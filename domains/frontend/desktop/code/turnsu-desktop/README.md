# Turnsu 工作台 Desktop

Local desktop implementation for Master PRD v0.6. This is a development build, not a signed/notarized
distribution or the completed cloud collaboration product. It does not load the Web workbench.

The current workspace adds a **工作台 / Skill OS** main navigation. Skill OS reads real project
Skill files for Codex, Claude Code and Pi, shows local capture drafts alongside fixed team methods,
and keeps Loop management as a secondary view. A selected project Skill is hashed and rechecked
before native send; viewing or preparing never invokes a model. The team catalog and existing
Product publication/Run paths remain authoritative for shared versions. Selected Button, Badge,
Input and Textarea primitives/tokens are adapted from the pinned company scaffold; see
[third-party notice](THIRD_PARTY_NOTICES.md). The shell is Electron 44.4.5. Windows packaging is separate from real Windows acceptance.

Local and cloud development/data ownership is defined in
[Desktop and cloud ownership](../../../../../wiki/architecture/desktop-cloud-boundary.md).

## Current path

The Electron window opens a project through the native folder picker. The private local Node host owns
SQLite project/session metadata, drafts and visible conversation output, and drives **installed Codex
CLI** through its official App Server protocol. Native history/credentials remain with Codex. The
desktop renders real native approval/question requests and provides project file listing/text preview.
The model menu reads the native catalog and persists the selection per task; it never changes global
Codex configuration. Drafts are isolated between tasks and between a new task and existing tasks.
Closing the app stops its host; interrupted work is not replayed automatically. Restore uses the same
native thread. Cloud membership, Skill/Loop publication and shared execution continue to belong to
the existing Product API and are not duplicated in the local database.

The desktop offers Codex, Pi and Claude Code. Pi uses the user's installed CLI (0.87.0 or later), account and native
resources via its RPC interface. It owns a separate native session per desktop task, preserves full
provider/model IDs, supports native extension confirm/select/input/editor interactions and cancellation,
and waits for settled execution rather than treating an intermediate `agent_end` as completion.
Pi uses its own local tool permissions; the UI does not claim it has Codex's sandbox or approval policy.
Claude Code uses the pinned official Agent SDK 0.2.132 with the user's installed CLI, native account,
settings and session files. Its default permission mode passes native approval/question requests to
the desktop, including multiple-choice questions and cancellation. Model selection stays within the
task. A provider error is not treated as a successful result, and stopping rejects late approvals.
Disconnecting one Agent leaves other Agents' pending interactions intact.
The optional **连接团队** dialog uses the existing Product browser approval and PKCE flow. A private
host-owned profile stores the desktop's rotating credential; tokens never enter the renderer. The
dialog reads actual accessible projects and project details through Product authorization, supports
cancel/retry and device revocation, and remains separate from local tasks. An invalid/expired credential or an uncertain refresh is removed locally so a fresh authorization
can proceed; an uncertain refresh never replays its consumed token. Temporary network
failure retains the credential but clears the project list rather than presenting stale access.
The connected desktop now offers **新建团队项目**: workspace administrators enter a name/optional
goal and explicitly choose existing workspace members from the narrow directory. Local SQLite retains
the reviewed request, member names and original retry key. Lost responses survive restart without
creating a second project; changing accounts cannot read or deliver another user's draft. A later
authorization failure does not discard an earlier uncertain creation. Product retains its existing
owner/admin requirement and rechecks current authority even when replaying an old receipt. This action
is exposed only through desktop control, not native model tools. Creation alone uploads no files or
private history; the next screen asks for the local sharing range. Real native-auth HTTP/PostgreSQL
checks cover selected-member access, creation/reopen/retry and subsequent file sharing; the native
form remains visually unverified while the Mac is locked.
The project detail now has **查看与管理成员**. Project owners can review additions/removals in a
compact roster; other members can read the list. The desktop currently exposes editing to the project
owner only, while Product retains its existing workspace-admin management authority. A private SQLite
review binds the original project ETag, audience, account and retry key. A concurrent change requires
rereading and confirmation; an uncertain receipt stays frozen across restart. Human desktop control
calls the existing `reviseProjectMembers` command, which reauthorizes receipt replay. Removal blocks
project/work reads and updates without remotely deleting already downloaded files or private sessions.
Real host/native-auth HTTP/PostgreSQL checks cover removal, lost receipt/reopen, one lifecycle mutation,
blocked new downloads, preserved old files and explicit re-addition. The macOS build passes; the native
member editor remains visually unverified while the Mac is locked. Project removal also revokes related
unfinished Agent borrowing requests and capability leases in the same transaction. Rejoining restores
project access but requires new borrowing consent; actual PostgreSQL/Broker checks verify old execution,
acceptance replay and output submission remain denied, while a newly accepted request works.

