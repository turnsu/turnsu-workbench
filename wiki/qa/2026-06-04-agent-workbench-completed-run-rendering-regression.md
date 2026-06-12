# Agent Workbench Completed Run Rendering Regression

Date: 2026-06-04

## Problem

The Agent workbench repeatedly regressed after run completion:

- The run status changed to completed, but the app did not show the final conclusion.
- Earlier fixes hid the dense SSE stream text, but when the persisted session assistant message was not loaded yet, the UI only showed `已完成，正在整理结果`.
- Sending another message often made the previous result appear correctly because stream events were cleared and the persisted session message became the only visible source.
- Desktop bundle startup added another failure mode: when the app was opened through LaunchServices, the process working directory could differ from the project root, so Swift runtime readers could miss the daemon-written final artifacts.

## Root Cause

The completed run had two competing display sources:

- `assistant.delta` SSE events, joined by `AgentWorkspaceStateAdapter.makeRunMessage`.
- The authoritative final answer written by the daemon to the session assistant message and `runtime/agent/runs/{runID}/final-output.md`.

The first-completion UI could render the synthetic stream message before the session final was available. Suppressing that stream message without a final-output fallback created the new blank-completion state.

The final-output fallback also depends on both the daemon and app resolving the same runtime root. A `.app` opened from `.build/release-app` cannot rely on `FileManager.currentDirectoryPath`, so project-root discovery must check the app bundle ancestry and build-time bundle metadata.

## Fix

Authoritative completed-run display is now:

1. Persisted assistant message for the same `runID`.
2. If not yet loaded, local `final-output.md` fallback text.
3. If neither is available, a short finalizing/status notice.

Touched files:

- `Sources/WeChatIntelligenceRadarApp/Models/AgentWorkspaceV2Models.swift`
  - Suppresses synthetic stream text after terminal events.
  - Uses terminal final text fallback when session final is not available.
- `Sources/WeChatIntelligenceRadarApp/ViewModels/DashboardViewModel.swift`
  - Reads final-output fallback immediately on terminal events and retries briefly until a same-run final source appears.
- `Sources/WeChatIntelligenceRadarApp/Services/AgentRuntimeStores.swift`
  - Adds `readFinalOutput(runID:)`.
- `Sources/WeChatIntelligenceRadarApp/Services/RuntimeSupport.swift`
  - Resolves the project root from env, bundle metadata, current directory, or `.app` bundle ancestors.
- `Sources/WeChatIntelligenceRadarApp/Views/MarkdownBlocks.swift`
  - Parses compact CJK bullets such as `-市场概览：`.
- `scripts/build-release-app-bundle.sh` and `scripts/build-debug-app-bundle.sh`
  - Add local project-root metadata to the app bundle for deterministic desktop launches.
- `Tests/WeChatIntelligenceRadarAppTests/AgentRuntimeTests.swift`
  - Adds regression tests for completed stream suppression, final-output fallback, and bundle-path project-root resolution.

## Regression Tests

Required before accepting future changes to this path:

- Completed stream events plus persisted assistant final must display only the persisted final.
- Completed stream events without session final but with `final-output.md` fallback must display fallback final text.
- Completed stream events without either final source must not display dense stream text.
- Compact bullets like `-市场概览：` must parse as bullets.
- Runtime root resolution must find the project root from a `.build/release-app/WeChatIntelligenceRadar.app` path.

## Acceptance

After a task completes, the first completed UI state must show the structured final conclusion. It must not require sending a second message to trigger a correct re-render.

Secrets and `.env` values must never be read, printed, or rewritten during this QA flow.
