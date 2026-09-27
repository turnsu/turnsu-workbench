# 05 · 执行计划（给 Codex）v2

## 2026-07-24 实施快照

> M1–M4 的历史任务记录保留其当时的实现背景。当前页面、信息架构、创建流和模型开关
> 一律以 `07-ux-restructure-m5.md` 为准；pre-M5 `03` 页面规格已归档，不再作为本计划
> 的当前验收依据。

- M1 已落地：首管理员 bootstrap、账号登录/退出、成员角色、HttpOnly Session、
  CSRF/Origin 防护及前端登录守卫。
- M2 主链已落地：浏览器目录、受限 ZIP、公开 GitHub 导入，管理员 allowlisted server
  scan/import、26 个本机 Lark Skill 识别、精确 Tool Action 策略、`execFile` 无 shell、
  Prompt/Tool Skill 经产品 Broker 测试与运行。
- M3 执行内核已落地：四协议模型路由保持固定 revision；Prompt Skill 使用
  `bounded_agent/process`；外部写节点强制直接依赖 Review Gate；effect receipt
  持久化并在成功重放时跳过，结果不明时禁止自动重试。
- 尚未达到 M2/M3 出口标准：真实 Provider、成员 Lark OAuth/profile、至少 5 个真实
  Skill 发布和两个真实飞书闭环尚未在本机环境完成；IA 合页与新的前端 tree 基线也未完成。

## 总则

- 5 个里程碑（M1–M5），**顺序固定：先认证与启动链，再 Skill 接入（含 Tool Adapter），
  真实闭环验收（M4）与 UX 重构（M5）可并行**。这是交叉 review 确认的顺序，不得调换。
- 每里程碑内任务分成可并行批次（Batch）。多 Agent 并行时同 Batch 标注 `[并行]` 的
  可同时开工；遇到 429 限流按批次串行。
- **删除纪律**：只允许删除/归档 `02` "删除/归档清单"中列出的对象。模型路由、
  四个协议 executor、Agent Slice 0–4（agent sessions、builder proposal、
  in-process adapter）、Sandbox、Memory/Remote/Stability 的底层契约与实现**一律不动**。
  模型选择的**表现层**按 `07` Batch A 改为轻量开关——`modelProfileId` 契约与后端
  路由不变，不属于"动模型路由"。
- 当前验证基线以 `08-iteration-reconciliation-and-implementation.md` 和对应 M5 QA
  记录为准，不在执行计划复制易过期计数。仍未形成新提交前端视觉基线，
  frozen-frontend release gate 会按设计拒绝候选；改动后已验证基线不得变差；
  需要 Mongo 的测试用隔离临时 runtime + `_test` 库（AGENTS.md 规则）。
- 遵守仓库 `AGENTS.md`：开工前读 `wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md`
  和就近 `AGENTS.md`；`git status --short` 中已有改动视为用户工作，不得覆盖；
  不移动/删除 `runtime/**` 产物。

## M1 · 地基：认证 + 启动链 + 有限大扫除（预估 3–4 天）

目标：任何人 `cp .env.example .env` 后一条命令起服务，bootstrap 初始化 admin，
成员注册登录后看到现有产品（功能不减少）。

### Batch 1（启动链，先修）

| # | 任务 | 位置 | 验收 |
|---|---|---|---|
| 1.1 | `.env.example` 补齐全部隐性变量（`WORKBENCH_MONGO_DATA_DIR/CONFIG_DIR/SECRETS_DIR`、`WORKBENCH_MODEL_*` 系列、`WORKBENCH_REGISTRATION_OPEN`、`WORKBENCH_BOOTSTRAP_ADMIN_TOKEN`、`WORKBENCH_SKILL_IMPORT_ROOTS` 等，以代码 `process.env` 全量比对为准） | `.env.example` | 无遗漏 |
| 1.2 | mongosh 副本集探测带认证；默认 URI 带凭据或显式报错 | `scripts/start-workbench-server.sh:7,27-33` | 干净环境一条脚本起到 8798 |

### Batch 2（有限大扫除，`[并行]` 3 路）

| # | 任务 | 验收 |
|---|---|---|
| 2.1 `[并行]` | 归档 legacy 入口（`bin/wechat-agent-daemon.mjs`、`scripts/*loopops*`、`wechat-cli/`、`Package.swift`、`domains/frontend/app/` → `archive/`）；**库文件不动**；修复断掉的 import | 测试基线不变差，server 能起 |
| 2.2 `[并行]` | 删前端死代码：无消费死导出、死 i18n key、隐藏测试按钮、演示数据白名单与静默过滤（`LoopsBoardView.jsx:182-186,24-27`、`SkillsView.jsx:61-64`）；修复 Resources 半死态（打开查询并标注实验性，或隐藏创建入口，执行时定并记录） | build 通过；grep 无残留；真实数据不再被隐藏 |
| 2.3 `[并行]` | 修复 `/objects/{objectId}` 契约（注册路由或移除契约）；过期文档归档（`domains/frontend/documents/current-skill-workflow-loop-workbench.md`、过期 INTERACTION_QA 段 → `wiki/history/`），README Active Truth 指向本套文档 | 契约与路由一致；文档索引更新 |

