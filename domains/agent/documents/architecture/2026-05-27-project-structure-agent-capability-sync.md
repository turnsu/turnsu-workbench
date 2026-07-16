# Project Structure and Agent Capability Sync

Date: 2026-05-27

## 结论

当前项目已经从早期的「静态微信情报看板」演进为本地 MVP 级「微信 x 链上 Agent 工作台」。它具备桌面端、Agent 端、数据存储端、运行/运维监控端四条主线，但能力成熟度不同：

- 桌面端：有效具备。本地 SwiftUI app 已包含首页、微信收件箱、Token 终端、观察列表、Agent 工作空间、数据/运维视图。
- Agent 端：本地 MVP 有效具备。Swift 内产品运行时负责情报刷新和本地对象闭环；Node/Pi SDK-backed daemon 负责 Agent 工作空间的 session、tool、stream、artifact 和 product mutation。
- 数据存储端：有效具备本地 artifact store。运行时对象、Agent run、session、attachment、crystal/proposal/memory/handoff 都有 JSON 落点。
- 运行/运维监控端：有效具备本地 MVP。runID、freshness、policy、health、manifest、daemon/provider 状态、tool-call artifact 都可追踪。
- 真实外部数据与执行：仍是受限能力。真实微信读取、live wechat-cli、交易、发消息、外部发布保持 blocked；market/on-chain/live provider 通过 normalized bridge contract 接入，未配置或不可用时必须显示 stale/degraded/blocked。

## 当前目录结构

```text
wechat-intelligence-radar-mvp/
├── Package.swift
├── domains/frontend/app/code/WeChatIntelligenceRadarApp/
│   ├── Models/
│   ├── Services/
│   ├── ViewModels/
│   ├── Views/
│   ├── Fixtures/wechat/messages.sample.json
│   └── WeChatIntelligenceRadarApp.swift
├── domains/frontend/app/code/Tests/WeChatIntelligenceRadarAppTests/
├── agent-runtime/
│   ├── bin/wechat-agent-daemon.mjs
│   ├── extensions/
│   ├── skills/
│   ├── prompts/
│   ├── runtime/capability-registry.json
│   └── runtime/model-providers.json
├── runtime/
│   ├── agent/
│   ├── alerts/
│   ├── artifacts/
│   ├── bridges/
│   ├── crystals/
│   ├── entities/
│   ├── evidence/
│   ├── handoffs/
│   ├── health/
│   ├── market/
│   ├── memory/
│   ├── onchain/
│   ├── proposals/
│   ├── runs/
│   ├── sessions/
│   ├── tasks/
│   ├── watchlist/
│   └── wechat/
├── scripts/
└── wiki/
    ├── PROJECT_WIKI.md
    ├── architecture/
    └── history/
```

## 功能面梳理

### 桌面端

- `WeChatIntelligenceRadarApp.swift` 提供三个入口：正常 SwiftUI app、`--smoke-check` runtime 刷新探针、`--ui-smoke-check` 可见窗口探针。
- `DashboardViewModel` 是 UI 总状态中心，持有情报快照、runtime 数据、选择态、Agent daemon 状态、Agent session/message/tool/task/attachment 状态。
- `TerminalWorkspaceSidebar` 和相关 views 组成多 workspace 产品壳：首页、微信收件箱、Token 终端、观察列表、Agent 操作台、数据/运维。
- `AgentWorkspaceV2Views.swift` 是当前 Agent 工作空间主界面：左侧任务/上下文/能力，中央 thread/chat/composer，右侧 inspector，底部 compact run bar。

### Swift 产品运行时

Swift 内部运行链路：

```text
DashboardViewModel
  -> RuntimeBackend
  -> RuntimeRepository
  -> AgentOrchestrator
  -> WeChatDataAdapter / MarketSnapshotStore / OnchainSnapshotService / Runtime stores
  -> TerminalDataSnapshot
  -> SwiftUI views
```

主要能力：

- `RuntimeBackend` 承接 UI command/query/mutation，避免 view 直接改 store。
- `RuntimeRepository` 负责刷新、导入、持久化与 artifact manifest/health。
- `AgentOrchestrator` 负责 fixture 消息读取、时间窗口过滤、token/entity 解析、market/on-chain 合并、evidence、alert、task、briefing、crystal/proposal/memory/handoff/session 生成。
- `AgentRunStore`、`MarketSnapshotStore`、`TerminalDataStores`、`AgentRuntimeStores` 负责本地 JSON artifact。
- `PolicyGate` 与 runtime health 维持敏感动作边界。

### Agent 工作空间运行时

Node/Pi-backed Agent 工作空间链路：

```text
Swift AgentWorkspaceV2
  -> AgentDaemonClient
  -> agent-runtime/bin/wechat-agent-daemon.mjs
  -> @earendil-works/pi-coding-agent
  -> DefaultResourceLoader
  -> agent-runtime/extensions/wechat-onchain-tools.ts
  -> runtime/agent/runs/{runID}/artifacts
  -> product-mutations.json
  -> Swift RuntimeBackend import
```

主要能力：

- `agent-runtime/package.json` 固定 `@earendil-works/pi-coding-agent@0.75.5`，daemon 内部通过 Pi SDK 创建 session，不 shell out 到全局 `pi` CLI。
- `PiBackedAgentRuntime` 使用 `DefaultResourceLoader` 加载本项目 extensions/skills/prompts。
- 首批 custom tools 覆盖 `wechat.read_normalized_messages`、`token.resolve_entities`、`market.read_snapshot`、`onchain.read_snapshot`、`crystal.create_or_update`、`proposal.create`、`memory.save`、`handoff.write`、`image.analyze_with_kimi`、`computer_use.request`。
- daemon 写出 `events.ndjson`、`tool-calls.json`、`policy-decisions.json`、`model-route.json`、`final-output.md`、`product-mutations.json` 等 artifact。
- Swift 只导入 `product-mutations.json` 中允许的本地对象，并按已有 id 去重。

