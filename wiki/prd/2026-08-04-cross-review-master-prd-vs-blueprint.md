# 交叉审查：Master PRD v0.2 × 三合一升级蓝图 v2

- 日期：2026-08-04
- 审查对象 A：[Looloomi Team Intelligence Workspace Master PRD](2026-08-04-looloomi-team-intelligence-workspace-master-prd.md)（v0.2，下称 **PRD**）
- 审查对象 B：[LoopOS / SkillOS 三合一升级蓝图 v2](../architecture/2026-08-04-three-in-one-upgrade-blueprint.md)（下称 **蓝图**）
- 审查协议：按 PRD §23 的冲突分类矩阵执行（product / authority / security / data / technology / delivery）
- 状态：审查完成，3 个决策点待团队拍板（见第五节）

---

## 一、总体结论

**两份文档在大方向上约 80% 收敛，且收敛不是巧合——它们独立地从同一组参照系（QM / OpenWorker / Buzz / Sierra / Anthropic / Shopify）推出了同一个产品形态：**

- 单一 Agent 入口 + 隔离 Session（不做角色化多 agent）；
- 云核心为唯一权威，桌面端是体验面 + 受治理的本地执行手；
- 审计记录 actor + authorizer 双字段，不上密码学；
- React/TypeScript 桌面端、Tauri 优先、Node sidecar（拒绝 Python sidecar）；
- 飞书为第一个 IM 连接器、不自建聊天；
- Skill/Loop 保持受治理资产定位，自动化钉住不可变版本；
- TypeScript 渐进迁移（新增全 TS、按边界迁移、不大跃进）。

**真正的冲突只有三个**：持久层（Mongo vs Postgres）、共享协作对象与可见性哲学（Work Item 隐私优先 vs 房间 scope 公开优先）、自动化时序（Phase 3 vs Phase 1）。其余差异都是**互补**而非冲突——PRD 深在控制链/隐私/设备治理，蓝图深在 scope 隔离模型/权限矩阵/多端推送前瞻。

**PRD 的工程严谨度整体高于蓝图**（它有 CommandIntakeService 单一入口、Handoff Capsule、设备注册密码学之外的身份协议、§16.5 量化 go/no-go、Scenario A–I 验收链）。蓝图的职责应收敛为"方向与参照系论证 + 技术栈选型依据"，产品语义以调和后的 PRD 为权威。

---

## 二、§23 交叉审查矩阵（已填写）