The shared-project entry can attach an empty local folder, or explicitly selected files/directories in
the current existing project, and synchronize them through the Product API. A selected directory includes
future ordinary files; unselected paths are excluded from uploads, downloads and deletion recovery.
SQLite retains the scope across restart without expanding legacy bindings or converting private sessions.
Local SQLite retains delivery receipts/outbox, not team permissions. Concurrent edits remain
separate until a member chooses a version. Files replaced by downloads remain under `.turnsu-local` for
recovery; hidden files, links and private native sessions are not uploaded. Agent work delays sync until
it settles. Current limits: 8 MB per file; recovery copies are not pruned.
Real two-member native-auth HTTP/PostgreSQL checks verify sharing existing work, teammate edits, deletion,
restart, retained private drafts/history and rejection of unselected files in team input before native
execution/publication. Local checks add initial name conflicts, offline recovery, single-file scopes and
symlink rejection. The new range picker has not been visually accepted while the Mac remains locked.
File deletions now propagate as immutable, recoverable Product revisions, distinct from empty files.
The existing PostgreSQL revision ledger and local SQLite outbox carry the deletion marker, original
baseline and retry key. Downloaded removals first retain the old local file in `.turnsu-local`; durable
incoming intents recover interrupted removal. Deleted files can be restored from the sync panel.
Delete/edit races preserve conflicting versions; review binds the displayed team revision, and both
devices converge after choosing either content or deletion. Files already absent before this upgrade
remain explicit restore/delete choices until locally observed, so an upgrade cannot silently propagate
old local removals. Real two-member native-auth HTTP/PostgreSQL checks cover deletion, restoration,
uncertain receipts, both conflict outcomes and restoration through successive deletion revisions.
SQLite/filesystem checks add offline reopen, interrupted removal and edits racing removal. The new
native sync-panel controls remain unverified while the Mac is locked.

The **团队工作** entry reads existing Product work items and creates a fresh, explicitly shared local
conversation with the chosen Agent. Before each request, it reads the current goal, recorded decisions
and latest 20 shared updates, confirms publication of the user's request, and then dispatches the native
Agent. Only the final visible answer is published; tool logs, injected reference packets and pre-existing
private conversations remain local. New work grants current project members participation explicitly;
Product still checks every read/write. Local durable creation receipts and an answer outbox recover lost
responses without duplicate publication. A different account cannot deliver the previous account's queue.
Normal team sending needs a live authorized Product connection; private local tasks remain independent.
After a temporary cloud outage, **用上次资料在本机继续** lets an existing contributor explicitly use
the saved team context and already saved file versions with their own Agent. The UI shows the context
time; the request and final answer stay in SQLite until reconnection rechecks access and delivers them.
Recovery does not rerun the Agent. Known denial, changed accounts and missing file versions cannot be
silently bypassed. This is resilience to Turnsu cloud outages, not offline model inference or permission
to run another member's Agent without a live grant.

The composer’s **@ → 团队方法** entry reuses the published Skill/native Loop catalog. Choosing a method
keeps the current Agent and prepares a new task with the saved input, file/work references and selected
model. Original drafts and native history remain untouched; team work keeps the same audience and
requires the original member connection. Preparation installs fixed dependencies but never starts a
model. Stale drafts are rejected, and retrying a choice reopens its prepared task. SQLite and real
HTTP/PostgreSQL checks cover carried drafts, actual published packages and controlled native input;
the new picker’s GUI remains unverified while the Mac is locked.

Contributors can choose **提交这份结果** on their own shared answer, inspect its complete text and fixed
files, and submit it to the accountable owner. The **工作成果** panel shows pending review, modification
feedback and accepted results; the owner explicitly chooses **需要修改** or **确认完成**. Requested changes
become the next action read by the member's subsequent native task. Original pending submissions survive
restart/uncertain responses with their ETag and retry key unchanged. Completed work retains its results
and can recover queued delivery, but cannot silently start another Agent execution. Real isolated
HTTP/PostgreSQL plus two local hosts verifies this cycle with controlled Pi output; SQLite recovery and
the macOS build pass. The new panel's GUI and real model quality remain unverified while the Mac is locked.

Owners can use **请同事接着做** to choose an existing contributor and explain the next step. Review
drafts can be saved locally; confirming uses Product's version-checked assignment, which adds the
assignee role without changing access grants or other roles. Unknown receipts keep the exact content
and retry key. The recipient sees **安排给我** and independently opens their preferred Agent; assignment
never starts their Agent, consumes their quota or marks the work complete. Real isolated native HTTP/
PostgreSQL checks cover lost receipts, stale previews, unchanged access, revocation and the recipient's
controlled Pi context. Native-window acceptance remains pending Mac unlock. This human-confirmed
handoff is not the still-required provider-capability borrowing or an unattended team environment.

