# Triple-style Chat / Quick GUI Module

Status: research complete; native metadata and Web parity pass verified

## Reference Sources

- `04-triple-chat-quick-gui.md`
- Web prototype: `web-prototype/src/App.jsx`, `web-prototype/src/styles.css`
- Native: `LoopOpsViews.swift`, `DashboardViewModel.swift`, `IntelligenceModels.swift`, `LoopOpsInteractionContracts.swift`

## Existing

- Product direction is clear: Chat is a control layer, while Loop, Run Ledger, Review Packet, and Studio Contract remain authoritative objects.
- Existing research constrains Triple/T3 to a "simple chatbot plus near-composer quick GUI" reference. It does not claim full coverage of an unknown Triple product.
- Web prototype already has interactive quick GUI state. Model, mode, search, temporary, and attachments are written to message `meta`; run messages filter by `runId`; attachments are stored by `run:{runId}` or `scope:{scope}`.
- Native already mounts Run Chat, Builder Chat, and Review Chat panels.
- Native quick controls are partially real: model changes `DashboardViewModel.selectedAgentModelPreference` and reaches `postMessageAsync`; Temporary prevents history/background run writes; Search/attachments are included in prompt text.
- The relevant native control-layer models are in `LoopOpsModels.swift`, `LoopOpsV2Models.swift`, `LoopOpsInteractionContracts.swift`, and `LoopOpsLocalStore.swift`, not the older `IntelligenceModels.swift`.
- Native chat user messages now persist `LoopOpsChatControlMetadata`: selected model, Instant/Deep mode, `Search: Off / Workspace / Web`, temporary flag, prompt category, and staged attachment summaries.
- Native `LoopOpsLocalStore` writes this metadata into both light chat history and strict JSON snapshots, then reloads it.
- Native chat user messages now also persist first-class `LoopOpsChatAttachment` arrays with legacy decode fallback, and strict snapshots expose both per-message attachments and a thread-level attachment inventory.
- Web prototype now exposes Global Chat, tri-state search, prompt category meta, temporary-chat no-history behavior, and Review Chat handoff parity in action smoke tests.
- Web prototype chat attachment chips can save a source into Knowledge and drive a run-scoped detach/undo loop through Knowledge detail and toast actions.

## Gaps

- Native `ChatScope.global` exists and Web exposes Global Chat clearly; native still needs a stronger first-class Global Chat entry point in the main LoopOps surfaces.
- Native `ChatMessage` now persists model/mode/search/category/attachment metadata for user messages.
- Attachments now become strict chat attachment records, but real file content, crawl output, and retrieval indexing are not implemented.
- Instant/Deep does not have structured execution-profile impact.
- Search is a prompt hint rather than a verifiable capability toggle.
- Quick controls are useful, but behavior is split across view code instead of a durable submit/request model.

## Design Direction

- Chat remains visually quiet and compact.
- Quick GUI should expose real state, not decorative chips.
- Controls should map to behavior: scope, mode, search, attach, temporary, prompt category, and run/review/builder actions.
- Chat scope is always visible.
- Introduce a durable `ChatControlState`: model preference, response mode, search mode, temporary flag, prompt category, and attachments.
- Introduce a durable scope reference: global/workspace, run, builder, review. The scope must key the thread/message, not only render a chip.
- Introduce a submit request concept: `scopeRef + controls + attachments + text + sourceSurface`.
- User-facing labels should remain direct: `Global Chat`, `Run Chat`, `Builder Chat`, `Review Chat`.
- Search should be explicit: `Search: Off / Workspace / Web`.
- Temporary should explain persistence: `Temporary, not saved` or `Private draft`.
- Attach menu should use product objects: `File note`, `Website source`, `Knowledge source`, `Skill path`.

## Implementation Targets

- Native:
  - Extend `LoopOpsScopedChatPanel` with structured chat controls, Global mounting, and per-scope composer/attachments.
  - Extend light and strict chat message models to persist controls/meta/attachments with legacy decode fallback.
  - Update `LoopOpsLocalStore.appendMessage` to accept submit metadata, not only text.
  - Pass search/mode/attachments as run context or explicit disabled state rather than only prompt prose.
  - Add interaction identifiers for Global scope, quick controls, attachment states, prompt category, and search mode.
- Web prototype:
  - Add Global scope to ChatBox scope row.
  - Upgrade search from boolean to three-state mode.
  - Persist prompt category in message meta.
  - Move control-to-behavior rules from large App component branches into `loopopsModel.js` where practical.

## Acceptance

- Global Chat, Run Chat, Builder Chat, and Review Chat scopes are visible.
- Quick controls can change mode/category/attachment/search/temporary state.
- Prompt context and message meta reflect selected quick controls.
- Native persists model/mode/search/attachment meta in chat history.
- Temporary chat does not enter history and does not start a background run.
- Search either enters request context or clearly shows a disabled/setup state.
- Attachments become run context references or durable message attachments.
- Run-scoped and review-scoped chat messages remain isolated.
- Repeated runs of the same contract keep Final Answer, Review Packet, Share-safe Log, and Run Chat separated by run id.
- Builder Chat produces a receipt and only changes the contract after apply/save.
- Review Chat decisions update Review Packet, ledger, and share-safe preview.
- The composer does not grow into a generic chat product; it stays attached to LoopOps objects.

## Verification

- `swift build` passed after native chat metadata changes.
- `swift test` passed with `checkLoopOpsChatControlMetadataRoundTripsThroughStores()`.
- `swift run WeChatIntelligenceRadar --contract-check` passed with `agent_runtime_contracts=pass`.
- Web prototype `npm run smoke` passed and reports `web_prototype_forbidden_terms=0`.
- Web prototype `npm run action:smoke` passed with `web_action_global_chat_scope=true`, `web_action_search_modes=Off|Workspace|Web`, `web_action_prompt_category_meta=true`, `web_action_run_chats_isolated=true`, `web_action_knowledge_attachment_saved=true`, `web_action_knowledge_detach_undo=true`, and `web_action_workspace_save_roundtrip=true`.

## Still Not Done

- Native needs a cleaner, explicit Global Chat mounting point in the LoopOps shell.
- Attachments are persisted as first-class strict chat attachment records, but they are still local object references rather than real parsed/crawled content.
- Search mode and Instant/Deep are still request context/control metadata, not a guaranteed external capability toggle.
- Native visual/pixel QA for the composer controls is still pending.
