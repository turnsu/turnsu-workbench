# Backend Code Ownership Map

## Current production boundary

```text
Web
  -> workbench-server Product API
      -> application services
      -> ProductPostgresStore / governed object store
      -> WorkflowRunner / AgentTurnRunner
      -> ExecutionBroker
      -> Agent Runtime public adapters
```

The production entrypoint is
`domains/backend/code/workbench-server/src/server.mjs`. Product contracts live in
`domains/backend/code/workbench-contracts/`.

Backend owns authentication, workspace authorization, idempotency, revisions,
model routing, Connections, attachments, Agent Sessions and proposals, execution,
Memory, Artifacts, Inbox read models, and operational readiness. The browser does
not call a Provider, Agent daemon, container, or credential store.

## Agent boundary

Reusable PI/Core code remains under
`domains/agent/code/agent-runtime/` and is consumed through Product-owned adapters.
The old port-8797 Agent daemon has been removed and must not return as a second control plane.

The retired Swift client and its services are compatibility-only. Building or
launching them requires the explicit `LOOLOOMI_ENABLE_LEGACY_NATIVE_CLIENT=1`
override; current M5 development targets the Web Workbench.

## Change discipline

- Keep Product API, store, Runner, and Broker ownership in the backend domain.
- Keep PI SDK mechanics inside the Agent domain's public adapter surface.
- Do not add browser-to-daemon, browser-to-Provider, or container-to-secret paths.
- Update contracts, migrations, runtime tests, and current architecture/QA evidence
  together when a boundary changes.
