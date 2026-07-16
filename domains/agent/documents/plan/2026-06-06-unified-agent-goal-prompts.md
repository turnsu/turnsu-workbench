# 统一 Agent 执行 Goal 提示词

- 日期：2026-06-06
- 用途：后续把文档计划交给 `/goal` 执行时直接复制
- 状态：当前有效执行提示词

## 0. 使用规则

必须按顺序执行：

```text
先 Phase 1
再 Phase 2
最后 Phase 3
```

不要把三段合成一个 goal。每个 goal 完成后必须更新 wiki，写清楚验收结果和下一阶段是否解锁。

## 1. Phase 1 Goal

```text
/goal 按 wiki/plan/2026-06-06-agent-runtime-harness-phase-1-plan.md 执行 Phase 1。只构建底层 production runtime harness，不合并 assignment agent 业务能力，不重构前端。

必须先阅读：
- wiki/architecture/2026-06-06-agent-harness-productization-iteration.md
- wiki/plan/2026-06-06-agent-runtime-harness-phase-1-plan.md
- wiki/architecture/2026-06-05-agent-output-gates-and-frontend-coupling-audit.md
- wiki/PROJECT_WIKI.md

实现范围：
- 后端新增 harness-session-tree.json、harness-branch-lineage.json、invocation-ledger.ndjson。
- 后端新增 context-event-log.ndjson、compaction-summary.json。
- 后端新增 review-read-model.json。
- 保持 agent-final-read-model-v1 为唯一最终输出来源。
- reviewer branch 不覆盖主 final read model，不导入 product mutations。
- 如果需要 Swift 适配，只补 read model 解码和测试，不做视觉/信息架构重构。

禁止事项：
- 不接入 meeting minutes、document generation、Feishu bridge、local ASR、Docker worker、Hermes sidecar。
- 不复制 assignment agent_副本 业务代码。
- 不改用户可见 Skill/Extension 选择模型。
- 不启动 Product Design。
- 不新增 live send、publish、trade、delete 能力。

验收标准：
- 同一 run/session 可形成 session tree 和 branch lineage。
- context compaction 保留路径、证据、gate、失败原因。
- review branch 不导入 mutations。
- completed run 只显示 AgentFinalReadModel.finalText。
- PROJECT_WIKI 增加本阶段 checkpoint。

回归命令：
- cd domains/agent/code/agent-runtime && npm test
- swift build
- swift test
- swift run WeChatIntelligenceRadar --ui-smoke-check

最终汇报：
- 新增 artifacts 列表和最新 runID。
- 测试结果。
- 是否解锁 Phase 2。
- 未完成项和风险。
```

## 2. Phase 2 Goal

