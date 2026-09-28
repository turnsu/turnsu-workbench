# Repository Development Rules

## Required architecture preflight

Before changing code in this repository:

1. Read `wiki/prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md` for target product authority.
2. Read `wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md` for implemented-system truth.
3. Read the nearest domain or package `AGENTS.md` that applies to the files you will edit.
4. Capture `git status --short` and treat existing changes as user-owned work.

The active product is **Turnsu 工作台** under Master PRD v0.6: local desktop work first,
then governed team collaboration. The existing Web workbench and Product API remain working
assets, not the desktop entry. New shared product logic must follow this dependency direction:

```text
Web / Desktop / Connector / Scheduler
  -> Workbench Product API
  -> CommandIntakeService
  -> PostgreSQL Product Store / AgentTurnRunner / WorkflowRunner
  -> AdmissionController
  -> ExecutionBroker
  -> WorkerTransport
```

Workers may call Model, Tool and Connection only through the Product Gateway. The browser must
not call the Agent daemon, Runner, Broker or Provider directly and must not receive their secrets.
Workflow readiness, execution order and final answers remain server-derived.

The desktop renderer talks only to its private local Host; native Agent execution, sessions and
drafts belong locally. Product/PostgreSQL owns team membership, shared Work Items, releases and
receipts. Do not copy private native history or credentials into team storage, infer authorization
from cached UI state, or replay Agent execution after an uncertain cloud response. See
`wiki/architecture/desktop-cloud-boundary.md`.

## Working in the migrated tree

- Do not restore the deleted root `Sources/` or root `agent-runtime/` trees.
- Do not reset, clean, move, delete, or overwrite existing `runtime/**` artifacts.
- Do not revert unrelated dirty files. Work with concurrent changes and stay inside the
  file ownership assigned for the current work package.
- Tests that need runtime or PostgreSQL state must use an isolated temporary runtime and an
  explicitly named `_test` database. Mongo is not a supported test or runtime dependency.
- Historical artifacts and browser fixtures are not proof of a current backend-backed run.

## Current implementation program

The Master PRD owns product scope; the 2026-09-28 workbench/Skill OS iteration plan owns the
current order. `wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md` owns implemented truth, verified
consumers and gaps. Preserve the implemented Product API, Runner, Agent Runtime and Pi boundaries.
Do not create a second Goal/Plan/State ledger for the same program.

For the current desktop iteration:

- Keep the main navigation focused on 工作台 and Skill OS; Loop management is a concise secondary
  Skill OS view. Keep advanced graph editing reachable when dependencies require it.
- Reuse the company `turnsu/frontend-scaffold` at a pinned revision by selecting components and
  design tokens. Preserve its license and upstream attribution. Do not import its demo routes,
  SSR server, fixture data or a second React application merely to share controls.
- The desktop shell uses Electron after the product-directed Tauri 2 replacement (2026-09-28).
  Keep React and the private Node Host; do not add another Tauri implementation or copy LinkCode.
  Use sandboxed, isolated renderers, a narrow preload bridge and OS-protected local credentials.
  Gateway selection is explicit per task; never rewrite native Agent global configuration, silently
  fall back to another provider, or share private keys through Product storage.
  Measure the full app/Agent process group on macOS and Windows before claiming a memory win.
- Company reuse is scoped to frontend-scaffold, brand assets and llm-gateway protocol integration.
  ShotSeek and doc-templates are excluded from this workbench iteration.
- A UI pass is complete only when the real local project → native Agent → result/file → reopen path
  remains usable. Changes to draft, permission, sharing or receipt behavior require proportional
  SQLite/filesystem and Product authorization checks. A green build is not native GUI acceptance.

M5 design files remain implementation evidence for current Web routes, not target-product
authority. Do not use old LoopOps/Swift harnesses, deleted goals, screenshot inventories,
visual-only fixtures, static source assertions or historical approval records as functional
completion evidence.
