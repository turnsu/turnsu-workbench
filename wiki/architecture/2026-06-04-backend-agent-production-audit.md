# 后端 Agent 生产就绪审查报告

- 日期：2026-06-04
- 范围：`agent-runtime/`（Node pi-SDK daemon + extensions + control-plane）、`Sources/WeChatIntelligenceRadarApp/Services|Models/`（Swift 运行时/数据层）、`runtime/`（数据文件）、`Tests/`、`scripts/`、`.env`
- 方法：只读代码审查 + 真实 CMC MCP 对照取数，全部结论带 `file:line` 证据；四个维度（数据 / 工具调用 / 编排链路 / 架构与生产就绪）并行审查后综合
- 性质：从**实际生产应用**视角评估"一个真实、可信、融于工作流的 agent 工作台"还差什么

---

## 0. 执行摘要（TL;DR）

**一句话定性**：这是一套**"控制平面很重、执行平面很轻"的演示级 agent 外壳**——外观上具备完整的 artifact 体系、策略闸、事件流、措辞严谨的反幻觉系统提示词，给人"来源可信、边界清晰、自主编排"的观感；但底层 **agent 核心链路（plan → act → observe → synthesize）实际是断的**，数据管道是空的，且**标签与真相系统性背离**。

**触发本次审查的现象**：UI 输出 BTC ≈ $94,500 的看空 thesis（含 200 日均线 $92,300、颈线 $99,500、ETF 净流出 $184M、相关性 0.62 等）。实测：真实 BTC = **$65,810**（CMC MCP 实时），本地 fixture 写的是 **$109,500**，LLM 输出的 **$94,500 既非真实也非 fixture——纯幻觉**。

**最严重的 5 条红线（上生产前必须阻断）**：

| # | 红线问题 | 根因层 | 影响 |
|---|---|---|---|
| R1 | **工具结果从不回灌 LLM**，模型在"信息真空"里写金融分析 | 编排/数据管道断裂 | 价格幻觉是**架构必然**，改提示词无效 |
| R2 | **Live 微信后门**：policy 声明"阻断"，daemon 实际默认开启读真实私聊并外发第三方 LLM，绕过 policy/approval | 安全/合规 | 隐私合规事故；声明与实现矛盾 |
| R3 | **数据全是 fixture/写死/hash 合成，却被标 `isLive:true`/`freshness:fresh`** | 数据真实性 | 用户对假数据建立交易/研究决策 |
| R4 | **daemon HTTP 零认证** + `spawnSync` 命令执行面；**真实密钥明文落盘 `.env` 并全量继承给子进程** | 安全 | 本机任意进程可触发读微信+外发+耗付费配额；密钥易泄露 |
| R5 | **决策卡（含具体价位 $517.26、ETF $1.5B）是写死 fixture**，按关键词选卡冒充"分析结论" | 数据/编排 | 金融场景下编造可执行价位，资金风险 |

**结论**：作为**单用户、单机、研究用途**的本地原型，它能跑且"边界意识"在意图层面到位；但以本仓 `CLAUDE.md`「生产=零容错」的标尺衡量，**当前不可上生产**，主要卡在 R1–R5 + 测试/CI 全面缺失。**这不是若干个独立 bug，而是系统性的"外壳完整、内核缺失 + 标签不诚实"**。

---

## 1. 系统现状与架构事实

### 1.1 双 Runtime（当前最大架构债）

存在两套**各自独立、逻辑重复**的运行时：

- **Swift Runtime**（`Services/AgentOrchestrator.swift:113 run()`）：纯本地、确定性、同步流水线。读 fixture → 归一化 → entity/market/onchain → evidence/crystal/proposal/handoff，以 `.atomic` 写入 `runtime/<domain>/*.json`。**不调 LLM、不联网**。
- **Node Runtime**（`agent-runtime/bin/wechat-agent-daemon.mjs`，1698 行单体）：pi-SDK agent（`PiBackedAgentRuntime`）+ DeepSeek 流式推理。写 `runtime/agent/runs/{runID}/*` 一整套 control-plane artifact。
- **数据交换 = 文件系统，不是 HTTP 共享状态**：daemon 工具把产物写 `runs/{runID}/product-mutations.json`（`wechat-onchain-tools.ts:57-88`）；Swift 收到 SSE `run.completed` 后 `importAgentProductMutations`（`RuntimeBackend.swift:190`）读回合并进本地 store。HTTP 仅用于会话/消息/事件流。