### Batch 3（认证，核心新增，串行）

| # | 任务 | 验收 |
|---|---|---|
| 3.1 | `users` + `authSessions` 集合、`bcryptjs`、注册/登录/登出端点（契约先行） | curl 全流程：注册→登录→带 cookie 访问→登出→401 |
| 3.2 | `requireAuth` 替换 `bootstrapSession` 自动签发（`workbench-http-handler.mjs:575-605`）；`WORKBENCH_REGISTRATION_OPEN` 开关；保留测试身份通道仅测试模式可用 | 未登录 401；现有测试改造后通过 |
| 3.3 | admin 初始化：一次性 bootstrap token（用后失效）或 CLI 显式创建；成员页角色管理（admin 可改角色/禁用）；**不做首个注册者自动 admin** | 无 token 无法成为首个 admin；并发注册无竞态 |
| 3.4 | 前端 `/login` `/register` + 路由守卫 + `/members` 页 | 历史 M1 验收记录；当前 UX 以 `07` 为准 |
| 3.5 | 单 workspace 产品形态：UI 只呈现默认 workspace；**后端隔离字段与查询过滤保留** | 两人注册互见对方对象；跨 workspace 拒绝的现有测试仍通过 |

**M1 出口标准**：干净环境一条命令起服务；admin 经 bootstrap token 初始化；
两人注册登录；现有功能（Builder/Agent/模型路由/上传通道）全部照常可用；测试基线不变差。

## M2 · Skill 接入：上传 + lark Tool Adapter（预估 4–5 天）

| # | 任务 | 依赖 | 验收 |
|---|---|---|---|
| 2A `[并行]` | 浏览器目录/受限 ZIP 上传（复用 quarantine→inspector→草稿链路；inspector 扩展 `tools` allowlist 校验） | M1 | 浏览器上传 5 个 lark skill 成草稿 |
| 2B `[并行]` | 服务器路径扫描导入（仅 admin、白名单根目录、路径穿越防护） | M1 | admin 从服务器 `~/.agents/skills` 导入；member 无此入口 |
| 2C | lark Tool Adapter：精确 Action allowlist、参数 Schema、`execFile` 无 shell、超时/截断、写操作由直接前置 Review Gate 确认、effect receipt | M1 | 单测覆盖：白名单外拒绝、shell 注入无效、确认前后状态、receipt 记录与不确定结果禁重放 |
| 2D | Skill 详情页 + 发布流 + readiness（frontmatter/CLI 依赖/allowlist/模型就绪） | 2A | 历史 M2 验收记录；当前 UX 以 `07` 为准 |
| 2E | 成员级 lark-cli 凭证：各成员 OAuth 授权、凭证按用户隔离 | 2C | 成员 A 的操作不以成员 B 身份执行 |

**M2 出口标准**：≥5 个真实 Skill 已发布在库中；Tool Adapter 安全单测全绿；
写操作未经确认不会执行。

## M3 · Loop 运行闭环 + 前端合页（预估 4–5 天）

| # | 任务 | 依赖 | 验收 |
|---|---|---|---|
| 3A | Loop 工作台页：Skill 面板/画布/步骤配置+ModelPicker/底部 Run 抽屉（含待确认 tab） | M2 | 历史 M3 验收记录；M5 模型开关与创建流以 `07` 为准 |
| 3B | prompt+tool 节点执行链路接通：SKILL.md→system prompt、references 惰性注入、输入渲染、Adapter 工具循环（≤5 轮）、待确认续跑 | 2C,3A | 真实跑一次 `lark-calendar` 节点；事件流完整 |
| 3C | Fork + 发布（Loop 级）+ 版本固定重跑 + Run 对比视图（输出/事件并排，展示差异） | 3B | Fork 改参重跑对比走通；写操作重跑不重复执行 |
| 3D | IA 验收：旧路由（builder/preflight/runs/publish/library/agent）能力映射走查，产出 `docs/rebuild/ia-acceptance.md`；切换默认导航 | 3A | 验收文档列明每个旧路由处置；旧路由挂 deprecation |
| 3E | 草稿回归服务端（删 `editorDraftStorage.js`）；未保存修改有放弃入口 | 3A | 多 Loop 切换不丢草稿；可显式 discard |

