# Archived: Pre-M5 Selected Direction Visual Restoration QA

> Historical only. This 2026-07-16 three-surface record predates the M5 Agent-first IA and is not
> current implementation, visual-scope or acceptance authority. Current M5 work follows
> `docs/rebuild/07-ux-restructure-m5.md` and `DESIGN.md`.

Date: 2026-07-16

Status: **not yet accepted**. The three baseline surfaces are implemented and compared, but the
Loop lifecycle and Builder evidence still contain real Product API data/contract gaps. This record
does not treat build success, screenshots, or automated smoke tests as visual acceptance.

## Scope

This pass restores the selected product direction for:

- Loop lifecycle board
- Create Loop
- Builder Canvas

Skills and Team library were also captured because they share the same top-level product shell and
were explicitly called out during review. Backend, Product API, Runner, Agent Runtime, and PI
execution semantics were not changed.

## Evidence

| Surface | Reference | Implementation | Comparison |
|---|---|---|---|
| Loop lifecycle | [selected-ai-native-lifecycle-board.png](../design/skill-loop-cloud-workbench-v1/visual-directions/selected-ai-native-lifecycle-board.png) | [implementation](artifacts/selected-direction-visual-qa-2026-07-16/loop-lifecycle-implementation.png) | [side by side](artifacts/selected-direction-visual-qa-2026-07-16/loop-lifecycle-side-by-side.png) |
| Create Loop | [01-create-loop.png](../design/skill-loop-cloud-workbench-v1/key-frames/01-create-loop.png) | [implementation](artifacts/selected-direction-visual-qa-2026-07-16/create-loop-implementation.png) | [side by side](artifacts/selected-direction-visual-qa-2026-07-16/create-loop-side-by-side.png) |
| Builder Canvas | [04-builder-canvas.png](../design/skill-loop-cloud-workbench-v1/key-frames/04-builder-canvas.png) | [implementation](artifacts/selected-direction-visual-qa-2026-07-16/builder-canvas-implementation.png) | [side by side](artifacts/selected-direction-visual-qa-2026-07-16/builder-canvas-side-by-side.png) |

Supporting captures:

- [390px Builder Canvas](artifacts/selected-direction-visual-qa-2026-07-16/builder-canvas-mobile.png)
- [Skills](artifacts/selected-direction-visual-qa-2026-07-16/skills-library.png)
- [Team library](artifacts/selected-direction-visual-qa-2026-07-16/team-library.png)
- [Screenshot manifest](artifacts/selected-direction-visual-qa-2026-07-16/screenshot-manifest.json)
- [Capture failures](artifacts/selected-direction-visual-qa-2026-07-16/capture-failures.json)

## Visual Findings

### Create Loop

- P0: 0
- P1: 0
- P2: 0
- P3: the account area uses the current workspace identity rather than the reference avatar and
  workspace name. This is expected product state, not a layout defect.

The five creation methods, field proportions, AI assistance explanation, autosave line, safety
message, and bottom actions match the reference hierarchy. Disabled actions reflect the genuinely
empty form.

### Loop lifecycle

- P0: 0
- P1: 1
- P2: 0

P1: the isolated Product API workspace contains three Draft Loops and no validated Ready or
published Shared Loop. The Ready and Shared columns therefore show real empty states instead of the
populated reference state. The shell, command entry, actions, three-column proportions, cards,
drop zones, and responsive behavior are implemented.

Resolution requires fresh server-owned Ready and Shared records. Client fixtures or client-written
readiness are prohibited.

### Builder Canvas

- P0: 0
- P1: 1
- P2: 1

P1: the real workspace exposes only one executable Skill and that Skill has no declared input or
output ports. The UI now marks it `Needs setup` and draws only compatible real connections. It does
not invent the five typed business Skills and ports shown in the reference.

P2: the resulting graph is visually lighter than the reference Skill sequence because it uses one
Skill plus Start, Review, and Result nodes. The Canvas remains the largest region and the Skill
picker, Step editor, zoom, fit, minimap, select, move, delete, connect, reconnect, and Escape flows
remain available.

Resolution requires server-owned Skill definitions for the Weekly Product Review sequence with
typed input/output ports. This is a data/contract prerequisite, not a reason to restore client mock
catalogs.

### Skills and Team library

Both routes now use the selected top workspace shell and support English/Chinese and light/dark
themes. Their low row count is the real Product API state: two workspace Skills and one installed
Team Skill release. No fake catalog rows were added for visual density.

## Regression Results

Passed:

- `npm run build`
- `npm run smoke`
- `npm run action:smoke`
- `npm run state:smoke`
- `npm run focus:smoke`
- `npm run accessibility:smoke`

Blocked by current runtime data:

- `npm run dom:smoke`: timed out waiting for the uploaded Skill test to reach `passed`.
- `npm run review:no-permission`: invokes `dom:smoke` and fails at the same runtime step.

The capture audit produced 33 fresh screenshots and 13 explicit failures. The failures cover
missing Ready/Shared/run/release states, absent prepared update/reconnect/success states, one
revision-conflict capture timeout, and the unknown-Loop error heading. They remain recorded rather
than being converted into client-only states.

## Acceptance

The implementation is ready for product review, but visual acceptance is still pending. Completion
requires:

1. Server-owned Ready and Shared Loops for the lifecycle reference state.
2. At least five usable business Skills with declared ports for the Builder reference graph.
3. A passing uploaded Skill execution in the isolated DOM regression environment.
4. Explicit user approval of the three baseline surfaces.
