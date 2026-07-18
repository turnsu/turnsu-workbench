# Product Model Routing and Unified Selection Implementation Plan

Date: 2026-07-18
Status: approved for automatic execution
Design source: `docs/superpowers/specs/2026-07-18-model-service-routing-design.md`

## 1. Delivery objective

Turn the current uncommitted text-profile prototype into the approved product-owned model routing
system without discarding user work. The delivered path must support immutable model revisions,
capability-filtered selection, per-Turn and per-Run pinning, a direct `model_call` execution mode,
Stability image generation, governed Artifact storage, the approved Web selection surfaces, and
fail-closed single-machine release evidence.

The existing production decision remains `NO-GO` until every external release gate passes. Offline
and fixture success may establish code acceptance, but cannot establish production readiness.

## 2. Preservation and execution rules

- Work only on `codex/backend-agent-slices-0-4`; do not push.
- Preserve all pre-existing dirty model-routing changes and reconcile them in place.
- Before implementation, save tracked/untracked inventories, a binary patch, and checksums under
  `/private/tmp/looloomi-model-routing-20260718-*`.
- Use repository Node `22.22.3` for every Node/npm command.
- Run Contracts before Backend because Backend consumes the Contracts build output.
- Use only isolated `_test` Mongo databases and temporary runtime/object-store roots.
- Do not write to repository `runtime/**` and do not expose Provider credentials to the browser,
  Agent containers, logs, events, plans, or Artifacts.
- Frontend changes are limited to the approved model-selection/Agent/Image surfaces and direct
  tests; no unrelated visual redesign.
- Commit verified phases separately. Do not stage unrelated files by pattern.

## 3. Baseline evidence

The pre-implementation dirty tree has been tested with the repository Node:

- Contracts: 33 pass, 0 fail.
- Backend: 334 pass, 13 skip, 0 fail.
- The same Backend suite produced two invalid failures under system Node `22.17.0`; rerunning with
  repository Node eliminated both. System-Node results are not acceptance evidence.
- Frontend has zero pre-existing diff.

## 4. Implementation sequence

### Phase 0 — Preserve and normalize the current work package

Files/outputs:

- `/private/tmp/looloomi-model-routing-20260718-status.txt`
- `/private/tmp/looloomi-model-routing-20260718-tracked.patch`
- `/private/tmp/looloomi-model-routing-20260718-untracked.txt`
- `/private/tmp/looloomi-model-routing-20260718-sha256.txt`

Tasks:

1. Capture branch, HEAD, status, existing diff, untracked inventory, and SHA-256 checksums.
2. Record the frontend baseline tree hash and current zero-diff assertion.
3. Confirm no pre-existing changes were lost after each implementation phase.

Acceptance:

- Backup files exist outside the repository.
- Existing dirty files remain present.
- No frontend change occurs before the frontend phase.

### Phase 1 — Canonical model, Artifact, Agent, Skill, and Execution contracts

Primary files:

- `domains/backend/code/workbench-contracts/src/common.ts`
- `domains/backend/code/workbench-contracts/src/models.ts`
- `domains/backend/code/workbench-contracts/src/model-http.ts`
- `domains/backend/code/workbench-contracts/src/agents.ts`
- `domains/backend/code/workbench-contracts/src/agent-http.ts`
- `domains/backend/code/workbench-contracts/src/execution.ts`
- `domains/backend/code/workbench-contracts/src/compiler.ts`
- `domains/backend/code/workbench-contracts/src/workflows.ts`
- `domains/backend/code/workbench-contracts/src/skills.ts`
- `domains/backend/code/workbench-contracts/src/artifacts.ts` (new)
- `domains/backend/code/workbench-contracts/src/artifact-http.ts` (new)
- `domains/backend/code/workbench-contracts/src/index.ts`
- Contract tests and examples.

Tasks:

1. Add strict IDs and enums for profile revision, capability, protocol, readiness, Artifact, Turn
   kind, and normalized model errors.
