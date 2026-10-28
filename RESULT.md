# RESULT — dsh-agent-bridge 标记泄漏与配额同步

更新时间：2026-10-28（F-080 收工）
状态：用户报的问题均已定位。F-080（参数闭合标签缺 `parameter` 一词）已修复并有红→绿测试，
      真机 3/3 验证通过。另查明"乱码"是宿主 Markdown 渲染所致，非插件缺陷。

## 一、用户报的现象与真实原因

原始描述："用 Qoder 反代模型经常输出那一大串…有时候还会被那些东西阻断输出"。
后续追加："在 CyberWork 里面的对话调用 Qoder 的 deepseek 还是总出现问题，比如输出被停止，
还有这种乱七八槽的输出：[乱码样本]"

拆成两类，根因完全不同：

### 1. 标记泄漏到屏幕上（"那一大串"）

Qoder 驱动不能原生调工具 —— `runtimeArgs()` 传 `--disallowed-tools *` 和 `--tools ''`，
工具带被清空。它只能让模型把调用写成文本、再从文本里正则回收。任何一处回收失败，
标记就原样上屏。而 `toolPreamble()` 恰恰在教模型写这种标记，所以泄漏面很大。

泄漏点不是一个，是四个通道 × 多个变体，逐个查出来的：

| 编号 | 缺陷 | 表现 |
| --- | --- | --- |
| F-071 | 关闭侧空格 `</ ｜｜DSML｜｜parameter>` 漏过所有正则 | 68% 的失败来自这一种拼法 |
| F-073 | 标签名在三处硬编码，`<function_call n` 中途放行 | 流式 14 红，批量全绿 |
| F-075 | reasoning 通道只有 stripLeak，没有块级 hold | 9 种切分里 5 种泄漏 |
| F-076 | WorkBuddy 用"见过闭合标记"当"块已闭合" | 逐字符推流必漏 |
| F-077 | **历史回放不清洗**，一次泄漏被永久强化 | 见下 |

F-077 是最关键的一条，也解释了"经常"：修复前泄漏的标记被当普通文本存进 assistant 回合，
之后每轮都原样回放。模型读回自己的标记，当成既定格式再写一遍 —— 自我强化闭环。

实测证据（同一段标记，只改承载角色）：

- 放 assistant 回合（被清洗）→ Qoder 回答"前一条只说了「我先确认一下状态。」"，明确表示没看到标记
- 放 user 回合（不清洗）→ Qoder 原样写出 `｜｜DSML｜｜`、`invoke`、`parameter`

清洗只对 assistant 生效。用户问"`<invoke name="pwsh">` 是什么意思"是在讲语法，
删掉就毁了那句话本身；这个不对称由测试两侧钉住。

### 2. "输出被阻断"

真机抓帧找到的，不是卡死，是**排队，而且一句话都不说**：

    {"type":"system","subtype":"model_queue_status","status":"queued",
     "queue_count":9741,"wait_time_ms":3261000,
     "queue_wait_elapsed_ms":0,"queue_max_wait_ms":3600000}

dfmodel 前面排 9741 个请求，预计 54 分钟。账户在扣（实测 2493→2181→2129→2126），
零个 chunk，回合永不失败。因为 `type:"system"` 帧完全没被处理：

1. 心跳每帧都把 deadline 往后推（`onEvent` 第一行），5 分钟空闲守卫形同虚设 ——
   只要队列在推进就永不超时，而服务自报上限是整整一小时。
2. 帧里的排名和预估等待全被丢弃，调用方无法区分"排第 9741 位"和"进程卡死"。

修法见 F-078：15 分钟预算（大于空闲超时、小于服务上限，测试钉住这个区间），
首次队列帧发一条人读的提示并去重，超预算以 `timeout` 失败（TIMEOUT，可重试）。

### 3. 配额实时同步（F-072）

原来是 5 分钟定时器，与逐轮消耗脱节。改为每轮结束后 `catalog.refreshQuota()`，
单飞、失败保留上一个好数字、不 await 以免拖慢回合。

## 二、验证

### 自动化

74 个测试文件，`npm run check` exit 0。本轮新增：

