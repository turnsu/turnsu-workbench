# Backend / Agent Slice 0–4 单机生产加固设计

- 日期：2026-07-16
- 状态：设计已确认，实施与生产验收待完成
- 目标部署：单台 macOS 长期稳定运行
- 发布状态：NO-GO；只有本文定义的门全部通过后才可改为 GO
- 适用范围：`domains/backend`、`domains/agent` 与非前端运维配置
- 前端边界：`domains/frontend/**` 保持归一化基线零变更

## 1. 背景与证据

本设计用于关闭以下两份审查中确认的生产阻断项：

- [Backend / Agent Slice 0–4 独立代码审查](../qa/2026-07-16-backend-agent-slices-0-4-independent-code-review.md)
- [Backend / Agent Slice 0–4 生产就绪审查](../qa/2026-07-16-backend-agent-slices-0-4-production-readiness-review.md)

当前仓库已经具备 Slice 0–4 的部分契约、持久化结构、adapter 和单元测试，但这不等于生产能力已经闭合。已确认的主要断点是：默认 Agent Turn 没有执行器、AgwaB 没有进入默认产品执行链、Memory 自动提升信任调用方自述、Agent sandbox 没有可构建 worker image、取消与完成可能产生分裂终态、Remote 输出采用黑名单清理，以及缺少可部署、可观察、可恢复的单机运行单元。

本文将这些缺口收敛为一个可验收的单机生产设计。它不以 mock、文件存在、接口存在或单元测试通过替代真实调用链证据。

## 2. 目标与非目标

### 2.1 本轮目标

1. 在单台 macOS 上交付可安装、可启动、可升级、可回滚的 Workbench Host Daemon。
2. 默认 Product composition 能真实执行 Main、Skill Creator 和 Loop Creator Turn。
3. Product Runner / AgentTurnRunner 保持产品状态权威，Execution Broker 保持 Worker 调度权威。
4. Pi 与 AgwaB 只能在受限容器内作为执行引擎工作，不能形成第二套产品控制面。
5. Mongo 成为 Session、Execution、Proposal 和 Memory 的唯一耐久状态源，并支持事务、备份与恢复。
6. Memory、Remote、Gateway 和 artifact 都采用显式信任边界与 allowlist。
7. 使用真实 Mongo、真实 Docker、受控模型和真实 Provider smoke 完成生产放行验证。

### 2.2 明确非目标

- 不实现真实第二台设备、设备注册、mTLS、公网中继、NAT 穿透、升级、配额或舰队调度。
- 不实现云端多租户部署、Ingress 或跨机器高可用。
- 不实现向量检索，也不自动把长期 Memory 发送给外部模型。
- 不修改前端，不修改系统 Node，不推送远端。
- 不允许 Docker 不可用时回退到宿主机执行不可信脚本或 Agent。

## 3. 已选择的部署架构

采用 **Host Daemon + Docker Sandbox + Mongo 单机 Replica Set**：

```text
Frozen Web / Product Client
          |
          | 127.0.0.1
          v
Workbench Host Daemon
|- Product API
|- AgentTurnRunner
|- WorkflowRunner
|- Execution Broker
|- Product Memory Service
`- Model / Tool Gateway
          |
          |-- Authenticated Mongo single-node replica set
          |
          `-- Docker sandboxes
              |- Script image
              `- Agent image (Pi / AgwaB)
