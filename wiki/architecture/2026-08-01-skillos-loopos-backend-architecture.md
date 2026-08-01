# SkillOS / LoopOS 后端目标架构（Agent 层）

- 日期：2026-08-01
- 状态：**目标架构（2026-08-01 交叉审查修订版）**，作为后续开发的权威依据
- 输入文档：
  - `wiki/architecture/2026-08-01-frontend-driven-agent-architecture-gap-inventory.md`
  - `wiki/architecture/2026-08-01-agent-architecture-adjustment-review.md`
- 生态基线：PI SDK 0.83.0、`@agwab/pi-subagent` 0.4.8、`@agwab/pi-workflow` 0.10.1
- 已确认决策：
  1. Context Capsule 采用 **condensation-as-event**，但正常 TTL、隐私删除和 retention policy 仍然生效；
  2. 全局容量采用 **有界持久排队**，每用户最多 3 个尚未开始的等待任务；第 4 个请求不接单，前端保留输入并给出恢复动作；
  3. Product API 接单成功后的 Turn 是 durable background work；浏览器刷新、HTTP/SSE 断线只结束观察连接，不取消任务；
  4. 所有受治理执行都必须取得 Capacity Lease，Execution Broker 是最终强制闸门，任何 Product caller 不得绕过；
  5. Loop Run 生命周期状态在本轮转为 event-sourced；Attempt、Effect Receipt、Checkpoint 和 Artifact 继续由各自账本负责；
  6. PI SDK 0.83.0 升级已完成；`pi-subagent` 的 `inline` backend 明确禁用，只允许 `headless`。

---

## 1. 架构总览

```text
Web / Mobile
   │  POST command（幂等）
   ▼
Workbench Product API
   ├─ principal / permission / ETag / command 校验
   ├─ 原子持久化 command + Turn + waiting-slot reservation
   ├─ 202 Accepted：返回 commandId / turnId / 状态
   └─ read model / SSE 仅负责观察；断线不取消
   │
Product Session Services（各管各的产品语义）
   ├─ MainAgentSessionService      （user × workspace）
   ├─ ModuleAgentSessionService    （user × workspace × object × branch）
   ├─ CreationSessionService       （Draft 前、临时、TTL）
   └─ ProposalService              （staged proposal 生命周期）
   │
ConversationTurnCoordinator（共享 application service）
   ├─ per-session FIFO / atomic claim / recover
   ├─ sessionEpoch + turnId/turnFence
   ├─ explicit cancel / timeout / permission-revocation
   ├─ Context Capsule 组装
   └─ trace lineage
   │
AdmissionController（容量权威）
   ├─ 两阶段等待：waiting_session_turn / waiting_capacity
   ├─ per-user / workspace / backend / provider 容量
   ├─ Capacity Lease：TTL / heartbeat / fence / recover
   └─ eligible FIFO + per-user fairness
   │
ExecutionBroker（执行强制闸门）
   ├─ 必须验证 Capacity Lease + Capability Lease + Fence + Budget
   ├─ invocation / attempt / late-result rejection
   ├─ cancel / timeout / reportChild / cancelAll
   └─ deterministic_skill ｜ model_call ｜ bounded_agent ｜ agent_orchestrator
   │
Agent Runtime（PI SDK 0.83）
   ├─ 容器 Worker：pi-subagent headless + toolResultBudget
   ├─ 编排：pi-workflow（节点内确定性 stage 图）
   ├─ PI compaction：只服务单次 Worker 上下文
   └─ ModelRuntime：统一 model + auth 门面
```

### 1.1 分工原则

