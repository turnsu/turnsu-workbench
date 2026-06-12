# CMC Skill Hub Display / Price / Mutation Gate Fix Plan

- Date: 2026-06-06
- Status: handoff-ready fix plan
- Based on: `wiki/problem/2026-06-06-cmc-skill-hub-display-gate-overblocking.md`
- Scope: small backend final-output/gate semantics fix plus minimal Swift rendering copy alignment
- Non-scope: architecture rewrite, UI redesign, Skill/Extension selection changes, live trading, WeChat sending, Feishu publishing

## Summary

当前 CMC gate 的问题不是“gate 不该存在”，而是 gate 职责太宽：它把 Skill Hub 返回内容展示、App 自己引用价格、工作台 mutation 导入混成一个总闸门。

本次 fix 目标是保留 gate，但拆成三个简单、稳定、可验证的职责：

```text
Display Gate:
  transport ok + 有 Skill Hub 返回文本 => final 可以展示。

Price Gate:
  具体价格 / 关键位只允许来自 Skill Hub 原文或结构化 live price snapshot。
  App / LLM 不能新增、推导、编造价格。

Mutation Gate:
  写入工作台卡片、观察项、proposal、memory、handoff 继续严格。
  证据不足或价格快照不足时可以 discarded。
```

一句话：

```text
summary 能展示就展示；
Skill Hub 原文里的价格可以展示；
App 不能新增价格；
assets=[] 只代表 App 没有结构化价格快照，不代表 Skill Hub 返回价格不可展示。
```

## Current Problem

当前 run `run-dfbd0511-062c-4e76-9680-4d0425a12fc8` 显示：

```text
transportStatus = ok
cmcSkillHub.observations[0].status = ok
summary exists
readableEvidenceCount = 0
assetCount = 0
priceSnapshotStatus = empty
allowConcretePrices = false
```

当前 final 被降级成：

```text
CMC Skill Hub transport 成功，但本轮未返回可解析研究证据或价格快照；
不能把这次结果当作有效实时研究结论。
```

这不符合业务目标。用户要的是 Agent 调用 CMC Skill Hub，然后展示 Skill Hub 返回的结论。App 侧 parser 没解析出 `readableEvidence[]`、本地 `assets=[]`，不能等价为“Skill Hub 结论不可展示”。

## Design Principles

### 1. Display First

只要 Skill Hub 调用成功，并返回可展示文本，就显示。

可展示文本来源优先级：

```text
skillHubResult.readableEvidence text
skillHubResult.summary
skillHubResult.conclusion
skillHubResult.marketRead.summary
skillHubResult.raw display-safe text after redaction
```

`readableEvidence=[]` 只能代表 App 没解析出结构化证据 section，不代表 Skill Hub 没有结论。

### 2. Price Strict

价格仍然要严格，但规则要更准确。

允许展示：

```text
Skill Hub 原文返回的价格数字
结构化 live price snapshot 中通过 gate 的价格数字
```

禁止展示：

```text
LLM 自己补的价格
App 从 fixture / stale snapshot / empty assets 推导的价格
不在 Skill Hub 原文也不在 live snapshot 里的支撑、阻力、入场、止盈、止损、关键位
```

### 3. Mutation Strict

工作台 mutation 继续严格：

```text
task
crystal / 情报卡
proposal
memory
handoff
watchlist / observation
```

如果只有 Skill Hub summary 可展示，但没有结构化 evidence 或 price snapshot，final 可以回答，但 mutation 可以 `discarded`。

### 4. No Business-Layer Risk Template By Default

“风险边界 / 数据缺口”不应是每次 CMC final 的固定正文模板。它可以保留在：

```text
task-local status
debug strip
inspector
policy summary
```

只有用户请求交易、发送、发布、自动执行、删除等动作时，再在正文显式展开安全边界。

## Target Gate Semantics

## Display Gate

字段建议：

```text
skillHubDisplayStatus = usable | empty | failed
displayableResultText = string | null
displayableResultSource = readableEvidence | summary | conclusion | marketRead | rawRedacted | none
allowSkillHubDisplay = boolean
```

极简实现可以不新增全部字段，只要内部函数得出等价判断即可。

放行条件：

```text
transportStatus == ok
AND observation.status in [ok, completed]
AND displayableResultText is not empty
```

放行后 final 必须展示 Skill Hub 返回内容。

## Price Gate

字段沿用：

```text
allowConcretePrices
priceSnapshotStatus
assetCount
```

新增或内部判断：

```text
allowSkillHubReturnedPrices
```

放行条件：

```text
Price is present verbatim in displayable Skill Hub returned text
OR price is present in structured live price snapshot that passed allowConcretePrices
```

禁止条件：

```text
Price / key level appears in model-generated text
AND it does not appear in Skill Hub returned text
AND allowConcretePrices == false
```

