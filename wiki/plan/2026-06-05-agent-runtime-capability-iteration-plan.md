# Agent Runtime Capability Iteration Plan

- Date: 2026-06-05
- Scope: Agent Runtime Host architecture, dynamic planner, multi-step agent loop, Context Plane, long-task state, worker scheduling, QA gate, tool result contracts
- Status: proposed development iteration plan
- Related audits:
  - `wiki/architecture/2026-05-29-agent-runtime-control-plane-comparative-audit.md`
  - `wiki/architecture/2026-05-29-context-plane-comparative-audit.md`
  - `wiki/architecture/2026-05-29-agent-runtime-control-plane-context-plane-implementation-record.md`
  - `wiki/architecture/2026-06-04-backend-agent-production-audit.md`
  - `wiki/architecture/2026-06-05-agent-output-gates-and-frontend-coupling-audit.md`

## 0. Executive Summary

The next product breakthrough should focus on the Agent side, not on adding more frontend buttons.

The current system already has a local Agent Runtime Host, public Skill/Extension surface, Control Plane artifacts, Context Plane artifacts, tool execution records, output guard, final read model, and local runtime stores. This is enough for auditable single-run research tasks.

It is not yet enough for complex or long-tail tasks. The main gap is that the current runtime is still mostly:

```text
classify task -> build static control/context artifacts -> run selected tools once -> synthesize once -> write final output
```

The target should become:

```text
understand goal
  -> decompose into durable subtasks
  -> retrieve task-specific context
  -> plan next action
  -> execute tool/worker
  -> observe structured result
  -> revise plan
  -> checkpoint
  -> continue / pause / resume / branch
  -> validate evidence and final answer
```

This plan proposes six increments. Each increment must keep the existing public frontend rule: users select Skill/Extension; raw tools, providers, worker internals, and private artifacts remain internal/debug surfaces.

## 1. Current Capability Baseline

### App Layer

Current app strengths:

- Swift app is mostly a read-model and interaction layer.
- Agent workspace consumes daemon sessions, SSE events, run manifest, summaries, tool calls, and final read model.
- User-facing surface remains Skill/Extension/Template.
- The final answer path has started to converge on `AgentFinalReadModel`.

Current app risks:

- `DashboardViewModel` still combines product runtime, Agent session state, selection state, filters, ops status, and Agent workspace composition.
- Agent debug information is available, but not yet organized as a coherent task timeline for long-running work.
- There is no product-level long-task board that shows subtask tree, blocked/resumable steps, branch state, and evidence completeness.

### Agent Runtime Layer

Current Agent strengths:

- `agent-runtime/bin/wechat-agent-daemon.mjs` can run sync/async tasks and stream events.
- `agent-runtime/control-plane/` writes task intent, execution profile, planner envelope, tool intent plan, policy, approval, model route, QA, metrics, checkpoint, and retry ledger artifacts.
- `context-plane.mjs` creates bounded context sources, chunks, retrieval plan, context bundle, and context gate.
- Tool calls are recorded and redacted.
- CMC output gates now distinguish transport success from usable evidence.
- `AgentFinalReadModel` provides a single final-output read model.

Current Agent limits:

- Planner is deterministic metadata, not dynamic planning.
- Tool selection is still mostly prompt/skill heuristic.
- Tool results do not drive iterative replanning.
- Context Plane summarizes local artifacts; it does not perform semantic retrieval, ranking, or cross-run compression.
- Checkpoint records state but is not a resumable execution state machine.
- Worker policy is recorded but not used for production worker scheduling.
- QA gate mostly checks boundaries/artifact presence; it does not strongly grade answer quality, evidence density, or task completion.

### Data Management Layer

Current data strengths:

- Local runtime artifacts are auditable and file-addressable.
- Product stores exist for messages, market snapshots, crystals, proposals, memory, handoffs, tasks, watchlist, ops, and Agent runs.
- Agent run artifacts can be inspected after completion.

