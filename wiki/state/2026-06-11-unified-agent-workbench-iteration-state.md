# Unified Agent Workbench Iteration State

- Date: 2026-06-11
- Active goal: unified Agent workbench capability loops, review, memory contract, and tmux/subagent safe coordination
- Current phase: Phase 1-5 minimum vertical slice completed

## Phase Status

| Phase | Status | Evidence |
| --- | --- | --- |
| Phase 1 Capability Task GUI | completed | Command Desk exposes Capability Launcher, Crypto/Office loop templates, Review, and Follow-up |
| Phase 2 Capability Loop Artifacts | completed | Completed runs write `capability-loop-read-model.json` and manifest `capabilityLoopSummary` |
| Phase 3 Memory Adapter Contract | completed | Completed runs write `memory-read-model.json`; Hermes unavailable is explicit and no memory is written |
| Phase 4 tmux/Subagent Coordination Contract | completed | Completed runs write `subagent-coordination-read-model.json`; tmux integration is read-only dry-run |
| Phase 5 Review/Follow-Up Loop | completed | Result canvas opens task-local review sheet and can prefill a continuation prompt |

## Implementation Notes

- Do not add a second orchestrator.
- Keep final answer authority on `agent-final-read-model.json`.
- Keep Feishu live actions blocked or confirmation-gated.
- Keep tmux integration read-only.

## Verification Log

- `node --check agent-runtime/bin/wechat-agent-daemon.mjs` passed.
- Sandboxed `npm test` reached `control_plane_smoke=pass` then failed at local MongoDB with `EPERM 127.0.0.1:27017`; approved non-sandbox `npm test` passed.
- Business QA passed with `btc_macro` run `run-74bc0d33-e6ef-41d4-b870-33585515874b` and `office_meeting_draft` run `run-e3ddecdf-20a0-4d5d-bae2-56d0d07db0a1`; both include capability loop, memory, and subagent coordination artifacts.
- `swift build` passed.
- `swift test` passed.
- `swift run WeChatIntelligenceRadar --ui-smoke-check` passed with `ui_smoke_capability_launcher_visible=true` and `ui_smoke_review_follow_up_visible=true`.

## Artifact Spot Check

- `capability-loop-read-model.json` for `run-74bc0d33-e6ef-41d4-b870-33585515874b` classified `crypto_market_loop`, exposed `CMC Skill Hub 能力包`, and provided three follow-up suggestions.
- `memory-read-model.json` reports `adapter_unavailable`, `writePolicy.status=not_written`, and candidate memories only as redacted previews.
- `subagent-coordination-read-model.json` reports `mode=read_only_dry_run`, namespace `looloomi-agent`, and blocks `send-keys`, `kill-session`, `detach-client`, and unrelated pane capture.
