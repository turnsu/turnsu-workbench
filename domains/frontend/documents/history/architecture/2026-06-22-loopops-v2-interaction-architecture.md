# LoopOps v2 Interaction Architecture

- Date: 2026-06-22
- Status: active interaction direction; SwiftUI frontend v1 implemented
- Scope: frontend product architecture only

## 1. Architecture Decision

LoopOps v2 uses a three-surface structure with an embedded chat control layer:

```text
Workbench: run, review, follow up
Library: save, clone, replay, share
Studio: build and edit loop contracts
Chat: control layer across all three
```

This keeps the App usable as a quiet macOS workbench while still allowing fast natural-language operation.

Implementation record, 2026-06-22: the active SwiftUI shell now maps the three surfaces to `Workbench`, `Library`, and `Studio`. Workbench embeds scoped chat next to the selected domain/run; Library exposes local loop contracts, run ledgers, replay/clone, and share-safe previews; Studio exposes contract fields plus Builder Chat. This is an App/frontend iteration only: runtime artifacts, Pi/Python harness, providers, gates, and final-output authority were not changed.

## 2. Surface Responsibilities

### Workbench

Primary daily surface.

Responsibilities:

- run saved loops and starter loops;
- show current run status;
- show the final answer from the authoritative read model;
- provide run-scoped chat follow-up;
- show review packet;
- start a fork or replay.

Workbench should not become a builder by default. It should expose loop structure enough to be understandable, then move advanced editing into Studio.

### Library

Reuse and memory surface.

Responsibilities:

- show saved loop contracts;
- show run ledgers;
- show share-safe logs;
- support clone, replay, compare, archive;
- turn a successful run into a reusable loop draft.

Library replaces passive History as the product concept. Existing History can remain as implementation compatibility, but the active IA is Library.

### Studio

Advanced configuration surface.

Responsibilities:

- edit loop contract fields;
- show builder chat;
- preview run behavior;
- validate missing fields;
- version a loop;
- prepare a loop for saving or scheduling.

Studio should be opened intentionally from a loop, a template, or a chat-generated draft. It should not be the default first screen.

## 3. Chat Contexts

### Global Chat

Located in Workbench as compact composer.

Expected actions:

- ask a direct question;
- start one-off run;
- create loop draft;
- attach files, images, or meeting media;
- choose domain implicitly from intent.

Output options:

- run now;
- save as loop draft;
- ask for clarification.

### Run Chat

Located beside or below the selected run.

Expected actions:

- explain final answer;
- ask follow-up;
- narrow the same loop;
- fork into a new run;
- create review notes.

Run Chat reads from the selected run state. It does not create a competing final answer.

### Builder Chat

Located in Studio.

Expected actions:

- turn plain language into a Loop Contract draft;
- update trigger, input bindings, step summary, gate, exit, and output shape;
- explain why the loop is incomplete.

Builder Chat must keep the structured contract visible. The user should see what changed.

### Review Chat

Located in Review Packet.

Expected actions:

- challenge a claim;
- request missing evidence;
- prepare a follow-up;
- mark reviewed;
- prepare a delivery preview.

Review Chat cannot execute high-impact external actions. It can only prepare a confirmed next step.

## 4. Core Interaction Flow

### Fast Run

```text
Open Workbench
  -> type or choose starter loop
  -> Run
  -> watch timeline
  -> read final answer
  -> Review Chat or Follow-up
```

### Build From Chat

```text
Open Global Chat
  -> describe recurring job
  -> receive Loop Contract draft
  -> open Studio
  -> adjust trigger / steps / gate / exit
  -> save to Library
```

### Review And Reuse

```text
Open Run Ledger
  -> inspect Review Packet
  -> ask Review Chat for gaps
  -> clone as loop or replay
  -> share-safe log if needed
```

## 5. Visual Layout

### Workbench Layout

Recommended desktop layout:

- Left: Loop Shelf
  - domain filter;
  - saved loops;
  - active and review-needed runs.
