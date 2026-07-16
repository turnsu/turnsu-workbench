# Agent Team Traceability Matrix

本文把“研究截图 -> 模块文档 -> Web prototype -> Swift/App -> 自动证据 -> 人工 review 路径”串成一张可审计矩阵。它补足 `07-agent-team-final-audit.md` 的过程证据缺口：不再只说 agent team 做过审计，而是让每个模块都有可追踪的源码、命令和人工验收入口。

## Scope Boundary

- 本文证明的是 repo 内可复查的分工链路和落地证据。
- 本文不伪造 sub-agent 原始 transcript。原始对话级证据不在 repo 内，仍以 `07-agent-team-final-audit.md` 的只读审计记录和当前源码/命令为准。
- 本文不声称 native AppKit/XCUITest pixel-click 已完成。该边界仍按 `12-remaining-decision-contract.md` 处理。
- 本文不扩展未提供 URL 的 Triple 产品本体研究。Triple 默认按 quick GUI/chatbot scope 收口。

## Module Traceability

| Trace ID | Module | Research source | Product mapping | Web implementation evidence | Swift/App implementation evidence | Automated evidence | Manual review route |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `trace.marketplace_loop_library` | Marketplace / Loop Library | `01-marketplace-template-library.md`; screenshots `01`, `02`, `03` | RelevanceAI marketplace rows, listing detail, readiness, install/clone mapped to Loop Library | `web-prototype/src/App.jsx` has `loopops.nav.library`, `loopops.library.marketplace-install-state`, `loopops.review-guide.path.marketplace`; `scripts/smoke.mjs` requires Library and Review Guide anchors | `LoopOpsInteractionID.loopLibraryTemplateMarketplace`; `LoopOpsAcceptanceHarness` covers `library_marketplace_install_to_studio`, batch run, row run, unready setup | `web_action_marketplace_install_to_studio=true`; `web_dom_marketplace_install_to_studio=true`; `loopops_action_library_marketplace_install_to_studio=true`; native activation covers Library run paths | `13-native-manual-review-checklist.md` rows `Loop Library marketplace`, `Loop Library run flow`, `Multi-run isolation` |
| `trace.knowledge_toast` | Knowledge / Toast | `02-knowledge-toast-system.md`; screenshots `04`, `05` | Knowledge library, New Knowledge menu, source status, attach to run, transient toast | `loopops.knowledge.new-menu`, `loopops.knowledge.starter.website`, `loopops.review-guide.path.knowledge`; Web model covers starter/filter/attach | `LoopOpsInteractionID.knowledgeNewMenu`, `LoopOpsInteractionID.knowledgeToastStack`; `LoopOpsLocalStore.showToast`; `LoopOpsAcceptanceHarness` covers new source and attach | `web_action_knowledge_attach_updates_run=true`; `web_dom_knowledge_attach_updates_run=true`; `loopops_action_new_knowledge=true`; `loopops_action_knowledge_attach_to_run=true` | Checklist rows `Knowledge attach` and Workbench Review Guide Knowledge path |
| `trace.tool_skill_os_logs` | Tool Creation / Skill OS / Logs | `03-tool-creation-logs.md`; screenshots `06`, `07`, `08`, `09`; Product Design captures `05a`, `05b` | RelevanceAI Tools list, New Tool starting points, Build/Use/Logs, required input validation, log source | `loopops.skill-os.create-tool`, `loopops.skill-os.create-tool-modal`, `loopops.skill-os.logs`, `loopops.review-guide.path.tool`; Web Create Tool flow inserts a public Skill OS row; capture audit includes `05a-skill-os-create-tool-import.png` and `05b-skill-os-tool-logs-validation.png` | `LoopOpsInteractionID.skillOSCreateTool*`, `LoopOpsInteractionID.skillOSToolLogs`; `LoopOpsToolDraft`, `LoopOpsToolLog`, `LoopOpsAcceptanceHarness` cover Import/form/source log | `web_action_tool_use_validation=true`; `web_action_tool_log_review_chat=true`; `web_dom_create_tool_flow=true`; `web_audit_capture_count=15`; `loopops_action_create_tool_import_starting_point=true`; `loopops_action_tool_log_source_tag=true` | Checklist row `Skill OS Create Tool` |
| `trace.triple_chat_quick_gui` | Triple/T3 Chat Quick GUI | `04-triple-chat-quick-gui.md`; T3 public DOM literals in `00-research-index.md` | Simple chatbot composer with model, Instant/Deep, Search, Attach, Temporary, prompt categories, scoped run/builder/review chat | `loopops.chat.scoped`, `loopops.chat.quick-controls.*`, `loopops.chat.attachments.*`, Workbench embedded Run Chat | `LoopOpsInteractionID.scopedChatQuickControls(...)`, `LoopOpsScopedChatPanel`, `LoopOpsAcceptanceHarness` covers run/review chat send | `web_dom_chat_send=true`; `web_dom_run_chat_isolated=true`; `loopops_action_run_chat_send=true`; `loopops_action_review_chat_send=true`; native activation covers Run Chat send | Checklist row `Run / Review Chat` |
| `trace.workbench_run_result` | Workbench / Run Result / Active Queue | `05-implementation-acceptance-spec.md`; `11-browser-clickthrough-review.md` | Default Workbench, active queue, selected Run Result, final answer, timeline, Review Packet, Run Chat | `loopops.workbench.active-queue`, `loopops.workbench.run-result`, `loopops.workbench.run-chat`; Review Guide and record handoff | `LoopOpsInteractionID.workbenchActiveQueue`, `workbenchRunResult`, `workbenchRunChat`; `LoopOpsNativeActivationHarness` covers queue selection and Run Chat | `web_action_batch_runs=2`; `web_dom_multi_run_queue=true`; `web_dom_same_loop_repeat_isolated=true`; `loopops_interaction_replay_step_7`; native activation target Workbench queue | Checklist rows `Workbench Review Guide`, `Multi-run isolation`, `Run / Review Chat` |
| `trace.studio_builder_skill_path` | Studio / Builder / Ordered Skill Path | `05-implementation-acceptance-spec.md`; LoopOps v2 plan docs | Loop Contract page, Skill OS shelf, ordered execution path, save/review/reset, Builder Chat setup handoff and structured patch receipt | `loopops.studio.execution-path`, `loopops.studio.review-diff`, `loopops.studio.builder-patch-receipt`, `loopops.studio.save-loop`; Web action smoke covers drag add/reorder, Builder patch receipt and Studio save-state; Web DOM smoke clicks Builder Chat and verifies receipt, steps, output and transcript; capture audit includes `06a-studio-builder-patch-receipt.png` | `LoopOpsSkillBinding`, `LoopOpsSkillStack`, `LoopOpsSkillPathDropResolver`, `LoopOpsInteractionID.studioExecutionPath`; acceptance covers stack drop/reorder/remove persistence and Builder patch receipt | `web_action_stack_drag_add=true`; `web_action_stack_drag_reorder=true`; `web_action_builder_patch_receipt=true`; `web_dom_builder_patch_receipt=true`; `web_audit_capture_count=15`; `loopops_action_skill_stack_drop_reorder=true`; `loopops_action_skill_stack_remove_persists=true`; `builder_patch_receipt=true` | Checklist rows `Studio execution path` and `Builder patch receipt` |
| `trace.no_permission_review` | No-Permission Review System | `09-no-permission-review-runbook.md`; `10-objective-completion-matrix.md`; `13-native-manual-review-checklist.md` | Local review preflight avoids macOS permission popups and separates automated evidence from manual visual review | `npm run review:no-permission`; offline artifact `dist/loopops-admin-offline.html`; Review Guide decision board and record handoff | `scripts/review-loopops-native.command`; `--loopops-native-activation-check`; native Workbench decision board and record handoff | `loopops_objective_audit_no_system_permissions=true`; `web_no_permission_review_auto_open=false`; `loopops_native_activation_external_ui_automation=false`; `workbench_review_decision_board=true` | Run `scripts/review-loopops-all.command`, set `Review decision`, then record result with `scripts/record-loopops-review.command` |
| `trace.agent_team_process` | Agent Team Process Evidence | `07-agent-team-final-audit.md`; `08-evidence-receipts.md`; this file | Research, implementation and hardening work recorded by module and by subsequent verification, with boundaries kept explicit | Web source and smoke anchors are mapped above; screenshot audit README records visual QA corrections | Swift source and harness anchors are mapped above; `LoopOpsAcceptanceHarness` and contract checks provide state evidence | `scripts/verify-loopops-traceability.command` and `scripts/audit-loopops-objective.command` verify this matrix and current evidence files | Human reviewer can read `07`, `08`, `10`, `13`, `14` as the process packet |

