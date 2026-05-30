# WeChat Intelligence Radar Project Wiki

Updated: 2026-05-29

```text
Project Wiki
├── 00 Plan / Checkpoints
│   ├── Initial SwiftUI MVP
│   ├── Runtime/data/ops milestones
│   ├── Proactive console milestones
│   ├── Agent workspace milestones
│   ├── Extension package / Ops decoupling
│   ├── Research OS frontend redesign
│   ├── Apple minimal workbench redesign
│   ├── Agent workbench layout / ability palette refinement
│   ├── Context Plane comparative audit
│   ├── Agent Runtime control plane comparative audit
│   ├── Agent Runtime control/context implementation
│   ├── Agent Runtime / Swift adapter contract fix
│   └── Agent extension / skill capability QA
├── 01 Issues
│   ├── Toolchain and launch caveats
│   ├── Live WeChat access intentionally blocked
│   ├── Provider / bridge degraded boundaries
│   └── Reference project write protection
├── 02 Decisions
│   ├── Swift Package executable
│   ├── RuntimeBackend command/query/mutation boundary
│   ├── Agent Runtime Host
│   ├── Skill/Extension public surface
│   ├── Agent/Ops decoupling
│   └── Wiki current/history split
├── 03 Fixes
│   ├── Runtime stores and artifacts
│   ├── Crystal / Proposal / Memory / Handoff
│   ├── Agent workspace V2
│   └── Product QA launch gate
├── 04 Verification
│   ├── Build / test / smoke records
│   ├── Capability audits
│   ├── Product QA records
│   └── Current structure sync
├── 05 Retrospective
│   ├── Architecture tradeoffs
│   └── Next iteration TODO
├── 06 Changelog
│   ├── 2026-05-24 initial MVP -> runtime backend
│   ├── 2026-05-26 proactive console and QA
│   └── 2026-05-27 Agent workspace / PiAgent / wiki sync
├── 07 Project Rules
├── 08 Next TODO
├── 09 QA / History
│   ├── 2026-05-29 Agent extension / skill capability QA
│   ├── 2026-05-26 Computer Use product-level QA archived
│   └── 2026-05-27 Assistant-UI Agent Workspace V2 QA archived
└── 10 Architecture
    ├── 2026-05-27 Project structure / Agent capability sync
    ├── 2026-05-27 PiAgent-backed runtime adoption
    ├── 2026-05-28 Agent extension package / Ops decoupling
    ├── 2026-05-28 Research OS frontend redesign
    ├── 2026-05-29 Apple minimal workbench redesign
    ├── 2026-05-29 Agent workbench layout / ability palette
    ├── 2026-05-29 Context Plane comparative audit
    ├── 2026-05-29 Agent Runtime control plane comparative audit
    ├── 2026-05-29 Agent Runtime control/context implementation
    ├── 2026-05-29 Agent Runtime / Swift adapter audit and fix
    └── History archive index
```

## 00 Plan

- Build a macOS SwiftUI dashboard that mirrors the reference image structure: left group navigation, top date/filter/sync controls, metric cards, briefing note, signal list, action items, source ranking, and an agent console.
- Keep the business loop minimal: mock WeChat-shaped data -> adapter -> briefing agent -> signal/action/source extraction -> SwiftUI rendering.
- Preserve future integration boundary: `WeChatDataAdapter` can later be implemented with `wechat-cli` JSON commands, but this MVP must not read real WeChat data.
- Use assignment-agent-raw as architecture reference only: Planner Envelope, Policy Gate, Capability Registry, runtime logs, and adapter boundaries.
- Checkpoint 2 plan: convert static dashboard behavior into a clearer agent data chain and add Web3 market enrichment with CMC MCP blocked/degraded handling.
- Checkpoint 3 plan: make the four-end architecture concrete by adding runtime market storage, agent run artifacts, file fixture source, real time-window filtering, sync state, and tests.
- Checkpoint 4 plan: upgrade the app from a single dashboard into a personal Bloomberg-style terminal shell with WeChat Inbox, Token Terminal, Watchlist/Alerts, Agent Console, Data/Ops, token/CA stores, on-chain snapshots, alert artifacts, and auditable agent module timeline.
- Checkpoint 5 plan sync: the current terminal shell is only an MVP skeleton. The next stage must add Runtime Backend, richer data stores, agent module pipeline, Ops health, artifact manifest, right inspector, and bottom operations deck. Historical completed plan: `wiki/history/plan/2026-05-24-plan-completed-runtime-data-agent-ops-overhaul.md`.
- Checkpoint 6 plan: implement the runtime/data/agent/Ops overhaul plan at MVP runtime depth, proving the five-end architecture and the `Message -> Token -> Evidence -> Alert/Task -> Artifact` loop with fresh smoke artifacts.
- Checkpoint 7 plan: use Yansu's proactive, local-first, background-agent product form as a reference and define the next product iteration around Crystal Stream, Agent Proposal, Memory, Handoff, and Proactive Session objects. Historical completed PRD: `wiki/history/prd/2026-05-26-prd-completed-yansu-inspired-wechat-onchain-agent-console.md`.
- Checkpoint 8 plan: complete all local MVP phases from the Yansu-inspired PRD with an agentteam-style split: runtime contract, agent pipeline, UI console, policy/Ops, QA/docs.
- Checkpoint 9 plan: fix product-level QA blockers by making the user-opened app bundle deterministic, adding a visible-window UI smoke gate, wiring search, making runtime smoke emit at least 3 crystals, and recording user-level visual evidence.
- Checkpoint 10 plan: upgrade Agent 操作台 into a Pi-compatible Agent operation space with local daemon, chat stream, tool/skill palette, attachment composition, long task artifacts, provider routing, and policy-visible tool calls. Historical completed plan: `wiki/history/plan/2026-05-27-plan-completed-agent-operation-space-v1-pi-compatible-daemon.md`.
- Checkpoint 11 plan: critique the current UI/UX from a product-design lens and prioritize a user-facing redesign before adding more capabilities. The next iteration must reduce runtime-first exposure, make “今日情报” and “Agent 工作台” the primary flows, turn 情报卡 into decision cards, collapse technical details by default, and clarify safety confirmation. Historical completed plan: `wiki/history/plan/2026-05-27-plan-completed-agent-workspace-ui-ux-product-redesign.md`.
- Checkpoint 12 plan: refine Agent 操作台 into an assistant-ui / AI Elements inspired ChatUI workspace. The frontend direction is thread-first, composer-centered, inline tool-call cards, attachment/context composition, human-readable approval cards, collapsible evidence inspector, and compact run status. Historical completed plan: `wiki/history/plan/2026-05-27-plan-completed-assistant-ui-inspired-agent-chat-workspace.md`.
- Checkpoint 13 architecture audit: 将下一阶段规划基线从前端形态转向后端、数据获取、存储、生命周期、Pi-compatible agent daemon、skills/tools、模型路由和 Ops 能力缺口。该审计已被 PiAgent-backed adoption 取代，历史文档：`wiki/history/architecture/2026-05-27-architecture-superseded-backend-agent-data-capability-audit.md`。
- Checkpoint 14 project sync: 当前有效项目结构与 Agent 能力已重新同步，区分 Swift 产品运行时、Node/Pi SDK-backed Agent daemon、runtime artifacts、history archive 和未生产化能力。当前架构文档：`wiki/architecture/2026-05-27-project-structure-agent-capability-sync.md`。
- Checkpoint 15 agent capability adjustment: Agent 前端只暴露 Skill/Extension，底层 tool/provider/normalizer/policy 由 Agent Runtime Host 内部调用；WeChatCLI 与 CMC Skill Hub 改为 extension package；Ops 从 Agent 规划器中解耦。当前架构文档：`wiki/architecture/2026-05-28-agent-extension-package-ops-decoupling.md`。
- Checkpoint 16 frontend redesign: 将 SwiftUI 前端整体升级为 Research OS 风格投研操作台，覆盖全局视觉系统、Sidebar、Top Command Bar、Home Operating Desk、Agent Workspace、Inbox、Token、Watchlist 和 Ops；本轮只改前端，不改 Agent Runtime Host 与后端边界。当前设计文档：`wiki/architecture/2026-05-28-research-os-frontend-redesign.md`。
- Checkpoint 17 frontend simplification: 按苹果/macOS 清透深色语言，将 Research OS 高密度界面收敛成极简“今日情报工作台”：首屏只保留今日摘要、5 条精选情报和常驻 Agent Composer；左侧导航压缩为今日/Agent/资料库/设置；运维、artifact、policy、module run 默认隐藏。当前设计文档：`wiki/architecture/2026-05-29-apple-minimal-workbench-redesign.md`。
- Checkpoint 18 Agent workbench refinement: 参考 ChatGPT/Cursor/Codex 的对话工作台模式，修复 Agent 页底部空白和左侧能力占位过大问题；主导航与 Agent 能力栏支持折叠；Skill/Extension 在主界面收敛为“能力包”；Composer 支持输入 `/add` 或点击 Add 打开能力包选择弹层。当前设计文档：`wiki/architecture/2026-05-29-agent-workbench-layout-ability-palette.md`。
- Checkpoint 18 follow-up: Agent 左侧栏进一步收敛为 session 列表，移除重复能力包区；能力包来源与 Agent Runtime Host public surface 对齐，至少包含 WeChatCLI 能力包、CoinMarketCap MCP 能力包和 CoinMarketCap 市场雷达；session 支持本地重命名。
- Checkpoint 19 context plane audit: 对比 `assignment-agent-raw` 的 `context-offload`、`source-context-runtime`、`file-context`、`source-context`、`retrieval-index` 机制后确认：当前项目已有上下文引用和 artifact 指针，但缺少任务级 Context Plane。下一阶段 Agent 能力重点应从增加前端按钮转为补内部 ContextBundle、chunk/retrieval/budget/manifest/gate。当前架构文档：`wiki/architecture/2026-05-29-context-plane-comparative-audit.md`。
- Checkpoint 20 control plane audit: 对比 `assignment-agent-raw` 的 planner、task router、execution profile、tool-load manifest、model routing、policy/approval/QA gate、worker、runtime observability 后确认：当前项目已具备 Agent Runtime Host MVP 和工具调用闭环，但控制面仍偏轻，下一阶段应补内部 Agent Runtime Control Plane，而不是增加前端按钮。当前架构文档：`wiki/architecture/2026-05-29-agent-runtime-control-plane-comparative-audit.md`。
- Checkpoint 21 control/context implementation: 已补齐本地 MVP 级 Agent Runtime Control Plane 与 Context Plane。daemon 执行顺序改为 task intent、execution profile、context bundle、planner、tool intent、policy/approval/model route/QA、允许工具执行、metrics/checkpoint、final output；前端仍只暴露 Skill/Extension。实施计划：`wiki/plan/2026-05-29-agent-runtime-control-plane-context-plane-implementation-plan.md`。实施记录：`wiki/architecture/2026-05-29-agent-runtime-control-plane-context-plane-implementation-record.md`。
- Checkpoint 22 Agent Runtime / Swift adapter fix: 已把 Agent Runtime Control/Context Plane 与 Swift 前端从早期兼容拼接升级为稳定适配契约。Runtime 保留同步接口并新增 async message API、真实 SSE tail、run-manifest、轻量 control/context summary、redacted tool call contract 和 pause/resume/cancel 状态检查；Swift 新增 typed run read-model、SSE client、manifest/context/control summary 查询，并让 Agent UI adapter 从结构化数据而非字符串猜测流程。当前架构文档：`wiki/architecture/2026-05-29-agent-swift-adapter-audit-and-fix.md`。
- Checkpoint 23 Agent extension / skill capability QA: 已完成 Agent 端 extension/skill 能力测试。WeChatCLI 通过 fixture/export normalization 跑通，live `wechat-cli` 命令保持 blocked；CMC MCP live 通过 CoinMarketCap MCP 获取 live market overview，再写入项目 normalized artifact 并由 `cmc-skill-hub` extension 读取完成 Agent run。QA 文档：`wiki/qa/2026-05-29-agent-extension-skill-capability-qa.md`。

