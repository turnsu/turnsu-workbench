# 前端驱动下的 Agent 架构问题梳理

- 日期：2026-08-01
- 状态：架构师 Review 输入稿
- 结论性质：问题清单、证据索引与候选方向；**不是已批准架构，不替代任何当前权威文档**
- 审查快照：`codex/backend-agent-slices-0-4`，`HEAD 6c8e0580cfa8` 加当前未提交工作树；后续代码变化需重新核对
- 适用范围：M5 前端、Workbench Product API、Agent Session、Creation Copilot、Loop Builder、Execution Broker、PI Worker、Context、Memory、Model/Realtime 路由
- 不包含：本文件不修改产品需求，不批准迁移方案，不宣称功能、视觉或生产签收

## 1. 为什么需要这份梳理

过去多轮迭代主要由前端产品形态推动：多任务 Agent、Skill 七步创建、对话式创建助手、
Realtime 语音、Loop 暂存提案、Builder 助手、模型选择、附件与材料等能力不断进入产品。
这种方式本身是合理的，因为前端更快暴露真实用户任务和交互缺口。

问题在于，部分新增交互只完成了页面和局部 API，后端仍沿用不同阶段形成的多套执行、
Session、上下文和恢复机制。结果不是“后端完全没有实现”，而是：

1. 已有 Main/Module Agent 主干与新增 Creation Copilot、Builder Assistant 没有完全对齐；
2. 用户看到的多个“Agent/助手”具有相似外观，却不共享相同的 FIFO、取消、审计、预算和恢复语义；
3. 前端承诺的多 Session、长对话和排队体验，超过了当前后端的全局容量与上下文治理能力；
4. 自动化测试大量覆盖局部模块，但关键真实组合链路仍存在缺口或尚未验证；
5. 历史迭代曾把“结构已存在”“自动化层已通过”和“真实能力可用”混为同一个结论；
   最新 QA 已纠正结论口径，但真实组合证据仍未补齐。

本文件的目标是把这些问题完整列出，交由架构师判断事实是否成立，再决定最终方案。

## 2. 审查口径

### 2.1 “前端驱动后端”在本项目中的正确含义

前端可以驱动后端的产品能力和契约设计，但浏览器不能成为运行、权限或状态权威。

推荐理解为：

```text
前端任务与交互
  -> 提出 Product capability / read model / command 需求
  -> Product API 验证 principal、状态、版本与幂等
  -> Product-owned Runner / Coordinator / Service 持有真实状态
  -> Execution Broker / Runtime / Provider Adapter 执行
  -> 前端消费可恢复、可解释的 read model
```

不应退化为：

```text
前端新增一个按钮或聊天框
  -> 为该页面临时增加一个模型调用
  -> 页面本地状态模拟排队、取消和恢复
  -> 后端留下另一套 Session 或执行生命周期
```

### 2.2 证据级别

| 级别 | 含义 |
|---|---|
| 已确认事实 | 当前源码或现有测试可直接证明 |
| 高可信推断 | 由默认 composition 和调用顺序推导，但尚缺真实集成运行证明 |
| 环境未验证 | 需要真实 Mongo、Docker、Provider、Credential 或认证页面运行 |
| 建议 | 本文提出的候选方向，等待架构师确认 |

### 2.3 优先级

| 优先级 | 定义 |
|---|---|
| P0 | 可能直接阻断主路径、破坏数据/因果一致性、绕过治理，或制造虚假成功 |
| P1 | 当前可局部工作，但架构所有权不一致，规模或恢复后会显著失效 |
| P2 | 不立即破坏正确性，但持续造成体验误导、运维困难或维护成本 |
| P3 | 已知演进项或当前明确边界之外的能力，不应反向阻塞 P0/P1 |

## 3. 当前真实架构概览

### 3.1 已建立的主控制链

```text
Web
  -> Workbench Product API
  -> Product Store / AgentTurnRunner / WorkflowRunner / Product Services
  -> Product-owned Execution Broker
  -> deterministic_skill | bounded_agent | agent_orchestrator | model_call
  -> process | container | remote adapter
  -> Agent Runtime Core / PI Kernel / Provider Adapter
```

关键所有权设计总体正确：

- `WorkflowRunner` 拥有外层 Loop Run、固定计划、review、retry、checkpoint 和最终状态；
- `AgentTurnRunner` 拥有个人 Agent Session 内的 Turn FIFO；
- `ExecutionBroker` 拥有 invocation、attempt、lease、event、cancel transport 和 fence；
- Product Model Catalog 拥有 model profile/revision/capability，浏览器只提交 `modelProfileId`；
- Product Memory Service 是长期 Memory 唯一权威，PI compaction 不是长期 Memory；
- Module Agent 只生成 Proposal，不应直接覆盖 Canonical Draft。

### 3.2 当前 Session 类型及实际消费情况

