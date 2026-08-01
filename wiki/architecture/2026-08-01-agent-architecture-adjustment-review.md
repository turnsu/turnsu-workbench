# Agent 架构调整分析：对《前端驱动下的 Agent 架构问题梳理》的 Review 回应

- 日期：2026-08-01
- 状态：架构分析稿（Review 回应）；**不是已批准架构，已由同日目标架构交叉审查修订**
- 输入文档：`wiki/architecture/2026-08-01-frontend-driven-agent-architecture-gap-inventory.md`（下称「梳理稿」）
- 方法：① 逐条对照当前源码核实梳理稿的事实与推断；② 调研 PI SDK 生态（pi SDK 本体、@agwab/pi-subagent / @agwab/pi-workflow、oh-my-pi、kimi-code）可复用能力；③ 按「复用优先」原则给出逐条调整方案
- 代码证据路径前缀：后端 = `domains/backend/code/workbench-server/src/`；agent 域 = `domains/agent/code/agent-runtime/`；前端 = `domains/frontend/web/code/web-prototype/src/`

> 权威性说明（2026-08-01）：本文件保留源码核实与生态调研过程，不作为实施依据。最终决策以
> `2026-08-01-skillos-loopos-backend-architecture.md` 为准。尤其是本稿中“Broker 对 Admission 无感”、
> “HTTP abort 等同执行取消”、“文字与 Realtime 共用单一 generation”、“严格全局 FIFO”以及
> “全量 transcript 永不删除”等候选结论已经被交叉审查修正。

---

## 1. 核实结论总表

| 条目 | 梳理稿结论 | 核实结果 | 关键证据 |
|---|---|---|---|
| P0-01 Creation 绕开 Broker | 已确认事实 + 高可信推断 | **成立（源码级闭环）** | `skills/skill-creation-service.mjs:259-281` 直调 `modelService.execute` 并自造 invocationId/attemptId；`server.mjs:479-519` 默认组合把无 try/catch 的 `recordModelAttempt` observer 注入同一个 ModelService；`execution/mongo-execution-persistence.mjs:41-46` invocation 不存在时抛 `execution_invocation_not_found`；`execution/model-service.mjs:132-135` observer 在 credential 解析与 provider 调用**之前**被同步 await（位于 try 块外） |
| P0-02 Creation 无 FIFO/fence | 已确认事实 | **成立** | `sendMessage()` 唯一并发保护是幂等键去重（`skill-creation-service.mjs:234-247`）；`:253` 只在调用前检查 formRevision，`:292-329` 写回 patch/turn/event 全程不复查；`http/workbench-http-handler.mjs` 全文无 `signal/abort`，生产路径 signal 恒为 undefined；文字路径无 generation fence（Realtime 有，`:488-493`） |
| P0-03 5000 条丢最新上下文 | 已确认事实 | **成立** | `agents/mongo-agent-persistence.mjs:269` 升序 `limit(5000)` 取**最早** 5000 条；`agents/product-agent-executor.mjs:200-206` 再 `.slice(-100)`；附件路径 `agent-turn-runner.mjs:934-946` 同样 `.slice(-100)`，同一缺陷两处 |
| P0-04 缺组合链证据 | 已确认事实 | **成立**（本次核实同样只到源码层，未做真实 Mongo/Docker 运行） | — |
| P1-01 无全局 admission | 已确认事实 | **成立** | `agent-turn-runner.mjs:24-26,470-562` 全部调度状态按 sessionId 键控；`execution-broker.mjs:82-163` execute 直接 createInvocation→createAttempt→issueLease→dispatch，无容量检查 |
| P1-03 loop_creator 未消费 | 已确认事实 | **成立** | `agents/agent-definitions.mjs:4-28` 三种定义齐全；Builder 走一次性 proposal（`application/workbench-application.mjs:2852-2960` 直接构造 bounded_agent invocation，controller 为 `builder-{proposalId}`）；前端全 src grep `loop_creator` 零匹配 |
| P1-05 上下文责任未闭环 | 已确认事实 | **成立（一处无法本仓验证）** | 跨 Turn 重建仅 `listMessages()`（`agent-turn-runner.mjs:542`）；`memory/product-memory-service.mjs:185` 的 `contextCapsule()` **定义存在但全 src 无调用方**；PI compaction 仅 `kernels/pi/pi-kernel-adapter.mjs:256-260` 暴露、workbench 无消费方。容器内 worker 源码不在本仓库，容器内 PI Session 生命周期无法本仓闭环验证 |