| 层 | 唯一负责 | 明确不负责 |
|---|---|---|
| Agent Definition | 身份、capability 天花板、输出 Schema | 排队和调度 |
| Product Session Service | transcript、TTL、Patch/Proposal 产品语义 | 全局容量 |
| ConversationTurnCoordinator | Session 内顺序、claim、settle、恢复、上下文与 Turn fence | prompt 内容和产品对象规则 |
| AdmissionController | 等待槽、容量策略、公平调度、Capacity Lease | 模型与工具执行细节 |
| ExecutionBroker | 强制验证 lease/fence/budget，创建 invocation/attempt 并调度执行 | 产品 Session 和 Canonical Draft |
| PI Runtime | 单次 agentic loop、Tool、compaction、sub-agent 内部执行 | 产品状态权威 |

### 1.2 两种 Lease 不得混用

- **Capacity Lease**：回答“当前是否还有机器、Provider 或用户并发容量”；由 AdmissionController 签发，有 TTL、heartbeat 和资源维度。
- **Capability Lease**：回答“这个 Worker 允许做什么”；由既有 Execution/Security 路径签发，包含 Tool、Resource、Connection 和权限上限。
- Broker dispatch 时两者都要验证。子 Worker 的 Capacity Lease 单独计数，Capability Lease 必须是父级子集。

## 2. 核心机制

### 2.1 Durable Command 与 ConversationTurnCoordinator

Product API 在返回成功前，必须用 Mongo transaction 原子完成：

1. 校验幂等键、principal、Session 状态和 waiting-slot 上限；
2. 写入 Product Command；
3. 写入 queued Turn；
4. 注册 Admission waiting slot；
5. 返回 `202 Accepted` 与稳定的 `commandId / turnId`。

接单之后，HTTP 请求、SSE 或浏览器页面的生命周期不再拥有 Turn：

- HTTP/SSE 断开仅 detach observer；后台继续执行；
- 显式 Cancel API、权限撤销、超时或 Session end 才进入取消链；
- 刷新后通过 read model / event cursor 恢复；
- 服务重启后 Coordinator 扫描 queued/active Turn 并恢复调度；
- 幂等重放返回同一个 command/turn，不产生第二份工作。

Coordinator 泛化既有 Main Agent 原子原语：

- **claim**：只有 Session 无 active Turn 时，最早 queued Turn 才能成为 active；
- **settle fence**：写回必须匹配 `sessionEpoch + activeTurnId + turnFence + status`；
- **Turn 内并行**：一个 active Turn 可以并行启动多个 Worker；Session 内多个 Turn 仍严格 FIFO；
- **显式 steer**：只影响当前 active Turn，不创建并发 Turn；普通新消息进入 FIFO。

Turn claim 时 pin `modelProfileId + profileRevision`。无声明 fallback；若策略允许 fallback，必须生成可见事件并重新校验 capability。

### 2.2 两阶段有界排队与 Admission

等待有两个逻辑阶段，但共享一个 Product-owned admission 记录与计数口径：

- `waiting_session_turn`：前一个 Turn 尚未结束；
- `waiting_capacity`：已经是 Session 队首，但等待 user/workspace/backend/provider 容量。

**接单上限**：同一用户跨 Session 最多保留 3 个“尚未开始执行”的 Turn；running Turn 不计入该等待数。达到上限时：

- Product API 不创建新的 Turn 或 admission waiting record；
- 幂等命令可以记录/返回同一拒绝结果，但不得变成待执行任务；
- 返回 `admission_queue_full`、当前等待项安全摘要与 cancel/retry recovery action；
- 前端保留尚未提交的输入，不合并、不覆盖、不静默丢弃。

**容量维度与首版默认值**：

| 维度 | 默认值 | 来源 |
|---|---:|---|
| per-user running | 4 | Product 配置 |
| per-workspace running | 8 | Product 配置 |
| per-container backend | 单机资源探测后的配置值，初始 4 | Runtime 配置 |
| per-provider/profile | Model Catalog 明确配置；缺失时采用保守服务默认 | Catalog / Server 配置 |

Admission 调度采用 **eligible FIFO + per-user round-robin**：同一用户内部保持创建顺序；暂时不满足某个容量维度的队首不会阻塞其他有资格的用户。`position` 是当前 eligible rank，`estimatedWaitSeconds` 是带 `approximate=true` 的粗略估计，不能承诺准确时间。