**M3 出口标准**：一人画布拼 3 节点 Loop 跑通（含写操作确认），另一人 Fork 改参
重跑并对比；新 IA 为默认。

## M4 · 真实闭环验收 + 团队部署（预估 2 天）

| # | 任务 | 验收 |
|---|---|---|
| 4.1 | 闭环 A（晨报）端到端 | 确认后真实群里收到晨报；事件流完整 |
| 4.2 | 闭环 B（纪要→任务）端到端 | 确认后真实建出任务；重跑不重复建 |
| 4.3 | 部署文档 `docs/deployment.md`（docker compose、模型 key、lark-cli 安装与各成员授权、导入白名单、bootstrap token、反向代理建议） | 干净机器按文档复现 |
| 4.4 | ≥3 个真实账号走查 `01` 成功标准 5 条 | 全过 |

**M4 出口标准 = MVP 完成。**

## M5 · UX 重构（Agent 工作区 / 创建流程 / 模型开关，规格见 `07`）

> 来源：`PRODUCT_AND_FRONTEND_RESTRUCTURE_V1.md` 经交叉 review 整合为 `07`，
> 含冲突裁决 D1–D4（Agent 主入口边界、Script 沙箱、proposal 仅草稿、GitHub 导入）。
> 与 M4 的关系：M4 的外部阻塞（凭证/租户）多是环境项，M5 四个 Batch 为纯
> 产品/前端工作，可与 M4 并行推进；IA 合页验收（Batch D）是两者共同的收尾。

| # | 任务 | 依赖 | 验收 |
|---|---|---|---|
| 5A | Agent 工作区 IA 重构：composer 底部通栏、右侧降 drawer、文本/图像统一任务流、空状态可行动 + 轻量模型开关共享组件（chip+popover，同步替换 Loop 工作台步骤配置里的模型选择形态；**只改表现层，modelProfileId 契约不变**） | M1 | `07` 验收标准"Agent 工作区"+"模型开关"节 |
| 5B | Skill 创建分流（定义 vs 导入）+ 7 步定义向导（仅真实支持的 Prompt、Python Script；职责与 IO/执行方式/分类 tags/脚手架/冒烟/发布）；Tool Skill 仅允许导入带后端精确 Action ID 声明的已注册包；Script 钉死 Docker 沙箱（D2）；**GitHub 公共仓库导入实做**：受限 Contents API 读取→quarantine→inspector→草稿，不 clone、不执行仓库内容（D4） | M2 | `07` 验收标准"Skill 创建"节 + GitHub 导入负向测试（私有/不可读仓库、超大文件、timeout） |
| 5C | 工作流创建分流（文档生成默认 vs 定义导入高级）+ 三态可见（设计中/可运行/已发布共享；结果属于独立 Run）；文档路径复用现有 proposal 系统且**只产待确认草稿**（D3） | M3 | `07` 验收标准"工作流创建"节 |
| 5D | 中文优先默认 + 全产品"默认 vs 高级"折叠扫荡 + IA 合页验收（`06` 剩余项：旧路由处置、演示数据清零、新前端 tree 基线）+ 同步修订 PRODUCT.md 非目标措辞（D1） | 5A–5C | `07` Batch D 全项；PRODUCT.md diff 明确 |

**M5 出口标准**：`07` 四组验收标准全过；前端新基线形成，发布门禁可重跑。

## V1.1 候选项（明确排后）

- Tool Adapter 迁移进 Docker 沙箱执行、Skill 在线编辑器、搜索/筛选、移动端 390px、
  review gate 完整 UI、Memory/Remote 解冻评估、暗色主题、GitHub 私有仓库
  per-user token（`07` D4）、图像生成高级参数完整面板。

## 风险与注意

1. **lark-cli 授权**是闭环外部依赖：每个成员需完成自己的 OAuth。验收环境无飞书
   租户时，闭环可降级为"前 3 节点真实 + 写操作节点 dry-run"，但必须在验收记录注明。
2. **归档 legacy 时**：`workbench-server/src/server.mjs:6-27` 相对路径 import
   `agent-runtime` 的 core/kernels/lib——只动入口文件，库保持原位。
3. **契约先行**：所有端点增删先改 `workbench-contracts`，路由由契约生成。
4. **不要动 `runtime/**`**（AGENTS.md 明确规则）；需要运行时状态的测试用隔离临时目录。
5. **文档同步**：每里程碑结束更新 `PRODUCT.md`/`README.md` 现状段；本套文档的决策
   被后续审查推翻时直接修订并标注版本。
