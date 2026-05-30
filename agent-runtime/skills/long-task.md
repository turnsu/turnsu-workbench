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
