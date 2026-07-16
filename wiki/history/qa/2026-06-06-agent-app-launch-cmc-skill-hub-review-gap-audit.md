# Agent App Launch / CMC Skill Hub Review Gap Audit

- Date: 2026-06-06
- Trigger: 人工 review 发现打开的 App 与 Phase 3 期望观感不一致，且 CMC Skill Hub 能力看起来没有对应挂载
- Scope: 只记录问题与证据，不改 runtime / Swift 代码
- Status: open issues for next implementation pass

## 1. Executive Summary

本次 review 暴露的核心问题不是单一“旧版未启动”或“CMC Skill Hub 未挂载”，而是三个层面的叠加：

- App bundle 是最新构建，但本地持久化 UI 偏好让 Phase 3 的 `Work Queue Canvas` 左栏默认折叠，导致用户看到的工作台仍像旧版。
- CMC Skill Hub 在 daemon / Pi runtime / public surface 中均已挂载，但 UI 没有把“已挂载、transport 成功、证据为空、价格被拦截”区分清楚，用户自然会判断为“能力没挂上”。
- 最终输出仍会泄漏 `Skill:`、`Extension:`、`cmc-skill-hub`、`cmc-market-radar` 等内部 ID，破坏了 Phase 3 “只显示用户能力包，不暴露 internal tools/provider”的产品边界。

因此下一轮应做一个小型收口修复，而不是继续大改架构：

1. 首屏默认展开 Agent work queue。
2. CMC 能力命名统一为 `CMC Skill Hub`。
3. 前端展示 CMC mounted / evidence empty / prices blocked 的状态。
4. final output / Swift humanize 继续清理内部 Skill / Extension ID。

## 2. Review Evidence

### 2.1 Bundle evidence

当前打开的 release bundle 指向当前项目根，不是明显旧构建：

```text
.build/release-app/WeChatIntelligenceRadar.app
CFBundleIdentifier = local.wechat-intelligence-radar.mvp
CFBundleName = looloomi
LooloomiProjectRoot = /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3
```

启动流程也已使用 deterministic launcher：

```text
scripts/launch-app.command
```

该脚本会重建 release app bundle、启动本地 daemon、再打开 `.build/release-app/WeChatIntelligenceRadar.app`。

### 2.2 Persisted UI preference evidence

本机偏好显示 Agent rail 与主 sidebar 被持久化折叠：

```text
minimalWorkbench.agentRailCollapsed = 1
minimalWorkbench.sidebarCollapsed = 1
```

这解释了为什么 Phase 3 已实现的左侧 `工作队列 / QUEUE / SESSIONS` 未在人工 review 首屏显现。当前 UI 状态不是代码完全没进，而是旧偏好覆盖了新 IA 的默认可见性。

### 2.3 Daemon / Pi runtime CMC mount evidence

后台 daemon 已启动：

```text
pid = 74408
host = 127.0.0.1
port = 8797
status = available
```

`runtime/agent/daemon.pid` 记录 Pi runtime 已加载 CMC extension package：

```text
extensionPackages:
- cmc-skill-hub
- context-plane
- office-agent
- wechat-cli

registeredTools / activeTools include:
- cmc.live_market_refresh
- cmc.daily_market_overview
- cmc.crypto_macro_overview
- cmc.classify_kline_pattern_quality
- cmc.read_market_evidence
- cmc.detect_market_regime
- cmc.track_social_price_divergence
- cmc.request_mcp_refresh
```

因此 CMC Skill Hub 不是完全未挂载。

### 2.4 Public surface evidence

`agent-runtime/runtime/public-surface.json` 暴露了用户可见能力：

```text
Skill: CoinMarketCap 市场雷达
Extension: CoinMarketCap MCP 能力包
extensionID: cmc-skill-hub
defaultSelected: true
```

截图中 Composer 能力条也显示了：

```text
CoinMarketCap 市场雷达
CoinMarketCap MCP 能力包
```

实际问题是命名不符合用户心智：用户在排查 `CMC Skill Hub`，但 UI 仍显示 `CoinMarketCap MCP 能力包`，容易误判为不是同一个能力。

### 2.5 Current run evidence from screenshot

截图中的当前 run 已显示：

```text
Evidence empty
Prices blocked
Mutations discarded
```

最终输出中也出现：

```text
CMC Skill Hub transport 成功，但本轮未返回可解析研究证据或价格快照
Skill: cmc-market-radar, market-regime-review, wechat-onchain-intelligence
Extension: cmc-skill-hub, wechat-cli-export-bridge
```

这说明：

- transport / extension routing 并非完全断开；
- 证据合约仍在 empty evidence 分支；
- copy guard 尚未完全清除内部 Skill / Extension ID；
- UI 缺少一个明确的 mounted-but-empty 状态表达。

## 3. Problem Breakdown

## 3.1 Problem A: 最新 App 被折叠偏好伪装成旧版本

现象：

- 用户打开 App 后仍看到窄左栏，而不是 Phase 3 方向 2 的完整 `Work Queue Canvas`。
- 左侧 queue-first IA 未成为第一视觉信号。

根因：