The separate **同事的 Agent 协助** section now discovers incoming/outgoing requests, shows the fixed
published method and declared input, and requires the recipient to choose their own Pi API model and
explicitly accept before execution. This first profile handles text only: it cannot read the recipient's
project, private sessions or arbitrary tools. Personal subscription seats are excluded. Cloud Product
owns consent, membership and the invocation; SQLite owns the original pending submission and local
dispatch/result receipts. Lost acknowledgements, concurrent submissions, restart and cancellation are
covered by real isolated PostgreSQL/native-auth tests with the actual Pi SDK and a controlled provider.
The desktop UI is wired but still awaits native-window acceptance; real model-account quality and
two-member desktop acceptance have not passed. This is not an unattended team environment.

After building the app, its generated SDK chunk can be checked without a real model account:

```sh
.tooling/node/bin/node domains/frontend/desktop/code/turnsu-desktop/scripts/verify-host-bundle.mjs \
  .build/turnsu-desktop/Turnsu.app/Contents/Resources/local-agent-host
```

The **团队技能** entry discovers published instruction Skills through the current Product identity and
reuses the native connector installer for the selected Agent's project directory. It preserves package
references, rejects same-name conflicts/local changes, and opens a fresh local task without invoking a
model. From an existing team work session, the default is to continue that same Work Item; a separate
local task remains an explicit choice. A shared method task refreshes the work context and publishes
its request (with method/version) and final answer through the existing shared-work outbox. It does
not publish local installation paths or old private history. Product membership is checked before
creating that continuation and again at input admission. The selected release and task are durable
across retries/restart. Dispatch verifies the installed
files and release again, then explicitly references `SKILL.md`; an edited/replaced package cannot silently
substitute for the task's selected version. Already installed local work remains available without the
Turnsu cloud. New downloads and repeated installation requests require current Product authorization.
Desktop Skill capture and Product-backed publication are described below. The separate Work Item workflow entry uses
the Product execution service; adding a native Skill does not start that execution.

The team-work detail now offers **使用团队工作流**. Its catalog filters published Loop releases and
paginates them without consulting an author's private draft. Preparation creates the current member's
own fixed-version copy. Input remains in the private desktop draft until **运行并共享结果**; compilation
must be ready before dispatch through Product's existing workflow runner. The UI explicitly identifies
team-service execution and the member's authorized configuration, separate from native Agent execution.
Run receipts, not local guesses, supply status/results. Unknown submissions block another run and retain
the original input and idempotency key; reopening never automatically executes or replays a workflow.
The user can retry the original request to recover the same Run. Access is checked again, and switching
accounts cannot reuse another member's pending preparation.

The initiating member can now cancel an executing run or inspect a waiting review and explicitly
approve it, request changes, or reject/end it. Only this member can open the private review packet. Decisions bind to
the exact node attempt shown; stale decisions fail in Product's locked review transaction. Pending
control receipts survive desktop restart and replay their original payload/key without another
execution. Review text is no longer silently shortened to 1,000 characters; an oversized truncated
packet is labelled and cannot be approved in the desktop. Requesting changes requires a written change
and a configured direct upstream Skill with a text feedback input. Product reruns that Skill using the
existing execution configuration, then creates a fresh review attempt. It retains each candidate and
decision; the desktop currently displays the latest ten rounds and reports the count of older rounds.
Execution-configuration editing is not yet offered by this panel.

Real isolated native-PKCE/HTTP/PostgreSQL acceptance verified approval, rejection, active cancellation,
lost control receipts, restart/replay, and final capacity/capability closure. It also rejected an
execution status mutation without a governed cancellation command. Product upgrade requires migration
`039_workflow_cancellation_transition`; terminal consistency checks remain enforced. No provider
inference was used. The same real path also verified two successive revision rounds, accumulated
feedback, a lost revision receipt and host restart. Fault injection after the revised result was saved,
followed by lease expiry and a fresh runner, reopened review without repeating the completed Skill.
Native GUI interaction for these controls is still pending Mac unlock.

Completed local answers now offer **整理为技能**. This creates a private, durable task with the same
Agent/model and only the selected answer as reference; preparing the task does not call a model.
The normal conversation handles questions and refinement after the user sends. Internal file/format
instructions stay out of the visible composer. The host reads the actual independent `SKILL.md` from
the task's hidden draft directory, displays its entire bounded contents, and adopts only the exact
reviewed hash into the chosen Agent's project skill directory. Existing skills/local edits are preserved.
A new task can use that adopted method; it rechecks the file before dispatch. No global Agent settings
are changed and neither the source transcript nor the draft is automatically published.

