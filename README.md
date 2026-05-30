# WeChat Intelligence Radar MVP

Swift / SwiftUI macOS MVP for a local-first "WeChat x On-chain Intelligence Terminal" aimed at personal or 5-8 person team usage.

## Scope

- Builds only inside this new project directory.
- Uses mock fixture data for MVP development.
- Keeps `assignment-agent-raw` and `wechat-cli_raw` as read-only references.
- Does not connect to the current computer's WeChat client.
- Does not call `wechat-cli init/history/search` or any live local WeChat read command without explicit authorization.
- Treats CoinMarketCap MCP / Crypto Skill Hub as a permissioned/live capability. If no callable CMC tool, network permission, or API key is available, the app must show `blocked` or `degraded` and may only use clearly labeled mock market fixtures.

## Architecture

```text
SwiftUI Views
  -> DashboardViewModel
  -> RuntimeBackend
  -> RuntimeRepository
  -> RuntimeCommand / RuntimeQuery / RuntimeMutation
  -> AgentOrchestrator module pipeline
  -> AgentRunStore / AgentSyncState
  -> PolicyGate / CapabilityRegistry / AgentRunLog
  -> WeChatDataAdapter
  -> WeChatFixtureFileAdapter / MockWeChatDataAdapter
  -> MarketSnapshotStore / CMCRefreshBridge
  -> CMCMarketDataProvider
  -> CMCSkillHubCapability
  -> TokenResolutionService
  -> NormalizedWeChatStore / TokenEntityStore
  -> OnchainSnapshotStore / AlertStore
  -> EvidenceStore / TaskStore / WatchlistStore / AlertRuleStore
  -> ArtifactManifestStore / RuntimeHealthStore
  -> SubagentManager agent module timeline
  -> MockWeb3MarketDataAdapter
  -> Web3SignalService
  -> BriefingAgent
  -> IntelligenceSnapshot
```

Future live integration should implement `WeChatDataAdapter` using `wechat-cli` JSON outputs, after explicit user authorization.

## Current Data Chain

- WeChat intelligence: `WeChatFixtureFileAdapter` loads `Fixtures/wechat/messages.sample.json`; if the file cannot be loaded it degrades to `MockWeChatDataAdapter`.
- Desktop shell: the app now has Home/Daily Brief, WeChat Intelligence Inbox, Token Terminal, Watchlist/Alerts, Agent Console, and Data/Ops workspaces.
- Agent run: `AgentOrchestrator` builds a planner envelope, evaluates policy, loads the fixture batch, applies the selected `TimeWindow`, detects Web3 entities, loads the freshest market snapshot, resolves token entities, generates on-chain fixture snapshots and alerts, writes run artifacts, synthesizes briefing/actions/sources, and returns `IntelligenceSnapshot`.
- Token loop: `TokenResolutionService` normalizes messages, extracts BTC/ETH/SOL symbols and CA-like strings, resolves `TokenEntity` records, and links related WeChat messages to Token Terminal.
- Web3 enrichment: `Web3SignalService` detects BTC/ETH/SOL/Web3 mentions in group intelligence and attaches normalized market context.
- Runtime storage: local-first JSON stores are written under `runtime/wechat`, `runtime/entities`, `runtime/market`, `runtime/onchain`, `runtime/alerts`, and `runtime/runs/{runID}/`.
- Ops surface: `AgentSyncState`, source health, policy decisions, artifact paths, freshness, and degraded reasons are visible in Agent Console / Data-Ops.
- UI controls: group selection, time window changes, rescan, and copy summary all call ViewModel methods and append run logs/sync status.

## Runtime Overhaul Status

`wiki/plan/2026-05-24-runtime-data-agent-ops-overhaul.md` is now implemented at MVP runtime depth:

- local `RuntimeBackend` / `RuntimeRepository` / command-query-mutation boundary;
- evidence, task, watchlist, alert-rule, artifact-manifest, and runtime-health JSON stores;
- explicit agent module pipeline: Ingestion, Entity Resolver, Market Data, On-chain, Evidence, Alert, Task, Briefing, QA/Policy;
- Top Command Bar, Left Nav, Main Workspace, Right Inspector, and Bottom Operations Deck;
- Ops health, artifact completeness, policy state, import/export boundary, secrets boundary, and degraded reasons as runtime data.

## CMC MCP Boundary

The intended live provider is CoinMarketCap MCP / Skills Marketplace:

https://coinmarketcap.com/api/skills-marketplace/

In the current Codex session `mcp__crypto_skill_hub__` is active. The loaded skill is:

```text
unique_name: altcoin_token_profile
parameters: {"symbol":"BTC|ETH|SOL","convert":"USD"}
```

The app therefore reports:

- `CoinMarketCap MCP`: `enabled`
- `Web3 Enrichment`: `enabled`
- `Mock Market Fixture`: `standby`

The current normalized snapshot was loaded from CMC Skill Hub executions for BTC, ETH, and SOL. The Swift app does not call the network directly; live refresh belongs to the external agent/MCP execution boundary. Mock market values remain fallback only and must not be described as live CoinMarketCap data.

## Runtime Artifacts

Manual app-free smoke check:

```bash
swift run WeChatIntelligenceRadar --smoke-check
```

This runs one agent refresh without launching the desktop window and writes:

```text
runtime/market/latest-market-snapshot.json
runtime/wechat/messages.normalized.json
runtime/entities/token-entities.json
runtime/onchain/{chain}/{ca-or-tokenID}.json
runtime/alerts/alerts.json
runtime/alerts/alert-rules.json
runtime/evidence/evidence.json
runtime/tasks/tasks.json
runtime/watchlist/watchlist.json
runtime/artifacts/manifest.json
runtime/health/latest-health.json
runtime/runs/{runID}/run.json
runtime/runs/{runID}/planner-envelope.json
runtime/runs/{runID}/policy-decisions.json
runtime/runs/{runID}/market-snapshot.json
runtime/runs/{runID}/intelligence-snapshot.json
runtime/runs/{runID}/terminal-data.json
runtime/runs/{runID}/module-runs.json
runtime/runs/{runID}/subagent-runs.json
runtime/runs/{runID}/artifact-manifest.json
runtime/runs/{runID}/logs.json
```

## Build

```bash
swift build
```

## Test

```bash
swift test
```

The current CommandLineTools install does not expose `XCTest` as an importable module, so the test target uses framework-free precondition checks for Web3 detection, policy blocking, CMC freshness, fixture JSON loading, CA extraction, time-window filtering, and artifact writing. `swift test` validates the target build; `--smoke-check` is the runtime verification path.

## Run

```bash
swift run WeChatIntelligenceRadar
```