两套 runtime **各实现了一套** "读数据→生成 crystal/proposal/handoff→写 runtime/" 的平行流水线，**外加两套独立的安全策略表**（见 3.2 / 3.4）。

### 1.2 真实数据/控制流（基于代码，非宣称）

```
HTTP POST /sessions/:id/messages(/async)
        │  (sync: 阻塞直到全程结束 | async: 立即 202 + SSE)
        ▼
runAgentTask(prompt, skills, extensions, attachments)
        │
        ├─ inferTools(prompt) ──正则关键词匹配──▶ tools[]      ← 不是规划，是分诊
        │
        ├─ buildControlPlane()  【一次性同步生成全部元数据；无 LLM；工具还没跑】
        │     ├ taskIntent / executionProfile(13 个写死 stage)
        │     ├ contextPlane ── summarizeJsonFile() ─▶ modelContext = "json keys=..." (只有 key 名/计数, 无真实价格/消息)
        │     ├ planner.mjs (静态模板 envelope, 无规划逻辑)
        │     ├ qaGate (只产 warning, 永不 fail)
        │     ├ modelRoute (恒定 deepseek; fallback 仅文字)
        │     └ checkpoint/retryLedger (resume/retry 不执行)
        │
        ├─ maybeWriteStrategyResult() ─正则选卡─▶ STRATEGIST_FIXTURES (写死价位 $517.26… )
        │
        ├─ for tool of tools:  【顺序循环, 无反馈, 工具间无数据传递】
        │     ├ policy != pass ? → skip (blocked / waitingForApproval)
        │     └ executeTool(tool, {恒定 params}) → tool-calls.json
        │                  ╳ 结果不进入 LLM ╳            ◀── R1 断点
        │
        ├─ callOpenAICompatible(deepseek, stream)   【唯一一次 LLM 调用】
        │     messages = [ system(agent-system.md),
        │                   user( prompt + skills + modelContext摘要 + liveWechat正文 ) ]
        │     ╳ 不含任何 tool 结果、不含真实价格 ╳   ← 模型在信息真空里写分析 (R1)
        │            └─ blocked/empty → deterministicAssistantText() (模板兜底冒充回答)
        │
        └─ 写 final-output.md (无 schema 校验) + run.completed (degraded/兜底也标 completed)

旁路: Live WeChat: maybeRefreshLiveWechatForRun ─spawnSync wechat-cli─▶ messages.live.json ─▶ 拼进 user message
      （这是唯一真正进入 LLM 的"真实数据"，且绕过 policy —— R2）
```

**关键事实**：LLM 请求体里**没有 `tools`/`functions`/`tool_choice`**（`wechat-agent-daemon.mjs:770-775`）——不存在 function-calling；工具在 LLM **之前**被顺序执行，结果只写盘、**不回灌**；所谓"多步串联"中工具间**零数据传递**（每个工具入参恒定，`:1016-1024`）。pi-SDK 本身支持 tool-use 多轮，但这里**没有接上 SDK 的 agent loop**。

---

## 2. 核心矛盾：为什么"看起来很完整却不可信"

1. **诚实的字段名 + 不诚实的取值**：系统有 `freshness/isLive/degraded/provenance/policy` 全套字段和反幻觉提示词，但 fixture/手动数据在多个环节被洗成 `fresh/isLive:true`，能力标志 `mcpToolAvailable/isLiveProvider` 被硬编码为 `true`，policy 高调声明"阻断 live 微信"却留后门。**这比完全没有标签更危险——它主动诱导用户与下游信任假数据。**
2. **控制平面很重，执行平面很轻**：十几个 control-plane artifact（task-intent / execution-profile / context / planner / qa / policy / checkpoint…）写得很完整，但服务于一个**不会真正用工具结果做推理的单轮 LLM 摘要**。
3. **幻觉不是模型的锅，是管道断裂**：提示词明令"只报数据内数字、禁止编造"，但工具结果根本不在模型输入里——模型被要求"只报真实数字"却手里没有任何真实数字，只能从训练记忆编造。**约束在运行时无法被满足、也无法被强制。**

