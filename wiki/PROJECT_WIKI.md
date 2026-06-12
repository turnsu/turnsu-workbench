# WeChat Intelligence Radar Project Wiki

Updated: 2026-06-12

## Current Architecture

The active architecture is `Command Desk + Agent Runtime Core + Pi Kernel + Capability Packages`.

- Swift App: `Workbench / History / Settings`, with Command Desk as the default workbench.
- History: completed answers, drafts, follow-ups, and task-local compatibility details. WeChat, Token, and Watchlist are filters inside History, not top-level products.
- Settings: runtime readiness, privacy, providers, and diagnostics.
- Agent Runtime Core: capability catalog, route plan, GateEngine, final output writer, capability loop, memory/subagent contracts, provider dispatch, deterministic final copy.
- Daemon Shell: HTTP/SSE, Mongo lifecycle, local auth, filesystem paths, process boundary, and low-level provider transport.
- Pi Kernel: agentic extension/session/tool execution behind Core contracts.
- Capability Packages: CMC Skill Hub, Markets Research, Office/Meeting, WeChatCLI/context source.
- Final answer authority: `agent-final-read-model.json` / `AgentFinalReadModel.finalText`.

Current architecture sync: `wiki/architecture/2026-06-12-current-architecture-cleanup-sync.md`.

## Active Source Of Truth

- `PRODUCT.md`
- `DESIGN.md`
- `wiki/prd/2026-06-11-agent-workbench-product-redesign-prd.md`
- `wiki/design/2026-06-11-agent-workbench-prototype-spec.md`
- `wiki/architecture/2026-06-11-agent-workbench-interaction-redesign.md`
- `wiki/architecture/2026-06-11-command-desk-capability-gui-review-flow.md`
- `wiki/architecture/2026-06-12-current-architecture-cleanup-sync.md`
- `wiki/architecture/2026-06-12-agent-runtime-core-pi-kernel-redesign.md`
- `wiki/architecture/2026-06-12-markets-research-capability-package-integration.md`
- `wiki/state/2026-06-12-agent-runtime-core-pi-kernel-gate-cleanup-state.md`

Historical directions such as Research OS, Apple minimal, Today Desk, Queue Canvas, Split Focus, Unified Workstream, source-browser-first IA, and global Inspector are archived background only.

## Checkpoints

- 2026-06-11: Command Desk v2 became the default SwiftUI workbench. Top-level navigation is `工作台 / 历史 / 设置`; default shell no longer renders global `RuntimeRightInspectorView`.
- 2026-06-11: Adaptive layout fixed wide-window empty space with `WorkbenchLayoutMetrics` and compact / regular / wide breakpoints.
- 2026-06-12: Markets Research capability package integrated InvestSkill and cc-equity-research as methodology/dispatcher references without exposing their CLI or slash-command surfaces.
- 2026-06-12: Agent Runtime Core / Pi Kernel / Gate cleanup corrected wrapper-skeleton gaps. `selectedCapabilityIDs`, capability catalog routing, Pi lifecycle, final output authority, GateEngine tests, memory/subagent contracts, provider dispatch, and deterministic final copy are Core-owned.
- 2026-06-12: Architecture cleanup pass consolidates current wiki state, keeps legacy decision records in history, moves WeChat/Token/Watchlist into History filters, keeps Ops under Settings diagnostics, and keeps Agent Console as internal compatibility/debug.

## Product Rules

- Default product path must not show global Inspector, source browser, raw runtime artifacts, raw provider IDs, raw tool IDs, normalizer names, workers, secrets, or internal schema fields.
- User-visible capability selection remains capability/Skill/Extension level. Internal tools/providers are runtime implementation details.
- WeChatCLI is read-only source access. Do not run live WeChat commands unless the user explicitly authorizes that step.
- CMC live data must be labeled by source and freshness. Fixture, manual, normalized-file, or degraded values must never be labeled as live.
- Feishu live publish/reply, trading, WeChat sending, external posting, destructive actions, and real tmux/subagent control remain blocked or confirmation-gated.
- Future Agent architecture work must distinguish `Agent Runtime Core`, `Pi Kernel`, `Daemon Shell`, `Product Capability`, `Task Intent`, `Tool Module`, and `Provider Adapter`.
- Business uncertainty, parser gaps, freshness, low confidence, and weak output quality are metadata or feature bugs, not broad blocking gates.

## Active QA

