# 02 · 架构与裁剪清单 v2

## 技术栈现实（修订版）

- **Agent 执行底座是 Node.js 的 pi SDK**：`@earendil-works/pi-coding-agent@0.80.7`
  （`domains/agent/code/agent-runtime/kernels/pi/pi-kernel-adapter.mjs:3-8`），配套
  `@agwab/pi-subagent`、`@agwab/pi-workflow`。能力足够：真实模型调用、`tool_calls`、
  session、extension 工具注册。若后续不够，优先查 pi extension 生态。
- **但"项目没有任何 Python"是错误说法**：`wechat-cli/` 是完整的 Python CLI（旧产品线），
  处置方式是归档到 `archive/`，不是假装它不存在。
- 本次不新增语言栈；lark-cli（Node CLI）的接入走受控 Tool Adapter（见下）。

## 总体架构（重构后）

```
浏览器（React SPA）
  │  同源 HTTP + SSE，/api/workbench/v1
  ▼
workbench-server（单进程 Node）
  ├─ auth 模块（新增：注册/登录/session/bcrypt/bootstrap token）
  ├─ contracts 驱动路由（保留）
  ├─ Skill 服务 + 上传/导入通道（保留 + 扩展浏览器目录上传）
  ├─ Workflow Compiler（保留）
  ├─ Workflow Runner（保留：持久化/lease/checkpoint/SSE/取消/重跑/effect receipt）
  ├─ ModelService + 多协议 executor（保留：openai-compatible/anthropic/gemini/stability
  │   + revisioned ModelCatalog——多模型多协议是已确认需求，不简化）
  ├─ In-process Agent Adapter → PI Kernel（保留）
  │     ├─ 上传 Skill：Docker 沙箱执行（保留，不降级）
  │     └─ lark Tool Adapter（新增：受控 CLI 执行，见下）
  └─ Memory / Remote / Stability / handoffs（冻结：实现与契约保留，UI 不暴露）
MongoDB（docker compose replica set）
```

## 保留清单（明确不动）

| 模块 | 说明 |
|---|---|
| 契约包 `workbench-contracts/` | 单一事实源 |
| HTTP handler 骨架 | CSRF/Origin/ETag/幂等 |
| 编译器 / Runner / Mongo store / SSE | 项目最值钱的资产 |
| **模型路由全套**（ModelService、ModelCatalog、四个协议 executor、ModelPicker 对应端点） | 已确认需求；OpenAI/Anthropic/Gemini/Stability 协议格式不同，不可合并为单一 executor |
| **Agent Slice 0–4 成果**（agent sessions、builder proposal、in-process adapter 等） | 用户已确认完成，禁止删除 |
| **Docker 沙箱**（`docker-skill-executor.mjs`）与 release gate 机制 | 安全边界；新执行路径只能加强不能削弱 |
| workspace 隔离字段、四角色模型、effect receipt / `side_effect_outcome_unknown` 语义 | 产品层隐藏 ≠ 拆除 |

## 冻结清单（UI 隐藏/降级，底层保留）

| 对象 | 处置 |
|---|---|
| Memory 5 端点、handoffs 2 端点、Remote transport、Stability | 保留实现与契约；前端不渲染入口；文档标注 V1.1+ 候选 |
| `/agent` 页、NL proposal、Resources、ModelPicker | **保留**；`/agent` 与 proposal 是否收敛出入口由 IA 验收决定；Resources 修复"能建不可见"的半死状态（要么打开查询并标注实验性，要么隐藏创建入口——二选一，执行时定） |
| 多 workspace 切换 | UI 不暴露，数据模型保留 |

## 删除 / 归档清单（仅限这些）

| 对象 | 处置 | 理由 |
|---|---|---|
| 前端死导出、死 i18n key、隐藏测试按钮、游离 aria-hidden 标签 | 删除 | 无消费者 |
| 演示数据硬编码（`LoopsBoardView.jsx:182-186,24-27`、`SkillsView.jsx:61-64`） | 删除 | 真实数据必须所见即所得 |
| `editorDraftStorage.js` 单槽 localStorage 草稿 | 删除（草稿回归服务端模型） | 多 Loop 切换静默丢草稿 |
| legacy 入口：`bin/wechat-agent-daemon.mjs`、`scripts/*loopops*`、`wechat-cli/`、`Package.swift`、`domains/frontend/app/` | 移入 `archive/` | 历史遗留；`agent-runtime/core|kernels|lib` 库文件**保持原位**（server 依赖） |
| `/objects/{objectId}` 契约 | 修复（注册路由）或从契约移除——二选一，倾向补注册 | 当前是"契约定义但未路由"的双重死状态 |

