# Manager Acceptance Closeout

This closeout adds a manager-level gate over the existing LoopOps evidence. It keeps automated review-ready evidence separate from human approval and does not touch product UI files.

## Scope

- Gate script: `scripts/manager-loopops-acceptance-gate.command`.
- Actual 15-step design evidence path: `human-review-gallery.html`, backed by `16-human-review-gallery.md`, `product-design-audit-web/`, and `product-design-audit-web-mobile/`.
- Latest native review packet: newest `native-review-packets/loopops-native-review-*.json` plus its Markdown pair; manager gate requires 26 activation targets, 26 state-backed targets, 26 no-permission targets, `visualResult=pass`, 6/6 nonblank native visual captures, a readable visual manifest, and explicit `nativeAppKitClicksVerified=false`.
- Current human review native visual gallery: `16-human-review-gallery.md` must point at a readable `native-visual-audit/loopops-native-visual-*/README.md`, and the manager gate now checks that gallery's manifest plus Workbench, Loop Library, Skill OS, Knowledge, Chat and Studio PNGs.
- Latest manual review source of truth: newest `review-records/loopops-review-*.json` plus its Markdown pair.
- Permission model: local shell reads only. No `open`, AppleScript, Accessibility, screen recording, Chrome/Safari, browser automation, or AppKit click automation.

## Current Handoff

- Web review URL: `http://127.0.0.1:5188/`.
- Native app bundle for manual review: `.build/debug-app/WeChatIntelligenceRadar.app`.
- Human review gallery: `human-review-gallery.html`.
- Current native visual gallery: `native-visual-audit/loopops-native-visual-2026-06-27-155147/README.md`.
- Current pending review record: `review-records/loopops-review-2026-06-27-145550.md` and `.json`.
- Current pending record evidence includes manual approval guardrails: pass records require explicit reviewer notes and empty blockers; non-pass records require concrete blockers.
- Current Swift test log: `.build/loopops-objective-audit/swift-test.txt`.

The current review record remains `pending-manual-review` with blocker `human-review-not-yet-recorded`; this is intentionally not treated as completion.

## Consistency Guard

`scripts/audit-loopops-objective.command` now reads the current native visual gallery from `16-human-review-gallery.md`, resolves its capture ID, and checks that the same ID appears in:

- `10-objective-completion-matrix.md`
- `13-native-manual-review-checklist.md`
- `15-goal-completion-gate.md`
- `human-review-gallery.html`

This prevents stale native screenshot IDs from silently staying in the manual review path after a new offscreen visual capture is generated. The objective audit now keeps the handoff stable by default; set `LOOPOPS_OBJECTIVE_AUDIT_REFRESH_NATIVE_VISUAL=1` only when intentionally refreshing the native screenshot set.

## Latest Verification Commands

```bash
LOOPOPS_MANAGER_GATE_MODE=review-ready scripts/manager-loopops-acceptance-gate.command
scripts/manager-loopops-acceptance-gate.command
scripts/verify-loopops-traceability.command
LOOPOPS_WEB_URL=http://127.0.0.1:5188/ scripts/audit-loopops-objective.command
cd domains/frontend/web/code/web-prototype && npm run review:no-permission
swift run --disable-sandbox WeChatIntelligenceRadar --loopops-native-activation-check
swift run --disable-sandbox WeChatIntelligenceRadar --loopops-native-visual-capture
git diff --check
```

Expected current manager-gate behavior in review-ready mode:

```text
loopops_manager_gate_mode=review-ready
loopops_manager_gate_review_ready=pass
loopops_manager_gate_human_approved=false
loopops_manager_gate=pass
```

Expected current manager-gate behavior in full mode:

```text
loopops_manager_gate_mode=full
loopops_manager_gate_review_ready=pass
loopops_manager_gate_human_approved=false
loopops_manager_gate_native_appkit_clicks_verified=false
loopops_manager_gate=fail
```

The failure is intentional while the latest manual review record remains `pending-manual-review`.

## Known Boundaries

- `native_appkit_clicks_verified=false` is an explicit no-permission boundary, not a human approval signal.
- Native visual capture is offscreen SwiftUI screenshot-level evidence, not external AppKit/XCUITest click automation.
- The review-ready mode can prove local evidence exists and the latest no-permission session passed; it cannot decide visual/product acceptance without a human record.
- The full mode remains the only completion gate. It fails until the latest human review record is `pass` with no blockers.
- A `pass` record must be the latest review record and must not carry blockers.
- A `needs-work`, `blocked`, `failed`, unsupported, missing, or pending latest status keeps the manager gate failing.
- Product Design screenshots and the static gallery are review evidence, not a substitute for live human click review.

## Human Review Recording

Record a pass only after reviewing the gallery and live Web/native paths:

```bash
LOOPOPS_WEB_URL="http://127.0.0.1:5187/" LOOPOPS_REVIEW_STATUS=pass LOOPOPS_REVIEW_BLOCKERS="" LOOPOPS_REVIEW_NOTES="Reviewed Web and native surfaces; no blockers." scripts/record-loopops-review.command
```

Record issues as needs-work:

```bash
LOOPOPS_WEB_URL="http://127.0.0.1:5187/" LOOPOPS_REVIEW_STATUS=needs-work LOOPOPS_REVIEW_BLOCKERS="Specific blocker observed during manual review." LOOPOPS_REVIEW_NOTES="Describe the review path and affected surface." scripts/record-loopops-review.command
```

After recording the result, rerun:

```bash
scripts/manager-loopops-acceptance-gate.command
```
