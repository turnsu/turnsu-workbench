# Scoped Chat / Quick GUI Redesign V3

This reference defines the product direction for LoopOps Scoped Chat and its near-composer Quick GUI. It is guidance, not an implementation prerequisite.

The core principle is unchanged: Chat is a control layer for LoopOps objects, not the product body. Workbench, Loop Library, Loop Studio, Run Ledger, Review Packet, Share-safe Log, and the authoritative final answer remain the primary surfaces and records.

## Reference Breakdown

The prior Triple/T3 research establishes a narrow, useful reference: a simple chatbot with a compact control strip around the input. The relevant pattern is not a large chat product, but a lightweight composer system with visible model, response mode, search, attach, temporary mode, settings, and prompt categories.

The existing module note confirms that LoopOps already treats chat as scoped behavior rather than a generic message stream. Run Chat, Builder Chat, and Review Chat exist as product concepts, while Global Chat is present in the reference direction and needs a stronger first-class role in the product surface.

`PRODUCT.md` anchors the design in a local-first macOS productivity app. The user wants to start work quickly, continue from an authoritative result, save or deliver useful output, and stay away from internal runtime concepts. Chat must therefore start, explain, refine, and review Loop work without making the user manage infrastructure.

`DESIGN.md` sets the visual and IA constraints: native, quiet, light-first, compact, system-adaptive, and focused on LoopOps v2. Scoped Chat belongs beside Workbench, Library, and Studio flows, with clear scope labels such as Global Chat, Run Chat, Builder Chat, and Review Chat.

## Current UI Failure List

- Scope is not strong enough as a persistent mental model. A user can see chat, but may not immediately know whether a message targets the whole workspace, the current run, a loop draft, or a review packet.
- Global Chat is under-expressed. It should be the broad entry point for starting or finding work, not an accidental variant of run chat.
- Near-input controls risk reading as decoration unless each one visibly changes request behavior, persistence, or context.
- Mode is too soft. Instant and Deep need a clear behavioral distinction: quick answer or lightweight action versus deeper planning, broader context, and slower response.
- Model selection is useful only if it is attached to the outgoing request and shown in the resulting user message metadata.
- Search needs three explicit states: Off, Workspace, and Web. A single search toggle hides whether the assistant is using local LoopOps context, external web context, or no retrieval.
- Attach needs product-specific source types, not a generic paperclip. File note, Website source, Knowledge source, and Skill path imply different handling and persistence.
- Temporary mode needs an obvious consequence. The user should understand that the message is not saved to the durable thread and should not create background run history.
- Prompt category is currently easy to treat as a suggestion chip. It should shape the request intent and default follow-up actions.
- Run, Builder, and Review messages must stay isolated. A follow-up on a run should not silently mutate a loop draft; a builder instruction should not be recorded as a review decision.
- Review Chat must not compete with the Review Packet. It can explain and propose, but saved review state belongs to the packet and ledger.
- Builder Chat must not become invisible configuration. Changes proposed in chat must land in visible Studio fields before they are saved.
- The composer can become too heavy if every option is expanded at once. The target should stay close to the T3-style compact control strip.

## New Information Architecture

Scoped Chat is a shared control layer mounted in four scopes:

| Scope | Primary Surface | User Intent | Durable Object |
| --- | --- | --- | --- |
| Global Chat | Workbench or app-level command region | Start, find, summarize, or route work across the workspace | Workspace chat thread or new Loop draft |
| Run Chat | Current Run Canvas and run detail | Continue, refine, explain, or reuse one run result | Run Ledger entry and run-scoped thread |
| Builder Chat | Loop Studio | Create or edit a Loop Contract using natural language | Draft or saved Loop Contract |
| Review Chat | Review Packet and ledger detail | Explain quality, gaps, decisions, and next action | Review Packet and ledger decision |

The scope selector is always visible near the composer. It uses plain labels: Global, Run, Builder, Review. The full scope label appears in the panel header: Global Chat, Run Chat, Builder Chat, or Review Chat.