## 新增清单（仅这些允许加）

| 模块 | 内容 | 规模预估 |
|---|---|---|
| `auth/` | 注册/登录/登出、session cookie（httpOnly+SameSite=Lax）、bcrypt（新增唯一依赖 `bcryptjs`）、`requireAuth` 替换 `bootstrapSession` 自动签发（`workbench-http-handler.mjs:575-605`） | ~400 行 |
| admin 初始化 | 一次性 bootstrap token（`WORKBENCH_BOOTSTRAP_ADMIN_TOKEN`，用后失效）或 `workbench-local` CLI 显式创建首个 admin；**不做**"首个注册者自动 admin" | ~80 行 |
| Skill 浏览器上传 | `webkitdirectory` 目录上传 + zip 上传（复用现有 quarantine→inspector→草稿链路） | ~200 行增量 |
| 服务器路径导入 | **仅 admin 且仅服务器本机**：白名单根目录（`WORKBENCH_SKILL_IMPORT_ROOTS`）扫描导入；普通成员无此入口 | ~150 行 |
| lark Tool Adapter | 受控 CLI 执行层（见下） | ~400 行 |

## lark Tool Adapter（安全核心，替代"模型直跑 CLI"）

lark-* Skill 不是纯 prompt：它们要读 `references/`、有确认流程、要调 `lark-cli`。
**不允许把模型生成的命令直接在宿主裸跑**——这比上传脚本更需要隔离、权限和审计。
Adapter 设计：

1. **精确 Action allowlist**：每个 Skill 在 frontmatter 声明后端注册的精确 Tool
   Action ID（如 `lark.calendar.agenda`）。二进制、子命令与参数 flag 由后端固定
   映射；`binary + args`、通配符或 Skill 自定义命令都不能成为授权边界。
2. **参数 Schema**：参数按声明类型校验，禁止 shell 拼接——用 `execFile` 数组参数，
   不经 shell。
3. **用户级凭证**：lark-cli 的 OAuth 凭证按执行用户隔离（每成员自己授权一次，
   凭证存服务端加密存储或各用户 agent 配置目录），团队成员不共享发布者凭证——
   沿用 PRODUCT.md 原则 6。
4. **危险操作确认**：含外部写 Action 的 Skill 节点必须直接依赖 Review Gate；
   缺少 Gate 时编译直接 blocked。只有持久化 decision 完成后，后端才向 Adapter
   传递确认状态。
5. **effect receipt**：每个外部副作用记录 receipt；重跑时已成功的写操作默认跳过
   或显式确认重放，对接现有 `side_effect_outcome_unknown` 语义。
6. **执行位置**：MVP 可在宿主子进程执行（`execFile`、超时 120s、输出截断 100KB、
   无 shell），但必须过上述 1–5；迁移到 Docker 沙箱执行是 V1.1 加固项。

## 数据模型变更

- 新增 `users`：`_id, username, passwordHash, role(admin|member), disabled, createdAt`
- 新增 `authSessions`：`token, userId, expiresAt`
- `workspaces`/`memberships`/四角色：**保留**；产品层固定单 workspace 展示
- 删除：无。Memory/Remote 相关集合保留（冻结≠清库）

## 认证与安全决策（8–15 人团队尺度）

- 密码：bcrypt（`bcryptjs`，纯 JS 无原生编译），最少 8 位。
- Session：httpOnly + SameSite=Lax cookie，7 天过期，滑动续期；CSRF 沿用现有机制。
- 模型 API key：环境变量（`DEEPSEEK_API_KEY` 等）+ 沿用现有 Keychain 支持（macOS
  开发机）；团队服务器上用 env 或 docker secrets。不削弱现有凭证隔离。
- 机密不进库、不进日志、不进事件流（沿用现有约束）。

## 启动链修复（P0，第一批就做）

1. `.env.example` 补齐：`WORKBENCH_MONGO_DATA_DIR/CONFIG_DIR/SECRETS_DIR` +
   全部隐性变量（`WORKBENCH_MODEL_*` 系列、`WORKBENCH_REGISTRATION_OPEN`、
   `WORKBENCH_BOOTSTRAP_ADMIN_TOKEN`、`WORKBENCH_SKILL_IMPORT_ROOTS` 等）。
2. `start-workbench-server.sh:27-33` 的 `mongosh rs.status()` 探测改为带认证
   （与 `mongo-healthcheck.sh:4-11` 一致）；默认 `WORKBENCH_MONGODB_URI` 带凭据或显式报错提示。
3. 目标：`cp .env.example .env`（填几个值）→ `./scripts/start-workbench-server.sh`
   一条命令起全栈。README 同步改写。
