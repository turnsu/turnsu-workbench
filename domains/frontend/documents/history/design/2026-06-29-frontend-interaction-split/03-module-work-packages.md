# Module Work Packages

These packages are for separate frontend development. They are scoped by user-facing interaction, not by backend capability.

## FE-01 Shell And Navigation

Build:

- Web sidebar and native app sidebar.
- Workspace switcher.
- Search/command entry.
- Current page selection.
- Global run/status indicator.

Out of scope:

- Account auth.
- Real permission model.
- Backend workspace switching.

Usable when:

- A user can move between Workbench, Loop Library, Skill OS, Knowledge, Studio, Tool Builder, Integrations, Settings, Help, and What's New without losing visual context.

## FE-02 Loop Library

Build:

- Browse list.
- Template/listing pattern.
- Loop detail page.
- Multi-select actions.
- Ready/needs setup/running/completed states.

Out of scope:

- Real loop execution.
- Real ledger persistence.

Usable when:

- A user can find a loop, open details, start a mocked run, clone a template, and see the resulting queued item.

## FE-03 Skill OS And Tool Builder

Build:

- Skill/package browse.
- Capability detail page.
- Skill Stack editor.
- Tool Builder entry screen.
- Tool log viewer.

Out of scope:

- Real credential storage.
- Real tool validation.
- Runtime provider management.

Usable when:

- A user can browse capabilities, inspect setup, add a skill to a loop or stack, reorder a stack, and open logs.

## FE-04 Studio And Builder Chat

Build:

- Loop Contract editor.
- Execution path drag/drop and reorder.
- Skill shelf.
- Builder Chat.
- Change receipt.

Out of scope:

- LLM-generated contract patches.
- Real skill compatibility validation.

Usable when:

- A user can build or edit a loop from visible fields, add/reorder/remove path steps, ask chat for a change, review the proposed change, and apply it to the visible contract.

## FE-05 Workbench And Run Result

Build:

- Active queue.
- Run result detail.
- Final Answer section.
- Timeline.
- Evidence gaps.
- Review Packet.
- Run Chat.

Out of scope:

- Real task runner changes.
- Final-answer authority changes.

Usable when:

- A user can start several mocked runs, select each run independently, inspect result state, and chat within the selected run context.

## FE-06 Knowledge And Toasts

Build:

- Knowledge source list.
- Source detail.
- Attach target picker.
- Activity/extraction state.
- Toast/banners for action feedback.

Out of scope:

- Real document parsing.
- Real vector store or retrieval system.

Usable when:

- A user can add or select a source, inspect freshness/activity, attach it to a loop/run/builder chat target, and undo or open the affected object from the toast.

## FE-07 Shared Components

Build shared components after at least two modules need the same behavior:

- Object header.
- Database row.
- Segment control.
- Search/filter toolbar.
- Detail inspector.
- Empty state.
- Loading skeleton.
- Inline error.
- Toast/banner.
- Scoped chat composer.
- Drag row.

Avoid building a generic component system before module screens prove the patterns.

## Shared Mock Data

Use mock data with these small shapes:

- `LoopListItem`: id, title, type, domain, readiness, skillPath, lastRun, primaryAction.
- `SkillPackageItem`: id, title, kind, source, setupState, usedBy, primaryAction.
- `RunQueueItem`: id, loopTitle, status, startedAt, skillPath, reviewState, finalState.
- `KnowledgeSourceItem`: id, title, type, freshness, extractionState, attachedTo.
- `ChatMessage`: id, scope, role, body, proposedAction.

Keep mock data local to frontend prototypes until backend integration is intentionally started.
