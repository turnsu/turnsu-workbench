# Loop Authoring, Orchestration, and Runtime PRD

- Date: 2026-07-10
- Status: target product requirements
- Parent: [Skill & Loop Cloud Workbench Master PRD](2026-07-10-skill-loop-cloud-workbench-master-prd.md)

## 1. Goal

Let a user turn a recurring goal into a readable, executable, versioned Loop by combining an
explicit goal contract with pinned Skill steps, input/output mappings, review gates, and
verification.

The Loop must remain understandable without opening the canvas, and executable without asking
an Agent to guess the intended order.

## 2. Why a Loop Is More Than a Workflow Graph

A graph answers “what runs before what.” It does not reliably answer:

- why the work exists;
- which context is authoritative;
- what must not change;
- what completion means;
- how the result is verified;
- when the Agent must stop and ask for help.

A `/goal`-style contract answers those questions but does not define exact Skill versions,
data mappings, review gates, or executable dependencies. Looloomi combines both forms in one
versioned object.

## 3. Loop Definition

A `Loop` contains four coordinated layers:

1. **Loop contract**: human-readable intent and acceptance rules.
2. **Execution graph**: deterministic node order and data flow.
3. **Run interface**: generated input form, connections, review policy, and outputs.
4. **Lifecycle metadata**: ownership, visibility, versions, validation, Runs, and provenance.

### 3.1 Loop Contract

The contract uses these required sections:

| Section | Product question |
|---|---|
| Goal | What single repeatable outcome should this Loop produce? |
| Context | Which inputs, references, examples, and business rules must be read first? |
| Constraints | What must not change, what actions are forbidden, and which safety boundaries apply? |
| Done when | What observable conditions mean this Run is complete? |
| Verify | Which checks, evidence, review, or comparison proves completion? |
| Output | What must be returned, in which format, with which evidence and remaining risk? |
| Stop rules | When must execution pause instead of guessing or causing an unsafe action? |

The product presents these as guided fields with examples. Advanced users may edit a
`LOOP.md` representation. Missing or vague contract sections produce warnings or blocking
diagnostics based on policy and risk.

### 3.2 Execution Graph

V1 node kinds:

| Node | Purpose |
|---|---|
| Start | Collect and validate Run inputs. |
| Skill | Execute one pinned Skill version. |
| Material | Resolve a bounded reference or uploaded resource. |
| Transform | Apply a declared mapping or bounded transformation. |
| Condition | Choose a declared branch from structured values. |
| Review | Pause for an explicit person or policy decision. |
| Result | Assemble one or more user-facing outputs. |

The current backend `Input`, `Skill`, `Material`, `Transform`, `ReviewGate`, and `Output`
types may remain internal. Product labels use the human terms above.

V1 graphs are acyclic. “Loop” means the process can be run repeatedly. Scheduled Runs and
explicit iteration constructs require a later execution contract; users cannot create cycles
by connecting a downstream node back to an upstream node.

### 3.3 Step Definition

Every executable step includes:

- step ID, title, purpose, and position;
- pinned Skill ID and version where applicable;
- required inputs and where each value comes from;
- created outputs and which later step receives them;
- step-specific instructions;
- allowed tools, connections, network, files, and external actions inherited from the Skill;
- timeout, retry, and failure behavior;
- optional condition;
- review requirement;
- example input/output preview;
- compile and last-test status.

Canvas coordinates never determine execution order. Saved edges and bindings remain the
execution authority.

## 4. Portable Loop Package

Upload and export use a portable folder or `.zip`:

```text
loop-name/
├── LOOP.md
├── workflow.json
├── tests/
└── assets/            # optional non-secret examples or output templates
```

`LOOP.md` contains the readable contract. `workflow.json` contains the versioned graph,
input definitions, output definitions, and pinned Skill requirements. Product metadata such
as owner, workspace, visibility, audit, and connection bindings remains outside the package.

An upload creates a draft. The import preview shows missing Skills, unavailable versions,
required connections, invalid mappings, package provenance, and any unsafe embedded content.
It never silently substitutes another Skill version.

