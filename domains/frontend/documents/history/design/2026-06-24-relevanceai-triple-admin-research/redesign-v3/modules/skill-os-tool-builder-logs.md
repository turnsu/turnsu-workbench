# Skill OS / Tool Builder / Tool Logs Redesign V3

Skill OS is the second library in LoopOps. Loop Library stores reusable loops and completed work records; Skill OS stores reusable work capabilities that a user can inspect, build, try, reuse, and review. It should feel like a product database for owned tools, not a list of implementation abilities.

The target surface covers four product objects:

- Tools database: the default browse, search, filter, and ownership surface.
- Tool detail: the durable home for one tool, with Build, Use, and Logs separated.
- Create Tool: a guided entry point for Describe task, Start from blank, and Import.
- Tool Logs: product evidence for what a tool did, who used it, what it cost, what came out, and whether it needs review.

## Reference Breakdown

| Source | Useful reference signal | Redesign V3 decision |
| --- | --- | --- |
| `modules/skill-os-tool-builder-logs.md` | Confirms the existing Skill OS direction: tools list, Create Tool sheet, Build/Use/Logs detail modes, Skill Stacks, and Review Chat handoff. Also shows that the current write-up mixes research, implementation targets, and verification evidence. | Keep the product direction, but rewrite the module as a target design brief that can be reviewed by a human before any UI work. |
| `03-tool-creation-logs.md` | RelevanceAI Tools behaves like a database: rows, filters, columns, sorting, ownership, integrations, agents, and last modified. Tool Builder uses Build, Use, Logs. Tool history focuses on status, cost, errors, and users. | Make Tools database the top-level surface. Use Build/Use/Logs as the fixed detail structure. Make logs readable as product history, not execution traces. |
| `PRODUCT.md` | looloomi is a local-first macOS workbench for crypto, markets, office work, review, and delivery. The user wants a working product surface, one authoritative result, and privacy-preserving boundaries. | Skill OS must support daily work without exposing internal implementation nouns. The tool story must help users start, review, and reuse work, not inspect plumbing. |
| `DESIGN.md` | LoopOps v2 uses Workbench, Library, Studio, Settings, and scoped Chat. RelevanceAI Tool creation/logs maps to Skill OS. UI should be native, quiet, adaptive, and light-first. | Skill OS becomes a library-like surface adjacent to Loop Library. Tool detail uses native split views, segmented tabs, table rows, sheets, and contextual Review Chat. |

## Current UI Failure List

- Skill OS still reads too much like a capability inventory. It needs a library model with owned objects, rows, metadata, details, and review paths.
- Build, Use, and Logs are present as concepts, but the hierarchy is not product-clear enough. A reviewer should immediately see where to edit, where to run, and where to inspect history.
- Tool detail is too close to a right-panel utility. It should be the durable page for one tool, not a crowded side area inside a broader Skill page.
- Create Tool does not yet carry enough information hierarchy. Import, Build, Use, Logs, and Open Review Chat need to appear as a staged workflow, not as disconnected buttons.
- Logs are at risk of reading like execution records. The target state should frame each log as evidence: purpose, input summary, result, issue, cost, duration, user, and next review action.
- Required input issues need to live next to the fixable field. A global warning alone does not give the user a repair path.
- Skill Stacks exist as a concept, but the UI does not make it clear which tools are reusable across loops and which active work they affect.
- Review Chat handoff exists as a capability, but it needs product placement: from tool detail and from a selected log row, with visible scope and context summary.
- Empty, blocked, and filtered states need calm product copy. They should not expose internal names, file-like fields, or diagnostic phrasing.

## New Information Architecture

Skill OS has one default object hierarchy:

1. Tools database
   - Default landing view for Skill OS.
   - Searchable table of tools.
   - Filters for type, status, integration, owner, and used by.
   - Row-level metadata: name, description, type, integrations, used by, owner, status, last changed.
   - Primary action: `Create Tool`.

2. Tool detail
   - Opens from a database row or after creating a draft.
   - Header shows tool name, description, status, owner, used by, last changed, and key actions.
   - Fixed tabs: `Build`, `Use`, `Logs`.
   - Context action: `Open Review Chat`.

3. Create Tool
   - A sheet launched from Tools database.
   - Starting points:
     - `Describe task`: user describes a repetitive manual task and gets a draft structure.
     - `Start from blank`: user manually defines fields.
     - `Import`: user brings in an existing definition or template and reviews a human-readable preview.
   - Completion creates a Tool Draft and opens Tool detail on `Build`.

4. Skill Stacks
   - A reusable collection shelf for grouping tools into a working stack.
   - Shows which tools are included, which loops can use them, and which tools need setup.
   - Does not compete with Tools database as the main landing view.

5. Review Chat
   - Contextual panel or sheet opened from Tool detail or a log row.
   - Scope is always visible: tool-level review or log-level review.
   - Carries a compact context summary: tool purpose, selected run or log, inputs, output or issue, user, cost, duration, and related loop.

## Core User Paths