| 类型 | 设计作用域 | 当前消费 | 判定 |
|---|---|---|---|
| `MainAgentSession` | `user × workspace`，长期个人任务 | Agent 首页 | 主干已存在 |
| `ModuleAgentSession` | `user × workspace × object × branch` | Skill Draft 后的 `skill_creator` | 主干已存在 |
| `loop_creator` Module Session | 同上，Loop 对象分支 | 后端定义存在，当前 Builder 主路径未消费 | 前后端未对齐 |
| `SkillCreationSession` | Draft 前、个人、临时、TTL | Skill 创建文字/语音 Copilot | 独立生命周期 |
| Builder Proposal Session | 单次 bounded proposal | Loop 创建与 Builder 变更建议 | 无持久多轮 Session |
| `WorkerSession` | `invocation × attempt` | bounded Agent/PI Worker | 短生命周期，符合设计 |
| Realtime Call | Creation Session 下的媒体连接 | Skill 创建语音 | 专用 WebRTC 生命周期 |

### 3.3 前端表面与后端真实路径对照

| 前端表面 | 用户理解 | 当前后端路径 | 一致性 |
|---|---|---|---|
| Main Agent | 可切换的长期个人任务 | AgentTurnRunner → ProductAgentExecutor → Broker | 基本一致 |
| Skill Creator Agent | 围绕已有 Draft 多轮协作 | Module Agent Session → Proposal → apply/reject | 基本一致 |
| Skill 创建“让 Agent 帮我梳理” | Draft 前多轮文字/语音 Agent | SkillCreationService；文字直调 ModelService，语音走 Realtime adapter | 部分一致 |
| Loop Builder“助手” | 可持续协作的 Loop Agent | 单次 bounded Proposal，无 Module transcript | 名称/预期不完全一致 |
| Loop 文档生成 | 生成可编辑、可恢复的暂存提案 | staged proposal + 前端本地编辑 + commit | 提案边界正确，编辑恢复不完整 |
| Agent 排队 | 同任务串行、不同任务并行且可解释 | Session FIFO 已实现；全局 admission 与准确队列位置未实现 | 部分一致 |

## 4. P0：必须优先确认和处理的问题

### P0-01 Skill 创建文字助手绕开 Execution Broker，并可能在默认组合中先于 Provider 调用失败

#### 当前事实

`SkillCreationService.sendMessage()` 直接调用 `ModelService.execute()`，自行生成
`invocationId`/`attemptId`，但没有先通过 Execution Broker 创建对应 invocation、attempt
和 capability lease。

默认 Server composition 又把同一个 `recordModelAttempt` observer 注入该 Model Service。
observer 会向 Execution Persistence 追加事件，而 Mongo Persistence 在 invocation 不存在时
抛出 `execution_invocation_not_found`。Model Service 在解析 credential 和调用 Provider 之前
同步等待 `attempt.started` observer。

#### 影响

- 真实默认组合可能在 Provider 请求前失败；
- 即使通过定制依赖绕过失败，Creation Copilot 仍缺少 Broker 的 lease、fence、统一取消、预算和 timeline；
- 单元测试注入 fake Model Service，可以通过但无法证明默认 composition；
- 同一产品内形成“Agent Turn 有完整执行记录，Creation Turn 只有局部记录”的双重真相。

#### 证据性质

- “直接调用 ModelService”是已确认事实；
- “默认真实组合会在调用 Provider 前失败”是高可信推断，需要 Mongo composition 集成测试确认。

#### 候选方案

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A | 为 Creation Copilot 禁用或替换 execution observer | 修复快 | 继续保留第二套执行审计，隐藏架构分叉 |
| **B（建议）** | 通过 Product-owned `CreationTurnCoordinator` 创建受治理 `model_call` invocation，再交给 Broker/Model backend | 保留临时 Creation Session 语义，同时统一执行治理 | 需要增加轻量协调层和迁移测试 |
| C | 把 Draft 前创建对话直接改成 `ModuleAgentSession` | 最大程度复用 AgentTurnRunner | Draft 尚不存在，对象/branch 语义被迫伪造，长期污染 Agent Session |

#### 最小验收证据

1. 默认 Server + Mongo composition 下真实调用到 fake Provider adapter；
2. invocation/attempt/lease/event 在 Provider 请求前存在；
3. 取消、超时、权限失败、Provider 失败均进入统一终态；
4. 日志与事件不包含用户原文、音频或 Provider payload。

### P0-02 SkillCreationSession 缺少服务端单 Turn FIFO、完整取消和迟到结果 fence

#### 当前事实

- `sendMessage()` 仅在模型调用前检查 `formRevision`；
- 没有原子 claim `activeTurnId` 或等价的服务端 Session drain；
- 两个页面/标签可以用不同幂等键并发发起模型调用；
- application 层当前没有把 HTTP abort signal 传给 service；
- 模型返回后，在写 Patch、Turn、Event 前没有再次验证 Session status/generation/formRevision；
- Realtime 已有 generation fence，但文字路径没有同等级 fence。

#### 影响

- 两个并发回复可能基于相同旧表单生成互相冲突的 Patch；
- 用户结束 Session 后，迟到结果仍可能写入数据库；
- 前端 `pending` 只能保护单页面，不能保护跨标签页、重试、断线和服务重启；
- 文字和语音对同一表单的因果顺序不完整。

