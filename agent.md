# Project Agent Rules

Updated: 2026-05-28

## Purpose

This project builds a local-first WeChat x on-chain Agent workspace. The desktop app is the user interface; the Agent Runtime Host handles sessions, skills, extensions, internal tools, artifacts, and product mutations.

## Hard Boundaries

- `assignment-agent-raw` and `wechat-cli_raw` are read-only references.
- Do not run live WeChat reads, `wechat-cli init`, `wechat-cli history`, `wechat-cli search`, `wechat-cli sessions`, `wechat-cli new-messages`, trading, send-message, or external publish commands.
- Swift UI must not call MCP, RPC, live WeChat, live wechat-cli, or model providers directly.
- API keys, Authorization headers, cookies, and raw request bodies must not be written to code, wiki, runtime artifacts, logs, or screenshots.
- User-facing Agent UI exposes only Skill and Extension choices. Internal tools, providers, normalizers, and policy implementations stay inside Agent Runtime Host artifacts.

## Agent Runtime Contract

- Frontend request shape: prompt, selected skill IDs, selected extension IDs, attachments, and context references.
- Runtime Host maps selected skills/extensions to internal tools and policy decisions.
- Runtime artifacts under `runtime/agent/runs/{runID}/` are audit records, not user-facing capability menus.
- Product mutations must be local JSON and idempotent.
- WeChatCLI and CMC integrations must be extension packages with manifests, schemas, policies, fixtures, providers, and normalizers.

## Ops Contract

- Agent executes tasks and writes events/artifacts.
- Ops Runtime reads Agent outputs and writes health, metrics, provider readiness, dependency status, and policy summaries under `runtime/ops/`.
- Agent workspace UI should explain task progress; Ops UI should explain runtime health and failures.

## Documentation Contract

- Keep `wiki/PROJECT_WIKI.md` as the total project wiki.
- Keep `agent-runtime/wiki/AGENT_RUNTIME_WIKI.md` as the Agent-side wiki.
- Record architecture changes in `wiki/architecture/`.
- Completed or superseded plans/QA/architecture records should move to `wiki/history/`.