- `test/dsml-spelling-matrix.mjs` — 4800 组合拼法性质测试 + 3072 组合 stripLeak 扫描
- `test/dsml-stream-matrix.mjs` — 70 条字符流切分
- `test/qoder-reasoning.mjs` / `test/workbuddy-reasoning.mjs` — 两个驱动的推理通道
- `test/history-scrub.mjs` — 历史清洗 + 四条回放路径的审计
- `test/quota-refresh.mjs` — 配额刷新
- `test/qoder-queue.mjs` — 队列帧处理（用抓到的原始帧，只改被测字段）

每条修复都做了反向验证（撤掉修复必须变红）：

| 撤掉什么 | 结果 |
| --- | --- |
| WorkBuddy 的块闭合判据 | 2 红 |
| settle 里的 truncateOpenMarkup | 1 红 |
| replayText 的历史清洗 | 1 红 |
| user 回合豁免 | 1 红 |
| toWireMessages 的清洗 | 1 红 |
| 队列帧处理 | 2 红 |
| 队列预算 | 1 红 |
| 队列去重 | 2 红 |

### 真机

两个驱动各 8 轮，历史里带一段泄漏标记：

    qoder      leaks=0 fails=0 calls=4 reasoning=2081b 参数逐字节=YES avg=2787ms
    workbuddy  leaks=0 fails=0 calls=4 reasoning=0b    参数逐字节=YES avg=1918ms
    VERDICT CLEAN

配额同步实测生效（Qoder 2036→2035）。参数保真用 149 字符含引号、反斜杠、制表符、
中文、emoji、代理对的载荷验证，两个驱动都逐字节一致。

### 最终验收（用户两次重启后的收工检查）

代码一致性：7 份关键文件哈希与仓库逐个比对，0 差异 —— 加载的确实是 `2dc5a0c`。

两个驱动各 6 轮普通请求（含 3 条会触发 `<` 的回答），历史里塞一段未闭合泄漏标记：

| 驱动 | 可用 | 泄漏 | 参数逐字节 | 延迟 | 配额 |
| --- | --- | --- | --- | --- | --- |
| WorkBuddy | 6/6 | 0 | YES | 1.6–2.1s | 7,155 积分不变 |
| Qoder | 6/6 | 0 | YES | 1.2–10s | 1,652 credits |

含 `<` 的回答完整到达，例如 Qoder：

    In JavaScript, `<` is the less-than relational operator, which compares its two
    operands—coercing…（修复前这类回答会被砍掉一半）

**Qoder 队列实测**：11 个模型全部真实作答（8–14 秒），8 个模型带工具调用全部成功
（9.7–11.9 秒），无一排队。之前观察到的 4000+ 排队是瞬时拥堵窗口，不是常态 —— 我曾在
那个窗口里做检查，把临时状况误判为架构问题。价格与排队深度未发现相关性。

**Qoder 15 分钟队列预算真机验证**：在拥堵窗口内实测 +935s 精确触发，先播报
`queued behind the vendor's model — 4451 requests ahead, roughly 8 minutes to go`，
到点以 `TIMEOUT` 结束并附最新位置与重试建议。修复前同样情形是沉默一小时。

**一个被排除的假象**：验收中 WorkBuddy 曾说 `my tool calls keep coming back as bare "ok"`。
追查确认是探针脚本用字面量 `ok` 当工具返回值所致；换成真实多行工具输出后，模型正确
转述了 `Get-Date` 的结果，无任何抱怨。非插件缺陷。

## 二·补 F-080：参数闭合标签缺 `parameter` 一词（真正的功能性缺陷）

用户第二次报障后，不再靠合成样本猜，改为直接解码真实会话日志（`session.v4.jsonl.zstd`
是 zstd 追加流，按小端 magic `0x28 B5 2F FD` 切帧后逐帧解压）。

### 两条报障其实同源

日志里 `session-87c61dd3`（CyberWork，1407 行）有一条决定性的失败记录：

    "type":"llm/retry"  … "failure": {
      "message": "qoder: the model wrote call syntax as text and none of it could be
                  recovered … (353 characters, reaching for `command`)",
      "code": "EMPTY_RESPONSE" }

