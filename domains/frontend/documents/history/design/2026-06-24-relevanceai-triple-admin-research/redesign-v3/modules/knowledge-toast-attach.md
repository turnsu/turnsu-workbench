# Knowledge / Toast / Attach Redesign V3

This is product interaction guidance for Knowledge, toast feedback, and attach scope in LoopOps redesign-v3. It is a reference, not an implementation prerequisite.

## Reference Breakdown

Reference inputs read for this draft:

- `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/modules/knowledge-toast.md`
- `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/02-knowledge-toast-system.md`
- `PRODUCT.md`
- `DESIGN.md`

Key reference decisions carried into V3:

- Knowledge is a workspace source library, not a temporary attachment tray and not a runtime dump.
- The primary Knowledge shape is a Sources database with searchable rows, source status, and a source detail surface.
- New Knowledge keeps four user-facing starts: `Blank`, `Upload file`, `Import website`, and `Integrations`.
- Source lifecycle must be visible in durable UI: row status, detail metadata, and activity history.
- Toast is compact product feedback. It can confirm, warn, undo, or point back to durable state, but it is not the place where users review long-running history.
- Attach belongs near chat and loop context. It must name the current scope and state the consequence before changing a run, chat, or loop.
- LoopOps remains a quiet macOS productivity workspace. The UI should expose user work, final answers, review, sources, and delivery actions; it should not expose internal runtime terms.

## Current UI Failure List

- Knowledge can read as a mixed attachment feature instead of a durable source database when source rows, detail state, and attach flows are not clearly separated.
- A source row can be too thin if it only shows a name and status. Users need source type, document count, linked scope, updated time, and next action.
- Source detail can become ambiguous when creation, sync, review, attach, detach, and retry events are not visible as a coherent activity trail.
- Attach can feel risky when the user cannot see whether the action affects only the current chat, the current run, or the reusable loop.
- Attach failure can feel like silent refusal if the UI only blocks the action without naming the reason and the recovery step.
- Toast can become noisy if every system event appears as a feed item. Feedback must be short, dismissible, and tied to the current user action.
- Toast can be too weak if destructive or reversible actions do not offer undo at the point of feedback.
- Chat attachments and saved Knowledge sources can blur together. A staged file or website is not the same as a reusable source until the user saves or reviews it as Knowledge.
- Empty Knowledge states can over-explain the feature instead of offering clear first actions.
- User-facing copy can become less trustworthy if it names internal concepts, raw IDs, or hidden execution machinery.

## New Information Architecture

V3 uses three coordinated surfaces:

1. Knowledge Sources Database

The Knowledge landing surface is a database-style list of reusable sources. It supports search, status filters, source type filters, and a primary `New Knowledge` action. Rows are compact but complete enough to answer: what is this, can it be used, where is it linked, and what needs attention?

Recommended row fields:

| Field | Product meaning |
| --- | --- |
| Name | User-owned source name |
| Source type | `Blank`, `Upload`, `Website`, or `Integration` |
| Documents | Count or `0 documents` for empty sources |
| Linked | Current linked run, chat, loop, or `Not linked` |
| Updated | Last meaningful user-visible update |
| Status | `Draft`, `Syncing`, `Needs review`, `Ready`, or `Failed` |
| Action | Contextual next action such as `Review`, `Retry`, `Attach`, or `Open` |

2. Source Detail

Selecting a row opens a source detail surface. The detail surface is the durable home for metadata, setup state, activity, and attachment history.

Required sections:

- Header: source name, source type, status, document count, updated time.
- Setup state: import or setup progress, review need, error reason, retry affordance, and readiness action.
- Source contract: user-readable summary of what the source contains and how it can be used.
- Attached scopes: visible list of linked runs, chats, and loops.
- Activity: creation, import start, review, ready state, attach, detach, retry, failure, and undo recovery events.
- Actions: `Attach`, `Detach`, `Retry`, `Mark ready`, `Rename`, and source-type-specific edit actions where relevant.

3. Attach Drawer

Attach opens a drawer or sheet from chat, run result, loop detail, or source detail. It is not a generic picker. It is a scoped decision surface.

The drawer must show:

- Current scope: `Current run`, `Current chat`, `Selected loop`, or `Choose target`.
- Impact statement: what will change after attach.
- Source readiness: whether each candidate source is usable.
- Blocked reason: why a source cannot attach.
- Recovery action: what the user can do next, such as `Review source`, `Retry import`, or `Mark ready`.
- Confirmation action: a clear verb-object action such as `Attach source`.

