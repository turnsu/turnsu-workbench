# Backend / Agent Slice 0–4 单机生产加固实施计划

- 日期：2026-07-17
- 状态：执行中
- 设计依据：[单机生产加固设计](../architecture/2026-07-16-backend-agent-local-production-hardening-design.md)
- 审查输入：[独立代码审查](../qa/2026-07-16-backend-agent-slices-0-4-independent-code-review.md)、[生产就绪审查](../qa/2026-07-16-backend-agent-slices-0-4-production-readiness-review.md)
- 分支：`codex/backend-agent-slices-0-4`
- 前端基线：`1ba9916:domains/frontend`，tree `d6aa607bab850e6f30a2c92c4823896806871937`

## 1. 执行原则

1. 只修改 Backend、Agent、根级运维配置和权威文档；`domains/frontend/**` 零变更。
2. 每个工作包先增加能够失败的契约/负向/并发测试，再修改实现。
3. 默认 composition 和真实运行路径是验收对象；mock 只用于单元隔离，不作为完成证据。
4. Mongo 测试只使用显式 `_test` 数据库；运行文件只写临时目录或正式本机应用目录。
5. 每个工作包独立提交；组合后重新运行完整基线和真实 Docker/Mongo 验收。
6. 所有失败、blocked、cancelled、timeout、sandbox/remote unavailable 必须可区分，不允许静默降级。

## 2. 工作包与依赖

```text
WP1 Product Agent + Proposal V2
  -> WP2 Atomic Execution State
  -> WP3 Canonical Memory
  -> WP4 Agent Image + Stdio Gateway
  -> WP5 AgwaB Live Children
  -> WP6 Remote Allowlist
  -> WP7 Local Production Operations
  -> WP8 Release Rehearsal and GO Review
```

WP1–WP3 建立产品状态权威；WP4–WP5 才接入真实 Agent 执行；WP7 不能提前把未闭合能力包装成生产服务。

## 3. WP1：默认 ProductAgentExecutor、个人 Branch 与 Proposal V2

### 3.1 先写测试

- 扩展 `tests/agents/agent-turn-runner.test.mjs`：
  - 默认 executor 生成真实 `ExecutionRequest`。
  - 同用户/对象复用唯一 active branch；显式错误 branch 被拒绝。
  - 两用户同 Draft 的 branch、transcript、权限隔离。
  - Main 与 Module 使用不同结果 Schema；Module 不能直接写 Canonical Draft。
- 扩展 `tests/server.test.mjs`：默认 composition 中 `agentExecutor.execute` 存在。
- 新增 `tests/agents/product-agent-executor.test.mjs`：Main、Skill Creator、Loop Creator，Turn 内并行 workers、blocked 状态、handoff 和 proposal 输出。
- 扩展 HTTP/contract 测试：`branchId` 恢复与 `AgentObjectProposalV2` 读取/接受/拒绝。
- 扩展 Mongo integration：并发创建相同 active branch 只产生一个结果。

### 3.2 实现文件

- 新增 `src/agents/product-agent-executor.mjs`：把 Turn 转为一个受限 container `ExecutionRequest`，校验 `AgentTurnOutput`，并保存 proposal/handoff。
- 新增 `src/agents/agent-proposal-service.mjs`：统一 Skill/Loop Proposal V2、三方 merge、编译/验证与冲突持久化。
- 修改 `src/agents/agent-turn-runner.mjs`、`mongo-agent-persistence.mjs`、`agent-persistence.mjs`：显式 branch 恢复、唯一 active branch、Context Capsule checkpoint。
- 修改 contracts：`agents.ts`、`agent-http.ts`、`index.ts`，增加 Proposal V2 与 branch 请求字段/端点。
- 新增 migration `005-agent-proposals-and-active-branches.mjs`，增加 `agent_object_proposals`、必要索引和 migration 注册。
- 修改 `product-mongo-store.mjs`、`constants.mjs`、`server.mjs`、`workbench-application.mjs`、HTTP handler 完成默认注入与 API 路由。

### 3.3 完成门

- 默认 composition 不再产生 `agentExecutor = null`。
- 不注入 mock executor 的 Main/Module 集成路径可执行；sandbox/provider 缺失时返回明确 blocked/unavailable，而不是 executor 缺失。
- 提交：`feat(agent): connect product-owned agent turns and proposals`

## 4. WP2：Execution Broker 原子终态、取消、Fence 与恢复

### 4.1 先写测试

- 扩展 `tests/execution/execution-broker.test.mjs`：pre-abort、dispatch barrier、backend 返回/取消交错、重复取消、retry 后旧结果、child 写入前取消。
- 新增 Mongo integration 测试：attempt/invocation/lease/terminal event 在同一事务中一致；进程重启 reconciliation。
- 使用可控 barrier 证明每个 invocation 只存在一个权威 terminal outcome。

