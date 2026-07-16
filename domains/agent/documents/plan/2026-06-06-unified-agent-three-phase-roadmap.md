# 统一 Agent 三阶段路线图

- 日期：2026-06-06
- 范围：Agent runtime harness、统一 Agent 合并、App 前端重构
- 状态：后续 `/goal` 执行顺序门禁

## 0. 摘要

统一 Agent 重构分三阶段：

```text
Phase 1: Production Runtime Harness
Phase 2: Unified Agent Product Merge
Phase 3: Product Design App Redesign
```

阶段必须顺序执行。Phase 1 未验收通过，不得开始 Phase 2。Phase 2 未验收通过，不得进入 Product Design 前端重构。

## 1. Phase 1：底层 Harness

目标：

- 当前 Web3 Agent Runtime Host 具备 production harness。
- 不合并 assignment agent 业务能力。
- 不重构前端视觉。

交付：

- `harness-session-tree.json`
- `harness-branch-lineage.json`
- `invocation-ledger.ndjson`
- `context-event-log.ndjson`
- `compaction-summary.json`
- `review-read-model.json`

验收：

- 同一 run/session 可形成 session tree 和 branch lineage。
- review branch 不覆盖主 final read model。
- review branch 不导入 product mutations。
- context compaction 保留路径、证据、gate、失败原因。
- `npm test`、`swift build`、`swift test`、UI smoke 通过。

禁止：

- 接入 Feishu/Office/Meeting 能力。
- 复制 assignment agent 业务代码。
- 直接启动 Product Design。
- 改前端信息架构。

## 2. Phase 2：统一 Agent 合并

目标：

- 当前 Web3 Agent 与 assignment agent 能力合成一个统一 Agent 产品架构。
- Office/Meeting/Feishu 作为 capability packages 接入统一 runtime。
- 保持一个 Agent Runtime Host，一个 final read model authority，一个 policy/QA/finalization contract。

交付：

- Unified capability registry。
- Multi-domain task profiles。
- Prompt Registry / Model Router / Source Context 对齐。
- Office/Meeting draft-only 或 gated capability package。
- Channel capability matrix。
- Feishu/Office policy action intent 扩展。
- Domain read models，但不替代 final read model。

验收：

- Web3 与 Office/Meeting 能力在同一 registry 中表达。
- Assignment agent 目录保持只读参考。
- 不存在第二套 orchestrator。
- Feishu/Office live action 默认 blocked/needs_confirmation，除非 QA/Policy/channel readiness pass。
- 所有新增 capability 都经过 harness session tree / branch lineage / review branch。

禁止：

- 绕过 Phase 1 harness。
- 把 `agent-output.json` 或 publish/reply artifact 当最终答案源。
- 让 Feishu adapter 决定业务流程。
- 让 Document Worker 执行发布。
- 自动长期记忆写入。

## 3. Phase 3：Product Design App 重构

目标：

- App 从 Web3 terminal / Agent chat 混合界面升级为统一 Agent 产品工作台。
- 能展示多域任务、session tree、branch/review、final read model、capability packages、QA/Policy 状态。

Product Design 入口：

1. 使用 Product Design `get-context`。
2. 确认设计 brief。
3. 使用 `ideate` 产出三个视觉方向。
4. 用户选定视觉目标。
5. 再进入 prototype / image-to-code / implementation。

交付：

- 统一 Agent App IA。
- 选定视觉方向。
- Swift UI 重构。
- UI smoke 验收记录。

验收：

- 不暴露 internal tools/provider/normalizer。
- 同一 run 只出现一个最终答案。
- branch/review 状态可读。
- policy/QA 状态用户可理解。
- `swift build`、`swift test`、UI smoke 通过。

禁止：

- 跳过 Product Design brief。
- 未选视觉方向就重写 UI。
- 用前端状态决定 final precedence。
- 在 UI 中暴露 provider/internal tools。

## 4. 文档依赖

Phase 1 必读：

- `wiki/architecture/2026-06-06-agent-harness-productization-iteration.md`
- `wiki/plan/2026-06-06-agent-runtime-harness-phase-1-plan.md`
- `wiki/architecture/2026-06-05-agent-output-gates-and-frontend-coupling-audit.md`

Phase 2 必读：

- `wiki/architecture/2026-06-06-unified-agent-product-architecture.md`
- `wiki/architecture/2026-06-06-assignment-agent-capability-mapping.md`
- `wiki/architecture/2026-06-05-agent-runtime-pi-office-reference-architecture.md`
- `assignment agent_副本/meeting-agent-pi-package/README.md`
- `assignment agent_副本/assigment agent wiki/02-agent-architecture.md`
- `assignment agent_副本/assigment agent wiki/13-office-agent-product-technical-review.md`

Phase 3 必读：

- Phase 1/2 验收记录。
- Product Design `get-context` skill。
- 当前 Swift Agent workspace files。
- 用户确认的 design brief。

## 5. 失败处理

- Phase 1 artifact 缺失：不得进入 Phase 2。
- Phase 1 final read model 变成多源竞争：停止，修复 final authority。
- Phase 2 出现第二套 orchestrator：停止，回滚合并方向，改为 capability package。
- Phase 2 live publish 绕过 Policy Gate：停止，标记 P0。
- Phase 3 未确认 Product Design brief：停止，不做 UI。

## 6. 当前默认策略

- 完整产品合并是长期目标。
- Phase 1 是唯一下一步代码执行入口。
- Docker worker 保持 Phase 2/长期选项，不进入 Phase 1。
- Product Design 只在 Phase 3 启动。
- Live 交易、真实微信发送、外部发布、删除/清空类动作继续 blocked 或 needs_confirmation。
