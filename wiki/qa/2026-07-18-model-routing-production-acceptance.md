# Model Routing / Selection 生产验收补充审查

- 日期：2026-07-18
- 范围：单机方案 A 的模型目录、能力路由、Agent/Workflow revision pin、Stability 图片任务、Product Artifact、Keychain、备份恢复和 release gate
- 关系：补充 2026-07-17 Slice 0–4 单机生产就绪报告，不替代其尚未通过的外部发布门
- 当前结论：代码与本地 fixture 验收通过；生产发布仍为 `NO-GO`

## 1. 目标与控制链

本轮不是增加一个前端 Provider 下拉框，而是补齐一个产品级选择与执行边界：

```text
Product UI / API
  -> profile selection or workspace capability default
  -> immutable ModelProfileRevision pin
  -> AgentTurnRunner or compiler-pinned Workflow step
  -> Execution Broker / Product Tool Gateway
  -> protocol-specific ModelService adapter
  -> governed result or Product Artifact
```

Mongo 的 revisioned Model Catalog 是运行时唯一真相源。单机配置只提供幂等 operator import；Keychain 只提供按 `credentialRef` 懒读取的 secret。聊天、工具/结构化输出和图片生成按 capability 区分。Stability 图片生成是 typed `model_task`，不创建 PI Session，也不允许 fallback。

## 2. 本轮关闭的设计缺口

| 检查面 | 验收语义 |
|---|---|
| 目录 | profile 身份与不可变 revision 分离；相同配置幂等，修改产生新 revision |
| 选择 | Session 保存 profile 偏好；Turn 与 ExecutionPlan 固定 revision；workspace 按 capability 提供默认值 |
| 路由 | DeepSeek/OpenAI、Anthropic、Gemini、Stability 使用不同 adapter；协议和 capability 不匹配时编译/执行前拒绝 |
| fallback | 图片禁止；聊天仅允许 Workflow 显式 pin 的兼容 revision，且受 workspace/Workflow policy 双重约束 |
| secret | catalog/import/API/log/Artifact 不含 secret；宿主按 `model-credential:<credentialRef>` 懒读 Keychain |
| Artifact | 图片 bytes 进入受治理 Product Artifact；元数据和内容按 workspace 授权读取并校验 hash |
| readiness | required capability 缺默认 route、revision 或 credential 时失败关闭；optional 未引用 profile 可保持 unavailable 而不阻断 |
| 运维 | migration 升至 `006-model-routing`；Mongo 和 Object Store 作为一个恢复点联合验证 |
| 发布 | chat 与 Stability 分开进行 exact-candidate Product-path smoke；Stability 必须显式确认真实付费调用 |

## 3. 已执行的证据

截至本文生成时，使用仓库 Node `22.22.3` 执行了运维定向测试：

- encrypted Mongo backup、Object Store backup/hash、readiness、release evidence、Provider smoke refusal/Product API envelope 共通过 23 项；其中需要 loopback 的 Provider smoke 测试在允许本机短命 test server 后 4/4 通过，覆盖 chat pin 和 Stability Artifact/hash/跨 workspace 拒绝。另对 local runtime 的 6 项非 release-gate 测试做了单独复跑并全部通过。
- 完成官方 Stability Core 参数对齐后，模型目录、Stability executor、备份、readiness 与 release gate 的集成定向回归为 44 pass、2 skip、0 fail；2 项 skip 分别是需要独立认证 Mongo 的目录重启/并发测试和严格本地生产 readiness 演练，不以单元测试结果冒充真实环境证据。
- Stability 缺 `--confirm-billable` 时在候选摘要、server launcher 和任何 Provider 工作之前拒绝；相对候选路径也在启动前拒绝。
- release evidence 测试证明手写 gate 标签不能替代 source/candidate-bound Provider 与 license evidence。
- 已将确认后的前端模型选择功能独立提交，并把发布门禁冻结到该提交的 `domains/frontend` tree `c928dda4e262bff84186333068317413d8debce6`；后续候选若含任何未提交前端差异，继续以 `frozen_frontend_integrity_failed` 阻断。

最终集成候选补充执行了以下证据：