### 4.2 实现文件

- 修改 `execution-persistence.mjs` 和 `mongo-execution-persistence.mjs`：增加 `settleAttempt`、`requestCancellation`、`beginAttempt` 原子端口。
- 修改 `execution-broker.mjs`：所有状态转换只走上述端口；dispatch/child/settle 前检查 abort 和 fence；取消等待 transport 中断完成。
- 增加 reconciliation 服务并在 `server.mjs` readiness/recovery 注册。
- 必要时通过 migration `006-execution-terminal-state.mjs` 增加终态约束、recovery 字段与索引。

### 4.3 完成门

- cancel/success 竞争无状态分裂。
- 旧 fence 结果永远不能覆盖新 attempt。
- 提交：`fix(execution): make terminal transitions atomic and fenced`

## 5. WP3：Canonical Memory 提升信任边界

### 5.1 先写测试

- 修改 `product-memory-service.test.mjs`：Agent/Worker 即使伪造 canonical/verified/low/evidence 也只能 pending。
- 增加 canonical object/version/evidence 不存在、workspace 不匹配、hash 不匹配、未验证对象的负向测试。
- Mongo integration 验证 scope、tenant、TTL、物理删除、无正文 tombstone 与重启读取。

### 5.2 实现文件

- 新增 `src/memory/canonical-memory-resolver.mjs`：只从 Product Store 读取 Skill Draft/Version、Workflow Revision 和验证状态，生成 canonical evidence/hash。
- 修改 `product-memory-service.mjs`：公共 `submitCandidate` 永远 pending；新增仅后端组合可调用的 `ingestCanonicalFact`。
- 修改 Memory contract，使 caller assertion 与 server verification 明确区分；扩展事件类型与审计元数据。
- 修改 `server.mjs` 注入 resolver；HTTP 不暴露 canonical ingestion。
- 必要时增加 migration `007-memory-verification.mjs` 存储 verified evidence hash 与策略版本。

### 5.3 完成门

- 无任何 Agent/Worker/public HTTP 自动提升路径。
- 只有服务器重新读取的 canonical 事实可按 policy 提升。
- 提交：`fix(memory): require server-verified canonical promotion`

## 6. WP4：可构建 Agent Image 与 Stdio Gateway

### 6.1 先写测试

- 修改 `agent-container-sandbox.test.mjs`：不再挂载宿主 Unix socket；stdin/stdout 使用 framed RPC；stdout 业务日志不能污染协议。
- 扩展 Gateway 测试：fence、lease、预算、tool allowlist、child capability、取消后请求、协议版本。
- 新增 worker protocol 单元测试：消息帧、结果 Schema、artifact hash、取消、输出限制。
- 新增真实 Docker integration：镜像 labels、无网络、只读 root、non-root、cap drop、资源限制、容器内无 secret/source/Mongo。

### 6.2 实现文件

- 新增 `domains/agent/image/Dockerfile`、`.dockerignore`、`worker/worker.mjs`、`worker/supervisor.mjs`、`worker/protocol.mjs` 和构建脚本。
- 固定 Node/Pi/AgwaB 与 base image digest；构建生成 image digest/label manifest。
- 新增 Backend `stdio-tool-gateway-session.mjs`，替代 Agent sandbox 的宿主 socket mount。
- 修改 `agent-container-sandbox.mjs`：`docker run -i`、双向 framed RPC、严格 stdout/stderr 与 artifact 边界。
- 修改 `product-tool-gateway.mjs`：校验 invocation attempt fence lease、费用/token/step/tool 预算。
- Pi worker 使用公开 API 和自定义 model transport；AgwaB children 只连接容器内 Supervisor socket。

### 6.3 完成门

- 仓库能够构建可运行的 Agent image。
- 真实 Docker 路径完成一次受控模型 bounded Turn。
- Docker 不可用只有 `sandbox_unavailable`，无 host fallback。
- 提交：`feat(agent): ship isolated worker image and stdio gateway`

## 7. WP5：AgwaB 实时 Children 与产品恢复

### 7.1 先写测试

- 扩展 Agent domain AgwaB 测试：运行中 task diff、child open/progress/checkpoint/complete、父取消。
- 扩展 Broker 测试：child 在父完成前已存在，权限为父子集，超过 `maxChildren` 被拒绝。
- 新增默认 composition 端到端测试：外层 pinned node 启动两个 children，重启只恢复未完成 child，外层图不变。

### 7.2 实现文件

