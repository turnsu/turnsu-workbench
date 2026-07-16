# Screen and Component Specification

## 1. App Shell

### Sidebar

- Workspace switcher at top.
- Primary items: Skills, Loops, Team library.
- Create button remains visible without competing with navigation.
- Recent objects may appear below a divider, maximum five, and never replace primary items.
- User/workspace settings live at the bottom.
- Collapsed sidebar uses icons and tooltips; active state remains visible.

### Top Bar

- Current page/object title and breadcrumb.
- Search belongs to the active library or a global command search, not both simultaneously.
- Theme/language move to workspace/account menu in the target V1 shell.
- Contextual primary action sits at far right.

## 2. Skills Library

### Purpose

Find, create, upload, validate, install, and maintain Skills.

### Structure

1. Page title, one-line purpose, Create Skill.
2. Search and filters.
3. List/table as the primary surface.
4. Optional selection preview at desktop widths.

### Default Row

- name and outcome summary;
- owner/avatar or “You”;
- private/team/installed visibility;
- validation status and date;
- risk/external-action icon when relevant;
- Loop usage count;
- update state;
- contextual trailing action.

### Required States

- no Skills: create/upload/browse team;
- no results: clear filters;
- draft: Continue editing;
- validation failed: Fix issue;
- published: Add to Loop;
- team item not installed: Install Skill;
- update available: Review update;
- permission denied: Request access.

## 3. Skill Detail and Editor

### Detail Header

- Skill name and plain-language purpose;
- owner, selected version, visibility, last validation;
- one status line and one primary action;
- overflow for export, fork, deprecate, archive.

### Detail Tabs

- Overview
- Edit, only for an editable draft
- Tests
- Versions
- Usage

### Overview

- What it helps you do
- What it needs
- What it creates
- Example
- Connections and external actions
- Validation summary
- Used by Loops

### Editor

Use a left section list or stepper and one central editor. Do not place all fields in one form.

- Overview
- Instructions
- Files
- Needs and creates
- Permissions and setup
- Tests

Footer actions: Save draft, Run validation. Publish is available only after current-content
validation and opens a dedicated review flow.

## 4. Loops Library

### Purpose

Find, create, run, publish, and improve reusable Loops.

### Default Row

- Loop name and goal;
- owner and visibility;
- draft/published version;
- Ready, Needs setup, or Fix required;
- step and Skill counts;
- latest Run result/time;
- update/review state;
- contextual action.

Use goal text instead of a technical graph description. Keep the last Run secondary unless the
user filters by Runs needing attention.

## 5. Loop Detail

### Header

- Loop name, one-sentence goal, owner, selected version, visibility;
- readiness explanation;
- primary action: Run Loop, Continue editing, Fix issue, or Review update;
- secondary actions: Edit, Test, Publish depending on state.

### Tabs

- Overview
- Definition
- Steps
- Runs
- Versions
- Usage

### Overview

- Goal
- Expected result
- Required information and connections
- Skill sequence summary
- Review points
- Done when and Verify
- Example output or latest successful Run
- Team usage and maintainer

## 6. Create Loop

The first screen shows five clear paths, not a template database:

- Describe a goal
- Start blank
- Use a starting point
- Upload Loop
- Duplicate existing Loop

Goal-based creation is a focused flow:

1. Goal and example result.
2. Inputs/context.
3. Constraints and stop rules.
4. Suggested Skills and ordered steps.
5. Review proposed Loop.

Allow Save draft and Exit. Do not require the user to understand graph nodes before step 4.

## 7. Loop Builder

### Header

- breadcrumb and Loop name;
- base/draft version;
- saved/unsaved state;
- validation state;
- Save draft, Test Loop, Publish;
- overflow for duplicate, export, archive.

### Mode Bar

- Definition
- Outline
- Canvas

These are representations of one draft, not separate pages or tabs with independent data.

### Definition Mode

Use structured sections:

- Goal
- Context
- Constraints
- Done when
- Verify
- Output
- Stop rules

Show concise guidance and examples only when a field is empty or focused.

### Outline Mode

Each step row shows:

- order and type icon;
- title and Skill/version;
- receives from;
- creates;
- review/condition;
- validation state;
- drag handle and menu.

Inline insertion appears between rows. Selecting a row opens Step editor.

### Canvas Mode

- Skill panel left, canvas center, Step editor right when open.
- Node title and purpose dominate; technical ports stay compact.
- Selected node has clear border/focus without a heavy glow.
- Edge labels appear only for non-obvious mappings.
- Minimap and zoom controls stay in separate corners.
- Drop zone visibly responds; invalid drop explains where to release.
- New node is selected and revealed.
- Connection mode shows source, temporary edge, target affordance, Esc cancel, inline errors.

### Step Editor

Sections:

- Basics
- Skill and version
- Receives
- Creates
- Instructions
- Permissions and connections
- Review and failure behavior
- Tests
- Actions

Delete is secondary-danger and requires confirmation when the step has downstream dependents.

### Assistant

Compact bottom-right action opens a drawer or bottom sheet. It contains prompt, proposed changes,
diff, Apply changes, and Discard. The proposal banner remains attached to the Builder until
decided. Opening it never hides the active editor mode.

### Validation and Test Dock

Compact collapsed state shows validation summary and Test Loop. Expanded state shows issues or
step progress. It must not become a generic developer console.

## 8. Run Detail

### Running

- Run/Loop identity and exact version;
- current state and elapsed time;
- step timeline with one current item;
- product-safe progress;
- connection/reconnect state;
- Cancel when supported.

### Waiting for Review

- candidate result;
- evidence and gaps;
- reviewer question;
- downstream effect;
- Approve, Request changes, Reject;
- note field required for changes/rejection based on policy.

### Completed

- final result first;
- Done-when and Verify checks;
- evidence and gaps;
- review history;
- step timeline and attempts;
- exact Loop and Skill versions;
- Run again, Create draft from Run, Compare Run.

### Failed

Explain what failed, what was preserved, and the safe next action. Internal stack traces remain
in technical details accessible to authorized maintainers.

## 9. Team Library

### Library

One search surface with type filters for Skills, Loops, and Starting points. Other filters:
owner, installed, update, validation, risk, connection, and collection.

Rows/cards may be used for genuinely distinct published assets, but avoid marketing tiles. Each
item shows purpose, owner, version, validation, permissions, usage, and update status.

### Detail

- purpose/goal;
- maintainer and provenance;
- versions and release notes;
- validation/tests;
- permissions/connections;
- dependencies;
- examples;
- usage;
- Install, Add to Loop, Use as starting point, Fork, Request access.

### Publish Review

Dedicated step or sheet showing:

- visibility and version;
- changes;
- tests/validation;
- permission and connection changes;
- dependencies and affected Loops;
- release notes;
- approver and policy.

Save never means publish.

## 10. Component Inventory

Use and extend the local design-system wrapper:

- AppShell, SideNav, TopBar
- Button, IconButton, MenuButton
- SearchInput, TextInput, TextArea, Select
- FilterBar, FilterChip
- ObjectRow, DataTable, EmptyState
- ObjectHeader, Breadcrumb, Tabs, SegmentedControl
- StatusDot, Badge, Progress
- Drawer, Sheet, Dialog, Popover, Tooltip
- Toast, InlineBanner
- VersionSelector, DiffView
- FileTree, UploadDropzone
- StepRow, WorkflowNode, Port, Edge
- Timeline, ReviewPanel, ResultViewer
- ChatComposer, ProposalReview

All primitives receive English/Chinese labels, keyboard states, loading/disabled behavior, and
stable dimensions before feature-specific styling.
