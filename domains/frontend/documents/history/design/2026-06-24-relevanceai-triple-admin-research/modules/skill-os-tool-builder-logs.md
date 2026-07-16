# Skill OS / Tool Builder / Logs Module

Status: research complete; native/Web parity pass 1 verified

## Reference Sources

- `03-tool-creation-logs.md`
- `screenshots/06-relevanceai-tools-list.png`
- `screenshots/07-relevanceai-tools-new-menu.png`
- `screenshots/08-relevanceai-tool-builder.png`
- `screenshots/09-relevanceai-tool-logs-tab.png`
- Web prototype: `web-prototype/src/App.jsx`, `web-prototype/src/loopopsModel.js`, `web-prototype/src/styles.css`
- Native: `LoopOpsViews.swift`, `LoopOpsModels.swift`, `LoopOpsLocalStore.swift`, `LoopOpsLocalJSONStore.swift`, `AgentRuntimeContractChecks.swift`

## Existing

- Product direction is explicit in `PRODUCT.md` and `DESIGN.md`: LoopOps v2 uses Workbench, Library, Studio, Skill OS, Knowledge, and scoped Chat, while public UI avoids provider/runtime/gate/schema/raw artifact terms.
- RelevanceAI Tool creation/logs research has already been translated into local acceptance: Tools database, New Tool starting point, Build/Use/Logs, required input validation, and status/user/cost/duration/error/output logs.
- Native has real local models: `LoopOpsToolDraft`, `LoopOpsToolLog`, `LoopOpsSkillStack`, Knowledge, and Builder Packet.
- Native Skill OS already has a tools list, Create Tool sheet, Use/Build/Logs segmented detail, and Stack Builder.
- `LoopOpsLocalStore` persists tool drafts/logs/stacks and syncs strict JSON snapshots.
- Web prototype is ahead of native on workflow fidelity: canonical tool log status flow, Tool Logs to Review Chat, Run Result tool logs to Review Chat, and structured Create Tool contract.
- Native parity pass 1 now adds canonical `LoopOpsToolLog` status mapping plus stable Review Chat scope ids.
- Native Tool Log rows expose `Open Review Chat`; the handoff writes a review-scoped assistant context message with tool, status, input, output/error, and run context.
- Native Review Chat and Run Chat are explicitly tested to remain separated for the same tool run.

## Gaps

- Create/Import Tool remains review-safe local draft creation. It does not parse external JSON, URL, or file definitions.
- Native Tool Builder exists, but the hierarchy is crowded: Build, Use, and Logs live inside the Skill Page right panel rather than a cleaner Tool detail page.
- Native `LoopOpsToolLog.status` still stores legacy strings for compatibility, but filters/labels can now use canonical mapping.
- Native Tool Log rows now have direct `Open Review Chat`; deeper log detail page hierarchy remains unfinished.
- Skill stacks have model, drag, save, and delete cleanup, but the front-end explanation of which runs/tools an active stack affects remains weak.
- Current native evidence is no-permission action wiring/contract harness. It does not prove AppKit/XCUITest pixel clicking.

## Design Direction

- Skill OS is the second library beside Loop Library.
- User-facing objects are Skills, Extensions, Tools, Tool Drafts, Skill Stacks, and Tool Logs.
- Tool Builder should have clear Build, Use, and Logs modes.
- Logs should read as product evidence, not backend execution dumps.
- Skill OS top level should separate `Tools database`, `Tool detail`, and `Skill Stack`.
- Tool detail has fixed tabs: `Build` for contract, `Use` for inputs/validation/run, `Logs` for history and handoff.
- Create Tool keeps three starting points: `Describe task`, `Start from blank`, and `Import`.
- Stable tool fields: Tool name, Description, Type, Source/Integration, Input scope, Required inputs, Steps, Outputs, Review rule, Used by loops/stacks, Owner, Status.
- Native tool log status should converge to a canonical lifecycle: draft, validated, submitting, waiting, running/run-scoped, succeeded, failed, blocked/cancelled.
- Each log row should keep status trace, run id, user, cost, duration, input summary, output/error summary, and Review Chat handoff.

## Implementation Targets

- Native:
  - Replace or wrap `LoopOpsToolLog.status` with a canonical status model and legacy display mapping.
  - Update Logs filtering to use normalized status, selected/all, user, run, and text query.
  - Add `Open Review Chat` on Tool Log rows, passing tool/status/output/run/knowledge context into `.review` chat.
  - Write canonical lifecycle state from append/ack/fail log paths in `LoopOpsLocalStore`.
  - Keep `DashboardViewModel.runLoopContract` review-only while reflecting pending tool log ack/fail into the new status model.
  - Extend contract checks/tests for Tool Log to Review Chat, canonical status, and forbidden visible terms.
- Web prototype:
  - Preserve the existing normalized status model in `loopopsModel.js` as the parity target.
  - Keep Tool Logs to Review Chat and Run Result tool logs to Review Chat behavior stable.
  - Continue using Build/Use/Logs as the native parity reference.
  - Maintain smoke checks for forbidden UI terms and Build/Use/Logs contract.

## Acceptance

- Skill OS navigation is visible.
- Skill packages are searchable and draggable into a loop path.
- Skill stacks can be saved and reused.
- Create/import tool path supports Describe/Blank/Import and creates a draft visible in list and stack shelf.
- Build mode edits inputs, steps, output, and review rule, then writes a draft-updated log.
- Use mode validates required inputs near the field, can bind to an active run, and writes lifecycle logs.
- Logs support selected/all, status, user, run, and query filters.
- Log rows show status, user, input, cost, duration, output/error, and run link.
- Running a tool creates a pending log, then resolves to success or blocked.
- Open Review Chat is scoped to the selected tool log and carries tool/run/status/output/knowledge context.
- Internal provider/runtime/gate/schema/raw identifiers do not appear in normal UI.

## Verification

- `swift build` passed after native Tool Log Review Chat/status changes.
- `swift test` passed with `checkLoopOpsToolLogCanonicalStatusAndReviewChatScope()`.
- `swift run WeChatIntelligenceRadar --contract-check` passed with `agent_runtime_contracts=pass`.
- Web prototype `npm run action:smoke` passed with `web_action_tool_log_review_chat=true`, `web_action_run_tool_log_review_chat=true`, `web_action_tool_logs_scoped=true`, and `web_action_no_browser_permissions=true`.

## Still Not Done

- Native Build/Use/Logs still needs visual polish into a cleaner Tool detail layout.
- Native log filters need full selected/all, status, user, run, and text query behavior with product-grade empty/loading states.
- Native visual QA is still harness-based, not screenshot/pixel-reviewed.
