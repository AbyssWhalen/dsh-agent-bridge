# 设计

这份文档记的是「为什么这么做」，不是「做了什么」——做了什么看代码和 README。

## 一、只共享宿主，驱动不共享传输层

两家的传输方式完全不同：

| 厂商 | 通道 |
| --- | --- |
| Qoder | 子进程 + 控制帧（`initialize` / `set_model` / `none` 语义） |
| WorkBuddy | 纯 HTTP + SSE |

所以插件**没有**统一的「协议转换层」。这种层要把每家的怪癖都建模一遍，一旦某一处判断错了，两家会同时坏。驱动各自说话，宿主只管池化、刷新、命名空间、注册、错误映射。

宿主给驱动的契约很小（`lib/driver.js` 校验）：`id` / `locate()` / `listModels()` / `quota?()` / `createSession()` / `normalize()`，可选 `efforts?(row)`、`ownSystemPrompt`。少一个必选成员，这一家就降级成「不提供」，而不是让整个插件加载失败。

## 二、驱动不依赖 DSH

`drivers/` 里没有一行 `import … from '@deepseek-ai/dsh-llm'`。DSH 的消息形状只在 `lib/messages.js` 里投影一次，变成中立的 `{role, text}` 列表。

好处是同一套驱动以后可以直接给一个 OpenAI 兼容外壳复用，不用重写；坏处是这层投影必须把 DSH 的每种内容块都考虑到——附件、工具调用、思考块，漏一个就在真实会话里表现为「模型没看见我说的话」。所以它只有一处，且有测试。

## 三、能力靠特性探测，不靠猜

额度、思考强度、上下文窗口都是**可选成员**：上游不声明，宿主就不显示，也不填默认值。宁可少一个控件，不给一个假数字。

这条规则是有代价的，而且是刻意接受的：DSH 里不出现强度选择器，用户看不出「是这个模型没有档位」还是「插件没做」。所以每次踩到都往 README 的已知限制里写一句，让「没有」本身是可解释的。

## 四、一个包，两个真组件

`cordis.patch.yml` 插的是两行，同一个模块、两个 `config.component`：

```yaml
- insert:
    - id: agent-bridge-workbuddy
      name: dsh-agent-bridge
      config: { component: workbuddy }
    - id: agent-bridge-qoder
      name: dsh-agent-bridge
      config: { component: qoder }
```

所以插件列表里是一张包卡，点进去是「包含的组件：共 2 个」——两行，每行一个状态灯、一个 `rowId`、**一个 DSH 自己的开关**：

```
插件
└── dsh-agent-bridge                       ← 包卡 · 共 2 个 · 2 运行中
    ├── agent-bridge-workbuddy  运行中  [开]  ›   WorkBuddy  已开启 · 18 个模型 · 6,402
    └── agent-bridge-qoder      运行中  [开]  ›   Qoder      已开启 · 14 个模型 · 2,794 / 2,800
```

这两行不是画出来的卡片，是 Loader 的行：每一行是**一次独立的 `apply(ctx, config)`**，一个实例只管一家。行由 DSH 原生渲染，开关就是 DSH 的开关（`pluginManager.setPluginEnabled(entryId, …)`），关掉一行只卸载那一行。

因此有三条硬规矩：

1. **开关只有一处**：行上那个。行的详情页里不再画第二个开关（那会是同一个厂商两个开关、两个状态源），只写一句「开关就是上面这一行自己的开关」。
2. **页面各自订阅各自的路由**：`/plugins/dsh-agent-bridge/<id>/status`。两家各自的 store 独立轮询，一家读失败不连累另一家。
3. **行实例不读本地 `disabled` 列表**：行在跑就是开，行被关就没了。`removed` 仍然独立——驱动文件被移出包时该行仍显示「已卸载」，可以就地「恢复」。

行详情页走 `plugins.row.config`，key 是 DSH 自己拼的 `<包名>#<rowId>`，也就是 `dsh-agent-bridge#agent-bridge-qoder`。**改名就意味着这里也要改名。**

## 五、两条路由，因为出错代价不同

| 路由 | 方法 | 作用 | 保护 |
|---|---|---|---|
| `/plugins/dsh-agent-bridge/<id>/status` | GET | 只读状态文档 | Host / Origin 必须是回环 |
| `/plugins/dsh-agent-bridge/<id>/action` | POST | 开关 / 卸载 / 恢复 / 刷新 | 上者 + 必须带 `x-agent-bridge-key` |

