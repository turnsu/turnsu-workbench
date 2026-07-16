# Backend and Agent Slices 0–4 Delivery Plan

- Date: 2026-07-16
- Status: implemented; environment-gated integration evidence remains explicit below
- Scope: `domains/backend`, `domains/agent`, and current wiki records
- Frozen boundary: `domains/frontend` tree `d6aa607bab850e6f30a2c92c4823896806871937`

## Delivery State

| Slice | Delivered state |
|---|---|
| Worktree normalization | Complete on `codex/backend-agent-slices-0-4`; one worktree, domain source tree, history separated from current authority |
| 0 — Pi compatibility | Complete: Node minimum gate, exact Pi/AgwaB locks, public loader boundary, runtime compatibility tests |
| 1 — Execution Broker | Complete: public execution contracts, Mongo/in-memory persistence, modes, leases/fences, cancellation, checkpoints, no generic Worker HTTP route |
| 2 — Agent Sessions | Complete: personal Main/Module definitions, FIFO Turns, Turn-internal parallel Workers, personal branches, handoff capsules, three-way proposal merge |
| 3 — AgwaB | Complete: `pi-subagent` bounded backend, `pi-workflow` node-local orchestrator, product child timeline, resume and cancellation |
| 4A — Product Memory | Complete: governed candidate/promotion/query/delete service, scope policy, TTL and hash-only tombstones |
| 4B — Sandbox/Gateway | Complete: shared container policy, Agent image boundary, local Gateway, lease/budget/allowlist enforcement, no host fallback |
| 4C — Remote boundary | Complete: seven-method transport, loopback/fake conformance, reorder/dedupe, disconnect resume and cancellation |

## Fixed Control Chain

```text
Product API / AgentTurnRunner / WorkflowRunner
  -> Product-owned Execution Broker
  -> deterministic_skill | bounded_agent | agent_orchestrator
  -> process | container | remote adapter
```

The outer Loop graph and Run remain Product Runner authority. Dynamic Agent children exist only
inside one pinned node. Memory is a separate governed product service. A Worker cannot bypass
these owners through a public endpoint.

## Acceptance Gates

- contracts, backend, Agent unit and runtime-integrity suites pass on repository Node `22.22.3`;
- deterministic execution does not create a PI Session;
- collaborator Sessions and branches are isolated; proposal conflicts do not change the Draft;
- Memory candidate promotion and cross-scope access are policy controlled;
- container policy rejects unavailable Docker without process fallback;
- Remote loopback covers contract, unavailable, reorder, duplicate, disconnect, resume, cancel and
  transport-detail redaction;
- final frontend diff from normalization baseline remains empty.

## Deliberately Deferred

- real remote devices, registry, mTLS, relay/NAT, fleet operations and public Remote selection;
- embedding generation or vector retrieval;
- host-specific live Docker and Mongo integration when those services are unavailable;
- frontend changes of any kind.

See [the fresh QA record](../qa/2026-07-16-backend-agent-slices-0-4-acceptance.md) for verified and
environment-gated evidence.