- Latest cleanup verification on 2026-06-12:
  - `git diff --check`: pass.
  - `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
  - sandboxed `npm test`: Core/control-plane passed, local MongoDB blocked by expected `EPERM 127.0.0.1:27017`.
  - approved non-sandbox `npm test`: pass; business QA included `markets_equity_draft` run `run-b89ffae5-b37a-4619-a217-f4568d558900` and `cmc_degraded` run `run-e245fda4-1bf3-418f-951b-6f7304d16dbc`.
  - `swift build`: pass.
  - `swift test`: pass.
  - `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass with `ui_smoke_workspace=Workbench`, `ui_smoke_command_desk_visible=true`, `ui_smoke_markets_research_visible=true`, `ui_smoke_no_global_inspector=true`, `ui_smoke_single_final_answer_source=true`, and `ui_smoke_public_ability_names_clean=true`.
- Backend: `node --check agent-runtime/bin/wechat-agent-daemon.mjs`.
- Backend full: `npm test` in `agent-runtime`; local MongoDB may require approved non-sandbox execution.
- Swift: `swift build`.
- Swift tests: `swift test`.
- UI smoke: `swift run WeChatIntelligenceRadar --ui-smoke-check`.
- UI smoke must continue to report `ui_smoke_workspace=Workbench`, `ui_smoke_command_desk_visible=true`, `ui_smoke_markets_research_visible=true`, `ui_smoke_no_global_inspector=true`, `ui_smoke_single_final_answer_source=true`, and `ui_smoke_public_ability_names_clean=true`.

## Active Architecture / Problem / Plan Index

- Current architecture cleanup: `wiki/architecture/2026-06-12-current-architecture-cleanup-sync.md`.
- Agent Runtime Core / Pi Kernel redesign: `wiki/architecture/2026-06-12-agent-runtime-core-pi-kernel-redesign.md`.
- Agent daemon / Pi overlap review: `wiki/architecture/2026-06-12-agent-daemon-pi-overlap-architecture-problem-review.md`.
- Agent gate overdefense review: `wiki/problem/2026-06-12-agent-gate-overdefense-problem-review.md`.
- Core cleanup state: `wiki/state/2026-06-12-agent-runtime-core-pi-kernel-gate-cleanup-state.md`.
- Markets Research integration: `wiki/architecture/2026-06-12-markets-research-capability-package-integration.md`.
- Command Desk interaction redesign: `wiki/architecture/2026-06-11-agent-workbench-interaction-redesign.md`.
- Command Desk capability GUI / review flow: `wiki/architecture/2026-06-11-command-desk-capability-gui-review-flow.md`.
- Capability loop / memory / subagent harness: `wiki/architecture/2026-06-11-agent-capability-loop-memory-subagent-harness.md`.
- CMC display gate fixes:
  - `wiki/problem/2026-06-06-cmc-skill-hub-display-gate-overblocking.md`
  - `wiki/problem/2026-06-06-cmc-skill-hub-display-price-mutation-gate-fix-plan.md`

## History

- History archive index: `wiki/history/README.md`.
- Superseded frontend directions are kept under `wiki/history/architecture/` and `wiki/history/design/prototypes/`.
- Completed older plans and QA records are kept under `wiki/history/plan/`, `wiki/history/prd/`, and `wiki/history/qa/`.
- Main index should not reintroduce archived product directions as current implementation guidance.

## Next TODO

- Generate Swift fallback/public-surface data from `agent-runtime/runtime/capability-catalog.json` after the compatibility window.
- Extract low-level CMC provider transport into provider adapters only if it continues to grow; keep HTTP/SSE/Mongo/auth/path lifecycle in daemon shell.
- Before enabling live equity provider for Markets Research, add provider auth/redaction, normalized evidence pack, price snapshot, split gates, fixtures, and business QA.
- Design Hermes memory review, retention, purge, and rollback before enabling real memory writes.
- Design tmux/subagent namespace, permission prompt, logs, termination, and QA before enabling real session control.
- Improve Command Desk task rendering for CMC market content, Markets research drafts, Office document previews, and Feishu preview/confirmation while keeping the UI minimal.
- Replace local debug bundle workflow with signed Xcode packaging when moving beyond local MVP.
- Record GitHub sync branch and commit hash after this cleanup is pushed.

## GitHub Sync

- Branch: `codex/latest-intelligence-workbench-cleanup`.
- Remote: `origin` (`https://github.com/DESONGs/intelligence-agent-web3.git`).
- Cleanup commit: pending push record.
