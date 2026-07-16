# Web Prototype Product Design Audit

Date: 2026-06-26  
Target: `http://127.0.0.1:5184/`  
Viewport: 1280 x 820 CSS pixels, captured at 2x scale  
Captured: 2026-06-26T16:03:52Z  
Evidence: `screenshot-manifest.json` plus 15 referenced PNG files

## Audit Scope

This audit covers the Web prototype path for LoopOps review:

1. Workbench default entry
2. Loop Library database, detail selection, and explicit run action
3. Workbench Run Result
4. Skill OS package list, ordered stack, Create Tool import flow, and Tool Logs validation
5. Studio Loop Contract page, Builder Chat patch receipt, and review changes
6. Knowledge creation menu, setup panel, and source detail
7. Triple-style scoped Chat quick GUI
8. Workbench empty queue state

The screenshots were regenerated from the running local prototype after DOM anchors were verified. The accepted PNG evidence was captured through the local WebKit audit script against the session `127.0.0.1:5184` target.

## Step List

| Step | Screenshot | Health | Notes |
| --- | --- | --- | --- |
| 01 | `01-workbench-initial.png` | Good | Workbench is now the default entry. Active Queue and Run Result are visible immediately, matching the plan's default workspace expectation. |
| 02 | `02-loop-library-database.png` | Good | Library uses database rows, search, filters, sort, columns, detail, and four live artifact sections: Loop Contract, Run Ledger, Review Packet, and Share-safe Log. Toolbar wrap and search sizing are fixed. |
| 03 | `03-workbench-run-result.png` | Good | Loop row click or explicit Run creates a queue item, updates Review Packet state, and writes Share-safe Log content. Open remains the detail-only action. |
| 04 | `04-skill-os-stack.png` | Good | Skill OS presents public skill packages and a tool detail without exposing provider, runtime, gate, or schema wording. |
| 05 | `05-skill-os-stack-after-add.png` | Good | Adding Builder Skill updates the active execution path and emits a toast without blocking the right detail panel. |
| 05a | `05a-skill-os-create-tool-import.png` | Good | Create Tool shows `Default`、`Invent`、`Import` starting points, the active Import starter summary, Tool name, Task description, Input scope, and Start action. |
| 05b | `05b-skill-os-tool-logs-validation.png` | Good | Tool Use validation writes a failed log and a draft log with readable status, source, duration, cost, output, and Review Chat handoff. |
| 06 | `06-studio-contract-page.png` | Good | Studio exposes structured contract, ordered stack, editable Notion-style contract blocks, save-state feedback, and review/reset controls. |
| 06a | `06a-studio-builder-patch-receipt.png` | Good | Builder Chat applies a structured instruction and shows `Structured patch applied`, steps count, ordered skill path, review rule, exit condition, and output shape inside the visible Loop Contract page. |
| 06b | `06b-studio-review-changes.png` | Good | Review changes is clickable and shows the changed Skill Stack block after Skill OS adds Builder Skill to the active stack. |
| 07 | `07-knowledge-new-menu.png` | Good | New Knowledge menu is visible with Blank, Upload file, Import from website, and Integrations options. |
| 08 | `08-knowledge-setup-panel.png` | Good | Knowledge setup panel appears after Blank creation, making title, note content, and save action explicit. |
| 08b | `08b-knowledge-source-detail.png` | Good | Saved knowledge source opens as a reusable context detail with document count and source metadata visible. |
| 09 | `09-chat-quick-gui.png` | Good | Chat has scoped Run/Builder/Review actions plus model, Instant, Search, Attach, Temporary, prompt categories, attachments, and transcript context. |
| 10 | `10-workbench-empty-state.png` | Good | Empty Queue mode clears active runs while preserving the Run Chat surface and gives clear actions to run the selected Loop or restore seeded review. |

## Strengths