## Core User Paths

Path A: Create a blank source

1. User opens Knowledge.
2. User chooses `New Knowledge` then `Blank`.
3. A source detail opens in `Draft` state with `0 documents`.
4. Toast says `Knowledge source created` with an action to open the source if the user has navigated away.
5. The source row remains visible with status `Draft` and action `Open`.

Path B: Import a website source

1. User chooses `New Knowledge` then `Import website`.
2. User enters a URL and confirms.
3. Source detail opens in `Needs review` or `Syncing`, depending on whether content is immediately inspectable.
4. Row status mirrors the detail state.
5. If import fails, the row and detail show `Failed`, the reason, and `Retry`.
6. Toast says `Website import needs attention` or `Website import failed` and offers a direct recovery action.

Path C: Attach ready source to current run

1. User opens Attach from the current run result or run chat.
2. Drawer header reads `Attach to current run`.
3. Impact statement says the source will be added to the current run context and shown in run chat.
4. User selects a `Ready` source.
5. User confirms `Attach source`.
6. Run result shows the source under Knowledge, run chat receives a readable receipt, source detail records the activity, and toast confirms the attach with `Undo`.

Path D: Attempt to attach a blocked source

1. User opens Attach and selects a source in `Draft`, `Syncing`, `Needs review`, or `Failed`.
2. Drawer keeps the primary attach action disabled or changes it to the relevant recovery action.
3. Inline reason names the blocker in user language.
4. Toast only appears if the user attempts the blocked action, and it states the same reason with one recovery action.
5. No run, chat, loop, or source link history is changed.

Path E: Save a chat attachment as Knowledge

1. User adds a file or website in chat.
2. The attachment chip is labeled as staged input, not a saved source.
3. User chooses `Save as Knowledge`.
4. Source detail opens in `Needs review` or `Draft`, depending on source type and content readiness.
5. The chat remains scoped to the current conversation, while the new source becomes available from Knowledge after review.

Path F: Detach with undo

1. User removes a source from a run, chat, or loop.
2. The affected surface removes the source link immediately.
3. Source detail records a detach activity row.
4. Toast says `Source detached` with `Undo`.
5. Undo restores the source to the same scope and writes a matching activity row.

## High-Fidelity Target Draft

Knowledge Sources Database:

- Top bar: page title `Knowledge`, search field, segmented status filter, source type filter, and `New Knowledge`.
- Empty state: centered but compact, with four action buttons: `Upload file`, `Website`, `Integration`, `Blank`. Copy should be one sentence and action-led.
- Row design: one source per row, with icon by source type, source name, short description, document count, linked scope label, updated time, status pill, and contextual action.
- Status pills use both label and color. Color alone is never the only signal.
- The row action changes by lifecycle:
  - `Draft`: `Open`
  - `Syncing`: `View`
  - `Needs review`: `Review`
  - `Ready`: `Attach`
  - `Failed`: `Retry`

Source Detail:

- Header area: source icon, editable name, type, status, document count, updated time, and primary action.
- Readiness panel: the first panel below the header. It states whether the source can be attached now.
- Content summary: user-readable description of source content and source boundaries.
- Attached scopes panel: grouped by `Runs`, `Chats`, and `Loops`; each row shows target name, last used time, and detach action where allowed.
- Activity panel: compact chronological rows. Each row has event label, timestamp, short result, and relevant recovery action.
- Footer actions: secondary management actions remain quiet and do not compete with attach/retry/review.

Attach Drawer:

- Drawer title changes by entry point:
  - From run result: `Attach to current run`
  - From run chat: `Attach to run chat`
  - From loop detail: `Attach to loop`
  - From global chat: `Choose attach target`
- Scope summary sits directly below the title:
  - `Current run: Market Report Loop - Jun 27`
  - `Current chat: Follow-up on latest result`
  - `Selected loop: Crypto Thesis Review`
- Impact statement uses plain language:
  - `The selected source will be available to this run and visible in run chat.`
  - `The selected source will be saved on this loop for future runs.`
  - `The selected source will only affect this chat.`
- Source list groups candidates by usability:
  - `Ready to attach`
  - `Needs attention`
  - `Unavailable`
