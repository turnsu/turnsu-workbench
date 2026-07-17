# Looloomi Backend / Agent 单机生产运行手册

- 适用部署：一台 macOS，Host Workbench daemon + Docker Agent/Skill sandbox + Docker Mongo 单节点 `rs0`
- 公网边界：Workbench 和 Mongo 都只监听 loopback；本手册不把它当作云端或多租户部署
- 运维入口：仓库固定 Node `22.22.3` 执行 `domains/backend/operations/local/workbench-local.mjs`
- 数据目标：RPO ≤ 24 小时，RTO ≤ 2 小时

## 1. 不可跳过的前提

1. Docker Desktop 正常运行。
2. Agent、Skill、Mongo 都使用精确 `sha256` digest；Agent image 必须带仓库定义的 Pi/AgwaB labels。
3. macOS 登录 Keychain 可用。Mongo、Provider 和备份密钥不得写入 `.env`、release bundle、launchd plist 或容器。
4. `domains/frontend` 必须保持 tree `d6aa607bab850e6f30a2c92c4823896806871937` 且无工作树 diff，否则 release manifest 拒绝生成。
5. Provider 必须兼容 OpenAI `/models` 与 `/chat/completions`，非 loopback endpoint 必须是 HTTPS。

先在仓库根目录定义本次 shell 使用的入口：

```bash
workbench_local() {
  .tooling/node/bin/node domains/backend/operations/local/workbench-local.mjs "$@"
}
```

## 2. 首次初始化

初始化产品生成的 Mongo/backup secrets。已有 Keychain item 时命令默认拒绝覆盖；只有明确轮换时才使用 `--rotate`。

```bash
workbench_local init-secrets
```

通过标准输入从密码管理器传入 Provider key，不要把 key 写进命令参数或 shell history：

```bash
password-manager-command | workbench_local set-model-key
```

当前 Keychain adapter 调用 macOS `/usr/bin/security`；写入瞬间 secret 会作为该短命子进程的参数存在。因此本部署模型要求单一受信任本机用户，并禁止同时运行不受信任的本机进程。若这一条件不成立，必须更换原生 Keychain helper 后才能放行。

写入不含 secret 的配置：

```bash
workbench_local configure \
  --model-base-url https://provider.example/v1 \
  --model provider/model-id \
  --agent-image repository/agent@sha256:<64-hex> \
  --skill-image repository/skill@sha256:<64-hex> \
  --database looloomi_workbench \
  --port 8798
```

启动认证 Mongo 并执行 migration：

```bash
workbench_local mongo-up
workbench_local migrate
```

Mongo secret 只会短期物化为 owner-only `0600` 文件并挂载给 Mongo；Agent/Skill 容器不接收这些文件。

## 3. 构建与安装 release

Release staging 只复制 allowlist 运行文件，依赖符号链接会被解引用；目标目录必须不存在：

```bash
workbench_local stage-release --destination /absolute/path/looloomi-release-<version>
workbench_local manifest \
  --bundle /absolute/path/looloomi-release-<version> \
  --version <version>
```

Manifest 固定 source commit、每个文件 hash、Agent/Skill/Mongo image digest 与冻结前端 tree。生成 manifest 和激活 release 都会重新验证 `release-evidence/`：Contracts、Backend、Agent、认证 Mongo、Docker 隔离、默认 Agent composition、备份恢复、升级回滚、容量、secret scan、两份 CycloneDX SBOM、零漏洞依赖审计以及三个精确 digest 镜像的 high/critical 零漏洞扫描必须全部通过；证据缺失或失败时拒绝激活。首次安装和以后升级都走同一个失败关闭路径：升级前加密备份，候选版本执行自己的 migration，以临时端口启动完整 Product composition，且 `/readyz` 必须同时通过 Mongo primary、migration checksum、Agent sandbox 和真实 Provider probe；之后才原子切换 `current` 并重载 launchd。

```bash
workbench_local upgrade --bundle /absolute/path/looloomi-release-<version>
```

常规生命周期：

```bash
workbench_local preflight
workbench_local status
workbench_local restart
workbench_local stop
workbench_local start
workbench_local diagnostics
```

`start` 会等待 Mongo healthy、重跑幂等 migration、安装三个 LaunchAgent，并在 60 秒内要求服务 ready。`stop` 会卸载 LaunchAgent 并停止本项目 Mongo compose。不要对用户已有的其他 Mongo 容器执行这些命令。

