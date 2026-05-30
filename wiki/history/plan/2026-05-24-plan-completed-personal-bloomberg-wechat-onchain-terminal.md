# Personal Bloomberg-Style WeChat x On-chain Intelligence Terminal

Updated: 2026-05-24

## 1. Product Vision

本项目目标不再是早期 UI MVP，而是面向个人或 5-8 人小团队的完整桌面情报终端。

产品核心是打通微信群聊信息与链上/市场数据，形成类似 Bloomberg Terminal 的个人化 Web3 情报分析平台：

- 管理微信相关信息内容，包括群、消息、联系人、项目线索、讨论上下文。
- 从群内讨论中识别代币 `symbol`、`CA`、链名、项目名、叙事关键词。
- 自动关联链上数据、行情数据、交易数据、持仓/资金流/合约信息。
- 把“群里在聊什么”和“链上正在发生什么”合并成可操作的情报、监控、提醒和研究卡片。
- 适合个人研究员、交易员、BD、小型投研/运营团队日常使用。

## 2. Product Positioning

### Target Users

- 个人 Web3 研究员 / 交易员
- 小型投研团队
- 社群运营 / BD / 项目方增长团队
- 需要从微信群中捕捉市场信号的人

### Core Jobs

1. 我想知道微信群里最近在高频讨论哪些 token / 项目 / CA。
2. 我想快速判断群里提到的 token 是否真实、在哪条链、合约是否匹配。
3. 我想看到对应 token 的行情、流动性、交易量、持有人、资金流、风险信号。
4. 我想从群聊讨论自动生成情报简报、可跟进行动、提醒和研究任务。
5. 我想把重要群聊内容、token、地址、项目和结论沉淀为可搜索的个人/团队数据库。
6. 我想让 agent 帮我持续监控和整理，但所有敏感读取、发布、联网和密钥操作都必须有边界。

## 3. Non-negotiable Constraints

- 不得擅自接入当前电脑微信。
- 不得运行 `wechat-cli init/history/search` 等真实读取本机微信命令，除非用户明确授权。
- `assignment-agent-raw` 和 `wechat-cli_raw` 只能只读参考。
- Swift 桌面端默认 local-first。
- 链上和市场数据必须有明确 source、timestamp、freshness、confidence。
- mock / fixture / stale / degraded / live 必须视觉和数据层明确区分。
- 不得把 mock 数据伪装成 live 数据。
- 产品内 agent、数据抓取、外部联网、密钥使用、长期运行任务必须进入 policy/capability 管理。
- 开发执行过程中可以按任务创建 subagent 分工，但 subagent 使用必须被生命周期管理，不能无边界并发或遗留任务。
- 每轮开发必须更新 wiki checkpoint。

## 4. Four-end Architecture

```text
Desktop App
  -> Workspace UI / Token Terminal / WeChat Inbox / Agent Console

Agent Runtime
  -> Orchestrator
  -> Task / Skill Modules
  -> Policy Gate
  -> Capability Registry
  -> Task Queue
  -> Run Store

Data Layer
  -> WeChat Source Store
  -> Token Entity Store
  -> Market Snapshot Store
  -> On-chain Snapshot Store
  -> Evidence Store
  -> Watchlist / Alert Store

Ops Layer
  -> Sync State
  -> Run Artifacts
  -> Health Checks
  -> Source Freshness
  -> Error / Retry / Degraded State
  -> Audit Log

Development Execution Layer
  -> Optional Subagents by Workstream
  -> Subagent Lifecycle Records
  -> Handoff Artifacts
  -> Wiki Checkpoints
```

## 5. Desktop UI / UX Direction

产品应从“静态仪表盘”升级为“工作终端”。

### Primary Layout

采用 Bloomberg-style dense workspace，但保持 macOS 原生体验：

