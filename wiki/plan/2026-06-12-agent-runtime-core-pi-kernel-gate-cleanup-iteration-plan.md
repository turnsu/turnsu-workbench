# Agent Runtime Core / Pi Kernel / Gate Cleanup Iteration Plan

- Date: 2026-06-12
- Status: implemented through Phase 7 Core ownership cleanup; host-shell/provider-adapter boundaries remain
- Prerequisites:
  - `wiki/architecture/2026-06-12-agent-daemon-pi-overlap-architecture-problem-review.md`
  - `wiki/problem/2026-06-12-agent-gate-overdefense-problem-review.md`
  - `wiki/architecture/2026-06-12-agent-runtime-core-pi-kernel-redesign.md`

## 1. Summary

This plan refactors the Agent side by first creating a project-owned `Agent Runtime Core`, then moving routing, gates, final read model writing, memory, review, and subagent coordination out of the daemon shell.

The goal is not to weaken Pi. Pi remains the default agentic kernel and should become more capable over time. The goal is to stop the daemon from being the permanent product brain and to stop gate overuse from hiding business bugs.

## Implementation Note

The first implementation pass was a wrapper skeleton and did not satisfy the plan's actual routing, Pi lifecycle, final authority, and contract-use goals. The corrected pass now treats the following as implemented facts:

- Core consumes `capability-catalog.json` and daemon accepts `selectedCapabilityIDs`.
- `markets_equity_draft` business QA uses `selectedCapabilityIDs:["markets-research"]` only, proving capability catalog routing on the daemon path.
- Pi SDK lifecycle moved into `agent-runtime/kernels/pi/pi-kernel-adapter.mjs`; daemon no longer imports the Pi SDK.
- Core `writeAuthoritativeFinalOutput()` owns final-output, final read model, manifest, session/task mirror, and `run.completed` ordering.
- Memory/subagent read models embed Core contract summaries.
- Phase 7 Core ownership cleanup is now implemented for daemon compatibility helpers that were still acting as product-brain code: capability-loop projection, runtime tool execution dispatch, deterministic fallback final copy, and degraded market final copy now live behind Core modules and golden tests.
- Remaining work is no longer "Phase 7 wrapper cleanup" but explicit follow-up boundaries: generated Swift/public surface from catalog, provider-adapter extraction for low-level CMC transport code, and real Hermes/tmux execution after review/retention/namespace/kill strategy.

## 2. Principles

- Keep one App workbench.
- Keep one Agent Runtime Core.
- Keep Pi as the default agentic kernel.
- Keep daemon as local host shell.
- Keep capability packages pluggable.
- Keep final answer authority in `agent-final-read-model.json`.
- Keep only engineering gates.
- Fix business issues directly in providers, parsers, routers, prompts, and UI.

## 3. Phase 0: Documentation and Naming Freeze

Status: this document set.

Tasks:

- Record daemon/Pi overlap problem.
- Record gate overdefense problem.
- Approve new vocabulary:
  - Product Capability
  - Task Intent
  - Capability Catalog
  - Tool Module
  - Pi Kernel
  - Agent Runtime Core
  - Daemon Shell
- Freeze new docs/code from using unqualified `Skill/Extension` as architecture terms.

Acceptance:

- Wiki has the four current docs.
- `PROJECT_WIKI.md` indexes them.
- No runtime code changed in Phase 0.

## 4. Phase 1: Extract Core Skeleton

Goal: create module boundaries without changing behavior.

Add:

```text
agent-runtime/core/
  run-loop/
  planner/
  router/
  capability/
  gates/
  final-output/
  artifacts/
  events/

agent-runtime/kernels/pi/
```

Move behavior by wrapper first:

- daemon calls `runAgentTask` through Core facade;
- existing tool-routing functions remain behavior-compatible;
- existing gate behavior is wrapped but not changed yet;
- existing final read model output remains byte-compatible where possible.

Acceptance:

- `npm test` passes.
- no public API change.
- no Swift changes required.
- run artifacts remain compatible.

## 5. Phase 2: Capability Catalog and Routing Cleanup

Goal: stop user-facing selected IDs from being the internal routing model.

Tasks:

- Introduce `capability-catalog.json`.
- Map existing public surface into catalog records.
- Rename internal request model from `selectedSkillIDs/selectedExtensionIDs` to Core-level `selectedCapabilityIDs` while preserving API compatibility.
- Move `toolsForSkill`, `toolsForExtension`, and `inferTools` into `core/router`.
- Add route diagnostics as first-class artifacts.

Acceptance:

- Swift can still send existing selected IDs during compatibility period.
- Core receives normalized capability IDs.
- CMC macro routing and Markets routing remain covered by business QA.
- No raw internal tools exposed to frontend.

## 6. Phase 3: Gate Consolidation

Goal: reduce gates to engineering boundaries.

Keep hard gates:

