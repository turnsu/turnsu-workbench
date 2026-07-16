# Evidence Receipts

本文记录 2026-06-24 本轮 Product Design / LoopOps 重构验收的可追踪证据。它不是设计结论本身，而是把源码、构建、运行检查和 agent-team 审计结果落成可复查凭据。

## 2026-06-27 追加 155136 Typed Run Result Native Handoff

本轮在此前 review-ready 基础上补齐 native no-permission harness 对 Web closure delta 的覆盖：Tool Log Review Chat、Builder Packet apply/reject/save、Run Result locked Run Chat、run lifecycle actions、Run Chat lifecycle receipts 和 Share-safe Log preservation 都进入 native activation target。该证据仍不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或外部 AppKit click automation。

Latest native review packet:

```text
native-review-packets/loopops-native-review-2026-06-27-155136.md
native-review-packets/loopops-native-review-2026-06-27-155136.json
activationTargets=26
stateBackedTargets=26
noPermissionTargets=26
visualCaptures=6
nonBlankVisualCaptures=6
nativeAppKitClicksVerified=false
```

Latest native visual gallery:

```text
native-visual-audit/loopops-native-visual-2026-06-27-155147/README.md
native-visual-audit/loopops-native-visual-2026-06-27-155147/manifest.json
```

Latest native no-permission command excerpts:

```text
swift run WeChatIntelligenceRadar --loopops-action-check
loopops_action=pass
loopops_action_active_queue_selection_changes_result=true
loopops_action_typed_run_result_state=true
loopops_action_typed_run_result_isolation=true
loopops_action_selected_run_result_id=action-run-crypto-defi-opportunity-scan
loopops_action_selected_run_chat_scope_id=action-run-crypto-defi-opportunity-scan

swift run WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=152
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=53

swift run WeChatIntelligenceRadar --loopops-interaction-coverage-check
loopops_interaction_coverage=pass
loopops_interaction_coverage_item_count=44

swift run WeChatIntelligenceRadar --loopops-interaction-replay-check
loopops_interaction_replay=pass
loopops_interaction_replay_step_count=44

swift run WeChatIntelligenceRadar --loopops-native-activation-check
loopops_native_activation=pass
loopops_native_activation_target_count=26
loopops_native_activation_activation_targets=26
loopops_native_activation_activation_state_backed=26
loopops_native_activation_no_system_permissions=true
loopops_native_activation_native_appkit_clicks_verified=false
```

Current handoff:

```text
Web review URL: http://127.0.0.1:5188/
Native app bundle: .build/debug-app/WeChatIntelligenceRadar.app
Human review gallery: human-review-gallery.html
Server handoff: review-sessions/loopops-server-handoff-2026-06-27-152603.md
server_handoff_http_status=HTTP/1.1 200 OK
server_handoff_browser_opened=false
server_handoff_native_app_opened=false
server_handoff_system_automation=false
server_handoff_tracked_exec_session_running=false
Native visual gallery: native-visual-audit/loopops-native-visual-2026-06-27-155147/README.md
Pending review record: review-records/loopops-review-2026-06-27-155300.md
status=pending-manual-review
```

Closeout helper:

```text
scripts/print-loopops-review-closeout.command
loopops_review_closeout=ready
web_review_url=http://127.0.0.1:5188/
latest_review_record_json=review-records/loopops-review-2026-06-27-155300.json
latest_review_status=pending-manual-review
latest_pending_record_markdown=review-records/loopops-review-2026-06-27-155300.md
native_visual_gallery=native-visual-audit/loopops-native-visual-2026-06-27-155147/README.md
```

该 helper 只打印当前 pending record、pass / needs-work 记录命令和后续 gate 命令，不写入新 record，不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化。

Objective audit now enforces this helper path:

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5188/ LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
Manual review closeout helper=pass
review-closeout-helper.txt contains loopops_review_closeout=ready
review-closeout-helper.txt contains loopops-review-2026-06-27-155300
review-closeout-helper.txt contains loopops-native-visual-2026-06-27-155147
review-closeout-helper.txt contains LOOPOPS_REVIEW_STATUS=pass
review-closeout-helper.txt contains LOOPOPS_REVIEW_STATUS=needs-work
review-closeout-helper.txt contains LOOPOPS_MANAGER_GATE_MODE=review-ready
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

Manager gate now enforces the same helper path:

```text
LOOPOPS_MANAGER_GATE_MODE=review-ready scripts/manager-loopops-acceptance-gate.command
manual_review_server_handoff contains HTTP/1.1 200 OK
manual_review_server_handoff contains browser_opened=false
manual_review_server_handoff contains native_app_opened=false
manual_review_server_handoff contains system_automation=false
manual_review_server_handoff_json contains trackedExecSessionRunning=false
manual_review_closeout_helper no system automation command
manual_review_closeout_helper executed
manual_review_closeout_helper contains loopops_review_closeout=ready
manual_review_closeout_helper contains loopops-review-2026-06-27-155300
manual_review_closeout_helper contains loopops-native-visual-2026-06-27-155147
manual_review_closeout_helper contains LOOPOPS_REVIEW_STATUS=pass
manual_review_closeout_helper contains LOOPOPS_REVIEW_STATUS=needs-work
loopops_manager_gate_closeout_helper=pass
loopops_manager_gate=pass
```

该 handoff 仍是 `review-ready`，不是 `human-approved`。默认 full manager gate 必须等最新人工 review record 变成 `pass` 且 blockers 为空后才能通过。

## 2026-06-27 Previous 5187 Full Objective Audit 与 Previous Handoff

上一轮为了快速确认 review-ready 状态使用过 `LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1`。本轮已在当前 live review server `http://127.0.0.1:5187/` 上重跑完整 objective audit，不设置 skip 环境变量，因此包含 full `swift test`。最新人工 review handoff 指向 native visual capture `loopops-native-visual-2026-06-27-134805` 与 pending record `loopops-review-2026-06-27-135236`。Guardrail 更新后，`2026-06-27 13:19 HKT` 再次重跑完整 audit，确认 pending record、manual approval guardrail evidence、invalid pass/needs-work probes 和 full Swift test 全部通过。随后 native Global Chat 被提升为一等 Chat route，并刷新 native review packet 到 `loopops-native-review-2026-06-27-134754`，activation evidence 为 18/18，native visual evidence 为 6/6 nonblank surfaces including Chat。

- `.build/loopops-objective-audit/swift-test.txt` 证明 full Swift test 已通过。
- 当前 native handoff 证明 `134805` native visual gallery、current review record、Web smoke/action/no-permission review、live `5187` local-http DOM smoke、Swift contract、LoopOps acceptance、UI action、interaction coverage、interaction replay 和 native activation 仍一致。
- 人工 approval 记录已加防误批准校验：`pass` 必须有明确 reviewer notes 且 blockers 为空，`needs-work` / `blocked` / `fail` 必须有具体 blockers；manager full gate 同步检查这一点。Objective audit 现在会运行 invalid pass / invalid needs-work probes，并验证这些被拒记录没有写出 Markdown/JSON artifacts。

路径仍保持 no-permission：不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化。

Full Swift test evidence:

```text
Swift test log: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/.build/loopops-objective-audit/swift-test.txt
Build complete!
```

Full objective audit command:

```bash
LOOPOPS_WEB_URL=http://127.0.0.1:5187/ scripts/audit-loopops-objective.command
```

Full objective audit excerpt:

```text
web_dom_smoke=pass
web_no_permission_review_url=http://127.0.0.1:5187/
web_no_permission_review_server=available
web_no_permission_review_dom_smoke=true
web_no_permission_review_dom_smoke_source=local-http
web_dom_review_record_handoff=true
web_dom_review_record_preview=true
web_dom_review_state_persistence=true
web_dom_multi_run_queue=true
web_dom_run_chat_isolated=true
web_dom_stack_drag_add=true
web_dom_stack_drag_reorder=true
web_dom_create_tool_flow=true
web_dom_knowledge_attach_updates_run=true
web_dom_builder_patch_receipt=true
web_dom_no_browser_permissions=true

loopops_ui_action=pass
loopops_ui_action_required_identifier_count=151
loopops_ui_action_action_summary_count=43
loopops_interaction_replay=pass
loopops_interaction_replay_step_count=36
loopops_native_activation=pass
loopops_native_activation_activation_targets=18
loopops_native_activation_activation_state_backed=18
loopops_native_visual_capture=skipped_stable_handoff
loopops_native_visual_refresh_native_visual=false
pass file exists: native-visual-audit/loopops-native-visual-2026-06-27-134805/README.md
pass contains 'loopops-native-visual-2026-06-27-134805': 10-objective-completion-matrix.md
pass contains 'loopops-native-visual-2026-06-27-134805': 13-native-manual-review-checklist.md
pass contains 'loopops-native-visual-2026-06-27-134805': 15-goal-completion-gate.md
pass contains 'loopops-native-visual-2026-06-27-134805': human-review-gallery.html

== swift test ==
pass swift test
pass output contains 'Build complete': .build/loopops-objective-audit/swift-test.txt

loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

Manual review guardrail excerpt:

```text
pass invalid pass review record probe rejected invalid input with 'pass review records require explicit reviewer notes'
pass file absent: review-records/loopops-review-invalid-pass-probe.md
pass file absent: review-records/loopops-review-invalid-pass-probe.json
pass invalid needs-work review record probe rejected invalid input with 'non-pass review records require concrete blockers'
pass file absent: review-records/loopops-review-invalid-needs-work-probe.md
pass file absent: review-records/loopops-review-invalid-needs-work-probe.json
```

The current pending record was generated with:

```bash
LOOPOPS_WEB_URL=http://127.0.0.1:5187/ LOOPOPS_REVIEW_STATUS=pending-manual-review LOOPOPS_REVIEW_BLOCKERS=human-review-not-yet-recorded LOOPOPS_REVIEW_NOTES='Native visual review now includes the first-class Chat workspace: no-permission Swift harnesses pass with 151 required identifiers, 43 action summaries, 36 replay steps, 18 native activation targets, and 6/6 native visual captures including Chat; latest native visual gallery is loopops-native-visual-2026-06-27-134805; awaiting manual Web/native product review.' scripts/record-loopops-review.command
```

It remains a blocker record, not a pass record.

## 2026-06-27 追加 Current Handoff Pointer Guard

本轮发现 native visual capture 会随 full objective audit 刷新，因此把当前人工 review 入口收敛到两个 source of truth：

```text
Current native visual gallery: native-visual-audit/loopops-native-visual-2026-06-27-134805/README.md
Current pending review record: review-records/loopops-review-2026-06-27-135236.md
```

随后更新 `scripts/audit-loopops-objective.command`：它现在会从 `16-human-review-gallery.md` 读取 `Native visual gallery:`，解析 capture ID，并要求 `10-objective-completion-matrix.md`、`13-native-manual-review-checklist.md`、`15-goal-completion-gate.md` 和 `human-review-gallery.html` 都包含同一个 ID。这样新截图生成后，如果任何人工 review 文档还指向旧 capture，objective audit 会直接失败。为避免每次复查都生成新的截图 ID，objective audit 现在默认验证当前 handoff gallery；只有设置 `LOOPOPS_OBJECTIVE_AUDIT_REFRESH_NATIVE_VISUAL=1` 时才刷新 native visual capture。

该检查只读取本地文件，不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或外部 UI automation。

## 2026-06-27 追加 Manager Gate Live DOM Guard

本轮把 manager review-ready gate 从宽泛的 Web no-permission pass 收紧为必须读取最新 review session 的 live local-http DOM 交互证据。也就是说，`scripts/manager-loopops-acceptance-gate.command` 现在要求最新 `review-sessions/loopops-session-*-web.log` 同时包含以下关键路径：

```text
web_no_permission_review_dom_smoke=true
web_no_permission_review_dom_smoke_source=local-http
web_dom_multi_run_queue=true
web_dom_run_chat_isolated=true
web_dom_stack_drag_add=true
web_dom_stack_drag_reorder=true
web_dom_create_tool_flow=true
web_dom_knowledge_attach_updates_run=true
web_dom_builder_patch_receipt=true
```

验证结果：

```text
LOOPOPS_MANAGER_GATE_MODE=review-ready scripts/manager-loopops-acceptance-gate.command
loopops_manager_gate_review_ready=pass
loopops_manager_gate=pass

scripts/manager-loopops-acceptance-gate.command
loopops_manager_gate_review_ready=pass
loopops_manager_gate_human_approved=false
loopops_manager_gate=fail
```

默认 full gate 的失败仍是预期结果：最新人工 review record 仍为 `pending-manual-review`。

## 2026-06-27 追加 Native Visual Audit Refresh

Note: this packet-linked visual capture is superseded for manual review by the full objective audit entry above, which generated `loopops-native-visual-2026-06-27-122347`. The `094345` paths remain here as historical packet evidence for `loopops-native-review-2026-06-27-094341`.

本轮补齐 native App 的无权限 screenshot-level 证据。新增的 native visual harness 使用 offscreen `NSHostingView` 渲染真实 SwiftUI `DashboardView`，覆盖 Workbench、Loop Library、Skill OS、Knowledge、Studio 五个核心 surface。该路径不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari、系统浏览器自动化或外部 AppKit click automation；因此它可以避免反复触发 macOS 权限弹窗。它证明 native surface 非空且可供视觉 review，不声称外部 AppKit/XCUITest 像素点击已经完成。

命令：

```bash
swift run --disable-sandbox WeChatIntelligenceRadar --loopops-native-visual-capture
scripts/review-loopops-native.command
LOOPOPS_WEB_URL=http://127.0.0.1:5187/ scripts/review-loopops-all.command
```

结果摘录：

```text
loopops_native_visual=pass
loopops_native_visual_capture_id=loopops-native-visual-2026-06-27-094345
loopops_native_visual_capture_count=5
loopops_native_visual_nonblank_count=5
loopops_native_visual_no_system_permissions=true
loopops_native_visual_external_ui_automation=false
loopops_native_visual_native_appkit_clicks_verified=false

Native visual manifest: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-visual-audit/loopops-native-visual-2026-06-27-094345/manifest.json
Native visual gallery: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-visual-audit/loopops-native-visual-2026-06-27-094345/README.md
Native review packet: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-review-packets/loopops-native-review-2026-06-27-094341.md
Review session markdown: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-27-093200.md
```

## 2026-06-27 追加 5187 Live Review Session Refresh

本轮继续人工 review handoff 时发现旧的 `http://127.0.0.1:5186/` 已不可达；旧 Vite 进程痕迹仍在系统进程表里，但 sandbox 内外端口探测结果不同。为避免把失效端口写入人工 review 入口，重新启动 Web review server，Vite 自动切到 `http://127.0.0.1:5187/`。使用非 sandbox localhost 探测确认 HTTP 200；随后用同一 live URL 重新生成统一 review session。该流程不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化。

命令：

```bash
npm run review
curl -I http://127.0.0.1:5187/
LOOPOPS_WEB_URL=http://127.0.0.1:5187/ scripts/review-loopops-all.command
```

结果摘录：

```text
web_no_permission_review=pass
web_no_permission_review_url=http://127.0.0.1:5187/
web_no_permission_review_bind=127.0.0.1:5187
web_no_permission_review_server=available
web_dom_smoke=pass
web_dom_review_state_persistence=true
web_dom_multi_run_queue=true
web_dom_run_chat_isolated=true
web_dom_builder_patch_receipt=true
web_dom_create_tool_flow=true
web_dom_knowledge_attach_updates_run=true
web_dom_no_browser_permissions=true

loopops_native_activation=pass
loopops_native_activation_activation_targets=17
loopops_native_activation_activation_state_backed=17
loopops_native_activation_no_system_permissions=true
loopops_native_activation_native_appkit_clicks_verified=false
loopops_native_visual=pass
loopops_native_visual_capture_count=5
loopops_native_visual_nonblank_count=5

Review session markdown: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-27-093200.md
Review session json: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-27-093200.json
Native review packet: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-review-packets/loopops-native-review-2026-06-27-094341.md
Native review packet json: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-review-packets/loopops-native-review-2026-06-27-094341.json
Native visual gallery: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-visual-audit/loopops-native-visual-2026-06-27-094345/README.md
```

## 当前源码证据