2. Define immutable `ModelProfileRevision`, safe profile summary, workspace routing policy,
   capability filters, and parameter support.
3. Define strict `ChatInput | ImageGenerationInput` and `ChatResult | ImageGenerationResult`
   unions plus internal model invocation/result metadata.
4. Change Turn creation to `{ kind, modelProfileRevisionId, input }`; retain the old Session model
   mutation only as last-used preference compatibility.
5. Add `model_call` to execution contracts and `model` plus required capability to Skill execution
   declarations.
6. Extend `ExecutionPlanV2` with pinned requested/actual route fields, capability, normalized
   parameter/result schema, limits, evidence, and compatible fallback revision list.
7. Replace one universal Workflow model setting with capability-specific Run Settings and a node
   profile override.
8. Define product-safe Artifact metadata and authorized content retrieval endpoints; exclude
   object-store paths and raw bytes from JSON.
9. Preserve read-only compatibility for old sessions, drafts, and V1/V2 plans using explicit
   `legacy_unpinned` projection rather than fabricated revisions.

Tests:

- Strict validation and unknown-field rejection.
- Capability/protocol incompatibility.
- Agent controller rejection of image-only profiles.
- Turn union discrimination and per-Turn revision requirement.
- `model_call` limits require zero tools/children.
- Artifact responses contain no storage path, Provider payload, or Base64.

Commit target:

- `feat(contracts): define revisioned product model routing`

### Phase 2 — Mongo catalog, routing policy, Artifact metadata, and config import

Primary files:

- `domains/backend/code/workbench-server/src/store/constants.mjs`
- `domains/backend/code/workbench-server/src/store/repositories.mjs`
- `domains/backend/code/workbench-server/src/store/product-mongo-store.mjs`
- `domains/backend/code/workbench-server/src/store/migrations/006-model-routing.mjs` (new)
- `domains/backend/code/workbench-server/src/store/migrations/index.mjs`
- `domains/backend/code/workbench-server/scripts/migrate-product-store.mjs`
- `domains/backend/code/workbench-server/src/models/model-catalog.mjs` (new)
- `domains/backend/code/workbench-server/src/models/model-catalog-importer.mjs` (new)
- Catalog/migration persistence tests.

Collections:

- `model_profiles`
- `model_profile_revisions`
- `model_routing_policies`
- `product_artifacts`

Tasks:

1. Implement `006-model-routing` and the exact unique/scope/current/config-hash/attempt indexes.
2. Add dedicated repositories for profile current-revision CAS, immutable revision insertion,
   versioned workspace policy updates, and Artifact state transitions.
3. Implement an idempotent startup/config importer. The migration creates schema/indexes; it must
   not be the only importer because completed migrations do not rerun after operator config changes.
4. For the same `profileId + configHash`, reuse the revision. For a new hash, allocate the next
   revision and atomically advance `currentRevisionId`.
5. Treat Mongo catalog/policy as runtime truth. Local configuration is an operator import input,
   never a second route authority.
6. Apply global/workspace scope authorization before returning or resolving profiles.
7. Derive current readiness without mutating immutable revision data.

Tests:

- Migration checksum, indexes, idempotence, lock behavior, and registration after `005`.
- Revision immutability, concurrent import convergence, config-hash reuse, and current CAS.
- Workspace isolation and global visibility.
- Policy default resolution and version updates.
- Restart/readback using an isolated `_test` Mongo database.

Commit target:

- `feat(models): persist immutable model catalog revisions`

### Phase 3 — Typed Model Service and Provider drivers

Primary files:

- `domains/backend/code/workbench-server/src/execution/model-service.mjs`
- `domains/backend/code/workbench-server/src/execution/openai-compatible-model-executor.mjs`
- `domains/backend/code/workbench-server/src/execution/anthropic-model-executor.mjs`
- `domains/backend/code/workbench-server/src/execution/gemini-model-executor.mjs`
- `domains/backend/code/workbench-server/src/execution/stability-image-model-executor.mjs` (new)
- `domains/backend/code/workbench-server/src/models/keychain-credential-resolver.mjs` (new or
  injected port backed by existing local Keychain code)