- The information architecture now matches the requested four-part structure: Workbench, Loop Library, Skill OS, Studio, with Knowledge and Chat as supporting first-class surfaces.
- The visual language is restrained and product-like: side navigation, database rows, fine dividers, small radius, familiar controls, and low decorative noise.
- Loop Library behavior now matches the requested operating model: Loop row click or explicit Run launches work, Open controls detail, and Run Ledger / Review Packet / Share-safe Log rows open the corresponding Workbench Run Result.
- Skill OS is framed as user-facing tools and stacks rather than internal execution machinery.
- Create Tool and Tool Logs now have screenshot-level evidence, not only DOM/action smoke coverage.
- Chat is no longer only a text box. The screenshot shows a compact Triple-style quick GUI near the composer.
- The top-right primary action now follows the current page: Run selected, Create tool, Save Loop, New Knowledge, or Send message.
- `npm run focus:smoke` verifies 6 surfaces have focusable nav and page primary actions, and writes `focus-smoke-manifest.json` with focus order.
- `npm run focus:smoke` now also fails if a visible focusable control has no accessible label; current manifest reports 0 unlabeled controls across all 6 surfaces.
- Toasts are capped to two visible messages and old messages auto-clear.
- Studio now marks unsaved stack/path changes, surfaces changed blocks through Review changes, and supports Reset draft.
- Workbench now has explicit Empty queue and Seeded review states for review clarity.
- The same 15-step capture path now also runs at 390 x 844 in `../product-design-audit-web-mobile/`, with no horizontal overflow.
- No captured step shows horizontal page overflow at 1280 x 820.
- The latest pass also fixed a Workbench Run Result tool-log min-width overflow and a Listing Detail install-state layout where `Installed` could wrap vertically next to a long workspace copy id.
- The latest capture was rerun after the dark-mode contrast pass; light cards no longer inherit low-contrast dark-mode text, Studio form fields share the same dark surface system, and Library table headers plus focused ledger rows stay readable.

## UX Risks

- The review server prefers `5184`, but Vite may choose the next free port when local ports are occupied. Use the printed `Local:` URL, or set `LOOPOPS_WEB_URL` for smoke/capture commands.
- Studio's Review changes panel identifies changed blocks, but it is still a lightweight block list rather than a side-by-side textual diff.
- Toasts now avoid the right detail panel and are capped. Production should still record every important state in the row/detail, not only in transient toast copy.
- The visible prototype label has been replaced by product copy in the running review build.

## Accessibility Risks

- WebKit focus smoke now verifies nav and page primary controls across the 6 surfaces, records focus order, and asserts that visible focusable controls have accessible labels. A real screen-reader pass is still needed.
- Placeholder and muted-text contrast is visually improved in the latest dark-mode capture, but should still be measured before treating it as AA-compliant.
- Toast announcements are visually clear, but screen reader live-region behavior was not verified from screenshots.
- Loop row click launches work while explicit Open controls show detail. This keeps keyboard labels distinct for run versus open, but still needs a screen-reader pass to confirm the action model is announced clearly.
- The compact sidebar letter badges should have accessible labels derived from the full nav text, not rely on the single letters.

## Recommendations

1. Expand Studio Review changes from block-level labels into a side-by-side value review for long contract text.
2. Expand accessible naming coverage beyond nav into Library run/open row actions, Review Packet buttons, Skill Stack Up/Down/Remove, Knowledge menu, and Chat composer.
3. Add a focused screen-reader pass and color contrast measurement before claiming WCAG-level readiness.

## Evidence Limits

- This is a screenshot and DOM-state audit of the Web prototype only. It does not prove native macOS behavior, backend execution, or real tool routing.
- No claim of full WCAG compliance is made. Focus order is checked, but focus ring, broader screen reader naming, reduced motion, and color contrast measurements still need direct checks.
- The WebKit capture script renders the same local URL and clicks the same `data-testid` targets, but it is not a substitute for a user session recording.
- The screenshot set in this folder has been rerun after row-click safety, Clone behavior, product copy, mobile toast placement, adaptive CSS, and dark-mode contrast fixes. It still remains visual evidence for the Web prototype only.