- `@AppStorage("minimalWorkbench.agentRailCollapsed")` 持久化了旧折叠状态。
- Phase 3 改了 IA，但没有迁移或重置旧 UI preference。
- UI smoke 只验证 Agent Console 可打开，未验证 queue rail 是否展开。

影响：

- 人工 review 会判断为“打开的还是旧版本”。
- Phase 3 的主产品变化被折叠状态隐藏。

修复方向：

- 新版本首次进入 Agent Console 时默认展开 Agent work queue。
- 增加一个 lightweight preference migration，例如 `minimalWorkbench.phase3QueueCanvasPreferenceMigrated`。
- UI smoke 增加断言或 screenshot 检查：`工作队列` / `QUEUE` / `SESSIONS` 至少一个可见。

## 3.2 Problem B: CMC Skill Hub 已挂载，但 UI 命名和状态表达不成立

现象：

- 用户认为 CMC Skill Hub 未对应挂载。
- UI 显示 `CoinMarketCap MCP 能力包`，但用户预期是 `CMC Skill Hub`。
- 当前 run 输出 `Evidence empty` / `Prices blocked`，缺少 mounted 状态。

根因：

- public surface 仍沿用 `CoinMarketCap MCP 能力包` 文案。
- UI 能力条只表示 selected / available，不表示 runtime mount / provider transport / evidence usability。
- CMC split gate 的结果只在 final output 和 diagnostics badge 中间接出现，没有成为能力包状态。

影响：

- 用户无法区分：
  - CMC extension 未挂载；
  - CMC extension 已挂载但 provider unavailable；
  - provider transport ok 但 readable evidence empty；
  - price snapshot unavailable；
  - output guard rewritten。

修复方向：

- 将用户可见 extension title 统一为 `CMC Skill Hub 能力包`。
- 在 Agent Canvas header 或 ability strip 增加 CMC capability status：
  - `Mounted`
  - `Evidence empty`
  - `Prices blocked`
  - `Provider degraded`
  - `Live snapshot usable`
- 不把 `cmc-skill-hub` raw ID 当作用户文案。

## 3.3 Problem C: Final output 仍泄漏内部 Skill / Extension ID

现象：

当前 final output 中可见：

```text
Skill: cmc-market-radar, market-regime-review, wechat-onchain-intelligence
Extension: cmc-skill-hub, wechat-cli-export-bridge
```

根因：

- 后端 deterministic final output 仍会拼接 selected skill / extension IDs。
- Swift `AgentOutputCopy.humanize` 已过滤一部分 internal surface，但没有覆盖 `Skill:` / `Extension:` 这类公开 ID 列表。
- Phase 3 产品规则要求前端只展示用户能力包名和状态，不展示内部 ID。

影响：

- 破坏“internal tools/provider 不暴露”的产品边界。
- CMC 能力问题被进一步放大：用户看到 raw IDs，会认为挂载逻辑混乱。

修复方向：

- 后端 final output 不再输出 raw selected skill IDs / extension IDs。
- 如需展示能力，转成用户文案：
  - `CMC Skill Hub 能力包：已挂载，证据为空，价格被拦截`
  - `WeChat 只读能力包：本地/导出读取可用，发送阻断`
- Swift copy guard 增加 `Skill:` / `Extension:` 行过滤或 humanized mapping。

## 3.4 Problem D: CMC empty evidence 与 mounted 状态没有合并成一个可读诊断

现象：

当前页面出现多个分散信号：

```text
Evidence empty
Prices blocked
Mutations discarded
CMC Skill Hub transport 成功，但本轮未返回可解析研究证据或价格快照
```

但没有一个地方明确说：

```text
CMC Skill Hub 已挂载；本轮 transport 成功，但 readableEvidence=0 且 priceSnapshot 不可用。
```

根因：

- Backend artifacts 已记录 split gate，但 Swift 只显示短 badge。
- Ability strip 不读取 CMC gate summary。
- Inspector/debug strip 没有产品化成用户理解的原因链。

影响：

- 用户只能看到异常结果，无法判断是挂载失败、调用失败、证据为空，还是输出 guard 改写。

修复方向：

- 以 `AgentFinalReadModel.cmcGateSummary` 为源，生成一个 UI status line：
  - `CMC Skill Hub: mounted · transport ok · evidence empty · prices blocked`
- 只在 task-local diagnostics 显示，不做成常驻复杂面板。
- 保留 Feishu dry-run 后台化规则；不要因此恢复 internal tool/provider 面板。

## 4. Required Fix Pack

### P0

- 默认展开 Phase 3 Agent queue rail，或做一次 preference migration。
- 清理 final output 中 raw `Skill:` / `Extension:` ID。
- 将 CMC 能力用户名统一为 `CMC Skill Hub 能力包`。

### P1

- CMC ability strip / canvas header 增加 mounted + gate 状态。
- UI smoke 增加 Agent Console queue visibility check。
- App launch script 在 release 打开前可选关闭旧 app process，避免多个 bundle/旧窗口并存造成误判。

### P2

- 对 latest run 增加一条 human-facing capability summary artifact，用于 Swift 直接渲染：

