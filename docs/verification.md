# 验证

分三层，都跑过。**数字是某次实测的快照，不是断言**——模型数、额度都会随厂商侧浮动。真正的断言是「两轮对话都回 PONG / PING」。

## 一、离线（CI 跑的就是这一组）

```powershell
node test/efforts.mjs        # 思考强度归一化 + 两家各自的拼法
node test/teardown.mjs       # 卸载竞态：halt 之后迟到的刷新不许再广播
node test/components.mjs     # 组件开关、卸载/恢复、两条路由的权限边界
node test/compat.mjs         # DSH 兼容声明：peer 必须是范围、README 与清单不许分叉
```

都不需要客户端、不发网络请求。`components.mjs` 全程跑在临时 `$DSH_HOME` 和替身 web server 上，不碰真 profile，也不碰任何客户端。CI（`.github/workflows/test.yml`）跑的就是这四条命令，在 `windows-latest` 上。`compat.mjs` 守的是 `peerDependencies` 的写法与两份 README 的一致性——细节和「为什么不能精确锁版本」见 [compatibility.md](compatibility.md)。

```
# reasoning effort
  OK   a model with levels and an off switch offers both
  OK   a model whose flat isReasoning flag is absent still gets its levels
  OK   a model that cannot disable thinking offers levels only
  OK   an on/off-only model offers exactly Off
  OK   a model with no thinking config gets no control
  OK   the flat fields remain a fallback for an older runtime
  OK   an unrecognised value is passed through, and no choice stays undefined
  OK   Qoder spells Off as none on its control channel
  OK   WorkBuddy drops Off before the wire but keeps a real level
```

## 二、宿主集成（需要装客户端）

```powershell
node test/integration/host.mjs                   # 用替身 ctx 跑真 apply()
node test/integration/soak.mjs                   # 反复开关 + 定时刷新，查泄漏（-Rounds=8）
node test/integration/collision.mjs              # 同一 provider id 被别人占住时的降级与恢复
node test/integration/leak.mjs qoder             # 逐驱动：列完模型后有没有残留子进程
node test/integration/turn-teardown.mjs qoder    # 跑完一整轮对话后再看残留
node test/integration/drain.mjs workbuddy 20     # 跑完一轮、正常收尾后，事件循环干净吗
```

替身 ctx 的 `registerAdapter` 会像 DSH 一样拒绝重复 provider，所以同一家被注册两次会在这里失败而不是在用户的会话里。它同时也替身了 `webServer`，所以两条设置路由是拿**真的 `apply()`** 端到端跑过的：读状态文档 → 关掉 Qoder → 确认 WorkBuddy 的路由还在 → 再打开。

```
refusals:
  no key            -> 403 {"error":"bad-key"}
  non-loopback host -> 403 {"error":"request-not-trusted"}

isolation: switch Qoder off, leave the other running
  workbuddy  state=on
  qoder      state=off
  adapters still registered: workbuddy
```

**`drain.mjs` 是唯一一个不调 `process.exit()` 的探针，这是刻意的。** 别的探针最后都强制退出，而宿主不会——它干完活就停下，等事件循环自然排空。所以「留下一个句柄」这种事，只有在不强制退出的探针里才看得见。两家跑完一轮后循环都是干净的（qoder 17.1s / workbuddy 6.3s 后自行退出）。

> **别把 headless CLI 不自行退出当成插件的问题。** 这个环境里 DSH 的 headless CLI 干完活本来就不退出——用一个**根本不存在的 provider** 做对照实验，它在 `NO_ADAPTER` 秒失败之后同样一直挂着。所以判断依据只能是上面那个收尾探针。

### 反复开关（soak）

一次性验证证明不了「用一天不出事」。`soak.mjs` 拿真的 `apply()` 做重复操作：每一轮把一个组件**真 dispose**（DSH 里那一行开关就是这个语义）、确认另一家还在服务、再 apply 回来、等它把模型报回来；轮与轮之间还有 5 秒的定时刷新在跑。跑 8 轮的结果：

```
  round  1  qoder 14->14  workbuddy 18->18  adapters:2  off:gone/routes gone
  ...
  round  8  qoder 14->14  workbuddy 18->18  adapters:2  off:gone/routes gone
  OK   no warnings or errors were logged across the whole run
  OK   teardown leaves no adapter behind
  OK   teardown leaves no route behind
```

它抓到过一个真问题：探针最初没 `await` disposer，那一轮就复现了「旧实例还在、新实例已上」的双注册窗口，模型数从 14 掉到 0。cordis 自己会 await disposer，所以这是探针的 bug 而不是插件的——但它正好说明这类顺序问题只有重复才看得见。

### 同一 provider id 被占用（collision）

`collision.mjs` 在 `apply()` 之前先替别的插件占住 `workbuddy`，把用户实际会遇到的场景跑一遍：

```
  OK   applying with a foreign owner present does not throw
  OK   the vendor that collided keeps the foreign adapter, not ours
  OK   the other vendor still registers
       log: dsh-agent-bridge/workbuddy: could not be registered: provider "workbuddy" is already registered (DUPLICATE_ADAPTER)
  OK   a collided vendor is not retried on later refreshes by itself
  OK   and it does not repeat the warning on every tick
  OK   flipping the row claims the id back without restarting DSH
```

也就是说：撞了不会把另一家拖下水，原因写在日志里而不是只在栈里，而且不会每五分钟刷一条同样的警告；占位方走了以后也不自动抢回来，需要把那一行关掉再打开。

## 三、工具通道

DSH 是编码代理：没有工具通道的模型，每一轮都只能说话，而模型一旦被 harness 的系统提示告知「你有工具」，就会把调用写成 `<tool_call>{…}</tool_call>` 文本。这段文本进不了工具循环，渲染出来就是**一条空回复**。上一版正是这样：请求里没有 `tools`，回程的 `delta.tool_calls` 又被丢掉。

```powershell
node test/tools.mjs                    # 离线：声明转发、流式重组、历史重放
node test/tools-live.mjs               # 实机：真账号 + 真上游 + 本插件的驱动
```

`test/tools.mjs` 用合成 SSE 钉住四条：适配器把 harness 的 `{name, description, parameters}` 转给驱动；驱动再转成 OpenAI 的 `function` 信封；一串参数片段重组成 `block-start` / `tool-call-delta` / `block-end`，`finish` 报 `tool-calls`；历史里的调用带 `tool_calls`、结果按 `tool_call_id` 对应。有工具时还必须**不再**注入「你没有工具」的前导语——那和工具列表直接矛盾，模型会退回去写文本调用。

实机一次的结果（两轮闭环，`WorkBuddy tools driver: OK`）：

```
turn 1 (expect a pwsh call)
  chunk types : block-start, tool-call-delta, block-end, usage, finish
  block-start : 1 ["tool-call"]
  deltas      : 25
  block-end   : 1
  finish      : {"kind":"tool-calls"}
  text        : (none)
  call        : pwsh {"command": "Get-ChildItem"}

turn 2 (expect prose about the listing)
  chunk types : reasoning-delta, text-delta, usage, finish
  finish      : {"kind":"stop"}
  text        : "The current directory contains two files:\n\n- `README.md`\n- `package.json`…"
```

25 个片段拼回的参数是合法 JSON，说明「id/name 先到、参数在后」的顺序被上游真的这么发，也说明重组是按 `index` 而不是按到达顺序做的。

**第二轮才是重点。** 只测一轮只能验到「模型发起了调用」，验不到「结果喂回去之后模型还能答」——而这一路出过真问题：助手那一轮如果丢了 `tool_calls`，剩下的 `tool` 消息就在回答一个不存在的调用，上游直接 `11148 tool calls and tool results do not match`。所以现在第二轮把 `tool-call` 块和 `tool` 消息按 harness 的真实形状回放，要求 `finish: stop` 且**有正文**。

## 四、逐驱动实盘

```powershell
node test/qoder-live.mjs
node test/workbuddy-live.mjs
```

每个脚本独立跑一家：安装状态 → 模型数 → 额度 → 两轮真实对话，最后打印一行 `<厂商> driver: OK`（方便整套跑完 grep 一遍）。这个「一定有一行结论」是**进程级保证**，不是 happy path 末尾的一句 `console.log`：`test/verdict.mjs` 接管 `unhandledRejection` / `uncaughtException`，所以失败也会给出结论行而不是裸栈。

