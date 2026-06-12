# Agent Runtime Core and Pi Kernel Redesign

- Date: 2026-06-12
- Status: proposed architecture
- Scope: agent-runtime refactor, Pi SDK boundary, daemon shell, capability packages, subagents, gates

## 1. Decision

The project should introduce an explicit `Agent Runtime Core` inside `agent-runtime/core/`.

The Core is not placed inside Pi Agent. It is also not left inside the daemon shell. It is a project-owned agent brain that uses Pi as the default agentic kernel.

```text
Pi is the agentic kernel.
Agent Runtime Core is the product brain and contract owner.
Daemon Shell is the local process host.
Swift is the workbench.
Capability packages are plugin contracts.
```

This avoids two bad outcomes:

- making the daemon a permanent monolith;
- making product behavior depend directly on Pi package semantics.

## 2. Target Directory Shape

```text
agent-runtime/
  bin/
    wechat-agent-daemon.mjs

  core/
    run-loop/
    planner/
    router/
    capability/
    gates/
    memory/
    review/
    subagents/
    final-output/
    artifacts/
    events/

  kernels/
    pi/
      pi-kernel-adapter.mjs
      pi-tool-module-loader.mjs
      pi-session-adapter.mjs
      pi-subagent-adapter.mjs

  extensions/
    cmc-skill-hub/
    markets-research/
    office-agent/
    wechat-cli/

  runtime/
    public-surface.json
    capability-registry.json
```

## 3. Responsibility Split

### 3.1 Swift Workbench

Swift owns:

- Command Desk UI;
- queue and history display;
- capability selection UI;
- final read model rendering;
- task-local review/detail sheets;
- user confirmation surfaces.

Swift must not own:

- tool routing;
- final precedence;
- evidence interpretation;
- mutation eligibility;
- provider selection;
- Pi session state.

### 3.2 Daemon Shell

Daemon shell owns:

- local HTTP/SSE;
- auth/local secret;
- process lifecycle;
- Mongo connection;
- run request intake;
- event streaming;
- filesystem root and retention plumbing;
- calling Agent Runtime Core.

Daemon shell should not own:

- product planning;
- capability routing;
- gates;
- final formatting;
- package business logic.

### 3.3 Agent Runtime Core

Core owns:

- task normalization;
- planner;
- capability resolver;
- tool router;
- gate engine;
- memory adapter contract;
- review branch contract;
- subagent coordination contract;
- final read model writer;
- product mutation eligibility;
- runtime artifact manifests.

Core is the place where future complex loops should live.

### 3.4 Pi Kernel

Pi Kernel owns:

- Pi SDK session lifecycle;
- tool-call loop execution;
- tool module loading;
- Pi-native subagent/session features as they mature;
- converting Pi observations into Core observations.

Pi should not own:

- product capability catalog;
- public UI labels;
- final answer authority;
- business mutation policy;
- App-specific artifact contracts.

This does not reduce Pi to a dumb executor. It lets Pi become a stronger agentic kernel while keeping project-level contracts stable.

### 3.5 Capability Packages

Capability packages own:

- manifest contribution;
- Pi tool modules;
- provider adapters;
- normalizers;
- package-local schemas;
- fixtures;
- package-local artifact writers.

Capability packages must not own:

- final output authority;
- global routing;
- product mutation commit;
- public UI layout;
- high-impact policy overrides.

## 4. Core APIs

The Core should expose a small interface to the daemon:

```ts
type RunRequest = {
  sessionID: string
  prompt: string
  selectedCapabilityIDs: string[]
  taskIntent?: string
  attachments: AttachmentRef[]
  contextRefs: ContextRef[]
}

type RunResult = {
  runID: string
  taskID: string
  status: "completed" | "failed" | "cancelled"
  finalReadModelPath: string
  manifestPath: string
}
```

Core internal pipeline:

```text
normalize request
  -> resolve capabilities
  -> plan task
  -> route tools / kernel actions
  -> execute through Pi Kernel
  -> normalize observations
  -> evaluate engineering gates
  -> write artifacts
  -> write final read model
  -> emit event summary
```

## 5. Capability Catalog

Replace ambiguous `Skill/Extension` naming in new code with:

```text
capability-catalog.json
```

Concepts:

- `capabilityID`: user-visible package or ability.
- `taskIntents`: supported task types.
- `defaultEnabled`: UI hint only.
- `toolModuleRefs`: internal mapping.
- `policyProfile`: engineering policy profile.
- `readModelHints`: UI display hints.

Swift should eventually consume generated catalog output, not a manually duplicated fallback surface.

## 6. Tool Routing

Tool routing should move from ad hoc daemon functions to:

```text
core/router/
  intent-classifier
  capability-resolver
  tool-route-planner
  route-diagnostics
```

Input:

- prompt;
- selected capability IDs;
- attachments;
- context refs;
- previous run state.

Output:

- planned kernel actions;
- selected internal tools;
- reasons;
- route diagnostics.

This allows task intent to be fixed as a router bug, instead of patched with gates.

## 7. Gate Engine

All gates should live in:

```text
core/gates/
```

The only hard gate classes:

- `PolicyDecision`
- `ContractDecision`
- `ClaimProvenanceDecision`
- `OutputSafetyDecision`
- `MutationCommitDecision`

Fields such as confidence, risk, freshness, parser warnings, and source trust should be metadata. They may inform review UX, but should not independently rewrite or block business output.

## 8. Subagent Path

Subagents should be introduced through Core, with Pi Kernel as the execution adapter:

```text
Core SubagentCoordinator
  -> creates namespaced subagent request
  -> Pi Kernel creates/attaches subagent session
  -> Core records lineage, messages, artifacts, review result
  -> final read model remains authoritative
```

Do not let Swift or daemon shell create subagents directly.

## 9. Memory Path

Memory should be Core-owned:

- retention policy;
- user review;
- purge;
- write eligibility;
- source attribution;
- memory read model.

Hermes or any future memory system should plug into Core as a memory adapter, not into Swift and not directly into Pi tool modules.

## 10. Expected Benefits

- daemon becomes smaller and safer;
- Pi can evolve into a more capable agentic kernel;
- App remains a clean workbench;
- gates are centralized and reduced;
- business bugs are fixed in router/provider/parser/prompt/UI, not hidden by more gates;
- capability packages become easier to add without copying orchestrators;
- subagents and memory can evolve without coupling to Swift.

## 11. Non-goals

- This does not replace Pi SDK.
- This does not move product decisions into Swift.
- This does not expose Pi tools to the App.
- This does not enable live trading, live WeChat send, Feishu publish, or external posting.
- This does not turn every business uncertainty into a gate.