#### 候选方案

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A | 在 SkillCreationService 内增加进程级 mutex | 改动小 | 多实例/重启不可靠，状态不可观察 |
| **B（建议）** | 持久化 `activeTurnId + sequence + generation`，复用共享 ConversationTurnCoordinator 的 claim/drain/fence | 与 Main Agent 一致，可恢复、可审计 | 需要迁移和并发测试 |
| C | 继续依赖前端禁用发送 | 无后端改造 | 无法保证正确性，应拒绝 |

#### 最小验收证据

- 同 Creation Session 两条消息严格 FIFO；
- 不同 Creation Session 在 admission 允许时并行；
- end/cancel 后 Provider 迟到结果不能写 Patch、Receipt 或 Assistant Event；
- 文字与 Realtime Patch 使用同一个 generation/form revision 因果规则。

### P0-03 长 Main Session 在超过 5000 条消息后会静默丢失最新上下文

#### 当前事实

Mongo `listMessages()` 按 sequence 升序读取并限制最早 5000 条；随后
`ProductAgentExecutor.boundedMessages()` 从这 5000 条中取最后 100 条。

因此第 5001 条之后，模型仍会接收第 4901–5000 条，而不是真正最新的 100 条。

#### 影响

- 长期任务会突然“忘记”最新用户要求；
- 用户无法区分模型能力问题和服务端查询错误；
- 错误是静默的，可能基于过时上下文执行 Tool 或生成 Proposal；
- 多 Session 越成功，积累长 Session 后越容易触发。

#### 候选方案

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A | 立即将查询改为倒序取最新 N 条，再恢复正序 | 最快修复正确性 | 仍没有长期上下文摘要 |
| **B（建议）** | A + Product-owned Context Capsule/summary checkpoint；每 Turn 组合摘要、最新消息、Artifact/Decision 引用 | 同时解决正确性与长期上下文 | 需要明确摘要版本、失效和证据来源 |
| C | 为每个 Product Session 长期保存并恢复 PI Session | 可复用 PI 原生 compaction | 运行时耦合、容器迁移和恢复复杂，PI Session 不能成为产品状态权威 |

#### 最小验收证据

- 5001、10000 条消息场景始终包含最新 Turn；
- 摘要保留 Goal、Constraint、Decision、Progress、Open Risk 和 Artifact 引用；
- 原始 transcript 不被写入 Durable Memory；
- Capsule 可版本化、可审计，并可在 Worker 重建后复现。

### P0-04 关键组合链路缺少生产级运行证据，当前 NO-GO 不能解除

#### 当前事实

最新 QA/Code Review 已正确地将代码实现、真实功能签收、人工视觉签收和生产发布分开，
当前 functional、visual、production 仍是 NO-GO。真实 Provider、认证 Mongo、Docker、
Connection credential 以及完整 Loop → Agent → Worker → Result 组合链仍有未验证项。

#### 影响

- 局部单测或静态 gate 容易再次被解释为“Agent 已完成”；
- 上述 P0-01 的 composition 问题可能长期不被 fake service 测试捕获；
- 前端继续演进时，缺少真实路径基线，新的 UI 会建立在未经证明的后端能力上。

#### 候选方案

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A | 延续模块测试与静态 smoke | 成本低 | 无法证明组合链路 |
| **B（建议）** | 建立少量“前端承诺级”垂直集成 Gate，每条从 Product API 到 persistence/backend | 证据与产品承诺直接对应 | 需要维护隔离 Mongo/Docker/fake Provider 组合环境 |
| C | 直接搭建完整类生产 staging | 证明最强 | 当前单机场景过重，容易拖慢 P0 修复 |

## 5. P1：架构所有权和扩展性问题

### P1-01 多 Session 可以并行，但没有 Product-owned 全局 admission/backpressure

#### 当前事实

`AgentTurnRunner` 按 `sessionId` 独立调度，所以不同 Session 可并行；Execution Broker 接到
请求后会立即创建记录、签发 lease 并启动 backend。当前没有统一的 per-user、
per-workspace、per-backend 或 per-provider active limit。

#### 后果

- 单机可因大量 Session 同时活跃而启动过多容器或 Provider 请求；
- Provider 429、内存耗尽和队列延迟只表现为各自失败，用户看不到真实容量状态；
- Realtime、普通模型调用、bounded Worker 和 Script 容器不能共享统一容量预算；
- “不同 Session 可并行”缺少明确的上限和公平策略。

#### A/B/C

- A：进程内 semaphore。快速但重启丢失等待状态；适合短期止血。
- **B（建议）：Product-owned AdmissionController**。Mongo 保存等待项、优先级、容量租约和
  fence；单机执行但状态可恢复，Broker 只在获准后 dispatch。
- C：引入外部消息队列/分布式调度。适合多设备/舰队阶段，本轮过重。

### P1-02 多种“助手”拥有重复且不一致的会话生命周期

#### 当前事实

Main Agent、Module Agent、Skill Creation 文字、Skill Realtime、Builder Proposal 分别实现
了部分 Session、Event、Cancel、Patch 或 Model routing。它们的产品语义确实不同，但底层
Turn 协调能力不应各自重复。

#### 后果

- 每新增一个对话式入口都可能复制一套 TTL、幂等、取消和事件逻辑；
- 修复 Main Agent 的并发问题不会自动修复 Creation Copilot；
- 同名“Agent/助手”在用户层表现不同；
- 测试矩阵随表面数量成倍增长。

