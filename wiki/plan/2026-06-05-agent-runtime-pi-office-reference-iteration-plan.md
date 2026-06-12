# Agent Runtime PI 办公参考迭代计划

- 日期：2026-06-05
- 范围：Web3 Agent Runtime Host、CMC evidence contract、final read model、Swift Agent 工作台 finalization
- 参考对象：`assignment agent_副本/meeting-agent-pi-package`
- 状态：实施计划

## 0. 摘要

本轮只把真实运行中的办公/会议 PI agent 包作为架构参考，不把 office、meeting、Feishu、calendar、document 或 notification 能力合并进当前 Web3 项目。

实施顺序固定为：

1. 先落地 wiki architecture 和 plan。
2. 增加后端 dynamic loop artifacts，并收紧 CMC evidence gates。
3. 保持 `agent-final-read-model-v1` 为唯一权威最终答案。
4. 将 Agent run completion/finalization 编排从 `DashboardViewModel` 移出。
5. 跑后端、Swift 和 UI smoke 回归。

Docker bounded worker 本轮只作为未来路线记录。

## 1. 后端 Runtime 工作

### 1.1 决策归属

固化 runtime 不变量：

- Planner、Model Router、Evidence/QA Gate、Policy Gate 和 Output Guard 拥有决策权。
- Capability Registry、tool runner、provider、normalizer 和 artifact writer 不决定业务结果。
- Swift 只渲染 read models 并提交用户选择，不决定最终答案优先级。

### 1.2 Dynamic Loop Artifacts

在当前 control plane/run directory 中扩展内部 loop artifacts：

```text
planner-state.json
task-graph.json
agent-loop.ndjson
planner-decisions.ndjson
observations/{observationID}.json
step-results/{stepID}.json
```

最低行为：

- control plane 创建后写入初始 planner state。
- 将当前 tool execution pass 绑定到一个 root subtask。
- 每个 tool call 记录为一组 action/observation pair。
- 将最终 QA/output guard 决策记录为 terminal loop step。
- 保持 `planner-envelope.json`、`tool-calls.json`、`tool-observations.json` 和 `run-manifest.json` 兼容。

### 1.3 CMC Evidence Contract

稳定 `agent-tool-observations-v1` 的 CMC split fields：

```text
transportStatus
researchEvidenceStatus
readableEvidenceCount
emptyEvidenceReason
priceSnapshotStatus
allowResearchConclusion
allowConcretePrices
```

规则：

- MCP transport 成功但没有 `readableEvidence` 且没有 `assets` 时，状态为 `degraded_empty_evidence`。
- empty evidence 禁止 live research claim。
- 没有价格的 research evidence 可以支撑定性结论。
- concrete prices 必须来自 usable price snapshot。
- tool-selection diagnostic 必须记录 macro/thesis prompt 是否走 macro/regime 路径。

### 1.4 Final Output 与 Mutations

保留 `agent-final-read-model-v1` 作为 daemon-owned final answer。

最终输出规则：

- 存在 Skill Hub readable evidence 时，优先使用该可读证据。
- 没有 readable evidence 或 price snapshot 时，输出：`CMC Skill Hub transport 成功，但本轮未返回可解析研究证据或价格快照。`
- 如果 market output guard rewrite 了答案，写入 `outputGuardStatus=rewritten`。

Mutation policy 规则：

- empty evidence 或 market guard rewrite 时，`productMutationPolicy.status=discarded`。
- discarded run 不把 tasks、watchlist items、crystals、proposals、memory 或 handoffs 导入主工作台。

### 1.5 Context Plane Retrieval Pack

后续实现新增第一层 deterministic retrieval read model，作为更完整 replan/resume/branch 的前置。

新增 artifacts：

```text
context-index.json
retrieval-results.json
context-pack.json
source-trust-report.json
memory-compression.json
context-chunks/{chunkID}.json
```

规则：

- Context indexing 本轮保持 host-only 和 deterministic，不引入外部 embedding 服务。
- raw private transcripts、raw request bodies、secrets、provider prompts 不进入 context artifacts。
- CMC normalized evidence 和 market snapshot 需要暴露 provider、freshness、asset count、readable evidence count、missing inputs 等独立 metadata。
- retrieval ranking 使用 prompt terms、已选 Skill/Extension、freshness、source trust 和领域 boost。
- `context-pack.json` 是后续 planner replan/resume/branch 消费的 bounded pack。

## 2. Swift 工作

### 2.1 Completion / Finalization Coordinator

保留现有 `AgentRunStreamCoordinator` 和 `AgentRunReadModelStore`，新增独立 completion/finalization coordinator，负责：

- terminal SSE event handling；
- 在 bounded interval 内 retry 读取 final read model；
- completion 之后刷新 daemon sessions/tasks；
- 只有在权威 final read model 存在后才调用 product mutation import；
- 将 finalization status 回传给 `DashboardViewModel`。

`DashboardViewModel` 只保留页面级状态和选择逻辑。

### 2.2 Final Render Contract

`AgentWorkspaceStateAdapter` 必须继续只把 `AgentFinalReadModel.finalText` 渲染为最终答案。

final read model 缺失时：

- 只显示短等待/错误 notice；
- 不把 stream blob 显示为 final output；
- 不显示 `run.completed.finalText`；
- 不从 `final-output.md` 重建答案；
- final read model 存在后，不重复显示 session assistant message。

### 2.3 Diagnostics

Inspector/debug strip 只保留紧凑诊断标签：

```text
Evidence empty
Prices blocked
Final rewritten
Mutations discarded
```

这些标签是 UI/debug contract，文档中保留英文原值。

## 3. 测试计划

后端：

- MCP transport ok 但 `assets=[]` 且 `readableEvidence=[]`：run degraded，final 明确证据为空，`productMutationPolicy=discarded`。
- Skill Hub 有 research evidence 但没有 prices：`allowResearchConclusion=true`、`allowConcretePrices=false`，不触发 market rewrite。
- price snapshot 存在：`allowConcretePrices=true`。
- macro/ETF/thesis prompt 命中 macro/regime tool path。
- output guard rewrite 后，`AgentFinalReadModel.outputGuardStatus=rewritten`。
- daemon run 必须写出 `context-index.json`、`retrieval-results.json`、`context-pack.json`、`source-trust-report.json`、`memory-compression.json` 和至少一个 `context-chunks/{chunkID}.json`。

Swift：

- completed run 只渲染 `AgentFinalReadModel.finalText`。
- final read model 缺失时，不显示 stream fallback 或 session duplicate。
- discarded mutation policy 不改变 tasks/watchlist/crystals/proposals/memory/handoffs。
- diagnostics 能显示 empty evidence、blocked prices、rewritten final、discarded mutations。

回归命令：

```text
cd agent-runtime && npm test
swift build
swift test
swift run WeChatIntelligenceRadar --ui-smoke-check
```

## 4. 假设

- `assignment agent_副本` 只作为只读架构参考。
- 不导入 office/meeting/Feishu 能力。
- Docker bounded worker 本轮只进入路线图。
- 保留现有未提交改动；实施只触碰本计划覆盖文件。
