# Web Boundaries

## Web Owns

- Web product shell.
- Web page layouts.
- Web component states.
- Web drag/drop interactions.
- Web prototype fixtures.
- Web-specific responsive behavior.
- Browser accessibility, focus order, and keyboard navigation.

## Web Does Not Own

- SwiftUI native layout decisions.
- Agent prompt semantics.
- Backend storage contracts.
- Tool execution.
- External action authority.

## Web Can Depend On

- Shared product nouns.
- Mock frontend object shapes.
- Product-safe backend read models when they exist.
- Coze-style Builder interaction reference for palette, canvas, inspector, and debug panel.
- Astryx-wrapped local design-system components.

## Keep Separate From App

- Web may use drawers, route pages, browser command palette, and responsive breakpoints.
- App may use native split views, sheets, menus, and toolbars.
- Do not force one platform's component structure into the other.