#### A/B/C

- A：继续按页面维护独立 Service。局部速度快，长期持续分叉。
- **B（建议）：抽取 `ConversationTurnCoordinator`**，共享 FIFO、generation、model pin、
  invocation、abort、context capsule、principal 和 admission；各产品 Session 保留独立记录。
- C：把所有入口强行合并成 `AgentSession`。概念最少，但会混淆 Draft 前临时会话、对象分支
  和长期 Main Session，不建议。

### P1-03 `loop_creator` 已在后端定义，但 Builder 主路径没有消费

#### 当前事实

后端内置 `main`、`skill_creator`、`loop_creator`；Skill Draft 页面消费 `skill_creator`，
Builder 的“助手”仍是一次性 bounded proposal，没有持久 transcript 或 Module Session。

#### 后果

- Skill 和 Loop 的协作模型不一致；
- Builder 中无法自然进行多轮澄清、恢复和个人 branch proposal；
- 用户可能把“一次生成变更提案”误认为持续 Agent；
- 后端 `loop_creator` 成为未被主 UI 证明的闲置能力。

#### A/B/C

- A：将 UI 改名为“生成变更提案”，明确一次性语义。最小且诚实。
- **B（建议）：已有 Loop Draft 后接入 `loop_creator` Module Session**，所有修改仍只产生
  Proposal，由现有 review/apply/merge 控制。
- C：另建 BuilderChatSession。能定制，但再次增加会话真相源。

### P1-04 Loop 暂存 Proposal 的编辑只在前端保存，刷新恢复不完整

#### 当前事实

服务端保存原始 staged proposal；前端允许编辑名称、Goal、Context、Constraint 和节点标题，
但编辑仅进入 React state。确认时前端将修改后的 draft 一次性提交，所以“不刷新立即应用”
可以成功；刷新则恢复服务端原始版本，而不是用户最后编辑的版本。

#### 后果

- 页面声称“可编辑、可恢复的暂存提案”，实际只恢复生成态；
- 浏览器崩溃或 principal 切换会丢失人工修改；
- 用户可能误以为修改已经保存。

#### A/B/C

- A：本地持久化并显示“仅保存在此设备”。简单但跨设备/身份语义差。
- **B（建议）：Product API 增加 staged proposal patch + revision/ETag**，保存用户编辑但仍不
  创建 Canonical Loop；commit 原子消费指定 revision。
- C：每次编辑生成新的不可变 Proposal version。审计最强，但当前表单编辑频率下过重。

### P1-05 Product Session 与 PI Worker 的上下文责任尚未真正闭环

#### 当前事实

Product Session/Transcript 持久化；bounded Worker 通常每 invocation 创建新的 in-memory PI
Session 并在完成后 dispose。PI compaction 只作用于该 Worker Session。Product Memory Service
能生成 Memory context capsule，但 AgentTurnRunner 的跨 Turn 重建仍主要依赖消息列表。

#### 后果

- “Product Session 持久”容易被误解为“PI 长上下文自然持久”；
- Worker 重建后缺少明确的 Decision/Progress/Risk/Artifact Capsule；
- 只依赖最近消息会丢失早期但仍有效的约束；
- 把 Durable Memory 当上下文摘要会污染长期记忆边界。

#### A/B/C

- A：扩大最近消息窗口。只能推迟问题并增加 token 成本。
- **B（建议）：Product-owned Session Context Capsule**，PI compaction 作为单次 Worker 的内部
  优化；Durable Memory 仅按治理检索注入，三者明确分开。
- C：持久恢复 PI Session 文件。可作为优化 adapter，但不能成为唯一产品真相。

### P1-06 前端排队语义比后端 read model 更丰富

#### 当前事实

同 Session FIFO 已实现；UI 能显示 queued/running，但设计要求的准确“排队第 N 位”没有稳定
后端字段。前端 `activeTurn` 在权威 `activeTurnId` 缺失时，会回退到最后一个非终态 Turn，
这可能把 queued Turn 暂时当作 active。当前主要取消入口针对 active Turn，不提供明确的
queued Turn 管理。

#### 后果

- 用户难以判断消息是在运行还是等待；
- 多个 queued Turn 时取消对象不清晰；
- admission 引入后，如果不扩展 read model，前端会继续猜测队列状态。

#### A/B/C

- A：降低文案承诺，只显示“已排队”。正确但体验有限。
- **B（建议）：Session read model 返回 runningTurnId、queuedTurnCount、当前 Turn position，
  并支持取消指定 queued Turn**。
- C：支持拖拽重排和优先级。当前没有足够需求证据，暂不建议。

### P1-07 Realtime 是合理的专用媒体通道，但尚未纳入统一容量和成本治理

#### 当前事实

浏览器通过 WebRTC 传输语音，Provider credential 留在服务端；Realtime call 有 generation
和 sideband Patch Tool。当前没有与普通 Turn/Worker 共用的 workspace/user admission、
并发额度或统一 cost event。

#### 后果

- 多标签页可以建立多个计费连接；
- 语音和文字并发时缺少统一公平策略；
- 运维难以从 Product timeline 回答“谁占用了 Realtime 容量、花费多少、为何断开”。