补充核实（梳理稿未覆盖、本次新发现）：

1. **Turn FIFO 与 settle fence 本身是健康的**：Mongo 原子 claim（`mongo-agent-persistence.mjs:283-301`，事务内 `activeTurnId: null` 条件）+ `settleTurn` 条件写回（`:382-394`）构成完整 claim/drain/fence，可直接作为共享 Coordinator 的原型。
2. **Broker 的 agent_orchestrator 已具备 sub-agent 治理骨架**：`reportChild` 登记子 invocation/子 lease、`maxChildren` 预算、capability 子集校验防提权、父 fence 校验、`cancelAll` 级联取消（`execution-broker.mjs:276-485`）。`bounded_agent` 被禁止再派生子级（`:573-575`）。
3. **Turn 内并行 Worker 机制已存在但未使用**：`agent-turn-runner.mjs:564-581` `#runWorkers` 支持 `Promise.all` 并行派发，但 `product-agent-executor.mjs:54` 只提交单个 worker。
4. **隐性依赖风险**：`worker/container-pi-worker.mjs:10-13` 与 `worker/product-gateway-extension.mjs:3-6` 直接 import 传递依赖 `@earendil-works/pi-ai/providers/faux`，但 package.json 未声明 `pi-ai`——pi-coding-agent 依赖结构变化会破坏 worker 镜像，应显式声明。

## 2. 生态调研结论（复用优先原则的事实基础）

### 2.1 前提更正（影响调研结论的适用方式）

- **pi 项目已易主**：从 Mario Zechner 迁移至 Earendil（维也纳，含 Armin Ronacher）。npm scope 从 `@mariozechner/pi-*`（停留在 0.73.1）迁到 `@earendil-works/pi-*`，当前最新 **0.83.0**；本仓 pin `0.80.7`（`domains/agent/code/agent-runtime/package.json:35-42`，有兼容门禁测试锁定）。来源：github.com/earendil-works/pi、pi.dev/news/2026/5/7/pi-has-a-new-home。
- **「kimi-code 基于 PI SDK」不成立**：kimi-code 是 MoonshotAI 自研 TypeScript monorepo，agent 引擎为自研 `@moonshot-ai/agent-core`（依赖 kosong/kaos，不依赖任何 pi 包）；**仅 TUI 基于 pi-tui**（README 明确致谢）。来源：github.com/MoonshotAI/kimi-code。因此 kimi-code 对本项目只有**模式参考价值**，没有代码复用价值。
- **oh-my-pi（omp）** 是 pi-mono 的 batteries-included fork（github.com/can1357/oh-my-pi，npm `@oh-my-pi/pi-coding-agent`），其 task/hub 工具是社区里最完整的多 agent 编排实现，**模式高度可参考**；直接换用 omp 等于换底座，不建议（见 §6）。
- 本仓已引入 `@agwab/pi-subagent@0.4.8`（headless/inline sub-agent）与 `@agwab/pi-workflow@0.8.1`（动态 DAG），并在容器 worker 默认走 AgwaB 后端——**sub-agent 执行层已经复用社区包，不需要再造**。

### 2.2 可复用能力清单（按本项目四个关切主题分组）

图例：[pi] = pi SDK 内建（本项目已依赖）；[agwab] = 已引入的社区包；[omp] = oh-my-pi 模式（参考，不引入）；[kimi] = kimi-code 模式（参考）；[自建] = 必须自己做。

