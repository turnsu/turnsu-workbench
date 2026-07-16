# Loop Library / Marketplace Redesign V3

Loop Library / Marketplace V3 is product interaction guidance for the user-facing module. It is a reference, not an implementation prerequisite.

The new direction combines a Notion-style dense database with RelevanceAI-style marketplace listing detail. The module must feel like a work database for loops the user can own, run, clone, inspect, and review, not like an old scripted demonstration surface.

Every row and every detail view must answer four questions without making the user infer from hidden state:

- Can I run this now?
- Can I install or clone it?
- What is missing before it works?
- After it runs, where do I see the result?

## Reference Breakdown

Source files reviewed:

- `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/modules/marketplace-loop-library.md`
- `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/01-marketplace-template-library.md`
- `PRODUCT.md`
- `DESIGN.md`

Reference takeaways:

| Source | Useful signal for V3 |
| --- | --- |
| Marketplace module research | Loop Library should behave like a database of owned and reusable Loop Contracts, with search, filters, sort, detail, readiness, run actions, review packets, ledgers, and share-safe logs. |
| RelevanceAI marketplace research | Marketplace cards answer what can be installed; listing detail answers whether it is worth installing through creator, tools, integrations, description, example task, preview, and sample output. |
| Product direction | looloomi is a quiet local-first macOS workbench. The user wants to start crypto, markets, or office loops quickly, continue from results, identify the authoritative output, and keep safety boundaries visible without seeing runtime internals. |
| Design direction | LoopOps v2 makes Loop the main object and Chat the control layer. Library should hold My Loops, Run Ledgers, Shared / Imported logs, Drafts, clone, replay, and review decisions in an adaptive split layout. |

Design translation:

- Use database rows as the primary browsing surface, not large gallery cards.
- Use marketplace listing detail for inspection, install, clone, setup, run, and sample output.
- Use light separators, compact rows, inline properties, and stable columns.
- Use cards only for repeated listing objects or focused result previews; do not stack cards inside cards.
- Use user-language labels: Ready to run, Needs setup, Installed, Clone, Open, Run, Review, Ledger.
- Hide raw provider, tool, schema, artifact path, worker, and secret vocabulary from this module.

## Current UI Failure List

V3 exists because the current module is close in structure but still fails at product judgment:

1. Rows show many properties, but they do not reliably answer whether the loop can run now, whether it is only installable, or whether it needs setup.
2. Detail can contain marketplace-like information, but the decision model is weak: install value, clone value, required inputs, required knowledge, and result destination are not presented as one coherent checklist.
3. Readiness is too easy to treat as a status badge. The target needs a concrete missing-items list for integrations, knowledge, inputs, permissions, and review boundary.
4. Batch run selection can exist without enough pre-run feedback. Users need to see selected count, ready count, setup-needed count, clone-only count, and where each result will appear.
5. Installed and source templates can look too similar. Users must know whether they are viewing a shared source listing, an installed owned loop, a draft, or a replayable run record.
6. The UI rhythm still risks feeling like a set of demo panels. V3 should feel like a durable local work database with split detail and predictable row actions.
7. Run Ledger, Review Packet, and Share-safe Log can be discoverable but not sufficiently tied to "what happens after I run this?"
8. Some visible fields risk exposing implementation vocabulary. The target must keep skill/capability labels user-facing and move implementation detail out of the main surface.
9. Empty and blocked states need specific repair actions. "Cannot run" is not enough; the UI must say which item is missing and which setup path fixes it.
10. Visual emphasis can drift toward floating cards. The V3 target should use table density, grouped surfaces, and dividers instead.

## New Information Architecture

The module is a single Library surface with database views and split detail.

Top-level structure:

| Area | Purpose | Default behavior |
| --- | --- | --- |
| View rail | Switches between database views | My Loops, Marketplace, Needs Setup, Run Ledgers, Shared / Imported, Drafts |
| Toolbar | Search, filters, sort, view mode, selected actions | Persistent above the database, wraps on narrow widths |
| Database | Dense row list of loops, templates, ledgers, and drafts | Primary browsing and selection surface |
| Split detail | Listing detail for the selected row | Explains value, readiness, actions, example task, output destination |
| Footer strip | Selection and run summary | Appears only when one or more rows are selected |

