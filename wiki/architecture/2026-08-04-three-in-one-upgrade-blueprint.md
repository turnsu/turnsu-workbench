# LoopOS / SkillOS 三合一升级蓝图：方向 · 架构 · 技术栈 · PRD

> 日期：2026-08-04（同日修订 v2：数据库改为 Postgres 优先、补充多端 API 与认证策略、协作面改为飞书优先的 IM 适配器）
> 状态：**已完成历史使命，转为参考文档。** 经两轮交叉审查（见 `wiki/prd/2026-08-04-cross-review-master-prd-vs-blueprint.md`），本文档的方向论证与技术栈选型已调和进 Master PRD v0.3（`wiki/prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md`），产品语义以 v0.3 为唯一权威。本文档保留作为参照系调研结论与选型依据的存档。
> 依据：
> - 《agent协作调研报告.md》《三项目深度对比与团队产品蓝图.md》（2026-08-03，调研对象：YC QM、吴恩达 OpenWorker、Block Buzz，及 Sierra/Anthropic/Shopify 组织级 Harness 实践）
> - 本仓库现状摸底（`wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md`、`2026-08-01-skillos-loopos-backend-architecture.md`、`PRODUCT.md`）
> - 2026-08-04 团队反馈：无生产数据沉淀，一切存储可换，纯粹按产品形态与架构适配决策；客户端路线为 桌面端 → 移动端；协作面以国内 IM（飞书/企业微信）为主
> 读者：8 人团队全员

---

## 一、方向调整：为什么要变

### 1.1 现状判断

现有系统的工程地基是扎实的：同源 Product API、不可变版本/修订模型、DAG 编译器、event-sourced 持久化 Runner、ReviewGate 人工复核、Admission/Capability 双 Lease、Docker 容器沙盒、多协议模型路由、Team library 安装/Fork/更新。这些**设计资产**保留；实现层面，由于无生产数据沉淀，存储与技术栈可以按目标架构自由更换（详见第四节的修正决策）。

问题不在工程质量，在**产品形态**：

| 现状缺口 | 后果 |
|---|---|
| 只有 Web，没有桌面端（SwiftUI 应用已 legacy 停迭代） | 用户主入口缺失，agent 能力"随人下班而下班" |
| 单机单 workspace，无公网云形态 | 8 人团队无法共享一个团队级基座 |
| 无 scope（人×房间）隔离模型 | 多人共用 = 记忆串台、密钥外泄风险 |
| cron/定时调度是 P3 deferred，无触发器 | **自动化复利不成立**——每天重复做的事无法沉淀为"到点自动跑的 Loop" |
| 协作只有 Proposal/Inbox 异步流，无"房间+线程+@委派" | 人和 agent 不是同室同事，只是表单提交关系 |
| 审批是单点 ReviewGate，没有风险分级×权限模式的类型系统 | 要么全拦要么全放，无法按风险分层自治 |
| 认证是纯浏览器形态（session+CSRF） | 桌面端/移动端/IM 插件无法接入 |

一句话：**我们之前一直在做"前端修改和驱动"，但本质上产品的形态定义不足。** 上一代产品是"造 agent 的工作台"，这一代（QM/Buzz/OpenWorker 代表的）是"运营 agent 舰队的操作层"——身份、策略、调度、持久状态、沙盒、审计才是本体，agent 智能外包给可替换的模型/harness。

### 1.2 新方向

**从 "Skill & Loop 云端工作台" 升级为 "团队 Agent 操作层"——一个产品，三个面：**

1. **桌面端（macOS 先行）**：每个人的主入口。个人 scope、本地文件与工具、Inbox 审批、离线只读。
2. **云核心（LoopOS/SkillOS 升级版）**：团队共享基座。Session 事件日志、调度、身份与策略、沙盒池、凭据代理、模型路由。
3. **协作面（房间/频道）**：房间 scope、@agent 委派、公开线程、session 可旁观/接续/分叉。初期直接接飞书等 IM，不自建聊天。

形态参照 **Buzz**（唯一同时有桌面端+云服务器+多人协作的完整形态），但**用 TypeScript 全栈重写其形态**，不采用其 Rust/Nostr 技术栈；云核心架构学 **QM**；桌面端与权限引擎学 **OpenWorker**。

