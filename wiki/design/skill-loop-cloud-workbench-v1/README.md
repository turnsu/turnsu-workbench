# Skill & Loop Cloud Workbench V1 Design Package

- Date: 2026-07-10
- Status: target UI/UX design package
- Product requirements: [PRD index](../../prd/README.md)
- Current implementation: [Current System Architecture](../../architecture/CURRENT_SYSTEM_ARCHITECTURE.md)

## Purpose

This package translates the target Skill & Loop Cloud Workbench PRDs into a coherent Web
experience. It defines information architecture, screen hierarchy, interaction behavior,
responsive rules, accessibility, and visual direction before implementation begins.

The current P0 screenshots are references for problems to solve, not visual targets to copy.
The new experience must make five jobs obvious: create/manage Skills, create/manage Loops,
compose Skills, run/review Loops, and share versioned assets with a team.

## Read Order

1. [UI/UX Foundation](docs/UI_UX_FOUNDATION.md)
2. [Information Architecture and User Flows](docs/INFORMATION_ARCHITECTURE_AND_USER_FLOWS.md)
3. [Screen and Component Specification](docs/SCREEN_AND_COMPONENT_SPECIFICATION.md)
4. [Interaction, States, Accessibility, and Responsive Rules](docs/INTERACTION_STATES_ACCESSIBILITY.md)
5. [Design Acceptance](docs/DESIGN_ACCEPTANCE.md)
6. [Design Handoff](HANDOFF.md)

## Visual Material

- [Diagram index](diagrams/README.md)
- [Visual direction index](visual-directions/README.md)
- [Selected direction key frames](key-frames/README.md)
- [Selected direction functional closure](docs/SELECTED_DIRECTION_AND_FUNCTIONAL_CLOSURE.md)
- [Current-product references](references/README.md)

The diagrams are implementation-neutral design sources. The first three visual-direction images
are now historical references only; product review rejected them as default implementation
targets. Continue from the [Design Handoff](HANDOFF.md) before producing a new direction.

## Authority Boundary

- PRDs define product scope and required behavior.
- This package defines the target experience and visual hierarchy.
- `DESIGN.md` remains the current P0 implementation design until the target is implemented.
- Architecture and public contracts decide what the current backend and Agent can truthfully do.
- A design image cannot override security, versioning, readiness, or final-result authority.

## Canonical Product Language

- `Skill`: reusable capability package.
- `Loop`: goal contract plus executable Skill graph.
- `Run`: one execution pinned to exact Loop and Skill versions.
- `Team library`: workspace-published Skills and Loops.
- `Template`: a published Loop version used as a starting point, not a primary navigation item.

## Primary Navigation

- Skills
- Loops
- Team library

Builder, Run detail, publishing, members, connections, and audit are object or secondary routes.
