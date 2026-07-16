# Templates / Builder UI Handoff

Date: 2026-07-09

## Context

This document captures the current Templates / Builder UI and UX problems observed during manual review. It is intended as a handoff for the main implementation thread.

Evidence used:

- User screenshot: `/var/folders/mw/qj5k08_91bn4sq1qq28syxgc0000gn/T/TemporaryItems/NSIRD_screencaptureui_9erPxu/截屏2026-07-09 18.35.44.png`
- Follow-up screenshot: `/var/folders/mw/qj5k08_91bn4sq1qq28syxgc0000gn/T/TemporaryItems/NSIRD_screencaptureui_xOmWYB/截屏2026-07-09 19.22.46.png`
- Product truth: `/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/PRODUCT.md`
- Design truth: `/Users/chenge/Desktop/intelligence-agent-web3/intelligence-agent-web3/DESIGN.md`
- Builder implementation:
  - `src/components/templates/TemplatesBuilderView.jsx`
  - `src/components/canvas/LoopCanvas.jsx`
  - `src/components/chat/ScopedChatPanel.jsx`
  - `src/styles.css`
  - `src/i18n.js`

Static detector result:

- `impeccable detect` on the relevant Builder components returned `[]`.
- This means the main issues are product hierarchy, layout behavior, interaction feedback, and localization consistency, not simple static anti-pattern matches.

## Product Baseline

The current product goal is narrow:

- Manage Skills.
- Manage Workflows / Loops.
- Use Skills to create, compose, run, and reuse Workflows / Loops through templates, drag-and-drop canvas, and natural-language patch receipts.

The Builder must make the workflow canvas the primary surface. Chat is only a scoped control layer for generating a structured patch receipt. It must not visually or conceptually replace the canvas.

## Priority Issues

### P0: The Canvas Is Not The Primary Surface

Observed issue:

- In the screenshot, the user sees a `Workflow Canvas` label and node count, but the actual graph canvas and nodes are not visible.
- The center of the page is dominated by `Builder assistant`.
- Dragging a skill appears to do nothing because the user cannot see where the node was added, or the drop may happen outside the actual canvas drop zone.

Why it matters:

- The core job is to drag Skills into a workflow canvas and build a Loop / Workflow.
- If users cannot immediately see the canvas, the product fails its primary interaction.

Likely root causes:

- `workflowBoard` lays out canvas, assistant, and debug dock as peer grid rows:
  - `src/styles.css`, `.workflowBoard`, around line 753.
- `assistantDock.open` expands inside the same vertical layout and can consume the space the canvas needs.
- Drop handling is only attached to the canvas viewport. If the user drags into the large assistant area, the action will not produce visible canvas feedback.

Required fixes:

- Default first screen must show the canvas stage and existing nodes.
- Assistant must be collapsed by default and must not consume primary canvas height.
- Canvas viewport needs a stable desktop minimum height, for example `min-height: 520px`.
- Drop zone must visibly highlight during drag-over.
- After drag or `Add`, the new node must be selected, highlighted, and visible in the canvas.
- If the drop is outside the canvas, show a clear inline hint: `请拖到工作流画布区域`.

Acceptance criteria:

- At 1440px desktop, the workflow graph is the largest visible area.
- User can see existing nodes without scrolling past assistant.
- Dragging a skill produces a visible selected node within 500ms.

### P1: Chinese Mode Is Not Fully Localized

Observed issue:

Chinese mode still shows mixed core terms:

- `Skill Library`
- `Workflow`
- `Node Inspector`
- `Builder assistant`
- `patch`
- `builder scoped`
- `Patch-aware`
- `Sources optional`
- `Run ledger`

Why it matters:

- Mixed language makes the information hierarchy feel incoherent.
- Users cannot tell whether these are separate product concepts or untranslated labels.

Relevant file:

- `src/i18n.js`, zh dictionary, around lines 150-250.

Recommended terminology:

- `Skill` -> `技能`
- `Workflow` -> `工作流`
- `Templates` -> `模板`
- `Skill Library` -> `技能库`
- `Workflow Canvas` -> `工作流画布`
- `Node Inspector` -> `节点编辑` or `节点检查器`
- `Builder assistant` -> `编排助手`
- `Patch` -> `变更回执`
- `Run ledger` -> `运行记录`
- `Add to workflow` -> `添加到工作流`
- `Clone template` -> `克隆模板`

Terms that should be removed from primary UI:

- `scoped`
- `patch-aware`
- `sources optional`
- internal runtime/provider/schema-style words

