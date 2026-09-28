# Desktop and cloud ownership

The confirmed product direction is a local Agent workbench with optional workspace collaboration.
Local execution must work before cloud setup. The two applications are developed and verified
independently in this repository, then integrated through the public Product API.

## Code and data

| Owner | Code | Authoritative data | Must not own |
| --- | --- | --- | --- |
| Desktop renderer | `domains/frontend/desktop/code/turnsu-desktop/src` | Window state and user interactions; transient key entry for explicit save | Saved provider secrets, team permissions, direct SQL/filesystem/Node access |
| Desktop main process | `domains/frontend/desktop/code/turnsu-desktop/electron` | Window/Host lifecycle, native dialogs, OS-encrypted local model connection keys | Team ACL, native Agent global credentials/settings, business SQL |
| Private local host | `domains/agent/code/local-agent-host` | Local SQLite: projects, native session references, drafts, exact pending submissions and sync receipts; project files remain in their actual directory | Team ACL, publication decisions, direct PostgreSQL connections |
| Native adapters | `domains/agent/code/agent-runtime/integrations/native` and local host Codex/CC/Pi adapters | Native processes and protocol interactions; native credentials/history stay with the user's Agent; explicitly selected gateway keys exist only in that private execution path | Automatic access to another member's machine or account |
| Cloud Product | `domains/backend/code/workbench-server` | PostgreSQL: workspaces, membership, shared work, decisions, file revisions, immutable releases and delivery receipts; object storage: explicitly shared/versioned content | Local directories, private native history, execution merely because a task was assigned |
| Shared protocol | `domains/backend/code/workbench-contracts` and `domains/frontend/shared/code/product-client` | Request/response schemas and HTTP client mapping | A second store, permission service or execution engine |

The desktop build bundles public contracts and the HTTP client, but rejects dependencies on backend
implementation packages and PostgreSQL drivers. No local HTTP server or local PostgreSQL is required.
The renderer talks to its private host through a sandboxed Electron preload and private utility-process messages; the host alone holds the optional
rotating Product credential. Explicit model connection keys are decrypted in the main process and
passed only to the private Host and selected native Agent; saved-profile reads expose metadata only.
They are not Product credentials and grant no team permissions. Neither side opens the other's database.

## Interaction rules

1. Opening a local project, preparing a task, selecting a native Agent and resuming its session use
   the local host. Provider connectivity may be required for inference; Turnsu cloud is not.
2. Joining a workspace establishes the audience and declared shared area. Product reauthorizes reads
   and delivered mutations. Local cached context and sync state are not authorization sources.
   An existing local project can declare specific file/directory paths. SQLite persists that local sync
   scope; unselected directories and pre-existing private sessions are not included. Cloud membership
   still owns access to the shared revisions, independently of a device's selected local paths.
3. Before a cloud mutation the host records the exact reviewed content, actor/workspace, base revision
   and retry key. Unknown outcomes retain that content. Reconnecting or reopening never replays Agent
   execution. Account changes cannot submit another member's queued content.
4. Cloud state remains authoritative for shared objects. Conflicting files preserve both versions;
   stale workflow writes fail against the current revision/ETag. Private native transcripts and
   credentials are excluded from the shared payload.
5. Skills/Loops use fixed published versions. A member's private edits do not change a teammate's
   selected release. Local invocation is distinct from an explicitly configured team execution host.
6. Shared file removal creates an immutable cloud deletion revision. Local SQLite retains the exact
   pending mutation and recoverable filesystem operation; prior content remains available for restore.
   Delete/edit conflicts preserve both outcomes. Files already missing before the deletion-sync upgrade,
   including those with old pending uploads, require an explicit restore/delete choice.
7. Creating a team project uses a human desktop action and the existing Product command. SQLite keeps
   the reviewed name/member selection and retry receipt, while PostgreSQL alone owns the new Project
   and grants. Creation does not bind local folders or upload their contents automatically.

8. Project member changes use the existing Product membership command. Local SQLite keeps the reviewed
   member set, original project ETag and fixed pending receipt; it never grants project access. Cloud
   receipt replay rechecks management authority, and stale changes require another explicit review.
   Removed members cannot fetch new project/work content; already downloaded bytes remain on their
   devices. Related unfinished Agent borrowing and capability leases are revoked transactionally;
   rejoining needs new borrowing consent. Workspace administrative authority is separate from this
   project member list.

