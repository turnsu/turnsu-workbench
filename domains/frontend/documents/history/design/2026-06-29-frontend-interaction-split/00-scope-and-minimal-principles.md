# Scope And Minimal Principles

## Purpose

The frontend work should become simple enough to develop module by module. The goal is to make the product usable, not to preserve the old design package or create another layer of process.

## Keep

- LoopOps is a workspace for loops, skills, runs, knowledge, and scoped chat.
- RelevanceAI is a useful reference for product shape: workspace sidebar, marketplace/listing browse, object detail pages, owned/public separation, clone/add actions, setup status, and help surfaces.
- User-facing actions should be clear: browse, open, run, clone, add, configure, chat, review result.
- External actions such as sending, publishing, trading, or posting still need explicit user confirmation when they become real actions.

## Remove From This Frontend Track

- Old target screenshots as binding requirements.
- Old review-board process as implementation blockers.
- Approval-process wording.
- Manager/agent-team process requirements.
- Long audit matrices.
- Hidden runtime/provider/policy terminology in product UI.
- Backend router, tool execution, storage migration, and policy authority changes.

## Frontend Boundary

This package covers:

- Information architecture.
- Page and panel structure.
- Component behavior.
- Interaction states.
- Prototype fixtures.
- Visual rhythm and usability details.

This package does not cover:

- Real skill execution.
- Tool router changes.
- Account permission systems.
- Final-answer authority.
- External publishing or trading flows.
- Database migrations except mock data needed by UI prototypes.

## Shared Product Objects

Use these names consistently in both Web and App prototypes:

- Loop.
- Loop Template.
- Skill.
- Tool.
- Extension.
- Skill Stack.
- Run.
- Run Result.
- Review Packet.
- Knowledge Source.
- Chat.

## Minimal Quality Bar

For every frontend module, implement the actual interaction path instead of only drawing the screen:

- Default, hover, active, focus, selected, loading, empty, error, and disabled states where relevant.
- Real click targets and keyboard focus order.
- Clear primary and secondary actions.
- Inline status text that explains what the user can do next.
- No decorative controls that do not perform an action.
- No internal implementation terms in user-facing copy.