| Review area | PRD（candidate v0.2） | 蓝图 v2 | 冲突类型 | 证据 | 裁决建议 |
|---|---|---|---|---|---|
| Product thesis | Work first; assets emerge from proven work | 自动化复利：做过一次的事沉淀为 cron Loop/Skill | 无冲突（互补） | PRD §1.3 vs 蓝图 §1.2 | **合并**：PRD 的"资产从已验证的工作中涌现"是生成侧，蓝图的"复利"是消费侧，同一闭环 |
| Cloud/Desktop authority | Route C：云唯一权威，桌面=受治理 Worker | 云核心权威 + 桌面端个人 scope 本地延伸 | authority（程度差异） | PRD §0/§9.10 vs 蓝图 §3.1 | **采纳 PRD**：设备注册、执行位置策略、无静默云回退是蓝图缺失的硬语义，蓝图 §3.1 桌面端定义按 PRD §9.10 重写 |
| Shared collaboration object | Work Item + Work Thread（product-safe）；原生协作面只是读模型聚合，频道绑定 Work Item | 房间 scope 为一等容器，IM 线程即协作面，session 可旁观 | **product + data（真冲突）** | PRD §6.4/§9.3 vs 蓝图 §3.2 决策 3 | **见决策点 D2** |
| Agent identity/session scope | 一个入口、隔离 Session；displayAgent/performedFor/authorizedBy | 一个入口 + 意图路由；actor/authorizer 双字段；persona | 无冲突 | PRD §9.2 vs 蓝图决策 4/7 | 合并，术语用 PRD 的 |
| Skill/Loop role | 受治理资产，提案制，永不静默变更 | 同；skill 归属 scope → 审批晋升全组织 | 无冲突（蓝图多一条治理链） | PRD §9.4/9.5 vs 蓝图决策 8 | 合并：晋升链接入 PRD 的 publication policy |
| Automation | Automation 为一等 Product 对象，钉 Loop 版本，过 CommandIntakeService；Phase 3 交付 | cron/webhook 触发器是新调度层；Phase 1 交付 | **delivery（时序冲突）** | PRD §9.6/§17 vs 蓝图 P0/Phase 1 | **见决策点 D3**；对象模型采纳 PRD |
| Desktop stack | React TS + TS Worker；Tauri 优先但 evidence-gated（含 Electron 对照 spike） | Tauri 2 + React + Node sidecar，直接选定 | technology（程度差异） | PRD §13.1/13.4 vs 蓝图 §4.1 | **采纳 PRD**：Tauri 优先 + 时间盒 spike 门，蓝图措辞降级为"倾向" |
| Persistence | Mongo 保持云权威；换 PG 是非目标；数据 ADR 由实测证据触发 | **Postgres 优先**：新核心直接建在 PG，存量触它即迁，Phase 1 收敛三域 | **data（最大真冲突）** | PRD §2.2/§13.1/§20.4/§21 vs 蓝图 §3.3 | **见决策点 D1** |
| Offline scope | V1 仅 cache/Draft/outbox；离线不可改 canonical | 桌面端离线只读 | 无冲突 | PRD §15 vs 蓝图 N5 | 采纳 PRD 的完整离线契约 |
| Collaboration channel | 飞书优先 + 原生工作线程；"不做另一个聊天产品" | 飞书优先的 IM 适配器（企微/Slack 同接口）；不自建聊天 | 无冲突（PRD 更收敛） | PRD §6.3/6.4 vs 蓝图 §4.3 | 合并：适配器接口保留，但频道**绑定 Work Item/Project**（PRD 语义），不做房间容器 |
| Permissions | 信任七级 × effect 五类 + 无"全放行"开关 | 风险四级 × 权限五档（OpenWorker 矩阵）+ 硬命令策略 | security（互补，维度不同） | PRD §10 vs 蓝图决策 5 | **合并成二维**：effect class（PRD）× permission mode（蓝图）；蓝图的 discuss/plan/interactive/auto/custom 作为策略档，PRD 的硬拒绝规则在全部档生效 |
| Rollout order | Phase 0 权限/授权修正 → 薄桌面试点 → 本地 Worker → 自动化+频道 → 学习 → 规模化 | Phase 0 QM 试用+V1 收尾 → 云核心 → 桌面+飞书 → 深化 | **delivery** | PRD §17 vs 蓝图 §7 | **采纳 PRD 主线**，蓝图 Phase 0 拆成两件独立的事（见 4.3） |

---

## 三、三个真冲突的裁决分析

### D1 持久层：Mongo（PRD）vs Postgres（蓝图）—— 最大决策点

**PRD 立场**：不换。"仅因参照产品用 Postgres 就换 Mongo"是非目标；Mongo 有 559 测试覆盖、事务、事件溯源已落地；换库最大风险是双写双真相；设定实测触发的数据 ADR 退出条件（RLS 硬需求、队列 SLO 失败、应用层 join 主导、跨集合授权缺陷、多组织发布）。

**蓝图立场**：换，现在换。无生产数据 → 迁移是纯代码成本且处于历史最低点；新核心负载（append-only 事件+全局序号、SKIP LOCKED 队列、LISTEN/NOTIFY 推送、关系型 scope/ACL）全是 PG 主场。

**审查意见（诚实版）**：

1. PRD 最强的论据不是"迁移成本"，而是**双库并存期**——蓝图 v2 的"触它即迁"对稳定模块可能意味着无限期双库，这正是 PRD §21 明确拒绝的最差结局。此批评成立。
2. 但蓝图有一个 PRD 未计入的事实：**scope 模型改造（两份文档都要做）会触碰几乎所有现有 store**——skills/loops/runs/memory/connections 全部要加 scope 维度。既然 store 层反正要大面积返工，"换库的增量成本"比表面看低；且团队已确认无生产数据，不存在数据迁移，只有代码改写。
3. 在 8 人规模下，PG 的全部优势（LISTEN/NOTIFY、SKIP LOCKED、RLS）都不是性能刚需，Mongo 都能用工程手段补齐——**这是开发者人体工学决策，不是能力决策**。

**裁决建议**：二选一，**不要中间态**——