这就是"输出被停止"。同一会话里还有真正执行过的工具调用：

    {"command": "ssh jp '… nproc'</｜｜DSML｜｜>\n
     <｜｜DSML｜｜ parameter name=\"description\" …>Check apt packages …</｜｜DSML｜｜>\n
     <｜｜DSML｜｜ parameter name=\"timeoutMs\" …>90000</｜｜DSML｜｜>\n"}

`command` 长 237 字符，把另外两个参数当成字面标记吞了进去。

### 原因

`lib/dsml.js` 的 `PARAMETER` 正则注释原文写着"`parameter` 在开标签上可选，在**闭**标签上必需"。
但真实数据里模型绝大多数时候写的是不带该词的裸闭合 `</｜｜DSML｜｜>`。逐帧普查 CyberWork 会话：

| 闭合拼写 | 次数 |
| --- | --- |
| `</｜｜DSML｜｜>`（裸） | **3151** |
| `</｜｜DSML｜｜ parameter>`（带词） | 92 |

差 34 倍。闭合匹配不上，`[\s\S]*?` 就一路吞到下一个带词闭合或块尾：

- **多参数**：第一个参数吞掉其余全部 → 命令带标记 → shell 报语法错 → 执行失败
- **单参数**：`parametersOf` 返回 `{}` → 调用被丢弃 → `EMPTY_RESPONSE` → 输出被停止

一个正则，两个症状。

### 修法

闭合处的 `parameter` 改为可选：

    `…([\s\S]*?)</${SEG}\s*(?:parameter\s*)?>`

安全性：`</｜｜DSML｜｜ invoke>` 和 `</｜｜DSML｜｜ calls>` 在该位置都有词，`\s*>` 要求紧跟
`>`，因此不会被误当参数闭合。

### 验证

- 新增 `test/qoder-bare-close.mjs`，5 项断言，覆盖普查到的 8 种闭合拼写
  （裸 / 单栏 / 三栏 / 带词 / 无空格带词 / ASCII 双竖线 等）
- **反向验证**：去掉修复后 5 项全红；工作区哈希前后均为 `31a98e395ea0acb5`，恢复自校验通过
- 真机 3/3：每次都是三个独立参数、值内零标记、`$a` 完好
  （`$a = 3; "a is $a"; [char[]]'abc…' | Select-Object -First 5` → 输出 `a is 3 / a / b / c / d / e`）
- 破坏性对比：修复前那条命令 exit 1（`术语 '<' 不会被识别为 cmdlet`），修复后 exit 0

### 第二种形态：一个标签同时闭合与开启（F-080b）

真实会话里还有 8 处这样的写法：

    …20261027-fofa-idle-batch.sh</｜｜DSML｜｜ parameter name="old_string">  echo "…

`file_path` 的值末尾那个标签既是前一个参数的闭合，又带着下一个参数的属性。任何只看闭合的
规则都匹配不了它。效果与 F-080a 相同：值把下一个参数吞成字面标记，工具收到一个尾巴带标签
的文件名，编辑被拒。

修法：在规范化阶段先把它拆成 `</X><X parameter …>`——解析器本来就懂这个形式，拆分只是把
模型的意图说明白。前瞻断言 `(?=(?:name|parameter|key)\s*[=:])` 保证正常闭合
（`</… parameter>` 后面没有属性）不受影响。

新增 `test/qoder-close-as-open.mjs`，4 项断言；**反向验证**：从 `normalizeCallSyntax` 中
移除该步骤后 2 项变红，哈希前后一致（`6b1d563e4d0731d2`）。

真机验证时发现一个方法陷阱：第一次跑三种形态，模型在第 2 轮自己选了 `pwsh` 而不是 `edit`，
于是"3/3 通过"并没有测到第二种形态。改成只提供 `edit` 一个工具、强制选择后重测，
3/3 才真正走通（`file_path` / `old_string` / `new_string` 三个独立参数，
多行且含 `========` 的 `old_string` 完好）。

### 用真实日志度量修复效果

