# Looloomi Backend / Agent 单机生产运行手册

- 适用部署：一台 macOS，Host Workbench daemon + Docker Agent/Skill sandbox + Docker Mongo 单节点 `rs0`
- 公网边界：Workbench 和 Mongo 都只监听 loopback；本手册不把它当作云端或多租户部署
- 运维入口：仓库固定 Node `22.22.3` 执行 `domains/backend/operations/local/workbench-local.mjs`
- 数据目标：RPO ≤ 24 小时，RTO ≤ 2 小时

## 1. 不可跳过的前提

1. Docker Desktop 正常运行。
2. Agent、Skill、Mongo 都使用精确 `sha256` digest；Agent image 必须带仓库定义的 Pi/AgwaB labels。
3. macOS 登录 Keychain 可用。Mongo、Provider 和备份密钥不得写入 `.env`、配置文件、release bundle、launchd plist 或容器。
4. release manager 记录的冻结前端 tree 必须等于本次已验收的前端基线，且工作树无前端 diff；否则 manifest 拒绝生成。
5. DeepSeek/OpenAI、Anthropic、Gemini、Stability 分别使用已实现的协议 adapter；生产 Provider endpoint 只能使用无 userinfo、query 或 fragment 的 HTTPS URL。

先在仓库根目录定义本次 shell 使用的入口：

```bash
workbench_local() {
  .tooling/node/bin/node domains/backend/operations/local/workbench-local.mjs "$@"
}
```

## 2. 首次初始化与模型目录

初始化产品生成的 Mongo/backup secrets。已有 Keychain item 时命令默认拒绝覆盖；只有明确轮换时才使用 `--rotate`。

```bash
workbench_local init-secrets
```

通过标准输入从密码管理器传入 Provider key，不要把 key 写进命令参数或 shell history：

```bash
password-manager-command | workbench_local set-model-key --credential-ref deepseek-main
```

当前 Keychain adapter 调用 macOS `/usr/bin/security`；写入瞬间 secret 会作为该短命子进程的参数存在。因此本部署模型要求单一受信任本机用户，并禁止同时运行不受信任的本机进程。若这一条件不成立，必须更换原生 Keychain helper 后才能放行。

写入不含 secret 的初始导入配置：

```bash
workbench_local configure \
  --provider deepseek \
  --model-profile-id deepseek-default \
  --label "DeepSeek" \
  --model deepseek-chat \
  --credential-ref deepseek-main \
  --agent-image repository/agent@sha256:<64-hex> \
  --skill-image repository/skill@sha256:<64-hex> \
  --database looloomi_workbench \
  --port 8798
```

`config.json` 使用 `looloomi-local-config-v3`，只保存 `model-catalog-import-v1` 的 flat `profiles[]` 和 `routingPolicies[]`。它是启动导入输入，不是运行时模型真相源。服务启动后，Mongo 的 `model_profiles`、不可变 `model_profile_revisions` 和带版本的 `model_routing_policies` 是权威目录；相同配置幂等复用 revision，变更配置会创建新 revision。Session 偏好保存 profile，Turn 和 Workflow 执行固定 revision，因此运行中不会被后来修改静默换模。

其他 Provider 可以追加到同一单机配置，而不替换当前默认模型：

```bash
password-manager-command | workbench_local set-model-key --credential-ref anthropic-main
workbench_local add-model \
  --model-profile-id claude-sonnet \
  --label "Claude Sonnet" \
  --provider anthropic \
  --model claude-sonnet-model-id \
  --credential-ref anthropic-main
workbench_local set-default-model --model-profile-id deepseek-default
```

Stability 是 `image_generation` capability，不是聊天模型。增加并设为图片默认时使用：

```bash
password-manager-command | workbench_local set-model-key --credential-ref stability-main
workbench_local add-model \
  --model-profile-id stability-image \
  --label "Stability Image" \
  --provider stability \
  --model stable-image-core \
  --capabilities image_generation \
  --credential-ref stability-main
workbench_local set-capability-default \
  --capability image_generation \
  --model-profile-id stability-image
```

DeepSeek 与 OpenAI 使用 `openai_compatible_chat`；Anthropic 使用 `anthropic_messages`；Gemini 使用 `gemini_generate_content`；Stability 使用 `stability_image_v2`。本轮 Stability 只接受 `stable-image-core`：prompt/negative prompt 各最多 10,000 字符，seed 为 `0..4294967294`，aspect ratio 只允许 `16:9, 1:1, 21:9, 2:3, 3:2, 4:5, 5:4, 9:16, 9:21`。自定义端点只支持 OpenAI-compatible chat，必须同时提供 `--provider custom --protocol openai_compatible_chat --model-base-url <https-url>`。图片模型不允许聊天 capability 或 fallback；`tool_calling`/`structured_output` 必须同时声明 `chat`。