Current data limits:

- Runtime artifacts do not yet form a durable task graph.
- Cross-run memory lacks ranking, decay, compression, and source trust scoring.
- There is no first-class branch/retry lineage for long-tail tasks.
- Tool result schemas are inconsistent across tools.

## 2. Target Architecture

### 2.1 Dynamic Planner

Replace the current static planner envelope with a planner that owns:

- task decomposition;
- subtask dependencies;
- next-action selection;
- stop conditions;
- evidence requirements;
- tool result expectations;
- replan triggers.

Target artifacts:

```text
planner-state.json
task-graph.json
subtasks/{subtaskID}.json
plan-revisions.ndjson
```

Minimum planner state:

```text
schemaVersion
runID
taskID
planID
goal
currentStepID
subtasks[]
dependencies[]
nextActions[]
evidenceRequirements[]
blockedReasons[]
revisionCount
status
createdAt
updatedAt
```

The planner should not be a one-shot prompt. It should be called before each action and after each observation.

### 2.2 Multi-Step Agent Loop

Introduce an internal loop:

```text
plan -> act -> observe -> evaluate -> replan -> checkpoint
```

Loop rules:

- Every action must be tied to a `subtaskID`.
- Every tool call must declare expected result contract before execution.
- Every observation must be normalized before it enters planner context.
- Planner can continue, pause, branch, retry, or finish.
- Final output is allowed only after required evidence is satisfied or explicitly marked missing.

Target artifacts:

```text
agent-loop.ndjson
observations/{observationID}.json
step-results/{stepID}.json
planner-decisions.ndjson
```

### 2.3 Stronger Context Plane

Upgrade Context Plane from artifact summaries to retrieval and memory infrastructure.

Required capabilities:

- source extraction by domain type;
- chunking with stable IDs;
- semantic retrieval index;
- recency/freshness scoring;
- source trust scoring;
- cross-run memory compression;
- task-specific context pack;
- evidence-specific context chunks for CMC, WeChat, token, onchain, proposal, memory, handoff.

Target artifacts:

```text
context-index.json
context-chunks/{chunkID}.json
retrieval-results.json
context-pack.json
memory-compression.json
source-trust-report.json
```

Context Plane should emit not only "what was included", but also "what was excluded and why".

### 2.4 Durable Long-Task State Machine

Checkpoint must become executable state, not just a record.

Long task states:

```text
created
planning
running
waiting_for_input
waiting_for_tool
blocked
paused
resumable
branching
completed
failed
cancelled
```

Required operations:

- pause;
- resume from latest valid checkpoint;
- retry failed step;
- branch from a prior step;
- mark input missing;
- mark evidence insufficient;
- discard unsafe product mutations;
- finalize.

Target artifacts:

```text
long-task-state.json
checkpoints/{checkpointID}.json
resume-plan.json
branch-lineage.json
failure-report.json
```

### 2.5 Worker Scheduling

Move from recorded worker policy to actual internal worker execution.

Worker types:

- context worker;
- market evidence worker;
- WeChat/message evidence worker;
- onchain worker;
- synthesis worker;
- QA worker;
- product mutation worker.

Scheduling rules:

- sequential by default;
- bounded parallelism only for independent read-only workers;
- no parallel writes to the same artifact path;
- worker output must normalize into observation contracts;
- failed worker must produce retryable failure artifact.

### 2.6 Strong QA Gate

Upgrade QA from boundary checking to task-quality enforcement.

QA dimensions:

- required evidence coverage;
- source freshness;
- tool result contract satisfaction;
- unsupported claim detection;
- final answer structure;
- risk boundary;
- user goal completion;
- mutation safety;
- missing input disclosure.

Final output should be blocked or downgraded if QA fails.

## 3. Development Increments

### Phase 1: Planner State and Agent Loop Skeleton

Goal:

- Make planning stateful and iterative without changing the public UI.

Backend changes:

- Add `planner-state.json`, `task-graph.json`, and `agent-loop.ndjson`.
- Split planner into:
  - task decomposition;
  - next-action selection;
  - replan after observation.
- Keep existing `planner-envelope.json` as compatibility summary.
- Add `subtaskID` to tool calls and observations.

Acceptance:

- A run with a market research prompt produces at least 2 subtasks.
- Tool calls are associated with subtasks.
- A tool result can update planner state before final synthesis.
- Existing single-turn smoke still passes.

### Phase 2: Tool Result Contracts

Goal:

- Make all tool results gateable like the new CMC empty-evidence path.

Backend changes:

- Define a common tool result envelope:

```text
transportStatus
resultStatus
usableEvidenceStatus
emptyResultReason
sourceAttribution
missingInputs
confidence
artifactPath
mutationAllowed
```

- Apply the envelope to:
  - CMC tools;
  - WeChat import/read tools;
  - token/entity tools;
  - onchain snapshot tools;
  - memory/handoff/proposal tools.

Acceptance:

- Transport success never implies usable evidence.
- Empty result blocks final claims and product mutations.
- Tool observations can be compared across tool families.

### Phase 3: Retrieval Context Plane

Goal:

- Make context selection task-specific, not generic artifact summary.

Backend/data changes:

- Add chunk store and retrieval index.
- Add source-specific chunkers:
  - CMC evidence chunker;
  - WeChat message chunker;
  - market snapshot chunker;
  - memory/proposal/handoff chunker.
- Add retrieval scoring:
  - semantic match;
  - recency;
  - source trust;
  - user-selected priority;
  - task type fit.

Acceptance:

- Context bundle cites selected chunk IDs and excluded chunk IDs.
- Prompt receives top task-relevant chunks, not only JSON key summaries.
- Missing or stale context is visible in `context-gate.json`.

### Phase 4: Durable Long-Task Resume

Goal:

- Support complex tasks across time, interruption, and partial progress.

Backend changes:

- Add `long-task-state.json`.
- Add resumable checkpoint format.
- Add resume endpoint or command path behind existing Agent control actions.
- Persist current step, completed subtasks, pending subtasks, failed subtasks, and blocked reasons.
- Convert pause/resume from UI state into runtime state transitions.

Acceptance:

- A run can pause after a completed subtask.
- Resume continues from the next unfinished subtask, not from the beginning.
- Failed tool step can be retried without duplicating completed steps.
- Branching creates lineage instead of overwriting prior state.

### Phase 5: Worker Scheduler

Goal:

- Execute independent read-only work in bounded workers while keeping write safety.

Backend changes:

- Add worker registry.
- Add worker queue and worker result artifacts.
- Allow bounded parallel execution for independent read-only subtasks.
- Serialize writes to product mutations and final read model.

Acceptance:

- Market evidence and context retrieval can run independently.
- Worker failures produce retryable artifacts.
- Runtime metrics show worker duration, status, and output artifact.

### Phase 6: QA Gate and Product Mutation Safety

Goal:

- Make final output and product mutations depend on evidence quality.

Backend changes:

- QA gate evaluates:
  - evidence coverage;
  - required subtasks completed;
  - unsupported claims;
  - stale inputs;
  - mutation safety.
- Product mutations are only importable when:
  - required evidence is usable;
  - output guard passed or downgraded safely;
  - QA gate allows mutation.

Acceptance:

- Final output can be `passed`, `degraded`, or `blocked`.
- Product mutation policy is `importable`, `discarded`, or `requires_review`.
- Evidence-insufficient runs cannot mutate terminal stores.

## 4. App Work Required

App should not expose the internal complexity as more buttons.

Required UI/read-model changes:

- Add long-task timeline view:
  - current step;
  - completed subtasks;
  - blocked subtasks;
  - missing inputs;
  - resume point.
- Add compact evidence health:
  - evidence usable;
  - evidence empty;
  - context stale;
  - QA degraded;
  - mutations discarded.