- Swift/App quick GUI：`domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/LoopOpsViews.swift` 的 `LoopOpsScopedChatPanel` 现在包含 model、Instant/Deep、Search、Temporary、Create/Explore/Code/Learn prompt categories，并把 quick controls 写入提交上下文。
- Swift/App quick GUI anchors：`domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsInteractionContracts.swift` 新增 `scopedChatQuickControls`、`scopedChatModelControl`、`scopedChatInstantControl`、`scopedChatSearchControl`、`scopedChatTemporaryControl`、`scopedChatPromptCategories`。
- Swift/App Tool Draft 可见性：`LoopOpsSkillPackage.packages(from:toolDrafts:)` 把本地 `LoopOpsToolDraft` 合成为 Skill OS package；Skill OS、Workforce、Studio shelf 均使用该来源。
- Swift/App Skill OS 公开能力过滤：`LoopOpsPublicSkillPolicy` 已从单纯关键词拦截补强为 `publicCategories` allowlist + blocked status/id/title 双层过滤。有 category 的 manifest 必须属于 `market/marketData/markets/research/review/office/multimodal/local tool` 等用户可见类别；`channel/provider/runtime/memory` 和未知 category 会隐藏；无 category 的旧 public manifest 在通过安全过滤后保持兼容。`swift test` 和 `--contract-check` 均覆盖 CMC public package 可见、Feishu channel/provider/memory/unknown category 隐藏、legacy uncategorized public package 兼容。
- Swift/App Tool 起点与日志：`LoopOpsSkillOSView` 的 `New Tool` sheet 现在提供 `Invent / Default / Import` 起点，并补齐 Tool name、Task description、Input scope 三个可编辑字段；`Import` 会创建 `Imported Review Tool`，切到 Logs，并写入 `Starting point: Import` 与 `Input scope: Builder packet`。`LoopOpsInteractionContracts.swift` 新增 `skillOSCreateToolInvent`、`skillOSCreateToolDefault`、`skillOSCreateToolImport`、`skillOSCreateToolName`、`skillOSCreateToolDescription`、`skillOSCreateToolInputScope` 稳定锚点。
- Swift/App durable ledger：`LoopOpsLocalStore.swift` 现在持久化 `run-ledgers.json` 与 `share-safe-logs.json`；`DashboardViewModel.runLoopContract` 在 `postMessageAsync` 返回后写入 contract-scoped ledger，并在 final read model 可读时刷新同一条 share-safe preview。
- Swift/App strict-store recovery：`LoopOpsLocalStore.load()` 现在会读取 `LoopOpsLocalJSONStore.readSnapshot()`，把 strict JSON 中缺失的 Loop Contract、Run Ledger、Review Packet、Share-safe Log、Run/Review Chat 恢复回轻量 UI store，并重新落盘。
- Swift/App strict snapshot full sync：`LoopOpsLocalStore` 关键保存路径现在统一写入完整 `LoopOpsLocalStoreSnapshot`，不再按 contract/chat/review/ledger/share-safe 分散 upsert；`upsertReviewPacket` 会自动更新同 run 的 ledger decision 和 share-safe preview。
- Swift/App active queue 行级定位：`BlocksRunRow` 现在写入 `LoopOpsInteractionID.workbenchActiveQueueRow(taskID)`，`runActionChecks()` 断言选择第二个 active run 后 Run Result 和 Run Chat scope 同步切换。
- Swift/App Loop Library 主动作：`LoopOpsLibraryView` 的 Loop 主行 run 现在先选中该 contract；`Ready` loop 通过 `DashboardViewModel.runLoopContract` 入队并切回 Workbench，`Needs setup` loop 被统一拦截，聚焦 Studio 的 Builder Chat、预填 setup prompt，并写入 builder-scoped receipt。`Run selected` 现在返回 queued/setup 计数，ready 项入队，第一条 unready 项进入 setup。
- Swift/App Knowledge 前台文案：Knowledge 的 scoped chat 行从 `memory candidates` 改为 `reusable notes`，并在 `--contract-check` / `swift test` 中断言 Knowledge 行不暴露 `memory/provider/runtime/worker/artifact/schema` 等内部词。
- Swift/App 无权限 UI action contract：`LoopOpsAcceptanceHarness.runUIActionChecks()` 将 required interaction IDs、动态 contract/run/skill path/review IDs 与 `runActionChecks()` 的状态转移绑定，并输出 `no_system_permissions=true`，避免用 AppleScript、Accessibility、屏幕录制或系统浏览器控制作为回归前提。`runInteractionCoverageCheck()` 进一步枚举 31 个 native 关键交互，新增 Marketplace template install 到 Studio / workspace copy、unready Loop Library row 到 Builder setup、Skill OS Import 起点、Create Tool form fields 和 Tool Log source tag 的状态证明，确认每项都有 stable anchor、状态证明和 no-system-permission 路径，同时显式记录 `native_appkit_clicks_verified=false`。`runInteractionReplayCheck()` 把同一组 31 个 native 交互 replay 成 before/after 状态证据，用于无权限回归和后续 XCUITest 对照。
- Swift/App native activation harness：`domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsNativeActivationHarness.swift` 新增 `--loopops-native-activation-check` 背后的进程内 action wiring 检查，复用 replay/coverage 证据覆盖 9 个关键 review action，并输出 `external_ui_automation=false`、`native_appkit_clicks_verified=false`。该入口减少“SwiftUI 控件 action 是否接上”的盲区，但仍不声称完成 AppKit/XCUITest 点击。
- Swift/App Builder Chat 自然语言 patch：`LoopOpsBuilderDraftPatch` 现在识别 `skill path / skill stack / capability chain / execution path / review rule / 调用顺序 / 技能路径 / 能力链 / 先后顺序` 等路径和复核字段，并支持中文 `步骤 / 反馈 / 退出条件 / 输出格式`。`步骤：先...然后...再...最后...` 会拆成可见 step list，`调用顺序：A -> B -> C` 会按顺序生成 `LoopOpsSkillBinding`，materialize 后写入 `promptForRun()` 的 ordered `Skill Path`。本轮又补了无字段名的中英文自由描述推断：例如“先用 A，然后用 B，再用 C，最后输出 review packet；如果证据不足...；完成条件是...；输出为...”和 “first use A, then use B, finally output a review packet; if evidence is stale...; stop when...; output as...” 会推断 visible steps、ordered skill path、review rule、exit condition 和 output shape，并由 `swift test` 与 `--contract-check` 覆盖。
- Web prototype 状态闭环：`web-prototype/src/App.jsx` 现在支持 Workbench Review Guide Evidence Map、Marketplace template `Install` / `Install to Studio` 生成 editable workspace copy 并切到 Studio、原模板回填 `workspaceCopyId`、Skill OS 行切换详情、Create Tool 插入工具行和当前 tool 日志、Create Tool 的 Default/Invent/Import 起点同步更新字段与日志来源，Logs 行直接渲染 submitted source、Run Tool 追加 scoped 日志、Logs 按 selected tool/status/user 过滤、Tool Log 打开 Review Chat、Loop run materialize run-bound Tool logs、Run Result Tool log 打开 Review Chat 并携带 `runId/toolLogId/status/output/bound knowledge`、Knowledge starter/search/status filter、新建插入列表行、Knowledge attach 会同步更新当前 active run 的 Run Result `Knowledge` 字段、写入 Run Chat 可见事件并生成 run-scoped attachment、Run Chat 按 `runId` 隔离、Chat transcript、所有 Chat 发送入口共享 model/mode/search/temporary quick controls、Temporary chat 不写 transcript、Library sort/columns、Studio Open packet 和 Chat scope 联动、Studio structured contract blocks 直接编辑、Studio save-state / Review changes / Reset draft、Workbench Empty queue / Seeded review、toast 自动清理、Loop Library 主行点击/名称/Run 会按 readiness 分流，ready loop 进入 Workbench queue，Marketplace available template 进入 install/setup flow，Limited/Needs setup loop 进入 setup detail 和 Builder Chat，主行支持 Enter/Space 键盘触发和 focus ring，Open 只负责打开详情，Clone 复制到 Studio。
- Web prototype 无权限 action smoke：`web-prototype/scripts/action-smoke.mjs` 现在用 Node 状态机和源码锚点验证 Marketplace install to Studio / editable workspace copy、batch run、unready loop setup handoff、Run Chat 隔离、run-bound Tool logs、Run Tool Log to Review Chat、run-scoped attachments、Knowledge starter/search/filter、Knowledge attach 更新 active run、Create Tool starting point、Tool Logs per selected tool、Tool Log to Review Chat、Studio ordered skill path，不调用浏览器、截图、AppleScript 或 WebKit 权限路径。
- Web prototype review server / offline review：`web-prototype/package.json` 提供 `npm run review`，默认优先绑定 `127.0.0.1:5184`，用于人工 review，不打开系统浏览器、不调用 AppleScript、不读屏。root 新增 `scripts/review-loopops-web.command`，若该 URL 已可访问且页面内容是 `LoopOps Admin` 则只打印地址并退出，否则启动本地 review server；若端口被占用，则以 Vite 终端打印的 `Local:` 地址为准。本轮又新增 `npm run review:offline`、`scripts/export-offline-review.mjs` 和 root `scripts/review-loopops-web-offline.command`，会把 build 后 CSS/JS 内联成 `dist/loopops-admin-offline.html`，作为 localhost 绑定被策略阻止时的人工 review fallback。
- Web prototype no-permission QA：`web-prototype/package.json` 的 `npm run review:no-permission` 聚合 `build`、`smoke`、`action:smoke`、离线 artifact 导出、本地 review server 检查/启动、`dom:smoke`；如果 Vite 因端口占用打印新的 `Local:` URL，该脚本会解析并把 `dom:smoke` 指向实际 URL；如果本地策略禁止绑定 localhost，该脚本会先输出 `web_no_permission_review_server=offline_fallback` 与 `web_offline_review_path=.../dist/loopops-admin-offline.html`，再尝试用 `file://` 离线 artifact 跑 DOM smoke。当前 sandbox 下 WebKit file navigation 会被拦截，因此脚本会输出 `web_no_permission_review_dom_smoke_source=skipped_sandbox_file_navigation`，保留 build/smoke/action/offline 证据而不直接失败；同时检查 review/smoke/capture 脚本不包含 `osascript`、`System Events`、`open -a`、Chrome/Safari 或 Accessibility/screen-control 模式。
- Web prototype 本地 DOM smoke：`web-prototype/scripts/dom-smoke.swift` 用本地 WebKit 点击真实 DOM，覆盖 Workbench Evidence Map、Marketplace template detail install 到 Studio、editable workspace copy、原模板 install state 回填、Loop Library ready run、unready setup handoff、Context & tools、multi-run queue、run-scoped chat isolation、same Loop repeat isolation、Run Result run-bound Tool logs、Run Tool Log to Review Chat、Skill OS Create Tool modal / Import starter / visible log source / draft log、Tool Log to Review Chat、Skill OS Use validation、Knowledge Website starter/search/status filter、Knowledge attach 更新 active Run Result、run-scoped attachment 不泄漏到其他 run 和 Chat send；默认指向 `http://127.0.0.1:5184/`，也可用 `LOOPOPS_WEB_URL` 覆盖到 HTTP 或 `file://` URL。完整 DOM 点击证据仍以可访问的本地 HTTP URL 为主；离线 artifact 是人工 review fallback，file DOM smoke 会在环境允许时补充验证。
- Codex 内置 Browser clickthrough：`11-browser-clickthrough-review.md` 记录了当前 `http://127.0.0.1:5184/` 的真实 DOM 点击巡检，覆盖 Workbench、Loop Library ready/unready、batch run queue、ledger/packet/share-safe linked rows、Skill OS Create Tool Import 起点到 Start 提交、Knowledge starter/search/filter/attach、Chat quick GUI、Studio add step 和 review diff。该巡检不调用系统浏览器、Accessibility、屏幕录制或 AppleScript；Create Tool 的 `Start` 同时由 WebKit `web_dom_create_tool_flow=true` 继续覆盖。
- Remaining decision contract：`12-remaining-decision-contract.md` 把两个外部边界写成验收合同。Triple 默认按当前 quick-GUI scope 收口；如果用户提供具体 Triple URL，再新增独立 deep dive。Native 默认按 no-permission action wiring / contract / Web DOM 点击收口；如果用户明确要求 AppKit/XCUITest pixel-click，则另建授权路径和验收文档，不把当前 harness 伪装成像素点击。
- Web prototype 样式：`web-prototype/src/styles.css` 新增 `chatTranscript`、`chatMessage`、`chatScopeKey`、save-state strip、empty-state mode controls、visible focus rings、6/8 列 database grid、Library mini rows、unready row/setup action、reduced-motion、dark appearance 和 mobile static toast 样式，保持 Notion/RelevanceAI 式轻量产品 UI；最新 dark-mode contrast pass 还把 `.mainPane`、`.emptyState`、Chat quick GUI、Studio fields、contract textarea、composer textarea、quick-grid surfaces、`.dbHead`、`.miniRow`、`.miniRow.focused`、`.loopRow.needsSetup` 和 `.rowActions button.setupAction` 纳入深色 surface token，修复截图里白底浅字和 Library focused ledger row 低对比的问题。

## 构建与检查摘录

### Web prototype

命令：

```bash
npm run build
```

结果摘录：

```text
vite v6.4.2 building for production...
✓ 29 modules transformed.
dist/index.html                   0.40 kB │ gzip:  0.27 kB
dist/assets/index-DJTc6t7L.css   23.65 kB │ gzip:  5.44 kB
dist/assets/index-CuuzqKTX.js   264.50 kB │ gzip: 80.13 kB
✓ built in 572ms
```

无系统权限 action smoke：

```bash
npm run action:smoke
```

结果摘录：

```text
web_action_smoke=pass
web_action_marketplace_install_to_studio=true
web_action_marketplace_workspace_copy=crypto-thesis-review-workspace-action
web_action_batch_runs=2
web_action_row_click_launches_run=true
web_action_unready_loop_routes_setup=true
web_action_library_ledger_open=true
web_action_resource_bindings=true
web_action_run_tool_logs_bound=true
web_action_run_tool_log_review_chat=true
web_action_run_ids_unique=true
web_action_run_chats_isolated=true
web_action_selected_run_id=run-crypto-trade-plan-review-action-smoke-2-1
web_action_knowledge_attach_run_scoped=true
web_action_knowledge_attach_updates_run=true
web_action_attachments_run_scoped=true
web_action_knowledge_starter_filter=true
web_action_tool_use_validation=true
web_action_tool_logs_scoped=true
web_action_tool_log_review_chat=true
web_action_tool_mode=Import
web_action_stack_drag_add=true
web_action_stack_drag_reorder=true
web_action_studio_skill_path=Evidence Skill > Final Answer Skill > CMC market radar
web_action_no_browser_permissions=true
```

无系统权限 review 聚合：

```bash
npm run review:no-permission
```

结果摘录：

```text
web_no_permission_review=pass
web_no_permission_review_url=http://127.0.0.1:5184/
web_no_permission_review_bind=127.0.0.1:5184
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_no_permission_review_server=available
web_no_permission_review_dom_smoke=true
dist/assets/index-DJTc6t7L.css   23.65 kB │ gzip:  5.44 kB
dist/assets/index-CuuzqKTX.js   264.50 kB │ gzip: 80.13 kB
web_dom_smoke=pass
web_dom_review_guide_paths=true
web_dom_review_guide_evidence_map=true
web_dom_marketplace_install_to_studio=true
web_dom_library_run_clicked=true
web_dom_unready_loop_setup=true
web_dom_multi_run_queue=true
web_dom_run_chat_isolated=true
web_dom_same_loop_repeat_isolated=true
web_dom_resource_bindings=true
web_dom_run_tool_logs_bound=true
web_dom_run_tool_log_review_chat=true
web_dom_tool_log_source_visible=true
web_dom_tool_log_review_chat=true
web_dom_knowledge_attach=true
web_dom_knowledge_attach_updates_run=true
web_dom_attachments_run_scoped=true
web_dom_knowledge_starters_search_filter=true
```

真实 DOM action smoke：

```bash
cd domains/frontend/web/code/web-prototype
npm run review
LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run dom:smoke
```

结果摘录：

```text
web_dom_smoke=pass
web_dom_marketplace_install_to_studio=true
web_dom_library_run_clicked=true
web_dom_unready_loop_setup=true
web_dom_library_linked_rows_open=true
web_dom_resource_bindings=true
web_dom_run_tool_logs_bound=true
web_dom_run_tool_log_review_chat=true
web_dom_stack_drag_add=true
web_dom_stack_drag_reorder=true
web_dom_create_tool_flow=true
web_dom_tool_log_source_visible=true
web_dom_tool_use_validation=true
web_dom_tool_log_review_chat=true
web_dom_knowledge_attach=true
web_dom_knowledge_attach_updates_run=true
web_dom_attachments_run_scoped=true
web_dom_knowledge_starters_search_filter=true
web_dom_chat_send=true
web_dom_no_browser_permissions=true
```

### Swift build

命令：

```bash
swift build
```

结果摘录：

```text
Build complete! (10.79s)
```

### Contract check

命令：

```bash
swift run WeChatIntelligenceRadar --contract-check
```

结果摘录：

```text
Build of product 'WeChatIntelligenceRadar' complete! (0.17s)
agent_runtime_contracts=pass
```

覆盖新增项：

- Tool Draft 合成为 Skill OS package。
- Marketplace template install to Studio 会创建 editable workspace copy，并保留 `installedFromTemplateID/workspaceCopyID`；Studio 保存和 strict JSON bridge 不丢来源。
- ordered skill path 与 launch request isolation。
- Builder Chat 支持中文自然语言 `步骤 / 调用顺序 / 反馈 / 退出条件 / 输出格式` patch，并把 ordered skill path 写入 run prompt。
- 轻量 `LoopOpsLocalStore` run ledger / share-safe log 持久化。
- strict `LoopOpsLocalJSONStore` 以完整 snapshot 同步，并可作为空 light store 的恢复来源。
- review packet upsert 会推进同 run 的 ledger decision 和 share-safe preview。
- public Skill OS policy 隐藏 provider/gate/channel 内部能力。
- knowledge/tool/log persistence。
- review-only policy boundary。

