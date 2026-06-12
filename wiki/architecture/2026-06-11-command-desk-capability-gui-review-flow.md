# Command Desk Capability GUI and Review Flow

- Date: 2026-06-11
- Status: implemented architecture

## 1. Product Shape

Command Desk remains minimal:

- Left: task stack.
- Center: result canvas.
- Bottom: command composer.
- Details: task-local sheet.

This iteration adds a compact capability launcher, not a new dashboard.

## 2. Capability Launcher

Visible groups:

- `Crypto`
  - Market loop.
  - Thesis review.
  - Token follow-up.
- `Office`
  - Meeting minutes.
  - Document draft.
  - Revision.
  - Feishu preview.

The launcher writes prompt text and selected public skills/extensions into existing ViewModel state. It does not expose raw internal tools.

Implementation note: the first pass writes prompt text into the existing composer and keeps Skill/Extension selection unchanged. It does not add a second launch API.

## 3. Review Path

Result canvas actions:

- `Review`
- `Follow up`
- `Copy`
- `Save`

In this phase:

- `Review` opens task-local detail sheet.
- `Follow up` pre-fills a continuation prompt.
- `Copy` / `Save` remain follow-up candidates; this pass does not add storage or clipboard behavior beyond existing app commands.

## 4. Detail Sheet

Add compact sections:

- Evidence / Review / Policy / CMC.
- Loop.
- Memory.
- Subagents.

The detail sheet explains state. It is not an Inspector and must not render raw artifacts.

## 5. UI Smoke

The UI smoke should assert presence of:

- Command Desk.
- Capability launcher.
- Crypto and Office intents.
- Review/follow-up path.
- No global Inspector.
- Clean public ability names.

## 6. Visual Rules

- Use Apple system controls and existing `RadarTheme`.
- No large new panels.
- No source browser.
- No provider or tool names.
- No permanent Feishu live action.

## 7. Implementation Record

- Command Desk result canvas now shows capability loop status when `capability-loop-read-model.json` exists.
- Composer includes a compact `Capability Launcher` with Crypto and Office loop templates.
- Task detail sheet adds Loop, Memory, and Subagents tabs.
- UI smoke asserts `ui_smoke_capability_launcher_visible=true` and `ui_smoke_review_follow_up_visible=true`.
