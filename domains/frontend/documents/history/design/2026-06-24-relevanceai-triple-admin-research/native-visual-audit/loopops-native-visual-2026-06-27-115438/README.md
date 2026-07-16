# LoopOps Native Visual Audit

- Capture ID: `loopops-native-visual-2026-06-27-115438`
- Created: `2026-06-27-115438`
- Permission model: offscreen NSHostingView render; no open, AppleScript, Accessibility, screen recording, Chrome/Safari, browser automation, or external AppKit click automation
- No system permissions: `true`
- External UI automation: `false`
- Native AppKit/XCUITest clicks verified: `false`
- Capture count: `5`
- Nonblank captures: `5`

## Captures

| Surface | Workspace | Image | Size | Bytes | Sampled colors |
| --- | --- | --- | --- | --- | --- |
| Workbench default | 工作台 | [01-workbench.png](01-workbench.png) | 1280x820 | 307407 | 83 |
| Loop Library database | Loop Library | [02-loop-library.png](02-loop-library.png) | 1280x820 | 490262 | 120 |
| Skill OS and Tool Logs | Skill OS | [03-skill-os.png](03-skill-os.png) | 1280x820 | 527116 | 118 |
| Knowledge library | Knowledge | [04-knowledge.png](04-knowledge.png) | 1280x820 | 390229 | 94 |
| Studio builder | Studio | [05-studio.png](05-studio.png) | 1280x820 | 456647 | 113 |

## Boundary

These PNGs are rendered from the native SwiftUI `DashboardView` through an offscreen `NSHostingView`. They provide screenshot-level native surface evidence without opening the app or requesting Accessibility, AppleScript, screen recording, Chrome/Safari, or external AppKit click automation. They do not claim external pixel-click coverage or human approval.
