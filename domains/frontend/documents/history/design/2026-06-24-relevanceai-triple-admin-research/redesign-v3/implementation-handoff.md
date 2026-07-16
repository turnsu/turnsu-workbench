# Implementation Handoff

Status: `non-blocking-guidance`
Date: 2026-06-27
Reset: 2026-06-29

## Purpose

This handoff is implementation guidance. The UI may be rebuilt module by module as long as the core product direction in [visual-system.md](visual-system.md) and the external-action safety boundaries are preserved.

The goal is to avoid adding more demo code into single large files. Prefer modular Web and native surfaces with shared database rows, object headers, chat controls, logs, toast, and layout primitives.

## Current Code Shape

Read-only inspection on 2026-06-27 found:

| Area | Current file | Current size | Risk |
| --- | --- | ---: | --- |
| Web prototype | `domains/frontend/web/code/web-prototype/src/App.jsx` | 4584 lines | UI, state, seed data, translation, review guide and interaction logic are concentrated in one file. |
| Native LoopOps | `domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/LoopOpsViews.swift` | 6649 lines | Many LoopOps surfaces and shared controls live in one SwiftUI file. |
| Native shell | `domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/DashboardView.swift` | 1822 lines | Global chat, command desk and shell routing share one file. |
| Native models | `domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsModels.swift` | 3784 lines | Model compatibility should be preserved; avoid mixing visual refactor with model rewrites unless required. |

Existing harnesses and smoke scripts are regression guards only. They do not prove product quality.

## Implementation Freedom

- Work may start on any module with a clear target direction.
- Modules can be redesigned or replaced if a better product interaction emerges.
- Web and native do not need to wait for every module to be finalized before useful module-level iteration starts.
- Human review produces feedback and priority, not a blocking workflow status.
- Regression failures should be fixed when they expose real broken behavior, not treated as design approval or rejection.

## Web Component Boundaries

Recommended target file map:

```text
web-prototype/src/
  App.jsx
  data/
    loopopsSeed.js
    loopopsReviewFixtures.js
  state/
    useLoopOpsWorkspace.js
    loopopsActions.js
    loopopsSelectors.js
  components/
    shell/
      WorkspaceShell.jsx
      SidebarNav.jsx
      TopBar.jsx
    workbench/
      WorkbenchView.jsx
      ActiveQueue.jsx
      RunResultPanel.jsx
      RunChatPanel.jsx
      ReviewPacketSummary.jsx
    library/
      LoopLibraryView.jsx
      LoopDatabase.jsx
      LoopDetailPage.jsx
      MarketplaceTemplateRow.jsx
    skill-os/
      SkillOSView.jsx
      ToolDatabase.jsx
      ToolDetailPage.jsx
      ToolLogsPanel.jsx
      CreateToolFlow.jsx
    studio/
      StudioView.jsx
      SkillShelf.jsx
      ExecutionPathEditor.jsx
      BuilderChatPanel.jsx
      BuilderPatchReceipt.jsx
    knowledge/
      KnowledgeView.jsx
      SourceDatabase.jsx
      SourceDetailPage.jsx
      AttachDrawer.jsx
      ProductToastStack.jsx
    chat/
      ScopedChatView.jsx
      ScopeRail.jsx
      ChatThread.jsx
      ComposerControls.jsx
      ChatContextPanel.jsx
    shared/
      DatabaseTable.jsx
      ObjectHeader.jsx
      StatusDot.jsx
      PropertyGrid.jsx
      EmptyState.jsx
      tokens.css
      layout.css
      controls.css
```

Implementation notes:

- `App.jsx` should become shell composition and high-level state wiring.
- Seed data and mutation helpers belong outside presentational components.
- Database rows should be reusable across Loop Library, Knowledge, Skill OS and logs.
- Chat controls should be a real reusable composer component.
- Toasts should be product events with one recovery action.
- Modals should stay focused; use page-detail or drawer patterns for normal setup.

## Native Component Boundaries

Recommended target file map:

```text
domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/LoopOps/
  LoopOpsDesignTokens.swift
  LoopOpsShellViews.swift
  LoopOpsWorkbenchView.swift
  LoopOpsRunResultView.swift
  LoopOpsLibraryView.swift
  LoopOpsSkillOSView.swift
  LoopOpsStudioView.swift
  LoopOpsKnowledgeView.swift
  LoopOpsScopedChatView.swift
  LoopOpsToastViews.swift
  LoopOpsSharedControls.swift
  LoopOpsDatabaseRows.swift
  LoopOpsReviewPacketViews.swift
```

Implementation notes:

- Keep `DashboardView.swift` focused on routing and shell placement.
- Preserve legacy Loop Contract JSON compatibility unless a migration is explicit.
- Share spacing, typography, color and border radius between Web and native where practical.
- Preserve review-only and explicit-confirmation boundaries for external actions.
- Do not add tool execution, trading, publishing, WeChat sending or Feishu sending capabilities as part of UI polish.

## Verification

Use verification to catch regressions and obvious interaction breakage:

```text
cd domains/frontend/web/code/web-prototype
npm run build
npm run smoke
npm run action:smoke
npm run review:no-permission
```

```text
swift build
swift test
swift run WeChatIntelligenceRadar --contract-check
```

These checks are useful, but they are not approval mechanisms. Product readiness still comes from looking at the UI, using the flows, and comparing the result against the core product direction.

## Practical Sequence

1. Pick one module and define the object, primary action, secondary inspector, empty state and failure state.
2. Extract or create shared primitives only when they reduce real duplication.
3. Implement the module with realistic data and real interaction states.
4. Review the live UI on desktop and narrow width.
5. Fix overlap, clipping, confusing copy, hidden actions, card stacking and backend-looking logs.
6. Repeat for the next module.
