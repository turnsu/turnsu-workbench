# Unified Agent Phase 3 Product Design Workbench Acceptance

- Date: 2026-06-06
- Phase: Phase 3, Product Design-led App redesign
- Scope: Swift Agent workspace IA / interaction direction, not backend runtime behavior
- Status: accepted for current iteration

## 1. Design Decision

Direction 2, "Work Queue Canvas", is the selected product direction.

Product Design flow evidence:

- Product Design `get-context` was used before implementation.
- The brief was confirmed for a unified Agent product workbench.
- Three visual directions were generated: Focused Workbench, Work Queue Canvas, and Split Focus Desk.
- The user selected direction 2 and clarified that Feishu dry-run should be a background capability rather than a standing workbench surface.

Reasoning:

- The current unified Agent product is no longer only a chat surface. It runs multi-domain work items across Web3 research, Office/Meeting drafts, final read model review, QA/policy boundaries, and local artifacts.
- A session-first chat layout makes the user inspect history before understanding current work. The actual operating question is: what is queued, what is running, what result is authoritative, and what is blocked.
- A work-queue-first layout matches the current runtime contract: `AgentLongTask`, session/run lineage, final read model, review branch, product mutation policy, and capability packages.
- Direction 2 keeps the workbench minimal. It avoids a permanent inspector and does not turn Feishu dry-run or internal channel plumbing into a primary UI surface.

## 2. User Constraint Incorporated

The user confirmed that Feishu dry-run is a background capability and should not be a permanent workbench surface.

Design rule:

- Office/Meeting remains visible as a user-facing capability package.
- Feishu/Lark/channel dry-run capability is hidden from the persistent workbench ability strip and Add palette.
- If a task text routes through Feishu dry-run, the runtime may still write dry-run artifacts and policy/channel diagnostics, but the workbench shows only user-facing status such as policy/QA or background channel preview.
- Internal tool/provider/normalizer/worker names remain hidden.

## 3. Implemented UI Changes

Files changed:

- `Sources/WeChatIntelligenceRadarApp/Views/AgentWorkspaceV2Views.swift`
- `Sources/WeChatIntelligenceRadarApp/Models/AgentWorkspaceV2Models.swift`
- `Sources/WeChatIntelligenceRadarApp/WeChatIntelligenceRadarApp.swift`

Workbench structure:

- Left rail now prioritizes `工作队列` over raw session history.
- Queue summary shows running/completed/blocked counts.
- Task rows select the matching session by `task.sessionID`, expose prompt/status/run shortcut, and keep delete scoped to task record deletion.
- Sessions remain as secondary recent history.
- Center canvas header now shows the selected task/run title, run identity, queue status, and compact Evidence / Review / Policy signals.
- Final diagnostics remain concise badges: `Evidence empty`, `Prices blocked`, `Final rewritten`, `Mutations discarded`.
- Composer ability strip is grouped into `Web3`, `Office / Meeting`, and `Local`.
- Feishu/Lark/channel abilities are filtered out of the persistent strip and Add palette.
- UI smoke now opens `Agent Console` when `--ui-smoke-check` is passed, so the desktop smoke path covers the Agent workbench instead of Home.

## 4. Product Boundaries

Still true after this iteration:

- Final answer source is still `agent-final-read-model-v1`; Swift does not reconstruct final output from stream blobs, SSE final fallback, or session message duplication.
- Review branch state remains read-only; review runs do not import product mutations.
- Product mutations remain controlled by `productMutationPolicy`.
- Feishu dry-run remains backend/dry-run only and does not execute live publish/reply/notify.
- No real trading, WeChat sending, external publishing, deletion, or cloud document overwrite was introduced.

## 5. Verification

Commands run from project root:

```text
cd agent-runtime && npm test
swift build
swift test
swift run WeChatIntelligenceRadar --ui-smoke-check
```

Results:

```text
npm test: control_plane_smoke=pass; mongo_repository_smoke=pass; security_smoke=pass; business_qa=pass; sync smoke completed; async_smoke=pass; mongo_test_cleanup=pass
swift build: Build complete! (3.95s)
swift test: Build complete! (2.48s)
ui_smoke_window_title=looloomi
ui_smoke_workspace=Agent Console
ui_smoke=pass
```

## 6. Residual Risks

- The current UI smoke verifies launch and workspace routing, not pixel-perfect visual layout. A future visual QA pass should capture a screenshot of `Agent Console` and compare against the selected direction 2 reference.
- Branch/review read models are available in Swift stores, but the current direction 2 pass surfaces them as compact review/policy signals rather than a full branch map.
- Feishu dry-run is hidden from the workbench palette; if a future product flow needs explicit channel preview review, it should be a temporary task-local review surface, not a permanent navigation item.

## 7. Next Design Gate

Next frontend iteration should stay on direction 2 and deepen only the work canvas:

- expose session tree / branch lineage as a compact task-local review sheet,
- add screenshot-based visual QA for `Agent Console`,
- keep Feishu dry-run in backend diagnostics unless the user explicitly asks to review a channel preview.
