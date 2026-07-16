# Agent Domain

Agent owns reasoning, prompts, skills, capability packages, tool routing, run loops, and evidence/final-output semantics.

## Documents

- [Current full-stack architecture](../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
- [Agent boundaries](documents/boundaries.md)
- [Code ownership map](code/README.md)

## Agent Responsibilities

- Agent system prompts and task prompts.
- Skill and extension manifests.
- Capability catalog and registry semantics.
- Tool intent planning.
- Model route selection.
- Agent run loop and provider execution.
- Evidence, final-output, memory, and subagent contracts.

## Not Agent

- App native layout.
- Web product layout.
- Product storage ownership.
- Daemon lifecycle and local auth unless directly required by agent execution.
- User-facing design system.

## Current Main Sources

Most agent code currently lives in `domains/agent/code/agent-runtime/`.

## Migrated Docs

- Agent architecture notes: [documents/architecture/](documents/architecture/)
- Agent plans: [documents/plan/](documents/plan/)
- Agent state records: [documents/state/](documents/state/)
- Agent problem reviews: [documents/problem/](documents/problem/)
- Agent runtime package wiki: [code/agent-runtime/wiki/AGENT_RUNTIME_WIKI.md](code/agent-runtime/wiki/AGENT_RUNTIME_WIKI.md)
