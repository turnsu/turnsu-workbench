# Skill Creation Realtime Copilot Design

- Date: 2026-07-31
- Status: approved for implementation
- Scope: M5 Skill creation only; conversation-assisted form completion, realtime voice, governed
  pre-Draft Agent session, deterministic form patches, and handoff to the existing Skill Creator
  Agent

## 1. Decision

The Skill creation experience will use a hybrid, conversation-led design:

- the seven-step wizard remains the visible, editable structured truth;
- a compact `让 Agent 帮我梳理` entry opens a co-creation Agent;
- the Agent accepts text and continuous speech-to-speech conversation;
- the Agent fills empty scalar fields and appends inferred material, parameter, and output rows;
- it never overwrites or deletes user content;
- every applied batch is visible, attributable, and undoable;
- it cannot create, test, validate, or publish a Skill without the existing explicit product actions.

The realtime voice path uses a Product-governed OpenAI Realtime profile. The initial compatible
provider model is `gpt-realtime-2.1`, selected through the product Model Catalog rather than exposed
as a hard-coded browser model.

## 2. Why this design

Three alternatives were considered:

1. Replace the wizard with a conversation. This is natural but hides required contracts and makes
   review and correction difficult.
2. Keep the wizard and add a shared co-creation Agent panel. This makes conversation the efficient
   input method while keeping materials, parameters, outputs, runtime choices, and review visible.
3. Add an isolated AI action to each field. This is a small change but fragments context and cannot
   coherently infer a Skill across steps.

Option 2 is selected. It improves the high-friction prose fields without weakening the explicit
runtime contract or introducing a second Skill Draft representation.

## 3. Current-system boundary

The existing `SkillCreatorAgentPanel` is object-bound and only becomes valid after a canonical
private Skill Draft exists. The creation wizard runs before that object exists. The implementation
must not create a fake Skill Draft merely to host a conversation.

The pre-Draft experience therefore uses a Product-owned `SkillCreationSession`:

```text
session scope = user × workspace × creationSessionId
```

This is an expiring working session, not a canonical Skill Draft, proposal, Memory, or execution
Run. It reuses the `skill_creator` Agent definition with a pre-Draft creation-session binding.

After the user explicitly creates the private Draft:

- the creation session ends or expires;
- confirmed responsibilities, decisions, constraints, unresolved questions, and source references
  may be handed to the object-bound Skill Creator Agent;
- raw audio and the complete creation transcript are not copied into the Module Agent transcript;
- canonical creation still occurs through the existing Product API and lifecycle service.

## 4. User experience

### 4.1 Entry and layout

The wizard heading gains one compact action:

```text
[✨ 让 Agent 帮我梳理]
```

- Desktop: open a right-side co-creation panel while keeping the wizard visible.
- At 390 px: open a full-screen sheet with a clear return action and preserved form state.
- The panel supports typed input even when realtime voice is unavailable.
- Starting voice requires an explicit user gesture and browser microphone permission.

### 4.2 Conversation behavior

The Agent:

- starts by asking who the Skill helps and what outcome it should produce;
- asks one short, adaptive question at a time;
- uses concise spoken responses and shows synchronized captions;
- supports semantic turn detection, interruption, mute, pause, resume, and end;
- shows a seven-section progress map rather than navigating the wizard automatically;
- calls out missing runtime, model, tool, connection, or material capability rather than inventing
  an available path;
- distinguishes a declared material requirement from a test sample and a real runtime binding.

The user may continue editing the form throughout the conversation. Manual input always wins.

### 4.3 Automatic filling

The approved automatic behavior is:

- scalar fields: `set_if_empty` only;
- structural collections: `append_if_absent` only;
- no overwrite;
- no delete;
- no automatic step completion, Draft creation, test, validation, or publication.

Each applied Agent turn forms one patch batch:

- newly filled fields and rows receive a short indigo highlight;
- a summary reports applied and skipped operations;
- `撤销本轮填写` restores only values still equal to the Agent-applied value;
- user edits made after application are never reverted by undo;
- a late patch based on an old revision is rejected or partially applied without overwriting newer
  user state.

When information is ambiguous, the Agent asks instead of producing a required contract from weak
inference.

### 4.4 State and failure feedback

The panel exposes these explicit states:

```text
idle
connecting
listening
thinking
speaking
paused
reconnecting
unavailable
ended
```

Required failure cases include:

- microphone permission denied;
- compatible realtime profile unavailable or forbidden;
- Provider credential missing or invalid;
- session budget or TTL reached;
- network interruption and failed reconnect;
- stale form revision;
- invalid or disallowed patch operation;
- creation session expired.

Voice failure does not silently select another model. When a governed text model is ready, the UI
may offer `继续文字梳理` as an explicit alternative.

## 5. Form patch contract