- Model Service and driver tests.

Tasks:

1. Make Model Service resolve only immutable revisions supplied by Product Controllers.
2. Validate authorization, readiness, capability, parameter schema, result schema, and budget
   before dispatch.
3. Create executors lazily. A missing optional credential makes that profile unavailable and does
   not crash unrelated routes.
4. Normalize protocol names and error codes. Preserve cancellation, timeout, authentication,
   rate-limit, content rejection, invalid request, invalid response, and oversized response as
   distinct product outcomes.
5. Keep interactive fallback empty. Allow a pinned Workflow fallback list only after compatibility
   validation.
6. Extend Chat drivers to declare actual supported capabilities and structured-output behavior.
7. Implement Stability multipart requests, bounded binary/JSON response reads, MIME/output-format
   allowlists, image signature and dimension validation, safe usage/safety metadata, and abort.
8. Emit safe requested/actual revision, capability, fallback, usage, latency, and failure events;
   never log prompts, authorization, raw Provider bodies, or image bytes.

Tests:

- Provider protocol fixture requests/responses for OpenAI-compatible, Anthropic, Gemini, Stability.
- Optional missing credential isolation.
- Interactive no-fallback and Workflow compatible fallback.
- Capability and structured-output rejection before Provider calls.
- Timeout/abort/error normalization and safe event payloads.
- Stability invalid MIME, corrupt image, oversized response, moderation, rate limit, and cancel.

### Phase 4 — Governed Artifact Service and `model_call`

Primary files:

- `domains/backend/code/workbench-server/src/artifacts/artifact-service.mjs` (new)
- `domains/backend/code/workbench-server/src/artifacts/index.mjs` (new)
- `domains/backend/code/workbench-server/src/storage/filesystem-object-store.mjs`
- `domains/backend/code/workbench-server/src/execution/model-call-backend.mjs` (new)
- `domains/backend/code/workbench-server/src/execution/execution-broker.mjs`
- `domains/backend/code/workbench-server/src/execution/index.mjs`
- `domains/backend/code/workbench-server/src/execution/remote-execution-backend.mjs`
- `domains/backend/code/workbench-server/src/execution/remote-worker-transport.mjs`
- `domains/backend/code/workbench-server/src/execution/loopback-remote-worker-transport.mjs`
- `domains/backend/code/workbench-server/src/server.mjs`
- Artifact, Broker, Remote, HTTP, and storage tests.

Tasks:

1. Reuse `FilesystemObjectStore` for workspace-isolated, content-addressed bytes; add governed
   Artifact metadata and authorization rather than exposing generic product objects.
2. Implement the state sequence: bounded validation -> quarantine -> fence/lease recheck ->
   pending metadata -> promote -> ready metadata. Only ready Artifacts are returned.
3. Add safe same-workspace metadata/content retrieval with MIME, length, and cache headers; reject
   cross-workspace reads without revealing existence.
4. Add cleanup/reconciliation for pending/orphaned Artifact state and support promoted Artifact
   deletion needed by retention/failed-attempt cleanup.
5. Implement `model_call` as a process backend that creates an invocation/attempt, calls Model
   Service, and creates no Pi Session, Tool, or child.
6. Enforce `maxChildren=0`, no Tool capabilities, bounded model requests/image count/output bytes,
   and Product-owned cancellation/fence settlement.
7. Add explicit Remote supported-mode advertisement. Unadvertised `model_call` is rejected; no
   implicit remote or host fallback.

Tests:

- Artifact hash, MIME, dimensions, auth, restart, pending reconciliation, and no Base64 persistence.
- Artifact failure or late fenced result cannot produce a successful attempt.
- `model_call` creates no Pi Session/Tool/children and reports `isolation: process`.
- Deterministic Skills still cannot request a model.
- Cancellation revokes lease, aborts Provider, and rejects late Artifact attachment.

