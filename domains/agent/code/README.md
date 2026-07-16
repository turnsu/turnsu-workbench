# Agent Code Ownership Map

## Current Agent-Owned Areas

```text
domains/agent/code/agent-runtime/control-plane/
domains/agent/code/agent-runtime/core/run-loop/
domains/agent/code/agent-runtime/core/router/
domains/agent/code/agent-runtime/core/providers/
domains/agent/code/agent-runtime/core/capability/
domains/agent/code/agent-runtime/core/final-output/
domains/agent/code/agent-runtime/core/memory/
domains/agent/code/agent-runtime/core/subagents/
domains/agent/code/agent-runtime/prompts/
domains/agent/code/agent-runtime/skills/
domains/agent/code/agent-runtime/extensions/*/manifest.json
domains/agent/code/agent-runtime/extensions/*/skills/
domains/agent/code/agent-runtime/runtime/capability-catalog.json
domains/agent/code/agent-runtime/runtime/capability-registry.json
domains/agent/code/agent-runtime/runtime/schemas/
```

## Mixed Areas To Split Later

```text
domains/agent/code/agent-runtime/bin/
domains/agent/code/agent-runtime/lib/
domains/agent/code/agent-runtime/extensions/*/extension.ts
domains/agent/code/agent-runtime/runtime/public-surface.json
```

Some files here combine daemon/API behavior with agent execution behavior.

## Current Physical Target

```text
domains/agent/code/agent-runtime/
```

The Node package remains intact inside `agent-runtime`; scripts and Swift path resolution now point to this location.