**Loop 和 Skill 的定位变化**：从"产品的全部"变成"操作层上的复利资产"——Skill 是可晋升的能力包，Loop 是可定时、可模板化、可复用的工作流，二者挂在 scope 上随团队使用持续增值。这正是"团队每天做的事自动复利化"的落点。

---

## 二、目标产品形态与参照映射

| 我们的产品模块 | 主要借鉴 | 具体借鉴什么 |
|---|---|---|
| 桌面壳 | **OpenWorker** | Tauri 2 + React 壳结构、签名公证/自动更新、连接器 OAuth broker；sidecar 我们用 Node/TS 而非它的 Python |
| 权限引擎 | **OpenWorker** | 风险四级（read/write_local/exec/external）× 权限五档（discuss/plan/interactive/auto/custom）矩阵；无人值守 = Inbox 挂起而非提权；shell 永远询问 |
| 云核心 | **QM** | API·Identity·Policy·Scheduler 的 headless core；插件面（Web/Admin/IM/桌面端）可拆装；wiring 文件注入 harness；Postgres 统一持久层 |
| Session 底座 | Anthropic/QM/Buzz 共识 | append-only 事件日志，独立于 harness 与沙盒存活；harness 无状态可重放；session ≠ 上下文窗口 |
| scope 隔离 | **QM** | 人×房间粒度；各自记忆/文件/凭据视图/权限/cron/沙盒 |
| 协作交互 | **Buzz** | 频道内人和 agent 对等、@委派、agent 间 @交接；agent 有名字和头像（persona） |
| 问责审计 | **Buzz**（简化版） | 每条 agent 行为记录"谁做的 + 谁授权的"双字段；agent 权限可独立吊销；**不上密码学，数据库层面实现** |
| 沙盒 | QM/Anthropic（我们已有） | `execute(name,input)→string` 接口；沙盒是 cattle；harness 住在沙盒外 |
| 凭据 | OpenWorker/Sierra（我们已有雏形） | 秘密永不进模型上下文；云端 OAuth 走代理 vault 代发 |
| Skill 治理 | **QM** | skill 归属 scope → 授权共享 → admin 审批晋升全组织；skill pack 从 git 导入 |
| 部署 | **QM** | 部署目录契约（核心通用 + layers/<org> 定制）；一条命令起整套 |
| 成本治理 | Buzz/QM | 接收侧闸门；per-scope token 预算；贵模型 planning + 便宜模型执行 |

**不整体照搬任何一个**：Buzz 是 pre-1.0 + Rust 30 万行（8 人团队维护不起）；QM 无桌面端；OpenWorker 无多人协作。三者各取一块。

---

## 三、目标架构

### 3.1 分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│ 客户端层（全部是云核心 API 的可选客户端，共享同一套 typed contract）   │
│  ┌──────────────┐ ┌───────────┐ ┌───────────┐ ┌───────────────┐ │
│  │ macOS 桌面端   │ │ Web 工作台 │ │ 移动端(P2) │ │ IM 插件面      │ │
│  │ Tauri2+React │ │ React SPA │ │ 只读+审批  │ │ 飞书→企微→Slack│ │
│  │ +Node sidecar│ │ (现有升级) │ │ 起步      │ │ (适配器,不自建) │ │
│  └──────────────┘ └───────────┘ └───────────┘ └───────────────┘ │
│         传输：HTTP(请求/响应+幂等) + SSE(流式推送) + cursor 增量同步  │
│         认证：浏览器 session / 非浏览器 token(设备授权+refresh 轮换)  │
├──────────────────────────────────────────────────────────────────┤
│ 云核心 headless core（LoopOS/SkillOS 升级版，全部 turn 过中央核心）    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ API 层：ETag/幂等/错误信封/SSE（现有），契约优先生成各端 client │   │
│  │ Identity：用户 + scope（人×房间）+ 委托身份 + agent persona    │   │
│  │ Policy：权限矩阵（风险四级×模式五档）+ 硬命令策略（不可旁路）     │   │
│  │ Scheduler：cron + watch + webhook 触发器（新建）               │   │
│  │ Session 服务：append-only 事件日志 + 分支/接续 + 上下文组装      │   │
│  │ 模型路由：model_profiles 升级（planning/执行分层 + 预算）        │   │
│  │ 凭据 vault：秘密永不进上下文/sandbox/trace（硬约束）             │   │
│  │ 审计：actor + authorizer 双字段，全量可查                       │   │
│  │ Outbox：事件 → SSE / IM 推送 / 移动端推送网关 的统一出口         │   │
│  └──────────────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────────┤
│ 执行层（脑手分离，现有资产升级）                                      │
│  ┌────────────────────┐  ┌──────────────────────────────────┐  │
│  │ 无状态 Harness/Runner│  │ 沙盒池（cattle）                   │  │
│  │ DAG 编译器→持久化Runner│→│ Docker 容器：digest 锁定/禁网/      │  │
│  │ 崩溃后重放 session 续跑│  │ 只读根/资源限额（现有,已 fail-closed）│  │
│  └────────────────────┘  └──────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ 数据层（Postgres 单库，见 3.3 决策论证）                              │
│  PG: session_events(append-only) / scopes / skills / loops      │
│      / runs / memory / queue(SKIP LOCKED) / audit / outbox      │
│  对象存储：artifacts（现有，AES-256-GCM 加密备份）                    │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 十条核心架构决策

