# Frontend Domain

Frontend is currently scoped around the web Skill / Workflow / Loop workbench. The native app folders may remain in the repository, but they are not the active iteration target for this pass.

```text
frontend/
  app/
    documents/
    code/
  web/
    documents/
    code/
```

The two surfaces may share product nouns and mock data shapes, but they should not be forced into the same layout system.

## Current Active Truth

- [../../PRODUCT.md](../../PRODUCT.md)
- [../../DESIGN.md](../../DESIGN.md)
- [../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md](../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
- [documents/current-skill-workflow-loop-workbench.md](documents/current-skill-workflow-loop-workbench.md)
- [web/code/web-prototype/INTERACTION_QA.md](web/code/web-prototype/INTERACTION_QA.md)

## Shared Frontend Vocabulary

- SkillPackage.
- Workflow / Loop.
- WorkflowTemplate.
- WorkflowNode.
- WorkflowEdge.
- RunDraft.
- RunLedger.
- Review Packet.
- BuilderPatch.
- Scoped Chat.

## Shared Frontend Quality Bar

- Every visible control should have a real interaction.
- Empty, loading, error, disabled, selected, hover/focus, and active states should be designed where the state can occur.
- Chat should update visible product state or propose visible actions; it should not hide the workflow.
- Avoid internal runtime/provider/policy wording in product UI.
- Keep Web patterns dense, inspectable, and object-first.

## Tracks

- [App](app/README.md): retained native surface, not the current iteration target.
- [Web](web/README.md): active web prototype and current product surface.

## Document Rules

- Active architecture index: [documents/architecture/](documents/architecture/)
- Active design index: [documents/design/](documents/design/)
- Active PRD index: [documents/prd/](documents/prd/)
- Historical documents: [documents/history/](documents/history/)

Do not use historical PRDs, old design packets, or previous architecture notes as active constraints unless a future plan explicitly reactivates one file by path.
