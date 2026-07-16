# Unified Agent Workbench Capability Loop Harness Plan

- Date: 2026-06-11
- Status: active implementation plan
- Scope: Command Desk v2, Agent Runtime Host, internal loop artifacts, memory adapter contract, safe tmux/subagent coordination read model

## 1. Objective

Turn Command Desk v2 from a minimal task surface into a practical unified Agent workbench that can launch, review, continue, and learn from the current project capabilities:

- Crypto research through CMC Skill Hub and market loop tasks.
- Office and meeting work through draft, revision, review, and Feishu preview/dry-run tasks.
- Human review and follow-up instructions as first-class task loop steps.
- Memory capture/read contracts inspired by Hermes-style memory, without inventing unavailable Hermes behavior.
- Safe local subagent coordination inspired by tmux sessions, without touching unrelated user sessions.

## 2. Non-Goals

- No live trading, order placement, transfer, or portfolio execution.
- No WeChat sending.
- No Feishu live publish/reply unless a later review/confirm flow explicitly enables it.
- No second orchestrator and no copied assignment-agent runtime.
- No direct exposure of raw MCP tools, providers, normalizers, workers, or artifact internals in the workbench.
- No destructive tmux commands.

## 3. Phase 1: Capability Task GUI

Deliverables:

- Keep Command Desk as the default surface.
- Add compact task launcher groups for `Crypto` and `Office`.
- Add quick tasks for market loops, thesis review, meeting minutes, document draft, revision, and Feishu preview.
- Add task-local review/follow-up actions near the current result.

Acceptance:

- UI smoke confirms capability launcher, Crypto and Office intents, review/follow-up path, no global Inspector, and no internal IDs.
- `AgentFinalReadModel.finalText` remains the only final answer source.

## 4. Phase 2: Capability Loop Artifacts

Deliverables:

- Backend writes `capability-loop-read-model.json` for every run.
- Artifact summarizes loop type, selected capability package, review state, follow-up suggestions, memory policy, and subagent coordination policy.
- Run manifest indexes the new artifact.

Acceptance:

- Crypto run records `loopType=crypto_market_loop`.
- Office run records `loopType=office_work_loop`.
- Review/follow-up suggestions are user-facing and do not expose raw provider/tool IDs.

## 5. Phase 3: Memory Adapter Contract

Deliverables:

- Backend writes `memory-read-model.json` for every run.
- If Hermes memory is not locally available, artifact status is `adapter_unavailable` with a clear reason.
- If local runtime memory exists, summarize what can be safely remembered and what must not be stored.

Acceptance:

- Memory artifact never stores secrets, raw provider payloads, or unredacted private content.
- Swift can read and display a compact memory status in task detail.

## 6. Phase 4: tmux/Subagent Coordination Contract

Deliverables:

- Backend writes `subagent-coordination-read-model.json`.
- It uses a dedicated app namespace such as `looloomi-agent-*`.
- It only reports dry-run/list/readiness state in this phase.
- It never kills, detaches, sends keys, or reads unrelated user sessions.

Acceptance:

- Artifact shows `status=available`, `not_installed`, or `disabled`.
- If `tmux` is present, only list/read-only evidence is recorded.
- Swift can show a compact coordination status in task detail.

## 7. Phase 5: Review and Follow-Up Loop

Deliverables:

- Command Desk result canvas exposes task-local review and follow-up shortcuts.
- Backend loop artifact records whether follow-up is suggested, blocked, or ready.
- Existing harness review branch remains read-only and does not override main final output.

Acceptance:

- Same run has final read model plus loop read model plus review read model.
- Product mutations remain controlled by existing policy.

## 8. Verification

Required commands:

- `node --check agent-runtime/bin/wechat-agent-daemon.mjs`
- `npm test` in `agent-runtime`
- `swift build`
- `swift test`
- `swift run WeChatIntelligenceRadar --ui-smoke-check`
- Active SVG prototype XML check if prototypes change.

UI smoke must print:

- `ui_smoke_command_desk_visible=true`
- `ui_smoke_capability_launcher_visible=true`
- `ui_smoke_crypto_office_intents_visible=true`
- `ui_smoke_review_followup_visible=true`
- `ui_smoke_no_global_inspector=true`
- `ui_smoke_public_ability_names_clean=true`

## 9. Stop Rules

- Stop if Hermes behavior cannot be grounded in local code/docs; write a blocked adapter artifact instead.
- Stop if tmux access would touch unrelated sessions or require destructive commands.
- Stop if adding a GUI surface would expose internal provider/tool concepts.
- Stop if a phase requires live credentials or high-impact external actions.