#### 多 agent 管理（spawn / registry / 路由 / 并发）

| 能力 | 来源 | 对本项目的用法 |
|---|---|---|
| 进程内 spawn 子 session | [pi] `createAgentSession` + inMemory SessionManager；[agwab] runSubagent | 已用于容器 worker；Builder proposal 生成器（`core/proposals/pi-builder-proposal-generator.mjs`）也是同一模式 |
| Agent 定义 = 声明式描述 + 多级发现 | [omp] Markdown frontmatter + project/user/plugin/bundled 四级发现；[kimi] 六级优先级 | 本项目 `agent-definitions.mjs` 已是声明式，保持 Product-owned，不引入文件系统发现 |
| spawn 白名单 + 递归深度门控 + 防自递归 | [omp] `getSessionSpawns()` / `task.maxRecursionDepth` / `PI_BLOCKED_AGENT`；[kimi] `subagents` 字段执行前二次校验 | 映射到 Broker 的 capability 子集校验 + `maxChildren` + orchestrator 层级限制（已有骨架，补深度计数即可） |
| 并发上限 semaphore | [omp] session 级 Semaphore（`task.maxConcurrency`）；[kimi] swarm 渐进爬坡（立即 5 个、每 700ms +1）+ 环境变量封顶 | 用于 AdmissionController 的容量租约设计（见 §4.3） |
| 异步 job + 完成结果回投 | [omp] AsyncJobManager（async-result 注入父会话）；[kimi] `run_in_background` + synthetic user message 回投 | 对应 Worker 完成 → Turn 事件回写，Broker 事件流已具备传输层 |
| 结构化产出 | [omp] `outputSchema` + yield 工具 + `agent://<id>` 产物 URL | 本项目 bounded worker 已有最终 JSON schema 校验（`container-pi-worker.mjs:199-226`），方向一致 |
| 角色化模型路由 | [omp] default/smol/slow/plan 四角色 + fallback chain；[kimi] primary/secondary model | 由 Product Model Catalog 承担（已存在），不另建 |

#### 上下文窗口管理（compaction / capsule / memory）

| 能力 | 来源 | 对本项目的用法 |
|---|---|---|
| 阈值触发 compaction（reserveTokens 默认 16384、keepRecentTokens 默认 20000、切点绝不在 tool result 上） | [pi] | **已在容器 worker 开启**（`container-pi-worker.mjs:189`，reserve 8000 / keepRecent 16000）；保持其定位为「单次 Worker 内部优化」 |
| 固定结构化 summary 模板（Goal / Constraints / Progress(Done·In Progress·Blocked) / Key Decisions / Next Steps / Critical Context + 文件清单） | [pi] | **直接借用为 Product Session Context Capsule 的 schema 蓝本**（见 §4.2），与梳理稿要求的 Goal/Constraint/Decision/Progress/Open Risk/Artifact 引用几乎一一对应 |
| 分支摘要（session tree 切分支注入被弃分支上下文） | [pi] | 远期若启用 PI session tree/fork 再评估；当前 P3 |
| 溢出先升窗再压缩（context promotion）、tool-output 预剪枝、mid-turn/idle 压缩 | [omp] | tool-output 预剪枝值得吸收到 executor 的消息裁剪；其余暂不需要 |
| 无 LLM 确定性压缩（snapcompact 位图帧） | [omp] | 实验性、依赖视觉模型，不采用 |
| 跨 session 记忆（retain/recall/reflect） | [omp] Hindsight/mnemopi | 本项目 Product Memory Service 已是权威，按治理检索注入即可，不引入 |
| 注入物存活过 compaction | [omp] stream rules | 对应「Capsule 不进 PI 上下文、每 Turn 由 Product 侧重新组合」的设计（§4.2） |

#### Session 管理（FIFO / cancel / fence / 持久化）

