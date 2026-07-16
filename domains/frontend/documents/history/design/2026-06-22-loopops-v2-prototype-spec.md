# LoopOps v2 Prototype Spec

- Date: 2026-06-22
- Status: active prototype package; selected direction implemented in SwiftUI frontend v1
- Prototype directory: `domains/frontend/documents/design/2026-06-22-loopops-v2-prototypes/`

## 1. Design Thesis

LoopOps v2 should feel like an Apple-style production workbench for reusable agent loops. Chat is always available, but it does not replace structured loop objects.

The recommended direction is:

```text
Loop Workbench with Chat
  -> Run Chat Detail
  -> Loop Library
  -> Loop Studio with Builder Chat
```

Implementation record, 2026-06-22: SwiftUI now implements the selected LoopOps structure with Workbench scoped chat, Library loop/run-log management, Review Packet decisions, and Studio contract editing. The SVG package remains the visual reference for subsequent polish; it is no longer only a pre-implementation concept.

Polish record, 2026-06-22: the Workbench result area now follows the prototype hierarchy more closely: overview first, one authoritative answer, domain render blocks, review boundary, then follow-up actions. Library review decisions and share-safe log copy are now operational in the local store. Remaining visual validation still needs behavior-level AppKit/XCUITest or accessibility-identifier coverage; current UI smoke is structural.

## 2. Prototype Files

- `loop-workbench-with-chat.svg`
  - 1440x900 default Workbench.
  - Shows Loop Shelf, Current Run Canvas, Chat / Review region, and compact composer.
- `loop-workbench-with-chat-1280.svg`
  - 1280x800 adaptation of the recommended Workbench.
  - Shows how chat becomes a lower drawer and the shelf remains readable.
- `run-chat-detail.svg`
  - 1440x900 run-scoped chat and review detail.
  - Shows final answer, timeline, evidence gaps, and follow-up chat.
- `loop-library.svg`
  - 1440x900 Library.
  - Shows My Loops, Run Ledgers, Shared / Imported, replay, clone, and share-safe log preview.
- `loop-studio-with-builder-chat.svg`
  - 1440x900 Studio.
  - Shows Loop Contract editor, steps/gates, validation, and Builder Chat.

## 3. Visual System

Use the existing App design system:

- Apple system font.
- Light-first layout with dark mode parity later.
- Solid neutral surfaces.
- Hairline separators.
- System blue accent only for current selection and primary action.
- No glow, black-gold cockpit, marketing hero, large gradients, or decorative dashboards.

## 4. Required States

Every implementation-ready design must account for:

- running;
- blocked;
- review-needed;
- completed;
- empty loop shelf;
- no final answer yet;
- media upload / cloud transcription pending for Office;
- missing market inputs for Crypto;
- share redaction for Library.

## 5. Required Domain Coverage

### Crypto

Prototype copy must include:

- Market Report Loop;
- Thesis Review;
- candidate funnel;
- no-trade / review-only boundary;
- CMC returned result as user-facing capability status, not hidden infrastructure.

### Markets

Prototype copy must include:

- Company deep dive;
- Earnings review;
- cross-asset read-through;
- research draft rather than trading recommendation.

### Office

Prototype copy must include:

- Meeting minutes;
- Doc draft;
- cloud transcription status;
- Feishu preview with confirmation boundary.

## 6. Chat Interaction Rules

Chat must have visible scope:

- Global Chat.
- Run Chat.
- Builder Chat.
- Review Chat.

The user should know whether they are:

- asking a general question;
- continuing a selected run;
- editing a loop contract;
- reviewing a final answer.

Chat suggestions should be action-oriented:

- Run this loop.
- Ask follow-up.
- Convert to saved loop.
- Review evidence gaps.
- Prepare delivery preview.

## 7. Non-goals For The Prototype

- Do not render a full node graph as the default surface.
- Do not show a permanent inspector.
- Do not show source browser as a primary surface.
- Do not show hidden runtime identifiers.
- Do not include live trading, live publish, or external sending controls.
- Do not use Chat as the only visible product shell.

## 8. Validation

Run:

```bash
xmllint --noout domains/frontend/documents/design/2026-06-22-loopops-v2-prototypes/*.svg
```

Run active-doc consistency checks from the implementation goal against PRODUCT, DESIGN, PROJECT_WIKI, active PRD, active architecture, active design docs, and the v2 prototype directory.

Matches for superseded UI names are acceptable only in historical or superseded contexts. Matches for implementation-internal terms are acceptable only when they describe hidden or prohibited implementation details, not visible UI.

## 9. SwiftUI Implementation Handoff

Later implementation should be a separate goal. It should:

- create a `LoopOpsWorkbenchView` or refactor `BlocksWorkbenchView` behind a feature-safe path;
- add pure UI/adaptor types for loop contracts, run ledgers, review packets, and chat scopes;
- keep existing final answer authority;
- keep existing backend payloads until a runtime goal explicitly changes them;
- update UI smoke to verify Workbench, Library, Studio, scoped chat, hidden internals, and single final answer source.
