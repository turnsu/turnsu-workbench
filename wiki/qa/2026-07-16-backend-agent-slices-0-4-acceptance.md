# Backend and Agent Slices 0–4 Acceptance

- Date: 2026-07-16
- Scope: worktree normalization plus backend/Agent Slice 0–4
- Result: code-level acceptance passed; environment-gated live services are not represented as passed
- Runtime: repository `.tooling/node` `v22.22.3`

## Verified Results

| Gate | Result | Evidence |
|---|---|---|
| Public contracts | passed | 32/32, including `ExecutionPlanV2`, Agent APIs and Product Memory |
| Backend full suite | passed | 283 tests: 276 passed, 7 environment-gated skips, 0 failed |
| Agent compatibility/unit suite | passed | Pi/AgwaB pins, loader, Builder, Runtime Core, policy and cancellation checks |
| Agent runtime integrity | passed | `runtime_integrity=pass`; repository runtime manifest unchanged |
| Remote adapter | passed | seven-method contract, loopback, reorder, duplicate, disconnect, checkpoint/resume, cancel/fence and unavailable state |
| Frontend freeze | passed | no path diff under `domains/frontend/**` from baseline commit `1ba9916`; baseline tree hash `d6aa607bab850e6f30a2c92c4823896806871937` |

## Slice Evidence

- Pi is pinned to `0.80.7`; AgwaB packages are pinned to `0.4.8` and `0.8.1`. Runtime startup
  rejects Node below `22.19.0`.
- Execution Broker distinguishes completed, failed, cancelled, blocked, partial, timeout,
  permission denied, sandbox unavailable and Remote unavailable. Cancellation revokes the lease
  before interrupting the backend and increments the fence.
- Two bounded Workers may run concurrently while one Session's Turns remain FIFO. Collaborators on
  the same Draft retain separate Session, transcript, PI Session, permission and temporary branch.
- Proposal merge rebases non-overlapping node/field/resource/setting/Skill-pin changes and persists
  same-path conflict without mutating the canonical Draft.
- AgwaB children are product invocations; parent cancellation cascades, completed children are
  reused after resume, and the pinned outer graph stays unchanged.
- Product Memory prevents direct durable writes by Agent/Worker, enforces personal/object/workspace
  scope, excludes unapproved inference, applies TTL, physically deletes content and retains only a
  content-free tombstone.
- Container tests cover digest pins, network/root/capability/UID/resource restrictions, secret-free
  payloads, Gateway lease/allowlist/budget validation and no host fallback.
- Remote event payloads and results remove device, transport, host, image and socket details before
  entering product records.

## Commands

All authoritative commands used the repository runtime, not the system Node:

```text
.tooling/node/bin/node .../npm-cli.js --prefix domains/backend/code/workbench-contracts test
.tooling/node/bin/node --test domains/backend/code/workbench-server/tests/...
PATH=<repo>/.tooling/node/bin:... .tooling/node/bin/node .../npm-cli.js test
```

The Agent runtime-integrity suite requires a temporary loopback listener. A sandboxed attempt was
rejected by the host with `listen EPERM`; the authoritative rerun used the same repository Node in
an allowed local-process environment and passed. This was an execution-environment restriction,
not an application fallback.

## Not Verified in This Environment

- Docker daemon was unavailable, so the real uploaded-Skill image and Agent image integration
  tests were skipped. Policy construction, negative isolation cases, cleanup ownership and
  `sandbox_unavailable` without host fallback passed with controlled backends.
- Mongo integration was not configured, so live Mongo restart/readback tests were skipped. Mongo
  repositories, migrations and in-memory behavioral contracts passed; test database guards require
  a name ending in `_test`.
- A live Provider call was not repeated. Compatibility and provider-unavailable behavior passed;
  runtime-integrity reported `live_model=false`.
- No real Remote device exists by design. Device registry, mTLS, relay/NAT and fleet behavior are
  outside this slice.

These items remain residual deployment evidence. They are not silently downgraded to success.