每条标注：**[新建]** 仓库里完全没有 / **[升级]** 有基础需改造 / **[保留]** 现状已满足。

1. **Session 事件日志一等公民化 [升级]**。现有 `run_state_events`（append-only + fold 投影）只覆盖 Run 生命周期。升级为统一的 `session_events` 日志：任何 session（对话、Loop Run、cron 触发、IM 委派）都是一条 append-only 事件流，可重放、可分支（他人用自己的授权分叉独立继续）、可接续。这是一切协作功能的地基，**先做这一件事**。
2. **脑手分离 [升级]**。Harness（编排循环）无状态化：崩溃后新实例从事件日志重放续跑。执行环境收敛到 `execute(name, input) → string` 接口后面（现有 execution-broker 的 process/container/remote 适配器已经是这个形状，收敛契约即可）。
3. **scope 模型：人 × 房间 [新建]**。隔离粒度不是 agent 个体，而是 scope：每个人一个个人 scope，每个项目/房间一个共享 scope。每个 scope 独立的记忆/文件/凭据视图/权限/cron/沙盒。agent 被拉进房间即获得该房间的共享 scope。现有 `workspace-local` 单 workspace 模型扩展为 `workspace → scopes[]`。
4. **单一入口 + 意图路由，不做角色化多 agent [新建]**。对用户只有一个 agent 入口（一个 @handle / 一个输入框），分类器按任务路由环境/模型/预算；并行度靠临时子 session 获得，不预定义"产品经理 agent / 研发 agent"。Sierra 的教训：角色 agent 死于用户记不住 + 业务天然跨部门。
5. **审批做成类型系统，不是弹窗 [升级]**。在现有 ReviewGate / approval-decision 之上，实现风险四级 × 模式五档的二维矩阵。无人值守 ≠ 提权，只把审批路由到 Inbox 挂起；预声明破坏性命令（rm -rf、破坏性 SQL）硬拦截，**所有模式下生效、不可旁路**。审批入口同时进 Web Inbox 和 IM 卡片按钮。
6. **凭据走代理 vault [升级]**。现有 Connections（workspace 级密钥绑定、密钥不出 workspace）+ macOS Keychain 是基础。升级为统一 vault 服务：云端代发 OAuth，token 永不进模型上下文/trace/sandbox 环境变量。硬性架构约束。
7. **审计双字段 [升级]**。每条 agent 行为事件同时记录 `actor`（哪个 agent/session 做的）和 `authorizer`（谁授权的、哪条 standing rule 放行的）。agent 权限可独立吊销不连坐人。直接回应"员工对过程 WHY 一问三不知只能背锅"——审计必须能回溯每个决策的出处，包括 AI 写的 spec 是否被读过。
8. **Skills 治理晋升链 [升级]**。现有 Team library（发布/install/fork/update）+ skill 状态机（draft→validating→ready）升级为 QM 式链路：skill 归属 scope → 授权共享给其他 scope → admin 审批晋升全组织。skill pack 支持从 git 仓库导入（现有 github-skill-repository-source 已有一半）。
9. **调度与触发层 [新建]**。cron + watch + webhook 触发器，每次运行绑定一个 session（留全量 transcript 供审计）。这是"自动化复利"的直接载体：昨天手工跑的 Loop，今天变成 7:30 自动跑、结果进房间线程的 cron Loop。**填补 CURRENT_SYSTEM_ARCHITECTURE 里 P3 deferred 的最大空白。**
10. **部署目录契约 [新建]**。核心完全通用，团队特定的一切（org 配置、自定义 skills、沙盒镜像、基础设施）收进 `deploy/layers/<org>/`；一条命令部署到自有云账号。先把现在 docker-compose 单机形态参数化，再长出云部署。