| 能力 | 来源 | 对本项目的用法 |
|---|---|---|
| steer / followUp 双队列 + `queue_update` 事件 + `abort()` 贯穿 | [pi] | steer/followUp 语义可映射到产品层「插队/排队」；`abort()` 已在 kernel adapter 暴露，需在产品链路把 HTTP abort 接到底 |
| JSONL 树形 session（id/parentId、fork、label、compaction entry 即历史） | [pi] | 产品状态权威仍是 Mongo Product Session；PI JSONL 只允许作为 Worker 内部优化，不得成为产品真相（与梳理稿 §8.1 一致） |
| 每 agent 独立 wire.jsonl 事件流（含请求级 trace，用于回放） | [kimi] | 对应 Broker execution event 流，已有等价物 |
| 工具执行 parallel/sequential 可配 | [pi-agent-core] | kernel 层已可用 |

#### 执行治理（queue / admission / backpressure / 观测）

| 能力 | 来源 | 对本项目的用法 |
|---|---|---|
| 后台 job 并发上限 + owner 作用域可见性 | [omp]（max-running fallback 15）；[kimi]（`max_running_tasks`） | AdmissionController 默认上限的参考数值 |
| 消息邮箱背压（每 agent 上限、溢出丢最旧） | [omp] hub | 对应 Session 队列长度上限与拒绝策略 |
| 超时两段终止（SIGTERM→grace→SIGKILL） | [kimi] | Broker 已有 abort→超时定时器，容器层补两段终止 |
| 审批/权限规则继承给 sub-agent | [kimi] | 对应 Broker capability 子集校验（已有） |
| OTel GenAI semconv（`pi.session → pi.agent_turn → gen_ai.chat`） | [pi] 社区扩展 pi-OTel | 可作为 exporter；Product event/invocation 仍是审计真相（梳理稿 P1-09 口径一致） |

### 2.3 一句话结论

**执行层（sub-agent spawn、编排、compaction）社区已有且本项目已在用；真正的缺口全部在「产品控制面」——FIFO/admission/capsule/lineage，这些三个生态都没有现成模块，正是必须自建的 ConversationTurnCoordinator + AdmissionController。** 梳理稿方案 B 的方向与生态现状完全吻合。

## 3. 逐条调整方案

### P0-01 Creation 文字助手接入 Broker 治理

采纳梳理稿方案 B，细化如下：

1. 新增 Product-owned `CreationTurnCoordinator`（或并入 §4.1 的共享 Coordinator，见 P1-02），`sendMessage()` 改为：claim Turn → 由 Coordinator 向 ExecutionBroker 发起 `model_call` invocation（mode=model_call、isolation=process，backend 为 `createModelCallBackend`，`server.mjs:580` 已存在）→ Broker 持久化 invocation/attempt/lease → 模型调用。
2. 这样 `recordModelAttempt` observer 不再收到自造 ID——observer 逻辑零改动，双重真相自然消除。
3. ModelService 保持「纯执行」定位，不再被产品层直接持有；`server.mjs:889-895` 的注入改为注入 Broker 或 Coordinator。
4. 验收：默认 Server + Mongo composition + fake Provider adapter 的集成测试，证明 invocation/attempt/lease 先于 Provider 请求存在，取消/超时/权限/Provider 失败均进统一终态（梳理稿 §P0-01 验收 1-4 原样成立）。

不采纳方案 A（observer 特例）：会把架构分叉固化成永久兼容层。不采纳方案 C（改造成 ModuleAgentSession）：Draft 前伪造 object/branch 语义会污染 Agent Session 模型。

### P0-02 Creation Session 服务端 FIFO + fence

采纳方案 B：

