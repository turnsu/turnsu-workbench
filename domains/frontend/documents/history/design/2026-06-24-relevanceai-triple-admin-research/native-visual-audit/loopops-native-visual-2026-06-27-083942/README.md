# LoopOps Native Visual Audit

- Capture ID: `loopops-native-visual-2026-06-27-083942`
- Created: `2026-06-27-083942`
- Permission model: offscreen NSHostingView render; no open, AppleScript, Accessibility, screen recording, Chrome/Safari, browser automation, or external AppKit click automation
- No system permissions: `true`
- External UI automation: `false`
- Native AppKit/XCUITest clicks verified: `false`
- Capture count: `5`
- Nonblank captures: `5`

## Captures

| Surface | Workspace | Image | Size | Bytes | Sampled colors |
| --- | --- | --- | --- | --- | --- |
| Workbench default | 工作台 | [01-workbench.png](01-workbench.png) | 1280x820 | 259656 | 62 |
| Loop Library database | Loop Library | [02-loop-library.png](02-loop-library.png) | 1280x820 | 312515 | 75 |
| Skill OS and Tool Logs | Skill OS | [03-skill-os.png](03-skill-os.png) | 1280x820 | 317894 | 81 |
| Knowledge library | Knowledge | [04-knowledge.png](04-knowledge.png) | 1280x820 | 279053 | 70 |
| Studio builder | Studio | [05-studio.png](05-studio.png) | 1280x820 | 285072 | 70 |

## Boundary

These PNGs are rendered from the native SwiftUI `DashboardView` through an offscreen `NSHostingView`. They provide screenshot-level native surface evidence without opening the app or requesting Accessibility, AppleScript, screen recording, Chrome/Safari, or external AppKit click automation. They do not claim external pixel-click coverage or human approval.
