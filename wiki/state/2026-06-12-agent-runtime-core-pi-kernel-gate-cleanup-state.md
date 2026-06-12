# Agent Runtime Core / Pi Kernel / Gate Cleanup State

- Date: 2026-06-12
- Goal status: Phase 7 Core ownership cleanup verified
- Execution mode: agentteam with subagent explorers + local integration
- Scope: corrected Core/Pi/Gate boundary extraction after wrapper-skeleton audit

## Source Docs

- `wiki/architecture/2026-06-12-agent-daemon-pi-overlap-architecture-problem-review.md`
- `wiki/problem/2026-06-12-agent-gate-overdefense-problem-review.md`
- `wiki/architecture/2026-06-12-agent-runtime-core-pi-kernel-redesign.md`
- `wiki/plan/2026-06-12-agent-runtime-core-pi-kernel-gate-cleanup-iteration-plan.md`

## Agentteam Modules

| Module | Owner | Status | Notes |
| --- | --- | --- | --- |
| Architecture Captain | main agent | completed | Maintains phase state, wiki sync, final audit. |
| Router / Catalog | explorer `019eb9ca-266b-74a1-8026-7fa75f5f7869` + main | completed | Recommended wrapper-first migration of `toolsForSkill`, `toolsForExtension`, `inferTools`, CMC diagnostics, and route artifact. |
| Gates / Final | explorer `019eb9ca-5389-7302-b023-5791061efa34` + main | completed | Recommended GateEngine wrapper, hard gate classes, metadata downgrade, final writer parity. |
| Pi / Run Loop | explorer `019eb9ca-7fe0-79f2-b015-6bbedd5e626e` + main | completed | Confirmed Daemon Shell should retain HTTP/SSE/Mongo/lifecycle and Pi adapter should wrap Pi only. |
| Swift / QA | explorer `019eb9ca-a4e1-7153-8f79-d1bea717145a` | completed exploration | Confirmed no Swift change is needed for wrapper-first pass if legacy API/artifacts remain stable. |
| Memory / Subagents | main agent | completed | Contract-only, dry-run only; no user tmux session access. |
| QA | main agent | completed | Backend, Swift, UI smoke, route artifact, and focused leak checks passed. |
| Phase 7 Cleanup | main agent | completed | Moved capability-loop projection, runtime provider execution, and deterministic final copy into Core-owned modules with golden tests. |

## Correction Summary

The first implementation should be read as a wrapper skeleton, not as full Phase 1-6 completion. The correction pass fixes the six concrete gaps found in review:

- `selectedCapabilityIDs` now enters the daemon request path and is resolved through `agent-runtime/runtime/capability-catalog.json`.
- `capability-catalog.json` is no longer documentation-only; Core route planning consumes it and tests assert capability-only Markets/Office/CMC routing.
- GateEngine still preserves safety boundaries, but raw internal-surface rewrites no longer fall back to the old deterministic business template, and mutation policy no longer bypasses Core.
- Pi SDK session/resource/tool loading moved from daemon into `agent-runtime/kernels/pi/pi-kernel-adapter.mjs`; daemon calls `piKernel.ensure/status/executeTool`.
- Final output authority moved into Core artifact writer: `final-output.md`, `agent-final-read-model.json`, metrics, checkpoint, manifest, session/task mirror, and `run.completed` ordering are one write sequence.
- Memory and subagent Core contracts are embedded in `memory-read-model.json` and `subagent-coordination-read-model.json`, with QA coverage.
- Phase 7 cleanup now removes the main remaining ownership leaks: daemon no longer owns capability-loop classification/projection, deterministic fallback/degraded final copy, or CMC-vs-Pi runtime tool execution logic. Daemon keeps only host-shell wrappers for API/lifecycle compatibility.

## Phase Progress

### Phase 1: Core Skeleton

- Added `agent-runtime/core/router/tool-router.mjs`.
- Added `agent-runtime/core/capability/capability-normalizer.mjs`.
- Added `agent-runtime/core/gates/gate-engine.mjs`.
- Added `agent-runtime/core/final-output/final-read-model.mjs`.
- Added `agent-runtime/core/artifacts/artifact-writer.mjs`.
- Added `agent-runtime/core/run-loop/agent-runtime-core.mjs`.
- Added `agent-runtime/core/memory/memory-contract.mjs`.
- Added `agent-runtime/core/subagents/subagent-contract.mjs`.
- Added `agent-runtime/kernels/pi/pi-kernel-adapter.mjs`.

### Phase 2: Capability Catalog and Routing Cleanup

