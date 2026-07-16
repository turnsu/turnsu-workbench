# Workbench / Active Queue / Run Result Redesign V3

Workbench / Active Queue / Run Result V3 is product interaction guidance for the user-facing module. It is a reference, not an implementation prerequisite.

The new direction treats Workbench as the default work surface for running loops and reading results. Active Queue and the selected Run Result must appear in the same task context, so the user can move between multiple runs without losing which result, chat, packet, and source set belong together.

Every selected run must answer five questions without making the user infer from a chat transcript or background log:

- Which run am I looking at?
- Is it active, blocked, ready for review, or complete?
- What is the authoritative Final Answer?
- What evidence, gaps, Review Packet, and resources belong to this run?
- Where do I continue the work without leaking context into another run?

## Reference Breakdown

Required source files reviewed:

- `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/modules/workbench-run-result.md`
- `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/10-objective-completion-matrix.md`
- `PRODUCT.md`
- `DESIGN.md`

Reference takeaways:

| Source | Useful signal for V3 |
| --- | --- |
| Existing Workbench / Run Result module | Workbench already points toward same-screen queue and selected result, with Final Answer, timeline, evidence gaps, Review Packet, run-bound resources, and locked Run Chat as the stable result structure. |
| Objective completion matrix | Multi-run isolation, run-scoped chat, Review Packet persistence, run-bound Knowledge, Tool Logs, and manual review routes are key behaviors. Visual and product review should still distinguish implementation evidence from user trust. |
| Product direction | looloomi is a quiet local-first macOS workbench. The user wants to start work quickly, know the authoritative answer, continue or refine a result, and keep safety boundaries visible without seeing runtime internals. |
| Design direction | LoopOps v2 makes Workbench the default product surface, Current Run Canvas the main result area, and Chat the control layer. The layout should use native macOS density, restrained surfaces, clear state, and user-language labels. |

Design translation:

- Workbench is the daily operating surface, not a verification or review-only panel.
- Active Queue is always visible in regular and wide layouts; selected result is always visible beside it.
- Run Result has a fixed authority order: Run header, Final Answer, status timeline, evidence gaps, Review Packet, run-bound resources, Run Chat.
- The selected run owns its chat, packet, resources, timeline, and output. Selection changes all run-scoped content together.
- Multi-run isolation must be visible through row identity, selection treatment, run scope labels, and locked context in Run Chat.
- Use compact rows, separators, grouped surfaces, and stable columns. Avoid decorative cards and oversized explanatory copy.
- Use user-facing labels such as Final Answer, Active Queue, Review Packet, Evidence gaps, Knowledge, Tool Logs, Run Chat, Share-safe Log, Reviewed, Needs follow-up, Blocked.
- Hide raw provider, worker, artifact path, schema, secret, and internal runtime vocabulary from the main surface.

## Current UI Failure List

V3 exists because the current module has enough structure to be recognizable, but not enough product authority:

1. Workbench can still read like a review or evidence console instead of the default place where a user starts and resumes work.
2. Active Queue and selected result can feel like adjacent panels instead of one synchronized work surface.
3. The selected run identity is not strong enough. Users need run title, domain, status, attempt, source loop, and selected row state to stay visible.
4. Final Answer can compete with timeline, packet, logs, and chat. The target must make Final Answer the first authority, then let details support it.
5. Multi-run batches can be created, but visual separation is not yet strong enough for users to trust that run chat, resources, and packet decisions are isolated.
6. Review Packet can look like one more detail block. It should be a decision object with clear state, claims, evidence gaps, blocked actions, next questions, notes, and event history.
7. Evidence gaps are easy to bury. Missing or weak evidence should be near the answer and connected to follow-up actions.
8. Run Chat can be present without enough locked-scope clarity. Users must see that messages go to the selected run only.
9. Run-bound Knowledge and Tool Logs can appear as support material, but the target needs explicit ownership by the selected run.
10. Queue lifecycle actions can exist without a clear before-and-after state in the result timeline, Review Packet, and Run Chat.
11. Review-ready and reviewed states are too easy to blur. The UI should separate ready for review, reviewed, needs follow-up, and blocked.
12. Empty and blocked states can drift toward generic copy. The target should name the next concrete action.

## New Information Architecture

Workbench is a single task surface with three coordinated zones.

