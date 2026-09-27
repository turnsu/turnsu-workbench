# Backend Domain

Backend owns the cloud Product API, PostgreSQL authority, operational boundaries and runtime
integration that are not part of Agent reasoning itself.

## Documents

- [Current full-stack architecture](../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
- [Backend boundaries](documents/boundaries.md)
- [Code ownership map](code/README.md)
- [Single-machine production runbook](documents/operations/SINGLE_MACHINE_RUNBOOK.md)

## Backend Responsibilities

- Runtime bridge between clients and governed Workers.
- Product read/write models used by Web, Desktop, connectors and schedulers.
- PostgreSQL migrations, adapters, readiness, backup and restore.
- HTTP/JSON/SSE boundary, authentication, authorization and process lifecycle.
- Runtime, Connection and Artifact adapters where they serve Product state.
- Backend-safe normalization for frontend read models.

## Not Backend

- Prompt design.
- Tool plan reasoning.
- Skill authoring.
- Capability execution semantics.
- Frontend presentation.

## Current Main Sources

The active Product API and operational runtime are under
`domains/backend/code/workbench-server` and `domains/backend/operations/local`.
