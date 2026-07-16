# Project Wiki

Updated: 2026-07-10

## Product Direction

Looloomi is a Skill & Loop cloud workbench. It helps individuals and teams:

- create, upload, test, version, publish, and improve Skills;
- turn a goal contract and pinned Skills into an executable Loop;
- compile, run, review, rerun, and compare immutable Loop versions;
- discover, install, fork, and explicitly update workspace-published assets;
- share packages and metadata without sharing credentials.

`Skill`, `Loop`, and `Run` are the primary product terms. `Workflow` remains a current backend
and graph term. Templates are published Loop starting points, not a separate durable product.

## Sources of Truth

Read in this order:

1. [../PRODUCT.md](../PRODUCT.md) for product scope and language.
2. [prd/README.md](prd/README.md) for the target product PRD set.
3. [design/skill-loop-cloud-workbench-v1/README.md](design/skill-loop-cloud-workbench-v1/README.md) for target UI/UX, diagrams, and visual directions.
4. [architecture/CURRENT_SYSTEM_ARCHITECTURE.md](architecture/CURRENT_SYSTEM_ARCHITECTURE.md) for implemented Web/Backend/Agent reality and boundaries.
5. [../DESIGN.md](../DESIGN.md) for the selected visual authority and current rejection boundary.
6. [../domains/frontend/documents/current-skill-workflow-loop-workbench.md](../domains/frontend/documents/current-skill-workflow-loop-workbench.md) for current frontend behavior, not visual acceptance.

Target PRDs do not prove implementation. The architecture and fresh QA evidence decide what is
working today.

## Current Full-Stack Status

The Web is connected to a same-origin Product API with workspace Skills, immutable revisions,
server compilation, durable Runs, SSE, Review Gate continuation, authoritative results, Team
library, upload/import, Builder proposals and version updates. Current capability details remain in
the architecture document.

The rendered Web visual result was rejected on 2026-07-15. Its functional behavior remains useful,
but its old layout and generated screenshot matrix are not current design evidence.

The current dependency direction is:

```text
Web -> Product API/BFF -> Product Store + Compiler/Runner
    -> Agent Runtime Core -> PI Kernel -> Skill adapters
```

The target extends this boundary with identity/workspaces, package ingestion, object storage,
secret-safe connections, Team library publication, and tenant-aware runtime execution.

## Active Surfaces

Current product navigation:

- Skills
- Loops
- Team library

Builder remains a Loop editing route. Runs remain attached to Loop detail. Templates move into
Loop creation and Team library discovery.

## Current Code and Evidence

- Web: [../domains/frontend/web/code/web-prototype/](../domains/frontend/web/code/web-prototype/)
- Product contracts: [../domains/backend/code/workbench-contracts/](../domains/backend/code/workbench-contracts/)
- Product server: [../domains/backend/code/workbench-server/](../domains/backend/code/workbench-server/)
- Agent Runtime: [../domains/agent/code/agent-runtime/](../domains/agent/code/agent-runtime/)
- P0 acceptance: [qa/2026-07-10-skill-workflow-loop-first-slice-acceptance.md](qa/2026-07-10-skill-workflow-loop-first-slice-acceptance.md)

## Historical Boundary

Crypto, markets, meetings, office, WeChat, old Blocks Workbench, Command Desk, LoopOps v2,
SwiftUI-first surfaces, and monitoring consoles are examples or history. They cannot define
active acceptance unless a current PRD explicitly references them.

Historical documents are indexed under [history/](history/) and
[../domains/frontend/documents/history/](../domains/frontend/documents/history/).