| Area | Purpose | Default behavior |
| --- | --- | --- |
| Workbench command row | Starts work and narrows the visible queue | Domain filter, loop picker, search, batch summary, and primary start action |
| Active Queue | Shows active, recently completed, blocked, and review-needed runs | Persistent list; selecting a row controls the full result surface |
| Selected Run Result | Shows the authoritative result and run-scoped detail | Always bound to the selected queue row |
| Run Support region | Holds Review Packet, resources, Share-safe Log, and Run Chat when width allows | Right side on wide layouts; stacked below result on compact layouts |
| Follow-up composer | Continues the selected run through Run Chat or starts a new loop from Workbench | Scope label is always visible |

Surface hierarchy:

| Priority | Content | Reason |
| --- | --- | --- |
| 1 | Selected run identity and status | The user must know which run is in focus before reading any result. |
| 2 | Final Answer | The answer is the authority; no other text should look more definitive. |
| 3 | Evidence gaps and review boundary | The user needs immediate confidence and risk context. |
| 4 | Timeline | The user can inspect how the result reached the current state. |
| 5 | Review Packet | The decision layer records claims, gaps, questions, and review state. |
| 6 | Run-bound resources | Knowledge, Tool Logs, and Share-safe Log explain the source context. |
| 7 | Run Chat | The user continues the selected run without changing run scope. |

Active Queue row model:

| Field | Meaning | Example display |
| --- | --- | --- |
| Run title | Human-readable run name | `BTC Market Report` |
| Domain | Work area | `Crypto` |
| Status | Running, queued, blocked, review-ready, complete | `Review-ready` |
| Loop source | Saved loop or starter loop | `Market Report Loop` |
| Time | Started, updated, or completed time | `Updated 2m ago` |
| Review state | Packet decision state | `Needs follow-up` |
| Resource count | Knowledge and Tool Log ownership | `2 Knowledge · 3 Logs` |
| Chat count | Run-scoped chat activity | `4 messages` |

Selected Run Result sections:

| Section | Required content | Default state |
| --- | --- | --- |
| Run header | Run title, status, domain, loop source, attempt, selected scope, timestamps | Sticky within result when scrolling |
| Final Answer | Authoritative answer, domain-native summary, copy/save/follow-up actions | Open by default |
| Evidence gaps | Missing evidence, weak claims, unsupported assumptions, next evidence action | Visible directly below answer |
| Timeline | Start, queued, running, packet created, decisions, blocked, completed, follow-up events | Collapsible after first rows |
| Review Packet | Decision, claims, evidence gaps, blocked actions, next questions, notes, event history | Visible in support region or below timeline |
| Run resources | Knowledge, Tool Logs, Share-safe Log, source detach/restore receipts | Grouped by resource type |
| Run Chat | Locked run scope, transcript, composer, follow-up suggestions | Scope label cannot be hidden |

Layout rules:

- Wide: queue on the left, selected result in the center, support region on the right.
- Regular: queue on the left, selected result and support content in a two-row center stack.
- Compact: queue becomes the first section, result follows, support and Run Chat become collapsible sections below.
- Active Queue keeps a stable minimum width; the Final Answer area gets the most horizontal room.
- Top controls wrap instead of compressing row labels or action buttons.
- Row selection and Run Chat scope label must use the same selected run title or short id.

## Core User Paths

1. Start a single ready loop
   - User opens Workbench.
   - Command row shows runnable loops and recent domains.
   - User starts a ready loop.
   - A new Active Queue row appears and becomes selected.
   - Selected Run Result opens with running status, timeline, and empty Final Answer state until output is ready.

2. Start several loops together
   - User selects two or three loops from Workbench.
   - Launch summary shows selected count, ready count, setup-needed count, and skipped count.
   - Ready loops create separate Active Queue rows.
   - The newest or first launched run is selected by default.
   - Each row keeps separate status, answer, resources, Review Packet, and Run Chat.

3. Switch between active runs
   - User clicks a different queue row.
   - Header, Final Answer, evidence gaps, timeline, Review Packet, resources, and Run Chat switch together.
   - The previous run keeps its state and unread activity marker.
   - No chat transcript, packet note, or resource attachment appears under the wrong run.

4. Read a completed result
   - User selects a run marked `Review-ready` or `Complete`.
   - Final Answer appears first with status and timestamp.
   - Evidence gaps appear immediately below the answer.
   - Timeline and Review Packet provide supporting detail without competing with the answer.

5. Resolve an evidence gap
   - User sees a gap under Final Answer.
   - Gap row names the missing source or weak claim and offers a concrete action: attach Knowledge, ask Run Chat, open Tool Log, or mark as accepted limitation.
   - Action updates the selected run timeline and Review Packet event history.

6. Review the result
   - User opens Review Packet in the support region.
   - Packet shows decision state, claims, evidence gaps, blocked actions, next questions, notes, and event history.
   - User marks Reviewed, Needs follow-up, or Blocked.
   - The queue row and selected Run Result update review state without changing Final Answer text.