把会话里记录下来的参数值原样当作输入（记录值就是"原文去掉开标签"，不需要重构分隔符），
重新解析后看值内是否还残留标签：

    会话 session-87c61dd3 工具调用总数            258
      仅提到 DSML 一词、无标签（本来就干净）        2
      值内含真实标记标签（真污染）                138
      修复后恢复为干净值                        138/138 = 100%

判据修正过程也有教训：第一版用 `[｜|]{2}|DSML` 作判据，把 shell 的 `||` 或运算符和命令里
提到的 `*DSML*` 文件名都算成污染，得出"154/258 被污染"的虚高数字。改成"值内出现标记标签
（`<` 或 `</` 紧跟栏）"后才是 138。

### 第三种形态：只写开标签，一个闭合都没有（F-081）

用户第二次报告，样本是「一条命令 + 三个参数值各占一行，没有任何标记，也没有执行」：

    $t="D:\...\T20261028-04-iis6-cred-hunt"; Get-ChildItem $t -Recurse -File | ForEach-Object { ... }
    List files in active task dir
    30000
    D:\DshWork\CyberWork

以及 `parameter name="timeoutMs" string="false">30000D:\DshWork\CyberWork`——`workdir` 的开标签
被当成标记剥掉了，它的值留了下来贴在上一行末尾。

在 `session-87c61dd3` 的 turn 27 step 2 找到对应记录：`assistant/message` 的 text 块正是这四行，
后面直接跟 `step/end`、`turn/end`，**中间没有 `tool/call`**。也就是说命令根本没执行，只是被显示
出来了——比执行失败更糟，用户会以为跑过了。

模型写的是这个形状（开标签齐全，闭合一个都没有）：

    <｜｜DSML｜｜ invoke name="pwsh">
    <｜｜DSML｜｜ parameter name="command" string="true">Get-ChildItem $t …
    <｜｜DSML｜｜ parameter name="description" string="true">List files in active task dir
    <｜｜DSML｜｜ parameter name="timeoutMs" string="false">30000
    <｜｜DSML｜｜ parameter name="workdir" string="true">D:\DshWork\CyberWork

两处独立失效：

1. `SEPARATOR_CLOSED_PARAMETER` 的取值终止条件只有「分隔符 / `</parameter>` / `</invoke>` /
   字符串结尾」，**不认下一个参数的开标签**。于是 `command` 一路吞到末尾，把后面三个参数当成
   字面标记收进自己的值里。
2. 没有 `invoke` 名字可恢复时，标记被剥离、**值却作为正文活了下来**并显示给用户。

修法：给终止条件加 `PARAMETER_OPENER_LOOKAHEAD`；另加 `orphanArgumentSpans`，在「没能恢复出
任何调用」时把无人认领的参数块整段切掉。后者只在 `calls.length === 0` 时生效——一旦有调用，
它自己的 span 已经覆盖了参数。

**边界**：`prose-safety` 与 `dsml-nameless-envelope` 两个既有测试立刻抓到第一版的过度切割——
终止符只认 `</parameter>` 和 `</invoke>`，导致无名 `calls` 信封之后的散文被一起吃掉。改成认任意
闭合标签 `</${SEG}` 后恢复。这正是"改了要证明没弄坏别的"的价值。

新增 `test/qoder-opener-only.mjs`，5 项断言；**反向验证**：分别移除两处修复，各自变红
（第 1 处红 1 项，第 2 处红 2 项），哈希前后一致（`983c4d5f9109f198`）。

真机四参数验证 3/3：`command` / `description` / `timeoutMs` / `workdir` 四个独立参数，
`timeoutMs` 正确转成 number，`{0,-9}` 格式串完好，文本通道零泄漏。其中一轮客户端 90 秒超时，
加长预算单独重跑后 11.2 秒成功——是拥塞，不是缺陷。

### 结构性方案：改教紧凑 JSON 格式（F-082）

前三轮修的都是同一类伤：每次调用两个标签、四个参数十个地方可以拼错，而尖括号格式**没有
任何词法规则规定值在哪里结束**。F-080a 是闭合拼错、F-080b 一个标签干两件事、F-081 干脆
不写闭合——三种拼写，一个病根。

#### 先验证"能不能彻底换掉"

按"先做最小实验、成了再改"的顺序，实测了三条路：