## Mutation Gate

字段沿用：

```text
productMutationPolicy.status
productMutationPolicy.reason
```

建议规则：

```text
If only displayable Skill Hub text exists but no structured evidence/price:
  final answer allowed
  productMutationPolicy may remain discarded

If structured evidence or price snapshot exists and output guard passed:
  productMutationPolicy may be importable
```

## Minimal Backend Changes

### 1. Add displayable Skill Hub text extraction

Add a helper near existing CMC summary helpers:

```text
displayableSkillHubText(observation)
```

It should return redacted display-safe text from:

```text
readableEvidence bullets joined
summary
conclusion
marketRead.summary
```

Do not return:

```text
raw request body
headers
secrets
API keys
provider internals
unredacted raw payload
```

### 2. Change degraded final behavior

Current behavior:

```text
readableEvidenceCount == 0 && assetCount == 0
=> degraded_empty_evidence
=> final says cannot use result as effective research conclusion
```

New behavior:

```text
If displayableSkillHubText exists:
  final displays Skill Hub returned result
  append a short App-side note:
    "本轮未获得 App 可结构化引用的价格快照，因此不输出 App 生成的具体价位。"
Else:
  final may say Skill Hub transport succeeded but no displayable content was returned
```

### 3. Update output guard for Skill Hub returned prices

Current price guard likely sees any concrete number + market term while `allowConcretePrices=false` and rewrites/degrades.

New rule:

```text
If a concrete price/key number appears verbatim in displayableSkillHubText:
  keep it
  mark source as "CMC Skill Hub 返回"
Else if allowConcretePrices == false:
  strip/rewrite model-generated concrete price/key levels
```

Implementation can be simple:

- Before checking concrete market violations, collect displayable Skill Hub text.
- When a line has price-like numbers, allow the line if the same line or numeric tokens are present in Skill Hub returned text.
- Continue blocking generated lines with numbers not present in Skill Hub result.

### 4. Keep mutation policy strict

Do not relax:

```text
productMutationPolicy.status = discarded
```

for empty structured evidence/price cases.

Only final answer display changes.

## Minimal Swift Changes

### 1. Header copy

Current header may show:

```text
evidence empty · prices empty
```

That can remain, but should not imply no Skill Hub result.

Preferred display:

```text
CMC Skill Hub · result usable · prices empty
```

If backend does not add `skillHubDisplayStatus`, Swift can infer:

```text
summary non-empty && transport ok => result usable
```

### 2. Final rendering

Do not hide Skill Hub returned conclusion just because:

```text
readableEvidenceCount == 0
priceSnapshotStatus == empty
```

Swift `AgentOutputCopy.humanize` should continue replacing internal IDs, but avoid deleting entire useful lines when a safe replacement would preserve explanation.

## Expected Final Output Examples

## Case A: Skill Hub summary exists, no structured price snapshot

Input:

```text
transport ok
summary exists
readableEvidenceCount = 0
assets = []
```

Expected final:

```text
## CMC Skill Hub 返回结论
{Skill Hub summary/conclusion}

## 本轮 App 可用性
- CMC Skill Hub 调用成功。
- 本轮未获得 App 可结构化引用的价格快照，因此不输出 App 生成的具体价位、支撑阻力或交易区间。
```

Not allowed:

```text
不能把这次结果当作有效实时研究结论。
```

## Case B: Skill Hub summary includes BTC price

Input:

```text
summary = "BTC is trading near 69,000..."
assets = []
allowConcretePrices = false
```

Expected final:

```text
CMC Skill Hub 返回：BTC is trading near 69,000...

说明：该价格来自 CMC Skill Hub 返回内容；App 本轮未获得独立结构化价格快照，因此不新增关键价位或交易区间。
```

Not allowed:

```text
BTC 支撑 67,200，阻力 70,500。
```

unless those levels appear in Skill Hub returned text.

## Case C: No displayable Skill Hub text

Input:

```text
transport ok
summary empty
conclusion empty
readableEvidence empty
```

Expected final:

```text
CMC Skill Hub 调用成功，但本轮没有返回可展示的结论文本。
```

## Acceptance Criteria

- A run with `transportStatus=ok`, `observation.status=ok`, `summary` non-empty, `readableEvidenceCount=0`, and `assetCount=0` displays Skill Hub summary in final answer.
- The same run does not output App-generated concrete prices, support/resistance, trade levels, entry/exit, stop loss, or take profit.
- If Skill Hub summary itself contains prices, final preserves those prices and labels them as CMC Skill Hub returned content.
- If model output adds numbers not present in Skill Hub returned text while `allowConcretePrices=false`, output guard removes or rewrites only those generated numbers/lines.
- `productMutationPolicy` can remain `discarded` for empty structured evidence/price cases.
- Header/status distinguishes `result usable` from `prices empty`.
- Final answer no longer uses the default business-layer section `风险边界 / 数据缺口` for ordinary CMC research responses.
- Existing safety boundaries for trading, WeChat sending, Feishu publishing, external publish, and destructive actions remain blocked.

