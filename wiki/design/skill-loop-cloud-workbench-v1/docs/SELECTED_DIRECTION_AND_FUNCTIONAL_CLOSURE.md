# Selected Direction and Functional Closure

- Date: 2026-07-10
- Status: selected design direction, functional screen set in progress
- Visual source: [AI-native lifecycle board](../visual-directions/selected-ai-native-lifecycle-board.png)
- Product source: [Master PRD](../../../prd/2026-07-10-skill-loop-cloud-workbench-master-prd.md)
- Architecture source: [Current System Architecture](../../../architecture/CURRENT_SYSTEM_ARCHITECTURE.md)

## 1. Selected Product Frame

The selected direction is an AI-native, lifecycle-oriented Loop workspace. Its main screen is a
compact three-lane board:

- `Drafts`: editable Loops that are not yet ready to run;
- `Ready`: validated Loops that can start a Run;
- `Shared`: immutable team releases and Loops with an available update.

`Needs attention` is an Inbox filter, not a fourth lane. This keeps the main screen focused on
three meaningful lifecycle stages while preserving a single recovery queue for setup, validation,
review, permission, and update issues.

The board is an overview and direct-action surface. It is not the Loop editor, Run detail, Team
library, or technical diagnostics screen. Selecting a Loop reveals only the action needed at its
current stage. Opening its title navigates to a dedicated object route.

## 2. AI-Native Interaction Contract

The command field `Create or update a Loop with AI` accepts a desired outcome or a requested
change. It never edits a Loop immediately.

1. The service returns a typed proposal against a known base version.
2. The UI shows goal, field, step, Skill, permission, and version changes.
3. The user applies or discards the proposal.
4. Apply checks the current revision, saves a draft, and runs validation.
5. Publish and Run remain explicit user actions.

Manual creation and editing remain complete when AI proposal generation is unavailable. The AI
field is a command form, not a chat home, assistant persona, or replacement for object pages.

## 3. Board Interaction Semantics

Dragging is a request to perform a lifecycle transition, not a client-side status mutation.

| Transition | User result | Required server decision |
|---|---|---|
| Drafts -> Ready | Opens validation and test checklist | Saved version is valid, setup is complete, test policy passes |
| Ready -> Shared | Opens publish review | Immutable release, visibility, permissions, release notes, approval |
| Shared -> Drafts | Creates a new editable draft | New draft is based on the selected published version |
| Any stage -> Inbox | Not a drag target | Inbox is derived from blocking diagnostics and updates |

An invalid drop returns the card to its original lane and shows one reason plus one recovery
action. Keyboard users receive the same transitions through the card action menu.

## 4. Functional Route Closure

### 4.1 Create Loop

Route: `/loops/new`

Entry points:

- Describe a goal
- Start blank
- Use a starting point
- Upload Loop
- Duplicate existing Loop

Goal-based creation captures the desired outcome, example result, required information,
constraints, completion rules, verification, output, and stop rules. AI may propose Skills and
ordered steps. The user reviews the proposal before an editable draft is created.

Upload shows package files, missing Skill versions, permission declarations, secrets findings,
and conflicts before creating a draft. Upload never publishes or executes automatically.

### 4.2 Loop Object

Route: `/loops/:loopId`

The object page makes the Loop understandable without Canvas. It shows purpose, readiness,
selected version, owner, visibility, required information, expected result, ordered Skill summary,
review points, completion checks, latest Run, versions, usage, and the next valid action.

Tabs: `Overview`, `Definition`, `Steps`, `Runs`, `Versions`, `Usage`.

### 4.3 Loop Builder

Route: `/loops/:loopId/edit`

One draft has three synchronized representations:

- `Definition`: goal, context, constraints, done when, verify, output, stop rules;
- `Outline`: readable ordered Skill steps, receives, creates, review, failure behavior;
- `Canvas`: dependencies, branches, ports, mappings, drag, connect, reconnect, and delete.

The selected mode owns the main area. Skill selection and Step editing use temporary drawers so
the editor never becomes a permanent five-panel layout. `Save draft`, `Validate`, `Test Loop`, and
`Publish` remain separate actions.

### 4.4 Run and Review

Routes:

- `/loops/:loopId/run`
- `/loops/:loopId/runs/:runId`

The preflight form shows exact Loop and Skill versions, required inputs, connections, side effects,
and review points. During execution, the Run page shows a product-safe step timeline and reconnect
state. A Review Gate shows candidate output, evidence, missing information, and downstream impact.