1. 持久化 `activeTurnId + sequence + generation` 到 SkillCreationSession，claim/drain/fence 复用 Main Agent 已验证的 Mongo 原子条件写模式（`mongo-agent-persistence.mjs:283-301` 的 claim、`:382-394` 的 settle 条件写回即模板）。
2. 写回前（插入 patch/turn/event 之前）以 `{ sessionId, activeTurnId, generation, status: "active" }` 为条件执行写操作——条件不满足即拒绝，迟到结果无法落库。
3. 打通取消链：http handler 把请求 abort signal 传到 application → service → Broker（Broker `:141-152` 已有 signal→cancel 桥接，接上即可）。
4. 文字路径 generation 与 Realtime `realtimeGeneration` 统一为同一个 session generation 字段，文字/语音对同一表单的因果顺序一致。
5. 验收：同 Session 双客户端严格 FIFO；end/cancel 后迟到 Provider 结果不能写 Patch/Receipt/Event；跨标签页并发回归测试。

### P0-03 长 Session 上下文修复 + Capsule

分两步，先做 A 止血，再做 B：

1. **A（立即）**：`mongo-agent-persistence.mjs:269` 改为按 sequence 倒序取最新 N 条再恢复正序；`agent-turn-runner.mjs:934-946` 附件路径同步修复。两处各一行级改动，必须配 5001/10000 条回归测试。
2. **B（跟进）**：Product-owned Session Context Capsule，见 §4.2。
3. 不采纳方案 C（持久恢复 PI Session）：与 §2 调研结论一致——PI Session 不能成为产品状态权威，运行时耦合和容器迁移成本高。

### P0-04 垂直集成 Gate

采纳方案 B。建议首批只建 4 条「前端承诺级」垂直 Gate（每条从 Product API 到 persistence/backend，用隔离 Mongo + fake Provider）：

1. Main 同 Session FIFO + 跨 Session 并行；
2. Creation 文字端到端（P0-01/P0-02 修复后的回归基线）；
3. 超长 Session 上下文（P0-03）；
4. cancel/end 后迟到结果 fence（文字 + Realtime）。

环境重的（真实 Docker、真实 Credential、真实 gpt-realtime）保持「环境未验证」标记，不阻塞 P0 修复合并，也不改变 NO-GO 口径。

### P1-01 全局 AdmissionController

采纳方案 B，设计见 §4.3。要点：Mongo 持久等待队列 + 容量租约 + fence；位置在 Coordinator 与 Broker 之间——**Broker 保持「获准即执行」的简单语义不变**，admission 作为独立 Product service，Broker 不需要知道排队存在（回答梳理稿 §12 问题 3）。

### P1-02 ConversationTurnCoordinator

采纳方案 B。定位为**从 AgentTurnRunner 抽取出的内部 application service**（回答梳理稿 §12 问题 2）：把已验证的 per-session FIFO/claim/settle/fence/recover 泛化为「session 记录 + 锁字段」协议，Main/Module/Creation 三种 Session 保留各自的产品记录与 TTL 语义，仅共享 Turn 协调。防止其演化成巨型 Service 的手段：Coordinator 只管并发与因果（FIFO、generation、cancel、fence、admission 请求、trace 串联），**不管** prompt 组装、patch 语义、proposal 语义——这些留在各产品 Service。

### P1-03 loop_creator 接入 Builder

采纳方案 B，最小范围（回答梳理稿 §12 问题 7）：**仅在 Loop Draft 已存在后**启用 `loop_creator` ModuleAgentSession（objectKinds 已声明 `["workflow"]`，`agent-definitions.mjs:4-28` 无需改）；Builder「助手」的多轮消息走 Module Session transcript，产出仍只有 Proposal，由现有 review/apply/merge 控制。Draft 前的「生成 Loop 文档」保持 staged proposal 生命周期，不接 Module Session。若本迭代不实施，则先执行 P2-04 的诚实降级文案。

### P1-04 staged proposal 编辑持久化

采纳方案 B：Product API 增加 staged proposal patch 端点（字段级 merge + revision/ETag），commit 原子消费指定 revision；不建 immutable version 链（方案 C 对当前表单编辑频率过重）。

### P1-05 三层上下文语义闭环

