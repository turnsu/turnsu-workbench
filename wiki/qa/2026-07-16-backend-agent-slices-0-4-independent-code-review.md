# Backend / Agent Slice 0–4 独立代码审查

- 日期：2026-07-16
- 审查对象：`codex/backend-agent-slices-0-4`，提交 `0365db6`
- 方法：只读代码审查与静态调用链追踪；未修改实现，也未把既有测试通过视作生产链路证明。
- 结论：**不能签收为“Slice 0–4 已完整交付”**。契约、持久化模型和多数单元测试已经存在，但核心生产执行链存在断点；必须先关闭下列 P0 问题后，再做集成验收。

> 本文补充而非覆盖同日的 [acceptance 记录](2026-07-16-backend-agent-slices-0-4-acceptance.md)。其中“code-level acceptance passed”的结论不应作为当前完成证明，直到本文列出的阻断项被修复并通过真实路径验证。

## 审查判断

| Slice | 判断 | 依据 |
|---|---|---|
| Slice 0：Pi 兼容门 | 基本完成 | Node 和依赖版本门、公开适配器及相应测试均可见。 |
| Slice 1：Execution Broker | 主体完成，未可签收 | 契约和持久化存在，但取消与完成写入有竞态，fence 语义未被严格证明。 |
| Slice 2：个人 Session / proposal | 数据模型与 API 已完成，执行未完成 | 默认产品组合没有可用的 `AgentExecutor`，实际 Turn 会进入 `blocked`。 |
| Slice 3：AgwaB 动态执行 | 未完成 | adapter 有实现和单测，但没有接入默认 Product 执行组合；child 只在父任务返回后投影。 |
| Slice 4A：Product Memory | 未完成 | 自动提升信任 Agent/Worker 自述的 `verified` 等字段，可污染 Durable Memory。 |
| Slice 4B：Agent sandbox / Gateway | 框架完成，运行交付未完成 | host adapter 存在，但仓库没有可构建 Agent image 或其 `worker.mjs`。 |
| Slice 4C：Remote adapter | 边界与 fake/loopback 基本完成 | 未含真实设备符合范围；但 remote event/result 脱敏仍需改为白名单。 |

## 阻断项（P0）

### P0-1：AgwaB backend 没有接入真实 Product 执行路径

**证据**

- `@agwab/pi-subagent` 和 `@agwab/pi-workflow` adapter 存在于 Agent domain，也有孤立单测。
- [server.mjs](../../domains/backend/code/workbench-server/src/server.mjs) 的默认 composition 只注册 deterministic backend，以及在环境变量存在时注册 container backend；没有创建或注入任何 AgwaB adapter。
- `PiKernelAdapter` 只包装常规 Pi runtime 操作，没有调度 AgwaB backend。
- workflow adapter 在父任务完成后才构造 child summaries；Broker 也在 backend 返回后才补记 child invocation。child 不会在运行期间出现在产品时间线中，也不能独立 checkpoint、fence 或被父取消即时级联。

**影响**

计划中“`pi-subagent` 作为首个 bounded worker backend”和“`pi-workflow` 作为 `agent_orchestrator` adapter”未进入产品真实调用链。现有测试不能证明动态 child 能被真实 Run 调度或观测。

**修复与验收**

1. 在 Product composition 中显式构造 AgwaB backend，并通过 `ExecutionBroker` 注册到 `bounded_agent` / `agent_orchestrator` 的确定性路由中；不要让它绕过 Product Runner。
2. child 的创建、事件、checkpoint、完成与取消必须以流式方式映射为产品 `invocation / attempt / event`，而非在父任务结束后批量投影。
3. 增加端到端测试：一个 pinned outer Loop 节点启动两个 child；两个 child 在产品 timeline 实时可见；父取消后 child 收到取消；重启后只恢复未完成 child；外层图保持不变。

### P0-2：Main / Module Agent API 默认没有执行器

**证据**

