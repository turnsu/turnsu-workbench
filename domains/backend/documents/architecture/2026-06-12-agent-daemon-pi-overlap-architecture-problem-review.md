# Agent Daemon / Pi Agent Boundary Problem Review

- Date: 2026-06-12
- Status: historical problem review
- Scope: Agent daemon, Pi SDK-backed runtime, Skill/Extension naming, capability package architecture

## 1. Why This Exists

The project has accumulated multiple Agent iterations in a short time:

- Pi SDK adoption.
- Skill / Extension public surface.
- CMC Skill Hub package.
- Office / Meeting package.
- production harness artifacts.
- Command Desk workbench.
- Markets Research package.

Each iteration solved a real immediate problem, but the concepts were layered on top of the existing daemon rather than separated into a stable runtime architecture. The result is not just a large daemon file. The deeper problem is that product concepts, Pi concepts, tool execution, routing, gates, artifacts, and frontend read models are using the same names and often the same JSON objects.

## 2. Current Concept Collision

The word `Skill` / `Extension` is overloaded:

| Layer | Current term | Actual meaning |
| --- | --- | --- |
| Swift App | Skill / Extension | user-selectable ability or package |
| public surface | skillIDs / extensionIDs | product-facing capability catalog |
| daemon request | selectedSkillIDs / selectedExtensionIDs | both user selection and routing hints |
| Pi SDK | extension | code module that registers tools through `pi.registerTool(...)` |
| extension manifest | public skills + internal tools + providers + policies | mixed product and runtime metadata |
| daemon router | toolsForSkill / toolsForExtension | internal mapping from product IDs to tool names |
| Swift fallback | default public surface | second copy of user-facing catalog |

This makes the system hard to reason about because one ID can be interpreted as:

- a UI option;
- a task intent;
- a package;
- a runtime module;
- a tool-routing hint;
- an evidence/policy boundary.

## 3. Where Agent Daemon and Pi Agent Overlap

The daemon currently does too many jobs:

- local HTTP/SSE host;
- session and run lifecycle;
- public capability serving;
- Pi SDK initialization;
- extension loading;
- tool routing;
- planner and deterministic run-loop artifacts;
- CMC / Office / Markets gate logic;
- output guard;
- final read model writing;
- Mongo persistence;
- product mutation policy;
- frontend compatibility shape.

Pi SDK is also present as a runtime framework:

- session manager;
- resource loader;
- extension tool registration;
- tool execution abstraction.

The overlap is not that Pi SDK and daemon both exist. The overlap is that the daemon uses Pi as an internal tool runtime but still implements most agentic control itself. If the project continues this way, future planner loops, subagents, memory, review branches, and provider orchestration will keep growing inside the daemon.

## 4. Why "Daemon Owns Everything" Is Not Enough

Earlier stabilization moved decision ownership into the daemon to stop frontend drift and package-level overreach. That was a correct short-term move, because it established:

- one authoritative final read model;
- no final reconstruction in Swift;
- no product mutation import when gate conditions fail;
- no provider or tool IDs exposed to the App.

But as a long-term architecture it is too coarse. A daemon that owns all decisions becomes:

- hard to test at module level;
- hard to evolve into real agentic loops;
- hard to let Pi become more agentic;
- too coupled to Swift read model needs;
- too coupled to specific CMC / Office / Markets business bugs;
- too risky for future subagent / tmux / Hermes memory work.

The correct next step is not to move logic into Swift or Pi package manifests. The correct next step is to split the daemon into a host shell plus an Agent Runtime Core.

## 5. Historical Root Causes

### 5.1 Product Capability and Tool Module Were Not Separated

`cmc-skill-hub`, `office-agent`, `markets-research`, and `wechat-cli` are product capability packages from the user's point of view. But in code they are also Pi extension modules and internal tool namespaces.

This creates pressure to expose implementation detail to the App or to treat package manifests as source of truth for product behavior.

### 5.2 Routing Uses User Selection Too Directly

`selectedSkillIDs` and `selectedExtensionIDs` are useful user intent signals, but they should not be the runtime routing model. Today they are used as a bridge into `toolsForSkill`, `toolsForExtension`, and `inferTools`.

This is brittle:

- changing UI labels risks changing runtime behavior;
- adding a capability can accidentally fan out tools;
- task intent and package selection are not strongly typed;
- macro / social / price tasks can be routed incorrectly.

### 5.3 Pi SDK Is Treated as Both Kernel and Package Loader

Pi SDK is a good fit for tool modules, sessions, and agentic execution. It should grow into a stronger kernel over time. But the project currently lacks a stable Core boundary above Pi, so daemon logic decides what Pi should do through ad hoc glue.

### 5.4 Swift Fallback Public Surface Duplicates Runtime Truth

Swift fallback is useful for offline startup, but it has become another copy of the catalog. Every new capability risks drift between:

- `runtime/public-surface.json`;
- extension manifests;
- daemon `/capabilities`;
- Swift `defaultPublicSurface()`.

This should eventually be generated from one catalog.

## 6. Corrected Vocabulary

Future work should use these names consistently:

| New term | Meaning |
| --- | --- |
| Product Capability | user-visible ability package, e.g. CMC Skill Hub, Markets Research, Office / Meeting |
| Task Intent | what the user wants to do, e.g. market loop, earnings review, meeting notes |
| Capability Catalog | canonical product-facing catalog consumed by Swift |
| Tool Module | Pi-loadable code module that registers executable tools |
| Internal Tool | concrete tool name such as `cmc.*`, `office.*`, `markets.*` |
| Provider Adapter | data/API bridge used by a tool module or Core service |
| Agent Runtime Core | product-level agent brain and contract owner |
| Daemon Shell | local host process exposing HTTP/SSE and lifecycle |
| Pi Kernel | default agentic execution kernel used by Core |

The word `Extension` should not be used alone in new design docs. It must be qualified as either `Product Capability` or `Pi Tool Module`.

## 7. Target Separation

```text
Swift Command Desk
  -> capabilityIDs + task intent + attachments

Daemon Shell
  -> HTTP/SSE, auth, Mongo, process lifecycle

Agent Runtime Core
  -> planner, router, memory, review, gates, final read model

Pi Kernel Adapter
  -> sessions, tool-call loop, tool module loading, subagent sessions

Tool Modules
  -> CMC, Markets, Office, WeChat, Memory providers and artifact writers
```

The important distinction:

- Pi Kernel can become more agentic over time.
- Agent Runtime Core remains the product contract owner.
- Daemon Shell should not keep growing into the product brain.
- Swift should not own routing, final precedence, or gate decisions.

## 8. Historical Lesson

The project should not repeat the pattern of solving every new business feature by adding another daemon branch, gate field, Swift fallback, and artifact contract. The next phase should first create a stable Core boundary, then migrate features into it incrementally.