```text
/goal 在 Phase 1 验收通过后，按 wiki/architecture/2026-06-06-unified-agent-product-architecture.md 与 wiki/architecture/2026-06-06-assignment-agent-capability-mapping.md 执行统一 Agent 合并。

必须先确认：
- Phase 1 checkpoint 已写入 PROJECT_WIKI。
- Phase 1 npm test、swift build、swift test、UI smoke 已通过。
- harness-session-tree.json、harness-branch-lineage.json、invocation-ledger.ndjson、context-event-log.ndjson、compaction-summary.json、review-read-model.json 已在最新 run 中可查。

必须先阅读：
- wiki/architecture/2026-06-06-unified-agent-product-architecture.md
- wiki/architecture/2026-06-06-assignment-agent-capability-mapping.md
- wiki/architecture/2026-06-05-agent-runtime-pi-office-reference-architecture.md
- wiki/plan/2026-06-06-unified-agent-three-phase-roadmap.md
- assignment agent_副本/meeting-agent-pi-package/README.md
- assignment agent_副本/assigment agent wiki/02-agent-architecture.md
- assignment agent_副本/assigment agent wiki/13-office-agent-product-technical-review.md

实现范围：
- 将当前 Web3 Agent 与 assignment agent_副本 的运行时能力合成一个统一 Agent 产品架构。
- 统一 capability registry，能表达 Web3、Office/Meeting、Channel、Memory/Learning 能力。
- 统一 planner、model router、context/source context、QA gate、policy gate、output guard、final read model。
- 接入 Office/Meeting/Feishu 能力包，但默认受 QA/Policy Gate、权限、secret redaction、channel capability matrix 控制。
- Office/Meeting artifacts 作为 domain read model，不替代 AgentFinalReadModel。

禁止事项：
- 不复制第二套 orchestrator。
- 不绕过 Phase 1 harness。
- 不让 Feishu adapter 决定业务流程。
- 不让 Document Worker 执行发布。
- 不让 agent-output.json、publish.json、reply.json 成为最终答案来源。
- 不自动长期记忆写入。
- 不改 assignment agent_副本 目录。

验收标准：
- 当前项目只有一个 Agent Runtime Host。
- Unified capability registry 同时表达 Web3 与 Office/Meeting 能力。
- Feishu/office live action 默认 blocked/needs_confirmation，除非 QA/Policy/channel readiness pass。
- 新增能力经过 session tree、branch lineage、review branch 记录。
- PROJECT_WIKI 增加 Phase 2 checkpoint。

回归命令：
- cd domains/agent/code/agent-runtime && npm test
- swift build
- swift test
- swift run WeChatIntelligenceRadar --ui-smoke-check

最终汇报：
- 迁移了哪些 capability。
- 哪些能力仍 blocked/roadmap。
- 是否解锁 Phase 3。
- 测试结果和风险。
```

## 3. Phase 3 Goal

```text
/goal 在 Phase 2 验收通过后，使用 @product-design 进入 App 前端重构。先运行 Product Design get-context 并确认 design brief，再 ideate 三个视觉方向，用户选定后再实现。

必须先确认：
- Phase 2 checkpoint 已写入 PROJECT_WIKI。
- Unified capability registry 已存在。
- Web3 + Office/Meeting 能力已进入统一 Agent runtime contract。
- Swift 仍只消费 read model，final answer 仍来自 AgentFinalReadModel。

必须先阅读：
- wiki/architecture/2026-06-06-unified-agent-product-architecture.md
- wiki/plan/2026-06-06-unified-agent-three-phase-roadmap.md
- Phase 1/2 验收记录
- Product Design get-context skill
- 当前 Swift Agent workspace 相关文件

Product Design 流程：
- 先执行 get-context，确认产品目标、视觉参考、交互深度。
- brief 未确认前，不改 UI。
- brief 确认后，ideate 三个视觉方向。
- 用户选定方向后，再进入 prototype / image-to-code / Swift implementation。

前端重构目标：
- 统一 Agent 产品工作台。
- 展示多域任务、session tree、branch/review 状态、final read model、capability packages、policy/QA 状态。
- 不暴露 internal tools/provider/normalizer/worker。
- 同一 run 只出现一个最终答案。

禁止事项：
- 不跳过 Product Design brief。
- 不在用户选视觉方向前重写 UI。
- 不让 DashboardViewModel 或 Swift view 决定 final precedence。
- 不暴露 provider/internal tools。

验收标准：
- Product Design brief 和选择的视觉方向写入 wiki。
- swift build 通过。
- swift test 通过。
- UI smoke 通过。
- 用户可见界面只展示能力包、任务、session/review、final answer、QA/Policy 摘要。

最终汇报：
- Product Design brief。
- 选定视觉方向。
- 改动文件。
- 截图或 UI smoke 证据。
- 测试结果。
```

## 4. 文档维护 Goal

如果后续只需要更新规划，不执行代码，可用：

```text
/goal 只更新 wiki 文档，不改 runtime / Swift / assignment agent 代码。根据当前最新实现状态同步 unified agent roadmap、phase gate、goal prompts 和 PROJECT_WIKI。完成后只做 markdown/link/status 核验，不跑代码回归。
```
