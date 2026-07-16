# Web Interaction Brief

## Surface Model

The web product is a Skill / Workflow / Loop workbench.

- Left sidebar: `Skills`, `Workflows`, `Templates`.
- Main content: database rows plus object detail, or Builder.
- Builder: Skill Palette, Workflow Canvas, Node Inspector, Run / Debug Panel, Builder Chat patch receipt.
- Chat is scoped to the selected workflow, run, or builder patch. It is never the main product surface.

## Primary Areas

### Skills

- Manage callable `SkillPackage` objects.
- Show purpose, inputs, outputs, risk, dependencies, and usage.
- Primary action: `Add to workflow`.
- Secondary action: create a local skill.

### Workflows

- Manage owned Workflow / Loop objects.
- Support search, filter, select, edit, run, duplicate, and save.
- Detail shows workflow graph outline, run contract, attached resources, run ledger, final answer, evidence gaps, and review packet.
- `Runs` and `Knowledge` appear only inside workflow detail.

### Templates

- Show preset workflow templates.
- Template primary action is `Clone`.
- Cloned templates become owned workflows and open in Builder.
- Templates are not run or silently edited.

### Builder

- Skill Palette supports search, filter, click add, and drag into canvas.
- Workflow Canvas supports node select, move, delete, connect, zoom, fit view, and minimap.
- Node Inspector edits title, description, input mapping, output contract, risk, and review policy.
- Run / Debug Panel shows compile preview, mock execution plan, node errors, and run result.
- Builder Chat generates a `BuilderPatch` receipt; the user must apply or dismiss it.

## Interaction Rules

- Every visible button must either execute or show a disabled / blocked reason.
- Destructive actions must be explicit: `Delete node`, `Dismiss patch`, `Remove`.
- Save is explicit. Dirty state must be visible.
- Long Chinese titles, mixed English IDs, ticker symbols, and meeting names must not overflow.
- Do not expose provider, runtime, worker, schema, artifact path, or secret terms in UI.