```text
┌────────────────────────────────────────────────────────────┐
│ Global Command / Search / Time / Source / Sync / Alerts     │
├───────────────┬───────────────────────┬────────────────────┤
│ Source Nav    │ Intelligence Stream   │ Token / Entity Pane │
│ - Groups      │ - Messages            │ - Price             │
│ - Watchlist   │ - Signals             │ - Liquidity         │
│ - Alerts      │ - CA mentions         │ - Holders           │
│ - Agents      │ - Tasks               │ - Risk              │
├───────────────┴───────────────────────┴────────────────────┤
│ Agent Console / Run Timeline / Evidence / Ops Status        │
└────────────────────────────────────────────────────────────┘
```

### Required Views

1. **Home / Daily Brief**
   - 今日群聊摘要
   - 热门 token / CA
   - 异常活跃群
   - 需要跟进的人/消息
   - Web3 市场上下文

2. **WeChat Intelligence Inbox**
   - 群列表
   - 消息流
   - 关键词 / CA / symbol 高亮
   - 消息到 token/entity 的关联
   - 收藏、标记、归档、生成任务

3. **Token Terminal**
   - token identity
   - chain / CA / symbol resolver
   - price / volume / market cap
   - liquidity / pools
   - holders / whale movement
   - contract risk
   - social mention count
   - related WeChat messages
   - agent summary

4. **Watchlist & Alerts**
   - token watchlist
   - CA watchlist
   - group mention alerts
   - price / volume / liquidity alert
   - repeated mention / sudden mention alert

5. **Agent Console**
   - active run
   - agent run timeline
   - policy decisions
   - capabilities
   - source freshness
   - artifacts
   - retry / degraded reasons

6. **Data & Ops Settings**
   - WeChat source status
   - chain data source status
   - CMC / DEX / RPC provider status
   - local storage path
   - retention policy
   - secrets boundary
   - export/import controls

## 6. Agent Capabilities

### Core Agent Roles

The product runtime should expose clear agent capability modules. These modules may later become internal workers, but the product does not need to ship a complex permanent subagent system in the next phase. Separately, development execution may use subagents for implementation workstreams; those development subagents must be lifecycle-managed as described in section 7.

1. **Ingestion Agent**
   - Reads fixture/export/live-authorized WeChat data.
   - Normalizes messages.
   - Extracts sender, group, timestamp, text, attachments.
   - Does not interpret market meaning.

2. **Entity Resolver Agent**
   - Extracts CA, symbol, chain names, project names.
   - Resolves ambiguous symbols.
   - Scores confidence.
   - Links messages to token entities.

3. **Market Data Agent**
   - Fetches/loads CMC, DEX, CEX, price, volume, market cap.
   - Tracks freshness and source.
   - Never fabricates live data.

4. **On-chain Agent**
   - Given CA + chain, retrieves contract/pool/holder/liquidity/risk info.
   - Supports degraded state if RPC/API unavailable.

5. **Briefing Agent**
   - Generates daily intelligence.
   - Produces summaries, signals, tasks, watchlist suggestions.

6. **Alert Agent**
   - Watches mention spikes, price moves, liquidity changes, repeated CA mentions.
   - Writes alert artifacts, notifies only if policy permits.

7. **QA / Policy Agent**
   - Ensures sensitive operations are blocked or confirmed.
   - Verifies source/freshness/confidence labels.
   - Prevents mock-as-live behavior.

## 7. Development Subagent Lifecycle Management

Subagents here primarily refer to development execution subagents used by Codex/agents while building the product, such as UI/UX, Agent Runtime, Data Layer, On-chain Data, Ops/QA, and Documentation workstreams. They are optional execution helpers, not a requirement that the shipped desktop product must run permanent uncontrolled subagents.

### Required Lifecycle

```text
create -> planned -> running -> completed | degraded | failed | cancelled -> archived
```

### Rules

- Every development subagent run should have `runID`, `parentRunID`, `agentType`, `taskScope`, `status`, `startedAt`, `completedAt`, `artifact`, and `error`.
- Subagents must have explicit task boundaries, timeout expectations, and retry limits.
- Subagents write bounded handoff artifacts only, preferably in wiki checkpoints or runtime/debug artifacts inside this project.
- Subagents cannot read live WeChat, call external network, mutate protected references, install dependencies, or notify users unless the parent task and policy explicitly allow it.
- Long-running monitors must not be created implicitly. They require an explicit user request and a registered automation/job.
- If development subagents are used, the final checkpoint must record which subagents were created, their lifecycle outcome, and any degraded/failed handoff.

