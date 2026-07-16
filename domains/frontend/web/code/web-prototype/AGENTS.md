# Prototype Instructions

Run the local server yourself and return the local URL. Do not open a system browser, macOS app, AppleScript, Chrome, Safari, Accessibility, or screen-control flow unless the user explicitly asks for that surface.

Use `npm run review:no-permission` for local build/smoke/action verification, and use `scripts/review-loopops-web.command` from the repository root when the user needs the Web review server without auto-opening anything.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

For the current visual reimplementation, read `../../../../../DESIGN.md` and
`../../../../../wiki/design/skill-loop-cloud-workbench-v1/HANDOFF.md`, then use the selected image
plus its named key frame for each screen. Use the Product Design `image-to-code` workflow for
faithful implementation and `impeccable` for product UI QA. Do not use `make-goal` as an
implementation workflow.

Build the three baseline screens under one visual owner, one screen at a time. A build, DOM test,
screenshot count, overflow check, or pending manual verdict does not establish design fidelity.
Every baseline screen needs a same-viewport side-by-side comparison and a written deviation review.