## 01 Issues

- `agent.md` was requested as a base writing rule, but no `agent.md` file was found outside `node_modules` during workspace scan. Current mitigation: proceed with the explicit user constraints and record this gap here.
- The actual WeChat reference directory is named `wechat-cli_raw`, while the objective mentions `wechat-cli-raw`. Current mitigation: protect and reference the actual directory name.
- Live WeChat testing is prohibited by the user. Current mitigation: PolicyGate blocks `read_live_wechat` and the app uses `MockWeChatDataAdapter`.
- CoinMarketCap MCP was initially unavailable through MCP_DOCKER catalog search, but `tool_search` later exposed `mcp__crypto_skill_hub__`, a CoinMarketCap-powered Crypto Skill Hub. Current state: `CMCMarketDataProvider` loads a normalized BTC/ETH/SOL snapshot from verified `altcoin_token_profile` executions; `MockWeb3MarketDataAdapter` remains standby fallback only.
- The local CommandLineTools install does not expose `XCTest` or `Testing` as importable modules in this SwiftPM project. Current mitigation: the test target uses framework-free precondition checks and `swift test` still validates compilation of those checks.
- Development execution subagents were not spawned in this checkpoint. Current mitigation: no external development subagent lifecycle artifact is required; the shipped product runtime still records bounded agent module runs for Ingestion, Entity Resolver, Market Data, On-chain, Briefing, Alert, and QA/Policy.
- Contract extraction initially leaked an internal base58-looking substring from the ETH sample CA. Current mitigation: `TokenResolutionService` now requires alphanumeric token boundaries around CA matches.
- Product consistency issue: prior checkpoint language used "effective" for MVP-depth surfaces. Current clarification: those are skeleton-level capabilities only; they do not yet satisfy the next-stage runtime/backend/data/agent/Ops product goal.
- Live on-chain provider remains unavailable by design. Current mitigation: on-chain module and runtime health mark symbol-only/provider-missing paths as `degraded`; fixture CA snapshots remain labeled `fixture`.
- XCTest/Testing is still unavailable as an importable local framework. Current mitigation: `swift test` validates target build and `swift run WeChatIntelligenceRadar --smoke-check` validates runtime artifacts.
- Computer Use product QA found a P0 launch/package inconsistency: the app-bundle binary exposed the older dashboard while the direct SwiftPM executable contained the newer Crystal-first code. Current mitigation: record in `wiki/history/qa/2026-05-26-qa-completed-computer-use-product-level-qa.md` and require an app-bundle launch smoke gate before the next product acceptance.
- Computer Use could not complete the current Crystal-first UI walkthrough after local build-artifact replacement because the app process started without a readable visible window. Current mitigation: backend/runtime artifacts remain inspectable, but product QA is marked not pass until window launch is deterministic.
- Product QA fix status: app-bundle launch is now deterministic through `.build/debug-app/WeChatIntelligenceRadar.app`; UI smoke verifies a visible `WeChat Intelligence Radar` window with a real `windowNumber`; user-provided screenshot confirms the current Crystal-first UI is visible.
- Residual tooling caveat: Computer Use app-state capture can still be unreliable against this macOS SwiftUI window. Current acceptance uses app-bundle launch smoke plus user-level screenshot evidence instead of treating the Computer Use attachment issue as a product UI blocker.
- User provided model API keys in chat during Agent operation-space planning. Current mitigation: no key was written to code, wiki, or runtime artifacts; implementation reads provider credentials only from environment variables and production use should rotate the exposed keys.
- Architecture clarification resolved: 当前 `agent-runtime/` 使用 Agent Runtime Host 作为产品层概念，Pi SDK 仅作为内部 runtime framework；前端不再展示 raw tools。

## 02 Decisions

- Use a Swift Package executable with SwiftUI to keep local build verification simple through `swift build`.
- Avoid copying source from either reference project. The MVP keeps its own model, adapter, orchestrator, and UI files.
- Keep agent architecture shallow: `AgentOrchestrator`, `PolicyGate`, `CapabilityRegistry`, `BriefingAgent`, and `WeChatDataAdapter`.
- Web3 market capability is split into `CMCMarketDataProvider` for loaded CMC Skill Hub snapshots and `MockWeb3MarketDataAdapter` for fixture fallback, so CMC-loaded data and local fallback data remain visibly distinct.
- Web3 enrichment runs after the WeChat mock adapter and before `BriefingAgent`, making the chain `UI -> ViewModel -> AgentOrchestrator -> adapters/providers -> Web3SignalService -> BriefingAgent -> Snapshot -> UI`.
- Runtime writes are now first-class: market snapshots live under `runtime/market/`, and every agent refresh can write structured run artifacts under `runtime/runs/{runID}/`.
- Swift desktop does not call MCP directly; `CMCRefreshBridge` consumes normalized local JSON artifacts and `CMCMarketDataProvider` seeds the current Skill Hub snapshot when no external artifact exists.
- Next-stage implementation must route product actions through a local Runtime Backend / Repository boundary instead of placing workflow logic directly in views or `DashboardViewModel`.
- Runtime backend boundary is now present. SwiftUI actions call `DashboardViewModel`, which dispatches `RuntimeCommand` into `RuntimeBackend` and `RuntimeRepository`; the backend never reads live WeChat, calls MCP, or stores secrets.
- The shipped product runtime now uses `AgentModuleRun` as the first-class module timeline. `subagent-runs.json` is retained as a compatibility artifact only.
- Agent 后端路线已调整为 Agent Runtime Host：Swift 只负责 UI 与 artifact 展示，Node runtime host 负责 session/resource/extension/internal-tool runtime，product mutation 通过本地 JSON inbox 导入 Swift runtime。
- Agent 能力接入采用 extension package，不再把 WeChatCLI、CMC 等能力作为一次性 bridge 接线。前端只选择 Skill/Extension。
- Ops Runtime 从 Agent 任务规划中解耦，健康、provider readiness、dependency status、policy summary 写入 `runtime/ops/`。
- Agent 上下文能力采用内部 Context Plane 方向：前端仍只展示 Skill/Extension 和轻量 context chip，底层由 Agent Runtime Host 组装 ContextBundle、retrieval plan、context manifest 和 gate。
- Agent Runtime 控制面采用内部 Control Plane 方向：前端继续只暴露 Skill/Extension，底层补 task intent、execution profile、tool intent plan、policy/approval/QA gate、runtime metrics、worker decision 和 checkpoint artifact。
- Agent Runtime Control Plane 与 Context Plane 已进入本地 MVP 实现：底层 artifact contract 已写入 `runtime/agent/runs/{runID}/`，但 worker 调度、retrieval index、schema enforcement 仍按后续迭代推进。
- Agent Runtime 与 Swift 前端之间采用 manifest-first 适配：Swift 主界面只消费 run stage、context count、risk summary、final output 和 public Skill/Extension 名称；tool/provider/module、policy detail、artifact index 只进入详情或本地 artifact。
- 前端采用 Research OS 设计系统：深色玻璃、细网格、青绿主色、紫蓝空间层级、金色/红色风险状态；所有工作区共享同一 shell、Inspector 和 Execution Strip 语言。
- 前端进一步收敛为 Apple minimal workbench：主工作台不常驻 Inspector/Execution Strip，技术细节进入设置或按需详情；资料库聚合 Inbox/Token/Watchlist。
- Wiki 文档管理采用当前文档与历史归档分层：完成或被取代的计划/PRD/QA/架构文档进入 `wiki/history/`，当前有效架构保留在 `wiki/architecture/`。

