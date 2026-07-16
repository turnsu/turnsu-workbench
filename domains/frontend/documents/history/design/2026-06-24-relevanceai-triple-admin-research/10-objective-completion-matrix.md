# Objective Completion Matrix

本文把原始目标拆成可验收条目，并标注当前证据等级。它的目的不是替代 `06-completion-audit.md`，而是给人工 review 一张逐项核对表：哪些已经由当前 worktree 和命令输出证明，哪些只是部分证明，哪些明确不声称完成。

## Evidence Levels

| Level | 含义 |
| --- | --- |
| Proven | 有当前源码、文档、截图、命令输出或本地运行态证据，且证据覆盖该要求的实际范围。 |
| Partially proven | 已有实现或检查，但证据范围比要求窄，仍需要人工 review 或后续 hardening。 |
| Not claimed | 当前没有足够证据，不把它写成已完成。 |

## Evidence Ledger

| Claim | Evidence type | Command or artifact | Latest count | Boundary |
| --- | --- | --- | --- | --- |
| Web prototype surface and source contract | Source smoke | `npm run smoke` in `web-prototype/` | `web_prototype_testids=177`, `forbidden_terms=0`, `surfaces=6`; includes Review Guide evidence map, traceability, decision board, record handoff, command preview, local persistence anchors and Builder patch receipt anchors | Proves source anchors and static contracts, not visual parity by itself |
| Web shared interaction model | Source plus action smoke | `src/loopopsModel.js`, `npm run action:smoke` | shared readiness, resource binding, tool validation, knowledge and stack rules; `web_action_smoke=pass` | Proves App and action-smoke share core pure rules; React state wiring is still reviewed through App events and smoke anchors |
| Web no-permission review path | Build plus offline fallback | `npm run review:no-permission`, `npm run review:offline` | offline artifact `dist/loopops-admin-offline.html`, no auto-open, no system automation | If sandbox blocks localhost or WebKit file navigation, DOM smoke is explicitly skipped rather than misreported |
| Unified manual review preflight | Web + native no-permission scripts plus review session packet | `scripts/review-loopops-all.command` | Prints Web URL/offline HTML, native app bundle, native checklist, completion matrix; writes `review-sessions/loopops-session-*.md/.json` plus Web/native logs with the actual parsed review entry | Aggregates review preparation without opening browser, app, Accessibility, AppleScript, or screen recording; avoids stale fixed-port assumptions when Vite switches ports |
| Agent-team traceability audit | Static module-chain verifier | `scripts/verify-loopops-traceability.command`, `14-agent-team-traceability-matrix.md` | `loopops_traceability=pass`, `loopops_traceability_modules=8` | Proves repo-level mapping from research to implementation and review evidence; does not provide raw sub-agent transcript logs |
| Executable objective audit | End-to-end local CLI audit | `scripts/audit-loopops-objective.command` | Verifies traceability, docs, reference screenshots, desktop/mobile Product Design screenshot manifests (`15` shots, no horizontal overflow, `05a` Create Tool import, `05b` Tool Logs validation, `06a` Builder receipt, `08b` Knowledge source detail), Web smoke/action/no-permission review, Swift/native action wiring, full `swift test`, review script permission model, and manual record artifacts | Outputs pass/fail evidence without opening browsers, apps, Accessibility, AppleScript, screen recording, or external UI automation |
| Manual review record artifact | Local Markdown + JSON recorder | `scripts/record-loopops-review.command` | Generates timestamped `review-records/loopops-review-*.md` and `.json` with status/blockers/notes | Does not claim pass by default; records human review outcome without opening apps, browsers, Accessibility, AppleScript, or screen recording |
| Swift LoopOps action wiring | In-process action harness | `swift run WeChatIntelligenceRadar --loopops-ui-action-check` | `required_identifier_count=152`, `dynamic_identifier_count=17`, `action_summary_count=53`; includes native Review Guide evidence map, traceability, decision board, record handoff, Studio Builder patch receipt, Builder Packet apply/reject/save, Global Chat send, Run Chat lock, run lifecycle receipts and Tool Log Review Chat | Proves stable anchors and state transitions, including native Workbench Review Guide paths/checklist/evidence map/traceability/decision/record handoff plus Builder Chat structured patch feedback and Global Chat action wiring, not external AppKit pixel clicks |
| Swift native interaction coverage | No-permission coverage and replay | `--loopops-interaction-coverage-check`, `--loopops-interaction-replay-check` | `44` anchored, state-backed, no-permission replay steps; replay steps include `Studio|Apply Builder Chat patch receipt`, Builder Packet apply/reject/save, `Global Chat|Send workspace-scoped chat`, `Run Result chat locked to run scope`, run lifecycle actions, and Tool Log Review Chat before/after state | Explicitly records `native_appkit_clicks_verified=false` |
| Swift native activation wiring | In-process activation harness | `--loopops-native-activation-check`, `13-native-manual-review-checklist.md` | `26` activation targets plus manual native review map; includes `global_chat_send=true`, `tool_log_review_chat=true`, `builder_packet_apply=true`, `builder_packet_reject=true`, `builder_packet_save=true`, `run_chat_locked_scope=true`, `run_lifecycle_actions=true`, `run_lifecycle_updates_run_chat=true`, `run_lifecycle_updates_share_safe_log=true`, `workbench_evidence_map_sources=4`, `workbench_review_decision_board=true`, `workbench_traceability_modules=8`, `workbench_review_record_handoff=true`, `workbench_review_record_preview=true` and `workbench_review_state_persistence=true` | Verifies SwiftUI action wiring without Accessibility, AppleScript, screen recording or browser control; manual checklist records the remaining visual/product review |
| Swift native visual surfaces | Offscreen SwiftUI screenshot capture | `swift run --disable-sandbox WeChatIntelligenceRadar --loopops-native-visual-capture`, `native-visual-audit/loopops-native-visual-2026-06-27-155147/README.md` | `capture_count=6`, `nonblank_count=6`; Workbench, Loop Library, Skill OS, Knowledge, Chat and Studio; latest native packet records `visualResult=pass` | Screenshot-level native product evidence without `open`, Accessibility, AppleScript, screen recording, Chrome/Safari or external AppKit click automation; explicitly not pixel-click proof |
| Swift visible copy privacy | Contract check | `swift run WeChatIntelligenceRadar --contract-check` | `agent_runtime_contracts=pass` | Checks representative LoopOps visible copy for old `gate/runtime/provider` phrasing; does not replace human review of every pixel |
| Sub-agent process evidence | Read-only audit summaries plus traceability matrix plus product-visible guide | `07-agent-team-final-audit.md`, `14-agent-team-traceability-matrix.md`, `Workbench Review Guide`, `scripts/verify-loopops-traceability.command` | `8` trace modules map research docs, screenshots, source anchors, automated evidence and manual review routes; native evidence includes `workbench_traceability_modules=8` | Repo-level and product-visible evidence is now strong; raw transcript-level proof is still not claimed |