## 4. 备份与恢复演练

每日 LaunchAgent 执行：

```bash
workbench_local backup
```

备份是 `mongodump --archive --gzip` 流，宿主立即用 AES-256-GCM 加密。旁路 manifest 记录数据库、最新 migration、release、密文字节数和 SHA-256，不记录正文。保留策略为 7 个日恢复点加 4 个周恢复点。

恢复演练永远写入独立 `_test` 数据库：

```bash
workbench_local restore-drill --backup /absolute/path/workbench-YYYYMMDDTHHMMSSZ.lbkp
```

成功条件：密文认证、关键集合计数、重复 ID、001–005 migration ledger 和关键索引数量与源库一致。成功后临时库自动删除；失败时保留临时库供诊断，人工确认后再调用容器内 `mongo-drop-test.sh` 清理。

单节点 Mongo 不是高可用或 PITR。机器和本地备份盘同时损坏会超过 RPO/RTO；生产使用时必须把加密 `.lbkp` 与 manifest 复制到独立受控介质。

## 5. Health、metrics、日志与告警

- `GET /healthz`：仅进程存活，不等待 startup recovery。
- `GET /readyz`：生产模式严格检查 startup/recovery、可写 Mongo primary、精确 migration checksum、Agent sandbox 与 Provider。
- `GET /metrics`：Prometheus 文本；包含 HTTP、Run/Turn 队列、active lease/age、execution terminal status/时长、Gateway allow/reject、Memory candidate 和 Mongo up。
- JSON 日志采用字段 allowlist，只允许产品关联 ID、操作、固定 code、状态与时长；Provider payload、Authorization、Tool input、host path 和任意未知字段不会落盘。
- Watchdog 每 60 秒执行完整诊断，将 owner-only 状态写到 `state/watchdog.json`；连续第 3 次失败写入 macOS unified log，恢复时清零。

初始告警线：

| 条件 | 级别 | 动作 |
|---|---|---|
| `readyz` 连续 3 次失败或 `workbench_mongo_up == 0` | P1 | 停止新 Run，检查 Docker/Mongo/Provider；15 分钟无恢复则执行 rollback |
| `workbench_oldest_active_lease_age_seconds > 900` 持续 5 分钟 | P1 | 检查 orphan Worker、取消链与 recovery；不得手工改 Mongo 状态 |
| Run/Turn queue 持续增长 10 分钟 | P2 | 限制新提交，检查 Worker 容量、Provider 延迟和 Docker 资源 |
| `sandbox_unavailable`、Gateway reject 或 execution timeout 突增 | P2 | 按 image/lease/fence/budget 分类；禁止 host fallback |
| 备份超过 26 小时未成功或 restore drill 失败 | P1 | 修复前禁止升级和 migration |

容量验收预算：启动到 ready ≤ 60 秒；Mongo/Docker 重启后 ≤ 2 分钟恢复；至少 4 个并发 Session、8 个并发 Worker；不含模型时间的普通本地读取 API p95 < 250ms。超过预算不等同数据损坏，但阻断 release GO。

## 6. 故障处理与回滚

1. 先保存 `diagnostics`、`readyz`、`metrics`、watchdog 状态和相关 JSON 日志；不要复制 Keychain 或 secret 文件。
2. Docker 不可用时，Agent/Skill 必须返回 `sandbox_unavailable`，不得改为宿主执行。
3. Provider 不可用时 readiness 失败；不得把 Agent Turn 报告为正常成功。
4. migration 失败时不要切换 release；依赖升级前备份与 migration 自身 checksum/transaction 重试。
5. 候选 smoke 失败时 `current` 保持原版本。
6. 已切换版本需要回退时：

```bash
workbench_local rollback
```

Rollback 只切回上一个 release 并重新通过 readiness，不重写 Mongo 历史。所有 migration 必须向前兼容旧 release；若未来 migration 不满足这一点，必须停止自动升级并单独设计数据回退。

## 7. 放行边界

本手册只支持已确认的单机方案 A。真实 Remote Device、设备注册/mTLS/中继/舰队、云端多租户、PITR/自动故障切换和公网 TLS/Ingress 均不在本轮范围。任何真实 Provider smoke、安全扫描、容量门或 release rehearsal 未执行时，最终结论必须保持 `NO-GO`，不能用单元测试替代。