Real SQLite/filesystem host tests cover restart/idempotency, same-Agent preparation, selected-answer
isolation, all three Agent directories, changed/linked/foreign-file refusal, and recovery after the file
was installed but its local receipt failed. Native model dispatch is controlled in these tests: method
quality, actual CLI discovery/execution and the new GUI are not yet accepted. This local capture supports
one UTF-8 instruction file up to 64 KB; attached scripts/references require a fuller package flow. It is
not a validated team release. Cloud Skill version updates remain incomplete. Loop draft capture is
described below; trial/publication must remain within the Product validation/publication authority.

The capture preview can now explicitly save that exact file as a private cloud Skill draft using
the existing native Product upload/inspection/promotion/creation APIs. Only the reviewed file is sent;
this does not publish to the team or call a model. Durable local transfer checkpoints bind to the
original account, immutable bytes and step-specific idempotency keys. An unknown result is reconciled
by explicit retry; it cannot be discarded as a failed upload. Definite inspection/name failures allow
explicit re-preparation, preserving already uploaded private objects. Existing upload permission
warnings are not silently acknowledged. Reopening does not submit anything.

Real native-auth HTTP/PostgreSQL/object-store acceptance covers exact-file persistence, private access,
no release creation and recovery from a lost accepted response. SQLite tests add restart, changed local
files, changed accounts, revoked reads and re-preparation. The UI still needs native-window acceptance;
editing an externally changed cloud draft is not offered by this panel yet.

Saved captured drafts now support a text trial, current status/full output, cancellation, and explicit
human approval before validation/publication as v1.0.0. Execution uses the member's Product-authorized
model/environment, not their native CLI account. Native tools forward the exact draft `If-Match`;
publication binds the inspected output and original test/draft revision. Trial and publication action
receipts survive reopening, never replay automatically, and block competing actions while uncertain.
Published skill files become accessible through the team library; trial inputs/outputs stay private.

Real isolated native-auth HTTP/PostgreSQL acceptance ran the existing Skill test runner with controlled
execution output, validated and published the captured package, downloaded its exact bytes as another
member, denied that member access to the private trial, and reconciled lost trial/publication receipts.
It exposed a PostgreSQL domain-array decoding issue in validation readback, repaired at the SQL owner.
SQLite recovery checks cover restart, cancellation, changed draft, unreviewed output and account switch.
This does not prove real provider quality or the new GUI. The panel currently handles independent
text-instruction captures and first publication; editing/version-updating cloud skills remains
unfinished. No provider inference was used by these acceptance checks.

Completed answers also offer **整理为 Loop**. Preparation creates an independent local task with the
same Agent/model and only the selected answer. An optional team catalog includes exact published
Skill versions and input/output contracts, never another member's private draft. The actual bounded
`LOOP.json` uses canonical Product schemas. The desktop shows goals, steps and readable input sources;
the complete file and compiler details are available on demand.

Explicit cloud save freezes the reviewed bytes, actor/workspace and retry keys. Local modifications
can be reviewed and saved as a new revision of the same private workflow using the current base/ETag.
An uncertain save retains its original payload even if the local file changes again. External cloud
edits block overwriting. Renaming an already saved workflow is not yet supported in this panel.
Saving or checking neither invokes an Agent nor publishes a team release.

Isolated native-auth HTTP/PostgreSQL checks cover published Skill discovery, private draft visibility,
lost create/save/update responses and exactly one accepted revision per reviewed update. Packaged
Tauri UI acceptance exercised preparation, missing-file recovery, local versus saved version review,
explicit update and dependency checking. The test workflow reports its missing cloud model honestly;
this proves draft transfer, not native Loop execution or end-to-end publication.

**准备本机试做** now prepares a separate private conversation with the selected Agent, the exact
reviewed recipe and verified published Skill files. It does not invoke a model; the normal Send action
does. Already prepared tasks do not require Turnsu cloud. **核对试做结果** displays the original goal
and completion criteria alongside the complete result. Explicit human confirmation saves only the
entered summary, result and review note to a private, version-bound cloud receipt. Frozen local
delivery state survives restart and lost responses; retry never invokes the Agent again.

Real isolated native-auth HTTP/PostgreSQL integration verified that path using controlled native
output, including no Turnsu cloud call during local execution, receipt recovery, and denial to another
member. Local SQLite tests and the packaged native build pass. The new trial dialog's GUI and real
model result quality are not yet verified. Saving a local receipt does not itself publish a team method
or grant cloud execution readiness.