### UI smoke

命令：

```bash
swift run WeChatIntelligenceRadar --ui-smoke-check
```

结果摘录：

```text
ui_smoke_loopops_library_visible=true
ui_smoke_loopops_skill_os_visible=true
ui_smoke_loopops_knowledge_visible=true
ui_smoke_loopops_studio_visible=true
ui_smoke_scoped_chat_visible=true
ui_smoke_loopops_chat_quick_gui_visible=true
ui_smoke_loopops_interaction_ids_stable=true
ui_smoke_loopops_public_skill_policy_hides_internal=true
ui_smoke_internal_tools_hidden=true
ui_smoke_public_ability_names_clean=true
ui_smoke=pass
```

### UI action contract

命令：

```bash
swift run WeChatIntelligenceRadar --loopops-ui-action-check
```

结果摘录：

```text
loopops_ui_action=pass
loopops_ui_action_required_identifiers_unique=true
loopops_ui_action_dynamic_identifiers_stable=true
loopops_ui_action_required_action_anchors_visible=true
loopops_ui_action_library_actions=true
loopops_ui_action_studio_drag_actions=true
loopops_ui_action_knowledge_tool_actions=true
loopops_ui_action_run_review_chat_actions=true
loopops_ui_action_review_safe_boundaries=true
loopops_ui_action_no_system_permissions=true
loopops_ui_action_action_summary_count=30
loopops_ui_action_required_identifier_count=69
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=30
```

说明：该命令不打开系统浏览器、不调用 AppleScript、不请求 Accessibility 或屏幕录制权限；它把 UI 可定位锚点和用户动作背后的本地状态转移绑定为一条可重复回归。

### Native interaction coverage

命令：

```bash
swift run WeChatIntelligenceRadar --loopops-interaction-coverage-check
```

结果摘录：

```text
loopops_interaction_coverage=pass
loopops_interaction_coverage_items=24
loopops_interaction_coverage_anchored_items=24
loopops_interaction_coverage_state_backed_items=24
loopops_interaction_coverage_no_system_permission_items=24
loopops_interaction_coverage_native_appkit_clicks_verified=false
loopops_interaction_coverage_native_appkit_click_gap_count=24
```

说明：该入口是 native 端无权限覆盖矩阵。它证明 24 个关键交互已有稳定 UI anchor 和状态转移证据，也明确说明这些仍不是 AppKit/XCUITest 像素点击验收。

### Native interaction replay

命令：

```bash
swift run WeChatIntelligenceRadar --loopops-interaction-replay-check
```

结果摘录：

```text
loopops_interaction_replay=pass
loopops_interaction_replay_steps=24
loopops_interaction_replay_replay_verified_steps=24
loopops_interaction_replay_state_mutation_steps=24
loopops_interaction_replay_no_system_permission_steps=24
loopops_interaction_replay_before_after_evidence=true
loopops_interaction_replay_native_appkit_clicks_verified=false
loopops_interaction_replay_native_appkit_click_gap_count=24
loopops_interaction_replay_step_1=Loop Library|Batch run selected loops|loopops.library.batch-run|before:selected_loop_ids=2; launch_requests=0; active_runs=0|after:launch_requests=2; isolated_chat_scopes=true
loopops_interaction_replay_step_2=Loop Library|Install marketplace template to Studio|loopops.library.install.crypto-market-report-loop|before:marketplace_template=available; workspace_copy=nil; selected_workspace=library|after:workspace_copy=workspace-crypto-market-report-loop-action; selected_workspace=studio; builder_receipt=installed
loopops_interaction_replay_step_4=Loop Library|Route unready loop to Builder setup|loopops.library.run.action-unready-loop|before:unready_loop_click=action-unready-loop; queued_runs=0|after:queued_runs=0; focused_contract=action-unready-loop; builder_chat_receipt=setup_needed
loopops_interaction_replay_step_19=Skill OS|Choose Import tool starting point|loopops.skill-os.create-tool.import|before:create_tool_mode=Default; tool_name=Default Runner|after:create_tool_mode=Import; tool_name=Imported Review Tool
loopops_interaction_replay_step_20=Skill OS|Edit tool name, task description, and input scope|loopops.skill-os.create-tool.input-scope|before:tool_name=Evidence Gap Finder; input_scope=Review packet; description=editable|after:tool_name=Imported Review Tool; input_scope=Builder packet; description=import_definition
loopops_interaction_replay_step_21=Skill OS|Record tool log source|loopops.skill-os.logs|before:tool_log_source=missing|after:tool_log_source=Import; input_scope=Builder packet
loopops_interaction_replay_step_22=Skill OS|Create a new local tool draft|loopops.skill-os.create-tool.start|before:tool_drafts=0; tool_logs=0|after:tool_drafts=1; tool_logs=1; skill_os_package_visible=true; tool_name=Imported Review Tool
```

说明：该入口逐条 replay 31 个 native 关键交互，并输出 before/after 状态证据。它不打开 App、不调用 Accessibility/AppleScript/屏幕录制，也不把无权限 replay 伪装成 AppKit/XCUITest 点击。

### Native activation wiring

命令：

```bash
swift run WeChatIntelligenceRadar --loopops-native-activation-check
```

结果摘录：

```text
loopops_native_activation=pass
loopops_native_activation_in_process_activation=true
loopops_native_activation_swiftui_action_wiring_verified=true
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_native_appkit_clicks_verified=false
loopops_native_activation_activation_targets=9
loopops_native_activation_activation_state_backed=9
loopops_native_activation_target=Loop Library|loopops.library.batch-run|library_batch_run=true
loopops_native_activation_target=Loop Library|loopops.library.run.action-unready-loop|library_unready_loop_setup=true
loopops_native_activation_target=Skill OS|loopops.skill-os.create-tool.input-scope|create_tool_form_fields=true
loopops_native_activation_target=Run Chat|loopops.workbench.run-chat.send|run_chat_send=true
```

说明：该入口验证关键 SwiftUI action wiring 的进程内激活与状态变更，不打开 App、不调用 Accessibility/AppleScript/屏幕录制，也不把它等同于外部 AppKit/XCUITest 像素点击。

### Swift test target build

命令：

```bash
swift test
```

结果摘录：

```text
Compiling WeChatIntelligenceRadarAppTests LoopOpsV2ModelStoreTests.swift
Compiling WeChatIntelligenceRadarAppTests AgentRuntimeTests.swift
Linking WeChatIntelligenceRadarMVPPackageTests
Build complete! (2.74s)
```

说明：当前 package 的 standard XCTest/Testing discovery 仍不提供逐项 test report，因此本轮强验收继续以 `--contract-check` 和 `--ui-smoke-check` 为主。

## Agent-Team 审计输入

本轮追加三个只读 sub-agent 审计：

- `019ef899-81e3-7913-a122-7e9ea50c07aa`：Swift/App 实现审计。指出 Tool Draft 未进入 Skill OS package 和 Swift quick GUI 不够完整。本轮已修 quick GUI 与 Tool Draft 可见性；run ledger/share-safe strict integration 仍列入 hardening。
- `019ef899-af2f-7be0-b77b-dfb9dc462565`：Web prototype 审计。指出 Tool row 不可切换、Create Tool 不落列表、Run Tool 不产生日志、Logs filter 不真实、Chat 无 transcript、Knowledge 新建不入列表。本轮已逐项修补。
- `019ef899-c94a-7501-b37c-de3817f9ce0c`：研究/验收文档审计。指出需要 evidence receipts、Triple 只能按 quick-GUI 模式验收、PRODUCT/DESIGN traceability 需补。本文件即为 receipts；PRODUCT/DESIGN 已补研究来源映射。
- `019ef8ae-a8aa-7012-a37c-30beddb4ed6b`：Swift durable ledger 审计。指出 v2 strict store 存在但生产 run 生命周期未写 durable ledger/share-safe。本轮已接轻量生产 store，并追加完整 strict snapshot sync；真实 AppKit/XCUITest 仍列为 hardening。
- `019ef8ae-bcb7-7931-bc92-3d014ed6ef5c`：Web review / 文档审计。指出历史端口和部分 placeholder 交互误导。本轮已修 sort/columns、Open packet、Chat scope 联动，并更新 review 入口口径。
- `019ef9b5-fba0-7630-8ada-8528ee62eefd`：Swift/App 最新只读审计。确认主要 LoopOps surface、ordered skill bindings、tool/knowledge/log store 已落地；指出 Workbench composer 仍可能绕开 durable LoopOps ledger、Review Chat surface 不够可达、Share-safe clone 可能引用错 contract、原生 IA/copy 仍有内部面。本轮已修前三项，并用 action/ui smoke 验证；原生 IA/copy 继续列入 polish。
- `019ef9b6-2f28-7730-9beb-24c8d4b32fde`：Web prototype 最新只读审计。指出 Library row click 语义、Clone handler、切换态 aria pressed/current、prototype/internal copy、adaptive appearance 和 mobile toast 遮挡需要明确。本轮已补 Clone、aria、copy、appearance、toast；随后按原始计划把 Loop Library 主行点击恢复为 run，并把 `web_action_row_click_launches_run=true` 纳入无权限 action smoke。

## 边界

- 不声称完整研究了另一个未给 URL 的 Triple 产品本体；当前验收对象是“简洁 chatbot + 快捷 GUI 模式”。
- 不声称 Web prototype 是生产后端实现；它是可点击交互前端原型。
- 不声称 UI smoke 等同真实 XCUITest；它是结构和合同级验收。
- 不新增交易、飞书/微信发送、外部发布、tool router 或 final answer authority。

## 2026-06-24 追加行为锚点验收

本轮补强了 LoopOps action-level accessibility anchors：

- `LoopOpsInteractionID.contractRunButton(_:)`、`contractOpenButton(_:)`、`ledgerRow(_:)` 覆盖 Library row 的 run/open/ledger 定位。
- `loopLibraryReviewPacket` 与 `reviewDecision("reviewed" | "needs_follow_up" | "blocked")` 覆盖 Review Packet 三类决策按钮。
- `loopLibraryShareSafeLog` 覆盖 Share-safe Log 预览。
- `loopLibraryDetailRun`、`loopLibraryDetailClone` 覆盖 Loop detail 主动作。
- `skillPathRow`、`skillPathMoveUp`、`skillPathMoveDown`、`skillPathRemove` 已继续覆盖 Studio execution path 行级排序/删除。

验证命令：

```bash
swift build
swift run WeChatIntelligenceRadar --contract-check
swift test
swift run WeChatIntelligenceRadar --ui-smoke-check
npm run build
```

最新结果摘录：

```text
Build complete! (7.04s)
agent_runtime_contracts=pass
Build complete! (2.58s)
ui_smoke_loopops_interaction_ids_stable=true
ui_smoke_loopops_dynamic_interaction_ids_stable=true
ui_smoke=pass
vite v6.4.2 building for production...
✓ built in 1.09s
```

Web review 入口状态：

- `http://127.0.0.1:5184/` 当前是 Vite review server，用于人工 review；默认启动命令是 `npm run review`。
- WebKit focus/capture/DOM smoke 脚本支持 `LOOPOPS_WEB_URL` 覆盖目标 URL。
- 2026-06-24 最新人工 review 小修后，`curl -L http://127.0.0.1:5184/` 返回当前页面且 title 为 `LoopOps Admin`。
- 为避免继续触发 macOS 权限弹窗，当前最新保障不使用 AppleScript、Computer Use、屏幕录制或系统浏览器控制。非沙盒本地 WebKit `LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run dom:smoke` 已通过真实 DOM 点击链路。desktop/mobile screenshot manifest 已在 Create Tool import、Tool Logs validation、Builder Chat patch receipt、Knowledge source detail 和 visual overflow pass 后重跑，当前为 15 步截图证据，包含 `05a-skill-os-create-tool-import.png`、`05b-skill-os-tool-logs-validation.png`、`06a-studio-builder-patch-receipt.png` 和 `08b-knowledge-source-detail.png`。

本轮仍不声称已经完成真实 AppKit/XCUITest 点击链路；但 action anchors 已经为后续行为自动化提供稳定定位。

## 2026-06-24 追加 Web product-review receipts

本轮补强 Web prototype 的人工 review 可见状态：

- Studio contract page 增加 `loopops.studio.save-state`、`loopops.studio.review-diff`、`loopops.studio.reset-draft`、`loopops.studio.diff-panel`。当 Skill OS ordered stack 被编辑后，Studio 会显示 Unsaved changes，并把 Skill Stack 标为 changed block。
- Workbench 增加 `loopops.workbench.mode.empty`、`loopops.workbench.mode.seeded` 和 `loopops.workbench.empty-state`，人工 review 可在空队列和 seeded review 之间切换。
- WebKit capture 增加 `06b-studio-review-changes.png` 和 `10-workbench-empty-state.png`，截图 manifest 的 capture count 从 9 提升到 11。
- Focus smoke 继续覆盖 6 个 surface，Workbench focusables 从 55 增加到 57，Studio focusables 从 49 增加到 50。
- Focus smoke 现在断言 visible focusable controls 都有可读名称；当前 6 个 surface 的 unlabeled count 均为 0。
- Mobile capture 新增 `product-design-audit-web-mobile/`，以 390 x 844 viewport 跑同一条 11 步点击路径，所有步骤 `hasHorizontalOverflow=false`。

最新结果摘录：

```text
web_prototype_smoke=pass
web_prototype_testids=79
web_focus_smoke=pass
web_focus_surfaces=6
web_audit_capture=pass
web_audit_capture_count=11
```

## 2026-06-24 追加 LoopOps 行为验收 harness

本轮新增 `LoopOpsAcceptanceHarness`，把分散的 LoopOps 数据链验收集中成一个可重复入口：

- 生成 3 个 batch launch request：Market Report、Thesis Review、Trade Plan Review，并额外生成同一个 Market Report Loop 的 2 次重复 launch request。
- 验证每个 request 保留自己的 `contractID`、`chatScopeID`、ordered skill path、selected skill ids 和 extension ids。
- 验证同一个 `contractID` 的重复 launch 仍生成不同 `chatScopeID`，且 scope 保持 `loop-run-{contractID}-{launchID}` 的可读前缀。
- 写入临时 `LoopOpsLocalStore`，模拟 queued/running run ledger、run-scoped chat、review packet、share-safe log。
- 重新加载 store，验证 5 个 run 的 ledger、review packet、share-safe log、run chat 不串线。
- 不调用 daemon，不触发外部 tool router，不产生交易、发布或发送动作。

新增入口：

```bash
swift run WeChatIntelligenceRadar --loopops-acceptance-check
```

最新结果摘录：

```text
loopops_acceptance=pass
loopops_acceptance_batch_requests=3
loopops_acceptance_run_ids_unique=true
loopops_acceptance_skill_paths_ordered=true
loopops_acceptance_run_chats_isolated=true
loopops_acceptance_same_contract_repeat_runs_isolated=true
loopops_acceptance_review_packets=5
loopops_acceptance_share_safe_logs=5
loopops_acceptance_run_ids=acceptance-run-0-crypto-market-report-loop,acceptance-run-1-crypto-thesis-review,acceptance-run-2-crypto-trade-plan-review,acceptance-repeat-run-0-crypto-market-report-loop,acceptance-repeat-run-1-crypto-market-report-loop
loopops_acceptance_contract_ids=crypto-market-report-loop,crypto-thesis-review,crypto-trade-plan-review
loopops_acceptance_ledgers=5
```

同一 harness 已接入：

- `swift run WeChatIntelligenceRadar --contract-check`
- `swift test` 的 `agentRuntimeChecks` 显式入口

本轮仍不声称已经完成真实 AppKit/XCUITest 点击链路；但 LoopOps 的 batch run 数据链已经从 presence smoke 提升到可重复的模型行为验收。

## 2026-06-24 追加 LoopOps action harness

本轮继续新增 `LoopOpsAcceptanceHarness.runActionChecks()`，用于绕开 macOS LaunchServices、Application Support、进程枚举等会触发系统权限弹窗的路径，直接验证 UI 按钮背后的本地 action/data mutation：