`qoder-live.mjs` 末尾还有一轮**故意失败**：用一个账号里没有的模型发一轮，断言它必须响。只测成功路径的话，`F-006`（队列把中途失败当成正常结束）和 `F-007`（失败的帧判成空回复）在它面前完全隐形——两个缺陷的表现都是「正常结束 + 零文本」，和模型不肯回答分不出来。允许抛异常或 `finish.reason` 为 `error`，唯独不允许静默收场。

| 驱动 | 结果（快照） |
| --- | --- |
| Qoder | 14 个模型 · `2,794 credits left` · PONG / PING · 故意失败轮 `qoder: Sorry, something went wrong…` |
| WorkBuddy | 18 个模型 · `6,402 积分` · PONG / PING |

## 五、真 DSH 跑通

在 headless profile 里把默认模型指到本插件的模型，走完整 DSH 链路各跑一轮：

| provider / model | 结果 |
| --- | --- |
| `qoder` / `qmodel_38max` | `PONG`，`turn_end: completed` |
| `workbuddy` / `deepseek-v4.1-flash` | `PONG`，`turn_end: completed` |

这两行意味着整条链路是通的：DSH 按命名空间找到 provider → 走本插件的 adapter → 驱动去跟客户端说话 → 流式结果回到会话里。

**但这只证明了「有回复」。** 工具在真循环里能不能用，另见第十节——那里补了工具闭环，并因此抓出第八条缺陷。

## 六、思考强度：实机怎么验的

Qoder 的档位不是读文档读出来的，是一条条问出来的。同一个 worker runtime，同一轮「只回一个词」，只改 `reasoningEffort`：

- `off`（控制通道 `none` / argv `--thinking disabled`）→ chunk 序列 `text-delta, finish`，思考内容为空字符串；
- `low` → `reasoning-delta, text-delta, finish`，思考内容是 `The user wants me to reply with exactly "PONG".`。

各模型实测到的档位：

| 模型 | 档位 | 默认 |
| --- | --- | --- |
| Qwen3.8-Max / Qwen3.8-Flash | `off, low, medium, xhigh` | medium |
| DeepSeek-V4-Pro | `off, high, max` | max |
| DeepSeek-Flash | `off, low, high, max` | max |
| GLM-5.3 / GLM-5.3-Flash / GLM-5.2 | `low, high, max`（有的带 `off`） | max |
| Kimi-K3 / Kimi-K2.8-Preview | `low, high, max` | max |
| Qwen3.7-Plus / Qwen3.7-Max | 只有开/关 | — |
| Auto / Qwen3.7-Flash / MiniMax-M2.7 | 无 | — |

最后一行不是漏做：这三个模型在 Qoder 自己的模型列表里就没有 `thinking_config`。硬塞一个档位只会是假开关。

## 七、被测出来的真问题

**一、前言与上游系统提示打架。** 第一次跑某个自带 agent 系统提示的上游时，一个「只回一个词」的请求产生了 **878 个输出 token** 的思考——模型在纠结「我们的 proxy 前言说我没有工具，但上游自己的系统提示说我有工具，这段前言是不是注入攻击」。改法不是改措辞，是把「要不要加前言」变成驱动契约的一部分（`ownSystemPrompt`）。改完同一轮降到 **3 个输出 token**，直接回答。

**二、模型列表会「冻住」。** 有个上游的模型列表来自一次会话创建时的快照，而 catalog 会话长期热着，于是旧列表被一直重复报下去——「额度到了但插件还报旧列表」正好会毁掉加它的目的。修法是给 catalog 会话 5 分钟回收。

> 这一条当时只写进了文档，代码里没落地：`listModels()` 仍然只看 `#catalog` 是否非空，而 catalog 每 5 分钟刷新一次、每次都 `#touchIdle()`，所以子进程永不闲置、永不回收。见第九节。

**三、`isReasoning` 两个方向都错。** 它漏掉 DeepSeek-Flash / Kimi-K3，又给 `auto` / `q37fmodel` 编出并不存在的控件；而真正的权威是 `thinking_config`。修完之后 Qoder 14 个模型里 10 个有真档位、2 个只有开/关、3 个没有控件，与 Qoder 自己的 UI 对得上。

**四、关掉的行会自己回来（卸载竞态）。** `host.mjs` 收尾后偶发打印 `adapters remaining after cleanup: 1`——六次里出现一次。原因是卸载顺序里有一个窗口：timer 停了，但**已经在飞**的那次刷新不会停，等它落地就会 publish → announce → 宿主重新注册 provider 路由（这是余额能进分组标题的机制）。于是刚被关掉的那一家又挂回去了，从外面看像「卸载没生效」。

修法不是把顺序再调一遍，而是把窗口关掉：`Catalog.halt()` 在释放路由**之前**置一个标志，之后任何 announce 都是空操作。`test/teardown.mjs` 强制制造这个竞态（让驱动的 `listModels()` 挂在一个受控的 promise 上，卸载后再放行），并把 `halt()` 摘掉会失败这件事验过一遍——不这么验，测试只是在测「通常能赢」。修完连跑六次收尾都是 0。

**五、工具调用写成正文，于是每轮都是空回复。** 这一条是用户在实际使用中撞出来的，比前四条严重得多：切到某家的 `deepseek-v4.1-flash` 后，回复一出现就是空白。

抓原始 SSE 才看清发生了什么——请求里**没有 `tools`**，而 harness 的系统提示说「你有 shell 工具」。模型的反应是把调用写进正文：

```
<tool_call>
{"name":"pwsh","arguments":{"command":"Get-ChildItem"}}
</tool_call>
```

而回程的 `delta.tool_calls` 一直是 `[]`，`readDeltas()` 只读 `content` 和 `reasoning_content`，别的字段一律丢掉。也就是说：上游本来会给出结构化调用，是本插件没问、也没接。

对照实验：只在出站 body 上补一个 `tools` 数组，其他都不动，上游立刻回 `finish_reason: tool_calls` 和 13 个带 `id` / `name` / 参数片段的对象。所以问题不在上游、不在模型，在插件的工具通道整个是空的。

修法是把通道接通，而不是把措辞写得更严厉（`PROXY_PREAMBLE` 里那句「你没有工具」正是最初「让它别写工具语法」的手段，它没能拦住，还和工具列表自相矛盾）：

- `lib/adapter.js` 把 harness 的 `{name, description, parameters}` 转给驱动，并在**有真工具时不再注入**那段前导语；
- `drivers/workbuddy/conversation.js` 出站带 `tools` + `tool_choice: "auto"`，回程把片段按 `index` 重组成 `block-start` / `tool-call-delta` / `block-end`，`finish` 报 `tool-calls`；
- `lib/messages.js` 的投影保留 `toolCalls` 与 `toolCallId`，历史按原生结构重放（助手消息带 `tool_calls`，结果按 `tool_call_id` 对应），不再压成 `[tool call: …]` 文本；
- 顺手修掉一个真 bug：流式的空闲计时器原本是「从开流起 5 分钟必响」，不因数据到达而重置，长回答会被这条假超时打断。

`test/tools.mjs`（离线）与 `test/tools-live.mjs`（实机）分别钉住合成与真实两条路径，见上一节。

## 八、探针工具（开发期，不进 profile）

`_probe/` 里放开发期的一次性探针与抓到的原始协议快照，不入库、不发版。**例外**是两个被文档当成复现路径写出来的工具，它们已在 `tools/` 里入库——一条读者打不开的复现路径等于没有复现路径：

- `tools/inspect-frames.mjs`：把帧里的标记逐码点打出来（终端是有损视图）；
- `tools/real-loop-capture.ps1`：跑 N 轮真循环并留住每一轮 transcript，见第十二节。

- `client-render.mjs`：用桩把浏览器半身渲染成元素树并断言（不需要 DSH、不需要浏览器）；
- `render-html.mjs`：把同一份 `client.js` 渲成静态页（`out/preview.html` + `preview.png`），并注入一段自测脚本，量出溢出、卡片高度、进度条比例、页签 `aria-selected`——版式问题是可数的，不必靠眼睛；`--only=<n> --shot=<path>` 只渲一张图并按实际高度截屏；
- `measure.mjs`：把上面那份自测脚本的 `<pre id="report">` 数字读回终端；
- `three-rows.mjs`：两行 Loader 的注册与隔离；
- `qoder-*.mjs`：协议探测（控制帧、`thinking_config`、`off` 与 `low` 的实际差异）。

README 里的三张图就是 `render-html.mjs` 的输出（**本地桩数据渲染，只示版式**）。

## 九、第二轮实测补修（未发版）

