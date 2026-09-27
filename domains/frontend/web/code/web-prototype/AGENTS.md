# Web Client Instructions

Run the local server yourself and return the local URL. Do not open a system browser, macOS app, AppleScript, Chrome, Safari, Accessibility, or screen-control flow unless the user explicitly asks for that surface.

Use the package-local build and smoke commands for automated verification. `npm run review` is a
visual-only environment and cannot establish Product API or execution completion.

Before product or interaction changes, read the repository Master PRD v0.6 and the current
implementation architecture. The PRD owns target product semantics; the architecture owns current
progress. The Web client is an existing Product surface, while the local desktop workbench is the
current primary entry. M5 files describe existing Web routes until those routes are deliberately
replaced; they do not restore the old Web-first delivery order.

Before making substantial visual changes, use the available Product Design workflow when the visual
source is unclear or no longer matches the current goal. Durable product decisions belong in the
authoritative PRD/design package, not as one-off rules appended here.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

For existing M5 surfaces, read `../../../../../DESIGN.md` and the current M5 handoff before visual
changes. For new team or desktop-shared surfaces, follow Master PRD v0.6 and the current
desktop-first design package; do not extend old M5 navigation by assumption. Human review
must use the real same-origin Product API candidate. A build, DOM test, screenshot count, static
screen ID, synthetic PNG or pending verdict does not establish design fidelity or functionality.

## Current M5 manual-review decisions

- The Main Agent model picker only exposes chat-capable Product Model Catalog profiles. It groups
  them as text or multimodal according to `image_input`; an `image_generation`-only profile is an
  execution capability and must not appear as a primary Agent conversation model.
- The desktop result reader uses a keyboard-accessible draggable separator and remembers width as
  a per-user local UI preference. Mobile keeps the full-screen result view without a resize handle.
