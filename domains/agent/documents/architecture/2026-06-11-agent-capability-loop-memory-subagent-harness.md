# Agent Capability Loop, Memory, and Subagent Harness Architecture

- Date: 2026-06-11
- Status: implemented architecture
- Related plan: `wiki/plan/2026-06-11-unified-agent-workbench-capability-loop-harness-plan.md`

## 1. Architecture Position

The current project already has the correct high-level ownership:

- Swift Blocks Workbench is the product surface.
- Agent Runtime Host owns planning, tool execution, gates, artifacts, and final read models.
- Skill/Extension packages are the user-facing capability layer.
- Internal tools/providers/normalizers/workers remain hidden.

This iteration adds a loop harness above existing capabilities, not a new orchestrator.

## 2. Loop Read Model

New internal artifact:

```text
runtime/agent/runs/{runID}/capability-loop-read-model.json
```

Purpose:

- Classify the run into a product loop:
- `crypto_market_loop`
- `office_work_loop`
- `multi_domain_loop`
- `general_agent_loop`
- Record user-facing launch surface, selected capability package, review state, follow-up suggestions, memory policy, and coordination policy.
- Give Swift one compact task-local read model for the workbench.

It must not contain raw provider payloads, secrets, hidden MCP request bodies, or internal tool dumps.

## 3. Memory Read Model

New internal artifact:

```text
runtime/agent/runs/{runID}/memory-read-model.json
```

Purpose:

- Record whether memory is available.
- Summarize what can be remembered from the run.
- Mark unavailable Hermes integration explicitly instead of pretending memory is active.

Allowed statuses:

- `adapter_present_dry_run`
- `adapter_unavailable`
- `disabled`
- `blocked`

Memory is product memory, not model hidden state. It must be inspectable, bounded, and redacted.

## 4. Subagent Coordination Read Model

New internal artifact:

```text
runtime/agent/runs/{runID}/subagent-coordination-read-model.json
```

Purpose:

- Describe whether local subagent coordination is available.
- Use tmux as a process/session coordination reference only.
- In this phase, perform read-only detection and namespace planning.

Allowed statuses:

- `available_read_only`
- `unavailable`
- `disabled`
- `blocked`

Rules:

- Dedicated namespace: `looloomi-agent-*`.
- No kill/detach/send-keys.
- No inspection of unrelated user sessions by default.
- No raw terminal transcript in product UI.

## 5. Swift Read Path

Swift should read the three new artifacts through `AgentRunReadModelStore`.

Blocks Workbench can display:

- Capability loop status near result/review.
- Memory status in task detail.
- Subagent coordination status in task detail.

The result canvas must still render final answer only from `AgentFinalReadModel.finalText`.

## 6. Harness Ownership

Only these backend layers can decide:

- Planner / tool intent planner.
- Evidence/QA gate.
- Policy gate.
- Output guard.
- Capability loop classifier.

These layers cannot decide user-facing truth:

- Swift view state.
- Capability registry.
- Provider transport.
- Artifact writer.
- tmux detection.

## 7. Review and Follow-Up

Review is task-local:

- It can recommend follow-up prompts.
- It can mark missing evidence or blocked policy.
- It cannot mutate the final answer.
- It cannot import product mutations when product mutation policy says discarded.

Follow-up is a new task or continuation request, not a hidden mutation of the previous run.

## 8. Safety

- Trading opportunity analysis is research only.
- Office/Meeting output is draft/review unless explicitly confirmed.
- Feishu live write remains blocked or needs explicit confirmation.
- WeChatCLI remains read-only.
- tmux integration remains read-only in this phase.

## 9. Implementation Record

- Runtime writes `capability-loop-read-model.json`, `memory-read-model.json`, and `subagent-coordination-read-model.json` for completed runs.
- `run-manifest.json` includes `capabilityLoopSummary`, `memorySummary`, and `subagentCoordinationSummary`.
- Business QA asserts crypto runs classify as `crypto_market_loop` and office meeting/document runs classify as `office_work_loop`.
- Swift reads the new artifacts through `AgentRunReadModelStore` and displays them only in task-local Blocks Workbench surfaces.