### 3.3 数据库决策：MongoDB → Postgres（修订后的明确结论）

**结论：换，且现在就是整个生命周期里成本最低的切换点。**

前提已确认：系统无生产数据沉淀，Mongo 里没有任何不可丢弃的资产，选择纯粹按产品形态与架构适配。

**为什么 Postgres 更适配目标架构**——新核心的四类负载恰好都是 PG 的主场：

| 新核心负载 | Postgres 原生能力 | MongoDB 需要自己补的 |
|---|---|---|
| session 事件日志（append-only + 全局有序 + 水位线重放） | bigserial/序列保证全局序号；按 scope 索引分页；事件 sourcing 生态成熟 | 跨文档全局有序性需额外机制 |
| 实时推送（SSE / IM / 移动端推送的事件出口） | `LISTEN/NOTIFY` + transactional outbox 直接驱动 | change streams 可用但语义与运维更重 |
| 任务队列（cron 触发、agent 任务、重试） | `SELECT ... FOR UPDATE SKIP LOCKED` 是行业标准做法（QM 的 queue 就是这么存的） | 需自建队列语义 |
| scope/身份/权限/审计（强关系 + 一致性问题） | 关系模型 + 行级安全（RLS 可直接做 scope 隔离的兜底） + 事务 | 多文档事务有但非其强项 |

payload 灵活性不是障碍：事件体、skill manifest 等用 JSONB 存，兼得 schema 演进自由与可索引查询。

**迁移策略（与 TS 迁移策略同构）**：

1. **新核心模块直接生在 Postgres 上**：session 事件日志、scope、身份/审计、调度器、队列、vault 索引——这些本来就要从零写，零迁移成本。
2. **存量模块"触它即迁"**：skills/loops/runs 等现有 Mongo store，在该模块为新架构做实质性改动时连同迁 PG（与"触它即迁 TS"同步发生，一次改动完成双重迁移）。
3. **双库并存期规则**：新数据一律 PG；Mongo 只服务未迁移的旧模块；禁止跨库事务依赖（跨库一致性走事件/outbox，不走分布式事务）。
4. **终点是单一 PG**：运维面从 docker-compose 单容器 Mongo 换成单容器 PG，8 人团队负担不变；artifacts 对象存储（文件+加密备份）不受影响，原样保留。
5. 风险如实记录：双库并存期是真实复杂度，需要有明确的所有权和收敛时间盒（建议随 Phase 1 结束收敛掉 session/scope/scheduler 三个域，其余随迭代收敛）。

### 3.4 多端传输与 API 策略：HTTP + SSE 够用，但要补四个缺口

**结论：传输形态不需要革命。** 桌面端、移动端、Web、IM 插件都是普通 API 客户端，HTTP（请求/响应 + ETag + 幂等键）+ SSE（服务端流式推送）是经过 QM、OpenWorker 验证的形态。不引入 WebSocket 为主的实时层（双向实时协同编辑不在路线图）、不引入 gRPC/GraphQL（8 人团队的多端成本大于收益）。

但现有 HTTP 层是按"纯 Web 单机"设计的，面对多端路线有**四个必须补齐的缺口**：

1. **认证升级（硬缺口，P0）**。现有 bcrypt + session + CSRF 只服务浏览器。桌面端/移动端/CLI 需要 token 形态：设备授权流程（设备码 → 浏览器确认，或 OAuth2 PKCE）、refresh token 轮换、**设备级吊销**（丢一台笔记本只吊销它的 token，不连坐账号）。agent/API 客户端走独立的 service token，与 human token 在审计里可区分。
2. **契约优先的多端 client（P0）**。四端消费同一套 API，绝不能每端手写请求层。以 `workbench-contracts`（TypeBox）为唯一事实源，生成各端 typed client + 可选 OpenAPI 输出；契约变更即 breaking change 审查。这是"多端不爆炸"的前提。
3. **cursor 增量同步协议（P1）**。桌面端离线只读、移动端弱网重连，都靠同一个机制：session 事件日志的水位线（`after_seq`）增量拉取 + 本地缓存重放。现有 cursor 分页是雏形，推广到事件流；同步协议只对事件日志这一个数据源定义，不做泛化的多端同步框架。
4. **推送网关抽象（P2，现在留口）**。移动端锁屏后 SSE 必然失效，推送只能走 APNs/厂商通道。架构上现在就把出口设计好：所有需要外推的事件走 **outbox**（PG 表 + `LISTEN/NOTIFY`），SSE hub、IM 插件、未来的 APNs 网关都是 outbox 的消费者——移动端到来时不用改核心，只加一个消费者。

