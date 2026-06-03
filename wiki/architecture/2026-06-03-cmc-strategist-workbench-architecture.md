# CMC 策略师工作台架构指引

Date: 2026-06-03

## 背景与目标

本文件用于指导下一阶段开发一个面向团队策略师日常使用的 CMC Skill 工作台。用户提供的三个 showcase HTML 分别展示了：

- Alpha Discovery：从全市场扫描发现 HOME，再通过深度分析拒绝追高，等待关键回踩价位。
- Perp Trade Review：围绕 GENIUS / ZEC 永续持仓，回答持有、止盈、退出、是否被 squeeze 的决策问题。
- Macro Short Review：围绕 BTC ETF 流出、跨资产相关性和反证，跟踪一个宏观做空 thesis。

工作台不应复刻这些 HTML 的静态叙事页面，而应把其中的策略师工作流产品化：让用户选择 CMC 能力包、提交策略问题、看到结构化分析卡、关键价位、场景图、反证、证据来源和风险边界，并把完整运行记录写入本地 artifact。

首版目标是 **决策支持工作台**，不是自动交易系统。交易、转账、外部发布、真实微信读取、未经确认的 live MCP refresh 仍保持 blocked 或 needs_confirmation。

## 现状架构审查

当前项目已经具备搭建策略师工作台的基础，但缺少面向策略决策的稳定读模型。

### SwiftUI 前端

- `DashboardView` 和 `TerminalWorkspaceViews` 提供桌面 shell，包括 Home、Agent Console、Token、Watchlist、Data/Ops 等工作区。
- `AgentWorkspaceV2View` 已经是 thread-first 工作台形态：左侧 session rail，中间对话与 composer，右侧 inspector，底部 inline run status。
- `AgentComposerBar` 支持通过 Add 或 `/add` 选择能力包，前台只展示 Skill / Extension，不展示内部 tool/provider/module。
- `AgentThreadMessageRow`、`CapabilityCallCard`、`FinalOutputCard` 已能承载能力调用、执行状态、最终输出和 artifact 链接。
- `AgentInspectorV2Panel` 已能查看 message、tool call、policy、event、artifact、task、context，但目前还没有策略读模型专用视图。

### Swift 状态与接口

- `DashboardViewModel` 负责刷新 Agent workspace、读取 session/task/event/tool call/run manifest，并通过 `submitAgentPrompt()` 提交任务。
- `AgentDaemonClient` 的提交接口已经包含：
  - `prompt`
  - `selectedSkillIDs`
  - `selectedExtensionIDs`
  - `attachments`
  - `contextRefs`
- `AgentWorkspaceStateAdapter` 将 daemon session、SSE event、tool call、run manifest 转为用户可读的 thread state。
- 当前模板来源有两层：
  - `agent-runtime/runtime/public-surface.json` 暴露 public templates。
  - `AgentWorkspaceTaskTemplates.all` 在 Swift 侧仍是静态模板。后续若要让前端完全跟随 public surface，需要补一层 remote template adapter；首版可以同步维护两处。

### Node Agent Runtime Host

- `agent-runtime/bin/wechat-agent-daemon.mjs` 是本地 Agent Runtime Host，提供 health、capabilities、sessions、async messages、SSE events、run control。
- `inferTools()` 依据 `selectedSkillIDs` / `selectedExtensionIDs` 和 prompt 推导内部 tools。
- control plane 已有：
  - `task-intent.mjs`
  - `execution-profile.mjs`
  - `context-plane.mjs`
  - `planner.mjs`
  - `tool-intent-plan.mjs`
  - `policy-decision.mjs`
  - `approval-decision.mjs`
  - `qa-gate.mjs`
  - `runtime-metrics.mjs`
  - `checkpoint.mjs`
- Context Plane 会整理 prompt、附件、selected context refs、runtime artifacts，但目前只是 artifact summary 级别，不理解策略结果结构。
- QA Gate 当前检查 context、tool intent、policy、secrets、raw private transcript。后续应加入策略输出质量检查。

### CMC Skill Hub Extension

`agent-runtime/extensions/cmc-skill-hub/` 已经按 extension package 组织：

```text
manifest.json
extension.ts
skills/
tools/
providers/
normalizers/
schemas/
policies.json
fixtures/
```