| 路线 | 结论 |
| --- | --- |
| CLI 原生工具调用（`--tools`/MCP） | **可行**：给 MCP 工具时模型原生产生 `mcp__probe__probe_echo`，零 markup |
| 让 DSH 执行工具、结果回传 CLI | **不可行**：`stream-json` 输入只认第一条 user 消息 |
| 换调用格式 | **可行**，见下 |

第二条的判据是硬实验，不是推测。用 BANANA42 做无工具对照：

    三条消息（陈述 / 确认 / 提问） →  "Acknowledged — I'll remember it" ×2，答不出词
    拍平成一条消息               →  "BANANA42"

即只有第一条 user 消息到达模型——这正是插件一直把历史拍平成一段文本的原因。所以
「MCP + 主机执行」在现有 adapter 契约下走不通：DSH 必须自己跑工具（沙箱、权限、UI），
而把结果交回 CLI 需要历史回放，协议不支持。

顺带确认了 `--tools ''` 只限制内置工具，真正挡掉 MCP 的是 `--disallowed-tools *`。

#### 换格式为什么能根治

紧凑格式：一个信封、一个 JSON 载荷、一个闭合标签。

    <｜｜DSML｜｜ invoke name="edit">
    <｜｜DSML｜｜ arguments>{"file_path": "…", "old_string": "…"}</｜｜DSML｜｜ arguments>
    </｜｜DSML｜｜ invoke>

|  | 每参数一标签 | 紧凑 JSON |
| --- | --- | --- |
| 四参数调用所需标签 | 10 | 3 |
| 值的边界由什么决定 | 标签拼写 | JSON 引号，精确 |
| 退化时的表现 | 值吞掉后续参数（**数据损坏**） | 标签缺失但 JSON 完整（**可回收**） |

最后一行的差别是决定性的，而且是实测出来的：七例真机对照里唯一的失败是模型写完了完整
JSON 却漏掉 `</arguments>`。前者无解——一个吞了后续参数的字符串和"值里本来就含标记"无法
区分；后者只要按大括号配对就能完整取回。

#### 实测

换格式的对照实验（同一批用例，七例，含两个对抗用例）：

    每参数一标签   5/5   （干净上下文里模型本来就没问题）
    纯 fenced JSON 4/5   （模型把 command 写在顶层而不是 arguments 里）
    紧凑 JSON      7/7   （含"值里带大括号和引号""值里带 parameter 一词"）

最后 7/7 是在加了大括号配对兜底之后；加之前是 5/7，两个失败里一个是缺闭合标签（可回收），
一个是空回复。**这就是选择紧凑格式的依据：不是它更容易写对，而是它写错时还能救回来。**

换完之后走真实驱动端到端验证，并转储原始帧确认模型真的在写新格式：

    文本通道：<｜｜DSML｜｜ invoke name="pwsh"><｜｜DSML｜｜ arguments>{"command": …}
    arguments 标签对：12        parameter name= 标签：0

即 3 次调用共 12 个标签全部正确，旧的每参数标签零出现。

#### 实现

- `lib/dsml.js`：新增 `ARGUMENTS_PAYLOAD` / `ARGUMENTS_OPEN` 两个正则、`firstJsonObject`
  （按大括号配对，识别字符串与转义，因此值内的 `}` 不会提前截断）、`compactArguments`。
  `parametersOf` 只有在**一个参数标签都没找到**时才读紧凑载荷——两种方言不混读，否则散文里
  一段 JSON 会覆盖真实参数。
- `orphanArgumentSpans` 也切掉无人认领的载荷，否则写了 JSON 却没写工具名时，整个 JSON 会作为
  正文显示——F-081 的同一个错误换了个拼写。
- `drivers/qoder/conversation.js`：`toolPreamble` 改教紧凑格式，并明确写"不要一个参数一个标签"。
- **旧方言完整保留**：模型仍会出于习惯写旧格式，而且磁盘上已有的历史不会因为改了提示词就变。

新增 `test/qoder-compact-form.mjs`，10 项断言。**反向验证**：移除紧凑读取 → 4 项红；
移除载荷切割 → 1 项红；哈希前后一致（`b0f9ae793a6baf55`）。