---

## 3. 分维度问题清单

> 严重度：**P0 上生产前阻断** / **P1 尽快修** / **P2 质量与可维护性**。证据为 `文件:行`。

### 3.1 数据真实性

**[P0] D-1 没有任何数据域是真正实时的；4 套互相矛盾的写死 BTC 价并存**
- 证据：`cmc-skill-hub/fixtures/market-evidence.sample.json:16` BTC=**109500**；`runtime/market/cmc-skill-hub.normalized.json:19`/`latest-market-snapshot.json` BTC=**65810**（本次会话手动注入）；`CMCSkillHubCapability.swift:27` BTC=**76564.66**（标 `isLive:true`）；`Web3DataAdapter.swift` 的 `MockWeb3MarketDataAdapter` BTC=**68250**。
- 影响：不同入口显示完全不同"行情"，自相矛盾；真实 CMC MCP（`crypto-skill-hub`）**后端从未接入**（`cmc.request_mcp_refresh` 只写一个 request artifact，无任何外部调用，`extension.ts:166-181`）。

**[P0] D-2 fixture/手动数据被标 `freshness:fresh` + `isLive:true`，直达 UI**
- 证据：`cmc-skill-hub/extension.ts:65,75,81`——只要 normalized 文件**存在**即 `freshness:"fresh"`、`isLive:true`（只看文件存在性，不看真伪/时效）；Swift `MarketSnapshotStore.swift:39-52` 的 `normalizeFreshness` **只比较 `expiresAt` 与 now**，未过期即强制 `fresh`，无视底层是 fixture；`context-plane.mjs:21-30` 按**文件 mtime** 判 freshness（fixture 一被写就"fresh"）。
- 影响：用户看到带"实时/fresh"标识的价格，实际是开发者贴进去的过期快照。金融产品最严重的信任事故。

**[P0] D-3 Swift 主行情 provider 把"live CMC 可用"完全写死为 true**
- 证据：`Web3DataAdapter.swift:33-34` `isLiveProvider = true`；`:18-29` `currentEnvironment` 硬编码 `mcpToolAvailable:true, apiKeyConfigured:true` 并附伪造的"已调用 skill"证据；实际只读本地文件或回退写死价。
- 影响：整个系统自我报告"行情来自实时 CoinMarketCap MCP"，属于虚假来源声明。

**[P1] D-4 链上数据是 `hashValue` 伪造值，却带 0.64 置信度**
- 证据：`OnchainSnapshotService.swift:11-18`——`holders/poolLiquidityUSD/pairAddress` 全由 `tokenID.hashValue` 派生，`confidence:0.64`、`whaleActivity:"...neutral"`。
- 影响：伪造的链上指标带"中等可信"置信度与凭空结论。

**[P1] D-5 UI 核心指标卡是公式编造**
- 证据：`BriefingAgent.swift:53,60-62`——总消息写死 `"183,504"`、活跃群 `activeGroups*27+1`、@我 `replyNeeded*16+1`，无任何 fixture 标注。
- 影响：严重夸大产品覆盖度（"扫描 165 个群、183,504 条消息"全是凑数）。

**[P1] D-6 ETF/资金流/永续/情绪 100% 编造并进入决策卡**（与编排 O-4 同源，见 3.3）

**[P2] D-7 缺运行时 schema/数值校验**：`runtime/schemas/*.schema.json` 与 `typebox` **从未被 import 使用**；读取路径 `try/catch` 吞错返回 fallback，价格缺失静默变 0（`marketSnapshotFromEvidence` 用 `Number(x||0)`）。

### 3.2 工具调用机制

**[P0] T-1 没有 function-calling；"工具调用"是关键词路由的伪工具**
- 证据：LLM 请求体仅 `{model,messages,stream,temperature}`，**无 `tools`**（`wechat-agent-daemon.mjs:770-775`）；`inferTools` 用正则决定工具集、空集兜底塞 `wechat.read_normalized_messages/crystal.create_or_update/proposal.create`（`:622-652`）；工具在 LLM **之前**固定循环执行（`:962-1044`）。
- 影响：所谓"自主情报 agent"实为固定流水线 + 关键词分诊 + 一段独立 LLM 摘要。能力声明与实现严重不符。