这一轮用真账号把两个驱动重新跑了一遍，并专门去撞「取消」「失败」「缓存」这三类平时不会主动碰的路径。七条里前四条是行为错误，后三条里第六、七条会让用户看到**假的成功**。

**一、模型列表仍然冻住（第七节第二条其实没修）。** `QoderSession.listModels()` 只看 `#catalog` 是否非空，`#catalog` 从不失效；`catalogConversation` 只在抛错时关闭，而会话的 idle reaper 被每 5 分钟一次的刷新反复重置。探针连问两次得到**同一个数组对象**，说明一次上游都没问。修法是把「新鲜度」做进 `QoderSession`：`CATALOG_TTL_MS`（5 分钟，可注入以便测试），过期才 `get_models`；空列表不缓存（那正是未登录时隐藏 provider 的机制）。驱动侧再加一条 30 分钟上限，把常驻的 listing 子进程换掉。`test/catalog-ttl.mjs` 用一个「每次列表都多一个模型」的替身 runtime 钉住这两件事。

**二、用户按「停止」被上报成上游服务端错误。** 取消一轮对话时，客户端拿到的是
`the upstream rejected the request (server, http 0): transport error: AbortError`——话说反了，而且 `kind: server` 属于「可重试」分类，被取消的请求可能被重发；`http 0` 还是驱动程序编出来的状态码。修法是 `chatStream()` 先认 `signal.aborted` / `AbortError`，报 `kind: 'cancelled'`，并让 `describeFailure()` 说「the request was cancelled」。请求阶段与读流阶段两条路都覆盖，`test/cancellation.mjs` 用替换 `fetch` 的方式离线钉住，真实网络故障仍归 `server`。

**三、驱动层会静默吞掉「未投影」的工具调用。** 把 harness 原始形状的消息（`content` 里带 `tool-call` 块）直接交给 `openSession().send()`，助手那一轮**整条从请求里消失**：先读不到 `toolCalls` 而退化成文本，紧接着那段 `[tool call: …]` 又被 `stripLeak()` 当作自家渲染的伪调用清掉，于是空文本、被 `continue` 丢弃。请求到了上游只剩一个没有调用可答的 `tool` 消息，上游回 `11148 tool calls and tool results do not match`。真实 DSH 链路因为 `adapter.js` 先投影而没暴露，但驱动契约不该只在这种前提下成立——现在两种形状都读，`test/wire-shapes.mjs` 同时钉住。

**四、孤立的工具结果仍会被发出去。** 上下文压缩可能留下结果、丢掉提问的那一轮，而上游拒绝「没有对应调用」的 `tool` 消息。现在这种结果降级成一条 user 文本（保留 id 与内容），不再让整轮 400。

**五、已取消的一轮仍然把 prompt 发给了 worker。** 「把队列置为失败」写在 `session.send(prompt)` 之前，可 prompt 照样发了出去——取消了却照样扣额度，还让子进程的历史比这个类记的多一轮，下一轮的 append 判定随之失准。现在先查 `signal.aborted` 再发；同时取消统一成 `AbortError`，和第二节同一套语义。

**六、Qoder 的队列把中途失败当成正常结束（本轮最严重）。** `AsyncQueue` 的等待者只存了 resolve，`fail()` 唤醒它们时给的是 `{ done: true }`——读作「这一轮正常结束了」。而流式期间几乎总有等待者停在那儿，所以这不是边角情况，而是**所有中途错误的默认路径**：上游报错、取消、worker 猝死，全部变成一条被截断的回答，没有异常、没有日志。修法是等待者同时存 reject。

**七、失败的帧被判成空回复。** 用一个账号里没有的模型发一轮，拿到的 `result` 帧是
`{ subtype: "error_during_execution", is_error: true, errors: ["Sorry, something went wrong…"] }`——**没有 `result` 字段**。旧判断要求 `result` 非空才算失败，于是它被当成正常结束：`finish: stop`、零文本、零错误，从外面看就是模型不肯回答。现在失败以帧自己的判词为准（`is_error` 或 `subtype`），原因按 `result` → `errors[]` → `subtype` 三级取。`test/qoder-failure-frames.mjs` 用能按需发帧的替身 runtime 钉住四种形状；实盘复验同一请求已从「空回复」变成
`qoder: Sorry, something went wrong. Please try again. Report Issue (input /feedback)`。

这一轮新增的探针在 `_probe/`：`abort-phases.mjs`（取消的两个阶段）、`tools-loop-live.mjs` 与 `tools-loop-dsh.mjs`（未投影 / 已投影两种消息形状下的工具闭环）、`tools-wire-dump.mjs`（把真实请求体打出来）、`qoder-catalog-freeze.mjs` 与 `qoder-catalog-ttl.mjs`、`qoder-cancel` 相关的两个、`qoder-frames-live.mjs`（原始帧）、`qoder-error-live.mjs`。

## 十、真 DSH 循环里的工具闭环，以及第八条缺陷

第五节只验到「一轮对话有回复」。**有回复不等于工具能用**，而工具通道的问题恰好只在真 agent 循环里出现——只有那里，系统提示才会推着模型去发起工具调用。补上这一段之后又抓出一条。

### 怎么搭的

桌面端正在用的那个实例（`127.0.0.1:19387`）不加载本插件，`/plugins/dsh-agent-bridge/status` 是 404，所以不能拿它测得。改用一个**完全隔离的 `DSH_HOME`**，不动桌面端的 profile：

```powershell
$env:DSH_HOME = '<隔离目录>'
node <dsh>/lib/bin.js --profile e2e --from-default-profile headless --dump-config
```

把插件拷进 `<DSH_HOME>/profiles/e2e/plugins/dsh-agent-bridge`，在 profile 的 `package.json` 里加 `"dsh-agent-bridge": "file:./plugins/dsh-agent-bridge"` 并把它列进 `dsh.profile.bundles`。`--dump-config` 出现 `agent-bridge-workbuddy` / `agent-bridge-qoder` 两行，就说明插件被真的组装进去了。

用 `--patch` 叠加一层只改 `agent-default-model` 的 overlay，同一个 profile 就能分别指向两家，不必来回改文件。然后：

```powershell
node <dsh>/lib/bin.js --profile e2e --patch <overlay> headless "用 pwsh 工具列出当前目录的文件"
```

### 判据：不只看「有没有泄漏」

跑一个只有一句 prompt 的回合是不够的。缺陷的表现是**标记渲染出来、工具却没执行**，两者可以独立发生——所以每轮种一个**文件名带随机 token** 的文件，只有 token 出现在回答里才算工具真的跑过；同时回答里不许出现 `invoke` / `parameter name=` / 连续竖线。两条都满足才算通过。

`tools/real-loop-check.ps1` 把这件事做成了脚本：

```powershell
pwsh -File tools/real-loop-check.ps1 -Profile e2e -Runs 5 -Provider qoder
pwsh -File tools/real-loop-check.ps1 -Profile e2e -Runs 5 -Provider workbuddy -Model deepseek-v4.1-flash
```

修复后实测：`qoder` 4/4、`workbuddy` 3/3，工具都真的执行、零泄漏。

### 第八条：模型把分隔符写成「只有竖线、没有 `DSML`」

真循环里跑出来的原文（`qoder` / `qmodel_38max`，原始帧确认）：

```
<｜｜DSML｜｜calls>
<｜｜｜｜｜invoke name="pwsh">          ← 五个竖线，没有 DSML
<｜｜DSML｜｜parameter name="command" string="true">Get-ChildItem -File -Filter *.txt</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>List .txt files via PowerShell
```

同一个信封里，`invoke` 用退化写法、`parameter` 用规范写法。解析器要求字面 `DSML`，于是**整个信封都不被识别**——标记进入回答、`pwsh` 从未执行，这一轮就白花了。

修法：分隔符拆成两种拼法，字母有的、和只有竖线的。只承认竖线的那个**必须后跟标签名**（`invoke` / `parameter` / `calls` / `tool_calls`）——否则 shell 管道里的 `<||` 会被当成调用开头，把正常文本扣住再从历史里删掉。`endsWithMarkerPrefix()` 也一并改成按归一化后的尾巴判断，不再列举已知拼法（列不完，模型版本一变就落后）。

护栏：`test/dsml-variant.mjs` 用抓到的字节钉住解析，`test/dsml-stream.mjs` 从**驱动输出**再钉一次（含「切在裸竖线中间」的流行边界）。反向验过：把裸分隔符分支关掉，四条断言全红，报的症状和实际泄漏一致。

