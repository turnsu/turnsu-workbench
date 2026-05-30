# Next Stage Agent Capability Optimization Plan

Updated: 2026-05-24

## Scope

This plan covers the missing capabilities identified after the CMC Crypto Skill Hub checkpoint. All implementation must stay inside `wechat-intelligence-radar-mvp`. `assignment-agent-raw` and `wechat-cli_raw` remain read-only references. Do not run `wechat-cli init`, `wechat-cli history`, `wechat-cli search`, or any command that reads the user's current WeChat data unless explicitly authorized later.

## Target Architecture

```text
SwiftUI
  -> DashboardViewModel
  -> AgentOrchestrator
  -> AgentRunStore
  -> WeChatDataAdapter
  -> WeChatFixtureAdapter / future WeChatCLIExportAdapter
  -> CMCRefreshBridge
  -> MarketSnapshotStore
  -> Web3SignalService
  -> BriefingAgent
  -> IntelligenceSnapshot
  -> UI + Wiki checkpoint
```

## 1. CMC Auto Refresh Bridge

### Current State

- `CMCSkillHubCapability.swift` contains a manually loaded normalized BTC/ETH/SOL snapshot.
- The Swift app does not directly call MCP tools at runtime.
- Fresh live refresh belongs to the external agent/MCP execution boundary.

### Optimization Goal

Build an agent-side refresh bridge that can load CMC Skill Hub output into a local normalized snapshot file, then let Swift read that file with freshness/status metadata.

### Implementation Plan

1. Add `MarketSnapshotStore.swift`.
   - Read/write `runtime/market/latest-market-snapshot.json`.
   - Include `sourceName`, `status`, `generatedAt`, `expiresAt`, `assets`, `evidence`, `upstreamStatus`.
   - If the file is missing or stale, return `degraded` or `blocked`, not fake live data.

2. Add `CMCRefreshBridge.swift`.
   - Define a bridge contract for external agent output.
   - The Swift side does not call MCP directly; it consumes a validated JSON artifact.
   - Expected artifact producer: Codex/agent calls `mcp__crypto_skill_hub__.execute_skill`, normalizes output, writes JSON.

3. Update `CMCMarketDataProvider`.
   - Prefer fresh `MarketSnapshotStore` data.
   - Fall back to `CMCSkillHubCapability.current` only if the local snapshot is unavailable.
   - Fall back to `MockWeb3MarketDataAdapter` only when CMC is blocked/degraded and clearly label it.

4. Add UI freshness status.
   - Show `fresh`, `stale`, `degraded`, or `blocked`.
   - Display last verified time and source.

### Acceptance Criteria

- A local JSON snapshot can update BTC/ETH/SOL without recompiling the app.
- Agent console shows CMC status and freshness.
- Stale or missing snapshots do not appear as live data.
- `swift build` passes.

### Risks / Boundaries

- No background network calls from Swift until a deliberate runtime bridge is designed.
- No API keys or raw MCP payloads should be committed.

## 2. Broader CMC Data Coverage

### Current State

- Only `altcoin_token_profile` for BTC/ETH/SOL is loaded.
- No trend assets, category/narrative, ETF, macro, or onchain views are normalized.

### Optimization Goal

Add optional CMC-backed market context lanes without overloading the first screen.

### Implementation Plan

1. Add `MarketLane` model.
   - `spotQuotes`
   - `dailyOverview`
   - `macroRegime`
   - `breakoutCandidates`
   - `etfDemand`

2. Add support for selected Crypto Skill Hub skills.
   - `daily_market_overview` for daily crypto regime.
   - `crypto_macro_overview` for macro regime.
   - `btc_etf_institutional_demand` for BTC ETF flow context.
   - `altcoin_breakout_scanner_spot` for trend candidates.

3. Normalize each skill output.
   - Store only bounded summaries, status, confidence, evidence pointers, and key metrics.
   - Avoid storing large raw analysis blocks in app state.

4. Add UI access.
   - Keep the dashboard compact.
   - Use a detail drawer or tab for expanded market context.

### Acceptance Criteria

