# Skill / Workflow / Loop First Real Slice

- Status: complete
- Architecture authority: `wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md`
- Started: 2026-07-10
- Scope: P0 first real vertical slice

## Goal

Connect the Web workbench to a same-origin Product API and prove this path without a
browser mock or historical runtime artifact:

```text
Load a real Skill -> Use a Template -> Add the Skill -> Save a revision
-> Compile the DAG -> Start a Run -> Receive node events -> Decide a Review Gate
-> Display the authoritative final result -> Rerun the saved revision
```

## Non-negotiable constraints

- Preserve all existing dirty work and deleted migration paths.
- Never delete, move, overwrite, or use repository `runtime/**` as test state.
- Browser code never reads the Agent daemon URL, bearer token, provider payloads, tool
  names, secrets, or artifact paths.
- Workflow order and readiness come from the server compiler. Canvas position and node
  array order are not execution authority.
- A completed Run requires the persisted Agent final read model. SSE summaries and Web
  state cannot manufacture the final answer.
- Production and default development paths have no fixture fallback.

## Frozen first-slice decisions

- Packages: `domains/backend/code/workbench-contracts` and
  `domains/backend/code/workbench-server`.
- Public prefix: `/api/workbench/v1`; default Product server port: `8798`.
- Product databases: `looloomi_workbench` and `looloomi_workbench_test`.
- Revision writes require `If-Match`; every mutation requires `Idempotency-Key`.
- Product events are persisted before delivery and carry a per-Run monotonic `sequence`.
- Version one executes ready DAG nodes sequentially with `maxParallelism: 1`.
- Builder proposals and Resource ingestion remain P1. The P0 Web must visibly block the
  assistant instead of running the old local proposal generator.

## Wave ledger

| Wave | Work package | Status | Exit evidence |
|---|---|---|---|
| 0 | Architecture rule, ledger, dirty baseline, Web baseline | complete | `smoke` and `action:smoke` passed on 2026-07-10 |
| 1A | Runtime paths, lifecycle safety, PI Skill loading | complete | unit and isolated runtime-integrity tests passed |
| 1B | Canonical v1 contracts and validation | complete | TypeBox build and 11 contract tests passed |
| 2A | Product Store and Mongo transaction boundary | complete | 11 unit tests and real replica-set integration passed |
| 2B | DAG compiler | complete | 34 compiler tests passed |
| 2C | Agent workflow bridge and conformance Skill | complete | real PI extension bridge test passed |
| 3A | Product API, browser session, CSRF, static Web | complete | 73 server unit/contract tests passed; default composition listens on 8798 |
| 3B | Runner, Review continuation, events, RunReadModel | complete | real Mongo + PI integration passed across review, restart, and rerun |
| 4A | Web API and state split | complete | TanStack server state, editor draft, Run stream, and UI state gates passed |
| 4B | Web interaction integration and real Run detail | complete | real Product API DOM closure, focus, EN/ZH, light/dark, review history passed |
| 5 | Fresh vertical proof, visual QA, architecture audit | complete | fresh proof, desktop/mobile capture, and read-only re-audit passed with no P0 blocker |

## Baseline evidence

- `npm run smoke --silent`: pass.
- `npm run action:smoke --silent`: pass, but validates browser-local mock behavior only.
- System Node is `v22.17.0`; repository `.tooling/node/bin/node` is `v22.22.3` and is the
  required runtime for implementation and verification.
- Docker daemon was not running at baseline. Mongo transaction tests remain gated until
  the Product Store wave starts Docker and verifies the replica set.
- Agent integration: blocked until Wave 1A fixes runtime ownership and PI Skill discovery.
- `domains/backend/code`: contains no Product API implementation at baseline.
- Existing repository status includes many user-owned modifications, deletions, and
  untracked migrated domain files. No cleanup is part of this goal.

## Wave 1 evidence

- `workbench-contracts` freezes 16 first-slice endpoints, strict mutation schemas,
  `ExecutionPlanV1`, Run events/read models, ETag and idempotency headers.
- Contract `npm test`: 11/11 passed using repository Node `v22.22.3`.
- Runtime path, PI adapter, Core Skill invocation, and Skill frontmatter work is present,
  with unit and isolated runtime-integrity smoke passing.
- Runtime integrity proof: 75,740 repository runtime files before and after, digest
  `b412cd8dc4f4b9f11ec40ff649c7b36d3525a8b1228b967e702785e996152cb6`.
- The proof exercises real PI Skill discovery and `/skill:long-task` command expansion via
  Core, without a live model call. A deterministic production-path conformance Skill is
  owned by Wave 2C for the full runner proof.

## Wave 2 evidence

- Mongo `rs0` is healthy. Product Store transaction integration passed against
  `looloomi_workbench_test`, covering immutable revisions, ETag, idempotency conflicts,
  atomic event sequence, ReviewDecision uniqueness, and durable RunReadModel storage.
- Compiler tests: 34/34 passed, including cycles, dangling ports, schema compatibility,
  blocked readiness, ReviewGate metadata, and stable plan hashes across canvas ordering.