## 03 Fixes

- Fixed SwiftUI compile error in `SidebarView`: replaced invalid `frame(width:maxHeight:)` overload with separate fixed width and max-height frame modifiers.
- Build note: first sandboxed `swift build` was blocked by user-level Swift/Clang module cache permissions. Authorized `swift build` succeeded.
- Added real handlers for copy summary, rescan, time-window change, and group selection through `DashboardViewModel`; each operation now triggers or records an agent-side state update.
- Added Web3 tag rendering and Web3 Radar panel after compile validation.
- Loaded CMC Crypto Skill Hub capability into agent side by adding `CMCSkillHubCapability` and changing `CMCMarketDataProvider` from blocked fallback to enabled normalized snapshot mode.
- Added `MarketSnapshotStore`, `CMCRefreshBridge`, `AgentRunStore`, `AgentSyncState`, `WeChatFixtureFileAdapter`, `WeChatCLIExportAdapter` contract, `sentAt/sourceDateText`, and `TimeWindow.range`.
- Added `--smoke-check` app mode to run one agent refresh without launching the desktop window.
- Added the terminal workspace shell: Home/Daily Brief, WeChat Intelligence Inbox, Token Terminal, Watchlist/Alerts, Agent Console, and Data/Ops Settings.
- Added `TokenResolutionService`, normalized message/token/on-chain/alert stores, fixture CA samples, and Token Terminal linking from message symbols/contracts to token entities.
- Added bounded agent module run timeline with task scope and artifacts for Ingestion, Entity Resolver, Market Data, On-chain, Briefing, Alert, and QA/Policy.
- Fixed CA extraction boundary handling so EVM addresses do not also emit nested base58 false positives.
- Added historical plan `wiki/history/plan/2026-05-24-plan-completed-runtime-data-agent-ops-overhaul.md` to synchronize the next-stage `/goal` with concrete stop conditions, five-end architecture, runtime backend, data stores, agent pipeline, Ops requirements, and completion evidence.
- Added `RuntimeBackend`, `RuntimeRepository`, `RuntimeCommand`, `RuntimeQuery`, and `RuntimeMutation`.
- Added `EvidenceItem`, `UserTask`, `WatchlistItem`, `AlertRule`, `ArtifactReference`, `RuntimeStoreManifest`, `RuntimeHealthCheck`, `DataRetentionPolicy`, `PrivacyRedactionPolicy`, and `AgentModuleRun`.
- Added `EvidenceStore`, `TaskStore`, `WatchlistStore`, `AlertRuleStore`, `ArtifactManifestStore`, and `RuntimeHealthStore`.
- Changed planner `taskType` to `wechat_onchain_terminal_runtime_refresh`.
- Reworked the runtime refresh into explicit modules: Ingestion, Entity Resolver, Market Data, On-chain, Evidence, Alert, Task, Briefing, QA/Policy.
- Added Top Command Bar, Right Inspector, and Bottom Operations Deck, while keeping the existing Left Workspace Nav and Main Workspace.
- Added deterministic debug app-bundle packaging at `.build/debug-app/WeChatIntelligenceRadar.app` with stale bundle cleanup, current executable/resource copying, and ad-hoc signing.
- Added `--ui-smoke-check` app mode that launches the real SwiftUI window and asserts title, root content, visibility, and `windowNumber`.
- Fixed default fixture coverage so smoke runs produce BTC, ETH, and SOL crystals.
- Wired the top search field into runtime-backed filters across messages, tokens, crystals, proposals, handoffs, and watchlist items.
- Added handoff archive and purge commands plus store-side index upsert/purge behavior.
- Applied Chinese-first UI labels and status presentation for workspace tabs, deck tabs, actions, and degraded/blocked/stale states.
- Added `agent-runtime/` Pi-compatible daemon package with capability registry, model-provider routing, skill/prompt/extension mirror, HTTP/SSE API, policy-visible tool calls, long task artifacts, and smoke-check mode.
- Added Swift Agent workspace models/services and replaced the Agent workspace with sessions, task list, plugin/skill palette, chat stream, image attachment composer, Agent Inspector, and Agent Run Deck.
- Added local image attachment copying with sha256/mime/size metadata under `runtime/agent/attachments/`; Kimi vision remains provider-config gated.
- Added historical plan `wiki/history/plan/2026-05-27-plan-completed-agent-workspace-ui-ux-product-redesign.md` to record the product-design critique, user-facing information architecture, Agent workspace redesign, intelligence-card redesign, safety confirmation flow, and phase-by-phase acceptance criteria.
- Added historical plan `wiki/history/plan/2026-05-27-plan-completed-assistant-ui-inspired-agent-chat-workspace.md` to translate AI Elements and assistant-ui interaction patterns into a SwiftUI-native Agent ChatUI workspace plan with Thread, Composer, inline capability cards, attachment/context chips, Inspector, long task rail, and compact run status.
- Redesigned the SwiftUI frontend around a Research OS visual system: expanded `RadarTheme`, added glass panels, command capsules, status chips, score bars, sparklines, Research OS background grid, refreshed Sidebar/Top Bar/Home/Agent/Inbox/Token/Watchlist/Ops surfaces, and documented the design checkpoint in `wiki/architecture/2026-05-28-research-os-frontend-redesign.md`.
- Simplified the SwiftUI frontend into an Apple-style minimal workbench: quieter material surfaces, 4-entry sidebar, compact top bar, Today-first home with 5 prioritized crystals, floating Agent composer, hidden-by-default Inspector/Execution details, consolidated Library workspace, and reduced Agent workspace chrome.
- Refined the Agent workbench layout: Agent pages now fill the available workspace instead of leaving a large lower blank area; main sidebar and Agent capability rail have persisted collapse controls; Skill/Extension are merged into user-facing ability packages; Composer supports `/add` and Add-button ability selection with prompt cleanup.
- Refined Agent session UX: the Agent rail is now a conversation/session history list, session titles can be renamed locally, and ability packages are only selected from the Composer Add / `/add` surface.
- Backfilled Agent public abilities in Swift and runtime manifests so the Add palette exposes WeChatCLI and CoinMarketCap MCP/CoinMarketCap Market Radar even when the app bundle cannot locate the project-root public surface file at launch.
- Added Agent Runtime Control Plane modules for task intent, execution profile, planner, tool intent, policy decision, approval decision, model route, QA gate, runtime metrics, checkpoint, retry ledger, and schema helper.
- Added internal Context Plane module and extension marker for ContextSource, ContextChunk, ContextBundle, retrieval plan, and context gate artifacts.
- Rewired the daemon task path so control/context artifacts are generated before allowed internal tool execution, and blocked/needs-confirmation tools are skipped instead of executed.
- Tightened Computer Use inference so generic "操作台" wording does not trigger `computer_use.request`; explicit computer/desktop/click language is still routed to the confirmation boundary.
- Added the Agent Runtime / Swift adapter contract fix: async message submission, real SSE run tail, run manifest indexing, lightweight control/context summaries, redacted tool-call records, structured policy display fields, pause/resume/cancel control-state checks, Swift event stream client, typed manifest/context/control read models, and adapter-driven Agent UI summaries.

## 04 Verification