当前 public extension / skills：

- Extension：`cmc-skill-hub`，前台显示为 `CoinMarketCap MCP 能力包`。
- Skill：`cmc-market-radar`、`market-regime-review`、`social-price-divergence`。
- 内部 tools：`cmc.read_market_evidence`、`cmc.detect_market_regime`、`cmc.track_social_price_divergence`、`cmc.request_mcp_refresh`。
- Provider：`fixtureProvider`、`normalizedFileProvider`、预留 `mcpProvider`。

当前 `cmc-skill-hub-result-v1` 主要写入市场快照和 CMC evidence，尚未写入 Alpha/Perp/Macro 这类策略师可直接扫描的结构化结果。

### Runtime Artifacts

当前 run 记录位于 `runtime/agent/runs/{runID}/`，关键文件包括：

- `run-manifest.json`
- `task-intent.json`
- `context-bundle.json`
- `policy-decisions.json`
- `tool-calls.json`
- `final-output.md`
- CMC extension 写出的 `cmc-{skillName}.json`

策略工作台应继续使用 manifest-first 方式：Swift 前端消费轻量 read model 和 artifact path，完整细节留在本地 artifact 中。

## Showcase 工作流抽象

三个 showcase 的共性不是“收益展示”，而是“把 raw CMC/市场数据转成策略师可执行的判断结构”。

| Showcase | 策略任务 | 用户问题 | 核心输出 | 工作台映射 |
| --- | --- | --- | --- | --- |
| HOME alpha scanner | Alpha Discovery | 这个新冒出的币是真 alpha 还是顶部 FOMO？ | 候选资产、扫描理由、拥挤度、关键回踩价、等待条件 | 候选卡、Deep Dive 卡、关键价位卡、观察任务 |
| GENIUS / ZEC perp | Perp Trade Review | 我已经持仓盈利，继续拿还是退出？会不会 squeeze？ | 场景 A/B/C、触发线、目标区间、反向风险 | 持仓复核卡、场景图、风险卡、跟踪 checklist |
| BTC macro short | Macro Short Review | 技股上涨时，BTC 基本面恶化是否支持做空 thesis？ | ETF 流出、跨资产相关性、反证、thesis 跟踪 | 宏观 thesis 卡、证据时间线、反证卡、监控项 |

### 1. Alpha Discovery

工作流：

```text
扫描候选
  -> 识别异常：涨幅、OI、funding、volume、social/叙事
  -> 深度分析：spot/perp 是否一致、是否 perp-led、是否拥挤
  -> 给出关键价位：追高区、回踩区、失效区
  -> 转观察：等待触发，不生成交易指令
```

首版模板：

```text
帮我用 CMC 能力包扫描今天值得进一步研究的 alpha 候选，只输出研究候选、关键价位、反证和后续观察条件，不给下单指令。
```

输出卡片：

- `CandidateCard`：symbol、name、setup、score、why now、data freshness。
- `StructureCard`：perp/spot/social/narrative 四象限。
- `KeyLevelCard`：avoid chase、pullback zone、invalidation floor。
- `NextWatchCard`：需要等待的价格/成交量/OI/funding/social 条件。

### 2. Perp Trade Review

工作流：

```text
读取用户持仓背景
  -> 复核 perp 结构：price、OI、funding、CVD、liquidation、holder concentration
  -> 生成场景图：A squeeze / B breakdown / C range
  -> 标出触发条件和失效条件
  -> 生成持有、止盈、退出的决策支持，不代替用户决策
```

首版模板：

```text
我有一个永续持仓，请用 CMC 能力包复核结构，给出 squeeze / breakdown / range 三个场景、关键触发线、反证和风险边界。
```

输出卡片：

- `PositionContextCard`：symbol、direction、entry、leverage、timeframe、user thesis。
- `ScenarioMapCard`：A/B/C 场景、if 条件、then 价格区间、confidence。
- `HiddenRiskCard`：holder concentration、funding crowding、liquidation risk、data gaps。
- `DecisionSupportCard`：hold / reduce / exit / wait 的条件式判断，禁止直接下单文案。

### 3. Macro Short Review

工作流：