- Loop Library 多选后 batch run request 生成，并验证每个 request 的 `contractID`、`chatScopeID` 与追加指令隔离。
- Loop Library Marketplace template install 会生成 editable workspace copy，切到 Studio / Builder，并保留 source template id。
- Loop Library 多选包含未安装 Marketplace template 时，会先 install 到 Studio，不绕过 install 直接生成 run request。
- Loop Library 主行 run 生成单个 contract-scoped launch request，并验证 detail context 切到被点击的 contract。
- Loop Library unready row 通过 `DashboardViewModel.runLoopContract` 进入 Studio / Builder Chat setup，不生成 run request，并写入 `library_unready_loop_setup=true`。
- Studio 保存 `LoopContractDraft`，并验证 ordered skill bindings 正常排序、保存、重载。
- Skill OS 保存 `LoopOpsSkillStack`，验证 skill stack reload 后顺序不丢。
- Skill OS drop payload 使用 `LoopOpsSkillPathDropResolver` 解析 `loopops-skill` / `loopops-stack`，验证 skill 插入到目标 binding 前、已有 skill 拖拽移动不重复、stack drop 展开保持顺序、移除 path row 后保存重开不丢。
- Knowledge 创建 blank source，验证 source 持久化、toast 只作为 transient 状态存在。
- Tool OS 创建 `LoopOpsToolDraft` 与 `LoopOpsToolLog`，验证可重载。
- Run Chat send 写入 run-scoped thread，验证两个并行 run chat 不串线。
- Review Chat send 写入 review-scoped thread，验证 review scope 可达并可重载。
- Share-safe clone 按 ledger 的 `loopContractID` 解析 contract，验证 detail contract 与 ledger contract 不一致时不会 clone 错对象。
- Review Packet upsert 会自动更新同 run 的 ledger decision 与 share-safe preview，不再要求调用方补一次 applied ledger capture。
- Strict snapshot full sync 使用完整 `LoopOpsLocalStoreSnapshot` 写入 strict JSON store；strict store recovery 使用同一个 strict JSON store 启动全新的空 light store，验证 loop contract、run ledger、share-safe log、run chat、review chat 均可恢复。

新增入口：

```bash
swift run WeChatIntelligenceRadar --loopops-action-check
```

最新结果摘录：

```text
loopops_action=pass
loopops_action_library_batch_run=true
loopops_action_library_marketplace_install_to_studio=true
loopops_action_library_marketplace_workspace_copy=true
loopops_action_library_batch_install_skips_run=true
loopops_action_library_installed_template_routes_copy=true
loopops_action_library_row_run=true
loopops_action_library_unready_loop_setup=true
loopops_action_same_contract_repeat_row_run_isolated=true
loopops_action_active_queue_selection_changes_result=true
loopops_action_studio_save=true
loopops_action_skill_stack_order=true
loopops_action_skill_stack_drag_payload=true
loopops_action_skill_stack_drop_reorder=true
loopops_action_skill_stack_remove_persists=true
loopops_action_new_knowledge=true
loopops_action_knowledge_attach_to_run=true
loopops_action_create_tool_starting_point=true
loopops_action_create_tool_import_starting_point=true
loopops_action_create_tool_form_fields=true
loopops_action_tool_log_source_tag=true
loopops_action_new_tool=true
loopops_action_run_chat_send=true
loopops_action_review_chat_send=true
loopops_action_share_safe_clone_targets_ledger=true
loopops_action_review_packet_upsert_updates_ledger=true
loopops_action_strict_snapshot_full_sync=true
loopops_action_strict_store_recovery=true
loopops_action_batch_run_count=2
loopops_action_tool_draft_id=action-tool-imported-review
loopops_action_row_run_contract_id=crypto-thesis-review
loopops_action_saved_contract_id=crypto-market-report-loop
loopops_action_skill_stack_id=action-stack-market-review
loopops_action_run_chat_scope_id=action-run-crypto-market-report-loop
loopops_action_selected_run_result_id=action-run-crypto-defi-opportunity-scan
loopops_action_selected_run_chat_scope_id=action-run-crypto-defi-opportunity-scan
```

同一 action harness 已接入：

- `swift run WeChatIntelligenceRadar --contract-check`
- `swift test` 的 `agentRuntimeChecks` 显式入口

这仍不是 AppKit/XCUITest 层面的像素点击验收；它证明的是用户动作背后的状态转移、持久化、隔离和安全边界已经可重复验证。

## 2026-06-24 追加 Native hardening pass

本轮按最新 Swift/App 审计继续补原生闭环，不新增外部执行能力，仍复用 `postMessageAsync` 与现有 review-only 边界：

- `BlocksWorkbenchView.swift`：Workbench composer 现在保留当前 template / contract 上下文。用户从 Loop Template 或 Loop Contract 填入任务后，提交会走 `DashboardViewModel.runLoopContract(..., loopOpsStore:)`，并清空 composer；不再退回普通 `submitAgentPrompt()`。
- `BlocksWorkbenchView.swift`：Workbench current run 区域下挂载 `Review Chat`，scope 为 `.review`，scopeID 使用当前 run，避免 Review Chat 只存在于模型枚举里。
- `LoopOpsViews.swift`：Run Chat follow-up 在有 selected contract 时走 contract-scoped run，保留 ledger/share-safe 捕获路径；无 contract 时才 fallback 到普通 selected session follow-up。
- `LoopOpsViews.swift`：Loop Library 主行 run 和 `Run selected` 会切回 Workbench；主行 run 会同步更新 detail context 到被点击的 contract，Open 继续只负责详情。
- `LoopOpsViews.swift` / `LoopOpsLocalStore.swift`：Share-safe `Clone as private loop` 和 `Replay run` 现在按 selected ledger 的 `loopContractID` 解析 contract，不再使用右侧 detail 里可能不一致的 selected contract。
- `LoopOpsInteractionContracts.swift` / `AgentRuntimeContractChecks.swift` / `WeChatIntelligenceRadarApp.swift`：Review Chat 的 panel、quick controls、input、send 都进入 stable interaction IDs、contract check 和 UI smoke。
- `LoopOpsAcceptanceHarness.swift`：action harness 新增 Review Chat 持久化和 Share-safe clone target 验收。
- `LoopOpsAcceptanceHarness.swift`：action harness 新增 `library_row_run=true` 和 `row_run_contract_id`，覆盖 Loop Library 主行运行语义。
- `LoopOpsLocalStore.swift`：启动时从 strict JSON snapshot 恢复缺失 light state；conversion 覆盖 contract、run ledger、review packet、share-safe log、run chat 和 review chat。
- `LoopOpsAcceptanceHarness.swift` / `AgentRuntimeContractChecks.swift`：新增空 light store + 现有 strict store 的恢复断言。

最新验证命令：

```bash
swift build
swift run WeChatIntelligenceRadar --contract-check
swift run WeChatIntelligenceRadar --loopops-action-check
swift run WeChatIntelligenceRadar --loopops-acceptance-check
swift run WeChatIntelligenceRadar --ui-smoke-check
swift test
cd domains/frontend/web/code/web-prototype
npm run smoke
npm run build
```

最新结果摘录：

```text
Build complete! (27.68s)
agent_runtime_contracts=pass
loopops_action=pass
loopops_action_review_chat_send=true
loopops_action_share_safe_clone_targets_ledger=true
loopops_action_review_packet_upsert_updates_ledger=true
loopops_action_strict_snapshot_full_sync=true
loopops_action_strict_store_recovery=true
loopops_acceptance=pass
loopops_acceptance_run_chats_isolated=true
ui_smoke_review_chat_visible=true
ui_smoke=pass
web_prototype_smoke=pass
✓ built in 573ms
Build complete! (2.34s)
```

本次追加 hardening 的实际命令摘录：

```text
swift build
Build complete! (8.67s)

swift run WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift run WeChatIntelligenceRadar --loopops-action-check
loopops_action=pass
loopops_action_library_marketplace_install_to_studio=true
loopops_action_library_marketplace_workspace_copy=true
loopops_action_library_row_run=true
loopops_action_library_unready_loop_setup=true
loopops_action_active_queue_selection_changes_result=true
loopops_action_row_run_contract_id=crypto-thesis-review
loopops_action_review_packet_upsert_updates_ledger=true
loopops_action_strict_snapshot_full_sync=true
loopops_action_strict_store_recovery=true

swift run WeChatIntelligenceRadar --loopops-acceptance-check
loopops_acceptance=pass

swift run WeChatIntelligenceRadar --ui-smoke-check
ui_smoke_review_chat_visible=true
ui_smoke=pass

swift test
Build complete! (2.57s)

npm run smoke
web_prototype_smoke=pass

npm run build
✓ built in 573ms
```

## 2026-06-24 追加 Web prototype 跨模块状态验收

本轮继续补强 `web-prototype/src/App.jsx` 与 `web-prototype/src/styles.css`：

- starter loop IDs 对齐 Swift 侧 crypto starters：`crypto-market-report-loop`、`crypto-defi-opportunity-scan`、`crypto-thesis-review`、`crypto-trade-plan-review`。
- Loop Library row click 不再只是展示 detail，会生成 Workbench active run，并同步生成 Final Answer、Review Packet、Share-safe Log 与 scoped Run Chat。
- Skill OS 新增 ordered skill stack 编辑区，支持 Add、Up、Down、Remove；Studio 保存 loop contract 时使用当前 stack 作为 execution path。
- Studio structured contract blocks 支持保存状态、Review changes、Reset draft，并能识别同一 stack 内 ordered bindings 的变更。
- Workbench 支持 Empty queue 和 Seeded review 模式，人工 review 可分别检查空队列和样例运行状态。
- Knowledge 新建 Blank 会插入列表并可 attach 到 Run Chat。
- Web DOM 增加稳定 `data-testid` 锚点，覆盖 Library、Workbench、Skill OS、Knowledge、Studio、Review Packet 和 Chat quick controls。
- Chat quick GUI 的 Temporary 状态现在会传入 `sendChat(..., { temporary: true })`，只显示 toast，不写入 transcript，和 Swift scoped chat 的 temporary 语义对齐。
- 右上 primary action 已按当前页面切换：Workbench/Loop Library 运行选中 loop，Skill OS 创建 tool，Studio 保存 Loop，Knowledge 新建 knowledge，Chat 发送 scoped message。
- Web 可见文本已过滤 `provider/runtime/gate/raw tool payload/schema field/worker` 与 em dash。

验证命令：

```bash
cd domains/frontend/web/code/web-prototype
npm run build
npm run review
```

当前运行态：

```text
VITE v6.4.2 ready
Local: http://127.0.0.1:5184/
```

构建结果摘录：

```text
dist/index.html                   0.41 kB
dist/assets/index-Cd3w_Tys.css   15.64 kB
dist/assets/index-CsjazYBi.js   240.56 kB
✓ built in 497ms
```

in-app browser action smoke 摘录：

```json
{
  "loopops.library.run.crypto-market-report-loop:count": 1,
  "afterRun": { "h1": "Workbench" },
  "loopops.library.review-decision.reviewed:count": 1,
  "loopops.skill-os.package.skill-builder:count": 1,
  "skillStackRows": 4,
  "loopops.knowledge.new-menu:count": 1,
  "knowledge": { "rowCount": 5 },
  "visibleText": { "bannedText": false, "h1": "Chat" }
}
```

本轮仍不声称 Web prototype 是生产后端；它是可人工 review 的交互前端原型，覆盖跨模块状态闭环。

## 2026-06-24 追加 Web prototype primary action 与焦点 smoke

本轮补齐页面级主动作和本地 WebKit 焦点合同：

- Workbench 与 Loop Library 右上 primary action 为 `Run selected`，继续写入 Workbench active queue。
- Skill OS 右上 primary action 为 `Create tool`，打开 Create Tool 起点。
- Studio 右上 primary action 为 `Save Loop`，保存当前 contract 与 ordered stack。
- Knowledge 右上 primary action 为 `New Knowledge`，打开知识来源菜单。
- Chat 右上 primary action 为 `Send message`，写入当前 scoped chat。
- Workbench Run Result 的 Skill Path 从箭头串联改成有序列表，避免窄卡片内断行不清。
- Studio structured contract blocks 改成可直接编辑，覆盖 steps、review rule、exit、output shape。
- Studio 增加 save-state strip、Review changes、Reset draft 和 ordered stack dirty feedback。
- Workbench 增加 Empty queue / Seeded review 切换，方便人工 review 空队列状态。
- Toast stack 最多显示两条，并自动清理旧消息。
- Sidebar nav badge 标记加 `aria-hidden`，nav button 使用页面名称作为 accessible label。
- Library row actions、Skill OS stack actions、Studio step actions、Workbench queue/review actions、Knowledge attach action 和 Chat quick controls 增加明确 `aria-label`。
- Focus-visible 样式已补到 button/input/select/textarea。

新增脚本：

```bash
cd domains/frontend/web/code/web-prototype
LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run focus:smoke
```

最新结果摘录：

```text
web_focus_smoke=pass
web_focus_surfaces=6
web_focus_summary=[{"focusables":57,"primary":"Run selected","primaryIndex":7,"surface":"Workbench"},{"focusables":55,"primary":"Run selected","primaryIndex":7,"surface":"Loop Library"},{"focusables":53,"primary":"Create tool","primaryIndex":7,"surface":"Skill OS"},{"focusables":50,"primary":"Save Loop","primaryIndex":7,"surface":"Studio"},{"focusables":36,"primary":"New Knowledge","primaryIndex":7,"surface":"Knowledge"},{"focusables":58,"primary":"Send message","primaryIndex":7,"surface":"Chat"}]
web_focus_manifest=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/product-design-audit-web/focus-smoke-manifest.json
```

## 2026-06-24 追加 Web prototype 源码 smoke

本轮新增 `web-prototype/scripts/smoke.mjs` 并接入 `npm run smoke`，用于不依赖浏览器手动点击即可重复检查 Web prototype 的核心合同：

- 六个页面入口存在：Workbench、Loop Library、Skill OS、Chat、Studio、Knowledge。
- Workbench 是默认入口。
- starter loop IDs 对齐 Swift 侧 crypto starters。
- Library、Workbench、Skill OS、Knowledge、Knowledge attach、Studio、Studio contract blocks、Review Packet、Chat quick controls 的核心 `data-testid` 锚点存在。
- 右上页面级 primary action 的测试锚点存在。
- Studio editable contract blocks 的测试锚点存在。
- Studio save-state、Review changes、Reset draft、Workbench empty/seeded mode 的测试锚点存在。
- Temporary chat 通过源码 smoke 断言不会写入 transcript；顶栏 Chat primary action 与 Chat workspace quick groups 也必须使用同一套 shared quick controls；Knowledge attach 必须更新 active Run Result knowledge list，并写入一个可见 Run Chat 事件；Create Tool 起点切换必须更新字段，并把当前起点写入日志；Run Chat 必须携带并过滤 active `runId`。
- Studio 使用 `Review rule`，不暴露 `Gate`。
- 可见源码不包含 `provider/runtime/gate/raw tool payload/schema field/worker` 与 em dash / en dash。

验证命令：

```bash
cd domains/frontend/web/code/web-prototype
npm run smoke
```

最新结果摘录：

```text
web_prototype_smoke=pass
web_prototype_starter_ids=4
web_prototype_testids=36
web_prototype_forbidden_terms=0
web_prototype_surfaces=6
```

2026-06-24 latest Run Chat isolation patch：

```text
npm run smoke
web_prototype_smoke=pass

npm run action:smoke
web_action_smoke=pass
web_action_row_click_launches_run=true
web_action_run_chats_isolated=true
web_action_no_browser_permissions=true

npm run build
dist/assets/index-DeYczbQi.css   17.07 kB
dist/assets/index-CE1QRVca.js   244.64 kB
✓ built in 541ms
```

## 2026-06-24 追加 Web prototype 无权限 action smoke

本轮新增 `web-prototype/scripts/action-smoke.mjs` 并接入 `npm run action:smoke`，用于在不触发 macOS 辅助功能、屏幕录制、WebKit 或 AppleScript 权限确认的前提下，验证用户关键动作背后的状态转移：

- Loop Library 选择两个 Loop 后 batch run，生成两个唯一 run id。
- Loop Library 主行点击会启动单个 run，并切到 Workbench 选中该 run；主行也支持 Enter/Space 键盘触发和 focus ring；Open 只负责详情。
- 每个 run 同步生成 Review Packet、Share-safe Log 与 run-scoped chat setup message。
- 选中第二个 run 后，Run Result 和 Run Chat 都只显示第二个 run 的上下文，不混入第一个 run 的 transcript。
- Temporary chat 不写入 transcript。
- Knowledge attach 更新当前 active run 的 Run Result knowledge list，写入当前 Run Chat，并产生 run-scoped attachment；切换到其他 run 后该 attachment 不可见。
- Loop run 会 materialize run-bound Tool logs；Run Result 可从对应 log 打开 Review Chat，并保留 `runId`、`toolLogId`、status、output 和 bound knowledge。
- Create Tool 的 `Import` starting point 会更新 modal 字段，并把 submitted mode 写入 tool log。
- Studio 保存时按当前 ordered Skill Stack materialize skill path。

验证命令：

```bash
cd domains/frontend/web/code/web-prototype
npm run action:smoke
```

最新结果摘录：

```text
web_action_smoke=pass
web_action_batch_runs=2
web_action_row_click_launches_run=true
web_action_unready_loop_routes_setup=true
web_action_run_ids_unique=true
web_action_run_chats_isolated=true
web_action_selected_run_id=run-crypto-trade-plan-review-action-smoke-2-1
web_action_knowledge_attach_run_scoped=true
web_action_tool_mode=Import
web_action_studio_skill_path=Evidence Skill > Final Answer Skill > CMC market radar
web_action_no_browser_permissions=true
```

## 2026-06-24 追加 Web prototype Product Design 截图审计

本轮新增 `web-prototype/scripts/capture-audit.swift` 并接入 `npm run audit:capture`。该脚本用本地 WebKit 渲染当前 `http://127.0.0.1:5184/`，按真实 `data-testid` 点击路径生成 11 张 PNG 和 manifest：

