# Studio / Builder Chat / Execution Path Redesign V3

Studio / Builder Chat / Execution Path V3 is product interaction guidance for the Studio module. It is a reference, not an implementation prerequisite.

The new direction treats Studio as the Loop Contract page. It is not a configuration dump, a hidden execution console, or a chat-only builder. The page must make the contract legible as a user-owned work object: what starts the loop, what inputs it needs, what it will do in order, what requires human review, and where the result lands.

The target layout is a stable three-column workspace:

- Left: Skill shelf for reusable capabilities and context objects.
- Center: Contract page with editable contract sections and an ordered Execution Path.
- Right: Builder Chat with a patch receipt for every natural-language change.

Every natural-language modification must produce a reviewable patch before it changes the saved contract. The user can apply it, reject it, or save the current contract state explicitly.

## Reference Breakdown

Source files reviewed:

- `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/modules/skill-os-tool-builder-logs.md`
- `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/modules/triple-chat-quick-gui.md`
- `PRODUCT.md`
- `DESIGN.md`

Reference takeaways:

| Source | Useful signal for V3 |
| --- | --- |
| Skill OS / Tool Builder / Logs research | Skill OS defines reusable capabilities, drafts, stacks, and logs. Studio should borrow the Build / Use / Logs discipline, but it should present those capabilities as contract ingredients instead of backend objects. |
| Triple-style Chat / Quick GUI research | Chat is a control layer with visible scope, model, mode, search, temporary state, prompt category, and attachments. Builder Chat must stay scoped to the selected contract and must create receipts for changes. |
| Product direction | looloomi is a quiet local-first macOS workbench. The user wants to start crypto, markets, or office loops quickly, continue from results, identify the authoritative output, and keep safety boundaries visible without seeing implementation internals. |
| Design direction | LoopOps v2 makes Loop the main object and Chat the control layer. Studio is for advanced Loop Contract editing: trigger, inputs, steps, review boundary, exit condition, and output shape. |

Design translation:

- Studio is a contract authoring page, not a settings form.
- Builder Chat proposes changes, but the contract page remains the source of truth.
- Execution Path is an ordered outline with step numbers, dependencies, review points, and outputs.
- Skill shelf items can be inserted into the path, but they should not dominate the page as chips.
- The right rail shows scoped chat and patch receipts, not an unbounded chat history.
- User-facing labels should stay direct: Loop Contract, Skill shelf, Execution Path, Review, Apply, Reject, Save.
- Internal implementation vocabulary stays out of the main surface.

## Current UI Failure List

V3 exists because the current Studio direction is structurally correct but not yet product-grade:

1. Studio can still feel like a field dump. Name, domain, trigger, inputs, steps, review boundary, and output shape need to read as one coherent contract page.
2. Builder Chat can appear authoritative even when its suggestions have not been applied. The user needs a receipt that clearly separates proposed changes from saved contract state.
3. Natural-language edits can feel too magical. Every change must show what will be added, edited, removed, or left unchanged.
4. Execution Path risks becoming a row of chips. The path should read like an ordered outline with sequence, purpose, input, review point, and output.
5. Skill selection can become a palette of technical capabilities instead of a shelf of reusable user-facing work ingredients.
6. Apply, Reject, and Save are not yet strong enough as separate decisions. Applying a patch should update the editable contract; saving should commit the current contract draft.
7. There is not enough visibility into unsaved changes. The page needs clear dirty state, last saved time, and pending patch count.
8. Review boundary can be buried inside step text. It should appear both in the contract summary and at the exact point in the Execution Path.
9. Output shape can look like a data detail instead of a promise to the user about where the final answer, draft, review packet, ledger entry, or share-safe log appears.
10. Empty states need to guide contract creation without turning Studio into onboarding copy or a marketing page.
11. Failure and blocked states need repair actions tied to contract sections, not generic warnings.
12. The layout can drift toward panels inside panels. V3 should use a calm split layout, separators, and grouped rows rather than nested cards.

## New Information Architecture

Studio is a single contract editing surface with three persistent regions.

Top-level structure:

| Area | Purpose | Default behavior |
| --- | --- | --- |
| Studio header | Identifies the current Loop Contract and save state | Shows contract name, domain, status, last saved time, Run preview, Save |
| Skill shelf | Lets the user browse reusable skills and context objects | Searchable left shelf with Skills, Extensions, Knowledge, Recent runs, and Saved snippets |
| Contract page | Main editable contract body | Center column with Summary, Trigger, Inputs, Execution Path, Review boundary, Output shape |
| Builder Chat | Scoped natural-language assistant | Right rail with Builder Chat, quick controls, composer, and patch receipts |
| Patch receipt | Reviewable change proposal | Appears above or within Builder Chat when a natural-language edit creates changes |

