# App Interaction Development Brief

## Platform Read

Treat the App as a native workspace product, not a web layout copied into SwiftUI. The current assumption is a macOS app surface with split views, sidebars, inspectors, keyboard commands, and native menus.

## Native Shell

Use a three-region structure:

- Sidebar: workspace navigation.
- Content: selected list, page, or editor.
- Inspector: selected object details, chat, logs, or settings.

Interaction details:

- Sidebar selection is stable and keyboard navigable.
- Toolbar contains search, time/window controls if still needed, and global run/status indicators.
- Detail pages should use native list rows, forms, split panes, sheets, and popovers instead of web-style nested cards.
- Use sheets for creation and configuration when the task is short.
- Use full pages for Loop Contract editing, Skill Stack editing, and Run Result review.

## Loop Library App Surface

Primary surfaces:

- Loop list.
- Template list.
- Run ledger.
- Share-safe log list.
- Loop detail page.

Interactions:

- Row click selects and opens detail in the content area.
- Row action menu contains Run, Open, Duplicate, Edit, Archive.
- Keyboard shortcuts can support Run Selected and Open Detail.
- Multi-select enables a native bottom or toolbar action cluster.
- Detail inspector shows readiness and recent run summary.

Native states:

- Selection.
- Disclosure.
- Context menu.
- Drag target.
- Inline progress.
- Confirmation sheet only for real external actions.

## Skill OS App Surface

Primary surfaces:

- Skill/package list.
- Tool list.
- Extension list.
- Stack list.
- Tool logs.
- Capability detail.

Interactions:

- Drag a skill or stack into Studio execution path.
- Right-click opens Configure, Add to Loop, Add to Stack, Open Logs.
- Capability detail shows setup requirements and examples in an inspector-friendly layout.
- Tool logs should be readable as a native timeline or table, not raw console output.

## Studio App Surface

Recommended native layout:

- Left: skill shelf with search and stacks.
- Center: Loop Contract form and execution path.
- Right: Builder Chat plus proposed change receipt.

Interactions:

- Execution path is a reorderable list.
- Path rows expose enable, remove, and open detail actions.
- Drag and drop from Skill OS shelf inserts at the drop position.
- Builder Chat updates a visible change receipt.
- Applying a receipt updates the form.
- Save remains explicit and visible in toolbar or page footer.

## Workbench And Run Result App Surface

Workbench should feel like a native task monitor:

- Active queue as a list or table.
- Selected run opens result detail.
- Result detail contains Final Answer, Timeline, Evidence Gaps, Review Packet, and Run Chat.
- Run Chat stays scoped to selected run and should not switch context silently.

Interactions:

- Queue selection updates result panel.
- Multiple running loops show independent progress.
- Result sections can collapse.
- Evidence items open inline previews or side inspector details.
- Retry, clone, and continue actions stay near the result header.

## Knowledge App Surface

Knowledge should behave like a source library:

- Source list with search and filters.
- Source detail page.
- Attach popover with explicit target selection.
- Extraction/activity timeline.

Use native notifications or compact banners for lightweight confirmations. Avoid persistent modal blockers unless the action is destructive or external.

## App-Specific Interaction Quality

- Make keyboard navigation first-class.
- Prefer native context menus over web-style overflow buttons when appropriate.
- Prefer split panes and inspectors over large overlays.
- Keep long forms readable with sections and native grouping.
- Avoid decorative gradient/card treatments that fight platform conventions.