- Checkpoint 18 build command: `swift build --scratch-path /private/tmp/wechat-radar-build`.
- Checkpoint 18 build result: `Build complete! (12.05s)`.
- Checkpoint 18 test command: `swift test --scratch-path /private/tmp/wechat-radar-test-build`.
- Checkpoint 18 test result: `Build complete! (15.67s)`.
- Checkpoint 18 UI smoke command: `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check`.
- Checkpoint 18 UI smoke result: `ui_smoke=pass`, visible window title `WeChat Intelligence Radar`, workspace `Home`, window number `249814`.
- Checkpoint 18 follow-up build command: `swift build --scratch-path /private/tmp/wechat-radar-build`.
- Checkpoint 18 follow-up build result: `Build complete! (21.35s)`.
- Checkpoint 18 follow-up test command: `swift test --scratch-path /private/tmp/wechat-radar-test-build`.
- Checkpoint 18 follow-up test result: `Build complete! (28.08s)`.
- Checkpoint 18 follow-up UI smoke command: `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check`.
- Checkpoint 18 follow-up UI smoke result: `ui_smoke=pass`, visible window title `WeChat Intelligence Radar`, workspace `Home`, window number `250278`.
- Checkpoint 18 follow-up daemon smoke command: `node agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check`.
- Checkpoint 18 follow-up daemon smoke result: `status=completed`, `sessionID=session-e1e91a63-cf4a-4f70-b6de-78a5c744e67a`, `runID=run-bf21ebc1-22c6-4270-9771-44b3f8396023`, `taskID=task-7aa93457-078a-4183-bd8a-5a4189008481`.
- Checkpoint 18 follow-up capability evidence: public surface contains 7 skills and 3 extensions, including `WeChatCLI 能力包`, `CoinMarketCap MCP 能力包`, and `CoinMarketCap 市场雷达`.
- Checkpoint 21 npm test command: `npm test` from `agent-runtime`.
- Checkpoint 21 npm test result: `control_plane_smoke=pass`; daemon smoke `status=completed`, `runID=run-b2064190-4968-4d26-91dd-d46de1efff3a`, `taskID=task-664c3d4c-d0c5-44a5-95b5-9d50d570b1c8`.
- Checkpoint 21 Swift build command: `swift build --scratch-path /private/tmp/wechat-radar-build`.
- Checkpoint 21 Swift build result: sandboxed run was blocked by user-level Clang module cache permissions; approved escalated rerun completed successfully: `Build complete! (3.04s)`.
- Checkpoint 21 Swift test command: `swift test --scratch-path /private/tmp/wechat-radar-test-build`.
- Checkpoint 21 Swift test result: sandboxed run was blocked by user-level Clang module cache permissions; approved escalated rerun completed successfully: `Build complete! (0.37s)`.
- Checkpoint 21 UI smoke command: `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check`.
- Checkpoint 21 UI smoke result: `ui_smoke=pass`, visible window title `WeChat Intelligence Radar`, workspace `Home`, window number `250655`.
- Checkpoint 21 artifact evidence: `runtime/agent/runs/run-b2064190-4968-4d26-91dd-d46de1efff3a/` contains `control-plane-manifest.json`, `task-intent.json`, `execution-profile.json`, `tool-intent-plan.json`, `context-manifest.json`, `context-bundle.json`, `retrieval-plan.json`, `context-gate.json`, `approval-decisions.json`, `qa-gate.json`, `runtime-metrics.json`, `checkpoint.json`, and `retry-ledger.json`.
- Checkpoint 21 public surface evidence: `agent-runtime/runtime/public-surface.json` reports `internalToolsExposed=false`, 7 skills, and 3 extensions.
- Checkpoint 21 protected reference evidence: `git -C ../wechat-cli_raw status --short` returned no changed files; newer-file checks against `assignment-agent-raw` and `wechat-cli_raw` returned no files.
- Checkpoint 22 npm test command: `npm test` from `agent-runtime`.
- Checkpoint 22 npm test result: `control_plane_smoke=pass`; daemon smoke `status=completed`; async smoke `async_smoke=pass`, latest npm-test async run `runID=run-545b75ea-5668-4b56-bb42-811520a97855`.
- Checkpoint 22 async smoke command: `node agent-runtime/bin/wechat-agent-daemon.mjs --async-smoke-check`.
- Checkpoint 22 async smoke result: `async_smoke=pass`, `runID=run-f9c85d7c-f653-4e5c-8d0d-46967e5bab89`.
- Checkpoint 22 Swift build command: `swift build --scratch-path /private/tmp/wechat-radar-build`.
- Checkpoint 22 Swift build result: `Build complete! (20.05s)`.
- Checkpoint 22 Swift test command: `swift test --scratch-path /private/tmp/wechat-radar-test-build`.
- Checkpoint 22 Swift test result: `Build complete! (22.43s)`.
- Checkpoint 22 UI smoke command: `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check`.
- Checkpoint 22 UI smoke result: `ui_smoke=pass`, visible window title `WeChat Intelligence Radar`, workspace `Home`, window number `250657`.
- Checkpoint 22 artifact safety evidence: latest async `tool-calls.json` uses `outputSummary`, `detailsArtifactPath`, and `redactionStatus`; search for sample raw message text, sender fields, `Authorization`, and `sk-` in the redacted tool-call surface returned no matches.
- Checkpoint 22 protected reference evidence: `git -C ../wechat-cli_raw status --short` returned no changed files; newer-file checks against `assignment-agent-raw` and `wechat-cli_raw` returned no files.
- Checkpoint 23 CMC MCP live execution: `daily_market_overview` returned `status=ok`, timestamp `2026-05-29T12:49:15.019024+00:00`, regime `headwind_tightening`, risk bias `defensive_research_only`.
- Checkpoint 23 normalized CMC artifact: `runtime/market/cmc-skill-hub.normalized.json` written with provider `mcpProvider`, skill `daily_market_overview`, status `ok`, watchlist count `5`; raw MCP response was not persisted.
- Checkpoint 23 npm test command: `npm test` from `agent-runtime`.
- Checkpoint 23 npm test result: `control_plane_smoke=pass`; sync run `runID=run-3f03fa84-0e31-4fc0-93d3-b694d13d9b67`; async run `runID=run-27179a13-2d02-4c4c-b0e0-0994f41781a3`; `async_smoke=pass`.
- Checkpoint 23 WeChatCLI artifact evidence: `runtime/agent/runs/run-27179a13-2d02-4c4c-b0e0-0994f41781a3/wechat-cli-import.json` reports `source=fixture_export`, `policy=pass`, `messageCount=3`, `liveCommandsBlocked=true`, and live commands only under `notExecuted`.
- Checkpoint 23 CMC extension evidence: `runtime/agent/runs/run-27179a13-2d02-4c4c-b0e0-0994f41781a3/cmc-daily_market_overview.json` reports `provider=normalizedFileProvider`, `skillName=daily_market_overview`, regime `headwind_tightening`; `runtime/market/latest-market-snapshot.json` reports `freshness=fresh`, `sourceName=CMC Skill Hub normalizedFileProvider`, asset count `5`.
- Checkpoint 23 public surface evidence: `/capabilities` returned `internalToolsExposed=false`, 7 skills, 3 extensions, and 0 public tools.
- Checkpoint 23 safety evidence: search of latest redacted tool-call surfaces found no `Authorization`, `Bearer`, `sk-`, `apiKey`, `cookie`, sample private message text, or sender metadata; `assignment-agent-raw` and `wechat-cli_raw` remained unchanged.
- Checkpoint 17 build command: `swift build --scratch-path /private/tmp/wechat-radar-build`.
- Checkpoint 17 build result: `Build complete! (2.32s)`.
- Checkpoint 17 test command: `swift test --scratch-path /private/tmp/wechat-radar-test-build`.
- Checkpoint 17 test result: `Build complete! (3.62s)`.
- Checkpoint 17 UI smoke command: `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check`.
- Checkpoint 17 UI smoke result: `ui_smoke=pass`, visible window title `WeChat Intelligence Radar`, workspace `Home`, window number `249477`.
- Checkpoint 17 safety evidence: `git -C ../wechat-cli_raw status --short` returned no changed files; newer-file checks against `assignment-agent-raw` and `wechat-cli_raw` returned no files.
- Checkpoint 17 UI exposure evidence: `DashboardView` no longer calls `BottomOperationsDeck`; `RuntimeRightInspectorView` is only conditionally rendered after explicit object selection.
- Checkpoint 16 build command: `swift build --scratch-path /private/tmp/wechat-radar-build`.
- Checkpoint 16 build result: `Build complete! (3.67s)` after the final safe CTA patch.
- Checkpoint 16 test command: `swift test --scratch-path /private/tmp/wechat-radar-test-build`.
- Checkpoint 16 test result: `Build complete! (4.82s)` after the final safe CTA patch.
- Checkpoint 16 UI smoke command: `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check`.
- Checkpoint 16 UI smoke result: `ui_smoke=pass`, visible window title `WeChat Intelligence Radar`, workspace `Agent Console`, window number `249079`.
- Checkpoint 16 public surface check: `rg "selectedAgentTool|agentTools|Tool Palette|raw tool|provider route|module list" Sources/WeChatIntelligenceRadarApp/Views` returned no matches.
- Checkpoint 16 protected project evidence: `git -C ../wechat-cli_raw status --short` returned no changed files; `find ../assignment-agent-raw ... -newer wiki/architecture/2026-05-28-research-os-frontend-redesign.md` returned no files; `find ../wechat-cli_raw ... -newer wiki/architecture/2026-05-28-research-os-frontend-redesign.md` returned no files.
- Build command: `swift build` from `wechat-intelligence-radar-mvp`.
- Build result: `Build complete! (3.69s)`.
- Checkpoint 2 build command: `swift build` from `wechat-intelligence-radar-mvp`.
- Checkpoint 2 build result: `Build complete! (6.54s)`.
- Checkpoint 3 build command: `swift build`.
- Checkpoint 3 build result: `Build complete! (0.19s)`.
- Checkpoint 3 test command: `swift test`.
- Checkpoint 3 test result: `Build complete! (1.58s)`.
- Checkpoint 3 smoke command: `swift run WeChatIntelligenceRadar --smoke-check`.
- Checkpoint 3 smoke result: `status=completed`, `freshness=fresh`, run artifact path under `runtime/runs/run-70920c92-3057-4e0c-8274-4a5608f241a3`.
- Checkpoint 4 build command: `swift build`.
- Checkpoint 4 build result: `Build complete! (4.40s)`.
- Checkpoint 4 test command: `swift test`.
- Checkpoint 4 test result: `Build complete! (1.86s)`. Note: local XCTest runner remains unavailable; runtime validation uses the smoke check below.
- Checkpoint 4 smoke command: `swift run WeChatIntelligenceRadar --smoke-check`.
- Checkpoint 4 smoke result: `runID=run-dccf783e-d9c3-4073-806a-b92366e2a0c7`, `status=completed`, `freshness=fresh`, artifact path `runtime/runs/run-dccf783e-d9c3-4073-806a-b92366e2a0c7`.
- Checkpoint 4 desktop launch command: `swift run WeChatIntelligenceRadar`, stopped manually after startup verification.
- Checkpoint 4 desktop launch result: product built and started without immediate launch-time crash before manual `Ctrl-C`.
- Checkpoint 4 artifact evidence:
  - `runtime/wechat/messages.normalized.json`
  - `runtime/entities/token-entities.json`
  - `runtime/market/latest-market-snapshot.json`
  - `runtime/onchain/Ethereum/0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.json`
  - `runtime/onchain/Solana/So11111111111111111111111111111111111111112.json`
  - `runtime/alerts/alerts.json`
  - `runtime/runs/run-dccf783e-d9c3-4073-806a-b92366e2a0c7/terminal-data.json`
  - `runtime/runs/run-dccf783e-d9c3-4073-806a-b92366e2a0c7/subagent-runs.json`
- Checkpoint 4 CA/entity evidence:
  - ETH fixture message extracted only `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` and linked `ethereum:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`.
  - SOL fixture message extracted `So11111111111111111111111111111111111111112` and linked `solana:so11111111111111111111111111111111111111112`.
  - Agent module timeline includes task-scoped `ingestion`, `entityResolver`, `marketData`, `onchain`, `briefing`, `alert`, and `qaPolicy` runs.