探针：`_probe/dsml-bare-delimiter.mjs`（抓到的字节 + 散文误判边界）、`_probe/qoder-marker-leak.mjs`（直接采样驱动发出的 chunk，而不是厂商原始帧——帧里永远有标记，那是模型写的内容）、`_probe/inspect-frames.mjs`（把帧里的标记逐码点打出来，终端是有损视图）。

### 这一轮顺带补的

- `test/tools-live.mjs` 原来只测一轮，只验到「模型发起了调用」，验不到「调用结果喂回去之后模型还能答」——而 F-003 暴露的正是后半段。现在扩成两轮闭环（`finish: tool-calls` → 回放 `tool-call` + `tool` → `finish: stop` 且有正文）。
- `test/qoder-live.mjs` 原来只测成功路径，`F-006`/`F-007` 在它面前是隐形的。现在末尾加一轮**故意失败**（用一个账号里没有的模型），断言失败必须**响**：要么抛异常、要么 `finish.reason` 是 `error`；唯一不允许的是「正常结束 + 零文本」，那和模型不肯回答分不出来。实盘已从静默空回复变成 `qoder: Sorry, something went wrong…`。
- `drivers/qoder/session.js` 加了 `DSH_BRIDGE_DUMP_FRAMES` 环境变量：置为一个文件路径就把收到的每一帧原样追加进去。翻译协议的人只有一份渲染后的回答可看时只能猜，而「模型写了我们没解析出来的调用」和「模型写了看起来像调用的散文」只差一个字段，渲染早就把是哪个通道丢了。默认关闭，因为它会带上 prompt 原文。

## 十一、第九条缺陷：历史重放丢掉了发起调用的那一轮

第八条修完之后去量「每次请求到底送了多少字节」，顺手把两个记在案上的疑问（H-001 / H-003）一起量了。H-001 不成立，H-003 的前提是错的，但量出了一个更严重的东西。

### 两个疑问的结论

**H-001（前导语与工具说明矛盾）：不成立。** `DriverAdapter.stream()` 在调用方给了工具时**不注入** `PROXY_PREAMBLE`，而 `toolPreamble()` 只在有工具时拼进 framing —— 两者互斥，不可能同时出现在一份 system 里。实测真循环里的 framing 是 676 字节，含 `# Calling tools`，不含 `You have no tools`。`test/tools.mjs` 早就在钉这件事。

**H-003（工具循环重建历史导致 token 翻倍）：前提错了。** `flattenConversation()` 会**丢掉最后一个 user 轮之后的所有消息**，所以「重放」并不重发整段历史。实测：三次工具交换里标着 REPLAY 的几轮都是 117 字节，全等，不增长。

### 但那个截断本身是错的

它丢掉的是**发起调用的那一轮**。对一个**有历史**的子进程这没关系——调用是它自己写的，结果补上就行。对一个**没有历史**的子进程（刚起、或崩了被换掉）就不是了，它收到的是：

```
[Conversation so far]
User: List the files in C:\missing-folder using the pwsh tool.
[End of conversation so far]

Get-ChildItem : Cannot find path 'C:\missing-folder' because it does not exist.
```

工具名、call id、以及「这是输出」这件事全没了。读起来就是**用户在报一个路径问题**。模型于是把命令输出当成用户提供的信息，不再当工具结果看。

同时，`isStraightAppend()` 当时要求新增的尾巴**必须以 user 结尾**，所以回答工具结果的那一轮**永远走重放**——也就是说每一次工具交换都会经过这条会丢调用的路。

### 修法

拆成两件事，各自由谁来做很清楚：

| 场景 | 用什么 | 送出什么 |
| --- | --- | --- |
| 子进程已有历史，只差一条新消息 | `appendPrompt()` | `Tool result for <call id>:\n<输出>` —— 只这一条 |
| 子进程没有可用历史（新起/被换/历史分叉） | `flattenTranscript()` | 整段，**含** `[tool call: 名 {参数} (id …)]` 与 `Tool result for <id>:` |

`isStraightAppend()` 放宽为「尾巴可以以 user 或 tool 结尾」，中间仍不许出现第二个 user 轮。这样回答工具结果的那一轮不再重建历史，顺带把每次交换的请求量从 117 字节降到 68 字节。

### 实测

量出来的形状（`_probe/qoder-framing-cost.mjs`）：

```
修前  turn 1:  20 bytes append
      turn 2: 117 bytes REPLAY  "[Conversation so far]\nUser: …\n[End]…\nalpha.txt…"
      turn 3: 117 bytes REPLAY
      turn 4: 117 bytes REPLAY
      冷子进程收到 tool 结果 → 不含工具名（names the tool call: false）

修后  turn 1:  20 bytes append  "List the files here."
      turn 2:  68 bytes append  "Tool result for qoder_call_0:\nalpha.txt…"
      turn 3:  68 bytes append
      turn 4:  68 bytes append
      冷子进程 → "[tool call: pwsh {…} (id call_1)] … Tool result for call_1:"（true）
```

真账号验证两件事：

- **追加路径**（`_probe/qoder-append-live.mjs`）：三次交换，每轮结果里塞一个随机 token，最后一次要求模型原样报出**两个** token。两个都出来 → 说明「调用→结果→再调用→结果→正文」这条链是通的。顺带看到耗时从首轮 11.7s 降到 3.2s / 3.3s（不再重放）。
- **冷子进程**（`_probe/qoder-cold-result-live.mjs`）：全新会话直接给一个**失败命令**的输出。修后模型答「The command returned the following error: …」——把输出归给命令；被截断的版本做不到这个读法。

### 护栏

`test/replay-shape.mjs`（进 `npm test`）钉住 4 组字节事实：冷子进程的 prompt 必须含 call 名与 id、结果必须标 id；已有历史时必须是 append 且 < 200 字节、不许回显调用；单条 user 要裸发不加壳；历史分叉时必须整段重放且含调用。另有一组 `isStraightAppend` 的边界（tool 尾可追加、中间有 user 不可追加、前缀变了不可追加）。

反向验证两条都做：把 tool 尾的可追加性去掉 → 4 条红（退回旧重放行为）；把 `flattenTranscript` 换回截断 → 4 条红（调用与 id 消失）。`_probe/replay-truncation-counterfactual.mjs` 自动做后者并还原源码。

### 没改的

- `flattenConversation()` 本身留着。它「把最后的 user 轮重复一遍」的行为对无状态驱动是对的，`workbuddy` 只在兜底路径用它。改它风险大于收益。
- 首次请求仍是裸文本（20 字节），不是带壳的 transcript —— 全新子进程没有任何前文可讲，加壳反而告诉它「前面有内容」。

## 十二、第四轮：真机复测又挖出四条

前九条都是靠「读代码 + 驱动直连」找出来的。这一轮换了做法：**先把真 DSH 循环跑起来，把每一轮的完整 transcript 都存下来**，再从失败的轮次里反推。理由很直接——第八条缺陷只存在于真循环里，说明驱动直连的覆盖面本来就不够，继续在离线层面找，找的是离线层面才有的问题。

新增 `tools/real-loop-capture.ps1`（当时写在 `_probe/`，因为文档把它当复现路径引用，后来入库）：跑 N 轮，每轮种一个带随机 token 的文件名，把 transcript **无论成败**都写进文件，并在文件头记下种的文件名与判定结果。`tools/real-loop-check.ps1` 只数失败次数，不留下证据；而这里恰恰不能重跑——每轮烧真额度，且缺陷是间歇的。

这个脚本自己也有个缺陷，是拿它跑 WorkBuddy 时暴露的：`-Model` 的默认值写死成 Qoder 的 `qmodel_38max`，换 vendor 后八轮全部 `model "qmodel_38max" is not in the catalog`——八轮零信息。模型 id 来自各家自己的目录，一个固定默认值不可能对两家都对；改成按 provider 取各自最便宜的模型。

判定仍然是那两条（token 回来 && 没有标记），但多了一列：**失败轮里模型自己的推理**。这一列贡献了后面一半的发现。

### 第四轮基线

修复前，20 轮里 12 轮干净。失败轮分三类：

| 形状 | 轮数 | 表现 |
| --- | --- | --- |
| 竖线墙 | 3 | 满屏 `｜`，工具没跑 |
| 参数丢失 | 6 | 模型说「参数明明给了却报 missing required property」 |
| 短散文 | 3 | 只有参数值当正文，没有工具结果 |

