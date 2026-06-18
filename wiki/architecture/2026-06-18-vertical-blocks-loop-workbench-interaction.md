# Vertical Blocks + Loop Workbench Interaction Architecture

- Date: 2026-06-18
- Status: active
- Scope: Swift App interaction and view composition

## 1. Architecture Boundary

This iteration changes the App surface only.

Unchanged:

- Agent Runtime Core
- Pi Kernel
- Python / lower harness
- provider adapters
- gate semantics
- runtime artifact contracts
- `AgentFinalReadModel` authority
- Skill/Extension/Capability selection contract

Changed:

- Workbench layout
- Swift-only view models/adapters
- loop template launcher
- task-local detail entry
- product copy and smoke assertions

## 2. Interaction Model

The Workbench is organized around:

```text
Block Rail -> Loop Template -> Run -> Result Canvas -> Review / Follow-up
```

This replaces the older queue-first model:

```text
Task stack -> Result canvas -> Command composer
```

The older Command Desk model remains a historical baseline, but it no longer describes the final active product.

## 3. Block Rail

The left rail has two parts:

1. Domain Blocks
   - Crypto
   - Markets
   - Office

2. Active Loops
   - filtered by selected block when that block has active runs
   - falls back to all active runs when selected block is empty

Block selection changes:

- composer placeholder
- quick prompts
- loop templates
- result canvas empty state
- attachment affordance
- default capability package selections

## 4. Loop Template Launcher

`/add` opens a current-domain template selector.

It must not show:

- raw MCP tools
- provider names
- normalizer names
- worker names
- prompt filenames
- raw slash commands from external repos

It may show:

- trigger
- steps summary
- review gate
- exit condition
- expected output

## 5. Result Canvas

The result canvas is block-aware.

Crypto:

- CMC returned result blocks when available.
- Markdown final answer.
- price / evidence explanation.
- review and follow-up actions.

Markets:

- equity / macro / cross-asset draft.
- evidence gaps.
- review tasks.
- no direct trading execution language.

Office:

- meeting minutes or document draft.
- Cloud ASR status and transcript review signal.
- Feishu preview and confirmation status when present.
- no persistent Feishu live entry.

Fallback:

- If no task is selected, show selected block templates and a direct run action.
- If a final read model is missing, show a short task status. Do not reconstruct final text from SSE, session message, stream blob, or `final-output.md`.

## 6. Loop Composer

Loop Composer responsibilities:

- Hold user instruction.
- Display selected block.
- Provide block-specific quick prompts.
- Accept attachments where relevant.
- Open template selector.
- Submit through existing `DashboardViewModel.submitAgentPrompt()`.

It does not:

- decide final output precedence.
- decide product mutation eligibility.
- expose raw tools.
- call providers directly.

## 7. Task Detail Sheet

Task detail is opened from the selected run, review action, or evidence action.

Tabs:

- Evidence
- Review
- Policy
- CMC
- ASR
- Loop
- Memory
- Subagents

The sheet is a narrow, task-local review surface. It is not a permanent right Inspector.

## 8. Swift Types

New frontend-only types:

- `WorkbenchDomain`
- `WorkbenchBlock`
- `WorkbenchLoopTemplate`
- `WorkbenchLoopRunState`
- `WorkbenchBlockAction`
- `BlocksTaskStatus`

These types aggregate existing data:

- `AgentLongTask`
- `CapabilityLoopReadModel`
- `AgentFinalReadModel`
- `CMCCapabilitySummary`
- `CloudASRSummary`
- memory/subagent read models

They do not create new backend contracts.

## 9. Runtime Safety

Safety remains owned by runtime gates and final read models.

Frontend must enforce presentation rules:

- no global Inspector.
- no source browser as the default product path.
- no raw provider/tool/internal IDs.
- no raw artifact paths.
- no live Feishu publish/reply button without confirmation.
- no trading or external posting action.

## 10. UI Smoke

UI smoke must report:

- `ui_smoke_workspace=Workbench`
- `ui_smoke_blocks_workbench_visible=true`
- `ui_smoke_domain_blocks_visible=true`
- `ui_smoke_loop_templates_visible=true`
- `ui_smoke_active_loops_visible=true`
- `ui_smoke_no_global_inspector=true`
- `ui_smoke_single_final_answer_source=true`
- `ui_smoke_internal_tools_hidden=true`
- `ui_smoke_feishu_live_hidden_or_confirmed=true`

Legacy Command Desk smoke keys may remain temporarily for compatibility, but they are not the product direction.
