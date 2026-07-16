# Design Manager / QA Redesign V3

Date: 2026-06-27
Reset: 2026-06-29

Owner: Design Manager / QA

Scope: Lightweight product quality guidance for LoopOps redesign.

## Root Failure Pattern

The previous QA system confused regression evidence with product completion evidence.

Useful technical checks include `swift test`, Web smoke scripts, action smoke, contract checks, non-empty screenshots, and no-permission review output. They prove some contracts still exist. They do not prove the UI is understandable, visually complete, correctly prioritized, or ready for daily use.

## Regression Policy

- Passing harness output means no known regression was detected by that script.
- Failing harness output means inspect the relevant behavior.
- `data-testid`, state fields, pass logs, non-empty screenshots and no-permission output are not product-quality evidence.
- Do not add visible UI, copy, anchors or state just to satisfy a script.

## Product Quality Review

Review the live UI and screenshots against these questions:

- Can the user tell where they are and which object is selected?
- Is there one clear primary action in the current decision area?
- Are secondary actions discoverable without competing with the primary action?
- Are run status, result, missing evidence and next action legible?
- Are chat scope, attachments and temporary/persistent behavior visible?
- Are logs readable as evidence rather than backend dumps?
- Does mobile avoid clipped text, overlap and horizontal scrolling?
- Does the UI avoid nested cards, decorative panels, noisy chips and implementation vocabulary?

## Review Output

Use plain product notes instead of workflow states:

```text
Module:
What works:
What feels confusing:
Visual issues:
Interaction issues:
Copy issues:
Recommended next edits:
```

Review notes can guide priority, but they do not block module-level design or implementation work.

## Safety Boundary

Safety is the remaining hard boundary:

- External actions such as trading, publishing, WeChat sending and Feishu sending require explicit confirmation or remain unavailable.
- Review-only surfaces must not silently execute external actions.
- Scoped chat must not silently mutate unrelated runs, drafts, packets or logs.