## Agent 能力矩阵

| 能力 | 当前状态 | 证据位置 | 说明 |
| --- | --- | --- | --- |
| Chat/thread workspace | 有效具备 | `AgentWorkspaceV2Views.swift`、`AgentWorkspaceV2Models.swift` | thread-first UI、composer、message parts、inline capability cards |
| Agent session/task 恢复 | 有效具备 | `runtime/agent/sessions/`、`runtime/agent/tasks/` | Swift 可读取已有 session/task JSON |
| Pi SDK backed daemon | 有效具备本地 MVP | `agent-runtime/bin/wechat-agent-daemon.mjs` | 使用 Pi SDK session/resource/tool 基础架构 |
| Custom tool registry | 有效具备 | `agent-runtime/runtime/capability-registry.json`、`extensions/wechat-onchain-tools.ts` | 项目工具可注册并被 daemon 调用 |
| Product mutation import | 有效具备 | `AgentProductMutationStore`、`RuntimeBackend.importAgentProductMutations` | Agent 结果进入本地 crystal/proposal/task/handoff 等对象 |
| 图片附件入库 | 有效具备本地存储 | `AgentAttachmentStore`、`runtime/agent/attachments/` | 复制图片、计算 sha256/mime/size；Kimi 分析取决于 provider 配置 |
| DeepSeek/Kimi live provider | 契约具备，运行取决于环境 | `agent-runtime/runtime/model-providers.json`、daemon `/health` | 缺 key 时显示 blocked，不冒充真实 LLM |
| Computer Use 执行 | 仅 proposal/needs_confirmation | daemon policy | 第一阶段不直接操作 Mac UI |
| 真实微信读取/live wechat-cli | blocked | `PolicyGate`、daemon policy | 不运行真实微信读取命令 |
| 交易/发消息/外部发布 | blocked | `PolicyGate`、daemon policy | 当前产品不执行外部高风险动作 |
| Market/on-chain live bridge | normalized contract only | `runtime/bridges/`、`runtime/market/`、`runtime/onchain/` | Swift 只消费本地 JSON，不直连 MCP/RPC |

## 数据与 artifact 映射

| 对象 | 主要路径 | 用途 |
| --- | --- | --- |
| WeChat fixture | `domains/frontend/app/code/WeChatIntelligenceRadarApp/Fixtures/wechat/messages.sample.json` | 本地样例输入，不读取真实微信 |
| Normalized messages | `runtime/wechat/messages.normalized.json` | 产品运行时统一消息输入 |
| Token entities | `runtime/entities/token-entities.json` | symbol/CA/entity 解析结果 |
| Market snapshot | `runtime/market/latest-market-snapshot.json` | CMC/market normalized artifact |
| On-chain snapshots | `runtime/onchain/{chain}/` | normalized on-chain fixture/bridge artifact |
| Evidence | `runtime/evidence/evidence.json` | 消息、token、market/on-chain 证据绑定 |
| Crystals | `runtime/crystals/crystals.json` | 微信 x 链上融合情报单元 |
| Proposals | `runtime/proposals/proposals.json` | Agent 生成的本地行动建议 |
| Memory | `runtime/memory/memory.json` | useful/wrong/false-positive 等长期记忆 |
| Handoffs | `runtime/handoffs/index.json` | 本地可复制/交接包索引 |
| Product runs | `runtime/runs/{runID}/` | Swift 产品运行时 run artifact |
| Agent runs | `runtime/agent/runs/{runID}/` | daemon/tool/model/policy/session artifact |
| Health | `runtime/health/latest-health.json` | 本地运行健康与边界状态 |
| Artifact manifest | `runtime/artifacts/manifest.json` | artifact 完整性和引用索引 |

## 运维与安全边界

- Swift 桌面端不直接调用 MCP、RPC、真实微信或 live provider。
- Node daemon 不写入 API key、Authorization、cookie 或完整 raw request body。
- Provider credential 只读环境变量；缺失时 `health` 与 UI 显示 blocked/degraded。
- Pi built-in `bash/edit/write` 默认禁用；第一阶段只允许本项目 custom tools。
- `assignment-agent-raw` 与 `wechat-cli_raw` 是只读参考，不作为当前项目的写入目标。
- 真实 WeChat、live wechat-cli、交易、发消息、外部发布必须保持 blocked，除非后续单独设计确认与审计 UX。

## 当前主要缺口

- Node 版本风险：Pi package 声明需要 Node `>=22.19.0`，历史 smoke 在较低 patch 版本可运行但应升级后再做 live smoke。
- Live model/provider smoke 未作为默认验收：需要用户轮换已暴露 key，并通过环境变量注入后再运行。
- Daemon 生命周期仍是脚本级：当前通过 `scripts/start-agent-daemon.sh` / `scripts/stop-agent-daemon.sh`，尚未做 LaunchAgent 或生产级 supervisor。
- 外部 bridge runner 未生产化：market/on-chain/user-provided WeChat export 仍以 normalized JSON contract 为边界。
- 历史 run retention/purge 需要继续硬化，尤其是 memory purge 与历史 artifact 可见性的关系。

## Wiki 同步结果

- 已将完成或过期的 plan/PRD/QA/architecture 文档迁移到 `wiki/history/`。
- 当前有效架构文档保留在 `wiki/architecture/`。
- `wiki/history/README.md` 记录历史文件命名规则、状态、类型和归档原因。
- `wiki/PROJECT_WIKI.md` 作为总索引，只应链接当前有效文档和 history 中的历史记录。