### 第十条：子进程死了，下一轮永远不结束

进程在**两轮之间**退出时，`QoderSession` 只调 `onError`，不清 `ready`；`send()` 在 stdin 已销毁时静默 return。于是下一轮跳过 `initialize`、把 prompt 写进一个死管道、然后等一个永远不会来的回复。

探针 `_probe/qoder-child-crash.mjs` 量到的结果：崩溃后的每一轮都是 8 秒超时、零 chunk、零提示（探针设了硬上限，否则就是真的挂死）。

这类失败最坏的地方是它没有形状：不是报错、不是空回答，是**什么都不发生**。用户看到的只是转圈。

修法是把「子进程已死」变成一等状态：

- `QoderSession` 加 `#died` 与 `alive` getter，`exit` / `error` 两条路径都置位并清 `ready`；
- `#send()` 从「静默 return」改成**抛错**——静默 return 把「子进程没了」伪装成「已经发出去了」；
- `QoderConversation#ensureChild()` 在 `send()` 与 `listModels()` 开头检查 `alive`，死了就换一个新的，并清掉 `#systemPrompt` 与 `#sent`（新进程什么都没被告知，留着任何一个都会让下一轮把一条孤立的消息追加给陌生人）。

修后：崩溃后的轮次 87ms 正常完成，且**换了新子进程并重放了历史**（探针记录 `children spawned: 2`，且新子进程收到的 prompt 是 replay）。

### 第十一条：子进程在答控制请求时死掉 → 整个 DSH 进程退出

`#dispatch()` 用 `void this.#answerControl(message)` 调用，没人持有那个 promise。而 `fetch_job_token` 这条路径要等凭据、等一次网络往返，之后才写回复——这个窗口里子进程完全可能已经没了。它的 `catch` 又用同一个 `#send()` 写错误回复，于是**第二次抛错没有 awaiter**。

Node 对 unhandled rejection 的默认行为是终止进程。也就是说：子进程在错误时机死一次，整个 DSH 跟着退出。

探针 `_probe/qoder-control-race.mjs` 装一个 `unhandledRejection` 监听（默认是会退出的），量到 `unhandled rejections: 1`，消息正是 `qoder: worker runtime is gone; the request was not sent`。

修法：`#answerControl()` 承诺不再抛——子进程没了就直接记 debug 日志返回（那条回复本来也没有读者），活着的子进程才写错误回复；调用点再加一层 `.catch()` 兜底，让方法内部的 bug 也变不成进程级事件。

### 第十二条：恢复出来的调用是空参数

这条最贵。模型说「参数我明明给了，工具却报 missing required property」，试了 `pwsh` 四次、`glob` 两次，最后判定「这是 harness 的系统性问题」并放弃。

根因不在参数，在**开标签的形状**。真机抓到四种：

```
<｜ name="command">Get-Location</｜｜DSML｜｜parameter>          ← parameter 这个词没了，只剩一根竖线
<｜｜DSML｜｜ parameter="command" string="true">…</…parameter>   ← 参数名成了 parameter 属性，不是 name 属性
<｜｜｜｜｜invoke name="pwsh">…</｜｜DSML｜invoke>               ← 开标签竖线 5~23 根，闭标签 2 根
（无闭合 </invoke>，参数写完直接进入重复循环）
```

原来的 `PARAMETER` 正则要求开闭两端都写全 `parameter`、且键必须叫 `name`。四种形状全部落空，而 `INVOKE` 匹配上了——于是调用被恢复成 `{}`，工具拒绝它，屏幕上一点标记都没有。

`_probe/empty-args.mjs` 把这件事变成可数的：扫帧转储，任何「恢复出 `{}` 但源块里明显有参数」的调用都列出来。一次抓取里 **22 个调用中有 10 个是空参数**。

修法：

- 键可以从 `name` / `parameter` / `key` 任一属性读；
- **开**标签的 `parameter` 一词可省，**闭**标签仍然必需——这个不对称是刻意的，闭标签上的 `parameter` 才是「这不是普通 `<x name="y">`」的证据；
- 闭合 `invoke` 可缺：参数完整就该用，只有开标签没有参数则不算（那是被截断的一轮，补 `{}` 等于替模型决定去调工具）；
- 竖线上限从 8 提到 32。上限本身就是个错误的假设——真机出现过 23 根；真正防误判的是竖线后面的标签名，不是长度。

修后同一份帧转储：`calls recovered: 42, empty arguments: 0`。

### 第十三条：退化轮把竖线墙当内容渲染

有的轮次模型直接重复 `｜` 到预算耗尽——真机抓到一次 500 根。原来这些竖线会原样流到屏幕上，看起来像回答。

现在按「这一轮没有产出」处理：`isDegenerate()` 认这种连续竖线（**但要求后面不跟标签名**，否则一个 23 根竖线的合法分隔符会被误杀），驱动层 hold 住并按失败结束，报 `the model degenerated into a repetition loop`。

顺带修了一个意图与实现不符的地方：恢复失败时，注释写的是「宁可显示标记也别吞掉一轮」，而代码 emit 的是 `recovered.rest`——也就是**标记已被剥掉**的残骸，参数值孤零零留在正文里，读起来像模型在胡言乱语，反而把唯一的线索擦了。现在失败时显示原始块。

### 护栏

三个新套件进 `npm test`：

- `test/dsml-dialects.mjs`（21 条）：每一段都是**从真机抓下来的原文抄进去的**，不是照着正则编的。含三种方言与全部退化形状，以及五条「不是调用」的反例（markdown 表格、`<b>`、纯散文、只有 wrapper、`a || b`）。修一个形状补一条，是「先写测试看它红」的顺序做的。
- `test/dsml-delta-split.mjs`（9 条）：同一批块**按真机抓到的 18 段 delta 边界**送进真驱动，再按**逐字符**送一遍。理由是批处理解析正确不等于流式正确——第十二条的竖线墙就是 `endsWithMarkerPrefix()` 在某个 delta 边界上把 `<` 放了出去。这条测试跑的是驱动，不是复制一份状态机。
- `test/qoder-child-lifecycle.mjs`（6 条）：第十、十一条的护栏，用两个假子进程（按命令自杀 / 在答控制请求时死）驱动真驱动类。最值钱的一条是 `a prompt written to a dead child is refused, not dropped in silence`——它要求会话处于「子进程已死但没人叫它关」这个状态，而 `QoderConversation` 会在写之前换掉死子进程，所以直接从 `QoderSession` 驱动。

反向验证过这三道护栏有牙：去掉 `#ensureChild()` → 红 3 条；把 `#send()` 改回静默 `return` → 红 1 条；把 `flattenTranscript` 换回截断 → `replay-shape` 红 4 条（`npm run test:counterfactual` 自动做并还原）。

### 效果

同一套 20 轮：修复前 12/20 干净，修复后 19/20。剩下那一轮是竖线上限问题（23 根竖线超了 8 的上限），修完后再测 16 轮 15 绿——唯一那一轮是模型真的退化了，现在报 `the model degenerated into a repetition loop` 而不是刷一屏竖线。

两家都跑了：Qoder 16 轮 15 绿（`capture9`），WorkBuddy 8 轮 8 绿（`capturewb2`）。WorkBuddy 第一遍 8 轮全挂，是上面那个默认模型 id 的问题，不是驱动的问题。

## 十三、第五轮：原生 token 漏出来，以及截断标签留在历史里

第十二节的做法（先跑真循环、把每一轮 transcript 都留下）在下一批 10 轮里立刻又付了一次现：第 6 轮抓到一种**全新形状**，而且它不是模型自创的方言。

```
<｜｜｜｜｜▁begin｜>function<｜tool▁sep｜>pwsh
```json
{"command": "Get-ChildItem -Force | Select-Object Name, Mode | Format-Table -AutoSize", "description": "列出当前目录中的文件"}
```<｜｜DSML｜｜call▁end｜>
```

`▁` 是 U+2581 —— 分词器在 token 的可读形式里代替空格的符号。也就是说这些是模型**自己的函数调用控制 token**（`<|begin_of_tool_call|>`、`<|tool_sep|>`、`<|end_of_tool_call|>`）漏进了正文通道，竖线仍是同一个 U+FF5C。

### 第十四条：原生 token 序列不被识别

这条比之前的方言都好恢复——参数是**围栏里的 JSON 对象**，本身就是一棵参数树，没有 `<parameter>` 语法可以读错。它之所以没被认出来，纯粹是因为没见过。

修法分两处，第二处才是关键的：