- [server.mjs](../../domains/backend/code/workbench-server/src/server.mjs) 的 `createWorkbenchComposition` 默认 `agentExecutor = null`，并把它直接传给 `AgentTurnRunner`。
- [agent-turn-runner.mjs](../../domains/backend/code/workbench-server/src/agents/agent-turn-runner.mjs) 在 executor 缺失时把 Turn 完成为 `blocked`，响应为 “Agent execution backend is unavailable.”
- 仓库中没有默认 executor 将 Main、`skill_creator`、`loop_creator` 的 Turn 接到 Agent Runtime、Execution Broker 或受控 sandbox；现有测试只注入 mock executor。

**影响**

Session、分支、FIFO、proposal merge 的数据层可用，但产品 Agent API 在默认部署中无法执行。Slice 2 不能以 API 存在或 mock 测试通过为完成。

**修复与验收**

1. 实现并默认注入产品拥有的 `AgentExecutor`：它应把 Agent Turn 交给 `ExecutionBroker` / Agent Runtime，并携带 Session、workspace、actor、branch、capability lease、预算和输出 schema。
2. 保持同 Session FIFO，允许一个 Turn 内启动多个 Worker；不同用户、Session 和 Run 仍可并行。
3. 集成测试不得注入 mock executor：创建 Main 和两个协作者 Module Session，确认 Main Turn 真正完成，两个 Module transcript / Pi Session / branch 隔离，且 Module 只能生成 proposal。

### P0-3：Agent/Worker 可以伪造条件并自动写入长期记忆

**证据**

- [product-memory-service.mjs](../../domains/backend/code/workbench-server/src/memory/product-memory-service.mjs) 的 `submitCandidate` 接受调用者提供的 `source`、`evidence` 和 `sensitivity`，并在 candidate 自己满足条件时调用自动 `#promote`。
- 同文件的 `qualifiesForAutomaticPromotion` 只检查 `source.kind === canonical_object`、`source.verified === true`、低敏感与 evidence 类型；没有由服务端重新读取 Canonical Object、验证版本/evidence，也没有拒绝 `actor.kind === agent/worker`。
- [product-memory-service.test.mjs](../../domains/backend/code/workbench-server/tests/application/product-memory-service.test.mjs) 直接用 `actor.kind: "agent"`、`verified: true` 并断言 candidate 被提升为 durable memory，证实该绕过路径。

**影响**

违反“Agent、Worker 只能提交 Candidate，不能直接写 Durable Memory”。任意 Agent/Worker 可借自述字段污染长期记忆，进而影响未来检索和模型上下文。

**修复与验收**

1. 将自动提升收敛为受信任的 server-side canonical ingestion 路径：由服务端解析 object/version/evidence，再决定是否提升；不要信任请求体 `verified`。
2. 所有 Agent/Worker 请求一律创建 `pending` candidate；只有具备明确服务身份、服务器验证 canonical revision 和 evidence hash 的写入才可按策略自动提升。
3. 增加负向测试：Agent/Worker 即使提交 `canonical_object + verified + low` 也只能得到 pending；伪造 object/version/evidence 被拒绝；经过服务端验证的 canonical 事实才能自动提升。

## 高优先级问题（P1）

### P1-1：Agent sandbox 没有可构建、可运行的 Worker 交付物

**证据**

- [agent-container-sandbox.mjs](../../domains/backend/code/workbench-server/src/runtime/agent-container-sandbox.mjs) 假定镜像内存在 `/opt/looloomi-agent/worker.mjs`，并通过 `WORKBENCH_AGENT_IMAGE` 接受外部 image digest。
- 仓库中没有 Agent image 的 Dockerfile、镜像构建脚本或该 `worker.mjs`；因此无法由仓库构建计划要求的固定 Pi / AgwaB runtime。

**修复与验收**