After saving a reviewed trial, **让同事也能使用这个流程** offers explicit publication of the complete
fixed recipe and Skill pins. Trial inputs/results/review notes stay private. The local publication
receipt freezes version, actor/workspace, workflow revision and retry key. Unknown outcomes survive
restart; a definitely rejected duplicate version can be changed without replacing the existing release.
**团队方法 → 本机流程** downloads the immutable recipe for a selected native Agent, installs exact
Skill packages in its project directory, and prepares a task without inference. Local edits are
preserved and block execution until resolved. Existing cloud workflow selection excludes native-only
methods, whose cloud admission endpoints also reject them.

Real isolated Product integration covers native publication and lost response, a second member's native
PKCE login/download, Claude project installation, restart and a controlled native turn with Turnsu
cloud calls blocked. The consumer receives no author trial content or private draft. Migration checks
preserve existing release IDs/hashes and receipts. The supported first publication scope is sequential
Input/Skill/Output with published native-compatible Skills; branches, required review nodes, private
resources and personal model bindings are explicitly rejected. The new publication/reuse UI and real
model quality still need acceptance.

There is no team runtime, binary-file preview, terminal panel or historical CLI-session import in this
slice. The full v0.6 destination remains unchanged.

## Build / run (Electron)

Requires Node >=22.19, npm, and the chosen user's Agent CLI. Install pinned dependencies with
`npm ci` in this package and in `domains/agent/code/local-agent-host`. The existing Agent Runtime
SDK dependencies used by the Host bundle must also be installed. No Rust/Cargo or local Web server
is required. Electron supplies the Host's Node runtime through a utility process.

```sh
cd domains/frontend/desktop/code/turnsu-desktop
npm ci
npx install-electron  # if the package manager deferred Electron's runtime download
npm start
npm run package -- --platform=darwin --arch=arm64
npm run package -- --platform=win32 --arch=x64
```

Outputs are under `.build/turnsu-electron/Turnsu 工作台-<platform>-<arch>/` at repository root. macOS builds
use local ad-hoc signing; neither notarization nor Windows release signing is claimed. `build-macos.sh`
is a convenience wrapper. Original artwork is in `resources/`; `build-icons.mjs` compiles it on macOS.

`TURNSU_DESKTOP_STATE` selects an isolated absolute state directory. Default state keeps the previous
`ai.turnsu.desktop` directory (macOS Application Support / Windows AppData). The new app identifier is
`org.turnsu.workbench`, avoiding launch ambiguity with an old development bundle while retaining that
explicit data path. Its SQLite lock prevents
an old app and new app from using it at once. Closing the window saves the draft, asks before stopping
active work, and closes Host/owned native processes. An uncertain request is never retried automatically.
The former `TURNSU_DESKTOP_NODE` / `TURNSU_DESKTOP_HOST` overrides and Tauri build are retired.

## Model connections

**模型连接** adds company Gateway or another compatible endpoint. Keys are encrypted with Electron
`safeStorage` and are never returned by saved-connection reads or put into SQLite/Product. Unavailable
OS encryption blocks saving; there is no plaintext fallback. The default remains native Agent settings.
New tasks and never-started prepared Skill/Loop tasks choose a source explicitly. After connection or
submission the source is fixed. Connection endpoint/protocol changes require a new connection;
key rotation preserves identity and waits until related tasks stop. Historical task bindings prevent
removing their connection. No user-wide Codex/Claude/Pi configuration file is rewritten.

- Codex uses a dedicated App Server per selected Responses connection, with process-local environment
  credentials and explicit thread provider configuration.
- Claude Code uses Messages through the official SDK and a process-local environment.
- Pi >=0.87 loads a process-local provider extension (Responses, Messages or Chat Completions). The
  initial compatibility budget is 32K context / 4K output; gateway prices and quotas remain authoritative.

`/v1/models` discovery proves catalog access only. Model inference and tool compatibility must be
checked independently. SDK file-level licenses are preserved; no llm-gateway admin UI source was copied.

## Verification

Current Electron and model-connection checks (run from repository root):

```sh
npm --prefix domains/frontend/desktop/code/turnsu-desktop test
npm --prefix domains/frontend/desktop/code/turnsu-desktop run test:electron
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/model-connections.test.mjs domains/agent/code/local-agent-host/test/native-process.test.mjs
.tooling/node/bin/node domains/agent/code/local-agent-host/test/verify-native-gateway.mjs codex
.tooling/node/bin/node domains/agent/code/local-agent-host/test/verify-native-gateway.mjs claude
TURNSU_TEST_PI_BIN=/path/to/pi .tooling/node/bin/node domains/agent/code/local-agent-host/test/verify-native-gateway.mjs pi responses
```