`Approve` continues. `Request changes` creates a new attempt with real reviewer input. `Reject`
ends the remaining plan. Completed Runs lead with the authoritative final result, followed by
done-when checks, verification, evidence, gaps, versions, and timeline.

### 4.5 Publish, Reuse, and Update

Routes:

- `/library`
- `/library/loops/:loopId`
- `/loops/:loopId/publish`
- `/loops/:loopId/updates/:version`

Publish review separates saving from release. It shows version changes, validation and test
evidence, permissions, dependencies, affected Loops, visibility, release notes, and approver.

Team reuse distinguishes:

- `Use as starting point`: create a new Loop identity from a published version;
- `Install`: retain upstream identity and pin a version;
- `Fork`: create an independent editable identity;
- `Review update`: inspect impact before explicitly changing a pinned dependency.

### 4.6 Supporting Skill Flow

Loop creation can select an existing Skill, install one from Team library, or open Create/Upload
Skill without losing the Loop draft. A missing Skill remains a recoverable setup item. Skill
creation, validation, testing, versioning, and publication use their own object routes and do not
become fields embedded inside the Loop Builder.

## 5. Secondary UI Surfaces

| Surface | Presentation | Rule |
|---|---|---|
| Global Create | Anchored menu | Exactly Create Skill, Upload Skill, Create Loop, Upload Loop |
| Inbox | Filtered issue list | Derived issues, one reason and recovery action |
| AI proposal | Review sheet/banner | No mutation before Apply changes |
| Skill picker | Searchable drawer | Row click previews, Add inserts after selected step |
| Step editor | Context drawer | One selected step, grouped fields, explicit save behavior |
| Validation | Inline issue list and compact dock | Links each issue to its field or step |
| Test Run | Bottom dock then Run route | Never a developer console |
| Publish review | Dedicated sheet/route | Save never means publish |
| Notifications | Inbox plus maximum two toasts | Toasts do not own persistent blockers |
| Theme/language | Workspace/account menu | English and Chinese remain equivalent |

## 6. Responsive Model

Desktop keeps the three-lane board. At tablet width, lanes become a horizontally controlled stage
view with one lane visible at a time. On 390px mobile, the board becomes a segmented list:
`Drafts`, `Ready`, `Shared`. Loop detail, creation, Outline, and Run review are separate full-screen
routes. Canvas opens full-screen and is not the default mobile editing mode.

## 7. Backend Capability Boundary

The design must distinguish implemented P0 behavior from target V1 behavior.

| Capability | Current implementation | Design behavior until backend exists |
|---|---|---|
| Workflow revision save, compile, Run, SSE, review, history | Implemented P0 | Connect directly through Product API |
| Generic blank/goal Loop creation and duplicate | Target | Omit enabled mutation or show explicit unavailable recovery |
| AI structured proposal | Target | Manual editing remains available; no local fake proposal |
| Upload/import | Target | Complete upload flow only after ingestion contracts exist |
| Team workspace, publish, install, Fork, update | Target | Design states may be reviewed, production controls remain blocked |
| Durable crash recovery, cancel, retry | Target | Do not claim availability in Run UI |
| Production business Skills | Release gap | Never present conformance fixtures as ready business assets |

## 8. Key Frame Set

The selected direction is complete only with these coherent frames:

1. [Lifecycle board, selected direction](../visual-directions/selected-ai-native-lifecycle-board.png).
2. [Create Loop entry and goal form](../key-frames/01-create-loop.png).
3. [AI draft proposal review](../key-frames/02-review-ai-proposal.png).
4. [Loop object overview](../key-frames/09-loop-overview.png).
5. [Builder Definition](../key-frames/10-builder-definition.png).
6. [Builder Outline](../key-frames/03-builder-outline.png).
7. [Builder Canvas with Skill picker and Step editor](../key-frames/04-builder-canvas.png).
8. Validation and test issues are represented inline in Builder Outline and the test dock.
9. [Run preflight](../key-frames/11-run-preflight.png).
10. [Run waiting for review](../key-frames/05-run-waiting-review.png).
11. [Completed Run](../key-frames/06-run-completed.png).
12. [Publish review](../key-frames/07-publish-review.png).
13. [Team library Loop detail and update review](../key-frames/08-team-library-update.png).
14. Skill selection/create/upload recovery remains in the next Skill lifecycle frame set.
15. Mobile lifecycle list, Builder Outline, and Run review remain in the responsive frame set.

The implementation gate remains the full [Design Acceptance](DESIGN_ACCEPTANCE.md) matrix, not the
main lifecycle image alone.
