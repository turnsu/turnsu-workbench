# Frontend App

This folder owns the native app frontend track.

## Current State

The native app code currently lives under:

```text
domains/frontend/app/code/WeChatIntelligenceRadarApp/
  Views/
  ViewModels/
  Models/
  Services/
  Resources/
  Fixtures/
```

The app UI is SwiftUI/macOS. It should be designed as a native workspace product, not as a web dashboard copied into SwiftUI.

## Documents

- [Interaction brief](documents/interaction-brief.md)
- [App boundaries](documents/boundaries.md)
- [Code ownership map](code/README.md)

## App-Specific Direction

- Use native sidebar, toolbar, split view, sheet, popover, table/list, inspector, and menu patterns.
- Keep keyboard navigation, selection state, and context menus first-class.
- Prefer native detail pages and inspectors over nested web-style cards.
- Keep long forms sectioned and readable.
- Run Result, Studio, Skill OS, Knowledge, and Loop Library should each feel like native work areas.