- Protected project evidence:
  - `git -C wechat-cli_raw status --short` returned no changed files.
  - `find assignment-agent-raw -type f -newer wechat-intelligence-radar-mvp/Package.swift -not -path '*/node_modules/*'` returned no files.
  - `find wechat-cli_raw -type f -newer wechat-intelligence-radar-mvp/Package.swift -not -path '*/.git/*'` returned no files.
- Checkpoint 4 protected project evidence:
  - `git -C ../wechat-cli_raw status --short` returned no changed files.
  - `find ../assignment-agent-raw -type f -newer Package.swift -not -path '*/node_modules/*'` returned no files.
  - `find ../wechat-cli_raw -type f -newer Package.swift -not -path '*/.git/*'` returned no files.
- Checkpoint 6 build command: `swift build`.
- Checkpoint 6 build result: `Build complete! (0.27s)`.
- Checkpoint 6 test command: `swift test`.
- Checkpoint 6 test result: `Build complete! (2.51s)`. Note: test target compiles; runtime checks are smoke-based because XCTest/Testing remains unavailable.
- Checkpoint 6 smoke command: `swift run WeChatIntelligenceRadar --smoke-check`.
- Checkpoint 6 smoke result: `runID=run-b7ed0c96-eacc-4971-a7ce-afa93ba3f790`, `status=degraded`, `freshness=degraded`, artifact path `runtime/runs/run-b7ed0c96-eacc-4971-a7ce-afa93ba3f790`.
- Checkpoint 6 desktop launch command: `swift run WeChatIntelligenceRadar`, stopped manually after startup verification.
- Checkpoint 6 desktop launch result: product built and started without immediate launch-time crash before manual `Ctrl-C`.
- Checkpoint 6 runtime artifact evidence:
  - `runtime/evidence/evidence.json`
  - `runtime/tasks/tasks.json`
  - `runtime/watchlist/watchlist.json`
  - `runtime/alerts/alert-rules.json`
  - `runtime/artifacts/manifest.json`
  - `runtime/health/latest-health.json`
  - `runtime/runs/run-b7ed0c96-eacc-4971-a7ce-afa93ba3f790/module-runs.json`
  - `runtime/runs/run-b7ed0c96-eacc-4971-a7ce-afa93ba3f790/artifact-manifest.json`
- Checkpoint 6 workflow evidence:
  - `terminal-data.json` reports `evidence=3`, `tasks=3`, `watchlist=3`, `alertRules=3`, `alerts=3`, `moduleRuns=9`.
  - `planner-envelope.json` reports `taskType=wechat_onchain_terminal_runtime_refresh`.
  - `module-runs.json` includes `ingestion`, `entityResolver`, `marketData`, `onchain`, `evidence`, `alert`, `task`, `briefing`, and `qaPolicy`.
  - `runtime/artifacts/manifest.json` reports `completenessStatus=complete`.
  - `runtime/health/latest-health.json` reports runtime writable, latest run exists, market fresh, policy matrix pass, artifact manifest complete, import/export boundary pass, secrets boundary pass, and on-chain provider state degraded.
- Checkpoint 6 protected project evidence:
  - `git -C ../wechat-cli_raw status --short` returned no changed files.
  - `find ../assignment-agent-raw -type f -newer Package.swift -not -path '*/node_modules/*'` returned no files.
  - `find ../wechat-cli_raw -type f -newer Package.swift -not -path '*/.git/*'` returned no files.
- File inventory evidence:
  - App entry: `Sources/WeChatIntelligenceRadarApp/WeChatIntelligenceRadarApp.swift`.
  - Main dashboard: `Views/DashboardView.swift`.
  - Agent console: `Views/AgentConsoleView.swift`.
  - Mock data adapter: `Services/MockWeChatDataAdapter.swift`.
  - Data adapter protocol and future CLI boundary: `Services/WeChatDataAdapter.swift`.
  - Summary/signal/action/source extraction: `Services/BriefingAgent.swift`.
  - Minimal agent architecture: `Services/AgentOrchestrator.swift`, `Services/PolicyGate.swift`, `Services/CapabilityRegistry.swift`.
  - Web3/CMC adapter contract and blocked provider: `Services/Web3DataAdapter.swift`.
  - CMC Skill Hub capability manifest and normalized BTC/ETH/SOL data: `Services/CMCSkillHubCapability.swift`.
  - Web3 entity detection and market enrichment: `Services/Web3SignalService.swift`.
  - Web3 UI context: `Views/Web3RadarView.swift`.
  - UI control wiring: `ViewModels/DashboardViewModel.swift`, `Views/HeaderView.swift`, `Views/BriefingNoteView.swift`.
  - Runtime path and encoding helpers: `Services/RuntimeSupport.swift`.
  - Market storage and CMC bridge: `Services/MarketSnapshotStore.swift`, `Services/CMCRefreshBridge.swift`.
  - Agent run artifacts: `Services/AgentRunStore.swift`.
  - Editable WeChat fixture file: `Sources/WeChatIntelligenceRadarApp/Fixtures/wechat/messages.sample.json`.
  - Fixture/export adapters: `Services/WeChatFixtureFileAdapter.swift`.
  - Framework-free runtime checks: `Tests/WeChatIntelligenceRadarAppTests/AgentRuntimeTests.swift`.
  - Terminal workspace shell: `Views/TerminalWorkspaceSidebar.swift`, `Views/TerminalWorkspaceViews.swift`.
  - Token/CA resolver and local stores: `Services/TokenResolutionService.swift`, `Services/TerminalDataStores.swift`.
  - On-chain and alert fixture services: `Services/OnchainSnapshotService.swift`.
  - Agent module lifecycle timeline: `Services/SubagentManager.swift`.
  - Runtime backend boundary: `Services/RuntimeBackend.swift`, `Services/RuntimeRepository.swift`, `Services/RuntimeCommand.swift`, `Services/RuntimeQuery.swift`, `Services/RuntimeMutation.swift`.
  - Runtime product builders: `Services/RuntimeProductServices.swift`.
  - Runtime shell UI: `Views/RuntimeShellViews.swift`.

## 04.1 Checkpoint 2 Completion Audit

- Static-only boundary reduced:
  - Existing real logic before checkpoint: mock WeChat batch loading, basic briefing synthesis, agent logs, simple policy.
  - Newly connected logic: CMC status policy, Web3 symbol detection, market snapshot normalization, mock fallback labeling, enrichment cards, copy-to-clipboard, rescan logs, window rerun, group filtering rerun.
- CMC MCP status:
  - Previous result: blocked through MCP_DOCKER catalog search.
  - Current result: enabled through `mcp__crypto_skill_hub__`.
  - Loaded skill: `altcoin_token_profile`.
  - Verified parameters: `{"symbol":"BTC","convert":"USD"}`, `{"symbol":"ETH","convert":"USD"}`, `{"symbol":"SOL","convert":"USD"}`.
  - Normalized snapshot: BTC 76564.662284 USD / 24h +1.18%; ETH 2113.979146 USD / 24h +2.16%; SOL 85.656062 USD / 24h +1.00%.
  - Runtime boundary: Swift app uses the loaded normalized snapshot; fresh live refresh still belongs to the external agent/MCP execution boundary.
- Minimum Web3 association:
  - Mock WeChat messages now include BTC, ETH L2, SOL, and Web3 mentions.
  - `Web3SignalService` maps those mentions to market context and `Web3RadarView` displays the enrichment.

## 04.2 Checkpoint 3 Four-End Audit

- Desktop end: effective. The SwiftUI app shows dashboard, Web3 freshness, runID, artifact status, sync status, copy summary, group selection, time-window rerun, and smoke-check mode.
- Agent end: effective. `AgentOrchestrator` now performs policy checks, fixture loading, time filtering, CMC snapshot loading, Web3 enrichment, briefing generation, capability reporting, and run artifact writing.
- Data storage end: effective for MVP. `runtime/market/latest-market-snapshot.json` contains BTC/ETH/SOL normalized CMC Skill Hub data; `runtime/runs/{runID}/` contains `run.json`, `planner-envelope.json`, `policy-decisions.json`, `market-snapshot.json`, `intelligence-snapshot.json`, and `logs.json`; WeChat input can be edited in `Fixtures/wechat/messages.sample.json`.
- Operations/monitoring end: effective for MVP. `AgentSyncState` surfaces `status`, `runID`, `lastRunAt`, `lastSuccessAt`, `sourceFreshness`, `errorMessage`, and artifact path; UI shows run/freshness/artifact badges; smoke check provides a non-GUI operational probe.

## 04.3 Checkpoint 4 Personal Terminal Audit

- Desktop end: effective for the requested product skeleton. The app now has a left terminal workspace nav and concrete views for Home/Daily Brief, WeChat Intelligence Inbox, Token Terminal, Watchlist/Alerts, Agent Console, and Data/Ops Settings.
- Agent end: effective for MVP module architecture. `AgentOrchestrator` now produces normalized messages, token entities, market snapshots, on-chain fixture snapshots, alerts, source health, policy decisions, capabilities, logs, and a task-scoped agent module timeline covering Ingestion, Entity Resolver, Market Data, On-chain, Briefing, Alert, and QA/Policy.
- Data storage end: effective for local-first MVP. The smoke run wrote `runtime/wechat/messages.normalized.json`, `runtime/entities/token-entities.json`, `runtime/market/latest-market-snapshot.json`, `runtime/onchain/{chain}/{ca-or-tokenID}.json`, `runtime/alerts/alerts.json`, and full `runtime/runs/{runID}/` artifacts including `terminal-data.json` and `subagent-runs.json`.
- On-chain/token loop: effective at fixture depth. ETH and SOL CA samples are extracted from fixture messages, resolved into token entities with confidence `0.92`, linked back to related WeChat messages, and shown with market/on-chain source/freshness/confidence in Token Terminal.
- Operations/monitoring end: effective for MVP. Data/Ops shows sync state, last run/success, artifact path, storage boundary, source health, degraded reasons, and policy boundaries. Current on-chain module is intentionally `degraded` when symbol-only BTC has no CA/provider.
- Development execution subagents: not used in this checkpoint, so no development subagent lifecycle handoff artifact was required. Product runtime agent module runs are still lifecycle-recorded in `subagent-runs.json`.