9. Cross-work references stay in one project. Cloud reads and shared comment delivery verify that all
   current target readers can read each declared source, including receipt replay. SQLite stores exact
   private snapshots, known source denials and original outbox source IDs; it does not authorize sharing.
   Later turns retain source declarations because native history may retain their contents. Offline
   continuation uses previously saved references, and reconnect checks access before sharing results.

## Independent development and integration

The local owner changes desktop, local host and native adapters, using controlled native-protocol
tests and real SQLite/filesystem checks without a cloud service. The cloud owner changes Product,
PostgreSQL/object-store persistence and public contracts, using isolated `_test` databases and real
HTTP authorization. Shared contract changes are agreed before integrating clients. File ownership
must remain disjoint during parallel implementation.

Integration uses the packaged native app with an isolated Product instance and distinct member
credentials. Verify actual declared files/results, cross-Agent continuation, restart, lost responses,
conflicts and revoked membership. Controlled providers prove transport/state behavior only; actual
Agent execution and useful results require separate real-provider acceptance.

## Current boundary and remaining work

Local Codex/CC/Pi adapters, shared-file/work synchronization, native Skill installation and reviewed
Loop draft transfer exist. Loop capture can save and update the same private cloud workflow while
preserving uncertain submissions; its dependency check uses the existing Product compiler.

Existing shared conversations now offer explicit local continuation after a recognized cloud outage.
The last saved context and already saved fixed file revisions can feed the member's own local Agent;
the desktop marks their age and queues the declared request/final answer in SQLite. New remote reads
and publication still require current Product authorization. Known denial or account/device changes
cannot be treated as a network outage, and a recorded denial survives reopen. Reconnection submits
the fixed queue without another Agent execution. Borrowed Agent requests and cloud runs never inherit
this local-continuation behavior. Real PG/native-auth integration covers controlled Pi continuation and
reconnect; real SQLite reopen tests cover queue/denial persistence. GUI and actual provider acceptance
remain separate outstanding checks.

Result submission/review follows the same split: the desktop selects an immutable shared answer and
collects explicit human confirmation; local SQLite persists its exact pending action and original ETag.
Cloud Product authorizes the contributor/accountable owner, fixes the entry/hash/file references and
atomically records review, work status and requested next action in its existing PostgreSQL lifecycle
ledger. Native Agent tools cannot directly invoke these human-control endpoints. Unknown receipts retry
the saved action without another native turn; completed work blocks new execution while keeping queued
delivery recoverable. Real two-member native-auth/HTTP/PostgreSQL integration covers revision feedback
reaching the next controlled Pi request and final acceptance. GUI and actual model acceptance are pending.

Local Loop preparation now creates a private native task with frozen recipe and verified Skill files.
It can execute without Turnsu cloud once its dependencies are installed. Explicit human review can
save the chosen input summary, complete result and review note through the canonical Product API.
SQLite retains the original submission across restart or uncertain responses; PostgreSQL stores an
immutable, private, revision-bound `member_attested_local` receipt. It is not a cloud execution record.
Real isolated HTTP/PostgreSQL integration covers delivery and recovery with controlled native output;
real model quality and the new trial dialog's native GUI remain unverified.

Locally tried sequential methods can now be explicitly published to the existing workspace library.
Cloud stores separate immutable native Loop versions and Skill pins; it does not relax cloud Loop
compile/run gates or fabricate cloud execution records. The package contains the reviewed recipe and
fixed dependencies, excluding private trial content. Consumers choose their own Agent and prepare a
private local task. Existing cloud-run entry points reject native-only versions.

Real isolated integration covers owner publication, lost-response recovery, another member's native
PKCE login/download, project-scoped Claude Skill installation, restart and execution with Turnsu cloud
disabled using controlled native protocol output. Migration checks preserve existing releases and
receipts. GUI and real-model acceptance remain outstanding. The first native publication path supports
linear Input/Skill/Output recipes only; unsupported control nodes, private resources and personal model
bindings are rejected. Cloud model setup is not a prerequisite for local work. Revocable isolated Agent borrowing
and a separately configured always-on team executor also remain incomplete. Human assignment alone
does not grant execution permission.

## Provider execution boundary being implemented

Member capability borrowing must use an explicit request and provider acceptance. Existing device
workers only admit the device owner's deterministic execution with no model calls; this path is not
being loosened to accept another member's input. The separate business controller is
`member_agent_request`, linked to existing Product Command/Admission/Invocation/Attempt records.
The requester is provenance; the accepting provider remains the execution principal and device owner.
Request consent state does not duplicate Invocation execution state. The separate cloud service now
freezes a published text method and declared input, authorizes both members, and binds explicit
provider acceptance to that provider's native session and registered Device. Request/accept/decline/
cancel/read/check/output use public contracts. Results settle through the existing Broker; clients
cannot write an arbitrary completed state. Deterministic Device worker gates remain unchanged.

