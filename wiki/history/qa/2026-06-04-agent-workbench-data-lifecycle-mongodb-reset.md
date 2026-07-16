# Agent Workbench Data Lifecycle And MongoDB Reset

Date: 2026-06-04

## Problem

The Agent workbench accumulated generated test and smoke data until the app opened into a noisy, hard-to-use state:

- Session history mixed real prompts with `smoke-check` and `async-smoke-check` runs.
- Runtime JSON artifacts kept growing without a clear retention boundary.
- The app could show many old conversations after launch, making the current workbench feel non-deterministic.
- The session-row pencil button was visually easy to mistake for a delete control, while no real delete action existed.

## Root Cause

The desktop app had local JSON runtime artifacts for sessions, tasks, runs, and product data, but no primary lifecycle store or cleanup API. Smoke tests wrote into the same runtime area that the app read from. Session/task deletion was not implemented across daemon API, Swift client, and UI.

## Fix Contract

- MongoDB is the primary store for Agent sessions, tasks, run metadata, run events, tool calls, and final outputs.
- File runtime remains an artifact/cache layer for large local records and SSE compatibility.
- App session/task lists come from the daemon API, not by scanning old runtime directories.
- Smoke tests use the test database and clean it up.
- Swift smoke uses a temporary runtime root and does not print a local artifact path.
- Hard reset deletes generated runtime data and resets the local MongoDB database.
- Session delete is a real UI action with confirmation.

## Touched Areas

- Node daemon: Mongo repository, session/task/run list-delete-reset APIs, smoke test isolation.
- Swift app: daemon list/delete/rename client methods, session rail delete button, Mongo-backed refresh.
- Scripts: Docker MongoDB startup, hard reset script, deterministic latest app launch still points to release app.
- QA: this document records the regression and required checks.

## Acceptance Checks

- After hard reset, Mongo session count is `0` and task count is `0`.
- `runtime/agent/sessions`, `runtime/agent/tasks`, and `runtime/agent/runs` contain no old entries.
- App launch does not auto-create a session.
- The left rail shows an empty state until the user creates a task.
- Rename and delete session buttons both perform real actions.
- No visible chat/status text exposes raw `runID`, `taskID`, local paths, schema names, or backend field names.

## Guardrails

Do not read, print, or rewrite `.env`. Do not store raw WeChat database content in MongoDB; only normalized/redacted Agent workbench metadata and outputs belong there.
