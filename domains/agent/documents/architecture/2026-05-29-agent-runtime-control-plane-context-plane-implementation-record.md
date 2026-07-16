# Agent Runtime Control Plane + Context Plane Implementation Record

Date: 2026-05-29

## 1. Result

Implemented the local MVP Control Plane and Context Plane inside `agent-runtime/` without changing the public Swift API or frontend exposure model.

The Agent Runtime Host now executes the internal sequence:

`task intent -> execution profile -> context plane -> planner -> tool intent plan -> policy/approval/model route/QA -> allowed tool execution -> metrics/checkpoint -> final output`

Frontend public surface remains Skill / Extension / Template only. Raw tools, provider routes, context chunks, and policy details are artifact/debug surfaces, not primary UI controls.

## 2. Files Added

Control Plane modules:

- `agent-runtime/control-plane/task-intent.mjs`
- `agent-runtime/control-plane/execution-profile.mjs`
- `agent-runtime/control-plane/context-plane.mjs`
- `agent-runtime/control-plane/planner.mjs`
- `agent-runtime/control-plane/tool-intent-plan.mjs`
- `agent-runtime/control-plane/policy-decision.mjs`
- `agent-runtime/control-plane/approval-decision.mjs`
- `agent-runtime/control-plane/model-route.mjs`
- `agent-runtime/control-plane/qa-gate.mjs`
- `agent-runtime/control-plane/runtime-metrics.mjs`
- `agent-runtime/control-plane/checkpoint.mjs`
- `agent-runtime/control-plane/schema-validator.mjs`
- `agent-runtime/control-plane/index.mjs`
- `agent-runtime/control-plane/smoke-test.mjs`

Internal Context Plane extension marker:

- `agent-runtime/extensions/context-plane/manifest.json`
- `agent-runtime/extensions/context-plane/extension.ts`
- `agent-runtime/extensions/context-plane/README.md`

Schema contracts:

- `agent-runtime/runtime/schemas/control-plane-manifest.schema.json`
- `agent-runtime/runtime/schemas/task-intent.schema.json`
- `agent-runtime/runtime/schemas/execution-profile.schema.json`
- `agent-runtime/runtime/schemas/tool-intent-plan.schema.json`
- `agent-runtime/runtime/schemas/context-manifest.schema.json`
- `agent-runtime/runtime/schemas/context-bundle.schema.json`
- `agent-runtime/runtime/schemas/context-gate.schema.json`
- `agent-runtime/runtime/schemas/retrieval-plan.schema.json`
- `agent-runtime/runtime/schemas/approval-decision.schema.json`
- `agent-runtime/runtime/schemas/qa-gate.schema.json`
- `agent-runtime/runtime/schemas/runtime-metrics.schema.json`

Wiki:

- `wiki/plan/2026-05-29-agent-runtime-control-plane-context-plane-implementation-plan.md`
- `wiki/architecture/2026-05-29-agent-runtime-control-plane-context-plane-implementation-record.md`
- `agent-runtime/wiki/AGENT_RUNTIME_WIKI.md` updated.

## 3. Daemon Integration

Updated `agent-runtime/bin/wechat-agent-daemon.mjs`:

- imports `buildControlPlane`;
- builds control/context artifacts before tool execution;
- passes `contextManifestRef` and `contextBundleRef` to internal tools;
- skips `blocked` and `needs_confirmation` tools instead of executing them;
- writes final `runtime-metrics.json` and `checkpoint.json` after tool execution and final output;
- keeps `GET /capabilities` backed by public Skill / Extension / Template surface.

One heuristic was tightened: generic Chinese "操作" no longer triggers `computer_use.request`; only explicit computer/desktop/click language does.

## 4. Artifact Evidence

Daemon smoke run:

- `runID=run-b2064190-4968-4d26-91dd-d46de1efff3a`
- `taskID=task-664c3d4c-d0c5-44a5-95b5-9d50d570b1c8`
- Artifact root: `runtime/agent/runs/run-b2064190-4968-4d26-91dd-d46de1efff3a/`

Required artifacts were generated:

- `control-plane-manifest.json`
- `task-intent.json`
- `execution-profile.json`
- `planner-envelope.json`
- `tool-intent-plan.json`
- `context-manifest.json`
- `context-bundle.json`
- `retrieval-plan.json`
- `context-gate.json`
- `policy-decisions.json`
- `approval-decisions.json`
- `model-route.json`
- `qa-gate.json`
- `runtime-metrics.json`
- `checkpoint.json`
- `retry-ledger.json`
- `tool-calls.json`
- `events.ndjson`
- `product-mutations.json`
- `final-output.md`

Observed checks:

- `control-plane-manifest.json`: `internalToolsExposed=false`, 16 declared artifacts.
- `context-gate.json`: status `pass`, `rawPrivateTranscriptIncluded=false`, `secretMaterialIncluded=false`.
- `policy-decisions.json`: no non-pass decision in the smoke prompt after Computer Use heuristic tightening.
- `checkpoint.json`: status `completed`, no remaining stages.
- `agent-runtime/runtime/public-surface.json`: `internalToolsExposed=false`, 7 skills, 3 extensions.

## 5. Verification

Commands run:

```bash
npm test
swift build --scratch-path /private/tmp/wechat-radar-build
swift test --scratch-path /private/tmp/wechat-radar-test-build
swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check
```

Results:

- `npm test`: pass.
- `node control-plane/smoke-test.mjs`: `control_plane_smoke=pass`.
- `node bin/wechat-agent-daemon.mjs --smoke-check`: `status=completed`.
- Sandboxed Swift build/test were blocked by user-level Clang module cache permissions; rerun with approved escalation.
- Escalated `swift build`: `Build complete! (3.04s)`.
- Escalated `swift test`: `Build complete! (0.37s)`.
- Escalated UI smoke: `ui_smoke=pass`, window title `WeChat Intelligence Radar`, workspace `Home`, window number `250655`.

Protected reference evidence:

- `git -C ../wechat-cli_raw status --short`: no changed files.
- `../assignment-agent-raw` is not a git repository; newer-file check against this implementation returned no files.
- `../wechat-cli_raw` newer-file check against this implementation returned no files.

## 6. Residual Risks

- Worker scheduling is sequential MVP. It records worker/checkpoint decisions but does not yet run parallel workers.
- Artifact schemas are contract files and lightweight required-key validation, not full production JSON Schema enforcement in the daemon path.
- Context Plane uses bounded local artifact summaries and selected refs. It does not yet implement a full retrieval index, semantic ranking, or cross-run compression.
- Runtime server socket verification was not required for this implementation record; sandboxed direct listen can be blocked. Daemon smoke validates the executable run path.

## 7. Next Step

Next implementation should move from MVP artifacts to stronger control-plane enforcement:

- schema validation before final output;
- model fallback and blocked-provider policy;
- resume from checkpoint;
- retrieval index and chunk scoring;
- Ops read-model for `runtime/ops/context-status.json` and control-plane health.