Commit target for Phases 3–4 after combined verification:

- `feat(execution): add typed model calls and Stability artifacts`

### Phase 5 — Agent Turn pinning and Product Gateway convergence

Primary files:

- `domains/backend/code/workbench-server/src/agents/agent-persistence.mjs`
- `domains/backend/code/workbench-server/src/agents/mongo-agent-persistence.mjs`
- `domains/backend/code/workbench-server/src/agents/agent-turn-runner.mjs`
- `domains/backend/code/workbench-server/src/agents/product-agent-executor.mjs`
- `domains/backend/code/workbench-server/src/application/workbench-application.mjs`
- `domains/backend/code/workbench-server/src/execution/product-tool-gateway.mjs`
- Gateway socket/RPC server files.
- `domains/agent/code/agent-runtime/core/proposals/pi-builder-proposal-generator.mjs`
- `domains/agent/code/agent-runtime/core/run-loop/agent-runtime-core.mjs`
- `domains/backend/code/workbench-server/src/runtime/in-process-agent-adapter.mjs`
- Agent, Builder, Gateway, and runtime-integrity tests.

Tasks:

1. Resolve and persist the exact revision before a Turn is runnable; queued Turns never reread a
   mutable Session route.
2. Rename Session authority to `lastUsedModelProfileId`; compatibility writes update preference
   only and cannot modify current/queued Turn execution.
3. Support `agent_message` and direct `model_task` Turns under the same FIFO/event timeline.
4. Persist requested/actual revision and normalized result/error on the Turn.
5. Fix new Module Session initialization so the preference is written to Session, not Branch.
6. Remove automatic interactive fallback.
7. Ensure Main, Skill Creator, Loop Creator/Builder, bounded worker, and orchestrator child all use
   Product Model Gateway policy.
8. Remove or fail closed the direct private Pi Provider fallback in Builder generation. Tests may
   inject a Product Gateway adapter, not a separate Provider authority.
9. Bind host Provider abort controllers to invocation/attempt cancellation rather than trusting a
   non-serializable Worker `signal` field.

Tests:

- Change Session preference after enqueue; pinned Turn remains unchanged.
- Two concurrent Sessions/Turns use different revisions.
- Direct image Turn creates no Pi Session and returns Artifact refs.
- Interactive failure does not cross models.
- Builder/Main/Creator/bounded/orchestrator Gateway convergence and credential isolation.
- Cancel/timeout/fence/restart result consistency.

Commit target:

- `feat(agent): pin model revisions per turn`

### Phase 6 — Workflow inheritance, compilation, Runner, and history

Primary files:

- `domains/backend/code/workbench-server/src/compiler/compile-workflow-v1.mjs`
- `domains/backend/code/workbench-server/src/runner/workflow-runner.mjs`
- `domains/backend/code/workbench-server/src/application/workbench-application.mjs`
- Workflow/compile/Runner/execution-detail tests.

Tasks:

1. Normalize legacy draft Run Settings without fabricating immutable revision history.
2. Resolve node override -> Run Settings capability default -> workspace default during compile.
3. Map Skill `executionMode: model` to `model_call` and reject incompatible controller/image
   selections before a Run can be ready.
4. Persist exact revisions, schema, capability, limits, evidence, and explicitly enabled compatible
   fallback list in `ExecutionPlanV2`.
5. Mark unresolved/unavailable routes blocked with product-safe diagnostics.
6. Runner dispatches `model_call`, preserves lease/fence/retry ownership, and publishes safe
   invocation/actual-model/Artifact timeline data.
7. Read models expose requested and actual revision plus fallback status without Provider payloads.

Tests:

- Node/Run/workspace inheritance and immutable plan hash.
- Image Skill compiles to `model_call`; Stable Image rejected as controller.
- Fallback capability/schema/permission/budget mismatch rejection.
- Old V1/V2 plans remain readable.
- Runner retry/cancel/restart/fence behavior with model-backed nodes.