**[P0] T-2 工具实现状态失真：read 工具薄读固定文件、write 工具是模板伪造、image/onchain 是占位**

| 工具 | 状态 |
|---|---|
| `wechat.read_normalized_messages` / `token.resolve_entities` / `market.read_snapshot` | 真实但很薄：读固定 JSON，`params.prompt` 被忽略 |
| `onchain.read_snapshot` | **近乎空壳**：只 `existsSync` 判目录，不读内容（`wechat-onchain-tools.ts:329`） |
| `crystal.create_or_update` / `proposal.create` / `handoff.write` | **模板伪造**：正则猜 token（`/eth/i→ETH…else BTC`，`:144`）、`confidence` 写死 **0.72**、`risk` 恒 `medium` |
| `image.analyze_with_kimi` | **占位**：仅判 `KIMI_API_KEY` 在否，**从不真正调用 Kimi**；主 LLM 恒走 deepseek 文本，图片二进制从不进 message |
| 根 `extensions/*.ts`（policy-gate/tool-runner/planner-runtime…） | **纯元数据 stub**，注释自承"实现在 daemon" |

- 影响："情报卡/行动建议"是确定性模板而非推理结论；图片理解、链上读取实质不可用。

**[P0] T-3 `needs_confirmation`/`blocked` 无"确认后执行"闭环（死端）**
- 证据：`:1004-1014` `policy!=="pass"` 直接 `continue`；唯一控制路由是 `pause|resume|cancel`（`:1591`），**没有 approve/confirm 端点**；`approval-decision.mjs:13-17` 自承不执行。
- 影响："人机确认"是假的——要么永远做不了，要么真正敏感动作根本不走这条路（见 T-4）。

**[P1] T-4 daemon HTTP 零认证 + 可触发本机命令执行**（与架构 A-1 同源）
- 证据：`:1562-1599` `handle()` 路由表无任何鉴权；`POST /sessions/:id/messages` → `inferTools` → `maybeRefreshLiveWechatForRun:1425` → `runWechatCli:1320` `spawnSync`。
- 影响：本机任意进程（含浏览器 DNS-rebinding）可无凭证触发 agent run、读微信、耗付费 key。

**[P2] T-5 工具入参不来自模型、几乎不校验**：入参由 daemon 在 `:1016-1024` 固定注入，参数化能力失效（如 `cmc.track_social_price_divergence` 的 `symbol` 永远走默认 `"BTC"`，`extension.ts:143`）。

### 3.3 编排/串联链路

**[P0] O-1 工具结果完全不回灌 LLM（= R1，价格幻觉的架构根因）**
- 证据：工具结果只流向 `tool-calls.json`（`:1015-1044`）；唯一 LLM 调用的 user content 只含 `prompt + modelContext摘要 + liveWechat`（`:1050-1058`）；`modelContext` 仅是 `summarizeJsonFile` 的 `"json object keys=..."`（`context-plane.mjs:5-19,126-129`），**不含任何价格/消息正文**。
- 影响：模型看不到 65810，提示词又要它"只报真实数字"，必然编造。**修提示词无效，是管道断裂。**

**[P0] O-2 planner 是静态模板，不是规划器**
- 证据：`planner.mjs:3-55` 无分支、无模型调用，`successCriteria/stopConditions` 全硬编码；`plannerMode` 写死 `"deterministic_control_plane_mvp"`（`execution-profile.mjs:39`）。

**[P0] O-3 工具间无数据传递（顺序执行 ≠ 串联）**
- 证据：循环里每个工具入参恒定（`:1016-1024`），无 `previousResult`；写类工具不读其它工具输出，用 prompt 正则猜 token + 硬编码 confidence（`wechat-onchain-tools.ts:142-166`）。

**[P0] O-4 strategist 决策卡是写死 fixture，按关键词冒充"分析结论"（= R5）**
- 证据：`STRATEGIST_FIXTURES`（`:1450-1534`）三张完整结论卡硬编码在源码（含 `$517.26`、`ETF 净流出 $1.5B`、`funding -0.31%`、`keyLevels price:0.038`）；`detectStrategistTaskType:1536` 正则选卡；Swift 侧 `CMCStrategistModels.swift:146-263` 另存一份（数值还不一致：daemon `$1.5B` vs Swift `$480M`）。
- 影响：用户问 ZEC 永续，稳定吐出"$517.26 是决定性价位、跌破级联到 $499→$477"——源码写死的虚构可执行价位。即便标 `fixture`，呈现方式让人当真。

