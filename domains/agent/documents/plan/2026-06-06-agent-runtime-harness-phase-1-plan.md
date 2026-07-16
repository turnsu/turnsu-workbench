# Agent Runtime Harness Phase 1 实施计划

- 日期：2026-06-06
- 范围：当前 Web3 Agent Runtime Host 的 production harness 底座
- 状态：Phase 1 代码执行用计划
- 前置文档：`wiki/architecture/2026-06-06-agent-harness-productization-iteration.md`

## 0. 摘要

Phase 1 只做底层 production runtime harness，不合并 assignment agent 业务能力，不重构 Swift 前端视觉。目标是让当前 Agent 从“单次 run + 测试脚手架”升级为“可调用、可分支、可压缩、可复核、可恢复”的运行时骨架。

必须新增内部 artifacts：

```text
harness-session-tree.json
harness-branch-lineage.json
invocation-ledger.ndjson
context-event-log.ndjson
compaction-summary.json
review-read-model.json
```

保留：

- `agent-final-read-model-v1` 作为唯一最终答案来源。
- CMC split gate。
- output guard。
- product mutation policy。
- 现有 `npm test`、Swift build/test、UI smoke 验收路径。

## 1. 非目标

- 不接入 meeting minutes、document generation、Feishu bridge、local ASR、Docker worker、Hermes sidecar。
- 不复制 `assignment agent_副本` 代码。
- 不改用户可见 Skill/Extension 选择模型。
- 不重构 App 视觉。
- 不新增 live send、publish、trade、delete 能力。
- 不让 reviewer branch 写入 product store。

## 2. 后端 Harness Artifacts

### 2.1 `harness-session-tree.json`

目标：表达一个 session 下的 run/branch 关系。

最低字段：

```text
schemaVersion = agent-harness-session-tree-v1
sessionID
rootRunID
activeBranchID
branches[]
reviewBranches[]
terminalBranches[]
createdAt
updatedAt
```

每个 branch：

```text
branchID
runID
parentBranchID
branchType = main | follow_up | steering | retry | review | experiment
status = active | completed | blocked | failed | abandoned | merged
sourceStepID
finalReadModelPath
reviewReadModelPath
createdAt
updatedAt
```

### 2.2 `harness-branch-lineage.json`

目标：表达 fork/retry/review/merge 的可审计 lineage。

最低字段：

```text
schemaVersion = agent-harness-branch-lineage-v1
sessionID
runID
branchID
parentBranchID
sourceRunID
sourceStepID
branchType
mergeTargetBranchID
mergeDecision = pending | accepted | rejected | superseded | not_applicable
mergeReason
```

规则：

- 主 run 也要写 lineage。
- retry 不能覆盖原 run artifact。
- review branch 的 `mergeDecision` 默认 pending/not_applicable。
- final selection 必须能追溯到 branch lineage。

### 2.3 `invocation-ledger.ndjson`

目标：记录调用层事件。

事件类型：

```text
accepted
context_loaded
planner_started
tool_action_started
tool_action_completed
follow_up_received
steering_inserted
branch_created
review_requested
branch_merged
branch_abandoned
final_selected
run_completed
run_failed
```

规则：

- 每行必须包含 `runID`、`sessionID`、`branchID`、`timestamp`。
- 失败事件必须包含 redacted `reason`。
- 不记录 raw prompt secrets 或 provider request body。

## 3. Context Event 与 Compaction

### 3.1 `context-event-log.ndjson`

目标：让 `context-pack.json` 成为每次模型调用前的 runtime event，而不是一次性 artifact。

最低字段：

```text
schemaVersion = agent-context-event-v1
eventID
runID
branchID
stage = plan | act | synthesize | review | compact
selectedChunkIDs[]
excludedChunkIDs[]
budget
sourceTrustSummary
privacyActions[]
gateReasons[]
contextPackPath
createdAt
```

### 3.2 `compaction-summary.json`

目标：在 context/session 压缩时保留可恢复信息。

必须保留：

- 用户目标和约束。
- artifact paths。
- selected evidence IDs。
- CMC gate summary。
- QA/Policy decisions。
- tool failures。
- missing inputs。
- branch lineage。
- final read model path。

禁止保留：

- raw private transcript。
- provider request body。
- secrets / tokens / cookies。
- raw Feishu auth status。
- unredacted personal metadata。

## 4. Review Branch

### 4.1 `review-read-model.json`

目标：独立复核主分支结果。

最低字段：

```text
schemaVersion = agent-review-read-model-v1
reviewRunID
sourceRunID
sourceBranchID
status = pass | needs_revision | blocked | insufficient_evidence
findings[]
checkedArtifacts[]
cmcGateSummary
outputGuardStatus
mutationPolicyAssessment
mergeRecommendation = merge | revise | discard | keep_main
generatedAt
artifactPath
```

规则：

- reviewer branch 只读 bounded artifacts。
- reviewer branch 不覆盖 `agent-final-read-model.json`。
- reviewer branch 不导入 product mutations。
- reviewer branch 可建议 revise/discard，但主分支 merge decision 才能生效。

## 5. Swift 最小适配

Phase 1 不做视觉重构，但可补必要 read model 解码：

- `HarnessSessionTreeReadModel`
- `BranchLineageReadModel`
- `ReviewReadModel`

Swift 展示仍保持最小：

- 如果读不到新 harness artifacts，不影响旧 run 展示。
- completed run 仍只显示 `AgentFinalReadModel.finalText`。
- 不显示 stream blob / SSE final fallback / session duplicate。

## 6. 实施顺序

1. 在 daemon run directory 写入主分支 `harness-session-tree.json` 和 `harness-branch-lineage.json`。
2. 把 run lifecycle、context、tool、final 事件写入 `invocation-ledger.ndjson`。
3. 将当前 Context Plane 输出绑定到 `context-event-log.ndjson`。
4. 生成 `compaction-summary.json`，先用 deterministic summary，不引入模型压缩。
5. 增加 review branch 读模型生成路径，可先是 deterministic reviewer。
6. 更新 manifest/artifact references。
7. 增加后端 smoke/business QA 断言。
8. 如必要，补 Swift 解码和测试，但不改主 UI 信息架构。
9. 更新 `PROJECT_WIKI.md` checkpoint。

## 7. 验收标准

后端：

- 每个 completed run 写出 6 个 harness artifacts。
- `agent-final-read-model.json` 仍存在且 final text 匹配最终输出。
- review branch 不导入 product mutations。
- empty evidence / output rewrite 场景下 review 不能建议 import mutations。
- context event 能解释 selected/excluded chunk。

Swift：

- completed run 只显示 final read model。
- final read model 缺失时不显示 fallback final。
- 新 read models 缺失不破坏旧 run。

回归命令：

```text
cd domains/agent/code/agent-runtime && npm test
swift build
swift test
swift run WeChatIntelligenceRadar --ui-smoke-check
```

## 8. 交付说明

Phase 1 完成报告必须包含：

- 新增 artifacts 列表。
- 最新 runID 和 artifact path。
- review branch 是否生成。
- final read model 是否仍为唯一最终来源。
- product mutation policy 是否仍生效。
- npm/swift/UI smoke 结果。
- 未进入 Phase 2 的能力列表。