采纳方案 B，即 §4.2：Durable Memory（治理检索注入）/ Session Context Capsule（跨 Turn 重建）/ PI compaction（单次 Worker 内部优化）三层明确分离。`contextCapsule()` 已有定义无调用方（`product-memory-service.mjs:185`）——Memory 层 capsules 继续由其提供，Session Capsule 是新增的另一对象，不要复用同一个函数混淆边界。

### P1-06 队列 read model

采纳方案 B：Session read model 增加 `runningTurnId / queuedTurnCount / position / cancelQueuedTurn`。admission 引入后该 read model 同时表达「等本 Session 前一个 Turn」与「等全局容量」两种等待，reasonCode 区分（对应 P2-07）。

### P1-07 Realtime 纳入统一治理

采纳方案 B：保留 WebRTC 媒体专用 adapter 与服务端 credential；session/call 的 admission、并发额度、budget、event、generation 归共享 Coordinator。短期可先做方案 A（每用户连接数上限）止血。

### P1-08 readiness 对齐

采纳方案 B：扩展现有 Product readiness read model 返回 `skillCreationCopilot.text/realtime` 的 status/reasonCode/recoveryAction，不建新服务。

### P1-09 trace lineage

采纳方案 B：`productCommandId → session/turn → invocation/attempt → provider/tool/realtime → proposal/artifact` 全链 ID 关联。实现成本最低的路径：Coordinator 在 claim Turn 时生成/透传 commandId，Broker 事件已具备 attempt 级串联，只需在 read model 聚合。OTel exporter 可作为后续增强（pi-OTel 的 span 模型可参考），不替代产品事件真相。

## 4. 四个横向主题设计

### 4.1 多 agent 管理

目标形态（维持梳理稿方案 B，结合 §2 调研细化）：

```text
Product Agent Definitions（main / skill_creator / loop_creator；声明式，Product-owned）
        │  定义「这个 agent 是谁、能用什么 capability、产出什么」
        ▼
ConversationTurnCoordinator（新增，内部 application service）
        │  per-session FIFO / active claim / generation fence / cancel / recover
        │  model revision pin / context capsule 组装 / trace 串联 / admission 请求
        ▼
AdmissionController（新增）── 容量租约、持久等待队列、公平策略
        ▼
ExecutionBroker（保持现有语义：invocation/attempt/lease/fence/cancel/reportChild）
        ▼
bounded_agent(容器, @agwab/pi-subagent) ｜ agent_orchestrator(@agwab/pi-workflow) ｜ model_call ｜ deterministic_skill
```

分工原则（防巨型 Service）：

- **Definitions** 回答「能做什么」：capability、objectKinds、产出类型（文本/Patch/Proposal）。
- **Coordinator** 回答「什么时候轮到谁、结果算不算数」：并发与因果。
- **Broker** 回答「怎么执行、怎么取消、怎么防越权」：执行治理。
- **各产品 Session Service** 回答「这个产品对象是什么」：transcript、TTL、patch/proposal 语义。

新增 agent 入口的 checklist 直接沿用梳理稿 §11 的 14 问——其中第 3、4、7、8 问由 Coordinator/Admission 统一回答后，新入口只需要回答产品语义问题（1、2、5、9、10、11），这正是统一层的收益。

### 4.2 上下文窗口管理

三层语义分离（每层一句话：谁拥有、活多久、给谁用）：

| 层 | 权威 owner | 生命周期 | 用途 | 现状 |
|---|---|---|---|---|
| Durable Memory | Product Memory Service | 长期、跨 Session | 按治理检索后注入 prompt | 已存在，`contextCapsule()` 待接调用方 |
| Session Context Capsule | Product Session Service（新增对象） | 随 Session 演进、版本化 | 跨 Turn / Worker 重建时还原目标、约束、决定、进展、风险 | **本次新增** |
| PI compaction | PI Session（Worker 内） | 单次 invocation/attempt | Worker 内部 token 预算 | 已在容器 worker 开启（reserve 8000/keepRecent 16000） |

