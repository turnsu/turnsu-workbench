# LoopOps UI Design Reset From RelevanceAI Research

Date: 2026-06-29

Status: reference note only. For active frontend work, use [../2026-06-29-frontend-interaction-split/README.md](../2026-06-29-frontend-interaction-split/README.md).

This file records product-shape ideas extracted from RelevanceAI research.

## Reset Position

The previous LoopOps design package should be treated as historical reference. The next design pass should start from the logged-in product pattern observed in RelevanceAI:

- Durable workspace shell.
- Marketplace/library browse surfaces.
- Stable object detail pages.
- Explicit owned/public separation.
- Scoped chat as an object-adjacent control, not the whole product.
- Clear safety around clone, install, run and external actions.

README files should be quick-reading indexes only. They should not act as project requirements.

## New IA Target

### Left Workspace Nav

Use a compact app shell with grouped navigation:

| Group | LoopOps Surface | Notes |
| --- | --- | --- |
| Work | Workbench | Active queue, selected run result, run chat. |
| Work | Loop Library | Owned loops, source templates, run ledgers, share-safe logs. |
| Work | Skill OS | Skills, tools, extensions, stacks, logs. |
| Work | Knowledge | Sources, attach scope, activity. |
| Build | Studio | Loop Contract builder, execution path, builder chat. |
| Build | Tool Builder | Create/import skill/tool, define inputs, outputs, safety. |
| Account | Integrations | Credentials, API keys, external-action status. |
| Account | Settings | Workspace settings and safety defaults. |
| Support | Help / What's New | Product support, not run logs. |

Owned objects may appear nested under their parent group when the list is short, similar to RelevanceAI's owned agents under Agents. For larger workspaces, use a collapsible recent/favorite subset only.

## Loop Library Pattern

Loop Library should mirror the marketplace/listing split:

### Browse Surface

- Search first: `Search loops, templates, ledgers, logs...`.
- Segments:
  - My Loops.
  - Templates.
  - Run Ledger.
  - Share-safe Logs.
- Filters:
  - Domain.
  - Ready / needs setup.
  - Review required.
  - Uses external actions.
  - Installed/source/draft.
- Row/card summary:
  - Title.
  - Type: Loop Contract, Template, Ledger, Log.
  - Domain.
  - Skill count.
  - Last run.
  - Readiness.
  - Primary action: Run, Open, Clone or Fix setup.

### Detail Page

Use a Relevance-style object header:

- Icon/avatar.
- Title.
- Type and owner/source.
- One-sentence job description.
- Metadata row:
  - Domain.
  - Required skills.
  - Required inputs.
  - Last run.
  - Review boundary.
  - External-action status.
- Primary action:
  - `Run loop` only when ready.
  - `Fix setup` when missing inputs.
  - `Clone template` for source templates.
- Secondary:
  - Copy link.
  - Edit in Studio.
  - View ledger.

Body sections:

- Example run.
- Execution path.
- Required skills and integrations.
- Review packet shape.
- Recent runs.
- Similar loops.

## Skill OS Pattern

Skill OS should use the same marketplace/detail pattern but for capabilities.

### Browse Surface

- Search: `Search skills, tools, extensions, stacks...`.
- Segments:
  - Skills.
  - Tools.
  - Extensions.
  - Skill Stacks.
  - Tool Logs.
- Filters:
  - Installed / available.
  - Required credential.
  - External action risk.
  - Data source.
  - Used by loop.
- Summary metadata:
  - Type.
  - Provider/source.
  - Inputs/outputs.
  - Used by.
  - Last run or last validation.
  - Required setup.

### Detail Page

Use the listing detail structure:

- Icon.
- Title.
- Type: Skill, Tool, Extension, Stack.
- Created by/source.
- One-sentence capability description.
- Primary action:
  - Add to loop.
  - Add to stack.
  - Configure.
  - Open logs.
- Metadata:
  - Required credentials.
  - Inputs.
  - Outputs.
  - External actions.
  - Review requirements.
  - Used by loops.
- Body:
  - Example invocation.
  - Expected output.
  - Setup requirements.
  - Logs/evidence.
  - Similar skills.

## Studio Pattern

Studio is the Loop Contract editor. It should not look like a settings dump.

Recommended layout:

- Left rail: skill shelf and stacks.
- Center: Loop Contract object page.
- Right rail: Builder Chat and patch receipt.

Builder Chat behavior:

- User describes changes in natural language.
- Chat returns a visible patch receipt.
- Patch maps into visible fields before save:
  - goal.
  - trigger.
  - inputs.
  - execution path.
  - review rule.
  - exit condition.
  - output shape.
- Save remains explicit.

Execution path:

- Ordered list, not decorative chips.
- Skills/tools are draggable rows.
- Each row shows:
  - skill title.
  - input dependency.
  - output.
  - required/optional.
  - review/external-action marker.
  - disable/remove controls.

## Workbench Pattern

Workbench should learn from RelevanceAI's task and marketplace framing:

- Active queue acts like a task database.
- Selected run opens a result detail page.
- Result page header should answer:
  - What ran?
  - Current status.
  - Final answer.
  - Missing evidence or inputs.
  - Next action.
- Run Chat is scoped to the selected run.
- Review Packet is a structured section, not hidden in chat.
- Timeline and evidence gaps stay near the answer.

## Knowledge Pattern

Knowledge should borrow the RelevanceAI positioning: central context that agents reuse.

- Browse sources as database rows.
- Source detail page shows:
  - title.
  - type.
  - freshness.
  - attached loops/runs.
  - extraction state.
  - activity.
- Attach action should show target scope:
  - attach to run.
  - attach to loop.
  - attach to builder chat.
- Toast confirms one product action and offers one recovery action.

## Clone / Install / Run Safety

RelevanceAI makes clone action primary. LoopOps should be more explicit because local loops may touch external systems.

Before clone/install/run, show:

- What object will be added or executed.
- Required skills/integrations.
- Required credentials.
- Whether external write/send/trade/publish actions are disabled.
- What review boundary applies.
- What will happen next.

Use product language instead of generic blocking language:

- `Needs setup`.
- `Requires confirmation`.
- `Review before sending`.
- `External action disabled`.
- `Run preview only`.

## Visual Direction

Use RelevanceAI app shell as the closer reference, not the public marketing hero:

- Light surface.
- Compact sidebar.
- Quiet selected row.
- Small icons plus text.
- Object pages with strong title/header.
- Metadata in compact rows.
- Rich examples below the fold.
- Purple/blue accent can exist, but should not dominate LoopOps.
- Avoid massive media blocks unless the media is the object itself.

## Prototype Priorities

1. Build a fresh authenticated-style shell prototype.
2. Implement Loop Library browse and detail.
3. Implement Skill OS browse and detail.
4. Implement Studio with skill shelf, ordered path and builder chat patch receipt.
5. Implement Workbench with active queue, result detail and run chat.
6. Add Knowledge, Tool Logs, Help/What's New and toast polish.

The next prototype should be judged by whether a user can understand and operate the objects, not by whether old review artifacts still pass.
