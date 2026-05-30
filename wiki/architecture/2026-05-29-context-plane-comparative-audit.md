# Context Plane Comparative Audit

Date: 2026-05-29

## 背景与结论

本轮目标是参考 `DESONGs/assignment-agent` 的上下文模块，理解它如何把复杂文档、附件、证据、长 transcript 和任务 prompt 放进一次可控的 agent 任务处理中，再对照当前 `wechat-intelligence-radar-mvp` 的 Agent Runtime Host 与 Swift 前端，判断本项目在上下文能力上的缺口。

参考依据以本地只读副本 `../assignment-agent-raw` 为准，外部项目身份为 [DESONGs/assignment-agent](https://github.com/DESONGs/assignment-agent)。本轮没有修改 `assignment-agent-raw`、`wechat-cli_raw`、Agent Runtime Host、Swift 代码或 runtime schema。

核心结论：

- 当前项目已经有“上下文引用”：`RuntimeObjectReference`、`AgentContextChip`、`AgentAttachment`、Crystal、Proposal、Memory、Handoff 都能作为 context ref 被前端选中并传给 Agent Runtime Host。
- 但当前还没有完整的 **Context Plane**：runtime 只是把 `contextRefs` 作为 JSON 摘要拼进 prompt 或透传给 internal tools，并未在任务级别完成 source extraction、chunking、retrieval、budgeting、compression、context pack、gate 和 trace。
- `assignment-agent` 值得参考的是“输入侧上下文平面”：大内容不直接塞进模型窗口，而是先落 artifact，再形成 source records、source segments、retrieval plan、bounded context packs 和 context gate。
- 本项目下一阶段 Agent 能力重点不应继续增加前端按钮，而应补一个内部 `context-plane` 能力包。前端仍保持极简，只展示“已带入 N 项上下文”和详情抽屉；底层 chunk/retrieval/budget/manifest 不暴露为主界面操作。

## assignment-agent 上下文机制

`assignment-agent-raw` 中的上下文能力不是简单的 prompt 拼接，而是分成几个层次：

### 1. Context Offload

参考文件：

- `meeting-agent-pi-package_副本/skills/context-offload/SKILL.md`
- `meeting-agent-pi-package_副本/extensions/context-offload.ts`

`context-offload` 负责把长 transcript、完整证据索引、大 draft payload 写成本地 artifact。模型主上下文只保留 pointer：

- `artifactPath`
- `sha256`
- `sizeBytes`
- bounded `preview`
- topic map / evidence map / QA gate / open questions

它的关键约束是：raw transcript 和 full evidence index 不进入 durable conversation context；读取必须 bounded、purpose-specific；preview 写入前做 secret redaction。

这解决的是“长内容如何离开模型窗口但仍可追溯”的问题。

### 2. File Context

参考文件：

- `meeting-agent-pi-package_副本/runtime/file-context.schema.json`

`file-context` 是文件输入的 ingestion metadata 与 extraction contract，不负责最终模型窗口组装。它记录：

- 文件名、类型、mime、source path/message id
- `contextMode`
- `disclosurePlan`
- extracted text path
- bounded `contextPreview`
- 是否支持外部 LLM、是否可发送 raw audio/video

它体现的是 progressive disclosure：文件可以被识别、抽取、预览，但大文件不能直接进入 metrics/logs 或完整 prompt。

### 3. Source Context Runtime

参考文件：

- `meeting-agent-pi-package_副本/extensions/source-context-runtime.ts`
- `meeting-agent-pi-package_副本/runtime/source-context.schema.json`

这是 reference 项目真正的 Context Plane owner。它把输入组装拆成稳定产物：

- `source-records.json`
- `source-segments.jsonl`
- `source-structure.json`
- `retrieval-plan.json`
- `context-packs/*.json`
- `context-gate.json`
- `context-manifest.json`

关键机制：

- source 被分段成 `SourceSegment`，带 sourceId、sourceType、heading/page/time、quality、metadata。
- 文档结构被抽成 `SourceBlock`，包括 heading、paragraph、table、comment anchor。
- retrieval 采用 deterministic section retrieval，不依赖 P0 向量库。
- 每个 work unit 绑定一个 bounded `contextPackRef`、`contextPackHash`、source segment ids、source block ids、table block count、prompt/evidence budget。
- `context-gate` 在生成前检查 source、segment、work unit 是否缺失或 stale。
- manifest 明确 `fullRawContentIncluded=false`、`rawSecretsReturned=false`、`rawMediaExternalUpload=false`。

这解决的是“复杂输入如何被切成可控模型调用单元”的问题。

### 4. Retrieval Index

参考文件：

- `meeting-agent-pi-package_副本/runtime/retrieval-index.schema.json`

`retrieval-index` 是 pointer-only 的长期检索索引。entry 只保存 summary、bounded preview 和 artifact/summary/metadata/embedding pointer，不保存完整 raw content。

这解决的是“跨 run 或跨对象如何可检索，但不把原文复制进长期上下文”的问题。

### 5. Context Plane 缺口复盘

参考文件：

- `assigment agent wiki_副本/issues/2026-05-22-runtime-context-plane-contract-gap.md`
- `assigment agent wiki_副本/plan/2026-05-22-document-output-contract-context-plane-plan.md`

reference 项目自己的复盘也说明：以前有 ingestion helper、artifact offload、prompt rendering、worker、QA，但没有一个层负责上下文 ownership。结果是 source content 过早 flatten，section worker 仍收到 bloated context，retry 也只是复用同一个大 prompt。

最终修复方向是把“输入侧上下文切片、检索、预算、gate”收归 `source-context-runtime`。

## 当前项目上下文现状

当前项目已经有几个上下文相关基础件：

### 1. Swift 前端上下文引用

相关代码：

- `Sources/WeChatIntelligenceRadarApp/Models/ProactiveIntelligenceModels.swift`
- `Sources/WeChatIntelligenceRadarApp/Models/AgentWorkspaceV2Models.swift`
- `Sources/WeChatIntelligenceRadarApp/ViewModels/DashboardViewModel.swift`
- `Sources/WeChatIntelligenceRadarApp/Services/AgentDaemonClient.swift`

已有模型：

- `RuntimeObjectReference`
- `AgentContextChip`
- `AgentAttachment`
- `AgentThreadMessage.contextChips`
- `AgentDaemonClient.postMessage(... contextRefs:)`

Swift 会把当前选中的 Crystal、Token、Message 转成 `RuntimeObjectReference`，并在提交 Agent 任务时把 `prompt`、`selectedSkillIDs`、`selectedExtensionIDs`、`attachments`、`contextRefs` 发给 Agent Runtime Host。

这说明前端已经能表达“用户想带入哪些对象”。

### 2. Agent Runtime Host 处理方式

相关代码：

- `agent-runtime/bin/wechat-agent-daemon.mjs`
- `agent-runtime/extensions/wechat-onchain-tools.ts`
- `agent-runtime/extensions/wechat-cli/extension.ts`
- `agent-runtime/extensions/cmc-skill-hub/extension.ts`

当前 daemon 的处理方式：

- 从 public surface 接收 Skill/Extension。
- 根据 prompt、Skill、Extension 推断 internal tools。
- 写出 `planner-envelope.json`、`tool-calls.json`、`model-route.json`、`policy-decisions.json`、`final-output.md`。
- 调模型时把 `contextRefs` JSON 截断到约 2000 字符拼入 user message。
- 调 internal tools 时把 `contextRefs` 透传给 tool params。

这说明当前 runtime 有任务 artifact 和 tool trace，但还没有 context assembly owner。

### 3. 领域对象与 runtime artifacts

当前项目已有可作为上下文来源的对象：

- 微信 normalized messages：`runtime/wechat/messages.normalized.json`
- Token entities：`runtime/entities/token-entities.json`
- Market snapshot：`runtime/market/latest-market-snapshot.json`
- On-chain snapshots：`runtime/onchain/*`
- Evidence：`runtime/evidence/evidence.json`
- Crystal：`runtime/crystals/crystals.json`
- Proposal：`runtime/proposals/proposals.json`
- Memory：`runtime/memory/memory.json`
- Handoff：`runtime/handoffs/*`
- Agent sessions/tasks/runs：`runtime/agent/*`

这些对象具备 source/freshness/confidence/privacy/redaction/runID 等元数据基础，但还没有被统一抽取成 source/chunk/index/bundle。

### 4. Extension Package 边界

当前项目已经把能力收敛到 Skill/Extension public surface：

- `wechat-cli` extension package
- `cmc-skill-hub` extension package
- local memory / handoff writer

这为新增内部 `context-plane` extension 提供了合适位置：它不需要暴露成前端按钮，只需在 Agent Runtime Host 内部被任务 planner 调用。

## 核心差距

### Gap 1: 有 context refs，但没有 ContextBundle

`RuntimeObjectReference` 是对象指针，不是模型窗口输入。它不能表达：

- 该对象应展开哪些字段；
- raw 内容是否允许进入模型；
- 是否只允许 summary/pointer；
- 该对象占用多少 token/char budget；
- 它为什么被选入或排除；
- 它与其他对象是否重复或冲突。

需要新增任务级 `ContextBundle`，由 runtime 组装，而不是前端直接决定模型上下文。

### Gap 2: 没有 source extraction 与 chunking

当前微信消息、CMC evidence、on-chain snapshot、handoff、memory 都是完整 JSON artifact 或对象引用。它们没有统一分段为 `ContextChunk`：

- 微信群消息应按 thread/topic/token/time window 分段。
- CMC evidence 应按 market regime、watchlist asset、risk note 分段。
- Handoff/memory 应按 claim/evidence/open question 分段。
- 图片附件应按 analysis result、detected entity、visual evidence 分段。

没有 chunking，就无法做稳定 retrieval、budget 和 provenance。

### Gap 3: 没有 retrieval plan

当前 tool 推断主要来自 prompt keyword 和 selected Skill/Extension。它没有回答：

- 本次任务为什么选 BTC 相关消息而不是 ETH/SOL；
- 为什么选某条 Crystal 而排除另一条；
- 同一 Token 的市场证据、微信证据、链上证据如何排序；
- 缺失上下文时是 degraded、blocked 还是 ask-for-input。

需要 `retrieval-plan.json` 记录 selected/excluded chunks 和 reasons。

### Gap 4: 没有 context window budgeter

当前模型输入只做粗略 JSON 截断。缺失：

- prompt budget；
- evidence budget；
- per source budget；
- private/raw content budget；
- summary vs raw preview 优先级；
- over-budget 时的压缩策略。

这会导致复杂任务进入真实 LLM 后不可控：要么信息不够，要么 prompt 过大，要么重要证据被随机截断。

### Gap 5: 没有 context manifest 和 gate

当前 run artifact 有 planner/model/tool/policy，但没有上下文 manifest。缺失：

- 本次 task 使用了哪些 source；
- 每个 source 的 freshness/privacy/redaction 状态；
- 哪些 chunk 进入模型；
- 哪些 chunk 被排除；
- 是否包含完整 raw；
- 是否有 stale/missing/blocked input；
- 是否通过 context gate。

这会影响复盘、QA、误判修复和长期任务恢复。

### Gap 6: Memory 是对象存储，不是 retrieval memory

当前 `MemoryEntry` 可以保存 useful/wrong/false-positive 等判断，但还没有形成 retrieval index：

- 没有 queryable memory index；
- 没有相似任务/Token/群组关联；
- 没有 false-positive 影响 retrieval ranking 的明确机制；
- 没有 purge 后 retrieval 不再返回的 manifest trace。

下一阶段需要把 memory 变成 Context Plane 的一个 source，而不是只在 UI/业务对象里存在。

### Gap 7: 附件入库不等于附件上下文

当前 `AgentAttachment` 有 sha256、mime、size、artifactPath、analysisPath。它还缺：

- attachment extraction status；
- image/document analysis chunk；
- privacy class；
- external model allowed decision；
- analysis result -> ContextChunk 的转换；
- raw media 不进入模型的 gate。

附件应进入 context plane，而不是只作为 message 附属数据。

### Gap 8: Ops 没有 context health

当前 Ops 已从 Agent 解耦，能写 provider/dependency/policy health。但 context 维度还没有：

- stale context count；
- missing source count；
- over-budget count；
- raw content blocked count；
- context gate status；
- latest context manifest pointer。

需要 `runtime/ops/context-status.json` 作为独立读模型。

## 建议架构

### 1. 新增 runtime/context 数据域

建议新增：

```text
runtime/context/
  context-manifest.json
  retrieval-index.json
  bundles/{bundleID}.json
  chunks/{sourceID}.jsonl
  sources/{sourceID}.json
  gates/{runID}.json
```

Agent run 内保留指针：

```text
runtime/agent/runs/{runID}/context-manifest.json
runtime/agent/runs/{runID}/context-bundle.json
runtime/agent/runs/{runID}/retrieval-plan.json
```

全局 `runtime/context/` 是可复用索引，run 内 artifact 是本次任务的确定性证据。

### 2. 新增内部 context-plane extension

建议新增内部 extension package：

```text
agent-runtime/extensions/context-plane/
  manifest.json
  extension.ts
  schemas/
  policies.json
  README.md
```

它不进入 public surface，不在前端 Skill/Extension 选择里显示。内部 tools 可以是：

- `context.prepare_sources`
- `context.segment_sources`
- `context.plan_retrieval`
- `context.build_bundle`
- `context.gate`
- `context.write_manifest`

Agent Runtime Host 在每次 `postMessage` 后、internal tools 执行前先调用 context-plane，得到 bounded `ContextBundle`。之后模型 prompt 和 tools 都消费 `contextBundleRef`，而不是直接消费未处理的 `contextRefs`。

### 3. 最小模型建议

建议文档化这些模型，不急于一次性实现完整字段：

```text
ContextSource
ContextChunk
ContextBundle
ContextWindowBudget
ContextAssemblyDecision
ContextGateResult
ContextManifest
RetrievalIndexEntry
```

核心字段需要覆盖：

- source identity：sourceID、sourceType、artifactPath、runID、generatedAt
- trust metadata：freshness、confidence、privacyLevel、redactionStatus
- chunk metadata：chunkID、sourceID、textPreview、token/char estimate、entity refs、time range
- retrieval metadata：selected/excluded、reason、ranking signal
- budget metadata：promptBudget、evidenceBudget、returnedChars、truncated
- gate metadata：pass/degraded/blocked、missingOrStaleInputs、rawSecretsReturned=false、fullRawContentIncluded=false

### 4. 输入来源映射

当前项目的 source 应先覆盖：

- WeChat normalized messages
- CMC market evidence / market snapshot
- on-chain snapshot
- token entity
- evidence item
- crystal
- proposal
- memory entry
- handoff packet
- attachment analysis
- selected user context refs

首版不需要向量数据库。可以先采用 deterministic retrieval：

- prompt keyword;
- selected context refs;
- token/entity match;
- time window;
- freshness/risk/confidence;
- memory false-positive penalty;
- source privacy gate。

### 5. UI 与产品边界

前端保持当前极简方向：

- Composer 展示“已带入 N 项上下文”。
- 详情抽屉展示 selected sources、freshness、privacy、truncation、gate status。
- 不展示 chunk 列表、retrieval plan、budgeter、provider route 为主界面功能。
- 高级排障可从设置/Ops 进入 context manifest artifact。

这与当前“前端只暴露 Skill/Extension，底层 provider/tool/normalizer/policy 不暴露”的原则一致。

### 6. Ops 解耦

新增：

```text
runtime/ops/context-status.json
```

用于记录：

- latestContextManifestPath
- latestRunID
- contextGateStatus
- sourceCount
- selectedChunkCount
- excludedChunkCount
- staleSourceCount
- blockedSourceCount
- overBudgetCount
- rawSecretsReturned=false
- fullRawContentIncluded=false

Ops 只读 context/run artifacts，不参与 Agent task planning。

## 实施路线

### Phase 0: Wiki 与 contract 冻结

- 完成本文档。
- 在 `PROJECT_WIKI.md` 记录 Context Plane 是下一阶段 Agent 能力重点。
- 明确 reference 项目只读，不复制 Feishu/Office 业务逻辑。

### Phase 1: Context schema + manifest writer

- 新增 `agent-runtime/extensions/context-plane/`。
- 新增最小 schema：ContextSource、ContextChunk、ContextBundle、ContextManifest、ContextGateResult。
- 每次 Agent run 写出 `context-manifest.json` 和 `context-bundle.json`。
- 初版可以只把 selected `contextRefs` 转成 pointer-only source/chunk。

### Phase 2: WeChat / CMC / artifact 分段检索

- WeChat messages 按 group、token、time window、message thread 生成 chunks。
- CMC evidence 按 market regime、watchlist asset、risk guidance 生成 chunks。
- Crystal/Memory/Handoff 按 claim/evidence/open question 生成 chunks。
- 写 `retrieval-plan.json`，记录 selected/excluded 和 reason。

### Phase 3: Budgeter 与 compression

- 为 prompt、evidence、memory、attachment analysis 设置 char/token hard cap。
- over-budget 时优先保留 user-selected refs、fresh evidence、高风险/高置信 source。
- raw private message 默认只允许 redacted preview；完整原文只保留 artifact pointer。

### Phase 4: Agent task assembly 接入

- Agent Runtime Host 不再把 `contextRefs` 直接 JSON stringify 给 LLM。
- 模型输入改为：user prompt + selected Skill/Extension + bounded context bundle summary + artifact pointers。
- internal tools 接收 `contextBundleRef` 和 selected source ids。

### Phase 5: UI/Ops 轻量展示

- Composer 显示上下文数量和 gate 状态。
- Inspector/详情抽屉显示 context source summary。
- Settings/Ops 显示 context health，不回到运维看板式主界面。

## 验收建议

文档验收：

- 本文档存在于 `wiki/architecture/2026-05-29-context-plane-comparative-audit.md`。
- `wiki/PROJECT_WIKI.md` 增加索引和 checkpoint。
- 文档同时覆盖 reference 机制、当前项目现状、缺口、建议架构、实施路线。

后续实现验收：

```bash
node agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check
swift build --scratch-path /private/tmp/wechat-radar-build
swift test --scratch-path /private/tmp/wechat-radar-test-build
```

新增 context artifact 后检查：

```text
runtime/context/context-manifest.json
runtime/context/retrieval-index.json
runtime/agent/runs/{runID}/context-bundle.json
runtime/agent/runs/{runID}/retrieval-plan.json
runtime/ops/context-status.json
```

安全验收：

- 不运行真实微信读取、live wechat-cli、交易、发消息、外部发布。
- 不写入 API key、Authorization、cookie、真实私聊原文。
- `assignment-agent-raw` 与 `wechat-cli_raw` 保持只读。