- Added internal `agent-runtime/runtime/capability-catalog.json`.
- Daemon keeps legacy `selectedSkillIDs` / `selectedExtensionIDs` compatibility and now accepts `selectedCapabilityIDs` as the Core request model.
- `normalizeSelectedCapabilities()` resolves catalog entries into legacy skill/extension IDs for compatibility during migration.
- Daemon writes `core-route-plan.json` for each run.
- Run manifest indexes `core-route-plan.json`.
- Business QA now asserts `core-route-plan.json` exists; `markets_equity_draft` uses `selectedCapabilityIDs:["markets-research"]` with no legacy selected IDs and verifies `compatibilityMode=capability_catalog_v1`.

### Phase 3: Gate Consolidation

- Added `GateEngine` with hard decision classes:
  - `PolicyDecision`
  - `ContractDecision`
  - `ClaimProvenanceDecision`
  - `OutputSafetyDecision`
  - `MutationCommitDecision`
- Existing `guardFinalOutput` delegates through Core GateEngine.
- Existing `productMutationPolicyForRun` delegates through Core mutation commit decision; daemon no longer calls `deriveMutationCommitDecision()` directly.
- Raw internal-surface rewrite no longer uses deterministic business final fallback. It returns a narrow safety rewrite when stripping leaves no public content.
- Broad market/price safety remains strict; no high-impact gate is weakened.

### Phase 4: Pi Kernel Adapter

- Added `PiKernelAdapter`.
- Moved `PiBackedAgentRuntime`, Pi SDK session creation, resource loader setup, and Pi tool execution into `agent-runtime/kernels/pi/pi-kernel-adapter.mjs`.
- Daemon no longer imports `@earendil-works/pi-coding-agent` and no longer calls `piRuntime.ensure()` / `piRuntime.status()` directly.
- `executeRuntimeTool()` now uses `piKernel.executeTool()` for non-CMC tools.
- CMC provider chain remains outside Pi adapter in this pass.

### Phase 5: Final Read Model and Artifact Writer

- Added `buildAgentFinalReadModelV1()`.
- Existing `buildAgentFinalReadModel()` delegates through Core facade.
- Added Core `writeAuthoritativeFinalOutput()` sequence.
- Core now writes `final-output.md`, final read model, final loop step, harness/read-model summaries, Mongo final output, runtime metrics, checkpoint, manifest, session assistant mirror, task mirror, and then `run.completed`.
- This fixes the Swift refresh race where `run.completed` could arrive before session/task persistence.

### Phase 6: Memory and Subagent Contracts

- Added Core-owned memory contract summary helper.
- Added Core-owned subagent contract summary helper.
- `memory-read-model.json` now includes `coreContract.schemaVersion=core-memory-contract-summary-v1`.
- `subagent-coordination-read-model.json` now includes `coreContract.schemaVersion=core-subagent-contract-summary-v1`.
- Real Hermes memory and tmux/subagent execution remain out of scope.

### Phase 7: Cleanup and Removal

- Added `agent-runtime/core/capability/capability-loop-read-model.mjs`.
- Daemon no longer defines `classifyCapabilityLoop`, `publicCapabilityPackagesForLoop`, `buildCapabilityLoopReadModel`, `writeCapabilityLoopReadModels`, `buildMemoryReadModel`, or `buildSubagentCoordinationReadModel`.
- Added `agent-runtime/core/providers/runtime-tool-executor.mjs`.
- CMC runtime tool execution now routes through Core provider executor; non-CMC tools route through the Pi kernel adapter.
- Daemon keeps `executeRuntimeTool()` and `cmcSkillForTool()` as compatibility wrappers only.
- Added `agent-runtime/core/final-output/deterministic-final-copy.mjs`.
- Deterministic fallback final copy and degraded market final copy now live in Core. Daemon wrappers inject project-specific helpers but do not own the copy rules.
- Added golden tests:
  - `node core/capability/capability-loop-read-model.test.mjs`
  - `node core/providers/runtime-tool-executor.test.mjs`
  - `node core/final-output/deterministic-final-copy.test.mjs`
- Host-only boundaries intentionally remain in daemon: HTTP server, SSE event endpoint, Mongo connection lifecycle, auth token handling, local filesystem run/session directories, and low-level CMC provider transport implementations.

## Verification Log

