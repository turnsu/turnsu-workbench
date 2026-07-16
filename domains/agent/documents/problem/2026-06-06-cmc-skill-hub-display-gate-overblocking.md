# CMC Skill Hub Display Gate Overblocking Problem

- Date: 2026-06-06
- Status: handoff-ready problem statement
- Scope: Agent runtime final-output semantics and App rendering semantics
- Non-scope: trading execution, WeChat sending, Feishu publishing, destructive actions

## Summary

当前 CMC Skill Hub gate 存在过度拦截：系统把 **CMC Skill Hub 调用成功后返回内容是否可以展示**、**App 是否拥有结构化价格快照**、**是否允许生成工作台产品 mutations** 三件事混在同一个 evidence/price gate 中处理。

这导致一个错误用户体验：

- CMC Skill Hub transport 是 `ok`。
- Skill Hub observation 有 `status=ok`，并返回了 summary / conclusion 类内容。
- 但因为 App 侧 parser 没解析出 `readableEvidence[]`，且本地 market snapshot 的 `assets=[]`，final output 被降级成“不能把这次结果当作有效实时研究结论”。

用户实际诉求不是让本应用重新验证 CMC Skill Hub 的研究有效性，而是：

> Agent 调用 CMC Skill Hub 能力，然后把 CMC Skill Hub 返回的结论在 App 内正确渲染出来。

因此主线应修复 gate 语义：**Skill Hub 返回内容可展示** 不应被 **本地价格快照缺失** 或 **App parser 未抽出 readableEvidence** 拦截。

## Concrete Evidence

人工 review run:

```text
run-dfbd0511-062c-4e76-9680-4d0425a12fc8
```

该 run 的 `tool-observations.json` 关键字段：

```text
cmcSkillHub.available = true
cmcSkillHub.observations[0].status = ok
cmcSkillHub.observations[0].skill = crypto_macro_overview
cmcSkillHub.observations[0].summary = crypto_macro_overview returned CMC Skill Hub evidence.
cmcSkillHub.observations[0].readableEvidence = []
cmcSkillHub.observations[0].readableEvidenceCount = 0
cmcFreshnessGate.transportStatus = ok
cmcFreshnessGate.provider = mcpProvider
cmcFreshnessGate.freshness = fresh
cmcFreshnessGate.assetCount = 0
cmcFreshnessGate.researchEvidenceStatus = empty
cmcFreshnessGate.priceSnapshotStatus = empty
cmcFreshnessGate.allowResearchConclusion = false
cmcFreshnessGate.allowConcretePrices = false
cmcFreshnessGate.reason = degraded_empty_evidence
```

对应 `cmc-capability-summary.json`：

```text
mountStatus = mounted
transportStatus = ok
status = ok
skill = crypto_macro_overview
readableEvidenceCount = 0
researchEvidenceStatus = empty
priceSnapshotStatus = empty
assetCount = 0
sourceObservationCount = 1
```

当前 final output 展示：

```text
CMC Skill Hub transport 成功，但本轮未返回可解析研究证据或价格快照；
不能把这次结果当作有效实时研究结论。
```

这句话对当前产品目标过重。它把“App 没解析出本地 evidence/price contract”表述成“Skill Hub 结果不能作为有效研究结论”，不符合用户对 CMC Skill Hub 能力包的预期。

## Current Gate Chain

当前主要逻辑在 `agent-runtime/bin/wechat-agent-daemon.mjs`：

- `marketSnapshotIntegrity(snapshot)` 判断本地 `runtime/market/latest-market-snapshot.json` 是否是 live/fresh/price-valid。
- `cmcFreshnessGate()` 从 snapshot 得出 `allowLiveResearch` 和 `allowConcretePrices`。
- `buildSplitCMCGate(baseGate, cmcSkillHubObservations)` 再把 CMC Skill Hub observations 合并进 split gate。

过度拦截的关键条件：