- `NATIVE_BEGIN` / `NATIVE_SEP` / `NATIVE_END` 三个 token 的正则，都允许竖线数量漂移、`_` 与 U+2581 互换；`NATIVE_CALL` 把「begin + 字面 `function` + sep + 工具名 + 正文 + end」串起来，正文取第一个围栏块并 `JSON.parse`。围栏缺失、截断、或解析出非对象 → **不执行**，但整块仍从文本里切掉。截断的半个 JSON 在这里补 `{}`，就是第十二条那个错误的翻版。
- 这三个 token 还必须进 `MARKER`。原因是流式：带 DSML 外壳时，外壳先到，hold 由外壳触发，原生 token 不需要被单独认识；**没有外壳时**没有任何东西像标记，逐字符流会把开头当正文放出去，等 `tool▁sep` 让形状明显时 block 已经漏完了。实测去掉 `MARKER` 那一项：逐字符流 `calls=0`、竖线进正文。

### 第十五条：退化成重复闭合标签的轮次，截断的那一截留在历史里

另一批抓取样例里，调用**完整恢复**了，但模型随后把 `</｜｜DSML｜parameter>` 重复了六十次，并且在预算耗尽时截断在标签中间。

这在渲染路径上无害（调用已经拿到），但在 `stripLeak` 上有害——它正是给重放历史用的：`RESIDUE` 要求标签有闭合 `>`，截断的 `</｜｜DSML｜` 独自占一行，`[^>\n]*` 跨不过换行，于是留在了历史里，成为下一轮可以照抄的示例。

改成终止符接受「行尾」：`(?:>|(?=[\r\n]|$))`。行边界让「允许缺 `>`」是安全的——一行里由分隔符起头、到换行都没有闭合括号的片段是标记，不是散文。

### 普查，而不是继续靠截图

一条 130 份日志里只出现 1 次的方言，靠眼睛是找不到的。所以这轮加了两个普查探针：

- `tools/tag-census.mjs`：把帧转储里所有标签形状按「分隔符后面那个词」分组。三次转储 471 个片段，出现的词只有 `dsml / invoke / ds / parameter / tooldsml / tool_name / tool_call`，**没有一个在词表外**——说明已抓到的形状，语法层面覆盖完了。
- `tools/residue-census.mjs`：把每个助手文本帧过一遍 `stripLeak`，看有没有分隔符活下来。这是更硬的判据，因为它直接问「还有没有清理不掉的东西」；而且这类缺陷**不出现在失败计数里**——那 8 个有残留的串，调用本身全都成功了。修前 93 个带标记的串里 8 个有残留，修后 **0**。剩下 7 个「有标记但恢复不出调用」的，逐个看是流式半截 delta（`<｜tool_name`、`<｜DSML`、`<｜ name="`），`rest` 已正确清空，不是缺陷。

两个探针都进了 `tools/`（`npm run census` 连跑），因为文档把它们当读者路径引用——上一轮的第十七条就是这么来的。

### 效果

- 方言 C 的原文按「整串」与「逐字符」两种方式压过真驱动：调用与参数都对，无标记泄漏。
- 真机 14 轮 14 绿（`capture11`）。这条形状稀有，这一批没再出现，所以复现靠上面那次原文压测。
- 离线：`dsml dialects` 27 条、`dsml delta split` 11 条，`npm run check` 退出码 0。

## 十四、第六轮：`invoke` 滑进属性位，参数被包在一层壳里

桌面端重启后的第一批 14 轮里，两轮各给出一种新形状。它们不是同一类问题：一个是**语法位移**，一个是**参数被包了一层**。

### 第十六条：`invoke` 从标签名滑到了属性位上

```
<｜｜DSML｜｜calls>
<｜｜｜｜call invoke="name">pwsh</｜｜DSML｜｜calls>
<｜｜｜｜invoke name="command">Get-ChildItem -Force | Select-Object Name, Mode, Length | Format-Table -AutoSize</｜｜DSML｜｜parameter>
<｜｜｜｜invoke name="description">List files in current directory</｜｜DSML｜｜parameter>
</｜｜DSML｜calls>
```

字面读这不是语法：一个 `call` 元素、它的 `invoke` 属性是 `name`；再一个带 `name` 属性的 `invoke` 元素。按**位移**读就通了——`invoke name="pwsh"` 变成了 `call invoke="name">pwsh`，`parameter name="command"` 变成了 `invoke name="command"`。

能恢复而不是靠猜，是因为位移的那个词两种读法都指向同一个工具名：属性是装饰也好、是字段名也好，元素正文都是 `pwsh`。

修法两处：

- `parseMisplacedCalls`：工具名取自 `<call invoke="name">正文</…>`，参数取 `<invoke name="KEY">值</…parameter>`。守卫是位移本身——属性键必须是本该做标签名的那个词（`invoke`/`function`/`tool_name`），所以规范的 `<…invoke name="pwsh">` 永远匹配不上这一支。两种写法只差一个词，两条都在真机上活着，守卫不能省。
- **`call` 必须进 `TAG_NAMES`**。裸分隔符只有在后面跟已知标签名时才算标记，所以以 `call` 开头的块对流式 hold 是隐形的：实测无外壳 + 逐字符流 `calls=0`、竖线进正文。这和第十四条（原生 token）是**同一个教训的第二次**——语法修好了、流式没跟上，等于没修。

### 第十七条：参数被包在一层 `<args>` 里，于是恢复成一个不存在的参数

```
<｜tool_calls>
<tool>
<tool_name>pwsh</tool_name>
<args>
<command>Get-ChildItem -Force | …</command>
<description>List files in current directory</description>
</args>
</tool>
</｜tool_calls>
```

同级的标签扫描把 `<args>` 当成**一个**参数，值是里面那串标签的**文本**。于是调用带着一个谁家 schema 都不认识的参数发出去，工具回 `required property 'command' is missing`，模型换了四种写法、最后判定 harness 坏了——**第十二条的翻版，只是隔了一层壳**。

这不是从失败日志里看出来的。它是这样量到的：对帧转储统计「恢复出来的调用有哪些键」，40 个调用里 8 个的键集是 `{args}`，其余 32 个是 `{command,description}`。一眼就看出那 8 个是错的。

修法是 `unwrapArguments`，两个条件都必需：

1. 壳必须是**唯一**属性——已经带着 `command` 又有 `<args>` 的，不是被包的调用，是带了个怪参数；
2. 值必须像参数袋——要么是 `<key>值</key>` 对，要么是 JSON 对象。纯文本是合法参数：`docker_run` 真的有一个叫 `args` 的字符串参数。

两个方言族的入口都串了这一步（`alternateArguments` 与 `parametersOf`），因为同一个错误换写法就会出现。

### 效果

- 同一批真实帧复算：40 个恢复调用全部 `{command,description}`，`{args}` 消失。
- 反向验证：去掉 `TAG_NAMES` 的 `call` → 逐字符流那条红；去掉 `parseMisplacedCalls` 调用 → 位移用例红；`unwrapArguments` 改回直接返回 → 两条壳用例红。
- 离线：`dsml dialects` 34 条、`dsml delta split` 13 条，`npm run check` 退出码 0。
- 帧转储普查（新抓的 2521 帧）：清理残留 0；「有标记无调用」5 个全是流式半截 delta，`rest` 已清空。

### 第十八条：`<｜tool>` 容器标签本身不是标记，整块当正文放出去

第十七条修完之后，`<｜tool>` 这个容器在普查里出现了 4 次——它不在 `TAG_NAMES` 里，所以 `hasNativeLeak` 为 false。后果不是"少识别一个标签"，而是**整块**失效：hold 从不触发，`<｜tool>` 当正文发出去；而 `tool_name` 元素自己一根竖线都不带，下游也没有任何东西能被认出来。实测无外壳时 `calls=0`、整块上屏。

`<｜tool>` 在 `MARKER` 里补上，但**刻意不进 `TAG_NAMES`**：`tool` 是讨论标记语言时的普通词，本插件自己的文档就在写它，进了词表就会被清理步骤从句子里吃掉。只匹配"前面带分隔符"的容器，既有流式需要的证据，又不碰散文。

反向验证：把 `CONTAINER` 从两个正则里去掉 → `dialects` 那条容器用例红、`delta split` 两条位移用例红。

---

## 十五、第七轮：同一条守卫只修在一个驱动上

第十八条的修法在真机上 14/14 绿，于是照着"还有没有问题"再查一遍。这一轮的两条不在方言里，在**修复的分布**上。

