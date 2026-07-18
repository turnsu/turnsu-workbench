# Product Model Routing and Unified Model Selection Design

Date: 2026-07-18
Status: design decisions approved; written specification pending final review

## 1. Purpose

The Workbench needs one product-owned model selection and routing layer for Agent sessions,
Creator assistants, Workflow execution, and direct media generation. The layer must preserve the
existing Product Runner and Execution Broker ownership boundaries while supporting provider
protocols whose inputs and outputs are not interchangeable.

The first media integration is Stability AI's hosted Stable Image API. Local ComfyUI remains a
future adapter behind the same product contract. AUTOMATIC1111 is not part of this design.

This specification also closes omissions found after the Slice 0–4 reviews. It does not change the
previous release conclusion: the single-machine release remains `NO-GO` until the existing real
Provider, authoritative dependency audit, container image CVE scan, repeatable cold-start capacity,
and complete upgrade/rollback gates pass.

## 2. Current findings

The uncommitted model-routing implementation present when this design was prepared is useful as a
starting point, but it is not a completed feature. Static inspection found these gaps:

- the current profiles identify provider and model but have no modality, capability, immutable
  revision, parameter contract, or per-profile readiness semantics;
- Agent Sessions mutate one session-wide `modelProfileId`, which conflicts with the approved
  per-Turn selection and pinning behavior;
- compiled Workflow plans pin mutable profile identifiers rather than immutable revisions;
- fallback chains are not capability- or result-schema-aware;
- the current drivers only implement text/tool protocols and do not support image generation or
  image Artifacts;
- Builder proposal generation still has a path that bypasses the common Model Service;
- optional profiles can affect startup even when their credentials are not required for the active
  route;
- readiness does not prove that every selectable profile is usable;
- no frontend surface consumes the new catalog or lets a user choose a model.

These files must be preserved and reconciled during implementation; their presence is not evidence
that the capability is complete.

## 3. Goals and non-goals

### Goals

- Provide one model catalog and one selection component across Main Agent, Skill Creator, Loop
  Creator/Builder, Workflow model-backed nodes, and Run Settings.
- Keep user choice per Turn or task. A Session only remembers the last choice as a convenience.
- Pin the exact model profile revision before a Turn starts or a Workflow Run is compiled.
- Route by required capability first and provider protocol second.
- Support OpenAI-compatible Chat, Anthropic Messages, Gemini `generateContent`, and Stability Stable
  Image protocols without exposing their wire formats to product consumers.
- Add direct, typed, non-Agent model execution without creating a Pi Session.
- Store generated images as governed product Artifacts.
- Preserve Product Runner, Execution Broker, AgentTurnRunner, capability lease, fence, cancellation,
  and audit ownership.

### Non-goals

- A general public HTTP endpoint that bypasses Product Controllers to invoke arbitrary models.
- A frontend for entering or managing Provider credentials.
- Arbitrary user-supplied provider endpoints, raw Provider payloads, or raw ComfyUI workflows.
- ComfyUI, AUTOMATIC1111, local GPU fleet management, image-to-image, inpainting, video, embeddings,
  reranking, or vector search in the first implementation.
- Cross-model fallback for interactive Turns or first-version image generation.
- Rewriting historical V1 Runs, plans, proposals, or transcripts.
- Unrelated frontend redesign. The prior frontend freeze is lifted only for the model picker,
  capability-specific composers, Workflow model fields, history labels, and their direct tests.

## 4. Core decisions

### 4.1 Separate profile, capability, and protocol

The product must not treat a model name, a capability, and a provider wire format as the same
concept.

```text
Model Profile
  = a user-selectable, product-governed configuration

Capability
  = what the model may do in the current context

Protocol Driver
  = how the product translates the typed request to a provider
```

The initial capability set is:

- `chat`
- `tool_calling`
- `structured_output`
- `image_generation`

The initial protocol set is:

- `openai_compatible_chat`
- `anthropic_messages`
- `gemini_generate_content`
- `stability_image_v2`

