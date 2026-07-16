# 统一 Agent 产品北极星架构

- 日期：2026-06-06
- 范围：当前 Web3 Agent、`assignment agent_副本/meeting-agent-pi-package`、未来统一 App Agent 工作台
- 状态：三阶段重构的目标架构，代码执行前的当前有效方向

## 0. 摘要

目标不是继续维护两个 Agent，也不是只把 `assignment agent_副本` 当参考。用户已确认长期方向是完整产品合并：当前 Web3 投研 Agent 与 assignment agent 的办公/会议 Agent 最终要收敛成一个统一 Agent 产品。

合并顺序必须固定：

```text
Phase 1: 先构建底层 production runtime harness
Phase 2: 再合并 Web3 Agent 与 assignment agent 能力，形成统一 Agent
Phase 3: 最后用 Product Design 工作流重构 App 前端
```

这不是三条并行路线。Phase 1 是强门禁；没有 session tree、branch lineage、context event、review branch 和 final read model authority，就不能安全接入 Office/Meeting/Feishu 能力，也不能重构前端。

## 1. 产品目标

统一 Agent 的产品目标是一个本地优先、证据优先、可恢复、可复核的个人 Agent 工作台，覆盖三类任务：

- Web3 / 投研：CMC、Token、链上、微信情报、观察列表、任务、情报卡、交接包。
- Office / 会议：会议纪要、文档生成、文档修订、文件上下文、PRD/技术方案/运营方案、行动项。
- Channel / IM：当前 WeChat 本地/fixture/export，未来 Feishu/WeChat/本地文件入口进入同一 Agent 运行时。

统一后的产品不应该是两个 tab 下两套 agent。它应该是同一个 runtime、同一套 capability package、同一套 context/evidence/QA/policy/final read model，只是能力包和任务 profile 不同。

## 2. 核心原则

### 2.1 一个 Runtime，多域 Capability

统一架构采用：

```text
One Runtime Harness
  -> Multi-domain Capability Packages
  -> Domain Read Models
  -> One App Workspace
```

Web3、Office、Meeting、Feishu、WeChat、File、Memory 都是 capability package。它们不能各自带一套 orchestrator、final output precedence 或 product mutation path。

### 2.2 Harness 先于能力合并

assignment agent 的 Feishu bridge、document worker、source-context、Docker worker、Hermes sidecar 都比当前 Web3 Agent 更接近真实办公生产场景。但这些能力进入当前产品前，必须先有 production harness：

- session tree 表达主分支、follow-up、retry、review、merge。
- branch lineage 表达能力包输出如何进入或拒绝主分支。
- context event 表达每次模型调用前的上下文裁剪与注入。
- compaction summary 保留路径、证据、gate、失败原因。
- review branch 独立复核，不能直接写产品 store。
- final read model 仍然是唯一最终展示来源。

### 2.3 决策层必须统一

统一 Agent 的决策权集中在以下组件：

- Planner：任务拆分、能力选择、下一步动作、停止条件、缺失输入。
- Model Router：模型/provider 路由、fallback、blocked 记录。
- Prompt Registry：文档/输出类型到 prompt contract 的选择和渲染。
- Domain Worker：在被 Planner 授权的子任务内处理文档章节、研究步骤或多源 synthesis 的局部执行策略。
- Evidence / QA Gate：证据是否可用、覆盖是否足够、结果是否可交付。
- Policy Gate：外部发布、通知、写私有文件、长期记忆、依赖安装、live channel 动作等边界。
- Output Guard：最终文本是否泄漏内部字段、是否引用无支撑数字、是否需要 rewrite。
- Harness Merge Controller：review branch、retry branch、follow-up branch 是否合入主分支。

没有决策权的组件：

- Capability Registry 只描述能力、readiness、policy metadata。
- Provider transport 只做传输。
- Normalizer 只做 payload -> contract。
- Artifact writer 只写文件。
- Swift view 只消费 read model。
- Channel adapter 只收发和转换。
- Publisher 只在 QA/Policy 允许后执行发布。

## 3. 目标运行时

统一 Agent 的主流程：

```text
User / Channel / File / Scheduled Trigger
  -> Invocation Harness
  -> Context Event
  -> Planner
  -> Capability Package Selection
  -> Model Route / Prompt Registry
  -> Domain Tool or Worker Execution
  -> Normalized Observation
  -> Evidence / QA Gate
  -> Policy Gate
  -> Replan / Branch / Review / Finish
  -> Output Guard
  -> AgentFinalReadModel
  -> ProductMutationPolicy
  -> App Read Models
```

关键点：

- 所有入口进入同一个 Invocation Harness。
- 所有上下文进入同一个 Context Plane。
- 所有最终答案进入同一个 `agent-final-read-model-v1`。
- 所有产品写入受 `productMutationPolicy` 控制。
- 所有外部发布受 Policy Gate 控制。
- 所有复核通过 review branch，而不是主 Agent 自证正确。

## 4. Capability Package 分层

### 4.1 Core Runtime Packages

必须始终存在：

- `runtime-harness`：session tree、branch lineage、invocation ledger、context event、review branch。
- `planner-runtime`：任务拆分和能力选择。
- `model-router`：provider/model route。
- `context-plane`：context pack、source trust、memory compression、compaction。
- `evidence-qa-gate`：证据和交付质量。
- `policy-gate`：动作边界。
- `output-guard`：最终文本安全。
- `runtime-observability`：metrics、decision logs、sanitized trajectory。

