# Agent Harness 产品化迭代架构

- 日期：2026-06-06
- 范围：Agent Runtime Host、Pi SDK-backed daemon、Context Plane、Final Read Model、Swift Agent Workspace
- 参考输入：`/private/tmp/agent-harness-architecture.html`、Pi-agent harness 调研文本、`assignment agent_副本/meeting-agent-pi-package`
- 状态：核心重组方案，代码执行前需过目

## 0. 摘要

当前 Web3 Agent 的 harness 已经覆盖 Node daemon、control plane、context plane、CMC gate、final read model、Swift adapter 和 UI smoke。它能证明运行时可控、可回放、可诊断，也能持续防止 CMC 空证据、输出闸门、Swift 多最终来源等问题回归。

但这套 harness 仍然主要是测试与验收编排。它回答的是：

```text
这次 run 是否正确跑完？
关键 artifact 是否写出？
gate 是否拦住错误输出？
Swift 是否只显示权威 final read model？
```

它还没有成为 live Agent 的生产运行时控制面。生产 harness 要回答的是：

```text
这个 Agent session 如何被调用、暂停、补充、分支、复核和恢复？
上下文如何在每次模型调用前被裁剪、注入、压缩和追踪？
工具调用和最终答案如何被独立复核，复核结果如何进入或拒绝主分支？
长任务如何形成可解释的 session tree，而不是一串孤立 smoke artifacts？
```

因此下一阶段不是继续堆更多 smoke/QA 命令，而是把 harness 从 acceptance layer 升级为 production control layer。测试 harness 保留，生产 harness 新增。两者共享 artifacts，但职责不同。

## 1. 当前 Harness 判断

### 1.1 已经具备的测试与验收能力

当前 HTML harness 文档把测试脚手架拆成五层：

- 执行脚手架：`agent-runtime/package.json`、daemon smoke、async smoke、business QA。
- 产物契约：`runtime/agent/runs/{runID}` 下的 control/context/tool/final artifacts。
- 闸门断言：CMC evidence/price split、output guard、product mutation policy。
- Swift 读模型验证：`AgentFinalReadModel`、`AgentWorkspaceStateAdapter`、`RuntimeBackend` mutation import。
- UI smoke：验证桌面 App 可启动并出现可见窗口。

这些能力已经覆盖了本项目过去最混乱的几类问题：

- CMC MCP transport 成功但 `assets=[]`、`readableEvidence=[]` 时不能声称已读取实时研究证据。
- `allowLiveResearch=true` 不等于 `allowConcretePrices=true`。
- 输出被 market guard rewrite 后，最终答案和 product mutations 必须降级或丢弃。
- Swift 不能在 SSE final text、`final-output.md`、session assistant message、file store 之间竞争最终答案。
- `agent-final-read-model-v1` 是唯一权威最终展示来源。

这套测试 harness 的价值很高，应该继续作为 acceptance layer 保留。

### 1.2 仍然缺失的生产运行时能力

当前 harness 的主要缺口不是测试覆盖不足，而是没有把 Agent 的生产运行过程本身建模为 harness：

- 没有 first-class session tree。当前 session/run/task 有记录，但还不能表达 fork、review branch、steering、follow-up、merge、abandon。
- 没有 invocation ledger。用户补充、系统 replan、tool retry、manual steering 没有统一的调用账本。
- 没有 context event。Context Plane 已经能写 `context-pack.json`、`source-trust-report.json`、`memory-compression.json`，但还没有成为每次模型调用前的动态 prune/inject hook。
- 没有 compaction policy。当前 memory compression 是 artifact，不是 session tree 中可复用、可复核、可回放的压缩事件。
- 没有独立 reviewer branch。output guard 和 QA gate 是主链路内的 gate，还不是独立 session 对主分支进行二次复核。
- 没有 merge policy。review 结果如何影响主 final read model、product mutations、memory proposal，目前尚未形成 contract。
- 没有产品级 branch/read model。Swift 只能看最终 run 结果和简洁诊断，不能看 branch lineage、review 状态和可恢复节点。

