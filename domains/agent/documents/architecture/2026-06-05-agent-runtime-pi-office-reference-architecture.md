# Agent Runtime PI 办公参考架构

- 日期：2026-06-05
- 范围：当前 Web3 Agent Runtime Host、CMC 证据门禁、最终输出读模型、Swift Agent 工作台编排
- 参考对象：`assignment agent_副本/meeting-agent-pi-package`
- 状态：下一轮实现采用的当前架构方向

## 0. 摘要

本轮只把真实运行中的办公/会议 PI agent 包作为架构参考，不把它的产品能力并入当前 Web3 项目。当前项目不接入会议纪要、飞书发布、办公文档生成、日历任务变更或办公协作工作流。

该参考包的价值在于运行时边界更清晰：

- 决策层显式分离；
- Capability Registry 只描述能力，不执行决策；
- Planner Envelope 可审计，并按场景生成；
- Policy Gate 与 QA Gate 分离；
- 长上下文优先采用 pointer/offload；
- bounded worker 只消费准备好的 context pack，不拥有产品状态。

当前项目已经具备 Pi SDK-backed 本地 daemon、公开 Skill/Extension surface、control/context artifacts、CMC output gate、`agent-final-read-model-v1` 和 Swift read model。下一步不是增加更多前端按钮，而是让 Agent 执行从一次性流程变成可记录的内部循环，收紧证据 contract，并把最终输出决策从 Swift 页面 ViewModel 中移走。

## 1. 非目标

- 不把会议纪要、办公文档写作、飞书文档 review、日历/任务 mutation 或飞书发布并入当前 Web3 app。
- 不把 internal tools、provider、normalizer、worker decision、policy implementation 名称暴露为前端可选项。
- 本轮不新增 Docker bounded worker。Docker 只作为未来长任务、重型任务、多源任务的路线图。
- 不让 Swift 在 SSE final text、`final-output.md`、session assistant message、file-store fallback 之间选择最终答案。最终答案必须来自 daemon read model。

## 2. 决策层不变量

当前 runtime 必须采用参考包的决策归属模式。

有决策权的组件：

- Planner：拆解任务意图，选择下一步动作，记录停止条件和缺失输入。
- Model Router：选择 provider/model route，并记录 fallback 或 blocked 状态。
- Evidence / QA Gate：判断证据是否 usable、missing、stale、empty 或不足以支撑最终综合。
- Policy Gate：判断 private write、持久化、外部发布、live WeChat、交易等动作边界。
- Output Guard：执行最终答案安全检查，并重写不安全或无支撑的最终文本。

没有决策权的组件：

- Capability Registry 只描述可用能力和 readiness。
- Tool runner 只执行已批准的内部工具并记录结果。
- Provider 只负责数据或模型调用传输，不判断证据是否可用。
- Normalizer 只把 provider payload 转成 contract，不在字段之外声明 freshness。
- Artifact writer 只持久化 artifact 和索引，不判断 product import eligibility。
- Swift view 只渲染 read model 和用户选择，不判断 final-output precedence。

## 3. 当前 Web3 Runtime 形态

当前 runtime baseline：

```text
task intent
  -> execution profile
  -> context plane
  -> planner envelope
  -> tool intent plan
  -> policy / approval / model route / QA metadata
  -> one tool execution pass
  -> one synthesis pass
  -> output guard
  -> final read model
```

这条链路可审计，但仍然偏顺序、偏一次性。它还没有持久的内部循环来让 tool observation 驱动 replan。

目标 runtime 形态：

```text
goal
  -> planner state
  -> task graph
  -> plan decision
  -> tool/action execution
  -> normalized observation
  -> evidence/QA evaluation
  -> replan or finish
  -> checkpoint
  -> final read model
```

第一轮实现不需要完整自治的 multi-worker system，但必须写出让循环真实可查的 artifacts：

```text
planner-state.json
task-graph.json
agent-loop.ndjson
planner-decisions.ndjson
observations/{observationID}.json
step-results/{stepID}.json
```

## 4. CMC 证据 Contract

之前的 CMC bug 来自把 provider transport success 当成 evidence success。两者必须长期分离。

必须稳定的 CMC gate 语义：

```text
transportStatus = ok | degraded | failed
researchEvidenceStatus = usable | empty | parse_failed | degraded | not_requested
readableEvidenceCount = integer
emptyEvidenceReason = string | null
priceSnapshotStatus = usable | empty | degraded | not_requested
allowResearchConclusion = boolean
allowConcretePrices = boolean
```

规则：

- `transportStatus=ok` 绝不等于 `researchEvidenceStatus=usable`。
- `mcpProvider` 返回 `assets=[]` 且 `readableEvidence=[]` 时，状态为 `degraded_empty_evidence`。
- CMC 证据为空时，用户文案不能写“已读取实时研究证据”。
- research evidence 可以在没有具体价格时支撑定性结论。
- concrete prices 必须来自 usable price snapshot，不能只依赖 fresh research transport。

最终文本行为：