- `01-workbench-initial.png`
- `02-loop-library-database.png`
- `03-workbench-run-result.png`
- `04-skill-os-stack.png`
- `05-skill-os-stack-after-add.png`
- `06-studio-contract-page.png`
- `06b-studio-review-changes.png`
- `07-knowledge-new-menu.png`
- `08-knowledge-blank-created.png`
- `09-chat-quick-gui.png`
- `10-workbench-empty-state.png`

审计输出：

- `product-design-audit-web/screenshot-manifest.json`
- `product-design-audit-web/README.md`

验证命令：

```bash
cd domains/frontend/web/code/web-prototype
LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run audit:capture
```

最新结果摘录：

```text
web_audit_capture=pass
web_audit_capture_count=11
web_audit_capture_dir=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/product-design-audit-web
```

截图 QA 过程中发现并修复：

- Web prototype 默认入口从 Loop Library 改回 Workbench。
- Loop Library toolbar 搜索输入过窄和 sort/columns 截断问题。
- Toast stack 遮挡右侧 detail 和 Chat composer 控件的问题。
- Studio contract summary 从三列窄卡片改成 Notion 式 block list。
- 右上 primary action 从全局 `Run selected` 改成按页面语义变化。
- Workbench `Skill Path` 从箭头串联改成有序列表，避免窄卡片断行不清。
- Studio structured contract blocks 从只读摘要升级为可直接编辑的 block editors。
- Studio step editor 改成多行编辑，避免在 1280 宽度下只显示几个字母。
- Studio save-state 与 dirty stack/path feedback 已可见，并支持 Review changes / Reset draft。
- Workbench 增加空队列截图，验证 Empty queue 与 Seeded review 模式。
- `capture-audit.swift` 支持 `LOOPOPS_VIEWPORT_WIDTH` / `LOOPOPS_VIEWPORT_HEIGHT`，并会在任一步骤出现水平溢出时失败。
- `product-design-audit-web-mobile/` 保存 390 x 844 的同路径移动端截图与 README。
- Toast stack 改成最多两条并自动清理旧消息。
- Focus smoke 新增 `focus-smoke-manifest.json`，记录 6 个 surface 的 focus order 与 activeElement 检查。
- 最新 dark-mode contrast pass 修复 `.mainPane`、`.emptyState`、Chat quick GUI、Studio fields、contract textarea、composer textarea、quick-grid surfaces、`.dbHead`、`.miniRow` 和 `.miniRow.focused` 的深色模式覆盖，避免白底浅字和 Library focused ledger row 低对比；`npm run smoke` 现会断言这些 dark-mode selectors 存在。

2026-06-24 最新重跑结果：

```text
npm run build
✓ built in 981ms

npm run smoke
web_prototype_smoke=pass
web_prototype_testids=79
web_prototype_forbidden_terms=0

LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run audit:capture
web_audit_capture=pass
web_audit_capture_count=11

LOOPOPS_WEB_URL=http://127.0.0.1:5184/ LOOPOPS_VIEWPORT_WIDTH=390 LOOPOPS_VIEWPORT_HEIGHT=844 npm run audit:capture -- ../product-design-audit-web-mobile
web_audit_capture=pass
web_audit_capture_count=11
```

## 2026-06-24 追加 Context & tools / Knowledge attach hardening

本轮按 sub-agent 只读审计继续补两个用户可见缺口：

- Web prototype：Loop listing detail 新增 `Context & tools`，可勾选 Knowledge source 和 Skill OS tool。Loop row run、detail run、batch run 都会把绑定的 Knowledge/Tools 写入 run payload，Workbench Run Result 显示本次带入的 Knowledge 与 Tools。Skill OS tabs 调整为 `Build / Use / Logs`，Use 页按 selected tool required inputs 校验，缺输入写入 failed log，补齐后写 success log。
- Swift/App：Knowledge detail 新增 `Attach to latest run`，调用 `LoopOpsLocalStore.attachKnowledgeSource(...)`，更新 `linkedRunID` / `reuseMode` / `status`，并向 run chat 写入 attach receipt。`LoopOpsAcceptanceHarness.runActionChecks()` 新增 `knowledge_attach_to_run=true`。

Web 验证：

```text
npm run smoke
web_prototype_smoke=pass
web_prototype_starter_ids=4
web_prototype_testids=79
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

npm run action:smoke
web_action_smoke=pass
web_action_batch_runs=2
web_action_row_click_launches_run=true
web_action_unready_loop_routes_setup=true
web_action_library_ledger_open=true
web_action_resource_bindings=true
web_action_run_tool_logs_bound=true
web_action_run_tool_log_review_chat=true
web_action_run_ids_unique=true
web_action_run_chats_isolated=true
web_action_selected_run_id=run-crypto-trade-plan-review-action-smoke-2-1
web_action_knowledge_attach_run_scoped=true
web_action_knowledge_attach_updates_run=true
web_action_attachments_run_scoped=true
web_action_knowledge_starter_filter=true
web_action_tool_use_validation=true
web_action_tool_logs_scoped=true
web_action_tool_log_review_chat=true
web_action_tool_mode=Import
web_action_stack_drag_add=true
web_action_stack_drag_reorder=true
web_action_studio_skill_path=Evidence Skill > Final Answer Skill > CMC market radar
web_action_no_browser_permissions=true

npm run build
dist/assets/index-Ca2VxsIQ.css   22.13 kB
dist/assets/index-P8mNvIvl.js   257.92 kB
✓ built
```

Swift 验证：

```text
swift build
Build complete! (0.11s)

swift run WeChatIntelligenceRadar --loopops-action-check
loopops_action=pass
loopops_action_library_batch_run=true
loopops_action_library_marketplace_install_to_studio=true
loopops_action_library_marketplace_workspace_copy=true
loopops_action_library_batch_install_skips_run=true
loopops_action_library_installed_template_routes_copy=true
loopops_action_library_row_run=true
loopops_action_library_unready_loop_setup=true
loopops_action_active_queue_selection_changes_result=true
loopops_action_studio_save=true
loopops_action_skill_stack_order=true
loopops_action_skill_stack_drag_payload=true
loopops_action_skill_stack_drop_reorder=true
loopops_action_skill_stack_remove_persists=true
loopops_action_new_knowledge=true
loopops_action_knowledge_attach_to_run=true
loopops_action_create_tool_starting_point=true
loopops_action_create_tool_import_starting_point=true
loopops_action_create_tool_form_fields=true
loopops_action_tool_log_source_tag=true
loopops_action_new_tool=true
loopops_action_run_chat_send=true
loopops_action_review_chat_send=true
loopops_action_share_safe_clone_targets_ledger=true
loopops_action_review_packet_upsert_updates_ledger=true
loopops_action_strict_snapshot_full_sync=true
loopops_action_strict_store_recovery=true

swift test
Build complete! (5.76s)

swift run WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift run WeChatIntelligenceRadar --ui-smoke-check
ui_smoke=pass
```

Review URL health check:

```text
scripts/review-loopops-web.command
LoopOps Web review is already available: http://127.0.0.1:5184/
No browser or system app was opened.
```

## 2026-06-25 追加可见文案与无权限证据账本

本轮按只读审计修正 Swift/App 可见文案泄漏：Loop Library、Workbench、Studio 和 prompt preview 的 `Gate` 展示文案改为 `Review Rule` / `Review rule`，侧栏 `Runtime workspace` 改为 `Ops workspace`，share-safe omitted copy 改为 `local setup metadata` / `local setup selections`，不再向用户展示 `provider details`、`provider payloads` 或 `legacy runtime selection IDs`。底层 `feedbackGate` JSON 字段保持兼容。

新增 `checkLoopOpsVisibleCopyHidesInternalTerms()`，接入 `swift run WeChatIntelligenceRadar --contract-check` 和 `swift test` 的 LoopOps 检查入口。该检查覆盖代表性的 LoopOps visible copy、share-safe copy 和 `promptForRun()` 文案，断言旧的 `Feedback Gate`、`Gate:`、`Runtime workspace`、`provider details`、`provider payloads`、`legacy runtime selection ids`、`raw artifact paths` 不回流。

本轮重跑结果，其中 `--contract-check` 和 `swift test` 已包含 `checkLoopContractDraftInfersUnstructuredEnglishInstruction()`：

```text
npm run smoke
web_prototype_smoke=pass
web_prototype_starter_ids=4
web_prototype_testids=79
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

swift run WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift test
Build complete! (3.64s)

swift run WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=69
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=30

swift run WeChatIntelligenceRadar --loopops-interaction-coverage-check
loopops_interaction_coverage=pass
loopops_interaction_coverage_items=24
loopops_interaction_coverage_native_appkit_clicks_verified=false

swift run WeChatIntelligenceRadar --loopops-interaction-replay-check
loopops_interaction_replay=pass
loopops_interaction_replay_steps=24
loopops_interaction_replay_before_after_evidence=true
loopops_interaction_replay_native_appkit_clicks_verified=false

swift run WeChatIntelligenceRadar --loopops-native-activation-check
loopops_native_activation=pass
loopops_native_activation_activation_targets=9
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_native_appkit_clicks_verified=false
```

## 2026-06-25 追加 Web 共享交互模型与无弹窗 review 证据

本轮把 Web prototype 中原本由 `App.jsx` 和 `scripts/action-smoke.mjs` 各自实现的关键纯交互规则抽到 `web-prototype/src/loopopsModel.js`。共享范围包括 Loop readiness / installability / setup prompt、resource bindings、run-bound tool logs、Knowledge starter/filter、Tool draft、Tool Use required input validation、Tool Logs filter、Skill Stack 插入和删除。`App.jsx` 保留 React 状态更新和视图事件，`action-smoke.mjs` 调用同一模型来验证状态转移。随后又把 Workbench Review Guide 升级为带 progress、per-path checked state 和 4 条路径逐项核对的 manual review checklist。

本轮复跑：

```text
npm run action:smoke
web_action_smoke=pass
web_action_marketplace_install_to_studio=true
web_action_batch_runs=2
web_action_row_click_launches_run=true
web_action_unready_loop_routes_setup=true
web_action_run_chats_isolated=true
web_action_tool_use_validation=true
web_action_stack_drag_reorder=true
web_action_no_browser_permissions=true

npm run smoke
web_prototype_smoke=pass
web_prototype_starter_ids=4
web_prototype_testids=84
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

npm run build
dist/index.html                   0.40 kB
dist/assets/index-Bp2dY7IT.css   24.45 kB
dist/assets/index-BRQA3GUF.js   267.25 kB

npm run review:no-permission
web_no_permission_review=pass
web_no_permission_review_url=file:///Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/web/code/web-prototype/dist/loopops-admin-offline.html
web_no_permission_review_bind=none
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_no_permission_review_server=offline_fallback
web_no_permission_review_dom_smoke=skipped_server_unavailable
web_no_permission_review_dom_smoke_source=skipped_sandbox_file_navigation
web_offline_review=pass
web_offline_review_relative_path=dist/loopops-admin-offline.html
web_offline_review_bytes=292123
```

## 2026-06-25 追加 Native Workbench Review Guide 无权限验收证据

本轮把 native Workbench 的 Review Guide 加入 SwiftUI action wiring：新增 `loopops.workbench.review-guide`、progress、checklist、四条 path 和四条 checklist action 的稳定 interaction ID；Workbench 页面内可以从 Review Guide 进入 Loop Library、Skill OS、Knowledge 和 Chat，并在本地记录每条人工 review path 的 checked 状态。自动验收仍只做进程内状态证明，不打开 App、不调用 Accessibility、AppleScript、屏幕录制或浏览器控制。

本轮复跑：

```text
swift run WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift run WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_review_guide_actions=true
loopops_ui_action_no_system_permissions=true
loopops_ui_action_required_identifier_count=80
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=32

swift run WeChatIntelligenceRadar --loopops-interaction-coverage-check
loopops_interaction_coverage=pass
loopops_interaction_coverage_items=26
loopops_interaction_coverage_anchored_items=26
loopops_interaction_coverage_state_backed_items=26
loopops_interaction_coverage_no_system_permission_items=26
loopops_interaction_coverage_native_appkit_clicks_verified=false
loopops_interaction_coverage_native_appkit_click_gap_count=26

swift run WeChatIntelligenceRadar --loopops-interaction-replay-check
loopops_interaction_replay=pass
loopops_interaction_replay_steps=26
loopops_interaction_replay_state_mutation_steps=26
loopops_interaction_replay_no_system_permission_steps=26
loopops_interaction_replay_step_8=Workbench|Open Review Guide paths|loopops.workbench.review-guide.path.library|before:review_guide_path=not-started; selected_workspace=home|after:review_guide_paths=library,skill-os,knowledge,chat; selected_workspace=home
loopops_interaction_replay_step_9=Workbench|Mark Review Guide checklist|loopops.workbench.review-guide.checklist-done.library|before:review_guide_checked=0|after:review_guide_checked=4; progress=4/4

swift run WeChatIntelligenceRadar --loopops-native-activation-check
loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=11
loopops_native_activation_target=Workbench|loopops.workbench.review-guide.path.library|workbench_review_guide_paths=true
loopops_native_activation_target=Workbench|loopops.workbench.review-guide.checklist-done.library|workbench_review_guide_checklist=true

swift test
Build complete! (2.74s)
```

## 2026-06-25 追加 Native Manual Review Checklist 与脚本证据

本轮新增 `13-native-manual-review-checklist.md`，把 native App 人工 review 拆成 Workbench Review Guide、Loop Library marketplace/run flow、multi-run isolation、Skill OS Create Tool、Studio execution path、Knowledge attach、Run/Review Chat 和 Review boundary 八类路径。每条人工点击路径都绑定已有 no-permission harness evidence，明确哪些由状态检查证明，哪些仍需人工肉眼判断。

同时新增 `scripts/review-loopops-native.command`。该脚本只构建 debug app bundle、运行 native activation harness、打印 app/checklist 路径；不调用 `open`，不关闭旧进程，不调用 AppleScript、Accessibility、屏幕录制或浏览器自动化。脚本内部显式使用项目 `.build/*` cache，并用 `swift run --disable-sandbox` 避免 SwiftPM 在当前 Codex sandbox 内尝试嵌套 `sandbox-exec`。

本轮复跑：

```text
scripts/review-loopops-native.command
loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=11
Native manual review app: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/.build/debug-app/WeChatIntelligenceRadar.app
Native manual review checklist: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/13-native-manual-review-checklist.md
Open the app manually only when you are ready to review.
```

## 2026-06-25 追加 Web + Native 一键 Review Preflight

本轮新增 `scripts/review-loopops-all.command`，作为人工 review 前的统一入口。它串联 Web `npm run review:no-permission` 和 native `scripts/review-loopops-native.command`，最后打印 Web URL 或 offline HTML、native app bundle、native checklist 和 completion matrix。该入口不调用 `open`，不打开系统浏览器或 App，不使用 AppleScript、Accessibility、屏幕录制或外部浏览器自动化。

本轮复跑：

```text
scripts/review-loopops-all.command
web_no_permission_review=pass
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_no_permission_review_server=offline_fallback
web_offline_review=pass
loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=11
Web review offline HTML: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/web/code/web-prototype/dist/loopops-admin-offline.html
Native app bundle: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/.build/debug-app/WeChatIntelligenceRadar.app
Native checklist: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/13-native-manual-review-checklist.md
Completion matrix: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/10-objective-completion-matrix.md
Manual review record: scripts/record-loopops-review.command

scripts/review-loopops-web.command
LoopOps Web review is already available: http://127.0.0.1:5184/
No browser or system app was opened.

curl -I http://127.0.0.1:5184/  # unsandboxed local network probe
HTTP/1.1 200 OK
```

## 2026-06-25 追加 Manual Review Record 证据

本轮新增 `scripts/record-loopops-review.command`，把人工 review 的结论记录变成本地可复查产物。脚本默认生成 `pending-manual-review` 状态，不自动声称通过；人工 review 后可用 `LOOPOPS_REVIEW_STATUS`、`LOOPOPS_REVIEW_BLOCKERS`、`LOOPOPS_REVIEW_NOTES` 写入实际结论。该入口只写本地 Markdown + JSON，不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化。

本轮复跑：

```text
bash -n scripts/record-loopops-review.command
pass

scripts/record-loopops-review.command
loopops_manual_review_record=created
loopops_manual_review_status=pending-manual-review
loopops_manual_review_markdown=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-records/loopops-review-2026-06-25-120740.md
loopops_manual_review_json=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-records/loopops-review-2026-06-25-120740.json
This command did not open apps, browsers, or system automation surfaces.

jq . review-records/loopops-review-2026-06-25-120740.json
valid_json=true
```

## 2026-06-25 追加 Web Review Guide Record Handoff 证据

本轮把 manual review record 从脚本/文档层推进到 Web Workbench 的 Review Guide 中。`Review Guide` 现在显示 record command、pending/ready 状态、`LOOPOPS_REVIEW_STATUS` / `LOOPOPS_REVIEW_BLOCKERS` / `LOOPOPS_REVIEW_NOTES` 输入提示和 `review-records/loopops-review-*.md + .json` artifact 位置。页面里的 `Prepare record` 只标记 ready handoff，不声称人工 review 已通过。

本轮复跑：