1. 在非前端目录添加可重现的 Agent image 定义与 worker 协议实现，固定 Pi `0.80.7` 和 AgwaB 版本，构建产物只接收只读输入与受限 artifact 输出。
2. Docker 集成门必须证明：容器无 provider/Mongo/connection/user secret、无网络、非 root、最小 capability；Gateway 拒绝越权/过期 lease/预算超限；Docker 不可用返回 `sandbox_unavailable`，绝不 host fallback。

### P1-2：取消、完成与状态持久化存在竞态

**证据**

- [execution-broker.mjs](../../domains/backend/code/workbench-server/src/execution/execution-broker.mjs) 通过 `void this.cancel(...)` 异步响应 AbortSignal，执行流仍可继续 mark-running、dispatch 和 complete。
- 完成 attempt 与完成 invocation 是分开的持久化更新；若取消落在两次更新之间，可出现 attempt `completed`、invocation `cancelled` / `cancellation_requested` 的分裂状态。
- 当前测试覆盖常规取消，但没有 pre-aborted signal 和“取消恰落在 backend 返回 / completeAttempt 前”的交织测试。

**修复与验收**

1. 将 cancel / completion 用 invocation fence 和原子条件更新收敛为单一状态机；在 dispatch 前、记录 child 前、完成写入前均检查 fence / abort 状态。
2. 添加可控 barrier 的并发测试，覆盖 pre-abort、取消与成功返回交错、重复 cancel、旧 attempt 迟到结果和 retry 后旧结果。
3. 证明最终只会有一个权威 terminal outcome，且所有迟到结果被拒绝并留下可观测 audit event。

### P1-3：Remote event/result 脱敏是黑名单，不是产品安全契约

**证据**

- [remote-execution-backend.mjs](../../domains/backend/code/workbench-server/src/execution/remote-execution-backend.mjs) 接收远端 event 的任意 `payload`，仅删除有限键名（device、host、socket、image 等）。
- 未使用允许字段 schema，因此 provider response、token、内部 tool 参数、任意文件路径可以换键名穿透到产品记录。

**修复与验收**

1. 对 event 和 result 使用按 type 定义的 allowlist schema；未知字段默认丢弃，artifact 仅接受产品生成的安全引用。
2. 用恶意 fake transport 注入 bearer token、provider payload、host path、socket、tool input 等变体，断言产品 event/result/API 无任何泄露。

## 次要观察（P2）

- Agent Session 创建/查找的并发与 branch 选择语义不够明确：持久化查找未按活跃状态和确定顺序约束；API 没有显式 branch 选择。需要明确同一用户、对象、分支是否可同时拥有多个 active Session，并用唯一索引或幂等键保护。
- Remote resume 目前主要依赖进程内 active map，尚未和产品持久化 checkpoint 的重启恢复形成闭环。该项不阻断本轮“仅边界”范围，但真实 Remote 设计前必须补齐。

## 重新验收门

只有下列证据全部具备，才可把 Slice 0–4 标为完成：

1. **真实默认 composition 测试**：不注入 mock executor，Main / Module Agent 以及 AgwaB bounded/orchestrator 均从 Product API / Runner 进入 Execution Broker，并在产品 timeline 可观测。
2. **治理安全测试**：Agent/Worker 不能自动提升 durable memory；任意伪造 canonical/evidence 被拒绝；scope、tenant、TTL 与删除 tombstone 仍正确。
3. **真实 Docker 集成**：仓库可构建 Worker image，且在真实 Docker 中完成 Gateway、网络、文件系统、凭证和 fallback 负向验证。
4. **并发状态机测试**：取消、retry、fence、迟到结果和重启恢复在可控交织下没有状态分裂或重复副作用。
5. **Remote 攻击性契约测试**：乱序、重复、断连、取消之外，还证明 event/result 不能泄漏未允许的数据。

## 审查边界

- 本次没有运行 Docker、Mongo、真实 Provider 或真实 Remote 设备；这些环境缺失项仍是部署级未验证，不可记录为成功。
- 本次未修改前端、后端或 Agent 实现；本文仅提供主线程修复与复验的依据。
