# SkillOS / LoopOS 后端架构实施计划

- 日期：2026-08-01
- 状态：**Iterations 0–6 已在当前工作树实现并通过本地纵向 Gate；生产发布仍为 NO-GO**
- 权威架构：`wiki/architecture/2026-08-01-skillos-loopos-backend-architecture.md`
- 代码范围：`domains/backend`、`domains/agent`；只有契约需要时才触及前端 API client/read model，不在本计划重做 M5 视觉
- 运行范围：单机 Product-owned 调度，不引入外部 MQ 或真实远程设备
- 依赖基线：PI SDK 0.83.0、pi-workflow 0.10.1、pi-subagent 0.4.8；只允许 `headless`
- 实施与验证记录：`wiki/qa/2026-08-01-skillos-loopos-iterations-0-6-implementation-review.md`

> 本文下方保留原实施拆解作为追溯清单。“已实现”不等于“可生产发布”；外部 Provider、真实 Connection credential、认证生产 Mongo、供应链/CVE、冷启容量、升级/回滚和当前构建的人工视觉验收仍是独立门禁。

## 0. 开发护栏

### 0.1 控制链铁律

1. **先持久化，再执行**：Product API 必须原子写入 command、Turn 和 waiting-slot reservation 后才返回 `202 Accepted`。
2. **断线不取消**：HTTP/SSE 断开只 detach；显式 Cancel API、权限撤销、超时或 Session end 才触发 Broker cancel。
3. **Broker 是 Admission 强制闸门**：所有受治理执行缺少有效 Capacity Lease 一律拒绝。Coordinator 不是唯一 caller，不能靠调用方自觉。
4. **两种 Lease 分开**：Capacity Lease 管资源，Capability Lease 管权限；dispatch 时同时验证。
5. **异步写回必带分层 Fence**：文字使用 `sessionEpoch + turnId + turnFence`；Realtime 使用 `sessionEpoch + realtimeCallGeneration + causalSequence/formRevision`。
6. **不制造双重真相**：`run_state_events` 是 V2 Run 生命周期权威；`runs`、既有 `run_events` 和 checkpoints 都是投影或 snapshot。
7. **外部副作用不虚假承诺 exactly-once**：必须有 Effect Receipt 与 reconciliation；结果不明时阻塞人工处理。
8. **Browser 不持有秘密**：credential、Tool secret、宿主路径和可重放业务 Provider payload 不出后端。

### 0.2 当前脏工作树纪律

- 开发前保存 `git status --short`、目标文件 hash 与基线测试结果到 `/private/tmp`；
- 现有修改全部视为用户所有，不 reset/clean/checkout，不做无关格式化；
- 每批只 stage 本批拥有的文件，提交前检查 `git diff --cached --name-only`；
- 如果共享文件已有并行改动，先按当前内容做增量补丁，不能还原成旧基线；
- 不修改 Provider/Connection 凭证、K3/Kimi 配置，不推送远端。

### 0.3 证据口径

- 主测试套件任何阶段都必须绿；不得故意保留“已知红”；
- Characterization test 通过断言当前失败语义来证明问题，修复批次再更新为成功断言；
- 单元 fake 只能证明局部逻辑。垂直 Gate 使用默认 Server composition + 隔离 `_test` Mongo + 明确 fake Provider adapter；
- 真实 Docker、Provider、Credential 分开标记环境证据，缺失时写“环境未验证”，不影响可独立验证的代码结论；
- 每批运行 `git diff --check`，高风险批次补进程重启、迟到结果和跨租户负向测试。

## 1. Iteration 0：正确性止血与可执行基线

| # | 任务 | 主要位置 | 实现与验收 |
|---|---|---|---|
| 0.1 | 最新历史查询 | `agents/mongo-agent-persistence.mjs`、相关测试 | 查询改成倒序取最新 N 条再恢复正序；附件组装复用同一结果。5001/10000 条测试必须包含最新 Turn |
| 0.2 | Creation 现状 characterization | 默认 Server composition 集成测试 | 当前版本用“预期得到 `execution_invocation_not_found`”作为通过断言；Iteration 3 同一测试改为成功并验证 invocation/attempt 先创建 |
| 0.3 | 强制禁用 inline | Agent runtime backend config、startup integrity、AgwaB adapter | `inline` 在配置加载和 dispatch 两处明确失败；headless 正向测试；无 silent fallback |
| 0.4 | Lineage/Fence 契约 | contracts + persistence schema | 增加 `productCommandId/sessionEpoch/turnFence` 及幂等字段；旧记录读取兼容 |
| 0.5 | 调用面清单测试 | server composition / static architecture test | 枚举 Main、Creation、Workflow、Builder、Skill validation、dynamic child 的 Broker 入口，作为 Iteration 2 无旁路 Gate |