- **选项 A（Mongo 保持，PRD 默认）**：新域也建在 Mongo 上，事件日志/队列/outbox 复用现有 run_state_events 模式。Phase 1 风险最低，PRD 的 ADR 退出条件保留作为未来安全阀。代价：队列/推送/全局序号自己写并自己背。
- **选项 B（Postgres 全量切换，蓝图修正版）**：不是"触它即迁"，而是 **Phase 1 内一次性、时间盒化的 store 层整体移植**（反正 scope 改造要动所有 store），终点单库 PG。代价：Phase 1 增加约 2–3 周；收益：事件日志/队列/推送/RLS 全部用原生能力，与参照系（QM）同栈可直接对照。

蓝图 v2 的"渐进双库"路线撤回——两份文档都同意无限期双真相是最差结局。**审查倾向选项 B**，理由：切换成本只会随时间上涨，而当前是无数据、store 层反正返工的唯一窗口；若团队对 Phase 1 风险极度敏感，选项 A 同样可辩护，且 PRD 的 ADR 机制是诚实的退路。**此为团队必须显式拍板的第一决策。**

### D2 协作对象与可见性：Work Item 隐私优先（PRD）vs 房间公开优先（蓝图）

**PRD**：共享协作围绕 Work Item + product-safe Work Thread；私有 transcript 永远不进团队面；跨人接续用 Handoff Capsule（目标/决策/风险/产物引用），不复制私有上下文；原生协作面只是读模型，频道绑定 Work Item。
**蓝图**：房间 scope 是一等容器，session 默认公开可旁观（Shopify River 模式），公开语料是组织学习引擎。

**审查意见**：

- PRD 的对象模型（Work Item / Work Thread Entry vs Activity Projection / Handoff Capsule）**明显更完备**，且直接回应"员工对过程 WHY 一问三不知"的原始痛点（Decision 对象让理由可发现而不必读全 transcript）。采纳。
- 但 PRD 的**默认可见性**在 8 人高信任团队里可能过度防御：Shopify 的复利机制恰恰来自"默认公开"——如果每个 session 默认私有、靠显式 promote 才共享，旁观学习的发生频率会低一个量级。
- **裁决建议**：对象模型全采 PRD；可见性策略做成 **scope 级可配置**，8 人团队默认值为"workspace 内可读（opt-out 私有）"，敏感域（HR/法务/薪酬）建 scope 时显式标私有。PRD §9.2 的 Session visibility 表增加 `workspace_readable` 一档即可容纳，不破坏其隐私不变量（Attachment 正文、Worker 日志、provider payload 仍然永不共享）。蓝图放弃"房间即 scope 容器"，房间降级为 IM 频道与 Project/Work Item 的绑定关系（PRD §6.3 语义）。**scope 作为隔离/权限容器保留（蓝图 N1），Work Item 作为协作记录容器（PRD）——两者是不同层，不冲突。**

### D3 自动化时序：Phase 3（PRD）vs Phase 1（蓝图）

- 蓝图把 cron 放 P0 的理由：自动化复利是本次升级的核心动机（"每天做的事自动复利"），且调度后端相对桌面端便宜。
- PRD 把 Automation 放 Phase 3 的理由：它依赖 Work Item、权限修正、设备/连接器就绪，且坚持"先权威后自动化"。
- **裁决建议**：拆开后端与入口——**Automation 域 + cron 触发器后端随 Phase 1 云核心交付**（走 CommandIntakeService，满足 PRD 的控制链不变量；此时只暴露 Web 入口），**连接器触发与频道呈现留 Phase 3**。复利验证（≥5 个 cron Loop 每日运行）不必等桌面端。这不违反 PRD 任何不变量，只调整交付顺序，属 delivery 级冲突，可直接调和。

---

## 四、互补清单（无冲突，互相吸收）

### 4.1 PRD 更强、蓝图/调和版应采纳的

