# looloomi Skill & Loop Cloud Workbench

Current implementation: a local same-origin Web workbench for backend-backed Skill,
Workflow/Loop, compile, Run, review, and rerun behavior. Target product: a cloud workspace
for creating, uploading, versioning, composing, publishing, and sharing Skills and Loops.

## Active Truth

- [PRODUCT.md](PRODUCT.md)
- [DESIGN.md](DESIGN.md)
- [wiki/PROJECT_WIKI.md](wiki/PROJECT_WIKI.md)
- [wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md](wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
- [wiki/prd/README.md](wiki/prd/README.md)
- [domains/frontend/documents/current-skill-workflow-loop-workbench.md](domains/frontend/documents/current-skill-workflow-loop-workbench.md)
- [domains/frontend/web/code/web-prototype/INTERACTION_QA.md](domains/frontend/web/code/web-prototype/INTERACTION_QA.md)

## Architecture Status

The P0 Web surface is connected to a same-origin Product API. Skills, immutable
Templates, Workflow revisions, server compilation, persisted Runs, SSE, Review Gates,
authoritative final results, and history/rerun are implemented. `localStorage` is limited
to UI preferences and the current unsaved Workflow draft.

The target full-stack path is:

```text
Web -> Product API/BFF -> Workflow Compiler/Runner
    -> Agent Runtime Core -> PI Kernel -> Skill adapters
```

See [Current System Architecture](wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
for the implemented capability matrix, remaining P1/P2 gaps, canonical contracts,
Product API, event model, and migration plan.

## Current P0 Scope

The active web prototype only serves:

- `Skills`: callable capability units with inputs, outputs, risk, dependencies, and usage.
- `Workflows`: owned workflow / loop objects that can be edited, saved as revisions, run, reviewed, and rerun.
- `Templates`: immutable preset workflows that create an owned workflow for editing.

Builder includes Skill Library, Workflow Canvas, Step Editor, and Run / Debug Panel.
Natural-language Builder proposals and Resources remain visibly blocked until P1.

## Target Product Scope

The target product uses three primary surfaces: `Skills`, `Loops`, and `Team library`.
It adds cloud Skill/Loop creation and upload, immutable publication, team install/fork/update,
minimal workspace roles, secret-safe connection binding, and a Loop contract that complements
the execution graph. Templates become published Loop starting points rather than a separate
top-level object.

See the [target PRD set](wiki/prd/README.md). Those requirements are a delivery target, not a
claim about the currently running P0 catalog.

## Not Current Scope

The following are historical examples or implementation background only:

- standalone crypto, market, stock, meeting, office, or research products;
- old monitoring dashboards, provider panels, ops consoles, and independent Knowledge / Runs products;
- old SwiftUI-first workbench directions;
- old LoopOps v2, Blocks Workbench, Command Desk, and RelevanceAI/Triple research packets.

Those documents are archived under [wiki/history/](wiki/history/) and [domains/frontend/documents/history/](domains/frontend/documents/history/).

## Web Prototype

Start the same-origin Product server (Mongo replica set and Web build are prepared by the
script), then open `http://127.0.0.1:8798/`:

```bash
./scripts/start-workbench-server.sh
```

Run Web-only static and state gates with:

```bash
cd domains/frontend/web/code/web-prototype
npm run build
npm run smoke
npm run action:smoke
```

Browser-side checks:

```bash
npm run review
npm run dom:smoke
npm run focus:smoke
npm run audit:capture
```

No-permission review:

```bash
npm run review:no-permission
```

## Cleanup Rule

If a document or implementation path no longer serves Skill creation/management, Loop
authoring/execution, or workspace-scoped sharing and reuse, it should be archived or downgraded
to example-only context instead of kept as an active requirement.