The local `restricted-pi-execution.mjs` adapter now implements `pi-declared-text-v1` against the existing
Pi SDK 0.85.1. It exposes only opaque-ID `read_input` and text `write_result` tools, uses independent
in-memory settings/session state, and disables discovery of personal context, extensions, Skills and
templates. The trusted host supplies the fixed method text, declared input, selected model/auth runtime,
authorization callback and bounded request/output/deadline limits. No shell, arbitrary file/network
tool or native personal history is exposed. This is tool/context confinement for text methods, not an
OS sandbox for arbitrary code, extensions or every published Skill.

Actual SDK tests with a controlled provider verify rejection of hostile shell/file calls, absence of
private context/auth in model input, grant revocation between turns and during an active model request,
deadline and request limits, refusal of incomplete results, and no second run of the same adapter.
The local host now has a SQLite dispatch fence and fixed-result outbox, keyed by cloud/workspace/
provider and Invocation. It commits before creating an executor; a changed contract, attempt or fence
cannot replay that Invocation. Opening after an abrupt process exit marks the attempt interrupted.
Retrying sends only the original result or interrupted/failed outcome, never a second model request.
Actual SDK plus SQLite checks cover result-delivery loss and reopen; a child-process SIGKILL check
covers a real interrupted dispatch. Output is UTF-8 byte bounded and excludes SDK transcripts.

Desktop control calls use the same rotating native credential as ordinary Product calls, but accept,
device registration, authorization checks and result submission are absent from Agent tools. The
local transport checks the complete unchanged ticket and live fence/lease before execution, and
passes only declared results to the Product output endpoint. Receipt validation requires matching
attempt, fence, delivery ID and the Broker's terminal status; an unconfirmed response remains pending.

Real isolated PostgreSQL/HTTP integration now covers requester/provider identities, native PKCE and
Device registration, Command/Admission/Broker settlement, and this local SDK/SQLite transport. Losing
the output acknowledgement and reopening only resends the original output. Requester revocation
through HTTP aborts the active SDK stream and shares no cancelled output. Service restart revokes
the old lease and fences the old attempt; unfinished text execution becomes `partial` with
`member_agent_restart_outcome_unknown`, never an external-effect receipt or automatic replay.
Acceptance interrupted before Invocation registration leaves the existing Command blocked and a
clear registration-interrupted response. Backend failure before dispatch no longer leaves HTTP
waiting indefinitely. Local account usage is explicitly `local_unmetered`, with unknown cost and
model-call accounting represented as null; ordinary cloud execution keeps its numeric budget gates.

The desktop Team Work view now mounts request discovery, a compact method/member/text request,
input review, explicit model-account consent, decline/cancel and result recovery. The normal host
dispatcher owns these actions; SQLite persists the actor, cloud identity, exact payload and original
idempotency key before cloud submission. Real native-auth/HTTP/PostgreSQL checks verify that lost
create/accept responses survive host restart and resume the original action without duplicate model
execution. Paginated cloud discovery rechecks membership and exposes only requests involving the
viewer; displayed method names and versions come from the fixed published version.

The runtime reads available Pi API accounts only on demand, excludes personal subscription seats,
and creates/removes a private execution directory per accepted text task. The macOS package bundles
the pinned SDK as lazy chunks and includes its MIT notice and dependency notices. A generated-bundle
check executes declared-input/result tools with the actual SDK and controlled provider; a separate
packaged stdio check opens a local project with no cloud or configured account. No live model account
was used by these checks. They do not prove real model quality or dollar-cost enforcement. The native
UI remains unverified while the Mac is locked; real two-member desktop acceptance is still required.
Full-server validation evidence is in the isolated
`verify-member-agent-requests.mjs` fixture and local `verify-member-agent-desktop.mjs` companion.

Design sources: [Pi SDK boundary overrides](https://pi.dev/docs/latest/sdk) and
[Pi isolation boundaries](https://pi.dev/docs/latest/containerization). Native Codex restricted-read
support was checked against its installed generated App Server schema and
[official read-access documentation](https://learn.chatgpt.com/docs/app-server#sandbox-read-access-readonlyaccess);
ordinary workspace-write configuration alone does not establish a borrowed-task read boundary.