## Requirement Matrix

| 原始要求 | 当前落地 | 主要证据 | 等级 | 仍需人工看什么 |
| --- | --- | --- | --- | --- |
| 使用 `$design-taste-frontend` / `$impeccable` / `@product-design` 的设计原则，不做通用 AI slop UI | 当前产品上下文明确为 product UI，设计语言收敛到 Notion/RelevanceAI database rows、split detail、system font、低装饰、强状态反馈 | `PRODUCT.md`、`DESIGN.md`、`web-prototype/src/styles.css`、`product-design-audit-web/README.md` | Proven | 人工看 Web 和 App 是否真的安静、可扫读、少卡片嵌套、无内部 runtime 文案 |
| 深度参考 RelevanceAI marketplace/template/agent/listing 展示方式 | 已沉淀 marketplace/listing/detail/filter/readiness/install/clone/run 映射，并落到 Loop Library；Web Marketplace available template 会先 `Install to Studio`，生成 editable workspace copy，再由 Studio 继续配置；Swift/App 也补齐 install to Studio、workspace copy 来源保存和 Builder receipt | `01-marketplace-template-library.md`、`screenshots/01-relevanceai-marketplace-workforce.png`、`screenshots/02-relevanceai-marketplace-listing-detail.png`、`LoopOpsLibraryView`、Web `Loop Library`、`web_action_marketplace_install_to_studio=true`、`web_dom_marketplace_install_to_studio=true`、`loopops_action_library_marketplace_install_to_studio=true`、`loopops_interaction_replay_step_2=Loop Library|Install marketplace template to Studio...` | Proven | 对照截图看 Loop Library 行、detail、Install/Run/Clone、readiness 是否像 database/listing，而不是营销卡片；安装后确认 original template 回填 workspace copy，copy 在 Studio 可编辑 |
| 深度参考 Knowledge 和 toast 展示形式 | 已沉淀 Knowledge empty/new menu/source status/toast feedback，Swift 和 Web 均有 Knowledge surface；Web attach 会同步更新 active Run Result 的 `Knowledge` 字段、Run Chat 事件和 run-scoped attachment，并验证切换 run 后附件不泄漏 | `02-knowledge-toast-system.md`、`screenshots/04-relevanceai-knowledge-empty.png`、`screenshots/05-relevanceai-knowledge-new-modal.png`、`LoopOpsKnowledgeView`、`LoopOpsToastStack`、`web_dom_knowledge_attach_updates_run=true`、`web_dom_attachments_run_scoped=true`、Web `Knowledge` | Proven | 人工看 New Knowledge、search/filter、attach to run、toast 是否清楚且不遮挡主任务；切换 run 后确认 attachment 不串线 |
| 深度参考 Tool creation 和 logs 展示形式 | 已沉淀 New Tool starting point、Build/Use/Logs、required input validation、tool log source/review chat，并落到 Skill OS；Web Tool Log 行现在直接显示 submitted source，例如 `Import`；Loop run 会生成 run-bound Tool logs，Run Result 可打开 Review Chat 且保留 `runId/toolLogId`；截图审计也补了 Create Tool import modal 和 Tool Logs validation 两个可视状态 | `03-tool-creation-logs.md`、`screenshots/06` 到 `09`、`LoopOpsSkillOSView`、Web `Skill OS`、`web_dom_tool_log_source_visible=true`、`web_dom_run_tool_logs_bound=true`、`web_dom_run_tool_log_review_chat=true`、`web_audit_capture_count=15`、`product-design-audit-web/05a-skill-os-create-tool-import.png`、`product-design-audit-web/05b-skill-os-tool-logs-validation.png`、`npm run review:no-permission` | Proven | 人工看 `Default / Invent / Import`、Tool name、Input scope、Use validation、Logs isolation、source 列和 Run Result 下的 Tool logs |
| 参考 Triple/T3 简洁 chatbot 和快捷 GUI | 已把 quick GUI 映射到 scoped chat：model、Instant/Deep、Search、Attach/附件、Temporary、Create/Explore/Code/Learn、run/builder/review scope；Browser clickthrough 已点击 Chat quick GUI toggle | `04-triple-chat-quick-gui.md`、T3 public DOM literal、`LoopOpsScopedChatPanel`、Web `Chat` / `Run Chat`、`11-browser-clickthrough-review.md`、`12-remaining-decision-contract.md` | Proven for quick-GUI scope; Not claimed for unknown Triple product body | 默认按 quick-GUI scope 收口；如果用户提供具体 Triple URL，再补完整产品本体研究 |
| 每个模块先由 sub agent 深入获取信息、总结文档，再开发落地 | Repo 内记录了多轮只读 sub-agent 分工、审计结论、响应补丁和边界；新增 traceability matrix 把八个模块逐一映射到 research docs、screenshots、Web/Swift source anchors、evidence receipts 和 manual review path | `07-agent-team-final-audit.md`、`08-evidence-receipts.md`、`14-agent-team-traceability-matrix.md`、`scripts/verify-loopops-traceability.command` | Proven for repo-level traceability; Not claimed for raw transcript logs | 人工可按 `14` 逐项核对模块链路；原始 sub-agent transcript 不在 repo 内，不作为完成声明 |
| 输出一个个模块文档 | Research index、marketplace、knowledge/toast、tool/logs、chat GUI、acceptance、audit、receipts、runbook、completion matrix 均存在 | `00` 到 `10` 系列 Markdown | Proven | 人工检查每个文档是否只引用真实截图和当前实现，不扩大事实 |
| Swift/App 与当前 App 融合 | Workbench、Loop Library、Skill OS、Knowledge、Chat、Studio、Run Result、Run Chat、Review Chat、local store、ordered skill bindings、runLoopContract、Marketplace install to Studio / workspace copy 等均落地；Skill OS public surface 已补 category allowlist，隐藏 `channel/provider/runtime/memory/unknown` 类能力，兼容无 category 的旧 public manifest；native Workbench Review Guide 现在含 Evidence Map、8 模块 traceability、Review decision board、record handoff、command preview 和 AppStorage 本地 review 草稿持久化；native manual checklist 已把人工点击路径、自动 evidence 和 offscreen visual gallery 对齐；native no-permission harness 已覆盖 Tool Log Review Chat、Builder Packet apply/reject/save、Run Chat lock、run lifecycle 和 Share-safe Log preservation | `LoopOpsModels.swift`、`LoopOpsLocalStore.swift`、`DashboardViewModel.swift`、`LoopOpsViews.swift`、`DashboardView.swift`、`TerminalWorkspaceSidebar.swift`、`BlocksWorkbenchView.swift`、`--contract-check`、`--loopops-action-check`、`--loopops-interaction-replay-check`、`--loopops-native-activation-check`、`--loopops-native-visual-capture`、`12-remaining-decision-contract.md`、`13-native-manual-review-checklist.md`、`native-visual-audit/loopops-native-visual-2026-06-27-155147/README.md` | Proven for product data flow, no-permission action wiring and screenshot-level native surfaces; Not claimed for external pixel clicks | 人工按 `13-native-manual-review-checklist.md` 看 native App，并先扫 `native-visual-audit/loopops-native-visual-2026-06-27-155147/README.md`。自动证据证明 action wiring、状态转移、Evidence Map/traceability/decision board、record preview、Saved locally 持久化、Skill OS public surface 过滤、Global Chat send、Tool Log Review Chat、Builder Packet apply/reject/save、Run Chat lock、run lifecycle、Share-safe Log preservation 和六个 native surface 非空渲染；外部 AppKit/XCUITest 像素点击需要单独授权路径 |
| Web 端交互前端应用 | Web prototype 已实现 6 个 surface、跨模块状态、Marketplace install to Studio、ready/unready run flow、Tool/Knowledge/Chat/Studio/Library 交互，支持本地人工 review；Workbench Review Guide 现在有 Evidence Map、agent-team traceability、Review decision、per-path manual review checklist、manual review record handoff、copy-ready command preview 和本地 review 草稿持久化；`src/loopopsModel.js` 让 App 和 action-smoke 共用 readiness、resource binding、tool validation、knowledge/filter 和 Skill Stack 规则；本轮 `review:offline` 单文件 fallback 避免 localhost 绑定策略让人工 review 中断；desktop/mobile screenshot manifests 已刷新为 15 步且无 horizontal overflow | `web-prototype/src/App.jsx`、`web-prototype/src/loopopsModel.js`、`web-prototype/src/styles.css`、`npm run smoke`、`npm run action:smoke`、`npm run review:no-permission`、`npm run review:offline`、`web_dom_review_guide_evidence_map=true`、`web_dom_review_record_handoff=true`、`web_dom_review_record_preview=true`、`web_dom_review_state_persistence=true`、`web_dom_library_primary_row_run=true`、`web_dom_marketplace_install_to_studio=true`、`product-design-audit-web/`、`product-design-audit-web-mobile/`、`11-browser-clickthrough-review.md` | Proven | 首选打开当前 live review URL `http://127.0.0.1:5188/`；如果端口绑定被策略阻止，打开 `dist/loopops-admin-offline.html`。先看 Review Guide 的 Evidence Map、Agent team traceability、Review decision、Review checklist、record handoff、command preview 和 `Saved locally` 状态，再按四条 path 逐项点，特别检查 Marketplace template install 到 Studio 的 editable copy |
| 可以同时运行多个 loops，结果面板和 Run Chat 隔离 | Swift action/acceptance harness、Web action smoke 与 WebKit DOM smoke 均验证多 run、same contract repeat、unique run IDs、run-scoped chat isolation；Browser clickthrough 中批量运行后 active queue 显示 3 条 run | `--loopops-acceptance-check`、`--loopops-action-check`、`npm run action:smoke`、`web_dom_multi_run_queue=true`、`web_dom_run_chat_isolated=true`、`web_dom_same_loop_repeat_isolated=true`、`11-browser-clickthrough-review.md` | Proven at model/Web DOM level; partially proven at native pixel level | 人工在 Web 切换 2-3 个 run 看 Final Answer / Review Packet；native 仍缺 AppKit/XCUITest 全链路点击 |
| Skill OS 可拖拽、排序、勾选、保存 skill stack | Swift 有 `LoopOpsSkillBinding`、`LoopOpsSkillStack`、drop resolver、Studio execution path；Skill OS package adapter 使用 public category allowlist；Web smoke 覆盖 drag add/reorder | `LoopOpsModels.swift`、`LoopOpsSkillPathDropResolver`、`LoopOpsSkillPathEditor`、`checkLoopOpsPublicSkillPolicyHidesInternalPackages()`、`web_dom_stack_drag_add=true`、`web_dom_stack_drag_reorder=true` | Proven | 人工拖 skill 到 Studio path、排序、保存、重新打开；确认 Skill OS 不展示 provider/channel/runtime/memory 类内部能力 |
| Builder Chat 自然语言更新 draft steps/gate/exit/output/skill path | Swift builder parser 现在支持英文结构化标签、`review rule`、中文 `步骤 / 调用顺序 / 反馈 / 退出条件 / 输出格式`，也能从无字段名中英文自由描述里推断“先用 A、然后用 B、再用 C、最后输出...”或 “first use A, then use B, finally output...” 的 visible steps、ordered skill path、review rule、exit condition 和 output shape，并把 ordered skill path 写入 materialized contract 和 run prompt；Studio 内联 `Builder patch receipt` 和 Builder Chat assistant receipt，展示 fields matched、steps count、skill path、review rule、exit、output shape 或 no-match guidance；Web prototype 现在也通过 `makeBuilderDraftPatch` / `applyBuilderDraftPatch` 接入 Builder Chat receipt，action smoke 验证自然语言改 steps、ordered Skill Stack、output shape 和 chat assistant receipt，DOM smoke 真实点击 Studio Builder Chat 并验证 Loop Contract receipt、steps、output shape 和 chat transcript；截图审计新增 `06a-studio-builder-patch-receipt.png` 作为人工 review 图证据 | `LoopOpsBuilderDraftPatch.receiptText`、`LoopOpsBuilderPatchReceiptView`、`builder_patch_receipt=true`、`web_action_builder_patch_receipt=true`、`web_dom_builder_patch_receipt=true`、`web_audit_capture_count=15`、`product-design-audit-web/06a-studio-builder-patch-receipt.png`、`loopops.studio.builder-patch-receipt`、`loopops_interaction_replay_step_20=Studio|Apply Builder Chat patch receipt...`、`checkLoopOpsBuilderDraftPatchReceiptExplainsMatchedAndUnmatchedInstructions()`、`swift test`、`swift run WeChatIntelligenceRadar --contract-check`、`npm run action:smoke`、`npm run dom:smoke` | Proven for deterministic structured/freeform parser and product-visible receipt; Not claimed as general LLM engine | 人工在 Studio Builder Chat 输入带 `steps / skill path / review rule / exit / output shape` 或中文对应字段的指令，看 Loop Contract 顶部 receipt 和 chat assistant receipt 是否准确；仍不把它声称为任意自然语言都可靠的 LLM patch engine |
| 不新增外部执行能力，不绕过 review-only 边界 | 运行仍复用 `postMessageAsync`；文档和 checks 明确不新增交易、发布、发送或 tool router 权限 | `DashboardViewModel.runLoopContract`、`AgentRuntimeContractChecks.swift`、`08-evidence-receipts.md` | Proven | 人工确认 UI 只出现 review/prepare/attach，不出现 live trade/send/publish 自动执行 |
| 人工 review 不被 macOS 权限弹窗阻塞 | Web review 只提供本地 URL或离线 HTML，不打开系统浏览器；localhost 被策略拒绝时 `review:no-permission` 走 `offline_fallback` 并尝试 file DOM smoke，当前 sandbox 下明确输出 `skipped_sandbox_file_navigation`；统一 preflight 会生成 review session Markdown/JSON 和 Web/native logs，记录实际 URL（如本轮 `5188`）或离线入口，避免固定端口过期；native 回归走进程内 action harness，native screenshot-level evidence 走 offscreen `NSHostingView`，不调用 Accessibility/AppleScript/屏幕录制。`listen EPERM` 被标注为 sandbox 绑定限制，不按 macOS 隐私权限弹窗处理 | `09-no-permission-review-runbook.md`、`scripts/review-loopops-all.command`、`scripts/review-loopops-web.command`、`scripts/review-loopops-web-offline.command`、`npm run review:no-permission`、`npm run review:offline`、`--loopops-native-activation-check`、`--loopops-native-visual-capture` | Proven for current review path | 如果要外部 AppKit/XCUITest 像素点击，仍会进入另一类权限/签名问题，当前不把它作为日常 review 路径 |
| 人工 review 结果可记录、可复查 | Workbench Review Guide 现在有 `Review decision` board，可在产品内标记 pending / needs work / approved 并填写 blockers / notes；`scripts/record-loopops-review.command` 默认生成 pending Markdown + JSON，不替人声明通过；可用 `LOOPOPS_REVIEW_STATUS/BLOCKERS/NOTES` 写入人工结论 | `BlocksWorkbenchView.swift`、Web `ReviewGuide`、`09-no-permission-review-runbook.md`、`review-records/loopops-review-*.md`、`review-records/loopops-review-*.json`、`workbench_review_decision_board=true` | Proven for product-visible review decision and local record generation | 人工完成后需要把实际 blockers/notes 用脚本写入，再决定是否回填 evidence receipts |