这些缺口导致长任务和复杂研究仍然容易表现为“无限出现和混乱”：看起来有很多 artifact，但缺少一个能解释 Agent 控制流的运行时骨架。

### 1.3 当前可复用的 artifact substrate

本项目已经有适合作为生产 harness 底座的 artifact：

```text
planner-state.json
task-graph.json
agent-loop.ndjson
planner-decisions.ndjson
context-index.json
retrieval-results.json
context-pack.json
source-trust-report.json
memory-compression.json
tool-observations.json
agent-final-read-model.json
product-mutations.json
```

这些 artifact 目前主要用于证明单次运行正确。下一步要把它们提升为 session tree、branch、context event、review branch 的基础数据，而不是再造第二套状态。

## 2. Pi-Agent Harness 参考

Pi-agent 社区成熟 harness 的核心不是某个 CLI 命令，而是三件事：

```text
Invocation
Context
Verification
```

Pi 的关键思想是：Agent 本身就是 harness，通过 Extension、Session Tree 和 Context Event 控制调用、上下文和核查。

### 2.1 Invocation Harness

Pi CLI 生产用法强调 named session、fork、follow-up、steering、RPC/SDK 嵌入。对应到当前项目：

- named session 对应当前 daemon session，但需要更强的 session tree。
- fork 对应从某个 run/step/context checkpoint 分支继续。
- follow-up 对应用户补充信息，不应创建完全孤立的新 run。
- steering 对应用户或系统在运行中插入约束、改目标、停止某个 branch。
- RPC/SDK 嵌入对应当前 Swift + daemon 模型，而不是 shell out 到全局 `pi` CLI。

结论：当前项目应采用 SDK Embedded Runtime Harness 作为主路径。CLI harness 只作参考，不作为默认执行方式。

### 2.2 Context Harness

Pi 的 context 机制包括静态指令、动态 context event、session tree、memory、auto compaction 和 custom compaction。对应到当前项目：

- 静态层：`agent-system.md`、skill docs、extension manifest、public surface。
- 动态层：每次模型调用前由 Context Plane 选择 bounded context pack。
- 持久层：session tree 和 branch lineage。
- 压缩层：`memory-compression.json` 升级为 compaction event，可被 review 和回放。
- 隐私层：raw private transcript、provider prompt、secret、raw request body 不进入 context artifacts。

当前 Context Plane 的 deterministic retrieval pack 是正确起点，但它还只是一次性 artifacts。生产 harness 要让它成为每次 LLM 调用前的 context event。

### 2.3 Verification Harness

Pi 的复核机制包括 tool call 拦截、session_before_compact 校验、自定义压缩、独立 `/review` branch 和 merge 前复核。对应到当前项目：

- `tool_call` 拦截：现有 Policy Gate、approval decision、output guard 可以承接，但要记录为 harness events。
- `session_before_compact`：在压缩前检查证据、路径、失败原因、gate 决策是否保留。
- 独立 review branch：新增 reviewer run，读取主分支 final read model、tool observations、context pack、gate summary。
- merge policy：review branch 不能直接覆盖主 final，也不能导入 product mutations。只有通过主分支 merge decision 才能影响最终状态。

当前项目已经有 QA/output guard，但它们在主链路内。生产 harness 需要把 reviewer branch 作为独立核查面，避免主 Agent 自证正确。

### 2.4 Multi-Agent Harness

Pi 的 multi-agent harness 通常由 planner、builder、reviewer 子 session 组成。当前项目可以吸收这个方向，但不应第一阶段直接上多 agent。

原因：

- 当前 session tree 和 branch lineage 尚未建模。
- 当前 Context Plane 尚未接入 context event。
- 当前 Swift 还没有 branch/read model 展示能力。
- 当前 product mutation policy 已经足够敏感，多 agent 会增加状态合并复杂度。

因此 multi-agent orchestration 应作为第二阶段：先把单 Agent 的 invocation/context/verification harness 稳定下来，再引入 planner/researcher/reviewer 子 session。

## 3. 目标架构

### 3.1 两层 Harness

下一阶段需要明确两层 harness：