Acceptance criteria:

- In Chinese mode, the primary Templates / Builder flow should not contain mixed English except for brand names, real Skill IDs, tickers, or explicit technical object IDs.

### P1: Builder Assistant Competes With Builder Canvas

Observed issue:

- `Builder assistant` is visually larger than the workflow canvas.
- The chat panel asks the user to describe workflow changes, but the main product action is supposed to be visible graph editing.
- Labels such as `builder scoped`, `Patch-aware`, and `Sources optional` are unclear and feel internal.

Why it matters:

- The page becomes ambiguous: is this a workflow editor or a chat interface?
- The assistant should support editing, not become the product center.

Relevant files:

- `src/components/templates/TemplatesBuilderView.jsx`, assistant dock around lines 367-387.
- `src/components/chat/ScopedChatPanel.jsx`.

Required fixes:

- Rename `Builder assistant` to `编排助手` in Chinese.
- Default assistant state should be collapsed.
- Expanded assistant should be a compact bottom panel, not a full-width content area that pushes out the canvas.
- Replace internal chips with user-facing copy:
  - Remove `builder scoped`.
  - Remove `Patch-aware`.
  - Remove `Sources optional`.
- When a message is sent, show a structured `变更回执` banner above the canvas:
  - summary of changes
  - added / modified nodes
  - `应用变更`
  - `取消`

Acceptance criteria:

- Opening the assistant never hides the workflow graph.
- The user can understand assistant output as a proposed workflow change, not as a chat transcript.

### P1: Toasts Are Duplicated And Still Obstruct Context

Observed issue:

- Two duplicate toast messages appear in the top-right.
- Toast copy remains in English in Chinese mode: `Open templates`, `Close`.
- Toasts overlap the right-side context area.

Why it matters:

- Duplicated feedback looks broken.
- Toasts compete with the Inspector and canvas controls.
- English actions in Chinese mode break trust in the localization.

Relevant file:

- `src/components/shared/ToastStack.jsx`
- `src/styles.css`, `.toastStack`, around line 1450.

Required fixes:

- Deduplicate identical toast events.
- Keep at most two toasts, but do not show duplicate action messages.
- Chinese mode actions must be localized:
  - `Open workflow` -> `打开工作流`
  - `Review patch` -> `查看变更`
  - `Close` -> `关闭`
- Toast should not cover Inspector controls, canvas controls, assistant composer, or debug dock.

Acceptance criteria:

- Repeating the same add/clone action does not stack identical toasts.
- Toast action and close labels follow the active language.

### P2: Inspector Drawer Looks Like A Cut-Off Floating Panel

Observed issue:

- In the screenshot, the right side shows a partial `编辑契约` panel that looks clipped.
- It is not clear whether the Inspector is open, collapsed, hidden, or obstructed.
- It occupies the same visual region as toast messages.

Why it matters:

- Users need a reliable place to edit the selected node.
- The current collapsed state looks like broken layout rather than a purposeful drawer.

Relevant CSS:

- `src/styles.css`, `.contextDrawer`, around line 1237.
- `src/styles.css`, `.contextDrawer.collapsed`, around line 1251.

Required fixes:

- Collapsed Inspector should be a narrow rail or a single clear button, not a semi-panel.
- Expanded Inspector should either participate in layout or appear as an intentional drawer.
- It must not cover key canvas nodes or toast actions.
- `编辑契约` should be reachable from the selected node summary bar and from the drawer rail.

Acceptance criteria:

- The user can tell the Inspector state at a glance: closed, collapsed, or open.
- The Inspector does not look clipped at 1280px or 1440px desktop.

### P2: Skill Library Add / Drag Feedback Is Too Weak

Observed issue:

- Skill rows can be dragged and have a plus button, but the result is not obvious.
- Some plus buttons feel squeezed at the far right.
- The left rail shows a horizontal scrollbar, which signals layout pressure.

Why it matters:

- Skill-to-workflow composition is one of the product's three core jobs.
- If add/drag feedback is weak, users assume the operation failed.

Relevant files:

- `src/components/templates/TemplatesBuilderView.jsx`, Skill Library around lines 143-225.
- `src/styles.css`, `.libraryRow` and `.libraryAddButton`, around lines 857-906.

Required fixes:

- Increase Skill Library rail width or ensure rows never create horizontal overflow.
- Make drag affordance explicit on hover/focus.
- Add an inline hint above the canvas during drag: `释放后添加为工作流节点`.
- Click `+` and drag/drop should have identical feedback:
  - add node
  - select node
  - show selected node summary
  - optional toast or inline status
  - ensure node is visible

