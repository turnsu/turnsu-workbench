# Backend / Agent Slice 0–4 生产就绪审查（Production Readiness Review）

- 日期：2026-07-16
- 审查对象：`codex/backend-agent-slices-0-4`，提交 `0365db6`
- 审查类型：生产发布审查。覆盖真实调用链、隔离与凭证、数据可靠性、部署、可观测性和运行验收；不以 mock 单测或文档声明替代生产证据。
- 发布结论：**NO-GO（不得作为生产版本发布）**。

本文建立在 [独立代码审查](2026-07-16-backend-agent-slices-0-4-independent-code-review.md) 之上。代码审查发现的 P0 已足以阻断上线；本审查进一步确认仓库尚未具备可重复部署、可观测、可恢复的生产运行证据。

## 适用的“生产”定义

当前架构把系统定义为 **local-first、workspace-scoped workbench**。因此需分开判断：

| 目标 | 当前结论 | 原因 |
|---|---|---|
| 单机、本地受信任环境试用 | 有条件 NO-GO | 默认 Agent Turn、AgwaB、Memory 自动提升存在实质性 P0，先修复才可受控试用。 |
| 单机、长期稳定运行 | NO-GO | 没有完整的 Worker 交付物、真实 Docker/Mongo 恢复证据与运行监控。 |
| 云端/多租户生产 | NO-GO | 目前服务绑定 loopback，缺少应用部署产物、TLS/Ingress、密钥治理、备份恢复、SLO/告警和容量/故障演练。 |

这不否定已有代码价值：当前实现可作为开发集成基线；但它不是可签收的 production release。

## 已确认事实、未验证项与推断

| 类别 | 结论 | 证据 / 限制 |
|---|---|---|
| 已确认 | Node、Pi 和 AgwaB 版本门及部分 Product 契约、迁移、单元测试存在。 | 源码与同日 acceptance 记录。 |
| 已确认 | 默认服务在启动时监听 `127.0.0.1`。 | [server.mjs](../../domains/backend/code/workbench-server/src/server.mjs) 的 `startWorkbenchServer`。 |
| 已确认 | compose 仅定义一个单节点 Mongo 服务；没有 Workbench 应用服务。 | [docker-compose.yml](../../docker-compose.yml)。 |
| 已确认 | Store 有内部 `health()`，HTTP 层没有可供编排器使用的 `/healthz` / `/readyz`；请求 ID 和审计记录存在，但没有 metrics/tracing/exporter。 | [product-mongo-store.mjs](../../domains/backend/code/workbench-server/src/store/product-mongo-store.mjs)、[workbench-http-handler.mjs](../../domains/backend/code/workbench-server/src/http/workbench-http-handler.mjs)。 |
| 已确认 | Agent sandbox host adapter 要求外部 `WORKBENCH_AGENT_IMAGE`，但仓库无 Agent image Dockerfile 和镜像内 `worker.mjs`。 | [agent-container-sandbox.mjs](../../domains/backend/code/workbench-server/src/runtime/agent-container-sandbox.mjs)。 |
| 未验证 | Mongo 迁移、重启读取、备份/恢复、真实 Docker 隔离、Provider Gateway、Remote transport。 | 同日 acceptance 已明确 Docker/Mongo/Provider/real Remote 未运行；本次未将其计为通过。 |
| 推断 | 任何对外或多副本部署都会在 readiness、secret rotation、请求关联、容灾和并发恢复上存在显著运维风险。 | 由上述缺少部署与运行证据推得，须在预发用演练验证。 |

## 不可豁免的发布阻断项

### R0-1：真实 Agent 执行链未闭合

**现象**：默认 `AgentTurnRunner` 得到的是 `null` executor；实际 Turn 会被标记为 `blocked`。AgwaB `pi-subagent` / `pi-workflow` adapter 没有接入默认 Product composition，动态 child 仅可在父任务返回后被补记。

**生产风险**：用户能够创建 Session 或启动流程，却无法得到真实 Agent 结果；即使 adapter 单测通过，也无法对 Product API / Runner 的执行、取消、审计和恢复负责。

**上线前证据**：

1. 在不注入 test mock 的进程中，从 Product API 创建 Main/Module Turn，得到 `completed` 或可区分的 `blocked` / `failed` / `cancelled`，不能是缺 executor 的假阻塞。
2. 在同一外层 Run 内实时观测两个 AgwaB child 的 invocation、attempt、event、checkpoint 和 artifact；取消父级后 child 立即中断；重启后只恢复未完成 child。
3. 证明 Module 的独立 branch/transcript/lease 不会污染另一协作者或 canonical Draft。

**状态：阻断。**

### R0-2：长期 Memory 可被 Agent/Worker 伪造后自动提升