**[P1] O-5 QA gate 结构上永远不可能 fail**
- 证据：`qa-gate.mjs:5-33` 只产 `warning/info`，`status==failed` 唯一条件是有 `error` 级 issue，而 error 永不产生 → 永远 `pass`/`pass_with_warnings`；且 QA 在工具/输出**之前**算，看不到产出。

**[P1] O-6 输出无 schema 校验**：唯一"校验"是 `schema-validator.mjs:46-56` 的 `validateRequired`（仅查顶层 key 非 null），不校验类型/枚举/`final-output.md`。

**[P1] O-7 checkpoint/resume 不可用、retry 从不执行**
- 证据：`checkpoint.mjs:13-14` 标 `resumeSupported:true`，但 daemon `:349-363` 只认 `pause/cancel`，`resume` 落入 "return running"（只是取消暂停，非断点恢复）；`retry-ledger` 写完即弃，`maxRetries:0`。

**[P1] O-8 视觉链路断**：带图也只调 deepseek 文本，图片从不发给任何视觉 provider（`wechat-onchain-tools.ts:391-405`、`:1050-1057`）。

**[P1] O-9 model-route 无真正 fallback；默认模型名疑似不存在**：恒定 deepseek（`:1051`），`fastModel` 定义却从不用；`model-providers.json:13,27` 默认 `deepseek-v4-pro`/`kimi-k2.6` 疑为占位/臆造名。

**[P2] O-10 degraded 静默通过 + 兜底文案冒充真回答**：`deterministicAssistantText`（`:1060-1065`）在无 key/失败时生成模板文字，走与正常输出**完全相同**的 `assistant`/`run.completed` 路径，前端无法区分。

### 3.4 架构与生产就绪

**[P0] A-1 daemon 零认证 + spawnSync 命令面**（= T-4/R4）；`WECHAT_AGENT_DAEMON_HOST` 可被 env 改成 `0.0.0.0`（`:32-33`）。

**[P0] A-2 真实密钥明文落盘 `.env` 并全量继承给子进程**
- 证据：`.env:6,12` 真实 `DEEPSEEK_API_KEY/KIMI_API_KEY=sk-...`（非占位符；`.gitignore` 已忽略，故**非 git 泄露**，是本机明文 + 传播习惯问题）；`.env:25` `WECHAT_LIVE_ENABLED=true`；`.env:28-29` 残留**他人**绝对路径 `/Users/terryhuang/...`（说明 `.env` 在机器/人之间拷贝）；`runWechatCli` 的 `spawnSync` 未隔离 env，把**全部** `process.env`（含 key）继承给第三方 `wechat-cli`。

**[P0] A-3 Live 微信后门绕过 policy（= R2，合规红线）**
- 证据：声称阻断——`PolicyGate.swift:48-59`、`wechat-cli/extension.ts:135-155`、`policy-decision.mjs:4-5` 均列 blocked；实际能读——`maybeRefreshLiveWechatForRun:1425-1444` 在 `WECHAT_LIVE_ENABLED=true` 且工具集含 `wechat.read_normalized_messages`（几乎所有含"微信"的 prompt 或空兜底都会命中）时，`spawnSync` 跑 `wechat-cli sessions/history`（`:1352-1420`）抓真实私聊，写 `messages.live.json` 并**拼进 LLM prompt 外发 DeepSeek**；Swift `WeChatFixtureFileAdapter.swift:62-67` 让 `messages.live.json` **优先于** fixture 进 UI。daemon health 自报 `policy.liveWechat:"local"`，与 Swift "blocked" 矛盾。

**[P0] A-4 共享 JSON 并发写无锁、非原子**
- 证据：daemon `writeJSON:279` 裸 `writeFileSync`（无 tmp+rename）、`appendFileSync` 写 `events.ndjson`；`appendUnique`（`wechat-onchain-tools.ts:78-88`）是无锁 read-modify-write；Swift 虽 `.atomic`，但两 runtime 各自写**同一批共享文件**（crystals/tasks…）。
- 影响：崩溃中途写 → 文件截断 → `readJSON` 静默 fallback（丢数据无告警）；多 async run 交错 lost-update。