- Center: Current Run Canvas
  - final answer;
  - domain-native summary;
  - timeline;
  - evidence and caveat rows.
- Right or bottom adaptive region: Chat / Review Packet
  - compact in regular width;
  - drawer or sheet in compact width.
- Bottom: Chat Composer when not using side chat.

### Library Layout

- Left: filters and collections.
- Center: loop and run list.
- Right: selected log preview and clone/replay/share actions.

### Studio Layout

- Left: contract fields.
- Center: step and gate preview.
- Right: Builder Chat and validation.

## 6. Domain Mapping

### Crypto

Primary loops:

- Market Report Loop.
- DeFi Opportunity Scan.
- Thesis Review.
- Trade Plan Review.

Chat should help ask follow-ups such as:

- "What changed since last run?"
- "Which candidate deserves deep review?"
- "Turn this into a review-only plan."

### Markets

Primary loops:

- Company deep dive.
- Earnings review.
- Sector scan.
- Macro / cross-asset read-through.

Chat should help ask:

- "What contradicts this thesis?"
- "What data is missing?"
- "Create a follow-up research loop."

### Office

Primary loops:

- Meeting minutes.
- Document draft.
- Source pack rewrite.
- Delivery preview.

Chat should help ask:

- "Rewrite this for an executive audience."
- "Extract action items."
- "Prepare a Feishu preview, but do not publish."

## 7. App vs Web Split

Default product should remain App-first.

### macOS App

Best for:

- daily running and review;
- file and media input;
- private local workspace;
- fast follow-up;
- editing personal loop contracts.

### Web / Share Portal

Optional later surface.

Best for:

- share-safe loop logs;
- public examples;
- team review links;
- imported loop templates.

The web surface should not become the main run environment until the App workflow is stable.

## 8. Implementation Boundary For Future SwiftUI Work

Implemented in the 2026-06-22 SwiftUI pass:

- pure UI models for loop contracts, run ledgers, review packets, chat messages, and domain-scoped loop templates;
- local LoopOps store support for saved loop contracts, chat threads, review packets, and run ledgers;
- strict bridge helpers between the lightweight Swift `LoopContract` and the stricter LoopOps JSON contract used by Studio/store tests;
- Workbench result canvas components for run overview, final answer, domain render blocks, review boundary, and follow-up actions;
- Library review decision controls that persist `Reviewed`, `Needs follow-up`, and `Blocked` decisions;
- UI smoke strings for Workbench, Library, Studio, scoped chat, loop contracts, run ledgers, review packets, share-safe logs, hidden internals, and single final answer source.

Allowed in a later implementation phase:

- imported/shared log UX beyond local share-safe preview;
- behavior-level AppKit/XCUITest or accessibility-identifier checks for launch, replay, clone, review decision, chat draft, and Studio save flows;
- stricter persistence if `LoopOpsLoopContract` becomes the single canonical saved contract model;
- richer adapters that aggregate existing task, final read model, CMC summary, ASR summary, loop read model, memory, and subagent read models without changing runtime authority.

Not allowed without a separate runtime goal:

- changing backend route contracts;
- changing artifact names or schema authority;
- replacing final answer precedence;
- adding live external execution;
- exposing hidden infrastructure identifiers;
- bypassing product mutation policy.

## 9. Safety And Review Boundaries

LoopOps v2 must keep high-impact actions behind explicit confirmation or blocked paths:

- trading;
- live Feishu publish;
- WeChat sending;
- external posting;
- destructive file or data actions.

Chat may prepare the action, explain why it is blocked, or create a review checklist. It must not silently execute it.

## 10. Open Design Risks

- Chat can easily dominate the product and erase loop structure. The UI must keep the structured loop visible.
- Studio can become too heavy. Keep default Workbench fast and use progressive disclosure.
- Library can become passive history. It must foreground clone, replay, and share-safe log actions.
- Domain-native rendering can fragment too far. Keep each domain to a few stable components, not dozens of micro-panels.
