# Agent Output Gates and Frontend Coupling Audit

- Date: 2026-06-05
- Scope: Agent Runtime Host output gates, CMC Skill Hub result propagation, Swift Agent workspace state coupling
- Evidence run: `runtime/agent/runs/run-f2967ea8-7a82-40c6-922c-9dc4508e8f91`
- Runtime snapshot: `runtime/market/latest-market-snapshot.json`
- Nature: architecture audit and remediation record; no runtime/API/model change is implied by this document

## 0. Executive Summary

The current bug is not a single frontend rendering issue. The latest run shows that CMC Skill Hub was reached and was labeled as fresh MCP research evidence, but the returned normalized evidence did not contain assets, prices, or readable evidence sections. The backend then allowed the answer to continue as "live research" while blocking concrete prices, and the output guard finally rewrote the model output into a generic degraded template.

The key evidence is:

- `cmcFreshnessGate.status=pass`, `provider=mcpProvider`, `freshness=fresh`.
- `cmcFreshnessGate.assetCount=0`.
- `allowLiveResearch=true`, but `allowConcretePrices=false`.
- `cmcSkillHub.available=true`, but `cmcSkillHub.observations[0].readableEvidence=[]`.
- `outputGuard.status=rewritten`, reason `concrete_market_values_without_fresh_gate`.
- Final output says "已读取 CMC Skill Hub 实时研究证据", but it cannot show concrete Skill Hub evidence because none survived normalization.

The frontend confusion is a separate but compounding problem. `DashboardViewModel` currently owns too many runtime roles: daemon sessions, SSE stream buffering, local terminal runtime refresh, product mutation import, final-output loading, strategy result loading, filters, selected objects, and UI presentation state. As a result, one Agent run can have multiple competing final result sources: SSE terminal event, `final-output.md`, Mongo/session assistant message, and local file-store read models.

## 1. Latest Run Symptom

### 1.1 What the run actually produced

Latest inspected run:

```text
runtime/agent/runs/run-f2967ea8-7a82-40c6-922c-9dc4508e8f91
```

`tool-observations.json` reports:

```text
cmcFreshnessGate.status = pass
cmcFreshnessGate.provider = mcpProvider
cmcFreshnessGate.freshness = fresh
cmcFreshnessGate.assetCount = 0
cmcFreshnessGate.allowLiveResearch = true
cmcFreshnessGate.allowConcretePrices = false
cmcFreshnessGate.reason = fresh_live_research_snapshot_no_concrete_prices
cmcSkillHub.available = true
cmcSkillHub.observations[0].skill = track_social_price_divergence
cmcSkillHub.observations[0].summary = track_social_price_divergence returned CMC Skill Hub evidence.
cmcSkillHub.observations[0].readableEvidence = []
outputGuard.status = rewritten
```

The corresponding global market snapshot says:

```text
runtime/market/latest-market-snapshot.json
provider = mcpProvider
status = enabled
freshness = fresh
assets = []
evidence = [
  "track_social_price_divergence returned CMC Skill Hub evidence.",
  "Research context only; not a trading, leverage, position sizing, or execution instruction.",
  "Use concrete numbers only while provider=mcpProvider and freshness=fresh."
]
```

The normalized CMC artifact says:

```text
runtime/market/cmc-skill-hub.normalized.json
provider = mcpProvider
skill = track_social_price_divergence
status = ok
watchlist = []
market_read.summary = track_social_price_divergence returned CMC Skill Hub evidence.
```

This is the core contradiction: the run is "fresh MCP" at the provider level, but it is empty at the research payload level and empty at the price snapshot level.

### 1.2 What the user sees

The UI shows a final answer with generic sections:

```text
## 结论
已读取 CMC Skill Hub 实时研究证据，但本轮没有通过具体价格门禁...

## 关键证据
- 市场数据状态：CoinMarketCap MCP · 最新。
- 数据边界：Skill Hub 返回的是研究证据包，不是可引用价格快照。
```

This is not a stable decision-grade CMC answer. It is the output guard's replacement text after the model tried to produce market-sensitive content that was not allowed by `allowConcretePrices=false`.