`test/qoder-calls.mjs` 的"语法只示范一次"原本数的是 `calls>` 信封，随格式一起改成数
`invoke name=` 与载荷示例，并新增一条断言：提示词里不得再出现每参数一标签的示例。

### 积分"实时同步"曾经是假的（F-083）

用户最初的两件事里，第二件是「实时积分情况也要做好同步」。复查时发现它一直是坏的，
而且坏得看不见——所有只读检查都会通过。

#### 怎么发现的

先证明读得通：`providerInfo().name` 上确实有真数字。

    WorkBuddy · 7,255 积分
    Qoder · 1,752 credits left

再证明刷得动——给 `catalog.refreshQuota` 加计数包装，跑一个 turn：

    calls before the turn: 0
    refreshQuota calls during the turn: 1
    last result: {"remaining":1752,...,"used":1048}

接线是通的，turn 后确实刷了一次。但**两次返回的数字一样**。当时最容易就此收工，写一句
「可能模型免费」。不能这么收。

#### 根因

`drivers/workbuddy/index.js`：

```js
export const CREDIT_TTL_MS = 60 * 1000;

async quota(options = {}) {
  if (options.fresh !== true && cachedCredits !== undefined && ...) {
    return cachedCredits.value;   // ← 命中缓存，返回 turn 之前的数字
  }
```

而 `lib/index.js` 的接线上：

```js
quota: driver.quota === undefined ? undefined : () => driver.quota(),
//                                                 ↑ fresh 在这里被丢掉了
```

于是 `refreshQuota()` 每次都在 60 秒窗口内命中缓存，把**花掉积分之前**的数字当成新的
发布出去。turn 后立刻看，看到的是旧数字——正是「没同步」的手感。

驱动缓存本身是合理的：计费端点是用户自己账户上的计费调用，模型选择器每次渲染都问一次会
把请求打爆。错的是刷新时不告诉它「这次要新的」。

对比：Qoder 的 `quota()` 没有缓存，每次都真读。所以只有 WorkBuddy 受影响。

#### 修法

- `lib/index.js`：把接线抽成具名可测的 `quotaReader(driver)`，`fresh` 透传。
  抽出来是因为它埋在 `mount` 里就测不到——要测一行参数传递得先起一个真厂商。
- `lib/catalog.js`：`refreshQuota()` 传 `true`（这是花完钱之后的刷新，缓存毫无意义）；
  定时 `refresh()` 传 `false`（省一次计费调用，下一轮缓存反正也过期了）。

#### 验证

新增 `test/quota-fresh.mjs`，6 项，用一个按 WorkBuddy 方式记忆 60 秒的假驱动：

- turn 后刷新必须拿到新值（旧值 100 → 新值 40）
- 去掉 fresh 时必须拿不到新值（复现缺陷本身，否则前一条没在测东西）
- 刷新失败保留上次的数字，不把 header 清空
- 并发刷新只打一次计费端点
- 接线把 flag 原样送到驱动（`true` / `false` / `undefined` 三种）
- 没有余额的厂商不贡献读取器

**反向验证**：把 `#readQuota(true)` 改回无参 → 红 2 项；把 `quotaReader` 改回丢弃 flag
→ 红 1 项；哈希前后一致。

第一版反向验证暴露了一个真问题：`lib/index.js` 那半边**不红**——因为测试直接构造
`Catalog` 并自己传 `(fresh) => driver.quota({ fresh })`，绕过了插件自己的接线。也就是说
原来的 bug 位置之一完全没被覆盖。这才有了把接线抽成 `quotaReader` 并单独测试。

#### 修复后数字为什么还是不动

跑了 turn，WorkBuddy 仍是 7255、Qoder 仍是 1752 / used 1048。现在每次都是真读（缓存绕过了），
所以这不是同步问题，是计费粒度：

- WorkBuddy 的 `remain` 是整数，`x0.11 credits` 是一次调用的倍率，1.6 秒的 flash turn 花不到 1 积分
- Qoder 的 `remaining` 同样是整数

**能证明的**：读路径是活的、turn 后确实触发、强制新鲜、并发不放大。
**不能证明的**：厂商到底扣没扣——这需要跨足够多的 turn 才看得见。报告里不写「已验证扣费」。