Database views:

| View | Row objects | Primary question |
| --- | --- | --- |
| My Loops | Installed and owned Loop Contracts | What can I run or open now? |
| Marketplace | Source templates and shared listings | What can I install or clone? |
| Needs Setup | Owned or cloned loops with missing setup | What is blocked and how do I fix it? |
| Run Ledgers | Completed, blocked, and review-needed runs | What happened, and can I replay or review it? |
| Shared / Imported | Share-safe logs and imported loop packages | Can I inspect, clone, or compare this safely? |
| Drafts | Chat- or Studio-generated loop drafts | What can be saved, completed, or discarded? |

Core row columns:

| Column | Meaning | Example display |
| --- | --- | --- |
| Name | Loop or listing title with compact type label | `Market Report Loop` · Crypto |
| Source | Owned, Marketplace, Shared, Draft, Ledger | `Owned` |
| Action state | Run, Install, Clone, Open, Finish setup, Review | `Run` |
| Readiness | Concrete status with missing count | `Needs setup · 2 missing` |
| Required inputs | Short list of required user inputs | `symbols, timeframe` |
| Knowledge | Required or optional knowledge binding | `Research notes required` |
| Integrations | Human-readable connection needs | `Market data connected` |
| Output | Result destination after run | `Current Run + Ledger` |
| Updated | Last changed or last run | `Jun 24` |
| Review | Review decision state | `Needs follow-up` |

Filter model:

- Search placeholder: `Search loops and templates...`
- View filter: All, Owned, Marketplace, Shared, Draft, Ledger
- Domain filter: Crypto, Markets, Office, General
- Action filter: Can run, Can install, Can clone, Needs setup, Needs review
- Setup filter: Missing inputs, Missing knowledge, Missing integration, Permission required
- Sort: Recently updated, Most used, Newest, Review needed

## Core User Paths

1. Browse marketplace listing
   - User opens Library and selects Marketplace.
   - Rows show install/clone state, domain, required setup, and output destination.
   - User selects a row and reads the split detail without leaving the Library.
   - Detail shows what the loop does, what it needs, and whether the user can install, clone, or preview.

2. Install a ready template
   - User selects a Marketplace row with `Ready to install`.
   - CTA shows `Install`.
   - After install, row moves or duplicates into My Loops as an owned editable loop.
   - Detail CTA changes to `Open` and `Run` if required setup is complete.

3. Clone a template that needs edits
   - User selects a source listing marked `Clone recommended`.
   - Detail explains which parts are editable after clone.
   - CTA creates an owned draft or loop copy.
   - The owned copy shows missing items and a clear `Finish setup` action.

4. Finish setup
   - User opens Needs Setup.
   - Each row shows the missing item count and the first missing item inline.
   - Detail checklist groups missing items by Inputs, Knowledge, Integrations, and Review boundary.
   - Completing all required items changes the row to `Ready to run`.

5. Run a single owned loop
   - User selects My Loops and chooses a ready row.
   - Row-level action is `Run`; detail CTA is also `Run`.
   - Pre-run summary shows input values, review boundary, and result destination.
   - After launch, result opens in Current Run and is recorded in Run Ledgers.

6. Run selected loops
   - User multi-selects rows.
   - Footer strip summarizes selected, ready, setup-needed, and skipped rows.
   - User confirms `Run ready`.
   - Ready loops start as separate runs; setup-needed rows remain selected with repair actions.
   - The user can open Current Run for active output or Run Ledgers for completed output.

7. Review a run result
   - User opens Run Ledgers.
   - Row shows run status, final output availability, review state, and replay/clone action.
   - Detail shows authoritative final answer, review packet decision, share-safe log preview, and replay target.
   - User can mark Reviewed, Needs follow-up, or Blocked from the detail action area.

## High-Fidelity Target Draft

Overall layout:

- Left sidebar remains the global app navigation; Library is the active surface.
- Library header uses a compact title row: `Loop Library` on the left, primary action `New Loop` on the right.
- Under the header, a segmented view rail switches My Loops, Marketplace, Needs Setup, Run Ledgers, Shared / Imported, and Drafts.
- Toolbar sits below the view rail with search on the left and compact filters on the right.
- Main content is an adaptive split:
  - Regular and wide: database on the left, selected detail on the right.
  - Compact: database first; detail opens as an inline panel or sheet.
- No hero, no marketing block, no oversized template cards.

Database visual treatment:

- Row height target: compact enough for scanning, with two-line max in the name cell.
- Column dividers are subtle; row separators carry most of the structure.
- Type, domain, and source use small text labels rather than large chips.
- Status uses one icon plus one short label; color is secondary.
- Action cell is stable width so Run, Install, Clone, Open, and Finish setup do not shift the table.
- Selected row uses system selection treatment and keeps detail synchronized.
- Batch selection uses checkboxes only when selection mode is active.

Marketplace row anatomy:

```text
Name                         Source        Action       Readiness              Needs                 Output
Market Report Loop           Marketplace   Install      Ready to install       symbols, timeframe    Current Run + Ledger
DeFi Opportunity Scan        Marketplace   Clone        Needs setup · 1        wallet context        Current Run + Ledger
Meeting Summary Draft        Marketplace   Install      Missing integration    calendar access       Draft + Review
```

Owned loop row anatomy:

```text
Name                         Source        Action       Readiness              Review                Output
BTC Market Report            Owned         Run          Ready to run           Review optional       Current Run + Ledger
Weekly Markets Brief         Owned         Finish setup Missing knowledge      Needs follow-up       Draft + Ledger
Office Memo Builder          Draft         Open         Missing inputs         Not reviewed          Draft
```

Split detail anatomy:

- Header:
  - Title, type, domain, source, creator/source owner.
  - Main CTA state: Run, Install, Clone, Finish setup, Open, Review.
  - Secondary actions: Preview, Duplicate, Share-safe Log, Replay, depending on object type.
- Readiness checklist:
  - `Can run now` or `Cannot run yet`.
  - Missing inputs, knowledge, integrations, permissions, and review boundary.
  - Each missing item has a repair action or destination.
- What it does:
  - One-sentence summary.
  - Use cases in compact rows, not marketing copy.
  - Capability labels written in user language.
- Required setup:
  - Inputs: required fields and current values.
  - Knowledge: required library binding or optional enhancement.
  - Integrations: connected, missing, or unavailable.
  - Review boundary: what requires human confirmation.
- Example task:
  - One runnable example prompt or input set.
  - Button to use the example only when it can fill required inputs.
- Sample output:
  - Short preview of the expected final output shape.
  - Shows whether the result appears in Current Run, Draft, Review Packet, Run Ledger, or Share-safe Log.
- History:
  - Installed date, cloned-from source, last run, usage count, and review decision when available.

Detail CTAs:

| Object state | Primary CTA | Secondary CTA | Result after action |
| --- | --- | --- | --- |
| Marketplace listing, ready | Install | Preview | Owned loop appears in My Loops |
| Marketplace listing, editable | Clone | Preview | Owned editable copy appears in Drafts or My Loops |
| Owned loop, ready | Run | Open | Run appears in Current Run and Run Ledgers |
| Owned loop, missing setup | Finish setup | Open | Checklist opens focused on missing items |
| Draft loop | Open | Save as loop | Draft opens in editable detail |
| Completed run | Review | Replay | Review Packet or replay flow opens |
| Share-safe log | Clone | Compare | Owned copy or comparison detail opens |

Empty states:

- Marketplace empty: search/filter reset plus source explanation, no marketing copy.
- My Loops empty: show available starter listings and imported logs that can become owned loops.
- Needs Setup empty: show "No setup needed" with a link back to runnable loops.
- Run Ledgers empty: show "No runs yet" and a link to ready loops.
- Drafts empty: show "No drafts" and entry points from Chat or Studio.

Blocked states:

- Missing input: list the field name, expected format, and edit control.
- Missing knowledge: show required knowledge source and bind action.
- Missing integration: show connection name and setup action.
- Permission unavailable: show plan or local permission reason in user terms.
- Review required: show required confirmation and why the loop cannot continue without it.

## Interaction State Table

| State | Row label | Detail headline | Available actions | Missing items shown | Result destination |
| --- | --- | --- | --- | --- | --- |
| Ready marketplace listing | `Ready to install` | This template can be installed now | Install, Preview | None required | My Loops after install |
| Editable marketplace listing | `Clone recommended` | Clone to edit before running | Clone, Preview | Optional edits and required setup | Drafts or My Loops after clone |
| Installed ready loop | `Ready to run` | This loop can run now | Run, Open, Duplicate | None required | Current Run + Run Ledgers |
| Installed limited loop | `Limited` | This loop can run with reduced context | Run, Finish setup, Open | Optional knowledge or integration | Current Run + Run Ledgers |
| Setup-needed loop | `Needs setup` | This loop cannot run yet | Finish setup, Open | Required inputs, knowledge, integration, or permission | None until setup is complete |
| Draft loop | `Draft` | Finish and save this loop | Open, Save as loop, Discard | Missing contract fields and inputs | Drafts until saved |
| Active run | `Running` | Result is being generated | Open Current Run, Stop if available | Current progress and review boundary | Current Run, then Run Ledgers |
| Completed run | `Review` | Final output is ready for review | Review, Replay, Clone from run | Review packet state | Run Ledgers + Review Packet |
| Blocked run | `Blocked` | Run stopped before final output | Open, Fix setup, Replay after fix | Blocking reason and repair action | Run Ledgers |
| Share-safe log | `Shared` | Inspect safe output and clone if useful | Clone, Compare, Open log | Redaction and source limits | Shared / Imported, then My Loops if cloned |

Interaction rules:

- Clicking a row selects it and opens detail; it does not silently run anything.
- Primary actions are explicit buttons in the row and detail.
- Multi-select changes the footer into a run/install/clone summary, with counts by action state.
- Setup-needed rows never hide the CTA; they show `Finish setup` with the exact missing group.
- Installing never overwrites a source listing.
- Cloning always creates an owned editable copy.
- Running always creates a visible Current Run entry and a Run Ledger record.
- Reviewing changes the Review Packet state but does not alter the original final answer.

## Acceptance Criteria

- The document defines Loop Library / Marketplace as a dense database plus split listing detail, not a card gallery or scripted demo screen.
- Required headings are present exactly as section headings.
- Rows define whether each item can run, install, clone, open, or needs setup.
- Detail defines missing inputs, knowledge, integrations, permission, review boundary, example task, sample output, and result destination.
- Marketplace listings and owned loops are visually and semantically distinct.
- Installed, cloned, draft, completed run, blocked run, and shared log states are all represented.
- Run actions state that results appear in Current Run and Run Ledgers.
- Review actions state that decisions live in Review Packet without changing the final answer.
- Visual direction follows Notion-like density: compact rows, subtle separators, stable columns, restrained surfaces, and few cards.
- Product vocabulary hides runtime implementation names and uses user-facing labels.
- Empty and blocked states include concrete next actions.
- The file is a design target only and does not request production UI, web prototype, or native code changes in this step.

## Implementation Notes For Later

- Treat this file as the reviewable product target for V3 before any UI work.
- Future implementation should map existing loop, listing, ledger, draft, review packet, and share-safe log data into one database model.
- Readiness should be computed as grouped user-facing requirements: inputs, knowledge, integrations, permission, and review boundary.
- Row actions and detail actions should share one action-state model so labels do not drift.
- The output destination should be a first-class field, not hidden in a run callback.
- Source listing and owned loop identity should be immutable enough that install and clone cannot overwrite the source.
- The database should preserve selection when filters change if the selected row remains visible.
- Narrow layout should keep the same IA by moving detail into a sheet or inline drill-in, not by removing columns from the model.
- Future verification should look at the live product behavior and visual quality without adding automation-only vocabulary to the product surface.

## Use

Reference guidance for redesign and implementation.