### 第十九条：退化轮只在 Qoder 侧被拦，WorkBuddy 侧五百根竖线照原样上屏

F-015（退化轮）修在 `drivers/qoder/conversation.js` 里：`acceptText` 判 `isDegenerate` 就 hold，`settleText` 报明原因失败。`drivers/workbuddy/conversation.js` 根本没导入这个函数——两个驱动各写一份流式状态机，同一个守卫只能落一份。

不是"少一个检查"，是**用户能看见**：

| 输入 | 修前 | 修后 |
| --- | --- | --- |
| 500 根竖线 | 500 根上屏、不报错 | 失败并说明原因 |
| 正文 + 300 根竖线 | 318 字符上屏（正文 + 竖线） | 只留已发出的正文，轮次失败 |
| 普通正文 | 正常 | 正常 |
| 真实调用泄漏 | 恢复成调用 | 恢复成调用 |

判定条件不能从解析结果里取。竖线墙根本不是调用语法，非原生分支不会问解析器要结论，`recovered.degenerate` 因此是 `undefined`——拿它做判据，拦截等于没写，实测第二次仍然 500 根上屏。改成从**原始 held 文本**判：

```js
const degenerate = recovered.degenerate === true || isDegenerate(raw);
```

护栏是 `test/workbuddy-dialect.mjs`（4 条），用假 client 走真实的 SSE 翻译路径，断言的是**用户看到什么**，不是走了哪个分支。反向验证：把 `acceptText` 的退化分支和上面的判据同时去掉 → 2 条红。

### 第二十条：额度通知不在已知通知表里，于是被当成模型自己的回答

`capture15` 那 14 轮里 13 轮挂掉，日志写的是 `You've reached your daily usage limit for Chat. …`。当时判断"上游原文如实透出，不是缺陷"——**这个判断错了一半**。

插件本来就有这个机制：`SERVICE_NOTICES` 把 runtime 的固定通知变成错误，而不是当成模型的回答。它没生效，因为表里只有两条（忙、排队失败），而且**整句精确匹配**：

- 日额度这条不在表里；
- 就算在，runtime 会在后面接 `Report Issue (input /feedback)`，整句比较对不上真实报文。

后果比"显示一句提示"严重：它被记成 assistant 的内容，下一轮作为历史重放，会话就此污染。

改成前缀词干匹配（三条），并且**同时**修 hold 窗口。只改匹配是不够的——`couldBeServiceNotice` 原来只判"仍是某条通知的前缀"，通知一长出词干一个字符，窗口就关了、内容当场放出去，末尾的精确判定已经没有东西可查。实测：只加词干不改窗口，忙那条从"能识别"退化成"被当回答"，红 3 条。所以是两个窗口：

```js
if (stem.startsWith(lowered)) return true;                                   // 还在长成通知
if (lowered.startsWith(stem) && lowered.length - stem.length <= SLACK) return true;  // 通知 + 尾巴
```

`SLACK = 120` 是上界也是保险：以这些句子开头、但后面还有大段真实内容的回答会长过窗口被放出去，然后按回答处理——失败要往上取整，不能把一个正常回答判成上游故障。

护栏是 `test/qoder-notices.mjs`（5 条），含两条反向用例：`The daily usage limit for Chat is 2900 credits.` 与 `You've reached the end of the file. …` 必须仍然是回答。反向验证：删掉第二个窗口 → 3 条红。

### 这一轮真正学到的东西

前六轮的每一条都是"模型写了什么奇怪形状"。这一轮两条都是**"修在了哪"**——同一个逻辑有两份实现，改了一份，另一份就是活的缺陷；一个机制存在但输入表不全，机制等于不在。

对应的做法不是再读一遍代码，是给每个驱动配**同形**的行为套件：`workbuddy-dialect.mjs` 与 `qoder-notices.mjs` 断言的是同一类用户可见结果（标记不上屏、退化成失败、通知成错误），任何一侧单独失效都会各自变红。

## 第七轮状态

- 离线：`npm run check` 退出码 0；`dsml dialects` 36、`dsml delta split` 13、`workbuddy dialect` 4、`qoder notices` 5。
- 真机：`capturewb4` 14/14 绿（帧转储 45 帧、0 处标记、0 处参数键异常）；`capturewb5` 12/12 绿（新增空轮/闭合守卫之后，确认没有误杀真实轮次）。
- 续：`workbuddy-dialect` 7 条、`empty-turn` 6 条、`block-pairing` 3 条、`close-mid-turn` 2 条、`preflight-cancel` 3 条、`driver-parity` 12 条进链；空轮在两个驱动上都已改为失败；调用块在超时与断流两个出口上补了闭合；`close()` 现在会结束正在跑的那一轮；调用前已取消的轮次不再发出请求；两个驱动的取消错误统一带上 `kind` 与 `name` 两种标记。
- 未验证：WorkBuddy 是否也会把额度通知当回答（`H-010`，无证据，未改代码）。

---

## 十六、第七轮续：空轮，两侧都没有这条规则

第十九、二十条是「一条守卫只修在一个驱动上」。这一条反过来：**两侧都缺同一条规则**，所以它不是不对称，是共同缺口——也因此不会因为「对比两个驱动」被发现。

### 第二十一条：上游报成功、但什么都没产生，被当成正常结束

判据很窄：没有文本、没有 reasoning、没有调用，而 `result`/`[DONE]` 说这一轮成功了。

修前两个驱动都把它当 `finish: stop` 交出去：

| 驱动 | 修前 | 修后 |
| --- | --- | --- |
| Qoder | `text="" failure=none finish={"kind":"stop"}` | 失败并说明「没产生任何内容」 |
| WorkBuddy | `text="" failure=none` | 同上 |

用户看到的是空白回答：没有原因、没有可重试的信号，额度还扣了。

这条不是猜的。Qoder 的代码里已经写着这个判断——在处理 `failed` 的那段注释里：「空回答与拒答无法区分，而这是空答案最糟糕的形态」。**作者认这个结论，但只处理了「上游说失败」那一半。**「上游说成功、其实什么都没有」那一半没有任何代码。

修的位置都在收尾处，因为那是最后一个还来得及改结论的地方：

- WorkBuddy：`yield* queue` 之后、`yield finish` 之前
- Qoder：`result` 帧处理里，`settleText()` 与通知判定之后、`push finish` 之前

顺序不是随意的：`settleText()` 可能把 held 的正文放出来，`noticeProbe` 也可能是真内容，先判空会把它们误杀。

### 为什么这条最容易漏

它没有失败样本。前六轮每条都有 transcript、有红字、有「模型抱怨参数缺失」这类可读的症状；空轮只有一段空白，而空白在日志里长得和「模型答了很短的一句」一模一样。真机上如果出现，最自然的解释是「模型没话说」，而不是「harness 谎报成功」。

所以这条是靠**枚举用户可见结局**找到的，不是靠读失败日志：一个轮次结束时用户可能看到什么——答案、错误、空白。前两种都有代码负责，第三种没有任何人负责。

### 验证

`test/empty-turn.mjs`（6 条），每个用例**同时跑两个驱动**，其中四条是防误杀：

- 有文本的轮次必须仍然正常结束（两侧各一条）
- 只有工具调用的轮次必须仍然正常结束（两侧各一条）——这是编码会话最常见的形状，判空判错就会全线崩

反向验证：把两侧的 `if (!delivered())` 分别改成 `if (false)`，各红一条，互不影响。这同时证明了双驱动套件的价值：只修一侧，一半的用例会红。


---

## 十七、第七轮续二：调用的块没有闭合，以及一个把失败伪装成通过的探针

### 第二十二条：连接在调用中途断开，`block-start` 没有对应的 `block-end`

WorkBuddy 的调用是「先开块、后闭块」：第一次看到某个 index 的 delta 就 push `block-start`，
后续 delta 往里填参数，收尾时 `closeCalls()` 统一 push `block-end`。出口有四个，修前只有两个
调了 `closeCalls()`：

| 出口 | 修前 | 修后 |
| --- | --- | --- |
| 正常 `[DONE]` | 调了 | 调了 |
| 上游 error 帧 | 调了 | 调了 |
| 空闲超时 | **没调** | 调了 |
| 流抛异常（socket 断开） | **没调** | 调了 |

后果就是 F-003 的成因：`block-start` 已经在宿主侧记下了，`block-end` 没来，历史里留下一个
没有结果的调用——真机上表现成 `11148 tool calls and tool results do not match`。

