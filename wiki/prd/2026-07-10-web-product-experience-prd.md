# Web Product Experience PRD

- Date: 2026-07-10
- Status: target product requirements
- Parent: [Skill & Loop Cloud Workbench Master PRD](2026-07-10-skill-loop-cloud-workbench-master-prd.md)
- Evidence: user-provided Skills, Workflows, and Templates screenshots from 2026-07-10

## 1. Goal

Make the Web workbench clearly communicate one product: create, manage, combine, run, and
share Skills and Loops.

The first screen of every surface must help the user take the next product action. It must not
look like an internal schema browser, runtime readiness dashboard, or sample-data harness.

## 2. Current Experience Audit

### Step 1: Skills Surface — Poor

The current Skills screen shows one “Blocked sample Skill,” mixed Chinese/English copy, and a
detail rail dominated by runtime binding status and raw field names. The main actions repeat
“Add to workflow,” while creation, upload, testing, versions, usage, ownership, and team
publication are absent.

Product impact:

- users cannot understand whether this is a Skill manager or a runtime registry;
- empty space makes the single blocked fixture appear to be the whole product;
- “needs text, creates echo” is technically valid but gives no real-world value or example;
- the user cannot resolve the blocked state from the visible workflow;
- no path exists for the first stated pain point: managing and iterating many Skills.

Accessibility risk visible from the screenshot: status meaning relies heavily on small pills
and color, detail/action hierarchy is weak, and mixed language increases comprehension burden.
Keyboard behavior and contrast still require interactive testing.

### Step 2: Loops Surface — Poor

The current Workflows screen repeats the blocked sample, shows zero steps, and presents a
large empty table plus a detail panel. Labels such as “No manual review,” “template-sample-
blocked,” and raw input names expose implementation state instead of the Loop's purpose.

Product impact:

- the difference between a Workflow, Loop, and template is not clear;
- the user can open/edit but cannot create, upload, publish, compare versions, or share;
- a Loop is presented as a list record plus graph, not a goal-driven reusable operating asset;
- Run history is empty but provides no guided first-run path;
- the blocked object gives no useful example of why a team would adopt the product.

### Step 3: Template/Builder Surface — Poor

The Builder gives the canvas the largest area, but the selected template produces a zero-step
draft and an empty graph. The bottom Run area mixes Chinese and English, and the input form is
disconnected from a useful goal. A vertical Step editor rail appears even when no step exists.

Product impact:

- users land on a construction tool before defining the Loop's goal and completion criteria;
- the template, draft, and owned Loop modes are visually entangled;
- empty canvas affordances explain dragging but not what a good first Loop requires;
- compile/run disabled states expose process words rather than a guided recovery sequence;
- natural-language creation and team reuse are absent from the primary path.

### Audit Limit

These findings are grounded in the supplied screenshots. Focus order, drag behavior, keyboard
deletion, screen-reader labels, loading transitions, and error recovery require interactive
browser testing and are not claimed from screenshots alone.

## 3. Experience Strategy

The redesign uses a library-and-editor model:

- libraries help users find and manage durable assets;
- detail pages explain one asset and its lifecycle;
- creation flows scaffold a valid first draft;
- the Loop Builder synchronizes Definition, Outline, and Canvas views;
- Runs are evidence attached to a Loop version;
- team publishing is an explicit lifecycle action, not a generic save.

The UI uses `Skill`, `Loop`, and `Run`. `Workflow`, `contract`, `schema`, `binding`, `artifact`,
`provider`, and `ledger` are not primary user terms.

## 4. Global Information Architecture

### Primary Navigation

- `Skills`
- `Loops`
- `Team library`

### Global Actions

One `Create` button opens:

- `Create Skill`
- `Upload Skill`
- `Create Loop`
- `Upload Loop`

### Secondary Workspace Menu

- workspace switcher;
- members;
- connections;
- publishing rules;
- audit history;
- theme, language, and account.

Templates are a Team library filter and a choice inside `Create Loop`. Builder and Run detail
are object routes. They are not permanent navigation items.

## 5. Shared Page Structure

Library pages use:

```text
Page title + short outcome statement                         Create
Search      filters       view options
---------------------------------------------------------------
Object list/table                        Optional preview/detail
```

