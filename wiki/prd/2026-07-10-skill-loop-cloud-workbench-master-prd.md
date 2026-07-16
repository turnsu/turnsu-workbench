# Looloomi Skill & Loop Cloud Workbench Master PRD

- Date: 2026-07-10
- Status: target product requirements
- Scope: Web, Product Backend, Agent Runtime, cloud team workspace
- Current implementation reference: [Current System Architecture](../architecture/CURRENT_SYSTEM_ARCHITECTURE.md)

## 0. Document Role

This document defines what the product must become. It does not claim that all requirements
are implemented today.

The current system architecture remains authoritative for implemented behavior, current API
contracts, and known runtime gaps. This PRD changes the target product direction in one
important way: minimal team workspaces, cloud upload, and controlled sharing are now core V1
requirements instead of an indefinite future marketplace feature.

Use this PRD together with:

- [Skill Lifecycle and Creator PRD](2026-07-10-skill-lifecycle-and-creator-prd.md)
- [Loop Authoring, Orchestration, and Runtime PRD](2026-07-10-loop-authoring-orchestration-runtime-prd.md)
- [Team Cloud Library and Governance PRD](2026-07-10-team-cloud-library-governance-prd.md)
- [Web Product Experience PRD](2026-07-10-web-product-experience-prd.md)
- [Backend and Agent Platform PRD](2026-07-10-backend-agent-platform-prd.md)

## 1. Product Problem

High-frequency Agent users already have many useful Skills, but those capabilities are
scattered across local folders, repositories, tools, and team members. They repeatedly solve
the same composition problem by remembering which Skill to call, reconstructing a prompt,
and manually passing outputs between steps.

The product must solve five connected problems:

1. **Skill sprawl**: users cannot reliably find, understand, test, version, or improve a large
   personal Skill collection.
2. **Repeated composition**: users rebuild the same multi-Skill process for recurring work.
3. **Loop drift**: reusable processes are difficult to inspect, tune, version, verify, and
   rerun after requirements change.
4. **Team fragmentation**: Skills and Loops remain on individual machines and cannot be
   discovered, reused, governed, or improved as shared team assets.
5. **Creation friction**: there is no product-grade cloud path to create or upload a Skill,
   or to create or upload a Loop that combines an explicit goal contract with executable
   Skill steps.

The current prototype proves graph editing and a backend-backed run path, but the visible
product is dominated by one blocked sample, infrastructure readiness, an empty canvas, and
mixed technical terminology. It demonstrates architecture rather than the user's daily job.

## 2. Product Thesis

Looloomi is a cloud workbench where individuals and teams turn Agent capabilities into
versioned, reusable operating assets.

It provides one connected lifecycle:

```text
Create or upload a Skill
  -> test and publish a version
  -> create a Loop from a goal, template, or blank canvas
  -> combine pinned Skill versions
  -> validate and test the Loop
  -> publish to a personal or team library
  -> run, review, rerun, and improve from evidence
```

The product is not a generic Agent chat, a monitoring console, or a marketplace. Chat may
help draft or modify an object, but the durable product value is the versioned Skill and Loop.

## 3. Canonical Product Language

The product must use one human-facing vocabulary consistently.

| Term | Meaning | User-facing status |
|---|---|---|
| `Skill` | A versioned capability package with instructions, optional resources, declared inputs/outputs, permissions, tests, and an executable binding. | Primary object |
| `Loop` | A reusable Agent execution specification containing a goal contract, an executable graph of Skill steps, inputs, review rules, outputs, and verification. | Primary object |
| `Loop version` | An immutable saved or published snapshot used by Runs. | Primary version object |
| `Run` | One execution of one pinned Loop version with specific inputs and review decisions. | Embedded in Loop detail |
| `Team library` | Published Skills and Loops available inside a workspace. | Primary discovery surface |
| `Template` | A published Loop version marked as a recommended starting point. Using it creates a new Loop draft. | Creation aid, not a top-level object |
| `Workflow graph` | The node-and-edge execution graph inside a Loop. | Builder implementation concept |

