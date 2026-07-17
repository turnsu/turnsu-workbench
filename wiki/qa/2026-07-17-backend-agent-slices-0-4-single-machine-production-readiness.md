# Backend / Agent Slice 0–4 单机生产就绪复审

- 日期：2026-07-17
- 目标：已确认的方案 A——单台 macOS、Host Workbench daemon、Docker Agent/Skill sandbox、认证 Mongo 单节点 Replica Set
- 运行候选提交：`3aeb3059e8d6075d899119388254d03d101ecec3`
- 分支：`codex/backend-agent-slices-0-4`
- 前端 tree：`d6aa607bab850e6f30a2c92c4823896806871937`，与归一化基线一致
- 结论：**Slice 0–4 的原始代码阻断项已经闭合；当前单机生产发布仍为 NO-GO。**

本报告是以下历史审查的当前复审结果：

- [独立代码审查](2026-07-16-backend-agent-slices-0-4-independent-code-review.md)
- [生产就绪审查](2026-07-16-backend-agent-slices-0-4-production-readiness-review.md)

“代码阻断项闭合”与“可以上线”是两个不同结论。前者已有真实 Product、Mongo 和
Docker 路径证据；后者仍被 Provider、供应链扫描、容量稳定性和完整升级演练阻断。

## 1. 审查问题闭环

| 原问题 | 当前状态 | 实现与证据 |
|---|---|---|
| R0/P0：默认 Main/Module Agent 无执行器 | 已闭合 | 默认 composition 注入 `ProductAgentExecutor`；Main 走 bounded container；Module 只产生 proposal；两协作者的 Session、transcript、权限和 branch 独立。 |
| R0/P0：AgwaB 未进入 Product 执行链 | 已闭合 | `pi-subagent` / `pi-workflow` 通过 Broker 注册；children 在父完成前产生 product invocation/event/checkpoint，父取消级联，外层图不变。 |
| R0/P0：Agent/Worker 可伪造 Memory 自动提升 | 已闭合 | public/Agent/Worker 只能写 Candidate；自动提升只走服务器重新读取 Canonical Object、版本、验证和 evidence hash 的内部路径。 |
| R0/P1：Agent image/worker 缺失 | 已闭合 | 仓库包含 buildable Agent image、Worker/Supervisor 和 framed stdio Gateway；真实 Docker 运行验证无 Provider/Mongo/Connection/user secret。 |
| R0/P1：cancel/complete 终态竞争 | 已闭合 | attempt、invocation、lease、fence 与 terminal event 原子 settlement；pre-abort、重复取消、成功竞争、旧 fence 迟到结果和 Mongo 事务均有负向测试。 |
| R1：Remote 黑名单脱敏 | 已闭合到本轮边界 | lifecycle/artifact/checkpoint/evidence/result 使用 allowlist；恶意 Provider、token、tool、host path、socket、image 字段不能进入产品记录。 |
| R1：单机部署、观测、备份恢复缺失 | 已实现 | local CLI、launchd 模板、严格 readiness、metrics、allowlist JSON log、watchdog、认证 Mongo、加密 backup/restore、release staging/rollback 均已落地。 |

关键实现提交包括：`b3cc25a`、`40619c1`、`5e06d47`、`2db8e55`、`f6eea31`、
`e354f3b`、`82df12f`、`17712cf`、`ea8369c`、`8c14ad8`、`238c6df`、
`7976c22` 和 `3aeb305`。

## 2. 已验证证据

### 2.1 静态、契约与运行时

| 门 | 结果 | 证据 |
|---|---|---|
| 固定 Node | passed | 仓库 `.tooling/node` 为 `v22.22.3`；启动拒绝 `<22.19.0`。 |
| Pi / AgwaB pin | passed | Pi `0.80.7`、pi-subagent `0.4.8`、pi-workflow `0.8.1`；公开 API 兼容门通过。 |
| Contracts | passed | `32/32`。 |
| Backend final suite | passed with recorded instability | 最终 JUnit：337 tests，324 pass，13 skip，0 fail。此前一次相同集合报告 1 fail 但输出被截断；随后两次相同 JUnit 集合均为 0 fail，无法回溯失败项，因此保留稳定性风险而不把它改写成“从未失败”。 |
| Agent suite | passed | 12 个 Pi/AgwaB/Worker 核心测试及全部顺序 smoke 通过；runtime-integrity 对 75,741 个 runtime files 前后比较通过。 |

Contracts 与 Backend 必须顺序执行。Contracts build 会重建共享 `dist`；将两者并行会造成
Backend 读取构建中产物的非产品失败，因此最终权威结果来自顺序运行。

### 2.2 Product、Mongo 与恢复

在独立 `*_test` 数据库和任务自有 `looloomi-mongodb-ops-test` 容器中完成：

- Mongo 认证与单节点 `rs0` primary；migration `001`–`005` 及 checksum/lock；
- Agent proposal/branch、Execution atomic terminal、Product Memory 重启读取与物理删除；
- workspace Connection tenant 隔离、Loop portable import/export、Product HTTP；
- WorkflowRunner Mongo integration、Skill upload、Store integration；
- 4 个 process-kill 边界的 recovery/reconciliation；
- AES-256-GCM backup、manifest、独立 `_test` restore drill 和恢复后集合/索引/migration ledger 对比；
- strict `/readyz`、`/healthz`、`/metrics`、日志脱敏和 watchdog 状态。