```text
读取宏观 thesis
  -> 追踪基本面流：ETF flow、AUM、institutional demand
  -> 追踪跨资产：BTC/Nasdaq、BTC/Gold、risk-on beta 是否失效
  -> 纳入反证：LTH accumulation、stablecoin liquidity、macro event
  -> 生成 thesis health、关键失效条件和后续观察任务
```

首版模板：

```text
帮我复核 BTC 宏观 thesis：ETF 流、跨资产相关性和反证是否支持继续观察空头逻辑，只做决策支持和监控项。
```

输出卡片：

- `ThesisCard`：thesis、time window、supporting forces、confidence。
- `FlowEvidenceCard`：ETF flow、AUM、institutional demand。
- `CrossAssetCard`：BTC/Nasdaq、BTC/Gold、risk-on/risk-off interpretation。
- `CounterEvidenceCard`：反对 thesis 的数据和需要触发重新评估的条件。
- `ThesisWatchCard`：未来 24h/72h 需要监控的指标。

## 目标工作台信息架构

### 左侧：策略任务入口

左侧保留当前 session rail，但增加策略师任务入口：

- 最近会话：继续使用现有 Agent sessions。
- 策略模板：
  - Alpha Scanner
  - Perp Position Review
  - BTC Macro Thesis Review
  - Market Regime Check
  - Social/Price Divergence
- 观察列表：展示用户已保存的 candidates、positions、theses。首版可先读本地 artifact summary，不做完整 watchlist 后端。

注意：左侧不展示 raw tools。能力仍通过 Composer 的 Add / `/add` 进入。

### 中央：策略任务流

中央继续使用 thread-first UI，但 Assistant message 里应渲染策略专用卡片：

```text
User prompt
  -> Plan Summary
  -> CMC Skill Call Card
  -> Strategy Result Card
  -> Scenario Map / Key Levels / Counter Evidence
  -> Final Output + artifact link
```

策略结果卡要能被快速扫描：

- 一句话 verdict。
- 核心价格或条件。
- 需要等待什么。
- 哪些数据支持。
- 哪些数据反对。
- 风险边界。

### 右侧：证据与复核

Inspector 应围绕策略结论展开，而不是只显示技术事件：

- Evidence：数据来源、freshness、provider、artifact path。
- Key Levels：价格、角色、触发条件、失效条件。
- Counter Evidence：反证、权重、需要重新评估的条件。
- Risk Boundary：不构成投资建议、不下单、杠杆风险、缺失数据。
- Audit：run manifest、tool calls、policy、QA gate。

### 底部：执行与记录

沿用 `AgentRunInlineStatus` 和 run manifest：

- 显示当前阶段：整理上下文、调用 CMC、生成策略读模型、质量检查、完成。
- 显示 event count 和 artifact link。
- 对 needs_confirmation 或 blocked 明确显示，不用模糊成功态。

## 接口与读模型

### Public Surface

在 `agent-runtime/runtime/public-surface.json` 和 `agent-runtime/extensions/cmc-skill-hub/manifest.json` 中增加面向策略师的模板或 public skill。建议先增加模板，避免过早膨胀 skill 列表。

建议新增 templates：

```json
[
  {
    "templateID": "cmc-alpha-scanner",
    "title": "Alpha Scanner",
    "skillIDs": ["cmc-market-radar", "market-regime-review", "social-price-divergence"],
    "extensionIDs": ["cmc-skill-hub"]
  },
  {
    "templateID": "cmc-perp-position-review",
    "title": "Perp Position Review",
    "skillIDs": ["cmc-market-radar", "market-regime-review"],
    "extensionIDs": ["cmc-skill-hub"]
  },
  {
    "templateID": "cmc-btc-macro-thesis-review",
    "title": "BTC Macro Thesis Review",
    "skillIDs": ["cmc-market-radar", "market-regime-review"],
    "extensionIDs": ["cmc-skill-hub"]
  }
]
```

Swift 首版同步更新 `AgentWorkspaceTaskTemplates.all`，直到前端模板完全从 `/capabilities` 动态读取。

### CMC Result Artifact

保持现有 `cmc-skill-hub-result-v1` 向后兼容，在结果中新增 `strategyReadModel` 字段。

