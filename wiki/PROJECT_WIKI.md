# WeChat Intelligence Radar Project Wiki

Updated: 2026-06-18

## Current Architecture

The active architecture is `Blocks Workbench + Agent Runtime Core + Pi Kernel + Capability Packages`.

- Swift App: `Workbench / History / Settings`, with Blocks Workbench as the default workbench.
- Workbench interaction model: `Domain Blocks -> Loop Templates -> Run / Review / Follow-up`.
- Domain Blocks: `Crypto`, `Markets`, `Office`; internal provider/tool surfaces remain hidden.
- History: completed answers, drafts, follow-ups, and task-local compatibility details. WeChat, Token, and Watchlist are filters inside History, not top-level products.
- Settings: runtime readiness, privacy, providers, and diagnostics.
- Agent Runtime Core: capability catalog, route plan, GateEngine, final output writer, capability loop, memory/subagent contracts, provider dispatch, deterministic final copy.
- Daemon Shell: HTTP/SSE, Mongo lifecycle, local auth, filesystem paths, process boundary, and low-level provider transport.
- Pi Kernel: agentic extension/session/tool execution behind Core contracts.
- Capability Packages: CMC Skill Hub, Markets Research, Office/Meeting, WeChatCLI/context source.
- Office/Meeting ASR: non-realtime cloud transcription through Alibaba Bailian / DashScope and OSS temporary upload; no local ASR fixed thread is active.
- Final answer authority: `agent-final-read-model.json` / `AgentFinalReadModel.finalText`.

Current frontend product sync: `wiki/prd/2026-06-18-vertical-blocks-loop-workbench-prd.md` and `wiki/architecture/2026-06-18-vertical-blocks-loop-workbench-interaction.md`.
Runtime architecture sync: `wiki/architecture/2026-06-12-current-architecture-cleanup-sync.md`.

## Active Source Of Truth

- `PRODUCT.md`
- `DESIGN.md`
- `wiki/prd/2026-06-18-vertical-blocks-loop-workbench-prd.md`
- `wiki/design/2026-06-18-vertical-blocks-loop-workbench-prototype-spec.md`
- `wiki/architecture/2026-06-18-vertical-blocks-loop-workbench-interaction.md`
- `wiki/architecture/2026-06-12-current-architecture-cleanup-sync.md`
- `wiki/architecture/2026-06-12-agent-runtime-core-pi-kernel-redesign.md`
- `wiki/architecture/2026-06-12-markets-research-capability-package-integration.md`
- `wiki/plan/2026-06-12-agent-cmc-rendering-and-model-routing-simplification-plan.md`
- `wiki/plan/2026-06-12-meeting-agent-cloud-asr-bailian-plan.md`
- `wiki/plan/2026-06-13-cloud-asr-oss-configuration-handoff.md`
- `wiki/state/2026-06-12-agent-runtime-core-pi-kernel-gate-cleanup-state.md`

Historical directions such as Research OS, Apple minimal, Today Desk, Queue Canvas, Split Focus, Unified Workstream, Command Desk v2, source-browser-first IA, and global Inspector are archived background only.

## Checkpoints