## Completion Boundary

当前可以证明的是：研究证据、模块文档、Swift/App 主要产品数据流、Web 可点击原型、无权限 review 路径、核心模型/DOM/action smoke 都已经存在并可复跑。

当前不能证明或不声称的是：

- 未给 URL 的另一个 Triple 产品本体已被完整研究。
- Native App 已完成外部 AppKit/XCUITest 像素点击级全链路自动化。
- Web prototype 已变成生产后端实现。
- Builder Chat 已达到通用自然语言 contract patch 的可靠度。

## Manual Review Route

1. 首先运行 `scripts/review-loopops-all.command`，让 Web 与 native 的 no-permission preflight 一次性完成，并生成 `review-sessions/loopops-session-*.md`。
2. Web 以 session Markdown 里的 `Web review URL` 或 `Web review offline HTML` 为准。不要假设固定端口；如果 Vite 从 `5184` 切到 `5189` 或其他端口，session 会记录实际入口。
3. Native 手动打开 `.build/debug-app/WeChatIntelligenceRadar.app`，按 `13-native-manual-review-checklist.md` 记录结果。
4. 从 `Workbench` 的 Review Guide 进入四条路径：run queue/result、Loop Library、Skill OS、Knowledge/Chat，并先看 `Evidence map` 是否显示 4 个来源、`Agent team traceability` 是否显示 8 个模块、`Review decision` 是否能记录状态和 notes。
5. 在 `Loop Library` 打开 available Marketplace template，点击 `Install to Studio`，确认切到 `Studio` 且出现 `Workspace Copy`，再回到原 template detail 看 workspace copy 状态。
6. 在 `Loop Library` 启动一个 ready loop，再点击一个 unready loop，确认前者进入 Run Result，后者进入 setup/Builder Chat。
7. 在 `Skill OS` 打开 `Create Tool`，切换 `Invent / Default / Import`，填写 Tool name / Task description / Input scope，确认 tool row 和 log row 更新。
8. 在 `Studio` 用 Builder Chat 输入一条包含 `步骤 / 调用顺序 / 反馈 / 退出条件 / 输出格式` 的指令，确认 Loop Contract 顶部出现 `Builder patch receipt`，chat assistant 也显示 fields matched、steps count、skill path 和 output shape；再拖入 skill、重排 execution path、保存，重新切回该 loop 确认顺序不丢。
9. 在 `Knowledge` 新建 Website/Blank source，attach 到最新 run，确认 Run Result 的 `Knowledge` 字段、Run Chat scoped event 和 run-scoped attachment 都更新；再切到另一个 run，确认 attachment 不串线。
10. 同时启动 2-3 个 loops，切换 active queue，确认 Final Answer、Review Packet、Run Chat 和 Run Result 下的 Tool logs 不串线；从 Tool log 打开 Review Chat，确认带有 `runId/toolLogId`。
11. Review 结束后运行 `scripts/record-loopops-review.command`，用 `LOOPOPS_REVIEW_STATUS`、`LOOPOPS_REVIEW_BLOCKERS`、`LOOPOPS_REVIEW_NOTES` 留下人工结论。