`deepseek`, `openai`, and compatible custom Chat endpoints may share the OpenAI-compatible driver,
but remain distinct Provider identities for display, policy, usage, and diagnostics.

### 4.2 Unified does not mean universally selectable

The frontend uses one catalog and one picker component, but every surface supplies required
capabilities. The server repeats this validation and remains authoritative.

- Main, Skill Creator, Loop Creator/Builder, and Workflow Agent controller fields require at least
  `chat` and `tool_calling`.
- A surface that requires schema-constrained output, including Builder proposal generation, also
  requires `structured_output`.
- A model-backed image task requires `image_generation`.
- Stable Image must never appear as an Agent controller option.
- A text Agent may generate an image only through a governed image-generation Tool or model-backed
  task; the image model does not become the controller.

### 4.3 Per-Turn and per-Run pinning

- A user selects a model for the next Turn or task.
- Submitting the Turn freezes a `modelProfileRevisionId`; changing the picker affects only a later
  Turn.
- A Session may record `lastUsedModelProfileId`, but this is a preference, not execution authority.
- Workflow Drafts store profile identities and inheritance intent. Compilation resolves them to
  immutable revisions in `ExecutionPlanV2`.
- Retries of an existing attempt use its pinned route unless a new Product-owned attempt is
  explicitly created under review/retry policy.

## 5. Ownership and control chain

```text
Frontend model picker / Workflow editor
  -> Product API
  -> Model Catalog
  -> capability + authorization + readiness validation
  -> AgentTurnRunner or WorkflowRunner
  -> Execution Broker
       -> deterministic_skill
       -> model_call
       -> bounded_agent
       -> agent_orchestrator
  -> Product Model Gateway / Model Service
  -> protocol driver
  -> Provider
  -> typed result / Artifact
```

Ownership remains explicit:

- **Model Catalog** owns current selectable profiles, immutable revisions, capability metadata,
  policy, and readiness state.
- **AgentTurnRunner / WorkflowRunner** owns FIFO Turn or outer Run state, retry decisions,
  checkpoints, review, final status, and final result.
- **Execution Broker** owns invocation/attempt scheduling, isolation selection, leases, fences,
  cancellation propagation, and event transport.
- **Model Service** owns route validation, protocol-driver dispatch, same-route retry policy, safe
  Provider attempt records, and normalized usage.
- **Protocol drivers** own only Provider wire-format translation and response validation.
- **Artifact Service** owns image bytes, content metadata, retention, authorization, and retrieval.
- **Memory Service** is not involved unless a later governed Memory Candidate explicitly references
  an Artifact; model output never becomes durable Memory automatically.

The Model Service is an in-process logical boundary for the single-machine deployment, not a new
network service.

## 6. Model catalog and persistence

### 6.1 Entities

`ModelProfile` is the stable user-facing identity:

```text
ModelProfile
  profileId
  displayName
  currentRevisionId
  scope: global | workspace
  workspaceId?
  enabled
  createdAt / updatedAt
```

`ModelProfileRevision` is immutable:

```text
ModelProfileRevision
  revisionId
  profileId
  revisionNumber
  provider
  protocol
  providerModelId
  capabilities[]
  parameterSchemaVersion
  defaults
  limits
  credentialRef
  endpoint?
  policyVersion
  configHash
  createdAt
```

Secrets are never stored in either entity. `credentialRef` resolves through the single-machine
Keychain/Connection layer. A custom endpoint is immutable revision data and is restricted from
public responses. Provider endpoints are operator-controlled; HTTPS is required except for
explicitly enabled loopback development endpoints.

`WorkspaceModelRoutingPolicy` is the single truth source for workspace defaults and route policy:

```text
WorkspaceModelRoutingPolicy
  workspaceId
  defaultProfileIdsByCapability
  workflowFallbackAllowed
  policyVersion
  updatedAt
```