Commit target:

- `feat(workflow): compile capability-routed model revisions`

### Phase 7 — Product API and approved Web model-selection surfaces

Backend API files:

- `domains/backend/code/workbench-server/src/http/workbench-http-handler.mjs`
- `domains/backend/code/workbench-server/src/application/workbench-application.mjs`
- `domains/backend/code/workbench-server/src/server.mjs`
- Model, Agent history, Run invocation, and Artifact HTTP tests.

Frontend files:

- `domains/frontend/web/code/web-prototype/src/api/client.js`
- `domains/frontend/web/code/web-prototype/src/api/queryKeys.js`
- `domains/frontend/web/code/web-prototype/src/api/queries.js`
- `domains/frontend/web/code/web-prototype/src/state/models/*` (new)
- `domains/frontend/web/code/web-prototype/src/state/agents/*` (new)
- `domains/frontend/web/code/web-prototype/src/components/models/ModelPicker.jsx` (new)
- `domains/frontend/web/code/web-prototype/src/components/models/ChatComposer.jsx` (new)
- `domains/frontend/web/code/web-prototype/src/components/models/ImageComposer.jsx` (new)
- `domains/frontend/web/code/web-prototype/src/components/agents/MainAgentView.jsx` (new)
- Skill Creator, Create Loop, Builder, Run Settings, Preflight, Run Details integration files.
- Presentation adapters, routes/navigation, localization, styles, and smoke/component tests.

Tasks:

1. Add capability/context-filtered model catalog API, paged Agent Turn history, Run invocation
   history, and authorized Artifact metadata/content retrieval.
2. Query keys include every capability/context/selected-history filter to prevent cache mixing.
3. Build one `ModelPicker` with explicit `selectionKind: revision | profile`.
4. Use explicit typed `ChatComposer` and `ImageComposer`; do not render arbitrary Provider JSON.
5. Main Agent supports controller Chat and direct image task modes. Creator/Builder surfaces filter
   to their exact controller/structured-output capabilities.
6. Add the picker to Loop creation and Builder proposal submission; submit the selected revision
   with the task, never via session-wide mutation.
7. Add capability-specific Workflow node override and Run Settings defaults. Empty means inherit;
   do not persist `null`.
8. Show compiled resolved revisions and inheritance in preflight; show requested/actual/fallback in
   Turn and Run history.
9. Render ready image Artifacts through the authorized Product API. No filesystem path or data URL
   is persisted in app state.
10. Preserve the selected visual system and avoid expanding the existing all-purpose workspace
    hook with Agent-specific state.

Tests:

- API client bodies, query serialization, CSRF/idempotency, and cache keys.
- Picker capability filtering and disabled historical selection.
- Per-Turn switching, Chat/Image composer switching, keyboard/busy/error behavior.
- Dirty-draft normalization and node/Run Settings round-trip.
- Main/Creator/Loop/Builder model submission and history actual-model display.
- Build, state smoke, action smoke, DOM/accessibility checks, and approved-scope source audit.

Commit target:

- `feat(web): add unified model selection and image tasks`

### Phase 8 — Local operations, backup, readiness, and release evidence

Primary files:

- `.env.example`
- `domains/backend/operations/local/keychain.mjs`
- `domains/backend/operations/local/local-runtime.mjs`
- `domains/backend/operations/local/workbench-local.mjs`
- `domains/backend/operations/local/release-evidence.mjs`
- encrypted backup/restore and Mongo snapshot files.
- `domains/backend/code/workbench-server/src/operations/product-readiness.mjs`
- `domains/backend/code/workbench-server/package.json`
- `domains/backend/documents/operations/SINGLE_MACHINE_RUNBOOK.md`
- Release/operations/readiness tests.

Tasks:

1. Update local config to revisioned profile import plus capability defaults. Add Stability protocol
   and credential reference without placing secrets in config.
2. Resolve credentials lazily from Keychain. Optional missing credentials disable one profile;
   required defaults fail readiness.
3. Update latest migration and all migration/backup fixtures to `006-model-routing`.
4. Extend encrypted backup/restore to include an object-store snapshot consistent with Mongo
   Artifact metadata; verify Artifact hash and authorized retrieval after restore.
5. Add non-billable per-profile readiness and fail-closed required capability defaults.
6. Add explicit `smoke-chat` and billable-confirmed `smoke-stability` commands that run through the
   Product path using isolated `_test` data and temporary object storage.
7. Add source-bound `chat_provider_smoke`, `stability_provider_smoke`, and license evidence gates.
   Release manager must validate structured evidence, not a handwritten `passed` string.
8. Keep manifest creation, secret reads, backup, and activation behind all gates.

Tests:

- Local config migration/import, optional credentials, doctor/readiness behavior.
- Evidence schema, expiry/source/candidate binding, and fail-closed release manager.
- Mongo + object-store encrypted backup/restore and orphan detection.
- Live smoke commands refuse missing confirmation/credentials and never emit secrets.

Commit target:

- `feat(ops): gate revisioned model providers and artifacts`

### Phase 9 — Architecture, QA, and final verification

Documents:

- `wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md`
- `domains/backend/documents/operations/SINGLE_MACHINE_RUNBOOK.md`
- a dated model-routing code acceptance QA record
- a dated production readiness addendum
- `wiki/PROJECT_WIKI.md`

Tasks:

1. Correct premature “implemented” statements while work is incomplete; after code acceptance,
   document only paths proven by current evidence.
2. Record offline, Mongo, Docker, live Provider, backup, and release-gate results separately.
3. Re-run secret scan and prove frontend/Agent containers contain no Provider credentials.
4. Confirm no unplanned frontend files changed and no repository runtime artifacts were written.
5. Verify every prior production `NO-GO` item remains explicit unless new authoritative evidence
   actually closes it.

Final verification order:

1. Repository Node/version gate.
2. Contracts build/test.
3. Backend full offline suite.
4. Agent full unit/runtime-integrity suite.
5. Frontend build and state/action/DOM/accessibility tests.
6. `006` migration and model/Artifact Mongo integration in an isolated `_test` database.
7. Docker Agent/Skill/Gateway isolation tests.
8. Authenticated Mongo + Docker + fixture Provider production-readiness composition.
9. Real Chat smoke when a real credential is configured.
10. Real Stability smoke only with explicit billable confirmation and credential.
11. Dependency/license audit, exact-image CVE scans, repeatable cold capacity, encrypted full
    backup/restore, and upgrade/rollback rehearsal.
12. Release manager fail-closed check and final `git diff --check`/status review.

Commit target:

- `qa: record model routing acceptance and release status`

## 5. Parallel work boundaries

After contract names are frozen, independent work may proceed in parallel with disjoint ownership:

- Catalog/migration owner: store, repositories, migration, catalog importer, catalog tests.
- Provider/Artifact owner: Stability driver, Artifact service, object-store extension, direct tests.
- Frontend owner: Web API/state/components/smoke only after the public contract compiles.
- Operations owner: local config, readiness, backup/release evidence after catalog interfaces are
  stable.

The main thread retains shared public contracts, Execution Broker, AgentTurnRunner, compiler,
server composition, integration, commits, and final verification. Workers must not revert or
overwrite other dirty files.

## 6. Completion definition

Code acceptance requires every offline and required integration assertion above to pass and every
approved UI surface to consume the real Product API. Production readiness additionally requires
real Chat and Stability evidence plus all previously open supply-chain, CVE, cold-capacity, and
upgrade/rollback gates. If any external gate cannot run because a credential, network, scanner, or
candidate image is absent, the final result remains an explicit `NO-GO`; it is not converted to a
soft success.
