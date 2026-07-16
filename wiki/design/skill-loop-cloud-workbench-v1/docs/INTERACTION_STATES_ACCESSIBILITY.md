# Interaction, States, Accessibility, and Responsive Rules

## 1. Interaction Contract

Every control must be one of:

- immediately executable;
- opens a complete flow;
- disabled with a visible reason and recovery action;
- omitted because the capability is not available.

There are no dead buttons, demo-only controls, or enabled actions that silently stage unrelated
changes.

## 2. Selection and Navigation

- Row click selects on split views and opens on single-column views.
- Checkboxes are reserved for bulk actions and do not duplicate selection state.
- Selection survives non-destructive filters only when the item remains visible.
- Browser Back restores filters, scroll, and prior selected object.
- Deep links open the exact object/version when authorized.

## 3. Save, Validate, Test, Publish

These actions are distinct:

- Save draft: persist editable work.
- Validate: check package/contract/graph/runtime readiness.
- Test: execute safe test inputs and capture evidence.
- Publish: create an immutable visible release.

The UI never uses one Save button to imply all four actions. Header state names the object:
“This Loop has unsaved changes,” not generic “Unsaved changes.”

## 4. Drag and Drop

### Skill to Canvas

- drag handle is distinct from row selection and Add;
- drag preview shows Skill name and version;
- canvas highlights valid drop region;
- compatible insertion points may be suggested;
- invalid canvas or outside drop produces a nearby explanation;
- successful drop creates, selects, and reveals the step;
- screen-reader/keyboard equivalent uses Add to Loop and insertion menu.

### Step Reorder

- Outline supports keyboard move up/down and drag reorder;
- reorder never overrides dependency edges without an explicit proposal;
- invalid reorder explains the blocking dependency.

## 5. Graph Connections

- output port hover/focus names the created value;
- starting a connection announces source and enters a visible mode;
- temporary edge follows pointer;
- valid targets highlight; invalid targets remain distinguishable;
- Esc cancels; clicking background cancels after confirmation only if mappings would be lost;
- self-connection and incompatible types show inline node-level errors;
- reconnect preserves the old edge until the new target is valid.

## 6. Destructive Actions

### Delete Step

- immediate when isolated and undo is available;
- confirmation when dependents, mappings, or review policy are affected;
- dialog names affected steps and offers Cancel/Delete step;
- focus returns to a predictable neighboring step.

### Archive/Deprecate

- distinguish from permanent deletion;
- explain effects on new use, installed assets, pinned Loops, and historical Runs;
- show replacement selection when deprecating a Skill version.

## 7. Assistant Proposals

- sending a message creates a pending proposal, not a mutation;
- proposal shows summary, per-object diff, permission/version impact, validation result;
- Apply changes checks the current base revision;
- conflict opens review/merge/save-copy choices;
- Discard removes only the proposal;
- assistant unavailable state explains that manual Definition/Outline/Canvas editing remains
  available.

## 8. Upload and Import

States:

- selecting;
- uploading with progress and resumable status;
- quarantine scanning;
- parsing;
- needs decisions;
- ready as draft;
- failed with specific recovery.

The preview lists files, size, format, executable content, permissions, dependencies, secrets
findings, and version conflicts. A failed file may be replaced without losing resolved choices.

## 9. Standard Data States

| State | Required presentation |
|---|---|
| First use | Explain value, provide Create/Upload/Browse actions |
| Loading | Stable skeleton matching final layout |
| Partial | Show available data and one retry for missing section |
| Empty search | Query/filter summary and Clear filters |
| Offline | Read-only cached state where safe; reconnect status |
| Service error | Plain-language impact, Retry, request ID in technical detail |
| Permission denied | What access is needed and Request access/contact owner |
| Needs setup | Missing connection/material/input and one setup action |
| Fix required | Exact Skill/Loop/step issue and focus action |
| Conflict | Compare latest, merge, save copy, or discard local |
| Update available | Version/permission/dependency impact and Review update |

## 10. Toasts, Banners, and Inline Feedback

- Maximum two toasts, top-right below global bar.
- Deduplicate identical message/action pairs.
- Toasts do not cover Step editor, Run controls, or mobile action bar.
- Errors affecting the current task use inline banners at the affected surface.
- Proposal, compile, publish, and review states use persistent banners or panels until resolved.
- `aria-live="polite"` for confirmations; `assertive` only for immediate blocking errors.

## 11. Keyboard and Focus

- Logical order follows sidebar, top bar, page actions, filters, list, detail.
- Skip link reaches main content.
- Visible 3px-equivalent focus ring with sufficient contrast.
- Escape closes the topmost non-destructive overlay or cancels connection mode.
- Dialogs trap focus and restore it to the invoking control.
- Builder shortcuts are optional accelerators, never the only path.
- Node/step selection, Add, connect, disconnect, move, duplicate, and delete have keyboard paths.
- Canvas exposes an accessible Outline equivalent.

## 12. Screen Reader Semantics

- Sidebar uses navigation landmark and current page.
- Libraries use tables or lists matching visual structure.
- Object status includes text, not only color.
- Step graph has an accessible name, step count, connection count, and selected-step announcement.
- Ports announce direction, value name, type summary, and connection state.
- Validation summary links to each affected field/step.
- Run timeline is an ordered list with current/completed/failed state.
- Review buttons announce consequence.

## 13. Responsive Behavior

### 1440 and 1280

- full sidebar or user-collapsed state;
- library split view allowed;
- Builder may show Skill panel + editor + Step editor if editor remains at least 640px;
- contextual panels collapse before the editor becomes unusable.

### 1024 and Tablet

- collapsed app navigation;
- list/detail become route + drawer;
- Builder shows one main editor mode; Skill/Step panels are overlays;
- table columns reduce to identity, state, owner, action.

### 390 Mobile

- separate list/detail routes;
- search and filters use a sheet;
- Definition/Outline are primary Loop editing modes;
- Canvas opens dedicated full-screen view;
- no page-level horizontal overflow;
- bottom action bar remains above safe area;
- dialogs become sheets when appropriate.

## 14. Localization

- English and Chinese dictionaries contain all visible copy, placeholders, aria labels, titles,
  tooltips, empty/error states, and status explanations.
- No string concatenation that assumes English word order.
- Dates, numbers, duration, and relative time are locale formatted.
- Long Chinese titles and unbroken package IDs truncate with accessible full text.
- Product terms stay consistent: Skill/技能, Loop/Loop, Run/运行, Team library/团队资源库.
- Raw server messages are fallback technical detail; visible copy maps stable error codes.

## 15. Theme

- Light and dark are equivalent, not separate visual products.
- System preference may set the initial theme; user choice persists.
- Browser and canvas controls inherit semantic tokens.
- Dark mode buttons, inputs, badges, graph edges, focus, and destructive states require explicit
  contrast review.
- Do not invert screenshots or artifacts that need original colors.

## 16. Motion

- 120-180ms for hover/selection/drawer transitions.
- 180-240ms for sheet/dialog transitions.
- No motion for layout-critical node placement or connection completion that delays feedback.
- Reduced-motion removes nonessential movement and uses opacity/state changes.