---

## 四、技术栈决策

### 4.1 总表：现状 → 目标

| 层 | 现状 | 目标 | 决策与理由 |
|---|---|---|---|
| 语言 | 主体 JS ESM（.mjs ~95k 行），TS 仅契约包+少量入口 | **TypeScript 为唯一新增语言** | 团队硬性要求；详见 4.2 迁移策略 |
| 运行时 | Node 22（.tooling 锁定） | Node 22 不变 | 成熟，无更换理由；不引 Bun |
| 云核心 HTTP | 自研 handler（ETag/幂等/SSE 已完备） | **保留自研传输层**，补齐认证/契约/同步/outbox 四缺口（3.4） | 传输形态本身正确，不必迁 Fastify；要补的是多端能力而非框架 |
| 持久层 | MongoDB 6（docker-compose 单容器） | **Postgres 单库**（新核心直接建在其上，存量触它即迁） | 无数据锁定，按架构适配选择；论证见 3.3 |
| 前端 | React 19 + Vite + StyleX + astryx 设计系统 | 不变，Web 与桌面端/未来移动端**共享组件库** | 桌面端复用现有四 surface 组件，不重写 |
| 桌面端 | SwiftUI legacy（停迭代） | **Tauri 2 + React + Node sidecar** | 学 OpenWorker 壳结构但 sidecar 用 Node/TS（与云核心同语言同契约），不用它的 Python；不继续投 Swift；不用 Electron（体积/内存，且 Tauri 是三参照系共同选择） |
| sidecar | 无 | Node 22 打包为 Tauri sidecar | 本地工具（文件/git/shell）+ 本地模型路由（可选 Ollama）+ 离线只读缓存 |
| 移动端 | 无 | P2 起步：只读 + 审批 | 先 Web 移动视图够用；原生壳待桌面端站稳后评估（Tauri mobile 或 RN，届时再决策） |
| Agent/LLM | PI 生态（pi-coding-agent）+ 自研多协议 executor | 不变 | harness 无关是既有设计，继续 |
| 沙盒 | Docker（digest 锁定/禁网/只读根/fail-closed） | 不变，池化增强 | 已是三家大厂共识形态 |
| 协作 IM | 无 | **飞书优先，企微/Slack 经同一适配器接口接入，不自建聊天** | 见 4.3 |
| 协议/身份 | bcrypt session + CSRF | 增加 token 认证（设备授权+轮换+吊销）；审计 DB 双字段 | **不上 Nostr/secp256k1**：Buzz 的 attestation 思路用 DB 字段实现，密码学对单一公司是过度设计 |
| 部署 | docker-compose（仅 Mongo） | 部署目录 + 一条命令云部署（自有 VPS / fly.io 类） | 学 QM deployment directory |

### 4.2 TypeScript 迁移策略

现状是 ~13 万行 JS。8 人团队**不可能也不应该**停下手头一切做全量重写。策略：

1. **所有新代码一律 TypeScript**（严格模式）：session 服务、scope、权限矩阵、调度器、桌面端、sidecar、IM 插件、PG store——新模块直接生在 TS 里。
2. **契约先行**：`workbench-contracts`（已是 TS + TypeBox）扩展为新模块的唯一事实源，JS 存量代码经契约边界与新 TS 模块交互，同时作为各端 typed client 的生成源。
3. **存量渐进迁移**：只有当一个 JS 模块需要为新架构做实质性改动时，才连同改动一起迁 TS（"触它即迁"，与 Mongo→PG 迁移同步发生）。纯稳定的存量留在 JS 不动——它们有测试覆盖，迁移没有收益。
4. 不做"TS 化大跃进"里程碑。语言统一是结果，不是目标。

### 4.3 协作面：IM 适配器（飞书优先）