Contract page sections:

| Section | Purpose | Required display |
| --- | --- | --- |
| Contract Summary | Names the loop and its job | Name, domain, one-sentence goal, current readiness |
| Trigger | Defines how the loop starts | Manual, scheduled, from chat, from ledger replay, or from a selected object |
| Inputs | Defines user-provided and reusable context | Required inputs, optional inputs, defaults, validation copy |
| Execution Path | Defines the ordered work outline | Numbered steps, step intent, input used, skill used, review point, output |
| Review Boundary | Defines what requires human confirmation | Review reason, decision options, blocked condition, owner |
| Output Shape | Defines result destination and form | Final answer, draft, review packet, ledger entry, share-safe log |

Skill shelf groups:

| Group | Examples | Insert behavior |
| --- | --- | --- |
| Skills | Market report, thesis review, meeting summary | Insert as a step or replace the selected step's skill |
| Extensions | Calendar source, document export, workspace search | Attach to inputs or step context |
| Knowledge | Research notes, meeting source, saved market context | Bind to inputs or a selected path step |
| Recent runs | Completed or blocked loop runs | Use as replay context or clone a step pattern |
| Snippets | Saved review rules, output formats, prompt fragments | Insert into the selected contract section |

Patch receipt model:

| Receipt part | Purpose |
| --- | --- |
| Request | Shows the user's natural-language instruction |
| Proposed changes | Groups changes by Contract Summary, Trigger, Inputs, Execution Path, Review Boundary, and Output Shape |
| Diff summary | Short labels for add, edit, remove, and reorder |
| Affected path | Lists changed step numbers and review points |
| Confidence note | Plain-language note when the builder is uncertain or missing information |
| Actions | Apply, Reject, Refine, Save after apply |

Save model:

- `Apply` updates the editable draft on the page.
- `Reject` closes the proposal and leaves the draft unchanged.
- `Refine` keeps the proposal open and sends a scoped follow-up to Builder Chat.
- `Save` commits the current draft.
- Unsaved changes remain visible until saved or discarded.
- A saved contract can still have a new pending patch that has not been applied.

## Core User Paths

1. Open an existing loop in Studio
   - User opens a saved loop from Library or Workbench.
   - Studio shows the contract page with Summary, Trigger, Inputs, Execution Path, Review Boundary, and Output Shape.
   - Builder Chat opens in `Builder Chat` scope for this contract.
   - No chat suggestion changes the contract until the user reviews a patch receipt.

2. Add a step from the Skill shelf
   - User selects a position in the Execution Path.
   - User drags or inserts a skill from the left shelf.
   - The new step appears in the ordered outline with a step number, intent, required input, review marker, and output.
   - The contract becomes unsaved and the header shows a clear save state.

3. Modify the contract with Builder Chat
   - User asks Builder Chat to change the loop, for example: make the review happen before the final summary.
   - Builder Chat replies with a patch receipt, not a silent mutation.
   - Receipt groups changes by contract section and highlights affected path steps.
   - User can Apply, Reject, or Refine.
   - Applying updates the center contract page and leaves the contract in unsaved state.
   - Saving commits the draft.

4. Reorder Execution Path
   - User drags a step handle or asks Builder Chat to reorder steps.
   - Direct drag updates the draft immediately and marks it unsaved.
   - Chat-driven reorder creates a patch receipt first.
   - The outline preserves numbering, dependency notes, and review point placement after reorder.

5. Repair a blocked contract
   - User opens a contract marked `Needs setup`.
   - Header and affected sections show missing inputs, missing knowledge binding, or missing review rule.
   - Contract page focuses the first missing section.
   - Builder Chat can propose a repair patch, but the user still reviews and applies it.

6. Preview run readiness
   - User selects `Run preview`.
   - Studio shows what will start the loop, required input values, ordered path, review point, and output destination.
   - Preview does not run the loop.
   - If setup is incomplete, preview lists repair actions by contract section.

7. Create a contract from chat
   - User starts from Builder Chat or a draft entry.
   - Chat creates an initial patch receipt that would populate Summary, Trigger, Inputs, Execution Path, Review Boundary, and Output Shape.
   - User applies the receipt to create the draft page.
   - User saves only after reviewing the visible contract.

## High-Fidelity Target Draft

Overall layout:

- Studio uses a three-column split with global navigation outside the module.
- Header spans the module width and remains compact.
- Left Skill shelf is narrow but searchable.
- Center Contract page is the primary reading and editing surface.
- Right Builder Chat rail is narrower than the contract page and can collapse into a drawer on compact widths.
- No hero area, no marketing copy, no oversized decorative cards.

Header anatomy:

```text
Studio     BTC Market Report Contract     Crypto     Unsaved changes     Run preview     Save
```

Header behavior:

- Contract name is editable inline.
- Domain is a compact selector.
- Save state shows `Saved`, `Unsaved changes`, or `Pending patch`.
- `Run preview` opens a readiness preview.
- `Save` is disabled when there are no draft changes.
- If a patch is pending, header shows the pending count and keeps Save visually separate from Apply.

Left Skill shelf:

- Search field at top: `Search skills and context...`
- Segmented filter: Skills, Extensions, Knowledge, Runs, Snippets.
- Shelf rows use icon, name, short type, and availability state.
- Rows are draggable into Execution Path or selectable for insert.
- Availability state uses one short label: Available, Needs setup, Limited, Not available.
- Shelf does not show implementation IDs or low-level execution detail.

Shelf row anatomy:

```text
Market report        Skill        Available
Research notes       Knowledge    Bound to inputs
Meeting summary      Skill        Needs setup
```

Center Contract page:

- Uses a document-like grouped layout, not a form dump.
- Each section has a short title, current value, edit affordance, and section-level change marker when unsaved.
- Section order is stable: Summary, Trigger, Inputs, Execution Path, Review Boundary, Output Shape.
- Inline edits use native text fields, popovers, segmented controls, and compact menus.
- Long values wrap cleanly and keep labels aligned.

Contract summary block:

```text
Goal
Create a concise crypto market report from selected symbols, recent market context, and saved research notes.

Readiness
Ready to preview. One optional knowledge source is not bound.
```

Trigger block:

```text
Starts from
Manual run or Builder Chat request

Required before start
Symbols, timeframe, review owner
```

Inputs block:

| Input | Type | Required | Current value | Repair action |
| --- | --- | --- | --- | --- |
| Symbols | Market symbols | Required | BTC, ETH | Edit |
| Timeframe | Time range | Required | 24h | Edit |
| Research notes | Knowledge source | Optional | Not bound | Bind |
| Review owner | Person | Required | Me | Edit |

Execution Path block:

The path is an ordered outline. It should never render as a loose chip pile.

```text
1. Collect market context
   Uses: Market data skill
   Inputs: Symbols, timeframe
   Output: Price and market summary

2. Compare against saved research
   Uses: Research notes
   Inputs: Market summary, optional knowledge source
   Output: Thesis deltas

3. Draft final answer
   Uses: Markets writing skill
   Inputs: Price summary, thesis deltas
   Output: Final answer draft

4. Human review
   Review point: Confirm no trade execution is implied
   Decision: Reviewed, Needs follow-up, Blocked

5. Prepare share-safe log
   Uses: Delivery formatter
   Inputs: Reviewed final answer
   Output: Ledger entry and share-safe preview
```

Execution Path row anatomy:

| Element | Behavior |
| --- | --- |
| Step number | Stable order marker; updates after reorder |
| Step title | Editable user-facing intent |
| Uses | Skill or context object from shelf |
| Inputs | Contract inputs or prior step outputs |
| Output | Named result produced by the step |
| Review marker | Inline marker when the step requires human review |
| Actions | Edit, duplicate, move, remove |

Review Boundary block:

- Shows the human review rule in plain language.
- Shows why review exists.
- Shows the available decision labels.
- Shows what happens if the review is blocked.
- Links the review rule to the exact Execution Path step.

Output Shape block:

- Defines the authoritative final answer.
- Defines whether a draft, Review Packet, Run Ledger entry, or share-safe log is created.
- Shows where the user will find the result after running.
- Keeps delivery and sharing language separate from contract editing.

Right Builder Chat rail:

- Header label: `Builder Chat`.
- Scope line: current contract name and unsaved state.
- Quick controls stay compact: mode, search, attachment, temporary state.
- Chat messages remain secondary to the contract page.
- Builder replies that change the contract create patch receipts.
- Receipts stay visible until applied, rejected, or refined.

Patch receipt visual:

```text
Patch receipt
Request: Move human review before final answer delivery.

Changes proposed
Execution Path
+ Add review marker after step 3
~ Move share-safe log preparation after review

Review Boundary
~ Change blocked condition to stop delivery until review is complete

Actions: Apply  Reject  Refine
```

Patch receipt behavior:

- Each receipt belongs to one Builder Chat request.
- Multiple receipts can be queued, but only one is active for review.
- Applying a receipt updates the center contract page and marks the draft unsaved.
- Rejecting a receipt writes no contract change.
- Refining a receipt keeps the proposed change visible while the user asks a follow-up.
- Saving is a separate action after applying.

Compact layout:

- Skill shelf collapses into a left drawer.
- Builder Chat collapses into a right drawer.
- Contract page remains the main surface.
- Execution Path keeps its ordered outline and does not degrade into chips.
- Patch receipt opens above the composer or as a focused review panel.

