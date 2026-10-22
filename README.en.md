# DSH Agent Bridge

English | [中文](./README.md)

Reverse-proxy the models you are already signed in to in local AI desktop clients into [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) as extra providers.

No second API key, no second OAuth flow: the plugin reuses each client's install location and login state.

| Vendor | Models | Balance | Reasoning effort | Channel |
| --- | --- | --- | --- | --- |
| Qoder | 14 | credits left | levels or on/off, per model | child process + control frames |
| WorkBuddy (incl. WorkBuddy AI) | 19 | credits / packages | levels on some models | HTTP + SSE |

Model counts are a snapshot from one run; they move with the account state and upstream changes.


## DSH compatibility

| | Version |
| --- | --- |
| DSH desktop (verified) | **0.2.0-rc.2** |
| Declared runtime range | **`^0.2.0-rc.2`** (the 0.2 line; 0.3 is refused) |
| `@deepseek-ai/dsh-llm` | 0.2.0-rc.2 (peer `^0.2.0-rc.2`) |
| `@deepseek-ai/dsh-client-ui-plugin-manager` | 0.2.0-rc.2 |
| `@deepseek-ai/cordis` | 4.0.4 (peer `^4.0.2`) |
| Node | 24.21.0 (`^22.19.0` or `>=24`) |

Before loading a plugin, DSH compares every `@deepseek-ai/dsh*` peer against the running runtime version and skips the whole bundle on a mismatch:

```
dsh: skipping profile bundle "dsh-agent-bridge": Plugin dsh-agent-bridge@1.0.0 is
incompatible with dsh 0.2.1: peerDependencies {"@deepseek-ai/dsh-llm":"0.2.0-rc.2"}.
```

That is why this manifest declares a range rather than an exact pin: a pin makes every DSH patch release skip the plugin silently. To override a refusal, exempt that exact pair:

```jsonc
// %USERPROFILE%\.dsh\profiles\desktop\compatibility.json
{ "dsh-agent-bridge@1.0.0": ["0.3.0"] }
```

Interfaces this plugin depends on, and a checklist for after a DSH update: [docs/compatibility.md](docs/compatibility.md). `test/compat.mjs` in `npm test` guards the declaration above.


## Features

- **Zero configuration.** Install and open DSH; no key, no second sign-in. Switch accounts in the client and the plugin follows.

![Two components in the plugin page](assets/plugins.png)

- **One package, two components.** `cordis.patch.yml` inserts two Loader rows over one module, differing only in `config.component`. The plugin page shows one package card plus two rows, each with its own switch and detail page. Switching one vendor off leaves the other's routes, timers and child processes untouched.

- **Streaming, reasoning included.** Upstream `reasoning-delta` frames become DSH's collapsible thinking block.

- **Reasoning effort.** Only the levels the upstream declares are offered (`low / medium / high / xhigh / max`, plus `Off` where thinking can be disabled). Nothing declared, nothing shown.

![Models tab](assets/models.png)

- **Balance on the provider header**: `Qoder · 2,427 credits left`, `WorkBuddy · 6,549 credits`.

- **Settings card per row** with 概览 / 模型 / 账号 (overview / models / account) tabs: allowance packages as bars with exhausted ones collapsed into a count, the same catalog the picker reads, and the driver's raw `locate()` result.

![WorkBuddy row detail page](assets/card.png)

- **Uninstall and restore.** Uninstalling moves that vendor's driver directory to `$DSH_HOME/agent-bridge-removed/<id>/`, so a reinstall does not bring it back; "restore" moves it back.

- **Vendor isolation.** A broken driver, a missing client or a provider-id conflict degrades only that vendor to "not offered".


## Install

Requires Windows, at least one supported client installed and signed in, and DSH desktop running. Both drivers rely on Windows install paths and credential files; macOS and Linux are not supported yet.

1. Get the source:

```powershell
git clone https://github.com/AbyssWhalen/dsh-agent-bridge.git
cd dsh-agent-bridge
```

2. Register the bundle in the profile (DSH does not discover unregistered plugins):

```jsonc
// %USERPROFILE%\.dsh\profiles\desktop\package.json
{
  "dependencies": { "dsh-agent-bridge": "file:./plugins/dsh-agent-bridge" },
  "dsh": { "profile": { "bundles": [/* …existing… */, "dsh-agent-bridge"] } }
}
```

3. Sync and install:

```powershell
.\tools\sync.ps1                 # desktop profile
.\tools\sync.ps1 -Profile xxx    # another profile
```