### 另一条：乱码输出不是插件造成的

用户贴的样本里 `-` 变成 `−`(U+2212)、`'` 变成 `′`(U+2032)、`$` 消失、`20_archive` 断成
`20 / a / rchive`。这些都是 **Markdown + 数学渲染**的特征：`$…$` 之间按 LaTeX 排版
（`-` 是减号、`'` 是撇号、空格被忽略），`_a_` 被当成斜体吃掉下划线。

第二次报告里这条机制可以精确对上。原命令是：

    $t="D:\DshWork\CyberWork\10_active\..."; Get-ChildItem $t -Recurse -File | ForEach-Object { "{0,-9} {1}" -f $_.Length, $_.FullName }

第一个 `$` 开数学区、第二个 `$`（`Get-ChildItem $t` 的那个）闭数学区，中间那一整段被当公式排版：

| 屏幕上 | 真实字符 | 原因 |
| --- | --- | --- |
| `t="D:\…";Get-ChildItemt` | 两端各有一个 `$` | 数学定界符被吃掉 |
| `2026−10` | `2026-10` | 减号变 U+2212 |
| `10 a rchive` | `10_archive` | 数学斜体把字母分开、下划线消失 |
| `. L e n g t h` | `$_.Length` | 同上 |
| `{0,−9}` | `{0,-9}` | 减号变 U+2212 |

证据：对全部 10 个会话做指纹检索，带 `−` 的 `2026−10` **只出现在当前会话**（用户粘贴 +
本文引用）；CyberWork 两个会话里 `2026-10` 分别是 1209 和 937 次，**全部是正常 ASCII**。
即落盘的命令字符完全正确，只有屏幕显示被渲染坏。

宿主 `app.asar` 内含 katex，确认存在数学渲染。此问题在 GUI 渲染层，插件侧不改文本是对的
（改文本会让真正需要渲染的内容也坏掉）。

## 三、过程中的方法教训（已写入提交信息）

1. **判据写错拼法是静默失效**。`hasUnclosedCallMarkup` 第一版数 ASCII `|`，而规范化器
   输出全角 `｜`，谓词恒为 false，泄漏照旧 —— 测试全绿但什么都没测。
2. **绿测试可能什么都没测**。做角色隔离对照时，指令是"用工具打印日期"，两个驱动都直接
   调工具、正文 0 字节，模型没有模仿的机会。改成不给工具、要求成文描述才拿到结论。
3. **反向验证要自校验**。有一次驱动循环在"会挂住"的用例上被杀，恢复步骤没执行，工作区
   留着故意打断的代码 —— 与之前 stash 丢修复是同一类事故。改用 `_counter.mjs`：
   先哈希、写完跑、恢复、再哈希，不匹配拒绝报告。
4. **挂住不是红色结果**。`no-budget` 反向验证表现为挂住而非变红：测试没关子进程、
   没超时兜底。已加 `Promise.race` 20s 上界 + `conversation.close()`。
5. **测错层等于没测**。驱动层抛带 `bridgeKind` 的原始错误，转成 `code` 在 adapter 层。
   直接断言 `failure.code` 是我搞错了层，现在两层各测各的事实。
6. **过滤管道本身会丢结论**。`Select-Object -First 30` 要凑够行数才输出，导致 25 分钟
   看不到日志、误判为挂死。改为直接写文件。
7. **只证明"问题不再出现"不算通过，还要证明"别的东西没坏"**（F-079 的代价）。上一轮
   修泄漏时引入的截断回归，把任何含 `<` 的正常回答砍半（实测 5 条真实回答里 2 条受损、
   共 121 字符），而当时全量测试是绿的 —— 因为没有一条测试问过"守卫会不会吃掉正确
   答案"。现在 `test/prose-safety.mjs` 专门守这个方向。
8. **测试的判据和被测代码一样可能出错**。`history-scrub` 原来用手写正则作判据，列了
   `invoke`/`parameter` 却漏了 `tool_call`/`antml`，导致新增的三个用例根本没被检查，
   反向验证假通过。改为调用模块自己的 `hasLeak`。