```text
Acceptance Harness
  -> npm test
  -> daemon smoke / async smoke / business QA
  -> Swift build/test
  -> UI smoke
  -> artifact assertions

Production Runtime Harness
  -> invocation/session tree
  -> context event/compaction
  -> review branch/merge policy
  -> branch read models
  -> final read model authority
```

Acceptance Harness 证明实现没有坏。Production Runtime Harness 控制真实 Agent 如何运行。

两者共享 artifacts，但不要混淆：

- smoke artifacts 不是用户任务状态。
- business QA summary 不是生产 session tree。
- UI smoke 不是 live Agent 完成信号。
- `agent-final-read-model.json` 是最终答案，但不是完整 harness state。

### 3.2 Invocation Plane

Invocation Plane 负责描述一次 Agent 调用的来源、目标、分支和生命周期。

建议新增内部 artifacts：

```text
harness-session-tree.json
harness-branch-lineage.json
invocation-ledger.ndjson
```

建议语义：

```text
harness-session-tree.json
  sessionID
  rootRunID
  branches[]
  activeBranchID
  terminalBranches[]
  reviewBranches[]
  createdAt
  updatedAt

harness-branch-lineage.json
  branchID
  parentBranchID
  sourceRunID
  sourceStepID
  branchType = main | follow_up | steering | retry | review | experiment
  status = active | completed | abandoned | merged | blocked
  mergeTargetBranchID
  mergeDecision

invocation-ledger.ndjson
  accepted
  follow_up_received
  steering_inserted
  branch_created
  branch_abandoned
  branch_merged
  review_requested
  final_selected
```

规则：

- 用户 follow-up 不应默认变成孤立 session，必须能关联到 prior branch。
- review branch 必须有 `branchType=review`，不能导入 product mutations。
- retry branch 必须记录 retry 的 source step，不允许只覆盖原 artifact。
- final selection 必须记录为何选择某个 branch 的 final read model。

### 3.3 Context Plane

Context Plane 负责把当前任务、历史、证据、工具结果和记忆变成有边界的模型上下文。

建议新增内部 artifacts：

```text
context-event-log.ndjson
compaction-summary.json
```

现有 artifacts 继续保留：

```text
context-index.json
retrieval-results.json
context-pack.json
source-trust-report.json
memory-compression.json
context-chunks/{chunkID}.json
```

目标行为：

- 每次模型调用前写入 context event，记录输入来源、排除来源、选中 chunks、预算、隐私裁剪和 gate reason。
- context pack 不只为最终 synthesis 服务，也为 replan、review、follow-up 和 branch resume 服务。
- compaction 必须保留文件路径、artifact path、tool failure、gate decision、missing input、evidence status 和 final read model lineage。
- compaction 不应把 raw private transcript、secrets、provider prompt、raw request body 写入摘要。
- source trust 必须进入 context event，而不是只留在单次 run artifacts 中。

### 3.4 Verification Plane

Verification Plane 负责独立复核工具调用、上下文压缩、最终答案和 product mutations。

建议新增内部 artifact：

```text
review-read-model.json
```

建议语义：

```text
review-read-model.json
  schemaVersion = agent-review-read-model-v1
  reviewRunID
  sourceRunID
  sourceBranchID
  status = pass | needs_revision | blocked | insufficient_evidence
  findings[]
  checkedArtifacts[]
  cmcGateSummary
  outputGuardStatus
  mutationPolicyAssessment
  mergeRecommendation = merge | revise | discard | keep_main
  generatedAt
```

规则：

- reviewer branch 只读取 bounded artifacts，不读取 raw provider request、secret 或未脱敏私有正文。
- reviewer branch 不能写入 tasks、watchlist、crystals、proposals、memory、handoffs。
- reviewer branch 不能直接覆盖 `agent-final-read-model.json`。
- reviewer branch 的建议必须由主分支 merge decision 接受后才影响最终展示。
- 如果 reviewer 发现 CMC empty evidence、价格被拦截或 output guard rewrite，必须把 product mutations 维持为 discarded。

### 3.5 Orchestration Plane