### 1.3 Why previous fixes did not close the loop

The June 4 production QA work added real MCP HTTP provider support, provider readiness, CMC freshness gates, output guard rewriting, and business QA cases. Those fixes improved safety, but the latest failure is one layer deeper:

- The provider call can be successful while returning no structured `watchlist`, `market_read`, evidence pack, triggers, anomalies, or readable sections.
- The gate treats this as enough for `allowLiveResearch=true`, because provider/freshness/status look valid.
- The final output contract expects `readableEvidence` to exist, but no hard gate fails the run when it is empty.
- The frontend displays the guarded final text, making the run look "available but vague" rather than "provider result was empty or not parsed."

## 2. Actual Output Gates

### 2.1 Provider chain gate

Owner:

- `agent-runtime/bin/wechat-agent-daemon.mjs`
- `refreshCMCLive`
- `refreshCMCViaMcpHTTP`
- `normalizeCMCBridgeEvidence`
- `marketSnapshotFromNormalizedEvidence`

Current behavior:

- Provider order defaults to `mcp_http,mcp_bridge,rest,normalized,fixture`.
- `mcp_http` can return `status=ok` through Skill Hub `find_skill` and `execute_skill`.
- The normalized evidence may still have `watchlist=[]`.
- `marketSnapshotFromNormalizedEvidence` can produce:
  - `provider=mcpProvider`
  - `status=enabled`
  - `freshness=fresh`
  - `assets=[]`

Impact:

- A run can be provider-fresh but evidence-empty.
- The user-facing output says CMC Skill Hub was read, but there are no CMC facts to cite.
- The next stage must separate provider transport success from evidence usefulness.

Required future contract:

```text
transportStatus = ok | degraded | failed
researchEvidenceStatus = usable | empty | parse_failed | degraded
priceSnapshotStatus = usable | empty | not_requested | degraded
```

`transportStatus=ok` must not imply `researchEvidenceStatus=usable`.

### 2.2 CMC freshness gate

Owner:

- `marketSnapshotIntegrity`
- `cmcFreshnessGate`
- `buildToolObservations`

Current behavior:

- `mcpProvider/fresh/enabled` with evidence text passes live research.
- Empty `assets` blocks concrete prices.
- Result becomes:
  - `allowLiveResearch=true`
  - `allowConcretePrices=false`

This is directionally correct, but incomplete. The gate does not check whether the Skill Hub research result is content-rich enough for a final answer. It checks provider/freshness and concrete price integrity, not evidence density.

Missing checks:

- `cmcSkillHubResult.summary` is not just a generated fallback sentence.
- `readableEvidence.length > 0`, or there is an explicit `emptyEvidenceReason`.
- `marketRead` has at least one meaningful field, trigger, conflict, diagnostic, or source note.
- `missingOrStaleInputs` is surfaced as a user-facing data gap.

Short-term rule:

```text
if provider=mcpProvider
and assets.length=0
and readableEvidence.length=0
and marketRead has no useful fields
then cmcFreshnessGate.status should be degraded
and allowLiveResearch should be false or "limited_empty_evidence"
```

### 2.3 Output guard

Owner:

- `guardFinalOutput`
- `concreteMarketViolations`
- `degradedMarketFinalText`
- `safeStreamVisibleText`

Current behavior:

- The model may stream a richer answer.
- If the answer contains market-sensitive concrete values while `allowConcretePrices=false`, the guard rewrites it.
- The final persisted `final-output.md` can be a generic degraded template even though earlier streamed deltas were more detailed.

This is safety-positive but product-confusing. The UI can briefly see model deltas, then terminal final text replaces them. In the latest run, the output guard recorded:

```text
status = rewritten
reason = concrete_market_values_without_fresh_gate
violations = [
  "- 跨资产相关性：BTC 与纳斯达克/黄金/美元指数的滚动 20 日相关性是否突破 ±0.7"
]
```

The immediate issue is not that the guard exists. It is that the guard's replacement text says "已读取 CMC Skill Hub 实时研究证据" when the usable Skill Hub evidence is effectively empty.