Session Context Capsule 设计：

- **Schema 直接借用 pi compaction 的结构化模板**（§2.2）：`goal / constraints / progress{done,inProgress,blocked} / keyDecisions / nextSteps / criticalContext / artifactRefs`——与梳理稿 P0-03 验收第 2 条逐项对应，且该模板经过 pi 生态实战验证。
- **更新时点**：每个 Turn settle 时由 Product 侧基于「上一版 Capsule + 本 Turn 消息 + 本 Turn artifact/decision 引用」生成新版本（版本化、可审计、可回滚）；原始 transcript 永不写入 Durable Memory。
- **组装规则**：每 Turn 输入 = Capsule + 最新 N 条消息（N 受 token 预算约束）+ 治理检索的 Memory 引用；tool-output 类长消息按 [omp] 预剪枝模式截断。
- **Worker 重建验收**：新 PI Session 仅凭 Capsule + recent messages + refs 即可重建有效上下文（梳理稿验证矩阵「Worker 重建」行）。
- 回答梳理稿 §12 问题 5：owner 是 Product Session Service；版本随 Turn 单调递增；更新时点为 settle；回滚 = 指回旧版本号（Capsule 只增不改）。

### 4.3 sub-agent 启动与并发

已有的不动，缺的补上：

- **已有（保持健康）**：Broker `agent_orchestrator` 的 reportChild/maxChildren/capability 子集校验/cancelAll；`#runWorkers` 的 Turn 内并行；AgwaB 的 interrupt/reconcile/resumeRun。
- **补 1：递归深度与 spawn 策略**。在 Broker 请求里增加 `depth` 字段与 per-definition `allowedChildren`，映射 [omp] maxRecursionDepth + spawn 白名单模式；orchestrator 已有 maxChildren，补深度计数即可， bounded_agent 禁止派子的规则维持。
- **补 2：全局并发闸门 = AdmissionController**。维度：per-user / per-workspace / per-backend(container) / per-provider；默认上限参考生态数值（omp max-running 15、kimi swarm 爬坡 5+1/700ms）：建议初始 user=4、workspace=8、container=单机 CPU 派生、provider=按 Catalog profile 配置。等待项持久化（Mongo），获准签发 capacity lease，Broker dispatch 前校验 lease+fence；释放与超时回收与 execution lease 同生命周期。
- **补 3：Turn 内多 Worker 的实际启用**。`#runWorkers` 机制已在，待 ProductAgentExecutor 产出多 worker 计划时自然启用，无需新机制；但多 worker 请求必须先过 admission（每 worker 一个 capacity lease）。
- **补 4：容器两段终止**。参考 [kimi] SIGTERM→grace→SIGKILL，落到 `agent-container-sandbox.mjs` 的清理路径（现有 kill/rm 已存在，补 grace 窗口）。

### 4.4 agent 执行治理

- 所有模型/agent 执行**只认 Broker 一条路**：Main Turn、Module Turn、Creation 文字、Builder proposal、bounded worker、orchestrator——P0-01 修复后达成。Realtime 媒体平面除外（媒体不走 Broker，但 admission/budget/event 走 Coordinator，P1-07）。
- ModelService 回归「Broker 的 model_call backend 内部组件」定位，产品层不再直接注入。
- 超时/取消/fence/迟到结果拒绝维持 Broker 现有实现（已完整）；Creation 路径接入后自动继承。
- 观测：trace lineage 见 P1-09；execution event 流已是等价于 [kimi] wire.jsonl 的审计真相，read model 只暴露安全引用。

## 5. 对梳理稿 §12 十个 Review 问题的建议回答

