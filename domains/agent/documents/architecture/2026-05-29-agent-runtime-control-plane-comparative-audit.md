# Agent Runtime Control Plane Comparative Audit

Date: 2026-05-29

## 背景与结论

本报告补充 `2026-05-29-context-plane-comparative-audit.md` 之外的 Agent 底层控制面对比。这里不比较具体 skill、extension、Feishu、Office、CMC、WeChatCLI 等业务能力，而是比较两个项目在 Agent Runtime 的控制面设计：规划编排、工具调用、能力选择、执行 profile、模型路由、Policy/Approval/QA gate、worker/agent team、observability、artifact contract、session/task lifecycle、失败降级与安全边界。

参考依据以本地只读副本 `../assignment-agent-raw` 为准，外部项目身份为 [DESONGs/assignment-agent](https://github.com/DESONGs/assignment-agent)。本轮没有修改 `assignment-agent-raw`、`wechat-cli_raw`、Swift 代码、Agent Runtime Host 或 runtime schema。

核心结论：

- 当前项目已经具备本地 Agent Runtime Host MVP：Pi SDK ResourceLoader、public Skill/Extension surface、内部工具调用、session/task/run artifact、policy 记录、model route 记录、Ops read-model 都已存在。
- 当前项目不是“没有工具调用”，而是工具调用仍偏轻量：`prompt/skill/extension -> heuristic tool list -> name-level policy -> sequential execute`。它能跑通本地闭环，但还不是完整控制面。
- `assignment-agent-raw` 的底层更像分层运行时：task router 先形成 task intent 与 execution profile，planner 产出 planner envelope，capability/tool-load/model-routing/policy/qa/worker/metrics 各自有 contract 和 artifact。
- 当前项目的 `planner-envelope.json` 已有雏形，但 planner 逻辑仍写在 daemon 主流程中；`policyForTool` 也主要按 tool name 判断，缺少 actionIntent、audience、payloadClass、riskLevel、sourceRecordRequired 等维度。
- 下一阶段应补 **Agent Runtime Control Plane**：不增加前端复杂度，不暴露底层 tool/provider/module，而是在 Agent Runtime Host 内部补 task intent、execution profile、tool intent plan、gate、metrics、worker decision 和 schema validation。

## reference 项目底层架构

### 1. Task Router 与 Execution Profile

参考文件：

- `meeting-agent-pi-package_副本/tools/task_router.mjs`
- `meeting-agent-pi-package_副本/runtime/execution-profiles.schema.json`
- `meeting-agent-pi-package_副本/runtime/execution-profiles.json`

reference 项目不是直接从 prompt 推 tool，而是先做 task intent classification：

- task type：fast answer、file summary、audio minutes、document generation、document revision、multi-source synthesis、publish-only、unsupported。
- response mode：direct answer、document pipeline、needs file、ack cached file、unsupported。
- required stages / skip stages：例如 `file_context`、`source_context`、`planner_envelope`、`prompt_registry`、`document_workers`、`qa_gate`、`policy_gate`、`publish`、`reply`。
- reasoning depth：fast 或 deep。
- source preparation：附件、文件、音频、review context 是否需要进入后续管线。

这层解决的是“本次任务走哪条执行路径”的问题。它比单纯 tool inference 更早、更结构化。

### 2. Planner Runtime

参考文件：

- `meeting-agent-pi-package_副本/skills/planner-runtime/SKILL.md`
- `meeting-agent-pi-package_副本/extensions/planner-runtime.ts`
- `meeting-agent-pi-package_副本/runtime/planner-envelope.schema.json`

Planner 产出 `planner-envelope.json`，核心字段包括：

- `goal`
- `taskType`
- `successCriteria`
- `constraints`
- `capabilitiesNeeded`
- `toolPlan`
- `parallelizableWorkers`
- `policyRisks`
- `requiredArtifacts`
- `stopConditions`
- `fixedWorkflow=false`
- `rawSecretsReturned=false`
- `rawTranscriptIncluded=false`

重要点是：Planner 不负责业务生成，也不是固定会议流。它负责选择场景 playbook、能力、工具意图、worker、stop conditions，并要求后续 runtime 留痕。

### 3. Capability Registry 与 Tool Load Manifest

参考文件：

- `meeting-agent-pi-package_副本/runtime/capability-registry.json`
- `meeting-agent-pi-package_副本/runtime/tool-load-manifest.json`

reference 项目把能力与工具加载分开：

- capability registry 描述能力、状态、context cost、tool intents、policy、observability、security review、trigger、guardrail。
- tool-load-manifest 根据 execution profile 映射默认工具包，不要求每个任务加载全部工具。
- always-on 能力包括 planner、policy、QA、observability、capability registry；其他能力 lazy load。

这层解决的是“什么能力可以被加载、何时加载、为什么加载、有什么风险”的问题。

### 4. Model Routing

参考文件：

- `meeting-agent-pi-package_副本/runtime/model-routing.json`
- `meeting-agent-pi-package_副本/extensions/document-worker-runtime.ts`

reference 项目有独立 model routing contract：

- taskType 对应 primary model 和 fallbacks。
- `silentFallbackAllowed=false`，禁止无记录的静默降级。
- route artifact 写入 `model-route.json`。
- blocked conditions 包括 no candidate、privacy boundary unsatisfied、user requires exact model、manual/blocked candidate selected。
- QA gate 可走 deterministic rules provider，文档 worker 可按 fast/deep route 选择不同模型。

这层解决的是“为什么用这个模型、失败后如何降级、是否允许降级”的问题。

### 5. Policy Gate 与 Approval Gate

参考文件：

- `meeting-agent-pi-package_副本/extensions/policy-gate.ts`
- `meeting-agent-pi-package_副本/extensions/approval-gates.ts`
- `meeting-agent-pi-package_副本/runtime/policy-gate.schema.json`

Policy Gate 不是按 tool name 简单 pass/blocked，而是按 action intent 和 payload 风险判断：

- action intent：read、draft、write_private、publish_customer_visible、notify_people、mutate_calendar、assign_task、external_web、install_dependency、persist_memory、delete。
- 判断维度：audience、payloadClass、riskLevel、sourceRecordRequired、channel、targetSpecified、destructiveAction、containsSecrets、rawMediaExternalUpload、rawTranscriptIncluded。
- 输出状态：pass、needs_confirmation、blocked。
- 输出 safe alternative 和 required user confirmation。

Approval Gate 则负责交互式确认。如果没有 UI，确认请求会 fail closed。

这层解决的是“能不能做、需不需要人确认、确认不可用时是否阻断”的问题。

### 6. QA Gate

参考文件：

- `meeting-agent-pi-package_副本/extensions/qa-gate.ts`
- `meeting-agent-pi-package_副本/runtime/qa-gate.schema.json`

QA Gate 与 Policy Gate 分工不同：

- Policy Gate 判断动作边界。
- QA Gate 判断内容质量、证据覆盖、实体安全、标题同步、发布阻断。

QA Gate 可以输出 pass、needs_fix、blocked，并在 publish 前阻断用户可见输出。它让“生成结果质量”变成 runtime contract，而不是人工肉眼检查。

### 7. Worker 与 Agent Team

参考文件：

- `meeting-agent-pi-package_副本/extensions/document-worker-runtime.ts`
- `meeting-agent-pi-package_副本/extensions/agent-team-runtime.ts`
- `meeting-agent-pi-package_副本/skills/document-worker-runtime/SKILL.md`
- `meeting-agent-pi-package_副本/skills/agent-team-runtime/SKILL.md`

reference 项目的 worker 不是自由并发，而是 bounded worker：

- document worker 消费 bounded context pack 和 work unit。
- worker 有 max workers、max tasks、timeout、payload size、deadline、checkpoint、retry policy。
- worker trace 记录 section attempts、repair attempts、model route、contextPackId、source segment ids。
- agent-team runtime 提供任务形 worker，如 topic map extractor、evidence coverage checker、entity gate checker、risk/open question extractor。

这层解决的是“复杂任务如何拆分、并行、超时、重试、恢复、保序”的问题。

### 8. Runtime Observability

参考文件：

- `meeting-agent-pi-package_副本/extensions/runtime-observability.ts`
- `meeting-agent-pi-package_副本/runtime/metrics.schema.json`

reference 项目有独立 runtime metrics：

- planner decisions
- policy decisions
- worker decisions
- capability selections
- package audits
- model calls
- tool calls
- external calls
- generated artifacts
- token usage
- context budget
- QA gate status

metrics writer 会拦截 secret-like 字段和 raw transcript/full content，遇到 raw payload 倾向 fail closed。

这层解决的是“出问题时如何复盘整条控制链，而不是只看最终文本”的问题。

## 当前项目底层架构

### 1. Agent Runtime Host

参考文件：

- `agent-runtime/bin/wechat-agent-daemon.mjs`
- `agent-runtime/wiki/AGENT_RUNTIME_WIKI.md`

当前项目的 Node daemon 是产品层的 Agent Runtime Host：

- 嵌入 `@earendil-works/pi-coding-agent`。
- 使用 `DefaultResourceLoader` 加载本项目 extensions、skills、prompts。
- 使用 `SessionManager.inMemory(projectRoot)`。
- 禁用 Pi built-in `bash/edit/write`，只启用项目 custom tools。
- 提供本地 HTTP API：health、capabilities、sessions、messages、runs events、pause/resume/cancel。
- 写 `runtime/agent/sessions/`、`runtime/agent/tasks/`、`runtime/agent/runs/{runID}/`。

这已经具备本地 agent 工作台所需的宿主能力。

### 2. Public Skill/Extension Surface

参考文件：

- `agent-runtime/runtime/public-surface.json`
- `agent-runtime/runtime/capability-registry.json`

当前项目对前端暴露 Skill/Extension，而不暴露 raw tool/provider/module：

- Swift 提交 `selectedSkillIDs`、`selectedExtensionIDs`、prompt、attachments、contextRefs。
- daemon 内部从 public surface 和 extension package manifest 合并公开能力。
- `internalToolsExposed=false`。

这是当前项目比 reference 更产品化的一点：前端体验更克制，底层工具不直接变成用户按钮。

### 3. Internal Tool Inference

参考文件：

- `agent-runtime/bin/wechat-agent-daemon.mjs`
- `agent-runtime/runtime/tool-load-manifest.json`

当前工具选择逻辑主要在 daemon 内：

- `toolsForSkill(skillID)`
- `toolsForExtension(extensionID)`
- `inferTools(prompt, selectedToolNames, attachments, selectedSkillIDs, selectedExtensionIDs)`

它根据 Skill、Extension、prompt keyword 和附件决定 internal tools。执行时按列表顺序逐个调用 `piRuntime.executeTool`。

这能跑通本地 MVP，但还不是独立的 task intent / execution profile / tool intent plan。

### 4. Planner Envelope

参考文件：

- `agent-runtime/bin/wechat-agent-daemon.mjs`
- `agent-runtime/extensions/planner-runtime.ts`

当前项目会写 `planner-envelope.json`，字段包括 goal、taskType、successCriteria、constraints、selectedSkills、selectedExtensions、capabilitiesNeeded、internalToolPlan、policyRisks、requiredArtifacts、stopConditions。

但 `agent-runtime/extensions/planner-runtime.ts` 目前只是 placeholder，实际 plannerEnvelope 函数仍在 daemon 主文件里。它更像“run metadata envelope”，还不是独立 planner runtime。

### 5. Policy 与 Tool Call

参考文件：

- `agent-runtime/bin/wechat-agent-daemon.mjs`
- `agent-runtime/extensions/policy-gate.ts`
- `agent-runtime/runtime/capability-registry.json`

当前 `policyForTool(name)` 按 tool name 返回：

- pass
- needs_confirmation
- blocked

blocked 覆盖 live WeChat、live wechat-cli、trade、send message、publish external；Computer Use 和 CMC MCP refresh 需要确认。

该策略简单、清晰、安全，但缺少 reference 项目的 actionIntent、payloadClass、audience、riskLevel、targetSpecified、sourceRecordRequired 等维度。

### 6. Model Route

参考文件：

- `agent-runtime/bin/wechat-agent-daemon.mjs`
- `agent-runtime/runtime/model-providers.json`

当前项目有 provider readiness 和 model route artifact：

- DeepSeek：text/planning/tool-call style chat。
- Kimi：vision attachment analysis。
- provider 缺失时返回 `blocked_missing_provider_config`。
- 不写 API key、Authorization 或 raw request body。

但 route/fallback 仍偏固定：没有按 task type 的 route table、silent fallback policy、manual blocked candidate、exact model requirement。

### 7. Artifact 与 Product Mutation

参考文件：

- `agent-runtime/runtime/schemas/agent-session.schema.json`
- `agent-runtime/runtime/schemas/product-mutations.schema.json`
- `agent-runtime/extensions/wechat-onchain-tools.ts`

当前 run artifacts 包括：

- `events.ndjson`
- `planner-envelope.json`
- `tool-calls.json`
- `model-route.json`
- `attachments.json`
- `policy-decisions.json`
- `product-mutations.json`
- `final-output.md`

`product-mutations.json` 是当前项目的一个重要边界：Agent 不直接任意改 Swift store，而是写本地 mutation inbox，Swift 再导入允许对象并做幂等。

这是当前项目相对 reference 更贴近产品数据闭环的一点。

### 8. Ops Read Model

参考文件：

- `agent-runtime/bin/wechat-agent-daemon.mjs`
- `runtime/ops/*`

当前项目已将 Ops 从 Agent task planning 中拆出：

- `runtime/ops/provider-status.json`
- `runtime/ops/dependency-status.json`
- `runtime/ops/health/agent-runtime-host.json`
- `runtime/ops/policy/latest-policy-summary.json`

这符合用户要求：Agent 负责执行任务与产出 artifact，Ops 负责 health、provider readiness、dependency、policy summary。

## 差异对比

| 控制面 | assignment-agent-raw | 当前项目 | 结论 |
| --- | --- | --- | --- |
| 任务入口 | `task_router` 先产出 task intent、profile、stage plan | Swift 直接 POST prompt/skills/extensions/contextRefs 到 daemon | 当前缺少任务意图层 |
| 规划层 | `planner-runtime` 独立 tool 与 schema | `plannerEnvelope()` 在 daemon 主文件中 | 有 artifact 雏形，缺独立 planner module |
| 能力选择 | capability registry + lazy load + contextCost + guardrails | public Skill/Extension + hardcoded tool mapping | 前端更简洁，但底层选择依据较弱 |
| 工具调用 | toolPlan 使用 actionIntent、policyCheckRequired | tool list 使用 skill/extension/prompt heuristic | 缺 tool intent contract |
| 上下文 | source-context-runtime + context pack + gate | contextRefs 透传或截断进 prompt | 已在另一份 Context Plane audit 中确认缺口 |
| 模型路由 | model-routing table + fallback policy + route artifact | provider readiness + fixed DeepSeek/Kimi route | 缺任务级 route/fallback policy |
| Policy Gate | actionIntent/audience/payload/risk/source record | tool name 级 pass/needs_confirmation/blocked | 当前安全但粒度不足 |
| Approval Gate | 有 UI-aware approval request，no UI fail closed | needs_confirmation 主要记录为 policy/tool status | 缺独立 approval decision artifact |
| QA Gate | 内容质量、证据、实体、发布前阻断 | 业务运行有 QA/Policy module，Agent daemon 无独立 QA gate | 缺 Agent task 级 QA gate |
| Worker 并行 | document worker / agent team / bounded worker / retry / deadline | internal tools sequential execute | 缺 worker scheduler 和 retry/checkpoint |
| Observability | runtime metrics 记录 planner/policy/worker/model/tool/context/QA | events/tool-calls/policy/model-route/Ops | 有基础 trace，缺统一 runtime metrics |
| Artifact contract | 多 schema，gate/metrics/route/profile 都有 contract | session/product mutation schema + run artifact | 关键控制面 schema 不足 |
| Lifecycle | profile/stage/checkpoint/retry/partial publish | session/task/run + pause/resume/cancel events | 产品生命周期具备，执行恢复较弱 |
| Ops | observability 仍较靠近 runtime | Ops read-model 已解耦 | 当前项目在 Ops 解耦方向更符合本项目目标 |

## 当前项目缺口

### Gap 1: 缺 AgentTaskIntent

当前 daemon 从 prompt 和 selected Skill/Extension 直接推 tools。缺少一层结构化 task intent：

- taskType
- responseMode
- executionProfile
- requiredStages
- skipStages
- reasoningDepth
- sourcePreparation
- unsupported reason

没有这层，后续增加更多任务类型时会继续扩大 `inferTools()` 的复杂度。

### Gap 2: 缺 ExecutionProfile

当前 `agent-runtime/runtime/tool-load-manifest.json` 有 profileTools，但没有完整 profile contract。需要把不同任务路径固化为可审计 profile：

- chat
- daily intelligence
- token check
- image analysis
- long watch
- handoff
- context-heavy research
- unsupported / blocked

profile 应定义 required stages、allowed tools、model route、QA gate、policy gate、context policy、worker policy。

### Gap 3: 缺独立 Planner Module

当前 planner envelope 已写出，但 planner 逻辑仍在 daemon 主流程。应拆成内部 control-plane module：

- 输入：prompt、selected Skill/Extension、attachments、context refs、daemon health。
- 输出：planner envelope、task intent、execution profile、tool intent plan、required artifacts、stop conditions。
- 不执行工具、不生成业务内容。

这会让 planner 变成可测试、可复盘、可替换的控制面。

### Gap 4: 缺 ToolIntentPlan

当前 internal tools 是具体 tool names。建议新增 `ToolIntentPlan`：

- actionIntent：read、draft、write_private、persist_memory、request_confirmation、external_provider、external_action。
- toolName：内部 tool。
- reason：为何需要。
- policyCheckRequired。
- inputBoundary：context bundle、artifact pointer、attachment analysis、provider config。
- outputBoundary：artifact path、product mutation、run event。

这样 tool 选择不再只是“选哪个函数”，而是“为什么、带什么输入、产出什么边界”。

### Gap 5: Policy 粒度不足

当前 `policyForTool(name)` 易懂且安全，但缺少高阶维度：

- audience：private/local/team/customer/external。
- payloadClass：runtime artifact、private message preview、raw file、market evidence、model prompt。
- riskLevel：low/medium/high。
- sourceRecordRequired。
- targetSpecified。
- destructiveAction。
- rawSecretsReturned / rawPrivateContentIncluded。

下一阶段可保留 name-level allowlist 作为第一层，再叠加 actionIntent 级 policy gate。

### Gap 6: 缺 ApprovalDecision

当前 needs_confirmation 多数只是 tool/policy 状态。缺少独立 approval artifact：

- requested action
- target
- summary
- risk
- visibility
- reversible
- approval available
- approved/rejected/unavailable
- decidedAt

Computer Use、CMC live refresh、未来外部动作都需要这层，而不是直接混在 tool call status 中。

### Gap 7: 缺 QA Gate

Agent daemon 目前会生成 final output 和 product mutation，但没有统一 QA gate。对本项目而言，QA gate 不需要做 Office 文档检查，但至少应覆盖：

- evidence coverage：Crystal/Proposal 是否有证据。
- privacy：是否泄露 raw private message、secret、Authorization、cookie。
- action safety：是否把研究建议误写成交易/发消息/发布指令。
- source freshness：market/onchain/wechat 是否 stale/degraded。
- output contract：handoff/proposal/memory 是否满足本地 schema。

### Gap 8: 缺 RuntimeMetrics

当前已有 `events.ndjson`、`tool-calls.json`、`policy-decisions.json`、`model-route.json`，但缺一个统一 metrics view：

- task intent
- selected capabilities
- model calls
- tool calls
- policy decisions
- approval decisions
- QA gate
- context budget
- artifacts
- blocked/degraded reasons

Ops 可以读取这个 metrics，而不是从多个 artifact 临时推断。

### Gap 9: 缺 Worker Scheduler / Agent Team Runtime

当前 internal tools 顺序执行。复杂任务需要 bounded workers：

- context retrieval worker
- market evidence worker
- token/entity worker
- evidence coverage worker
- handoff writer worker
- memory review worker

首版不需要真正多线程，但需要 worker decision artifact、timeout、retry、deadline、max tasks、partial result 策略。

### Gap 10: 缺可配置 ModelRouteDecision

当前 DeepSeek/Kimi provider 配置清晰，但 route 策略固定。建议新增：

- route table by taskType/profile。
- fast/deep/vision/deterministic gate routes。
- fallback candidates。
- silent fallback forbidden。
- blocked reasons。
- exact model requested handling。

这能避免未来 live provider 接入后模型选择不可追踪。

### Gap 11: 缺 Resume/Checkpoint

当前 session/task/run 可恢复，pause/resume/cancel 也有事件，但执行过程没有 stage checkpoint。长期任务需要：

- current stage
- completed stages
- retry ledger
- partial artifacts
- resume from stage
- cancelled/failed/degraded finalization

这与用户希望的长期任务工作台直接相关。

### Gap 12: Artifact Schema Validation 不足

当前有部分 schema，但 daemon 写出的核心控制面 artifact 多数未被 schema validate。建议后续至少验证：

- planner envelope
- tool calls
- policy decisions
- product mutations
- model route
- future context bundle
- future QA gate / runtime metrics

## 建议演进路线

### Phase 0: 报告与边界冻结

- 完成本报告。
- 明确下一阶段不是增加前端能力按钮，而是补 Agent Runtime Control Plane。
- 保持前端只暴露 Skill/Extension 和轻量任务过程。

### Phase 1: Control Plane Manifest

新增内部控制面 artifact：

```text
runtime/agent/runs/{runID}/control-plane-manifest.json
runtime/agent/runs/{runID}/task-intent.json
runtime/agent/runs/{runID}/execution-profile.json
```

先不改变执行行为，只把当前推断结果结构化写出。

### Phase 2: Planner Module 拆分

把 daemon 内的 `plannerEnvelope()`、`inferTools()`、`policyForTool()` 周边决策拆成内部模块：

```text
agent-runtime/control-plane/
  task-intent.mjs
  execution-profile.mjs
  planner.mjs
  tool-intent-plan.mjs
  policy-decision.mjs
```

对外 API 不变，Swift 仍只调用现有 daemon endpoints。

### Phase 3: Policy / Approval / QA Gate

新增：

```text
policy-decisions.json
approval-decisions.json
qa-gate.json
```

Policy 从 tool-name gate 升级为 actionIntent + payload boundary；Approval 独立记录人工确认状态；QA gate 负责 evidence/privacy/freshness/output contract。

### Phase 4: Runtime Metrics

新增：

```text
runtime/agent/runs/{runID}/runtime-metrics.json
runtime/ops/metrics/latest-agent-runtime-metrics.json
```

Ops 从 metrics 读健康、失败、staleness、blocked/degraded，而不是从 run artifacts 临时拼。

### Phase 5: Worker Decision 与 Checkpoint

新增：

```text
worker-decisions.json
checkpoint.json
retry-ledger.json
```

首版可以仍顺序执行，但每个 stage 都记录 worker decision、timeout、retry、partial artifact 和 resume point，为长期任务恢复做准备。

## 未来接口建议

以下接口只作为后续实现建议，本轮不实现：

- `AgentTaskIntent`
- `ExecutionProfile`
- `ToolIntentPlan`
- `ControlPlaneManifest`
- `RuntimeMetrics`
- `QAGateResult`
- `ApprovalDecision`
- `WorkerDecision`
- `ModelRouteDecision`

这些接口应属于 Agent Runtime Host 内部控制面，不进入前端 public surface。

## 验收建议

文档验收：

- 本文档存在于 `wiki/architecture/2026-05-29-agent-runtime-control-plane-comparative-audit.md`。
- `wiki/PROJECT_WIKI.md` 增加索引和 checkpoint。
- 文档明确排除具体 skill/extension 业务功能比较。
- 文档覆盖上下文、工具调用、规划编排、policy/approval/QA、worker、observability、artifact、模型路由、session/task lifecycle。

后续实现验收：

```bash
node domains/agent/code/agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check
swift build --scratch-path /private/tmp/wechat-radar-build
swift test --scratch-path /private/tmp/wechat-radar-test-build
```

新增 control plane artifact 后检查：

```text
runtime/agent/runs/{runID}/control-plane-manifest.json
runtime/agent/runs/{runID}/task-intent.json
runtime/agent/runs/{runID}/execution-profile.json
runtime/agent/runs/{runID}/runtime-metrics.json
runtime/agent/runs/{runID}/qa-gate.json
runtime/agent/runs/{runID}/approval-decisions.json
```

安全验收：

- 不运行真实微信读取、live wechat-cli、交易、发消息、外部发布。
- 不写入 API key、Authorization、cookie 或真实私聊原文。
- `assignment-agent-raw` 与 `wechat-cli_raw` 保持只读。