**出口**：Contracts、Backend 与 Agent integrity 基线全绿；长历史正确；inline 不能启动；不存在故意红灯。

## 2. Iteration 1：Durable Command + ConversationTurnCoordinator

### 2.1 持久命令与异步 API

| # | 任务 | 实现要点 | 验收 |
|---|---|---|---|
| 1.1 | Product Command / Turn intake | Mongo transaction 原子写 command、queued Turn、waiting-slot reservation；幂等键唯一 | 重放请求只返回同一 command/turn；中途失败无半条记录 |
| 1.2 | 异步 Turn API | 创建接口返回 202 + commandId/turnId；状态与事件用 cursor 读取 | API contract、reload/reconnect 测试 |
| 1.3 | 断线语义 | request signal 只控制接单 transaction；接单后 HTTP/SSE close 不传成执行 cancel | 发送后断网/刷新，后台完成；observer 可重新连接 |
| 1.4 | 显式 Cancel | 独立 idempotent Cancel command：记录取消 → 撤销 leases → Broker/children cancel → fence 拒绝迟到结果 | 重复 cancel 幂等；迟到 Provider/Tool 结果不能写回 |

### 2.2 Coordinator 泛化

| # | 任务 | 实现要点 | 验收 |
|---|---|---|---|
| 1.5 | 抽取 Coordinator | 从 AgentTurnRunner 泛化 claim/drain/settle/recover；面向 session adapter，不 import 产品 prompt/对象逻辑 | Main Agent 原有 FIFO/恢复断言不变通过 |
| 1.6 | 分层 Fence | Session record 增加 `sessionEpoch`；Turn pin `turnFence/modelProfileRevision` | cancel/end/permission change 后旧结果拒绝 |
| 1.7 | Turn 内并行 | 保留单 Session 单 active Turn；当前 Turn 的 Worker fan-out 并行 | 两个 Worker 并行、上下文隔离；下一 Turn 仍等待 |
| 1.8 | 重启恢复 | queued/active 扫描、stale claim 回收、幂等续跑 | kill/restart 后只恢复未完成工作，不重复 settled attempt |

**出口**：Turn 生命周期不依赖浏览器连接；Main Agent 迁入共享 Coordinator 且无行为回退。

## 3. Iteration 2：AdmissionController 与 Broker 强制闸门

### 3.1 等待记录、调度和 Capacity Lease

| # | 任务 | 实现要点 | 验收 |
|---|---|---|---|
| 2.1 | Schema 与索引 | `admission_waiting`、`capacity_leases`；actor/workspace/backend/provider、status、createdAt、lease TTL、fence 索引 | migration 重跑幂等；跨租户查询拒绝 |
| 2.2 | 等待槽上限 | 每用户跨 Session 最多 3 个 waiting；waiting reason 为 session/capacity；running 不计 | 第 4 个请求不创建 Turn；取消一个后可重试 |
| 2.3 | 公平 Scheduler | user 内 FIFO；eligible user round-robin；跳过暂时不满足资源的用户，避免全局 head-of-line blocking | 多用户/多 provider 压力与饥饿回归 |
| 2.4 | 原子多维 Lease | user/workspace/backend/provider 同时占用；TTL/heartbeat/release/recover/fence | 并发竞争不超卖；kill 后过期回收 |
| 2.5 | Queue read model | `waiting_session_turn/waiting_capacity`、approximate position/wait、取消动作 | cursor 稳定；文案不承诺精确等待时间 |

### 3.2 Broker 强制校验与所有 caller 迁移

| # | 任务 | 实现要点 | 验收 |
|---|---|---|---|
| 2.6 | Broker capacity authorizer | execute/attempt 前验证 Capacity Lease owner、scope、dimension、TTL、fence；再验证 Capability Lease | 缺失/过期/错用户/错 provider 全部拒绝 |
| 2.7 | Main/Creation/Workflow/Builder/Validation 接线 | 所有调用方通过 admitted dispatch；不允许 ad-hoc Broker 绕过 | 0.5 的调用面 Gate 全部转为强制 lease |
| 2.8 | Dynamic child admission | child recorder 在 reportChild 前申请独立 lease；child capability 仍为父级子集 | 容量不足排队或明确 blocked；不能先启动后补票 |
| 2.9 | Feature rollout | 先 audit-only 记录缺 lease caller，仅在测试/本地迁移窗口使用；清零后同一批切 `required` | 生产目标态不存在 bypass flag；启动时断言 required |