- 如果存在 readable evidence，最终输出优先使用 Skill Hub 返回的可读摘录。
- 如果没有 readable evidence 或 price snapshot，最终输出必须明确说明：`CMC Skill Hub transport 成功，但本轮未返回可解析研究证据或价格快照。`
- 如果 concrete prices 被 blocked，最终输出可以讨论定性证据，但不能引用价格、关键价位、支撑阻力、进出场区间或交易触发数字。

## 5. Final Read Model Contract

`agent-final-read-model-v1` 是唯一权威最终输出来源。

必要行为：

- daemon 在 output guard 和 mutation policy 决策之后写入 `agent-final-read-model.json`。
- SSE `run.completed.finalText` 只作为实时通知。
- session assistant message 只镜像 final read model，不是独立最终来源。
- Swift 渲染路径在 final read model 可用时只显示 `AgentFinalReadModel.finalText`。
- 如果 read model 缺失，Swift 只显示短等待/错误状态，不从 stream delta 或文件重建最终输出。

必要字段：

```text
runID
taskID
status
finalText
finalTextSource
outputGuardStatus
outputGuardReason
cmcGateSummary
productMutationPolicy
generatedAt
artifactPath
```

## 6. Product Mutation Policy

只有 run 产出了 usable evidence，并且最终答案没有因为市场证据不足被 rewrite，product mutations 才允许导入。

丢弃条件：

- `researchEvidenceStatus=empty` 且 `priceSnapshotStatus!=usable`。
- `reason=degraded_empty_evidence`。
- `outputGuard.status=rewritten`，且原因是 market evidence insufficient。

被丢弃的 artifacts 如果已经写入，仍可作为 run artifacts 检查，但不能进入主工作台的 tasks、watchlist、crystals、proposals、memory 或 handoffs store。

## 7. Swift 耦合边界

当前 Swift state 已经部分拆分，但 `DashboardViewModel` 仍承担过多 Agent runtime 编排职责：

- active SSE subscription state；
- terminal event handling；
- final read model retry；
- completion 之后的 session/task refresh；
- product mutation import timing；
- page selection 与 runtime terminal data。

目标边界：

- `AgentRunStreamCoordinator` 负责缓冲 SSE 并识别 terminal event。
- `AgentRunReadModelStore` 负责读取 run artifacts。
- completion/finalization coordinator 负责 retry、final read model 检测、session/task refresh 和 mutation import 决策。
- `RuntimeBackend` 只在 `productMutationPolicy.status=importable` 时导入 mutations。
- `DashboardViewModel` 只应用返回的 read models 和页面状态，不判断 final precedence 或 mutation eligibility。

## 8. Docker 路线图

办公参考包有 Host + local Docker bounded worker 切分。这个边界对未来重型任务有价值，但不是本轮实现范围。

未来如果采用 Docker 边界：

- Host 保留 provider credentials、app sessions、本地私有数据访问、发布能力和高权限工具。
- Docker worker 只接收 bounded context pack，并写回 bounded result artifacts。
- Docker worker 不能接收 WeChat live session、交易凭证、飞书 token、raw private media 或直接 app mutation 权限。

在未来专项之前，当前 Web3 runtime 保持 host-only。

## 9. 验收标准

本轮架构验收标准：

- Wiki 记录该参考方向和非目标。
- 后端写入 loop artifacts，同时不改变公开 Skill/Extension selection。
- CMC evidence/price split 在 `tool-observations.json` 和 `agent-final-read-model.json` 中保持稳定。
- Skill Hub empty evidence 会产生 degraded final answer 和 discarded product mutation policy。
- Swift 每个 run 只显示一个最终答案，并且来源是 `AgentFinalReadModel`。
- Docker worker 只保留在文档路线图中。

## 10. Context Plane 迭代

2026-06-05 的后续实现，在 loop artifacts 之上补了第一层 host-only retrieval read model。

新增 artifacts：

```text
context-index.json
retrieval-results.json
context-pack.json
source-trust-report.json
memory-compression.json
context-chunks/{chunkID}.json
```

行为：

- Context Plane 仍保持本地、确定性实现；不引入外部 embedding 服务或 Docker worker。
- Runtime artifacts 只写入有界 preview 和 metadata，不写入 raw private transcript dump。
- CMC normalized evidence 和 latest market snapshot 会提取领域 metadata，例如 provider、freshness、asset count、readable evidence count、missing inputs 和 expiry。
- Retrieval ranking 使用 prompt terms、Skill/Extension hints、freshness、source trust score 和领域 boost。
- `context-pack.json` 是任务级 evidence pack，供后续 planner/replan/resume 逻辑消费。
- `source-trust-report.json` 记录某个 source 为什么被信任、标记为 stale、degraded、empty 或 local-only。

当前限制：

- Retrieval 目前是 deterministic scoring，不是 semantic embedding。
- Per-chunk artifacts 只是内部 read models；前端仍显示紧凑 run summaries。
- 本轮为 replan/resume/branch 准备基础，但尚未实现 autonomous branching。
