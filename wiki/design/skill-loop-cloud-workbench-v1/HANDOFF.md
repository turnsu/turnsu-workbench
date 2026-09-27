# Skill & Loop Cloud Workbench V1 Design Handoff

- Date: 2026-07-10
- Status: selected main direction with core Loop functional key frames
- Decision: the first three visual directions remain rejected; the AI-native lifecycle board is selected
- Historical images: [visual-directions](visual-directions/README.md)
- Product requirements: [PRD index](../../prd/README.md)
- Architecture source: [Current System Architecture](../../architecture/CURRENT_SYSTEM_ARCHITECTURE.md)

> **M5 authority update (2026-07-28):** this handoff remains historical background for Loop
> lifecycle and Builder frames. Its older statements that exclude a general Agent landing page or
> freeze three primary navigation items—and its dedicated Run preflight/result route as the main
> execution path—are superseded by the [M5 design package](m5/README.md). The July 25 rebuild
> document is retained only as a decision-history source. The current Agent, ModelSwitch, Skill,
> Loop, Library, mobile and recovery-state closure lives in that M5 package. The 55 screen IDs are
> an automated coverage inventory; human
> visual review is limited to the representative key-frame set and is recorded separately from the
> machine capture manifest using `screenId + contentHash + reviewedAt + verdict`.

## 1. Current Decision

Update on 2026-07-10: the next iteration selected the
[AI-native lifecycle board](visual-directions/selected-ai-native-lifecycle-board.png) as the main
Loops management direction. Its complete Loop route and interaction model are documented in
[Selected Direction and Functional Closure](docs/SELECTED_DIRECTION_AND_FUNCTIONAL_CLOSURE.md),
with visual states in the [key-frame index](key-frames/README.md).

The selected frame is intentionally not the whole product. The board manages lifecycle and quick
actions; dedicated routes own creation, object overview, Definition, Outline, Canvas, publication,
and team update. Run preflight/result routes remain compatibility surfaces only; the M5 primary
run path creates a Product Agent task and reads its result in Agent. The remaining Skill lifecycle, responsive,
theme, localization, and standard error-state frames are listed in the key-frame index and remain
required before full V1 design acceptance.

The V1 design package has enough PRD and architecture material, but the first three visual
directions should not be treated as implementation targets.

They are useful historical references because they expose three possible organizing ideas:
definition-first, canvas-first, and outline-first. None of them yet solves the full product
problem clearly enough:

1. people use many Skills every day and need to manage, tune, test, and version them;
2. people compose Skills into reusable Loop flows, similar to a runnable goal plus explicit
   Skill steps and execution rules;
3. people need to manage and quickly adjust many Loops;
4. teams need cloud sharing, upload, update, ownership, and reuse across independent members;
5. people need first-class creation flows for Skill upload/create and Loop upload/create.

The next design pass should restart from those five jobs instead of refining one rejected image.

## 2. Rejected Visual Directions

### Direction A: Contract Studio

Image: [contract-studio.png](visual-directions/contract-studio.png)

Why it is not enough:

- It makes Loop definition readable, but underplays Skill inventory and Skill iteration.
- It does not make cloud/team sharing feel like a product-level workflow.
- It risks becoming a form editor rather than a workbench for managing and composing reusable
  execution assets.
- Canvas and execution remain too secondary for users who build Loops by arranging Skills.

Keep from it:

- Loop goal, acceptance rules, and run intent should be visible before execution.
- A Loop is more than a graph; it needs a human-readable goal contract.

### Direction B: Canvas Workshop

Image: [canvas-workshop.png](visual-directions/canvas-workshop.png)

Why it is not enough:

- It over-centers the Builder and makes the product feel like a graph editor.
- It does not make Skill lifecycle, team library, version review, upload, and reuse obvious.
- It can repeat the current product problem: strong canvas mechanics, weak product positioning.
- It does not explain when users should create a Skill, add an existing Skill, use a template,
  publish a Loop, or update a team-shared asset.

Keep from it:

- Dragging Skills into a Loop and editing step settings must remain a primary creation mode.
- Canvas, inspector, and test run dock are still required for complex Loop composition.

### Direction C: Operational Outline

Image: [operational-outline.png](visual-directions/operational-outline.png)

Why it is not enough:

- It is structured, but it reads too much like a table/database view.
- It makes Skill/Loop execution clear, but not creation, upload, team distribution, or iteration.
- It may work as one editing mode, not as the whole product language.
- It underplays the natural-language goal/Loop authoring behavior the product needs.

Keep from it:

- Ordered step summaries are valuable for scanability and review.
- Receives/creates/review status should be easy to inspect without opening every node.

## 3. Product Positioning To Preserve

The product is not a provider/ops console, workflow database, or graph demo. It is a cloud
workbench for Skill and Loop assets with a governed general Agent task entry.

Primary objects:

- Skill: reusable capability that can be created, uploaded, tested, tuned, versioned, and shared.
- Loop: reusable goal plus Skill composition, execution steps, run settings, review rules, and
  version history.
