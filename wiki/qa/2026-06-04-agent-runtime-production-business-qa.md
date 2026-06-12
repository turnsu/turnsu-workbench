# Agent Runtime Production Business QA

Date: 2026-06-04

## Problem

The app could accept clicks and start tasks, but that did not prove the backend Agent could reliably finish business work. The missing production gate was the full path:

`session -> run -> skill/extension mount -> CMC data call -> tool observations -> final output -> app-visible result`

Before this checkpoint, CoinMarketCap showed as an available capability while the actual market gate could still be `normalizedFileProvider/degraded`.

## Fix Contract

- CoinMarketCap MCP is the primary market data source for the daemon.
- Provider order is `mcp_http -> mcp_bridge -> rest -> normalized -> fixture`.
- CMC Skill Hub MCP Streamable HTTP endpoint is the primary path: `https://mcp.coinmarketcap.com/skill-hub/stream`.
- CMC REST and CMC CLI are fallback/supplementary capabilities only.
- `provider-status.json` distinguishes mounted/configured/connected/degraded/missing-key states.
- Skill and extension packages are checked against actual Pi runtime tool registration.
- A run is not considered production-ready unless it writes `tool-observations.json` and `final-output.md`.
- Degraded CMC data must not allow concrete market prices, support/resistance, trading ranges, or fresh/live claims.

## Business QA Cases

The new `--business-qa-check` runner executes representative product scenarios against the same backend path the app uses.

Latest test summary:

- `btc_macro`: passed, `gate=pass/mcpProvider/fresh`, 12 tool observations.
- `sol_signal`: passed, `gate=pass/mcpProvider/fresh`, 11 tool observations.
- `alpha_scanner`: passed, `gate=pass/mcpProvider/fresh`, 8 tool observations.
- `image_market`: passed, `gate=pass/mcpProvider/fresh`, 8 tool observations.
- `cmc_degraded`: passed, `gate=degraded/normalizedFileProvider/degraded`, concrete prices blocked.

The fresh/live cases use a local fake CMC MCP HTTP server inside the test runner so CI can validate the MCP success path without real secrets. Real production refresh still requires a local `CMC_MCP_API_KEY` or equivalent runtime configuration.

## Acceptance Checks

- `npm test --prefix agent-runtime` includes the business QA runner.
- Every business run reaches `task.status=completed`.
- Every run writes `run-manifest.json`, `tool-observations.json`, and `final-output.md`.
- Final output contains structured sections and no raw MCP/tool markup.
- CMC MCP success creates a fresh `mcpProvider` gate.
- Missing CMC config degrades honestly and blocks concrete market values.
- App copy says Agent capability source status, not just AI model status.

## Verification

- `npm test --prefix agent-runtime`: passed.
- `swift test`: passed.
- `swift run WeChatIntelligenceRadar --contract-check`: passed.
- `swift run WeChatIntelligenceRadar --smoke-check`: passed with expected degraded market status in local smoke mode.
- `swift run WeChatIntelligenceRadar --ui-smoke-check`: passed.

## Guardrails

Do not read, print, or rewrite `.env`. Do not persist API keys, Authorization headers, raw MCP request bodies, raw WeChat private transcripts, or local absolute paths into user-visible chat output.