## 5. Creation Entry Points

### 5.1 Describe a Goal

The user describes the recurring work in natural language. The assistant proposes:

- a draft Loop contract;
- suggested inputs and outputs;
- candidate Skills from installed and Team libraries;
- an ordered outline;
- a graph proposal;
- missing information and risk questions.

The user reviews the proposal before it becomes the editable draft.

### 5.2 Start Blank

Start with the Loop contract and an empty graph. The product guides the user through Goal,
Inputs, Steps, Result, and Verification without requiring canvas knowledge.

### 5.3 Use a Template

A template is a published Loop version marked as a starting point. `Use template` creates a
new Loop identity and draft, preserves provenance, and shows which Skills and connections
must be installed. The source template is never edited or run in place.

### 5.4 Duplicate or Fork

- Duplicate within the same workspace preserves ownership context and creates a new Loop.
- Fork from the Team library creates a new lineage and records the source version.
- Install keeps the original Loop identity read-only and allows Runs when policy permits.

### 5.5 Upload

Upload a valid portable Loop package. The product parses the contract and graph, validates
dependencies, and creates a draft with unresolved items clearly listed.

## 6. Builder Experience

The Builder offers three synchronized views of the same draft:

### 6.1 Definition

Guided contract fields for Goal, Context, Constraints, Done when, Verify, Output, and Stop
rules. This is the default starting view for a new Loop.

### 6.2 Outline

A compact ordered list of steps showing Skill, input source, created output, review, and
blocked reason. It is the fastest mode for reading and reordering a simple Loop.

### 6.3 Canvas

The visual graph shows branches, mappings, dependencies, and review gates. It supports add,
drag, move, connect, reconnect, delete, zoom, fit, minimap, and keyboard selection. The canvas
is not the only way to understand or edit a Loop.

All three views write to one editor draft. A change in one view appears immediately in the
others. Saving creates one immutable Loop version, not separate definition and graph versions.

## 7. Skill Selection and Composition

The Skill picker prioritizes outcome and compatibility:

- search by what the Skill helps accomplish;
- filter by installed/team, readiness, input, output, owner, risk, and connection;
- show whether current upstream outputs satisfy required inputs;
- preview the exact version to be pinned;
- explain missing setup before adding;
- allow install and add as one explicit multi-step flow when authorized.

Adding a Skill creates a selected step, proposes compatible mappings, and reveals the new
step in the viewport. It does not stage a chat proposal or modify unrelated steps.

## 8. Agent-Assisted Changes

The Builder assistant returns a typed `LoopChangeProposal` containing:

- base Loop version/draft revision;
- user request;
- human-readable summary;
- added, changed, removed, and reconnected steps;
- Skill version changes;
- contract section changes;
- permission and connection impact;
- compile result on a temporary copy;
- warnings and unresolved choices.

The user can inspect, apply, or discard the proposal. Applying checks the base revision,
updates the draft transactionally, and recompiles. The assistant cannot publish, set readiness,
start a Run, bypass review, or resolve a version conflict by itself.

## 9. Compile and Preflight

The Product Backend is the only readiness authority. Compile validates:

- required Loop contract sections;
- supported node kinds;
- acyclic and reachable graph;
- real nodes, ports, and bindings;
- input/output schema compatibility;
- exact Skill versions and runtime availability;
- installed dependencies and workspace connections;
- Resource readiness;
- review and external-action policy;
- Result reachability and output format;
- timeout and retry limits;
- permissions allowed by the workspace.

Results are:

- `Ready`: safe to test or run with required inputs.
- `Needs setup`: valid structure but missing Skill, connection, material, permission, or input.
- `Fix required`: invalid contract or graph.

Each issue identifies the affected contract section or step, explains it in product language,
and provides one recovery action.

## 10. Test Run and Publish

Before publication, a user can run the draft in test mode:

- side effects are disabled or require explicit test authorization;
- exact draft content and Skill versions are captured;
- node timeline and structured outputs are visible;
- review gates behave exactly as production policy requires;
- Done-when and Verify checks are evaluated and shown separately;
- final output, evidence gaps, failures, cost, and duration are attached to the test.

