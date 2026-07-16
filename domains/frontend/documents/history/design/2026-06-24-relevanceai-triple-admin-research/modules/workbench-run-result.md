# Workbench / Run Result / QA Module

Status: research complete; native Run Result and Review Packet history pass verified

## Reference Sources

- `05-implementation-acceptance-spec.md`
- `10-objective-completion-matrix.md`
- `11-browser-clickthrough-review.md`
- `13-native-manual-review-checklist.md`
- `14-agent-team-traceability-matrix.md`
- `17-manager-acceptance-closeout.md`
- Web prototype review screenshots under `product-design-audit-web/` and `product-design-audit-web-mobile/`
- Native: `LoopOpsViews.swift`, `DashboardView.swift`, `DashboardViewModel.swift`, `LoopOpsAcceptanceHarness.swift`, `LoopOpsNativeActivationHarness.swift`

## Existing

- Workbench can launch single or batch loops from Loop Library. `DashboardViewModel.runLoopContract` / `runLoopContracts` use `postMessageAsync` and, after daemon ack, write run ledger, Knowledge/Tool Log associations, and selected run state.
- Default Blocks Workbench has Active Queue, lifecycle actions, componentized Run Result, Review Boundary, Timeline, Review Tools, Share Preview, Knowledge, Run History, and a right-side locked Run Chat.
- Web prototype is more complete for local interaction: batch run creates multiple runs, review packets, share-safe logs, run-bound tool logs, and run-scoped chat.
- Web `applyRunLifecycleAction` supports Start/Pause/Resume/Complete/Fail/Cancel/Retry and synchronizes event, packet, log, and chat state.
- `LoopOpsAcceptanceHarness` already covers multiple runs, run chat isolation, repeated same-contract run isolation, and ledger/review/share-safe persistence.
- `LoopOpsNativeActivationHarness` proves in-process SwiftUI action wiring, but explicitly is not external AppKit/XCUITest click evidence.
- Native Run Result now has a run object strip showing selected run instance, answer status, Review Packet readiness, share log readiness, knowledge count, tool log count, and locked Run Chat message count.
- Native Review Packet now renders as a dedicated panel instead of generic "Review Tools"; it foregrounds decision, claims, evidence gaps, blocked actions, next questions, and uncertainty.
- Native Run Result now includes a locked Run Chat artifact section bound to the selected run scope and its saved message count.
- Native Knowledge detach/restore writes run-scoped ledger events and Run Chat receipts, so a selected Run Result can reflect source removal and restoration without leaking to another run.
- Web action smoke now proves the Knowledge saved-source, detach, toast Undo, and restored attachment chip path against a selected run.
- Native Review Packet now persists decision notes and typed event history in the light store, strict JSON mirror, Run Ledger timeline, and Workbench/Library UI.
- Web Review Packet now writes structured event rows for packet creation, lifecycle changes, and manual decisions, while still rendering older string events.

## Gaps

- Native model/harness evidence is stronger than native pixel-click evidence. AppKit/XCUITest visual click proof is still missing.
- Native Run Result now embeds a locked Run Chat artifact summary, while the active composer still lives in the right support panel.
- Critical run lifecycle events still rely partly on strings. Review Packet history is now typed, but a full typed `RunResultState`/attempt model remains pending.

## Design Direction

- Workbench should show active queue and selected result in the same task surface.
- Run Result is a page/panel with Final Answer, timeline, evidence gaps, Review Packet, and Run Chat.
- Multiple runs should feel independent even when launched together.
- QA should prove behavior, not only strings.
- Run Result structure should be fixed: Run header, authoritative Final Answer, timeline/events, Review Packet, run-bound resources, locked Run Chat.
- A single `RunResultState` should aggregate run id, loop contract id, status, attempt, lifecycle events, final answer pointer, review packet, share-safe log, knowledge ids, tool log ids, chat scope id, parent/child run ids.
- UI should never force the user to infer authority across task, ledger, packet, and chat thread.

## Implementation Targets

- Native:
  - Upgrade Blocks Workbench run artifact sections into explicit Run Result subpanels.
  - Make Review Packet notes/events/decision first-class in the selected Run Result. Completed for packet notes/history; full typed run result state remains future work.
  - Add run-bound tool log subpanel with direct Review Chat handoff.
  - Add locked-mode support to `LoopOpsScopedChatPanel` so Run Result Run Chat does not imply switchable scope.
  - Add attempt, typed event, and packet event history where current state relies on free-form strings.
  - Extend UI harness assertions for queue lifecycle actions.
- Web prototype:
  - Keep existing Run Result behavior as parity target.
  - Move queue lifecycle, Review Packet, and Builder Packet state rules into shared model reducers where practical.
  - Map field names to Swift concepts such as `RunLedgerRow` and `ReviewPacketViewModel`.

## Acceptance

- Workbench active queue is visible.
- Starting 2-3 loops creates independent active/completed entries.
- Selecting a run opens a result panel with Final Answer, timeline, evidence gaps, Review Packet, and Run Chat.
- Review Packet decisions, notes, and event history persist.
- Run-bound Knowledge and Tool Logs are visible inside the selected Run Result.
- Run Chat does not leak to another run.
- Acceptance harness records real behavior paths and manual-review gaps.
- Native review distinguishes review-ready from human-approved; pending records do not count as final approval.

## Verification

- `swift build` passed after Run Result structure changes.
- `swift test` passed.
- `swift run WeChatIntelligenceRadar --contract-check` passed with `agent_runtime_contracts=pass`.
- `swift test` includes `checkLoopOpsKnowledgeChatSourceDetachAndUndo()` for run-scoped detach/restore receipts.
- `swift test` now covers Review Packet decision notes, event history, strict mirror, share-safe notes, legacy light decode, and legacy strict decode through `checkLoopOpsLocalStorePersistsRunLedgerAndShareSafeLog()`.
- Web prototype `npm run action:smoke` passed with `web_action_review_packet_history=true`, `web_action_knowledge_detach_undo=true`, and existing run isolation checks.

## Still Not Done

- Native visual QA and screenshot comparison remain pending.
- Full typed Run Result state and attempt model remain pending.
- Run Chat is summarized inside Run Result, but the composer remains the side support panel rather than fully embedded.