**出口**：任何用户/Workflow 受治理执行均不能绕过 Admission；队列、lease 和重启恢复有 Mongo 集成证据。

## 4. Iteration 3：Creation 文字与 Realtime 对齐

| # | 任务 | 实现要点 | 验收 |
|---|---|---|---|
| 3.1 | Creation 文字走正式链路 | durable Turn → Coordinator → Admission → Broker `model_call`；删除 service 自造 invocation/attempt | Iteration 0 characterization 改为成功；Provider 前已有 command/admission/invocation/attempt |
| 3.2 | Patch intent 写回 | 结果只生成 Patch intent；以 `sessionEpoch/turnFence/formRevision` 条件持久化；Canonical 仍需用户确认 | 并发编辑冲突不覆盖；刷新恢复同一 revision |
| 3.3 | Realtime Fence 分层 | 保留 `realtimeCallGeneration`，增加共享 causalSequence；不能复用文字 turnFence | 文字与语音交错不互相误杀，Patch 顺序稳定 |
| 3.4 | Realtime Admission | call 建立申请 user/provider Capacity Lease；断开/心跳超时释放 | 媒体断开不取消已持久文字 Turn；旧 call sideband 拒绝 |
| 3.5 | Readiness/成本 | text/realtime 的 reasonCode/recoveryAction；计费挂 command/call lineage | unavailable 不静默 fallback；成本可归集 |

**出口**：Creation 不再绕过 Broker；文字具备 durable FIFO；Realtime 与文字共享业务因果但不共享一把 generation 锁。

## 5. Iteration 4：Context Capsule 与 Sub-agent 治理

### 5.1 Capsule

| # | 任务 | 实现与验收 |
|---|---|---|
| 4.1 | summary event/schema | 同 transcript sequence；包含 coverage、sourceHash、prompt/model revision 和 provenance；唯一索引防重复 |
| 4.2 | token-aware assembly | 按 pinned model context limit 计算 80% 阈值；输入为 summary + recent + refs；derived summary 按 untrusted context 处理 |
| 4.3 | governed condensation | maintenance model_call 走 Admission/Broker；排除自身递归；失败 backoff 不阻塞正常 Turn |
| 4.4 | retention/delete | condensation 不删 transcript；Session TTL、用户删除和合规清除同步删除/失效派生 summary |
| 4.5 | Worker rebuild | 新 PI Session 仅凭有效 Capsule、recent messages 和有权限 refs 重建；无权限/过期 ref 拒绝 |

### 5.2 Sub-agent

| # | 任务 | 实现与验收 |
|---|---|---|
| 4.6 | fan-out/depth/spawn | 并发 4、depth 2、Session spawn 100、allowedChildren；四组边界测试 |
| 4.7 | toolResultBudget | Agent runtime 真实传入 AgwaB；超限裁剪测试 |
| 4.8 | Transcript Artifact | 敏感分类、继承 scope、加密 Object Store、TTL/审计；普通日志和 Memory 不含正文 |
| 4.9 | terminal/cancel | PI `agent_settled` + Product fence；父取消级联 child；有效 child 可在恢复时复用 |

**出口**：超长 Session、Worker 重建、递归防护和 transcript 数据治理全部通过。

## 6. Iteration 5：Loop Run 事件化与副作用治理

### 6.1 事件权威与投影

| # | 任务 | 实现要点 | 验收 |
|---|---|---|---|
| 5.1 | `run_state_events` V2 | 内部 append-only transition envelope；Run 生命周期唯一权威 | sequence/eventId 唯一；坏 priorStateHash 拒绝 |
| 5.2 | Fold/Projector | fold 生成 runs 当前投影、产品安全 run_events、checkpoint snapshot | 从空流/snapshot 重放结果一致 |
| 5.3 | Shadow-write | V1 runs 权威期间同时写 V2 事件，对每次 transition 对账并报警 | 连续运行和重启后差异为零 |
| 5.4 | New Run cutover | `stateModelVersion=2` 的新 Run 事件权威；runs 只投影 | 杀进程后从事件恢复，不依赖旧 checkpoint 真相 |
| 5.5 | Legacy cutover | drain claim；active Run 写 `run_state_imported` + source hash；transaction 翻转版本；completed V1 只读 | 可回滚、无半迁移、历史读取兼容 |

