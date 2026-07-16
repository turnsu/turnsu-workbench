# Pi Agent Execution Platform Design

- Date: 2026-07-16
- Status: approved design; not yet implemented
- Scope: Product Agent topology, Module Agent sessions, execution workers, context, memory,
  permissions, recovery, observability, and community Pi package adoption
- First feature implementation slice after compatibility preflight: execution contract,
  deterministic Skill runner, and one bounded Pi subprocess/RPC backend

## 1. Executive Decision

The product will present one coherent Agent personality to each user while running multiple
independent Agent sessions and execution workers behind that experience.

The target architecture is a layered Agent Fabric:

```text
Main Agent per user
  -> Module Agent Session per user × workspace × object × branch
  -> Creator Controller or Product WorkflowRunner
  -> shared Execution Broker contract
  -> deterministic Skill Job | bounded Pi Worker | Agent Orchestrator
  -> inline process | subprocess/RPC | sandbox | remote device
```

The product does not have one global control plane. Instead, every durable state domain has one
authority:

- Canonical Object Service owns Skill and Loop drafts, revisions, proposals, and merges.
- Creator Controller owns creation, editing, validation, test initiation, and publish workflows.
- Product WorkflowRunner owns every executable Loop Run created from a compiled, pinned graph
  snapshot, including test Runs and published-version Runs. It owns the fixed outer graph, leases,
  checkpoints, reviews, retries, and final result.
- Execution Broker owns worker lifecycle and transport, but never becomes the authority for Draft
  or Run state.
- Memory Service owns promoted durable memory, but does not own transcripts, product objects, or
  Skills.

`@agwab/pi-workflow` is a candidate execution backend behind the Execution Broker. It must not
replace the existing Product WorkflowRunner or introduce a second authoritative Run state store.

## 2. Motivation and Current-State Evidence

The existing system already contains a durable Product API, Mongo-backed repositories, immutable
revisions, a DAG compiler, and a Workflow Runner with leases, fencing, heartbeats, checkpoints,
attempts, reviews, and recovery. The implemented dependency direction remains:

```text
Web -> Workbench Product API -> Product Store / Workflow Runner
    -> Agent Runtime Core -> PI Kernel -> Skills and tools
```

Authoritative current-state references:

- [`wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md`](../../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
- [`wiki/plan/SKILL_WORKFLOW_LOOP_FIRST_SLICE.md`](../../../wiki/plan/SKILL_WORKFLOW_LOOP_FIRST_SLICE.md)
- [`domains/backend/code/workbench-server/src/runner/workflow-runner.mjs`](../../../domains/backend/code/workbench-server/src/runner/workflow-runner.mjs)
- [`domains/agent/code/agent-runtime/kernels/pi/pi-kernel-adapter.mjs`](../../../domains/agent/code/agent-runtime/kernels/pi/pi-kernel-adapter.mjs)

The gap is the execution plane. The current Pi adapter creates an in-memory session and serializes
Skill invocation around a shared Agent session, including a `pi_skill_session_busy` guard. This
cannot provide independent context, concurrency, fault isolation, or per-execution recovery for
multiple product modules and Loop nodes.

The repository currently pins `@earendil-works/pi-coding-agent` at `0.75.5`. The npm registry
reported `0.80.7` as current during this research on 2026-07-16. The first technical action must
therefore be a compatibility experiment, not an unverified package upgrade inside a wider
refactor.

## 3. Confirmed Product Semantics

### 3.1 Main Agent

Each user has a Main Agent that provides the continuous product personality. It owns cross-module
intent, navigation, personal preferences, and summaries of important progress. It does not own
every module transcript and does not directly become the controller for Creator workflows or
executable Loop Runs.

### 3.2 Module Agent Definition and Session

A Module Agent Definition describes a product role such as Skill Creator or Loop Creator. It pins
the role prompt, allowed Extensions, available Skills, permission template, output contracts, and
UI integration. The definition is shared; runtime sessions are not.

Every collaborator entering the same object receives a different Module Agent Session:

```text
session scope = user × workspace × object × branch
```

The session has its own transcript, context window, personal permission evaluation, connection
handles, and temporary working branch. Two users may operate concurrently against the same Draft
without sharing raw conversation or credentials.

### 3.3 Shared Object Collaboration

Module Agent Sessions never directly overwrite the Canonical Draft. They emit structured
`ChangeProposal` objects against a `baseRevision`.

When the base revision is stale, the service performs a three-way comparison:

- non-overlapping structural changes may rebase automatically;
- semantic or field conflicts require explicit resolution;
- an Agent may prepare a merge suggestion but may not silently override another user's change.

### 3.4 Concurrency

The design combines three levels of concurrency rather than selecting only one:

- one Agent turn inside one session is serialized to preserve transcript causality;
- one turn may launch multiple independent workers concurrently;
- different user sessions, object branches, and Loop Runs may execute concurrently.

New input arriving during an active turn is represented as queue, steer, or cancel. It is not
executed as a second concurrent turn mutating the same Pi session.

## 4. Component Ownership

| Component | Owns | Explicitly does not own |
|---|---|---|
| Main Agent | Per-user product conversation and cross-module intent | Module transcripts and Loop execution state |
| Module Agent Definition | Role prompt, Extensions, Skills, permission template, contracts | User session state |
| Module Agent Session | Object-scoped user conversation and temporary branch | Canonical Draft |
| Canonical Object Service | Drafts, revisions, proposals, three-way merge, audit | Agent execution |
| Creator Controller | Create, edit, validate, initiate test, and publish lifecycle | Execution state of a test or published-version Loop Run |
| Product WorkflowRunner | Fixed outer graph and durable state for every compiled, pinned Loop Run | Creator session and dynamic Agent planning outside a node |
| Execution Broker | Backend selection, worker lifecycle, cancellation, events | Draft and Run authority |
| Worker Backend | One execution attempt and its evidence | Product completion authority and durable memory |
| Memory Service | Promoted, scoped, provenance-bearing durable memory | Session transcript, object version, and Skill package |

## 5. Session, Context, and Memory

### 5.1 Session Types

| Session | Scope and lifecycle |
|---|---|
| `MainAgentSession` | `user × workspace`; persistent personal product conversation |
| `ModuleAgentSession` | `user × workspace × object × branch`; resumable while the object exists |
| `WorkerSession` | `invocation × attempt`; created for one Agentic execution and then closed |
| `SkillJob` | No model session; retains inputs, events, artifacts, and structured result only |

### 5.2 Context Capsule

Sessions do not exchange complete transcripts. Every Agentic execution receives an auditable
Context Capsule with:

```text
goal and local task
pinned Skill / Loop / Object revisions
input and upstream artifact references
allowed Skills, tools, and capability handles
retrieved personal, object, and workspace memory references
budget, deadline, cancellation token, and maximum steps
output schema, evidence requirements, and stop conditions
runId / nodeId / invocationId / parentSessionId
```

The capsule contains references and summaries by default. Raw tool output, unrelated history, and
credentials do not enter the prompt.

### 5.3 Context Window Policy

Context management is not a destructive sliding window. The order of operations is:

1. Reduce large tool output at the source and store the recoverable original as an Artifact.
2. Retrieve only task-relevant personal, object, and workspace memory.
3. Build a temporary Prompt Projection for the current turn.
4. Use Pi native compaction near the context threshold, preserving Goal, Constraints, Progress,
   Decisions, Next Steps, and Artifact anchors.
5. Add request-time pruning only after traces demonstrate repeated context or cache-cost problems.

The raw session event log and artifacts remain outside the model context. Compaction or pruning
may change the prompt projection, but cannot destroy source evidence.

Official Pi already provides Agent sessions, append-only session trees, fork/import operations,
native compaction hooks, context hooks, and a JSONL RPC protocol. These remain the base rather than
being reimplemented:

- [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi compaction](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/compaction.md)
- [Pi RPC](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md)

### 5.4 Handoff

The Main Agent receives a Handoff Capsule only on important transitions:

- proposal created or merged;
- validation or test completed;
- version conflict;
- worker blocked or approval required;
- module exit;
- object publication or Run completion.

The capsule contains status, decisions, artifact references, risks, and next action. The Main Agent
may query details under the current user's permission, but does not import the full Module
transcript.

### 5.5 Durable Memory

The system distinguishes four sources of knowledge:

- Session History: conversation and tool events;
- Object State: Drafts, revisions, proposals, tests, and Runs;
- Durable Memory: cross-session semantic memory;
- Skills: versioned executable procedures.

Module Agents and workers may only emit a `MemoryCandidate`:

```text
tenantId and workspaceId
scope: personal | object | workspace
subjectRef: userId | objectId | workspaceId
content
provenance and evidenceRefs
confidence
sensitivity
ttl or expiresAt
createdBy
```

Verified object facts may be promoted by policy. Other candidates require user or workspace
confirmation. Failed experiments, worker speculation, and unverified external content never
become team memory automatically. Memory may not silently generate and activate a Skill.

## 6. Execution Contract and Worker Modes

### 6.1 Common Contract

All execution backends implement one product-owned contract:

```text
ExecutionRequest
  executionMode
  subjectRef and pinnedVersion
  inputsRef and artifactRefs
  requiredCapabilities
  limits: timeout, budget, maxSteps
  resultSchema and evidenceRequirements
  idempotencyKey and sideEffectPolicy
  traceIds and cancelToken

ExecutionEvent
  invocationId, attemptId, sequence, timestamp
  state, progress, artifactRef, usage, diagnosticClass

ExecutionResult
  status
  structuredOutput
  evidenceRefs and artifactRefs
  usage and sideEffectLedger
  checkpointRef
```

The contract must not expose an AgwaB-specific Run ID, local path, or `.pi/workflows` file as a
product authority.

### 6.2 Deterministic Skill Job

Deterministic transformations, fixed API calls, validators, formatters, and script-backed Skills
run directly in a backend Script/Skill Runner:

```text
input -> pinned Skill executor -> structured result and evidence
```

This path does not start Pi, consume model context, or grant an Agent a general shell. Platform
built-ins may run in a normal backend worker. Published workspace scripts run in a constrained Job
Worker. Newly uploaded or untrusted scripts run only in a sandbox or container.

### 6.3 Bounded Agent Worker

A bounded Agent receives a fixed goal, explicit Skills, a Context Capsule, maximum steps, model and
token budget, output schema, and stop conditions. It may choose the order of allowed Skills or
repeat a safe analysis step, but may not change the outer Loop, extend its permission scope, write
durable memory, or announce that the parent Run is complete.

Background bounded Agent work uses an independent Pi subprocess/RPC by default. A separate
in-process `AgentSession` is allowed only for trusted, read-only, low-cost work where process fault
isolation is not required.

### 6.4 Agent Orchestrator

An Agent Orchestrator may create a dynamic child graph inside its fixed parent node. Every child is
visible as a product invocation/attempt with its own budget, cancellation, artifacts, and status.
The Agent cannot add, delete, or reorder nodes in the pinned outer Loop graph.

If a dynamic plan proves reusable, the Agent may generate a separate proposal for the next Loop
version. Runtime learning never mutates the pinned version of the current Run.

### 6.5 Execution Mode Selection

A Skill declares which modes it supports. The Creator recommends a mode and lets the user adjust
it within the Skill's allowed set. The server compiler fixes and validates the selected mode in the
immutable snapshot used by a test Run or published Loop version. Runtime code may not silently
upgrade a deterministic node into a full Agent.

## 7. Least-Privilege Execution

Skill packages declare capabilities such as:

```text
filesystem: read workspace artifacts
network: api.example.com
connection: github-workspace-handle
externalAction: create_pull_request
```

The Policy Engine evaluates the current user, workspace, object version, execution mode, and review
rules. It issues a short-lived Capability Lease containing only handles required for that
execution. Raw secrets do not enter the Context Capsule or worker environment when an opaque
connection handle can be used.

Hard rules:

- child workers receive only a subset of the parent's capabilities;
- undeclared capabilities cannot be acquired through model reasoning;
- leases are execution-scoped, expiring, and revocable;
- cancellation revokes the lease before or while terminating the worker;
- high-risk external actions may require a just-in-time review gate;
- a permission denial is reported as a distinct product state, not a generic tool failure;
- a process-only fallback is not reported as sandbox isolation.

Third-party Pi packages and Extensions execute with the Pi process's system authority, so packages
must be source-reviewed and contained according to their trust level. Pi's own package guidance
explicitly warns about this boundary: [Pi Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## 8. Run State, Recovery, and Cancellation

### 8.1 Invocation and Attempt

One logical execution has a stable `invocationId`. Each retry or recovery creates a new
`attemptId`:

```text
queued -> leased -> running -> waiting_review -> succeeded | failed | canceled
                         \-> lost -> recovering -> new attempt
```

The Product Controller owns the invocation state. The broker reports ordered events. Pi stdout,
local session files, and backend status are diagnostic evidence, not the state authority.

Heartbeat, lease, and fence tokens reject stale workers and late results. A result becomes success
only after schema validation, evidence checks, and required side-effect verification.

### 8.2 Checkpoint

An Agentic checkpoint includes:

- Context Capsule hash and Pi session/compaction reference;
- completed Tool Call ledger;
- artifacts and dynamic child states;
- remaining budget;
- known external side effects;
- last safe recovery point.

It stores handles rather than raw credentials.

### 8.3 Recovery Matrix

| Execution type | Recovery |
|---|---|
| Idempotent deterministic Skill | New attempt with identical pinned input |
| Pure analysis Pi Worker | Resume from checkpoint; otherwise reconstruct a fresh session from the capsule |
| Dynamic child graph | Reuse valid completed children and rerun only incomplete or invalid children |
| Confirmed external side effect | Query the external system and ledger before continuing |
| Non-idempotent action without verification | No automatic retry; enter `needs_review` |

A Pi session resume does not prove whether an external action already succeeded. Recovery therefore
uses session state, tool ledger, artifacts, and external verification together.

### 8.4 Cancellation

Cancellation propagates down the call tree:

```text
Controller cancel
  -> revoke Capability Lease
  -> Pi RPC abort or process termination
  -> cancel child workers and pending tool calls
```

Late events remain available for audit but may not change product state after fencing.

## 9. Observability

The canonical trace hierarchy is:

```text
workspace
  -> mainAgentSession
  -> moduleAgentSession or loopRun
  -> node
  -> invocation
  -> attempt
  -> piSession / turn
  -> toolCall / childWorker
```

Every event carries the relevant IDs, pinned object version, execution mode, worker backend, model,
and capability-lease reference.

Observability has two visibility classes:

- Product-safe events: progress, review, result summary, error classification, and recovery action.
- Internal diagnostics: prompts, model events, raw tool output, process logs, and sandbox details.

The initial metric set includes queue latency, duration, token use, compaction count, retries,
cancellation latency, tool errors, permission denials, child count, artifact size, and recovery
outcome. Braintrust may export these traces, but the product retains the canonical IDs and events.

## 10. `pi-workflow` Integration Boundary

`@agwab/pi-workflow` provides useful execution behaviors: single steps, foreach, reduce, loop,
nested DAGs, dynamic orchestration, background execution, and stage artifacts. It is built on
`@agwab/pi-subagent`, which can run Pi workers through separate processes, tmux, or inline SDK
sessions.

It is a good first backend for `agent_orchestrator`, subject to these constraints:

- Product WorkflowRunner remains the authority for every compiled, pinned Loop Run.
- Dynamic workflow state is mapped to product invocation, attempt, event, and artifact contracts.
- Local `.pi/workflows` storage is not an authoritative product database.
- Product cancellation, fencing, budgets, permissions, and review rules wrap the backend.
- Uploaded Skill execution uses a product Tool/Skill gateway rather than assuming in-process
  bindings exist in a subprocess.
- Replacing AgwaB must not change Product API, Draft, Loop, Run, or trace contracts.

References:

- [`AgwaB/pi-workflow`](https://github.com/AgwaB/pi-workflow)
- [`@agwab/pi-workflow` catalog entry](https://pi.dev/packages/%40agwab/pi-workflow)
- [`@agwab/pi-subagent` catalog entry](https://pi.dev/packages/%40agwab/pi-subagent)

Deterministic Skill Jobs do not pass through `pi-workflow`. Bounded Agent work may use the lighter
subagent backend without creating an unnecessary workflow.

## 11. Community Package Decisions

The Pi catalog is a discovery and adoption signal, not an endorsement or security review. Package
selection also considers source maturity, tests, license, architecture fit, and ability to remain
replaceable.

| Area | Package or reference | Decision |
|---|---|---|
| Official foundation | Pi SDK, Session, compaction, RPC | Adopt `0.80.7` after compatibility experiment |
| Bounded worker | `@agwab/pi-subagent` | First subprocess backend PoC |
| Dynamic child graph | `@agwab/pi-workflow` | First orchestrator backend PoC |
| Execution semantics | [`pi-subagents`](https://pi.dev/packages/pi-subagents) | Reference background, resume, steer, artifact, and supervisor behavior |
| Permission policy | [`@gotgenes/pi-permission-system`](https://pi.dev/packages/%40gotgenes/pi-permission-system) | Reference fail-closed and child-scope behavior; direct dependency requires PoC |
| Host sandbox | [`pi-landstrip`](https://pi.dev/packages/pi-landstrip) | Evaluate after the execution contract is stable |
| Durable memory | [`@remnic/plugin-pi`](https://pi.dev/packages/%40remnic/plugin-pi) | Strongest Memory Service PoC candidate; not in the first slice |
| Pi-native memory | [`pi-hermes-memory`](https://pi.dev/packages/pi-hermes-memory) | Reference provenance and query-on-demand; disable automatic Skill activation |
| Context reduction | Pi native compaction first; [Hypa](https://pi.dev/packages/%40hypabolic/pi-hypa) and [context-mode](https://pi.dev/packages/context-mode) as benchmarks | Do not add a second context subsystem before trace evidence |
| Goal semantics | [`@narumitw/pi-goal`](https://pi.dev/packages/%40narumitw/pi-goal) | Reference completion and blocker guards; no second Run state machine |
| Observability | [`@braintrust/pi-extension`](https://pi.dev/packages/%40braintrust/pi-extension) | Optional exporter after canonical trace exists |
| Deferred orchestration | `pi-fabric`, dynamic-workflows, independent task pipelines | Avoid early duplicate schedulers and state authorities |

Licenses for Hypa, context-mode, task packages, and any hosted memory or sandbox service require
review before adoption. No package is approved merely because it appears in the catalog.

## 12. Delivery Decomposition

This architecture is too broad for one implementation plan. The document is the master design;
implementation is split into independently reviewable slices.

### Slice 0: Pi 0.80.7 Compatibility Experiment

- Upgrade Pi from `0.75.5` to `0.80.7` on an isolated branch.
- Verify the current runtime, tools, events, model configuration, cancellation, and tests.
- Record breaking changes, package peer requirements, and rollback.
- Preserve current product behavior.

### Slice 1: Unified Execution Foundation

- Define ExecutionRequest, Event, Result, and Checkpoint contracts.
- Extract deterministic Skill execution from the shared Pi session.
- Run deterministic scripts through the backend Script/Skill Runner.
- Add one bounded Pi subprocess/RPC backend.
- Connect cancellation, timeouts, artifacts, tracing, and result validation.
- Keep Product WorkflowRunner as the existing Loop Run authority.

This is the first implementation plan because it proves the architectural seam and removes the
shared-session concurrency constraint without requiring the entire Agent platform.

### Slice 2: Product Agent and Module Sessions

- Introduce Main Agent, Module Agent Definition, and Module Agent Session.
- Implement session scope, Handoff Capsule, important-event synchronization, proposals,
  baseRevision, and three-way merge.

### Slice 3: Dynamic Agent Orchestrator

- Integrate AgwaB behind the Execution Broker.
- Persist dynamic children as product invocations and attempts.
- Prove visibility, cancellation, budgets, recovery, and fixed outer graph behavior.

### Slice 4: Memory, Sandbox, and Remote Execution

- Implement Memory Candidate promotion and scoped retrieval.
- Add sandbox/container execution for uploaded Skills.
- Add remote-device backend when cross-machine scheduling is a real product requirement.
- Benchmark advanced context reducers before adopting one.

## 13. Acceptance Criteria

The architecture is accepted only when tests and real execution traces prove:

1. A deterministic script completes without creating a Pi session or making an LLM request.
2. Two users working on the same Draft have isolated sessions, context, credentials, and
   transcripts.
3. Non-conflicting proposals rebase, while conflicting changes cannot silently overwrite.
4. Two bounded Pi workers execute concurrently without shared-session busy errors.
5. A pinned outer Loop graph remains fixed while dynamic children are visible in the Run
   timeline.
6. Restart recovery reuses valid work, and external side effects are not duplicated.
7. Undeclared permissions are denied and a child worker cannot escalate beyond its parent.
8. Compaction preserves Artifact anchors and original evidence remains retrievable.
9. An unconfirmed Memory Candidate does not appear in workspace durable memory.
10. One trace joins Product Run or Module Session to invocation, attempt, Pi turn, tool call, and
    child worker.
11. Removing the AgwaB backend does not require changes to Product API, Draft, Loop, Run, or trace
    contracts.
12. Fallback, timeout, cancellation, blocked permission, and partial success remain distinguishable
    product states.

## 14. Explicit Non-Goals

- Replacing Product WorkflowRunner with `pi-workflow`.
- Making every Skill invocation an Agent.
- Sharing one Module Agent transcript among collaborators.
- Allowing runtime Agents to mutate the pinned outer Loop snapshot.
- Automatically converting worker output into durable memory or executable Skills.
- Building a service-per-Agent deployment before the execution contract is proven.
- Adopting every high-download Pi package or treating catalog presence as trust.

## 15. Known Risks and Validation Requirements

These are known risks, not undecided architecture:

- Pi `0.80.7` compatibility with the current adapter is unverified until Slice 0 runs.
- AgwaB persistence, stop/resume behavior, and Tool gateway integration require source-level and
  live-runtime verification.
- Current uploaded Skill bindings are in-process; subprocess workers require an explicit product
  Skill/Tool gateway.
- Memory multi-tenancy, deletion, retention, provenance conflict, and legal policy require a
  dedicated Slice 4 design before production adoption.
- A subprocess provides context and fault separation but not a security sandbox.
- Sandbox behavior differs across macOS, Linux, Windows, and remote devices and must be proven on
  every supported backend.
- Context pruning can reduce provider prefix-cache reuse, so it is enabled only from trace-backed
  evidence.
- Dynamic child workflows increase observability volume and need product-safe event summarization.

## 16. Final Architecture Statement

The approved direction is:

```text
one coherent product personality
+ per-user independent Module Agent Sessions
+ canonical object revisions and proposal merge
+ domain-specific controllers
+ one product-owned Execution Broker contract
+ direct backend execution for deterministic scripts
+ independent Pi workers for Agentic execution
+ fixed pinned Loop graphs with visible dynamic child graphs
+ provenance-bearing, gated durable memory
+ replaceable subprocess, workflow, sandbox, and remote backends
```

The first landing item is the Execution Contract and deterministic/Agentic path split. AgwaB is an
adapter candidate for that boundary, not the boundary itself.
