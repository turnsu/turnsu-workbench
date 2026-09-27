# Current Frontend Truth: Agent / Skill / Loop Workbench

Date: 2026-07-28

This is the active frontend product truth for
`domains/frontend/web/code/web-prototype`. The executable M5 specification is the
[`2026-07-28 M5 design package`](../../../wiki/design/skill-loop-cloud-workbench-v1/m5/README.md)
and its linked component/flow documents. `docs/rebuild/07-ux-restructure-m5.md` is
implementation background only and is superseded wherever it conflicts.
Older three-surface or separate Chat/Image composer documents are historical
background and must not be used to restore the previous UI.

## Active product and IA

The workbench has four primary surfaces:

- `Agent`: canonical `/` landing page and current-user multi-task workspace. One
  bottom composer handles governed model capabilities without a text/image mode
  switch. Session state, execution details and result reading stay in one task flow.
- `Skills`: create, import, inspect, test, validate, publish and version Skills.
- `Loops`: design, compile/test and publish/share Loops. Run results remain immutable
  Run records rather than a Loop lifecycle state.
- `Team library`: published reusable Skill and Loop releases.

Builder, Run preflight/detail, Skill lifecycle pages and member management are
addressable secondary routes, not competing top-level products. `/agent` remains a
compatibility alias for `/`.

## M5 creation contracts

### Skill

The first decision is `定义新技能` versus `导入已有技能`.

- Definition is a seven-step wizard: type, responsibility and I/O, runtime,
  category/tags, generated package, smoke example and review.
- Direct definition supports Prompt plus Product-catalogued Python 3.12 and Node.js
  20 TypeScript Docker-sandbox packages. Tool Skills can be created only from
  Product API registered packages and their exact Action IDs. Workflow is a Loop,
  not a Skill runtime.
- Import supports browser directory, bounded ZIP, public GitHub repository and
  admin allowlisted server paths. GitHub reads only `SKILL.md` and the optional
  complete governed runtime pair: `skill.runtime.json` plus the exact Python or
  Node TypeScript entrypoint.
- The wizard creates a private Draft. Test, validation and publish are separate,
  explicit lifecycle actions.

### Loop

The first decision is `从文档生成工作流` versus advanced `.loop.json` import.

- Document input creates an expiring staged proposal only.
- The user reviews and can edit the name, goal, context, constraints and proposed
  node titles before `保存为草稿`.
- No canonical Workflow/Loop is stored until that commit succeeds atomically.
- Blank, template/starting point and duplicate paths remain inside the advanced
  entry.
- The board exposes `设计中` / `可运行` / `已发布共享`; it never invents a `有结果`
  Loop state.
- Ready Loop execution calls the Product Loop-to-Agent task endpoint and then
  deep-links to the exact returned personal Session. The Agent consumer validates
  that Session against the current user's Session list; `/loops/:id/run` remains a
  compatibility route, not the M5 primary path.

## Model selection boundary

`ModelSwitch` is the shared compact chip + popover. The browser filters profiles by
task capability and sends only `modelProfileId`. It never creates provider-specific
OpenAI, Anthropic, Gemini or Stability payloads and never chooses an immutable
revision. The Product backend resolves the current profile revision when a Turn or
proposal is queued and persists that pin for replay and audit.

## State and trust boundaries

- TanStack Query owns Product API server state.
- The Builder editor owns one unsaved revision draft.
- `localStorage` stores only user-scoped theme/locale preference and one explicit
  legacy draft recovery path; it is not product truth.
- Raw server/user strings render as returned. Frontend demo-copy rewrite tables are
  forbidden.
- Browser code calls only the same-origin Product API. Provider credentials,
  provider wire payloads, Worker controls and internal artifact paths never enter the
  frontend.

## Required verification

Run from `domains/frontend/web/code/web-prototype`:

```bash
npm run build
npm run smoke
npm run state:smoke
npm run m5:smoke
npm run dom:smoke
npm run focus:smoke
npm run accessibility:smoke
```

Static checks cannot replace the DOM path. If Docker/Mongo/Provider are unavailable,
record the affected checks as unverified; do not report them as passed.