回环 Host 检查能挡住 DNS-rebinding 的**页面**读状态，但它**不是**写操作的授权——rebinding 攻击里那个页面恰恰就是从回环发出来的。所以写操作还要一个进程级随机 key，这个 key 只随状态文档交给页面。没 key 的 POST 在读 body 之前就被 403 掉了。

这条边界是被测过的，不是推理出来的：`test/integration/host.mjs` 里有两行反例，`no key → 403`、`non-loopback host → 403`。

## 六、卸载是移动文件，不是写一个 flag

「卸载」把该组件的驱动目录移到 `$DSH_HOME/agent-bridge-removed/<id>/`，于是：

- 它不会在下次启动时被挂载；
- 它不会被下一次 `pnpm install` 顺手装回来（文件在包外）；
- 想反悔随时能「恢复」。

开关状态存在 `$DSH_HOME/agent-bridge-state.json`，`disabled` 和 `removed` 是两个**不同**的字段：前者是「先别用」，后者是「已经移走了」。合成一个字段的话，「卸载」就成了一个被重装悄悄撤销的谎话。

## 七、驱动里的几个具体决定

**前言是条件性的。** 有一个上游自带完整 agent 系统提示（含工具表），而驱动把整段对话压成一条字符串发出。如果无条件加 `PROXY_PREAMBLE`，它就会落到**用户消息里面**，位置正好和上游真正的系统提示相矛盾。所以「要不要加前言」是驱动契约的一部分：驱动可以声明 `ownSystemPrompt: true` 表示「上游自带框架，别加」。（这个问题是实测出来的，见 [verification.md](verification.md)。）

**Qoder 必须跑它自己的 worker runtime。** 公开端点对第三方模型请求一律 503（`/api/v2/model/list`、`/model/v1/chat/completions`），而 `/api/v2/quota/usage` 正常——所以这不是鉴权问题，是它们只服务桌面传输。诚实做法只有一个：跑那个 runtime，说它的协议。

**Qoder 的历史与 DSH 的无状态契约要对齐。** runtime 自己维护对话历史（热态一轮约 1.6s，冷态约 6s），而 DSH 的 `stream()` 每次都给完整消息列表。当来的是「上一条列表 + 一个尾部用户轮」且系统提示没变时，只发那一轮；任何别的变化（编辑、压缩、分叉）都意味着子进程的历史不再描述这个请求，会话用扁平化 transcript 重建。

**Qoder 的思考强度以 `thinking_config` 为准。** `isReasoning` 在两个方向上都不靠谱：它既漏掉 DeepSeek-Flash / Kimi-K3 这类「有档位但没打标记」的模型，也会给 `auto` / `q37fmodel` 编出并不存在的控件。`thinking_config.disabled` 存在 = 可以关；`enabled.efforts` 的键 = 档位；`enabled.efforts[id].is_default` = 默认档。控制通道上 `off` 拼成 `none`，命令行上是 `--thinking disabled`。

**WorkBuddy 的 `Off` 是「不发这个字段」。** 两个区的端点都对字面量 `off` 有拒绝记录，而「缺省」在每一类模型上都被实测接受。所以 `Off` 的真实语义是「上游自己决定」，这一点在 README 里如实写了，没有假装它等于「关掉思考」。

**思考强度的归一化只有一处。** `lib/effort.js` 的 `EFFORT_ORDER`、`wireEffort()`、`buildReasoning()`；每家怎么拼由驱动自己翻译（WorkBuddy 删字段、Qoder `none` / `--thinking disabled`）。宿主不猜厂商的拼法。

## 八、额度为什么在分组标题上

DSH 的模型选择器只渲染分组标题（`group.name`）和模型名（`model.name`），`model.description` 根本没被读。账户级余额放标题上出现一次；放在每个模型名上会把同一个数字重复十八遍。

代价是：provider 名字在**注册时**被读一次，而注册不能等一次 spawn。所以首次刷新之后会重新发布一次分组名（`release.replace([provider])`），余额才出现在选择器里。`adapter.js` 里的 `providerInfo()` 就是为此存在的。

而这个「重新发布」正是卸载竞态的成因：一次已经在飞的刷新，落地时仍会 announce，于是**已经被释放的路由又被注册回去**——刚被关掉的那一家自己回来了。所以 `Catalog.halt()` 必须在释放路由之前置位，之后所有 announce 都是空操作。顺序在这里不是风格问题：`halt → stop → release → close`，任何一步提前或推后都会重开这个窗口。回归测试见 `test/teardown.mjs`（它把 `listModels()` 挂住来强制制造这个竞态，而不是指望它偶发出现）。