1. **CommandIntakeService 单一原子入口**（§12.1）：桌面/Web/连接器/Scheduler/Automation 全部过同一 intake，accepted = 云端已持久担责。蓝图未涉及，直接采纳为云核心第一组件。
2. **设备注册与本地 Worker 治理**（§9.10）：设备非导出密钥对、挑战-响应、短寿命连接凭证、出站连接、fence/lease/TTL、无静默云回退。蓝图的 N9"多端认证"被其完全覆盖并超越——蓝图的 token 认证只对了 Web/CLI，桌面端应直接用 PRD 的 device enrollment 模型。
3. **WorkThreadEntry 与 WorkActivityProjection 分离**（§9.3）：人类内容 canonical、机器活动可重建投影，投影永远不得覆盖人类记录。
4. **Handoff Capsule**（§4/§8.2）：跨人接续不传 transcript，传"目标+决策+风险+产物引用"的有界胶囊。
5. **Automation Grant**（§10.3）：可吊销、绑定 Loop 版本/Connection/预算/有效期；owner 变动触发重验证而非静默继承。
6. **Secret 单一真相源**（§9.8）：`secretSource + storeBindingRevision` 显式绑定，copy→probe→switch→revoke 迁移，禁止双后端探测。比蓝图的 vault 章节精确一个量级。
7. **事件权威边界**（§11.3）："不要把全产品转成单一全局事件源"——蓝图的 N2 措辞需修正：统一的是 **Session 事件日志**（跨 session 种类），不是全域事件总线；Skill/Loop 修订保持不可变对象，审计是 append-only 证据而非命令总线。
8. **§16.5 八人试点 go/no-go 量化阈值**与 **Scenario A–I 验收链**：直接成为调和版的验收章节，蓝图的验收指标被其覆盖（蓝图的"≥5 个 cron Loop"等指标并入 16.3）。
9. **包结构与依赖方向**（§13.3）：pnpm workspace + 允许依赖方向由架构测试强制。蓝图未涉及仓库结构，采纳。
10. **Phase 0 权限/授权修正**（§17）：PRD 记录了**现有私有 Loop ACL 不完整**这一实证缺口——这是两份文档都依赖的多人协作的前置条件，蓝图完全漏掉了。必须成为一切协作功能的前置 Phase。
11. **Tauri evidence-gate**（§13.4）：签名/公证/更新/回滚/SBOM/冷启动的量化门 + 时间盒 Electron 对照 spike。蓝图"直接选 Tauri"降级为"倾向 Tauri，门控通过即定"。
12. **信任七级**（§10.1）：低信任内容不得因模型转述而升格为指令/权限/记忆——防注入写成类型系统，比蓝图的笼统表述强。

### 4.2 蓝图更强、PRD/调和版应采纳的

1. **scope（人×房间）隔离模型**（蓝图决策 3 / QM）：PRD 有 workspace 角色 + 对象 ACL + Session 可见性，但**没有一个统一的隔离容器概念**来承载"各自的记忆/文件/凭据视图/权限/cron/沙盒"。建议：scope 作为 PRD §9.1 workspace 之下的标准隔离维度落地（`workspace → scopes[]`），对象 ACL 挂在 scope 上——这同时是 D1 论证中"store 反正要返工"的依据。
2. **权限模式维度**（蓝图决策 5 / OpenWorker）：PRD 有 effect 五类但缺"模式"轴（discuss/plan/interactive/auto/custom）。二维合并后，无人值守=Inbox 挂起的语义才有完整表达。
3. **outbox 推送出口与移动端前瞻**（蓝图 N10/§3.4）：PRD §12.3 提到 SSE/WS/HTTPS 但无"事件→推送"统一出口；移动端在其路线图中几乎缺席。蓝图的 outbox 消费者模型（SSE hub / IM 连接器 / 未来 APNs 皆为消费者）应补入 PRD §12.3，移动端（只读+审批）列为 PRD Phase 5 的显式候选而非空白。
4. **cursor 增量同步协议**（蓝图 §3.4 缺口 3）：PRD 有 SSE with cursors（§12.3）和离线 watermark（§15），可吸收蓝图的"事件日志水位线增量拉取"作为统一同步语义，措辞对齐即可。
5. **每 scope token 预算 + 贵模型规划/便宜模型执行分层**（蓝图 U7）：PRD §9.9 有 budget/latency class 但无显式 planning/execution 分层路由策略，补一条 routing 默认策略即可。
6. **QM 实测试用**（蓝图 Phase 0）：PRD 风险表警告"把参照项目当依赖"，但蓝图的建议是**试用而非依赖**（8 人真实跑两周，验证 scope/安全姿态手感）。作为可选验证步骤保留，明确不进入产品依赖链。

