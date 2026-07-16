---
name: long-task
description: Runs a recoverable local task with session, progress, and handoff state. Use when work must remain inspectable across runtime restarts.
compatibility: Requires looloomi Agent Runtime task and run persistence bindings.
---

# Skill: Long Task

Purpose: keep agent tasks recoverable across Swift app restarts.

Inputs:
- session ID;
- prompt;
- selected skills/extensions;
- attachments;
- context refs.

Outputs:
- `runtime/agent/tasks/{taskID}.json`;
- `runtime/agent/runs/{runID}/events.ndjson`;
- `planner-envelope.json`;
- `tool-calls.json`;
- `policy-decisions.json`;
- `final-output.md`.

Controls:
- pause;
- resume;
- cancel.