Object detail pages use:

```text
Breadcrumb
Object name, purpose, version, owner, status          Primary action
Tabs: Overview | Editor/Definition | Tests/Runs | Versions | Usage
Content with one dominant reading order
```

The right rail is reserved for contextual information that changes with selection. Primary
lifecycle actions stay in the object header or dedicated publish/run flow.

## 6. Skills Experience

### 6.1 Skills Library

Default columns/row content:

- name and outcome-oriented description;
- private/workspace visibility;
- selected version;
- readiness and last validation;
- permissions/risk summary;
- number of Loops using it;
- owner and update state;
- one contextual action.

Filters:

- My Skills, Installed, Team, Drafts, Updates, Blocked;
- outcome/category;
- readiness;
- risk/external action;
- required connection;
- owner.

Empty state:

> Create your first Skill from a description or upload an existing Skill package.

Actions: `Create Skill`, `Upload Skill`, `Browse team library`.

### 6.2 Skill Detail

Header answers purpose, readiness, owner, visibility, selected version, and next action.

Overview sections:

- What it helps you do
- What it needs
- What it creates
- Example
- Connections and external actions
- Validation summary
- Used by Loops

Tabs:

- Overview
- Edit (draft owners only)
- Tests
- Versions
- Usage

Primary action examples:

- `Continue editing`
- `Run validation`
- `Publish version`
- `Install Skill`
- `Add to Loop`
- `Review update`

Blocked states show one reason and one recovery action. Raw setup diagnostics are available
only in an expandable technical detail section.

## 7. Loops Experience

### 7.1 Loops Library

Rows show:

- Loop name and goal;
- private/workspace/installed state;
- draft or published version;
- validation status;
- number of steps and Skills;
- latest Run result/time;
- owner;
- update or review state.

Filters:

- My Loops, Shared with me, Installed, Drafts, Published, Needs attention;
- goal/category;
- owner;
- Skill dependency;
- readiness;
- last Run status.

Primary actions: `Create Loop`, `Upload Loop`. Row action depends on state: `Continue editing`,
`Run Loop`, `Review update`, or `View results`.

### 7.2 Loop Detail

Header:

- goal summary;
- selected version and visibility;
- owner/maintainer;
- compile/readiness result;
- `Run Loop` or one recovery action;
- draft actions: `Edit`, `Test`, `Publish`.

Tabs:

- Overview
- Definition
- Steps
- Runs
- Versions
- Usage

Overview shows Goal, expected output, required inputs, Skills, review points, verification,
example Run, and team usage. It must be understandable without opening the canvas.

### 7.3 Run Detail

Run detail is nested under the Loop and shows:

- status, duration, initiator, Loop version, and Skill versions;
- input summary;
- current step/timeline;
- Review request when waiting;
- final result;
- Done-when and Verify results;
- evidence and gaps;
- safe failure/recovery;
- `Run again`, `Create draft from this Run`, and `Compare Run`.

## 8. Create Loop Experience

The first decision is not the canvas. The create screen offers:

- `Describe a goal`
- `Start blank`
- `Use a template`
- `Upload Loop`
- `Duplicate existing`

For goal-based creation:

1. Goal and example outcome
2. Required context/inputs
3. Constraints and stop rules
4. Suggested Skills and steps
5. Review proposal
6. Open Builder

The user can skip suggestions and continue manually. Generated content remains a draft.

## 9. Loop Builder

### 9.1 Header

Show Loop name, draft/base version, saved state, validation state, and actions:

- `Save draft`
- `Test Loop`
- `Publish`
- overflow: duplicate, export, archive

Do not duplicate save actions across global and local bars.

### 9.2 Main Modes

- `Definition`: Loop contract editor.
- `Outline`: ordered readable steps.
- `Canvas`: visual dependencies and mappings.

The selected mode occupies the main workspace. A mode switch does not change or discard data.

### 9.3 Skill Panel

The Skill panel is searchable and collapsible. Rows show name, one-line outcome, compatibility,
version, and readiness. `+` adds after the selected step; drag adds at a canvas position. Row
click previews without changing the Loop.