Capacity Lease 必须支持原子多维占用、TTL、heartbeat、显式 release、崩溃回收和 fence。Session cancel/end、权限撤销或 turnFence 变化会使 waiting record 与 lease 失效。

### 2.3 Broker 的 Admission 强制边界

Admission 不能只依赖 Coordinator 自觉调用。现有 WorkflowRunner、AgentTurnRunner、Builder proposal、Skill validation 和 orchestrator child 都可能触发 Broker，因此：

- 所有用户或 Workflow 触发的 `model_call / deterministic_skill / bounded_agent / agent_orchestrator` 请求都必须带 `capacityLeaseId`；
- Broker 在创建/启动 attempt 前通过 Admission lease authorizer 验证 owner、workspace、backend/provider、TTL、fence 和预算维度；
- 缺失、过期或不匹配统一失败，禁止 silent bypass；
- 动态 child 创建时，由 Product-owned child dispatch adapter 先申请独立 Capacity Lease，再调用 Broker `reportChild`；
- 非生成式 readiness/probe 可走受治理的 Connection/Provider Driver，不伪装为模型执行；
- Realtime 媒体平面是唯一不走 Broker 的执行面，但仍必须走 Admission、计费和侧带调用校验。

Broker 知道“lease 是否有效”，但不知道公平策略、队列顺序或产品 Session 语义，因此不会演化成第二个 AdmissionController。

### 2.4 Context Capsule：condensation-as-event

三层上下文保持分离：

| 层 | Owner | 生命周期 | 用途 |
|---|---|---|---|
| Durable Memory | Product Memory Service | 跨 Session，受审批/TTL/删除治理 | 可检索长期事实 |
| Session Context Capsule | Session transcript 的派生 summary event | 随 Session，继承 Session retention | 重建目标、约束、决定、进度和风险 |
| PI compaction | 单次 PI invocation/attempt | Worker 内部 | 控制本次 agentic loop token |

`session_context_summary` 与消息使用同一 sequence 空间，至少包含：

```text
schemaVersion / coversFromSequence / coversUpToSequence / sourceHash
goal / constraints / progress / keyDecisions / nextSteps / criticalContext
artifactRefs / createdAtTurnId
summaryPromptVersion / modelProfileId / modelProfileRevision / createdAt
```

规则：

- condensation 本身不删除 transcript；原消息仍服从 Session TTL、用户删除、合规清除和 retention policy；
- 模型输入使用最近有效 summary + 其后消息 + 有权限的 artifact refs；
- summary 被标记为 derived/untrusted context，不得覆盖系统指令或权限；
- 阈值依据当前 pinned model revision 的 context limit 计算，默认使用有效窗口 80%；
- summary invocation 通过 Broker，并标记 `maintenanceKind=context_condensation`，不参与自身的再次触发；
- `(sessionId, coversUpToSequence, summaryPromptVersion)` 唯一，失败采用可观测 backoff；
- 任意 Turn 的 effective context 可以通过 summary provenance 与后续 transcript 重建；
- 原始 transcript 和 summary 不自动写入 Durable Memory。

同时修复长 Session 查询：Mongo 读取最新 N 条时倒序 limit，再恢复正序。附件上下文路径必须复用同一正确查询结果；保留最终 token/message 截断是预期行为，不另造第二套历史查询。

### 2.5 Sub-agent 并发、上下文与 Artifact

- Turn 内 fan-out 默认并发 4；每个 Worker 单独取得 Capacity Lease；
- orchestrator 嵌套深度最大 2，bounded_agent 不允许继续派子；
- 单 Session 累计 child spawn 上限 100；Definition 还需声明 `allowedChildren`；
- 启用 `toolResultBudget`；父 Turn 只接收 Schema 校验后的最终结构化结果与 artifactRef；
- Worker transcript 默认按敏感 Artifact 管理：继承 invocation owner/workspace/object scope，Object Store 加密，短 TTL，访问审计，不进入普通日志或 Durable Memory；
- `agent_settled` 是 PI attempt 完全落定的运行时信号；Product 最终状态仍需通过 Broker fence settle。