```

Workbench Server 继续只监听 `127.0.0.1`。应用不放入拥有 Docker socket 的容器；宿主 daemon 直接启动受限 worker container。Mongo 和 Worker 使用 Docker，但产品控制面、Provider 凭证与 Gateway 留在宿主机。

## 4. 所有权与唯一真相源

| 能力 | 唯一所有者 | 不拥有的责任 |
|---|---|---|
| 外层 Loop Run、固定图、review、retry、最终结果 | `WorkflowRunner` | 不管理 Worker 传输 |
| Session、Turn FIFO、Turn 最终响应 | `AgentTurnRunner` | 不直接运行 Pi 或修改 Canonical Object |
| invocation、attempt、lease、fence、Worker/child 调度 | `ExecutionBroker` | 不宣告外层 Run 或 Agent Session 的业务成功 |
| 长期记忆与提升策略 | `ProductMemoryService` | 不拥有 Pi Session compaction |
| Canonical Skill / Loop | 对应 Product Store | proposal 不是 Canonical 数据 |
| Provider 与 Connection 凭证 | Host Gateway / Keychain | 容器和 Remote backend 不持有凭证 |

任何 Pi Session、AgwaB run、worker process 或 Remote transport 都只是一次产品 invocation 的执行载体。

## 5. Agent Session、Turn 与个人分支

### 5.1 Scope

- Main Session：`user x workspace`
- Module Session：`user x workspace x definition x object x branch`
- 内置 Definition：`main`、`skill_creator`、`loop_creator`

同一 Draft 的不同协作者拥有不同 Session、transcript、权限 lease、Pi 执行状态和临时 branch。不存在绑定业务对象并由多人共享历史的 Module Agent。

同一用户对同一 Module Object 默认复用自己的唯一 active branch。显式 `branchId` 用于恢复该用户已有 branch；active branch 被合并或放弃后才能创建新的 active branch。唯一索引与幂等键必须阻止并发创建两个 active branch。

### 5.2 Turn concurrency

```text
Agent Session
  -> Turn 1 (running)
       -> Worker A ----+
       -> Worker B ----+ parallel
       -> Worker C ----+
  -> Turn 2 (queued)
  -> Turn 3 (queued)
```

- 同一 Session 同时只有一个 running Turn，后续 Turn 按 FIFO 执行。
- `steer` 只追加到当前 Turn，不创建并发 Turn。
- 一个 Turn 内允许多个 Worker 并行。
- 不同用户、Session、Run 可以并行。

### 5.3 Context continuity

Mongo 保存产品可见 transcript、Context Capsule、artifact/evidence 引用和 compaction checkpoint。每个 Turn 在独立容器内创建 Pi Engine；完成后只保存用户消息、Agent 输出、治理后的工具结果、摘要和引用，不保存隐藏推理。

后续 Turn 使用最近 Capsule、有限近期消息和经过授权的 Durable Memory 重建上下文。产品不依赖常驻 Pi 进程保持 Session，因此服务或 Docker 重启后可以恢复，也不会共享不同用户的 Pi Session。

### 5.4 Proposal V2

Module Agent 只能产生 `AgentObjectProposalV2`：

```text
objectType: skill_draft | loop
objectId
branchId
baseVersion
structuredOperations
evidenceRefs
validationResult
status: proposed | conflicting | accepted | rejected | superseded
```

新 Agent 流程使用统一 `agent_object_proposals` 存储；旧 `builderProposals` 保持只读兼容，不重写历史。Canonical Skill/Loop 仍是唯一业务真相源。

应用 proposal 时使用 base、branch proposal 与当前 canonical 三方比较：非重叠修改自动 rebase、重新编译和验证；同路径不同修改持久化为 `MergeConflict`，Canonical Draft 不变。Agent 可以提出合并建议，但不能静默覆盖。

Handoff 只同步目标、已确认决策、风险、对象版本以及 artifact/evidence 引用，不复制 Module transcript，不携带另一个 Session 的权限。

## 6. Execution Broker 与 AgwaB

### 6.1 控制链

```text
Product API / AgentTurnRunner / WorkflowRunner
  -> Product-owned Execution Broker
  -> deterministic_skill | bounded_agent | agent_orchestrator
  -> process | container | remote adapter
