# LoopOps Product Design Review

- Date: 2026-06-22
- Status: superseded product design audit and previous prototype baseline
- Scope: desktop App / macOS UX only
- Reference: current Blocks Workbench implementation, current PRODUCT / DESIGN docs, and user-described `loops.elorm.xyz` loop sharing model

## 0. Superseded By

This review remains useful as the first LoopOps product audit, but it is no longer the active direction. It is superseded by:

- `wiki/prd/2026-06-22-loopops-v2-product-prd.md`
- `wiki/architecture/2026-06-22-loopops-v2-interaction-architecture.md`
- `domains/frontend/documents/design/2026-06-22-loopops-v2-prototype-spec.md`

The key v2 change is the addition of a scoped Chat Control Layer. Chat is used to start loops, follow up on runs, generate loop drafts, and support review, while the product remains structured around Loop Contract, Run Ledger, Review Packet, and Share-safe Log.

## 1. Brief

The current looloomi App should evolve from a static Blocks Workbench into a **LoopOps workbench**:

```text
User assembles logs / loops / skills -> saves a runnable Loop -> runs it from GUI -> watches stable background execution -> reviews output -> continues or shares the log.
```

The user mental model is not "open a dashboard" or "chat with an agent". It is closer to:

- I have vertical work needs: crypto market loops, markets research, office writing and meeting summaries.
- I want to compose a repeatable workflow from logs, prompts, skills and review gates.
- I want those workflows to run in the background reliably.
- I want one-click GUI launch for saved loops.
- I want a clean log/replay/share surface for results.
- I do not want to see raw MCP tools, providers, normalizers, artifact paths, or runtime plumbing.

`loops.elorm.xyz` could not be fetched in this environment because local network access is routed through an unavailable proxy at `127.0.0.1:7890`. This review therefore uses the product pattern described by the user: public/shareable loops, logs, steps, and reusable loop definitions. It does not claim page-specific visual details from that site.

## 2. Current App Diagnosis

### What works

- The App has a clear active direction: `Workbench / History / Settings`.
- `Crypto / Markets / Office` are the right vertical domains.
- `Loop Templates` are a good first abstraction over MCP and skills.
- `AgentFinalReadModel.finalText` as the only final-answer source is the correct authority model.
- Task-local detail sheets are better than a permanent Inspector.

### What still feels like a demo

- **Blocks are static shortcuts, not user-owned loops.** The user cannot assemble, name, version, save, duplicate, or schedule a loop from the UI.
- **Active Loops is actually a task list.** It mixes completed, active, review and failed tasks under one label, so the operational meaning is weak.
- **Composer is still too prompt-centric.** It fills a prompt and selected skills, but does not visibly show trigger, input log source, skill chain, review gate, and exit condition as first-class loop parts.
- **Result Canvas is mostly markdown rendering.** Crypto, Markets and Office need domain-native result components, but the product should not over-fragment into dozens of raw render blocks.
- **History is not yet a loop log system.** It lists results and drafts, but does not make replay, fork, clone, share, compare and audit trail obvious.
- **Settings owns too much operational ambiguity.** Background runners, provider health and loop reliability should be visible as loop-level status first, with Settings only for global diagnostics.
- **Legacy UI concepts still leak into implementation.** `CommandDesk*`, `AgentWorkspaceV2`, and `RuntimeRightInspectorView` are mostly not default UI, but they keep the team thinking in old surfaces.

## 3. Product Reframe

Rename the active product concept from "Blocks Workbench" to **LoopOps Workbench**.

This does not require exposing internals. The UI hierarchy should be:

```text
Domain
  -> Loop
    -> Inputs / logs
    -> Skill chain
    -> Trigger
    -> Feedback gate
    -> Exit condition
    -> Run state
    -> Review output
    -> Shareable log
```

The key shift is that a loop becomes a durable user-facing object, not just a static template row.

## 4. Proposed Information Architecture

### Global navigation

Keep three top-level areas:

- **Workbench**: run and review loops.
- **Library**: saved loops, shared logs, reusable prompts and output records.
- **Settings**: accounts, providers, privacy, background execution, retention and diagnostics.

If the current app must keep `History`, it should visually become `Library` later. "History" is too passive for a product whose value is reuse, replay and share.

### Workbench

Workbench should have four visible zones:

1. **Loop Rail**
   - Domain filter: Crypto, Markets, Office.
   - Saved loops.
   - Running loops.
   - Review-needed loops.

2. **Loop Builder / Runner**
   - Selected loop name and description.
   - Trigger and input logs.
   - Skill chain as user-facing steps, not raw tools.
   - Feedback gate and exit condition.
   - Run button, pause/cancel, duplicate, schedule.

3. **Run Console**
   - Compact timeline: queued, collecting inputs, calling skill package, drafting, guard/review, completed.
   - Not a terminal log.
   - Shows progress and blockers in human language.

4. **Review Output**
   - One final answer.
   - Domain-native summary.
   - Evidence gaps.
   - Review actions: approve, ask follow-up, fork loop, share log.

### Library

Library should be split into:

- **My Loops**: saved runnable loop definitions.
- **Run Logs**: completed run logs and replayable outputs.
- **Shared**: imported public/shared loops, cloned logs, team templates.

The reference idea from loop-sharing products is important: users should be able to inspect a successful loop, understand how it works, clone it, and run it with their own sources.

## 5. Required Product Objects

### Loop Definition

User-facing fields:

- name
- domain
- goal
- trigger
- input log sources
- skill packages
- step summary
- feedback gate
- exit condition
- review boundary
- output shape
- schedule / manual run mode

Do not expose:

- raw MCP tool name
- provider id
- internal artifact path
- normalizer
- worker
- secret / token / raw payload

### Run Log

User-facing fields:

- run status
- started / completed time
- inputs used
- step timeline
- final answer
- evidence gaps
- review decision
- share / clone / replay metadata

### Skill Package

Skill packages should appear as readable capabilities:

- CMC Skill Hub
- Markets Research
- Office / Meeting
- Cloud ASR
- Feishu Preview
- WeChat Context

They should not be flat buttons. They should be selected inside loop composition, then summarized as the loop's skill chain.

## 6. UX Problems To Fix

1. **The main question is unclear.**
   The current screen asks "which block?" but the user question is "what loop do I want to run or improve?"

2. **Loop ownership is missing.**
   Users need to save, name, clone and manage their own loops. Static templates are not enough.

3. **The background runner is invisible.**
   If loops run reliably in the background, the UI must show runner health per loop: idle, scheduled, running, waiting for review, failed.

4. **Logs are not shareable objects yet.**
   A completed run should produce a clean log: what ran, what sources were used, what it concluded, what was blocked, and how to clone/replay.

5. **Review is a button, not a stage.**
   Human review should be an explicit middle layer between run and delivery: review result, accept/reject claims, fork/follow-up, then share or deliver.

6. **The app still sounds like implementation.**
   Copy such as "skills routed by backend" should become "Skill chain ready" or "Uses CMC + WeChat context".

## 7. Recommended Direction

Use **Prototype A: LoopOps Command Center** as the next product direction.

Why:

- It keeps the Apple-like quiet desktop feel.
- It makes loop definitions the core object.
- It preserves the current Domain Block model without making raw skills visible.
- It supports background running and human review without becoming an ops dashboard.
- It creates a natural path to shareable logs and cloned loops.

## 8. Prototype Files

- `prototypes/loopops-command-center.svg`
- `prototypes/loop-builder-studio.svg`
- `prototypes/shared-loop-log-library.svg`

## 9. Implementation Order

1. Rename the product concept in UI copy from Blocks Workbench to LoopOps Workbench.
2. Convert `Loop Templates` into `Saved Loops` plus `Starter Templates`.
3. Add a Loop Builder sheet for name, goal, trigger, skill chain, gate and exit.
4. Make Active Loops only show live/waiting/review-needed runs; move completed runs to Library.
5. Add Run Log view with replay / clone / share actions.
6. Replace implementation copy with user-facing operational copy.
7. Only after that, improve visual polish and domain-specific result components.

## 10. Design Acceptance Criteria

- A new user can understand in 10 seconds that the app runs reusable loops.
- The user can start from a starter loop or a saved loop.
- A saved loop shows its inputs, skills, trigger, feedback gate and exit condition.
- A running loop shows stable background state without terminal logs.
- A completed run is reviewable, cloneable and shareable.
- Internal tools and providers remain hidden.
- Crypto / Markets / Office remain visible domains, not top-level separate apps.