### 4.3 交付顺序调和（替代双方各自的原计划）

| 阶段 | 内容 | 来源 |
|---|---|---|
| Phase 0a | 权限/授权修正：私有 Loop ACL 负向测试、统一 workspace 角色+对象 ACL、防绕过架构测试 | PRD Phase 0 |
| Phase 0b | 现有 V1 NO-GO 项收尾（外部 Provider 实证、CVE 门） | 蓝图 Phase 0 后半 |
| Phase 0c（可选） | QM 试用两周，产出 scope/姿态手感验证 | 蓝图 Phase 0 前半 |
| Phase 1 | 云核心：Session 事件日志（PG 或 Mongo，待 D1）+ scope 模型 + 权限矩阵（effect×mode）+ Automation 域与 cron 后端 + vault/Secret 单一真相 + 审计双字段 + 设备/token 认证 + typed client | 蓝图 Phase 1 主体，按 PRD 不变量约束 |
| Phase 2 | 桌面端云客户端（Tauri 门控后）+ Web 团队试点（八人真实使用） | PRD Phase 1 后半+2 |
| Phase 3 | 本地 Worker + 飞书连接器 + Work Thread/原生协作面 | PRD Phase 2/3 |
| Phase 4 | 组织学习闭环 + 审计视图 + 企微/Slack 适配器 + 移动端（只读+审批）+ APNs | 双方 P2 合并 |

---

## 五、待团队拍板的决策点（3 个）

| # | 决策 | 选项 | 审查倾向 |
|---|---|---|---|
| **D1** | 持久层 | A. Mongo 保持（新域也建 Mongo，保留 ADR 退出条件）／B. Phase 1 内时间盒化整体迁 PG（单库终点，禁无限期双库） | 倾向 B，但 A 可辩护；**必须在 Phase 1 动工前拍板** |
| **D2** | Session 默认可见性 | A. 默认私有、显式 promote（PRD 现状）／B. 8 人团队内默认 workspace 可读、敏感 scope opt-out 私有 | 倾向 B（组织学习复利的前提），对象模型不变 |
| **D3** | Automation 后端时序 | A. Phase 3（PRD 现状）／B. Phase 1 交后端+Web 入口，连接器留 Phase 3 | 倾向 B |

三个决策定案后，建议动作：以 PRD 为骨架产出 v0.3（吸收 4.2 六项 + 调和交付顺序 + 写入 D1/D2/D3 裁决），蓝图文档标注"方向论证已完成历史使命，技术栈选型以 PRD v0.3 §13 为准"，避免两份文档长期并存产生第三处真相。

---

## 六、附：两份文档各自被推翻/修正的表述

**蓝图 v2 被本审查修正的**：
1. "触它即迁 PG"（§3.3）→ 撤回，改为 D1 二选一；若选 B 则为时间盒化整体移植。
2. "房间 scope 即协作面"（决策 3）→ scope 是隔离容器，协作记录容器是 Work Item，频道是绑定关系。
3. "统一 session 事件日志"（N2）→ 收窄为 Session 域统一，不做全域事件总线。
4. "Tauri 直接选定"（§4.1）→ Tauri 优先 + evidence gate。
5. "N9 token 认证"→ 桌面端用 PRD 设备注册模型，token 认证仅覆盖 Web/CLI/未来移动端。
6. "Phase 0 QM 试用"→ 降级为可选验证步骤。

**PRD v0.2 被本审查要求补充的**：
1. 补 scope 隔离容器概念（§9.1 与 §9.2 之间）。
2. 补权限模式轴（§10 增加 permission modes）。
3. 补 outbox 推送出口与移动端路径（§12.3、Phase 5）。
4. Session visibility 表补 `workspace_readable` 档（若 D2 选 B）。
5. Automation 后端时序前移（若 D3 选 B）。


---

# 第二轮：蓝图方对 PRD Review 的回应与最终结论（2026-08-04 v2）

> 输入：PRD 方的 Review 结论（五条修正 + 吸收清单 + 最终合并形态）+ 团队裁定原则：**不考虑工期，质量与长期稳定为第一选择**。
> 本文节取代第一轮的 D1/D2/D3 建议，为蓝图方最终立场。

## 一、逐条裁决