The composer has three layers:

- Context row: scope label, current object reference, and attachment inventory.
- Input row: multiline prompt field and send action.
- Quick GUI row: mode, model, search, attach, temporary, and category controls.

The quick controls are not settings. They are request controls. Every outgoing message should carry the active scope, mode, model, search state, temporary flag, category, and attachment references.

Scope behavior:

- Global Chat can create a new loop draft, find saved loops, summarize recent runs, or ask a broad workspace question.
- Run Chat is bound to one run id and can only operate on that run unless the user explicitly forks, replays, or promotes a result.
- Builder Chat is bound to one loop draft or saved contract. It can propose edits, but visible Studio fields remain the source of truth.
- Review Chat is bound to one review packet or ledger entry. It can propose decisions, but saved review state must be applied through the Review Packet.

## Core User Paths

1. Start from Global Chat.
   The user opens Workbench, sees Global Chat as the broad control layer, selects a category such as Explore or Create, optionally attaches a Knowledge source, and asks for a crypto, markets, or office task. The response either answers directly or offers a clear action to create a loop draft, open a saved loop, or start a run.

2. Continue from a run.
   The user reads the authoritative final answer in Current Run Canvas, opens Run Chat, and asks a follow-up. The composer shows the bound run, selected mode, search state, and attachments. The reply stays attached to that run and offers follow-up actions such as refine answer, prepare delivery, save insight, or replay from this result.

3. Build or modify a loop.
   The user opens Loop Studio and uses Builder Chat to say what the loop should do. The assistant proposes changes, then maps them into visible fields such as goal, trigger, inputs, steps, review rule, exit condition, and output shape. Nothing is saved until the user applies the proposed changes.

4. Review a run.
   The user opens a review-needed ledger entry and uses Review Chat to ask why a result is incomplete, risky, or blocked. The chat explains gaps and suggests a decision. The Review Packet remains the place where Reviewed, Needs follow-up, or Blocked is saved.

5. Attach source context.
   The user opens Attach, chooses File note, Website source, Knowledge source, or Skill path, and sees the source appear as an attachment chip with source type and state. The next message includes that source in request context. If the source should become reusable knowledge, that action is explicit and separate from the one-time chat attachment.

## High-Fidelity Target Draft

The target panel is quiet, compact, and close to the input. It should feel like a native macOS control area, not a dashboard.

Panel header:

- Left: scope title, such as Run Chat.
- Center or secondary line: bound object label, such as Current run, Loop draft, or Review packet.
- Right: compact actions for opening detail, clearing a temporary draft, or collapsing the panel.

Message area:

- User messages show only useful metadata: mode, search state, temporary state when active, category, model label, and attachment count.
- Assistant messages focus on product actions and object references. They do not expose raw provider names, worker names, schema fields, or internal artifact paths.
- Run Chat replies may reference the final answer, timeline, evidence gaps, or delivery preview.
- Builder Chat replies may show proposed contract changes, but the visible Studio form is the authority.
- Review Chat replies may show decision reasoning, but the Review Packet is the authority.

Composer:

- The input stays visually dominant, with one clean multiline field and a stable send button.
- Above or below the input, the Quick GUI row uses compact controls:
  - Mode: Instant or Deep.
  - Model: current model label with a menu.
  - Search: Off, Workspace, or Web.
  - Attach: source menu.
  - Temporary: toggle with temporary state shown only when active.
  - Category: Create, Explore, Code, Learn, Review, or Refine depending on scope.
- Controls wrap on compact widths without hiding the scope label or send action.
- Attachment chips sit close to the input and use short labels with source type, state, and remove action.

Visual tone:

- Use system surfaces, separators, and native control sizing.
- Avoid large decorative cards, marketing-style empty states, gradients, glow, and dense status chip stacks.
- Keep labels short and work-oriented.
- Keep Chat visually subordinate to the current LoopOps object.

Scope-specific category defaults:

- Global Chat: Create, Explore, Learn.
- Run Chat: Refine, Review, Learn.
- Builder Chat: Create, Code, Refine.
- Review Chat: Review, Explore, Refine.

## Interaction State Table

| Control | States | Default | Behavior Impact | Disabled or Empty State |
| --- | --- | --- | --- | --- |
| Scope | Global, Run, Builder, Review | Current surface scope | Selects thread, object binding, allowed actions, and persistence target | If no object is available, show Global only and explain through object label, not long helper copy |
| Mode | Instant, Deep | Instant | Instant favors short response and direct action; Deep allows broader context, planning, and slower reasoning | If Deep is unavailable, keep the label visible and show unavailable state in the menu |
| Model | Available product model labels | Product default | Sets the model preference for the outgoing request and appears in message metadata | If only one model is available, show it as a non-menu label |
| Search | Off, Workspace, Web | Workspace in scoped object surfaces; Off in temporary draft | Off sends no retrieval intent; Workspace limits context to local LoopOps objects; Web permits external search intent | If Web is unavailable, keep Web visible but disabled with setup state |
| Attach | File note, Website source, Knowledge source, Skill path | No attachment | Adds source references to the outgoing request and shows chips near the composer | If a source fails to load, keep the chip with error state and remove action |
| Temporary | Off, On | Off | On prevents durable chat history and background run creation for that message | If scope requires a durable record, disable Temporary and state that the scope saves decisions |
| Category | Create, Explore, Code, Learn, Review, Refine | Scope-specific default | Shapes intent, suggested actions, and response framing | If not relevant for a scope, hide that category rather than showing a dead control |
| Send | Ready, Empty, Sending, Blocked | Empty | Submits text plus scope, controls, and attachments as one request | Empty disables send; Blocked shows the blocking reason near the composer |
| Attachment chip | Ready, Loading, Error, Saved to Knowledge | Ready after source resolves | Communicates what context will be included in the next message | Error state keeps remove and retry actions |
| Apply proposal | Available in Builder and Review flows | Hidden | Applies a visible proposed change to Studio fields or Review Packet state | Hidden unless there is a concrete proposal tied to the current object |

## Acceptance Criteria

- The draft clearly states that Chat is a LoopOps control layer, not the product body.
- Global Chat, Run Chat, Builder Chat, and Review Chat are defined as separate scopes with distinct objects and behaviors.
- Scope is always visible near the composer and reflected in the panel title.
- Mode, model, search, attach, temporary, and category controls are all explained as behavior-changing controls.
- Search has Off, Workspace, and Web states.
- Attach supports File note, Website source, Knowledge source, and Skill path.
- Temporary mode explicitly affects persistence and background run creation.
- Run-scoped chat stays bound to one run unless the user chooses a fork, replay, or promotion action.
- Builder Chat proposals must be reflected in visible Studio fields before saving.
- Review Chat proposals must be applied through the Review Packet before they become saved review state.
- The target visual direction remains compact, native, and close to the input.
- The document does not require production UI, Web prototype, Swift, runtime, or data-model changes in this step.

## Implementation Notes For Later

- Introduce a durable submit request shape that combines scope reference, message text, selected controls, attachment references, source surface, and persistence intent.
- Keep scope reference separate from visual chips. The scope should key the thread and object binding, not only render a label.
- Treat Quick GUI controls as request inputs rather than view-only state.
- Persist message metadata only where the scope allows durable history.
- Keep temporary requests out of durable chat history and background run creation.
- Keep attachment references structured so they can later resolve to parsed file notes, website captures, knowledge records, or skill paths.
- Keep Review Packet and Loop Contract saves explicit. Chat can propose, but object surfaces must apply.
- Preserve user-facing language. Avoid raw provider ids, internal tool names, worker names, schema fields, artifact paths, or secret-like values in foreground UI.
- Later UI work should verify compact and wide layouts with long Chinese titles, mixed English ids, symbols, and multiple attachments.

## Use

Reference guidance for redesign and implementation.