The Electron smoke check uses real OS encryption and an actual utility process without a renderer.
Native gateway checks isolate native configuration in temporary directories and use a controlled local
HTTP service, not paid inference. Pi accepts `responses`, `messages` and `chat`; use Pi >=0.87 without
changing the user's global install. macOS UI verification and real Windows/provider acceptance are
recorded separately in the [current architecture](../../../../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md).

Existing persistence, native adapter and cloud-boundary checks:

```sh
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/local-work.test.mjs
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/project-skills.test.mjs
.tooling/node/bin/node --test domains/frontend/desktop/code/turnsu-desktop/src/refresh-queue.test.mjs
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/pi-work.test.mjs
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/claude-work.test.mjs
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/cloud-auth.test.mjs
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/shared-files.test.mjs
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/shared-work.test.mjs
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/team-methods.test.mjs
.tooling/node/bin/node --test domains/agent/code/local-agent-host/test/team-loops.test.mjs
WORKBENCH_POSTGRES_TEST_FILE=tests/http/postgres-project-files.integration.test.mjs .tooling/node/bin/node domains/backend/code/workbench-server/tests/store/run-isolated-postgres.mjs
WORKBENCH_POSTGRES_TEST_FILE=tests/http/postgres-desktop-cloud.integration.test.mjs .tooling/node/bin/node domains/backend/code/workbench-server/tests/store/run-isolated-postgres.mjs
```

These checks use real SQLite/filesystem and a controlled external provider. They establish draft
persistence, duplicate-submission protection, approval binding, cancellation and project path limits.
They do not substitute for a real model run and native desktop operation. A definitive send failure
retains the draft and exposes its failed receipt so the next explicit attempt receives a new key; an
uncertain provider receipt stays protected against duplicate execution and requires result review.

Work owners can now record an explicitly confirmed team Decision directly in the desktop. A compact
question/outcome editor with optional rationale keeps unsubmitted text in private local SQLite; the
canonical `recordWorkItemDecision` Product endpoint owns authorization, the immutable Decision and its
shared Thread event. Contributor suggestions are not automatically accepted as Decisions. Before the
mutation the desktop persists the exact payload and key; unknown receipts freeze that content and
replay the original request. A changed account, stale preview or non-owner cannot confirm it. Existing
shared-work preparation reads the confirmed Decision into subsequent native requests.

Real SQLite tests verified draft reopen, stale/unconfirmed rejection and restart after a lost receipt.
Real native-auth HTTP/PostgreSQL acceptance verified owner-only recording, a single Decision after a
lost response, and its arrival in another member's controlled Pi request. Host/native-tool regressions
and the macOS development build passed. The new editor has not been operated in the native GUI while
the Mac is locked, and this does not prove real model interpretation or Decision revision/supersession.

Project files can now be explicitly referenced from the desktop composer with `@`, a file picker,
or the existing file preview. Draft references persist with their own task; creating a native task
moves its text and references together. The host reads bounded UTF-8 files at submission, saves the
exact private snapshot before shared admission, and injects it as reference data for the selected
native Agent. Retrying an uncertain admission preserves those bytes across restart. History loads
the original snapshot on demand rather than displaying a subsequently edited file. Hidden paths,
links, outside files, binary/invalid text and oversized inputs are rejected before dispatch.

Team-task references require a synchronized, non-conflicting Product file revision and a fresh
permission-checked read of that exact revision. Unsynchronized local material cannot be attached to
team work through this path. Shared comments pin selected Product file revisions; local snapshots/native input
packets remain private. Real isolated HTTP/PostgreSQL acceptance verified unsynchronized-file denial,
lost admission receipt plus a later local edit, immutable revision reads, and reference delivery to
controlled Codex and Pi boundaries. SQLite/filesystem tests verified draft isolation, restart and
snapshot inspection. This does not establish model interpretation quality or native GUI acceptance;
the Mac was locked during this change. Current limits are four references, 64 KB each and 128 KB total;
the file picker filters the current directory.

Within a declared team task, the same `@` picker now offers shared progress and confirmed decisions,
with an explicit content preview and pagination for older entries. Product authorizes exact immutable
entry reads against both current Work Item and Project access; no new cloud table is introduced.
The local host checks the selected source identity/content digest, retains its private input snapshot
in the existing SQLite reference store, and rejects altered or private-session references. Cross-work
references require the same cloud project and a compatible current audience, as described below.
Sending does not republish the referenced body as a new shared result. Explicit outage continuation
can reuse a previously saved source; missing content never silently falls back to a different entry.
Real two-member HTTP/PostgreSQL integration verified a selected reply after 21 newer updates, its
exact content plus a decision and pinned file reaching controlled Pi input, offline reuse and revocation.
SQLite reopen checks cover drafts, uncertain admission, original snapshot inspection and known denial.
The packaged desktop build passes; native GUI and actual model interpretation remain unverified.