### 9.4 Step Editor

When a step is selected, show:

- purpose and selected Skill/version;
- receives from;
- creates;
- mapping;
- step instructions;
- connection/permission summary;
- review/failure/retry settings;
- test status;
- move, duplicate, replace Skill, and delete.

Collapsed state is a labeled rail only. No panel appears when nothing can be edited.

### 9.5 Diagnostics

Validation issues appear in one panel grouped by:

- Loop definition
- Missing setup
- Step data flow
- Permissions/review
- Output/verification

Selecting an issue focuses the exact field, step, or connection. `Needs setup` and `Fix
required` are not merged into one generic blocked state.

### 9.6 Assistant

The assistant is optional and collapsed by default. It proposes changes and shows a reviewable
diff. It does not occupy the main canvas, send a hidden edit, or use internal labels such as
patch/scoped/context binding.

## 10. Team Library Experience

The Team library provides Skills and Loops in one search surface with type filters. Each item
shows owner, version, validation, permissions, usage, and update state.

Detail actions are explicit:

- Skill: `Install Skill`, `Add to Loop`, `Fork Skill`
- Loop: `Run installed Loop`, `Use as starting point`, `Fork Loop`
- Restricted: `Request access`
- Update: `Review update`

Publishing is a separate review flow showing diff, tests, permissions, dependencies,
visibility, and approver. “Save” never implies “publish.”

## 11. Product Copy

### Preferred

- What this Skill needs / 这个技能需要什么
- What it creates / 会生成什么
- Create Loop / 创建 Loop
- Use as starting point / 以此为起点
- Needs setup / 需要补充设置
- Fix required / 需要修正
- Test Loop / 试运行 Loop
- Proposed changes / 建议修改
- Publish to team / 发布到团队
- Review update / 查看更新影响

### Avoid in Primary UI

- contract / schema / binding / runtime / provider / artifact
- workflow ledger / patch receipt / scoped chat / mock run
- clone template / owned workflow / source packet
- internal object IDs unless in a copyable technical details section

English and Chinese copy are authored separately. Chinese is not a word-for-word translation,
and business Skill names may remain in their source language when appropriate.

## 12. Interaction States

Every data surface supports:

- first-use empty state;
- loading skeleton with stable layout;
- partial data state;
- no search results with reset action;
- permission state with request action;
- blocked state with one recovery action;
- version conflict with review/merge/copy choices;
- offline/reconnecting state;
- service failure with retry and request ID in technical detail;
- success feedback that does not obscure primary actions.

Buttons are enabled only when their action can complete or open a complete recovery flow. A
disabled primary action always has a visible reason, not only a tooltip.

## 13. Responsive and Accessibility Requirements

- Desktop 1280/1440: libraries and Builder remain usable without page-level horizontal scroll.
- Mobile 390: prioritize reading, definition, outline, and Run review; canvas may use a
  dedicated full-screen mode.
- Full keyboard navigation for list selection, menus, Builder modes, step operations, and
  review decisions.
- Visible focus, semantic headings, labeled controls, and announced validation changes.
- Status never relies on color alone.
- WCAG AA contrast for text and controls in light and dark themes.
- Motion respects reduced-motion preference.
- Long Chinese names, English package IDs, and mixed text truncate predictably with full
  accessible names.
- Destructive publish/archive/delete actions require scoped confirmation and explain impact.

## 14. Web Acceptance Criteria

For both English and Chinese, light and dark, desktop and mobile:

1. a new user can identify the product's purpose from Skills, Loops, and Team library;
2. first-use screens provide Create/Upload paths instead of a blocked sample;
3. the Skill flow covers create/upload, edit, validate, test, publish, versions, and usage;
4. the Loop flow covers goal contract, Skill composition, compile, test, publish, Runs, and
   versions;
5. a teammate can discover, install/fork, and update a shared asset;
6. Definition, Outline, and Canvas stay synchronized;
7. all visible buttons work or show a visible reason and recovery action;
8. no primary UI exposes the avoided internal terms;
9. keyboard-only users can complete create, edit, publish review, Run, and Review Gate flows;
10. screenshots show realistic useful Skills and Loops, not conformance or blocked fixtures.
