# Web Interaction Development Brief

## Design Read

Build this as a dense B2B product workspace, not a landing page. The reference is closer to RelevanceAI's logged-in app shell plus marketplace detail pages than to the public marketing site.

## Web Shell

Use a left workspace sidebar with grouped navigation:

- Work: Workbench, Loop Library, Skill OS, Knowledge.
- Build: Studio, Tool Builder.
- Account: Integrations, Settings.
- Support: Help, What's New.

Interaction details:

- Sidebar groups collapse independently.
- Current page has a persistent selected state.
- Search opens a command/search overlay scoped to the current workspace.
- Recent loops or agents may nest under a parent item when the list is short.
- Main content uses a header, toolbar, scrollable body, and optional right inspector.

## Loop Library

Purpose: browse, run, clone, and inspect loops.

Screens:

- Browse: My Loops, Templates, Run Ledger, Share-safe Logs.
- Detail: selected loop or template.
- Multi-select: batch run or batch organize.

Interactions:

- Row primary click opens the detail page.
- A visible Run button starts a background run for ready loops.
- Template rows use Clone, not Run.
- Filters should be chips or segmented controls: domain, readiness, source, review required, external action.
- Multi-select exposes batch action bar.
- Detail page has a strong object header: icon, title, type, owner/source, description, metadata, primary action.

States:

- Ready.
- Needs setup.
- Running.
- Has recent result.
- Missing input.
- External action disabled.

## Skill OS

Purpose: browse, configure, and compose skills, tools, extensions, and stacks.

Screens:

- Browse: Skills, Tools, Extensions, Skill Stacks, Tool Logs.
- Detail: capability detail page.
- Stack editor: ordered skill/tool combination.

Interactions:

- Search and filters stay visible at the top.
- Add to loop opens a target picker.
- Add to stack opens or creates a stack.
- Configure opens an inline drawer or detail subpage.
- Tool logs open from each capability detail page.
- Drag from Skill OS into Studio execution path should be supported in the web prototype.

States:

- Installed.
- Available.
- Needs credential.
- Used by loops.
- Recently failed.
- Validated.

## Studio

Purpose: edit a Loop Contract without hiding structure behind chat.

Layout:

- Left shelf: skills, tools, extensions, stacks.
- Center page: loop contract fields and ordered execution path.
- Right panel: Builder Chat and change receipt.

Interactions:

- Drag skills/tools from shelf into execution path.
- Reorder path rows.
- Disable or remove a path row.
- Builder Chat proposes edits as a visible receipt before applying.
- Applying a receipt updates visible fields.
- Save is explicit.

Visible fields:

- Goal.
- Trigger.
- Inputs.
- Execution path.
- Review rule.
- Exit condition.
- Output shape.

## Workbench And Run Result

Purpose: run loops and inspect outcomes.

Screens:

- Active queue.
- Run result detail.
- Run chat.
- Review packet.

Interactions:

- Queue rows show status, loop name, domain, skill path summary, started time, and final/review status.
- Selecting a queue row opens result detail.
- Result detail keeps Final Answer, Timeline, Evidence Gaps, Review Packet, and Run Chat in one workspace.
- Run Chat is scoped to the selected run.
- Starting multiple loops should create independent queue rows.

States:

- Queued.
- Running.
- Needs input.
- Waiting for review.
- Completed.
- Failed.
- Canceled.

## Knowledge

Purpose: manage reusable context and attach it to loops, runs, or builder chat.

Interactions:

- Source browse uses database rows.
- Source detail shows freshness, extraction state, attached objects, and activity.
- Attach action requires a visible target: run, loop, or builder chat.
- Toast confirms one action and offers one recovery action.

## Chat Quick GUI

Use chat as a scoped assistant, not the whole interface.

Patterns:

- Compact prompt composer.
- Quick action chips for common operations.
- Attachment chips for loop, run, skill, or knowledge context.
- Chat messages can include structured action proposals.
- Applying proposals updates visible UI fields or opens a focused drawer.

Avoid:

- Chat-only hidden state.
- Generic assistant text that does not map to UI changes.
- Large modal conversations that block the workspace.
