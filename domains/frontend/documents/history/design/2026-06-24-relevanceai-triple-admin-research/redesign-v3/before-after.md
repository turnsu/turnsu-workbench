# Before After

Status: `reference`

## Purpose

本文件把旧截图与 redesign-v3 目标稿放在同一个参考路径里。旧截图证明“当前问题是什么”，新目标稿证明“可以往哪个方向走”。新一轮 UI 可以推倒重来，不需要逐项继承旧 target。

## Old Evidence

Web screenshots:

- Workbench initial: `../product-design-audit-web/01-workbench-initial.png`
- Loop Library database: `../product-design-audit-web/02-loop-library-database.png`
- Workbench Run Result: `../product-design-audit-web/03-workbench-run-result.png`
- Skill OS stack: `../product-design-audit-web/04-skill-os-stack.png`
- Create Tool import modal: `../product-design-audit-web/05a-skill-os-create-tool-import.png`
- Tool Logs validation: `../product-design-audit-web/05b-skill-os-tool-logs-validation.png`
- Studio contract page: `../product-design-audit-web/06-studio-contract-page.png`
- Builder patch receipt: `../product-design-audit-web/06a-studio-builder-patch-receipt.png`
- Knowledge setup panel: `../product-design-audit-web/08-knowledge-setup-panel.png`
- Chat quick GUI: `../product-design-audit-web/09-chat-quick-gui.png`

Native screenshots:

- Workbench: `../native-visual-audit/loopops-native-visual-2026-06-27-155147/01-workbench.png`
- Loop Library: `../native-visual-audit/loopops-native-visual-2026-06-27-155147/02-loop-library.png`
- Skill OS: `../native-visual-audit/loopops-native-visual-2026-06-27-155147/03-skill-os.png`
- Knowledge: `../native-visual-audit/loopops-native-visual-2026-06-27-155147/04-knowledge.png`
- Chat: `../native-visual-audit/loopops-native-visual-2026-06-27-155147/05-chat.png`
- Studio: `../native-visual-audit/loopops-native-visual-2026-06-27-155147/06-studio.png`

## New Target Draft

Open:

```text
redesign-v3/target-mockups/index.html
```

Screenshots:

- `redesign-v3/target-mockups/target-overview-1440-full.png`
- `redesign-v3/target-mockups/target-overview-mobile-390.png`
- `redesign-v3/target-mockups/target-overview-1440.png`
- `redesign-v3/target-mockups/modules/workbench-target.png`
- `redesign-v3/target-mockups/modules/loop-library-target.png`
- `redesign-v3/target-mockups/modules/skill-os-tool-logs-target.png`
- `redesign-v3/target-mockups/modules/studio-target.png`
- `redesign-v3/target-mockups/modules/knowledge-target.png`
- `redesign-v3/target-mockups/modules/scoped-chat-target.png`

![LoopOps redesign V3 target overview](target-mockups/target-overview-1440-full.png)

The target draft includes:

- Workbench target
- Loop Library target
- Skill OS and Tool Logs target
- Studio target
- Knowledge target
- Scoped Chat target

## Module Screenshot Matrix

| Module | Old Evidence | New Target |
| --- | --- | --- |
| Workbench / Active Queue / Run Result | `../product-design-audit-web/01-workbench-initial.png`, `../product-design-audit-web/03-workbench-run-result.png` | `target-mockups/modules/workbench-target.png` |
| Loop Library / Marketplace | `../product-design-audit-web/02-loop-library-database.png` | `target-mockups/modules/loop-library-target.png` |
| Skill OS / Tool Builder / Tool Logs | `../product-design-audit-web/04-skill-os-stack.png`, `../product-design-audit-web/05a-skill-os-create-tool-import.png`, `../product-design-audit-web/05b-skill-os-tool-logs-validation.png` | `target-mockups/modules/skill-os-tool-logs-target.png` |
| Studio / Builder Chat / Execution Path | `../product-design-audit-web/06-studio-contract-page.png`, `../product-design-audit-web/06a-studio-builder-patch-receipt.png` | `target-mockups/modules/studio-target.png` |
| Knowledge / Toast / Attach | `../product-design-audit-web/08-knowledge-setup-panel.png` | `target-mockups/modules/knowledge-target.png` |
| Scoped Chat / Quick GUI | `../product-design-audit-web/09-chat-quick-gui.png` | `target-mockups/modules/scoped-chat-target.png` |

## Difference Checklist

| Area | Old Failure | V3 Target |
| --- | --- | --- |
| Object hierarchy | Many panels compete for attention | One primary object per surface with secondary inspector |
| Lists | Rows mixed with card-like blocks | Database rows with stable columns and light dividers |
| Status | Many status chips and technical pass terms | Small status dot plus human label and next action |
| Toast | Feedback reads like system event | Product feedback with scope and one recovery action |
| Modal | Creation forms feel stacked | Creation starts with choice, then focused detail page |
| Logs | Backend-style status dump | Evidence table plus readable log detail |
| Chat | Controls feel decorative | Controls sit at composer and affect visible scope/state |
| Workbench | Review guide competes with daily work | Queue and result are primary, review guide moves to QA area |
| Studio | Contract fields, path and chat feel crowded | Contract page, ordered path, patch receipt are separated |
| QA | Pass counts imply completion | Product notes guide iteration; harnesses stay regression-only |

## Review Questions

1. Does the target draft clearly look like a real daily work app rather than a demo?
2. Can a user tell what is runnable, what needs setup, and where the result will appear?
3. Are logs, chat and Knowledge attached to objects rather than floating as separate tools?
4. Are any modules still too card-heavy or chip-heavy?
5. Which module should be redesigned or implemented first?
