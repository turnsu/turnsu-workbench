# Crypto Loop Memory Integration

- Date: 2026-06-18
- Status: active frontend/product architecture
- Scope: stable rule import from external crypto loop memory

## 1. Decision

The external crypto trading loop memory is used as a rule source, not as a runtime dependency.

Imported:

- stable workflow rules.
- candidate lifecycle model.
- R:R and review gates.
- agentteam concurrency boundaries.
- review-only product copy.

Not imported:

- `/Users/chenge/Desktop/skill调用` paths.
- external `MEMORY.md`.
- historical report files.
- state markdown files.
- Trading Zac commands.
- live execution behavior.

## 2. Stable Rules

### Broad-to-Deep Flow

Crypto loops should start broad and then narrow:

1. broad market regime.
2. perp scanner.
3. on-chain / public-contract scanner.
4. focused deep dive on only 1-3 clean candidates.
5. final stance and review checklist.

Independent read-only research can run in parallel, but final synthesis is serial.

### Candidate Lifecycle

User-facing lifecycle labels:

- `观察`
- `回避`
- `持有`
- `出列`

Rules:

- Observation pool should stay small, normally no more than 5 candidates.
- `回避` and `出列` candidates do not revive just because a scanner mentions them again.
- Revival requires a new qualified event, such as CVD repair, spot/perp confirmation, key level acceptance/breakdown, holder/security/liquidity coverage or fresh catalyst.
- `持有` requires protection, stop, reduce, invalidation and fresh risk review before any added exposure.

### Four-Question Depth Gate

Each deep-dive candidate must answer:

- price / OI support.
- funding / basis quality.
- spot CVD and futures CVD agreement.
- multi-timeframe structure.

If spot/perp confirmation is missing or conflicting, the candidate stays review-only.

### R:R Gate

- A-level executable plan requires structural R:R >= 2:1.
- R:R < 1.5:1 rejects trade execution.
- R:R is not only a pass/fail gate. The answer must explain entry, stop, first target, second target, potential loss, potential gain and what trigger would improve R:R.

### NO_TRADE Is Valid

No clean setup is a successful output. The App should make `NO_TRADE`, `cash`, `wait for trigger`, `risk rejected` and `review required` feel normal, not like failures.

## 3. Agentteam Boundary

Can run in parallel:

- broad CMC overview.
- perp scanner.
- on-chain scanner.
- different-symbol deep dives.
- macro/cross-asset checks.
- safety/liquidity/holder review.

Must remain serial:

- final stance.
- trade plan synthesis.
- status lifecycle decision.
- memory/writeback decisions.
- any execution path.

In this App v1, there is no execution path. Agentteam outputs are research summaries only.

## 4. App Mapping

Current App surface:

- Crypto Domain Block.
- four Crypto Loop Templates.
- Loop Composer prompt.
- Result Canvas review-only note.
- task-local Review / Evidence sheet.

Current runtime:

- existing CMC Skill Hub capability package.
- existing planner and gate behavior.
- existing final read model.

No backend contract changes are required for v1.

## 5. Safety Copy

Every Crypto review loop should make these boundaries visible in prompt or result context:

- research and review only.
- no Trading Zac invocation.
- no dry-run.
- no live trading.
- no external send/publish.
- final answer only from `AgentFinalReadModel.finalText`.
