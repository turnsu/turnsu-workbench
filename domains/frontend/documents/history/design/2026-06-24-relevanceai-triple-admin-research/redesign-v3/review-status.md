# Module Notes

Status: `non-blocking-reference`

This file is no longer an approval tracker. It is a lightweight index for module references and product notes. Any module can be redesigned or implemented without waiting for rows in this file to change.

## Module References

| Module | Reference Doc | Target Screenshot | Product Notes |
| --- | --- | --- | --- |
| Loop Library / Marketplace | [modules/loop-library-marketplace.md](modules/loop-library-marketplace.md) | [loop-library-target.png](target-mockups/modules/loop-library-target.png) | Database-style loop and template library. |
| Skill OS / Tool Builder / Tool Logs | [modules/skill-os-tool-builder-logs.md](modules/skill-os-tool-builder-logs.md) | [skill-os-tool-logs-target.png](target-mockups/modules/skill-os-tool-logs-target.png) | Second library for skills, stacks, tool creation and logs. |
| Studio / Builder Chat / Execution Path | [modules/studio-builder-execution-path.md](modules/studio-builder-execution-path.md) | [studio-target.png](target-mockups/modules/studio-target.png) | Loop Contract page with visible ordered path and patch receipt. |
| Knowledge / Toast / Attach | [modules/knowledge-toast-attach.md](modules/knowledge-toast-attach.md) | [knowledge-target.png](target-mockups/modules/knowledge-target.png) | Source lifecycle, scoped attachment and recoverable toast. |
| Workbench / Active Queue / Run Result | [modules/workbench-run-result.md](modules/workbench-run-result.md) | [workbench-target.png](target-mockups/modules/workbench-target.png) | Active queue, selected result, review packet and run chat. |
| Scoped Chat / Quick GUI | [modules/scoped-chat-quick-gui.md](modules/scoped-chat-quick-gui.md) | [scoped-chat-target.png](target-mockups/modules/scoped-chat-target.png) | Scoped composer controls and isolated chat modes. |
| Design Manager / QA | [modules/design-manager-qa.md](modules/design-manager-qa.md) | [target-overview-1440-full.png](target-mockups/target-overview-1440-full.png) | Lightweight product quality review guidance. |

## What Not To Use As Product Proof

- Passing `swift test`.
- Passing `npm run smoke`.
- More `data-testid` anchors.
- More state fields.
- More pass summary lines.
- Nonblank screenshots.
- No-permission harness output.

These are technical guardrails, not evidence that the UI is good.

## Useful Review Note Format

```text
Module:
What works:
What is confusing:
What should be redesigned:
Next implementation edits:
```