## 04.4 Next-Stage Consistency Audit

- Documentation status: synchronized. `README.md` now points to the runtime overhaul plan instead of implying the current skeleton is complete product runtime.
- Plan status: archived completed plan at `wiki/history/plan/2026-05-24-plan-completed-runtime-data-agent-ops-overhaul.md`.
- Required next-stage concepts now documented: `RuntimeBackend`, `RuntimeRepository`, command/query/mutation boundary, `EvidenceItem`, `UserTask`, `WatchlistItem`, `AlertRule`, `ArtifactReference`, `RuntimeHealthCheck`, `AgentModuleRun`, bottom operations deck, right inspector, artifact manifest, runtime health, and stop conditions.
- Implementation status: pending. These concepts are now plan requirements, not yet completed code.

## 04.5 Checkpoint 6 Runtime Overhaul Audit

- Desktop end: effective at trial-runtime depth. UI has Top Command Bar, Left Nav, Main Workspace, Right Inspector, and Bottom Operations Deck. Message selection, token opening, task creation, watchlist add, alert status changes, evidence copy, and artifact selection route through `RuntimeBackend`.
- Runtime Backend end: effective. `RuntimeBackend` handles `RuntimeCommand`; `RuntimeRepository` mediates refresh and store persistence; `RuntimeQuery` and `RuntimeMutation` define the query/mutation boundary. Backend has no live WeChat, MCP, or secret-writing path.
- Data management end: effective. JSON stores now cover normalized WeChat messages, token entities, market snapshots, on-chain snapshots, evidence, tasks, watchlist, alerts, alert rules, artifact manifest, runtime health, and agent run artifacts.
- Agent Runtime end: effective. Refresh is represented as a nine-module pipeline with `AgentModuleRun` records and produced artifacts. The planner task type is now `wechat_onchain_terminal_runtime_refresh`.
- Ops end: effective. Runtime health records writable runtime, latest run, market freshness, on-chain degraded reason, policy matrix, artifact completeness, protected-reference boundary, import/export boundary, and secrets boundary.
- Core workflow: effective and verifiable. Latest smoke run proves `Message -> Token -> Evidence -> Alert/Task -> Artifact` through normalized messages, token entities, evidence bundles, alerts/tasks/watchlist/rules, and manifest/run artifacts.
- Boundary labels: explicit. WeChat fixture is `fresh`, market snapshot is `fresh`, on-chain provider is `degraded/fixture`, live WeChat is `blocked`, wechat-cli export is `needs_confirmation`, and Swift app stores no secrets.
- Known residual limitation: on-chain live provider is not connected and remains intentionally degraded. This is acceptable under the plan because live data must not be fabricated.

## 04.6 Checkpoint 7 Yansu-Inspired PRD Audit

- Documentation status: archived completed PRD at `wiki/history/prd/2026-05-26-prd-completed-yansu-inspired-wechat-onchain-agent-console.md`.
- Reference status: Yansu is used as a product-form reference for proactive work, Listen -> Crystallize -> Solve, memory, handoff, local-first privacy, and background execution. The project does not copy Yansu branding, visual assets, or source code.
- Product direction: next iteration shifts from dashboard-first terminal to proactive agent console with Crystal Stream, Evidence Inspector, Agent Proposal, Memory, Handoff Builder, and Agent Run Deck.
- Architecture direction: current `RuntimeBackend`, `RuntimeRepository`, `RuntimeCommand`, `RuntimeQuery`, `RuntimeMutation`, and `AgentOrchestrator` boundaries remain the base. New planned stores cover crystals, proposals, memory, handoffs, and proactive sessions.
- Four-end conclusion: desktop, agent, data storage, and runtime/Ops are effective at current MVP runtime depth; next gap is durable crystal/proposal/memory/handoff objects and quality/review telemetry.
- Boundary status: live WeChat commands remain blocked, Swift desktop still must not call MCP directly, and external live-like data must enter through normalized local JSON artifacts.

## 04.7 Checkpoint 8 Full-Phase Proactive Console Audit

- Desktop end: effective for full-phase local MVP. Home is now Crystal-first, with Crystal Stream, Agent Proposal panel, Memory Review, Handoff Builder, Bridge Contracts, expanded Inspector, and proactive bottom deck.
- Agent end: effective for local MVP. `AgentOrchestrator` now writes memory, crystal, proposal, handoff, bridge, and session module runs in addition to ingestion/entity/market/on-chain/evidence/alert/task/briefing/QA.
- Data storage end: effective for local MVP. Runtime artifacts now include `runtime/crystals/crystals.json`, `runtime/proposals/proposals.json`, `runtime/memory/memory.json`, `runtime/handoffs/index.json`, `runtime/sessions/latest-session.json`, and `runtime/bridges/{market-bridge,onchain-bridge,wechat-export-bridge}.json`.
- Runtime/Ops end: effective with expected degradation. Artifact manifest is `complete`; runtime health is `degraded` because live bridges/on-chain providers are intentionally not connected. This is acceptable because Swift still consumes normalized artifacts only.
- Command loop: effective. Runtime commands now support crystal selection, proposal accept/reject, handoff creation, useful/false-positive review memory, memory purge, and bridge artifact selection. Proposal acceptance is local and idempotent.
- Policy boundary: effective. Live WeChat, trading, sending messages, and publishing are blocked; external bridge refresh and export outside project require confirmation; local proposal/handoff actions pass.
- Verification:
  - `swift build`: `Build complete! (10.06s)`.
  - `swift test`: `Build complete! (3.28s)`.
  - `swift run WeChatIntelligenceRadar --smoke-check`: `runID=run-e46d4442-f1e7-4321-926b-c65767cc6661`, `status=degraded`, `freshness=degraded`.
  - `runtime/artifacts/manifest.json`: `completenessStatus=complete`.
  - `runtime/health/latest-health.json`: `overallStatus=degraded`.
  - Protected references: `../wechat-cli_raw` status returned no changes; `../assignment-agent-raw` new-file scan returned no files.

## 04.8 Computer Use Product-Level QA

- QA document: `wiki/history/qa/2026-05-26-qa-completed-computer-use-product-level-qa.md`.
- Method: Computer Use desktop walkthrough, local launch checks, and runtime artifact inspection.
- User-level outcome: not pass for the current Crystal-first product surface. Computer Use could operate the old dashboard app window, but the current app bundle path was inconsistent and the manually synchronized current bundle launched without a readable visible window.
- Runtime outcome: partial pass. Latest artifacts show a proactive session, 2 crystals, 2 proposals, 3 memory refs, 1 handoff ref, bridge statuses, and runtime health. This misses the planned minimum of 3 crystals and remains `degraded` due expected stale/degraded/blocked external-source boundaries.
- Critical findings:
  - `QA-P0-001`: stale app-bundle binary exposed old UI.
  - `QA-P0-002`: current bundle process launched but Computer Use timed out and System Events reported no window names.
  - `QA-P1-004`: runtime generated 2 crystals, below the phase target of at least 3.
- Safety evidence: no real WeChat app interaction, no live `wechat-cli` read command, no live MCP/RPC call, and no external export.

## 04.9 Product QA Fix Implementation

- QA document updated and archived: `wiki/history/qa/2026-05-26-qa-completed-computer-use-product-level-qa.md`.
- Desktop launch status: fixed for local MVP. `scripts/build-debug-app-bundle.sh` produces `.build/debug-app/WeChatIntelligenceRadar.app` from the current executable and resource bundle, and removes stale app-bundle paths before packaging.
- UI smoke status: fixed. Direct app executable smoke reports `ui_smoke_visible=true`, `ui_smoke_content=true`, `ui_smoke_window_number=242824`, and `ui_smoke=pass`; LaunchServices `open -W -n .build/debug-app/WeChatIntelligenceRadar.app --args --ui-smoke-check` exits successfully.
- User-level visual status: fixed. The user-provided screenshot shows the current Crystal-first workspace with Crystal Stream, action proposal, memory review, handoff builder, Inspector, and Run Deck.
- Runtime smoke status: fixed. Latest smoke run reports `runID=run-7c2fe19c-a6cc-43b4-b053-5a597a46f6f6`, `status=degraded`, and `freshness=degraded`; `runtime/crystals/crystals.json` count is `3`, `runtime/proposals/proposals.json` count is `3`, and the latest session has `createdCrystalRefs=3` plus `generatedProposalRefs=3`.
- Search status: fixed. The top command bar now filters runtime-backed messages, tokens, crystals, proposals, handoffs, and watchlist items through `DashboardViewModel.searchQuery`.
- Handoff lifecycle status: fixed for local MVP. Handoffs can be archived and archived handoffs can be purged; the handoff index upserts instead of replacing unrelated entries.
- Ops clarity status: fixed for local MVP. Source freshness, bridge status, permission state, and action status are localized and shown as `fresh/stale/degraded/blocked/needs_confirmation/pass` equivalents with reasons and local actions.
- Verification:
  - `swift build --scratch-path /private/tmp/wechat-radar-build`: `Build complete! (0.31s)`.
  - `swift test --scratch-path /private/tmp/wechat-radar-test-build`: `Build complete! (182.90s)`.
  - `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --smoke-check`: pass with run artifact under `runtime/runs/run-7c2fe19c-a6cc-43b4-b053-5a597a46f6f6`.
  - `scripts/build-debug-app-bundle.sh`: pass, produced `.build/debug-app/WeChatIntelligenceRadar.app`.
  - `.build/debug-app/WeChatIntelligenceRadar.app/Contents/MacOS/WeChatIntelligenceRadar --ui-smoke-check`: pass.
  - `open -W -n .build/debug-app/WeChatIntelligenceRadar.app --args --ui-smoke-check`: pass.
