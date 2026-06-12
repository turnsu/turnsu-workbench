# Research OS Frontend Redesign

Date: 2026-05-28

## Objective

把当前“微信 x 链上 Agent 情报工作台”从运行监控感较强的终端界面，升级为更接近 Research OS / 产业链投研操作台的 SwiftUI-native 前端：深色玻璃、青绿高亮、紫蓝空间感、细网格背景、紧凑专业信息密度，以及以 Agent 任务和可验证情报为中心的操作空间。

本轮只改前端视觉系统和版面组织，不改 Agent Runtime Host、extension package、数据模型、runtime artifact schema 或安全边界。

## Design Principles

- 信息密度优先：桌面端保留多列布局、右侧 Inspector 和底部 Execution Strip，适合持续研究与快速扫读。
- 用户层表达优先：前端只暴露 Skill / Extension、情报卡、行动建议、证据、交接包、运行状态；底层 provider / tool / module 只进入 artifact 或调试层。
- 低打扰运行：Agent 工作台以 thread-first、composer-first 为核心，不把日志流当成主界面。
- 可追踪但不前置技术细节：runID、artifact path、policy detail 保留在 Inspector / Ops / Execution Strip 中，不作为主标题。
- 安全边界常驻：真实微信 live、live wechat-cli、交易、发消息、外部发布继续保持 blocked 或 needs confirmation。

## Visual System

新增或扩展的全局视觉 tokens 与组件位于 `Sources/WeChatIntelligenceRadarApp/Views/VisualTheme.swift`：

- 背景：深蓝黑全窗口渐变 + 细网格，避免分散装饰元素。
- 主色：青绿色用于可用、执行、核心 CTA。
- 次高亮：紫蓝用于空间层次、AI/Agent 状态、模型状态。
- 警示：金色用于 stale/degraded/needs confirmation，红色用于 blocked/failed/high risk。
- Surface：glass panel、glow border、command capsule、status chip、score bar、sparkline、primary/secondary button style。
- 字体：标题使用 rounded bold/heavy；正文保持 10-13pt；时间、runID、score、ticker 使用 monospaced。

## Information Architecture

- Sidebar：品牌区、Active Theme、Overview / Research / Agent / Memory-Ops 分组、Sources、安全边界提示。
- Top Command Bar：长搜索胶囊、时间窗口、Agent Host、Guard、本地时间、刷新。
- Home：Operating Desk hero、watchlist mini board、4 个 Research metric card、Top 3 情报雷达、Web3 Radar、Briefing Note。
- Agent Workspace：左侧任务/上下文/Skill/Extension，中央 chat stream + composer，右侧 Evidence/Policy/Artifact/Handoff Inspector，底部 compact execution strip。
- Inbox：Research Feed，按群、时间、Token/CA 线索扫读。
- Token：Token Map + Token Deep Dive + 微信证据链。
- Watchlist：观察与预警工作台，突出风险状态和下一步动作。
- Ops：独立运行状态页，读取 runtime/Ops 侧状态，不混入 Agent 任务规划。

## Implementation Notes

- 保持 `DashboardViewModel`、runtime stores、Agent Runtime Host、extension package 和 Ops Runtime 数据接口不变。
- `radarPanel()` 被升级为 Research OS glass panel，旧面板自动获得新质感；新增 `researchPanel(glow:)` 用于重点区域。
- Home 新增 `ResearchHeroDesk`、`ResearchWatchlistPanel`、`ResearchMetricDeck`、`ResearchTopRadarPanel`。
- Agent 工作台保留 `AgentWorkspaceV2View` 的 thread-first 结构，只重做视觉层级、Composer 控件、Run Bar 和 Inspector。
- `PanelHeader` 改为全局 section eyebrow 风格，使所有工作区标题统一。

## Acceptance Criteria

- 首屏 5 秒内能识别为 Research OS 风格的“微信 x 链上 Agent 情报工作台”。
- Home、Agent、Inbox、Token、Watchlist、Ops 共享同一 glass / grid / glow / compact 信息体系。
- Agent 主界面只让用户选择 Skill / Extension，不显示 raw tools/provider/module 列表。
- 文本不溢出，按钮和标签在常见桌面宽度下不重叠。
- `swift build`、`swift test`、`--ui-smoke-check` 通过。
- 不运行真实微信、live wechat-cli、交易、发消息、外部发布。
- 不写入 API key、Authorization、cookie 或真实私聊原文。