1. Browse and choose a tool
   - User opens Skill OS.
   - Tools database shows saved tools with filters and sortable metadata.
   - User selects a row and lands in Tool detail.
   - Detail defaults to the most useful tab: `Build` for drafts, `Use` for ready tools, `Logs` when opened from a history surface.

2. Create a tool from a task description
   - User clicks `Create Tool`.
   - Sheet defaults to `Describe task`.
   - User enters the repetitive task, optional integration, required inputs, expected output, and review rule.
   - App creates a Tool Draft and opens Tool detail on `Build`.
   - Build tab shows the generated input list, steps, output, and review rule as editable product fields.

3. Import a tool and review it before use
   - User chooses `Import` in Create Tool.
   - Import preview translates the source into readable fields: name, description, type, integration, required inputs, outputs, owner, and status.
   - Warnings are written as setup requirements, not technical parsing notes.
   - User creates a draft, reviews it in `Build`, then moves to `Use`.

4. Build and validate
   - User edits inputs, steps, output, and review rule.
   - Missing required values appear next to the affected input.
   - Unsaved changes are visible in the header.
   - Saving keeps the user in Tool detail and writes a human-readable change entry for later review.

5. Use a tool
   - User switches to `Use`.
   - Required inputs appear as a compact form with validation beside each field.
   - User can bind the run to an active loop when relevant.
   - Running the tool creates a visible log row with a product status and a pending result state.

6. Inspect logs as evidence
   - User opens `Logs`.
   - Rows show what happened, who ran it, input summary, output or issue, cost, duration, related loop, and review action.
   - Filters support all tools or selected tool, status, user, related loop, time range, and text query.
   - User opens a row to see the evidence summary, then can open Review Chat.

7. Open Review Chat
   - From Tool detail: review the tool definition, readiness, and usage guidance.
   - From a log row: review a specific result or issue.
   - Chat opens with a visible scope label and a short context summary before the first assistant response.

## High-Fidelity Target Draft

Skill OS should use a native macOS split layout. The left app sidebar selects `Skill OS`. The main content is a Tools database table. Selecting a tool opens a detail view in the main pane or a secondary column depending on window width.

Tools database target:

- Header:
  - Title: `Skill OS`.
  - Secondary label: `Tools`.
  - Right actions: search field, filter button, columns button, `Create Tool`.
- Table columns:
  - `Tool name`: icon, name, one-line description.
  - `Type`: Action, Analysis, Import, Export, Automation.
  - `Integrations`: user-readable connection names.
  - `Used by`: loops, stacks, or agents using this tool.
  - `Owner`: person or local profile.
  - `Status`: Draft, Ready, Needs setup, Running, Blocked, Archived.
  - `Last changed`: relative date or short date.
- Row behavior:
  - Single click selects.
  - Double click opens full Tool detail.
  - Context menu includes Open, Duplicate, Add to Stack, Archive.

Create Tool target:

- Sheet title: `Create Tool`.
- Starting point segmented control:
  - `Describe task`.
  - `Start from blank`.
  - `Import`.
- Shared fields:
  - Tool name.
  - What it does.
  - Type.
  - Integration.
  - Input scope.
  - Required inputs.
  - Expected output.
  - Review rule.
  - Owner.
- `Describe task` body:
  - A short task description field.
  - Optional example input.
  - Draft preview showing proposed inputs, steps, output, and review rule.
- `Start from blank` body:
  - Empty editable fields for inputs, steps, outputs, and review rule.
- `Import` body:
  - Source selector for an existing definition, file, or template.
  - Human-readable preview of the imported name, inputs, steps, output, owner, and setup needs.
  - Import warnings appear as setup notes.
- Footer:
  - `Cancel`.
  - `Create Draft`.
  - After creation, the sheet closes and Tool detail opens on `Build`.

Tool detail target:

- Header:
  - Tool name and description.
  - Status pill.
  - Owner.
  - Used by.
  - Last changed.
  - Actions: `Use Tool`, `Add to Stack`, `Open Review Chat`.
- Tabs:
  - `Build`: edit the tool definition.
  - `Use`: fill inputs and run the tool.
  - `Logs`: inspect usage history and evidence.
- Right-side summary on regular and wide layouts:
  - Readiness.
  - Required setup.
  - Related loops.
  - Recent outcome.
  - Review rule.

Build tab target:

- Inputs section:
  - Required inputs with labels, descriptions, expected format, and sample value.
  - Missing required values shown inline.
- Steps section:
  - Ordered product-language steps.
  - Each step shows purpose, input used, and expected intermediate result.
- Output section:
  - Output name, format, destination, and review expectation.
- Review rule section:
  - What must be checked before the result is trusted.
- Footer state:
  - Unsaved changes.
  - Save draft.
  - Publish or mark ready when complete.

Use tab target:

- Run form:
  - Required input fields.
  - Optional input fields collapsed by default.
  - Active loop binding when applicable.
  - Run button disabled until required inputs are valid.
- Result preview:
  - Pending state while work is active.
  - Success state with output summary and link to log.
  - Blocked state with issue summary and next action.
- Review action:
  - `Open Review Chat` becomes prominent after a result or issue exists.