**[P1] A-5 单体 1698 行 daemon + 内存单例会话 = 不可扩展 + 无故障恢复**：`piRuntime` 模块级单例、`SessionManager.inMemory`；进程重启 → 内存会话与 `activeRunID` 丢失，运行中的 run 变孤儿（`run-manifest` 停在 `running`，无 reaper）。

**[P1] A-6 双 runtime 逻辑重复且会漂移**：两套策略表（`PolicyGate.swift` `executeTrade/...` vs daemon `policyForTool`+`blockedActions`，命名都不一致）、两套 crystal/proposal/handoff 生成、两处 taskType 推断；产物 schema 双写，演进时 import 解码静默失败（`try?` 吞错）。

**[P1] A-7 import/产物消费链路静默失败**：Swift 全用 `_ = try? ...persist`、`try?` 解码（`RuntimeBackend.swift:203+`、`AgentRuntimeStores.swift:120,305`）；失败仅写 `commandStatus`，无日志/指标/告警。

**[P1] A-8 可观测性/审计不达标**：仅 `console.log` 到无轮转的 `daemon.log`；无结构化日志/request-id 关联；无 CLAUDE.md 要求的"变更前后 diff + 理由 + 时间"审计条目；敏感操作（live 微信）只在 events 留 type，无 who/why。过度脱敏（`safeToolDetail:366` 把 `messages/text/content/summary` 全 `[REDACTED]`）导致**排障时看不到工具到底读到了什么**。

**[P1] A-9 `runtime/agent/runs/` 无限增长**：每 run 一目录（~20 artifact + events.ndjson），无 TTL/归档；`readSessions/readTasks` 每次全目录扫描解码。

**[P2] A-10 测试形同虚设**：`AgentRuntimeTests.swift:4` 是顶层 `let agentRuntimeChecks: Void = {...}()`，113 处 `precondition`，但该符号**无任何引用**、无 `import XCTest`/`XCTestCase` → `swift test` **实际执行 0 个断言**（已验证：只 build 不跑）。**零有效自动化测试。**

**[P2] A-11 无 CI / 无一键 validate**：无 `.github/`、无 CI yaml；`npm test` 仅 3 个 smoke 且强制 `WECHAT_AGENT_MOCK_PROVIDER=1`（不覆盖真实 LLM）；无 SwiftLint、无 security scan。与 `CLAUDE.md` 第 4 章直接冲突。

**[P2] A-12 部署脚本面向单机开发**：`start-agent-daemon.sh` 用 `nohup &` + PID 文件，无 launchd/健康探针/优雅关闭（`stop` 直接 `kill` → 孤儿 run）；release 用 ad-hoc `codesign --sign -`，无公证，无法对外分发。

**[P2] A-13 SSE 靠 250ms 轮询读整文件**：`setInterval(250ms)` 反复 `readFileSync` 整个 `events.ndjson`（`:1259`），run 长时 O(n²) 读放大，且与 `appendFileSync` 写竞争。

---

## 4. 跨维度系统性根因

1. **缺少真正的 Agent Loop**：plan→act→observe→synthesize 四环全部以"占位/正则/单轮"实现——planner 是模板、工具是关键词路由且结果不回灌、综合是信息真空里的单轮 chat。**这是幻觉、伪工具、伪串联的共同根因。** pi-SDK 的 tool-use 能力被旁路。
2. **数据管道是空的，标签却是满的**：没有任何实时数据源接入，但 freshness/isLive/provenance 字段被各环节"洗白"。**字段诚实、取值不诚实**，比无标签更危险。
3. **安全边界"声明 vs 实现"分裂**：策略表有 ≥4 套且口径不一；最敏感的 live 微信读取走了一条不过 policy 的后门；HTTP 无认证、密钥明文继承给子进程。**安全边界没有单一事实源。**
4. **无质量保障闭环**：QA gate 永不 fail、无 schema 校验、`swift test` 不执行、无 CI/lint/security scan、错误全程 `try?` 静默吞。**没有任何回归网，"完成"无法被证明。**
5. **双 runtime 重复 = 必然漂移**：两套平行实现靠文件松耦合，缺单一 schema/策略来源，演进时静默失配。