- Keep Skill/Extension selection unchanged.
- Keep internal tools in inspector/debug only.

Avoid:

- exposing raw worker list as user controls;
- letting users manually pick internal tools;
- mixing stream deltas with final read model;
- importing product mutations before QA.

## 5. Data Work Required

Data layer should evolve from "many JSON files" to "typed task/event state".

Required stores:

- task graph store;
- subtask store;
- observation store;
- context chunk store;
- retrieval index store;
- checkpoint store;
- branch lineage store;
- worker result store;
- QA result store.

Retention rules:

- run artifacts remain immutable after completion;
- resume/branch creates new state records, not in-place overwrite;
- memory compression writes derived records with source references;
- product mutations must link to evidence and QA approval.

## 6. Milestones

### Milestone A: Dynamic Planner MVP

Deliver:

- planner state;
- task graph;
- loop log;
- subtask-bound tool calls.

Done when:

- one complex prompt produces subtasks and at least one replan event.

### Milestone B: Tool Contract Standardization

Deliver:

- common tool result envelope;
- CMC, WeChat, token, onchain adapters emit the envelope.

Done when:

- empty evidence behavior is consistent across tool families.

### Milestone C: Retrieval Context Plane

Deliver:

- chunk store;
- retrieval scoring;
- context pack.

Done when:

- context pack includes task-specific chunks and exclusion reasons.

### Milestone D: Durable Long Task

Deliver:

- long-task-state;
- resumable checkpoint;
- retry/branch records.

Done when:

- a task can pause and resume without rerunning completed subtasks.

### Milestone E: Worker + QA

Deliver:

- bounded worker scheduler;
- QA quality gate;
- mutation safety gate.

Done when:

- final output and product mutations are blocked/degraded when evidence is insufficient.

## 7. Testing Strategy

Backend tests:

- dynamic planner decomposes a macro market prompt into subtasks;
- tool result updates planner state;
- empty tool result blocks final claims;
- resume continues from checkpoint;
- branch preserves lineage;
- worker failure can be retried;
- QA blocks unsupported final claims.

Context tests:

- retrieval returns relevant chunks for CMC macro task;
- stale context is excluded or marked degraded;
- memory compression preserves source references;
- selected user context outranks generic runtime context.

Swift tests:

- long-task timeline renders subtask states;
- final read model remains the only final answer source;
- mutation discarded status does not alter terminal data;
- inspector shows evidence/context/QA diagnostics without exposing raw tools.

Smoke tests:

- existing daemon smoke remains pass;
- async run still streams terminal events;
- paused task can resume;
- cancelled task cannot mutate product stores.

## 8. Priority Recommendation

Recommended implementation order:

1. Dynamic planner state and loop log.
2. Standard tool result contract.
3. Durable long-task state.
4. Retrieval Context Plane.
5. Worker scheduler.
6. Strong QA gate.

Reason:

- Dynamic planner and tool contracts create the control backbone.
- Durable state makes long-tail tasks possible.
- Retrieval and worker scheduling become much easier once subtasks and observations are first-class.
- QA should be strengthened after the runtime has typed evidence and task completion state.

## 9. Non-Goals

This iteration should not:

- expose internal tools as frontend buttons;
- add trading/send/publish execution;
- bypass policy gates for convenience;
- make Swift call MCP or model providers directly;
- treat planner artifacts as user-facing chat content;
- store API keys or raw private transcripts in artifacts.

## 10. Success Definition

The Agent architecture is improved when the following are all true:

- Complex prompt produces durable subtasks.
- Tool execution is selected by planner state, not only prompt heuristics.
- Tool observations can trigger replan.
- Context bundle is retrieved and ranked, not only summarized.
- Long task can pause/resume/retry/branch.
- QA can block unsupported final output.
- Product mutations require evidence and QA permission.
- Swift shows a coherent task timeline without exposing internal runtime machinery.