### 6.2 Effect Receipt 与取消

| # | 任务 | 实现与验收 |
|---|---|---|
| 5.6 | Effect intent/receipt | 稳定 effectId/idempotencyKey；dispatch 前 intent；Driver 回写 external ref | crash 窗口可识别而非盲重试 |
| 5.7 | Reconciliation | 支持查询的 Driver 自动核对；不可查询且 outcome unknown 进入人工 blocked | 重复 dispatch 不产生可避免的重复副作用 |
| 5.8 | Cancel semantics | 未发出可取消；计算类强杀；外部副作用协作式取消，不声称撤销已发生效果 | cancelled/partial/effect_outcome_unknown 可区分 |

**出口**：V2 Run 可由事件恢复，公开 timeline 不泄漏内部 payload，副作用不再用“事件化即 exactly-once”的错误假设处理。

## 7. Iteration 6：产品化与垂直 Gate

| # | 任务 | 验收 |
|---|---|---|
| 6.1 | Session read model | rename/archive/search、queued/running/blocked、稳定 cursor；delete 暂缓到 retention 决策完成 |
| 6.2 | Creation reload | URL 只含 opaque sessionId；服务端重验 principal/TTL/status；跨用户拒绝 |
| 6.3 | Readiness/recovery | Admission、model、runtime、connection、Realtime reasonCode 指向真实恢复动作 |
| 6.4 | Trace query | command→turn→admission→attempt→effect/proposal/artifact 全链可查，公开结果无 secret/payload |
| 6.5 | 垂直 Gate A | Main FIFO、Turn 内并行、跨 Session 容量、第 4 个 waiting 拒绝、断线后台完成 |
| 6.6 | 垂直 Gate B | Skill Creation 文字 → Patch → review，包含 cancel/迟到/reload |
| 6.7 | 垂直 Gate C | 10000 条 Session → Capsule → 新 Worker 重建 → retention/delete |
| 6.8 | 垂直 Gate D | Loop Draft → loop_creator Proposal → apply → V2 Run → crash/recover → Effect reconciliation |
| 6.9 | 环境 Gate | Docker、真实 Provider、真实 Credential 分别出证据；缺失项保持环境未验证 |
| 6.10 | 独立 Code Review | 查 Admission 旁路、断线误取消、Fence 混用、summary 递归、effect 盲重试、事件/投影双真相、inline fallback |

## 8. 批次提交与依赖顺序

建议提交顺序：

1. `fix: preserve latest agent session context`
2. `chore: enforce supported pi subagent backend`
3. `feat: add durable product commands and turn coordination`
4. `feat: enforce admission leases across execution broker`
5. `feat: route creation sessions through governed execution`
6. `feat: add governed context condensation and worker artifacts`
7. `feat: event-source loop run lifecycle state`
8. `test: add agent execution vertical readiness gates`

依赖关系：

- Iteration 0 可立即实施；
- Coordinator 先于 Creation 迁移；
- Admission + Broker hard gate 必须同批覆盖所有 caller，不能留下长期兼容旁路；
- Creation/Realtime 在分层 Fence 和 Admission 可用后迁移；
- Capsule 依赖 Broker hard gate，否则 maintenance invocation 会成为新旁路；
- Loop shadow-write 可在 Iteration 4 后并行准备，但权威 cutover 必须等 projector 对账稳定；
- 每个 Iteration 出口未达到前，不得把对应能力宣布为“已支持”或“生产就绪”。

## 9. 回滚与残余风险

| 风险 | 回滚/缓解 |
|---|---|
| Admission 误限流 | 保留可观测 audit-only 作为本地迁移工具；生产只能 required。配置回滚不能绕过权限 Lease |
| Coordinator 恢复重复执行 | command/turn/invocation 幂等键 + settle fence；重复恢复只复用有效 attempt |
| Capsule 摘要错误 | summary 可审计，模型输入可回退到原消息窗口；不删除 transcript |
| Queue wait 估计不准 | 标记 approximate；仅提供排序和状态，不承诺精确秒数 |
| Event projector 不一致 | shadow 阶段报警并阻止 cutover；V1 authority 保持到差异归零 |
| 外部 effect 结果不明 | `effect_outcome_unknown` + 人工恢复，不自动重试 |
| pi-subagent 上游变化 | inline 继续硬禁用；只有独立兼容性评审和负向测试通过后才能重新设计启用 |

---

实施中如与权威架构冲突，以架构文档为准；出现新的产品、权限或状态权威决策时先修订架构，再修改代码。