The implementation adds `006-model-routing` after the existing
`005-agent-proposals-and-active-branches` migration. It creates `model_profiles`,
`model_profile_revisions`, and
`model_routing_policies` with unique profile/revision/workspace, scope, enabled/current, and
configuration-hash indexes. Local configuration is an operator input that is imported
idempotently; it is not a second runtime truth source.

### 6.2 Readiness

Each current profile has a derived runtime state:

- `ready`
- `degraded`
- `unavailable`
- `disabled`

Missing credentials for an optional profile disable that profile; they do not crash the entire
server. Production readiness fails when a required workspace default has no ready revision.

Normal health checks must not incur image-generation charges. Configuration and non-billable
Provider checks establish operational readiness; a release-gated real smoke generation separately
proves the Stability path.

## 7. Selection and inheritance

### 7.1 Interactive Turn

Resolution order:

```text
explicit revision submitted for this Turn
  > current revision of Session last-used profile
  > current revision of workspace capability default
```

The server resolves and persists the exact revision before the Turn becomes runnable. If it cannot
resolve an authorized, ready, capability-compatible revision, the Turn is `blocked` with an
explicit code and no Provider request is sent.

### 7.2 Workflow

Resolution order per required capability:

```text
node profile override
  > Run Settings capability default
  > workspace capability default
```

Run Settings use separate capability defaults rather than one universal model field, initially:

- `agentControllerModelProfileId`
- `imageGenerationModelProfileId`

A Skill Definition may declare a fixed model-backed execution with `executionMode: model` and a
required capability. The compiler maps it to `model_call`; this avoids adding a second visual node
system merely for image generation.

Compilation stores the resolved `modelProfileRevisionId`, capability, normalized parameter schema,
limits, result schema, evidence requirements, and allowed fallback revisions in `ExecutionPlanV2`.

### 7.3 Fallback

- Interactive Turns do not cross models automatically.
- A transient failure may retry the same pinned revision within its retry and budget policy.
- Background Workflow fallback is allowed only when Run Settings explicitly enables and the
  compiler pins an ordered list of revisions.
- Every fallback revision must satisfy the same required capabilities, tool policy, result schema,
  workspace authorization, and budget class.
- Stability image generation has no cross-model fallback in the first version.
- Events and final results identify the requested and actual revision. No fallback is reported as
  an ordinary primary success.

## 8. Execution mode: `model_call`

The Execution Broker gains a fourth mode:

```text
deterministic_skill | model_call | bounded_agent | agent_orchestrator
```

`model_call` is a direct, typed, Product-controlled model invocation:

- it creates an invocation and attempt but no Pi Session or child Agent;
- `maxChildren` and tool permissions are zero;
- `maxModelRequests`, timeout, output bytes, image count, and cost/usage budgets are explicit;
- the route and result schema are fixed before dispatch;
- direct host execution reports `isolation: process`;
- a remote backend may accept it only if it advertises the mode; otherwise the Broker returns an
  explicit unsupported/unavailable result;
- `deterministic_skill` retains the existing invariant that it cannot make model requests.

The cancellation order remains:

```text
record cancellation
  -> revoke capability lease
  -> abort Provider request / Worker and children
  -> fence rejects late completion and Artifact attachment
```

A Provider may have already charged for a request that cannot be stopped. That fact is observable,
but a late result cannot change the cancelled Product attempt.

## 9. Product contracts

### 9.1 Invocation

```text
ModelInvocationRequest
  invocationId
  attemptId
  workspaceId
  modelProfileRevisionId
  capability
  typedInput
  limits
  capabilityLeaseId
  idempotencyKey
```

The initial typed input union is:

```text
ChatInput
  messages
  tools
  responseSchema

ImageGenerationInput
  prompt
  negativePrompt?
  aspectRatio?
  seed?
  outputFormat?
```

The public contract exposes only normalized fields supported by the selected revision. Provider
extras and arbitrary JSON are rejected.

An Agent Session Turn request is also explicit about execution kind:

```text
AgentTurnRequest
  kind: agent_message | model_task
  modelProfileRevisionId
  input
```