## Verification Commands

```bash
cd domains/frontend/web/code/web-prototype
npm run review:offline
npm run review:no-permission
```

```bash
swift run WeChatIntelligenceRadar --loopops-native-activation-check
swift run WeChatIntelligenceRadar --contract-check
scripts/verify-loopops-traceability.command
scripts/audit-loopops-objective.command
scripts/review-loopops-native.command
scripts/review-loopops-all.command
scripts/record-loopops-review.command
```

剩余边界和默认收口策略见 `12-remaining-decision-contract.md`。

## 2026-06-26 Product Polish Delta

本轮根据人工 review 反馈，把 Web prototype 从“模块已存在”推进到更明确的产品交互闭环：

| 模块 | 本轮改善 | 最新证据 | 剩余边界 |
| --- | --- | --- | --- |
| Loop Library | database row 主点击直接 Run / Install / Setup；详情由 `Open` / 文档图标进入，避免主路径和详情路径混淆 | `web_dom_library_primary_row_run=true`、`web_dom_library_explicit_run_action=true`、`web_action_primary_row_action_runs=true` | Native App 已同步主行 action；仍需人工视觉复查 |
| Knowledge | starter 打开 setup panel，创建 source 前需要 visible source contract；row detail 和 Attach 分离；Ready + active run 才能 attach | `loopops.knowledge.setup-panel`、`loopops.knowledge.source-detail`、`web_dom_knowledge_attach=true`、`web_dom_attachments_run_scoped=true` | 仍不做真实 URL/file fetch，只做 review-safe source setup |
| Skill OS / Logs | Use tab 显示 active run validation context；logs 默认 All activity，支持 search/action/status/user filters，并带 run context chips | `loopops.skill-os.active-run-context`、`web_action_tool_use_validation=true`、`web_dom_tool_use_validation=true` | Create Tool 还不是完整 contract editor |
| Chat quick GUI | message transcript 显示 model/mode/search/attachment metadata；关键 quick actions 会触发真实状态变更 | `requestMeta`、`function runQuickAction(group, action)`、`updateReviewDecision?.(activeRun.id, "Reviewed")` | attachments 仍是前端 mock context，不含真实文件读取 |
| Run Result / Review Packet | Review Packet 显示 notes 和 event history，decision update 会追加 packet event | `loopops.workbench.review-packet-card`、`updateReviewDecision` event append | queue lifecycle 还缺 pause/cancel/retry/complete |