- **底层是一个 IM 适配器接口**，四组能力：消息收发 / 线程（reply in thread）/ @提及解析 / 卡片交互（审批按钮、进度卡片）。房间 scope 与 IM 频道一一绑定。
- **飞书第一个做**：团队实际工具；机器人能力完整（消息、线程、卡片按钮、@机器人），卡片按钮可直接承载 Inbox 审批的外部入口。
- **企业微信第二波**：应用消息能力够用但线程/交互弱于飞书，适配器实现时接受能力降级（审批卡片降级为链接跳 Web）。
- **Slack 第三波**：能力最全（QM/Buzz 都选它不是偶然），但国内团队日常使用优先级最低。
- 原则不变：不自建聊天，协作抓手是公开线程 + @提及，默认公开、敏感场景（HR/法务/薪酬）opt-in 私有——公开语料是组织学习的引擎。

---

## 五、功能清单：引进 / 升级 / 不做

### 5.1 新引进（仓库里没有的）

| # | 功能 | 来源 | 价值 |
|---|---|---|---|
| N1 | **scope（人×房间）模型**：独立记忆/文件/凭据/权限/cron/沙盒 | QM | 多人共用一个系统而不串记忆、不泄密 |
| N2 | **统一 session 事件日志**：所有 session 类型 append-only、可分支/接续/旁观 | Anthropic/QM/Buzz | 协作、恢复、审计、复利四合一地基 |
| N3 | **权限矩阵引擎**：风险四级 × 模式五档 + Inbox 挂起 + 硬命令策略 | OpenWorker | 审批从弹窗变类型系统 |
| N4 | **cron / webhook 触发器**：Loop 定时自动跑，结果进房间线程，全量 transcript | OpenWorker/QM | **自动化复利的直接载体** |
| N5 | **macOS 桌面端**：Tauri 壳、个人 scope、Inbox、本地工具、离线只读 | OpenWorker | 用户主入口 |
| N6 | **IM 插件面（飞书优先）**：房间 @agent 委派，结果回线程，卡片审批 | QM/Buzz | 协作抓手是公开线程不是新 UI |
| N7 | **agent persona**：名字/头像/可被 @/可被交接；发现公开、记忆私有 | Buzz | agent 成为组织成员的交互范式 |
| N8 | **部署目录**：`deploy/layers/<org>/` + 一条命令云部署 | QM | 从单机到云核心的通路 |
| N9 | **多端认证**：设备授权 token、refresh 轮换、设备级吊销 | 多端路线的硬前提 | 桌面端/移动端/CLI 的入场券 |
| N10 | **outbox 推送出口**：事件 → SSE/IM/APNs 的统一分发 | 架构前瞻 | 移动端与未来实时性的扩展口 |

### 5.2 升级（已有基础上改造）

| # | 功能 | 现状 → 目标 |
|---|---|---|
| U1 | Loop 复利化 | 手动触发 + Template → **cron 自动运行 + Run 证据反哺模板迭代**（昨天跑过的今天自动跑，不再重新设计） |
| U2 | SkillOS 治理 | Team library install/fork → **scope 归属 → 共享授权 → admin 审批晋升全组织** |
| U3 | Session 体系 | 多类 session 各自为政（Main/Module/SkillCreation/Worker）→ **统一事件日志 + 分支/接续** |
| U4 | 审批 | ReviewGate 单点 + approval-decision → **风险×模式二维矩阵 + Inbox/IM 卡片双入口无人值守挂起** |
| U5 | 凭据 | Connections + Keychain → **统一 vault，OAuth 代理代发，秘密永不进上下文**（硬约束） |
| U6 | 审计 | 事件日志 → **actor + authorizer 双字段全量记录 + 审计视图**（可回答"每个决策的出处"） |
| U7 | 模型路由 | model_profiles 目录 → **planning/执行分层路由（贵模型规划、便宜模型执行）+ per-scope token 预算** |
| U8 | 多用户 | 单 workspace 设计已有多用户并发 → **多 scope 云部署，8 人真实共用一个基座** |
| U9 | Web 前端 | 四 surface（Agent/Skills/Loops/Team library）→ 增加 **Rooms（协作面）与 Inbox（审批中心）两个一级 surface**，组件库抽离供桌面端复用 |
| U10 | API 层 | 纯 Web 单机形态 → **契约优先 typed client + cursor 增量同步 + token 认证** |

### 5.3 明确不做（防 scope 蔓延）