Logs tab target:

- Header:
  - Title: `Tool Logs`.
  - Filters: status, user, related loop, time range, text query.
  - Toggle: selected tool or all tools.
- Row anatomy:
  - Time and status.
  - Tool name when viewing all tools.
  - User.
  - Related loop or stack.
  - Input summary.
  - Output or issue summary.
  - Cost.
  - Duration.
  - Action: `Open Review Chat`.
- Detail drawer:
  - Evidence summary.
  - Input values summarized, with sensitive values hidden.
  - Output summary or issue summary.
  - Related loop context.
  - Review notes.
- Empty state:
  - `No tool history found`.
  - Secondary text changes based on filter state, for example: `Try a different status or user filter.`

Review Chat target:

- Opens as a scoped drawer or sheet.
- Header shows `Review Chat` and scope:
  - Tool review: tool name and readiness.
  - Log review: tool name, status, time, related loop.
- First visible context block:
  - Tool purpose.
  - Selected inputs summary.
  - Output or issue.
  - Cost and duration.
  - Review rule.
- Chat can answer, summarize, suggest fixes, or draft a follow-up. It does not become the source of record for the tool definition.

## Interaction State Table

| Surface | State | Trigger | Visible UI | Primary action |
| --- | --- | --- | --- | --- |
| Tools database | Empty library | No tools saved | Quiet empty state with `Create Tool` | Create first tool |
| Tools database | Populated | Skill OS opened | Search, filters, rows, selected detail | Select or create tool |
| Tools database | Filtered empty | Filters hide all rows | Empty filter message and clear filters action | Clear filters |
| Create Tool | Describe task | User opens sheet | Task description, shared fields, draft preview | Create Draft |
| Create Tool | Blank | User selects blank start | Empty editable fields | Create Draft |
| Create Tool | Import ready | User selects source | Readable import preview and setup notes | Create Draft |
| Tool detail | Draft selected | Draft row opened | Header status Draft, Build tab first | Complete Build |
| Build | Missing required input | Required field incomplete | Inline field issue near input | Fill missing value |
| Build | Unsaved edits | User changes definition | Header save state and footer action | Save draft |
| Use | Ready | Required inputs valid | Run button active | Run tool |
| Use | Invalid | Required input missing | Run button disabled and inline issue | Fix input |
| Use | Active work | User runs tool | Pending result card and new log row | Wait or open log |
| Use | Blocked result | Work cannot complete | Issue summary and review action | Open Review Chat |
| Logs | History available | Logs tab opened | Evidence rows with filters | Open row or Review Chat |
| Logs | Filtered empty | Filters hide all logs | `No tool history found` with filter guidance | Adjust filters |
| Review Chat | Tool scope | Opened from detail header | Context block for tool definition | Ask review question |
| Review Chat | Log scope | Opened from log row | Context block for selected evidence | Review result or issue |

## Acceptance Criteria

- The document presents Skill OS as the second library beside Loop Library, not as an internal capability list.
- Tools database is the default Skill OS surface and includes searchable, filterable rows with name, description, type, integrations, used by, owner, status, and last changed.
- Create Tool includes `Describe task`, `Start from blank`, and `Import`, with shared fields and a readable import preview.
- Create Tool creates a Tool Draft and opens Tool detail on `Build`.
- Tool detail has a clear header, product metadata, and fixed `Build`, `Use`, `Logs` tabs.
- Build separates inputs, steps, outputs, and review rule, with required input issues shown next to the affected field.
- Use separates required inputs, optional inputs, active loop binding, run action, result preview, and review action.
- Logs read as product evidence: status, user, related loop, input summary, output or issue, cost, duration, and `Open Review Chat`.
- Logs support selected tool or all tools, status, user, related loop, time range, and text query filters.
- `Open Review Chat` is available from Tool detail and from each log row, with visible tool-level or log-level scope.
- Review Chat receives a compact product context summary and does not replace Tool detail as the source of record.
- UI copy avoids internal implementation nouns, diagnostic field names, and file-like identifiers in normal product surfaces.
- Empty, invalid, active, blocked, and filtered states have user-readable copy and a clear next action.

## Implementation Notes For Later

- This file is a target design brief only. It does not request production UI changes, Web prototype changes, or Swift changes.
- Future implementation should keep the same product object boundaries: Tools database, Tool detail, Create Tool, Tool Logs, Skill Stacks, and scoped Review Chat.
- Keep Build, Use, and Logs as stable top-level tabs inside Tool detail. Do not hide them behind a generic settings panel.
- Treat imported definitions as drafts until a user reviews the readable fields and setup needs.
- Store detailed execution evidence behind product summaries. The default row should answer what happened and what the user should do next.
- Status labels should stay user-facing: Draft, Ready, Needs setup, Running, Succeeded, Blocked, Cancelled, Archived.
- Future visual review should use screenshots and human evaluation against this target draft before changing default navigation.
- Do not add validation-only labels, synthetic success copy, or new testing identifiers to satisfy this document.

## Use

Reference guidance for redesign and implementation.
