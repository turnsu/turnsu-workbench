# LoopOps v2 Product PRD

- Date: 2026-06-22
- Status: active product direction; SwiftUI frontend v1 implemented
- Scope: macOS App product design and interaction model
- Supersedes: `2026-06-22-loopops-product-design-review` as the active direction

## 1. Decision

LoopOps v2 should not become a generic chatbot, a node-canvas automation tool, or an operations console. The product should become a **loop-native workbench with a chat control layer**.

The core product objects are:

```text
Loop Contract -> Run Ledger -> Review Packet -> Share-safe Log
                    ^
                    |
              Chat Thread
```

Chat is not a separate product surface. It is the control layer that helps the user:

- create a loop from natural language;
- run an existing loop;
- ask follow-up questions about a run;
- revise a loop contract;
- review a final answer and evidence gaps;
- turn file, image, meeting, or market questions into executable loop work.

Implementation record, 2026-06-22: the SwiftUI frontend now exposes LoopOps v2 in the default product path. `Workbench` includes saved Loop Contracts, starter loops, recent runs, a componentized current run canvas, and scoped chat. `Library` exposes My Loops, Run Ledgers, Review Packet decisions, replay/clone, and share-safe previews. `Studio` exposes a Loop Contract editor and Builder Chat. The implementation is frontend-only and keeps `AgentFinalReadModel.finalText` as the only authoritative final answer source.

Polish record, 2026-06-22: the first post-implementation pass closed the main demo gaps. Result Canvas now separates run overview, final answer, domain render blocks, review boundary, and follow-up actions. Review Packet decisions persist in the local LoopOps store. The lightweight Swift `LoopContract` model can export and import the stricter LoopOps JSON contract used by Studio/store tests. Front-stage visible copy was scrubbed so implementation terms such as read-model, provider, tool, artifact field, and schema names do not leak into the Workbench/Library/Studio path.

## 2. Why This Change

The current Blocks Workbench proves that domain templates can launch useful Agent tasks, but it still reads as a demo because the main object is unclear. Users see blocks, templates, tasks, markdown, and details; they do not yet see a durable work object they can own.

LoopOps v2 makes the durable object explicit:

- **Loop Contract**: the saved reusable workflow definition.
- **Run Ledger**: the immutable record of one execution.
- **Review Packet**: the human decision layer after output generation.
- **Share-safe Log**: a redacted replayable record that can be shared or cloned.
- **Chat Thread**: the conversational control history around a loop or run.

This maps better to the user's real work:

- Crypto: repeatedly scan, filter, review, and refine market candidates.
- Markets: run research loops over company, sector, macro, and cross-asset questions.
- Office: turn meetings, files, images, and instructions into drafts, summaries, and delivery previews.

## 3. Market Reference Takeaways

These references are product inputs, not UI patterns to copy.

- Zapier Agents frames agents as AI teammates that can be built, monitored, and chatted with when needed: <https://zapier.com/agents>.
- Make AI Agents emphasizes visual transparency, step-by-step decisions, manual approvals, and reusable building blocks: <https://www.make.com/en/ai-agents>.
- Gumloop emphasizes specialized agents, background tasks, workflow orchestration, audit logging, and governance: <https://www.gumloop.com/> and <https://docs.gumloop.com/>.
- Relevance AI emphasizes tools, knowledge, guardrails, approvals, and agent workforces: <https://relevanceai.com/docs/get-started/introduction>.
- n8n AI workflow documentation shows how AI agent steps, tools, structured output, and workflow nodes fit into automation: <https://docs.n8n.io/advanced-ai/intro-tutorial/>.
- Minara's docs are most useful for this product in three areas: context-aware personalization, multimodal chat input, and chat-to-workflow behavior. See <https://minara.ai/docs/features/personalization>, <https://minara.ai/docs/features/multimodal-input>, <https://minara.ai/docs/features/deep-research>, and <https://minara.ai/docs/features/agentic-workflow>.

Important boundary: Minara's trading copilot and one-click execution patterns are not the target for this App. looloomi remains research / drafting / review-first; trading, live posting, and external delivery stay gated.

## 4. User Jobs

### Crypto Research

The user wants to ask quickly:

- "Scan the market and tell me if anything is worth deeper review."
- "Continue this BTC thesis and show support, contradiction, invalidation."
- "Turn this result into a review-only trade plan draft."

The App must support continuous market work without turning into a trading terminal. The answer should make stance, evidence, missing inputs, and review boundary clear.

### Markets Research

The user wants to ask:

- "Run a company deep dive."
- "Review earnings."
- "Connect equity, macro, and crypto risk sentiment."

The App should keep this as a Markets loop, not a separate stock app. The output is a research draft or review packet, not a buy / hold / sell instruction.

### Office Draft

The user wants to drag in files, images, audio, or video and say:

- "Make meeting minutes."
- "Write this as a document draft."
- "Prepare a Feishu preview."