#### A/B/C

- A：在 SkillCreationService 增加每用户连接数限制。短期可用。
- **B（建议）：Realtime 保留媒体专用 adapter，但 session/call admission、budget、event 和
  generation 归共享 Coordinator**。
- C：独立 Realtime Gateway 服务。多机规模阶段再考虑。

### P1-08 Capability/Readiness 已有 Product read model，但 Creation Copilot 的恢复动作仍偏局部

#### 当前事实

M5 已新增 operation-specific readiness；Creation Copilot 则分别读取文字和 Realtime
Model Catalog，并在没有 Profile 时显示“无可用模型”。它没有消费一个明确的
`skillCreationCopilot.text/realtime` readiness action，用户通常只能看到 unavailable。

#### 后果

- Catalog “没有可选项”和“Credential 缺失/Provider unavailable/权限不足”在该入口难以区分；
- 管理员和普通用户可能看到同样的死路提示；
- 前端再次承担组合判断。

#### A/B/C

- A：在前端根据 Catalog reason 拼接提示。快，但规则分散。
- **B（建议）：扩展现有 Product readiness，而不是建立新服务**；返回状态、reasonCode、
  recoveryAction/route 和是否允许仅创建 Draft。
- C：所有入口统一跳转大型 Setup Center。当前可能过度设计。

### P1-09 缺少以“产品承诺”为单位的共享追踪关联

#### 当前事实

Agent Turn、Execution invocation、Model attempt、Tool call、Realtime call、Patch、Proposal、
Artifact 各自有 ID 和事件，但 Creation Copilot 与 Builder Proposal 并不总能沿同一链路关联。

#### 后果

- 一个前端动作失败时，需要跨多个集合和日志人工拼接；
- 难以建立端到端 SLO、成本和失败率；
- fake 测试容易只证明局部记录存在。

#### A/B/C

- A：增加日志字段。实现快，但日志不是状态权威。
- **B（建议）：统一 trace lineage：`productCommandId -> session/turn -> invocation/attempt ->
  provider/tool/realtime -> proposal/artifact`**，所有公开 read model 只返回安全引用。
- C：引入完整第三方分布式追踪平台。可以作为 exporter，不应代替产品事件真相。

## 6. P2：体验与维护债务

### P2-01 Main Session 缺少完整生命周期管理

当前已有新建、选择、分页和状态分组，但未形成清晰的 rename、archive、delete、search/filter
生命周期。Session 越多，左侧任务栏越难使用。

- A：只增加 archive；
- **B（建议）：rename + archive + search，delete 仅在明确审计/保留策略后开放**；
- C：引入文件夹/标签/共享 Session，当前过度。

### P2-02 Skill Creation Session 刷新后不能稳定恢复

Creation Session ID 主要保存在组件 ref；刷新通常重新开始。设计允许首版不恢复，但在长语音/
多轮梳理场景下会成为明显体验损失。

- A：保持临时不可恢复并明确提示；
- **B（建议）：URL 或安全 session storage 只保存 opaque sessionId，服务端重新校验 principal、
  TTL 和状态后恢复**；
- C：把它长期显示在 Main Agent Session rail，不建议混淆对象。

### P2-03 文字模型与 Realtime 模型双选择对普通用户过于技术化

独立选择在架构上准确，但普通用户不一定理解为什么“助手模型”和“语音模型”不同。

- A：保留两个显式 picker；
- **B（建议）：默认只显示“助手模型”，系统根据 Catalog/Policy 选择兼容 Realtime profile，
  高级设置再允许分开选择**；
- C：强制同一 Profile 同时具备文字和 Realtime 能力，会不必要地减少可选模型。

### P2-04 Builder “助手”命名与实际一次性 Proposal 语义不匹配

如果 P1-03 暂不实施，应先用文案明确其作用是“根据一条指令生成待审查修改”，避免用户期待
持续聊天历史。这是低成本但必要的诚实降级。

### P2-05 结构化输入仍有可进一步自动化的空间，但不应被聊天取代

材料、参数、产物、Runtime、Tool、Connection、预算和发布属于可验证契约。建议让 Agent
自动提出字段 Patch、自动绑定已有 Resource/Connection、只突出缺失项；最终仍由结构化界面
展示并确认。

### P2-06 错误和不可用状态需要统一恢复动作，而不只是禁用原因

部分入口已经有 reasonCode/readiness，但某些 Model/Agent 入口仍主要显示“没有可用模型”或
HTML `title`。移动端不可依赖 hover title。建议统一：一个原因、一个当前用户可执行动作、
一个安全诊断引用。

### P2-07 Session 状态命名在用户层和内部层之间仍需明确映射

内部存在 queued、running、waiting_review、blocked、failed、cancelled 等状态；用户层应区分
“等待资源”“等待当前任务完成”“等待用户确认”“缺少配置”，而不是全部显示成“排队/阻塞”。
这应由后端 reasonCode + state projection 提供，前端只负责文案。

### P2-08 兼容路径和新主路径需要明确移除条件

