# Assignment Agent 能力映射与迁移边界

- 日期：2026-06-06
- 范围：`assignment agent_副本/meeting-agent-pi-package` 到当前 Web3 Agent Runtime 的能力映射
- 状态：Phase 2 统一 Agent 合并前的参考与约束

## 0. 摘要

`assignment agent_副本` 是真实运行的 Pi-agent 办公/会议 Agent。它的价值不只是“多了一些办公工具”，而是已经形成了生产级运行时边界：

- Feishu / file / event 入口与 PI 生成链路分离。
- Planner、Model Router、Prompt Registry、Document Worker、QA Gate、Policy Gate 作为决策层。
- Capability Registry 只描述能力，不做决策。
- source-context / context-offload 让长上下文 pointer-only。
- document worker 只消费 bounded context pack。
- Feishu publisher 只在 QA/Policy 允许后执行。
- Hermes sidecar 只做事后学习建议，不直接改生产 runtime。

Phase 2 的合并目标是把这些能力压入当前统一 Agent runtime，而不是复制 assignment agent 的第二套 handler/orchestrator。

## 1. 映射总览

| Assignment Agent 能力 | 当前项目对应能力 | 迁移策略 | 边界 |
| --- | --- | --- | --- |
| Planner Runtime | `planner-state.json` / `planner-decisions.ndjson` | Phase 2 合并为统一 Planner package | 不复制固定办公 workflow |
| Model Routing | `model-route` / provider route | 统一 Model Router contract | 不静默 fallback，必须记录 route |
| Prompt Registry | 当前缺少正式 registry | 引入为 domain prompt registry | 只决定 prompt contract，不做发布决策 |
| Document Worker | 当前无办公 worker | 作为 Office capability package | Worker 只消费 bounded context pack |
| QA Gate | CMC/evidence/output gate | 合并为 multi-domain Evidence/QA Gate | QA 判断质量，不判断权限 |
| Policy Gate | 当前 policy gate | 合并 action intent 和 channel policy | Policy 判断边界，不生成业务内容 |
| Source Context Runtime | 当前 Context Plane retrieval pack | 合并为 unified context event/source trust | raw transcript/full file pointer-only |
| Context Offload | `memory-compression`/context artifacts | Phase 1 后接入 compaction policy | 不把 raw private payload 写入模型上下文 |
| Feishu Agent Bridge | 当前无 Feishu live package | Phase 2 后作为 channel package | 只在 QA/Policy pass 后 publish/reply |
| File Context | 当前 attachment/image/local artifacts | 合并为 file/source package | unsupported 明确返回，不猜测 |
| Local ASR / Media | 当前无 ASR | Phase 2 optional package | raw audio local-only |
| Docker Worker | 当前 roadmap-only | Phase 2/long-term, not Phase 1 | bounded worker 不持有 token 或发布权 |
| Hermes Sidecar | 当前 local memory/proposals | Phase 2/3 later learning package | 只写 human-review proposal |

## 2. 可迁移能力

### 2.1 Runtime 决策层

可迁移：

- Planner Envelope 的 goal/capability/tool/policy/artifact/stop-condition 结构。
- Model Router 的 route/record/fallback contract。
- Prompt Registry 的 docType -> prompt -> required sections contract。
- QA Gate 与 Policy Gate 分离。
- Runtime observability 对 planner/model/worker/policy/package audit 的记录。

迁移方式：

- 不直接复制 assignment agent 的文件结构。
- 在当前 `agent-runtime/` 下建立统一 capability package 形态。
- 继续让 Swift 只消费 read model。

### 2.2 Source Context / Context Offload

可迁移：

- source records。
- source segments。
- retrieval plan。
- bounded context pack。
- context manifest。
- pointer-only raw transcript/full evidence。

与当前项目对齐：

- 当前已有 `context-index.json`、`retrieval-results.json`、`context-pack.json`、`source-trust-report.json`、`memory-compression.json`。
- Phase 1 先新增 `context-event-log.ndjson` 和 `compaction-summary.json`。
- Phase 2 再吸收 assignment agent 的 `source-context-runtime` 和 `context-offload` 语义。

### 2.3 Document / Office 能力

可迁移：

- `document-prompt-registry.json`
- document generation prompt catalog。
- section-batched document workers。
- document revision overlay。
- title plan。
- QA input / missing sections / repair attempts。

边界：

- Document Worker 不读取 Feishu。
- Feishu adapter 不决定章节结构。
- Publisher 不决定内容质量。
- 删除/清空/销毁类动作 blocked。

### 2.4 Feishu / Channel 能力

可迁移：

- CLI-first Feishu event runner。
- local handler artifact pattern。
- Feishu publish/reply artifact。
- comment/review-context 读取 contract。
- channel capability matrix。

边界：

- Feishu token、tenant/user id、CLI session 不进入模型上下文。
- Auth status 只能返回 redacted summary。
- MCP 不是接收/回复/发布 Feishu 消息的必要路径。
- Feishu 能力必须作为统一 Agent channel package，不成为第二套 Agent。