### 2.6 Loop Run 生命周期事件化

现有 `run_events` 是产品安全的时间线投影，字段不足以重建内部 Run，不得直接宣布为 event source。目标结构：

```text
run_state_events   ← Run 生命周期唯一权威（内部、append-only）
        │ fold
        ├─ runs     ← 当前状态查询投影
        ├─ run_events ← 产品安全时间线投影
        └─ checkpoints ← fold 加速 snapshot

execution_attempts / effect_receipts / artifacts
        ↑ 由 run_state_events 使用稳定 ID 引用，继续各自作为事实账本
```

`run_state_events` 至少包含 `runId / sequence / eventId / transitionType / priorStateHash / payload / attemptId? / effectReceiptId? / commandId / occurredAt / schemaVersion`。事件化范围限定为 Run 生命周期状态、当前节点、review/block/terminal 迁移；Provider 请求、外部副作用明细和产物正文不复制进事件 payload。

迁移分三步：

1. shadow-write：旧 `runs` 仍权威，同时写内部事件并持续 fold 对账；
2. new-run cutover：新建 V2 Run 设置 `stateModelVersion=2`，事件流权威，`runs` 仅为投影；
3. legacy cutover：暂停领取、对 active legacy Run 写入带 source hash 的 `run_state_imported` 事件，在 transaction 中翻转版本后恢复；已完成 V1 Run 保持只读兼容。

### 2.7 副作用、幂等和取消

Event sourcing 不等于外部副作用 exactly-once。每个副作用步骤必须具备：

- 稳定 `effectId / idempotencyKey`；
- dispatch 前 intent receipt；
- Driver 返回的外部 receipt/reference；
- 可查询时执行 reconciliation；
- Provider 不支持幂等且结果不明时进入 `effect_outcome_unknown`，等待人工处理，禁止盲重试。

取消只能阻止尚未 dispatch 的工作或请求支持取消的 Driver 停止；不能声称撤销已经发生的外部效果。纯计算/LLM attempt 可以强制中断，外部副作用使用协作式取消与 reconciliation。

### 2.8 Realtime 因果与容量治理

- WebRTC 媒体面保持专用 adapter；浏览器可处理受治理的 SDP/媒体协议，但不持有 Provider credential、业务 Provider payload 或 Tool secret；
- Realtime call 建立时申请 user + provider Capacity Lease；断开或 heartbeat 超时结束 call 并释放 lease；
- 已经持久化的文字 Turn、已提交的 sideband Patch intent 不因媒体断线而取消；
- 不共用单一 generation：使用 `sessionEpoch`、文字 `turnId/turnFence`、`realtimeCallGeneration` 和共享 `causalSequence/formRevision`；
- sideband Patch intent 进入 Coordinator 的同一因果队列，写回必须匹配 formRevision 和 Session fence；
- Realtime tool/model sideband 调用必须验证 call lease、Capability Lease 和 causal fence。

### 2.9 Trace lineage

统一关联链：

```text
productCommandId
  → sessionId / turnId / turnFence
  → admissionId / capacityLeaseId
  → invocationId / attemptId
  → providerCallId / toolCallId / realtimeCallId
  → proposalId / effectReceiptId / artifactId
```

`productCommandId` 进入公共契约和所有持久化事件；幂等重放复用原 lineage。公开 read model 只返回安全引用。OTel exporter 可以消费这些事件，但不成为产品事件真相源。

## 3. Session 类型归位