1. **P0-01 推断是否成立、是否还有其他直调 consumer**：成立（§1 证据链）。排查结果：ModelService 的另一消费者是 `createModelCallBackend`（Broker 路径，正常）；建议修复后在 server composition 层加静态断言，禁止产品 service 直接持有 ModelService。
2. **Coordinator 是抽取层还是独立 service**：从 AgentTurnRunner 抽取的内部 application service（§4.1）。
3. **Admission 位置**：Coordinator 与 Broker 之间的独立 Product service，Broker 无感知（§4.3）。
4. **Mongo 持久 admission 是否足够、是否需公平策略**：单机阶段足够；首版用 FIFO + per-user 配额即公平，优先级字段预留不启用。
5. **Capsule owner/版本/时点/回滚**：Product Session Service；随 Turn 单调递增；settle 时更新；版本指针回滚（§4.2）。
6. **Creation Session 是否恢复、标识放哪**：需要恢复；opaque sessionId 放 URL（比 session storage 更利于跨标签页一致性），服务端重新校验 principal/TTL/status。
7. **loop_creator 最小范围**：仅在 Loop Draft 已存在后启用（§3 P1-03）。
8. **staged proposal 编辑存 mutable 还是 immutable**：mutable draft + revision/ETag（§3 P1-04）。
9. **Realtime 媒体状态与 Product Turn 映射、计费与 lease 时点**：call 建立时申请 admission 并签发 capacity lease，call 终止（正常/异常/超时心跳）释放；计费事件挂 session generation，旧 generation 的 sideband tool call 一律拒绝（现有 realtimeGeneration 机制延伸到容量与计费）。
10. **哪些 legacy 路径可删**：建议本轮只给每条兼容路径登记 owner/允许场景/删除条件（梳理稿 P2-08 口径），删除动作放到 Iteration 5 证据齐全之后；`pi-ai` 传递依赖显式声明可立即做（§1 补充 4）。

## 6. 明确不建议的事

- **不换底座到 oh-my-pi**：omp 价值在模式（§2.2 已逐条吸收），换 fork 等于放弃 earendil-works 主线升级通道与现有兼容门禁。
- **不引入 kimi-code 代码**：其 agent 层与 PI SDK 无关，仅模式参考。
- **不启用 PI session tree/fork 作为产品状态**：维持 Mongo Product Session 为唯一权威（梳理稿 P3-5 口径）。
- **不把 Coordinator 做成 event-sourced actor 系统**（梳理稿方案 C）：当前规模无证据支持。
- **pi SDK 0.80.7 → 0.83.x 升级**：与本批修复解耦，单独走兼容实验（沿用 Slice 0 的升级门禁做法），不夹带进 P0 修复。

## 7. 迭代切片（在梳理稿 §10 基础上的微调）

- **Iteration 0（止血）**：P0-03 查询修复（两处）+ 5001/10000 回归；P0-01 composition 集成测试复现；`pi-ai` 依赖显式声明。其余不动。
- **Iteration 1（Creation 治理）**：ConversationTurnCoordinator 最小契约（先只服务 Creation + Main，证明可抽取）→ Creation 文字走 Broker model_call → abort 链打通 → 写回 fence；Realtime generation 与文字统一。
- **Iteration 2（上下文 + 容量）**：Session Context Capsule（schema 借用 pi 模板）+ Worker 重建验收；AdmissionController（Mongo 持久、四个维度上限）；队列 read model（P1-06）。
- **Iteration 3（Loop 对齐）**：loop_creator Module Session（Draft 后）+ staged proposal revision/ETag。
- **Iteration 4（产品化）**：Session rename/archive/search、Creation 恢复（URL sessionId）、readiness 对齐、状态文案 reasonCode 化。
- **Iteration 5（证据）**：梳理稿 §13 验证矩阵全量，四条垂直 Gate 先行，环境重项单独出具证据；此后才讨论 legacy 删除。

---

本文件是对梳理稿的 Review 回应与调整建议，所有方案仍需架构师批准后形成正式结论；文中「核实结果」为源码级证据，真实运行表现以 Iteration 0/5 的集成证据为准。