The model never emits arbitrary UI code or directly mutates React state. It may call one
server-owned tool:

```text
propose_skill_creation_patch
```

The Product API validates and normalizes the call into:

```text
SkillCreationFormPatch
  patchId
  creationSessionId
  baseRevision
  sourceTurnId
  operations[]
  rationaleSummary
  createdAt
```

Allowed operation families:

```text
set_if_empty(path, value)
append_if_absent(collectionPath, semanticKey, value)
```

The server maintains an allowlist of writable creation-form paths and validates values against the
same schema used by final Skill Draft creation. The browser applies a validated patch through one
deterministic reducer and returns an application receipt:

```text
SkillCreationPatchReceipt
  patchId
  resultingRevision
  appliedOperationIds[]
  skippedOperations[]
  appliedAt
```

`skippedOperations` carries stable reasons such as:

- `target_not_empty`
- `semantic_duplicate`
- `stale_revision`
- `invalid_value`
- `path_not_allowed`
- `capability_unavailable`

Patch batches retain bounded inverse metadata for undo. Undo is conditional and must not revert a
value that the user subsequently changed.

## 6. Realtime architecture

The selected transport is browser WebRTC with a narrow realtime media-plane exception. Product
authority remains on the server.

```text
Browser
  -> authenticated Product API creation-session endpoint
  -> Product Model Catalog and readiness validation
  -> Product API submits SDP + server-owned session configuration
  -> OpenAI /v1/realtime/calls
  -> SDP answer returned through Product API
  -> browser <-> OpenAI WebRTC media plane

Product API
  -> sideband connection to the same realtime call
  -> instructions, monitoring, budget, tool handling, cancellation
  -> validated SkillCreationFormPatch event
  -> browser deterministic patch reducer
```

The unified server initialization interface is preferred over returning a client secret:

- the browser sends SDP to the Product API;
- the Product API owns the standard Provider credential, exact model revision, instructions,
  safety identifier, voice, limits, and tool definitions;
- the browser receives only the SDP answer;
- business logic and form tools execute through the server sideband;
- the browser cannot nominate a Provider model ID or install arbitrary tools.

No long-lived Provider credential may reach the browser, Mongo document, Agent transcript, log,
test fixture, screenshot, or client bundle.

## 7. Model Catalog and routing

The frontend continues to select only a `modelProfileId`. The catalog and profile revision require
capabilities appropriate to the surface:

```text
realtime_audio_input
realtime_audio_output
realtime_turn_detection
realtime_barge_in
tool_calling
```

The Product Model Service resolves the profile to its immutable revision and provider model. For
the first OpenAI route, that revision may use `gpt-realtime-2.1`.

The UI must not display voice availability from a hard-coded provider name. It consumes the same
Product-owned readiness model as other creation capabilities:

```text
ready | needs_setup | checking | unavailable | forbidden
```

No profile, permission, credential, or compatible capability produces an explicit unavailable
state. There is no silent fallback to another voice or text model.

## 8. Data, privacy, and retention

- Raw microphone audio is not persisted by the product.
- Transcript text and patch events are scoped to the personal creation session and use a bounded
  TTL.
- Creation transcripts are not durable Memory Candidates by default.
- Form values enter the canonical Skill only when the user performs the existing Draft creation
  action.
- Logs contain event types, stable identifiers, durations, counts, and redacted error codes—not
  audio, full transcripts, Provider payloads, or form secrets.
- A privacy-preserving per-user safety identifier is set server-side when the realtime session is
  created.
- Cancelling or expiring the creation session closes the sideband connection and invalidates
  further patch events.

## 9. Authorization, concurrency, and recovery

- Creation sessions are bound to the authenticated user and workspace.
- A session cannot read or patch another user's working form.
- The Product API rechecks principal, workspace membership, profile permission, readiness, budget,
  session status, and expected form revision for every patch.
- One creation conversation turn is serialized; realtime audio may be interrupted, but two
  concurrent patch-producing responses cannot mutate the same form revision.
- Each patch and receipt is idempotent by `patchId`.
- Reconnect resumes only an unexpired session owned by the same principal.
- Fence/session-generation checks reject events from a replaced or ended realtime call.
- A refresh may restore the bounded working session and validated patch history, but never implies
  that a canonical Draft was created.

## 10. Product API boundary

The exact URI names may follow existing server conventions, but the public behavior must cover:

```text
POST   /api/workbench/v1/skill-creation-sessions
GET    /api/workbench/v1/skill-creation-sessions/{sessionId}
POST   /api/workbench/v1/skill-creation-sessions/{sessionId}/realtime-calls
POST   /api/workbench/v1/skill-creation-sessions/{sessionId}/form-snapshots
GET    /api/workbench/v1/skill-creation-sessions/{sessionId}/events?after=...
POST   /api/workbench/v1/skill-creation-sessions/{sessionId}/patches/{patchId}/receipts
POST   /api/workbench/v1/skill-creation-sessions/{sessionId}/patches/{patchId}/undo
POST   /api/workbench/v1/skill-creation-sessions/{sessionId}/end
```

