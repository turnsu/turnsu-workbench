# Turnsu 工作台 — Current System Architecture

- Updated: 2026-09-28 (名称与当前迭代入口；下文实现证据仍以各自日期为准)
- Status: current implementation truth
- Baseline: isolated PostgreSQL standard-startup gate green; external production release remains `NO-GO`
- Product authority: [Master PRD v0.6](../prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md)
- Decision record: [Master PRD / Blueprint cross-review](../prd/2026-08-04-cross-review-master-prd-vs-blueprint.md)

This file records current consumers and current evidence only. It is not a roadmap, a second PRD,
or a rolling test ledger.

**2026-09-22 product correction:** the owner stopped Web/mobile-first iteration and confirmed
LinkCode + [Tutti](https://tutti.sh/zh) as the reference for a local desktop workbench with cloud
shared projects. Master PRD v0.6 supersedes the prior delivery order. The current Web build and
standalone native connector remain implemented assets; neither is a shipped native Agent workbench,
offline local workspace, synchronized team filesystem or Tutti-style cloud runtime. The separately
implemented desktop development slice below establishes local Agent work and bounded shared-file
synchronization; it does not establish a team runtime. Earlier fixed cross-surface directions below
are historical target decisions, not implemented consumers or the current priority.

### Local desktop implementation

**2026-09-28 Turnsu 工作台迭代（当前工作区，尚未进入双平台发行验收）：**桌面主导航
已收敛为「工作台 / Skill OS」，Loop 放在 Skill OS 的次级列表。Skill OS 通过本机 Host
只读列出当前项目的 Codex / Claude Code / Pi 项目技能文件与既有成果草稿；团队固定版本
仍调用现有 Product 方法目录。本机技能查看不执行模型，准备新任务时绑定所选文件哈希，
发送前再次核对，变化则拒绝旧版本。已有团队 Skill/本机 Loop 固定版本使用和云端
Work Item Loop 运行接口没有被替换。桌面选择性移植公司脚手架的按钮、输入、徽标与主题
token，并保留上游 MIT 归属；Host 刷新按顺序读取且保留末次事件，避免重叠序列化。
本轮真实 SQLite/文件及受控 Agent 检查覆盖技能读取、软链接拒绝、版本变化与重开准备；
macOS 开发包构建及空目录的真实 GUI 导航/目测通过。已填充技能的 GUI 使用、真实 Agent
成果、Electron 同负载对照和 Windows 设备操作尚未完成，不能据此声称跨平台发布或
资源优势。[本轮方案](../design/2026-09-28-workbench-skillos-iteration-plan.md)与
[内存调研](../design/2026-09-28-desktop-framework-memory-research.md)记录尚需验证的决策。

The [desktop/cloud ownership boundary](desktop-cloud-boundary.md) defines separate code, databases,
execution responsibility and independent-development/integration checks. Native execution belongs to
the local host; cloud collaboration remains a separately authorized Product API.

[`turnsu-desktop`](../../domains/frontend/desktop/code/turnsu-desktop/README.md) is a Tauri 2 macOS
development app with its own bundled React entry, not a browser pointed at the Web workbench. Its
Rust process owns a private stdio connection to
[`local-agent-host`](../../domains/agent/code/local-agent-host/host.mjs). Local SQLite stores project
references, task drafts, native thread references, visible messages and submission receipts. Native
Codex retains its credentials and original history. There is no local HTTP listener or cloud login
dependency in this path; online model inference still requires the provider.

The installed Codex CLI is driven through App Server: initialize, thread start/resume, turn
start/interrupt, events, approval/question responses and model discovery. Model selection is scoped
to the Turnsu task and does not modify global Codex configuration. An actual desktop operation opened
an isolated project through the native folder picker, resumed a native thread after restarting the
app, selected GPT-5.6-Sol and created `result.md`; the desktop file preview and filesystem both showed
the requested Chinese heading and two bullets. The initially configured GPT-6-Astra was rejected by
the installed CLI version. This failure led to model selection and a readable recovery message.

Automated checks use real SQLite/filesystem with a controlled provider boundary for persistence,
task-specific drafts, duplicate input protection, exact approval binding, interruption and file-path
confinement. This actual model run did not trigger an approval; real native approval interaction and
abrupt-exit recovery remain unverified.

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

The desktop now also has a Pi RPC adapter and an Agent selector. Each Pi task owns a separate native
session file; model selection, prompt admission, visible events, cancellation and extension dialogs
are bound to that task. The adapter requires Pi 0.87.0 or later to use full-run state and
`agent_settled`; intermediate `agent_end` does not complete a task. It does not claim to add a sandbox
to Pi's own local tool configuration. The installed 0.74.0 CLI remains unchanged pending user approval
to update. An isolated official 0.87.0 install passed actual RPC handshake/model discovery and native
extension select/confirm/cancel checks through the host. The native desktop selector and old-version
recovery message were visually verified. No Pi provider inference or file-writing acceptance has
passed on this adapter yet.

Claude Code is connected through official Agent SDK 0.2.132 to the user's installed CLI, using its
native settings, account and session files. The adapter implements model selection, streaming text,
tool approvals, native questions (including multiple selections), interrupt and session resume. It
uses default permissions and distinguishes provider failure from completion. Cross-Agent pending
requests survive an unrelated Codex disconnect; cancellation rejects late Claude permissions.
The source host, packaged host and actual desktop window all completed real initialization/model
discovery with Claude Code 2.1.132. SDK-boundary tests cover approval binding and recovery state, but
real Claude inference, approval rendering and continuation after inference remain unverified pending
the requested model-run authorization. Shared execution, team runtime and
distribution signing/notarization are not implemented in this slice.

The desktop's optional team connection now reuses the native Product PKCE/browser-approval flow and
credential rotation implementation. A host-only private credential profile backs authorized project
list/detail reads. Cancel closes the loopback listener, an unrelated cloud error does not block local
tasks, and HTTP 401, local expiry or an uncertain token refresh require fresh authorization without
replaying a consumed credential. An isolated real
PostgreSQL/HTTP test established approval, durable reopen, project reads, revocation and denied access;
it did not establish shared files, cross-Agent continuation or cloud runtime. No private native
transcript or project file is uploaded by this connection entry.

Project creation is now available through the native desktop connection dialog, with a short name/goal
form and explicit existing-workspace member selection. The original Product `createProject` command
still requires owner/admin authority and automatically retains the creator as project owner; it is
mapped only through human desktop control, not the native model tool list. Its idempotent transaction
rechecks current workspace/personal-scope authority before serving an old receipt. SQLite stores only
local review drafts and exact pending requests. Response loss/reopen retains the original body/key,
and a later denial cannot turn an uncertain creation into a new request. Creation does not promote
private sessions or upload files; local scope selection is a separate explicit step.
Actual native-auth HTTP/PostgreSQL plus desktop-host integration verifies one created project after
response loss/reopen, selected and unselected member access, revoked/downgraded authority, and subsequent
explicit sharing of an existing local result. Local persistence checks and the macOS build pass.
The native form has not been operated visually because the Mac remains locked.

Project membership is now editable by the project owner in an on-demand desktop roster. Other project
members can view it; the API retains existing workspace-admin authority, but that administrative edit
path is not exposed in this initial desktop editor. The local host stores only a reviewed member set,
original ETag/account and durable retry key. Concurrent edits require fresh review, and response loss
cannot silently replace the original request. `reviseProjectMembers` remains the sole Product mutation;
its idempotency digest includes the original ETag and replay rechecks current management authority.
A real PostgreSQL regression reproduced removed project members retaining access to old Work threads;
the existing Work read authorization now checks current project membership as well as the Work grant.
Actual native-auth HTTP/PostgreSQL plus local-host SQLite/directories verifies removal, restart after
response loss, one mutation, blocked new file downloads, preservation of previously downloaded files,
and explicit re-addition. Local tests and the macOS build pass. Native member-editor operation remains
unverified because the Mac is locked; this does not establish real cross-Agent model acceptance.
The same membership transaction revokes unfinished borrowing requests involving removed members and
their existing capability leases. Rejoining cannot revive that consent or an old acceptance receipt.
Actual PostgreSQL/Broker acceptance verifies denial of old execution checks, acceptance replay and
output, and success after a new explicit consent. Already completed results remain historical.

Shared project files now use the canonical Product API and native Product tools. PostgreSQL owns
immutable revisions, current heads and conflict-resolution receipts; file bytes reuse the governed
object store. Project membership is checked on reads, writes and idempotent receipt replay. Concurrent
writes preserve both versions. The desktop can attach an explicitly selected empty folder, or choose
files/directories within an existing local project, and synchronize
ordinary files after local Agent work settles, persist an upload outbox, and resume uncertain submissions
without duplication. Download intent is durable; replaced local files remain in a private recovery area.
A changed login requires explicit resumption, and private native sessions/hidden files stay outside sync.

Selected file ranges are immutable local sync configuration in SQLite `shared_projects.scope`; they
are not cloud permissions or a second file store. Existing bindings preserve whole-folder behavior.
Uploads, downloads, deletions and filesystem recovery honor the selected paths; new files inside selected
directories join the existing declared scope, while other local directories stay private. Existing
private sessions/drafts are not promoted. Team input rejects unselected local file references before
publication or native execution, and the Agent receives the actual file scope as reference context.
Real native-auth HTTP/PostgreSQL tests verify two members sharing an existing project's result, edits,
deletion, persisted scope and retained private history; SQLite tests additionally cover initial conflicts,
offline reopen, single-file selection and symlink rejection. The native picker remains visually unverified
because the Mac is locked.

Real isolated PostgreSQL/HTTP acceptance with two independently authorized members and two SQLite-backed
local folders passed byte-exact transfer, concurrent edits, conflict resolution/convergence and revoked
member rejection. Controlled failure checks cover offline capture, restart after a lost receipt,
interrupted download staging and edits arriving during a download. A separate native macOS window
joined the real isolated project through the folder picker, rendered its downloaded file, paused/resumed
sync, displayed both competing contents and selected the local version; an independent HTTP read
confirmed that selection as the current Product revision with no unresolved conflict. The final window
was visually checked after correcting shared-scope copy and stale preview behavior. Browser approval
for this window was supplied by the isolated fixture, not manually operated through the GUI.
This is not yet cross-Agent model
continuation or team-runtime acceptance. Current limits: 8 MB per file and recovery copies retained without automatic pruning.

Project-file deletion now uses an explicit `deleted` flag on immutable revisions (migration 045),
reusing the existing command, head/conflict and object-store owners. Deletion requires a real base
revision and no content; empty files remain normal versions. Old content and resolved conflicts remain
readable, and restoration is a new content revision based on the current deletion. Tombstones cannot
be attached as shared-comment file contents. Replaying an old mutation rechecks current authority
inside the idempotent transaction. SQLite queues exact deletion submissions and durable local removal
intents; remote removals preserve existing bytes in the private recovery directory. Changed bytes
racing removal are restored/preserved and later conflict instead of being silently discarded.
The desktop distinguishes local/team deletion when resolving conflicts and binds the displayed head;
a stale preview cannot overwrite a newer team version. Pre-upgrade missing files require an explicit
restore/delete choice, preventing unannounced propagation of earlier local removals.
Real two-member native-auth HTTP/PostgreSQL and real local directories verify both delete/edit conflict
outcomes, lost receipts, restoration through successive deletions and convergence after another member
chooses deletion. SQLite reopen tests cover offline deletion, interrupted filesystem removal and legacy
missing-file behavior. Native GUI verification remains blocked by the locked Mac.

Declared team conversations now reuse Product Work Items, comments and decisions. The desktop can
create a team goal or open an existing work item with the user's own Agent. Normal sending refreshes
the goal, recorded decisions and latest 20 shared updates and confirms the shared request before native
dispatch. After a recognized temporary cloud outage, an existing contributor can explicitly choose
**用上次资料在本机继续**. The host binds this to the original account/device, marks the last saved
context as stale, and queues the new request/final answer locally. Already saved fixed file revisions
can be reused; missing versions and unsynchronized/conflicting local files cannot be silently substituted.
Reconnection rechecks Product access and publishes the original queued updates, without rerunning an
Agent. Known access denial (including team-detail/file reads and project sync) disables cached execution
and persists across restart; a later network error cannot erase it. This exception applies only to the
member's own local Agent, never borrowed execution or cloud runs. Private pre-existing histories, tool
logs, credentials and injected reference packets remain private. Creation payloads and publication keys
are stable across lost receipts; recovery binds pending writes to the original user.

Real isolated HTTP/PostgreSQL plus two local hosts verified Codex-to-Pi context preparation, decision
transfer, no private-history/tool-log publication, uncertain-receipt recovery and revoked receipt replay.
The same integration verifies explicit Pi continuation during a cloud outage using the previously saved
file version, then a single request/result publication after reconnect and no additional native prompt.
SQLite reopen checks cover deferred updates, known denial and account changes. These outage checks
control the cloud transport failure and native provider boundary; they do not prove offline inference.
Model boundaries were controlled. Real cross-Agent model continuation and the new native team-work
screen are not yet accepted; the attempted native-window check was blocked by the Mac lock screen.

Team result review now binds a submission to the contributor's immutable shared entry, content hash
and fixed file references. Only the accountable owner can accept it or request changes; Product updates
the work status and next-action feedback atomically using the existing lifecycle ledger. SQLite stores
the exact human-confirmed action, original ETag and idempotency key before transmission. Lost receipts
are reconciled with that original action, never a refreshed version or another Agent execution. Completed
work remains readable and can deliver previously queued updates, but cannot start another native turn.
Real isolated native-auth HTTP/PostgreSQL integration verifies two-member submission, requested changes
in the next controlled Pi prompt, resubmission, stale-review rejection, lost-receipt recovery and completed
work execution denial. SQLite reopen checks and the packaged macOS build pass. Native GUI and actual
model acceptance remain outstanding; the latest window check was blocked by the locked Mac.

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

Desktop work owners can now ask an existing contributor to take over using **请同事接着做**.
The native host keeps only a private review draft and uncertain receipt; the existing Product Work
update accepts a narrow `assigneeUserId` plus optional `nextAction`. This mode adds the assignee role
under the Work root/grant locks, preserves every access grant and other role, and rejects combining
it with membership or status changes. Revocation now uses the same root-before-grant lock order.
The original If-Match, payload and key survive uncertain delivery. A stale preview cannot overwrite
new work changes, and assigning a revoked or read-only member cannot restore access. The receiving
desktop marks the work as assigned to its viewer, displays the next step and opens its own Agent only
when that member chooses to continue and send a request. Assignment is not acceptance or completion.

Real native-auth HTTP/PostgreSQL acceptance verifies owner-only assignment, unchanged grants, lost
response reconciliation, stale/conflicting input refusal, revocation, and inclusion of the handoff in
the recipient's controlled Pi input. SQLite checks cover reopen/restart and immutable uncertain drafts.
The native GUI remains unverified while the Mac is locked. This is a human-confirmed work handoff,
not a versioned capability invocation or unattended borrowing of the provider's native Agent. That
requires a revocable provider grant, enforceable isolated execution and actual invocation receipts;
the existing Device worker transport supports only the same user's deterministic skills.

A local Pi SDK adapter now proves a bounded text-only borrowing profile with declared-input
and result tools, no private resource discovery or arbitrary host tools, independent session state,
per-call authorization and active cancellation/deadline limits. Actual SDK tests use a controlled
provider; they do not establish real model quality. Local SQLite
now fences dispatch before executor creation and preserves fixed result delivery across restart.
Abrupt process-exit checks prevent a second invocation; SDK integration verifies that retrying an
unconfirmed result does not invoke the model again. Desktop-only consent/transport calls share the
native credential lifecycle without entering the Agent tool inventory. A separately implemented
cloud `member_agent_request` service now freezes the published method/input, records provider
consent and reuses Command/Admission/Invocation/Attempt/Broker settlement. Real isolated native-auth
HTTP/PostgreSQL plus local SDK/SQLite integration verifies output receipt loss and restart, active
model-stream cancellation after requester revocation, registration/dispatch failures and server
restart without replay. Interrupted text execution is `partial` with an explicit unknown-result
reason; local model cost is unmetered/null rather than fabricated zero usage or a numerical budget.
The desktop Team Work view and normal host dispatcher now expose request discovery, explicit
provider/model consent, results and cancellation. SQLite persists original create/accept submissions;
real native-auth/PG checks cover lost acknowledgements and host reopen without duplicate inference.
Account discovery uses the member's configured Pi API accounts, excludes subscription seats and
loads the bundled SDK lazily. The generated SDK chunk passes declared-input/result execution with
a controlled provider; the built stdio host opens local projects without cloud setup. Native GUI
acceptance remains blocked by the locked Mac, and real two-member model-account acceptance remains.
The
[desktop/cloud boundary](desktop-cloud-boundary.md#provider-execution-boundary-being-implemented)
records its scope and the remaining Command/Invocation, lease and desktop integration.

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
The same composer picker also exposes published team Skills and native Loops using the existing
catalog and installation owners. Selecting one prepares a new task with the same Agent, saved draft,
references and task-specific model; it performs no inference and leaves the original draft/history
intact. Shared tasks retain their Work Item and require the original member/connection; private drafts
cannot become shared through this shortcut. Draft changes during download reject stale preparation,
and retrying the same choice opens the original prepared task. Real SQLite tests cover these boundaries
and subsequent controlled native input. HTTP/PostgreSQL integration covers actual publication,
cross-member installation and carried references. Native GUI remains unverified while the Mac is locked.


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

The desktop also exposes published instruction Skills through the existing native Product catalog and
installer. Selecting a Skill adds the exact release to the chosen Agent's project directory and creates
an idempotent local task; no model is called until the user sends its task. Selection from a team work session can
continue the same Work Item with the user's Agent (the default), or explicitly open a private task.
The shared route publishes the selected method/version, request and final answer through existing
Product comments; local paths and private native history stay local. Fresh Work Item access governs
both selection and input admission. Installed files/release are
checked before dispatch, same-name local edits are preserved, and later tasks can use the downloaded
method without cloud availability. New installation requires current authorization. Real isolated
HTTP/PostgreSQL verified another member's immutable publication, exact files/references, private-draft
isolation, retry and revocation through this desktop host. That same real Product scenario verifies
shared method continuation, goal transfer, visible method/version and answer provenance, and denied
selection/execution after the member is downgraded to read-only. Model dispatch was controlled and the new
native dialog has not been visually accepted. Team runtime remains incomplete.

Completed native answers now connect to a local capture task with the same Agent/model. Only the
explicitly selected answer is placed in its private reference context; source history and shared-work
membership are not inherited. Creation saves a normal conversational draft without inference. The
user sends/refines it through the existing native task path, then previews the actual `SKILL.md` file
and explicitly adopts its exact content hash. The local host confines draft/target directories, refuses
linked/non-regular files and foreign/local edits, and persists adoption intent before an exclusive
atomic file installation. An uncertain local receipt can be reconciled without replacing the file.
Using the adopted method prepares another private task and checks the selected file again before
dispatch. This does not create a Product release or claim successful model validation.

Real SQLite/filesystem tests verify source isolation, restart, no inference on preparation/adoption,
Codex/CC/Pi destination directories, stale-preview rejection, preserved conflicts and receipt failure
recovery. Provider dispatch is controlled; actual method quality, CLI discovery and native GUI use
remain unverified. Current local capture is a standalone UTF-8 instruction file up to 64 KB. Desktop
cloud version updates and Loop capture are still incomplete and must use Product's existing
validation and immutable publication authority.

The capture preview now also saves the reviewed standalone instruction file into a private Product
Skill draft through native-auth canonical upload, inspection, promotion and draft creation. No cloud
publication or model execution is implied. Local transfer receipts freeze the chosen bytes/name,
original origin/workspace/member and each idempotency key; explicit retry resumes uncertain steps,
and a final fresh private-draft read checks access even on receipt replay. Definite inspection/name
failures can be explicitly re-prepared without deleting uploaded cloud objects; unknown outcomes
cannot. Upload permission warnings are never automatically acknowledged.

Real isolated native HTTP/PostgreSQL/object-store acceptance verifies exact reviewed bytes, another
member's denial, no release creation, and recovery after an accepted draft response was lost. Local
SQLite tests additionally cover restart, changed files/account, revoked access and bounded failure
recovery. Native GUI acceptance remains pending.

The capture panel now connects a text trial to the existing Skill test runner, full output/status and
cancellation, then explicit human result/audience confirmation to canonical validation and v1.0.0
publication. The native adapter preserves required draft `If-Match` headers. Local action receipts
freeze trial input, inspected output hash, draft version and retry keys; reopening does not execute.
Unknown outcomes block competing submissions and remain uncertain even if a later replay encounters
changed state. Product remains the only test/validation/release authority. Externally changed drafts
cannot silently run through a preview of the old package.

Real isolated native HTTP/PostgreSQL acceptance ran the existing runner with controlled output,
validated/published the captured package, recovered lost trial/publication receipts, and confirmed that
another member downloads the exact release but cannot read private trial data. Validation readback
exposed a domain-typed PostgreSQL array decoded as text; the SQL now aggregates `text[]`, preserving
whole test identifiers. SQLite recovery checks cover restart, cancellation, unreviewed outputs, stale
drafts and changed actors. This is not real provider or native GUI acceptance. The current panel covers
standalone text-instruction captures and first publication; cloud Skill draft editing/version updates
remain incomplete. Loop draft capture now uses a selected-answer local
task, optional published Skill contracts, reviewed file transfer and revision-checked updates to the
same private workflow. Durable transfer receipts retain the original content across lost responses.
Packaged native UI and real isolated PostgreSQL acceptance cover draft review/save/update/check;
the compiler's cloud model requirement is not evidence of local Agent readiness.

Local Loop trials now pin a reviewed recipe and installed Skill versions into an independent private
native task. Human-reviewed output can be saved through the canonical local-trial endpoint as an
immutable private receipt (`member_attested_local`, `cloudReady: false`). SQLite retains the exact
reviewed submission across restart and uncertain responses; retry does not execute an Agent.
Real isolated HTTP/PostgreSQL integration covers receipt delivery, version binding, lost-response
recovery and member isolation with controlled native output. Native GUI and real-provider acceptance
of this new trial flow remain outstanding; it does not bypass cloud publication gates.

Explicit native Loop publication now stores independent immutable native versions and Skill pins
behind the existing workspace library. The owner confirms the complete recipe and audience; trial
content and source draft stay private. Members download fixed recipes and native-compatible Skill
packages into their own project, choose Codex/CC/Pi and execute through the normal native task path.
The first supported publication scope is linear Input/Skill/Output; unsupported controls, personal
models and private resources are rejected. Managed cloud Loop entry points reject native-only releases.
Real isolated PostgreSQL/native-PKCE integration proves publication retry, second-member download,
controlled Claude execution after restart without Turnsu cloud, and preservation of old releases during
migration. Local checks cover pinned file changes and uncertain publication recovery. Native GUI and
actual model acceptance remain outstanding; no cloud runs were fabricated for this path.

Team Work detail now connects published Loop selection, private preparation/input drafts, compilation,
explicit shared execution, and Product-derived status/results. The library read owner supplies immutable
published purpose/result summaries and type-filtered seek pagination. Preparation and submission keys
are durable on the local host, scoped to the original member. Reopening does not dispatch; an uncertain
submission is reconciled only by an explicit retry with the original payload/key. A new run is blocked
while its predecessor remains uncertain. Work Item grants are checked on read, preparation and delivery.
This uses Product's authorized workflow execution environment, not a native CLI's account.

Real isolated native-PKCE/HTTP/PostgreSQL acceptance covers that desktop Loop path through the compiler,
admission and runner, including two-member result visibility, a lost receipt followed by host restart,
no duplicate Run, catalog pagination and revoked access. The execution backend is a deterministic test
capability, not model inference. The initiating member can now inspect private review content,
approve/reject its exact node attempt, or cancel active execution from desktop controls. Durable
local action receipts protect unknown outcomes across desktop restart; changed accounts or lost work
access cannot replay them. Product compares the expected attempt inside its locked review decision
transaction. The HTTP decision response uses the canonical persisted decision and Run projection.

The same real acceptance now covers stale-review refusal, approval/rejection, active cancellation,
lost decision/cancellation receipts, and closed capacity/capability authority. It exposed and repaired
review-Inbox SQL alias/column/parameter errors and cancellation attempt identity/order defects.
Migration `039_workflow_cancellation_transition` permits only the active node's intermediate cancellation
states after the governed command; an uncommanded mutation is still rejected, and terminal constraints
remain unchanged. The B3 constraints and shared Admission/Execution PostgreSQL integrations also pass. Execution event timestamps stay monotonic
across host/database clock differences. Review packets retain full content up to the public size bound;
the desktop blocks approval if an oversized packet was truncated.

Desktop review now accepts explicit requested changes for a configured direct upstream Skill with a
text input. The existing Product runner appends feedback to that attempt's persisted input and reruns
only the target Skill, using the existing execution configuration. A durable decision marker prevents
the same revision from executing twice during recovery. Each new candidate opens a new review attempt;
the public read model includes the latest ten candidate/decision rounds and an older-round count, while
PostgreSQL retains all rounds. Pagination of older rounds is not yet exposed in the desktop.

Real isolated HTTP/PostgreSQL acceptance verified two successive revisions, accumulated feedback,
unchanged upstream input execution, stale-attempt refusal, receipt loss/restart and final approval.
Fault injection after persisting the revised result, followed by lease expiry and a fresh runner,
reopened review without repeating the completed Skill. This is controlled execution evidence, not
provider inference or an operating-system process-kill test.

Native visual/interaction acceptance remains pending Mac unlock. Execution-configuration editing
is not implemented. The broader contract sweep still has an
unrelated auth-endpoint inventory expectation missing the existing native-session management routes;
the affected Run/public-endpoint, runner, native-tool and local-host checks pass.

## 1. Fixed authority and control chain

PostgreSQL is the single cloud Product Store. There is no dual-write, domain split, or runtime
fallback. Personal Sessions and branches are private by default; sharing is explicit and bounded.
Domain ledgers remain authoritative for their own state.

```text
Web / Desktop / Connector / Scheduler
  -> Product API
      -> Command Intake
          -> Product Store / Runner
              -> AdmissionController
                  -> ExecutionBroker
                      -> Transport / Worker
```

The current product is a modular Node.js same-origin server plus a React Web client. It is not yet
a deployed cloud control plane or a signed Desktop product. Production composition in
[`server.mjs`](../../domains/backend/code/workbench-server/src/server.mjs) requires a PostgreSQL
DSN, PostgreSQL Browser Sessions, migrations before traffic, explicit credential/identity ports,
the mounted Secret Store reference adapter, and the admitted Execution Broker wrapper. The
recommended startup script has been exercised against an isolated `_test` database through all
current migrations and real `/healthz` and `/readyz` HTTP checks.

### Agent Harness boundary

The Agent Harness is a replaceable execution sublayer beneath the existing Product control chain:

```text
Product Session / Turn / Run
  -> AgentKernelPort
      -> minimal Harness Kernel
          -> Pi Agent Loop (current production default)
```

Product Session authority, PostgreSQL, ACL, Command Intake, grants, approvals, model/tool/Connection
Gateways, and secret handling remain outside this Kernel and enter only through narrow bridge ports.

The current bounded Agent Worker is a production consumer of this boundary:

```text
AgentContainerSandbox / Worker
  -> product-pi-first-party-v1 Profile
      -> ProductSessionPort -> execution event -> PostgreSQL Agent Session ledger
      -> Product Tool Pipeline -> Product security / Inbox approval / Gateway
      -> PiAgentLoopPlugin (adapter-private Pi cache rebuilt from SessionPort)
```

`agent-kernel`, `agent-kernel-pi`, `agent-kernel-product-bridge`, `agent-kernel-testkit` and the
first-party business plugins are separate Harness packages. Backend reaches the remaining legacy Pi
compatibility surface only through `agent-runtime/public-api.mjs`; it does not import Pi or extension
paths. The fixed production Profile includes only T1 Product bridges and pinned T2 first-party plugins.
Pinned T1 services cannot be replaced from either the current context or a descendant plugin scope;
plugin child contexts are frozen facades and do not expose a raw `parent` traversal.
Developer-dynamic and sandbox-ephemeral plugin hosts are not constructed in production. The DSH/Cordis
compatibility adapter is experimental, runs the same conformance suite as Pi, and is not default-eligible.
The Harness also records the data-only promotion chain from sandbox evidence to a reviewer-approved,
capability-subset signed T3 descriptor and fixed Plugin Set revision; activation still requires a Product
profile resolver plus an isolated sandbox.
No alternate Session truth, Tool executor, Product Gateway bypass, or runtime fallback is introduced.

## 2. Current production consumers

| Domain | Current owner / consumer | Status | Remaining gap |
|---|---|---|---|
| Invitation and identity | `AuthService -> PostgresAuthPersistence`; hash-only invitation token, durable SMTP outbox/receipt, Google and GitHub OAuth ports, PostgreSQL Browser Session | implemented+verified locally | real TLS SMTP sandbox, provider test apps and HTTPS deployment are environment-deferred |
| Membership and personal scope | atomic `membership_activation` binds invitation, external identity, membership, principal, one active personal scope and initial policy/grant | implemented+verified locally | broader organization lifecycle and device identity |
| Private Agent Task | Product API -> operation decision -> Agent Command Intake -> PostgreSQL Agent persistence -> Admission/Broker -> isolated native Pi Worker; text/document reads use the Product-owned `turnsu_materials` tool scoped to persisted private Session turns | local same-origin browser task, real DeepSeek response, historical attachment list/read, encrypted transcript and refresh recovery verified on 2026-09-21 | cloud Worker, image follow-up access, external tool effects and broader recovery acceptance |
| Workflow Run | PostgreSQL command, job, event, attempt, review, execution and terminal aggregates; fenced Runner with heartbeat, takeover and SIGKILL recovery; exact fresh authority for retry and Agent-session companion Runs | saved private Skill workflow, real managed execution, persisted result reopening and execution history verified in the local browser on 2026-09-22 | every control operation and shared workflow variants are not browser-proven |
| Project and Work Item collaboration | PostgreSQL Project create/list/member revision, Project-backed Work Item create/list/status/owner/member revision, atomic promotion, safe Handoff Capsule, revocable ACL, teammate-owned continuation Session, shared comment and owner Decision; Web Work consumes the Project and Work Item paths | PostgreSQL HTTP verified; same-origin browser create, reload and status update verified on 2026-09-21 | multi-user browser acceptance, Activity projection and reviewer proposal flow |
| Skills and Loops | PostgreSQL Draft/read/upload/test/validation/publication, canonical published Skill reference reads, Workflow revision/compile and staged proposal owners; document editor with real dependency bindings and save-and-try | private published Skill reference saved, compiled and run against PostgreSQL with a real provider; desktop and 390px editor verified | Loop publication with Skill/Resource dependency closure, task-to-workflow capture and full publishing UI acceptance remain incomplete |
| Model, Connection and Secret | PostgreSQL catalogs and bindings with opaque injected gateways; admin personal model setup writes revision, scoped SecretBinding, default policy and completed Product command atomically | first-run Web setup, real provider model discovery and task execution verified locally; private catalog/default/selection boundaries covered by PostgreSQL HTTP regression | model editing/rotation, teammate and project provisioning, managed Secret Store and real Lark tenant acceptance |
| Inbox | recipient-scoped PostgreSQL read model; explicit database `target_kind` to public `objectKind` mapping; unknown kinds fail closed; Run review decisions dismiss their matching item through the canonical review/cancellation command | partial | no generic Inbox decision command; Automation attention is a recovery route, not yet an approval-and-resume flow |
| Automation | public Scope Policy and Automation lifecycle (`create/list/detail/revise/activate/pause/archive/occurrences`); immutable Loop, Resource and Connection pins; PostgreSQL scheduler -> decision -> Workflow Runner Command Intake; occurrence acceptance is atomic with Command/Run creation | implemented+verified locally through the PostgreSQL owner path | approval-bearing Automation resume from Inbox, signed webhook/internal-event triggers, multi-workspace worker composition and real browser acceptance |
| Storage and operations | filesystem Object Store for local execution; PostgreSQL migrate/start/doctor/release/backup/restore and fixed-digest local container; canonical startup owns identity/secret composition, attachment TTL recovery and realtime restart fencing | implemented+verified locally, including isolated standard startup and HTTP readiness | S3-compatible Object Store, managed PostgreSQL, cloud backup target and telemetry |
| ProductClient | typed Web leaves for Auth, Workspace, Readiness, Inbox, Model, Work Item, Scope, Automation and Run paths; browser and native bearer transports share JSON contract validation | partial | one composed cross-client surface plus typed SSE cursor and binary transfer support for Web, Tauri and connectors |
| Agent Harness | Product Worker runs `product-pi-first-party-v1`: Pi adapter, Product Session bridge, immutable Profile, Tool Pipeline, Inbox approval/resume, T2 business plugins and RenderIntent; DSH is an experimental conformance-only adapter | real Pi 0.85.1 in a digest-pinned network-disabled container completed browser tasks and read private materials through the Product Gateway; tool results, model-visible events and encrypted transcript persisted | external write/approval effects, signed workspace-plugin release path and a real Cordis/DSH provider remain deferred/experimental |
| Device control plane | native bearer authorization, Device register/list/heartbeat/revoke, execution leases, outbound authenticated WebSocket gateway and RemoteWorker registry are mounted by the real server | partial; module and PostgreSQL HTTP paths verified | no Tauri client, real remote Worker/Rust capability broker, reconnect UX, or signed-device end-to-end receipt |
| Desktop, mobile and channels | Product directions are fixed to one Tauri 2 macOS/Windows client, an Expo development-build companion, and Feishu/Lark first | not-started as shipped product consumers | signed desktop packages, Expo app, real Lark tenant adapter and cross-surface acceptance |

## 3. Old-owner exit

The code baseline has completed the PostgreSQL one-shot owner exit:

- `ProductMongoStore`, Mongo persistence adapters, Mongo operations, package dependencies,
  package scripts, compose service/config and production imports are removed;
- [`production-mongo-closure.test.mjs`](../../domains/backend/code/workbench-server/tests/architecture/production-mongo-closure.test.mjs)
  checks the production import closure, manifests, lockfiles, startup files, `.env.example` and
  compose configuration;
- the immutable comparison evidence is retained as
  [the PostgreSQL cutover receipt](../history/architecture/2026-08-12-postgresql-one-shot-cutover-receipt.json);
- cutover-only Mongo runners and permanent Mongo harnesses are deleted. The current permanent
  regression manifest is PostgreSQL-owned.

This proves the current repository baseline, not a real production maintenance-window cutover.
Managed-database deployment, external backups and rollback rehearsal remain environment-deferred.

Known public operations that still depended on unavailable legacy semantics were removed from the
contracts and Web consumer instead of being left as runtime fallbacks: direct membership add,
template clone/use, run comparison, Loop import/export/duplicate/from-Run/update, saved-Workflow
proposal paths, Team release start/fork and direct installation adoption. The current staged Loop
proposal path remains active.

The legacy Swift/LoopOps acceptance harnesses and static screenshot audits are not production
owners. Remaining generic repository branches support isolated tests or still-unmigrated internal
families; they are not a PostgreSQL fallback.

## 4. Domain ledgers

| Domain | Authority |
|---|---|
| Agent Session and Turn | PostgreSQL Agent Session/Turn events and projections; product-safe Session-domain envelope/replay/outbox for authorized Agent events |
| Workflow Run | `workflow_run_events` plus fenced job/attempt/execution aggregates |
| External effects | intent/outcome Effect Receipts |
| Skill and Loop assets | immutable Draft snapshots, versions, revisions and releases |
| Work collaboration | Work Item, `work_thread_entries`, Decisions and revocable grants |
| Identity activation | invitation, OAuth transaction, external identity and `membership_activation` lineage |
| Cross-domain activity | Session-domain envelope/outbox currently projects authorized Agent and Execution events; future rebuildable Work Activity and broader outbound-event projection remain non-authoritative |

The PRD-wide envelope is not yet complete for all four Session classes. Work Activity and a
cross-domain outbound event outbox are likewise not complete runtime capabilities.

## 5. PRD Phase 0–5 progress

Status meanings: `implemented+verified`, `implemented-unverified`, `partial`, `not-started`, and
`environment-deferred` are used literally; file existence is not verification.

| Phase | Status | Current evidence | Main gap |
|---|---|---|---|
| Phase 0 — authority/no bypass | partial; golden-path boundaries implemented+verified | operation decisions, explicit Command Intake, scope/object isolation, admitted execution, cross-user and cross-workspace Private Task denial | complete mutation-family boundary matrix and deployed policy telemetry |
| Phase 0.5 — PostgreSQL one-shot | implemented+verified for the repository/local runtime; production cutover environment-deferred | PG-only defaults and operations, same-manifest regression, real SIGKILL/fence recovery, backup/restore, Mongo consumer-zero guard and immutable cutover receipt | managed deployment and maintenance-window rollback rehearsal |
| Phase 1 — cloud core | partial | PostgreSQL identity, Sessions, authority, execution, Memory, Inbox foundation, invitation outbox, native token auth, scope-policy lifecycle, Automation lifecycle/pins, a real daily Automation poller and the Product Agent Harness bridge | complete four-kind Session ledger, cross-domain outbox, composed ProductClient with SSE/binary, cloud stores and tracing |
| Phase 2 — eight-person golden path | partial | private Task, Project-backed Team Work, explicit promotion, Handoff, teammate continuation, comment, owner Decision, Web Automation management and constrained offline daily Run execution | Activity projection, approval-bearing daily Automation, real browser acceptance, Tauri clients and eight-person pilot |
| Phase 3 — Device and channel | partial backend control plane | native authorization, Device lifecycle, execution leases, outbound WebSocket gateway and Lark policy tests | real Tauri Remote Worker/Rust capability broker and Feishu tenant connector |
| Phase 4 — compounding/mobile | not-started as a product path | Expo companion boundary is specified only | evidence-based proposals, Expo implementation/approval receipt, WeCom and Slack |
| Phase 5 — scale | not-started by design | none | pilot telemetry threshold has not been reached |

## 6. Current verification and limits

Current working-tree evidence:

- focused isolated PostgreSQL receipts prove: a companion-bound Loop Agent Task uses an exact
  Workflow Run authority; retry persists its immutable lineage; and Automation scope-policy,
  lifecycle commands, immutable Resource/Connection pins, misfire handling, concurrent Scheduler
  dedupe, Inbox projection and admitted completed Run all share the PostgreSQL control chain;
- the permanent `npm run test:postgres:isolated` manifest covers foundation, tenant/authority
  constraints, Loop/Library, Workflow Run, Automation/Inbox aggregates, invitation activation,
  regression scenarios, Memory FTS, SIGKILL boundaries, encrypted backup/restore,
  Admission/Execution, realtime restart fencing, canonical production startup/readiness and the
  two-user HTTP golden path;
- `npm test` passes in `workbench-server` and `workbench-contracts`;
- `npm run test:architecture` passes the no-bypass, raw-adapter, secret and Mongo consumer-zero
  boundaries;
- Pi and DSH run the same Kernel conformance suite; the Worker Profile test covers Session replay,
  Product Tool grant/approval, Context/Planner/Workflow preparation, RenderIntent and a T2-only
  monotonic business-tool policy;
- an isolated `_test` PostgreSQL receipt proves model-visible Kernel events are projected once to the
  Product Session ledger and an external Tool is resumed only by its matching Inbox approval;
- an isolated `_test` PostgreSQL receipt proves the recommended startup script applies all current
  migrations, starts the canonical production composition, and serves live and ready responses;
- Web state/API/routing/bundle-boundary smoke passes. It is structural evidence, not browser
  functional acceptance.

The HTTP golden test uses a real `_test` PostgreSQL server and real HTTP handler, but controlled
SMTP/OAuth/Worker ports. No current receipt proves a real Google or GitHub app, TLS SMTP sandbox,
model provider, S3-compatible Object Store, managed PostgreSQL, public HTTPS, Feishu tenant,
signed Desktop build or eight-person pilot.

## 7. Document and harness governance

Canonical/active:

- Master PRD v0.5 — sole product authority;
- this file — current implementation truth;
- concise `README`, `PRODUCT.md`, `DESIGN.md` and operational runbook pages that are consumed by
  current entrypoints.

History/decision evidence:

- cross-review decision record, absorbed Three-in-one Blueprint, immutable cutover receipt and
  ADRs that still explain current code;
- dated QA reports only for their exact candidate. They are never current acceptance by default.

Deleted as consumer-zero noise:

- duplicate Goal/Plan/State ledgers, candidate-hash/test-count manifests and stale deferred
  manifests;
- cutover-only characterization runners, old Mongo operations/tests and permanent Mongo harness;
- LoopOps manager/review scripts, Swift acceptance harnesses and static DOM/screenshot audits;
- retired public-client methods and UI controls for unsupported legacy operations.

Unknown/retained:

- large historical visual/receipt collections whose provenance or external references have not
  been fully reconstructed. They are inactive and are not acceptance evidence.

## 8. Current rebuild boundary

The 2026-09-21 request authorizes the complete product rebuild described in the Master PRD v0.4
amendment. The first visible path now starts at Agent after sign-in, puts the task composer in the
initial viewport, keeps drafting available before a model is configured, and shares a stable
navigation shell across routes. Team Work uses task-focused copy and adapts its list to the actual
space left by the detail pane. Shared Dialog styles now load with the component, fixing the Agent
handoff modal that previously trapped focus outside the visible viewport; the continuation entry
shows its shared objective and next-task composer without unrelated examples. These changes have
been built, checked with the existing Web smoke
suite, and operated against a newly isolated PostgreSQL Product server, without review fixtures.

The authenticated first-run model command now creates the Profile revision, scoped SecretBinding,
default policy and completed command atomically. The local browser has completed a real DeepSeek
task through Product -> native Pi Worker -> Model Gateway -> durable Session result. Text/document
follow-up also reads the original private attachment through the governed Tool Gateway, with
persisted list/read results. Scope isolation remains mandatory: selecting the latest policy across
an entire workspace is not a valid substitute for the actor's policy. Shared Work Item creation,
continuation context and owner comments have local browser evidence; actual teammate continuation,
real LinkCode loading, Jev's measured contribution and native cross-client acceptance remain open.

The existing Project-backed Team Work and Automation lifecycles remain reusable Product owners.
Multi-workspace Worker composition must be verified before Tauri or Expo execution. Automation
includes the explicit Owner policy revision and immutable Resource/Connection pins:

```text
Owner-approved unattended scope policy
  -> public Automation lifecycle command
  -> immutable Loop / Resource / Connection revision
  -> deduped Scheduler occurrence and authority
  -> Workflow Runner / Admission / Broker
  -> durable Run and occurrence result
```

The current Pi Harness has local provider-backed browser and private-material read evidence;
external tool effects and approval/resume still need equivalent acceptance. Do not switch the
default to DSH/Cordis, enable developer-dynamic plugins in production, or expose a workspace plugin
before its separate signing/sandbox release gate. Project and Work Item paths must not expose a
private transcript or source Session identifier through Project, Activity, or Harness events.

### Workflow authoring and native Agent boundary

`WorkflowStudio` is the default saved-workflow editor. Its canvas shows canonical nodes and port
connections, with an on-demand step library, contextual node settings, undo/redo, position-only
auto-layout and a test-run side panel. The previous form-first `WorkflowDocumentView` is no longer
the saved-workflow route. Input binding edits update the canonical graph and edges; save-and-try
passes the exact saved revision to the existing Product run command and can stay in the editor.
The run panel reads real Product Run detail, node status, final Markdown and saved run history.
Query refreshes cannot replace a dirty/saving editor or regress its saved revision; undo history
survives save acknowledgements. Conflict reload remains an explicit fresh snapshot operation.

Local browser checks on 2026-09-22 verified port reconnection, undo/redo, persisted layout after
reload and removal of an Input's unused run field. The new in-editor run reached real execution
but two attempts were rejected by the configured DeepSeek route with `provider_request_invalid`.
Their pinned model, Skill request input and output contract match the earlier completed run. This
iteration therefore establishes the new failure/retry surface, not a fresh successful provider run.
The earlier successful private Skill run and restart/result evidence remain historical acceptance,
separate from this iteration's current provider failure.

PostgreSQL run responses now project the public Run/Node/Review contracts instead of exposing
internal aggregates. Run events include workflow identity, and an invalid SSE replay closes the
stream without writing a second HTTP response. Execution history is read through the PostgreSQL
adapter, then projected to lifecycle metadata at the Product API boundary; raw Worker event payloads
stay private. Auxiliary history failures no longer hide an otherwise available final result.

The owner has explicitly requested native Claude Code, Codex and Pi hosting. This is a corrected
product requirement, **not an implemented consumer**: current task and workflow UI execution remains
Turnsu-managed. The LinkCode bridge is Pi-only and does not establish native multi-Agent hosting.
The official Codex App Server, Pi RPC and Claude integration boundaries are recorded in
[the storage/workspace research](2026-09-21-skill-workflow-workspace-storage-research.md).
Native session references, approvals, reconnect and desktop UI wiring remain outstanding. Native
account configuration and private transcripts must remain on the user's device; Product owns shared
work and explicit handoffs. The separate LinkCode daemon evaluation has not run because automatic
approval rejected its Keychain/config access and the requested permission remains unanswered.

## 9. Team capability reuse — implementation boundary, 2026-09-22

The owner expanded the product requirement to project-shared execution and cross-member reuse of
native Agent capabilities. The [team research](../design/2026-09-22-team-agent-collaboration-research.md)
informed Master PRD v0.5. The owner approved implementation; the complete four-part delivery order
remains the acceptance target, including real native participation and delegated execution.

Implemented and checked in this iteration:

- Skill/Resource publication uses the successful Run's exact compile and plan, pins immutable
  dependency versions and rechecks access at publication. `publishSelectedLoop` no longer recompiles
  immediately before publishing, which previously invalidated its successful test evidence.
- `createLoopFromRelease` resolves the exact released revision and creates an idempotent private copy
  for the consumer, records release provenance and excludes the publisher's model bindings.
- Migration 036 adds a sharing relation from Work Item to the canonical Workflow Run. The Run and
  sharing declaration commit atomically through existing Command Intake; no second Run status exists.
  Active member/work-item/project access is checked on reads and writes. Read-only members cannot
  execute; archived projects retain historical reads but reject new execution.
- Team Work exposes a release picker, declared input/audience, live status and shared final output.
  Requester authority/quota stay personal. Completion produces a result for review and does not
  complete the Work Item. New continuation capsules include bounded shared results as untrusted,
  unreviewed context; already-created continuations do not yet refresh this snapshot automatically.
- `integrations/native` adds an independent Product connector: official MCP SDK 1.30.0 stdio tools
  for Codex/Claude Code plus the same tool contract as a Pi extension. PKCE/browser authorization,
  per-client private credential file, single-process ownership, token rotation and revocation are
  implemented. An uncertain refresh requires reauthorization, never replay of a consumed token.
  This does not change or vendor LinkCode or claim native model/tool enforcement by the Product Gateway.
- A real independent stdio process read a second member's Loop result and submitted an idempotent
  handoff through native Bearer HTTP, Product Application and isolated PostgreSQL. Revoking the
  Work Item grant then denied reads through that same process. This proves protocol/Product wiring,
  not model-driven acceptance in the three native clients.
- Browser checks on localhost:8798 exercised fixed publication, private-copy execution, shared
  Work Item results surviving reload, and recovery of the same accepted Run after a failed response.
  Both response-header and response-body contract defects discovered there were repaired.

Remaining boundaries:

- `PostgresTeamWorkLifecycle.createTeamWorkItemAgentEntry` already composes a shared Work root,
  personal continuation and first Agent Turn atomically. The new Loop results projection does not
  yet cover all native activity, arbitrary artifacts or provider-hosted invocations.
- `PostgresTeamLibraryLifecycle.installRelease` writes workspace `asset_installations`. It does
  not install files into a member's native Agent or register a provider-hosted capability. A Loop
  with Connection requirements is rejected with `team_library_install_connection_lifecycle_unavailable`.
- Loop publication with Connection requirements remains blocked until a safe consumer binding flow
  exists; publisher credentials are never embedded in a release.
- The fixed `v0.30.0 / da9c0673` LinkCode/Pi bridge reads Project/Work data and stages bounded
  Work Item changes; it rejects non-Pi and non-empty MCP configuration. It has no Codex/CC native
  host, shared capability dispatch, native package installation receipt or durable proposal recovery.
- The registered Device gateway and leases provide a transport foundation. Native Agent capability
  inventory, independent delegated contexts, provider grants, compatibility probes and actual
  cross-member execution are not implemented by the existence of that gateway.

The weekly-feedback model path completed through the real configured DeepSeek route on 2026-09-22,
after the owner recharged the account. Run `run-58d1f22c-e148-42f8-8d36-2a392434fc4d`
replays the failed Run's fixed plan and inputs; the browser displayed all three completed steps and
three source-linked suggestions, explicitly retaining unknown counts/frequency/budget. A response
contract defect returned a bare ID after accepting retry/cancel commands; these now return the
canonical `{ runId }` receipt, with application output checked against the public schema. The
accepted retry was located and inspected without issuing another model call.

The earlier diagnostic returned HTTP 402 `Insufficient Balance`. The executor now classifies 402 as
`provider_payment_required`, carries only the fixed public code through Broker/Runner, and shows an
actionable billing/model-choice message. No automatic credential/model substitution was performed.
Prior failed records remain unchanged.

The same browser then published weekly-feedback Loop 1.0.0, created an independent consumer copy
from the Team Work release picker, and completed a second real DeepSeek Run with declared synthetic
team inputs. Its final result remained in the Work Item after reload as awaiting human acceptance.
The shared Run did not complete the Work Item. This verifies hosted Product execution and shared
results, not model-driven native Agent participation or provider-hosted delegation.

Publication exposed and repaired an exact-version authorization bug: a workspace-released Skill
version remains reusable even while its author's editing asset/draft is private. Authorization joins
the immutable release by workspace, Skill version ID and content hash; it does not widen asset/draft
visibility or grant management of the source. Real HTTP/PostgreSQL acceptance exercised another
member saving that Skill reference while still receiving 404 for the author's private draft.
The full publication/shared-Run/native-MCP integration also passed after this change.

Real Run replay additionally exposed database lease-maintenance events leaking into the public
progress stream. Public replay now excludes lease/recovery/decision receipts while preserving the
original sequence cursor; durable records remain intact. The completed Run page reconnected and
showed live updates after the repair.

Native setup now has a downloadable standalone connector in Settings → My Agents; see
[`integrations/native/README.md`](../../domains/agent/code/agent-runtime/integrations/native/README.md).
A real Codex CLI model completed a bounded native participation check through loopback PKCE login,
MCP and isolated PostgreSQL: it read the existing audience and another member's shared final result,
then wrote one explicitly authorized synthetic handoff quoting that result without accepting the work.
The opt-in `TURNSU_NATIVE_CLIENT_ACCEPTANCE=codex` integration passed. This is not native execution
of the full weekly-feedback workflow. Claude Code and Pi returned model-account HTTP 401 and need
their respective login credentials restored before model acceptance can continue.

Settings now includes **My Agents** for browser-session-owned native authorizations in the current
workspace. Members can list their active authorizations and revoke one without possessing its local
credential file. The browser-only endpoints require an active session; revocation also requires origin
and CSRF validation. Responses omit keys/tokens and do not claim an Agent is online. Existing native
session ownership fencing and atomic access/refresh revocation remain authoritative. Device commands
now record their time after authorization, and heartbeat responses retain the validated membership
state instead of incorrectly reporting offline.

Real PostgreSQL/HTTP acceptance covers cross-member denial, CSRF rejection, repeated revocation and
access/refresh rejection after disconnection. A separate isolated account using the production frontend
and real Product handlers passed desktop and 390px manual browser checks: cancel preserved the
connection, confirm removed it, refresh retained the result, and a server-side token probe failed.
The temporary UI fixture did not compose model/task services and is not evidence for those paths.
The connection list remains an authorization/recovery surface, not an online-Agent monitor.

The Web build now produces a standalone connector ZIP with bundled runtime dependencies, source-file
checksums and third-party notices. Settings provides an Agent selector, download and a start command
for the current Product origin. The launcher opens an installed Codex CLI, Claude Code or Pi with
per-launch MCP/extension configuration; it does not rewrite global host settings or copy native model
credentials. Default Turnsu profiles live in private user directories, separated by origin and Agent.
Node 22.19+ and an installed native CLI are still prerequisites; Windows is unverified.

The extracted bundle outside the repository completed real PKCE login, stdio MCP, another member's
shared-result read, idempotent handoff and permission revocation through isolated PostgreSQL/HTTP.
The installed Codex CLI accepted the per-launch configuration, and Pi 0.85.1's actual loader registered
the bundled extension. Host argument/process tests do not claim native model completion. Browser
selection/copy feedback and a real download event passed; the served ZIP matched the build checksum.
The new flow removes the checkout/npm-install requirement. It remains terminal-based and is not a
signed desktop installer, embedded native chat host, delegated execution environment or full workflow
acceptance across all three Agents.

Team Work now uses a project/list view and a focused single-work view instead of a permanent third
inspector column. Latest results open on demand, previous results are collapsed, and status/owner/date
editing lives in a management dialog. Default content omits Run/version identifiers and input JSON.
Desktop (1280px) and mobile (390px) browser checks covered result reading, list return, cancel-discard
and focus restoration; the existing web smoke and production build passed.

Standard instruction Skill packages now have an authenticated exact-release download endpoint and
project-scoped native installer. The reader joins the workspace release, immutable version, promoted
object and active membership, verifies object/package hashes, and does not expose the private draft.
Packages requiring dedicated runtimes, scripts, Product tools or connections are explicitly rejected
until native bindings exist. The installer preserves original files, checks path collisions/symlinks,
requires an explicit old release for updates, and refuses to overwrite local changes. A local receipt
records provenance and checksums; it is not another Product authorization or execution record.

Real HTTP/PostgreSQL acceptance downloaded as a second member, installed through the CLI and into
all three native project locations, and verified original bytes, idempotence and denied access after
revocation/suspension. Unit behavior checks covered version replacement, local edits, path traversal,
case collisions, symlinks and corrupt downloads; Pi 0.85.1 discovered the installed package with its
real loader. The test also exposed a missing explicit Authorization header in native logout, now fixed.
Codex CLI 0.150.1 actually read the installed SKILL.md and its named format reference, then summarized
two synthetic feedback statements with exact quotes and an unknown frequency. The opt-in
`TURNSU_NATIVE_SKILL_ACCEPTANCE=codex` PostgreSQL scenario passed. Installation itself still reports
`nativeExecution: not_verified`; compatibility is not inferred for other clients or different packages.

Team Library now omits the permanent inspector and duplicated global heading. Rows open usage details;
Skill parameters are collapsed, while native download and adding to Turnsu are separate actions.
The native dialog provides Codex/Claude Code/Pi project locations and prepares a ZIP preserving the
authorized release's original files. Browser checks covered desktop and 390px layouts and the API-backed
download-start state; the in-app browser did not deliver a download event, so saved-file completion is
not verified. Archive round-trip checks verify original bytes, hashes and path rejection separately.
Downloading does not assert installation, native execution or automatic result sharing.

Published Skill display metadata now comes from the exact immutable version, not the author's current
draft. Team Library lists workspace-visible releases. The HTTP/PostgreSQL regression creates a new
private draft, changes its name, and proves the other member still reads/downloads the old release while
being denied the private draft. Migration 037 permits the previously blocked published-to-new-draft
transition only with a different valid draft and unchanged latest published version; reopening the old
draft in place remains forbidden. The web smoke/build and focused read-model/real PostgreSQL checks pass.

Work details now render shared thread updates directly and let contributors post an update without
opening a private Agent task. Accountable owners can record a structured decision in the same view.
Both actions use existing Product commands and stable retry keys; the audience is shown before submit,
and neither action completes the Work Item. Longer content and older updates open on demand. The
thread endpoint accepts optional descending cursor order (ascending remains the compatibility default),
so recent activity is not hidden after the first page. The UI refreshes while visible and paginates history.
Real HTTP/PostgreSQL acceptance covers newest-first pagination alongside existing cross-member reads,
write restrictions, idempotency and revocation. Desktop/mobile browser checks posted an update and a
decision to the existing one-member local acceptance item and confirmed persistence after reload;
this is manual browser acceptance, not an automated browser regression or new native-model proof.

Native dependency bindings, complete native model workflows, shared-provider grants and isolated
dispatch, team unattended environments, offboarding and recovery remain required work. Do not mark
the full product goal complete from the protocol, database or UI subset above.
