# App Boundaries

## App Owns

- SwiftUI view composition.
- Native navigation model.
- App-specific layout and responsive behavior.
- View state and local UI state.
- Keyboard shortcuts, focus, selection, menus, sheets, popovers, and inspectors.
- Local mock states for App UI development.

## App Does Not Own

- Agent prompt semantics.
- Tool router behavior.
- Provider selection.
- Backend storage contracts.
- External action authority.
- Web layout decisions.

## App Can Depend On

- Shared product nouns.
- Mock data shapes from frontend docs.
- Backend view models and read models once they are stable.
- Agent-facing summaries that are already product-safe.

## Keep Separate From Web

- App navigation can use native sidebars and toolbars.
- App forms can use native grouped forms and inspectors.
- App drag/drop should follow macOS expectations.
- App notifications should use native banners or compact in-app notices.
