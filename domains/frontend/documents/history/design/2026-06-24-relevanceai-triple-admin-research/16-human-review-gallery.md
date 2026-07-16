# Human Review Gallery

本文把当前 15 步 Product Design 截图证据整理成一张人工 review 路线图。它用于肉眼检查产品体验，不替代 `scripts/audit-loopops-objective.command`、DOM smoke、Swift harness 或最终人工结论记录。

## Entry

```text
Web review URL: http://127.0.0.1:5188/
HTML gallery: human-review-gallery.html
Desktop screenshots: product-design-audit-web/
Mobile screenshots: product-design-audit-web-mobile/
Native visual gallery: native-visual-audit/loopops-native-visual-2026-06-27-155147/README.md
Latest pending record: review-records/loopops-review-2026-06-27-155300.md
Latest desktop capture: 2026-06-26T16:03:52Z, 15 screenshots, no horizontal overflow
Latest mobile capture: 2026-06-26T16:04:16Z, 15 screenshots, no horizontal overflow
Latest native visual capture: 2026-06-27-155147, 6 screenshots, 6 nonblank surfaces
Latest no-permission server handoff: review-sessions/loopops-server-handoff-2026-06-27-152603.md
```

Use [human-review-gallery.html](human-review-gallery.html) when you want the desktop and mobile screenshots paired in one local page.

## Review Rule

- 先看 desktop，再看 mobile，再扫 native visual gallery。
- 先按截图判断信息架构和视觉质量，再回到 live URL 点击关键动作。
- 如果发现问题，不要直接改 `pass`。把 blocker 写入 `LOOPOPS_REVIEW_BLOCKERS`，用 `scripts/record-loopops-review.command` 生成新 record。

## Screenshot Map

| Step | Surface | Desktop | Mobile | What To Check |
| --- | --- | --- | --- | --- |
| 01 | Workbench default | [desktop](product-design-audit-web/01-workbench-initial.png) | [mobile](product-design-audit-web-mobile/01-workbench-initial.png) | Default entry is a working queue/result surface, not a marketing page or log console. Review Guide, Active Queue, Run Result and Run Chat are discoverable. |
| 02 | Loop Library database | [desktop](product-design-audit-web/02-loop-library-database.png) | [mobile](product-design-audit-web-mobile/02-loop-library-database.png) | Rows feel like a Notion/RelevanceAI database. Run, Open, readiness, detail, ledger, packet and share-safe log are distinct actions. |
| 03 | Workbench Run Result | [desktop](product-design-audit-web/03-workbench-run-result.png) | [mobile](product-design-audit-web-mobile/03-workbench-run-result.png) | Starting a loop creates an active run. Final Answer, Review Packet, Tool logs, Knowledge and Run Chat remain scoped to selected run. |
| 04 | Skill OS stack | [desktop](product-design-audit-web/04-skill-os-stack.png) | [mobile](product-design-audit-web-mobile/04-skill-os-stack.png) | Skill OS presents user-facing skills, tools and stacks. It should not expose provider, runtime, worker, artifact, schema or secret wording. |
| 05 | Skill OS add to stack | [desktop](product-design-audit-web/05-skill-os-stack-after-add.png) | [mobile](product-design-audit-web-mobile/05-skill-os-stack-after-add.png) | Adding a skill updates the ordered execution path and keeps the detail pane readable. Toast feedback should not cover the main task. |
| 05a | Create Tool import modal | [desktop](product-design-audit-web/05a-skill-os-create-tool-import.png) | [mobile](product-design-audit-web-mobile/05a-skill-os-create-tool-import.png) | `Default`、`Invent`、`Import` starting points are visible. Tool name, task description, input scope and Start action are clear. |
| 05b | Tool Logs validation | [desktop](product-design-audit-web/05b-skill-os-tool-logs-validation.png) | [mobile](product-design-audit-web-mobile/05b-skill-os-tool-logs-validation.png) | Use validation produces readable failed/draft logs with status, source, duration, cost, output and Review Chat handoff. |
| 06 | Studio contract page | [desktop](product-design-audit-web/06-studio-contract-page.png) | [mobile](product-design-audit-web-mobile/06-studio-contract-page.png) | Contract structure stays visible while editing. Execution path, structured contract fields, save-state and reset/review controls are coherent. |
| 06a | Builder patch receipt | [desktop](product-design-audit-web/06a-studio-builder-patch-receipt.png) | [mobile](product-design-audit-web-mobile/06a-studio-builder-patch-receipt.png) | Builder Chat updates steps, ordered skill path, review rule, exit condition and output shape. Receipt explains what matched. |
| 06b | Studio review changes | [desktop](product-design-audit-web/06b-studio-review-changes.png) | [mobile](product-design-audit-web-mobile/06b-studio-review-changes.png) | Review changes identifies changed blocks without hiding the contract. It is acceptable as a lightweight block diff for this iteration. |
| 07 | Knowledge new menu | [desktop](product-design-audit-web/07-knowledge-new-menu.png) | [mobile](product-design-audit-web-mobile/07-knowledge-new-menu.png) | Blank, Upload file, Import from website and Integrations map to the RelevanceAI Knowledge menu pattern. |
| 08 | Knowledge setup panel | [desktop](product-design-audit-web/08-knowledge-setup-panel.png) | [mobile](product-design-audit-web-mobile/08-knowledge-setup-panel.png) | Blank creation opens an editable setup panel with title, note content and save action visible. |
| 08b | Knowledge source detail | [desktop](product-design-audit-web/08b-knowledge-source-detail.png) | [mobile](product-design-audit-web-mobile/08b-knowledge-source-detail.png) | Saved source appears as reusable context with detail metadata visible, not only a toast. |
| 09 | Chat quick GUI | [desktop](product-design-audit-web/09-chat-quick-gui.png) | [mobile](product-design-audit-web-mobile/09-chat-quick-gui.png) | Chat is compact and scoped. Model, Instant/Deep, Search, Attach, Temporary and prompt category controls stay close to the composer. |
| 10 | Workbench empty state | [desktop](product-design-audit-web/10-workbench-empty-state.png) | [mobile](product-design-audit-web-mobile/10-workbench-empty-state.png) | Empty queue is useful and recoverable. It should offer a clear run action and seeded review restore without feeling like onboarding copy. |