- Contracts：44/44 pass，覆盖 Model Profile/Revision、capability filter、Agent Turn pin、`model_call`、Artifact HTTP 和 Stability typed input/result。
- Backend canonical suite：445 tests，431 pass、14 项环境门控 skip、0 fail；本机回环 Chat/Stability Product API fixture 4/4 pass。未把未配置的认证 Mongo、真实 Docker Skill、Unix socket 和严格生产环境测试的 skip 计为通过。
- Agent 全量：PI/AgwaB/Worker 14/14，后续 Core、proposal、gate、provider、control-plane smoke 全部通过；runtime-integrity 检查 75,741 个仓库运行文件，manifest `21a8e858de21853a8903c21078a3df27590ef7740c63a59403ffa5c74645b57b` 未漂移，`live_model=false`。
- 真实 Agent sandbox：从当前 `domains/agent` 构建候选镜像 `looloomi-agent-worker@sha256:212dfd0ef0204e12d59e8f725a24e4a09171c138e2b256413c17518c96f50ecc`。bounded PI Worker 1/1 pass；真实 `pi-workflow` 动态 decision/synthesis、独立 child invocation、Product timeline、credential isolation 和 requested/actual revision 汇总连续两次通过。
- Web：Vite production build 通过；API、editor、Run stream、server model、routing、model routing 六组 state smoke 全部通过；无权限 review 的离线产物通过，DOM 文件导航因执行沙箱限制明确 skip。最终冻结 tree 仍为 `c928dda4e262bff84186333068317413d8debce6`，本轮 Agent/backend 收口没有新增前端 diff。
- Release allowlist：以代码提交 `73514decb7062b4303c7138dedf5d1e0e44b488d` 暂存 28 个入口、45,016 个文件；本地 secret scanner 扫描 44,970 个文本文件、跳过 46 个二进制、0 个超大文本，findings 0。该结果不替代最终 manifest 所需的 dependency/license/SBOM/CVE 和真实 Provider 证据。

上述证据证明代码和本地受控真实容器路径已验收，不证明真实 Provider、认证 Mongo 候选演练或生产发布已经通过。

## 4. 代码验收结论

以下代码门已完成：

1. Agent Turn 的 `agent_message | model_task`、Model Profile/Revision、Artifact API 和 ExecutionPlan pin 契约。
2. Backend canonical suite 对 `tests/models`、`tests/artifacts`、execution、HTTP、operations 和 migration `006` 的消费。
3. Chat 继续走受控 PI/Gateway；图片使用 childless/tool-free `model_call`，不创建 PI Session。
4. AgwaB child 使用精确的 bounded subagent session ID 作为产品 binding key；模型路由由 child invocation 继承并在 parent result 汇总。
5. Stability Core 官方参数、30,000 USD micros 单图预算预检、非计费 account probe、二进制 Artifact 边界和跨 workspace 访问拒绝。
6. 冻结前端 tree 干净，模型选择只消费产品安全 catalog 字段。

## 5. 生产发布门

以下门当前没有 exact-candidate 通过证据，因此结论必须保持 `NO-GO`：

- 真实 chat Product-path smoke；requested/actual revision 相同、单次 attempt、无 fallback。
- 真实 Stability Product-path smoke；操作者明确 `--confirm-billable`，固定无害输入摘要匹配，Artifact MIME/尺寸/hash 一致、可授权读取、跨 workspace 拒绝、无 PI Session；证据记录版本化的 3 credits × USD 0.01 = USD 0.03 估算，但不伪装成 Provider invoice。
- 使用当前候选和独立 `_test` 数据库执行认证 Mongo migration `001`–`006`、Model Catalog restart/并发导入、revision pin，以及 Mongo + Object Store 联合 restore drill。本机现有 Mongo 未被修改；当前会话没有取得其认证凭证，因此没有把旧候选或 fixture 结果冒充本候选证据。
- authoritative dependency advisory 与 license audit；证据绑定 source commit 和 candidate digest。
- Agent/Skill/Mongo 三个精确 digest 的 high/critical 零漏洞扫描。
- 可重复 cold start、4 Session/8 Worker 容量与长链路稳定性。
- 最终候选的完整 upgrade/rollback rehearsal，以及联合 backup/restore drill。
- secret scan、日志和 release bundle 证明不含 credential、raw Provider payload、prompt 或图片正文。

真实 Stability smoke 可能收费，只能由有权限的发布操作者对明确候选执行一次；常规 readiness、doctor、单元测试和 manifest 校验都不得触发它。

## 6. 当前判定

- 已确认：模型路由的产品责任边界、完整代码回归、真实 digest-pinned Agent/pi-workflow 容器链、前端选择层，以及单机 secret/import/backup/release 的失败关闭语义。
- 尚未确认：当前候选的认证 Mongo 集成、真实 Provider、外部供应链/CVE、可重复容量和完整升级/回滚演练。
- 生产判定：`NO-GO`。
- 允许转为 `GO` 的条件：第 5 节每项都具备同一 source commit、同一 candidate digest、未过期且可复核的证据。