- Each non-ready source row shows a reason:
  - `Import still syncing`
  - `Review required before attach`
  - `No documents yet`
  - `Last import failed`
- Drawer bottom bar shows selected source count, target scope, and the final action.

Toast:

- Position: non-blocking lower corner stack.
- Duration: long enough to read; user can dismiss.
- Collapsed mode: older toast items compress to a count or compact stack.
- Undo: visible for detach and other reversible link changes.
- Toast body limit: one short sentence plus one optional action.
- Toast should never become an audit trail. Durable details live in source detail and target run/chat/loop surfaces.

Recommended toast copy:

- `Knowledge source created`
- `Import started`
- `Website import needs review`
- `Upload failed: unsupported file type`
- `Source attached to current run`
- `Source detached`
- `Attach blocked: review source first`
- `Source restored`

## Interaction State Table

| Area | State | User sees | Primary action | Toast behavior | Durable state |
| --- | --- | --- | --- | --- | --- |
| Knowledge row | Empty database | Compact first actions | Create source | None until action | No source row yet |
| Knowledge row | Draft | `0 documents` or draft metadata | Open | Creation confirmation only | Row and detail show Draft |
| Knowledge row | Syncing | Progress and updated time | View | Import started or retry started | Row and detail show Syncing |
| Knowledge row | Needs review | Review-required label | Review | Review-needed feedback when created | Detail asks user to inspect |
| Knowledge row | Ready | Ready label and attach action | Attach | Attach confirmation after target chosen | Source can link to run/chat/loop |
| Knowledge row | Failed | Error reason summary | Retry | Failure message with retry action | Detail stores reason and retry count |
| Source detail | Ready but not linked | Attach readiness panel | Attach | None until attach completes | Activity remains unchanged |
| Source detail | Linked | Attached scopes list | Detach | Detach toast with Undo | Scope link and activity update |
| Attach drawer | No target | Scope chooser | Choose target | None | No mutation |
| Attach drawer | Target selected | Impact statement | Attach source | Confirmation with Undo when reversible | Target and source activity update |
| Attach drawer | Source blocked | Inline reason | Recovery action | Blocked feedback only after attempt | No link mutation |
| Toast stack | Single feedback | Short message and action | Dismiss or action | Self-contained | Durable state elsewhere |
| Toast stack | Multiple feedback items | Collapsed stack | Expand or dismiss | Readable, not noisy | Durable state elsewhere |

## Acceptance Criteria

- Knowledge opens as a Sources database with search, filters, rows, and a visible `New Knowledge` action.
- `New Knowledge` offers `Blank`, `Upload file`, `Import website`, and `Integrations`.
- A new source always lands in a visible lifecycle state: `Draft`, `Syncing`, `Needs review`, `Ready`, or `Failed`.
- Source row, source detail, and activity show consistent status and recovery actions.
- Source detail makes readiness, document count, attached scopes, and recent activity visible without exposing internal machinery.
- Attach drawer always names the current scope before the user confirms.
- Attach drawer explains whether the action affects a run, chat, loop, or chosen target.
- Only `Ready` sources can attach.
- Blocked attach shows a human-readable reason and recovery action.
- Blocked attach does not change run, chat, loop, or source link history.
- Successful attach updates the target surface, source detail activity, and toast feedback.
- Detach is reversible from toast with `Undo`.
- Toast is readable, dismissible, collapsible, and limited to product feedback.
- Toast does not replace row status, source detail, or target activity history.
- User-visible copy avoids raw IDs, hidden execution terms, and implementation-specific labels.

## Implementation Notes For Later

- Keep Knowledge, attach, and toast as separate responsibilities even when triggered by the same user action.
- Treat Knowledge source readiness as the single rule for attach eligibility.
- Store durable source lifecycle on source rows and source detail, not in toast state.
- Store target links where the affected run, chat, or loop can render them without searching transient feedback.
- Attach should be scoped by entry point first, then allow target selection only when the entry point has no clear target.
- Use the same user-facing source status labels in list, detail, drawer, and toast.
- Keep chat file or website inputs visually distinct from saved Knowledge sources until the user saves or reviews them.
- Avoid adding new user-visible internal labels while implementing this design.
- This document is reference guidance; production UI can diverge when the new interaction is stronger.

## Use

Reference guidance for redesign and implementation.