- 扩展 backend execution context：`openChild`、`emitChild`、`checkpointChild`、`completeChild`。
- 修改 `agwab-subagent-backend.mjs` 和 `agwab-workflow-backend.mjs`：轮询/订阅 task 差量并实时调用 child lifecycle。
- 修改 `execution-broker.mjs` 和 persistence：实时 child invocation、独立 attempt/lease/fence、父取消级联。
- 修改 `server.mjs`/Agent worker 注册真实 AgwaB backend，删除完成后批量 projection 路径。

### 7.3 完成门

- 产品 timeline 在父任务执行中看到 children。
- 重启、取消和权限子集闭环。
- 提交：`feat(agent): stream AgwaB children through product execution`

## 8. WP6：Remote Allowlist 与攻击性契约

### 8.1 先写测试

- 扩展 `remote-execution-backend.test.mjs`：注入 bearer、Provider payload、host path、socket、image、env、stack、tool args 和字段变体。
- 同时断言 persistence、SSE/HTTP read model 和日志不含攻击字符串。
- 覆盖乱序、重复、gap、断连、resume、cancel 后迟到和重复 terminal。

### 8.2 实现文件

- 修改 `remote-execution-backend.mjs`：按 lifecycle/artifact/checkpoint/result/evidence 类型构造 allowlist 对象；未知字段默认拒绝。
- 修改 Remote contract/loopback transport：有界 reorder、dedupe、gap/checkpoint/resume 与 terminal fence。
- 真实 Remote 未配置时保持 `remote_backend_unavailable`，且不公开用户选择。

### 8.3 完成门

- 所有恶意字段在 DB/API/SSE/log 中均不可见。
- 提交：`fix(execution): enforce remote product-safe allowlists`

## 9. WP7：单机生产运维、认证 Mongo、备份恢复与观测

### 9.1 先写测试

- Health/readiness/metrics HTTP 单元与集成测试。
- 结构化日志脱敏测试。
- 运维 CLI dry-run、失败不切换、manifest/hash、版本 rollback 测试。
- 真实 Mongo auth/replica migration、encrypted backup、独立 restore drill。
- Docker/Mongo/server kill/restart 和 orphan cleanup。

### 9.2 实现文件

- 新增 `src/operations`：health probes、readiness registry、metrics registry、JSON logger、recovery diagnostics。
- 修改 `server.mjs` 与 HTTP boundary：`/healthz`、`/readyz`、`/metrics`，仍只监听 loopback。
- 新增 `operations/local/workbench-local.mjs`、LaunchAgent 模板、安装/升级/回滚/诊断/备份/恢复模块。
- 新增生产 Mongo compose/profile：digest、auth、single-node replica set、loopback、secret file、healthcheck。
- 备份使用 `mongodump` 流和 Node AES-256-GCM；密钥从 macOS Keychain 读取；保留 7 daily + 4 weekly。
- 更新 README/runbook、环境契约和安全/故障响应文档。

### 9.3 完成门

- 可从零安装并由 launchd 管理 Host Daemon。
- RPO/RTO 设计通过一次真实 restore drill。
- readiness、metrics、日志和 watchdog 故障演练可复验。
- 提交：`feat(ops): add single-machine production runtime`

## 10. WP8：Release rehearsal 与生产放行复审

### 10.1 自动门

1. Contracts build/test。
2. Backend/Agent 全量 unit/runtime-integrity。
3. 认证 Mongo migration/integration/restart。
4. Agent/Script Docker 正负向测试。
5. 默认 Main/Module/AgwaB 产品链路。
6. 受控模型链路与真实 Provider smoke。
7. 并发、取消、fence、kill/recovery、容量预算。
8. 加密 backup/restore、upgrade/rollback。
9. SBOM、依赖审计、image scan、secret scan。
10. `domains/frontend/**` tree 与 baseline 一致；`git status` 清洁。

### 10.2 产物

- 新增时间戳 QA 报告，逐项映射 R0/R1 和命令/版本/digest/结果。
- 只有全部门通过时才把架构与 Review closure 改为 GO；任何环境门未运行都保持 NO-GO 并列出阻断证据。
- 提交：`qa: record single-machine production readiness`

## 11. 回滚与停止条件

- 每个工作包独立提交；失败时回滚部署 `current` symlink，不重写 Mongo 历史。
- Migration 必须向前兼容旧数据；需要破坏性数据变换时停止并重新设计。
- 若 Pi 公开 API 无法支持无凭证自定义 transport，不能把凭证放入容器；应保持 NO-GO 并记录阻断，而非降级安全边界。
- 若 Docker Desktop 无法证明无网络/无 secret/只读隔离，不能用 mock 代替真实门。
- 若真实 Provider 未配置或不可用，受控链路可以通过，但最终发布仍保持 NO-GO。