`agent_message` invokes the Pi controller and therefore requires the controller capabilities.
`model_task` compiles to `model_call`; the initial direct task is `image_generation`. Both kinds use
the same Session FIFO and persisted Turn/event timeline, but a direct image task does not create or
mutate a Pi Session. A later Agent Turn may receive a bounded Artifact reference through normal
context assembly, never raw image bytes.

### 9.2 Result

```text
ChatResult
  content
  toolCalls
  usage
  requestedModelRevisionId
  actualModelRevisionId

ImageGenerationResult
  artifactRefs
  seed
  format
  dimensions
  safetyStatus
  usage
  requestedModelRevisionId
  actualModelRevisionId
```

Provider request IDs may be retained in restricted operational evidence, but Provider payloads,
credentials, host paths, internal sockets, and raw Base64 are not public result fields.

### 9.3 Product API

- `GET /api/workbench/v1/model-profiles` accepts capability/context filters and returns authorized
  current revisions with selection/readiness state.
- `POST /api/workbench/v1/agent-sessions/{sessionId}/turns` accepts a typed Turn request and an
  explicit `modelProfileRevisionId`.
- The existing session-model mutation, if retained temporarily, updates only a last-used preference;
  it must not alter a running or queued Turn.
- Workflow Draft and Run Settings APIs accept profile identities in their capability-specific
  fields; compiled plans expose pinned revision identifiers.
- Existing Turn, execution-event, invocation, and Artifact APIs carry progress and results.
- No generic public `invoke model` or `invoke worker` endpoint is added.

## 10. Provider drivers

### 10.1 Chat drivers

The OpenAI-compatible, Anthropic Messages, and Gemini drivers translate the normalized Chat input,
Tool definitions, Tool results, structured-output constraints, usage, and stop reasons. Unsupported
features fail capability validation before a paid request.

All Pi controller paths use the same Product Model Gateway:

- in-process Main/Creator Agent sessions use an internal Pi adapter;
- sandboxed bounded/orchestrator workers use the existing authenticated local RPC/Unix socket;
- Builder proposal generation is migrated to this path and may not instantiate a private Provider
  client that bypasses Model Service policy.

### 10.2 Stability image driver

The first image driver targets Stability AI's hosted Stable Image REST API. It:

- converts normalized image input to the required multipart request;
- obtains credentials only from the host credential resolver;
- enforces timeout, maximum response bytes, accepted MIME types, and permitted output formats;
- validates image dimensions and decodability before Artifact commit;
- maps moderation, authentication, validation, rate-limit, timeout, and Provider failures to public
  error codes;
- writes successful bytes to the Artifact Service and returns references;
- never writes Base64 image content to Mongo events, transcripts, logs, or Agent context.

ComfyUI may later implement the same driver interface. Its workflow JSON would be a product-owned,
version-pinned internal template and would never become a second Product Workflow authority.

## 11. Frontend behavior

One reusable picker consumes the catalog, but the containing surface provides capability filters.

- Text/Agent selection shows Provider, display name, relevant capabilities, and availability.
- Selecting an image profile switches the eligible Main task composer to `ImageComposer`.
- `ChatComposer` and `ImageComposer` are explicit typed components; the frontend does not render an
  arbitrary Provider JSON schema.
- `ImageComposer` initially supports prompt, negative prompt, aspect ratio, seed, and output format,
  hiding fields unsupported by the chosen revision.
- Creator assistants and Agent controller settings never show image-only models.
- Model-backed Workflow Skill nodes show only profiles matching their declared capability.
- A disabled historical selection remains visible with its reason and requires deliberate
  reselection; the UI never silently substitutes another model.
- Turn/Run history displays the actual model revision and any fallback attempt.

## 12. Errors and observability

The normalized public error set includes:

- `model_route_unresolved`
- `model_profile_not_found`
- `model_profile_forbidden`
- `model_capability_mismatch`
- `model_revision_unavailable`
- `provider_auth_failed`
- `provider_rate_limited`
- `provider_content_rejected`
- `provider_timeout`
- `provider_response_invalid`
- `artifact_write_failed`
- `cancelled`

