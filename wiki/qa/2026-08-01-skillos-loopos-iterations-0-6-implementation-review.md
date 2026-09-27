# SkillOS / LoopOS Iterations 0–6 Implementation Review

- Evidence date: 2026-08-01
- Architecture authority: `wiki/architecture/2026-08-01-skillos-loopos-backend-architecture.md`
- Implementation plan: `wiki/architecture/2026-08-01-skillos-loopos-backend-implementation-plan.md`
- Scope: current dirty working tree; no commit or remote push is implied
- Code conclusion: **implemented and locally verified**
- Production release conclusion: **NO-GO**

## 1. Implemented

- Durable Product Command and per-Session FIFO Turn coordination. A Turn may fan out bounded Workers; observer disconnect does not cancel accepted work.
- Product-owned Admission and Capacity Leases enforced again at the Execution Broker. Capability Leases remain a separate permission boundary.
- Main, Module and Skill Creation sessions use product persistence, layered fences and personal ownership. Creation reload restores the same opaque Session and replays unapplied Patch intents without making the browser a truth source.
- Model routing pins catalog revisions and keeps provider wire formats and credentials behind Product adapters. Creation text and Realtime have separate fences and operation-specific readiness.
- Context Capsule condensation is a governed event; it does not delete raw transcript. Worker transcripts are separately encrypted in Object Store with TTL, authorization and audit.
- PI SDK 0.83.0, `pi-subagent` 0.4.8 and `pi-workflow` 0.10.1 use public, headless-only boundaries. Inline execution is rejected without fallback.
- V2 Loop Run lifecycle is derived from append-only `run_state_events`. External effects use durable intent/receipt records, immutable Connection approval fingerprints and query-backed reconciliation when the Driver explicitly supports it. Crash recovery uses a dedicated no-model path for the original `effectId`; it cannot regenerate Tool arguments or create a new write intent.
- Session history/read models use stable cursor contracts, query binding, stale-cursor rejection and Run as-of projection. Product Trace exposes product-safe lineage without Provider payloads or secrets.
- Attachment extraction, Script/Agent sandboxing, Team Library update drafts, governed materials and Connection state machines remain separated by their Product-owned records.

## 2. Verified evidence

| Gate | Command/evidence | Result |
|---|---|---|
| Contracts | `workbench-contracts: npm test` | 60 passed, 0 failed |
| Backend full | `workbench-server: npm test` outside the filesystem/network sandbox | 706 passed, 24 environment-gated skipped, 0 failed (730 total) |
| Iteration 6 A–D | `MONGODB_URI=mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true npm run test:vertical:iteration6` | 9 passed, 0 failed/skipped |
| Agent Runtime | `agent-runtime: npm test` | primary PI/AgwaB/container suite 17/17 plus all chained smokes; runtime integrity passed over 75,741 files |
| Runtime identity | `test/runtime-integrity-smoke.mjs` | manifest `b93000c85872939a502935af0ce8f2cdb655c5a7c08f3708684a588f844f0b25` |
| Frontend ownership/state | `owner:audit`, `state:smoke`, `skill-creation-copilot:smoke`, `m5:smoke` | passed |
| Frontend production build | `npm run build`, `bundle:audit` | passed; source `db5c8a…`, build `341a1c…` |
| Whitespace | `git diff --check` | passed at review time |

The A–D vertical suite uses the default Product server composition and an isolated `_test` database on the existing local Mongo replica set:

- Gate A: Turn-internal Worker fan-out, same-Session FIFO, cross-Session capacity, fourth-waiter rejection, detach/reconnect.
- Gate B: Skill Creation text → Patch → review receipt, late-result fencing, restart, ownership and active-only reload.
- Gate C: 10,000 messages → governed Capsule → new Worker rebuild; no recursive summary and no raw transcript deletion.
- Gate D: Loop Draft → `loop_creator` proposal → apply → V2 Run → review → external effect → SIGKILL → query reconciliation. The recovery invocation records `modelRequests=0`, and the fake provider ledger records exactly one write. This is explicit test evidence, not a real Provider claim.

Attachment negative tests cover corrupt/encrypted/duplicate/overlapping/truncated ZIP entries and exact size/count limits. A digest-pinned real Docker extraction gate passed separately, including network-off, read-only root, non-root UID, capability drop, `no-new-privileges`, resource limits and no host fallback.

## 3. Frontend build evidence

- Initial entry: 259,183 bytes raw / 79,692 gzip.
- Initial entry including base CSS: 274,792 raw / 83,618 gzip.
- Agent initial route: 690,488 raw / 190,648 gzip across its lazy dependency set.
- `fflate` remains deferred to ZIP import: 31,795 raw / 12,167 gzip.
- One chunk remains above 500 kB: Flowgram 657,159 raw / 193,308 gzip. It is deferred to Builder rather than loaded on Agent entry. This is a documented third-party boundary, not a claim that every chunk is below 500 kB.

## 4. Environment not verified

- Real external chat/image/Realtime Provider calls and billing behavior.
- Real production Connection credentials and production Secret Store/Keychain binding.
- Authenticated production Mongo topology, backup/restore and upgrade/rollback against this exact candidate.
- Complete dependency provenance, CVE/image scan and signed release artifact.
- Repeatable cold-start capacity/soak behavior under production load.
- Current-build human visual approval, including the no-permission DOM path that is still blocked by an unrelated review selector timeout.
- The existing local replica set advertises a stale `127.0.0.1:27017` member address, so the isolated gates used the verified `27018` endpoint with `directConnection=true`. Production topology and client discovery remain unverified.

Visual-only fixtures, loopback/fake providers and static source assertions do not close these gates.

## 5. Residual risks and release decision

- Existing bound Connections that predate `credentialBindingFingerprint` must be rebound and revalidated before use.
- The production Secret Store adapter must return the same credential fingerprint at bind and runtime resolution; local contracts cover the fence, but a production credential was not exercised.
- Query-backed Effect reconciliation is allowed only for one matching receipt, an unchanged approval fingerprint, an expired dispatch lease and a Driver that declares query reconciliation. It runs through `Runner → admitted ExecutionBroker → Prompt recovery branch → ProductToolGateway.recoverEffect → durable executor`, without loading the Skill or calling the model. Unknown, mismatched or unqueryable outcomes remain blocked for human handling.
- Flowgram remains a large deferred Builder vendor chunk and should be re-evaluated when its upstream package exposes a smaller stable entry.
- The working tree intentionally contains the implementation as uncommitted user-owned changes. This review does not assert a clean tree or a release manifest.

Therefore the implementation is suitable for continued local functional review, but it is not approved for production release.

## 6. Independent code review

The final independent review found one P1: the first receipt-recovery implementation could have re-entered the normal Prompt path and allowed a newly generated Tool call to produce a different `effectId`. The implementation was changed to the dedicated no-model recovery path described above. Regression evidence after the fix is: 114 targeted tests with 113 passed and one pre-existing Unix-socket skip, Gate D 1/1, the final A–D suite 9/9, and the final backend suite 706 passed / 24 environment-gated skipped / 0 failed. No P0 remains in the reviewed Admission, Creation reload, Trace, Session cursor, Run as-of or effect-recovery scopes.
