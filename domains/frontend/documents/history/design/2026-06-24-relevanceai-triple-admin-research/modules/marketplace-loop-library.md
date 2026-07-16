# Marketplace / Loop Library Module

Status: research complete

## Reference Sources

- `01-marketplace-template-library.md`
- `screenshots/01-relevanceai-marketplace-workforce.png`
- `screenshots/02-relevanceai-marketplace-listing-detail.png`
- Web prototype: `web-prototype/src/App.jsx`, `web-prototype/src/loopopsModel.js`, `web-prototype/src/styles.css`
- Native: `LoopOpsViews.swift`, `LoopOpsModels.swift`, `LoopOpsLocalStore.swift`, `DashboardViewModel.swift`

## Existing

- Local RelevanceAI marketplace research is sufficient source evidence for this module: it covers marketplace card/listing detail, search/filter/sort, install/clone CTA, readiness, example task, integrations/tools, and sample output.
- Native `LoopOpsLibraryView` already exists and exposes `Loop Library` navigation, search/filter/sort, summary strip, template listing database, multi-select/batch run, ledger list, detail CTA, review packet, and share-safe log identifiers.
- Native `LoopOpsTemplateListing` adapts existing `LoopContract` into marketplace-like listing properties.
- Native `LoopOpsLocalStore.actionContract(for:)` can turn installable/listing actions into runnable `LoopContract` objects.
- `DashboardViewModel.runLoopContracts` already supports batch launch and setup fallback.
- Web prototype already has Loop Library rows, selection, binding panels, detail, run selected, and Run Result integration.

## Gaps

- Marketplace-style listing value is still uneven. Rows show many properties, but detail should more clearly answer: "Should I install/clone/run this loop?"
- Readiness exists as setup logic, but it needs a stronger checklist with missing Knowledge, inputs, skill/tool path, and review boundary.
- Batch run exists, but users need stronger pre-run feedback: how many selected, which are install/setup-only, which will run now, and which need setup.
- Installed/clone/open states need more explicit page-level feedback so users do not confuse source templates with editable owned loops.
- Library is close to a database, but the visual polish still needs Notion-like row density, stable columns, subtle dividers, and fewer floating card treatments.
- Native interaction proof is mostly harness/string identifier based; real click/visual review remains a manual gate.

## Design Direction

- Treat Loop Library as a database of owned and reusable Loop Contracts.
- Row primary click should run or select depending on mode; detail/open action must be explicit.
- Preserve Notion-like database rhythm: compact rows, inline properties, section dividers, and page detail.
- Batch run must be visible and reversible before launch.
- The list should answer "what can I run or clone?" and the detail should answer "what will happen if I use this?"
- Row fields should include loop name, type, domain/category, skill path, required knowledge, access/setup, updated/run count, and review state.
- Detail page should show source/creator, integrations/skills, description, example task, sample output, readiness checklist, and CTA states.
- CTA states should be explicit: Preview, Install, Clone, Finish setup, Open, Run.

## Implementation Targets

- Native:
  - Strengthen `LoopOpsLibraryView` detail with a clearer readiness checklist and sample task/output area.
  - Improve batch run preflight copy and feedback: selected, ready, setup-needed, installed/clone-only.
  - Distinguish source template rows from owned Loop Contracts in row and detail language.
  - Keep primary row interaction predictable: select/open detail, with Run and Detail as explicit actions when ambiguity exists.
  - Add/confirm interaction identifiers for batch preflight, readiness rows, install/clone/open/run CTA states.
- Web prototype:
  - Keep marketplace/database list as the visual parity target.
  - Ensure selection, binding, detail, install/clone, and batch run are covered by smoke/action smoke.
  - Add detail readiness and sample output parity if native gains fields.

## Acceptance

- Loop Library navigation is visible.
- Loop rows expose contract title, domain, skill path, status, and review/final state.
- Library supports search, type/category/access/tag filters, and sort.
- Detail shows source/creator, integrations/skills, description, example task, CTA, and readiness.
- Missing setup items are visible instead of only disabling Run.
- Single loop run starts a background run without opening an unrelated screen.
- Multi-select starts 2-3 independent runs and reports ready/setup-needed split.
- Detail page opens without losing Library context.
- Run Ledger, Review Packet, and Share-safe Log are discoverable as database sections.
- Installed/clone creates an editable owned copy without overwriting the source template.