### 4.2 Web3 Packages

当前项目已有并继续保留：

- WeChat x onchain intelligence。
- CMC Skill Hub / CMC Market Radar。
- market regime review。
- social-price divergence。
- token/entity/onchain local stores。
- crystal/proposal/memory/handoff product mutations。

这些包必须继续遵守 CMC split gate：

```text
transportStatus != researchEvidenceStatus
allowLiveResearch != allowConcretePrices
empty evidence -> degraded final + discarded mutations
```

### 4.3 Office / Meeting Packages

来自 assignment agent 的目标能力包：

- meeting minutes。
- document generation。
- document revision。
- source context / file context。
- local ASR / media normalization。
- document worker runtime。
- Feishu document review context。
- Feishu agent bridge。
- office memory proposals。

这些包进入统一 Agent 后必须默认受 QA/Policy Gate 控制：

- raw audio 不外发。
- Feishu token、CLI session、tenant/user ids 不进入模型上下文。
- 删除、清空、销毁类动作 blocked。
- customer-visible publish 必须 QA pass + Policy pass。
- Office/Meeting 输出可写本地 read model，但不能绕过 final read model。

### 4.4 Channel Packages

统一 Agent 不应该产生第二套 channel workflow。

Channel adapter 只能提供：

- `im-event-v1`
- `im-attachment-v1`
- `im-reply-v1`
- `publish-target-v1`
- `channel-capability-matrix-v1`

Feishu、WeChat、本地文件入口都必须进入统一 task profile 和 runtime harness。

## 5. Read Model 与 Product Mutation

统一 Agent 的 App 只消费 read model：

```text
AgentFinalReadModel
HarnessSessionTreeReadModel
BranchLineageReadModel
ReviewReadModel
CapabilityPackageReadModel
ContextPackSummary
EvidenceQASummary
PolicyGateSummary
ProductMutationPolicy
```

不同域可以有域 read model，例如：

- `web3-intelligence-read-model-v1`
- `office-document-read-model-v1`
- `meeting-minutes-read-model-v1`
- `channel-reply-read-model-v1`

但这些域 read model 都不能成为最终答案来源。最终展示仍由 `AgentFinalReadModel.finalText` 决定。

Product mutation 统一策略：

- Web3 tasks/watchlist/crystals/proposals/memory/handoffs 只能在 `productMutationPolicy.status=importable` 时导入。
- Office docs/tasks/publish/reply 只能在 QA/Policy 允许后进入 pending publish 或 completed publish read model。
- review branch 不导入 mutations。
- failed/degraded/empty evidence 分支只保留 artifacts，不写主工作台。

## 6. App 产品形态

Phase 3 以后，App 不再是单纯 Web3 terminal，也不应该变成办公套件复制品。目标是统一 Agent 工作台：

- 左侧：工作空间、sessions、tasks、capability packages。
- 主区：Agent thread、branch/review 状态、final answer、domain deliverables。
- 右侧或详情：evidence、context pack、QA/Policy、source trust、artifact lineage。
- 底部或顶部：composer、attachment、context chips、run status。

可见概念：

- 能力包。
- 任务状态。
- session tree。
- review 状态。
- final answer。
- 待确认动作。
- 交付物。

不可见概念：

- raw provider。
- internal tool。
- normalizer。
- worker implementation。
- raw tokens/secrets。
- internal policy implementation。

Product Design 插件只在 Phase 3 启用。进入 Phase 3 时必须先确认 design brief，再 ideate 三个方向，用户选定视觉方向后才能实现。

## 7. 阶段门禁

### Phase 1 Gate

必须满足：

- `harness-session-tree.json` 可表达主分支和 review branch。
- `harness-branch-lineage.json` 可表达 fork/retry/follow-up/review/merge。
- `invocation-ledger.ndjson` 记录调用事件。
- `context-event-log.ndjson` 记录每次模型调用前的上下文选择。
- `compaction-summary.json` 保留关键证据、路径、gate、失败原因。
- `review-read-model.json` 不覆盖主 final，不导入 mutations。

### Phase 2 Gate

必须满足：

- 统一 capability registry 能同时表达 Web3 和 Office/Meeting capability。
- assignment agent 的办公能力只作为统一 runtime capability package 接入，不复制第二套 orchestrator。
- Feishu/office actions 默认受 QA/Policy Gate 和 channel capability matrix 控制。
- assignment agent 目录保持只读参考；迁移代码发生在当前项目。

### Phase 3 Gate

必须满足：

- Product Design `get-context` brief 已确认。
- 已 ideate 三个视觉方向并由用户选择。
- 前端不暴露 internal tools/provider。
- 同一 run 只显示一个最终答案。
- Swift build/test/UI smoke 通过。

## 8. 结论

统一 Agent 的核心不是把两个目录拼起来，而是把两个 Agent 的能力压进一套 runtime harness、capability registry、context/evidence/policy/read model contract。

正确顺序是：

```text
底层 harness 稳定
  -> 多域 capability 合并
  -> App 产品重构
```

跳过 Phase 1 会导致 Phase 2 的办公/会议能力放大现有状态混乱；跳过 Phase 2 直接做 Phase 3 会让前端设计建立在错误的 runtime 模型上。