## 3. 需隔离能力

### 3.1 Docker Bounded Worker

Docker worker 有价值，但不能进入 Phase 1。原因：

- Phase 1 目标是底层 harness，不是执行隔离。
- Worker 没有 session tree / branch lineage 时会放大状态漂移。
- 当前 Web3 runtime 还没有统一 multi-domain capability registry。

Phase 2 或之后采用时必须满足：

- Host 保留 credentials、channel session、publish/reply。
- Worker 只接收 bounded task/context/source metadata。
- Worker 不调用 `lark-cli`，不 publish，不 reply。
- Worker 超时/OOM 返回 blocked/retry-later，不自动退回 Host 长链路。

### 3.2 Hermes Sidecar

Hermes 只做事后学习建议。统一 Agent 早期不能让它自动改 prompt、memory 或 capability registry。

允许：

- 写 sanitized trajectory。
- 写 memory/prompt/eval proposal。
- 人工 review 后进入 backlog。

禁止：

- 自动写长期记忆。
- 自动修改 production prompt。
- 接收 credentials 或 direct write access。

### 3.3 Office Live Publish

Phase 2 可以接入 Feishu/Office 能力包，但 live publish 必须保持强 gate：

- QA pass。
- Policy pass。
- channel permission ready。
- target explicit。
- destructive action blocked。

缺任一条件时，只写 draft/pending read model。

## 4. 暂不接入能力

Phase 1 暂不接入：

- meeting minutes 业务能力。
- Feishu live event runner。
- document worker。
- Docker worker。
- Hermes sidecar。
- local ASR。
- external publish/reply。

Phase 2 初期仍可暂不接入：

- live WeChat send。
- live trading。
- destructive document operations。
- automatic long-term memory persistence。
- remote handler mode。
- raw media external upload。

## 5. Unified Capability Registry 目标

Phase 2 的 unified registry 应同时表达：

```text
core.runtime-harness
core.planner
core.model-router
core.context-plane
core.evidence-qa
core.policy-gate
core.output-guard
web3.cmc-market-radar
web3.wechat-onchain-intelligence
web3.token-onchain-context
office.meeting-minutes
office.document-generation
office.document-revision
office.source-context
office.local-asr
channel.feishu-agent-bridge
channel.wechat-adapter
memory.local-memory
learning.hermes-proposals
```

Registry 只描述：

- capability id/title/description。
- readiness。
- tool intents。
- policy requirements。
- observability fields。
- install state。
- security review。
- default load profile。

Registry 不决定：

- 是否使用能力。
- 是否可发布。
- 是否可写入产品 store。
- 哪个 final 是权威。

## 6. 合并风险

### 6.1 第二套 Orchestrator 风险

如果直接复制 `feishu_agent_task_handler.mjs` 和 `task_execution_runner.mjs` 成当前项目的新主链路，会产生第二套 Agent。必须改为 capability package，由统一 Planner 和 Harness 调用。

### 6.2 Final Output 竞争风险

assignment agent 有 `agent-output.json`、publish/reply artifacts；当前项目有 `agent-final-read-model.json`。合并后最终展示只能认 `AgentFinalReadModel`。Office artifacts 是 domain read model，不是最终答案源。

### 6.3 Policy 语义漂移风险

Office 能力里的 `write_private`、`publish_customer_visible`、`notify_people` 比 Web3 当前本地 artifact 写入风险更高。合并时必须扩展 Policy Gate action intent，不得把 office write 当成本地 product mutation。

### 6.4 Context 泄漏风险

会议 transcript、Feishu doc comments、auth status、tenant/user metadata 比 Web3 fixture 更敏感。必须采用 pointer-only、secret-scan、bounded preview 和 source trust。

## 7. Phase 2 迁移顺序

Phase 2 应按以下顺序执行：

1. 合并 capability registry schema，不启用 office live actions。
2. 引入 Prompt Registry 和 Model Router contract。
3. 对齐 source-context 与当前 Context Plane。
4. 接入 document generation 作为 draft-only capability。
5. 接入 QA/Policy multi-domain action intents。
6. 接入 Feishu bridge dry-run / local artifact mode。
7. 接入 live publish only after explicit QA/Policy/channel readiness gate。
8. 最后评估 Docker worker 和 Hermes sidecar。

## 8. 验收标准

Phase 2 验收必须满足：

- `assignment agent_副本` 目录保持只读参考。
- 当前项目中只有一个 Agent Runtime Host。
- 只有一个 final read model authority。
- 统一 capability registry 能表达 Web3 与 Office/Meeting 能力。
- Office/Feishu 能力默认 blocked/needs_confirmation，除非 QA/Policy/channel readiness pass。
- 文档/会议输出可追溯到 bounded evidence，不暴露 raw transcript 或 secret。
- 所有新增能力通过 harness session tree、branch lineage 和 review branch 记录。