## 8. Data Management

### Recommended Local-first Stores

Use simple local storage first:

- `runtime/runs/{runID}/`
- `runtime/market/latest-market-snapshot.json`
- `runtime/onchain/{chain}/{ca}.json`
- `runtime/entities/token-entities.json`
- `runtime/wechat/messages.normalized.json`
- `runtime/alerts/`
- Later: SQLite / SwiftData for indexing and query performance.

### Core Data Models

1. `WeChatMessage`
   - id
   - groupID
   - groupName
   - sender
   - sentAt
   - text
   - extractedSymbols
   - extractedContracts
   - linkedTokenIDs
   - sourceMode
   - privacyLevel

2. `TokenEntity`
   - tokenID
   - symbol
   - name
   - chain
   - contractAddress
   - confidence
   - aliases
   - firstSeenAt
   - lastMentionedAt
   - sourceMessages

3. `MarketSnapshot`
   - tokenID
   - source
   - price
   - volume24h
   - marketCap
   - liquidity
   - change24h
   - freshness
   - generatedAt
   - expiresAt

4. `OnchainSnapshot`
   - tokenID
   - chain
   - contractAddress
   - holders
   - poolLiquidity
   - pairAddress
   - whaleActivity
   - contractRisk
   - source
   - freshness

5. `AgentRun`
   - runID
   - parentRunID
   - taskType
   - status
   - policyDecisions
   - agentModuleRuns
   - optionalDevelopmentSubagentRuns
   - artifacts
   - errors

## 9. Operations / Monitoring

### Required Ops Surface

- sync status
- source freshness
- run timeline
- agent module status
- development subagent status if subagents were used during implementation
- failed/degraded reason
- retry controls
- artifact path
- data source health
- policy blocks
- last successful refresh

### Required Health Checks

- WeChat source available?
- Market provider available?
- On-chain provider available?
- Snapshot stale?
- Runtime writeable?
- Agent queue blocked?
- Any policy violation?

## 10. Development Phases

### Phase 1: Product Shell Upgrade

Goal: convert existing dashboard into a real terminal shell.

- Add app-level navigation.
- Add Token Terminal view.
- Add WeChat Inbox view.
- Add Agent Console detail view.
- Add Settings/Ops view.
- Keep data mock/fixture but show realistic flows.

### Phase 2: Data Foundation

Goal: make data manageable.

- Introduce normalized WeChat message store.
- Introduce token entity store.
- Introduce market snapshot store.
- Introduce on-chain snapshot store.
- Add search/filter.

### Phase 3: Agent Runtime

Goal: make agent work auditable and composable.

- Add auditable agent task modules.
- Add optional development subagent lifecycle records when subagents are used during implementation.
- Add task queue.
- Add run artifacts.
- Add policy/capability matrix.

### Phase 4: Chain Data Integration

Goal: resolve CA/symbol to useful market/on-chain context.

- CMC / Crypto Skill Hub market data.
- DEX Screener / GeckoTerminal style liquidity data.
- Etherscan/Solana/RPC-style contract/holder data.
- Token risk labels.
- Freshness and confidence model.

### Phase 5: Team Productization

Goal: usable by 5-8 person team.

- Local/team workspace.
- Roles and permissions.
- Shared watchlist.
- Shared annotations.
- Exportable reports.
- Alert rules.
- Backup/retention.

## 11. Acceptance Criteria

A phase is not complete unless:

- UI has real navigation and clear workflows.
- Agent runs produce artifacts.
- Data stores persist normalized records.
- Web3 data has source/freshness/confidence.
- WeChat data source mode is explicit.
- If development subagents are used, their lifecycle and handoffs are recorded.
- Ops dashboard shows health/degraded states.
- `swift build` passes.
- relevant tests/checks pass.
- wiki checkpoint is updated.