### 第 1 条（房间共享 Session）——接受，并细化出"观察权/操纵权分离"

接受。多人进入同一 session 直接操纵（争抢 Turn、混合权限与预算、无法回答"以谁的权限执行"）确实违背已确认的协作模型，蓝图该表述作废。最终模型按 PRD：

```text
Project / Work Item / Work Thread：共享
每位成员的 Session / transcript / Connection / branch：独立
Handoff Capsule / Artifact / Decision / Proposal：显式共享
```

但保留一个细化：**操纵权与观察权是两件事**。禁止的是多人**操纵**同一 session；团队成员**只读旁观**他人 session 的 product-safe 时间线不引入任何权限混合（观察不改变执行主体），而这正是 Shopify 式组织学习的来源。落地为 scope 级可见性配置：8 人团队默认"workspace 内可旁观"，敏感 scope（HR/法务/薪酬）建 scope 时显式关闭。旁观所见仅为 product-safe 投影（不含 Attachment 正文、Worker 日志、provider payload），隐私不变量不破。

### 第 2 条（统一 session_events）——接受分域权威，给出修正后的最终事件架构

接受"不能统一所有权"。最终结构：

```text
Session Events        → Session 历史权威（一个账本覆盖全部 session kind）
Run State Events      → Run 生命周期权威（保留现有 run_state_events）
Effect Receipts       → 外部副作用权威（现有）
Skill/Loop Revisions  → 可复用资产权威（不可变对象，现有）
WorkThreadEntry       → 人工协作记录（canonical）
WorkActivityProjection→ 可重建的统一跨域时间线（projection，不拥有内容）
```

跨域统一的只有三样东西，且都不是权威：**统一事件信封**（eventId / domain / seq / scopeId / actor / authorizer / occurredAt / payloadRef）、**统一 cursor/水位线语义**（供 SSE、增量同步、outbox 共用）、**统一查询/投影接口**。

蓝图相对现状仍成立的一点收窄保留：现有 Main / Module / SkillCreation / Worker 四类 session 各有机制，应收进**同一个 Session Events 账本**（Session 域内统一），获得统一的分支/重放/水位线语义——这不是跨域合并，不违反分域原则。Outbox 消费所有域的事件信封，作为 SSE hub、IM 连接器、未来 APNs 的统一出口。

### 第 3 条（Postgres）——部分接受，结论反转：接受"禁双写、禁分域并存"，拒绝"试点后 ADR 再评估"的时点设计

PRD 方最有力的论据（迁移成本是行为/事务/恢复语义的重写与重验证，不是搬数据；分域并存必然产生跨库引用）成立，蓝图已撤回"新模块 PG + 旧模块触它即迁"。**禁双写、禁分域长期并存——双方一致，不再讨论。**

分歧只剩"试点后做有指标的 PG ADR"这一步。蓝图方不接受，理由：

1. **这个 ADR 门在设计上不会开。** 列出的触发条件（队列/租约 SLO 失败、数据库级 RLS 硬需求、应用层 join 主导、跨集合授权缺陷、多组织发布）在 8 人试点规模下几乎都不可能达到——8 个人压不出队列 SLO 失败，scope 隔离在两种选型下都做在应用层。所以它名义上是"证据触发"，实际是**穿着延期外衣的永久保留 Mongo 决策**。而它现实中真正可能触发的时刻，恰恰是数据已沉淀、迁移成本最高的时刻——用最高的总成本换取"看起来稳妥"。
2. **团队已裁定工期不是约束**，保 Mongo  thus 只剩一个实质论据：重写已验证正确性行为的质量风险。这个风险有工程化解法——**特征测试先行**：先将现有行为测试套件作为 characterization harness 在 Mongo 上固化全绿，再整体替换 store 实现，要求同一套件在 PG 上全绿。测试套件的可移植性审计本身是质量门：**审计结论若是不足以为迁移背书，则迁移不成立、保 Mongo**。这是一个现在就能做、成本极低的证据门——比"试点后再评估"更早、更便宜、更诚实。
3. 长期稳定（团队第一优先级）有利于 PG：新架构的中心是事件日志（全局序号）、队列（SKIP LOCKED）、推送出口（LISTEN/NOTIFY）、scope/ACL/审计（关系完整性）。Mongo 侧虽已有 leases/jobs/事件溯源的可用实现，但继续投入意味着把全局排序、队列语义、outbox 扇出做成自维护基础设施——自维护基础设施正是长期稳定性的负债。