配置变更在下一次服务启动时导入。daemon 根据每个 `routingPolicies[].defaultProfileIdsByCapability` 的键生成 `WORKBENCH_MODEL_ROUTING_REQUIREMENTS_JSON`；required capability 因此由明确配置驱动。默认聊天配置要求 `chat/tool_calling/structured_output`，只有设置图片默认后才要求 `image_generation`。新加但未被任何 capability 默认策略引用的 profile 缺少凭证时，`doctor` 将其报告为 `required:false`，不会阻断服务；一旦成为默认路由，缺少凭证必须使 readiness 失败且执行 blocked，不能静默改用其他模型。旧 V1 配置升级后会生成 `legacy-default` credential ref；旧 `model-api-key` account 不再被视为可用，必须重新执行：

```bash
password-manager-command | workbench_local set-model-key --credential-ref legacy-default
```

启动认证 Mongo、执行到 `006-model-routing` migration，再启动服务：

```bash
workbench_local mongo-up
workbench_local migrate
workbench_local start
```

Mongo secret 只会短期物化为 owner-only `0600` 文件并挂载给 Mongo；Agent/Skill 容器不接收这些文件。Provider credential 只由宿主 ModelService 按 `credentialRef` 懒读取，不进入环境 JSON、Agent sandbox 或日志。

## 3. 构建、真实 Provider 验证与安装 release

Release staging 只复制 allowlist 运行文件，依赖符号链接会被解引用；目标目录必须不存在：

```bash
workbench_local stage-release --destination /absolute/path/looloomi-release-<version>
workbench_local scan-release-secrets \
  --bundle /absolute/path/looloomi-release-<version> \
  > /absolute/path/looloomi-release-<version>/release-evidence/secret-scan.json
```

`scan-release-secrets` 只输出 path/rule，不输出匹配正文；发现凭证或未扫描的大文本时返回非零。不要用 `|| true` 掩盖结果。

候选必须分别通过聊天和 Stability 的真实产品路径 smoke。命令使用隔离且逐次唯一的 `looloomi_provider_*_test` 数据库和临时 Artifact/Execution/Sandbox root，并以候选自带 `.tooling/node` 启动独立候选进程，再从 Product API 创建 Session/Turn；不会把候选模块导入当前运维进程，也不会绕过 Product Controller 直接调用 Provider。只有 test DB 清理成功后才写通过证据。聊天验证 requested/actual revision 相同且无 fallback。Stability 会产生真实、可能收费的图片调用，因此必须显式确认，并验证 Artifact hash、授权读取、跨 workspace 拒绝和无 PI Session：

```bash
workbench_local smoke-chat \
  --bundle /absolute/path/looloomi-release-<version> \
  --source-commit <40-hex-commit> \
  --model-profile-id deepseek-default

workbench_local smoke-stability \
  --bundle /absolute/path/looloomi-release-<version> \
  --source-commit <40-hex-commit> \
  --model-profile-id stability-image \
  --confirm-billable
```

没有 `--confirm-billable` 时，Stability 命令必须在读取配置、密钥、数据库或候选文件前拒绝。按 2026-07-18 核验的 Core 价格，单图为 3 credits、1 credit 为 USD 0.01，即估算 USD 0.03（30,000 USD micros）；V3 默认单图 cost budget 与 release smoke billing evidence 按这一版本固定。该值是发布策略估算，不是假装读取到的 Provider 账单，价格变化时必须更新 policy 并重新生成候选证据。证据只保存 source commit、候选摘要、profile revision、协议、固定无害输入摘要、响应摘要、Artifact ID/hash/MIME/尺寸、版本化计价估算和断言，不保存 prompt、图片正文、Provider payload 或 credential；release verifier 会重算固定输入摘要，任意替换测试内容都会使门禁失败。常规 `doctor`、`readyz` 与 release manifest 验证只通过非计费的 Stability `/v1/user/account`（或等价 balance endpoint）检查认证，不会主动生成收费图片。

在 approved scanner 生成 source/candidate-bound 的 SBOM、dependency audit、license audit 和精确镜像扫描证据后，才可生成 manifest：

```bash
workbench_local manifest \
  --bundle /absolute/path/looloomi-release-<version> \
  --version <version>
```

Manifest 固定 source commit、候选文件 hash、Agent/Skill/Mongo image digest 与冻结前端 tree。生成 manifest 和激活 release 都会重新验证 `release-evidence/`：Contracts、Backend、Agent、认证 Mongo、Docker 隔离、默认 Agent composition、备份恢复、升级回滚、容量、secret scan、dependency/license audit、两份 CycloneDX SBOM、三个精确 digest 镜像 high/critical 零漏洞扫描，以及 chat/Stability 真实 Provider smoke 必须全部通过。Provider 与 license 证据还必须匹配候选摘要且在允许时效内；手写 `"passed"` 标签不是证据。

证据缺失、陈旧、与候选不一致或失败时，`manifest` 返回非零且不写 `release-manifest.json`；`upgrade` 也会在读取运行密钥、创建备份或切换前拒绝候选。首次安装和以后升级都走同一个失败关闭路径：升级前加密备份，候选版本执行自己的 migration，以临时端口启动完整 Product composition，并通过 Mongo primary、精确 migration checksum、Agent sandbox、required model routing 与 Provider readiness；之后才原子切换 `current` 并重载 launchd。

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