- Team library: cloud space where Skills and Loops are published, discovered, updated, and reused.
- Run: one execution pinned to exact Skill and Loop versions.

Primary navigation should remain focused:

- Agent
- Skills
- Loops
- Team library

Secondary routes can exist, but should not become top-level product anchors:

- Builder
- Runs
- Templates
- Resources
- Members
- Settings

## 4. Required Next Design Pass

The next design pass should produce a new direction, not Option A/B/C refinement.

The new direction should answer these screens first:

1. Skills library: manage, create, upload, test, tune, version, and publish Skills.
2. Skill detail: show what the Skill does, what it needs, what it creates, current version,
   usage in Loops, tests, and update history.
3. Loops library: manage personal and team Loops, open recent Loops, duplicate, run, publish,
   and review update availability.
4. Loop builder: combine goal definition, ordered steps, canvas composition, Skill palette,
   step editor, test run, and proposal review.
5. Team library: discover team-published Skills and Loops, install/use them, review versions,
   ownership, update notes, and compatibility.
6. Create/upload flows: create Skill, upload Skill, create Loop from goal, upload Loop, use
   template, publish to team.

The Builder screen is important, but it should be one part of the product, not the only visible
product idea.

## 5. Information Hierarchy Corrections

The next design should fix these hierarchy problems:

- Do not let "template" dominate the product. Templates are starting points, not the product.
- Do not make blocked sample data the first impression.
- Do not show technical fixture terms such as duplicate "workflow workflow", blocked sample,
  executable binding, compile, schema, runtime, provider, or artifact in the main UI.
- Do not flatten all information into equal-weight panels. Each page needs one dominant job.
- Do not make every action a button. Use explicit primary actions, quiet secondary actions,
  menus, and contextual footers.
- Do not hide create/upload/publish in secondary corners; these are core product tasks.
- Agent chat may be the task landing page. It still cannot silently create, modify or publish
  Skill/Loop objects; object changes remain proposals users confirm.

## 6. Recommended Direction For Main Thread

Use a "Library + Composer + Team Cloud" product frame:

- Skills page is an asset manager, not just a registry table.
- Loops page is the reusable work hub, not just saved workflow rows.
- Team library is the shared cloud surface that makes upload, publish, install, update, and
  ownership real.
- Loop Builder combines three representations of the same Loop:
  - Definition: goal, inputs, constraints, completion rules.
  - Outline: ordered Skill steps and review points.
  - Canvas: dependencies, branches, and data flow.

Default screen priority:

1. object title and next action;
2. object status and version;
3. list/outline of reusable assets;
4. selected object detail;
5. creation/publish/update flows;
6. advanced graph and run diagnostics.

## 7. Visual Language Guardrails

The next visual direction should stay work-focused:

- quiet light-first workspace with dark parity;
- less blue page chrome and fewer badges;
- dense but readable lists;
- no card pile, no dashboard theater, no marketing hero, no decorative gradient;
- row-based libraries with clear selected state;
- panels used for one task each;
- natural product language in English and Chinese;
- creation and sharing flows visible without overwhelming the main surface.

## 8. Implementation Boundary

Do not implement from the rejected images directly.

Before code changes, the main thread should produce or select one new design direction that
explicitly covers:

- Skill lifecycle;
- Loop lifecycle;
- cloud/team sharing;
- create/upload flows;
- Builder composition;
- test run and review;
- version/update behavior.

After a new direction is accepted, implementation should follow the existing frontend design
package, PRDs, and `CURRENT_SYSTEM_ARCHITECTURE.md`.

## 9. Files To Carry Forward

Use these as product/design sources:

- [Master PRD](../../prd/2026-07-10-skill-loop-cloud-workbench-master-prd.md)
- [Skill lifecycle PRD](../../prd/2026-07-10-skill-lifecycle-and-creator-prd.md)
- [Loop authoring PRD](../../prd/2026-07-10-loop-authoring-orchestration-runtime-prd.md)
- [Team library PRD](../../prd/2026-07-10-team-cloud-library-governance-prd.md)
- [Web product experience PRD](../../prd/2026-07-10-web-product-experience-prd.md)
- [Backend and Agent platform PRD](../../prd/2026-07-10-backend-agent-platform-prd.md)
- [UI/UX Foundation](docs/UI_UX_FOUNDATION.md)
- [Information Architecture and User Flows](docs/INFORMATION_ARCHITECTURE_AND_USER_FLOWS.md)
- [Screen and Component Specification](docs/SCREEN_AND_COMPONENT_SPECIFICATION.md)
- [Interaction, States, Accessibility, and Responsive Rules](docs/INTERACTION_STATES_ACCESSIBILITY.md)
- [Design Acceptance](docs/DESIGN_ACCEPTANCE.md)

Use these only as historical references:

- [Current P0 screenshots](references/README.md)
- [Rejected visual directions](visual-directions/README.md)
