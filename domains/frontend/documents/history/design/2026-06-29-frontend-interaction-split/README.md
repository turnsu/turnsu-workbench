# LoopOps Frontend Interaction Split

Date: 2026-06-29

Status: moved into the project domain split. Current frontend work should start from [../../../README.md](../../../README.md).

This is a lightweight frontend-only development package. It extracts the Web and native App interaction work from the larger LoopOps redesign discussion so both surfaces can be developed separately.

This folder is a lightweight development guide for frontend work. It does not define backend contracts or product governance.

## Read Order

1. [00-scope-and-minimal-principles.md](00-scope-and-minimal-principles.md)
2. [01-web-interaction-development-brief.md](01-web-interaction-development-brief.md)
3. [02-app-interaction-development-brief.md](02-app-interaction-development-brief.md)
4. [03-module-work-packages.md](03-module-work-packages.md)

## Source References

- Logged-in RelevanceAI research: [../2026-06-29-relevanceai-authenticated-product-research/relevanceai-authenticated-ui-research.md](../2026-06-29-relevanceai-authenticated-product-research/relevanceai-authenticated-ui-research.md)
- Captured listing screenshots: [../2026-06-29-relevanceai-authenticated-product-research/screenshots/](../2026-06-29-relevanceai-authenticated-product-research/screenshots/)
- Older LoopOps design docs remain historical reference only.

## Current Decision

Develop the frontend interaction layer as two independent tracks:

- Web prototype and web app UI.
- Native app UI, currently treated as the SwiftUI/macOS product surface unless a different app platform is selected later.

Both tracks share product vocabulary, mock data shapes, and module boundaries. They do not need to share exact layout, component code, or platform-specific interaction patterns.
