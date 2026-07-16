# Crypto Loop Workbench v1 Agentteam Implementation Plan

- Date: 2026-06-18
- Status: implemented in this iteration

## 1. Summary

Implement Crypto Loop v1 inside the current Blocks Workbench without changing runtime contracts.

Chosen defaults:

- `App loop v1`.
- `Import summary`.
- `Review only`.

## 2. Agentteam Roles

Research agent:

- Read external crypto loop memory sources.
- Extract stable rules.
- Do not edit files.

Product/PRD agent:

- Add PRD and memory-integration architecture docs.
- Update active wiki source of truth.

Swift UI agent:

- Extend `WorkbenchLoopTemplate`.
- Add four Crypto loop templates.
- Update Loop Template Picker and Result Canvas copy.
- Add UI smoke assertions.

QA agent:

- Check active docs do not treat external paths as runtime dependency.
- Check UI smoke includes crypto loop assertions.
- Run Swift build/test/UI smoke.

Main agent:

- Own all final writes.
- Resolve conflicts.
- Update PROJECT_WIKI with verification results.

## 3. Implementation Boundaries

Allowed:

- Swift frontend-only model fields.
- Crypto loop template prompts.
- Loop picker presentation.
- UI smoke assertions.
- Product/wiki docs.

Not allowed:

- backend API changes.
- runtime artifact contract changes.
- Pi/Python/harness changes.
- external `skill调用` file writes.
- Trading Zac invocation.
- dry-run or live trading.

## 4. Acceptance

- Crypto block shows exactly the four v1 loop families.
- Picker explains trigger, steps, feedback gate, exit condition and review-only boundary.
- Composer prompt for each crypto loop explicitly blocks Trading Zac, dry-run and live trading.
- Result Canvas shows review-only status for Crypto loops.
- `swift build`, `swift test`, UI smoke and `git diff --check` pass.

## 5. Verification Commands

```bash
swift build
swift test
swift run WeChatIntelligenceRadar --ui-smoke-check
git diff --check
```