The App should show cloud transcription status when media is involved, then produce a draft and review packet before delivery.

## 5. Product Surfaces

### Workbench

Default surface. It answers:

- What loop should I run?
- What is currently running?
- Which run needs review?
- What is the authoritative final answer?
- What should I ask next?

Workbench includes:

- Loop Shelf: saved loops, starter loops, active / review-needed runs.
- Current Run Canvas: final answer, domain-specific blocks, timeline, evidence gaps.
- Chat Composer: quick prompt, run follow-up, attach files/images/media.
- Review Bar: approve as reviewed, ask follow-up, fork loop, save to Library, prepare delivery.

### Library

Reuse surface. It answers:

- Which loops do I own?
- Which runs are worth replaying or sharing?
- What did this loop do last time?
- Can I clone this run into a saved loop?

Library includes:

- My Loops.
- Run Ledgers.
- Shared / Imported logs.
- Prompt drafts and loop drafts.

History becomes Library because passive history is not enough for loop-based work.

### Studio

Advanced editing surface. It answers:

- What exactly does this loop do?
- What inputs does it bind to?
- What are the steps, gates, and exit conditions?
- How should review work?

Studio includes:

- Loop Contract editor.
- Builder Chat.
- Trigger and input bindings.
- Skill chain as user-facing capabilities.
- Feedback gate.
- Exit condition.
- Output shape.
- Review policy.

Studio is not the default screen. It opens from a saved loop, template, or chat-generated draft.

## 6. Chat Control Layer

The chatbot layer must support four contexts:

### Global Chat

Entry point for fast work:

- "Scan BTC and ETH."
- "Draft a meeting summary from this recording."
- "Build me a loop that checks ETF flows every morning."

It may create a loop draft or start a one-off run.

### Run Chat

Attached to a specific run:

- explain a result;
- ask a follow-up;
- continue with a narrower prompt;
- create a new run from the previous answer.

Run Chat cannot replace the final answer. The final answer remains the read model output.

### Builder Chat

Attached to a Loop Contract draft:

- convert natural language into trigger / steps / gate / exit;
- edit loop name, goal, output shape, or review policy;
- explain why a loop is not runnable.

Builder Chat must keep the structured contract visible next to the conversation.

### Review Chat

Attached to the Review Packet:

- challenge claims;
- ask for missing inputs;
- mark assumptions;
- prepare a follow-up loop;
- prepare a delivery preview.

Review Chat must not convert review-only content into execution.

## 7. Required Product Objects

### Loop Contract

Fields:

- name
- domain
- goal
- trigger
- input bindings
- user-facing capability chain
- step summary
- feedback gate
- exit condition
- review boundary
- output shape
- schedule / manual mode
- version
- owner
- visibility

### Run Ledger

Fields:

- loop contract snapshot
- run id
- started / completed timestamps
- inputs used
- status timeline
- final answer pointer
- evidence gaps
- blocked actions
- review decision
- follow-up prompts
- clone / replay metadata

### Review Packet

Fields:

- final answer
- domain summary
- claims
- evidence gaps
- uncertainty
- blocked actions
- next questions
- review decision

### Chat Thread

Fields:

- scope: global, run, builder, review
- messages
- attachments
- generated loop draft reference
- follow-up run references
- memory candidates

### Share-safe Log

Fields:

- redacted loop summary
- redacted run timeline
- final answer excerpt
- review notes
- clone instructions
- omitted sensitive fields summary

## 8. Domain Output Requirements

### Crypto

Must show:

- stance: risk-on, defensive, no-trade, waiting, review-needed;
- candidate funnel;
- CMC returned result summary when present;
- missing or stale inputs;
- price and evidence caveats;
- next review conditions.

Must not show:

- live trading button;
- one-click execution;
- hidden infrastructure names.

### Markets

Must show:

- company / sector / macro thesis;
- support and contradiction;
- evidence gaps;
- confidence and review needs;
- next research loop.

Must not show:

- buy / hold / sell as an action instruction.

### Office

Must show:

- transcript status if media is attached;
- meeting minutes or document draft;
- action items;
- unresolved questions;
- delivery preview.

Must not show:

- live Feishu publish without confirmation.

## 9. Non-goals

- No node-canvas as the default UI.
- No trading execution surface.
- No permanent inspector.
- No source-browser-first layout.
- No exposure of hidden runtime infrastructure.
- No separate chat-only shell.
- No new backend contracts in this design phase.

## 10. Acceptance Criteria

- A user can understand within 10 seconds that the App runs reusable loops and supports chat-guided follow-up.
- A user can start with chat, a saved loop, or a starter loop.
- A run shows one authoritative final answer.
- A loop can be saved, cloned, replayed, and reviewed conceptually in the design.
- Chat can generate or revise a loop, but the structured contract remains visible.
- Review is a stage, not just a button.
- Sharing uses a share-safe log, not raw internal output.
- Crypto, Markets, and Office remain domain work modes, not separate apps.
