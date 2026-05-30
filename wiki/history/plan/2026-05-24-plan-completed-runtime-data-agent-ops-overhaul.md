# Runtime / Data / Agent / Ops Overhaul Plan

Updated: 2026-05-24

## 1. Current Consistency Review

The current project has a useful SwiftUI MVP skeleton, but it is not yet a complete local-first intelligence terminal runtime.

- Desktop: has workspace entry points, but the UI is still close to a split dashboard. It lacks a true top command bar, right inspector, global bottom operations deck, and click-through business workflow.
- Runtime backend: missing. `DashboardViewModel` still coordinates too much directly against `AgentOrchestrator`; there is no command/query/mutation boundary.
- Data management: partial. Existing runtime artifacts cover messages, token entities, market/on-chain snapshots, alerts, and runs, but evidence, tasks, watchlist, alert rules, health checks, and artifact manifest stores are missing.
- Agent runtime: partial. Current `AgentOrchestrator` is still a single refresh function with a timeline artifact. It needs a module pipeline and explicit module results.
- Ops: partial. Source freshness and artifacts are visible, but runtime health, artifact completeness, import/export boundary, policy violations, retention plan, and protected-reference checks are not first-class product data.

## 2. Target Architecture

```text
Desktop Terminal
  -> Top Command Bar
  -> Left Workspace Nav
  -> Main Workspace
  -> Right Inspector
  -> Bottom Operations Deck

Runtime Backend
  -> RuntimeBackend
  -> RuntimeRepository
  -> RuntimeCommand / RuntimeQuery / RuntimeMutation

Data Layer
  -> WeChat / Token / Market / On-chain stores
  -> Evidence / Task / Watchlist / AlertRule stores
  -> Artifact manifest / Runtime health stores

Agent Runtime
  -> AgentRunContext
  -> AgentRunStateMachine
  -> AgentModuleRunner
  -> AgentArtifactWriter

Ops Layer
  -> Source Health
  -> Runtime Health
  -> Policy Matrix
  -> Artifact Completeness
  -> Retention / Import / Secrets Boundary
```

## 3. Runtime Backend Boundary

Add:

- `RuntimeBackend.swift`
- `RuntimeRepository.swift`
- `RuntimeCommand.swift`
- `RuntimeQuery.swift`
- `RuntimeMutation.swift`

Required commands:

- `refreshRun`
- `selectMessage`
- `openToken`
- `createTaskFromMessage`
- `addTokenToWatchlist`
- `acknowledgeAlert`
- `muteAlert`
- `resolveAlert`
- `copyEvidence`
- `openArtifactReference`

Rules:

- SwiftUI views must remain presentation-focused.
- `DashboardViewModel` should call `RuntimeBackend`; it should not own the product workflow.
- Runtime backend must not read live WeChat, call MCP directly, or store secrets.

## 4. Data Models And Stores

Add product models:

- `EvidenceItem`
- `UserTask`
- `WatchlistItem`
- `AlertRule`
- `AlertStatus`
- `ArtifactReference`
- `RuntimeHealthCheck`
- `RuntimeStoreManifest`
- `DataRetentionPolicy`
- `PrivacyRedactionPolicy`
- `AgentModuleRun`

Add stores:

- `EvidenceStore`
- `TaskStore`
- `WatchlistStore`
- `AlertRuleStore`
- `ArtifactManifestStore`
- `RuntimeHealthStore`

Required runtime artifacts:

- `runtime/evidence/evidence.json`
- `runtime/tasks/tasks.json`
- `runtime/watchlist/watchlist.json`
- `runtime/alerts/alert-rules.json`
- `runtime/artifacts/manifest.json`
- `runtime/health/latest-health.json`
- `runtime/runs/{runID}/module-runs.json`
- `runtime/runs/{runID}/artifact-manifest.json`

All stored records must carry source and either freshness, generatedAt, or status. Future live/imported WeChat text must have privacy/redaction fields.

## 5. Agent Runtime Pipeline

Replace the one-piece refresh flow with explicit modules:

- Ingestion
- Entity Resolver
- Market Data
- On-chain
- Evidence
- Alert
- Task
- Briefing
- QA / Policy

Each module result must include:

- `moduleID`
- `runID`
- `status`: `planned`, `running`, `completed`, `degraded`, `failed`, `skipped`
- `startedAt`
- `completedAt`
- `inputSummary`
- `outputSummary`
- `producedArtifacts`
- `evidenceIDs`
- `error`
- `degradedReason`

Planner envelope task type must become:

```text
wechat_onchain_terminal_runtime_refresh
```

## 6. Desktop Product Requirements

The app must be a terminal workspace, not a set of static cards.

- Top command bar: workspace title, global search, time window, source mode, freshness, alert count, refresh.
- Left nav: Home, Inbox, Token Terminal, Watchlist, Agent Console, Data/Ops.
- Main workspace: each workspace has its own workflow layout.
- Right inspector: selected message/token/alert/module/artifact context.
- Bottom operations deck: fixed tabs for Run, Evidence, Tasks, Logs, Artifacts, Policy.

Core workflow:

```text
Message -> Token -> Evidence -> Alert/Task -> Artifact
```

## 7. Ops Requirements

Runtime Health must include:

- runtime writable
- latest run exists
- market snapshot fresh/stale
- on-chain provider fixture/degraded
- policy violations
- artifact manifest complete
- protected refs unchanged

Source Health must include:

- WeChat fixture/export/live
- CMC snapshot
- on-chain fixture/provider
- runtime stores
- policy gate

Maintenance must show:

- retention policy
- cleanup plan, without destructive delete
- import/export boundary
- live WeChat blocked
- wechat-cli export needs confirmation
- secrets boundary

## 8. Stop Conditions

Codex must stop and report if:

- continuing requires real WeChat access or `wechat-cli init/history/search`;
- continuing requires mutating `assignment-agent-raw` or `wechat-cli_raw`;
- Swift build fails after three focused repair attempts;
- XCTest/Testing is unavailable, in which case smoke/runtime checks must be used and the limitation reported;
- GUI verification is unavailable, in which case build/smoke/runtime evidence must be reported;
- CMC/MCP/on-chain live data is unavailable, in which case the state must be `blocked`, `degraded`, or `fixture`;
- runtime artifact writing fails, in which case store/path/permission must be fixed before UI expansion;
- current structure cannot satisfy the goal without refactor, in which case stop adding temporary UI cards and report the required minimal refactor.

## 9. Completion Evidence

Do not report completion unless all are true:

- desktop, runtime backend, data management, agent runtime, and Ops all have implementation evidence;
- core workflow `Message -> Token -> Evidence -> Alert/Task -> Artifact` is verifiable;
- required runtime artifacts exist;
- `swift build` passes;
- `swift test` or smoke/runtime checks pass;
- `swift run WeChatIntelligenceRadar --smoke-check` emits a new runID and artifacts;
- wiki checkpoint is updated;
- protected reference checks show no changes;
- fixture/degraded/blocked/live labels are explicit.