```json
{
  "capabilityID": "cmc-skill-hub",
  "displayName": "CMC Skill Hub",
  "mountStatus": "mounted",
  "transportStatus": "ok",
  "researchEvidenceStatus": "empty",
  "readableEvidenceCount": 0,
  "priceSnapshotStatus": "blocked",
  "allowConcretePrices": false
}
```

## 5. Acceptance Criteria For Next Fix

- 打开最新 App 后，Agent Console 首屏可见 `工作队列` 或 `QUEUE`。
- Composer 能力条显示 `CMC Skill Hub 能力包`，不再显示容易混淆的 `CoinMarketCap MCP 能力包`。
- 当前 run 的 CMC 状态能区分：
  - mounted；
  - transport ok / failed；
  - evidence usable / empty；
  - prices usable / blocked。
- final output 不再显示 raw `Skill:` / `Extension:` ID。
- `internalToolsExposed=false` 仍成立。
- Feishu dry-run 仍为后台能力，不进入常驻工作台能力条或 Add palette。
- `swift build`、`swift test`、Agent Console UI smoke 通过。
- 如改 daemon/public surface，`agent-runtime npm test` 通过。

## 6. Non-goals

- 不重新设计 Phase 3 主方向。
- 不把 Feishu dry-run 放回工作台常驻入口。
- 不暴露 internal tools/provider/normalizer/worker。
- 不把 CMC empty evidence 伪装成可用 live research。
- 不执行真实交易、微信发送、Feishu 发布、外部发布或删除/清空动作。

## 7. Fix Record

- Date: 2026-06-06
- Status: fixed in stabilization pass
- Scope: Agent app launch / CMC Skill Hub review gap fix pack only; no Phase 3 redesign and no runtime architecture rewrite.

Implemented changes:

- Agent Console now performs a one-time `minimalWorkbench.phase3QueueCanvasPreferenceMigrated` migration and expands `minimalWorkbench.agentRailCollapsed=false` on the first post-fix open.
- UI smoke now opens `Agent Console`, forces the queue rail expanded for the smoke run, prints `ui_smoke_agent_queue_visible=true`, and fails if the queue is collapsed.
- User-facing CMC extension title is now `CMC Skill Hub 能力包` in the extension manifest, preserved `runtime/public-surface.json`, and Swift fallback public surface.
- Daemon writes `runtime/agent/runs/{runID}/cmc-capability-summary.json` with `schemaVersion=cmc-capability-summary-v1`, sourced from `toolObservations.cmcSkillHub.observations[].skillHubResult` first and `cmcFreshnessGate` second.
- Run manifest artifact index includes `cmc-capability-summary.json`.
- Swift added `CMCCapabilitySummary` and reads it with the final read model; `AgentCanvasHeader` renders a task-local compact CMC status line such as `CMC Skill Hub · mounted · transport ok · evidence usable/empty · prices usable/blocked`.
- Backend deterministic final output no longer emits raw `Skill:` / `Extension:` lines; it emits user-facing capability summaries instead.
- Backend final sanitizer and `internalSurfaceViolations()` now reject raw Skill/Extension ID lines, key public raw IDs, and raw provider IDs such as `mcpProvider`.
- Swift `AgentOutputCopy.humanize` now strips the same raw Skill/Extension/provider ID surfaces for older runs.
- `scripts/launch-app.command` closes same-bundle app windows via bundle id and then only kills current-project `.build/*/WeChatIntelligenceRadar.app/Contents/MacOS/WeChatIntelligenceRadar` processes before opening the freshly built bundle.

Verification:

- `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
- `bash -n scripts/launch-app.command`: pass.
- `npm test` in `agent-runtime`: pass after approved non-sandbox rerun for local MongoDB; covered `control_plane_smoke`, `mongo_repository_smoke`, `security_smoke`, `business_qa`, sync smoke, `async_smoke`, and cleanup.
- `swift build`: pass.
- `swift test`: pass.
- `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass with `ui_smoke_workspace=Agent Console`, `ui_smoke_agent_queue_visible=true`, `ui_smoke=pass`.

Artifact spot check:

- Business QA run `run-42785327-a863-4028-b09f-0bb0d7018b56` contains `cmc-capability-summary.json` with `mountStatus=mounted`, `transportStatus=ok`, `provider=mcpProvider`, `skill=daily_market_overview`, `readableEvidenceCount=1`, `researchEvidenceStatus=usable`, `priceSnapshotStatus=usable`, and `sourceObservationCount=1`.
- The same run's `final-output.md` no longer contains raw `Skill:` / `Extension:` lines, raw public ability IDs, or raw provider IDs; the CMC status is rendered as `CMC Skill Hub 能力包：已挂载，transport ok，证据可用（1 条），价格可用。`.

Remaining risk:

- Historical completed run artifacts may still contain old final text. Swift `AgentOutputCopy.humanize` strips those raw lines at render time, but old files are not rewritten.
- Real-provider QA with live `CMC_MCP_API_KEY` is still a separate credentialed verification item; this pass validates the contract and local business QA path without storing secrets.