## Agent Team Handoff Map

| Handoff | Repo evidence | What the next reviewer can verify |
| --- | --- | --- |
| Research agents -> design docs | `00` through `04`, screenshot files in `screenshots/` | Each module cites concrete screenshot or DOM literals and does not invent unseen RelevanceAI or Triple pages |
| Design docs -> Web implementation | `05-implementation-acceptance-spec.md`, `web-prototype/src/App.jsx`, `web-prototype/src/loopopsModel.js`, `web-prototype/scripts/*` | Research concepts appear as clickable Web surfaces and shared model rules, not static mock text only |
| Design docs -> Swift/App implementation | `LoopOpsModels.swift`, `LoopOpsInteractionContracts.swift`, `LoopOpsViews.swift`, `BlocksWorkbenchView.swift`, `DashboardViewModel.swift`, `LoopOpsLocalStore.swift` | Loop Library, Skill OS, Knowledge, Studio, Workbench, Run Result and scoped chats all have user-facing anchors and state paths |
| Implementation -> no-permission verification | `scripts/audit-loopops-objective.command`, `scripts/verify-loopops-traceability.command`, `scripts/review-loopops-all.command` | Review can start from CLI evidence without triggering macOS browser/App/UI automation permission prompts; native Review Guide exposes Evidence Map, traceability, decision board and record handoff before the manual checklist |
| Automated verification -> human review | `13-native-manual-review-checklist.md`, `15-goal-completion-gate.md`, `review-records/` | Automated checks state what they prove; human review records visual/product judgment separately |

## Verification Contract

`scripts/verify-loopops-traceability.command` must pass before this traceability packet is considered current. It checks:

- This file exists and includes every `trace.*` module above.
- Required research documents and screenshots exist.
- Web and Swift sources include the expected interaction anchors, including product-visible Review Guide evidence map, traceability rows, decision board and record handoff.
- Evidence receipts include the expected action and DOM proof strings.
- No-permission scripts and review documents remain discoverable.

Expected output:

```text
loopops_traceability=pass
loopops_traceability_modules=8
loopops_traceability_no_system_permissions=true
```