- Baseline `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass before edits.
- Post-wrapper `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
- Router smoke: `core/router/tool-router.mjs` keeps macro prompt preferred tool as `cmc.crypto_macro_overview`.
- `agent-runtime/runtime/capability-catalog.json` JSON parse: pass.
- Sandboxed `npm test`: blocked by local MongoDB `EPERM 127.0.0.1:27017`.
- Approved non-sandbox `npm test`: pass after using local MongoDB; new business QA still covers `btc_macro`, `office_meeting_draft`, `markets_equity_draft`, and degraded provider run.
- Route artifact spot check: `runtime/agent/runs/run-87eb78c3-bb51-4430-93b9-fabe480894df/core-route-plan.json` exists, schema `core-route-plan-v1`, compatibility mode `legacy_skill_extension_ids`, manifest indexed.
- `swift build`: pass.
- `swift test`: pass.
- `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass with `ui_smoke_markets_research_visible=true`, `ui_smoke_single_final_answer_source=true`, and `ui_smoke_public_ability_names_clean=true`.
- Focused final leak scan for new runs `run-a54e9dbe-cd66-499f-ac0f-e29c2caf7fde`, `run-87eb78c3-bb51-4430-93b9-fabe480894df`, and `run-d25f6739-ae50-4937-bf83-19bda91beebf`: clean.
- Full historical final-text scan still finds old run artifacts with raw provider/Skill/Extension lines; these predate this iteration and are not rewritten by this goal.
- Correction pass `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
- Correction pass core route golden test: `node core/run-loop/agent-runtime-core.test.mjs` prints `agent_runtime_core_route_plan=pass`.
- Correction pass core gate golden test: `node core/gates/gate-engine.test.mjs` prints `agent_runtime_core_gate_engine=pass`.
- Correction pass approved non-sandbox `npm test`: pass with `markets_equity_draft` run `run-b507b150-d625-4f49-a86a-d3079fd96c90` using `selectedCapabilityIDs:["markets-research"]`, resolving to `capability_catalog_v1`.
- Spot check `run-b507b150-d625-4f49-a86a-d3079fd96c90/core-route-plan.json`: `resolvedCapabilityIDs=["markets-research"]`, legacy IDs derived from catalog, tools `markets.equity_dispatcher.plan`, `markets.equity_research.draft`, `markets.provider.drillr_deferred`.
- Spot check `run-afba4166-abc0-44f5-a532-9bc253c1eab1`: memory/subagent read models include Core contract summaries; `run.completed` is appended after final auxiliary artifacts.
- `swift build`: pass.
- `swift test`: pass.
- `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass with `ui_smoke_command_desk_visible=true`, `ui_smoke_markets_research_visible=true`, `ui_smoke_single_final_answer_source=true`, and `ui_smoke=pass`.
- Phase 7 `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
- Phase 7 Core golden tests:
  - `node core/final-output/deterministic-final-copy.test.mjs`: `agent_runtime_core_deterministic_final_copy=pass`.
  - `node core/providers/runtime-tool-executor.test.mjs`: `agent_runtime_core_provider_executor=pass`.
  - `node core/capability/capability-loop-read-model.test.mjs`: `agent_runtime_core_capability_loop=pass`.
  - `node core/run-loop/agent-runtime-core.test.mjs`: `agent_runtime_core_route_plan=pass`.
  - `node core/gates/gate-engine.test.mjs`: `agent_runtime_core_gate_engine=pass`.
- Phase 7 old-owner audit: daemon has no remaining definitions for capability-loop classification/projection/memory/subagent read-model builder functions.
- Phase 7 sandboxed `npm test`: Core tests and control-plane smoke passed, then local MongoDB failed with expected sandbox `EPERM 127.0.0.1:27017`.
- Phase 7 approved non-sandbox `npm test`: pass. Business QA included `btc_macro` (`run-21b5bc57-43f8-4a25-97c7-ad72d2158778`), `office_meeting_draft` (`run-7d4598b9-b692-44e3-a674-c977af0043e2`), `markets_equity_draft` (`run-90a2503b-6d36-439b-8771-ecd6cf58c3a7`), and `cmc_degraded` (`run-9dda9ebb-845e-4318-9091-d85b432288b5`).
- Phase 7 `swift build`: pass.
- Phase 7 `swift test`: pass.
- Phase 7 `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass with `ui_smoke_command_desk_visible=true`, `ui_smoke_markets_research_visible=true`, `ui_smoke_single_final_answer_source=true`, `ui_smoke_public_ability_names_clean=true`, and `ui_smoke=pass`.

## Open Risks

- Router wrapper currently preserves CMC macro preferred tool and fanout pruning; keep business QA coverage.
- Gate wrapper currently preserves Skill Hub returned-price whitelist and generated-level stripping; future semantic cleanup needs golden tests before changing behavior.
- Final read model extra fields are Swift-decoding compatible because Swift ignores unknown fields.
- `capability-catalog.json` is internal baseline only; Swift fallback and public surface are still compatibility sources.
- Daemon still owns host-shell responsibilities: HTTP/SSE, Mongo connection lifecycle, auth, local process lifecycle, run/session/task directory paths, and low-level CMC provider transport functions. These are intentional host boundaries, not Core product-brain ownership.
- Swift fallback/public-surface generation still has compatibility drift risk until it is generated from `capability-catalog.json`.
- Low-level CMC provider transports still live in daemon scope; moving them should be treated as provider-adapter extraction, not another gate change.
- Real Hermes memory writes and real tmux/Pi subagent execution remain disabled/dry-run until review, retention, purge, namespace, and kill strategy are implemented.
