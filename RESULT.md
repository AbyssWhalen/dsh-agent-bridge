# RESULT — dsh-agent-bridge 标记泄漏与配额同步

更新时间：2026-10-27（W2 收工验收）
状态：用户报的两个问题（标记泄漏、实时积分同步）均已修复，有可复现的红→绿测试，
      并经用户两次重启后在真机上验收：两个驱动各 6/6 可用、0 泄漏、工具参数逐字节一致。

## 一、用户报的现象与真实原因

原始描述："用 Qoder 反代模型经常输出那一大串…有时候还会被那些东西阻断输出"。

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
  `test/prose-safety.mjs`、`test/quota-refresh.mjs`、`test/qoder-queue.mjs`
- 测试总数 75，`npm run check` exit 0
- 已同步到 `~/.dsh/profiles/desktop/node_modules/dsh-agent-bridge/`，哈希一致
- 缺陷编号 F-001…F-079 全部处理完毕