There is no generic browser endpoint for arbitrary Realtime sessions or arbitrary function tools.
The Product API supplies the fixed Skill creation Agent definition, allowed fields, limits, and
tool contract.

## 11. Implementation slices

### Slice 1: Contracts and deterministic reducer

- creation-session, patch, receipt, event, readiness, and error contracts;
- allowlisted Skill creation paths;
- `set_if_empty`, `append_if_absent`, conditional undo, idempotency, duplicate detection, and
  revision tests;
- no Provider dependency.

### Slice 2: Product-owned creation session

- in-process/Mongo persistence consistent with existing test and production stores;
- personal scope, TTL, principal switching, cursor events, cancellation, and recovery;
- integration with current creation readiness and Skill Draft creation handoff.

### Slice 3: Realtime Provider adapter

- Model Catalog capabilities and immutable route validation;
- Product-owned SDP initialization;
- sideband lifecycle, tool-call handling, budgets, fence, cancellation, and redacted telemetry;
- a fake adapter for deterministic tests, clearly marked as test-only.

### Slice 4: M5 frontend experience

- compact Agent entry;
- desktop panel and mobile sheet;
- typed chat and realtime voice states;
- captions, microphone controls, reconnect, progress map, highlights, patch summary, and undo;
- integration with the existing seven-step form rather than a duplicate form.

### Slice 5: End-to-end validation and review

- real Product API with isolated `_test` Mongo;
- fake Realtime adapter for deterministic behavioral coverage;
- optional real OpenAI Realtime smoke only when a governed profile and credential are available;
- accessibility, 390 px interaction, production build, bundle budget, security review, and visual
  review.

## 12. Acceptance criteria

### Behavior

- A user can start a text conversation from the Skill wizard without first creating a Skill Draft.
- With a ready realtime profile, a user can start continuous voice, see captions, interrupt the
  Agent, mute, pause, resume, and end.
- A conversation may fill any empty scalar field and append unique material, parameter, and output
  rows across the seven steps.
- Existing user values are never overwritten or deleted.
- Concurrent manual edits beat late Agent patches.
- Undo never removes a subsequent user edit.
- The final action still creates only a private Draft; Test, Validate, and Publish remain separate.

### Routing and security

- The browser sends a `modelProfileId`, not a Provider model ID or Provider payload.
- The server validates realtime and tool capabilities and pins an immutable profile revision.
- Standard Provider credentials remain server-side.
- Form tools execute only through the Product sideband and fixed allowlist.
- Raw audio, full Provider payloads, and transcript bodies are absent from ordinary logs and
  durable Memory.
- Cross-user, cross-workspace, expired-session, stale-call, and stale-revision operations fail
  explicitly.

### Failure truthfulness

- Missing profile, credential, permission, browser media support, or Provider availability is
  reported distinctly.
- Fake adapters are never reported as real Provider evidence.
- A realtime failure does not silently downgrade or report the form as completed.
- Lack of a real Provider credential remains an environment-unverified gate, not a production pass.

### QA

- contracts and backend suites pass;
- reducer race, duplicate, undo, idempotency, and stale-revision tests pass;
- frontend production build, state smoke, M5 smoke, and bundle budget pass;
- feature E2E uses the real Product API and isolated `_test` Mongo;
- microphone and WebRTC browser behavior is tested with controlled media mocks;
- a real Realtime smoke, when possible, proves SDP initialization, sideband tool calling,
  interruption, cancellation, and secret non-exposure;
- independent review checks for client-side Provider configuration, transcript leakage, hidden
  overwrite, unsafe undo, stale event application, and bypass of final Draft review.

## 13. Non-goals

- Replacing the seven-step wizard with a chat-only interface.
- A general voice assistant shared by every product surface in this slice.
- Persisting raw audio or automatically promoting creation conversations to Memory.
- Letting the realtime model directly create, execute, validate, or publish a Skill.
- Browser-owned Provider keys, arbitrary model IDs, arbitrary session instructions, or arbitrary
  tools.
- Audio-file materials for executable Skills unless the existing Attachment and runtime catalogs
  separately declare and implement that capability.
- Treating a fake Provider, visual fixture, static assertion, or green build as real Realtime
  production evidence.

## 14. References

- [OpenAI Realtime and audio](https://developers.openai.com/api/docs/guides/realtime)
- [OpenAI Voice agents](https://developers.openai.com/api/docs/guides/voice-agents)
- [OpenAI Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [OpenAI Webhooks and server-side controls](https://developers.openai.com/api/docs/guides/realtime-server-controls)
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [GPT-Realtime-2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)