9. **合成样本猜不出真实缺陷，去读真实日志**。前两轮我用自己编的命令测，结论都是"插件干净"，
   而用户照旧报障。改成解码真实会话日志后，一次就拿到 `llm/retry` 的失败记录、被污染的
   `tool/call` 参数、以及 3151:92 的闭合拼写比例。**报障原文本身就是最好的 fixture。**
10. **普查有限的状态空间，别一种形态一种形态地补**。闭合标签的拼写是有限集，逐帧计数一次
    就看出哪一种是主流（裸闭合 3151 次）。此前每轮补一种拼写的做法必然输给它。
11. **改配置脚本要验证替换真的命中**。`p.scripts.check.replace('test/qoder-queue.mjs', …)`
    在 `check` 里根本不存在这个串，静默无操作；靠 `git diff` 零输出才发现。加锚点断言与
    "replace 是否改变字符串"的检查后才算改对。
12. **判据里的字符类会把普通语法当成污染**。统计污染率时用 `[｜|]{2}|DSML`，而 shell 的
    `||` 或运算符、命令里提到的 `*DSML*` 文件名都被算进来，得出 154/258 的虚高数字。
    改成"值内出现标记标签"后是 138。**判据宽一格，结论就偏一个量级。**
13. **绿了要先问"它测到了我说它测的东西吗"**。真机验证三种形态，第 2 轮模型自己改选了
    `pwsh`，于是"3/3 通过"里根本没有第二种形态。只提供 `edit` 一个工具强制选择后重测，
    才是真的 3/3。这已是本项目第三次栽在"绿测试没测到目标"上。
14. **测试用例本身可能要求一件做不到的事**。我写过一个"值里字面包含闭合标签仍要完整保留"
    的用例——字节上与真正的闭合完全相同，任何解析器都无法区分。这种用例不是发现了缺陷，
    是把不可能当成需求。删掉并在注释里写明原因。

## 四、未决项

- **Qoder 的架构性脆弱**：`--disallowed-tools *` 让原生工具调用不可用，文本标记回收是
  唯一路径，本质上比 WorkBuddy 的原生调用脆。真正的解法是原生调用，但这需要确认 Qoder
  CLI 去掉该 flag 后是否支持 `tools` 参数 —— 未验证。**这是已知风险，不是已知故障**：
  当前两个驱动的实测结果都是 0 泄漏。
- **WorkBuddy 不出推理**：`deepseek-v4.1-flash` 的 reasoning 恒为 0 字节。不是缺陷，
  是该模型不上报思考内容。
- **Qoder 厂商侧队列**：插件无法控制排队深度，只能如实播报并在预算内结束。若长期拥堵，
  可换模型（11 个可选）或改用 WorkBuddy。
- 推送曾多次因网络失败（`Connection was reset` / 443 超时），当前已全部推送。

## 五、交付索引

- 项目：`D:\dshWork\CyberWork\10_active\dsh-agent-bridge`（分支 main，最新 `2dc5a0c`）
- 关键改动：`lib/dsml.js`、`lib/messages.js`、`lib/catalog.js`、`lib/adapter.js`、
  `drivers/qoder/conversation.js`、`drivers/workbuddy/conversation.js`
- 新增测试：`test/dsml-spelling-matrix.mjs`、`test/dsml-stream-matrix.mjs`、
  `test/qoder-reasoning.mjs`、`test/workbuddy-reasoning.mjs`、`test/history-scrub.mjs`、
  `test/prose-safety.mjs`、`test/quota-refresh.mjs`、`test/qoder-queue.mjs`、
  `test/qoder-bare-close.mjs`（F-080a）、`test/qoder-close-as-open.mjs`（F-080b）
- 测试总数 77，`npm run check` exit 0
- 已同步到 `~/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/`，哈希一致
- 缺陷编号 F-001…F-080 全部处理完毕
- 真实会话取证工具：`tools/_session.mjs`（按帧解 zstd）、`tools/_fingerprint.mjs`
  （指纹定位）、`tools/_spellings.mjs`（闭合拼写普查）、`tools/_counter-bare.mjs`
  （自校验反向验证）