```

默认 composition 必须创建真实 `ProductAgentExecutor`，把 Turn 的 Session、workspace、actor、branch、capabilities、limits 和 result schema 转成 `ExecutionRequest`。缺少执行器不再是正常默认状态。

### 6.2 Execution modes

- `deterministic_skill`：运行固定 Skill 或可信后端函数，不创建 Pi Session，不调用模型。上传脚本和任何不可信二进制仍必须进入 Script sandbox。
- `bounded_agent`：独立 Pi Worker，固定目标、模型预算、最大步数、工具 allowlist、权限 lease 和输出 Schema。
- `agent_orchestrator`：AgwaB 只能在当前固定外层节点内部生成动态 children；不得修改外层 Loop 图。可复用的动态方案只能形成下一版 Loop proposal。

### 6.3 Authoritative state machine

```text
queued -> leased -> running
  -> succeeded | partial | blocked | failed
  -> timed_out | cancelled | sandbox_unavailable
```

Mongo 使用单节点 Replica Set，以事务原子提交 attempt、invocation、lease 撤销、fence 校验和终态事件。重试创建新 attempt 并增加 fence。旧 attempt 的迟到事件或结果必须被拒绝并留下审计事件。

取消顺序固定为：

```text
cancellation_requested
  -> revoke capability lease
  -> interrupt worker and children
  -> commit cancelled terminal state
  -> fence rejects late results
```

取消与成功竞争时，以事务中第一个合法终态为准，另一方得到 `terminal_state_conflict`。pre-abort、dispatch 前、记录 child 前和终态提交前均检查 abort/fence。

### 6.4 AgwaB lifecycle

`@agwab/pi-subagent` 是 bounded worker backend；`@agwab/pi-workflow` 是 orchestrator backend。两者必须注册进默认产品执行组合。

Workflow adapter 在运行期间持续读取 AgwaB task 状态并进行差量映射。child 首次出现时立即建立产品 invocation/attempt，随后实时记录事件、checkpoint、artifact、预算和权限；不能等待父任务结束后批量补记。

child 权限必须是父级权限的严格子集。父取消级联 children。Checkpoint 保存 AgwaB `runId` 与 child 映射；重启时复用已完成 child，只恢复未完成部分。

## 7. Product Memory 信任模型

Mongo 是长期 Memory 唯一真相源。Pi compaction 只负责 Session 上下文压缩。

所有 Agent、Worker、用户输入和公共 API 都只能创建 `MemoryCandidate`。请求中的 `verified`、`canonical`、`trusted` 或 `confidence` 不能构成提升依据；公共 `submitCandidate` 永远不能直接创建 Durable Memory。

自动提升只允许走内部 `CanonicalMemoryResolver`：

```text
read canonical object from Product Store
  -> verify workspace, version and validation state
  -> derive and hash evidence
  -> evaluate sensitivity and policy
  -> create DurableMemory and audit event