建议结构：

```json
{
  "schemaVersion": "cmc-skill-hub-result-v1",
  "runID": "run-...",
  "provider": "normalizedFileProvider",
  "skillName": "daily_market_overview",
  "marketSnapshotArtifact": "runtime/market/latest-market-snapshot.json",
  "evidence": {},
  "strategyReadModel": {
    "schemaVersion": "cmc-strategist-result-v1",
    "taskType": "alpha_discovery",
    "title": "HOME squeeze candidate, wait for pullback",
    "verdict": "研究候选成立，但不追高，等待关键回踩区。",
    "subject": {
      "symbol": "HOME",
      "name": "Defi App",
      "instrument": "spot/perp",
      "directionContext": "watch_long_setup"
    },
    "confidence": 0.72,
    "dataFreshness": "fresh",
    "candidateSignals": [
      {
        "label": "Perp squeeze",
        "value": "OI +201%, funding -0.31%",
        "interpretation": "拥挤且可能继续挤压，但不是低风险追高点。",
        "evidenceRefs": ["runtime/agent/runs/{runID}/cmc-daily_market_overview.json"]
      }
    ],
    "keyLevels": [
      {
        "label": "Pullback zone",
        "price": 0.038,
        "upperPrice": 0.0405,
        "role": "wait_for_entry_review",
        "condition": "价格回踩且结构未破坏",
        "invalidatesBelow": 0.035
      }
    ],
    "scenarios": [
      {
        "id": "A",
        "label": "Continuation squeeze",
        "if": "价格守住回踩区，OI 不塌，funding 修复",
        "then": "继续观察上方流动性区",
        "bias": "constructive",
        "confidence": 0.55
      }
    ],
    "counterEvidence": [
      {
        "label": "Spot confirmation weak",
        "detail": "spot CVD 未确认，结构偏 perp-led",
        "severity": "medium"
      }
    ],
    "sourceMap": [
      {
        "label": "CMC market evidence",
        "artifactPath": "runtime/agent/runs/{runID}/cmc-daily_market_overview.json",
        "freshness": "fresh",
        "provider": "normalizedFileProvider"
      }
    ],
    "riskBoundary": {
      "tradeInstruction": "blocked",
      "summary": "仅做研究与决策支持，不生成下单、仓位或杠杆指令。",
      "warnings": ["杠杆会放大亏损", "缺少 live liquidation map 时必须标记数据缺口"]
    },
    "followUps": [
      {
        "label": "Track pullback zone",
        "condition": "price enters 0.038-0.0405 and funding normalizes",
        "suggestedSkillIDs": ["cmc-market-radar"]
      }
    ]
  },
  "generatedAt": "..."
}
```

### Task Intent

`task-intent.mjs` 应识别策略师任务类型：

- `cmc_alpha_discovery`
- `cmc_perp_trade_review`
- `cmc_macro_thesis_review`

识别来源：

- 选中的 CMC skills/extensions。
- prompt 中的 alpha、scanner、候选、perp、永续、short、ETF、correlation、宏观、thesis 等关键词。
- 模板 ID。当前 request body 没有 templateID，首版可通过 prompt + selected skills 推断；后续可将 templateID 加入 message request。

### Tool Intent

首版无需暴露新工具给前端。Node 内部可在现有 CMC tools 后增加本地 normalizer 步骤，生成 `strategyReadModel`。

如果后续拆分工具，建议内部工具名：

- `cmc.build_alpha_discovery_read_model`
- `cmc.build_perp_review_read_model`
- `cmc.build_macro_thesis_read_model`

这些工具仍属于 CMC extension 内部工具，不进入前台 Add 菜单。

### Swift Read Model

Swift 侧新增轻量模型即可，不读取 raw provider：

```text
CMCStrategistResult
  -> taskType
  -> title / verdict / confidence / dataFreshness
  -> subject
  -> candidateSignals
  -> keyLevels
  -> scenarios
  -> counterEvidence
  -> sourceMap
  -> riskBoundary
  -> followUps
```

渲染层建议：

- `StrategyResultCard`
- `ScenarioMapView`
- `KeyLevelsView`
- `CounterEvidenceView`
- `RiskBoundaryView`

接入方式：