两处都要修，而且顺序有讲究：`closeCalls()` 是幂等的（push 完 `clear()`），但必须在 `queue.fail()`
**之前**调用，因为 `fail` 之后队列已关闭，后续 `push` 全部被丢弃：

```js
closeCalls();
queue.fail(...);
```

`timer` 回调里也有同样的问题，而且它比 catch 更早能拿到引用——`closeCalls` 原来定义在 `timer`
之后，直接调用会踩 TDZ。把 `closeCalls` 的定义移到 `timer` 之前。

Qoder 侧没有这个问题：`emitCall` 一次性把 `block-start`、两条 `tool-call-delta`、`block-end`
同步推完，调用从不处于「已开未闭」状态。测试里保留了一条用例断言这个**性质**，不是为了修
什么——它一旦变红，说明 Qoder 的调用改成流式拼接了。

### 同一次排查里的方法失误：探针在错的目录里「全绿」

第一次验证这一条时，探针写在 `_probe/`，里面用 `new URL('./fake-delta-runtime.mjs', import.meta.url)`
解析假 runtime。`_probe/` 下没有那个文件，Qoder 启动直接失败、报错——而我的断言是
`assert.notEqual(failure, undefined)`，**「启动失败」和「调用未闭合」都满足它**。于是 Qoder
那条用例一直显示 OK，而它其实什么都没验证到。

发现的方式不是再看一遍代码，是同一个脚本复制到 `test/` 之后结果变了。同一个文件、只改了
一个用例名，两次结果不同——这不是随机性，是路径。修法是让所有 runtime 路径都相对文件自身
解析，并在文件头部写明理由：这个套件也会从已安装的 profile 里跑，裸 `./` 在那里指向空气。

教训和前面几条不一样：前面是「测试不会红就说明没测到」，这一条是**「测试会绿也可能什么都没测到」**。
绿比红更危险，因为没人会去看。

### 验证

`test/block-pairing.mjs`（3 条）：

- WorkBuddy 调用被断流切断后仍然闭合
- WorkBuddy 正常完成的调用恰好闭合一次（防重复闭合）
- Qoder 恢复出的调用是一个整体（性质断言）

反向验证：删掉 catch 分支的 `closeCalls()` → 第一条红。


---

## 十八、第七轮续三：`close()` 只杀了子进程，没有结束正在跑的那一轮

### 第二十三条：流式过程中关闭会话，消费端永久挂起

宿主在会话结束、或某一轮被放弃时会调用 `close()`。Qoder 侧的实现是：

```js
async close() {
  this.#closed = true;
  await this.#session.close();   // 杀掉子进程
}
```

杀掉子进程是对的，但**流式生成器还在等它自己的队列**。子进程死了之后不会再有 `onEvent`，
队列既没有 `fail` 也没有 `close`，`queue.next()` 那个 promise 就永远悬着。

实测（`_probe/close-midstream.mjs`，用不返回 `result` 的假 runtime）：

```
close() during a turn -> consumer HUNG in 3006ms
  chunks=1 failure=none finished=false
```

已经交付了一个 delta，然后这一轮就不存在了——没有错误、没有结束、没有超时。这是 F-010
往上挪了一层：那次是子进程死后下一轮不结束，这次是子进程被主动杀掉时当前这一轮不结束。

修法是让每一轮把「怎么结束自己」注册到会话上，`close()` 负责调用它：

```js
// 轮次开始时
this.#endTurn = (error) => queue.fail(error);

// finally 里
this.#endTurn = undefined;

// close()
this.#endTurn?.(cancellation('qoder: the conversation was closed before the turn finished'));
this.#endTurn = undefined;
```

`finally` 里必须清掉，否则 `close()` 会去 fail 一个已经结束的队列——`AsyncQueue.fail` 有
`if (this.#closed) return` 保护，但留着一个指向死对象的句柄是下一处麻烦的起点。

失败用 `cancellation()` 包装而不是裸 `Error`：这是「调用方停掉了它」，不是「上游坏了」。
两条错误在日志里必须能分开，否则统计失败率时会把用户主动取消算成上游故障。理由文案也
要说明是「会话被关闭」，而不是「模型失败」。

### 验证

`test/close-mid-turn.mjs`（2 条）+ 新增 `test/fake-silent-runtime.mjs`（只发一个 delta
就沉默的假 runtime，这一条没有它测不出来）。

反向验证：把 `close()` 里的 `#endTurn` 调用去掉 → 两条全红。



---

## 十九、第七轮续四：取消前的飞行前检查，只装在一个驱动上

### 第二十四条：调用前就已被取消，请求照样发出去并扣额度

Qoder 侧有一条守卫，来自 F-005 的真机教训：

```js
if (signal?.aborted === true) throw cancellation('qoder: the request was cancelled before it started');
```

注释写得很清楚：只在流里判取消不够——prompt 已经发出去了，额度已经扣了，子进程历史还多
了一次谁也解释不清的交换。WorkBuddy 侧没有这条。它的 `send()` 直接走到 `chatStream`，
signal 从头到尾没被看过一眼。

实测：`signal.aborted === true` 的情况下，`chatStream` 仍然被调用（`requested: true`），
这一轮照样扣额度，答案没人会读。

### 为什么这条值得单独记

它和第十九条是同一个模式的镜像：

- 第十九条：**有检查，但只在一个驱动上**（退化轮）
- 第二十条：**机制存在，但输入表不全**（额度通知）
- 第二十一条：**两侧都缺**（空轮）
- 第二十四条：**同一课，另一个驱动没学**（飞行前取消）

四种都出现过，说明「两个驱动各写一份状态机」这个结构本身在持续产出这种缺陷。每次修完
一个驱动，正确的动作不是「再看看还有没有别的方言」，而是**去另一个驱动找同一课**。

### 验证

`test/preflight-cancel.mjs`（3 条）：取消在前则请求不发、取消报 `cancelled` 而非上游故障、
正常 signal 不受影响。反向验证：删掉守卫 → 前两条红。

第三条（防误杀）是必须的：守卫写错会变成「所有轮次都不发」，那比原缺陷严重得多。


---

## 二十、第七轮收尾：把「去另一个驱动找同一课」变成一张表

### 第二十五条：同一个取消事件，两个驱动给出互不相交的形状

`test/cancellation.mjs` 里写着这个仓库自己的契约：取消要满足 `failure.kind === 'cancelled'`。
`test/qoder-cancel.mjs` 里写的是另一条：取消要满足 `failure.name === 'AbortError'`。

两份都是对的，因为它们测的是不同驱动：

| 驱动 | 取消时的形状 |
| --- | --- |
| WorkBuddy | `UpstreamFailure { name: 'UpstreamFailure', kind: 'cancelled' }` |
| Qoder | `Error { name: 'AbortError' }`（**没有 `kind`**） |

同一个事件，宿主只能按一个键判断，所以无论按哪个键，都必然有一个驱动被误判：按 `kind`
看，Qoder 的取消变成一个未分类故障；按 `name` 看，WorkBuddy 的取消变成上游故障。

修法是让 Qoder 的错误同时带两种标记。`kind` 是重试逻辑读的，`name` 是错误横幅和 HTTP
形状的辅助函数读的，两者互不替代：

```js
error.name = 'AbortError';
error.kind = 'cancelled';
```

两份现有契约继续成立（`qoder-cancel.mjs` 仍然 OK），而 `driver-parity` 的 `kind` 断言
开始通过。反向验证：删掉 `error.kind` 那一行 → Qoder 那条红、WorkBuddy 那条仍绿。

### 把教训做成表：`test/driver-parity.mjs`

这一轮出现了四种同源缺陷形状（只修一侧、输入表不全、两侧都缺、同一课另一个驱动没学）。
靠「再读一遍代码」找不到它们——前二十条里有几条是读了四遍代码都没发现的。所以这里换成一
张表：把**用户能观察到的保证**逐条列出来，然后要求两个驱动各自证明。

当前 6 条保证 × 2 个驱动 = 12 个断言：

1. 已取消的轮次不发出请求
2. 空轮是失败，不是空白答案
3. 退化轮是失败，不上屏
4. 调用标记不进正文
5. 每个宣告过的块都会闭合（即使流死掉）
6. 整块到达的轮次恰好交付一次

这张表的价值不在现在全绿，而在于**下次改任一驱动时，另一侧会自动被问到同一个问题**。
新增一条保证只要在数组里加一项，两个驱动各写一个函数；漏写一个，那一半直接缺失。

