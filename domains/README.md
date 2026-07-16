# Project Domain Split

Date: 2026-06-30

This directory separates project material by domain. The active iteration target is currently the Web Skill / Workflow / Loop workbench.

```text
domains/
  frontend/
    app/
      documents/
      code/
    web/
      documents/
      code/
  backend/
    documents/
    code/
  agent/
    documents/
    code/
```

The `code/` folders hold runnable or build-critical implementation. The `documents/` folders hold product, design, architecture, plan, state, and problem records for the matching domain.

## Domain Responsibilities

| Domain | Responsibility | Current main source |
| --- | --- | --- |
| Frontend / Web | Active Skill / Workflow / Loop web workbench | `domains/frontend/web/code/web-prototype` |
| Frontend / App | Retained native surface, not the current iteration target | `domains/frontend/app/` |
| Backend | Out of scope for the current web prototype pass | `domains/backend/` |
| Agent | PI-SDK / skill / loop semantics background, not changed in this pass | `domains/agent/` |

## Rules For Future Work

- Start with `PRODUCT.md`, `DESIGN.md`, and `domains/frontend/documents/current-skill-workflow-loop-workbench.md`.
- Keep App and Web frontend decisions separate unless a shared Skill / Workflow / Loop object contract is explicitly needed.
- Keep Backend and Agent responsibilities separate: Backend owns product data and process/API boundaries; Agent owns reasoning, tool plans, prompts, skills, and capability execution semantics.
- Do not move build-critical source files until the package/build config and scripts are updated in the same change.
- Prefer module-local `documents/` over large global redesign documents.
- Move superseded frontend documents into `domains/frontend/documents/history/`.

## Migration Stages

1. Domain split: App, Web, Backend, and Agent have separate `code/` and `documents/` roots.
2. Build split: separate test commands and CI per domain.
3. Shared contracts: extract shared product object schemas only after App/Web/Backend/Agent usage is clear.