`Workflow` remains a transitional backend and code term in the current v1 API. The product
must not create a second durable object that duplicates the existing Workflow aggregate.
The Web uses `Loop`; the backend maps it to the same revisioned graph until a contract migration
is justified.

## 4. Target Users

### 4.1 Individual Operator

Uses many Skills every day, wants to find the right one quickly, tune instructions, combine
steps, and rerun recurring work without reconstructing the process.

### 4.2 Skill Author

Creates reusable Agent procedures and tool integrations. Needs package scaffolding, validation,
tests, safe execution, versioning, usage visibility, and a controlled publishing path.

### 4.3 Loop Builder

Turns a business goal into a repeatable process. Needs both a readable goal contract and a
visual execution graph, plus compile diagnostics, test Runs, review gates, and version diffs.

### 4.4 Team Maintainer

Curates trusted Skills and Loops for a team. Needs ownership, visibility, approvals, dependency
impact, version adoption, audit history, and the ability to retire unsafe versions.

## 5. Jobs To Be Done

| Job | User question | Required product response |
|---|---|---|
| Find a capability | “Which Skill should I use, and can it run here?” | Search by outcome, input, owner, risk, and readiness; show a clear contract and test evidence. |
| Improve a Skill | “Can I change this without breaking every Loop?” | Create a draft version, compare changes, test it, inspect usage, and publish intentionally. |
| Build a repeatable process | “How do I turn this goal into reliable steps?” | Draft a Loop contract, suggest Skills, compose the graph, map data, validate, and test. |
| Tune a Loop | “What changed, and will the next Run behave differently?” | Version diff, compile result, test Run comparison, and explicit publish. |
| Reuse team work | “Can I install or fork what a teammate built?” | Team library, trust signals, dependency preview, install/fork/update flows. |
| Share safely | “Who can use or modify this?” | Workspace visibility, roles, publish controls, audit log, and secret isolation. |
| Run with confidence | “What will happen, what needs approval, and what did it produce?” | Preflight, visible review gates, node timeline, final result, evidence gaps, and rerun. |

## 6. Product Principles

1. **Objects before chat**: every meaningful action creates, edits, publishes, or runs a
   visible Skill or Loop.
2. **Readable before executable**: a person must understand purpose, requirements, side
   effects, outputs, and stop conditions without reading schemas or source code.
3. **Versioned by default**: published Skill and Loop versions are immutable. Runs always pin
   exact versions.
4. **Graph plus contract**: the canvas explains execution order; the Loop contract explains
   intent, constraints, completion, verification, and escalation. Neither replaces the other.
5. **Proposals, not silent edits**: Agent-assisted creation produces a structured diff that the
   user confirms.
6. **Readiness is earned**: availability comes from validation and runtime checks, not a UI
   toggle.
7. **Cloud sharing without secret sharing**: packages and metadata may be shared; credentials
   remain workspace-scoped bindings.
8. **Evidence closes the loop**: Run outcomes, failures, review decisions, and user ratings
   inform the next version.

## 6.1 Requirement Traceability

| User pain | Web requirement | Backend requirement | Agent requirement | Detailed PRD |
|---|---|---|---|---|
| Too many Skills to manage and tune | Skill library, creator, upload, tests, versions, usage, update impact | Draft/version registry, package ingestion, validation, publication, usage index | Immutable package loader, sandboxed tests, typed input/output validation | [Skill Lifecycle and Creator](2026-07-10-skill-lifecycle-and-creator-prd.md) |
| Repeated Skill composition | Definition/Outline/Canvas Builder and compatible Skill picker | Loop draft, compiler, dependency resolver, structured proposal apply | Execute the compiled graph without reordering it | [Loop Authoring and Runtime](2026-07-10-loop-authoring-orchestration-runtime-prd.md) |
| Loops are hard to understand and improve | Goal contract, versions, Run comparison, draft-from-Run | Immutable Loop versions, diff, compile/test evidence, Run lineage | Done-when/Verify evaluation, review revision input, authoritative final result | [Loop Authoring and Runtime](2026-07-10-loop-authoring-orchestration-runtime-prd.md) |
| Team assets are isolated | Team library, publish/install/fork/update, access recovery | Workspace tenancy, roles, object storage, approvals, audit, dependency impact | Workspace-scoped connection handles and policy enforcement | [Team Cloud Library](2026-07-10-team-cloud-library-governance-prd.md) |
| No cloud creation/upload | Global Create, guided creators, upload previews, validation progress | Quarantine, parser/scanner, content hashes, immutable releases, product-safe events | Discover and execute the exact approved package version | [Backend and Agent Platform](2026-07-10-backend-agent-platform-prd.md) |

