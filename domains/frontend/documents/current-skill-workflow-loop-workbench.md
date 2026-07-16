# Current Frontend Truth: Skill / Workflow / Loop Workbench

Date: 2026-07-09

This is the active frontend product truth for `domains/frontend/web/code/web-prototype`.

## Active Product

The web prototype is a Skill / Workflow / Loop workbench. It only needs to help the user:

- manage callable skills;
- manage owned workflows / loops;
- create workflows / loops from skills through templates, drag/drop canvas, and natural language patch receipts;
- run mock workflows and reuse run ledgers.

## Active IA

- `Skills`: skill registry and contract management.
- `Workflows`: owned workflow / loop management, run draft, run ledger, attached resources.
- `Templates`: preset templates plus Builder canvas for workflow creation and editing.

`Runs`, `Knowledge`, `Workbench`, `Skill OS`, `Loop Library`, and `Studio` are no longer top-level product surfaces. Their old web component files or folder names must not be reintroduced. Current web components should use `skills`, `workflows`, and `templates` naming.

## Active Builder Contract

Builder contains:

- Skill Library with template clone, resource search, Add, and drag/drop;
- Workflow Canvas with selected node summary;
- Collapsible Node Inspector drawer;
- Compact Run / Debug Panel;
- Builder assistant and BuilderPatch receipt banner.

Builder assistant never changes a workflow silently. It stages `BuilderPatch`; the user must apply it.

## Historical / Example-Only Inputs

Crypto, markets, meetings, office drafting, research reports, RelevanceAI/Triple research, LoopOps v2, Blocks Workbench, Command Desk, and SwiftUI App-first documents are historical references or sample data only. They do not define current scope.

## Verification

Current frontend changes must pass:

- `npm run build`
- `npm run smoke`
- `npm run action:smoke`
- `npm run dom:smoke`
- `npm run focus:smoke`
- `npm run review:no-permission`
- `npm run audit:capture`