- 2026-06-11: Command Desk v2 became the default SwiftUI workbench. Top-level navigation is `工作台 / 历史 / 设置`; default shell no longer renders global `RuntimeRightInspectorView`.
- 2026-06-11: Adaptive layout fixed wide-window empty space with `WorkbenchLayoutMetrics` and compact / regular / wide breakpoints.
- 2026-06-12: Markets Research capability package integrated InvestSkill and cc-equity-research as methodology/dispatcher references without exposing their CLI or slash-command surfaces.
- 2026-06-12: Agent Runtime Core / Pi Kernel / Gate cleanup corrected wrapper-skeleton gaps. `selectedCapabilityIDs`, capability catalog routing, Pi lifecycle, final output authority, GateEngine tests, memory/subagent contracts, provider dispatch, and deterministic final copy are Core-owned.
- 2026-06-12: Architecture cleanup pass consolidates current wiki state, keeps legacy decision records in history, moves WeChat/Token/Watchlist into History filters, keeps Ops under Settings diagnostics, and keeps Agent Console as internal compatibility/debug.
- 2026-06-12: Implemented CMC rendering and model routing simplification. `cmc-capability-summary.json` now carries `cmc-render-result-v1` render blocks/diagnostics/claim policy; `model-route.json` is `agent-model-route-v3` with model preference, fallback attempts, and final model; the Workbench exposes `自动 / deepseek-v4-pro / deepseek-v4-flash`.
- 2026-06-12: Implemented Meeting Agent cloud ASR. `office.cloud_asr.transcribe` routes audio/video meeting inputs through Alibaba Bailian / DashScope via OSS temporary upload, writes `cloud-asr-transcript.json`, `cloud-asr-summary.json`, and `meeting-source-pack.json`, and keeps raw media/provider payloads out of artifacts.
- 2026-06-13: Cloud ASR OSS configuration handoff added. Local inspection found `.env` still lacks real `DASHSCOPE_API_KEY`, OSS bucket, and OSS AK/SK; no local `aliyun` or `ossutil` profile is present; `VoiceInput.app` is a DashScope realtime ASR reference, not an OSS file-transcription config source.
- 2026-06-14: Cloud ASR OSS bucket setup advanced. The dedicated bucket is `meetingagent-feishu` in `cn-beijing`, `.env` now has non-secret OSS bucket/region/endpoint values prefilled, and `agent-runtime` includes `npm run cloud-asr:oss-check` for PUT/GET signed URL consistency after local AK/SK entry.
- 2026-06-18: Blocks Workbench became the active SwiftUI frontend direction. Default Workbench now uses Domain Blocks, Loop Templates, Active Loops, block-aware Result Canvas, and Loop Composer. Command Desk v2 is retained as historical baseline/compatibility code, not the final active design.

## Product Rules

- Default product path must not show global Inspector, source browser, raw runtime artifacts, raw provider IDs, raw tool IDs, normalizer names, workers, secrets, or internal schema fields.
- User-visible capability selection remains capability/Skill/Extension level. Internal tools/providers are runtime implementation details.
- WeChatCLI is read-only source access. Do not run live WeChat commands unless the user explicitly authorizes that step.
- CMC live data must be labeled by source and freshness. Fixture, manual, normalized-file, or degraded values must never be labeled as live.
- Feishu live publish/reply, trading, WeChat sending, external posting, destructive actions, and real tmux/subagent control remain blocked or confirmation-gated.
- Meeting ASR uses cloud transcription by explicit user media input. The UI must label it as `云端转写 · 阿里云百炼 · OSS 临时上传`; local fixed ASR threads are not part of the active architecture.
- Future Agent architecture work must distinguish `Agent Runtime Core`, `Pi Kernel`, `Daemon Shell`, `Product Capability`, `Task Intent`, `Tool Module`, and `Provider Adapter`.
- Business uncertainty, parser gaps, freshness, low confidence, and weak output quality are metadata or feature bugs, not broad blocking gates.
- CMC Skill Hub returned summaries/conclusions should render as provider-returned content. Gates should only prevent secret/internal leakage, unsupported generated numeric/action claims, unsafe external actions, malformed writes, or invalid state transitions.
- Model names may be visible in the expert workbench. The frontend may offer `自动`, `deepseek-v4-pro`, and `deepseek-v4-flash`; backend Core remains responsible for route validation and fallback attempts.

## Active QA

