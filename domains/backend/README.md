# Backend Domain

Backend owns product data services, storage, daemon/API boundaries, and runtime integration that are not part of agent reasoning itself.

## Documents

- [Current full-stack architecture](../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
- [Backend boundaries](documents/boundaries.md)
- [Code ownership map](code/README.md)
- [Single-machine production runbook](documents/operations/SINGLE_MACHINE_RUNBOOK.md)

## Backend Responsibilities

- Runtime bridge between UI and agent/runtime processes.
- Product read/write models used by App and future Web.
- Local JSON stores and persistence adapters.
- Daemon lifecycle, HTTP/SSE boundary, auth/path/process concerns.
- WeChat, market, runtime, and artifact data adapters where they serve product state.
- Backend-safe normalization for frontend read models.

## Not Backend

- Prompt design.
- Tool plan reasoning.
- Skill authoring.
- Capability execution semantics.
- Frontend presentation.

## Current Main Sources

Backend code is currently split across Swift `Services`, `runtime/`, selected `scripts/`, and selected Node daemon files inside `domains/agent/code/agent-runtime`.

The active Product API and single-machine operational runtime are under
`domains/backend/code/workbench-server` and `domains/backend/operations/local`.

## Migrated Docs

- Backend architecture notes: [documents/architecture/](documents/architecture/)
- Backend plans and handoffs: [documents/plan/](documents/plan/)