Errors preserve retryability and blocked/failed/cancelled semantics. Sanitization removes secrets,
authorization headers, prompts where policy forbids logging, internal endpoints, host paths, and
raw Provider bodies.

Every attempt emits safe events containing invocation/attempt, requested and actual revision,
capability, phase, latency, normalized usage, fallback flag, and failure code. Metrics separate
Provider, profile revision, capability, result, and latency without using prompt text as labels.

## 13. Migration and compatibility

- Add the new collections and indexes through `006-model-routing`; do not modify completed
  `003-agent-execution-fabric`, `004-product-memory`, or
  `005-agent-proposals-and-active-branches` migrations.
- Import valid single-machine V2 model configuration idempotently into profiles/revisions. Actual
  credentials remain in Keychain.
- Legacy `WORKBENCH_MODEL_*` and V1 configuration may be read to create a compatibility profile,
  but new writes use the revisioned catalog.
- Historical unpinned records remain readable and are marked `legacy_unpinned`; they are not
  rewritten to pretend an exact model revision was known.
- Existing V1 plans remain read-only. New compilations use the extended `ExecutionPlanV2`.
- Startup tolerates unavailable optional profiles, but production readiness rejects an unusable
  required default.

## 14. Verification and acceptance

### Contracts and catalog

- Capability/protocol/profile/revision schemas reject incompatible and provider-specific extras.
- Revision immutability, configuration hashing, workspace filtering, and current-revision updates
  are covered by persistence and restart tests.
- Missing optional credentials disable one profile without crashing unrelated routes.

### Execution and Agent integration

- A `model_call` creates no Pi Session, tools, or children.
- `deterministic_skill` still cannot issue a model request.
- Main Agent, Creator Agent, Builder proposal, bounded worker, and orchestrator child model traffic
  are proven to pass through Product Model Gateway policy.
- Two concurrent Turns can use different revisions without shared mutable selection.
- FIFO, timeout, cancellation, lease revocation, fence rejection, retry, and late Provider results
  are covered by negative tests.

### Workflow

- Node, Run Settings, and workspace inheritance compile to the correct immutable revision.
- An image-capability Skill compiles to `model_call`; an image model is rejected as Agent
  controller.
- Fallback compilation rejects capability, schema, permission, and budget mismatches.
- Old plans remain readable and unchanged.

### Stability and Artifacts

- Fixture tests cover multipart requests, binary and JSON/base64 responses when supported, content
  rejection, rate limiting, invalid MIME, oversized body, corrupt image, timeout, and cancellation.
- A release-gated real Stability generation produces a retrievable authorized Artifact and no raw
  image appears in Mongo events, transcript, logs, or Agent context.
- Artifact failure cannot produce a successful Turn or invocation result.

### Frontend

- Picker capability filters, disabled history, per-Turn switching, inheritance labels, and
  Chat/Image composer switching have component tests.
- End-to-end tests prove a text Agent Turn, a direct image Turn, a Workflow image Skill, history
  display, and explicit failure states.
- Frontend diffs are limited to the approved model-selection feature and its tests.

### Production gates

The feature is not production-ready based only on unit tests. Final release evidence must include:

- real Chat Provider and Stability Provider smoke runs;
- authoritative dependency/license audit;
- CVE scans for all release images;
- repeatable authenticated-Mongo cold start and capacity evidence;
- encrypted backup/restore plus full upgrade/rollback rehearsal;
- secret scan and proof that browser/Agent containers never receive Provider credentials.

Until all existing and new gates pass, release tooling must continue returning a clear `NO-GO` and
must not activate an incomplete candidate.

## 15. Primary references

- Stability AI API reference: <https://platform.stability.ai/docs/api-reference>
- ComfyUI workflow concepts: <https://docs.comfy.org/development/core-concepts/workflow>
- ComfyUI server routes: <https://docs.comfy.org/development/comfyui-server/comms_routes>
- AUTOMATIC1111 API documentation: <https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API>