```text
npm run smoke
web_prototype_smoke=pass
web_prototype_starter_ids=4
web_prototype_testids=90
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

npm run action:smoke
web_action_smoke=pass
web_action_no_browser_permissions=true

npm run review:no-permission
web_no_permission_review=pass
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_no_permission_review_server=offline_fallback
web_no_permission_review_dom_smoke=skipped_server_unavailable
web_no_permission_review_dom_smoke_source=skipped_sandbox_file_navigation
web_offline_review=pass
web_offline_review_bytes=294555
web_offline_review_css=assets/index-Cdr47NHI.css
web_offline_review_js=assets/index-CKJii6Ky.js

LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run dom:smoke
web_dom_smoke=pass
web_dom_review_guide_paths=true
web_dom_review_guide_evidence_map=true
web_dom_review_record_handoff=true
web_dom_no_browser_permissions=true

git diff --check
pass
```

## 2026-06-27 追加 5186 Objective Audit Refresh

本轮在最新 live review server `http://127.0.0.1:5186/` 上补跑 objective audit。该轮设置 `LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1`，因此没有重复 full `swift test`；但仍刷新了 Web smoke/action/no-permission review、Swift contract、LoopOps acceptance、UI action、interaction coverage、interaction replay 和 native activation 检查。路径仍保持 no-permission：不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化。

结果摘录：

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5186/ LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
web_no_permission_review=pass
web_dom_review_state_persistence=true
web_dom_builder_patch_receipt=true
agent_runtime_contracts=pass
loopops_acceptance=pass
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=138
loopops_ui_action_action_summary_count=42
loopops_interaction_coverage=pass
loopops_interaction_replay=pass
loopops_interaction_replay_step_count=35
loopops_native_activation=pass
loopops_native_activation_target_count=17
loopops_native_activation_no_system_permissions=true
swift_test=skipped_by_env
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-27 追加 Manager Gate Review-ready Mode

本轮给 `scripts/manager-loopops-acceptance-gate.command` 增加 `LOOPOPS_MANAGER_GATE_MODE=review-ready`。该模式只判断 evidence package 是否可交给人工 review，不把 pending human review 当成脚本失败；默认 `full` 模式不变，仍要求最新人工 review record 为 `pass` 且无 blockers。

结果摘录：

```text
LOOPOPS_MANAGER_GATE_MODE=review-ready scripts/manager-loopops-acceptance-gate.command
loopops_manager_gate_mode=review-ready
loopops_manager_gate_review_ready=pass
loopops_manager_gate_human_approved=false
skip human-approved latest manual review record is pending; review-ready is not human-approved
loopops_manager_gate=pass
loopops_manager_gate_failures=0

scripts/manager-loopops-acceptance-gate.command
loopops_manager_gate_mode=full
loopops_manager_gate_review_ready=pass
loopops_manager_gate_human_approved=false
fail human-approved latest manual review record is pending; review-ready is not human-approved
loopops_manager_gate=fail
loopops_manager_gate_failures=1
```

这让 manager/CI 可以区分两个问题：当前 package 是否 review-ready，以及是否已经完成用户人工批准。

## 2026-06-27 追加 Native Review Packet 与 Unified Session 证据

本轮把 native no-permission review 从终端日志升级为可复查 packet。`scripts/review-loopops-native.command` 现在会生成 Markdown/JSON packet，列出 app bundle、checklist、activation log、17 个 activation targets、17/17 state-backed/no-permission 计数，并明确 `nativeAppKitClicksVerified=false`。`scripts/review-loopops-all.command` 也会把该 native packet 写入统一 session Markdown/JSON。

本轮复跑：

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5186/ scripts/review-loopops-all.command
web_no_permission_review=pass
web_no_permission_review_url=http://127.0.0.1:5186/
web_no_permission_review_server=available
web_dom_smoke=pass
web_dom_no_browser_permissions=true

loopops_native_activation=pass
loopops_native_activation_activation_targets=17
loopops_native_activation_activation_state_backed=17
loopops_native_activation_no_system_permissions=true
loopops_native_activation_native_appkit_clicks_verified=false

Native review packet: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-review-packets/loopops-native-review-2026-06-27-003545.md
Native review packet json: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-review-packets/loopops-native-review-2026-06-27-003545.json
Review session markdown: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-27-003524.md
Review session json: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-27-003524.json
```

Manager gate now requires the latest native packet as part of review-ready evidence:

```text
loopops_manager_gate_latest_native_packet=domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/native-review-packets/loopops-native-review-2026-06-27-003545.json
pass latest_native_packet_json contains '"activationResult": "pass"'
pass latest_native_packet_json contains '"nativeAppKitClicksVerified": false'
pass latest_native_packet_json contains '"activationTargets": 17'
pass latest_native_packet_json contains '"stateBackedTargets": 17'
pass latest_native_packet_json contains '"noPermissionTargets": 17'
loopops_manager_gate_review_ready=pass
loopops_manager_gate_human_approved=false
loopops_manager_gate=fail
```

该失败仍是预期行为：最新人工 review record 仍为 `pending-manual-review`，自动 evidence packet 不能替代用户人工批准。

同轮 objective audit 已接入 native packet 检查：

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5186/ LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
pass contains '"reviewPacket":': review-sessions/loopops-session-2026-06-27-003524.json
pass contains '"reviewPacketJSON":': review-sessions/loopops-session-2026-06-27-003524.json
pass native review packet JSON exists
pass contains '"activationResult": "pass"': native-review-packets/loopops-native-review-2026-06-27-003545.json
pass contains '"activationTargets": 17': native-review-packets/loopops-native-review-2026-06-27-003545.json
pass contains '"stateBackedTargets": 17': native-review-packets/loopops-native-review-2026-06-27-003545.json
pass contains '"noPermissionTargets": 17': native-review-packets/loopops-native-review-2026-06-27-003545.json
pass contains '"nativeAppKitClicksVerified": false': native-review-packets/loopops-native-review-2026-06-27-003545.json
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-27 追加 5186 Live Review Session 与 Permission-safe Handoff Fix

本轮发现旧的 `5185` review server 已不可达；直接在 sandbox 内启动 Vite 返回 `listen EPERM`，这是本地监听被 sandbox 限制，不是 macOS Accessibility、屏幕录制或系统浏览器权限弹窗。随后使用允许的本地服务权限启动 Web review server，Vite 因 `5184/5185` 已占用自动切到 `http://127.0.0.1:5186/`，并通过 HTTP 200 验证。

同时修复 `scripts/review-loopops-all.command`：当调用方提供的 `LOOPOPS_WEB_URL` 可访问时，review session 优先记录 live URL；只有 live URL 不可访问时才使用 offline HTML fallback。这样人工 review packet 不会在 live server 已经存在时错误指向离线文件。

本轮复跑：

```text
curl -I http://127.0.0.1:5186/
HTTP/1.1 200 OK

LOOPOPS_WEB_URL=http://127.0.0.1:5186/ scripts/review-loopops-all.command
web_no_permission_review=pass
web_no_permission_review_url=http://127.0.0.1:5186/
web_no_permission_review_bind=127.0.0.1:5186
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_no_permission_review_server=available
web_no_permission_review_dom_smoke=true
web_no_permission_review_dom_smoke_source=local-http
web_dom_smoke=pass
web_dom_review_state_persistence=true
web_dom_library_explicit_run_action=true
web_dom_multi_run_queue=true
web_dom_run_chat_isolated=true
web_dom_builder_patch_receipt=true
web_dom_create_tool_flow=true
web_dom_knowledge_attach_updates_run=true
web_dom_no_browser_permissions=true

loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_native_appkit_clicks_verified=false
loopops_native_activation_activation_targets=17
loopops_native_activation_activation_state_backed=17

Review session markdown: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-27-002549.md
Review session json: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-27-002549.json
loopops_review_session=created
```

Manager gate 复查：

```text
scripts/manager-loopops-acceptance-gate.command
loopops_manager_gate_latest_session=domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-27-002549.json
loopops_manager_gate_review_ready=pass
loopops_manager_gate_human_approved=false
loopops_manager_gate_native_appkit_clicks_verified=false
loopops_manager_gate=fail
```

该失败仍是预期行为：最新人工 review record 仍为 `pending-manual-review`，自动化证据不能替代用户人工批准。

## 2026-06-26 追加 Web 15-Step Screenshot Refresh

本轮在当前 live review server `http://127.0.0.1:5184/` 上重新生成 desktop/mobile Product Design screenshot evidence。该路径使用本地 WebKit capture script，不调用系统浏览器、AppleScript、Accessibility、屏幕录制或外部 UI automation。

Desktop capture:

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run audit:capture
web_audit_capture=pass
web_audit_capture_count=15
capturedAt=2026-06-26T16:03:52Z
viewport=1280x820
horizontal_overflow=0
```

Mobile capture:

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5184/ LOOPOPS_VIEWPORT_WIDTH=390 LOOPOPS_VIEWPORT_HEIGHT=844 npm run audit:capture -- product-design-audit-web-mobile
web_audit_capture=pass
web_audit_capture_count=15
capturedAt=2026-06-26T16:04:16Z
viewport=390x844
horizontal_overflow=0
```

Current evidence files:

```text
product-design-audit-web/screenshot-manifest.json
product-design-audit-web-mobile/screenshot-manifest.json
human-review-gallery.html
16-human-review-gallery.md
```

This refresh supersedes earlier 14-step screenshot language for current review. It does not supersede the pending human review boundary or the native AppKit pixel-click gap.

## 2026-06-26 追加 Final Verification Refresh

本轮在更新 current review URL、15-step screenshot evidence 和 DOM selector drift 后重新跑核心验证。结果如下：

```text
npm run smoke
web_prototype_smoke=pass
web_prototype_testids=177
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

npm run action:smoke
web_action_smoke=pass
web_action_review_packet_history=true
web_action_knowledge_attachment_saved=true
web_action_knowledge_detach_undo=true
web_action_builder_patch_receipt=true
web_action_workspace_save_roundtrip=true
web_action_no_browser_permissions=true

npm run build
dist/assets/index-DkHU45pN.css   41.28 kB
dist/assets/index-GKeZp1vc.js   362.32 kB

npm run review:no-permission
web_no_permission_review=pass
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_no_permission_review_server=offline_fallback
web_offline_review=pass
web_offline_review_bytes=404023

LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run dom:smoke
web_dom_smoke=pass
web_dom_review_state_persistence=true
web_dom_library_explicit_run_action=true
web_dom_multi_run_queue=true
web_dom_run_chat_isolated=true
web_dom_builder_patch_receipt=true
web_dom_create_tool_flow=true
web_dom_knowledge_attach_updates_run=true
web_dom_no_browser_permissions=true

swift test
Build complete! (2.35s)

swift run WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

scripts/verify-loopops-traceability.command
loopops_traceability=pass
loopops_traceability_modules=8

LOOPOPS_WEB_URL=http://127.0.0.1:5184/ scripts/audit-loopops-objective.command
loopops_objective_audit=pass
loopops_objective_audit_failures=0
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_native_appkit_clicks_verified=false

scripts/manager-loopops-acceptance-gate.command
loopops_manager_gate_review_ready=pass
loopops_manager_gate_human_approved=false
loopops_manager_gate=fail

git diff --check
pass
```

`scripts/manager-loopops-acceptance-gate.command` 的 fail 是预期结果：最新人工 review record 仍为 `pending-manual-review`，所以当前状态只能交付给人工 review，不能标记为完成。

## 2026-06-27 追加 Native No-Permission Evidence Refresh

本轮同步 native manual review checklist 的当前验收数字，并复跑 native Swift harness。该路径仍然不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或外部浏览器自动化。

```text
swift run WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=138
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=42
loopops_ui_action_review_guide_actions=true
loopops_ui_action_workbench_review_state_persistence=true
loopops_ui_action_no_system_permissions=true

swift run WeChatIntelligenceRadar --loopops-interaction-replay-check
loopops_interaction_replay=pass
loopops_interaction_replay_step_count=35
loopops_interaction_replay_verified_count=35
loopops_interaction_replay_no_system_permission_count=35
loopops_interaction_replay_native_appkit_clicks_verified=false

swift run WeChatIntelligenceRadar --loopops-native-activation-check
loopops_native_activation=pass
loopops_native_activation_activation_targets=17
loopops_native_activation_activation_state_backed=17
loopops_native_activation_no_system_permissions=true
loopops_native_activation_native_appkit_clicks_verified=false
```

This strengthens native review readiness by making the current in-process action wiring counts explicit in `13-native-manual-review-checklist.md`. It still does not claim external AppKit/XCUITest pixel-click verification.

Native review preflight bundle refresh:

```text
scripts/review-loopops-native.command
Build complete! (2.43s)
.build/debug-app/WeChatIntelligenceRadar.app
loopops_native_activation=pass
loopops_native_activation_activation_targets=17
loopops_native_activation_activation_state_backed=17
loopops_native_activation_external_ui_automation=false
loopops_native_activation_native_appkit_clicks_verified=false
Native manual review app: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/.build/debug-app/WeChatIntelligenceRadar.app
Native manual review checklist: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/13-native-manual-review-checklist.md
```

SwiftPM printed user-level cache write warnings in the sandboxed shell, but the debug app bundle and native activation check completed successfully.

## 2026-06-26 Product Closure Delta

本轮根据人工 review 反馈继续补齐 Web prototype 的高影响闭环。重点是让点击后的状态、历史和结果可追踪，而不是只增加表面模块。

新增已落地：

- Create Tool 从 `name/description/scope` 扩展为可编辑 tool contract：`integration`、execution steps、outputs、review rule 会保存到 `makeToolDraft()` 生成的 Skill OS package 和 draft log。
- Builder Chat 不再直接改 Studio draft。它现在创建 `Builder Packet`，packet 有 `Pending / Applied / Rejected / Saved` 状态，Studio 页面展示 packet history、Apply/Reject action 和全字段 diff rows。Apply 后才更新 steps、output、review rule、exit 和 ordered Skill Stack；Save Loop 后 applied packet 标记为 Saved。
- Workbench active queue 增加集中 `applyRunLifecycleAction(runId, action)`，支持 Start/Pause/Resume/Complete/Fail/Cancel/Retry 类行内动作。动作会同步更新 `runs`、Review Packet status/events、Share-safe Log、run-bound Tool Logs 和 Run Chat event。
- Run Result 现在显示 `data-run-status`、attempt、structured lifecycle events、Review Packet status。Run Result 内嵌 Run Chat 使用 `lockedScope="run"`，隐藏 Builder/Review scope 切换，并固定读写当前 run 的 attachments。
- Knowledge attach 改成 id-bound：run 保存 `knowledgeIds`，source row 保存 `linkedRunIds/activity`，显示仍保留人类可读 source title。切换 run 时 attachment 仍按 `run:${runId}` 隔离。
- Skill OS Validate 成功会把 reusable action 反写到当前 run 的 `tools`、run-bound logs 和 run events，Run Result log list 会合并 run 内嵌 logs 与 Skill OS 全局 logs。

最新验证结果：

```text
npm run build
✓ built in 1.09s
dist/assets/index-BcnL2G8n.css   33.18 kB
dist/assets/index-C7UJ-b8Y.js   312.65 kB

npm run smoke
web_prototype_smoke=pass
web_prototype_testids=138
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

npm run action:smoke
web_action_smoke=pass
web_action_builder_patch_receipt=true
web_action_knowledge_attach_updates_run=true
web_action_tool_use_validation=true
web_action_no_browser_permissions=true

npm run dom:smoke
web_dom_smoke=pass
web_dom_builder_patch_receipt=true
web_dom_create_tool_flow=true
web_dom_tool_use_validation=true
web_dom_run_chat_isolated=true
web_dom_no_browser_permissions=true

npm run review:no-permission
web_no_permission_review=pass
web_no_permission_review_url=http://127.0.0.1:5184/
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_offline_review_path=dist/loopops-admin-offline.html
```

当前仍不声明完成：

- 这轮重点是 Web prototype。Swift/App 需要单独把同等 Create Tool contract、Builder Packet state machine、queue lifecycle 和 run-locked chat 做一次对齐审计。
- Web prototype 仍是本地前端状态机，不是生产后端执行器。
- Human review record 仍需用户实际 review 后写入。

## 2026-06-26 产品级交互 Polish Pass

用户人工 review 反馈：模块和 UI 结构已经存在，但很多功能仍像后端能力直接摆到前端，交互闭环和打磨不足。本轮采用模块级 explorer 审计后，由主线程统一集成，避免多个 worker 同时修改 `web-prototype/src/App.jsx` 造成上下文和视觉语言冲突。

本轮落地重点：

