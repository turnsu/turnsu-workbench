# Browser Clickthrough Review

本文记录 2026-06-25 使用 Codex 内置 Browser 对 `http://127.0.0.1:5184/` 执行的真实 DOM 点击巡检。该巡检只使用 Codex 内置 Browser，不调用 Chrome、Safari、AppleScript、Accessibility、屏幕录制或系统浏览器控制。

## Scope

- Target: `http://127.0.0.1:5184/`
- Browser surface: Codex in-app Browser
- Evidence type: real DOM clicks plus post-click DOM state reads
- Purpose: 补强“每个交互都可以点击一下”的人工 review 证据层

## Clickthrough Summary

| Step | Clicked control | Post-click evidence | Result |
| --- | --- | --- | --- |
| `open_workbench` | `loopops.nav.workbench` | `h1=Workbench`, Run Result visible, active queue visible | Pass |
| `open_loop_library` | `loopops.nav.library` | `h1=Loop Library`, database rows visible, ready/unready actions visible | Pass |
| `library_ready_loop_run_clicked` | `loopops.library.run.crypto-market-report-loop` | Navigated to `Workbench`, active queue increased to 2, Run Result visible | Pass |
| `library_batch_run_two_loops_clicked` | `Select Trade Plan Review`, then `Run selected` | Navigated to `Workbench`, active queue showed 3 items: 2 new runs plus seeded review | Pass |
| `library_unready_loop_setup_clicked` | `loopops.library.run.crypto-thesis-review` | Stayed on `Loop Library`; setup/builder text present; no run queue added on that surface | Pass |
| `library_linked_ledger_clicked` | first `loopops.library.run-ledger.*` row | Navigated to `Workbench`, Run Result visible | Pass |
| `library_linked_packet_clicked` | first `loopops.library.packet-row.*` row | Navigated to `Workbench`, Run Result visible | Pass |
| `library_linked_share_clicked` | first `loopops.library.share-log.*` row | Navigated to `Workbench`, Run Result visible | Pass |
| `open_skill_os` | `loopops.nav.skillos` | `h1=Skill OS`, 5 Skill OS packages visible, execution path visible | Pass |
| `skill_os_create_tool_import_selected` | `loopops.skill-os.create-tool`, then `loopops.skill-os.tool-draft.import` | Import starter selected; modal fields populated with `Imported Review Tool` and `Builder packet` | Pass |
| `skill_os_create_tool_start_clicked` | `loopops.skill-os.tool-draft.start` via visible DOM node | Start button was inside the Browser viewport, modal closed, `Imported Review Tool` appeared in Skill OS list and Tool Detail | Pass |
| `open_knowledge` | `loopops.nav.knowledge` | `h1=Knowledge`, starter cards and attach rows visible | Pass |
| `knowledge_website_starter_clicked` | `loopops.knowledge.starter.website` | New `Website import draft` row appears; attach count increases from 4 to 5 | Pass |
| `knowledge_search_filter_applied` | `loopops.knowledge.search`, `loopops.knowledge.status-filter` | Search `Triple` plus status `Ready` narrows visible attach rows to 1 | Pass |
| `knowledge_attach_clicked` | `loopops.knowledge.attach.knowledge-triple` | Navigates to `Chat`; scoped chat surface visible | Pass |
| `open_chat` | `loopops.nav.chat` | `h1=Chat`, Triple-style quick GUI text and scoped workflow cards visible | Pass |
| `chat_quick_gui_toggled` | `Enable search`, `Enable temporary chat` buttons | Chat surface remains visible after toggles; quick GUI controls remain close to composer | Pass |
| `open_studio` | `loopops.nav.studio` | `h1=Studio`, 3 structured steps visible, save-state visible | Pass |
| `studio_builder_patch_receipt` | Builder Chat composer, then `Send Builder chat message` | `Structured patch applied` receipt visible; ordered Skill Path, steps count, updated steps/output and Builder Chat assistant receipt visible | Pass |
| `studio_add_step_clicked` | `loopops.studio.step.add` | Studio step count increases from 3 to 4; save-state becomes `Unsaved changes` | Pass |
| `studio_review_changes_clicked` | `loopops.studio.review-diff` | Diff panel opens; `Changed blocks` and `Steps` visible | Pass |

## Create Tool Start Evidence

The Codex in-app Browser now covers the Skill OS `Create Tool` flow end to end. After selecting `Import`, the modal footer `Start` button reported `bottom=701.70` inside a `752` px Browser viewport, then clicking `Start` closed the modal and inserted `Imported Review Tool` into both the Skill OS package list and Tool Detail surface.

The same flow remains covered by the no-permission WebKit DOM smoke:

```bash
cd domains/frontend/web/code/web-prototype
npm run review:no-permission
```

Relevant passing lines:

```text
web_dom_create_tool_flow=true
web_dom_tool_log_source_visible=true
web_dom_tool_use_validation=true
web_dom_tool_log_review_chat=true
web_dom_builder_patch_receipt=true
web_dom_multi_run_queue=true
web_dom_run_chat_isolated=true
web_dom_same_loop_repeat_isolated=true
web_dom_no_browser_permissions=true
```

## Review Impact

This clickthrough materially strengthens the Web prototype evidence:

- It verifies real navigation clicks across all six surfaces.
- It verifies ready Loop run creates visible Workbench result state.
- It verifies batch run creates a multi-run active queue in the Browser.
- It verifies unready Loop setup does not accidentally enqueue a run.
- It verifies Run Ledger / Review Packet / Share-safe Log rows are linked into Run Result.
- It verifies Skill OS Create Tool Import to Start behavior.
- It verifies no-permission WebKit DOM smoke covers multi-run, same-loop repeat and Run Chat isolation.
- It verifies Knowledge starter, search, status filter and attach behavior.
- It verifies Chat quick GUI controls remain visible after interaction.
- It verifies Studio Builder Chat can apply a structured patch and expose the same receipt in the contract page and transcript.
- It verifies Studio structured contract editing and review-diff behavior.

It still does not prove native AppKit/XCUITest pixel clicking. That remains a separate native hardening gap tracked in `10-objective-completion-matrix.md`.