仓库中仍保留 legacy daemon、兼容启动器、旧 Preflight 组件和历史文档。当前已经通过默认拒绝、
release allowlist 或不被主 UI 消费来隔离，但需为每条兼容路径记录 owner、允许场景、删除条件
和测试，防止下一轮前端改造误接回旧控制链。

## 7. P3：明确延后或需要更多证据的方向

以下项目不应进入当前 P0/P1 修复范围，但需要在架构师 Review 中确认边界：

1. **真实 Remote Device/Fleet**：当前只有 adapter/loopback，设备注册、mTLS、升级、配额、
   NAT 和舰队调度仍明确不在本轮；
2. **外部消息队列和多机调度**：单机 Product-owned admission 足以作为下一步；
3. **向量 Memory/RAG**：当前 Mongo 强过滤与治理 Memory 是权威，embedding adapter 可继续预留；
4. **跨用户共享 Agent transcript**：当前产品决定是每个用户独立 Session/branch，不应因协作需求
   恢复成共享 transcript；
5. **Session fork/branch UI**：PI 能力不等于产品需求，需要真实使用证据；
6. **自动 Agent 发布/自动应用 Proposal**：继续保持明确人工 review，不因 Copilot 能力增强而放开；
7. **完整 Setup Center**：先复用 readiness recovery，只有配置面持续增多时再平台化；
8. **外部 tracing 平台**：可做 exporter，但 Product event/invocation 仍是审计真相；
9. **Flowgram 657 KB deferred chunk**：是 Builder 性能债务，不是 Agent 控制链 P0；
10. **真实 OCR、旧 DOC/XLS、宏处理**：继续明确 blocked，不允许宿主 fallback。

## 8. 三条总体演进路线

这三条是供架构师比较的总体方向，不代表本文已经选择。

### 方案 A：局部修补，保持现有多个 Service

#### 做法

- 修复 5000 条消息查询；
- 为 Skill Creation 增加本地 mutex/generation check；
- 为 observer 增加 Creation 特例；
- 为 Builder 改名；
- 为 Execution Broker 加进程级 semaphore。

#### 优点

- 改动最小、短期风险低；
- 能较快解除部分 P0。

#### 缺点

- Main Agent、Creation、Realtime、Builder 继续各自维护生命周期；
- 每个新 Agent 化入口继续复制治理逻辑；
- observer 特例和本地 mutex 容易成为永久兼容层；
- 无法根治跨 Session admission、Context Capsule 和 trace lineage。

#### 适用条件

仅适合作为紧急止血，不适合作为长期目标架构。

### 方案 B：共享会话协调层，保留产品 Session 差异（本文建议交由架构师优先评审）

#### 做法

新增内部 `ConversationTurnCoordinator` 与 `AdmissionController`，但不合并产品对象：

```text
MainAgentSession -----------\
ModuleAgentSession ----------> ConversationTurnCoordinator
SkillCreationSession -------/     -> FIFO / generation / model pin
                                    -> admission / abort / fence
                                    -> context capsule / trace lineage
                                    -> Execution Broker / Realtime Adapter

Loop Builder after Draft ------> loop_creator ModuleAgentSession
Staged Loop before Draft ------> Creation/Proposal lifecycle
```

#### 优点

- 解决真实重复能力，而不是把不同产品对象强行统一；
- Main、Module、Creation 可共享并发、取消、上下文和审计；
- Realtime 保留专用媒体平面；
- 符合 Product API/Runner 为控制面的既有方向；
- 可以分批迁移，回滚边界清晰。

#### 缺点

- 需要先定义稳定内部契约；
- 迁移期间会同时存在旧/新路径；
- 必须避免 Coordinator 演化成新的巨型 Service。

#### 适用条件

最符合当前单机、M5 产品和既有 Agent 平台基础，建议作为主要评审方向。

### 方案 C：统一事件流/Actor 化重构

#### 做法

把每个 Session/Run/Creation 都建模为持久 Actor 或 event-sourced aggregate，通过统一队列和
事件日志驱动全部状态变化。

#### 优点

- 并发、恢复、审计和多机扩展模型最统一；
- 长期适合复杂设备和舰队调度。

#### 缺点

- 改动面极大；
- 需要迁移当前 Store、Runner、AgentTurnRunner、Creation Service 和大量 API；
- 当前产品规模没有足够证据支持一次性重写；
- 容易延迟真实 P0 修复并引入新的状态错误。

#### 适用条件

只有真实多机、海量并发和复杂恢复需求已经出现时才值得重新评估。

## 9. 候选目标架构（基于方案 B，等待 Review）

```text
Web Feature Routes
  ├─ Main Agent
  ├─ Skill Creator / Skill Creation Copilot
  ├─ Loop Creator / Builder
  └─ Run / Library / Inbox
          |
          v
Workbench Product API
  ├─ Command validation / principal / idempotency / ETag
  ├─ Product readiness and recovery read models
  └─ Product-safe events and result readers
          |
          v
Product Session Services
  ├─ MainAgentSessionService
  ├─ ModuleAgentSessionService
  ├─ CreationSessionService
  └─ ProposalService
          |
          v
ConversationTurnCoordinator
  ├─ per-session FIFO and sequence
  ├─ active turn claim / generation fence
  ├─ cancel / timeout / late-result rejection
  ├─ model revision pin
  ├─ context capsule builder
  ├─ trace lineage
  └─ admission request
          |
          v
Product AdmissionController
  ├─ per-user / workspace / backend / provider capacity
  ├─ durable waiting state and fairness
  ├─ capacity lease and fence
  └─ queue read model
          |
          v
Execution Broker / Realtime Media Adapter
  ├─ invocation / attempt / capability lease
  ├─ deterministic skill
  ├─ model call
  ├─ bounded agent
  ├─ agent orchestrator
  └─ process / container / remote
          |
          v
Agent Runtime Core / PI / Provider / Tool Gateway
```

