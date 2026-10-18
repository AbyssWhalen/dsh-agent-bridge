# 兼容性

这份文档说清楚三件事：**本插件依赖 DSH 的哪些接口**、**DSH 版本对不上时会发生什么**、**升级 DSH 之后怎么用十分钟确认它还活着**。

## 一、DSH 自己会先判一次

DSH 在加载任何插件之前，会拿插件 `package.json` 里的 `peerDependencies` 与**正在运行的** DSH 版本逐条比对。规则在 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()` 里，只有两条：

1. **只比对 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 这两个前缀。** `@deepseek-ai/cordis` 不在其中——所以 cordis 的 peer 是给人看的文档，不是闸门。
2. 比对对象是**运行时版本**（`dsh-app-boot` 自己的 `package.json` 版本，也就是桌面端版本），不是 `node_modules` 里某个包实际装的版本。prerelease 参与比较（`includePrerelease: true`）。

对不上的结果是**跳过这个 bundle**，不是修好它，也不是让整个应用起不来：

```
dsh: skipping profile bundle "dsh-agent-bridge": Plugin dsh-agent-bridge@1.0.0 is
incompatible with dsh 0.2.1: peerDependencies {"@deepseek-ai/dsh-llm":"0.2.0-rc.2"}.
Running it may cause crashes or data loss. Update the plugin or install a plugin
version compatible with this dsh runtime. …
```

从用户视角看，这就是「更新完 DSH，插件没了」。

## 二、所以本插件声明的是范围，不是精确版本

```json
"peerDependencies": { "@deepseek-ai/dsh-llm": "^0.2.0-rc.2" }
```

| 写法 | 0.2.0-rc.2 | 0.2.0-rc.3 | 0.2.1 | 0.3.0 |
| --- | --- | --- | --- | --- |
| `0.2.0-rc.2`（精确锁） | 通过 | **跳过** | **跳过** | **跳过** |
| `^0.2.0-rc.2`（本插件） | 通过 | 通过 | 通过 | 跳过 |

精确锁看起来最保守，实际上最糟：DSH 每发一个补丁版，插件就在用户配置里被静默跳过，而报错信息写的是「不兼容」，看起来像插件坏了。范围写法把「同一 0.2 线的后续 rc / 补丁」当兼容处理，跨到 0.3 才拒载——`LlmAdapter` 契约真要变就是那时候变，宁可明确拒载，也不要半坏地跑起来。

`test/compat.mjs` 把这条规则钉住了：任一 `dsh*` peer 被写成精确版本、范围不再覆盖已验证版本、范围不再拒绝下一个小版本、`package.json` 与两份 README 说的版本对不上——四种情况都会让 `npm test` 失败。

### 用 DSH 自己的代码验一遍

上面那张表不是推出来的，是拿 DSH 里那个函数跑出来的。装好桌面端之后可以原地复跑（把 `$app` 指到本机的 `dsh-app-boot`）：

```powershell
$app = 'D:/CodeEditor/DeepSeek Harness/resources/app/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
node --input-type=module -e @"
const m = await import('file:///$app');
const fs = await import('node:fs');
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
for (const runtime of ['0.2.0-rc.2', '0.2.0-rc.3', '0.2.1', '0.3.0']) {
  const issue = m.evaluatePluginCompatibility(manifest, {}, runtime);
  console.log(runtime.padEnd(12), issue === undefined ? 'ACCEPTED' : 'SKIPPED ' + JSON.stringify(issue.peers));
}
"@
```

输出（本仓库 1.0.0 的实测）：

```
0.2.0-rc.2   ACCEPTED
0.2.0-rc.3   ACCEPTED
0.2.1        ACCEPTED
0.3.0        SKIPPED {"@deepseek-ai/dsh-llm":"^0.2.0-rc.2"}
```

把 peer 换回精确的 `0.2.0-rc.2` 再跑，`0.2.0-rc.3` 与 `0.2.1` 都会变成 `SKIPPED`——这就是「更新完 DSH 插件全没了」的真实机制。

## 三、被拒载之后怎么精确豁免

豁免是**一个插件版本 × 一个 DSH 版本**的精确授权，存在 profile 目录里，不写进任何包：

```jsonc
// %USERPROFILE%\.dsh\profiles\desktop\compatibility.json
{
  "dsh-agent-bridge@1.0.0": ["0.3.0"]
}
```

也可以在插件页里点，或走 CLI：`dsh plugin allow-version`（要显式 `--accept-risk`——DSH 会警告可能崩溃或丢数据，它不是在客气）。文件写坏了不会让 profile 变砖：读不出来的记录被忽略并上报，其余记录照常生效。

**豁免不等于能跑。** 它只是让加载继续；真坏了还是坏，所以下面这张表才是判断依据。

## 四、依赖的接口清单

版本号只是闸门，真正决定「能不能用」的是这些接口。每一条都标了「变化时会怎样」——大部分是降级，不是崩溃，因为宿主层是按这个目标写的。

| 接口 | 用在哪 | 变了会怎样 |
| --- | --- | --- |
| `LlmAdapter` 基类（`listModels` / `resolveModel` / `prepareCall` / `stream`） | `lib/adapter.js:26` | 加载期 `import` 就报错 → 两个组件都「无法启动」，插件页显示原因 |
| `ctx.llm.registerAdapter([id], adapter)` → `release.replace()` | `lib/index.js:184`、`167` | 注册失败 → 该家降级为「不提供」，另一家照常 |
| 模型记录形状：`context.contextWindow`、`defaultMaxTokens`、`reasoning.efforts` | `lib/adapter.js:208-221` | 字段被改名 → DSH 拿到 `undefined`，压缩与强度控件失效（不崩，但会看得见） |
| `prepareCall` / `stream` 的 `options.reasoningEffort` | `lib/adapter.js:276` | 强度选择器送的档位丢失 → 永远用上游默认档 |
| `ctx.webServer.register({ method, path, handler })` | `lib/routes.js:224`、`248` | 两条设置路由挂不上 → 插件页读不到状态、开关与恢复失效 |
| `ctx.inject(['webServer'], …)`、`ctx.effect(…)` | `lib/index.js:665`、`669` | 注入名变了 → 路由不挂载，插件其余部分仍在 |
| 客户端槽位 `plugins.bundle.config` / `plugins.row.config` | `lib/client.js:1614`、`1641` | 槽名或 key 规则变了 → 页面不出现（后端仍然工作） |
| 行 key 规则 `<包名>#<rowId>`：`dsh-agent-bridge#agent-bridge-qoder` | `lib/client.js` 的 `ROW_SLOT` 注册 | 规则变了 → 行详情页空着 |
| `ctx.locale.register(ns, { zh, en })` | `lib/client.js:1580` | 文案回退到 key 原文 |
| `cordis.patch.yml` 的 `insert: [{ id, name, config }]` | `cordis.patch.yml` | 字段改名 → 两行 Loader 不出现，插件等于没装 |
| `package.json` 的 `dsh.bundle.patch`、`dsh.client.{platform,inject}` | `package.json` | DSH 找不到 patch 或客户端半身 |