Short-term copy rule:

```text
If output is rewritten and readableEvidence is empty,
the final answer must say:
"CMC Skill Hub transport succeeded, but this run returned no parseable research evidence or price snapshot."
```

### 2.4 Context plane gate

Owner:

- `agent-runtime/control-plane/context-plane.mjs`

Current behavior:

- Runtime artifacts are summarized by keys and counts.
- `modelContext` is bounded to a small summary budget.
- The model sees `tool-observations.json` later in the daemon user message, but context plane itself does not produce evidence-specific chunks.

Current limitation:

- CMC evidence is not segmented as:
  - market regime
  - watchlist asset
  - trigger
  - missing input
  - source attribution
  - readable excerpt
- If `tool-observations` contains only fallback strings, there is no second evidence source that can rescue the final answer.

Medium-term fix:

- Context plane should not summarize CMC artifacts as generic JSON keys.
- It should build CMC-specific chunks when `cmc-skill-hub.normalized.json` exists:
  - `cmc.market_read.summary`
  - `cmc.watchlist[*]`
  - `cmc.action_guidance[*]`
  - `cmc.missing_or_stale_inputs[*]`
  - `cmc.source_attribution[*]`

### 2.5 Tool selection gate

Owner:

- `inferTools`
- `preferredCMCTool`
- `pruneDefaultCMCToolFanout`

Current behavior:

- Skill/Extension selection can initially add several CMC tools.
- `pruneDefaultCMCToolFanout` then keeps one preferred external CMC tool unless the user explicitly selected a tool.
- The latest macro thesis run selected `social-price-divergence`, so the preferred tool became `cmc.track_social_price_divergence`, even though the prompt asked about BTC macro thesis, ETF flows, cross-asset correlation, and counter-evidence.

Impact:

- A macro question can be routed to a social/price divergence skill.
- If that skill returns a thin payload, the whole CMC branch looks successful but content-poor.

Short-term rule:

- If prompt contains `macro`, `ETF`, `跨资产`, `相关性`, `反证`, or `thesis`, prefer `cmc.crypto_macro_overview` or `cmc.detect_market_regime` over `track_social_price_divergence`, even if social-price skill is selected.
- If selected skills conflict, record a tool-selection diagnostic in `tool-observations.json`.

## 3. Frontend Coupling Audit

### 3.1 `DashboardViewModel` has too many owners inside it

Owner:

- `Sources/WeChatIntelligenceRadarApp/ViewModels/DashboardViewModel.swift`

Current responsibilities include:

- Legacy terminal data refresh through `RuntimeBackend`.
- Agent daemon health and capabilities.
- Session list, selected session, task list, task deletion.
- Agent prompt, attachments, selected skills/extensions.
- Async message submission.
- SSE stream subscription, event de-duplication, coalesced flushing.
- Finalization retry loop.
- Tool call, run manifest, control summary, context summary, strategy result loading.
- Product mutation import into terminal runtime.
- Selected object state for message/token/evidence/crystal/proposal/memory/handoff.
- Search/filter memoization.
- UI workspace selection and inspector selection.

This makes the class a runtime adapter, repository coordinator, stream reducer, product mutation importer, and UI state store at the same time.

Failure mode:

- A backend output fix may appear broken because the UI is still showing stale `agentMessages`.
- A stream rendering fix may appear broken because `final-output.md` later overrides terminal text.
- A product mutation fix may appear broken because `RuntimeBackend` imports it into the older terminal store and changes unrelated panels.

### 3.2 There are multiple authoritative final-output sources

Current final text sources:

- SSE `run.completed.finalText`.
- `runtime/agent/runs/{runID}/final-output.md`.
- Mongo-backed session assistant message.
- Filesystem session JSON fallback.
- `agentTerminalFinalTextByRunID` in memory.
- `AgentWorkspaceStateAdapter.makeRunMessage(...)` terminal fallback part.

Current finalization path:

- `subscribeAgentEvents` reads SSE.
- terminal event triggers `scheduleAgentFinalization`.
- `applyAgentFinalization` stores `terminal.finalText`, imports product mutations, reads `final-output.md`, reloads tool calls and read models, then refetches sessions/tasks.
- `hasAuthoritativeAgentFinal` can consider either in-memory final text or session assistant message authoritative.

This is too many paths for one final answer. The frontend should consume one `AgentFinalReadModel` built by the daemon or by a single Swift repository adapter.

Proposed future read model:

```text
AgentFinalReadModel
- runID
- taskID
- status
- finalText
- finalTextSource: final_output_artifact | terminal_event | session_message
- outputGuardStatus
- cmcGateSummary
- generatedAt
- artifactPath
```

Only one layer should decide final precedence.

### 3.3 Product mutation import couples Agent runs back into legacy terminal state

Owner:

- `Sources/WeChatIntelligenceRadarApp/Services/RuntimeBackend.swift`
- `importAgentProductMutations(runID:)`

Swift `RuntimeBackend.importAgentProductMutations` is the specific coupling point that merges Agent run products back into the terminal runtime store.

Current behavior:

- Agent run writes `product-mutations.json`.
- On terminal event, Swift imports tasks, watchlist items, crystals, proposals, memory, and handoffs.
- Imported objects are merged into `terminalData`, which is also used by the non-Agent terminal workspace.

Impact:

- Agent chat execution mutates the same local product state shown elsewhere.
- A failed or degraded Agent run can still import objects and change the terminal surface.
- Debugging "the answer is wrong" becomes mixed with "the workspace state changed."

Short-term rule:

- If run output guard rewrote the final answer or CMC research evidence is empty, product mutations should be marked low-confidence or not imported automatically.

Medium-term rule:

- Product mutations should enter an inbox read model first.
- The user or a deterministic acceptance rule should promote them into terminal stores.

### 3.4 UI adapter also hides backend diagnostics

Owner:

- `AgentWorkspaceStateAdapter`
- `AgentWorkspaceV2Views`
- `RuntimeStatusPresenter`

Current behavior:

- Raw backend terms and internal fields are filtered from visible text.
- This is correct for normal use, but it can hide the exact reason an output was rewritten.
- The user sees "输出结果 / 上下文 / 边界正常" while the real problem is `readableEvidence=[]` and `assets=[]`.

Needed product behavior:

- Normal chat should stay clean.
- Inspector/debug strip should surface:
  - `outputGuard.status`
  - `cmcFreshnessGate.allowLiveResearch`
  - `cmcFreshnessGate.allowConcretePrices`
  - `assetCount`
  - `readableEvidenceCount`
  - `emptyEvidenceReason`

## 4. Root Cause Chain

The current failure chain is:

```text
User asks macro/market task
  -> selected skills/extensions add several CMC tools
  -> CMC fanout prune keeps one preferred tool
  -> selected tool can mismatch prompt intent
  -> MCP transport succeeds
  -> normalized evidence has no watchlist/assets/readable evidence
  -> snapshot is still provider=fresh/status=enabled
  -> freshness gate allows live research but blocks concrete prices
  -> model receives weak CMC evidence and tries to answer
  -> output guard detects unsupported concrete market values
  -> final output is rewritten to generic degraded template
  -> frontend finalization can show terminal/file/session-derived final text depending on timing
```

The bug is therefore both backend and frontend:

- Backend: no "empty Skill Hub evidence" hard gate.
- Backend: research evidence and price snapshot are conflated under one CMC gate.
- Backend: tool selection can route a macro task to a social divergence skill.
- Frontend: multiple result sources and product mutation side effects make the user-visible state hard to reason about.

## 5. Remediation Plan

### 5.1 Short term

Backend behavior:

- If `assets=[]` and `readableEvidence=[]`, mark CMC run as `degraded_empty_evidence`.
- Do not say "已读取实时研究证据" unless at least one meaningful Skill Hub evidence section exists.
- Add `emptyEvidenceReason` to the CMC result summary when the normalizer only has fallback text.
- Final output should explicitly say "Skill Hub 返回为空或未解析出可读证据".
- Record `readableEvidenceCount` in `tool-observations.json`.

