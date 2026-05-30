# Agent Runtime Wiki

Updated: 2026-05-29

```text
Agent Runtime Wiki
├── 00 Current Runtime
│   ├── Agent Runtime Host
│   ├── Public Skill / Extension surface
│   └── Internal tool execution
├── 01 Extension Packages
│   ├── wechat-cli
│   └── cmc-skill-hub
├── 02 Ops Runtime
│   ├── health
│   ├── provider status
│   ├── dependency status
│   └── policy summary
├── 03 Safety
│   ├── live WeChat blocked
│   ├── live wechat-cli blocked
│   ├── trade/send/publish blocked
│   └── secret redaction
├── 04 Verification
│   ├── daemon smoke
│   ├── Swift build/test
│   └── protected raw directories
├── 05 Control Plane
│   ├── task intent
│   ├── execution profile
│   ├── planner / tool intent
│   ├── policy / approval / QA gate
│   └── metrics / checkpoint / retry ledger
├── 06 Context Plane
│   ├── context source
│   ├── context chunk
│   ├── context bundle
│   ├── retrieval plan
│   └── context gate
└── 07 Swift Adapter Contract
    ├── async run
    ├── SSE tail
    ├── run manifest
    ├── redacted tool calls
    └── lightweight frontend summary
```

## 00 Current Runtime

- Product-facing name: Agent Runtime Host.
- Implementation: local Node/TypeScript daemon using `@earendil-works/pi-coding-agent` as an internal runtime framework.
- Frontend boundary: Swift sends prompt, selected skill IDs, selected extension IDs, attachments, and context refs.
- Public surface file: `agent-runtime/runtime/public-surface.json`.
- Internal tool registry remains runtime-only and is not exposed as a user-selectable frontend menu.

## 01 Extension Packages

- `agent-runtime/extensions/wechat-cli/`
  - Migrates command contracts, export format understanding, and normalization semantics from `wechat-cli_raw`.
  - Reads fixture/user export files only through policy gates.
  - Live `init/history/search/sessions/new-messages` command contracts exist only as blocked actions.

- `agent-runtime/extensions/cmc-skill-hub/`
  - Provides CMC Skill Hub style market evidence as a module.
  - Providers: fixture, normalized file, optional MCP connector.
  - Public skills: CMC 市场雷达, 市场状态复核, 讨论与价格偏离.
  - MCP skills represented: `daily_market_overview`, `detect_market_regime`, `build_daily_market_brief`, `track_social_price_divergence`.

## 02 Ops Runtime

- Agent Runtime Host writes task events and run artifacts under `runtime/agent/`.
- Ops Runtime status is written under `runtime/ops/`:
  - `provider-status.json`
  - `dependency-status.json`
  - `health/agent-runtime-host.json`
  - `policy/latest-policy-summary.json`
- Ops is a read-model over Agent artifacts; it is not part of the task planner.

## 03 Safety

- Swift does not call MCP, RPC, model providers, live WeChat, or live wechat-cli.
- API keys are environment-only and must not be written to artifacts.
- Real WeChat reads, live wechat-cli, trading, send-message, and external publish are blocked.
- Computer Use remains a confirmation proposal, not a direct UI operation.

## 04 Verification

- Daemon smoke command: `node agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check`.
- Control Plane smoke command: `node agent-runtime/control-plane/smoke-test.mjs`.
- Latest verification on 2026-05-29:
  - `npm test`: pass.
  - `control_plane_smoke=pass`.
  - daemon smoke `status=completed`, `runID=run-b2064190-4968-4d26-91dd-d46de1efff3a`.
  - Swift build/test/UI smoke pass after approved rerun outside the sandboxed Swift module cache restriction.
  - Adapter fix verification: async smoke `async_smoke=pass`, `runID=run-545b75ea-5668-4b56-bb42-811520a97855`; Swift build/test/UI smoke pass.
- Expected smoke behavior:
  - public surface exposes skills/extensions only;
  - WeChatCLI extension normalizes fixture/export messages;
  - CMC extension writes a market snapshot through fixture provider;
  - Ops files are generated under `runtime/ops/`;
  - sensitive live actions remain blocked.

## 05 Control Plane

- Location: `agent-runtime/control-plane/`.
- Purpose: move low-level runtime decisions out of the daemon main function and into explicit contracts.
- Current modules:
  - `task-intent.mjs`
  - `execution-profile.mjs`
  - `planner.mjs`
  - `tool-intent-plan.mjs`
  - `policy-decision.mjs`
  - `approval-decision.mjs`
  - `model-route.mjs`
  - `qa-gate.mjs`
  - `runtime-metrics.mjs`
  - `checkpoint.mjs`
  - `schema-validator.mjs`
- Main run artifacts:
  - `control-plane-manifest.json`
  - `task-intent.json`
  - `execution-profile.json`
  - `tool-intent-plan.json`
  - `policy-decisions.json`
  - `approval-decisions.json`
  - `model-route.json`
  - `qa-gate.json`
  - `runtime-metrics.json`
  - `checkpoint.json`
  - `retry-ledger.json`
- First version runs sequentially and records worker/checkpoint decisions. It does not start production multi-worker sandboxes.

## 06 Context Plane

- Location: `agent-runtime/control-plane/context-plane.mjs`.
- Package marker: `agent-runtime/extensions/context-plane/`.
- Visibility: internal only; not present in `GET /capabilities`.
- Purpose: assemble task context before planning and tool execution.
- Outputs:
  - `context-manifest.json`
  - `context-bundle.json`
  - `retrieval-plan.json`
  - `context-gate.json`
- Inputs:
  - user prompt;
  - selected runtime refs;
  - attachments;
  - local artifact summaries such as normalized WeChat messages, market snapshot, crystals, proposals, memory, and handoffs.
- Privacy boundary:
  - no full raw private transcript in model context;
  - no secret material;
  - use bounded redacted preview plus artifact pointer;
  - frontend should show only lightweight context summary by default.

## 07 Swift Adapter Contract

- Sync API remains: `POST /sessions/{sessionID}/messages`.
- Async API: `POST /sessions/{sessionID}/messages/async`.
- Event stream: `GET /runs/{runID}/events` tails `events.ndjson` as SSE until a terminal event.
- Run index: `runtime/agent/runs/{runID}/run-manifest.json`.
- Swift should consume:
  - `run-manifest.json`;
  - `control-summary.json`;
  - `context-summary.json`;
  - redacted `tool-calls.json`;
  - SSE event fields such as `stage`, `actionIntent`, `riskLevel`, `artifactKind`, `contextSourceCount`, and `contextChunkCount`.
- Frontend rule:
  - show Skill/Extension names, current stage, context count, risk state, and final output;
  - do not expose raw tool/provider/module selection in the main workspace;
  - keep full control/context artifacts in the detail drawer or local artifact inspection.