实测版本（本仓库最后一次全量验证）：

| | 版本 |
| --- | --- |
| DSH 桌面端 / 运行时 | **0.2.0-rc.2** |
| `@deepseek-ai/dsh-llm` | 0.2.0-rc.2 |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | 0.2.0-rc.2 |
| `@deepseek-ai/cordis` | 4.0.4（peer `^4.0.2`） |
| Node | 24.21.0（要求 `^22.19.0` 或 `>=24`） |

## 五、升级 DSH 之后的自检（约十分钟）

```powershell
# 1. 离线：契约没变、清单没腐化（不需要客户端，也不需要 DSH）
npm test

# 2. 宿主：用替身 ctx 跑真 apply()，注册 / 分组标题 / 开关隔离 / 路由权限
npm run test:host

# 3. 驱动：真客户端、真对话
npm run test:live

# 4. 装回 profile，重启桌面端，插件页应有两行、两个状态灯
.\tools\sync.ps1
```

四点都要看：

- `npm run test:host` 打印的 `providers:` 里两个 id 都在，收尾 `adapters remaining after cleanup: 0`；
- `test:live` 两家都给出结论行（`Qoder driver: OK` / `WorkBuddy driver: OK`）；
- 插件页两行都是「运行中」，模型选择器里两个分组都在；
- 随便发一句话，能流式回字。

若第 1、2 步过、第 3 步过、但页面空白：问题在客户端槽位（上表里那两行），不是模型链路。

## 六、provider id 被别人占了怎么办

DSH 对同一个 provider id 只接受一个 adapter。同一 profile 里如果还有另一个插件注册 `workbuddy`（典型是 `dsh-workbuddy-connect`），后注册的一方会拿到 `DUPLICATE_ADAPTER`。本插件的处理方式是**只降级冲突的那一家**：

| 情况 | 结果 |
| --- | --- |
| `apply()` 时 `workbuddy` 已被占 | 不抛异常；`workbuddy` 保持别人的 adapter，`qoder` 照常注册 |
| 日志 | `dsh-agent-bridge/workbuddy: could not be registered: provider "workbuddy" is already registered (DUPLICATE_ADAPTER)` |
| 之后每次刷新 | **不重试**，也不重复刷同一条警告（否则每 5 分钟一条，永远刷） |
| 想拿回这个 id | 把这一行关掉再打开（DSH 会 dispose 再 apply 一次），不必重启整个应用 |

`test/integration/collision.mjs` 把上面四条都跑了一遍，包括「占位方消失后本插件不会自己抢回来、但翻转该行会」。所以同一个 id 上不要同时留两个插件的开关：留一个，另一个从 `dsh.profile.bundles` 里去掉。

## 七、回滚

DSH 桌面端是覆盖安装的，插件是文件，所以回滚很轻：

```powershell
# 插件退回上一份源码
git -C <本仓库> checkout <上一个 tag>
.\tools\sync.ps1        # 再重启桌面端

# 或者直接停掉一家，不必动 DSH
#   插件页把该行关掉；或在 profile 里给它写 "disabled"
```

`sync.ps1` 每次都会覆盖 `plugins\dsh-agent-bridge` 并把 `node_modules` 里的那份镜像过去、逐文件比哈希，所以「回滚到哪一份」由源码决定，不会被上一次安装残留影响。
