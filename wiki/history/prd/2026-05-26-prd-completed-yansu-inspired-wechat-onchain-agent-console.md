# Yansu-Inspired WeChat x On-chain Agent Console PRD

Updated: 2026-05-26

## 0. Document Purpose

This document defines the next product iteration after the current SwiftUI MVP runtime checkpoint. It uses Yansu's public product form as a reference for proactive, local-first, background AI work, then adapts those principles to a WeChat x on-chain intelligence agent console.

This is not a visual copy or brand copy of Yansu. The reference value is the product posture:

- proactive work rather than prompt-first chat;
- Listen -> Crystallize -> Solve as the operating loop;
- memory, handoff, and crystal as durable product objects;
- local-first privacy and explicit permission boundaries;
- background work that does not interrupt the user's active desktop flow.

Reference source: https://yansu.app/?ref=producthunt, accessed 2026-05-26.

## 1. Product Thesis

The next iteration should move from "dashboard that summarizes WeChat and market signals" to "agent operation console that continuously turns private discussion and public market movement into verifiable, actionable intelligence."

The product should feel like a compact personal operating room for crypto intelligence:

```text
WeChat context
  -> people, groups, narratives, repeated questions, urgency, private alpha, collaboration intent
On-chain context
  -> token, CA, address, flow, event, liquidity, holder movement, market state
Agent runtime
  -> evidence binding, risk labeling, proposal planning, task creation, handoff, review
Desktop console
  -> calm control surface, crystal stream, inspector, run deck, policy boundary
```

The ideal user should not need to keep asking the app "what should I watch?" The app should quietly maintain context, surface high-signal changes, show why it believes something matters, and let the user approve or reject the next action.

## 2. Target Users

### 2.1 Primary User

An individual crypto researcher, trader, BD operator, founder, or analyst who monitors multiple WeChat groups while also following token and chain activity.

Core need:

- identify meaningful signals before they become obvious;
- connect private chat narratives with public on-chain confirmation;
- keep evidence and follow-up tasks organized;
- avoid leaking private WeChat content or secrets to remote services.

### 2.2 Team User

A small 5-8 person research or operations team sharing a local-first intelligence workflow.

Core need:

- preserve team memory around tokens, people, sources, and decisions;
- create handoff packets for shifts, meetings, or investment review;
- audit who/what triggered a conclusion;
- keep agent behavior permissioned and reviewable.

## 3. Product Principles

### 3.1 Proactive, Not Chat-First

The console should not be centered on an empty chat box. Chat can exist as a command input, but the first screen should be an active intelligence workspace: what changed, why it matters, what the agent is doing, and what needs a decision.

### 3.2 Evidence-First

Every crystal, proposal, alert, and task should carry evidence pointers. The user must be able to inspect source messages, token entities, on-chain snapshots, freshness, confidence, and policy decisions before acting.

### 3.3 Local-First and Permissioned

WeChat data, memory, crystals, run artifacts, and handoff packets live locally by default. Nothing should call live WeChat, MCP, RPC, browser automation, or external APIs from the Swift desktop runtime without an explicit bridge and policy state.

### 3.4 Calm Background Work

The agent should work in a visible but non-disruptive lane. It should not steal focus, hide its state, or silently overwrite conclusions. It should expose runID, module state, freshness, failure reason, and artifact status.

### 3.5 Human Approval for Sensitive Actions

Reading fixture files can pass. Reading user-provided WeChat exports needs confirmation. Running live WeChat commands is blocked. Publishing, trading, messaging, or external writes are out of scope for this MVP and must remain blocked until deliberately designed.

## 4. Product Objects

The next iteration should introduce durable product objects rather than only transient UI cards.

### 4.1 IntelligenceCrystal

An `IntelligenceCrystal` is the main unit of fused intelligence.

It represents:

- a concise claim or observation;
- related WeChat messages and sources;
- related token/address/chain entities;
- market and on-chain freshness;
- evidence links;
- confidence and risk;
- suggested next action.

Example:

```text
Crystal: "SOL infra discussion is accelerating in two groups while SOL liquidity snapshot remains fresh."
Source: WeChat fixture + market snapshot + token entity
Risk: medium
Next action: create watchlist follow-up and request on-chain bridge refresh
```