- At least one non-price market lane is represented in the agent snapshot.
- Each lane has explicit `source`, `status`, `confidence`, and `freshness`.
- Missing lanes show `not_configured`, `blocked`, or `degraded`.

### Risks / Boundaries

- Do not treat research evidence as trading advice.
- Do not present partial CMC skill outputs as complete market coverage.

## 3. WeChat Data Source Upgrade

### Current State

- `MockWeChatDataAdapter.swift` hardcodes group and message fixtures.
- Live WeChat access is correctly blocked.

### Optimization Goal

Move from hardcoded fixtures to explicit local fixture/export files while preserving the no-live-WeChat rule.

### Implementation Plan

1. Add `Fixtures/wechat/messages.sample.json`.
   - Include groups, messages, timestamps, senders, tags, and optional source metadata.

2. Add `WeChatFixtureFileAdapter.swift`.
   - Reads the sample JSON from the project bundle or local runtime folder.
   - Validates schema and marks source as `fixture_file`.

3. Add future `WeChatCLIExportAdapter` contract.
   - Accepts a user-provided export JSON file.
   - Does not run `wechat-cli`.
   - Does not read live WeChat.

4. Update policy.
   - `read_fixture_file = pass`
   - `read_wechat_cli_export_file = needs_confirmation`
   - `run_live_wechat_cli = blocked`

### Acceptance Criteria

- Mock data can be edited without recompiling Swift source.
- Agent logs clearly state whether data came from hardcoded fallback, fixture file, or user-provided export.
- No live WeChat commands are executed.

### Risks / Boundaries

- User-provided exports may contain private data. Add redaction and bounded preview before showing in UI.

## 4. Real Time Window Filtering

### Current State

- `day/week/month/quarter/year` triggers rerun but does not filter by message date.
- `IntelligenceMessage` has `timestamp` string only.

### Optimization Goal

Make time window selection change the dataset and metrics.

### Implementation Plan

1. Add date fields.
   - `sentAt: Date`
   - `sourceDateText: String`

2. Add `TimeWindow.range(endingAt:)`.
   - day: last 24 hours
   - week: last 7 days
   - month: last 30 days
   - quarter: last 90 days
   - year: last 365 days

3. Move filtering into adapter or orchestrator.
   - Adapter loads source.
   - Orchestrator applies selected time window.
   - Logs include original count and filtered count.

4. Update metrics.
   - Active groups, messages, Web3 signals, and action items should use filtered data.

### Acceptance Criteria

- Changing time window changes message count and relevant metrics.
- Agent log records `window`, `rangeStart`, `rangeEnd`, and filtered count.
- UI subtitle reflects the actual selected range.

### Risks / Boundaries

- Mock timestamps must cover multiple windows so the feature is visible in development.

## 5. Actual Sync State

### Current State

- Header shows `已重扫 #n`, but no sync queue, source freshness, retry, or error state exists.

### Optimization Goal

Replace cosmetic rescan text with a real agent sync state.

### Implementation Plan

1. Add `AgentSyncState`.
   - `idle`
   - `running`
   - `completed`
   - `degraded`
   - `failed`

2. Add sync metadata.
   - `lastRunAt`
   - `lastSuccessAt`
   - `sourceFreshness`
   - `runID`
   - `errorMessage`

3. Update `DashboardViewModel.refresh`.
   - Set `running` before orchestrator call.
   - Set `completed/degraded/failed` after result.
   - Render status in `HeaderView`.

4. Add retry behavior.
   - Manual retry button remains `重扫`.
   - Failed state should show a concise reason in agent console.

### Acceptance Criteria

- Header status reflects actual run state.
- Agent console includes run ID and freshness.
- Failures do not silently show old data as fresh.

### Risks / Boundaries

- Avoid adding long-lived background jobs before persistence and cancellation are designed.

## 6. Lightweight Tests

### Current State

- Project has no test target.
- Key logic is untested: Web3 detection, policy state, CMC fallback/loaded behavior.

### Optimization Goal

Add focused tests for agent-critical pure logic.

### Implementation Plan

1. Add Swift Package test target.
   - `Tests/WeChatIntelligenceRadarAppTests`.

2. Test `Web3SignalService`.
   - Detect BTC/ETH/SOL from title/excerpt/tags.
   - Avoid false positives where possible.