Frontend behavior:

- In the run status/inspector, show a compact diagnostic:
  - `CMC MCP connected`
  - `Evidence empty`
  - `Prices blocked`
  - `Final rewritten`
- Do not import product mutations automatically from runs whose output guard rewrote the final answer because market evidence was insufficient.

### 5.2 Medium term

Backend contract:

- Split CMC into two contracts:
  - `researchEvidence`
  - `priceSnapshot`
- Gate them separately:
  - `allowResearchConclusion`
  - `allowConcretePrices`
  - `allowStrategyCard`
- Tool selection should be intent-aware, not only selected-skill-order-aware.
- Context plane should create CMC-specific chunks, not generic JSON key summaries.

Frontend contract:

- Introduce one authoritative final read model.
- Stream deltas remain transient only.
- `final-output.md` or daemon final read model becomes canonical after completion.
- Session assistant message should mirror canonical final output, not compete with it.

### 5.3 Long term

Architecture:

- Split `DashboardViewModel` into separate state owners:
  - `AgentSessionStore`
  - `AgentRunStreamCoordinator`
  - `AgentRunReadModelStore`
  - `AgentProductMutationInbox`
  - `TerminalRuntimeViewModel`
  - `AgentComposerViewModel`
- Move final-output precedence rules out of SwiftUI view/adapters.
- Make Agent product mutations explicit proposals, not automatic terminal state mutations.
- Add regression tests for:
  - MCP success with empty evidence.
  - MCP success with research evidence but no price snapshot.
  - price snapshot success.
  - output guard rewrite.
  - frontend final precedence.

## 6. Acceptance Criteria

The next implementation should be considered fixed only when these cases are true:

1. MCP transport succeeds but returns empty evidence:
   - run status is degraded;
   - final output says evidence is empty;
   - no strategy card is produced;
   - no concrete prices are shown;
   - inspector shows `readableEvidenceCount=0`.

2. MCP returns research evidence without prices:
   - run status can be pass/limited;
   - final output includes Skill Hub excerpts;
   - concrete prices remain blocked;
   - output is not rewritten unless the model invents prices.

3. MCP or REST returns price snapshot:
   - `allowConcretePrices=true`;
   - final output can cite only numbers present in the snapshot;
   - strategy result uses fresh snapshot data only.

4. Frontend finalization:
   - exactly one final message is visible;
   - the same text appears in session message and final artifact;
   - output guard status is visible in inspector;
   - stale stream deltas do not remain after terminal final.

## 7. Files To Inspect During Fix

Backend:

- `agent-runtime/bin/wechat-agent-daemon.mjs`
- `agent-runtime/control-plane/context-plane.mjs`
- `agent-runtime/prompts/agent-system.md`
- `agent-runtime/extensions/cmc-skill-hub/extension.ts`

Swift frontend/runtime:

- `Sources/WeChatIntelligenceRadarApp/ViewModels/DashboardViewModel.swift`
- `Sources/WeChatIntelligenceRadarApp/Services/AgentDaemonClient.swift`
- `Sources/WeChatIntelligenceRadarApp/Services/AgentRuntimeStores.swift`
- `Sources/WeChatIntelligenceRadarApp/Services/RuntimeBackend.swift`
- `Sources/WeChatIntelligenceRadarApp/Models/AgentWorkspaceV2Models.swift`
- `Sources/WeChatIntelligenceRadarApp/Views/AgentWorkspaceV2Views.swift`

Reference artifacts:

- `runtime/agent/runs/{runID}/tool-observations.json`
- `runtime/agent/runs/{runID}/final-output.md`
- `runtime/agent/runs/{runID}/events.ndjson`
- `runtime/market/latest-market-snapshot.json`
- `runtime/market/cmc-skill-hub.normalized.json`

## 8. Current Document Boundary

This document intentionally does not change runtime code, Swift models, HTTP APIs, daemon behavior, or CMC provider configuration. It records the current failure chain and defines the next implementation contract. It should remain in `wiki/architecture/` as an active architecture audit until the gates and frontend ownership are refactored.