**现象**：Memory service 接受调用者声明的 canonical/verified/evidence 字段。当前单测证实 `actor.kind: "agent"` 可得到 `promoted` Durable Memory。

**生产风险**：未验证推测、恶意工具输出或提示注入可成为长期产品记忆，之后跨 Turn 影响决策；这是跨用户、跨时间的信任边界失效。

**上线前证据**：

1. Agent/Worker 请求永远只能创建 `pending` candidate，包含伪造 `verified`、对象版本和 evidence 的请求也不例外。
2. 自动提升只能通过服务端 canonical resolver 完成：服务器必须读取 canonical revision、验证版本与 evidence hash、写 audit event。
3. 在独立 Mongo `_test` 数据库验证 scope/tenant 拒绝、TTL 清理、物理删除和无正文 tombstone；再在预发真实 Mongo 重启后复验。

**状态：阻断。**

### R0-3：受控 Agent sandbox 没有可部署的运行产物

**现象**：host adapter 可以验证一个外部 digest image，却没有可从仓库构建、签名或复现的 Agent image，也没有其 `worker.mjs` 协议实现。

**生产风险**：运行时只能依赖不可审计的外部镜像；无法证明 Pi/AgwaB 版本、无密钥、无网络、只读输入和受限输出在真实容器里成立。

**上线前证据**：

1. 交付一个可重现构建的、digest-pinned Agent image，以及可版本化的 worker/Gateway 协议。
2. 在 CI 及预发真实 Docker 中证明 container 无 Provider、Mongo、Connection、用户凭证或源码工作树；网络关闭、非 root、cap drop、no-new-privileges、资源限制和输出限制均有效。
3. Gateway 必须对每次模型/工具请求验证 invocation、attempt、lease、父子权限子集、tool allowlist 和预算；Docker 不可用只能返回 `sandbox_unavailable`。

**状态：阻断。**

### R0-4：取消与完成竞争时无法证明单一权威结果

**现象**：AbortSignal 通过异步 `cancel()` 发起，随后执行仍可能走到完成持久化；attempt 与 invocation 用分开的条件更新写入。

**生产风险**：超时/取消/retry 时可能出现 `completed` attempt 与 `cancelled` invocation 并存，迟到副作用或结果可越过期望 fence。

**上线前证据**：

1. 状态机以原子条件更新和 fence 保证一个 invocation 只有一个权威 terminal outcome。
2. 用 barrier 测试覆盖 pre-abort、backend 返回与 cancel 交错、重复 cancel、retry 后旧结果和重启恢复。
3. 预发压测中采集每次取消的取消请求、lease 撤销、worker stop、fence 拒绝和 terminal event；不得出现状态分裂。

**状态：阻断。**

## 生产发布高风险项（P1）

### R1-1：没有可运行的应用部署单元

**事实**：根目录 compose 只部署单节点 Mongo。没有 Workbench server 的 Dockerfile、部署清单、镜像发布流程或环境配置契约；服务启动代码固定监听 `127.0.0.1`。

**需要补齐**：

- 选择并写明部署形态：单机 local daemon，或云端 Service/Ingress。两者配置与安全边界不同，不应混用。
- 若为云端：应用镜像、非 root 运行、只读根文件系统、TLS/Ingress、受限 egress、resource requests/limits、滚动升级和跨副本 session/lease 行为必须有可执行配置。
- 若为本地：安装包/启动器、数据目录权限、升级/回滚、磁盘阈值、Docker 依赖诊断与本地备份恢复流程必须有可执行 runbook。

**状态：阻断云端生产；阻断长期本地运行签收。**

### R1-2：可观测性不足以运营 Agent/Workflow 系统

**事实**：HTTP response 中存在 request ID，存储层存在 audit event，且仅在 `WORKBENCH_PROOF_DIAGNOSTICS=1` 时打印部分内部错误。未见公开 liveness/readiness、结构化日志规范、trace propagation、metrics 或告警规则。

**需要补齐**：

- `/healthz` 只反映进程存活，`/readyz` 必须检查 Mongo、迁移版本、必需 image/Gateway/Provider readiness，不得泄露内部细节。
- 结构化日志与 trace：关联 `requestId`、runId、sessionId、invocationId、attemptId；敏感字段必须脱敏。
- 指标与告警：Run/Turn 队列深度、lease age、attempt 时长、失败/超时/取消率、fence 拒绝、Gateway 拒绝、sandbox unavailable、Memory promotion/rejection、Mongo 连接与迁移失败。
- 定义 SLO、错误预算、on-call 响应级别和事故 runbook。

**状态：阻断生产运维签收。**

### R1-3：数据耐久性与迁移恢复尚无生产证据

**事实**：迁移代码、checksum 与锁测试存在；compose 使用一个 Mongo 7 实例和一个 volume。没有备份、PITR、恢复演练、多副本/故障切换或迁移 rollout/rollback 证据。

