# Agent Workbench Layout And Ability Palette

Updated: 2026-05-29

## 背景

用户反馈当前 Agent 页仍像“运维看板 + 工作台”：左侧 Skill / Extension 区域占位过大，底部存在大片空白，主界面暴露了过多底层概念。下一步应朝 ChatGPT / Cursor / Codex 的任务工作台模式收敛：主区域聚焦对话与输入，能力以按需添加的方式进入任务，而不是常驻占据页面。

## 本轮产品判断

- Agent 页应以中央任务对话和底部 Composer 为主，不再被外层 ScrollView 截断高度。
- 左侧主导航与 Agent 内部能力栏都应可折叠，避免小窗口下挤压任务区域。
- Skill / Extension 在用户层统一表达为“能力包”。底层 tool、provider、module 仍只进入 artifact 或详情层。
- 最优交互是类似 Codex 的 `/add` 能力选择入口；本轮先实现输入 `/add` 或点击 `Add` 打开能力包弹层，并支持多选。
- 能力选择后清理输入框中的 add 触发词，避免把 UI 命令作为任务内容提交给 Agent。

## 实现范围

- `DashboardView`：Agent workspace 不再包在父级 ScrollView 中，允许页面自然占满剩余高度。
- `TerminalWorkspaceSidebar`：主侧边栏新增持久化折叠状态，折叠后仅显示核心导航图标。
- `AgentWorkspaceV2Views`：
  - Agent 内部左栏新增持久化折叠状态。
  - Skill 与 Extension 合并为 `AgentAbilityPackage`，用户界面统一展示为能力包。
  - Composer 新增 `SelectedAbilityChipBar` 和 `AbilityPaletteView`。
  - 输入 `/add`、`add`、尾部 ` /add` 或 ` add` 自动打开能力包弹层。
  - 选择能力包后移除触发词，保留用户自然语言 prompt。

## 验收记录

- `swift build --scratch-path /private/tmp/wechat-radar-build`：通过。
- `swift test --scratch-path /private/tmp/wechat-radar-test-build`：通过。
- `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check`：通过，`ui_smoke=pass`，窗口标题 `WeChat Intelligence Radar`。

## 后续建议

- 将能力包弹层进一步升级为真正的 inline command menu：在光标处输入 `/add` 后展示可键盘导航的候选菜单，并支持回车添加。
- 增加可拖拽宽度的 SplitView，而不仅是折叠/展开。
- 在能力包中加入来源分组、最近使用和推荐能力排序，但默认仍保持极简。

## 2026-05-29 续迭代

用户进一步反馈：Agent 左侧栏不应该重复展示能力包，应像 ChatGPT / Codex / Claude / Cursor 一样承担历史 session 列表；能力包只应该从 Composer 的 Add / `/add` 入口进入。同时能力包需要与后端 Agent Runtime Host 的实际公开能力对齐，至少包含 WeChatCLI 和 CoinMarketCap MCP 两类 extension/skill。

本次补充实现：

- Swift 本地 `AgentToolRegistryStore` 增加 default public surface fallback。即使 app bundle 启动时无法定位项目根目录，也能展示后端定义的公开能力。
- `DashboardViewModel.refreshAgentWorkspace()` 会在 daemon 可用时额外读取 `/capabilities`，优先使用 Agent Runtime Host 的最新 public surface。
- `agent-runtime/runtime/public-surface.json` 和 extension package manifest 将用户层名称调整为 `WeChatCLI 能力包`、`CoinMarketCap MCP 能力包`、`CoinMarketCap 市场雷达`。
- Agent 左侧栏移除能力包区域，只保留 session 列表。
- session row 增加重命名入口，写回 `runtime/agent/sessions/{sessionID}.json` 的 `title` 和 `updatedAt`。

续迭代验收：

- public surface 检查：skills = 7，extensions = 3；extensions 包含 `WeChatCLI 能力包` 和 `CoinMarketCap MCP 能力包`。
- `node agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check`：通过，生成 `sessionID`、`runID`、`taskID` 和 run events。
- `swift build --scratch-path /private/tmp/wechat-radar-build`：通过。
- `swift test --scratch-path /private/tmp/wechat-radar-test-build`：通过。
- `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check`：通过。
