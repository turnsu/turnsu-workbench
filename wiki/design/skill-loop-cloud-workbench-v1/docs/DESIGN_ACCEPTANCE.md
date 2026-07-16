# Design Acceptance

## 1. Required Design Deliverables

- product language and visual foundation;
- information architecture and route map;
- Skill creation, upload, detail, test, version, and publish flows;
- Loop creation, Definition, Outline, Canvas, test, Run, and publish flows;
- Team library install/fork/update/publish flows;
- desktop 1440 and 1280 key screens;
- mobile 390 key screens;
- light and dark theme specs;
- English and Chinese states;
- empty, loading, blocked, error, conflict, permission, and update states;
- keyboard/focus and accessible non-canvas equivalent;
- three visual directions followed by one selected/refined direction.

## 2. Required Key Frames

Final selected direction must cover:

1. Skills library with realistic personal/team Skills.
2. Skill detail with purpose, needs, creates, tests, versions, and usage.
3. Skill creator/upload validation.
4. Loops library with goal, version, readiness, latest Run, and owner.
5. Loop detail with contract summary and Run action.
6. Create Loop from a goal.
7. Builder Definition mode.
8. Builder Outline mode.
9. Builder Canvas mode with Skill panel and Step editor.
10. Validation issues and proposed changes.
11. Run waiting for review.
12. Completed Run with result, checks, evidence, and versions.
13. Team library asset detail.
14. Publish/update impact review.
15. Mobile library/detail/Builder outline/Run review.

## 3. Realistic Design Data

Do not use blocked conformance fixtures as the main visual data. Use varied examples:

- Meeting action extractor
- Earnings report analyst
- Source freshness checker
- Research brief writer
- Customer feedback classifier
- Weekly product review Loop
- Meeting follow-up Loop
- Pre-market research Loop

Show a mix of Ready, Draft, Needs setup, Update available, and Deprecated where the screen needs
state coverage. Avoid filling every row with badges.

## 4. Product Acceptance

- A first-time user can explain the difference between Skill, Loop, and Run.
- Create and Upload are visible on Skills and Loops.
- Templates are understood as starting points, not a separate owned object.
- A Loop is understandable without opening Canvas.
- Definition, Outline, and Canvas visibly describe one shared draft.
- Team install, fork, publish, and update are distinguishable.
- Save, Validate, Test, Publish, and Run are not conflated.
- Disabled actions show a reason and recovery.
- Current version and ownership are visible where they change a decision.

## 5. Visual Acceptance

- First viewport has one dominant task and no decorative dashboard filler.
- Lists read as lists, not stacks of cards.
- No card nesting, gradients, glass, glow, oversized radii, or dark cockpit default.
- Canvas remains the largest region in Canvas mode.
- Definition and Run result have comfortable reading width.
- Right drawers do not permanently compress the main task below usable width.
- Long Chinese titles and package IDs do not overlap controls.
- Light/dark status colors and controls meet WCAG AA.

## 6. Interaction Acceptance

- Add and drag both create, select, and reveal the new step.
- Delete, disconnect, reconnect, move, duplicate, and Esc cancel work.
- Assistant proposals never mutate before Apply changes.
- Save draft survives navigation/reload according to product state.
- Test and Run states remain visible after reconnect.
- Review changes create a real new attempt.
- Toasts do not cover primary actions and deduplicate.
- Every visible button works, opens a complete flow, explains why disabled, or is removed.

## 7. Accessibility Acceptance

- Keyboard-only completion of create, edit, validate, test, publish, Run, and review.
- Accessible Outline equivalent for Canvas.
- Screen-reader status and validation announcements.
- Dialog focus trap/restore and visible focus.
- Status meaning does not depend on color.
- Touch targets at least 44px on mobile.
- Reduced motion and 200% zoom checks.

## 8. Review Matrix

Capture and compare:

| Viewport | Theme | Locale | Required screens |
|---|---|---|---|
| 1440 x 1024 | Light/Dark | EN/ZH | all key desktop frames |
| 1280 x 800 | Light/Dark | EN/ZH | libraries, Builder Canvas, Run review |
| 390 x 844 | Light/Dark | EN/ZH | library, detail, creation, Outline, review |

Each capture checks clipping, page-level overflow, hierarchy, current action, focus visibility,
text wrapping, panel overlap, and realistic data.

## 9. Handoff Requirements

Implementation handoff must include:

- selected visual direction and rejected-direction rationale;
- screen/state inventory mapped to components;
- semantic token changes;
- responsive behavior;
- interaction notes and keyboard paths;
- i18n copy inventory;
- backend capability dependencies and blocked fallbacks;
- test IDs only after user-facing behavior is defined;
- screenshot targets used for final design QA.

No image alone is sufficient handoff. No document alone is sufficient visual approval.