The picker now provides **来源工作** for another accessible work in the same project. Existing context,
entry-list and exact-entry reads accept `targetWorkItemId`; Product checks access to both works and
requires every current target reader to be a current source reader. No cloud reference or ACL table is
added. Local source snapshots remain fixed to their Work Item/object/hash and known source denial is
remembered across restart without denying unrelated target reads. Explicit offline continuation can
reuse only previously saved source content; a known denial cannot be downgraded to an outage.
Native history can retain earlier sources after their chips are removed. The host rechecks those
sources before later execution and persists their cumulative IDs on each shared outbox item. The
existing comment mutation accepts up to 64 `sourceWorkItemIds` and checks their current audience inside
the transaction, including old receipt replay. Thus reconnecting after source revocation or target
expansion cannot publish a queued request/answer to a broader audience. Restoring access can deliver
the original pending content without repeating Agent inference. New task preparation through Skill/Loop
selection preserves explicit cross-work draft references and validates them when sent.
Real native-auth HTTP/PostgreSQL and local SQLite/Pi-protocol integration verifies another work's
result/decision reaching controlled input, draft/restart, offline snapshots, blocked delivery after
revocation, one delivery after restoration and continued source declaration on later turns. Cloud
checks also cover cross-project rejection, broader target audiences and stale receipt authorization.
The macOS build and affected reference/method tests pass. The native picker remains visually unverified:
the latest attempt to open the packaged app again encountered the locked Mac. No real model inference
was performed in this acceptance.

Shared comments now accept bounded revision IDs through the canonical Product contract. The Product
transaction resolves them against the same Work Item project and current project membership, records
server-derived file metadata in the existing immutable Thread payload, and binds it into the command
and content digest. Clients cannot submit file contents or invented metadata through this field. The
native outbox preserves the exact revision IDs across lost receipts and reopening. Desktop shared
updates expose an on-demand “当时使用的资料” preview; each open rechecks Work Item and Project access
before reading the exact revision, without overwriting local files or revealing private native history.
Real HTTP/PostgreSQL acceptance verified another member reading the old revision after the current
file changed, rejection of a different project's revision, and denial after Work Item revocation.
The historical preview now offers continuation with the member's selected native Agent. This creates
an idle task and a persisted draft containing a version-pinned selection, without inference or local
file replacement. Preparing the same request again reuses that task; another account cannot reopen
its private session. The composer labels historical selections, and actual send resolves the exact
Product revision again after current Work Item/Project authorization. Read-only members cannot prepare
this route. Real HTTP/PostgreSQL acceptance verified Codex-to-Pi preparation with both cloud and local
files changed, exact original bytes in the controlled Pi request, no inference on preparation, stable
continuation receipts, and revoked replay denial. SQLite reopen tests verified pinned draft persistence
and rejection of forged/foreign selections rather than fallback to a same-named local file. Native GUI
acceptance and real cross-Agent model interpretation remain unverified.

The desktop now reads conversation history in bounded cursor windows (at most 40 messages and a
256,000-character page budget, except that one larger existing message is returned intact). Initial
open and live status refresh load the latest window; explicit older/newer navigation leaves stored
messages and native model context unchanged. Cursor ordering uses timestamp plus SQLite row identity,
so equal timestamps and newly appended messages do not shift or duplicate older records. Capturing an
older answer reads that explicitly selected record directly. Real SQLite/public-host tests verify
complete bidirectional traversal, preserved long answers and historical Skill capture.

A reproducible synthetic load check through the actual private stdio host entry is available at
`domains/agent/code/local-agent-host/test/benchmark-history.mjs`. With 2,400 synthetic messages, before/
after runs on this Mac reduced a session read from 9,915,027 to 165,706 serialized bytes and the median
of five reads from 43.2 to 1.3 ms. Host spawn-to-first-workspace response was approximately 0.4 seconds
in both runs. These are host/transport measurements, not Tauri launch or rendered scrolling evidence.
The changed native history controls remain visually unaccepted while the Mac is locked.

Task switching now saves only the currently loaded editor, ignores stale selection responses and
keeps unsaved input in place when saving fails. Failed destination reads cannot write empty drafts;
an explicit retry restores the stored text and references. Model discovery results are scoped to the
originating selection and do not prevent navigating to another local task after session creation.
Real SQLite tests drive the renderer's navigation owner through delayed reads, save/read failures and
reopening; the macOS build passes. The current packaged host was also measured with 2,400 synthetic
messages: spawn-to-first-workspace response 95 ms, five latest-page reads 1.2–2.0 ms (40 messages,
165,765 bytes). These numbers exclude GUI startup/rendering and model/cloud execution. The native
window check still encountered the Mac lock screen, so actual switching/rendering remains unverified.