## Native Visual Map

These screenshots come from native SwiftUI `DashboardView` rendered through offscreen `NSHostingView`. They avoid `open`, AppleScript, Accessibility, screen recording, Chrome/Safari and external AppKit click automation. They are visual surface evidence, not pixel-click proof.

| Surface | Image | What To Check |
| --- | --- | --- |
| Workbench Run Result | [native](native-visual-audit/loopops-native-visual-2026-06-27-155147/01-workbench.png) | Workbench opens as a working queue/result/review-guide surface; Result State, attempts, scoped Run Chat, Knowledge and Tool Log counts are visible. |
| Loop Library database | [native](native-visual-audit/loopops-native-visual-2026-06-27-155147/02-loop-library.png) | Loop rows, readiness and linked ledger/packet/share-safe actions read like a database, not large marketing cards. |
| Skill OS and Tool Logs | [native](native-visual-audit/loopops-native-visual-2026-06-27-155147/03-skill-os.png) | Skill OS presents user-facing tools, stacks and logs without exposing hidden runtime/provider terms. |
| Knowledge library | [native](native-visual-audit/loopops-native-visual-2026-06-27-155147/04-knowledge.png) | Knowledge sources, setup state and attach path are visible and productized. |
| Global Chat workspace | [native](native-visual-audit/loopops-native-visual-2026-06-27-155147/05-chat.png) | Chat is a first-class workspace route with scoped quick controls, context rail and assistant composer visible. |
| Studio builder | [native](native-visual-audit/loopops-native-visual-2026-06-27-155147/06-studio.png) | Contract page, execution path and Builder Chat remain visible together. |

## Live Click Checks

After reviewing the screenshots, use `http://127.0.0.1:5188/` for these live checks:

Current handoff: `review-sessions/loopops-server-handoff-2026-06-27-152603.md` verifies `http://127.0.0.1:5188/` returned `HTTP/1.1 200 OK`, the temporary `5189` fallback was stopped, and no browser/native app was auto-opened.

1. Run one ready Loop from Loop Library, then run 2-3 loops and switch active queue rows.
2. Open an unready Loop and verify it routes to Studio setup instead of launching a run.
3. In Skill OS, open Create Tool, switch `Default / Invent / Import`, fill fields, start, then open Use and Logs.
4. Drag or add a skill into Studio execution path, reorder, remove one item, save, then reopen.
5. In Builder Chat, send a structured instruction with steps, skill path, review rule, exit condition and output shape.
6. In Knowledge, create a source, attach it to latest run, switch runs and confirm the attachment does not leak.
7. In Chat, send Run Chat and Review Chat messages and confirm transcripts stay scoped.

## Record Result

To print the current closeout commands without creating a new record:

```bash
scripts/print-loopops-review-closeout.command
```

Recommended manual note shape before running the recorder:

```text
reviewer=<name>
date=YYYY-MM-DD
web_url=http://127.0.0.1:5188/
native_app=.build/debug-app/WeChatIntelligenceRadar.app
reviewed_paths=workbench,loop-library,skill-os,studio,knowledge,tool-logs,run-result,run-chat,review-chat

workbench=pass|needs-work, <short observation>
loop_library=pass|needs-work, <short observation>
skill_os_tool_logs=pass|needs-work, <short observation>
studio_builder=pass|needs-work, <short observation>
knowledge_toast_attach=pass|needs-work, <short observation>
scoped_chat=pass|needs-work, <short observation>
native_visual=pass|needs-work, <short observation>

blockers=none | <specific blocker list>
decision=pass | needs-work
notes=<what was reviewed, what still concerns you, and whether this can close the current goal>
```

Use this after the manual pass:

```bash
LOOPOPS_WEB_URL="http://127.0.0.1:5188/" LOOPOPS_REVIEW_STATUS=pass LOOPOPS_REVIEW_BLOCKERS="" LOOPOPS_REVIEW_NOTES="Reviewed Web and native surfaces; no blockers." scripts/record-loopops-review.command
```

If anything fails, use:

```bash
LOOPOPS_WEB_URL="http://127.0.0.1:5188/" LOOPOPS_REVIEW_STATUS=needs-work LOOPOPS_REVIEW_BLOCKERS="Specific blocker observed during manual review." LOOPOPS_REVIEW_NOTES="Describe the review path and affected surface." scripts/record-loopops-review.command
```

The recorder rejects `pass` without explicit notes, rejects `pass` with blockers, and rejects non-pass statuses without concrete blockers. The current pending record remains `review-records/loopops-review-2026-06-27-155300.md` until a new result record is generated.