- Latest Blocks Workbench verification on 2026-06-18:
  - `swift build`: pass.
  - `swift test`: pass.
  - `git diff --check`: pass; local shell printed a non-fatal pyenv shim warning.
  - `xmllint --noout wiki/design/prototypes/2026-06-18-*.svg`: pass; local shell printed a non-fatal pyenv shim warning.
  - `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass with `ui_smoke_workspace=Workbench`, `ui_smoke_command_desk_visible=false`, `ui_smoke_blocks_workbench_visible=true`, `ui_smoke_domain_blocks_visible=true`, `ui_smoke_loop_templates_visible=true`, `ui_smoke_active_loops_visible=true`, `ui_smoke_no_global_inspector=true`, `ui_smoke_single_final_answer_source=true`, `ui_smoke_internal_tools_hidden=true`, and `ui_smoke_feishu_live_hidden_or_confirmed=true`.
- Latest cleanup verification on 2026-06-12:
  - `git diff --check`: pass.
  - `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
  - sandboxed `npm test`: Core/control-plane passed, local MongoDB blocked by expected `EPERM 127.0.0.1:27017`.
  - approved non-sandbox `npm test`: pass; business QA included `markets_equity_draft` run `run-b89ffae5-b37a-4619-a217-f4568d558900` and `cmc_degraded` run `run-e245fda4-1bf3-418f-951b-6f7304d16dbc`.
  - `swift build`: pass.
  - `swift test`: pass.
  - `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass with `ui_smoke_workspace=Workbench`, `ui_smoke_command_desk_visible=true`, `ui_smoke_markets_research_visible=true`, `ui_smoke_no_global_inspector=true`, `ui_smoke_single_final_answer_source=true`, and `ui_smoke_public_ability_names_clean=true`.
- Latest CMC rendering/model-route verification on 2026-06-12:
  - `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
  - `node agent-runtime/control-plane/model-route.test.mjs`: pass.
  - `node agent-runtime/core/final-output/deterministic-final-copy.test.mjs`: pass.
  - `node agent-runtime/control-plane/smoke-test.mjs`: pass.
  - `node agent-runtime/core/gates/gate-engine.test.mjs`: pass.
  - sandboxed `npm test`: Core/control-plane passed, local MongoDB blocked by expected `EPERM 127.0.0.1:27017`.
  - approved non-sandbox `npm test`: pass; business QA included `btc_macro` run `run-10ae373b-864c-4a6e-87cf-035c5a143e19`, `markets_equity_draft` run `run-fa0f46da-3fb9-48a8-82cd-2c10b3eb7a01`, and `cmc_degraded` run `run-3ccace99-47f5-4b85-a470-143e02227c8e`.
  - `swift build`: pass.
  - `swift test`: pass.
  - `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass.
- Latest Meeting Cloud ASR verification on 2026-06-12:
  - `node --check agent-runtime/core/providers/cloud-asr-provider.mjs`: pass.
  - `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
  - `node agent-runtime/core/run-loop/agent-runtime-core.test.mjs`: pass.
  - `node agent-runtime/core/providers/runtime-tool-executor.test.mjs`: pass.
  - `node agent-runtime/control-plane/smoke-test.mjs`: pass.
  - sandboxed `npm test`: Core/control-plane passed, local MongoDB blocked by expected `EPERM 127.0.0.1:27017`.
  - approved non-sandbox `npm test`: pass; business QA included `office_meeting_cloud_asr` run `run-68d69fa7-8d90-4d6b-b0b4-2473f38d2d2b`.
  - `swift build`: pass.
  - `swift test`: pass.
  - `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass.
- Backend: `node --check agent-runtime/bin/wechat-agent-daemon.mjs`.
- Backend full: `npm test` in `agent-runtime`; local MongoDB may require approved non-sandbox execution.
- Swift: `swift build`.
- Swift tests: `swift test`.
- UI smoke: `swift run WeChatIntelligenceRadar --ui-smoke-check`.
- UI smoke must continue to report `ui_smoke_workspace=Workbench`, `ui_smoke_blocks_workbench_visible=true`, `ui_smoke_domain_blocks_visible=true`, `ui_smoke_loop_templates_visible=true`, `ui_smoke_active_loops_visible=true`, `ui_smoke_no_global_inspector=true`, `ui_smoke_single_final_answer_source=true`, `ui_smoke_internal_tools_hidden=true`, and `ui_smoke_feishu_live_hidden_or_confirmed=true`.

## Active Architecture / Problem / Plan Index

- Current architecture cleanup: `wiki/architecture/2026-06-12-current-architecture-cleanup-sync.md`.
- Blocks Workbench PRD: `wiki/prd/2026-06-18-vertical-blocks-loop-workbench-prd.md`.
- Blocks Workbench interaction architecture: `wiki/architecture/2026-06-18-vertical-blocks-loop-workbench-interaction.md`.
- Blocks Workbench prototype spec: `wiki/design/2026-06-18-vertical-blocks-loop-workbench-prototype-spec.md`.
- Agent Runtime Core / Pi Kernel redesign: `wiki/architecture/2026-06-12-agent-runtime-core-pi-kernel-redesign.md`.
- Agent daemon / Pi overlap review: `wiki/architecture/2026-06-12-agent-daemon-pi-overlap-architecture-problem-review.md`.
- Agent gate overdefense review: `wiki/problem/2026-06-12-agent-gate-overdefense-problem-review.md`.
- CMC rendering and model routing simplification plan: `wiki/plan/2026-06-12-agent-cmc-rendering-and-model-routing-simplification-plan.md`.
- Meeting Agent cloud ASR plan: `wiki/plan/2026-06-12-meeting-agent-cloud-asr-bailian-plan.md`.
- Cloud ASR OSS configuration handoff: `wiki/plan/2026-06-13-cloud-asr-oss-configuration-handoff.md`.
- Core cleanup state: `wiki/state/2026-06-12-agent-runtime-core-pi-kernel-gate-cleanup-state.md`.
- Markets Research integration: `wiki/architecture/2026-06-12-markets-research-capability-package-integration.md`.
- Command Desk interaction redesign: `wiki/architecture/2026-06-11-agent-workbench-interaction-redesign.md` is superseded by Blocks Workbench and kept as implementation history.
- Command Desk capability GUI / review flow: `wiki/architecture/2026-06-11-command-desk-capability-gui-review-flow.md` is superseded by Blocks Workbench and kept as implementation history.
- Capability loop / memory / subagent harness: `wiki/architecture/2026-06-11-agent-capability-loop-memory-subagent-harness.md`.
- CMC display gate fixes:
  - `wiki/problem/2026-06-06-cmc-skill-hub-display-gate-overblocking.md`
  - `wiki/problem/2026-06-06-cmc-skill-hub-display-price-mutation-gate-fix-plan.md`
  - These older gate-fix documents are superseded for future work by the render-first plan above; keep them as bug history, not current product direction.

## History

- History archive index: `wiki/history/README.md`.
- Superseded frontend directions are kept under `wiki/history/architecture/` and `wiki/history/design/prototypes/`.
- Completed older plans and QA records are kept under `wiki/history/plan/`, `wiki/history/prd/`, and `wiki/history/qa/`.
- Main index should not reintroduce archived product directions as current implementation guidance.

## Next TODO

- Generate Swift fallback/public-surface data from `agent-runtime/runtime/capability-catalog.json` after the compatibility window.
- Extract low-level CMC provider transport into provider adapters only if it continues to grow; keep HTTP/SSE/Mongo/auth/path lifecycle in daemon shell.
- Observe real CMC runs using `cmc-render-result-v1` blocks and `agent-model-route-v3` attempts; refine only if provider-returned content or fallback notes prove noisy in normal Blocks Workbench use.
- Complete Cloud ASR live setup by filling local `.env` values for `DASHSCOPE_API_KEY`, `ALIYUN_OSS_ACCESS_KEY_ID`, and `ALIYUN_OSS_ACCESS_KEY_SECRET`; then run `npm run cloud-asr:oss-check` in `agent-runtime` and proceed to live audio fixture validation.
- Before enabling live equity provider for Markets Research, add provider auth/redaction, normalized evidence pack, price snapshot, split gates, fixtures, and business QA.
- Design Hermes memory review, retention, purge, and rollback before enabling real memory writes.
- Design tmux/subagent namespace, permission prompt, logs, termination, and QA before enabling real session control.
- Improve Blocks Workbench rendering for CMC market content, Markets research drafts, Office document previews, Cloud ASR transcript review, and Feishu preview/confirmation while keeping internal tools hidden.
- Replace local debug bundle workflow with signed Xcode packaging when moving beyond local MVP.
- Record GitHub sync branch and commit hash after this cleanup is pushed.

## GitHub Sync

- Branch: `codex/latest-intelligence-workbench-cleanup`.
- Remote: `origin` (`https://github.com/DESONGs/intelligence-agent-web3.git`).
- Cleanup commit pushed: `36f36cf` (`cleanup architecture and consolidate command desk runtime`).