- `Loop Library` row 主点击改为打开详情/选中，不再误触启动 run；明确的 `Run / Install / Setup` 按钮才触发执行或配置。
- `Knowledge` starter 从“一点就创建占位行”改为 setup panel：填写 source name、source location/note、linked area、state 后才创建 source；row 主点击打开 source detail，Attach 是独立按钮，且只有 Ready source + active run 时可用。
- `Knowledge` attachment 文案从内部 `.knowledge` 后缀改为用户可读的 `source` attachment，并继续验证 run-scoped bucket 不串线。
- `Skill OS` Use tab 增加 active run validation context；`makeSkillRunLog` 写入 `runId / loopName / boundKnowledge`；Logs 默认支持 `All activity`、search、action/status/user filters，而不是只展示 selected skill。
- `Chat` request metadata 进入 transcript：model、Instant/Deep、Search on/off、attachment count 都随消息展示；关键 quick GUI command 现在会触发真实状态变更，例如 `Run selected loop` 和 `Mark reviewed`。
- `Run Result` 的 `Review Packet` 不再只显示状态，增加 notes 和 decision/event history；review decision 会追加 packet event。
- Product Design screenshot capture 更新到 Knowledge setup panel 和 explicit run action，不再截图旧占位行为。

最新验证：

```text
cd domains/frontend/web/code/web-prototype
npm run smoke
web_prototype_smoke=pass
web_prototype_testids=121
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

npm run action:smoke
web_action_smoke=pass
web_action_explicit_row_action_runs=true
web_action_knowledge_attach_run_scoped=true
web_action_tool_use_validation=true
web_action_builder_patch_receipt=true
web_action_no_browser_permissions=true

npm run review:no-permission
web_no_permission_review=pass
web_no_permission_review_url=http://127.0.0.1:5184/
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_dom_smoke=pass
web_dom_library_explicit_run_action=true
web_dom_tool_use_validation=true
web_dom_knowledge_attach=true
web_dom_attachments_run_scoped=true
web_dom_no_browser_permissions=true
web_offline_review=pass
web_offline_review_path=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/web/code/web-prototype/dist/loopops-admin-offline.html

git diff --check
pass
```

仍不声明完成的部分：

- `Create Tool` 还不是完整 contract editor，仍需要把 inputs、steps、outputs、review rule、integrations 做成可编辑结构。
- `Run Result` queue lifecycle 还没有 pause/cancel/retry/complete 等 durable actions。
- `Builder packet` 仍偏 chat receipt，没有完整 packet history / apply / reject / save 状态。
- Human visual/product approval 仍需人工 review record 更新后才能算完成。

随后取消 `LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST`，在同一 `http://127.0.0.1:5189/` review server 上跑完整 objective audit。该轮包含 full `swift test`：

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5189/ scripts/audit-loopops-objective.command
pass desktop capture manifest
capture_manifest_count=14
capture_manifest_has_05a=true
capture_manifest_has_05b=true
capture_manifest_has_06a=true
pass mobile capture manifest
capture_manifest_count=14
capture_manifest_has_05a=true
capture_manifest_has_05b=true
capture_manifest_has_06a=true
pass swift test
swift_test=pass
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-25 追加 Goal Completion Gate 与 5189 Pending Review Record

本轮完成一次 requirement-by-requirement completion audit 后，新增 `15-goal-completion-gate.md`。该文档明确区分两类状态：

- 自动证据已通过：研究文档、Web prototype、Swift/App no-permission action wiring、Product Design 14-step screenshot manifests、traceability verifier、full objective audit with `swift test`。
- 人工视觉/产品 review 尚未被用户记录为通过：不能把 `pending-manual-review` 误写成用户批准。

同时生成新的 5189 review record，避免旧 pending record 仍指向 `5184`：

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5189/ LOOPOPS_REVIEW_STATUS=pending-manual-review LOOPOPS_REVIEW_BLOCKERS=human-review-not-yet-recorded LOOPOPS_REVIEW_NOTES='Full no-permission objective audit passed with swift test; awaiting human visual/product review on 5189.' scripts/record-loopops-review.command
loopops_manual_review_record=created
loopops_manual_review_status=pending-manual-review
loopops_manual_review_markdown=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-records/loopops-review-2026-06-25-143957.md
loopops_manual_review_json=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-records/loopops-review-2026-06-25-143957.json
```

随后把 `15-goal-completion-gate.md` 纳入 traceability 和 objective audit 的必查文件：

```text
scripts/verify-loopops-traceability.command
pass file exists: domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/15-goal-completion-gate.md
pass contains 'status=pending-manual-review': domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/15-goal-completion-gate.md
pass contains 'loopops_objective_audit=pass': domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/15-goal-completion-gate.md
loopops_traceability_modules=8
loopops_traceability_no_system_permissions=true
loopops_traceability=pass
loopops_traceability_failures=0

LOOPOPS_WEB_URL=http://127.0.0.1:5189/ LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
pass file exists: domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/15-goal-completion-gate.md
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-25 追加 Human Review Gallery

本轮新增 `16-human-review-gallery.md`，把 desktop/mobile 14-step Product Design captures 整理成 reviewer-facing 路线图。它把每张截图对应到要检查的产品问题，例如 Workbench 默认入口、Loop Library database、Skill OS Create Tool、Tool Logs validation、Studio Builder patch receipt、Knowledge menu 和 Chat quick GUI。该文档不替代人工批准，只减少 reviewer 在 manifest、README、completion matrix 和 pending record 之间来回跳转。

```text
16-human-review-gallery.md
Desktop screenshots: product-design-audit-web/
Mobile screenshots: product-design-audit-web-mobile/
Latest pending record: review-records/loopops-review-2026-06-25-143957.md
```

随后把 `16-human-review-gallery.md` 纳入 index、completion gate、traceability verifier 和 objective audit：

```text
scripts/verify-loopops-traceability.command
pass file exists: domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/16-human-review-gallery.md
pass contains 'Human Review Gallery': domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/16-human-review-gallery.md
pass contains '05a-skill-os-create-tool-import.png': domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/16-human-review-gallery.md
pass contains '05b-skill-os-tool-logs-validation.png': domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/16-human-review-gallery.md
loopops_traceability_modules=8
loopops_traceability_no_system_permissions=true
loopops_traceability=pass
loopops_traceability_failures=0

LOOPOPS_WEB_URL=http://127.0.0.1:5189/ LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
pass file exists: domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/16-human-review-gallery.md
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-25 追加 Full Objective Audit With Swift Test

上一轮为了快速确认当前 `http://127.0.0.1:5189/` review server 使用了 `LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1`。本轮已在同一个 no-permission 路径上运行完整 objective audit，不设置 skip 环境变量，因此包含 full `swift test`。审计仍只使用本地 CLI、localhost WebKit/状态机和 Swift 进程内 harness，不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化。

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5189/ scripts/audit-loopops-objective.command
pass desktop capture manifest
capture_manifest_count=14
capture_manifest_overflow_count=0
capture_manifest_has_05a=true
capture_manifest_has_05b=true
capture_manifest_has_06a=true
pass mobile capture manifest
capture_manifest_count=14
capture_manifest_overflow_count=0
capture_manifest_has_05a=true
capture_manifest_has_05b=true
capture_manifest_has_06a=true
web_no_permission_review=pass
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_dom_review_record_handoff=true
web_dom_builder_patch_receipt=true
loopops_ui_action_required_identifier_count=110
loopops_ui_action_action_summary_count=37
loopops_interaction_coverage_item_count=31
loopops_interaction_replay_step_count=31
loopops_native_activation_target_count=15
swift_test=pass
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-25 追加 Tool Creation / Logs Screenshot Evidence

前一轮截图审计已覆盖 Skill OS stack 和 Studio Builder patch receipt，但缺少 Tool creation modal 与 Tool Logs validation 的独立可视证据。本轮用当前人工 review server `http://127.0.0.1:5189/` 重新跑 desktop/mobile WebKit capture，新增 `05a-skill-os-create-tool-import.png` 与 `05b-skill-os-tool-logs-validation.png`，并把 objective audit 的 manifest check 提升到 14 步。

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5189/ npm run audit:capture
web_audit_capture=pass
web_audit_capture_count=14
web_audit_capture_dir=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/product-design-audit-web

LOOPOPS_WEB_URL=http://127.0.0.1:5189/ LOOPOPS_VIEWPORT_WIDTH=390 LOOPOPS_VIEWPORT_HEIGHT=844 npm run audit:capture -- /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/product-design-audit-web-mobile
web_audit_capture=pass
web_audit_capture_count=14
web_audit_capture_dir=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/product-design-audit-web-mobile

product-design-audit-web/screenshot-manifest.json
capture_manifest_count=14
capture_manifest_steps=01,02,03,04,05,05a,05b,06,06a,06b,07,08,09,10
capture_manifest_overflow_count=0

product-design-audit-web-mobile/screenshot-manifest.json
capture_manifest_count=14
capture_manifest_steps=01,02,03,04,05,05a,05b,06,06a,06b,07,08,09,10
capture_manifest_overflow_count=0
```

## 2026-06-25 追加 Objective Audit 截图 Manifest 硬校验与 Full Swift Test

本轮把 `scripts/audit-loopops-objective.command` 从“检查截图文档存在”加强为“直接读取 desktop/mobile `screenshot-manifest.json`”。审计现在要求两个 Product Design 截图目录都满足：

- `screenshot-manifest.json` 存在。
- `03-workbench-run-result.png` 存在。
- `05a-skill-os-create-tool-import.png` 存在。
- `05b-skill-os-tool-logs-validation.png` 存在。
- `06a-studio-builder-patch-receipt.png` 存在。
- manifest 正好 `14` 个步骤。
- `capture_manifest_overflow_count=0`。
- `capture_manifest_has_05a=true`。
- `capture_manifest_has_05b=true`。
- `capture_manifest_has_06a=true`。

同时本轮不再用 `LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1`，完整 objective audit 已执行 `swift test --disable-sandbox` 并通过。该路径仍保持 no-permission：不打开浏览器或 App，不调用 AppleScript、Accessibility、屏幕录制或系统浏览器自动化。

本轮复跑摘录：

```text
bash -n scripts/audit-loopops-objective.command
pass

scripts/audit-loopops-objective.command
pass desktop capture manifest
capture_manifest_count=14
capture_manifest_overflow_count=0
capture_manifest_has_05a=true
capture_manifest_has_05b=true
capture_manifest_has_06a=true
pass mobile capture manifest
capture_manifest_count=14
capture_manifest_overflow_count=0
capture_manifest_has_05a=true
capture_manifest_has_05b=true
capture_manifest_has_06a=true
pass swift test
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

详细日志在 `.build/loopops-objective-audit/`，其中 `capture-manifest-desktop.txt`、`capture-manifest-mobile.txt` 和 `swift-test.txt` 是本轮新增硬证据的主要来源。

## 2026-06-25 追加 Native Review Guide Record Handoff 证据

本轮把 manual review record handoff 同步到 native Workbench 的 `Review Guide`。Native panel 现在显示 `Manual review record`、`Pending human review` / `Ready to record` 状态、`scripts/record-loopops-review.command` 命令、`LOOPOPS_REVIEW_STATUS / BLOCKERS / NOTES` 输入提示，以及 `review-records/loopops-review-*.md + .json` artifact 位置。`Prepare record` 只切换 ready handoff，不声称人工 review 已通过。

本轮复跑：

```text
swift run WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift run WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=83
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=33
loopops_ui_action_review_guide_actions=true
loopops_ui_action_no_system_permissions=true

swift run WeChatIntelligenceRadar --loopops-interaction-coverage-check
loopops_interaction_coverage=pass
loopops_interaction_coverage_items=27
loopops_interaction_coverage_anchored_items=27
loopops_interaction_coverage_state_backed_items=27
loopops_interaction_coverage_no_system_permission_items=27
loopops_interaction_coverage_native_appkit_clicks_verified=false

swift run WeChatIntelligenceRadar --loopops-interaction-replay-check
loopops_interaction_replay=pass
loopops_interaction_replay_steps=27
loopops_interaction_replay_step_10=Workbench|Prepare manual review record handoff|loopops.workbench.review-guide.record-prepare|before:review_record_status=pending; command=scripts/record-loopops-review.command|after:review_record_status=ready; command=scripts/record-loopops-review.command; inputs=status,blockers,notes

swift run WeChatIntelligenceRadar --loopops-native-activation-check
loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=12
loopops_native_activation_target=Workbench|loopops.workbench.review-guide.record-prepare|workbench_review_record_handoff=true

scripts/review-loopops-all.command
web_no_permission_review=pass
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_no_permission_review_server=offline_fallback
web_offline_review=pass
loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=12
loopops_native_activation_target=Workbench|loopops.workbench.review-guide.record-prepare|workbench_review_record_handoff=true

swift test
Build complete! (2.82s)

git diff --check
pass
```

## 2026-06-25 追加 Objective Audit 证据

本轮新增 `scripts/audit-loopops-objective.command`，把当前目标从“分散 smoke + 文档记录”收敛成一个可执行的 no-permission audit。它会检查研究文档和截图文件、Web prototype smoke/action/no-permission review、Swift/native action wiring、review 脚本是否调用系统 automation、manual review record artifact 是否存在，并明确输出外部 UI 自动化和 AppKit pixel-click 仍不属于当前默认验收路径。

该入口只调用本地 CLI 和进程内 harness，不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化。

本轮复跑：

```text
bash -n scripts/audit-loopops-objective.command
pass

scripts/audit-loopops-objective.command
loopops_traceability=pass
loopops_traceability_modules=8
web_prototype_testids=90 >= 90
web_action_smoke=pass
web_no_permission_review=pass
loopops_ui_action_required_identifier_count=83 >= 83
loopops_ui_action_action_summary_count=33 >= 33
loopops_interaction_coverage_item_count=27 >= 27
loopops_interaction_replay_step_count=27 >= 27
loopops_native_activation_target_count=12 >= 12
swift test
Build complete
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-25 追加 Agent-Team Traceability 证据

本轮新增 `14-agent-team-traceability-matrix.md` 与 `scripts/verify-loopops-traceability.command`。矩阵把八个模块从研究截图和模块文档一路映射到 Web prototype、Swift/App、自动 evidence 和人工 review 路径：

- `trace.marketplace_loop_library`
- `trace.knowledge_toast`
- `trace.tool_skill_os_logs`
- `trace.triple_chat_quick_gui`
- `trace.workbench_run_result`
- `trace.studio_builder_skill_path`
- `trace.no_permission_review`
- `trace.agent_team_process`

该 verifier 只读本地文件，不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化。它把原先“agent-team 过程证据偏叙述”的缺口收敛成 repo 内可复查的 source/evidence/manual-review 映射；仍不声称拥有原始 sub-agent transcript 日志。

本轮复跑：

```text
scripts/verify-loopops-traceability.command
loopops_traceability_modules=8
loopops_traceability_no_system_permissions=true
loopops_traceability=pass
loopops_traceability_failures=0
```

## 2026-06-25 追加 Product-visible Traceability 证据

本轮把 agent-team/module traceability 从文档矩阵推进到 Workbench Review Guide 的可见产品模块。Web prototype 现在有 `loopops.review-guide.traceability`、`loopops.review-guide.traceability-count` 和 8 个 `loopops.review-guide.traceability-row.*`；native Workbench Review Guide 对应有 `loopops.workbench.review-guide.traceability`、`loopops.workbench.review-guide.traceability-count` 和同一组 row IDs。人工 review 时可以直接在 Workbench 看到 research -> implementation -> evidence 的模块链路，而不是只去读文档。

本轮复跑：

```text
npm run smoke
web_prototype_smoke=pass
web_prototype_testids=93
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

npm run action:smoke
web_action_smoke=pass
web_action_marketplace_install_to_studio=true
web_action_knowledge_attach_updates_run=true
web_action_stack_drag_reorder=true
web_action_no_browser_permissions=true

swift run --disable-sandbox WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=93
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=34
loopops_ui_action_review_guide_actions=true
loopops_ui_action_no_system_permissions=true

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-interaction-coverage-check
loopops_interaction_coverage=pass
loopops_interaction_coverage_items=28
loopops_interaction_coverage_anchored_items=28
loopops_interaction_coverage_state_backed_items=28
loopops_interaction_coverage_no_system_permission_items=28
loopops_interaction_coverage_native_appkit_clicks_verified=false

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-interaction-replay-check
loopops_interaction_replay=pass
loopops_interaction_replay_steps=28
loopops_interaction_replay_step_10=Workbench|Review agent-team traceability|loopops.workbench.review-guide.traceability|before:traceability_visible=false|after:traceability_visible=true; modules=8; verifier=scripts/verify-loopops-traceability.command

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-native-activation-check
loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=13
loopops_native_activation_target=Workbench|loopops.workbench.review-guide.traceability|workbench_traceability_modules=8

scripts/verify-loopops-traceability.command
loopops_traceability_modules=8
loopops_traceability_no_system_permissions=true
loopops_traceability=pass
loopops_traceability_failures=0

scripts/audit-loopops-objective.command
pass output contains 'Review agent-team traceability'
pass output contains 'workbench_traceability_modules=8'
pass swift test
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0

git diff --check
pass
```

## 2026-06-25 追加 Native Review Guide AppStorage Persistence

为避免人工 review 过程中因为刷新、重开或权限弹窗绕路导致 checklist 状态丢失，native Workbench `Review Guide` 的 started paths、checked paths、record prepared、review decision、blockers 和 notes 已迁移到 `@AppStorage`。UI 同时展示 `Saved locally` 和 copy-ready record command preview；该路径仍不调用 Accessibility、AppleScript、屏幕录制、系统浏览器或外部 AppKit 点击自动化。

本轮复跑：

```text
swift run WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift run WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_workbench_review_record_preview=true
loopops_ui_action_workbench_review_state_persistence=true

