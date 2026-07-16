# LoopOps Product Iteration Roadmap

Date: 2026-06-26

## Design Read

Reading this as a native macOS productivity workbench plus a companion Web prototype for a high-frequency individual operator, with a Notion-like database/page interaction language and Apple-native restraint. This is product UI, not a marketing surface.

## Source Grounding

- Product baseline: `PRODUCT.md`
- Design baseline: `DESIGN.md`
- Existing research: `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/`
- Reference screenshots: `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/screenshots/`
- Current Web prototype: `domains/frontend/web/code/web-prototype/`
- Current native surfaces:
  - `domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/LoopOpsViews.swift`
  - `domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsModels.swift`
  - `domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsInteractionContracts.swift`
  - `domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsLocalStore.swift`
  - `domains/frontend/app/code/WeChatIntelligenceRadarApp/ViewModels/DashboardViewModel.swift`

## Product Principles

1. User-visible objects are Loop, Skill, Tool, Knowledge, Run, Result, Review, and Chat.
2. Internal implementation names stay out of normal UI: provider, runtime, gate, artifact, schema, worker, raw ID.
3. Lists behave like databases: sortable rows, row actions, selected state, batch action, and page detail.
4. Every major operation has state: empty, ready, running, success, blocked, and needs review.
5. Chat is a control layer. Structured Loop Contract, Run Result, Review Packet, and Tool Log remain visible and authoritative.
6. Web prototype validates product interaction quickly; native SwiftUI remains the real product surface.

## Module Tracks

| Track | Research Owner | Implementation Scope | Acceptance Focus | Status |
| --- | --- | --- | --- | --- |
| Marketplace / Loop Library | Harvey | Loop database, template detail, batch run, ledger/review/log sections | Rows, detail, clone, run, replay, share-safe log | Research running |
| Knowledge / Toast / Attach | Copernicus | Knowledge source library, new source flow, toast stack, attach path | Source status, attach to loop/chat, readable toast history | Research running |
| Skill OS / Tool Builder / Logs | Dewey | Skill package library, skill stack, tool builder, Build/Use/Logs | Create/import tool, run log, review chat, no internal terms | Research running |
| Triple-style Chat / Quick GUI | Banach | Scope-aware composer, quick controls, prompt categories | Controls change prompt/run behavior; chat scopes do not leak | Research running |
| Workbench / Run Result / QA | Helmholtz | Active queue, result panel, review packet, run chat, harness | Multi-loop isolation, final answer, review packet, scoped chat | Research running |

## Phases

### Phase 1: Evidence Inventory

- Read and summarize reference docs, screenshots, current Web prototype, and native surfaces.
- Produce one module document per track under `modules/`.
- Confirm which interactions already work, which are only static, and which are missing.

Exit evidence:
- All module docs have `Existing`, `Gaps`, `Design Direction`, `Implementation Targets`, and `Acceptance`.

### Phase 2: Interaction Contract

- Convert module research into explicit interaction contracts.
- Identify shared types/state that should be extended instead of view-local state.
- Protect backend execution boundaries and review-only behavior.

Exit evidence:
- Model/store changes are covered by tests.
- UI acceptance harness names the key visible routes and states.

### Phase 3: Native Implementation

- Implement native improvements in disjoint slices.
- Keep UI language compact and Apple/Notion-like.
- Avoid hiding structure behind chat-only flows.

Exit evidence:
- `swift build`
- `swift test`
- `swift run WeChatIntelligenceRadar --contract-check`
- Native review checklist updated.

### Phase 4: Web Prototype Implementation

- Update Web prototype to match the improved interaction model.
- Keep it runnable, clickable, and visually reviewable.
- Capture desktop and mobile screenshots without requiring macOS permission popups.

Exit evidence:
- `npm run smoke`
- `npm run action:smoke`
- `npm run build`
- Browser review screenshots and DOM checks.

### Phase 5: Manager Acceptance

- Run forbidden term checks against user-visible copy.
- Run multi-loop, tool log, knowledge attach, and scoped chat acceptance paths.
- Produce final audit against this roadmap and the current worktree.

Exit evidence:
- `final-audit.md` filled with pass/fail evidence, remaining risks, and next recommended iteration.

## Non-Negotiable Acceptance

- Loop Library, Skill OS, Studio, Knowledge, Workbench, Run Result, and Chat are all visible and navigable.
- Clicking or batch selecting loops can start independent runs.
- Skill path editing supports add, reorder, disable/delete, save, reopen.
- Knowledge and tool logs have productized state, not raw backend dumps.
- Scoped chats show their scope and do not cross-contaminate run/builder/review contexts.
- Web prototype and native app both have evidence, not only static screenshots.