Acceptance criteria:

- There is no horizontal scrollbar in the Skill Library rail at 1440px desktop.
- After clicking `+`, users can immediately see which node was added.

## Additional Half-Finished Design Inventory

This section tracks controls and interaction surfaces that currently look implemented, but do not yet behave like finished product features. These should be fixed, completed, or removed from the main path. Do not move this content into a help document; the issue is product interaction completeness, not user education.

### P1: Canvas MiniMap Looks Interactive But Is Static

Observed issue:

- The small white box at the lower-right of the canvas looks like a minimap.
- It shows small node blocks and highlights the current node.
- It does not support clicking to jump to a node.
- It does not support dragging the viewport.
- It does not show the current viewport rectangle.
- It does not show edges, so it does not communicate graph structure.
- It is marked `aria-hidden="true"`, so it is not an accessible control.

Relevant implementation:

- `src/components/canvas/LoopCanvas.jsx`, minimap rendering around lines 338-349.
- `src/styles.css`, `.canvasMiniMap`, around lines 1205-1226.

Why it matters:

- Users naturally interpret a minimap as a navigation control.
- A static minimap feels like a half-built feature and reinforces the concern that drag/drop did not work.

Recommended fix:

- MVP option: remove or hide the minimap until it is a real control. Keep zoom and fit-view controls.
- Complete option: make it a true minimap:
  - render nodes and edges
  - render current viewport rectangle
  - click node or region to scroll canvas there
  - drag viewport rectangle to pan
  - keep selected node highlighted
  - add label / tooltip: `画布缩略图，点击跳转`
  - keyboard-accessible node jump list or equivalent

Acceptance criteria:

- If the minimap remains visible, clicking it changes the canvas viewport.
- The minimap either shows graph edges or is visually simplified enough that it does not imply graph completeness.
- It no longer feels like decoration pretending to be a control.

### P2: Inspector Rail Still Reads As A Detached Half Panel

Observed issue:

- The collapsed Inspector now appears as a narrow vertical `Show` rail on the right.
- It is technically cleaner than the earlier clipped panel, but still reads as a floating white widget with unclear ownership.
- `Show` alone does not say what will open.
- It competes with the canvas command area and minimap.

Relevant implementation:

- `src/components/templates/TemplatesBuilderView.jsx`, collapsed Inspector button around lines 620-629.
- `src/styles.css`, `.contextDrawer.collapsed` and `.drawerRailButton`, around lines 1298-1389.

Why it matters:

- Node editing is core to Builder.
- The rail should clearly mean `open selected node editor`, not a generic hidden panel.

Recommended fix:

- Rename rail action to `编辑节点` / `Node editor`, not `Show`.
- If no node is selected, make the rail visually secondary and say `选择节点后编辑`.
- If a node is selected, show the selected node title in a compact tooltip or summary.
- Keep the rail outside the minimap and canvas zoom control area.

Acceptance criteria:

- At 1280 and 1440 desktop, the collapsed rail clearly communicates that it opens the node editor.
- It does not look like a clipped leftover card.

### P2: Connection Ports Are Functional But Not Discoverable

Observed issue:

- Nodes expose small circular input/output ports.
- The user must infer that clicking an output port starts a connection and clicking an input port completes it.
- There is no visible temporary line from the source port to the cursor.
- There is no persistent instruction near the cursor or canvas while connecting.
- There is no obvious cancel affordance such as `Esc` hint.

Relevant implementation:

- `src/components/canvas/LoopCanvas.jsx`, connection functions around lines 191-210.
- `src/components/canvas/LoopCanvas.jsx`, port buttons around lines 291-303.

Why it matters:

- Connecting nodes is a core workflow builder behavior.
- Hidden graph grammar makes the canvas feel partially implemented even when the logic works.

Recommended fix:

- On output port hover, show tooltip: `从这里连到下一个节点`.
- After starting a connection, show:
  - active source port
  - temporary line following cursor
  - canvas banner: `选择目标节点的输入端口，按 Esc 取消`
  - clear cancel behavior
- Invalid self-connection should not silently feel broken; show inline feedback near the node, not only toast.

Acceptance criteria:

- A first-time user can create a connection without guessing the port sequence.
- Connection mode is visually obvious until completed or canceled.

### P2: Run Preview Tab And Debug Dock Duplicate Each Other

Observed issue:

- The Builder has a `Run preview` tab.
- The bottom dock also shows `Run / debug`, `Show steps`, and `Start mock run`.
- Both surfaces expose execution preview concepts, but their relationship is unclear.

Relevant implementation:

- `src/components/templates/TemplatesBuilderView.jsx`, `trace` tab around lines 423-437.
- `src/components/templates/TemplatesBuilderView.jsx`, debug dock around lines 463-503.

Why it matters:

- Users must understand where to preview, where to run, and where to inspect run results.
- Duplicate partial surfaces create the impression that one of them is unfinished.

Recommended fix:

- Pick one primary execution surface:
  - Prefer bottom `Run / debug` dock for compile preview, node errors, and mock run.
  - Remove `Run preview` tab, or rename it to `Trace` only after a run exists.
- If both remain, define clear roles:
  - tab = read-only execution plan
  - dock = controls and live run state

Acceptance criteria:

- There is only one obvious place to start a run.
- Preview and run-result states are not split across two ambiguous regions.

### P2: Save Workspace And Save Workflow Look Like Different Actions But Share Scope

Observed issue:

- Top bar shows both `Save workspace` and `Save workflow`.
- In current implementation, the Templates primary action also calls `workspace.saveWorkspace`.
- The UI implies two scopes, but behavior appears shared.

Relevant implementation:

- `src/components/shell/TopBar.jsx`, `primaryForPage` around lines 19-22.
- `src/components/shell/TopBar.jsx`, secondary save around lines 73-77.

Why it matters:

- Workflow editing must have an explicit save model.
- If two save buttons do the same thing, users cannot build trust in dirty state or persistence.

Recommended fix:

- Use one primary scoped save in Builder: `保存工作流`.
- Move workspace snapshot save out of the main Builder top bar, or make it clearly secondary in settings/dev-only surfaces.
- If both are truly needed, expose exact scope:
  - `保存当前工作流`
  - `保存整个工作台快照`
  - show separate dirty states

Acceptance criteria:

- Users can tell exactly what data will be saved by each visible save action.
- No two visible buttons with different labels trigger indistinguishable behavior.

### P2: Template Page State Mixes Template Selection And Owned Workflow Editing

Observed issue:

- The page title is `Templates`.
- The left rail is a template list.
- The central object can be an owned workflow, for example `LoopWorkflow · Owned Workflows`.
- After clone, it is not obvious whether the user is still browsing templates or now editing a cloned workflow.

Why it matters:

- Template clone is a transition from preset template to owned workflow.
- If the mode boundary is unclear, users may think they are editing the template itself.

Recommended fix:

- After clone, show a clear mode banner:
  - `正在编辑从 Meeting Actions Template 克隆出的工作流`
  - include `返回模板` and `在 Workflows 中打开`
- Or route cloned workflows into a dedicated Builder/edit mode with a breadcrumb:
  - `Templates / Meeting Actions Template / Meeting Actions copy`

Acceptance criteria:

- Users can tell whether they are viewing a preset template or editing an owned workflow.
- Template rows remain clone-only; owned workflow editing is visually distinct.

### P2: Palette Row Click, Plus Button, And Drag Have Different Meanings

Observed issue:

- Skill rows:
  - row click selects skill detail
  - plus button adds to workflow
  - drag adds to canvas
- Non-skill rows:
  - row click stages a Builder patch
  - plus button adds directly
  - drag adds to canvas

Relevant implementation:

- `src/components/templates/TemplatesBuilderView.jsx`, skill rows around lines 236-258.
- `src/components/templates/TemplatesBuilderView.jsx`, non-skill rows around lines 264-285.

Why it matters:

- Same-looking rows should not have different primary meanings.
- Builder patch should come from the assistant, not from an ordinary palette row click.

Recommended fix:

- Standardize all palette rows:
  - row click = show resource detail / preview
  - plus button = add to workflow
  - drag = add to canvas at drop location
- Move patch generation only into the assistant.

Acceptance criteria:

- A palette row has one consistent interaction model across Skills, Inputs, Gates, and Outputs.

### P2: Sample Patch Button Is Prototype Scaffolding

Observed issue:

- Assistant includes a `Stage sample patch` / `生成示例变更` button.
- This is useful for testing, but it does not belong as a primary product action.

Relevant implementation:

- `src/components/templates/TemplatesBuilderView.jsx`, assistant sample patch around lines 451-458.

Why it matters:

- Users do not want demo scaffolding in the production-like workflow builder.
- It makes the assistant feel like a prototype instead of a controlled natural-language editing layer.