---

## 5. 本次会话已做的缓解（及其局限）

> 透明记录：审查期间为验证/止血做了少量改动，**均为权宜，根因未除**。

- **真实数据注入**：用真实 CMC MCP 拉 BTC/ETH/SOL（$65,810 / $1,836 / $73.16）写入 `runtime/market/cmc-skill-hub.normalized.json` + `latest-market-snapshot.json`。**局限**：一次性手动注入、会过期；且它正是 D-2 指出的"被标 fresh"的来源——**没有自动刷新桥**，下次不刷新就又陈旧。
- **prompt 数据纪律**：`agent-system.md` 加"Data integrity"硬约束（只引用快照字段、禁编造、`isLive:false` 必须标非实时）。**局限**：因 O-1（工具结果不回灌），模型仍拿不到真实数字，**该约束运行时无法被满足**——治标。
- 前端侧（主题/streaming/Inspector 精简、markdown+表格渲染、术语映射）已落地，与后端审查问题正交。

**核心结论不变**：在 O-1（工具结果回灌）与真实数据源自动化打通之前，幻觉与失真仍是架构必然。

---

## 6. 整改路线图（分阶段，按风险排序）

### 阶段 0 — 安全/合规止血（1–2 天，对应 R2/R4、A-1/A-2/A-3/A-4）
- daemon 强制 loopback、拒绝非 `127.0.0.1` 绑定；启动生成本地 shared-secret，Swift 客户端带 `Authorization`；校验 `Origin/Host` 防 DNS-rebinding。
- 密钥移出工作目录（Keychain/launchd 注入）；`spawnSync` 改**白名单 env**，剔除所有 `*_API_KEY`；轮换已落盘的 key；清理 `.env` 他人路径。
- **统一 live 微信边界**：要么正式受控开放（显式用户授权 UI + 审计 + 脱敏），要么彻底移除 daemon 后门。绝不"policy 说禁止、代码留后门"。`messages.live.json` 进 LLM 前必须脱敏。
- daemon 全部 JSON 写改 `tmp + rename` 原子写；`product-mutations` append 加进程内串行队列。

### 阶段 1 — 让 Agent 真正成立（1–2 周，对应 R1/R5、O-1/O-3/O-4、T-1/T-2）
- **接通 pi-SDK 原生 agent loop**（或 provider function-calling）：把工具 schema 交给模型，模型发起 tool_call → 执行 → 结果作为 `role:"tool"` 回灌 → 多轮直到收敛。**这是消除幻觉的根治点。**
- 在回灌打通前，**prompt 层硬禁模型输出任何具体价格/价位**；strategist 决策卡在接真实数据前**禁渲染或强制"样例·禁止交易"水印（正文非元数据）**。
- write 类工具（crystal/proposal）改为**消费前序工具的真实结构化结果**，删除 prompt 正则猜 token + 硬编码 0.72。

### 阶段 2 — 消除漂移 + 真实数据自动化（1–2 周，对应 A-6/D-1/D-2）
- **单一策略来源**：抽 `runtime/policy.json`，Swift 与 daemon 同源加载，删两份枚举 + 一致性测试。
- **单一 schema 来源**：product-mutations/RuntimeObjectReference 用 JSON Schema，两侧强制校验，解码失败上报不吞。
- **真实 CMC 自动刷新桥**：定时调 CMC skill hub 写 normalized 文件；freshness 由**数据自带时间戳 + provider 类型**决定，fixture/手动 provider 一律不得产出 `fresh/isLive:true`。
- 修 D-3/D-4/D-5：`isLiveProvider` 反映真实运行时能力；onchain 伪造值 confidence 归 0 或省略；UI 指标卡基于真实计数或显式标演示。