- Safety evidence: no live WeChat command, no live MCP/RPC command, no export outside the project, and no edits to `assignment-agent-raw` or `wechat-cli_raw`.

## 04.10 Agent Operation Space v1 Audit

- Documentation: archived completed plan at `wiki/history/plan/2026-05-27-plan-completed-agent-operation-space-v1-pi-compatible-daemon.md`.
- Desktop end: upgraded. `Agent 操作台` now has a four-zone Agent workspace: sessions/long tasks/plugin palette, Chat Stream, Agent Inspector, and Agent Run Deck.
- Agent daemon end: added. `agent-runtime/bin/wechat-agent-daemon.mjs` exposes local HTTP/SSE APIs, writes `runtime/agent/` sessions/tasks/runs, and supports smoke-check without model keys.
- Pi-compatible structure: added `agent-runtime/extensions/`, `agent-runtime/skills/`, `agent-runtime/prompts/`, `runtime/capability-registry.json`, and `runtime/model-providers.json`.
- Tool/plugin end: added. First manifest covers `wechat.read_normalized_messages`, `token.resolve_entities`, `market.read_snapshot`, `onchain.read_snapshot`, `crystal.create_or_update`, `proposal.create`, `memory.save`, `handoff.write`, `image.analyze_with_kimi`, and `computer_use.request`.
- Provider end: added. DeepSeek is text/planning/tool provider; Kimi is vision provider. Readiness checks require `DEEPSEEK_API_KEY` and `KIMI_API_KEY` from environment variables only.
- Attachment end: added. Swift copies selected image files into local runtime attachment artifacts, computes sha256, records mime/size/path, and selects the Kimi image analysis tool.
- Policy boundary: preserved. live WeChat, live `wechat-cli`, trade, send message, and external publish remain blocked; Computer Use is `needs_confirmation` and not executed in v1.
- Verification:
  - `node agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check`: pass.
  - `GET /health` against foreground daemon: pass.
  - `swift build --scratch-path /private/tmp/wechat-radar-build`: `Build complete! (11.63s)`.
  - `swift test --scratch-path /private/tmp/wechat-radar-test-build`: `Build complete! (12.74s)`.
  - `scripts/build-debug-app-bundle.sh`: pass.
  - app `--ui-smoke-check`: `ui_smoke=pass`, `ui_smoke_window_number=243957`.
- Safety evidence: no user-provided API key found in project/runtime scan; implementation stores only env var names and redacted provider status.

## 04.11 Assistant-UI Agent Workspace V2 Audit

- Documentation source: `wiki/history/plan/2026-05-27-plan-completed-assistant-ui-inspired-agent-chat-workspace.md`.
- QA record: `wiki/history/qa/2026-05-27-qa-completed-assistant-ui-agent-workspace-v2-qa.md`.
- Desktop end: upgraded. `Agent 操作台` now opens as a thread-first Agent workspace with task templates, left rail sessions/long tasks/context/capabilities, central message parts, Composer context composition, Inspector, and compact run status.
- Frontend state boundary: added `AgentWorkspaceV2Models.swift` with thread/message/part/capability/approval/context/run state and `AgentWorkspaceStateAdapter`, so SwiftUI renders user-facing ChatUI state instead of raw daemon events.
- Inline collaboration: added plan summary blocks, capability cards, approval/blocked cards, evidence/context chips, attachment cards, final output cards, and user-facing Chinese copy for model/provider/policy/artifact concepts.
- Long task UX: long tasks are visible as task cards with status and resume target; pause/resume/cancel controls moved into the compact run bar with expandable run details.
- UI smoke path: `--ui-smoke-check` now starts directly on `Agent Console` so the desktop acceptance path verifies the Agent workspace main route.
- Verification:
  - `swift build --scratch-path /private/tmp/wechat-radar-build`: pass.
  - `swift test --scratch-path /private/tmp/wechat-radar-test-build`: pass.
  - `node agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check`: pass, `run-9b49ebba-8540-43b1-ae24-301a148e87f6`.
  - `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --smoke-check`: pass, `run-4dd60389-5617-422c-90ad-e75a5e71827d`, `status=degraded`, `freshness=degraded`.
  - `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check`: pass, `ui_smoke_workspace=Agent Console`, `ui_smoke=pass`.
  - `scripts/build-debug-app-bundle.sh`: pass.
  - `.build/debug-app/WeChatIntelligenceRadar.app/Contents/MacOS/WeChatIntelligenceRadar --ui-smoke-check`: pass.
  - `open -W -n .build/debug-app/WeChatIntelligenceRadar.app --args --ui-smoke-check`: pass.
- Safety evidence: no live WeChat command, no live MCP/RPC command, no trading/send/publish execution, no raw API key material found, no changes detected in `wechat-cli_raw`, and timestamp check found no modified files under `assignment-agent-raw` or `wechat-cli_raw`.

## 04.12 Current Project Structure / Agent Capability Sync

- Current architecture document: `wiki/architecture/2026-05-27-project-structure-agent-capability-sync.md`.
- Wiki history archive index: `wiki/history/README.md`.
- Project structure status: synchronized. Active docs now distinguish current architecture from completed or superseded historical plans.
- Desktop capability: effective for local MVP. SwiftUI exposes Home, WeChat Inbox, Token Terminal, Watchlist/Alerts, Agent 工作空间, and Data/Ops.
- Swift product runtime capability: effective for local MVP. `DashboardViewModel -> RuntimeBackend -> RuntimeRepository -> AgentOrchestrator -> stores -> UI` handles refresh, command/query/mutation, proactive objects, artifact manifest, and runtime health.
- Agent workspace capability: effective for local MVP. `AgentWorkspaceV2 -> AgentDaemonClient -> Agent Runtime Host -> extension packages -> internal tools -> runtime/agent artifacts -> product-mutations -> Swift import` is now the explicit execution boundary.
- Data capability: effective for local artifact storage. JSON runtime paths cover messages, token entities, market/on-chain snapshots, evidence, crystals, proposals, memory, handoffs, product runs, agent runs, sessions, attachments, tasks, bridge status, health, and manifest.
- Ops capability: effective for local MVP. runID, freshness, policy decision, provider readiness, bridge status, artifact completeness, and daemon health are visible through runtime artifacts and UI state.
- Contract-only or degraded capability: live model provider smoke, market/on-chain live bridge, production daemon supervision, real Computer Use execution, real WeChat read, trade/send/publish.
- Documentation archive status: completed plan/PRD/QA docs moved under `wiki/history/{plan,prd,qa}`; superseded backend audit moved under `wiki/history/architecture`.

## 04.13 Agent Extension Package / Ops Decoupling

- Current architecture document: `wiki/architecture/2026-05-28-agent-extension-package-ops-decoupling.md`.
- Project agent rules: `agent.md`.
- Agent runtime wiki: `agent-runtime/wiki/AGENT_RUNTIME_WIKI.md`.
- Public Agent surface: `agent-runtime/runtime/public-surface.json`; it exposes skills, extensions, templates, and `internalToolsExposed=false`.
- Swift frontend: Agent workspace now selects Skill/Extension IDs instead of raw tool names. Internal tool/provider/module names are not presented as user-selectable frontend options.
- Runtime Host: `agent-runtime/bin/wechat-agent-daemon.mjs` discovers extension packages and maps selected skills/extensions to internal tools.
- WeChatCLI extension: `agent-runtime/extensions/wechat-cli/` migrates export normalization and command capability contracts while keeping live WeChat/wechat-cli actions blocked.
- CMC Skill Hub extension: `agent-runtime/extensions/cmc-skill-hub/` provides fixture, normalized-file, and optional MCP provider backends for CMC market evidence.
- Ops decoupling: Agent run artifacts remain under `runtime/agent/`; provider/dependency/health/policy read-models are written under `runtime/ops/`.
- Verification checkpoint: daemon smoke passed and wrote both extension outputs; `swift build --scratch-path /private/tmp/wechat-radar-build`, `swift test --scratch-path /private/tmp/wechat-radar-test-build`, and `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check` all passed after using an unsandboxed module cache.

## 05 Retrospective

- The current MVP prioritizes a visible product surface and a replaceable adapter boundary over live data access.
- The dashboard uses static fixture intelligence to validate UX and agent flow before connecting sensitive local WeChat data.
- SwiftPM provided the fastest verifiable path, but a later production-grade app can add an Xcode project, app icon, signing settings, and persisted preferences without changing the current agent/data boundaries.
- CMC integration is now loaded through Crypto Skill Hub for a BTC/ETH/SOL normalized snapshot. The next production step is an automated MCP bridge refresh path rather than another static fallback table.
- The Web3 panel is intentionally compact. If more market narratives are required, add a tab or detail drawer instead of crowding the first dashboard.
- The four-end architecture is now present at MVP depth. Remaining production hardening should focus on retention/purge, signed app path handling, real XCTest/Testing integration when the toolchain exposes the modules, and controlled user-import of exported WeChat JSON.
- The Yansu-inspired review clarifies the next product jump: the app should become a proactive, evidence-first operating console rather than a static terminal screen. The highest-leverage next implementation is Crystal MVP before broader live integrations.
- The full-phase local MVP is now in place. The next meaningful product risk is no longer missing objects, but ranking quality, retention/purge semantics across historic run artifacts, and extension-package quality for permissioned external inputs.
- Computer Use QA exposed a launch-path risk: runtime artifacts can look healthy while the user-opened `.app` serves stale or inaccessible UI. Future acceptance must test the exact app bundle a user opens, not only the direct SwiftPM executable and smoke-check path.
- The QA fix confirmed that launch determinism needs its own product gate. The debug bundle script and `--ui-smoke-check` should remain part of every desktop acceptance run until a signed Xcode packaging path replaces them.
- The Agent operation-space v1 separates UI control from execution runtime more cleanly than earlier in-process agent logic. The next hardening step is daemon lifecycle management, live provider smoke with rotated keys, and a stronger background-process strategy beyond local scripts.
- The Assistant-UI V2 iteration confirms the core product surface should be task/thread-first, with runtime artifacts available as details rather than the primary information architecture. The next product risk is quality of actual model/tool results, not whether the user can see and manage the Agent process.
- The Extension Package adjustment removes a future scaling risk: adding CMC, WeChatCLI, and later vertical capabilities should happen by package manifest/provider/normalizer/policy modules, not by exposing raw tool plumbing to the user.
- Ops should remain a read-model over Agent artifacts. Putting health aggregation inside the Agent planner creates confusing ownership and makes long-term operations harder to test.