Empty states:

- No contract selected: show recent contracts and create-from-chat entry, no long explanation.
- Empty Execution Path: show one inline action, `Add first step`.
- Empty Skill shelf search: show reset search and current filter.
- Empty Builder Chat: show scoped composer and small suggested actions tied to the current contract.

Blocked states:

- Missing input: focus Inputs and show the exact required field.
- Missing skill setup: show the shelf row and setup destination.
- Missing review boundary: focus Review Boundary and offer a builder patch.
- Output undefined: focus Output Shape and require a destination before preview.

## Interaction State Table

| State | Center contract page | Builder Chat rail | Available actions | Save behavior |
| --- | --- | --- | --- | --- |
| Saved contract | Sections show current saved values | Composer is ready in Builder Chat scope | Edit, Run preview, Save disabled | No save needed |
| Direct edit unsaved | Edited section has change marker | Chat remains available | Save, Discard changes, Run preview | Save commits draft |
| Chat patch proposed | Contract page stays unchanged | Patch receipt is active | Apply, Reject, Refine | Save remains separate |
| Patch applied unsaved | Contract page reflects applied proposal | Receipt moves to applied history | Save, Discard changes, Run preview | Save commits applied draft |
| Patch rejected | Contract page stays unchanged | Receipt closes as rejected | Continue chat, request new patch | No save needed |
| Patch refined | Contract page stays unchanged | Receipt remains open with follow-up thread | Apply, Reject, Refine | No save until apply |
| Missing input | Inputs section is focused | Chat can suggest repair | Edit input, bind source, request patch | Save after repair |
| Missing skill setup | Affected path step is marked | Shelf row shows setup state | Replace skill, setup, request patch | Save after repair |
| Missing review boundary | Review Boundary section is focused | Chat can create review-rule patch | Add review rule, request patch | Save after repair |
| Ready to preview | All required sections are complete | Chat can explain contract | Run preview, Save if dirty | Preview does not save |
| Compact drawer mode | Contract page remains primary | Chat or shelf appears as drawer | Open drawer, close drawer, apply receipt | Same as regular layout |

Interaction rules:

- Clicking a shelf item selects it; it does not insert until the user chooses a target or drops it.
- Dragging a shelf item into the path inserts it at the visible drop position.
- Direct edits update the draft immediately and mark the section unsaved.
- Chat-driven edits never mutate the contract without a patch receipt.
- Applying a patch is not the same as saving.
- Rejecting a patch cannot remove direct edits the user already made.
- Reordering steps preserves review markers and dependency notes.
- Removing a step warns when another step depends on its output.
- Run preview reads the visible draft and reports readiness; it does not start a run.

## Acceptance Criteria

- The document defines Studio as a Loop Contract page, not a configuration dump.
- Required headings are present exactly as section headings.
- The target layout uses left Skill shelf, center Contract page, and right Builder Chat with patch receipt.
- Every natural-language contract change creates a reviewable patch receipt before changing the contract.
- Apply, Reject, Refine, and Save are defined as distinct actions.
- Applying a patch updates the editable draft but does not save it automatically.
- Rejecting a patch leaves the contract unchanged.
- Saving commits only the current draft state.
- Execution Path is defined as an ordered outline with numbered steps, inputs, outputs, review markers, and dependencies.
- Execution Path is explicitly not a chip pile.
- Review Boundary is visible both as its own contract section and at the relevant path step.
- Output Shape states where final answer, draft, review packet, ledger entry, or share-safe log appears.
- The Skill shelf supports searchable skills, extensions, knowledge, recent runs, and snippets without exposing implementation internals.
- Empty, blocked, unsaved, pending patch, applied patch, and compact drawer states are represented.
- Visual direction follows quiet macOS product UI: compact rows, separators, grouped layout, restrained color, and few cards.
- The file is a design target only and does not request production UI, web prototype, or native code changes in this step.

## Implementation Notes For Later

- Treat this file as the human-review target for Studio V3 before any UI work.
- Future implementation should model the visible contract sections as one editable draft object.
- Builder Chat should emit structured patch receipts grouped by contract section.
- The contract page should remain the source of truth after a patch is applied.
- Apply and Save should remain separate state transitions.
- Execution Path should store order, step intent, input references, output references, review markers, and dependency notes.
- Skill shelf insertion should require an explicit target step or section.
- Run preview should evaluate the visible draft and return readiness grouped by contract section.
- Compact layout should preserve the same IA by moving shelf and chat into drawers.
- Future review should compare the built surface against product clarity, visual quality and interaction behavior.

## Use

Reference guidance for redesign and implementation.
