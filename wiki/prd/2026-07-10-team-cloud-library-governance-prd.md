# Team Cloud Library and Governance PRD

- Date: 2026-07-10
- Status: target product requirements
- Parent: [Skill & Loop Cloud Workbench Master PRD](2026-07-10-skill-loop-cloud-workbench-master-prd.md)

## 1. Goal

Turn Skills and Loops from isolated local files into trusted, versioned team assets without
sharing credentials, losing ownership, or allowing silent behavior changes.

V1 collaboration is workspace-scoped. It is not a public marketplace.

## 2. Core Problems

- Team members cannot discover what already exists.
- Copying files loses provenance, updates, tests, and maintainership.
- Sharing packages may accidentally include credentials or private data.
- A useful Skill update may break many Loops without showing impact.
- Teams need a small, understandable approval model before they need enterprise governance.

## 3. Product Objects

| Object | Purpose |
|---|---|
| Workspace | Tenant and policy boundary containing members, assets, connections, and audit. |
| Membership | User role and status inside one workspace. |
| Library item | Published Skill or Loop version visible in a workspace. |
| Collection | Curated group of library items for a team, role, or use case. |
| Installation | Workspace availability and pinned version of a Skill or Loop. |
| Release | Immutable published version plus provenance, validation, permissions, and notes. |
| Connection requirement | Named capability needed by an asset; never contains publisher credentials. |
| Approval | Explicit decision required by workspace policy for publish or high-risk use. |
| Audit event | Durable actor, action, target, version, time, and safe change summary. |

## 4. Workspace Model

Each object belongs to exactly one workspace or to a user's private area within that workspace.
V1 supports switching workspaces but does not merge data across them.

Roles:

| Capability | Viewer | Member | Publisher | Admin |
|---|---:|---:|---:|---:|
| View workspace library | Yes | Yes | Yes | Yes |
| Install published assets | Policy | Yes | Yes | Yes |
| Create private drafts | No | Yes | Yes | Yes |
| Share draft for review | No | Yes | Yes | Yes |
| Publish low-risk version | No | Policy | Yes | Yes |
| Approve high-risk version | No | No | Policy | Yes |
| Deprecate owned release | No | Owner | Yes | Yes |
| Manage members/connections/policy | No | No | No | Yes |

Ownership and role are separate. A Member can own a draft but may still require Publisher
approval to release it to the Team library.

## 5. Visibility

V1 visibility levels:

- `Private`: visible to owner and explicitly invited collaborators.
- `Workspace`: visible in the Team library to authorized members.
- `Archived`: hidden from normal discovery but retained for history and pinned Runs.

Public and cross-organization visibility are later. The data model may reserve visibility
values, but the UI must not present unsupported publishing choices.

## 6. Publish Flow

Publishing a Skill or Loop version requires:

1. immutable content hash and version;
2. successful validation and test evidence for the current content;
3. dependency and connection inventory;
4. permission and external-action summary;
5. secrets scan and private-data warning;
6. release notes and owner;
7. policy decision or approval when required;
8. audit event after the release commits.

The publish review must show what teammates will receive and what remains workspace-specific.
Credentials, local file paths, test secrets, private resources, and raw runtime artifacts are
never included in the release.

## 7. Discover and Reuse

The Team library supports:

- combined search across Skill purpose, Loop goal, created output, owner, tags, and examples;
- filters for Skills, Loops, templates, installed, not installed, updates, ready, blocked,
  risk, connection, owner, and collection;
- recommended and recently updated sections without a marketing-style home page;
- detail views with versions, tests, dependencies, permissions, usage, examples, and lineage;
- `Install`, `Add to Loop`, `Use as starting point`, `Fork`, and `Request access` actions.

An installed Loop remains owned by the publisher unless forked. A template action always creates
a new Loop identity. An installed Skill can be pinned by local Loops without copying its files.

## 8. Install and Connection Binding

Installing an asset performs a preflight:

- confirms compatible runtime and Skill versions;
- lists required workspace connections and permissions;
- checks whether each connection is available to the current user/Runner;
- shows external actions and approval requirements;
- stores an installation record and selected version.

Connections are referenced by requirement type, for example “GitHub repository access” or
“Market data provider.” The installing workspace chooses its own credential binding. Publisher
connection IDs and secret values are never copied.