7. Continue in Run Chat
   - User types into Run Chat while a run is selected.
   - Composer label states the selected run scope.
   - Reply appends to that run chat only.
   - Follow-up can refine the result, add a packet note, or create a next question without affecting another run.

8. Inspect run-bound resources
   - User opens Knowledge or Tool Logs from the selected result.
   - Resource rows show why they belong to this run.
   - Detach, restore, or open review actions update the selected run timeline.
   - Switching to another run shows a different resource set.

9. Handle a blocked run
   - User selects a blocked queue row.
   - Final Answer area shows no authoritative answer if the run stopped before one exists.
   - Blocked state names the cause, repair action, and whether a new attempt is needed.
   - Timeline, Review Packet, and Run Chat record the blocked state.

## High-Fidelity Target Draft

Overall layout:

- Global sidebar remains outside this module; Workbench is the active surface.
- Workbench header is compact: `Workbench` title, domain filter, loop picker, start action, and batch launch summary.
- Main surface uses a split layout:
  - Left: Active Queue.
  - Center: Selected Run Result.
  - Right or lower region: Review Packet, resources, and Run Chat.
- No hero area, no dashboard metrics strip, no marketing explanation.
- The first visible task object is either the selected active run or an empty queue state with starter loop actions.

Active Queue visual treatment:

- Rows use compact density with two-line max titles.
- Selected row uses system selection treatment and a clear left alignment with the Run Result header.
- Status uses an icon, label, and restrained color. Color never carries status alone.
- Running rows show progress text such as `Gathering sources` or `Writing answer`, not internal step names.
- Completed rows show `Review-ready`, `Reviewed`, `Needs follow-up`, or `Blocked`.
- Batch siblings show a shared batch label while still preserving unique row identity.
- Resource and chat counts are secondary metadata, not large badges.

Active Queue row anatomy:

```text
BTC Market Report
Crypto · Market Report Loop · Review-ready · 2 Knowledge · 3 Logs · 4 messages
```

```text
Weekly Markets Brief
Markets · Briefing Loop · Running · Writing answer · updated now
```

```text
Meeting Summary Draft
Office · Meeting Loop · Blocked · Missing transcript · repair needed
```

Selected Run Result anatomy:

- Header:
  - Run title, short run id, domain, loop source, attempt, status, timestamps.
  - Primary actions: Continue, Mark reviewed, Save, Share-safe Log when available.
  - Secondary actions: Replay, Clone loop, Open ledger when available.
- Final Answer:
  - Prominent title `Final Answer`.
  - Authoritative output in readable prose or domain-native blocks.
  - Copy and save actions near the answer, not hidden in resource panels.
  - If output is unavailable, state why and what happens next.
- Evidence gaps:
  - Compact rows with gap label, severity, affected claim, and next action.
  - Accepted limitations stay visible but lower in emphasis than unresolved gaps.
- Timeline:
  - Chronological event list with user-facing labels.
  - Major lifecycle events stay visible; routine progress can collapse.
  - Review decisions, source attach/detach, and Run Chat follow-ups appear in the same run timeline.
- Review Packet:
  - Decision state at top.
  - Claims, evidence gaps, blocked actions, next questions, notes, and event history.
  - Packet actions never rewrite Final Answer.
- Run resources:
  - Knowledge rows show source name, source type, and relationship to the selected run.
  - Tool Log rows show action summary, source, status, and review entry.
  - Share-safe Log preview shows what can be copied or shared.
- Run Chat:
  - Header says `Run Chat` plus selected run title or short id.
  - Composer remains locked to the selected run.
  - Quick actions are scoped to review, follow-up, refine answer, or attach context.

Empty states:

- No active runs: show starter loop actions and recent ready loops.
- Queue filtered empty: show filter reset and a clear reason.
- No selected run: select the newest active or review-ready run automatically when possible.
- Final Answer pending: show current run phase and expected next state.
- Review Packet missing: show `Packet not created yet` and the event that will create it.
- Run Chat empty: show scoped follow-up suggestions tied to the selected run.

Blocked states:

- Missing input: show the exact field and edit action.
- Missing Knowledge: show required source type and attach action.
- Missing transcript or document: show import or attach action.
- Review blocked: show the decision needed and why the result cannot move forward.
- No final output: do not display placeholder text as an answer.

Visual priority:

- Final Answer gets the strongest type weight and most reading width.
- Evidence gaps sit close to the answer.
- Review Packet and resources are structured support, not competing headline panels.
- Run Chat is visually available but clearly scoped and lower than Final Answer.
- Separators and grouped surfaces carry structure; cards are reserved for repeated resource rows or packet subsections.

