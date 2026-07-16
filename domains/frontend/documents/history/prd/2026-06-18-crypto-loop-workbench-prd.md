# Crypto Loop Workbench v1 PRD

- Date: 2026-06-18
- Status: active
- Scope: Blocks Workbench Crypto Domain, frontend loop templates, review-only workflow

## 1. Product Goal

Crypto Loop v1 turns the existing Crypto block into a practical research workbench for repeatable market loops:

- scan broad crypto market state.
- deep-dive only clean candidates.
- review thesis support and counter evidence.
- draft trade plans with triggers, invalidation and R:R.

The App does not execute trades. It creates research conclusions, trigger plans and human review tasks.

## 2. Source Memory

This PRD summarizes stable rules from:

- Codex thread `019ec1a6-1638-7742-8716-2471b2ee6a65`.
- The external `skill调用` project skills for periodic market reports and DeFi opportunity scans.

The current repo does not import external `MEMORY.md`, historical reports, state files or Trading Zac commands.

## 3. User Workflows

### Market Report Loop

Use when the user wants a periodic crypto market scan or one-off market report.

Output:

- market regime.
- candidate funnel.
- missing/stale inputs.
- state changes.
- next review conditions.

### DeFi Opportunity Scan

Use when the user wants to find clean crypto / DeFi / public-contract opportunities.

Output:

- 1-3 deep-dive candidates.
- four-question depth gate.
- R:R hypotheses.
- A/B/C/D execution layers.
- human review checklist.

### Thesis Review

Use when the user wants to review a BTC/ETH/SOL or token thesis.

Output:

- support evidence.
- counter evidence.
- data gaps.
- invalidation conditions.
- follow-up prompts.

### Trade Plan Review

Use when the user wants to turn research into a reviewable plan.

Output:

- portfolio stance.
- risk budget.
- entry prerequisites.
- trigger and invalidation.
- stop/target references.
- `NO_TRADE` or wait-for-trigger when appropriate.

## 4. Review-Only Boundary

Crypto Loop v1 is review-only:

- no Trading Zac invocation.
- no dry-run.
- no live trading.
- no WeChat sending.
- no external publishing.
- no hidden state-file writes to the external `skill调用` project.

The final answer remains `AgentFinalReadModel.finalText`.

## 5. UX Requirements

- Crypto block shows four loop templates: `Market Report Loop`, `DeFi Opportunity Scan`, `Thesis Review`, `Trade Plan Review`.
- Loop Template Picker shows trigger, steps, feedback gate, exit condition and review boundary.
- Composer prompts must explicitly say `不调用 Trading Zac` and `不触发 dry-run 或 live 交易`.
- Result Canvas shows a `Crypto Loop v1 · review-only` note.
- The UI must not expose raw MCP tools, provider IDs, normalizers, workers, artifact paths or external project paths.

## 6. Acceptance Criteria

- `swift build`, `swift test` and UI smoke pass.
- UI smoke reports:
  - `ui_smoke_crypto_loop_templates_visible=true`
  - `ui_smoke_crypto_market_report_loop_visible=true`
  - `ui_smoke_crypto_opportunity_scan_visible=true`
  - `ui_smoke_crypto_trade_review_only=true`
- Active docs state that Trading Zac is not triggered by the App.
- Active docs state that external `skill调用` memory is summarized, not imported.