最新 Web 复核入口：

```text
http://127.0.0.1:5184/
dist/loopops-admin-offline.html
```

最新验证命令：

```text
cd domains/frontend/web/code/web-prototype
npm run smoke
npm run action:smoke
npm run build
npm run review:no-permission
git diff --check
```

## 2026-06-26 Web Closure Delta

本轮继续推进 Web prototype 的产品级闭环，以下条目已从“Web 缺口”更新为 “Web prototype proven”：

| 模块 | 新状态 | 最新证据 | 剩余边界 |
| --- | --- | --- | --- |
| Create Tool | Web prototype proven | `loopops.skill-os.tool-steps`、`loopops.skill-os.tool-outputs`、`loopops.skill-os.tool-review-rule`、`web_dom_create_tool_flow=true`、`web_action_tool_mode=Import` | 仍是前端 tool contract，不触发外部 execution |
| Builder Packet | Web prototype proven | `builderPackets`、`loopops.studio.builder-packet.apply`、`web_dom_builder_patch_receipt=true`、action smoke 验证 pending -> applied -> saved | Swift/App 尚需同等状态机对齐 |
| Queue lifecycle | Web prototype proven | `applyRunLifecycleAction(runId, action)`、`loopops.workbench.queue-action.*`、`loopops.workbench.run-events`、`loopops.workbench.review-packet-status`、`npm run action:smoke` | Web 只是本地模拟状态，不是后端 worker lifecycle |
| Run-scoped chat | Web prototype proven | `lockedScope="run"`、`loopops.workbench.run-chat-locked`、`web_dom_run_chat_isolated=true` | Swift/App 的 run-scoped chat lock 仍需单独复查 |
| Knowledge id binding | Web prototype proven | `runKnowledgeIds`、`knowledgeIds: nextKnowledgeIds`、source `linkedRunIds/activity`、`web_dom_knowledge_attach_updates_run=true` | 不做真实 URL/file fetch |
| Skill OS validation反写 run | Web prototype proven | `handleToolValidated`、run-bound log merge、`web_action_tool_use_validation=true`、`web_dom_tool_use_validation=true` | 不新增外部发布/交易/发送能力 |

最新入口：

```text
http://127.0.0.1:5184/
dist/loopops-admin-offline.html
```

最新验证命令：

```text
cd domains/frontend/web/code/web-prototype
npm run build
npm run smoke
npm run action:smoke
npm run dom:smoke
npm run review:no-permission
```