## Interaction State Table

| State | Queue label | Result headline | Visible primary action | Review Packet state | Run Chat behavior |
| --- | --- | --- | --- | --- | --- |
| Empty queue | `No active runs` | Start a loop from Workbench | Start loop | None | Global or starter scope only |
| Queued run | `Queued` | Run is waiting to start | Open run | Not created | Locked to selected run, read-only until activity begins |
| Running run | `Running` | Final Answer is being prepared | Continue | Draft or not created | Locked to selected run with progress receipts |
| Final answer ready | `Review-ready` | Final Answer | Mark reviewed | Created, needs decision | Follow-up can refine or ask next question |
| Reviewed run | `Reviewed` | Final Answer | Save or share-safe log | Reviewed | Follow-up creates new chat events without changing decision automatically |
| Needs follow-up | `Needs follow-up` | Final Answer with open questions | Continue | Needs follow-up | Composer emphasizes next questions |
| Blocked before answer | `Blocked` | No Final Answer yet | Fix issue | Blocked | Chat explains the selected run issue only |
| Blocked after answer | `Blocked` | Final Answer with blocked action | Resolve block | Blocked with reason | Follow-up stays attached to this run |
| Completed run | `Complete` | Final Answer | Save | Reviewed or review optional | Chat remains available for follow-up |
| Batch sibling selected | `Batch item` | Final Answer for selected batch item | Continue | Per-run state only | Chat scope changes to selected sibling only |
| Resource detached | `Source changed` | Final Answer with source notice | Restore source | Event added | Chat shows detach receipt for this run |
| New attempt | `Attempt 2` | Latest attempt answer | Compare attempts | Per-attempt event history | Chat attaches to current attempt unless user opens old attempt |

Interaction rules:

- Clicking a queue row selects the run; it never triggers a lifecycle action by itself.
- Row action buttons must be explicit and stable in placement.
- Selection changes all run-scoped content together: Final Answer, evidence gaps, timeline, Review Packet, resources, and Run Chat.
- A batch label can group related rows, but each run keeps its own answer, packet, resources, and chat.
- Review decisions update Review Packet and queue state; they do not alter the stored Final Answer.
- Run Chat follow-up belongs to the selected run only.
- Resource detach and restore actions add visible events to the selected run.
- Blocked runs show repair actions before replay actions.

## Acceptance Criteria

- The document defines Workbench as the default work surface, not a review-only or diagnostics surface.
- Required headings are present exactly as section headings.
- Active Queue and selected Run Result are described as same-screen, synchronized surfaces.
- Run Result has a fixed hierarchy with run header, authoritative Final Answer, evidence gaps, timeline, Review Packet, resources, and Run Chat.
- Final Answer is clearly the highest-authority output and does not compete with chat or logs.
- Evidence gaps are visible near the answer and connected to concrete next actions.
- Review Packet is defined as a decision object with claims, evidence gaps, blocked actions, next questions, notes, and event history.
- Run Chat is locked to the selected run and cannot visually imply shared context across runs.
- Multi-run isolation is defined through queue identity, selected state, batch grouping, resource ownership, packet state, and chat scope.
- Running, queued, review-ready, reviewed, needs follow-up, blocked, completed, resource-changed, and new-attempt states are represented.
- Empty and blocked states include concrete next actions.
- Product vocabulary hides internal runtime names and uses user-facing labels.
- Visual direction follows native macOS product density: compact rows, stable controls, restrained color, clear selection, and few cards.
- The file is a design target only and does not request production UI, web prototype, or native code changes in this step.

## Implementation Notes For Later

- Treat this file as the reviewable product target for V3 before any UI work.
- Future implementation should model selected run as the single owner of answer, timeline, evidence gaps, packet, resources, and chat scope.
- Active Queue rows should derive labels from the same run state used by the selected result header.
- Final Answer should have an explicit authority field or pointer so UI never chooses between chat text and stored output.
- Evidence gaps should be structured enough to link each gap to a claim, severity, and next action.
- Review Packet decisions should be separate from Final Answer content and reversible through normal review editing.
- Resource ownership should be run-scoped: Knowledge, Tool Logs, and Share-safe Log previews should not appear under another run.
- Batch runs need a parent grouping field plus independent child run state.
- Attempts need visible numbering and a clear rule for which attempt Run Chat follows.
- Compact layout should preserve the same IA by stacking queue, result, support, and chat rather than removing run-scoped content.
- Future verification should be based on human visual review and behavior review without adding automation-only labels to the product surface.

## Use

Reference guidance for redesign and implementation.
