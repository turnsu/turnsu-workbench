# Context Plane Extension

This package is internal and must not be exposed through `GET /capabilities`.

The executable logic is in `domains/agent/code/agent-runtime/control-plane/context-plane.mjs` because
context assembly must run before planner/tool execution. This package records the
runtime contract, policies, and Pi-style extension boundary for future packaging.

Safety rules:

- Do not include full raw WeChat transcripts in model context.
- Do not include secrets or provider request bodies.
- Prefer artifact pointers, counts, freshness, and short redacted previews.
- Keep frontend exposure limited to "N context items attached" and optional details.

