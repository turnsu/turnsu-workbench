# Skill / Workflow / Loop First-Slice Acceptance

- Date: 2026-07-10
- Architecture authority: `wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md`
- Execution ledger: `wiki/plan/SKILL_WORKFLOW_LOOP_FIRST_SLICE.md`
- Result: P0 first-slice accepted

## Accepted path

The accepted path starts from an empty `looloomi_workbench_test` database and an
isolated temporary runtime. It loads the test-only conformance Skill through the real PI
loader, Agent Runtime Core, and production Workflow executor boundary. It then uses the
same-origin Product API to:

1. use an immutable Template;
2. add a second Skill node and save an immutable revision with ETag protection;
3. compile graph edges into a deterministic execution plan;
4. start a Run and recover its SSE stream from a cursor;
5. approve a Review Gate;
6. persist the Agent final read model before emitting the terminal event;
7. render the product-safe final result and review history;
8. restart the Product server, read the same Run back, and rerun the same revision.

The conformance Skill may use deterministic input and output, but it is not a direct test
function. Invocation passes through Skill discovery, PI, Agent Runtime Core, and the
registered Workflow Skill executor.

## Fresh proof

`npm run proof:first-slice --silent` produced:

```json
{
  "skillId": "workflow-conformance",
  "templateId": "template-workflow-conformance",
  "workflowId": "workflow-961c474e-4202-4838-9df2-cd9f44239a4e",
  "revisionId": "revision-f7cd070c-5a0a-4af8-801e-790fb477a618",
  "compileId": "sha256:f61bc0992bb1ecf7d3525381c2aa0a3a936011c4c9d95637658b5c4533ed2bf1",
  "runId": "run-d4c38ab4-c2b0-48e0-9dd1-9e566fca9c28",
  "reviewId": "review-be790ac0-dad7-44ac-a7a9-1ab6843997cf",
  "rerunId": "run-667fe91d-269d-4665-aa68-226b5e838b0e",
  "rerunReviewId": "review-8eb5ccb9-00d6-4ead-8f34-191eb0666a02",
  "lastSequence": 14,
  "finalAnswer": "fresh P0 HTTP first-slice proof",
  "restartReadback": "pass"
}
```

The proof also asserted `databaseReset`, `runtimeIsolation`, `edgeTopology`,
`sseRecovery`, `authoritativeFinalReadModel`, and `sameRevisionRerun` as `pass`.
The complete Agent final model is persisted only in the internal Run document. Public
Run responses strip it and expose only the product-safe `RunReadModel`.

## Verification gates

| Gate | Result |
|---|---|
| Contracts | 11/11 passed |
| Workbench server unit/contract/compiler/runner | 73/73 passed |
| Product Store Mongo integration | passed |
| Workflow Runner Mongo + PI integration | passed |
| Agent Runtime full test and runtime integrity | passed |
| Web build | passed |
| Web smoke | passed |
| Web action/state smoke | passed |
| Web DOM real closure | passed |
| Web focus order | passed across Skills, Workflows, Templates |
| Web screenshot capture | 6/6 passed |
| Web no-permission review | passed |

The DOM closure verifies template use, Skill add, Skill drag, node delete, two immutable
revision saves, server compile, test run, review approval, verbatim final answer, Run
history, and 390px page overflow. It does not use the retired browser fixtures.

## Visual evidence boundary

The original prototype screenshots were removed after the selected design review rejected their
visual direction. The behavior evidence in this report remains historical P0 integration proof; it
is not current visual acceptance. Current visual work is governed by
`DESIGN.md` and `wiki/design/skill-loop-cloud-workbench-v1/HANDOFF.md`.

## Deferred work

These are not hidden P0 successes:

- The default non-test catalog intentionally remains blocked until a real business Skill
  receives a production executor binding. The conformance Skill proves the architecture;
  it is not a business capability release.
- P1: durable recovery for queued/running jobs after a process crash, applying Review
  `requestedChanges` to a new execution input, Resource ingestion, BuilderProposal,
  atomic terminal-state commit/reconciliation, retry/cancel/checkpoint orchestration,
  and complete event replay.
- P2: business Skill import/activation, evidence lineage, artifact index, cost/latency
  metrics, controlled parallelism, and revision rollback.
- P3: remove the one-time legacy dirty-draft reader after its compatibility window and
  optimize harmless duplicate SSE replay on browser reconnect.

No P0 interaction is replaced with a mock fallback. Unsupported Builder assistant and
Resource capabilities remain visibly blocked.