**需要补齐**：

- 明确 RPO/RTO；为 Mongo 配置备份、加密、访问控制与恢复验证。单节点 Mongo 不等于容灾。
- 在预发真实数据库执行 `003-agent-execution-fabric`、`004-product-memory`：校验索引、唯一性、锁、旧数据兼容、失败中断和重试。
- 进行至少一次 restore drill：恢复后 Run、execution events/checkpoints、agent turns、memory tombstones 和审计链可读且无重复执行。

**状态：阻断需要耐久性承诺的生产发布。**

### R1-4：Remote data egress 脱敏策略不够强

**事实**：Remote adapter 主要按有限键名删除 transport/device/path 信息，event/result payload 不是按类型白名单构造。

**需要补齐**：

- event 和 result 使用 allowlist schema；未知字段默认删除，artifact 只允许产品安全引用。
- 用恶意 fake remote 注入 bearer token、Provider 回复、任意 host path、socket、内部 tool 参数及字段变体；验证 DB、SSE、HTTP 读取模型、日志均无泄露。

**状态：在 Remote 后端正式启用前阻断。**

## 发布流水线与环境验收矩阵

下列项必须是自动化或可复验产物，而非人工口头确认。

| 门 | 环境 | 最低证据 | 当前状态 |
|---|---|---|---|
| 静态/单元 | CI | lockfile、lint/contract/unit、secret scan、依赖/SBOM 与 image vulnerability scan | 部分已有；安全供应链证据未见。 |
| Mongo 迁移 | CI + 预发 | 新旧数据、索引、checksum lock、失败恢复和 restore drill | 单元存在；真实 Mongo 未验证。 |
| Agent 主链路 | CI / 预发 | 不使用 mock 的 Main/Module/AgwaB 端到端路径 | 失败：默认 executor/AgwaB 未接入。 |
| Sandbox / Gateway | CI + 预发 Docker | image build、digest、无 secret/no-network、Gateway 正负向、取消清理 | 失败：image/worker 缺失；真实 Docker 未验证。 |
| 并发与恢复 | 预发 | cancel/retry/fence、进程 kill、重启、重复事件、worker orphan cleanup | 部分单测；关键竞态未验证。 |
| 性能与容量 | 预发 | 并发 Run/Turn、队列背压、Mongo 压力、容器资源与 p95/p99 | 未验证。 |
| 安全 | CI + 预发 | authz/tenant 隔离、Memory 提升、日志/SSE 脱敏、依赖/镜像扫描 | 失败：Memory P0；其余未完整验证。 |
| 可观测性 | 预发 | health/readiness、metrics、trace、dashboard、告警演练 | 未实现/未验证。 |
| 灰度与回滚 | 预发 / 生产 | 版本兼容矩阵、canary、撤回/rollback、数据迁移退出条件 | 未实现/未验证。 |

## 可执行的放行顺序

1. **先关闭 R0-1 至 R0-4。** 修复默认 AgentExecutor/AgwaB 接入、Memory 信任边界、可构建 sandbox、取消状态机；每项以真实调用链集成测试证明。
2. **确定部署模型。** 在 local-first 单机和云端多租户之间选择一个本次要承诺的目标；再实现相应的部署、安全与运维配置。不能用 loopback daemon 的完成度替代云端交付。
3. **建立预发环境。** 独立 Mongo、真实 Docker、最小 Provider/Gateway 凭证、隔离 workspace/tenant，并运行迁移、恢复、容器和负向安全测试。
4. **补可观测性与 runbook。** Health/readiness、日志/trace、指标/告警、故障/恢复/密钥轮换/回滚手册必须随版本交付。
5. **执行 release rehearsal。** 从零部署、迁移、冒烟、并发压测、kill/restart、restore、灰度与 rollback；保留命令、版本 digest、测试报告和时间戳。
6. **由负责方签字。** Security、数据/平台、Agent Runtime、产品各自确认其门已通过；未验证项不得标记为 pass。

## 可接受的发布声明

在所有 R0 和相应 R1 关闭前，唯一准确的表述是：

> “Backend / Agent Slice 0–4 的开发基线和部分契约测试已完成；它尚未通过生产就绪验收，不能作为生产部署或多租户运行的完成声明。”

只有验收矩阵全部满足、并且真实部署环境证据归档后，才可替换为：

> “该版本已通过既定部署模型下的生产就绪验收。”

## 审查边界

- 本文不把 Docker daemon 不可用、Mongo 未配置、真实 Provider 未调用、无真实 Remote 设备解释为通过或可忽略。
- 本次未修改应用实现、部署配置或数据；本文是主线程修复、预发验证和上线决策的输入。
