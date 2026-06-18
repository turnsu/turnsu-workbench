# Vertical Blocks + Loop Workbench Prototype Spec

- Date: 2026-06-18
- Status: active
- Product direction: Blocks Workbench

## 1. Design Intent

The UI should feel like a quiet native macOS workbench for running vertical agent loops.

It should not feel like:

- a crypto trading cockpit.
- a source browser.
- a terminal wrapper.
- a generic agent chat shell.
- an internal ops console.

The design read is:

```text
Domain Blocks -> Loop Templates -> Run / Review / Follow-up
```

## 2. Prototype Set

### 2.1 Block Rail Workbench

Recommended direction.

Structure:

- left Block Rail with Crypto, Markets, Office.
- active loop list under blocks.
- main result canvas for selected run.
- bottom Loop Composer.

Why this wins:

- It keeps the product simple.
- It makes vertical domain intent visible.
- It supports both quick tasks and long loops.
- It does not expose source/provider/tool internals.

Files:

- `prototypes/2026-06-18-block-rail-workbench.svg`
- `prototypes/2026-06-18-block-rail-workbench-1280.svg`

### 2.2 Loop Board Workbench

Alternative.

Structure:

- top block switcher.
- central loop board grouped by Running / Review / Completed.
- side result preview.
- bottom quick composer.

Best for:

- many parallel loops.
- frequent review batching.

Risk:

- can drift toward a kanban dashboard and reduce focus on the current answer.

File:

- `prototypes/2026-06-18-loop-board-workbench.svg`

### 2.3 Focused Run Workbench

Alternative.

Structure:

- compact block launcher.
- large current run canvas.
- right task-local review strip.
- composer anchored to the selected run.

Best for:

- long research.
- long office drafts.

Risk:

- less efficient for quickly launching several vertical loops.

File:

- `prototypes/2026-06-18-focused-run-workbench.svg`

## 3. State Coverage

The active direction must cover:

- empty blocks.
- running loop.
- blocked loop.
- review-ready loop.
- completed loop.
- long Chinese prompt title.
- Crypto result with CMC returned content.
- Markets draft with evidence gaps.
- Office draft with Cloud ASR status.
- dark and light modes.
- 1024, 1280, 1440, and 1700pt+ widths.

## 4. Implementation Boundaries

Swift implementation should:

- use system font.
- remain light-first with dark parity.
- use solid surfaces and hairline separators.
- keep Block Rail and Result Canvas adaptive.
- avoid nested cards and decorative glows.
- show loop templates, not raw skills.
- keep task details in sheets.

Swift implementation must not:

- reintroduce global Inspector.
- reintroduce source browser as a main surface.
- show raw provider/tool/internal IDs.
- reconstruct final answers outside `AgentFinalReadModel.finalText`.
- add backend API or runtime contract changes.

## 5. Current Selection

Selected implementation direction: `Block Rail Workbench`.

Command Desk v2 is retained as historical baseline and compatibility code only.
