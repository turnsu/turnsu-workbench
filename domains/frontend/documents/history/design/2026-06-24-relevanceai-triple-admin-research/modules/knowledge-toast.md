# Knowledge / Toast / Attach Module

Status: research complete; native lifecycle and detach/undo pass verified

## Reference Sources

- `02-knowledge-toast-system.md`
- `screenshots/04-relevanceai-knowledge-empty.png`
- `screenshots/05-relevanceai-knowledge-new-modal.png`
- Web prototype: `web-prototype/src/App.jsx`, `web-prototype/src/workspacePersistence.js`, `web-prototype/src/styles.css`
- Native: `LoopOpsViews.swift`, `LoopOpsInteractionContracts.swift`, `LoopOpsLocalStore.swift`, `DashboardViewModel.swift`

## Existing

- Product direction is already explicit in `PRODUCT.md` and `DESIGN.md`: RelevanceAI Knowledge/toast maps to a Knowledge library, New Knowledge menu, source status, toast stack, and chat/loop reuse boundary.
- Native already has real local state flow for `LoopOpsKnowledgeSource`: status, reuse mode, activity, linked run ids, `RuntimeObjectReference`, toast, chat thread, and run ledger.
- Native attach is not only a toast. `LoopOpsLocalStore.attachKnowledgeSource` updates source activity, run ledger `knowledgeSourceIDs`, a Run Chat receipt, and the toast stack.
- Native run submission only passes ready sources. `DashboardViewModel.runLoopContract` resolves ready knowledge into context references before calling the agent client; follow-up uses run ledger/source links to recover context refs.
- Web prototype has a clickable local state machine for Knowledge starter/setup, search/status filter, source detail, attach active run, run-scoped attachment, Run Chat event, toast, and workspace persistence.
- Tests/harness already cover ready-only context refs, non-persistent toasts, Knowledge attach write-back to ledger/chat, run chat isolation, and visible-copy internal-word checks.
- Native Knowledge sources now carry lifecycle fields: document count, import progress, error summary, retry count, and last synced time.
- Native `New Knowledge` creates distinct setup states: Blank starts as Draft, Upload/Website start as Needs review, Integration starts as Syncing.
- Native source detail shows setup state, progress, retry count, last sync, error notice, and actions for Start/Retry plus Mark ready.
- Native attach is now gated: only Ready sources can attach to runs; blocked attach writes activity and a warning toast without mutating Run Chat or run ledger.
- Native Chat File/Website-style attachments can now be saved into Knowledge as source rows with conservative setup status.
- Native detach removes a source from the selected run ledger, Run Chat context, and source link history; the toast exposes Undo and restore writes back to the same run scope.
- Web prototype now mirrors the chain: attachment chip `Save source`, Knowledge attached-run rows, `Detach`, toast action `Undo`, and restored run-scoped attachment chips.

## Gaps

- Upload file, Website, and Integration are still local source placeholders or hand-filled fields. They are not real file ingestion, URL crawl, or connector sync.
- Native Chat File/Website attach can now become a Knowledge source contract, but it is not actual file reading, website crawling, or Knowledge document count indexing.
- Source status is still local/simulated. There is now a retry/progress/error/last-sync state model, but no real sync worker, file ingestion, URL crawl, connector sync, or retrieval index.
- Knowledge content has no full indexing/retrieval layer; it primarily becomes `summary/bodyMarkdown` context references.
- Toasts are transient in-app feedback, not a unified event center/activity log. Durable state must remain on row/detail/activity.
- Web prototype is a front-end state machine, not production ingestion.

## Design Direction

- Knowledge is a user-facing source library, not a runtime source dump.
- Toasts should be compact product feedback with enough context to recover what happened.
- Attach actions should be close to chat and loop context, with scope made visible.
- The top-level Knowledge surface should be `Sources` database rows plus a detail page. Recommended columns: `Name`, `Source type`, `Documents`, `Linked`, `Updated`, `Status`, `Action`.
- Source detail should show metadata/status first, then a source contract, then activity. Toasts only report short feedback; continuing state belongs in row/detail.
- `New Knowledge` keeps four starting points: `Blank`, `Upload file`, `Import website`, `Integrations`. New sources should enter setup/detail first rather than pretending to be ready.
- Attach should only allow `Ready` sources. It should support `Attach to latest run` and `Choose run...`, then update Run Result Knowledge, Run Chat receipt, and source activity.
- Chat attach menu uses typed options: `File`, `Website`, `Knowledge`, `Skill OS path`. File/Website show `Needs source` until ingestion is real.

## Implementation Targets

- Native:
  - Extend `LoopOpsKnowledgeSource` with import/sync fields such as progress, error, retry state, last synced time, and document count.
  - Expand `LoopOpsLocalStore.createKnowledgeSource` from placeholder creation into distinct Blank/Upload/Website/Integration setup states.
  - Update Knowledge detail/editor in `LoopOpsViews.swift` with real import status, retry, error recovery, and activity rows.
  - Upgrade chat attachment handling from staged text into source contracts that can be saved to Knowledge. Completed for local source contracts; real ingestion remains out of scope for this pass.
  - Add stable interaction identifiers for source setup, sync retry, attach target sheet, and activity row.
- Web prototype:
  - Add lifecycle fields and retry/error UI to the Knowledge setup panel.
  - Keep attach run-scoped while adding activity detail and undo/detach affordances. Completed in the local prototype.
  - Distinguish staged attachments from saved sources in Chat attach menu. Completed with `Save source` chips.
  - Centralize source status rules in `loopopsModel.js`.
  - Extend action smoke to cover detach, retry, failed source toast, and activity history.

## Acceptance

- Knowledge entry point is visible.
- Empty state explains the next concrete action without long product copy.
- New Knowledge flow supports Blank/Website/Upload/Integration and creates a source with status.
- Draft/Syncing/Needs review/Ready/Failed show consistently in row, detail activity, and toast.
- Toast shows creation/attach/result state and can be reviewed or dismissed.
- Ready sources can attach to Studio Loop, latest run, chosen run, or chat scope.
- Attach updates Run Result, Run Chat, source activity, and durable state.
- Toasts stay short and dismissible; durable state remains visible in row/detail/activity.
- User-visible copy avoids provider, runtime, gate, schema, artifact, and raw IDs.

## Verification

- `swift build` passed after native Knowledge lifecycle changes.
- `swift test` passed with `checkLoopOpsKnowledgeLifecycleRetryReadyAndAttachGuards()`.
- `swift run WeChatIntelligenceRadar --contract-check` passed after updating the no-permission acceptance harness to prove Draft attach is blocked, setup transitions to Syncing/Ready, and Ready attach targets the selected run.
- `swift test` also covers chat saved-source conversion, detach, toast Undo restore, and strict snapshot attachment persistence via `checkLoopOpsKnowledgeChatSourceDetachAndUndo()`.
- Web prototype `npm run action:smoke` passed with `web_action_knowledge_attachment_saved=true` and `web_action_knowledge_detach_undo=true`.
- Web prototype `npm run smoke`, `npm run build`, and `npm run review:no-permission` passed; no-permission review used offline fallback and did not auto-open a browser.

## Still Not Done

- Upload, Website, and Integration are still local setup contracts; no file parser, crawler, connector sync, or indexing layer exists.
- Chat File/Website attachments now save to local source contracts, but they are still not backed by real file parsing, website crawl, connector sync, or retrieval index.
- Choose-run polish and screenshot-level visual QA remain pending.