## 7. Product Information Architecture

The primary navigation is intentionally small:

- `Skills`: personal and installed Skills, drafts, versions, tests, usage, and creation.
- `Loops`: personal and installed Loops, drafts, versions, Runs, and creation.
- `Team library`: published Skills, published Loops, recommended templates, collections, and
  update availability.

Global `Create` supports:

- Create Skill
- Upload Skill
- Create Loop
- Upload Loop

The Builder is a Loop editing route, not a fourth top-level product. Runs live under Loop
detail. Templates live inside “Create Loop” and Team library filters. Workspace settings,
members, credentials, and audit are secondary administration routes.

## 8. Core Product Flows

### 8.1 Create and Publish a Skill

1. Start from a description, a package upload, a folder/repository import, or a team Skill fork.
2. Create a draft containing `SKILL.md` and optional scripts, references, assets, and UI metadata.
3. Declare what the Skill needs, creates, may access, and may change externally.
4. Run static validation, security checks, setup checks, and at least one test case.
5. Compare the draft to the previous version.
6. Publish an immutable version to private or workspace visibility.
7. Show affected Loops and available updates without auto-upgrading them.

### 8.2 Create and Publish a Loop

1. Start from a goal description, a blank Loop, an uploaded Loop package, a duplicate, or a
   template.
2. Draft the Loop contract: goal, context, constraints, done conditions, verification, output,
   and stop rules.
3. Add Skills through recommendation, list selection, or canvas drag-and-drop.
4. Map inputs and outputs, define review gates, and configure failure behavior.
5. Compile on the server and resolve all invalid or blocked diagnostics.
6. Run a test with safe inputs; inspect timeline, review packet, output, and evidence gaps.
7. Save a version and publish it to private or workspace visibility.

### 8.3 Reuse Team Assets

1. Search the Team library by job outcome rather than internal capability ID.
2. Inspect owner, version, last validation, permissions, usage, dependencies, and examples.
3. Install a Skill or use a Loop as a template.
4. Resolve required workspace connections without receiving the publisher's secret.
5. Pin a version. Later updates remain opt-in and show an impact diff.

### 8.4 Run and Improve

1. Open a Loop and complete its generated input form.
2. Review the exact Loop and Skill versions, side effects, and approval points.
3. Start a Run and observe product-safe node progress.
4. Approve, request revision, or reject at review gates.
5. Inspect the authoritative final result and evidence.
6. Rerun the same version or open a new draft from the Run with suggested changes.

## 9. Functional Scope

### 9.1 V1 Must Have

- Personal and team workspaces with membership and minimal roles.
- Skill create, upload, edit, validate, test, version, publish, deprecate, and usage lookup.
- Loop create, upload, edit, compile, test, version, publish, duplicate, and rerun.
- Loop contract editor plus visual Skill graph.
- Team library for workspace-published Skills and Loops.
- Immutable published versions and explicit dependency pinning.
- Product-safe Run history, review decisions, final results, and evidence gaps.
- Cloud object storage for package files and Mongo metadata for product objects.
- English and Chinese product copy with no raw runtime or provider terminology.

### 9.2 V1 Should Have

- Agent-assisted Skill scaffolding and Loop drafting.
- Structured proposal review and apply.
- Version diff and update impact preview.
- Collections, favorites, recent objects, and usage analytics.
- Import/export of portable Skill and Loop packages.
- Workspace publish approval for high-risk or externally acting Skills.

### 9.3 Later

- Public marketplace and cross-organization publishing.
- Billing, monetization, ratings, and public creator profiles.
- Enterprise SSO, SCIM, legal holds, and advanced policy administration.
- Scheduled or event-triggered Loops.
- Autonomous optimization that changes published Loops without approval.
- General-purpose multi-Agent organization charts or an unrelated ops console.