## 9. Fork, Update, and Dependency Impact

### Install

Retain upstream identity and receive update notices. Installed versions are read-only.

### Fork

Create a new editable identity. Preserve source workspace, object ID, version, and fork time as
provenance. Future upstream updates are informational and never auto-merge.

### Update

Show:

- old and new version;
- instructions or contract diff;
- input/output and mapping changes;
- permission and connection changes;
- validation/test differences;
- affected local Loops;
- migration notes;
- recommended retest scope.

Updates are explicit. Applying an updated Skill to a Loop creates a new Loop draft. A published
Loop version and historical Run remain unchanged.

## 10. Review and Approval

V1 supports object-level review before publication:

- author submits a specific draft content hash;
- reviewer sees diff, tests, permissions, dependencies, and policy findings;
- reviewer approves, requests changes, or rejects with a note;
- any content change invalidates the prior approval;
- approval and publish are separate audited events;
- high-risk external actions may require a Publisher or Admin.

This is publication governance, not Run-time Review Gate behavior. The two decision types must
not share ambiguous UI labels or backend states.

## 11. Audit and Provenance

Audit events include:

- workspace, actor, role, action, target, target version, request ID, and timestamp;
- safe change summary and approval reference;
- source upload/import/fork metadata;
- install, update, deprecate, permission, connection-binding, and Run-policy changes.

Audit data must not contain secrets, raw prompts containing private content, full uploaded file
contents, or provider payloads. Access to audit is role-controlled and retention is configurable
later; V1 uses a documented fixed retention period.

## 12. Security and Data Boundaries

- Every query and mutation is scoped by authenticated workspace membership.
- Object IDs alone never grant access.
- Browser sessions use HttpOnly cookies and CSRF protection.
- Package blobs use tenant-scoped authorization and signed, short-lived access where required.
- Uploads enter quarantine before parsing or execution.
- Secrets use a dedicated encrypted connection store, not Mongo object documents or object
  storage packages.
- Runtime receives only connection handles and bounded credentials at execution time.
- Cross-workspace cache keys, search indexes, event streams, and background jobs retain tenant
  identity.
- Deletion uses archive/retention rules when a published version is pinned by a Run or Loop.

## 13. Cloud Storage Requirements

Use separate concerns:

- Mongo: workspace, membership, object metadata, drafts, immutable versions, installs,
  approvals, dependencies, Runs, events, and audit indexes.
- Object storage: uploaded package blobs, immutable release files, test fixtures, approved
  assets, and product-safe Run artifacts.
- Secret store: encrypted credentials and connection bindings.
- Search index or derived Mongo search: discoverable metadata only, never secrets or raw
  private artifacts.

Every stored package version has a content hash, size, media inventory, scan status, and
provenance. The backend validates authorization again when issuing any download.

## 14. Failure and Recovery States

| State | Visible explanation | Recovery |
|---|---|---|
| Upload failed | File, size, network, or format reason | Resume or choose another package |
| Validation failed | Specific file/test/permission problem | Open draft at the affected section |
| Missing connection | Required service is not connected for this workspace | Configure connection or request Admin |
| Permission denied | Current role cannot perform the action | Request access or send for approval |
| Version conflict | Draft changed after opening | Review latest, merge, or save a copy |
| Upstream deprecated | Installed version has a replacement or warning | Review replacement and affected Loops |
| Asset removed from library | New installs unavailable; pinned history retained | Contact maintainer or fork allowed version |

No failure may expose bucket paths, storage keys, provider stack traces, or internal policy
implementation names.

## 15. Acceptance Criteria

A clean environment can prove:

1. two users join one workspace with different roles;
2. one user creates and publishes a validated Skill;
3. the other discovers and installs it without receiving the publisher's credential;
4. a Member cannot bypass required publish approval;
5. an approved Loop becomes visible in the Team library;
6. another user installs it or creates a new Loop from it;
7. a fork preserves provenance but has independent versions;
8. a Skill update shows all affected Loops and never auto-upgrades them;
9. cross-workspace list, detail, blob, SSE, and mutation requests are denied;
10. archived releases remain readable by authorized historical Runs;
11. all publish/install/fork/update/deprecate actions appear in the audit log;
12. secret scanning blocks a package that contains a credential and records no secret value.