### 8.1 不变的边界

- Browser 不持有 Provider credential、provider payload、宿主路径或 Tool secret；
- Product Runner 仍是 Loop Run 唯一权威；
- Execution Broker 不拥有产品 Session 或 Canonical Draft；
- Module/Creation Agent 只能提出 Patch/Proposal；
- Canonical 修改仍需 Product API 校验和用户确认；
- Durable Memory、Session Context、PI compaction 保持三种不同语义；
- 每位协作者继续拥有独立 Module Session、transcript、权限和 branch。

## 10. 建议的迭代切片

该顺序只是 Review 输入，最终范围由架构师确认。

### Iteration 0：P0 真实性与止血

- 增加 Skill Creation 默认 composition 集成测试，确认/复现 observer 缺 invocation；
- 将消息查询改为真正最新 N 条；
- 对 Creation Session 增加完成前二次 status/generation/revision 检查；
- 所有未真实运行的 Gate 继续标记未验证，不改变发布结论。

### Iteration 1：统一 Creation Turn 治理

- 定义最小 `ConversationTurnCoordinator` 契约；
- Skill Creation 文字路径接入 FIFO、invocation、cancel、fence；
- Realtime call 纳入同一 Session generation/admission/event lineage；
- 保留 Creation Session TTL 和非 Canonical 语义。

### Iteration 2：上下文与多 Session admission

- 引入最新消息查询和 Product Session Context Capsule；
- 实现单机持久 AdmissionController；
- 明确 per-user/workspace/provider/container 默认上限；
- 扩展队列 read model 和指定 queued Turn cancel。

### Iteration 3：Loop/Builder 对齐

- 已存在 Loop Draft 后由 `loop_creator` Module Session 驱动多轮 Proposal；
- Draft 前 staged proposal 编辑持久化并带 revision/ETag；
- 如果多轮 Module Agent 未实施，先把 UI 改为诚实的一次性 Proposal 语义。

### Iteration 4：Session 产品化与恢复

- Main Session rename/archive/search；
- Creation Session 刷新恢复；
- readiness recovery action 对齐 Copilot/Agent/Builder；
- 状态文案使用后端 reason projection，不由前端推断。

### Iteration 5：垂直证据与生产 Gate

- Main 同 Session FIFO、跨 Session admission 并行；
- Creation text/realtime 并发、取消、迟到结果；
- 超长 Session Context Capsule；
- Loop Draft → loop_creator proposal → merge/apply；
- 真实 Mongo、Docker、Provider、Credential 环境分别出具证据；
- 代码完成、功能签收、视觉签收、生产发布保持四个结论。

## 11. 前端驱动后端的契约清单

后续每增加一个“Agent/助手”交互，开发前应回答以下问题：

1. 这是 Main、Module、Creation、Worker，还是一次性 Proposal？
2. Session 作用域、owner、TTL 和唯一真相源是什么？
3. 同 Session 输入是 FIFO、steer、cancel，还是允许并发？
4. 不同 Session 的并行上限由谁决定？
5. 模型 revision 在何时 pin？是否允许 fallback？
6. 是否创建 invocation/attempt/lease/event？
7. 请求取消和进程重启后如何恢复？
8. 迟到结果由什么 generation/fence 拒绝？
9. 当前上下文来自最新消息、Context Capsule、Memory 还是 Artifact？
10. Agent 输出是文本、Patch、Proposal、Artifact 还是 Canonical mutation？
11. 用户是否必须确认？冲突如何持久化？
12. 前端刷新、跨标签页和 principal 切换后是否仍正确？
13. 不可用时 reasonCode 和 recoveryAction 是什么？
14. 哪一条真实垂直测试证明用户看到的承诺？

如果这些问题不能回答，前端不应把该入口命名为 Agent，也不应宣称支持恢复、排队或执行。

## 12. 架构师需要重点 Review 的问题

1. P0-01 的默认 composition 推断是否成立，是否还有其他直接 ModelService consumer 同样受影响？
2. `ConversationTurnCoordinator` 应是 AgentTurnRunner 的抽取层，还是独立的内部 application service？
3. Admission 应位于 Coordinator、Execution Broker 之前，还是由 Broker 提供独立 admission 接口？
4. 单机阶段持久 admission 是否使用 Mongo 足够，是否需要公平/优先级策略？
5. Context Capsule 的权威 owner、版本、更新时点和回滚策略是什么？
6. Creation Session 是否需要恢复；若需要，恢复标识应放 URL 还是 session storage？
7. `loop_creator` 接入 Builder 的最小范围是什么，是否只在已有 Draft 后启用？
8. staged proposal 编辑应保存 mutable draft 还是 immutable versions？
9. Realtime 的媒体状态和 Product Turn 状态如何映射，何时计费、何时释放 capacity lease？
10. 哪些 legacy/compatibility 路径可以在本轮明确删除，哪些仍需保留？