Actual macOS acceptance: native folder picker opened an isolated temporary project; after restarting
the app the existing native thread continued using the model selected in the desktop and created
`result.md`. The desktop Markdown preview and a direct filesystem read matched the requested content.
The existing CLI rejected its globally configured GPT-6-Astra, and selecting an available GPT-5.6-Sol
recovered the task. No native permission prompt was required for this project-local write, so approval
rendering is not yet accepted against a real provider request. Abrupt-exit recovery remains unverified.

Pi evidence: an isolated installation of the official 0.87.0 CLI completed a native handshake and
model discovery. `test/verify-pi-native.mjs <absolute-pi-binary>` verifies real extension dialogs,
response correlation, immediate-command completion, duplicate input protection and cancellation
without a model call. The desktop Agent selector and installed-0.74 version error were checked in the
native window. Global Pi was not upgraded; user confirmation remains pending. Real Pi model execution,
file generation and continuation after such a run remain unverified.

Claude evidence: both the source host and the bundled host completed actual SDK initialization with
the installed Claude Code 2.1.132 and returned its native model catalog. The rebuilt native app also
displayed that catalog through its Claude Code selector while retaining the previous Codex result
and draft. Controlled SDK checks cover question/approval binding, late-response rejection, provider
error handling, cancellation and session/model retention. No Claude model task has been sent on this
adapter; provider inference, real approval rendering and continuation after inference remain pending.

Cloud connection evidence: a disposable `_test` PostgreSQL instance and real HTTP Product server
completed registration, browser-bound approval, the desktop's actual PKCE loopback callback, project
read, credential persistence/reopen, server-side device revocation, denied reads and fresh login
cancellation. Separate checks cover cross-origin approval rejection, cancellation closing the callback
without saving credentials, and dead-lock recovery without taking a live credential owner. This is
connection/authorization acceptance. A separate `postgres-project-files` test drives two independent
native logins and two real SQLite-backed folders through byte-exact transfer, conflict preservation,
version resolution/convergence and member revocation. No model inference is used in these file tests.

Native UI evidence: the packaged app displayed the team connection dialog with keyboard focus in
the address field; an unavailable local endpoint produced the expected retry message, and closing
the dialog returned to the preserved local task. The entire browser approval flow has not yet been
operated through the GUI against the isolated server.

Shared-files native acceptance: an isolated real Product account/server supplied the development app's
credential. The actual window joined a project using the native empty-folder picker, displayed a
downloaded file, paused/resumed sync, previewed a real conflict and selected its local version. A separate
HTTP read verified the resulting current revision and cleared conflict. The rebuilt window displayed
the shared project title and explicit “文件与团队共享 · 对话仅在本机” scope. This does not validate browser
approval clicks, two simultaneous GUI users, or real cross-Agent model continuation.

Team-context evidence: two native local hosts and independently authorized Product accounts used real
HTTP/PostgreSQL to create work, publish a Codex answer, record a decision and prepare a Pi continuation.
The Pi input contained the shared answer and decision, without private-history/tool-log sentinels. Lost
creation and answer receipts recovered without duplicates; read-only membership prevented dispatch,
and revoked membership denied both new input and replay of an earlier comment receipt. These tests
control the model boundary: they do not prove real cross-Agent inference. The updated native window's
team-work flow still needs visual/interaction acceptance; the Mac was locked at the attempted check.

Desktop Skill reuse evidence: the real isolated Skill publication/HTTP/PostgreSQL scenario now uses the
local host with a separate PKCE-authorized desktop credential. It verifies the published catalog, exact
installed package/reference bytes, no inference on adding, retry identity, and the selected `SKILL.md`
path reaching native dispatch. Revocation prevents another download; the author's next private draft
remains inaccessible. The same scenario also verifies selecting that method for a shared Work Item,
carrying its goal to native dispatch, publishing method/version and answer under the actual member,
excluding private history/local paths, and refusing new selection and dispatch after a read-only downgrade.
Provider dispatch is controlled. Local checks cover restart, modified/version-changed
packages and continued use of an already installed method while cloud is unavailable. The new native
skills dialog still requires visual/interaction acceptance after the Mac is unlocked.

Desktop Loop evidence: the isolated B2 scenario now composes the actual local host, native PKCE profile,
Product HTTP, PostgreSQL read/write owners, compiler, admission and runner. It verifies release-filtered
pagination, a member-owned copy, a real completed shared Run, lost-HTTP-receipt recovery across host
restart, one result visible to both members, and denial after revocation. The execution capability is a
deterministic echo with no provider calls. Separate local checks cover blocked compilation, persistent
input, concurrent key reuse and account switching. This does not validate model-based Loop execution,
the new desktop panel's rendered interaction, or a team always-on host.