Orchestration Plane 负责后续多 agent 拆解。第一阶段只保留 contract，不实现多 agent。

未来子 session 类型：

- planner：拆解任务、列 evidence requirements、生成 branch plan。
- researcher：执行 bounded research/tool loop。
- reviewer：独立复核主分支结论和 evidence coverage。

规则：

- 子 session 必须有独立 branchID 和 source context pack。
- 子 session 输出必须是 read model 或 observation，不是直接产品 mutation。
- 主 session 负责 merge，子 session 不负责最终答案选择。
- Swift 只展示 run tree 和 branch summary，不展示 raw internal tools。

## 4. Swift 前端边界

Swift 前端不应该成为 harness 决策层。下一阶段展示能力应收敛为 read model：

```text
AgentFinalReadModel
HarnessSessionTreeReadModel
BranchLineageReadModel
ReviewReadModel
CMCGateSummary
ProductMutationPolicy
```

Swift 可以展示：

- 当前 run tree。
- 当前 active branch。
- review branch 是否通过。
- final read model 来源。
- compact diagnostics：`Evidence empty`、`Prices blocked`、`Final rewritten`、`Mutations discarded`。

Swift 不应该展示或决定：

- raw provider。
- raw tool。
- normalizer。
- internal worker。
- final precedence。
- mutation eligibility。
- reviewer merge policy。

如果 final read model 缺失，Swift 仍然只显示短状态，不从 SSE final text、stream blob、`final-output.md` 或 session assistant message 拼接答案。

## 5. 分阶段路线

### Phase 1：文档与 Contract

目标：

- 明确测试 harness 与生产 runtime harness 的边界。
- 确认当前项目主路径为 SDK Embedded Runtime Harness。
- 记录不 shell out 到全局 `pi` CLI、不迁移办公/会议/飞书能力、不新增 Docker worker 的边界。
- 定义 session tree、branch lineage、invocation ledger、context event、review read model contract。

交付：

- 本架构文档。
- `wiki/PROJECT_WIKI.md` 索引同步。

### Phase 2：Invocation Harness

目标：

- 后端 daemon 写入 `harness-session-tree.json`。
- 后端 daemon 写入 `harness-branch-lineage.json`。
- 后端 daemon 写入 `invocation-ledger.ndjson`。
- follow-up、retry、review request 至少在 artifact 层可表达。

验收：

- 同一 session 下多个 run 可以形成 parent/child branch lineage。
- retry 不覆盖旧 run artifact。
- review branch 可以被创建，但不影响主 final。

### Phase 3：Context Event 与 Compaction Policy

目标：

- 把现有 `context-pack.json`、`source-trust-report.json`、`memory-compression.json` 接入 context event。
- 每次模型调用前写入 `context-event-log.ndjson`。
- compaction 生成 `compaction-summary.json`。

验收：

- context event 能解释某个 chunk 为什么入选或被排除。
- compaction 后保留 artifact path、evidence status、gate decision、tool failure、missing input。
- raw private transcript、secret、provider prompt 不进入 compaction summary。

### Phase 4：Verification Branch

目标：

- 新增 reviewer branch runtime。
- 新增 `review-read-model.json`。
- reviewer 读取主 final read model、tool observations、context pack、gate summary。
- reviewer 输出 pass/needs_revision/blocked/insufficient_evidence。

验收：

- reviewer branch 不覆盖主 final read model。
- reviewer branch 不导入 product mutations。
- empty evidence 或 output rewrite 场景下 review 不能建议导入 mutations。

### Phase 5：Swift Read Model 收敛

目标：

- Swift 新增 branch/review read model 解码。
- Agent workspace 只展示 run tree、branch summary、review result 和 final read model。
- `DashboardViewModel` 不决定 branch merge、final precedence 或 mutation eligibility。

验收：

- completed run 只显示 `AgentFinalReadModel.finalText`。
- review branch 可见但不会生成重复 assistant final。
- final read model 缺失时仍然不显示 stream fallback。

### Phase 6：Multi-Agent Orchestration

目标：