每个恢复点由三项组成：Mongo 的 `<timestamp>.lbkp`、完整 Object Store 的 `<timestamp>.lbkp.objects`，以及不含正文的旁路 manifest。Mongo 使用 `mongodump --archive --gzip`，Object Store 使用受限 tar；宿主分别立即用 AES-256-GCM 加密。manifest 绑定两个密文的 SHA-256、数据库、`001`–`006` migration ledger、release、关键集合/索引、ready Artifact 元数据和每个对象 hash。捕获前后 Mongo 产品快照不一致或任一 Artifact 元数据与 `.bin` 内容不一致时，备份失败，不能生成看似成功的恢复点。保留策略为 7 个日恢复点加 4 个周恢复点，并按三项一起清理。

恢复演练永远写入独立 `_test` 数据库和临时 Object Store：

```bash
workbench_local restore-drill --backup /absolute/path/workbench-YYYYMMDDTHHMMSSZ.lbkp
```

成功条件：两个密文认证；恢复后的关键集合计数、重复 ID、`001`–`006` migration checksum、关键索引与 manifest 一致；每个 Object Store 文件的路径/hash 与 manifest 一致；Mongo 中 ready Artifact 的 hash/size 与恢复后的 `.bin` 一致。全部成功后临时数据库和对象目录自动删除；失败时保留恢复目标供诊断，不能用源库当前状态掩盖备份时状态。

单节点 Mongo 不是高可用或 PITR。机器和本地备份盘同时损坏会超过 RPO/RTO；生产使用时必须把 `.lbkp`、`.lbkp.objects` 和 manifest 一起复制到独立受控介质。

## 5. Health、metrics、日志与告警

- `GET /healthz`：仅进程存活，不等待 startup recovery。
- `GET /readyz`：生产模式严格检查 startup/recovery、可写 Mongo primary、精确 migration checksum、Agent sandbox、required capability 的模型默认路由和 Provider。
- `GET /metrics`：Prometheus 文本；包含 HTTP、Run/Turn 队列、active lease/age、execution terminal status/时长、Gateway allow/reject、model attempt、Memory candidate 和 Mongo up。
- JSON 日志采用字段 allowlist，只允许产品关联 ID、操作、固定 code、状态与时长；Provider payload、Authorization、Tool input、host path 和任意未知字段不会落盘。
- Watchdog 每 60 秒执行完整诊断，将 owner-only 状态写到 `state/watchdog.json`；连续第 3 次失败写入 macOS unified log，恢复时清零。

初始告警线：

| 条件 | 级别 | 动作 |
|---|---|---|
| `readyz` 连续 3 次失败或 `workbench_mongo_up == 0` | P1 | 停止新 Run，检查 Docker/Mongo/required model route；15 分钟无恢复则执行 rollback |
| `workbench_oldest_active_lease_age_seconds > 900` 持续 5 分钟 | P1 | 检查 orphan Worker、取消链与 recovery；不得手工改 Mongo 状态 |
| Run/Turn queue 持续增长 10 分钟 | P2 | 限制新提交，检查 Worker 容量、Provider 延迟和 Docker 资源 |
| `sandbox_unavailable`、Gateway reject 或 execution timeout 突增 | P2 | 按 image/lease/fence/budget 分类；禁止 host fallback |
| required model profile 变为 unavailable 或 fallback 突增 | P1 | 停止相关 capability；检查 Keychain/Provider/route pin，不得静默换模 |
| 备份超过 26 小时未成功或 restore drill 失败 | P1 | 修复前禁止升级和 migration |

容量验收预算：启动到 ready ≤ 60 秒；Mongo/Docker 重启后 ≤ 2 分钟恢复；至少 4 个并发 Session、8 个并发 Worker；不含模型时间的普通本地读取 API p95 < 250ms。超过预算不等同数据损坏，但阻断 release GO。

## 6. 故障处理与回滚

1. 先保存 `diagnostics`、`readyz`、`metrics`、watchdog 状态和相关 JSON 日志；不要复制 Keychain 或 secret 文件。
2. Docker 不可用时，Agent/Skill 必须返回 `sandbox_unavailable`，不得改为宿主执行。
3. 模型 revision/credential/Provider 不可用时执行必须 blocked/failed 且 readiness 反映 required route；不得报告正常成功或隐式选择另一个 profile。
4. migration 失败时不要切换 release；依赖升级前先验证完整 Mongo + Object Store 恢复点。
5. 候选 smoke 失败时 `current` 保持原版本。
6. 已切换版本需要回退时：

```bash
workbench_local rollback
```

Rollback 只切回上一个 release 并重新通过 readiness，不重写 Mongo 历史。所有 migration 必须向前兼容旧 release；若未来 migration 不满足这一点，必须停止自动升级并单独设计数据回退。

## 7. 放行边界

本手册只支持已确认的单机方案 A。真实 Remote Device、设备注册/mTLS/中继/舰队、云端多租户、PITR/自动故障切换和公网 TLS/Ingress 均不在本轮范围。任何真实 chat/Stability Provider smoke、外部安全/许可证扫描、可重复容量门或完整 release rehearsal 未执行时，最终结论必须保持 `NO-GO`，不能用单元测试、fixture 或旧候选证据替代。
