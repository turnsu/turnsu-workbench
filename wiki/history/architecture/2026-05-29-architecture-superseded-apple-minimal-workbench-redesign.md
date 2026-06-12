# Apple Minimal Workbench Redesign

Date: 2026-05-29

## Objective

将上一轮 Research OS 风格的高信息密度界面，收敛为 macOS 清透深色、极简操作优先的“今日情报工作台”。本轮目标是减少运维看板感，让用户打开应用后只看到今日重点、精选情报和 Agent 输入入口。

## Product Decisions

- 默认首屏是“今日情报”，不是 Agent 聊天页，也不是运行监控页。
- 首屏信息量固定为 5 条精选情报，来自现有 `filteredCrystals`，按风险、可信度和 freshness 排序。
- Agent Composer 常驻今日页底部，用于继续处理情报或直接输入任务。
- 左侧导航压缩为 4 个入口：今日、Agent、资料库、设置。
- Inbox、Token、Watchlist 合并为资料库，用 segmented control 切换。
- Ops、artifact、policy、module run、provider route 默认隐藏，只在设置页或详情抽屉中出现。

## Design System Changes

- 移除强发光、细网格背景、大面积青紫渐变和密集状态 chip。
- 使用深色系统背景、`.ultraThinMaterial`、柔和边框、轻阴影和 12-18px 圆角。
- 主色改为 macOS 蓝，绿色仅用于可用状态，金色用于 degraded/needs confirmation，红色用于 blocked/failed。
- 新增 Apple 风基础组件：`WorkspaceSurface`、`StatusDot`、轻量 primary/secondary button style、常驻 `FloatingAgentComposer`。
- 保留 `radarPanel()` / `researchPanel()` 兼容 wrapper，避免一次性破坏旧视图。

## Implementation Notes

- Shell：`DashboardView` 不再常驻右侧 Inspector 和底部 Execution Strip；只有用户显式选择情报、Token、消息等对象后才显示 Inspector。
- Sidebar：`TerminalWorkspaceSidebar` 改成 4 个核心入口，隐藏 group/source 列表与技术分组。
- Today：`HomeWorkspaceView` 改成今日摘要、5 条精选情报、主 CTA 与底部 Agent Composer。
- Agent：`AgentWorkspaceV2View` 保留对话流和 Composer；左侧只保留会话、Skill、Extension；Inspector 按需显示；运行状态压缩为 Composer 上方的一行。
- Library：新增 `LibraryWorkspaceView` 聚合微信线索、Token、观察列表。

## Acceptance

- 打开应用时主界面应像“今日情报工作台”，不是运维看板。
- 主界面不出现 logs、artifact 列表、policy matrix、module run deck、provider route。
- Agent 主界面只展示 Skill/Extension 和用户层任务过程。
- 运维信息仍可从设置或详情进入，不丢失排障能力。
- 后端、Agent Runtime Host、extension package、runtime artifacts 和安全边界不变。