- Agent bridge conformance passed through real `DefaultResourceLoader`, extension
  discovery, Agent Runtime Core, and the PI tool definition. No live model or direct test
  executor bypass was used.
- Full Agent Runtime `npm test` passed after registering the test-only conformance Skill;
  repository runtime digest remained unchanged.

## Wave 3 evidence

- Product API covers the frozen v1 routes with same-origin session + CSRF, Host allowlist,
  public error mapping, immutable templates, ETag and idempotency enforcement.
- SSE subscribes before replay, buffers the race window, deduplicates by monotonic
  `sequence`, and supports `after` / `Last-Event-ID` recovery.
- The default server composition owns Product Store, PI/Core adapter, execution resolver,
  Runner, API, and static Web delivery on port `8798`; Product routes were not added to
  the legacy daemon.
- `npm test --silent` in `workbench-server` passed 73 tests.
- The isolated Mongo + temporary-runtime Runner integration passed through real PI
  discovery and executor binding, approve/revise/reject, authoritative final read model,
  idempotency conflict, restart readback, and rerun.
- Integration testing found and fixed three production-path defects that unit fakes did
  not expose: a Mongo `ClientSession` leaking into `RunReadModel`, terminal Run status
  becoming visible before its final read model, and a Review decision being dropped while
  the preceding background job was still unwinding.

## Wave 4 evidence

- The production App now uses `useWorkbenchWorkspace`; retired fixture catalogs, the old
  workspace hook, client compile/run actions, legacy snapshot writer, and unused scoped
  chat component were physically deleted.
- TanStack Query owns Skill, Template, Workflow, revision, Run, and read-model server
  state. Editor draft, SSE reducer, and theme/locale/navigation state have separate
  boundaries. `localStorage` contains only UI preferences and the current unsaved draft.
- Template graphs are read-only. Skill `+`, drag/drop, selection, delete, move, connect,
  inspector edits, ETag revision save, compile, Run input, Review decision, final answer,
  review history, and rerun use Product API state.
- Browser retries retain the original `Idempotency-Key`. A `session_required` or
  `csrf_invalid` response reboots the same-origin session and retries the mutation with
  the same key.
- `build`, `smoke`, `action:smoke`, all state smoke scripts, `dom:smoke`, `focus:smoke`,
  `audit:capture`, and `review:no-permission` passed. The DOM gate executes a real
  Template -> Workflow -> edit -> save -> compile -> Run -> Review -> final-result path.
- The 390×844 capture found and fixed two responsive defects: desktop table actions were
  outside the mobile viewport, and the collapsed sidebar still reserved space for recent
  Workflows. Workflows/Skills now use compact mobile object rows and the nav is a labeled
  horizontal strip.

## Wave 5 evidence

- `proof:first-slice` resets only `looloomi_workbench_test`, uses a temporary runtime,
  starts a real Product server, and outputs one machine-readable proof object.
- Fresh proof IDs: Workflow `workflow-961c474e-4202-4838-9df2-cd9f44239a4e`, revision
  `revision-f7cd070c-5a0a-4af8-801e-790fb477a618`, Run
  `run-d4c38ab4-c2b0-48e0-9dd1-9e566fca9c28`, rerun
  `run-667fe91d-269d-4665-aa68-226b5e838b0e`.
- Both Runs ended at sequence `14`; the rerun final answer was exactly
  `fresh P0 HTTP first-slice proof`; restart readback passed.
- The complete `agent-final-read-model-v1` is persisted in the internal Run document,
  survives restart, and is stripped from public Product responses. The terminal Run
  event is emitted only after the product-safe final read model is durable.
- Acceptance record: `wiki/qa/2026-07-10-skill-workflow-loop-first-slice-acceptance.md`.
- Final read-only architecture re-audit found no P0 blocker. It verified internal Agent
  final persistence/public stripping, real compile idempotency, stable Web retry keys,
  session restart recovery, completed review history, same-origin separation, and the
  explicit test-only conformance boundary.

## Deferred after the P0 slice

- A non-test business Skill still needs a production executor binding before this is a
  business-capability release. The test-only conformance Skill proves the real execution
  path and is not presented as a production Skill.
- P1 remains responsible for durable recovery of unfinished jobs, atomic terminal-state
  reconciliation, applying Review revision feedback, Resources, BuilderProposal,
  checkpoint/retry/cancel, and complete replay.
- P2 remains responsible for business Skill import/activation, evidence lineage,
  artifact indexing, metrics, controlled parallelism, and revision rollback.
- P3 retains only the one-time dirty-draft compatibility reader and harmless duplicate
  SSE replay optimization; no legacy mock execution path remains.

## Stop rules

- Stop a wave when it requires files owned by another active worker.
- Stop before killing an unknown process or mutating a non-test database.
- Stop if PI Skill readiness is static, inferred, or bypasses the PI/Core invocation path.
- Stop if Product API logic is being added to the legacy daemon entrypoint.
- Stop if a final result would be parsed from an artifact path or assembled in the Web.
- A blocked wave is recorded here with its exact failing proof; it is never replaced with
  a mock success path.