3. Test `PolicyGate`.
   - Live WeChat remains blocked.
   - CMC query passes only for loaded Skill Hub state.
   - Mock market is standby when CMC enabled.

4. Test `CMCMarketDataProvider`.
   - Returns enabled loaded snapshot.
   - Uses blocked/degraded statuses when configuration says unavailable.

5. Test time filtering after item 4 lands.

### Acceptance Criteria

- `swift test` passes.
- Tests cover at least Web3 detection, CMC status, and live WeChat blocking.

### Risks / Boundaries

- Keep tests deterministic. Do not call live MCP or network from unit tests.

## 7. Persistent Agent Run Records

### Current State

- Logs are in memory only.
- No run artifact, policy decision JSON, or market snapshot audit trail is written.

### Optimization Goal

Persist agent runs as local artifacts for debugging and auditability.

### Implementation Plan

1. Add `AgentRunStore.swift`.
   - Writes under `runtime/runs/{runID}/`.
   - Files:
     - `run.json`
     - `planner-envelope.json`
     - `policy-decisions.json`
     - `market-snapshot.json`
     - `intelligence-snapshot.json`
     - `logs.json`

2. Add redaction.
   - No API keys.
   - No raw private chat exports unless explicitly permitted.
   - Store bounded previews only.

3. Show run artifact status in UI.
   - Run ID
   - Last written file
   - Error if write failed

### Acceptance Criteria

- Each refresh creates a run directory.
- Artifacts are structured JSON.
- UI still works if artifact writing fails, but shows degraded status.

### Risks / Boundaries

- Runtime artifacts may contain sensitive content after real exports are introduced. Add a purge command or retention limit.

## 8. Web3 UI Detail Layer

### Current State

- `Web3RadarView` shows market cards and enrichment rows.
- No click-through details, evidence, skill source, or staleness explanation.

### Optimization Goal

Make Web3 market context inspectable without crowding the dashboard.

### Implementation Plan

1. Add selected enrichment state.
   - Tap enrichment row or market asset card.

2. Add detail panel or sheet.
   - Asset identity
   - Price / 24h / volume / market cap
   - Source status
   - Skill unique name
   - Last verified time
   - Evidence summary
   - Staleness warning

3. Add status badges.
   - `LIVE`
   - `SNAPSHOT`
   - `STALE`
   - `MOCK`

### Acceptance Criteria

- User can inspect where Web3 context came from.
- Stale or mock data is visually distinct from loaded CMC snapshot data.

### Risks / Boundaries

- Do not paste long raw CMC analysis into first-level UI.

## 9. Configuration Layer

### Current State

- No app settings surface.
- CMC source, snapshot time, live refresh permission, and future wechat-cli status are visible only indirectly.

### Optimization Goal

Add a minimal settings/status surface for agent capabilities.

### Implementation Plan

1. Add `AgentSettings` model.
   - `allowCMCRefresh`
   - `marketSnapshotPath`
   - `allowWeChatCLIExportImport`
   - `liveWeChatAccessAllowed = false`
   - `artifactRetentionDays`

2. Add settings UI.
   - Keep it small.
   - Use toggles for allowed local behaviors.
   - Show immutable blocked status for live WeChat.

3. Persist settings.
   - Use `UserDefaults` for simple local preferences.
   - Do not store secrets.

4. Connect capability registry to settings.
   - Capability states should reflect user settings and source availability.

### Acceptance Criteria

- Settings panel displays CMC provider status, snapshot path, last update, and live WeChat blocked state.
- User can enable/disable local snapshot refresh behavior.
- No secrets are stored.

### Risks / Boundaries

- Do not add API key management until secret storage policy is explicit.

## Recommended Execution Order

1. CMC auto refresh bridge + `MarketSnapshotStore`.
2. Persistent agent run records.
3. Real time window filtering.
4. Fixture-file WeChat adapter.
5. Lightweight tests.
6. Web3 detail layer.
7. Configuration panel.
8. Broader CMC skill lanes.

This order turns the current manually loaded CMC snapshot into a repeatable agent runtime path before expanding UI or data coverage.