```text
baseGate.provider == mcpProvider
baseGate.assetCount == 0
hasSkillHubTransport == true
readableEvidenceCount == 0
```

满足后系统设置：

```text
status = degraded
reason = degraded_empty_evidence
allowLiveResearch = false
allowResearchConclusion = false
allowConcretePrices = false
```

其中 `allowConcretePrices=false` 是合理的，因为 `assets=[]` 没有价格快照。

不合理的是：`allowResearchConclusion=false` 被用来阻断或贬低 Skill Hub 自身返回结论。

## Why This Is Wrong

### 1. Skill Hub 是外部综合能力，不是本地 price snapshot provider

CMC Skill Hub 在这里更像一个外部研究/综合能力插件。它可能返回宏观判断、ETF 流解读、相关性、反证、thesis 复核、风险偏好等综合结论。

这些内容不一定会映射成：

```text
assets[]
priceUSD
readableEvidence[] sections
```

App parser 没抽出 `readableEvidence`，只能说明本地 structured parser 覆盖不足，不能直接说明 Skill Hub 返回结论不可展示。

### 2. `assets=[]` 只应阻止具体价格，不应阻止研究结论展示

`assets=[]` 应该只影响：

- `allowConcretePrices`
- 关键价位、支撑阻力、价格区间
- App 自己生成的 price-derived task/card/mutation

不应影响：

- 展示 Skill Hub 返回 conclusion
- 展示 Skill Hub 的宏观/ETF/相关性/thesis 判断
- 告知用户这是 Skill Hub 返回而非 App price snapshot

### 3. `readableEvidence=[]` 应是 parser warning，不应是 final-answer blocker

合理含义：

```text
Skill Hub returned content, but App did not parse structured readable evidence sections.
```

不合理含义：

```text
Skill Hub result is not valid research.
```

主线应把 `readableEvidence=[]` 降级为 rendering/diagnostic 信息，而不是 final output 的阻断条件。

### 4. “风险边界”是业务层输出，不是当前 Agent/App 工程默认模板

当前 final output 固定出现：

```text
风险边界 / 数据缺口
```

这偏业务策略层。当前工程问题是 Agent 能否调用能力包并正确渲染结果，不应每次都把安全/交易边界写进正文。

安全边界仍应保留，但位置应调整：

- Policy / Debug strip / Inspector 可展示。
- 当用户请求交易、发送、发布、外部动作时再进入正文。
- 默认 CMC research answer 不应被“风险边界”模板主导。

## Desired Semantics

主线应拆成三条状态线：

### A. Skill Hub Result Display Gate

目标：决定 CMC Skill Hub 返回内容能否在 final answer 中展示。

放行条件：

```text
transportStatus == ok
AND observation.status in [ok, completed]
AND has displayable Skill Hub content
```

`displayable Skill Hub content` 可以来自：

- `skillHubResult.summary`
- `skillHubResult.conclusion`
- `skillHubResult.marketRead.summary`
- `skillHubResult.readableEvidence`
- 其他已 redacted、可展示的 returned text

注意：`readableEvidenceCount=0` 不应自动阻断，只能说明没有结构化 evidence sections。

### B. Price Snapshot Gate

目标：决定 App 是否可以引用具体价格、价位、支撑阻力、区间。

放行条件仍应严格：

```text
provider is live
freshness == fresh
assets.length > 0
each cited asset has symbol
each cited asset has isLive == true
each cited asset has priceUSD > 0
```

如果失败：

```text
allowConcretePrices = false
priceSnapshotStatus = empty/degraded/blocked
```

但只阻止价格，不阻止 Skill Hub research conclusion display。

### C. Product Mutation Gate

目标：决定是否把 Agent 生成的 task / crystal / proposal / memory / handoff 导入主工作台。

这里可以继续严格：

- Skill Hub 无可展示内容时，不导入。
- 价格 snapshot 缺失时，不导入 price-derived mutation。
- output guard 因市场证据不足 rewrite 时，不导入。

