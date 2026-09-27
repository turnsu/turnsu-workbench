# 01 · 产品定义（Skill OS / Loop OS 团队版）v2

## 定位

**looloomi 是一个 8–15 人团队的 Skill OS / Loop OS：团队成员把自己的 Skill 上传到
团队共享库，在画布上拖成 Loop（工作流），一键真实运行，结果全员可见、可复用、可迭代。**

它不是：通用 Agent 聊天产品、监控驾驶舱、垂直业务产品、开放平台/市场。

## 用户模型（简但安全）

- **单一团队 workspace 作为产品形态**：UI 上只呈现一个工作区；**后端保留 workspace
  隔离字段与查询过滤**（已实现的隔离能力不拆除，只是产品层不暴露多 workspace 切换）。
- **注册**：用户名 + 密码。部署方可用 `WORKBENCH_REGISTRATION_OPEN=false` 关闭开放注册。
- **admin 初始化**：**不用"首个注册者自动成为 admin"**（开放注册下存在初始化抢占与
  并发竞态）。改为：部署时通过一次性 bootstrap token（环境变量
  `WORKBENCH_BOOTSTRAP_ADMIN_TOKEN` + 注册页一次性输入，或 `workbench-local` CLI
  显式初始化）创建第一个 admin；之后的 admin 变更由现有 admin 在成员页操作。
- **两个角色**：`admin`（退役 Skill、删除 Loop、禁用成员、服务器路径导入）和
  `member`（上传/创建/运行/发布/重跑）。后端四角色模型保留不拆，产品层只用这两个。

## 范围（In / Out / 冻结）

### In（MVP，验收必须全部走通）

| # | 能力 | 说明 |
|---|---|---|
| 1 | 注册 / 登录 / 登出 | 用户名+密码，session cookie，bcrypt；bootstrap token 初始化 admin |
| 2 | Skill 上传 | 浏览器上传目录（webkitdirectory）或 zip；SKILL.md 格式 |
| 3 | Skill 库 | 列表 / 详情 / 版本 / 退役（admin） |
| 4 | Loop 画布编排 | 拖 Skill 上画布、连线、配输入、保存版本 |
| 5 | Loop 运行 | 服务端编译 → 真实执行（含模型选择）→ SSE 实时事件 → 结果页 |
| 6 | Run 历史与重跑 | 固定版本重跑，结果全员可见；写副作用有 effect receipt |
| 7 | Loop 发布与 Fork | 发布为团队可用版本；他人可 Fork 出新版本 |
| 8 | 成员列表 | admin 可见成员、可禁用 |
| 9 | 两个真实闭环 | 见 `04`，用 lark-* Skill 组成，端到端验收 |

### 冻结（不做 MVP 主入口，UI 隐藏或降级，底层契约/迁移/实现全部保留）

- 产品记忆系统（memory）、Remote worker transport、handoffs
- 多 workspace 切换、发布审批、细粒度 RBAC
- `/agent` 聊天页与 NL Builder proposal：**已裁决保留并重构**（`07` D1/D3）——
  Agent 工作区升级为产品首页（用户确认通用 Agent 聊天可作首页），proposal 只产
  待确认草稿；二者不再是"冻结待定"项
- Stability 图像生成：**已解冻**，并入 Agent 工作区统一任务流（`07` Batch A）
- Docker 沙箱：**保留且继续用于上传 Skill 执行**；lark Tool Adapter 的宿主执行另有
  安全约束（见 `02`/`04`）

### Out（确认删除，仅限无消费者的前端死代码与 legacy 入口）

- 前端死导出（`useWorkbenchWorkspace.js` 尾部无消费的 knowledge/chatScope/selectedLoopIds 等）、
  死 i18n key、隐藏测试按钮、演示数据硬编码与静默过滤
- legacy 入口归档：`bin/wechat-agent-daemon.mjs`、`scripts/*loopops*`、`wechat-cli/`、
  `Package.swift`、`domains/frontend/app/` → `archive/`（库文件 `agent-runtime/core|kernels|lib`
  保持原位，workbench-server 依赖它们）
- 注意：`wechat-cli/` 是 **Python** 代码（旧产品线 CLI），归档而非删除；Agent 执行底座
  是 Node pi SDK，本次不新增 Python 运行时，但"仓库无 Python"的说法本身是错的。

## 信息架构（目标态，需经 IA 验收后切换）

```
/login            登录
/register         注册（含一次性 bootstrap token 输入位，仅初始化期显示）
/agent            Agent 工作区（任务发起入口 / landing page，见 07 D1）
/loops            Loop 库（列表 + 新建入口）
/loops/:id        Loop 工作台（画布 + 步骤配置 + 模型开关 + Run 面板，单页）
/skills           Skill 库（列表 + 创建/导入入口 + 发布状态）
/skills/:id       Skill 详情（说明 / 版本 / 用它建的 Loop）
/members          成员列表（admin）
```

- 主导航为 **Agent / Loops / Skills / Team library**；`Members` 是账户菜单中的管理页，
  不是与资产和任务竞争的一级导航。Agent 工作区是产品首页（landing page）与任务发起
  入口——用户已确认通用 Agent 聊天可作首页（`07` D1）；对象管理（建/编/发 Skill 和
  Loop）仍在 Skills/Loops 完成。`PRODUCT.md` 已同步该裁决。
- **模型选择以轻量开关形态保留**（chip + popover，见 `07` Batch A）——多模型、
  多协议是已确认需求，变的是表现层不是能力。
- Run 不作为一级页面，是 Loop 工作台下的一条记录。
- Skill/Loop 创建入口各自二选一分流（定义 vs 导入 / 文档生成 vs 定义导入），
  规格见 `07` Batch B/C。

## 成功标准（产品完成的定义）

一个 8–15 人团队，从空部署开始：

1. 部署者用 bootstrap token 初始化 admin；成员各自注册登录；
2. 任意成员从浏览器上传 ≥5 个真实 Skill（如 lark-calendar / lark-task / lark-im）；
3. 任意成员在画布上拼出 `04` 定义的闭环 A 或 B 并成功运行；
4. 另一成员看到该 Loop、Fork、改一个参数、重跑，并能对比两次 Run 的输出与事件。
   注意：**重跑保证的是"同一 Loop 版本 + 同一 Skill 版本 + 同一输入"的确定性重放，
   不保证外部世界结果相同**——LLM 输出、日历/任务外部状态会变化；含写副作用的
   节点（如建任务）重跑必须经 effect receipt 幂等或显式确认，防止重复创建；
5. 全程无任何"点了没反应"的按钮，无任何 mock 数据。

这条链路走通 = MVP 完成。