- `AgentWorkspaceStateAdapter` 从 run manifest artifacts 或 final-output 附带 artifact path 发现 CMC strategy result。
- `AgentMessagePart` 可新增 `.strategyResult(CMCStrategistResult)`；不建议把所有内容塞进 `.text`。
- Inspector selection 可新增 `.strategyResult(String)` 或复用 `.artifact(path)`，首版建议先复用 artifact path，减少状态面。

## 安全与合规边界

工作台必须稳定表达以下边界：

- 不生成“买入/卖出/开仓/平仓/几倍杠杆”的直接指令。
- 可生成条件式决策支持：如果 X 发生，则需要复核 Y；如果失守 Z，则 thesis 失效。
- 用户自有 entry、exit、leverage 可以作为上下文展示，但不得包装成 Agent 指令。
- Live CMC MCP refresh 只有在外部 connector 已配置且用户确认后才可执行；缺失配置时显示 degraded/blocked。
- CMC fixture 或 normalized file 输出必须明确标记 provider 和 freshness，不能描述为 live CMC。
- Raw provider request、API key、Authorization header、私有微信原文 dump 不进入前台或 artifact。
- 每个策略结论必须有 artifact/source pointer；没有证据时显示 `data_gap`。

## 开发阶段建议

### Phase 1：文档与模板

- 新增本文档。
- 在 public surface 和 Swift 静态模板中加入三个策略师模板。
- 保持现有 runtime 逻辑不变，先让策略师能用模板启动任务。

### Phase 2：CMC Strategy Read Model

- 在 CMC extension 输出中新增 `strategyReadModel`。
- 为 fixture provider 补一份可复现的 alpha/perp/macro 示例数据。
- 在 QA Gate 中增加策略输出检查：
  - 必须有 verdict。
  - 必须有 sourceMap。
  - 有关键价位时必须有 invalidation 或 condition。
  - 有方向性判断时必须有 counterEvidence。
  - riskBoundary.tradeInstruction 必须为 blocked。

### Phase 3：Swift Strategy Cards

- 增加 Swift read model 和卡片渲染。
- 中央消息流显示 Strategy Result Card。
- Inspector 支持查看 key levels、scenarios、counter evidence、source map。
- Artifact 链接继续可点击进入详情。

### Phase 4：观察与复盘

- 将 followUps 写入本地 watchlist/task artifact。
- 支持从策略结果卡一键创建长期观察任务。
- 支持把一次策略分析整理为 handoff / review memo。

## 验收标准

### 文档验收

- 本文档说明现状架构、showcase 工作流映射、目标工作台信息架构、接口边界、结构化读模型、开发阶段和验收标准。
- 文档没有要求前台暴露 raw tools/providers。
- 文档明确首版是决策支持，不是自动交易。

### 功能验收

后续实现完成后应通过：

```bash
swift build
swift test
node agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check
swift run WeChatIntelligenceRadar --ui-smoke-check
```

UI smoke 需要能看到：

- Alpha Scanner、Perp Position Review、BTC Macro Thesis Review 模板。
- CoinMarketCap MCP 能力包仍从 Add / `/add` 进入。
- 任务流中出现 CMC skill 调用卡、结构化策略结果卡、final output artifact 链接。
- Inspector 能看到证据、关键价位、反证、风险边界和 artifact。
- 缺少 live MCP provider 时显示 degraded/blocked，不显示 live 成功态。

### 安全验收

- 不出现 live trading、真实微信读取、外部发布。
- trade/send/publish 相关动作保持 blocked。
- `cmc.request_mcp_refresh` 保持 needs_confirmation 或 blocked_missing_provider_config。
- 任何收益、杠杆、entry/exit 展示都必须带风险边界和用户自有决策说明。

## 关键开发默认值

- 继续以 `selectedSkillIDs` / `selectedExtensionIDs` 作为前端到 daemon 的主接口。
- 继续以 runtime artifact 作为 CMC 输出和策略读模型的事实来源。
- 继续隐藏 internal tools/providers/normalizers。
- 首版优先模板和读模型，不引入交易执行、账户连接或外部发布。
- Swift 前端先同步维护静态模板；后续再把模板完全改为 remote public surface 驱动。