验收后已停止并移除任务自有 `looloomi-mongodb-ops-test` 及其临时数据；没有停止或修改
用户原有的 `looloomi-mongodb`。

### 2.3 Docker 与 Gateway

| 产物 | 精确 digest |
|---|---|
| Agent image | `looloomi-agent-worker@sha256:823530d008c582a26dd57bb7efe5b3f181f8702505577875eb427217f59b69a6` |
| Skill image | `ot-skill-verify@sha256:79154abfc753aec51c62c80e2f3804a0bef9d537870295b2939c7fcf6c538f99` |
| Mongo image | `mongo@sha256:340c1c56fb10e95cf79ff547f8664b96bc6ead9909bc355238cbf865a9695a6f` |

真实 Docker 验证覆盖 bounded Agent、AgwaB workflow children、上传脚本隔离、无网络、
read-only root、non-root、capability drop、`no-new-privileges`、资源/输出限制、容器无
Provider/Mongo/Connection/user secret、Gateway lease/fence/allowlist/budget 拒绝，以及 Docker
不可用时 `sandbox_unavailable` 且无 host fallback。

### 2.4 容量

受控 warm run 达到 4 个并发 Session、8 个真实隔离 Worker，普通本地读 p95 为
`11.70 ms`，低于 `250 ms` 预算。但此前两个 cold/high-load 尝试中有一次只在 barrier
期限内到达 7/8 Worker，另一次也未稳定完成。因此代码能力成立，**容量发布门仍标记
blocked**，必须在清洁重启条件下连续重复通过并建立 admission/backpressure 证据。

## 3. 供应链与候选包演练

候选目录：`/private/tmp/looloomi-release-rehearsal-20260717-3aeb305`。它只包含 28 个
allowlist entry，共 44,963 个初始运行文件，依赖符号链接已解引用。

已生成的本地证据：

- Backend CycloneDX 1.5 SBOM：16 components；
- Agent CycloneDX 1.5 SBOM：286 components；
- 本地 npm offline audit：两包均报告 0 vulnerability；
- source-bound Secret Scan：44,922 text files，46 binary skips，0 oversized skips，0 findings；
- release gates 明确记录 `upgrade_rollback`、`capacity`、`dependency_audit`、`image_scan` 为 `blocked`。

本地 offline audit 不能成为最终依赖安全结论：Agent 的一次 `npm ci --ignore-scripts`
曾报告 3 个 low vulnerabilities，而 offline audit 返回 0，说明本机 advisory cache 不足以
消除矛盾。未在没有明确外发授权的情况下把依赖图或 SBOM 上传到外部扫描服务，也未
伪造 image scan JSON。

Release manager 的失败关闭行为已验证：

1. `manifest` 在写文件前校验 source commit、文件 hash、12 个 release gate、SBOM、audit、
   secret scan 和精确 image scan；
2. 当前候选返回 `release_gates_not_passed`，exit code `1`；
3. 候选目录中不存在 `release-manifest.json`；
4. `upgrade/activate` 在读取运行密钥、创建备份或切换 `current` 前再次验证候选；
5. 因此本轮没有执行真实激活，也没有把 blocked candidate 包装成成功 release。

## 4. 当前不可豁免阻断项

1. **真实 Provider smoke 缺失。** 受控 loopback Provider 和 Gateway 路径通过，但候选环境
   没有已确认的真实 Provider key/config；不能用 Builder 历史 proof 或 mock 替代。
2. **authoritative dependency audit 缺失。** 必须在获准的 CI/安全环境中使用更新的 advisory
   数据解释并关闭 Agent 安装报告的 3 个 low findings。
3. **image CVE scan 缺失。** Agent、Skill、Mongo 三个精确 digest 都需要带 scanner 名称、
   database update time、high/critical 为零的真实报告。
4. **cold capacity 不可重复。** 8 Worker warm run 通过，但冷启动到达率有失败记录；需连续
   重跑、资源水位和提交背压证据。
5. **真实 upgrade/rollback rehearsal 未完成。** 依赖前述门全部通过后，才能执行从旧 release
   备份、候选 migration/readiness、原子切换、故障回滚及恢复验证。

任何一项未关闭，`release-gates.json` 都不得写成 `passed`。

## 5. 范围外与残余风险

- 真实 Remote Device、设备身份、mTLS、relay/NAT、舰队、配额和升级明确不在本轮；Remote
  adapter 仍不进入公开用户选项。
- 单节点 Mongo 不是 HA/PITR；当前 RPO ≤ 24h、RTO ≤ 2h 依赖加密备份被复制到独立介质。
- macOS `/usr/bin/security` 写 Keychain 时 secret 会短暂成为 helper 参数；本方案只适用于
  单一受信任本机用户。存在不受信任本机进程时必须替换为原生 Keychain helper。
- 一次 Backend 非确定失败和 cold Docker 容量波动都应进入 CI 多次重复门，不能因最终一次
  绿色而删除这段证据。
- 云端、多租户、公网 TLS/Ingress 和多副本协调不在本轮结论内。

## 6. 最终决策

**开发签收：通过。** 原始 review 的 R0/P0/P1 代码断点已经切实落地并由真实路径消费；
Backend / Agent Slice 0–4 不再只是接口、类型或 mock 基线。

**单机生产发布：NO-GO。** 当前候选已被 fail-closed release gate 正确拒绝。只有第 4 节所有
阻断项关闭、生成 source-bound manifest、完成真实 upgrade/rollback rehearsal，并在新 QA
记录中逐门改为 passed 后，才能改变本结论。