但 product mutation policy 不应反向影响 final answer 展示。

## Expected User-Facing Output

当前类似 run 的理想 final 应该是：

```text
## 结论
CMC Skill Hub 调用成功，返回了 BTC 宏观 thesis 复核结果。

以下为 CMC Skill Hub 返回结论：
...

## 数据说明
- 本轮 CMC Skill Hub transport ok。
- App 未获得可结构化价格快照，因此不输出具体价格、支撑阻力或价位区间。
- App 未解析出结构化 evidence sections，但这不影响展示 Skill Hub 返回的结论。
```

不应再写：

```text
不能把这次结果当作有效实时研究结论。
```

除非 Skill Hub 本身明确返回失败、空结果、错误、无结论或不可展示内容。

## Proposed Implementation Direction

主线实现时建议做小范围改动，不做架构重写。

### Backend

1. 在 CMC summary builder 中新增或稳定字段：

```text
skillHubDisplayStatus = usable | empty | failed
displayableResultText
displayableResultSource = summary | conclusion | marketRead | readableEvidence | none
parserEvidenceStatus = usable | empty
```

2. 修改 `buildSplitCMCGate` 语义：

```text
readableEvidenceCount == 0
```

不再直接导致：

```text
allowResearchConclusion = false
```

应改为：

```text
allowSkillHubDisplay = true if displayableResultText exists
allowResearchConclusion = true only for final display, not price/mutation
```

或更清晰地废弃 `allowResearchConclusion` 的混合含义，拆成：

```text
allowSkillHubResultDisplay
allowAppResearchMutation
allowConcretePrices
```

3. 修改 final output 选择：

- 优先展示 Skill Hub 返回内容。
- 如果 `assets=[]`，只补充“未获得 App 可引用价格快照”。
- 如果 `readableEvidence=[]`，只补充“未解析出结构化 evidence sections”。

4. Product mutations 保持严格：

```text
productMutationPolicy.status = discarded
reason = price_snapshot_empty_or_parser_evidence_empty
```

但 final answer 不随 mutation discarded 一起被降级成“无有效研究结论”。

### Swift App

1. Header 状态可以继续显示：

```text
CMC Skill Hub · mounted · transport ok · result usable · prices empty
```

2. 不要把 `evidence empty` 作为主结论里的负面判定。

3. “风险边界”不应作为每次 final 的固定正文 section。安全/policy 状态保留在 task-local status、debug strip、inspector。

## Acceptance Criteria

### Case 1: Skill Hub transport ok, displayable summary exists, assets empty

Input condition:

```text
transportStatus = ok
observation.status = ok
summary/conclusion exists
readableEvidenceCount = 0
assetCount = 0
```

Expected:

```text
final output displays Skill Hub returned conclusion
priceSnapshotStatus = empty
allowConcretePrices = false
no concrete price/key level output
productMutationPolicy may be discarded
final must not say Skill Hub result is invalid solely because readableEvidence/assets are empty
```

### Case 2: Skill Hub transport ok, no displayable content at all

Expected:

```text
final says Skill Hub transport succeeded but returned no displayable content
no research conclusion
no product mutations
```

### Case 3: Skill Hub has readableEvidence but no prices

Expected:

```text
final displays readable evidence and conclusion
prices blocked
no concrete levels unless Skill Hub returned explicit safe non-price text
```

### Case 4: Skill Hub or REST has price snapshot

Expected:

```text
prices usable
concrete prices may be cited with source/freshness attribution
```

## Non-Goals

- 不放开交易、下单、发送微信、Feishu 发布、外部发布。
- 不把 provider/internal tool 暴露给用户。
- 不要求 App 信任或复写 Skill Hub 原始 secret/request/body。
- 不把 product mutation 导入策略放宽。
- 不做 Phase 3 UI 大重构。

## Mainline Handoff Goal Prompt