- 在 session tree 稳定后引入 planner/researcher/reviewer 子 session。
- 每个子 session 独立 context pack 和 branchID。
- 主 session 负责 merge 和 final selection。

验收：

- 子 session 输出不直接进入产品 store。
- merge decision 可审计。
- review branch 可以拒绝 researcher 输出。

## 6. 非目标

- 不把会议纪要、办公文档、飞书发布、日历、任务、会议助手能力迁移到 Web3 项目。
- 不把 `assignment agent_副本` 的业务能力复制到当前仓库。
- 不默认通过全局 `pi` CLI 执行当前项目任务。
- 不暴露 internal tools、provider、normalizer、worker 给前端用户选择。
- 不让 Docker bounded worker 进入本轮代码实现。
- 不让 reviewer branch 自动写入长期记忆或主工作台。
- 不用 harness 取代现有 `agent-final-read-model-v1`。

## 7. 风险与取舍

### 7.1 为什么不只强化测试 harness

继续强化测试 harness 可以提高回归信心，但不能解决 live Agent 的控制流混乱。没有 session tree、branch、review、context event 时，复杂任务仍然只能被解释为一堆 artifacts，而不是一棵可恢复、可复核、可合并的任务树。

测试 harness 是验收工具，不是 Agent 的生产运行模型。

### 7.2 为什么主路径不是 CLI Harness

Pi CLI harness 很成熟，但当前项目是 Swift app + local daemon + Pi SDK-backed Agent Runtime Host。默认 shell out 到全局 `pi` CLI 会引入额外问题：

- provider/model/env 不再由当前 daemon 统一管理。
- session tree 会分裂到外部 CLI 状态。
- Swift read model 很难保持唯一权威。
- public Skill/Extension surface 与 CLI tool surface 容易漂移。

因此 CLI harness 只作为设计参考。实现主路径应在当前 daemon 内构建 SDK Embedded Runtime Harness。

### 7.3 为什么 multi-agent 放到第二阶段

多 agent 不是缺失 session tree 的替代品。没有 invocation/context/verification harness，多 agent 会放大状态合并问题。先把单 Agent 的 branch、review、context event 稳定下来，后续 multi-agent 才能可控。

### 7.4 为什么 reviewer 不导入 mutations

reviewer 的职责是复核，不是生产。让 reviewer 写 product mutations 会让主分支、复核分支和产品 store 形成三方竞争。当前项目已经因为多 final 来源出现过混乱，mutation 也必须遵守同样原则：只有主分支 authoritative final read model 和 product mutation policy 能决定是否导入。

## 8. 验收标准

文档阶段验收：

- 本文明确区分 acceptance harness 与 production runtime harness。
- 本文明确引用 Pi-agent 的 Invocation、Context、Verification 三层经验。
- 本文明确选择 SDK Embedded Runtime Harness 为当前项目主路径。
- 本文明确不迁移办公/会议/飞书能力，不默认 shell out 到全局 `pi` CLI。
- `wiki/PROJECT_WIKI.md` 登记本架构文档、issue 和 next TODO。

后续代码阶段验收：

- 同一 run/session 可形成 session tree 与 branch lineage。
- reviewer branch 不覆盖主 final read model，不导入 mutations。
- context compaction 后仍保留路径、证据、gate、失败原因。
- Swift 不展示 stream blob、SSE final fallback 或重复 session final。
- 测试 harness 继续跑 `npm test`、`swift build`、`swift test`、UI smoke。

## 9. 结论

当前 harness 做对了验收层，但还没有成为生产 Agent 的控制面。下一阶段的核心不是更多测试命令，而是把 Agent 的调用、上下文和复核建模成稳定 runtime harness。

推荐路线是：

```text
保留现有测试 harness
  -> 在 daemon 内新增 SDK Embedded Runtime Harness
  -> 先建 session tree / branch lineage / context event / review branch
  -> 再让 Swift 展示 branch/read model
  -> 最后引入 multi-agent orchestration
```

这个顺序可以把当前已经解决的 final-output、CMC gate、product mutation policy 继续固定住，同时为真正复杂的 Agent 任务提供可恢复、可复核、可合并的运行时骨架。