- ❌ 不上 Nostr / secp256k1 / 任何密码学身份（DB 双字段实现同等问责语义）
- ❌ 不自建聊天/IM（飞书/企微/Slack 适配器接入）
- ❌ 不做角色化多 agent（产品 agent/研发 agent 互相对话——Sierra/Cognition 已证伪）
- ❌ 不引入 WebSocket 为主的实时层 / gRPC / GraphQL（HTTP+SSE 足够，见 3.4）
- ❌ 不继续投 SwiftUI 桌面端（保留 legacy 参考，新桌面端 Tauri）
- ❌ 移动端 P2 之前不做原生应用（Web 只读视图起步）
- ❌ 不做多租户 SaaS / 公开市场 / 计费（维持 PRODUCT.md 非目标，先服务自己 8 人团队）

---

## 六、PRD

### 6.1 产品定位

**面向 8 人团队的"人和 agent 共事"操作层**：桌面端是个人主入口，云核心是团队共享基座，房间是协作空间。团队每天重复做的事沉淀为 cron Loop 和可晋升 Skill，自动复利——做过一次的事，不再重新设计。

### 6.2 目标用户与核心场景

**用户**：我们自己（8 人团队）。先自用半年再谈外部。

**S1 晨报复利（N4+U1）**：内容负责人配一次"每日情报 Loop"（抓取→筛选→成稿），设为 7:30 cron。每天早报自动出现在团队房间线程里，全量 transcript 可查。前一天调好的参数成为模板默认值，永不重复配置。

**S2 房间内委派（N1+N6+N7）**：任何成员在项目房间（飞书群）@agent："把昨天那个客户 demo 的问题查一下"。agent 以房间共享 scope 开工，session 公开可旁观；任务跨售前/调查/修代码时，session 跟着任务走、动态获得新工具，不换"角色"重头讲背景。其他人可进同一线程补充约束，agent 吸收新信息沿原任务继续。

**S3 桌面端个人工作（N3+N5）**：成员在桌面端让 agent 处理本地文件/代码。写操作按权限矩阵走：interactive 模式下逐个批准；挂起事项进 Inbox，下班前集中批复（也可以在飞书卡片上点批准）。无人值守不等于放权。

**S4 跨人接续（N2）**：A 发起的调研 session 跑到一半，B 用自己的授权分叉一份继续深挖；原 session 不受影响。全程可回答"哪一步是谁授权做的"。

**S5 决策回溯（U6）**：一个 AI 参与的大 PR 被质疑时，审计视图能拉出：spec 是哪版、谁读过、每个工具调用的 authorizer 是谁、复核门谁点的通过。不再"员工只能背锅"。

**S6 能力晋升（U2）**：某成员在项目房间沉淀出一个好用的 skill，一键共享给团队 scope，admin 审批后晋升全组织，所有人的 agent 即刻可用。组织智慧沉淀在 SkillOS，不沉淀在个人电脑里。

### 6.3 功能优先级

**P0（云核心地基，先做）**
- Postgres 落地 + 统一 session 事件日志（append-only + 重放 + 分支）
- scope 模型（人×房间）+ 现有数据映射
- 权限矩阵引擎 + Inbox 挂起 + 硬命令策略
- cron 调度器 + 触发 session transcript
- 凭据 vault 硬约束（秘密不进上下文）
- 审计双字段
- **多端认证（设备授权 token）+ 契约优先 typed client**

**P1（形态成型）**
- macOS 桌面端（Tauri 壳 + 个人 scope + Inbox + 本地工具 + 离线只读）
- 飞书插件面（@委派 + 线程回复 + 房间 scope 绑定 + 卡片审批）
- agent persona + Web 端 Rooms / Inbox 两个新 surface
- Skill 治理晋升链 + git 导入
- 模型分层路由 + per-scope 预算
- 部署目录 + 一条命令云部署
- cursor 增量同步协议

**P2（深化）**
- session 分叉/接续 UI 化、审计视图
- 组织学习闭环：公开工作记录 → 自动产出 skill 更新建议 / AGENTS.md diff
- watch 触发器、webhook、企微/Slack 适配器
- 移动端（只读 + 审批起步）+ APNs 推送网关

### 6.4 验收与成功指标

