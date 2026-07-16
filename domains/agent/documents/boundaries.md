# Agent Boundaries

## Agent Owns

- Task intent and tool intent.
- Prompt contracts.
- Skill/extension behavior.
- Capability loop semantics.
- Final-output composition.
- Evidence contracts.
- Memory and subagent contracts.
- Model routing and provider dispatch semantics.

## Agent Does Not Own

- Product navigation.
- App/Web visual design.
- Product persistence.
- User settings UI.
- Runtime process management except execution-specific hooks.

## Agent Can Depend On

- Backend-provided context bundles.
- Backend-provided tool execution adapters.
- Product-safe input metadata.
- Capability manifests.

## Separation From Backend

Agent outputs should be converted into product read models before reaching App or Web UI. Agent internals such as provider IDs, raw tool names, schema names, gate names, or low-level traces should not leak into frontend surfaces unless a dedicated developer/debug surface asks for them.
