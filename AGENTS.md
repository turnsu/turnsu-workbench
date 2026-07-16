# Repository Development Rules

## Required architecture preflight

Before changing code in this repository:

1. Read `wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md`.
2. Read the nearest domain or package `AGENTS.md` that applies to the files you will edit.
3. Capture `git status --short` and treat existing changes as user-owned work.

The current product is the local-first Skill / Workflow / Loop Web workbench. New product
logic must follow this dependency direction:

```text
Web -> Workbench Product API -> Product Store / Workflow Runner
    -> Agent Runtime Core -> PI Kernel -> Skills and tools
```

The browser must not call the Agent daemon directly or receive its bearer token. Workflow
readiness and execution order are server-derived. Do not reconstruct final answers in the
Web client.

## Working in the migrated tree

- Do not restore the deleted root `Sources/` or root `agent-runtime/` trees.
- Do not reset, clean, move, delete, or overwrite existing `runtime/**` artifacts.
- Do not revert unrelated dirty files. Work with concurrent changes and stay inside the
  file ownership assigned for the current work package.
- Tests that need runtime or Mongo state must use an isolated temporary runtime and an
  explicitly named `_test` database.
- Historical artifacts and browser fixtures are not proof of a current backend-backed run.

## Current visual implementation boundary

The active Web work is a design-fidelity task, not a full-stack feature goal. Read `DESIGN.md` and
`wiki/design/skill-loop-cloud-workbench-v1/HANDOFF.md`, and preserve the implemented Product API,
Runner, Agent Runtime and PI boundaries while rebuilding the approved visual baseline screens.

Do not use the deleted V1 full-stack goal, phase ledger, 46-shot manifest or "awaiting visual
approval" records as current instructions or completion evidence.