## 13. 验证矩阵

| 风险 | 必须证明的测试/运行证据 |
|---|---|
| Creation 直调模型 | 默认 Server + Mongo + fake Provider adapter 的 composition integration |
| 同 Session 并发 | 两个客户端同时发送，严格 FIFO，只有一个 active Turn |
| 跨 Session 并发 | 在容量范围内并行，超出后 durable queued，不丢任务 |
| 迟到响应 | cancel/end/generation change 后旧结果无法写 Patch/Event |
| 长上下文 | 5001/10000 条后模型输入仍包含最新 Turn 和有效 Capsule |
| Worker 重建 | 新 PI Session 可从 Capsule + recent messages + refs 重建 |
| Realtime | 多标签配额、断开释放、旧 generation tool call 拒绝 |
| Loop Module Agent | 每用户独立 branch，Proposal review/apply/reject，冲突不改 canonical |
| Proposal 编辑恢复 | 编辑后刷新恢复同一 revision，过期/冲突明确失败 |
| 权限 | 跨用户、跨 workspace、过期 Session/lease 全部拒绝 |
| 状态投影 | queued/running/waiting_review/blocked reason 与 UI 一致 |
| 组合链 | 浏览器动作可追踪到 command/session/turn/invocation/result |

## 14. 当前可确认、推断和未验证结论

### 已确认

- Main Agent 的 per-session FIFO 已由 AgentTurnRunner 和 Mongo 原子 claim 实现；
- 不同 Session 可由独立 scheduler 并行；
- 一个 Turn 内可以并行启动多个 Worker；
- Main/Module Session 按 user/workspace/object/branch 隔离；
- Skill Creation 文字调用没有通过 Execution Broker；
- Skill Creation 文字路径没有与 Main Agent 等价的持久 active Turn claim/fence；
- Mongo 消息读取存在“最早 5000 条后再取最后 100 条”的错误；
- `loop_creator` 后端定义存在，当前前端主路径未消费；
- staged Loop proposal 的人工编辑在 commit 前主要是前端本地状态；
- 当前没有统一多 Session admission/backpressure。

### 高可信推断

- 默认真实 Mongo composition 的 Skill Creation 文字调用可能因缺失 invocation 而在 Provider
  请求前失败；
- 多标签并发 Creation message 可能同时执行并产生基于同一旧 revision 的结果；
- 多 Session/Realtime 高并发在单机上可能造成资源争抢和不透明 429/容量失败。

### 环境未验证

- 真实受治理文字模型与 gpt-realtime-2.1 的端到端调用；
- 认证 Mongo 下上述 composition 问题的实际表现；
- Docker Worker/Material/Attachment 的完整真实运行；
- 真实 Credential Driver/Connection probe；
- 完整 Ready Loop → Agent Session → Turn/Worker → Result Reader 轨迹；
- 当前 M5 页面与 390px 关键帧的最新人工视觉签收。

## 15. 证据索引

主要代码证据：

- `domains/backend/code/workbench-server/src/agents/agent-turn-runner.mjs`
- `domains/backend/code/workbench-server/src/agents/mongo-agent-persistence.mjs`
- `domains/backend/code/workbench-server/src/agents/product-agent-executor.mjs`
- `domains/backend/code/workbench-server/src/execution/execution-broker.mjs`
- `domains/backend/code/workbench-server/src/execution/model-service.mjs`
- `domains/backend/code/workbench-server/src/execution/mongo-execution-persistence.mjs`
- `domains/backend/code/workbench-server/src/skills/skill-creation-service.mjs`
- `domains/backend/code/workbench-server/src/server.mjs`
- `domains/frontend/web/code/web-prototype/src/state/agents/useMainAgent.js`
- `domains/frontend/web/code/web-prototype/src/components/agents/AgentSessionRail.jsx`
- `domains/frontend/web/code/web-prototype/src/components/skills/SkillCreationCopilot.jsx`
- `domains/frontend/web/code/web-prototype/src/components/loops/CreateLoopView.jsx`
- `domains/frontend/web/code/web-prototype/src/components/templates/TemplatesBuilderView.jsx`
- `domains/frontend/web/code/web-prototype/src/state/useWorkbenchWorkspace.js`

参考但未被本文件替代的现有资料：

- `wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md`
- `wiki/design/skill-loop-cloud-workbench-v1/m5/README.md`
- `docs/superpowers/specs/2026-07-16-pi-agent-execution-platform-design.md`
- `docs/superpowers/specs/2026-07-31-skill-creation-realtime-copilot-design.md`
- `wiki/qa/2026-07-25-m5-ux-restructure-qa.md`
- `wiki/qa/2026-07-25-m5-ux-restructure-code-review.md`

---

本文件只负责把问题、证据、影响和候选方向放在同一张图上。架构师 Review 后，应另行形成
批准结论；未经 Review 的候选目标架构和迭代顺序不得被描述为已经实现或已经决定。
