# Product And Frontend Restructure V1

- Date: 2026-07-25
- Status: review draft
- Scope: main agent workspace, skill creation, workflow creation, model selector
- Source of truth for current implementation limits: [Current System Architecture](../../../architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
- Current active implementation design: [DESIGN.md](../../../../DESIGN.md)

## 1. Purpose

This document defines the next-round product and frontend restructuring direction for the
Skill / Workflow / Loop workbench.

It exists because the current experience mixes three different product roles into one surface:

1. conversational Agent workspace
2. workflow control and management console
3. skill package import and publishing backend

That mixed model makes the product hard to understand. Users do not know whether they are:

- starting a task
- configuring a system
- importing an artifact
- or reviewing an execution result

The restructuring goal is to restore one clear primary path:

```text
Start a task -> get a result -> review / refine -> optionally configure or publish
```

Not the reverse.

## 2. Core Product Decision

The redesign should follow these rules:

1. main-task-first, configuration-second
2. result-first, management-second
3. beginner-default, advanced-options-collapsed
4. internal system artifacts should not be default user-facing concepts
5. model selection is a lightweight switch, not a primary page structure
6. frontend only chooses the selected model profile; backend owns provider routing and protocol adaptation

## 3. What Is Wrong In The Current Product

### 3.1 Main Agent workspace

The current main Agent page behaves like a control console instead of a task workspace.

Observed problems:

- the composer is placed in a narrow right-side panel instead of the main interaction axis
- the left side becomes a large empty result area before any task has value
- text chat and image creation are treated as parallel page modes instead of one unified task input system
- model selection is visually over-weighted
- the page feels like workflow administration rather than an Agent that helps complete work

### 3.2 Skill creation

The current skill creation flow is package-first instead of definition-first.

Observed problems:

- `从草稿开始` and `GitHub 仓库 / 当前设备中的文件夹` are treated as equal creation paths, but they represent different user intents
- `从草稿开始` only collects name, description, and category, which is not enough to define a real skill
- `检查 / 测试 / 发布` reads like an internal platform pipeline, not a creation wizard
- runtime, language, input/output, execution mode, and test shape are not productized

### 3.3 Workflow creation

The current workflow story leaks internal representation.

Observed problems:

- `loop.json` feels like an internal artifact, not a normal user input
- the product does not clearly separate document-to-workflow creation from advanced definition import
- workflow design, workflow execution, and workflow results are not clearly separated as distinct states

### 3.4 Model selection

The current model selector has too much layout weight.

Observed problems:

- it occupies permanent interface space
- it behaves like configuration rather than a quick switch
- it exposes model choice as a primary action instead of a small execution preference

## 4. Restructuring Principles

### 4.1 Product principles

- the product should start from user intent, not system structure
- the interface should default to one clear action per screen
- advanced configuration should be present but not dominant
- import, validation, testing, and publishing should appear only when the user is on those tasks

### 4.2 Frontend principles

- the primary composer must sit on the main visual axis
- empty states must guide action instead of showing passive blank space
- the same object should not mix authoring, importing, and publishing in one undifferentiated dialog
- lightweight actions should use lightweight UI

### 4.3 Backend principles

- frontend sends `mode`, `modelProfileId`, input, attachments, and standard task parameters
- backend resolves provider, capability, revision, adapter, and protocol
- frontend must not own provider-specific payload logic
- frontend consumes one unified execution result shape

## 5. Object 1: Main Agent Workspace

## 5.1 Product role

The main Agent page is a task workspace, not a workflow console.

The user should arrive here to do three things:

1. state a task
2. watch progress and review outputs
3. optionally inspect status, context, and artifacts

## 5.2 Target layout

```text
Header: title + light state + optional context drawer toggle
Body: main conversation / task timeline / output cards
Bottom: full-width primary composer
Composer accessories: model switch, attachments, capability shortcuts, send
Optional right drawer: context, run details, artifacts, advanced controls
```

## 5.3 Required changes

- move the primary composer from the right sidebar to the bottom main area
- reduce the right panel from mandatory control surface to optional drawer
- unify text and image generation under one task workspace
- make the output stream the main evidence surface
- make empty state actionable with example tasks and recent work

## 5.4 Image generation inside the Agent workspace

Image generation should not be a second heavyweight mode.

Default behavior:

- user writes a prompt
- system uses the selected image-capable model default
- result appears in the same task/output stream

Advanced image controls such as aspect ratio, seed, format, and negative prompt should be hidden
behind an expandable advanced section.

## 5.5 Why this is the correct structure

This keeps the user mental model stable:

```text
I ask -> the Agent acts -> I see results -> I refine if needed
```

Instead of:

```text
I enter a console -> choose a mode -> configure parameters -> maybe send something
```

## 6. Object 2: Skill Creation

## 6.1 Product role

Skill creation must distinguish between:

1. defining a new skill
2. importing an existing skill

These are not the same product action.

## 6.2 New top-level entry

The first skill-creation step should ask the user to choose:

- `定义新技能`
- `导入已有技能`

## 6.3 Path A: Define a new skill

Recommended flow:

```text
1. choose skill type
2. define job, inputs, and outputs
3. choose execution mode / runtime
4. choose category and tags
5. generate draft
6. add smoke test
7. publish
```

### Step 1: skill type

Controlled options:

- Prompt Skill
- Tool Skill
- Script Skill
- Workflow Skill

### Step 2: job, inputs, outputs

Required fields:

- name
- one-line description
- detailed behavior
- input type
- output type

Suggested input types:

- free text
- structured fields
- file input
- multi-input

Suggested output types:

- text
- structured JSON
- file / artifact
- image

### Step 3: execution mode / runtime

Ask only when relevant.

- Prompt Skill: no runtime selection
- Tool Skill: select tool contract / binding source
- Script Skill: choose runtime
  - Python
  - Node.js
  - Shell
- Workflow Skill: confirm orchestration boundary and dependent skills

### Step 4: category and tags

Use:

- one controlled primary category
- optional flexible tags

Recommended primary categories:

- finance
- research
- coding
- automation
- image
- data
- ops
- other

### Step 5: generate draft

Only now should the system generate the initial draft package or `SKILL.md` scaffold.

### Step 6: add smoke test

Minimum publication gate:

- one example input
- one expected result or expected effect description
- one smoke test case

### Step 7: publish

Publishing should remain a separate final action, not something implied by draft creation.

## 6.4 Path B: Import an existing skill

This path should contain source-specific subflows:

- current device folder
- GitHub repository
- standard skill package file

### Current device folder

Keep this path. It matches user intent well.

But the UI must clearly explain:

- what files are expected
- whether `SKILL.md` is required
- whether the system can generate missing metadata
- what validation will run

### GitHub repository

This is an advanced import path, not a default creation path.

Required fields:

- repository URL
- branch or tag
- skill directory

The UI must also state:

- whether only public repositories are supported
- whether `SKILL.md` is required
- whether the system can synthesize an import draft when metadata is missing

### Standard package file

If package import remains, it should be named explicitly as package import, not hidden under a
generic upload concept.

## 7. Object 3: Workflow Creation

## 7.1 Product role

Workflow creation should be framed as:

- generate a workflow from a requirement document
- or import a workflow definition if the user is advanced

Not:

- upload an internal workflow structure file as the default mental model

## 7.2 New top-level entry

The first workflow-creation step should ask:

- `从文档生成工作流`
- `导入工作流定义`

## 7.3 Path A: Generate from document

This should be the default path.

Supported inputs:

- Markdown
- PRD
- requirement notes
- goal + constraints text

Recommended flow:

```text
1. provide document or requirement text
2. system extracts goals, constraints, inputs, outputs
3. system proposes workflow nodes and dependencies
4. user reviews and edits proposal
5. save as workflow draft
6. test run
7. publish or add to team library
```

This path aligns with normal user understanding.

## 7.4 Path B: Import workflow definition

This is the advanced path.

Supported inputs:

- `.loop.json`
- other formal workflow definition artifacts if later adopted

This path must be clearly labeled as advanced/import-only.

## 7.5 Workflow page state model

The workflow product must distinguish three states:

1. designing
2. runnable
3. executed / results available

The page should make that state visible, so users always know whether they are editing, testing,
or reviewing.

## 8. Object 4: Model Selector And Model Routing

## 8.1 Product role

Model selection is a lightweight execution preference switch.

It is not:

- a full page
- a persistent configuration panel
- a dominant piece of layout

## 8.2 Frontend interaction

Recommended interaction:

- show the current model as a compact chip/button near the composer
- on click, open a small popover
- show only models valid for the current task mode
- group by capability
  - text
  - image
- show concise metadata
  - model name
  - provider
  - revision
  - brief capability cue

## 8.3 Frontend contract

Frontend only needs to know:

- current task mode
- available model profiles
- selected `modelProfileId`

Frontend should not care whether the backend uses OpenAI, Anthropic, Gemini, Stability, or another
provider protocol.

## 8.4 Backend routing model

Frontend submits:

- `mode`
- `modelProfileId`
- `input`
- `attachments`
- standard task parameters

Backend resolves:

- provider
- capability
- model revision
- execution adapter
- provider-specific payload format

That means the frontend is simple:

```text
select model -> submit task
```

And the backend is responsible for:

```text
resolve model -> route provider -> adapt protocol -> execute -> normalize result
```

## 8.5 Why this is the correct split

This keeps model complexity where it belongs.

- user experience stays simple
- frontend remains stable
- backend can evolve routing and provider logic without redesigning UI structure

## 9. Cross-Cutting Rules

## 9.1 Chinese-first product behavior

Chinese is already supported in the product, but the default entry behavior is still not aligned
with a Chinese-first experience.

Requirement:

- use workspace or user preference when present
- otherwise default to Chinese in Chinese-first contexts
- do not rely on manual toggle as the normal path

## 9.2 Controlled category plus flexible tags

For skills and workflows:

- primary taxonomy should be controlled
- tags can remain flexible

This supports search, governance, recommendation, and consistent display.

## 9.3 Default vs advanced split

Every creation and execution screen should respect the same rule:

- default state shows only the minimum necessary inputs
- advanced settings are collapsible
- internal artifacts and low-level controls are not default-first UX

## 10. Frontend Refactor Landing Zones

The current work should focus on these frontend areas first:

1. main Agent layout and composer structure
2. lightweight model switch component
3. skill entry split: define vs import
4. full skill-definition wizard
5. workflow entry split: document vs definition import
6. language default and advanced-setting cleanup

## 11. Acceptance Criteria

### Main Agent workspace

- the user can identify the page as a task-start surface at first glance
- the main composer is bottom-centered and full-width
- model switching is quick and lightweight
- image generation no longer consumes a dedicated heavyweight side form by default

### Skill creation

- the user can distinguish new-skill definition from existing-skill import
- `从草稿开始` becomes a real definition wizard, not a thin metadata stub
- type, input/output, runtime, category, and test structure are explicit

### Workflow creation

- document-to-workflow is the default user path
- `loop.json` is preserved only as an advanced import route
- design state, runnable state, and result state are visibly distinct

### Model selector

- it behaves like a quick switch, not a page section
- frontend does not expose provider-specific request formats
- backend can route by `modelProfileId` directly

## 12. Recommended Implementation Order

1. restructure the main Agent workspace information architecture
2. reduce model selection into a lightweight shared component
3. split skill creation into define vs import
4. build the new-skill definition wizard
5. split workflow creation into document vs definition import
6. unify language default and advanced-setting behavior

This order matters because the main Agent workspace is the primary product entry point. If that
mental model remains wrong, secondary flow improvements will still feel inconsistent.

## 13. Review Boundary

This document defines product and frontend restructuring direction only.

It does not by itself:

- approve code changes
- replace architecture authority
- change backend execution truth
- redefine security, versioning, or release gates

Any implementation must still respect:

- the product API boundary
- model routing ownership in the backend
- current architecture constraints
- current approved dependency direction
