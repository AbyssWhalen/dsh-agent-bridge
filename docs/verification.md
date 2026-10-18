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

实机一次的结果：

```
chunk types : block-start, tool-call-delta, block-end, usage, finish
block-start : 1 ["tool-call"]
deltas      : 65
block-end   : 1
finish      : {"kind":"tool-calls"}
text        : (none — the turn is a call)
  call      : pwsh {"command": "Get-ChildItem | Select-Object Mode, Length, LastWriteTime, Name | Format-Table -AutoSize"}
WorkBuddy tool channel: OK
```

65 个片段拼回的参数是合法 JSON，说明「id/name 先到、参数在后」的顺序被上游真的这么发，也说明重组是按 `index` 而不是按到达顺序做的。

## 四、逐驱动实盘

```powershell
node test/qoder-live.mjs
node test/workbuddy-live.mjs
```

每个脚本独立跑一家：安装状态 → 模型数 → 额度 → 两轮真实对话，最后打印一行 `<厂商> driver: OK`（方便整套跑完 grep 一遍）。这个「一定有一行结论」是**进程级保证**，不是 happy path 末尾的一句 `console.log`：`test/verdict.mjs` 接管 `unhandledRejection` / `uncaughtException`，所以失败也会给出结论行而不是裸栈。

| 驱动 | 结果（快照） |
| --- | --- |
| Qoder | 14 个模型 · `2,794 credits left` · PONG / PING |
| WorkBuddy | 18 个模型 · `6,402 积分` · PONG / PING |

## 五、真 DSH 跑通

在 headless profile 里把默认模型指到本插件的模型，走完整 DSH 链路各跑一轮：

| provider / model | 结果 |
| --- | --- |
| `qoder` / `qmodel_38max` | `PONG`，`turn_end: completed` |
| `workbuddy` / `deepseek-v4.1-flash` | `PONG`，`turn_end: completed` |

这两行意味着整条链路是通的：DSH 按命名空间找到 provider → 走本插件的 adapter → 驱动去跟客户端说话 → 流式结果回到会话里。

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

`_probe/` 里放开发期的一次性探针与抓到的原始协议快照，不入库、不发版：

- `client-render.mjs`：用桩把浏览器半身渲染成元素树并断言（不需要 DSH、不需要浏览器）；
- `render-html.mjs`：把同一份 `client.js` 渲成静态页（`out/preview.html` + `preview.png`），并注入一段自测脚本，量出溢出、卡片高度、进度条比例、页签 `aria-selected`——版式问题是可数的，不必靠眼睛；`--only=<n> --shot=<path>` 只渲一张图并按实际高度截屏；
- `measure.mjs`：把上面那份自测脚本的 `<pre id="report">` 数字读回终端；
- `three-rows.mjs`：两行 Loader 的注册与隔离；
- `qoder-*.mjs`：协议探测（控制帧、`thinking_config`、`off` 与 `low` 的实际差异）。

README 里的三张图就是 `render-html.mjs` 的输出（**本地桩数据渲染，只示版式**）。