The script refuses to run unless the profile manifest lists the plugin, then copies the source, installs dependencies, and verifies every file against the `node_modules` copy by hash. Re-run it and restart DSH after editing the source: pnpm hard-links `file:` dependencies, so later edits do not propagate on their own.

If another plugin in the profile already serves one of the same vendors (for example `dsh-workbuddy-connect` alongside this plugin's WorkBuddy driver), keep only one: drop it from `dsh.profile.bundles` and remove its `dependencies` entry too, or it stays on disk (inert, but still there). DSH accepts one adapter per provider id; this plugin skips only the conflicting vendor and logs it.


## Vendor requirements

**Qoder**

- Qoder desktop installed and signed in; credentials live in `auth.v1.dat` under the install directory and are read-only, never sent anywhere.
- Model list and balance come from Qoder's own endpoints; turns go through its bundled worker runtime, because the public HTTP endpoints answer third-party requests with 503.
- Reasoning levels follow `thinking_config`: `enabled.efforts` gives levels, `disabled`/`enabled` alone gives on/off, neither gives no control.

**WorkBuddy**

- The domestic build shows as "WorkBuddy", the international one as "WorkBuddy AI"; install either or both, each with its own account and credits.
- The credential file is encrypted and is unsealed locally with the flow `dsh-workbuddy-connect` published; it is used only for local requests.
- `Off` means the field is omitted, since the upstream treats absence as its default and both regional endpoints reject the literal `off`.
- Multipliers and promo badges after model names (`GLM-5.3 · x0.79 credits`, `Hy3 · 免费`) are server-provided fields, not computed here.


## Environment variables

All optional, for troubleshooting.

| Variable | Effect |
| --- | --- |
| `DSH_BRIDGE_POLL_MS` | Refresh interval for models and balance; default 5 minutes, 5 seconds to 24 hours |
| `QODER_INSTALL_DIR` | Override the Qoder install directory |
| `WORKBUDDY_ELECTRON_BIN` | Override the WorkBuddy executable |
| `WORKBUDDY_AUTH_FILE` | Override the WorkBuddy credential file |


## Development

```powershell
npm install
npm test                # offline: contracts and state machines; no client, no network
npm run test:host       # real apply() against a stand-in ctx: registration, group titles, switch isolation, route auth
npm run test:soak       # repeated switch cycles and timer ticks, looking for leaked adapters or routes (-Rounds=N)
npm run test:collision  # another plugin holding the same provider id: degradation and recovery
npm run test:live       # live: per-vendor model count, balance, two real turns
npm run test:counterfactual  # reverse check: put the history truncation back and watch replay-shape go red
```

`npm test` matches CI. `test:host`, `test:soak`, `test:collision` and `test:live` need the relevant clients installed; `test:host` prints `SKIPPED` when none are present.

Per-driver probes: `node test/integration/leak.mjs qoder` (child process after listing models), `node test/integration/turn-teardown.mjs qoder` (after one turn), `node test/integration/drain.mjs workbuddy 20` (event loop after teardown).

Measured records: [docs/verification.md](docs/verification.md).

### Verifying inside a real DSH agent loop

Everything above drives the drivers directly. **Whether tools work in a real loop can only be proven in a real loop** — that is the only place where DSH's system prompt pushes the model to call a tool at all. Setup (isolated `DSH_HOME` plus a headless profile), the two-part pass condition (the tool actually ran **and** no call markup leaked), and a troubleshooting table: [docs/real-loop.md](docs/real-loop.md).

```powershell
pwsh -File tools/real-loop-check.ps1 -Profile e2e -Runs 5 -Provider qoder
```


## Layout

```
lib/
  index.js      host: mount/unmount per component, provider registration, refresh loop, logging
  state.js      component switch persistence, uninstall/restore
  routes.js     /plugins/dsh-agent-bridge/<id>/{status,action}
  client.js     browser half: package page + per-row detail page
  adapter.js    the single LlmAdapter
  catalog.js    local snapshot of models and balance
  pool.js       session pool
  messages.js   DSH messages -> vendor-neutral messages
  effort.js     reasoning-effort normalisation
  quota.js      balance text
  driver.js     driver contract validation
drivers/
  qoder/        session.js child-process channel · upstream.js HTTP · conversation.js · models.js · locate.js
  workbuddy/    seal.js decryption · upstream.js · conversation.js · models.js · auth.js · locate.js
tools/
  sync.ps1      copy the source into a profile and install it
test/           offline tests · integration/ host harness · *-live.mjs live runs
```

Design trade-offs: [docs/design.md](docs/design.md).


## Relationship to dsh-workbuddy-connect

The host-layer shape follows `dsh-workbuddy-connect` wherever it already fits.

| | dsh-workbuddy-connect | This plugin |
| --- | --- | --- |
| Scope | WorkBuddy (two regional groups) | Qoder / WorkBuddy in one package |
| Components | one Loader row | two Loader rows, each with a switch and detail page |
| Settings | one card, three tabs | package card plus one card per row, three tabs |
| Balance | beside the input, in the card | provider header, in the card |
| Reasoning effort | declares first, probes undeclared models (spends credits) | declared levels only, never probed |
| Context window | switchable to the upstream maximum (international) | static, as reported |
| Uninstall | — | driver moved out of the package, restorable |
| License | MIT (Corrine Hu) | MIT, notice preserved |

Two differences are deliberate:

- **No effort probing.** Both upstreams declare levels in model metadata (Qoder's `thinking_config`, WorkBuddy's `supportedEfforts`), so there is nothing to discover and no credits to spend on probes.
- **The context window is not a switch.** DSH's request contract has no per-call window field; the window is model metadata driving compaction and accounting. A switch would have to pick one number at report time that is only true for some models.


## Tool calls

DSH is a coding agent, so a model that cannot call tools is not usable. The plugin forwards the harness's tool declarations to the upstream (OpenAI `tools` envelopes for WorkBuddy) and reassembles streamed `tool_calls` fragments into the harness chunk sequence: `block-start` → `tool-call-delta` → `block-end`, finishing as `tool-calls`.

Replayed history keeps the native structure: an assistant message carries `tool_calls`, and a result answers it by `tool_call_id`. Flattening that into `[tool call: …]` text makes the upstream reject a `tool` message that answers nothing, and leaves two calls indistinguishable to the model.

With real tools present the "you have no tools" preamble is withheld: it contradicts the tool list, and a model handed both answers with `<tool_call>` written as prose — which arrives as **an empty reply on every turn**.

### Recovering calls that arrive as text

Upstream models occasionally lose their structured call channel and write the call **into the content stream**. The plugin intercepts and reconstructs them instead of streaming markup to the screen. Five shapes have been captured from live accounts:

```
<｜｜DSML｜｜invoke name="pwsh">     ← native DSML; bar counts and the `DSML` letters both drift
<｜tool_name>pwsh</｜tool_name>      ← invented by the model; followed by <command>…</command>
<｜tool_call><name>…</name><arguments>{…}</arguments></tool_call>
<｜｜｜▁begin｜>function<｜tool▁sep｜>pwsh  ```json {…} ```  ← the tokenizer's own control tokens
<｜｜｜｜call invoke="name">pwsh     ← `invoke` slid into the attribute slot; parameters as <invoke name="command">…
```

The fourth is not a dialect a model invented: those are its **native function-calling tokens** arriving in the content channel (`▁` is U+2581, the glyph a tokenizer uses for a space). Its arguments are a fenced JSON object, which makes it the easiest of the five to recover.

The fifth is a **displacement**: the word `invoke` moved out of the tag name and into an attribute (`call invoke="name">pwsh`), and the parameters came out as `<invoke name="command">value</…parameter>`. Both readings of the displaced token — decoration, or field label — agree on the tool name, which is why this is recoverable rather than a guess.

Detection is deliberately permissive and removal deliberately strict:

- up to 32 bars, the `DSML` letters optional, the word `parameter` optional on an **opening** tag, and `_` interchangeable with U+2581 — every one of those shapes was observed, not imagined;
- a bare run of bars only counts as a delimiter when a known tag name follows it, so `a || b`, markdown tables and `<b>bold</b>` pass through untouched — and conversely, a shape whose tag name is missing from that list has its opening released as text by the stream;
- a call whose arguments could not be recovered is **not executed**. Showing the raw block beats calling a tool with `{}` — on a live account that mistake made the model retry six times and then declare the harness broken. A truncated JSON fence, and a displacement with no parameters, are treated the same way.

A turn where the model repeats `｜` until the budget runs out (500 bars was observed) counts as a degenerate turn: it fails with the reason named rather than rendering the bars as an answer.

## Known limitations

- Windows only.
- Official channels only; providers you added yourself with your own key are not proxied.
- Whether a figure is balance or spend depends on the vendor; it is shown as reported, not converted.
- Which models appear depends on the account state in the client. The plugin does not log in, top up, or bypass anything.
- Re-run `tools\sync.ps1` and restart DSH after editing the source.


## License

MIT — see [LICENSE](LICENSE).

Host-layer design (component Loader rows, the two settings routes, the capability boundary) and the WorkBuddy credential decryption flow are derived from [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT, Copyright (c) 2026 Corrine Hu). The notice is preserved.
