# Agent Extension Package Surface and Ops Decoupling

Date: 2026-05-28

## Decision

The Agent workspace no longer treats low-level tools, providers, normalizers, or policy modules as frontend-selectable capabilities. The user-facing contract is now Skill / Extension:

```text
Swift Agent Workspace
  -> selectedSkillIDs / selectedExtensionIDs
  -> Agent Runtime Host
  -> extension package loader
  -> internal tools / providers / normalizers / policies
  -> runtime artifacts and product mutations
```

The local Node daemon is product-named **Agent Runtime Host**. Pi SDK remains an internal runtime framework and should not be exposed as a product concept.

## Extension Package Contract

Each capability module should live as an extension package:

```text
agent-runtime/extensions/{extensionID}/
  manifest.json
  extension.ts
  skills/
  tools/
  providers/
  normalizers/
  schemas/
  policies.json
  fixtures/
```

The current packages are:

- `wechat-cli`: migrates WeChatCLI command/export contracts and normalization. Live WeChat and live wechat-cli commands remain blocked.
- `cmc-skill-hub`: embeds CMC Skill Hub style market intelligence with fixture, normalized-file, and optional MCP provider backends.

## Public Surface

`agent-runtime/runtime/public-surface.json` is the frontend source of truth. It exposes:

- skills;
- extensions;
- task templates;
- `internalToolsExposed=false`.

Internal tools remain in daemon artifacts such as `tool-calls.json`, `planner-envelope.json`, and `policy-decisions.json` for audit only.

## WeChatCLI Migration Boundary

Migrated into the current project:

- command capability contract for sessions/history/search/export/new-messages;
- export JSON shape;
- session/message/search/member semantics;
- normalized message output.

Not migrated or executed:

- key scanner;
- database decrypt;
- db cache;
- live `wechat-cli init/history/search/sessions/new-messages`.

## CMC Skill Hub Boundary

CMC is now an extension package, not a global bridge. Provider backends are:

- fixture provider for deterministic local smoke;
- normalized file provider for external agent outputs;
- optional MCP provider when a connector is explicitly configured.

The module records CMC skills including `daily_market_overview`, `detect_market_regime`, `build_daily_market_brief`, and `track_social_price_divergence`, but it must mark missing live MCP configuration as degraded or blocked rather than invent live data.

## Ops Decoupling

Agent Runtime Host executes tasks and writes run artifacts. Ops Runtime is a separate read-model under `runtime/ops/`:

- `provider-status.json`
- `dependency-status.json`
- `health/agent-runtime-host.json`
- `policy/latest-policy-summary.json`

Swift Ops surfaces read these status artifacts. The Agent planner should not own long-term health aggregation.

## Verification Notes

- `node domains/agent/code/agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check` passes and triggers both extension packages.
- `swift build --scratch-path /private/tmp/wechat-radar-build` passes after using an unsandboxed Swift module cache.
- `swift test --scratch-path /private/tmp/wechat-radar-test-build` passes.
- `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check` passes with `ui_smoke_workspace=Agent Console`.
- Live WeChat, live wechat-cli, trade/send/publish remain blocked.
- `assignment-agent-raw` and `wechat-cli_raw` remain read-only references.