```text
/goal 按 wiki/problem/2026-06-06-cmc-skill-hub-display-gate-overblocking.md 修复 CMC Skill Hub final-output 过度拦截。只做小范围稳定改动，不重构 Agent 架构，不改用户可见 Skill/Extension 选择模型。核心目标：CMC Skill Hub transport ok 且返回 displayable summary/conclusion 时，final answer 必须展示 Skill Hub 返回结论；readableEvidence=[] 只能作为 parser warning，assets=[] 只能阻止具体价格和 price-derived mutations，不能阻止 Skill Hub 结论展示。保留 allowConcretePrices 严格价格门禁，保留 productMutationPolicy 对工作台 mutations 的严格导入控制。移除默认业务层“风险边界”正文模板，安全/Policy 状态放在 task-local status/debug/inspector，除非用户请求交易/发送/发布类动作。完成后更新 wiki/PROJECT_WIKI.md 和相关 QA，跑 node --check agent-runtime/bin/wechat-agent-daemon.mjs、npm test in agent-runtime、swift build、swift test、swift run WeChatIntelligenceRadar --ui-smoke-check，并用一个 transport ok + assets=[] + readableEvidence=[] 但 summary 存在的 run 验证 final 展示 Skill Hub 结论且不输出具体价格。
```

## Fix Record - 2026-06-06

Status: fixed in current runtime and Swift read model. Historical run artifacts are not rewritten.

Implemented changes:

- Backend CMC gate now separates parser evidence from displayability with `skillHubDisplayStatus`, `allowSkillHubResultDisplay`, `displayableResultText`, `displayableResultSource`, and `parserEvidenceStatus`.
- `readableEvidence=[]` plus `assets=[]` no longer blocks final display when CMC Skill Hub returns a displayable summary, conclusion, or readable evidence text.
- Price gate remains strict: without an App-referenceable fresh price snapshot, final output must not cite concrete prices, key levels, support/resistance, trading ranges, or price-derived entries/exits.
- Product mutations remain strict: parser evidence empty or price snapshot empty can still produce `productMutationPolicy.status=discarded`.
- Final output copy now says the Skill Hub result is displayable while separately noting parser warning and price snapshot absence. The old statement “不能把这次结果当作有效实时研究结论” is superseded for displayable Skill Hub results.
- `agent-system.md` no longer requires `风险边界 / 数据缺口` as a default section. `数据说明` is used only for parser/freshness/price caveats, and `风险边界` is used only for high-impact actions or real Policy Gate blocks.
- Swift `CMCCapabilitySummary` / `CMCGateSummary` decode the new display fields, and the Agent header renders `result usable/empty` rather than using `evidence empty` as the main CMC status.

Verification:

- `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
- `npm test` in `agent-runtime`: sandboxed run failed on local MongoDB `EPERM 127.0.0.1:27017`; approved non-sandbox rerun passed `control_plane_smoke`, `mongo_repository_smoke`, `security_smoke`, `business_qa`, sync smoke, async smoke, and cleanup.
- `swift build`: pass.
- `swift test`: pass.
- `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass, `ui_smoke_workspace=Agent Console`, `ui_smoke_agent_queue_visible=true`.

Similar-issue review conclusions:

- Swift `AgentOutputCopy.containsInternalSurface()` still removes whole lines containing raw provider/public IDs before humanizing them. This remains a nearby display overblocking risk for old runs or model-written diagnostic lines and should be reviewed separately.
- Backend `sanitizePublicFinalText()` also removes whole raw provider/public-ID lines. That is appropriate for anti-leak safety today, but may hide useful diagnostic wording from old runs; future work should consider replacing internal terms in safe user-facing lines instead of deleting the entire line.
- Older architecture/plan wording that says empty readable evidence plus empty price snapshot must always produce an unparseable/degraded final answer is superseded by this fix. Current behavior: displayable Skill Hub result may render; concrete prices and product mutations remain gated.