**最终结论 D1：整体迁移 Postgres，一次性完成（禁双写、禁分域并存），作为独立里程碑与 scope 改造同期执行（scope 改造反正要动全部 store）。前置质量门：现有测试套件的 Mongo 耦合度审计 + 特征测试全绿；门不过则退回 Mongo 单库并把 ADR 触发条件改为代码级（如"活动投影的 join 复杂度越阈"），而非负载级。**

### 第 4 条（Desktop 架构）——完全接受

Desktop = Device（注册、非导出密钥、挑战-响应、短寿命凭证）+ Worker Transport（认证 outbound WebSocket，dispatch/heartbeat/ack/lease/fence/防重放）+ Capability Broker（opaque file grant）+ Effect Receipt。普通产品事件走 SSE，设备调度走 WS，不是重复实时层。蓝图的"桌面端=普通 API 客户端+sidecar"表述作废，N9 多端认证收窄为 Web/CLI/移动端 token 体系。

### 第 5 条（QM 试用）——完全接受

QM 退出交付计划。八人试点用自有 Product API 跑（试点结果必须验证自己的控制链，QM 证明不了）。QM 仅作隔离的 UX 对照研究，不保存任何权威业务状态。

## 二、更新后的最终决策表

| # | 决策 | 最终结论 | 状态 |
|---|---|---|---|
| D1 | 持久层 | **Postgres 单库，一次性整体迁移**（独立里程碑；前置：测试套件耦合度审计 + 特征测试门；禁双写/分域并存） | 待团队最终确认（PRD 方原提案为 Mongo 保留+ADR 门，双方立场均已陈述完毕） |
| D2 | Session 可见性 | 操纵权禁止共享（每人独立分支+Capsule）；**观察权 scope 级可配置**，8 人团队默认 workspace 可旁观 | 待团队确认 |
| D3 | Automation 时序 | 冲突已消解：薄试点同期交付一个真实 cloud cron Automation 垂直链路（走 CommandIntakeService），连接器触发后续 | 双方一致 |

## 三、更新后的交付顺序（与 PRD 方建议对齐，插入 D1）

1. **Phase 0**：ACL/身份/Command Intake/唯一控制链修正 + 现有 V1 NO-GO 收尾。
2. **Phase 0.5（若 D1 通过）**：测试套件 Mongo 耦合度审计 → 特征测试固化 → store 层一次性整体迁 PG（单库切换，无并存期）。
3. **Phase 1**：云核心（Session 域统一账本、scope、权限矩阵 effect×mode、Automation 域与 cron 后端、Secret 单一真相、审计双字段、设备/token 认证、typed client）。
4. **Phase 2**：Desktop 云客户端 + Web + Work Item + 个人分支的八人薄试点；**同期交付至少一个真实每日 cron Loop**。
5. **Phase 3**：Desktop Worker + 本地 capability + 设备协议；飞书委派/线程结果/审批卡片。
6. **Phase 4**：移动端只读+Inbox+审批（APNs 走 outbox）；组织学习闭环；企微/Slack 适配器。

QM 不出现在任何 Phase。


---

# 终裁记录（2026-08-04，团队负责人确认）

- **D1 持久层：通过 Postgres 方案。** 整体迁移，一次性完成；现有运行数据无沉淀价值，允许清库重新开发。执行方式不变：独立里程碑（Phase 0.5），特征测试先行（现有行为测试套件在 Mongo 固化全绿 → 同一套件在 PG 全绿为迁移完成标准），全程禁双写、禁分域并存。
- **D2 Session 可见性：通过"观察权默认开"。** 操纵权/观察权严格分离——操纵永远走个人独立分支 + Handoff Capsule；观察（product-safe 时间线的只读旁观）在 8 人团队 workspace 内默认开启，敏感 scope（HR/法务/薪酬）创建时显式关闭。
- D3 已在第二轮消解（cron 垂直链路随薄试点同期交付），无需再议。

交叉审查到此闭环。以 Master PRD v0.2 为骨架、吸收本审查全部调和结果的 **v0.3 终稿**为唯一后续权威；蓝图文档转入历史参考。