swift run WeChatIntelligenceRadar --loopops-native-activation-check
loopops_native_activation=pass
loopops_native_activation_target_count=17
loopops_native_activation_no_system_permissions=true
workbench_review_record_preview=true
workbench_review_state_persistence=true
```

## 2026-06-25 追加 Human Review Gallery 与 5189 快审计

本轮为人工 review 增加静态 gallery handoff：`16-human-review-gallery.md` 提供逐项验收说明，`human-review-gallery.html` 把 desktop/mobile Product Design 截图并排展示，方便不触发系统权限弹窗地人工检查。HTML 只引用本地截图资源，不自动打开浏览器，不调用系统 UI 自动化。

本轮复跑：

```text
curl -I http://127.0.0.1:5189/
HTTP/1.1 200 OK

human-review-gallery.html
html_png_refs=56
html_missing_refs=0

scripts/verify-loopops-traceability.command
pass file exists: domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/human-review-gallery.html
pass contains 'LoopOps Human Review Gallery'
pass contains '05a-skill-os-create-tool-import.png'
pass contains '05b-skill-os-tool-logs-validation.png'
pass contains '06a-studio-builder-patch-receipt.png'
loopops_traceability=pass
loopops_traceability_failures=0

LOOPOPS_WEB_URL=http://127.0.0.1:5189/ LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
pass file exists: domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/16-human-review-gallery.md
pass file exists: domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/human-review-gallery.html
web_action_smoke=pass
web_action_no_browser_permissions=true
web_no_permission_review=pass
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-25 追加 Review Record Command Preview

本轮把 Workbench 的人工 review handoff 从“显示 recorder 脚本和输入字段”补强为“显示完整命令预览”。界面现在提供 `LOOPOPS_WEB_URL`、`LOOPOPS_REVIEW_STATUS`、`LOOPOPS_REVIEW_BLOCKERS`、`LOOPOPS_REVIEW_NOTES` 和 `scripts/record-loopops-review.command` 的可见组合，仍然只作为人工 review 后的落盘路径，不自动执行、不打开浏览器、不触发系统 UI 权限。

本轮新增验收信号：

```text
loopops.review-guide.record-preview
web_dom_review_record_preview=true
web_dom_review_state_persistence=true
workbench_review_record_preview=true
record_preview_inputs=LOOPOPS_WEB_URL,LOOPOPS_REVIEW_STATUS,LOOPOPS_REVIEW_BLOCKERS,LOOPOPS_REVIEW_NOTES
record_preview_command=scripts/record-loopops-review.command
record_preview_no_system_permissions=true
review_state_persistence=localStorage loopops.review-guide.v1
```

## 2026-06-25 追加 Native Evidence Map Parity 证据

本轮把 Web Review Guide 已有的 `Evidence map` 同步到 native Workbench Review Guide。Native 现在显示 Marketplace listing、Knowledge and toast、Tool builder logs、Triple quick GUI 四个来源，每行对应 applied product mapping 和 manual check；这让 App 内人工 review 可以直接看到 reference source -> LoopOps check，而不是只依赖 Web prototype 或文档。

本轮复跑：

```text
swift run --disable-sandbox WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=99
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=35
loopops_ui_action_review_guide_actions=true
loopops_ui_action_no_system_permissions=true

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-interaction-coverage-check
loopops_interaction_coverage=pass
loopops_interaction_coverage_items=29
loopops_interaction_coverage_anchored_items=29
loopops_interaction_coverage_state_backed_items=29
loopops_interaction_coverage_no_system_permission_items=29
loopops_interaction_coverage_native_appkit_clicks_verified=false

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-interaction-replay-check
loopops_interaction_replay=pass
loopops_interaction_replay_steps=29
loopops_interaction_replay_step_10=Workbench|Review source evidence map|loopops.workbench.review-guide.evidence-map|before:evidence_map_visible=false|after:evidence_map_visible=true; sources=marketplace,knowledge,tool,triple

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-native-activation-check
loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=14
loopops_native_activation_target=Workbench|loopops.workbench.review-guide.evidence-map|workbench_evidence_map_sources=4

scripts/audit-loopops-objective.command
pass output contains 'Review source evidence map'
pass output contains 'workbench_evidence_map_sources=4'
pass output contains 'workbench_traceability_modules=8'
pass swift test
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-25 追加 Product-visible Review Decision 证据

本轮把人工 review 的结果闭环从单纯的 command handoff 推进到产品内可见的 `Review decision` board。Web 和 native Workbench Review Guide 现在都能显示 pending / needs work / approved 状态，并在产品内保留 blockers 与 notes，再由 `scripts/record-loopops-review.command` 负责落盘为 Markdown/JSON。默认 blockers 明确保留 native pixel-click 需要显式授权的边界，不把未授权的外部 UI 自动化伪装成已完成。

本轮复跑：

```text
npm run smoke
web_prototype_smoke=pass
web_prototype_testids=102
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

swift run --disable-sandbox WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=108
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=36
loopops_ui_action_review_guide_actions=true
loopops_ui_action_no_system_permissions=true

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-interaction-coverage-check
loopops_interaction_coverage=pass
loopops_interaction_coverage_items=30
loopops_interaction_coverage_anchored_items=30
loopops_interaction_coverage_state_backed_items=30
loopops_interaction_coverage_no_system_permission_items=30
loopops_interaction_coverage_native_appkit_clicks_verified=false

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-interaction-replay-check
loopops_interaction_replay=pass
loopops_interaction_replay_steps=30
loopops_interaction_replay_step_12=Workbench|Set manual review decision|loopops.workbench.review-guide.decision|before:review_decision=pending; blockers=permission_path_required|after:review_decision=needs_work; blockers_recorded=true; notes_recorded=true; record_fields=status,blockers,notes

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-native-activation-check
loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=15
loopops_native_activation_target=Workbench|loopops.workbench.review-guide.decision|workbench_review_decision_board=true

scripts/audit-loopops-objective.command
pass output contains 'Set manual review decision'
pass output contains 'workbench_review_decision_board=true'
pass output contains 'workbench_evidence_map_sources=4'
pass output contains 'workbench_traceability_modules=8'
pass swift test
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```

## 2026-06-25 追加 Review Session Packet 证据

本轮把 `scripts/review-loopops-all.command` 从一次性终端输出升级为可复查的 review session packet。脚本仍然不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或外部浏览器自动化；它会同时生成 Markdown/JSON session、Web log 和 native log，并记录实际 Web URL 或 offline HTML。这样当 Vite 从默认端口切换到其他端口时，人工 review 以 session 文件为准，不再依赖固定 `5184` 假设。

本轮复跑：

```text
scripts/review-loopops-all.command
web_no_permission_review=pass
web_no_permission_review_url=http://127.0.0.1:5184/
web_no_permission_review_bind=127.0.0.1:5184
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_no_permission_review_server=available
web_no_permission_review_dom_smoke=true
web_no_permission_review_dom_smoke_source=local-http
web_offline_review=pass
web_offline_review_path=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/web/code/web-prototype/dist/loopops-admin-offline.html
web_dom_smoke=pass
web_dom_no_browser_permissions=true

loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=15

Web review URL: http://127.0.0.1:5184/
Native app bundle: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/.build/debug-app/WeChatIntelligenceRadar.app
Native checklist: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/13-native-manual-review-checklist.md
Completion matrix: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/10-objective-completion-matrix.md
Review session markdown: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-25-131810.md
Review session json: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-25-131810.json
loopops_review_session=created
```

新增 objective audit 覆盖：

```text
LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
pass contains 'review-sessions/loopops-session-*.md'
pass contains 'review-sessions/loopops-session-*.md/.json'
pass contains 'loopops_review_session=created'
pass manual review session JSON exists
pass manual review session Markdown exists
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0

swift test --disable-sandbox
Build complete! (0.17s)
```

## 2026-06-25 追加 Builder Chat Patch Receipt 证据

本轮把 Builder Chat 从“提交后只说已记录”推进为产品内可见的 structured patch receipt。用户在 Studio Builder Chat 输入自然语言或带标签的修改指令后，Loop Contract 顶部会显示 `Structured patch applied` 或 no-match guidance，并列出 steps count、ordered skill path、review rule、exit condition、output shape；Builder Chat assistant receipt 也写入同一份结构化结果。该改动继续保持 no-permission 路径，不调用系统 UI 自动化。

本轮复跑：

```text
swift test --disable-sandbox
Build complete! (23.30s)

swift run --disable-sandbox WeChatIntelligenceRadar --contract-check
agent_runtime_contracts=pass

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-ui-action-check
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=110
loopops_ui_action_dynamic_identifier_count=17
loopops_ui_action_action_summary_count=37
loopops_ui_action_no_system_permissions=true

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-interaction-coverage-check
loopops_interaction_coverage=pass
loopops_interaction_coverage_items=31
loopops_interaction_coverage_anchored_items=31
loopops_interaction_coverage_state_backed_items=31
loopops_interaction_coverage_no_system_permission_items=31
loopops_interaction_coverage_native_appkit_clicks_verified=false

swift run --disable-sandbox WeChatIntelligenceRadar --loopops-interaction-replay-check
loopops_interaction_replay=pass
loopops_interaction_replay_steps=31
loopops_interaction_replay_step_20=Studio|Apply Builder Chat patch receipt|loopops.studio.builder-patch-receipt|before:builder_patch_receipt=empty; step_summary=Old step|after:builder_patch_receipt=Structured patch applied; steps=4; skill_path=CoinMarketCap market radar -> CMC Skill Hub capability -> Market regime review

LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
pass contains 'builder_patch_receipt=true'
pass contains 'Builder patch receipt'
pass output contains 'Apply Builder Chat patch receipt'
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0

scripts/review-loopops-all.command
web_no_permission_review=pass
web_no_permission_review_url=http://127.0.0.1:5184/
loopops_native_activation=pass
Native app bundle: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/.build/debug-app/WeChatIntelligenceRadar.app
Review session markdown: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-25-132653.md
loopops_review_session=created
```

## 2026-06-25 追加 Web Builder Patch Receipt Parity 证据

本轮把上一段 native Builder Chat patch receipt 补到 Web prototype。Web `loopopsModel.js` 新增 `makeBuilderDraftPatch` / `applyBuilderDraftPatch`，`App.jsx` 的 Builder scoped chat 会把结构化 receipt 写入 Studio 的 `loopops.studio.builder-patch-receipt`，同时把 assistant message 改成同一份 receipt。Web action smoke 验证自然语言一次性更新 steps、ordered Skill Stack、output shape 和 Builder Chat transcript。

本轮复跑：

```text
npm run smoke
web_prototype_smoke=pass
web_prototype_starter_ids=4
web_prototype_testids=104
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

npm run action:smoke
web_action_smoke=pass
web_action_builder_patch_receipt=true
web_action_no_browser_permissions=true
```

## 2026-06-25 追加 Web DOM Builder Patch Receipt 证据

本轮把 Web Builder patch receipt 从源码 smoke / action smoke 推进到真实 DOM 点击验收。`dom-smoke.swift` 会打开 Studio，切到 Builder Chat，输入包含 `steps`、`skill path`、`review rule`、`exit`、`output shape` 的结构化指令，点击 `Send Builder chat message`，然后验证 Loop Contract 顶部 receipt、steps textarea、output textarea 和 Builder Chat transcript。

本轮复跑：

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run dom:smoke
web_dom_smoke=pass
web_dom_builder_patch_receipt=true
web_dom_no_browser_permissions=true
```

## 2026-06-25 追加 Web Screenshot Builder Receipt 与 Overflow Fix 证据

本轮把 Web Builder patch receipt 从 DOM/action 证据推进到截图审计证据。`capture-audit.swift` 在 Studio 中切到 Builder Chat，输入结构化指令并点击发送，然后新增 `06a-studio-builder-patch-receipt.png`。截图中可见 `Structured patch applied`、`steps=4`、ordered skill path、review rule、exit condition 和 output shape。截图审计同时修复两处人工 review 可见问题：

- Workbench Run Result 的 run-bound tool log 行以前使用过多固定列宽，在第 03 步撑出页面右侧；现在改为可压缩 database 行，短字段省略，长描述换行。
- Listing Detail 的 install-state 以前会在长 workspace copy id 旁把 `Installed` 挤成竖排；现在左侧状态保持自然宽度，右侧 copy 文本在弹性列中换行。

本轮仍保持 no-permission review 路径：不调用 AppleScript、Accessibility、屏幕录制、Computer Use 或系统浏览器自动点击。

本轮复跑：

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run audit:capture
web_audit_capture=pass
web_audit_capture_count=12
web_audit_capture_dir=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/product-design-audit-web

LOOPOPS_WEB_URL=http://127.0.0.1:5184/ LOOPOPS_VIEWPORT_WIDTH=390 LOOPOPS_VIEWPORT_HEIGHT=844 npm run audit:capture -- /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/product-design-audit-web-mobile
web_audit_capture=pass
web_audit_capture_count=12
web_audit_capture_dir=/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/product-design-audit-web-mobile

npm run smoke
web_prototype_smoke=pass
web_prototype_starter_ids=4
web_prototype_testids=104
web_prototype_forbidden_terms=0
web_prototype_surfaces=6

npm run action:smoke
web_action_smoke=pass
web_action_builder_patch_receipt=true
web_action_no_browser_permissions=true

LOOPOPS_WEB_URL=http://127.0.0.1:5184/ npm run dom:smoke
web_dom_smoke=pass
web_dom_builder_patch_receipt=true
web_dom_no_browser_permissions=true

npm run build
vite v6.4.2 building for production...
✓ built in 649ms

git diff --check
pass
```

## 2026-06-25 追加 5189 Review Session 与 Evidence Sync

本轮人工 review server 因 `5184-5188` 已被占用，Vite 自动切到 `http://127.0.0.1:5189/`。沙盒内直接绑定 `127.0.0.1` 曾返回 `listen EPERM`，这是 sandbox 网络限制，不是 macOS 隐私权限弹窗。处理方式保持 no-permission：不用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化，只使用本地 HTTP URL 或 offline HTML fallback。

本轮复跑：

```text
curl -I http://127.0.0.1:5189/
HTTP/1.1 200 OK

LOOPOPS_WEB_URL=http://127.0.0.1:5189/ scripts/review-loopops-all.command
web_no_permission_review=pass
web_no_permission_review_url=http://127.0.0.1:5189/
web_no_permission_review_bind=127.0.0.1:5189
web_no_permission_review_auto_open=false
web_no_permission_review_system_automation=false
web_no_permission_review_server=available
web_no_permission_review_dom_smoke=true
web_no_permission_review_dom_smoke_source=local-http
web_offline_review=pass
web_offline_review_bytes=303942
web_offline_review_css=assets/index-DRzqSk-K.css
web_offline_review_js=assets/index-BGRZdesK.js
web_dom_smoke=pass
web_dom_builder_patch_receipt=true
web_dom_no_browser_permissions=true

loopops_native_activation=pass
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_activation_targets=15
loopops_native_activation_activation_state_backed=15

Review session markdown: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-25-141620.md
Review session json: /Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-2026-06-25-141620.json
loopops_review_session=created
```

随后用当前 session URL 跑快速 objective audit，同步最新 harness counts：

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5189/ LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
pass output contains 'web_dom_builder_patch_receipt=true'
pass loopops_ui_action_required_identifier_count=110 >= 83
pass loopops_ui_action_action_summary_count=37 >= 33
pass loopops_interaction_coverage_item_count=31 >= 27
pass loopops_interaction_replay_step_count=31 >= 27
pass loopops_native_activation_target_count=15 >= 12
pass output contains 'workbench_evidence_map_sources=4'
pass output contains 'workbench_review_decision_board=true'
pass output contains 'workbench_traceability_modules=8'
pass output contains 'workbench_review_record_handoff=true'
swift_test=skipped_by_env
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0

git diff --check
pass
```

## 2026-06-27 追加 5186 Objective Audit Refresh

本轮在最新 live review server `http://127.0.0.1:5186/` 上补跑 objective audit。该轮设置 `LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1`，因此没有重复 full `swift test`；但仍刷新了 Web smoke/action/no-permission review、Swift contract、LoopOps acceptance、UI action、interaction coverage、interaction replay 和 native activation 检查。路径仍保持 no-permission：不调用 `open`、AppleScript、Accessibility、屏幕录制、Chrome/Safari 或系统浏览器自动化。

结果摘录：

```text
LOOPOPS_WEB_URL=http://127.0.0.1:5186/ LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
web_no_permission_review=pass
web_dom_review_state_persistence=true
web_dom_builder_patch_receipt=true
agent_runtime_contracts=pass
loopops_acceptance=pass
loopops_ui_action=pass
loopops_ui_action_required_identifier_count=138
loopops_ui_action_action_summary_count=42
loopops_interaction_coverage=pass
loopops_interaction_replay=pass
loopops_interaction_replay_step_count=35
loopops_native_activation=pass
loopops_native_activation_target_count=17
loopops_native_activation_no_system_permissions=true
swift_test=skipped_by_env
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
loopops_objective_audit=pass
loopops_objective_audit_failures=0
```