- 8 名成员每人有个人 scope，≥3 个项目房间 scope 真实运转
- ≥5 个 cron Loop 每日自动运行并产出到房间（自动化复利可量化：每周省下的重复人工小时数）
- 任意 session 可重放、可分支；任一 agent 行为可回答 actor + authorizer
- 秘密扫描：模型上下文/trace/sandbox 环境中 0 次凭据出现
- 桌面端：签名公证可下载，个人 scope 与云端同步，Inbox 审批闭环；同一套 API 被 Web/桌面/飞书三端真实消费
- 延续仓库既有标准：全新空库 + 临时 runtime 的端到端证据，NO-GO 门不变

### 6.5 非目标

多租户 SaaS、公开 skill 市场、计费、移动端原生应用（P2 前）、跨组织联邦、密码学身份、自建 IM。

---

## 七、里程碑路线图（对齐 8 人产能）

**Phase 0（2–4 周）验证与收尾**
- 直接部署 QM 到一台云服务器，8 人用 Web+Slack 真实跑两周业务——验证 scope 模型、三档安全姿态、skills 治理的手感，产出基于真实使用的差距清单
- 同时收尾现有 V1 的 NO-GO 项（外部 Provider 实证、生产存储、CVE 门），不留烂尾

**Phase 1（4–8 周）云核心升级（P0）**
- Postgres 落地（docker-compose 替换 + PG store 层）→ session 事件日志 → scope 模型 → 权限矩阵 → cron 调度 → vault → 审计双字段 → 多端认证 + typed client
- 全部新模块 TypeScript，经 workbench-contracts 与存量 JS 交互；存量模块触它即迁（TS + PG 同步完成）
- 时间盒：Phase 1 结束时 session/scope/scheduler 三个域完全收敛到 PG，不允许长期双库

**Phase 2（6–10 周，与 Phase 1 后段并行）桌面端 + 协作面（P1）**
- Tauri 壳 + Node sidecar；Web 组件库抽离复用
- 飞书插件面；Rooms/Inbox 新 surface；persona；治理晋升链；部署目录上云；cursor 增量同步

**Phase 3（持续）复利深化与移动端（P2）**
- 分叉/接续、审计视图、组织学习闭环、触发器扩展、企微/Slack 适配器
- 移动端（只读+审批）与 APNs 推送网关

---

## 八、风险与开放问题

1. **三个参照项目都只有 1–2 周公开历史**，按实验性软件对待；QM 可试用但不承载不可逆业务。各家成效数据均为自报，无独立验证。
2. **双库并存期复杂度**：Mongo→PG 不是一次性切换，并存期必须遵守"新数据一律 PG、禁跨库事务依赖"的规则，并用时间盒收敛（Phase 1 末收敛核心三域），否则会演变成长期两套运维面。
3. **TS 迁移的执行纪律**：必须守住"新增全 TS、触它即迁、不搞大跃进"，否则要么烂尾要么拖垮迭代。
4. **多端认证的实现面不小**：设备授权流程、token 轮换、吊销、与现有 session 认证共存，需要专门设计评审，不要顺手写。
5. **桌面端签名公证/自动更新**是脏活，OpenWorker 的壳工程可直接参考，预留专门人力。
6. **飞书适配器的能力边界**：线程语义、卡片交互、消息撤回等与 Web 端不完全对齐，需要在适配器契约里显式建模"能力降级"，避免核心代码 if/else 化。
7. 开放问题：agent persona 的命名/形象体系；本地模型（Ollama）是否进 P1；移动端原生壳届时选 Tauri mobile 还是 RN。

---

## 附：与仓库现有文档的关系

- 本文档是**方向提案**，不直接 supersede `PRODUCT.md` 与 `CURRENT_SYSTEM_ARCHITECTURE.md`；团队评审通过后，应更新 `PRODUCT.md` 的产品定位章节，并在 `wiki/prd/` 下按 P0/P1 拆分系列子 PRD。
- 技术地基描述以 `wiki/architecture/2026-08-01-skillos-loopos-backend-architecture.md`（Iterations 0–6）为准，本文档的"升级"项均在其之上叠加。
- v2 修订记录（2026-08-04）：数据库结论由"保留 Mongo"反转为"Postgres 优先"（新增 3.3 论证）；新增 3.4 多端传输与 API 策略（认证/契约/同步/outbox 四缺口）；协作面改为飞书优先的 IM 适配器（4.3）；功能清单新增 N9/N10/U10；路线图 Phase 1 增加 PG 落地与多端认证。
