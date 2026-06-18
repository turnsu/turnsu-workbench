# Vertical Blocks + Loop Workbench PRD

- Date: 2026-06-18
- Status: active frontend product direction
- Scope: Swift App UX, interaction model, prototypes, documentation
- Supersedes: Command Desk v2 as final active design

## 1. Product Read

The App is a macOS native productivity workbench for a single high-frequency operator. It is not a generic dashboard, source browser, terminal, or raw agent console.

The active product model is:

```text
Domain Blocks -> Loop Templates -> Run / Review / Follow-up
```

This matches the actual work:

- Crypto: call CMC / Skill Hub-backed market capabilities, read returned market analysis, review caveats, ask follow-ups, and run repeated opportunity loops.
- Markets: use equity / macro / cross-asset research methodology and future data providers to produce research drafts, evidence gaps, and review tasks.
- Office: turn audio, files, screenshots, notes, and instructions into meeting minutes, document drafts, reviewable transcript output, and Feishu delivery previews.

## 2. Users

Primary user:

- Works from a local Mac.
- Frequently asks for crypto/markets research and daily office writing.
- Needs fast task launch, short-loop follow-up, review, and delivery control.
- Does not want to see internal tools, providers, normalizers, raw MCP payloads, artifact paths, or implementation names.

## 3. Goals

1. Make the first screen a real working surface for vertical agent loops.
2. Make CMC / Markets / Office tasks easy to start without exposing raw skill lists.
3. Make the active run readable and reviewable without a global Inspector.
4. Keep final output authority simple: only `AgentFinalReadModel.finalText`.
5. Keep low-level Pi / Python / harness / provider architecture unchanged in this frontend iteration.

## 4. Non-Goals

- Do not change backend public API.
- Do not change runtime artifact contracts.
- Do not change Pi Kernel, Python, provider adapters, gates, or final-output architecture.
- Do not expose internal MCP skills, provider IDs, normalizer IDs, worker IDs, raw payloads, or artifact paths.
- Do not add Feishu live publish/reply as a persistent workbench entry.
- Do not add trading, WeChat sending, external posting, or destructive actions.

## 5. Core Information Architecture

Top-level navigation remains:

- Workbench
- History
- Settings

Workbench becomes Blocks Workbench:

- Block Rail: `Crypto`, `Markets`, `Office`.
- Loop Templates: 3 to 5 user-comprehensible templates per block.
- Active Loops: running, review-ready, blocked, completed, and failed tasks.
- Result Canvas: the current selected run or selected template explanation.
- Loop Composer: domain-aware prompt, quick prompts, attachment affordance, `/add` loop selector, run/continue/review/refine/delivery actions.
- Task Detail Sheet: Evidence, Review, Policy, CMC, ASR, Loop, Memory, Subagents. It is task-local only.

## 6. Domain Blocks

### Crypto

Purpose:

- Crypto data retrieval and market analysis.
- CMC returned result display.
- Market scan, thesis review, opportunity watch, and follow-up loops.

Default templates:

- Market scan
- Thesis review
- Opportunity watch

Result canvas emphasis:

- CMC returned result.
- Market markdown.
- Evidence and price caveats.
- Next follow-up prompts.
- Review action when claim quality is uncertain.

### Markets

Purpose:

- Equity, macro, and cross-asset research.
- InvestSkill / cc-equity-research style methodology through a unified Markets Research package.

Default templates:

- Company deep dive
- Earnings review
- Cross-asset read-through

Result canvas emphasis:

- Research draft.
- Evidence gaps.
- Review status.
- Follow-up tasks.
- No `BUY / SELL` action commands as primary UI.

### Office

Purpose:

- Meeting minutes, transcript review, document drafting, and Feishu preview/confirmation.

Default templates:

- Meeting minutes
- Doc draft
- Feishu preview

Result canvas emphasis:

- Meeting transcript status.
- Cloud ASR status: `云端转写 · 阿里云百炼 · OSS 临时上传`.
- Draft body.
- Review and delivery controls.
- Feishu write/publish remains preview/confirmation gated.

## 7. Loop Template Contract

A frontend loop template is not a raw runtime tool. It is a user-facing task shortcut.

Each template should include:

- `id`
- `domain`
- title
- short description
- trigger phrase
- expected output
- review gate
- exit condition
- default prompt
- default public skill/extension/capability selections when needed
- allowed actions

The frontend can set existing selected Skill/Extension/Capability fields, but it must not introduce a second routing contract or bypass backend planner validation.

## 8. Loop States

Active Loops should compress runtime states into user-readable statuses:

- Running
- Review-ready
- Blocked
- Completed
- Failed
- Draft-ready

The UI can show concise state labels and colors, but color must not be the only status signal.

## 9. Review / Follow-up Workflow

User actions:

- Run loop
- Continue
- Review
- Refine draft
- Prepare delivery

Review opens a task-local sheet. It can show evidence, CMC/ASR summaries, policy notes, memory/subagent status, and diagnostics. It must not become a global Inspector or runtime object browser.

Follow-up writes a prompt into the Loop Composer. It should preserve the selected block and use capability loop suggestions when available.

## 10. Acceptance Criteria

- Default Workbench shows Domain Blocks, Loop Templates, Active Loops, Result Canvas, and Loop Composer.
- Crypto, Markets, and Office are visible as blocks.
- `/add` opens loop templates for the selected block, not a raw skill/provider list.
- Result canvas never displays raw tool/provider/internal IDs.
- The final answer is read only from `AgentFinalReadModel.finalText`.
- Feishu live write is hidden or confirmation-gated.
- There is no global Inspector or source browser in the default product path.
- Swift build, tests, and UI smoke pass with new Blocks Workbench assertions.