### 4.2 AgentProposal

An `AgentProposal` is a permissioned recommendation produced by the agent.

It should answer:

- what the agent wants to do;
- why now;
- what data supports it;
- what artifacts will be written;
- what permission is required;
- what happens if the user rejects it.

### 4.3 HandoffPacket

A `HandoffPacket` is a shareable local artifact for a meeting, shift change, investment review, or team update.

It should include:

- selected crystals;
- source freshness and degraded boundaries;
- open tasks;
- unresolved questions;
- agent run summary;
- copied summary text with private content redaction controls.

### 4.4 MemoryEntry

A `MemoryEntry` stores reusable local knowledge:

- source quality notes;
- recurring group narratives;
- known addresses or contracts;
- user preferences;
- previous false positives;
- team review decisions.

Memory must be inspectable, editable, and purgeable.

### 4.5 ProactiveSession

A `ProactiveSession` represents one agent listening and analysis cycle.

It should connect:

- selected time window;
- selected data sources;
- runID;
- module results;
- created crystals;
- generated proposals;
- artifacts;
- health state.

## 5. Core User Workflows

### 5.1 Daily Intelligence Loop

```text
Open app
  -> see sync state and freshness
  -> read top crystals
  -> inspect evidence
  -> accept or reject proposals
  -> create tasks/watchlist/alerts
  -> generate handoff packet
```

Success condition:

- user can understand the day without reading every group message;
- every high-signal conclusion can be traced to evidence;
- degraded or stale sources are visible.

### 5.2 Token Investigation Loop

```text
Select token or CA
  -> inspect related WeChat messages
  -> inspect market/on-chain snapshots
  -> view crystals and alerts
  -> ask agent to prepare proposal
  -> create watchlist item or task
```

Success condition:

- private group context and public market context are visible in one inspector;
- the app does not claim live on-chain truth when only fixture data exists.

### 5.3 Source Quality Loop

```text
Open source ranking
  -> review which groups/users created useful signals
  -> inspect false positives and stale claims
  -> update MemoryEntry
  -> influence future crystal priority
```

Success condition:

- the app improves local prioritization without requiring external training;
- source quality remains explainable.

### 5.4 Agent Review Loop

```text
Open Agent Run Deck
  -> review module sequence
  -> inspect policy decisions
  -> inspect artifacts
  -> compare proposal to evidence
  -> mark useful / wrong / needs follow-up
```

Success condition:

- the user can audit why a result appeared;
- errors become structured memory and future TODOs.

## 6. Information Architecture

```text
App Shell
├── Top Intent Bar
│   ├── global command input
│   ├── time window
│   ├── run status
│   ├── source freshness
│   └── permission boundary
├── Left Source Rail
│   ├── Today
│   ├── WeChat sources
│   ├── Token watchlist
│   ├── Crystal library
│   ├── Memory
│   └── Ops / Policy
├── Main Workspace
│   ├── Crystal Stream
│   ├── Today Radar
│   ├── Token Radar
│   ├── Task Queue
│   └── Handoff Builder
├── Right Inspector
│   ├── Evidence
│   ├── Token / Entity
│   ├── Agent Proposal
│   ├── Memory Entry
│   └── Artifact
└── Bottom Agent Run Deck
    ├── runID
    ├── module timeline
    ├── policy decisions
    ├── freshness
    ├── errors / degraded reasons
    └── artifact write status
```

## 7. UI / UX Direction

### 7.1 Visual Character

The visual goal is a quiet iOS/macOS-native intelligence cockpit:

- dark, high-contrast, information-dense surface;
- compact controls and clear hierarchy;
- first-viewport signal about what changed today;
- no marketing hero, no decorative gradients, no empty chat-first screen;
- use cards only for repeated actionable objects such as crystals, proposals, alerts, and tasks.

### 7.2 Top Intent Bar

Required states:

- `Idle`: latest run is available;
- `Running`: agent modules are active;
- `Completed`: latest run finished with fresh enough sources;
- `Degraded`: usable result with stale/fixture/missing source;
- `Failed`: no reliable result, reason visible;
- `Blocked`: policy or permission prevents action.

Top bar must show:

- selected time window;
- selected source scope;
- latest runID;
- source freshness;
- permission boundary;
- manual refresh.

### 7.3 Crystal Stream

The center workspace should prioritize crystals over raw messages.

Each crystal card should show:

- title;
- one-line rationale;
- source mix: WeChat, market, on-chain, memory;
- confidence;
- freshness;
- risk;
- proposed next action;
- evidence count;
- status: new, watching, acted, dismissed, archived.

### 7.4 Right Inspector

The right inspector is the place for proof and action.

It should show:

- selected crystal details;
- source messages with redacted preview;
- token entities and CA;
- on-chain snapshot state;
- proposal actions;
- artifact references;
- policy decision trace.

### 7.5 Bottom Run Deck

The run deck should make the agent operationally accountable.

It should show:

- module timeline;
- duration and status;
- generated artifacts;
- degraded sources;
- policy decisions;
- last success;
- next recommended run.

## 8. Runtime Architecture

The current architecture should remain:

```text
SwiftUI Views
  -> DashboardViewModel
  -> RuntimeBackend
  -> RuntimeRepository
  -> RuntimeCommand / RuntimeQuery / RuntimeMutation
  -> AgentOrchestrator
  -> JSON stores under runtime/
```

The next iteration should add a proactive intelligence layer on top of the existing runtime.

### 8.1 New Stores

```text
runtime/crystals/crystals.json
runtime/proposals/proposals.json
runtime/memory/memory.json
runtime/handoffs/{handoffID}.json
runtime/sessions/latest-session.json
```

All new stores should use bounded, normalized JSON. They must not store secrets or unredacted private content unless explicitly represented as a local-only artifact with purge controls.

### 8.2 New Runtime Commands

Recommended command additions:

- `generateCrystals(window, sourceScope)`
- `selectCrystal(crystalID)`
- `acceptProposal(proposalID)`
- `rejectProposal(proposalID, reason)`
- `createHandoff(crystalIDs, redactionPolicy)`
- `saveMemory(entry)`
- `purgeMemory(entryID)`
- `markCrystalUseful(crystalID)`
- `markCrystalFalsePositive(crystalID, reason)`

### 8.3 New Runtime Queries

Recommended query additions:

- `listCrystals(filter)`
- `getCrystalDetail(crystalID)`
- `listProposals(status)`
- `getMemory(entityID)`
- `listHandoffs`
- `getProactiveSession`

### 8.4 Agent Module Pipeline

Recommended next pipeline:

```text
Listener
  -> Entity Resolver
  -> Market Context
  -> On-chain Context
  -> Memory Retriever
  -> Crystalizer
  -> Evidence Linker
  -> Proposal Planner
  -> Handoff Writer
  -> QA / Policy
  -> Review Learner
```

Module rules:

- every module writes an `AgentModuleRun`;
- every module has `status`, `sourceFreshness`, `artifactIDs`, `errorMessage`;
- every generated crystal links back to module runs and evidence;
- blocked or degraded input must remain visible in UI.

## 9. Data and Policy Boundaries

### 9.1 Allowed

- Read bundled fixture JSON.
- Read local normalized runtime artifacts.
- Write local runtime artifacts under `wechat-intelligence-radar-mvp/runtime/`.
- Use external agent-produced normalized JSON after policy approval.

### 9.2 Needs Confirmation

- Read user-provided WeChat export JSON.
- Use an external CMC/MCP bridge to refresh market snapshots.
- Use permissioned RPC/DEX bridge output.
- Export handoff packets outside the local project folder.

### 9.3 Blocked

- Run `wechat-cli init`, `wechat-cli history`, `wechat-cli search`, or any live WeChat read command.
- Store secrets in Swift source, wiki, runtime JSON, or git-tracked fixtures.
- Let Swift desktop directly call MCP or network APIs for live data.
- Execute trades, send messages, or publish content.

## 10. Development Roadmap

### P0: Documentation and Product Contract

Deliverables:

- this PRD;
- wiki index update;
- explicit product object definitions;
- acceptance criteria for next engineering pass.

Exit criteria:

- team can explain the shift from dashboard to proactive console;
- implementation can start without changing reference-project boundaries.

### P1: Crystal MVP

Deliverables:

- `IntelligenceCrystal` model;
- crystal JSON store;
- crystal generation from existing fixture messages, token entities, market snapshot, and evidence;
- Crystal Stream UI in main workspace;
- right inspector support.

Exit criteria:

- smoke run produces at least 3 crystals;
- each crystal links to evidence and source freshness;
- stale or degraded source state is visible.

### P2: Proposal and Task Integration

Deliverables:

- `AgentProposal` model;
- proposal store;
- accept/reject actions;
- conversion from proposal to `UserTask`, watchlist item, alert, or handoff draft.

Exit criteria:

- user can approve or reject agent suggestions;
- rejected proposals leave review memory;
- no external action executes automatically.

### P3: Memory and Review

Deliverables:

- `MemoryEntry` model and store;
- source quality memory;
- false-positive review flow;
- memory inspector.

Exit criteria:

- user can mark useful/wrong crystals;
- future runs can read local memory and adjust ranking;
- memory can be purged.

### P4: Handoff Builder

Deliverables:

- `HandoffPacket` model;
- handoff writer module;
- redaction policy controls;
- local artifact output.

Exit criteria:

- user can create a concise handoff packet from selected crystals;
- packet includes freshness, evidence, open tasks, and degraded boundaries;
- private message preview can be redacted.

### P5: Permissioned Live Bridges

Deliverables:

- external market bridge refresh contract;
- external on-chain bridge normalized contract;
- user-provided WeChat export import flow;
- stronger settings and retention controls.

Exit criteria:

- live-like data enters only through normalized artifacts;
- permission state is explicit;
- Swift app still does not run live WeChat commands or store secrets.

## 11. MVP Acceptance Criteria

The next implementation pass is acceptable when:

- Desktop end shows Crystal Stream, Inspector, Run Deck, and policy/freshness state.
- Agent end generates crystals, proposals, module runs, evidence links, and review records.
- Data storage end writes crystals, proposals, memory, sessions, and handoff artifacts locally.
- Ops end shows runID, last success, degraded reason, source freshness, policy decisions, and artifact completeness.
- All generated intelligence can be traced to source evidence.
- `swift build` passes.
- `swift test` passes or, if local XCTest/Testing remains unavailable, framework-free SwiftPM checks compile and smoke-check validates runtime artifacts.
- No live WeChat commands are executed.
- `assignment-agent-raw` and `wechat-cli_raw` remain untouched.

## 12. Four-End Conclusion After This PRD

### Desktop End

Current state: effective at trial-runtime depth.

Next gap: the UI still presents mostly dashboards, terminal views, and run state. It needs a proactive Crystal-centered workspace, right-side proof/action inspector, and a more operational bottom run deck.

### Agent End

Current state: effective for fixture-driven runtime.

Next gap: the agent pipeline should produce durable crystals, proposals, handoffs, and review memory, not only summaries, alerts, and tasks.

### Data Storage End

Current state: effective for MVP runtime artifacts.

Next gap: missing first-class local stores for crystals, proposals, memory, proactive sessions, and handoff packets.

### Runtime / Ops End

Current state: effective for run health and artifact visibility.

Next gap: ops should track crystal generation quality, proposal acceptance/rejection, false positives, memory impact, and handoff artifact completeness.

## 13. Risks

- Over-automation could hide weak evidence. Mitigation: evidence-first inspector and proposal approval.
- Crystal overload could recreate notification fatigue. Mitigation: rank by confidence, freshness, source quality, and user review memory.
- Private WeChat content could leak into artifacts. Mitigation: local-first storage, redaction controls, explicit export boundaries.
- On-chain fixture data could be mistaken for live data. Mitigation: freshness labels, degraded state, provider labels, and policy gates.
- The UI could become too dense. Mitigation: keep first screen focused on Today, Crystal Stream, Inspector, and Run Deck; push deeper market lanes into detail surfaces.

## 14. Open Decisions For Future Implementation

- Whether Crystal Stream becomes the default Home view or a sibling to Today Radar.
- Whether handoff packets should be Markdown-only first or include JSON + Markdown pair.
- Whether MemoryEntry ranking should be manual only in MVP or include simple heuristic scoring.
- Whether external live bridges should be invoked by Codex/agent jobs or by a separate local daemon.