## 06 Changelog

- 2026-05-24: Created isolated SwiftUI MVP scaffold, agent service boundaries, mock data adapter, and dynamic tree wiki.
- 2026-05-24: Verified local build and recorded reference-project protection evidence.
- 2026-05-24: Added Web3/CMC agent data chain, CMC blocked evidence, mock market fallback, Web3 Radar UI, and control wiring checkpoint.
- 2026-05-24: Loaded `mcp__crypto_skill_hub__` output into agent-side CMC provider via `CMCSkillHubCapability`; CMC capability now reports enabled with mock market standby.
- 2026-05-24: Implemented runtime market storage, CMC refresh bridge, persistent run artifacts, sync state, fixture-file adapter, real time-window filtering, smoke-check mode, and SwiftPM test target.
- 2026-05-24: Upgraded to a multi-workspace terminal shell, added token/CA resolution, normalized local stores, on-chain fixture snapshots, alert artifacts, task-scoped agent module timeline, and checkpoint 4 smoke/runtime verification.
- 2026-05-24: Synchronized next-stage docs around runtime backend, data management, agent pipeline, Ops health, bottom operations deck, and explicit stop/completion conditions.
- 2026-05-24: Implemented runtime backend, repository, command/query/mutation boundary, evidence/task/watchlist/alert-rule/manifest/health stores, nine-module agent pipeline, runtime shell UI, and smoke-verified artifacts.
- 2026-05-26: Added Yansu-inspired proactive console PRD and development breakdown covering Crystal Stream, Agent Proposal, Memory, Handoff, Proactive Session, runtime stores, agent modules, UI/UX direction, and four-end conclusion.
- 2026-05-26: Implemented full-phase proactive console local MVP: proactive models, stores, crystalizer, proposal planner, memory review, handoff draft, bridge contracts, session writer, Crystal-first UI, runtime commands, tests, smoke artifacts, and policy/Ops checks.
- 2026-05-26: Added Computer Use product-level QA document; recorded stale app-bundle launch, current-window operability blocker, runtime crystal-count gap, and next acceptance gates.
- 2026-05-26: Fixed product-level QA blockers: deterministic debug app bundle, visible-window UI smoke, runtime 3-crystal smoke, runtime search filters, handoff archive/purge, Chinese-first polish, and QA verification record.
- 2026-05-27: Implemented Agent operation space v1 with Pi-compatible local daemon, chat stream UI, tool/skill palette, image attachment artifacts, long-task run artifacts, provider readiness, and policy-visible tool calls.
- 2026-05-27: Implemented Assistant-UI inspired Agent workspace V2 with thread-first SwiftUI layout, V2 state adapter, Composer context composition, inline capability/approval/result cards, Inspector, compact run bar, Agent-console UI smoke path, and QA record.
- 2026-05-27: Added 后端 / Agent / 数据能力审计，覆盖当前服务能力、Pi-compatible daemon 状态、数据获取、存储映射、生命周期管理、真实能力与契约能力区分，以及下一阶段后端路线图。
- 2026-05-27: Implemented PiAgent-backed backend补足：`agent-runtime` 引入 pinned `@earendil-works/pi-coding-agent@0.75.5`，daemon 通过 Pi SDK `DefaultResourceLoader` 加载本项目 extension/skills/prompts，工具改为真实 `pi.registerTool(...)`，并新增 product mutation inbox 与 Swift 导入边界。
- 2026-05-27: Synchronized current project structure and Agent capability status; created `wiki/history/` archive index; moved completed/superseded plan, PRD, architecture, and QA docs into history with status/category naming.
- 2026-05-28: Adjusted Agent architecture to public Skill/Extension surface, added extension package loader, migrated WeChatCLI export contract and CMC Skill Hub market evidence as packages, split Ops Runtime status under `runtime/ops/`, and added project/agent runtime wiki rules.

## 07 Project Rules

- `assignment-agent-raw` and `wechat-cli_raw` are read-only references.
- Do not run `wechat-cli init`, `wechat-cli history`, `wechat-cli search`, or any local command that reads the user's current WeChat data unless the user explicitly authorizes that step.
- CoinMarketCap MCP live data requires an active callable MCP tool/connector and required permissions or API key. Current loaded source is `mcp__crypto_skill_hub__` / `altcoin_token_profile`; if unavailable, show `blocked` or `degraded`; never label mock fixture values as live CMC data.
- Every completed `/goal` must append a checkpoint to this wiki with plan, implementation, issues, fixes, verification, retrospective, and TODO.
- User-facing Agent capability selection must remain Skill/Extension only. Internal tools, providers, normalizers, and policy implementations belong in runtime artifacts and developer docs, not the frontend palette.
- Agent/Ops ownership is split: Agent writes task artifacts; Ops reads those artifacts and writes health/status summaries.

## 08 Next TODO

- Replace the seeded CMC Skill Hub snapshot with an external agent-produced `runtime/market/latest-market-snapshot.json` refresh job when a stable MCP execution runner is available.
- Replace compatibility `subagent-runs.json` naming once no downstream consumer depends on it.
- Persist user-selected time window and dashboard mode in app settings.
- Add proper XCTest or Swift Testing assertions when the local toolchain exposes either module to SwiftPM test targets.
- Replace fixture on-chain snapshots with a permissioned external DEX/RPC bridge that writes normalized JSON and source/freshness/confidence.
- Consider a detail drawer for each Web3 enrichment card if the first screen becomes too dense.
- Add retention/purge controls for `runtime/runs`.
- Harden cross-run memory retention and purge semantics so historic run artifacts cannot surprise the user after a memory purge.
- Extend additional data abilities as Agent extension packages with manifest, provider, normalizer, schema, policy, fixture, and smoke path.
- Investigate Computer Use app-state attachment reliability separately from product launch smoke, so future QA can combine UI tree operation with the current app-bundle path.
- 已选择下一阶段后端路线：采用 Agent Runtime Host，不 shell out 到全局 `pi` CLI，且默认禁用 `bash/edit/write` built-in 工具。
- Replace the debug bundle script with a signed Xcode packaging path when this project moves beyond local MVP.
- Add LaunchAgent or supervised daemon lifecycle only after the local script daemon path is stable.
- Run live DeepSeek/Kimi smoke after rotating the API keys exposed in chat and loading them through environment variables.
- Add true Computer Use execution only after a dedicated confirmation and audit UX exists.

## 09 QA

- 2026-05-29: Agent extension / skill capability QA：`wiki/qa/2026-05-29-agent-extension-skill-capability-qa.md`.
- 2026-05-26: Product-level Computer Use QA archived: `wiki/history/qa/2026-05-26-qa-completed-computer-use-product-level-qa.md`.
- 2026-05-27: Assistant-UI Agent Workspace V2 QA archived: `wiki/history/qa/2026-05-27-qa-completed-assistant-ui-agent-workspace-v2-qa.md`.

## 10 Architecture

- 2026-05-27: 当前项目结构与 Agent 能力同步：`wiki/architecture/2026-05-27-project-structure-agent-capability-sync.md`。
- 2026-05-27: PiAgent-backed runtime adoption：`wiki/architecture/2026-05-27-piagent-backed-runtime-adoption.md`。
- 2026-05-28: Agent Extension Package / Ops 解耦：`wiki/architecture/2026-05-28-agent-extension-package-ops-decoupling.md`。
- 2026-05-28: Research OS frontend redesign：`wiki/architecture/2026-05-28-research-os-frontend-redesign.md`。
- 2026-05-29: Apple minimal workbench redesign：`wiki/architecture/2026-05-29-apple-minimal-workbench-redesign.md`。
- 2026-05-29: Agent workbench layout / ability palette：`wiki/architecture/2026-05-29-agent-workbench-layout-ability-palette.md`。
- 2026-05-29: Context Plane comparative audit：`wiki/architecture/2026-05-29-context-plane-comparative-audit.md`。
- 2026-05-29: Agent Runtime control plane comparative audit：`wiki/architecture/2026-05-29-agent-runtime-control-plane-comparative-audit.md`。
- 2026-05-29: Agent Runtime control/context implementation record：`wiki/architecture/2026-05-29-agent-runtime-control-plane-context-plane-implementation-record.md`。
- 2026-05-29: Agent Runtime / Swift adapter audit and fix：`wiki/architecture/2026-05-29-agent-swift-adapter-audit-and-fix.md`。
- 2026-05-27: 后端 / Agent / 数据能力审计已归档为 superseded：`wiki/history/architecture/2026-05-27-architecture-superseded-backend-agent-data-capability-audit.md`。
- History archive index：`wiki/history/README.md`。