## 10. Success Metrics

### Activation

- Median time from workspace creation to first validated Skill.
- Median time from first Loop draft to first successful test Run.
- Percentage of new users who publish or reuse at least one Skill or Loop in seven days.

### Reuse

- Skill reuse: median number of Loops referencing a published Skill.
- Loop reuse: Runs per published Loop version per week.
- Team reuse: percentage of published assets used by someone other than the author.

### Quality

- Compile success rate after the first edit session.
- Test Run completion rate and Review Gate resolution rate.
- Percentage of blocked states with a successful recovery action.
- Failure rate by Skill version and Loop version.

### Iteration

- Percentage of failed or revised Runs that lead to a new draft.
- Median time from issue discovery to a validated replacement version.
- Update adoption rate after impact review.

Guardrail metrics include unauthorized execution attempts, secret exposure incidents,
publish rollback rate, and Runs using deprecated versions.

## 11. Delivery Milestones

### Milestone A: Real Personal Assets

Replace the blocked sample catalog with real Skill and Loop CRUD, upload, validation, and
business Skill execution. Preserve the current compiler, immutable revisions, Product API,
Run events, and final-result authority.

### Milestone B: Contract-Aware Loop Builder

Add the Loop contract editor, blank creation, generic graph editing, natural-language proposals,
portable Loop upload, version diff, and complete test Run recovery.

### Milestone C: Team Cloud Library

Add workspace identity, membership, roles, cloud package storage, publish/install/fork/update,
audit, and secret-safe connection binding. This is part of target V1.

### Milestone D: Reliability and Governance

Add durable worker leases, crash recovery, cancellation, retry, policy approval, lineage,
metrics, retention, and high-risk publishing controls.

## 12. Master Acceptance Criteria

The V1 product is accepted only when a fresh team workspace can complete this path without
fixtures or direct database edits:

```text
Create or upload a Skill
  -> validate and publish version 1
  -> teammate discovers and installs it
  -> create a Loop with a readable Loop contract
  -> add the Skill and map its inputs/outputs
  -> compile and complete a test Run with review
  -> publish the Loop to the Team library
  -> second teammate creates a draft from it
  -> publish an improved Skill version
  -> inspect impact and explicitly update the Loop
  -> rerun and compare the result
```

Required proof:

- all objects persist across service restart;
- tenant boundaries prevent cross-workspace reads and writes;
- published versions remain immutable;
- exact Skill and Loop versions are visible on every Run;
- secrets do not enter packages, browser storage, events, or shared metadata;
- compile order comes from the saved graph;
- the final result comes from the authoritative Agent read model;
- every disabled action shows one understandable reason and recovery action;
- English and Chinese flows are complete and equivalent.

## 13. Key Risks

| Risk | Product response |
|---|---|
| Users cannot distinguish Skill, Loop, and template | Use the canonical language above; make templates a creation property, not a parallel object. |
| Visual graphs become unreadable documentation | Require the Loop contract and outline view; use the graph for data flow and execution order. |
| Team sharing leaks credentials | Publish declarations and connection requirements only; bind secrets per workspace at install/run time. |
| Uploaded code is unsafe | Quarantine, scan, sandbox, restrict egress/filesystem, require permissions, and gate publishing. |
| Version updates silently change behavior | Pin versions, show impact, require explicit update, and preserve historical Runs. |
| Agent assistance hides structural changes | Return a typed proposal and diff; require confirmation and recompile. |
| “Cloud collaboration” expands into a marketplace | Keep V1 workspace-scoped; public discovery, billing, and marketplace operations remain later. |

## 14. Decisions That Must Stay Explicit

- V1 team sharing is workspace-scoped, not public marketplace publishing.
- Published versions are immutable; editing always creates a new draft/version.
- Template use creates a new Loop draft; templates are never edited or run in place.
- A Loop is reusable but its graph remains acyclic in V1. Repetition means starting another
  Run, not drawing an execution cycle.
- Agent-generated changes are proposals. Readiness, publication, and execution remain
  server-authorized product actions.