```

只有来源为当前 Canonical Skill/Loop、验证通过、证据可由服务器重新读取、低敏感且 policy 允许的事实才可自动提升。Worker 推测、失败实验、外部未验证内容、原始 transcript、未治理 Tool 返回和 Agent 自述只能保持 Candidate 并等待人工审批。

作用域规则：

- `personal`：仅本人读取、审批和删除。
- `object`：按对象读取/修改权限控制。
- `workspace`：成员按授权读取，owner/admin 才能审批和删除。

检索必须先做 workspace、subject、scope 和权限强过滤，再执行 text/tag/confidence/recency 排序。Context Capsule 只注入有限摘要、memory ID 和 evidence 引用。

删除和 TTL 到期都物理清除正文及派生索引，只保留不含原文的 ID/hash tombstone、原因、操作者和时间。删除过的 Memory 不得因旧 Candidate 或事件重放而复活。

## 8. Agent Sandbox 与 Gateway

### 8.1 Container boundary

Agent image 固定 Node `22.22.3`、Pi `0.80.7`、`pi-subagent 0.4.8` 和 `pi-workflow 0.8.1`，并使用 digest-pinned base image。Image label 记录协议版本、依赖版本、源码 revision 和构建时间。

运行时约束：

- `--network none`
- read-only root filesystem
- 仅 `/tmp`、`/run` 和受限 artifact 目录可写
- non-root UID
- drop all capabilities
- `no-new-privileges`
- CPU、内存、PID、文件、时间和输出限制
- 不挂载源码工作树、Mongo、Provider、Connection 或用户密钥

Artifact 离开容器前由宿主机重新计算 hash 并校验 MIME、大小和结果 Schema。

### 8.2 Stdio RPC

为避免 macOS Docker Desktop 的宿主 Unix socket 挂载差异，宿主 Execution Broker 与 Agent Container Supervisor 使用双向 framed JSON-RPC over stdin/stdout。容器内 Pi/AgwaB children 通过仅存在于容器内部的 Unix socket 连接 Supervisor，Supervisor 再复用唯一 stdio 通道。

允许的 RPC 类型只有：

```text
execution.start
model.generate
tool.invoke
artifact.commit
checkpoint.save
execution.cancel
execution.finish
```

每次模型或工具请求，Host Gateway 都重新校验 invocation、attempt、fence、capability lease、tool allowlist、模型/token/费用/步数预算、workspace/object 权限及父子权限子集。容器只得到不可复用的短期执行标识。

Pi 使用公开 API 和自定义 model transport，将模型与工具请求转换为上述 RPC。受控模型和真实 Provider smoke 使用同一 Product Executor / Gateway 链路，只替换宿主 Provider adapter。

Docker 不可用、镜像 label 不匹配或 RPC 版本不匹配时返回明确错误，不允许宿主机 fallback。

## 9. Remote adapter 边界

本轮只交付 loopback/fault-injection transport。Remote backend 不进入公开用户选项；未配置真实 transport 时返回 `remote_backend_unavailable`。

Remote 输入按事件类型 allowlist 构造：

- lifecycle：`phase`、`percent`、`messageCode`
- artifact：`artifactId`、`kind`、`contentHash`、`mediaType`、`sizeBytes`
- checkpoint：产品 checkpoint ID、sequence 和状态
- result：必须通过当前 `ExecutionRequest.resultSchema`
- evidence：只允许产品 artifact/memory/object 引用

未知字段不得进入 Mongo、SSE、HTTP 或日志。host path、socket、image、env、Provider payload、credential、stack、Remote metadata 和内部 Tool 参数全部拒绝。

Adapter 必须支持有界重排、重复去重、gap 检测、checkpoint/resume 和 cancel fencing。Terminal event 只能提交一次。

## 10. 单机运行与发布单元

### 10.1 目录与服务

```text
~/Library/Application Support/Looloomi Workbench/
|- releases/<revision>/
|- current -> releases/<revision>
|- state/
|- objects/
|- backups/
`- logs/

~/Library/LaunchAgents/
|- com.looloomi.workbench.plist
|- com.looloomi.workbench.backup.plist
`- com.looloomi.workbench.watchdog.plist
```

发布包包含固定 Node、Backend/Contracts/Agent Runtime、lockfile 安装的生产依赖、冻结前端静态文件及其基线 hash、image digest manifest、migration version、SBOM 和扫描结果。只有预检、升级前备份、migration 与 smoke 全部通过后才能原子切换 `current`。

Mongo 使用开启认证的单节点 `rs0`、固定 image digest、loopback port 和独立 named volume。Mongo、Provider 和备份密钥进入 macOS Keychain；短期 secret 文件为 `0600`，不进入仓库、日志或 container。

### 10.2 Health and observability

- `/healthz`：进程、事件循环与关闭状态。
- `/readyz`：Mongo、migration、Docker、Agent image label、Gateway、Provider 和 recovery reconciler。
- `/metrics`：仅 loopback，包含 Run/Turn 队列、lease age、attempt 时长、失败/取消/超时、fence/Gateway 拒绝、sandbox unavailable、Memory 与 Mongo 指标。
- JSON 日志：包含 request/run/session/turn/invocation/attempt 关联 ID，并在落盘前字段级脱敏。
- Watchdog：每分钟检查 readiness，连续三次失败后写入 macOS unified log 与本地告警状态。

初始单机验收预算：启动至 ready 不超过 60 秒；Mongo/Docker 重启后两分钟内恢复；支持至少 4 个并发 Session 和 8 个并发 Worker；普通本地读取 API p95 小于 250ms（不含模型时间）。

### 10.3 Backup and restore

- RPO 不超过 24 小时；RTO 不超过 2 小时。
- 每日 `mongodump`，备份流立即使用 AES-256-GCM 加密，密钥来自 Keychain。
- 每次升级/migration 前额外快照。
- 保留 7 个日备份和 4 个周备份。
- Manifest 记录时间、数据库、migration version、密文 hash 和 release revision，不记录正文。
- 默认恢复到独立临时 Mongo / `_restore_test`。
- Restore drill 必须真实解密、恢复、验证集合/索引/migration ledger，并执行 API、Session、Memory 和 Run 读取 smoke。

正式运维入口统一为 `workbench-local install|preflight|start|stop|restart|status|backup|restore|restore-drill|upgrade|rollback|diagnostics`。所有命令输出机器可读报告，任何失败不得继续切换版本或报告成功。

## 11. 生产验收与放行

以下证据全部通过前，状态保持 NO-GO：

1. 默认 composition 在不注入 mock executor 时完成 Main/Module Turn，并证明用户 Session、branch、transcript 和权限隔离。
2. Turn FIFO、Turn 内 Worker 并行；proposal 自动 rebase 与持久化冲突符合设计。
3. deterministic Skill 不创建 Pi Session；AgwaB children 运行期间实时出现在产品 timeline，取消和恢复闭环。
4. barrier 并发测试覆盖 pre-abort、取消/完成竞争、重复取消、retry、旧 fence 和重启。
5. Agent/Worker 不能伪造条件提升 Memory；作用域、TTL、删除和重启读取使用真实 Mongo 验证。
6. 真实 Docker 构建并运行 Agent image；网络、文件系统、UID、capability、资源、凭证和 no-fallback 负向验证通过。
7. Gateway 拒绝过期 lease、错误 fence、越权 Tool、预算超限和 child 权限升级。
8. Remote 恶意 payload 在 DB、SSE、HTTP 和日志中均不可见。
9. 受控模型全链路与真实 Provider smoke 走相同 Product Executor/Gateway 路径。
10. Mongo auth、migration、备份、真实 restore drill、upgrade/rollback、kill/restart 和 orphan cleanup 通过。
11. health/readiness/metrics/log redaction/watchdog、容量基线、SBOM、依赖/镜像/secret scan 通过。
12. 从归一化基线开始 `domains/frontend/**` 零变更，最终工作树清洁且未推送远端。

只有这些证据归档后，才可以把发布声明改为：

> 该版本已通过单机 macOS Host Daemon + Docker Sandbox + Mongo 单节点 Replica Set 部署模型下的生产就绪验收。

## 12. 实施顺序约束

实施必须保持以下依赖顺序，避免用运维包装掩盖核心执行链断点：

```text
truthful architecture status
  -> ProductAgentExecutor and Proposal V2
  -> atomic Broker state machine
  -> governed canonical Memory promotion
  -> buildable Agent image and stdio Gateway
  -> live AgwaB children
  -> Remote allowlist
  -> launchd/Mongo auth/backup/observability
  -> full release rehearsal and GO review
```

每一阶段都必须留下自动化证据，并在组合后的真实默认路径重新验证。旧 mock、旧 acceptance 或静态类型结构不能作为替代证据。