Publish requires:

- successful compile for the current content hash;
- at least one passing test unless workspace policy grants an exception;
- no unresolved blocking diagnostic;
- change and dependency review;
- required maintainer approval for team-visible or high-risk Loops.

Published Loop versions are immutable. Editing creates a new draft.

## 11. Run Experience

### 11.1 Before Run

Show:

- Loop version and owner;
- generated input form;
- pinned Skill versions;
- required connections and materials;
- external actions;
- review gates and expected approvers;
- expected outputs and verification;
- estimated limits where available.

### 11.2 During Run

Show product-safe states:

- queued, running, waiting for review, completed, failed, cancelled;
- current step and completed step summaries;
- structured progress where the Skill supports it;
- reconnect status without losing confirmed events;
- pause/cancel only when the backend supports them.

Raw provider streams, internal tool names, prompts, tokens, artifact paths, and secrets remain
hidden.

### 11.3 Review

A Review step presents the candidate output, evidence, missing information, requested decision,
and downstream impact. The reviewer can approve, request changes, or reject. Requested changes
must become real input to the configured revision step, not merely an audit note.

### 11.4 After Run

Show:

- authoritative final result;
- whether Done-when and Verify checks passed;
- evidence and gaps;
- review decisions;
- step timeline, attempts, and safe error summaries;
- exact Loop and Skill versions;
- actions to rerun, create a draft from this Run, or compare to another Run.

## 12. Versions, Dependencies, and Updates

- Every saved/published Loop version has a content hash and immutable graph/contract.
- Runs pin one Loop version and all transitive Skill versions.
- A Skill update never changes a published Loop version.
- The impact screen shows affected steps, schema changes, permission changes, and test status.
- Updating a Skill dependency creates a Loop draft and requires compile/test before publish.
- Version diff covers contract, graph, mappings, policies, Skills, and outputs.
- Rollback means republishing or selecting a prior immutable version; history is never rewritten.

## 13. Backend Requirements

Required capabilities:

- generic Loop create, update metadata, duplicate/fork, archive, and draft lifecycle;
- optimistic draft revision and immutable version save;
- package import/export and provenance;
- contract parsing and validation;
- graph compile and execution plan;
- structured change proposal generation and apply;
- test Runs and production Runs;
- Run events, review decisions, cancellation, retry, crash recovery, and rerun;
- version diff and dependency impact;
- workspace publication and authorization;
- audit and product-safe errors.

The current Workflow repository and Runner remain the foundation. Do not create parallel
Loop and Workflow persistence. Public v1 `/workflows` endpoints may remain as a compatibility
surface while the Web uses Loop language.

## 14. Agent Requirements

- Use the Loop contract as bounded execution context, not as permission to reorder the graph.
- Execute exact pinned Skill versions through the production registry.
- Preserve graph order, Review gates, conditions, and stop rules.
- Evaluate Done-when and Verify with explicit evidence; do not self-certify vague completion.
- Return typed change proposals rather than editing the saved Loop.
- Carry requested review changes into a new step attempt.
- Produce one authoritative final read model containing result, evidence, gaps, checks, and
  follow-up actions.
- Support checkpoint, cancellation, idempotent retry, and restart recovery.

## 15. Acceptance Criteria

A fresh workspace can:

1. create a Loop from a plain-language goal;
2. create a blank Loop and complete all contract sections;
3. use a template and receive a separate draft;
4. upload a Loop package and resolve missing dependencies;
5. add two real Skills, map outputs to inputs, and insert a Review step;
6. make equivalent edits through Definition, Outline, and Canvas views;
7. receive a structured assistant proposal and reject it without draft changes;
8. apply a valid proposal and observe a new compile result;
9. block an invalid cycle, missing Skill, incompatible mapping, or forbidden permission;
10. complete a safe test Run and pass explicit verification;
11. publish an immutable workspace-visible version;
12. let a teammate create a new draft from it;
13. execute a Run with review revision feedback actually applied;
14. reopen, compare, and rerun after a service restart.
