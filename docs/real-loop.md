# 在真 DSH agent 循环里验这个插件

驱动直连只能证明「驱动会说话」。**工具在真循环里能不能用，只有真循环能证明**——只有那里，DSH 的系统提示才会推着模型去发起工具调用。本文是把这件事搭起来的全部步骤，以及为什么判据是两条。

## 一、为什么要另起一个 `DSH_HOME`

正在用的桌面端实例不一定加载了本插件。先查：

```powershell
Invoke-WebRequest http://127.0.0.1:19387/plugins/dsh-agent-bridge/status -UseBasicParsing
```

404 就说明那个实例虽然 profile 里登记了插件、进程里却没加载。可以重启它，但那会打断正在做的事，而且让验证结果和「用户当时的环境」混在一起。

隔离一个 `DSH_HOME` 更干净：不碰桌面端、可随时删、失败不影响任何人。

> **先给这个 shell 设 `DSH_HOME`**，之后每条命令都在这套环境里跑。忘了设就会落到真实 profile 上。

## 二、起一个 headless profile

`--from-default-profile headless` 会照内置模板生成本地 profile：`dsh-base` + `dsh-headless`，没有 Host、没有 HTTP、没有浏览器层，正好是一次性跑一轮的形态。

```powershell
$env:DSH_HOME = '<隔离目录>'
node <dsh>/lib/bin.js --profile e2e --from-default-profile headless --dump-config
```

`<dsh>` 树在本机的路径（桌面端自带）：

```
D:\CodeEditor\DeepSeek Harness\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js
```

生成的目录：

```
<隔离目录>\profiles\e2e\
├─ package.json          ← 要改这一个
├─ cordis.yml
├─ cordis.patch.yml      ← 你的 patch 层
└─ pnpm-workspace.yaml
```

## 三、把插件装进 profile

拷贝到 profile 内的 `plugins\dsh-agent-bridge`，**排除** `node_modules`、`.git`、`_probe`。

然后改 `profiles\e2e\package.json`：

```json
{
  "name": "dsh-profile-e2e",
  "private": true,
  "dependencies": {
    "dsh-agent-bridge": "file:./plugins/dsh-agent-bridge"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "dsh-agent-bridge"
      ]
    }
  }
}
```

**`bundles` 里没有它，插件就不会被组装**——`dependencies` 只是让包能被解析到。

验证：

```powershell
node <dsh>/lib/bin.js --profile e2e --dump-config | Select-String 'agent-bridge'
```

必须看到两行：

```
- id: agent-bridge-workbuddy
- id: agent-bridge-qoder
```

看不到就是没装进去，别继续往下测。

## 四、让默认模型指向本插件的 provider

headless 跑一轮需要一个默认模型。用 patch 层改，别改 profile 本身——这样同一个 profile 能在两家之间来回切，不留残留。

`provider.yml`：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: qoder
    model: qmodel_38max
```

`provider` 换成 `workbuddy` + 一个便宜模型（如 `deepseek-v4.1-flash`）就是另一家。

## 五、跑一轮

```powershell
node <dsh>/lib/bin.js --profile e2e --patch provider.yml headless "Reply with exactly: PONG"
```

看到 `PONG` 就说明整条链路通了：DSH 按命名空间找到 provider → 走本插件 adapter → 驱动去跟客户端说话 → 流式结果回到会话。

**但这只证明「有回复」。** 工具能不能用，得单独验。

## 六、判据：两条，缺一不可

```powershell
pwsh -File tools/real-loop-check.ps1 -Profile e2e -Runs 5 -Provider qoder
pwsh -File tools/real-loop-check.ps1 -Profile e2e -Runs 5 -Provider workbuddy -Model deepseek-v4.1-flash
```

每一轮做两件事：

1. **种一个文件名带随机 token 的文件**，然后要求模型用 `pwsh` 列出目录。token 必须出现在回答里——这只有工具真的执行、输出真的喂回去才可能。
2. **回答里不许出现** `invoke` / `parameter name=` / 连续竖线。

为什么两条都要：

| 只查泄漏 | 结果 |
| --- | --- |
| 模型压根没写信封 | 零泄漏、工具没跑 → **假通过** |
| 模型写了标记但没被识别 | 泄漏 → 抓住 |

所以要 `token 回来 && 没有标记`。脚本退出码 0 表示每一轮都满足。

## 七、为什么必须连跑几轮

第八条缺陷（`docs/verification.md` 第十节）是**间歇**的：8 次里出现 1 次，而且驱动直连完全不出现。跑一轮看到绿色什么都不能说明。

同理，想让 CI 抓它不划算——既有概率漏，又要烧真额度。所以那道护栏放在离线字节级测试上（`test/dsml-variant.mjs`、`test/dsml-stream.mjs`），这个脚本只作为可选的端到端佐证。

## 八、排查

| 现象 | 可能是 |
| --- | --- |
| `--dump-config` 里没有 `agent-bridge-*` | `dsh.profile.bundles` 没加，或拷到了 profile 外 |
| 每轮都「工具没跑」，但模型说列到了文件 | 工作目录放到了工具看不见的地方（如系统临时目录）。DSH 的文件策略只覆盖它的工作区 |
| 改了源码但行为没变 | 隔离 profile 里是**拷贝**。`plugins\` 和 `node_modules\` 两处都要同步 |
| 想看成帧 | 设 `DSH_BRIDGE_DUMP_FRAMES=<jsonl 路径>`（Qoder 驱动）。会写入 prompt 原文，排查完记得关 |
| 想知道标记里的确切字符 | `node _probe/inspect-frames.mjs <jsonl>`——终端是有损视图，看不出是哪种竖线 |