### 阶段 3 — 可运维化（2–4 周，对应 A-5/A-8/A-9、O-5~O-9、A-10~A-13）
- 拆分单体 daemon（http / orchestrator / provider / wechat-cli-adapter / fixtures-data）；run 状态持久化 + 崩溃恢复 reaper + 优雅关闭。
- QA gate 对真正应阻断项升级为 error 并移到产出后；用 `typebox` 真实校验 artifact 与 `final-output.md`。
- 实现 resume（artifact replay）或如实下架该承诺；model-route 真 fallback；接通或下架视觉链路。
- 结构化日志 + 轮转 + runID 贯穿 + 敏感操作审计；`runs/sessions/tasks` 加 TTL/归档/索引；SSE 改 `fs.watch`/事件总线。
- **建 CI**：迁 XCTest 真跑测试 + daemon 契约测试（mock provider 验流式）+ SwiftLint + secret-scan + build + 签名/公证。

### 阶段 4（目标态，可选）
- 若要多用户/并发：`runtime/` 文件库升级为嵌入式事务存储（SQLite/WAL）；或 daemon 拆"无状态 HTTP + 持久化队列 + worker"，run 入队、状态进 DB，根除并发与单点。

---

## 7. 附录：关键文件清单

| 文件 | 关键证据 |
|---|---|
| `agent-runtime/bin/wechat-agent-daemon.mjs` | 工具循环 962-1044 / LLM 调用 1050-1058（无 tools、不回灌）/ inferTools 622-651 / live 微信 879,1320-1444 / STRATEGIST_FIXTURES 1450-1534 / 无认证路由 1562-1599 / 非原子写 279 / 恒定 deepseek 1051 / SSE 轮询 1259 |
| `agent-runtime/control-plane/context-plane.mjs` | modelContext 仅 key 名 5-19,126-129；mtime 判 freshness 21-30 |
| `agent-runtime/control-plane/{planner,qa-gate,schema-validator,checkpoint,model-route}.mjs` | 静态 planner / QA 永不 fail / 仅 key-presence 校验 / resume 不执行 / 无 fallback |
| `agent-runtime/extensions/wechat-onchain-tools.ts` | 模板产物+硬编码 0.72（142-166）/ 薄读·占位工具（289-421）/ 无锁 appendUnique（78-88） |
| `agent-runtime/extensions/cmc-skill-hub/extension.ts` | fixtureProvider 默认（53）/ fresh·isLive 仅看文件存在（65,75,81）/ MCP 仅写 request（166-181） |
| `agent-runtime/extensions/wechat-cli/extension.ts` | live_command 声明 blocked（135-155）——与 daemon 后门矛盾 |
| `Sources/.../Services/Web3DataAdapter.swift` | isLiveProvider=true（33-34）/ 硬编码能力标志（18-29） |
| `Sources/.../Services/CMCSkillHubCapability.swift` | 硬编码价标 isLive:true + 伪造调用证据（12-55） |
| `Sources/.../Services/MarketSnapshotStore.swift` | normalizeFreshness 只看 expiresAt（39-52） |
| `Sources/.../Services/OnchainSnapshotService.swift` | hashValue 伪造 + confidence 0.64（11-18） |
| `Sources/.../Services/BriefingAgent.swift` | 公式编造指标 183504（53,60-62） |
| `Sources/.../Services/PolicyGate.swift` ↔ daemon `policyForTool` | 双策略表漂移 |
| `Sources/.../Models/CMCStrategistModels.swift` | strategist fixture 第二份（数值与 daemon 不一致，146-263） |
| `Tests/WeChatIntelligenceRadarAppTests/AgentRuntimeTests.swift` | 顶层 let，swift test 不执行（4） |
| `.env` | 真实 key + WECHAT_LIVE_ENABLED=true + 他人绝对路径 |
| `scripts/{start,stop}-agent-daemon.sh` | nohup 部署、无优雅关闭 |

---

## 8. 审查方法与边界

- 全程只读审查 + 真实 CMC MCP（`crypto-skill-hub` / `altcoin_token_profile`）对照取数（BTC=$65,810 @2026-06-03T16:03Z），未修改后端逻辑代码；第 5 节列出的数据/prompt 缓解为审查期止血。
- 四维度（数据/工具/编排/架构）由独立审查通道并行产出，本报告做去重、交叉验证与优先级综合；所有结论可按附录 `file:line` 复核。
- 局限：未做动态压测/并发实测/渗透测试；`spawnSync` 命令注入、DNS-rebinding 等为静态推断的攻击面，建议后续以实际 PoC 验证。