## Regression Commands

```text
node --check agent-runtime/bin/wechat-agent-daemon.mjs
npm test
swift build
swift test
swift run WeChatIntelligenceRadar --ui-smoke-check
```

For `npm test`, local MongoDB may require a non-sandbox run.

## Mainline Goal Prompt

```text
/goal 按 wiki/problem/2026-06-06-cmc-skill-hub-display-price-mutation-gate-fix-plan.md 执行 CMC Skill Hub gate 最小稳定修复。不要重构 Agent 架构，不改变用户可见 Skill/Extension 选择模型，不放开交易/发送/发布。实现三层语义：Display Gate 宽松，transport ok + Skill Hub 有 displayable summary/conclusion 就必须在 final answer 展示；Price Gate 严格，只允许展示 Skill Hub 原文里的价格或结构化 live price snapshot 中通过 gate 的价格，App/LLM 不能新增价格、支撑阻力、入场出场、止盈止损；Mutation Gate 严格，结构化证据或价格不足时工作台 mutation 可以 discarded，但不能阻止 final 展示 Skill Hub 返回结论。移除普通 CMC research final 中默认业务层“风险边界 / 数据缺口”正文模板，安全状态保留在 policy/status/inspector，只有用户请求交易/发送/发布/删除等动作时才进正文。完成后更新 wiki/PROJECT_WIKI.md 和 QA，跑 node --check、agent-runtime npm test、swift build、swift test、UI smoke，并用 transport ok + summary exists + readableEvidence=[] + assets=[] 的 run 验证 final 展示 Skill Hub 结论且不输出 App 新增价格；再用 Skill Hub summary 自带价格的 fixture/run 验证该价格被保留并标注为 Skill Hub 返回。
```

## Fix Record - 2026-06-06

Status: fixed in current backend/Swift runtime. Historical run artifacts are not rewritten.

Implemented changes:

- Backend CMC display extraction now considers display-safe `readableEvidence`, `summary`, `conclusion`, and `marketRead.summary`.
- `tool-observations.json`, `cmc-capability-summary.json`, and `agent-final-read-model.json` now carry internal returned-price metadata: `allowSkillHubReturnedPrices`, `skillHubReturnedPriceTokenCount`, `skillHubReturnedTextSource`, and `skillHubReturnedTextCharCount`.
- Output guard builds a redacted Skill Hub returned-text corpus and allows market-number lines only when all numeric tokens in the line appear in that corpus or when `allowConcretePrices=true`.
- If model output adds concrete prices or key levels not present in Skill Hub returned text while `allowConcretePrices=false`, the guard strips only the violating lines and preserves the rest of the answer. It falls back to degraded deterministic text only if no useful text remains.
- Final output copy labels preserved Skill Hub-origin numbers as `CMC Skill Hub 返回` and states that App did not obtain an independent structured price snapshot, so App must not add support/resistance, entries/exits, stop loss, take profit, or trading ranges.
- Product mutations remain strict: empty parser evidence or empty price snapshot can still produce `productMutationPolicy.status=discarded`.
- Swift read models decode the new optional returned-price fields. `AgentOutputCopy.humanize` now humanizes safe provider/public capability IDs where possible, while still removing raw tool markup, paths, artifact fields, raw `Skill:` / `Extension:` ID lists, and secrets.

Verification:

- `node --check agent-runtime/bin/wechat-agent-daemon.mjs`: pass.
- `npm test` in `agent-runtime`: sandboxed run failed on local MongoDB `EPERM 127.0.0.1:27017`; approved non-sandbox rerun passed `control_plane_smoke`, `mongo_repository_smoke`, `security_smoke`, `business_qa`, sync smoke, async smoke, and cleanup.
- `swift build`: pass.
- `swift test`: pass.
- `swift run WeChatIntelligenceRadar --ui-smoke-check`: pass, `ui_smoke_workspace=Agent Console`, `ui_smoke_agent_queue_visible=true`.

QA coverage added:

- Skill Hub summary exists with `readableEvidence=[]` and `assets=[]`: final displays Skill Hub result and does not use the old invalid-result copy.
- Skill Hub summary includes `BTC price is near 69,000` with `allowConcretePrices=false`: output guard preserves `69,000` as CMC Skill Hub returned content.
- Model-added `支撑 67,200，阻力 70,500` not present in Skill Hub returned text: output guard rewrites and removes those generated levels while preserving the Skill Hub-origin `69,000`.
- No displayable Skill Hub text: final says transport succeeded but no displayable content was returned.
