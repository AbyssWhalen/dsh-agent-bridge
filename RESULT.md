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

### 另一条：乱码输出不是插件造成的

用户贴的样本里 `-` 变成 `−`(U+2212)、`'` 变成 `′`(U+2032)、`$` 消失、`20_archive` 断成
`20 / a / rchive`。这些都是 **Markdown + 数学渲染**的特征：`$…$` 之间按 LaTeX 排版
（`-` 是减号、`'` 是撇号、空格被忽略），`_a_` 被当成斜体吃掉下划线。

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