- `PolicyDecision`
- `ContractDecision`
- `ClaimProvenanceDecision`
- `OutputSafetyDecision`
- `MutationCommitDecision`

Downgrade to metadata:

- freshness;
- confidence;
- risk;
- source trust;
- parser warning;
- degraded / usable business status.

Tasks:

- Build `core/gates/GateEngine`.
- Replace broad CMC evidence/freshness blocking with claim-level provenance metadata.
- Remove business-template rewriting from Output Guard.
- Make `productMutationPolicy` a derived `MutationCommitDecision`.
- Keep Swift sanitizer as display fallback only.

Acceptance:

- CMC returned summary displays even if parser structured evidence is empty.
- unsupported generated prices are still blocked.
- high-impact actions still blocked or require confirmation.
- final output no longer becomes generic because of business/parser gaps.

## 7. Phase 4: Pi Kernel Adapter

Goal: let Pi become a stronger agentic kernel without owning product contracts.

Tasks:

- Add `PiKernelAdapter`.
- Move Pi session/resource/tool loading out of daemon shell.
- Normalize Pi tool observations into Core observations.
- Add adapter-level support for future Pi subagent sessions.

Acceptance:

- existing CMC / Office / Markets tools still execute.
- Pi built-in high-risk tools remain disabled unless explicitly designed.
- Kernel observations are persisted through Core artifacts.

## 8. Phase 5: Final Read Model and Artifact Writer Consolidation

Goal: centralize final output authority.

Tasks:

- Move final read model writing into `core/final-output`.
- Move manifest/index writes into `core/artifacts`.
- Keep `agent-final-read-model-v1` as stable public contract.
- Remove daemon-specific final precedence logic.

Acceptance:

- Swift still shows one final answer.
- session assistant message mirrors final read model.
- no SSE/session/file fallback reappears.

## 9. Phase 6: Memory and Subagent Core Contracts

Goal: support Hermes memory and tmux/Pi subagents through Core, not App or daemon shell.

Tasks:

- Move memory read model contract to `core/memory`.
- Add user-reviewable memory write eligibility.
- Add subagent namespace, lineage, cancellation, and log boundary contracts.
- Keep tmux as disabled or dry-run until namespaced execution and kill strategy are implemented.

Acceptance:

- no user tmux sessions are touched.
- subagent artifacts are namespaced per run.
- memory writes require review/retention/purge semantics.

## 10. Phase 7: Cleanup and Removal

Goal: delete compatibility duplication after migration is stable.

Tasks:

- Completed: move capability-loop classification, public package projection, memory read-model builder, and subagent read-model builder out of daemon into `core/capability/capability-loop-read-model.mjs`.
- Completed: move CMC-vs-Pi runtime tool execution dispatch out of daemon into `core/providers/runtime-tool-executor.mjs`.
- Completed: move deterministic assistant fallback copy and degraded market final copy out of daemon into `core/final-output/deterministic-final-copy.mjs`.
- Completed: add golden tests for route planning, gate engine, deterministic final copy, capability loop read models, and provider executor.
- Follow-up: remove duplicated Swift fallback source or generate it from catalog.
- Follow-up: remove obsolete gate fields from new artifacts after compatibility window.
- Follow-up: extract low-level CMC provider transport functions into provider adapters if they continue to grow.
- Follow-up: update docs and tests as each compatibility field is retired.

Acceptance:

- `wechat-agent-daemon.mjs` no longer owns core planning/gate/final/capability-loop/provider-dispatch logic. Host wrappers may remain.
- Core golden tests pass for capability routing, gate decisions, final copy, capability loop read models, and provider dispatch.
- `npm test`, `swift build`, `swift test`, and UI smoke pass.
- `rg` shows no daemon definitions for migrated capability-loop builder functions.

## 11. Test Plan

Backend:

- `node --check agent-runtime/bin/wechat-agent-daemon.mjs`
- `npm test` in `agent-runtime`
- business QA:
  - CMC crypto run
  - CMC empty parser / displayable result
  - Markets equity draft
  - Office meeting draft
  - degraded provider run

Swift:

- `swift build`
- `swift test`
- `swift run WeChatIntelligenceRadar --ui-smoke-check`

Static:

- no raw internal tools/provider IDs in public surface visible text.
- no new App final-output reconstruction path.
- no new product decisions inside Pi tool modules.

## 12. Risks

- Extracting Core without behavior drift requires wrapper-first migration.
- Gate cleanup may reveal business bugs currently hidden by generic fallbacks.
- Pi kernel adapter must be designed so future Pi agentic features can be adopted without rewriting product contracts.
- Swift fallback catalog may continue drifting until generated from the Core catalog.

## 13. Non-goals

- No live trading.
- No live WeChat send.
- No Feishu publish without confirmation.
- No external posting.
- No real tmux subagent control until namespace and kill strategy are reviewed.
- No broad deletion of existing artifacts during migration.