| 类型 | 顺序与 Fence | 执行路径 | 产出 |
|---|---|---|---|
| MainAgentSession | Coordinator FIFO + turnFence | Admission → Broker → bounded_agent/model_call | 文本、Tool 结果引用、Artifact |
| ModuleAgentSession | user × workspace × object × branch 独立 FIFO | Admission → Broker → bounded_agent | 仅 Proposal |
| SkillCreationSession（文字） | durable Turn + FIFO | Admission → Broker → model_call | Form Patch intent |
| SkillCreationSession（Realtime） | callGeneration + causalSequence | Realtime adapter；sideband 进入 Coordinator | Form Patch intent |
| Builder staged proposal | Proposal revision/ETag | Admission → Broker → bounded_agent | staged proposal |
| WorkerSession | invocation × attempt | Broker → PI sandbox | 结构化结果 + 受治理 transcript Artifact |
| Loop Run | WorkflowRunner + run_state_events | Admission → Broker → step backend | Run 投影、Effect Receipt、Artifact |

## 4. 不变边界

- Product Session、WorkflowRunner 和 Product Store 继续拥有业务状态；PI Session 永不成为产品权威；
- Browser 不持有 credential、宿主路径、Tool secret 或可重放业务 Provider payload；
- ExecutionBroker 不拥有 Session、Canonical Draft、公平策略或等待队列；
- Module/Creation Agent 只能产生 Patch/Proposal，Canonical 修改仍需 Product API 校验和用户确认；
- Durable Memory、Session Capsule、PI compaction 永不合流；
- 每位协作者拥有独立 Module Session、transcript、权限与临时 branch；
- 不建立绕过 Product Controller 的通用 Worker HTTP API；
- 本轮保持单机，不引入外部 MQ、多机 admission 或设备舰队。

## 5. 必须通过的验证矩阵

| 风险 | 真实证据 |
|---|---|
| 接单与断线 | Product API 返回 202 后断开 HTTP/SSE，Turn 后台完成；刷新以 cursor 恢复；显式取消才终止 |
| 幂等 | 相同 command idempotency key 只产生一个 Turn、一个 lineage |
| Session FIFO | 双客户端同 Session 同时发送，只有一个 active Turn；Turn 内 Worker 可并行 |
| 有界排队 | 每用户最多 3 个 waiting；第 4 个不落 Turn；输入由前端保留；取消后可重试 |
| Admission 无旁路 | Main、Creation、Workflow、Builder、Skill validation、dynamic child 缺 Capacity Lease 全部被 Broker 拒绝 |
| Lease 恢复 | 多维原子占用、heartbeat、TTL、崩溃回收、过期 fence 拒绝 |
| 长上下文 | 5001/10000 条消息仍包含最新 Turn；summary provenance 可重建；TTL/删除仍生效 |
| Capsule 递归 | condensation invocation 不触发自身；唯一键与 backoff 生效 |
| Sub-agent | fan-out=4、depth=2、spawn=100、child 权限子集、父取消级联、transcript 不进日志/Memory |
| Loop 恢复 | V2 事件 fold 重建与 runs 投影一致；shadow 对账；legacy cutover 可回滚 |
| 外部副作用 | idempotency/receipt/reconciliation；unknown outcome 不盲重试 |
| Realtime | 文字 Turn 不被媒体断线取消；callGeneration 与 turnFence 不互相误杀；Patch 因果有序 |
| Trace | 从 commandId 可追踪到 admission、attempt、effect/proposal/artifact |
| PI backend | 任何 inline 配置在启动/dispatch 时明确失败；headless 路径通过 |

## 6. 明确不做

- 不引入 tmux、Temporal、Inngest 或外部消息队列；
- 不切换 oh-my-pi、Kimi/K3 或其他第二套 Agent 真相源；
- 不做全站 actor/event-sourcing；仅 Loop Run 生命周期事件化；
- 不启用 `pi-subagent inline`；
- 不在本轮实现远程设备、舰队、公网中继或向量检索；
- 不自动应用 Proposal，不共享不同用户 transcript。

---

本文件是本轮 Agent 后端目标架构权威依据。任务分解、迁移顺序与验收门见
`wiki/architecture/2026-08-01-skillos-loopos-backend-implementation-plan.md`。