Recommended fix:

- Remove the sample patch button from normal UI.
- If needed for smoke tests, place it behind a test-only control, fixture action, or dev mode flag.
- Keep real quick actions as domain-specific prompts only if they are part of the product model.

Acceptance criteria:

- The assistant contains only real user actions.
- No visible button exists only to generate fixture/demo data.

### P3: Disabled / Blocked States Still Rely Too Much On `title`

Observed issue:

- Run buttons use `title` for blocked reasons.
- Hover-only explanations are weak and inaccessible on touch devices.

Relevant implementation:

- `src/components/templates/TemplatesBuilderView.jsx`, run actions around lines 316-318 and 482-487.

Why it matters:

- Running a workflow is a core action.
- If it is blocked, users need visible reasons and recovery actions.

Recommended fix:

- Replace title-only blocked states with inline reason text or a compact blocked popover.
- Provide one recovery action, for example `克隆模板`, `补齐输入`, or `打开节点编辑`.

Acceptance criteria:

- A disabled run action always has a visible explanation and one next step.

## Recommended Fix Order

1. Restore canvas priority:
   - Make assistant collapsed by default.
   - Give canvas a stable minimum visible height.
   - Move assistant into a non-dominant bottom overlay/dock.

2. Fix drag/drop and add feedback:
   - Highlight canvas drop zone.
   - Select and reveal newly added nodes.
   - Add invalid-drop feedback.

3. Normalize Chinese localization:
   - Replace mixed English core terms.
   - Remove internal tags from primary UI.

4. Clean right-side Inspector:
   - Replace clipped collapsed panel with rail/button.
   - Ensure open state is visually intentional.

5. Decide minimap scope:
   - Remove it for MVP, or complete it as a real navigation minimap.
   - Do not keep a static half-control.

6. Clarify graph operations:
   - Add visible connection-mode feedback.
   - Make palette row, plus button, and drag behavior consistent.

7. Consolidate execution controls:
   - Remove or clarify duplicate `Run preview` tab and debug dock.
   - Keep one obvious primary run surface.

8. Clarify save scope:
   - Avoid two visible save buttons with indistinguishable behavior.
   - Make dirty state map to the visible save action.

9. Deduplicate and localize toasts:
   - One event, one toast.
   - One recovery action plus close.
   - No overlap with core controls.

## Suggested Tests

Manual:

- Desktop 1440, Chinese, light mode:
  - Templates page opens with visible canvas and nodes.
  - Drag `Catalyst calendar` into the canvas.
  - Confirm new node appears and is selected.
  - Click `+` on another skill.
  - Confirm node appears in canvas and selected node summary updates.
  - Open and close Inspector.
  - Expand assistant and confirm canvas remains visible.
  - Trigger a toast and confirm no duplicate or English action labels.
  - Click the minimap if visible; it must navigate the canvas. If it does not, minimap should be removed.
  - Start a node connection and confirm connection mode is visually obvious and cancellable.
  - Check that `Save workspace` and `Save workflow` do not appear as two ambiguous actions.

- Desktop 1280, Chinese, light mode:
  - Confirm no horizontal page overflow.
  - Confirm Skill Library does not show horizontal scrollbar.
  - Confirm collapsed Inspector does not look clipped.
  - Confirm Inspector collapsed rail says what it opens.

- Dark mode:
  - Repeat drag/add/assistant/Inspector checks.

Automated:

- Add or update DOM smoke for:
  - `Skill Library` search and filter.
  - Drag skill to canvas.
  - Click skill `+`.
  - New node appears with selected state.
  - Assistant toggle does not hide canvas test id.
  - Toast deduplication.
  - Chinese dictionary does not expose forbidden English labels in Templates / Builder.
  - Minimap is either absent or exposes a real navigation action.
  - Palette row click does not stage a Builder patch outside the assistant.
  - Save workflow and save workspace scopes are not duplicated.

Recommended commands after implementation:

```bash
npm run build
npm run smoke
npm run action:smoke
npm run dom:smoke
npm run focus:smoke
npm run review:no-permission
```

## Final Acceptance

The page should answer these questions without explanation:

- Where is the workflow canvas?
- Which workflow am I editing?
- Which node is selected?
- Where do I drag this skill?
- Did the drag or add action succeed?
- How do I edit this node?
- What is the assistant proposing, and how do I apply or reject it?

If any of these require guessing, the Builder still has a hierarchy or interaction feedback problem.
