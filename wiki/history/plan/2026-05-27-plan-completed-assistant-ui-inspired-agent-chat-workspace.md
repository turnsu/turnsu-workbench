# Agent ChatUI 工作台前端重构方案

Date: 2026-05-27

## 背景

当前桌面端 `Agent 操作台` 已经具备 daemon、session、tool、artifact、policy、run deck 等工程能力，但前端体验仍然偏“运行监控面板”。用户进入页面后看到的是模块状态、日志、技术状态和系统对象，而不是一个可以自然交代任务、上传材料、选择能力、观察 Agent 工作、确认结果的日常工作空间。

本方案参考：

- [AI Elements](https://elements.ai-sdk.dev/)：可组合 AI UI primitives，覆盖 Conversation、Message、Prompt Input、Attachments、Reasoning、Sources、Task、Queue、Confirmation、Tool 等组件。
- [assistant-ui](https://www.assistant-ui.com/docs)：enterprise-grade AI chat interface，覆盖 Thread、Composer、Attachment、Tool runtime、streaming state、工具调用可视化和 human-in-the-loop。

这些库都是 React 生态，本项目当前是 SwiftUI 桌面软件。因此本方案不建议马上整体切换技术栈，而是把它们的交互模型、组件分层和状态语义迁移为 SwiftUI-native 组件。后续若 chat UI 迭代速度成为瓶颈，再评估在局部 Agent 工作台中嵌入 React/WKWebView。

## 核心判断

当前问题不是“缺少更多功能”，而是 Agent 工作台没有形成自然的人机协作动线。

需要把页面从：

```text
pipeline / log / runtime / artifact first
```

改为：

```text
thread / composer / tool call / evidence / handoff first
```

用户打开 Agent 工作台后，第一件事应该是输入任务或选择任务模板；Agent 的中间动作应该作为对话流里的可解释卡片出现；技术运行状态应该存在，但默认退到辅助层。

## 产品目标

Agent 操作台 v2 应成为一个长期可用的 Agent 工作空间：

- 用户可以像使用 ChatGPT / Codex 一样交代任务。
- 用户可以附加图片、上下文、情报卡、Token、微信群组、历史 handoff。
- Agent 可以流式输出判断、计划、工具调用、阶段结果和最终产物。
- 工具调用在对话流中可见、可折叠、可确认、可追踪。
- 长期任务不是日志堆，而是可恢复的 thread + task。
- 安全边界不是 policy 表，而是用户能读懂的确认卡和阻断说明。
- 运行日志、runID、artifact path 进入详情层，不抢主任务空间。

## 目标用户场景

### 场景 1：每日情报分析

用户输入：

```text
帮我看今天微信群里和 BTC、ETH、SOL 相关的重点讨论，结合行情和链上数据，列出我需要处理的 3 件事。
```

理想交互：

1. Agent 显示“正在读取本地 normalized 微信消息”。
2. Agent 显示“正在识别 Token 与项目实体”。
3. Agent 显示“行情数据过期，需要标记风险”。
4. Agent 输出 3 张情报卡，每张有依据、风险、建议动作。
5. 用户可直接点“加入观察”“创建任务”“生成交接包”。

### 场景 2：图片 + Prompt 合成任务

用户上传截图并输入：

```text
这张图里的项目值得加到观察列表吗？结合微信讨论和行情状态判断。
```

理想交互：

1. Composer 显示图片附件缩略图、大小、hash 状态。
2. Agent 调用图片理解能力，生成图片分析 artifact。
3. Agent 再把图片分析结果和本地情报上下文合并。
4. 对话流中显示图片分析卡、Token 识别卡、最终建议卡。
5. 如需要外发图片到 Kimi，必须有清晰的附件 hash 和 policy 留痕。

### 场景 3：长期监控任务

用户输入：

```text
接下来 24 小时帮我盯 SOL 相关讨论和异常链上信号，有变化时生成复盘。
```

理想交互：

1. Agent 生成长期任务计划。
2. 用户确认监控范围、数据源、频率和边界。
3. 左侧任务列表出现该任务。
4. 关闭 app 后任务仍由 daemon 保存状态。
5. 再打开时可以恢复 thread、查看最新阶段输出和 artifact。

## 信息架构

Agent 工作台采用四区结构，但层级要重新排序。

```text
┌─────────────────────────────────────────────────────────────┐
│ Top Bar: 当前任务 / 数据状态 / 模型状态 / 后台服务状态        │
├──────────────┬──────────────────────────────┬───────────────┤
│ Left Rail    │ Thread Workspace              │ Inspector     │
│              │                              │               │
│ Tasks        │ Messages                      │ Evidence      │
│ Context      │ Tool Call Cards               │ Attachment    │
│ Skills       │ Confirmations                 │ Tool Detail   │
│ Memory       │ Final Outputs                 │ Policy        │
│ Handoffs     │ Composer                      │ Artifact      │
├──────────────┴──────────────────────────────┴───────────────┤
│ Bottom Status: compact run state / active tool / pause/resume │
└─────────────────────────────────────────────────────────────┘
```

### 左侧：任务与能力

左侧不是 raw plugin list，而是用户语言的工作对象：

- 当前对话
- 长期任务
- 已选上下文
- 常用能力
- 记忆
- 交接包

能力显示为用户可理解的开关或 chips：

- 微信情报
- Token 识别
- 行情快照
- 链上检查
- 图片理解
- 生成交接包
- 申请电脑操作

### 中央：Thread Workspace

中央是主舞台，占最大面积。

它必须包含：

- 用户消息
- Agent 流式回复
- Agent 计划摘要
- 工具调用卡
- 依据卡
- 等待确认卡
- 最终输出
- Composer

不应该默认出现大块日志、module pipeline 或 raw artifact 路径。

### 右侧：Inspector

Inspector 只在用户选中对象时展开。默认态应轻，不应空白得像坏掉。

默认态文案：

```text
选择一条消息、能力调用、附件或结果后，这里会显示依据、权限边界和记录文件。
```

选中对象后按类型展示：

- 消息：来源、时间、引用上下文。
- 附件：缩略图、hash、尺寸、是否外发、分析 artifact。
- 工具调用：参数摘要、状态、结果、失败原因。
- 情报卡：证据、可信度、风险、建议动作。
- policy：允许/需确认/阻断的原因。
- artifact：本地路径、写入时间、关联 run。

### 底部：Run Status Bar

底部不再是常驻大 Run Deck，而是 compact status bar：

- 后台服务：已连接 / 未连接
- 当前 run：运行中 / 已完成 / 失败 / 需确认
- 当前能力：读取微信情报 / 图片理解 / 生成交接包
- 操作：暂停、继续、取消、展开详情

详细日志进入“运行详情”抽屉。

## ChatUI 组件映射

| 参考组件 | SwiftUI 目标组件 | 本项目含义 |
|---|---|---|
| Conversation / Thread | `AgentThreadView` | 当前任务对话主视图 |
| Message | `AgentMessageView` | 用户/Agent 消息 |
| Prompt Input / Composer | `AgentComposerBar` | 输入 prompt、附件、上下文和能力 |
| Attachments | `AttachmentStrip` | 图片/文件附件预览、删除、hash 状态 |
| Tool | `CapabilityCallCard` | 工具调用状态、参数、结果、确认 |
| Confirmation | `ActionApprovalCard` | 敏感操作确认/拒绝 |
| Reasoning | `AgentPlanSummaryBlock` | 计划摘要，不展示 raw chain-of-thought |
| Sources / Citation | `EvidenceSourceChips` | 微信消息、行情、链上证据 |
| Task / Queue | `LongTaskRail` | 长期任务队列与恢复 |
| Model Selector | `ModelRoutePill` | DeepSeek/Kimi 可用性和路由 |
| Artifact | `ArtifactPreviewCard` | 本地记录、handoff、分析文件 |

## 交互动线

### 1. 新建任务

用户点击“新任务”后，页面中心进入空 thread。

空状态只保留 4 个任务模板：

- 分析今日重点
- 检查某个 Token
- 从图片生成分析
- 创建长期监控

点击模板后填入 Composer，而不是直接执行。

### 2. 组合上下文

Composer 支持四类上下文 chips：

- 图片/文件附件
- 情报卡
- Token / CA / 项目
- 微信群组 / 时间窗口

上下文 chips 可删除、可点击查看、可在 Inspector 中解释来源。

### 3. 提交任务

提交后生成 `AgentTask`，并在 thread 中出现用户消息。

Agent 第一条回复不应是日志，而是：

```text
我会先读取本地微信情报，再识别 Token，最后结合行情/链上状态给出建议。
```

随后工具调用以卡片形式插入 thread。

### 4. 工具调用

每个工具调用卡有 4 种用户可理解状态：

- 准备中
- 运行中
- 需要确认
- 已完成 / 失败 / 已阻断

卡片默认展示摘要：

```text
读取本地微信情报
已读取 165 条消息，筛选出 12 条相关内容。
```

展开后才展示参数、artifact、policy decision 和 raw status。

### 5. 确认与阻断

敏感动作进入确认卡，而不是隐藏在 policy 表。

确认卡必须说明：

- Agent 想做什么
- 会读取/写入什么
- 会不会外发数据
- 为什么需要确认
- 拒绝后会怎样

真实微信读取、live wechat-cli、交易、发消息、外部发布继续保持 blocked。

### 6. 结果沉淀

一次任务的结果可以落为：

- 情报卡
- 观察对象
- 本地任务
- 记忆
- 交接包
- 运行记录

这些结果应在 Agent 回复末尾以结果区展示，而不是散落在不同面板中。

## 视觉设计原则

### 从终端感转向 macOS 工作台

保留专业感，但降低“黑客控制台”密度。

要求：

- Chat 区使用更大留白和明确消息宽度。
- 技术 ID、路径、runID 使用 monospace，但不作为主视觉。
- 工具调用卡采用轻量边框和状态点，不用重色块堆叠。
- 按钮使用明确动词：开始分析、加入观察、生成交接包、确认执行。
- 错误状态使用人话：`缺少 KIMI_API_KEY，图片理解暂不可用`。
- 不把 `daemon/provider/policy/artifact` 作为普通用户默认标题。

### 色彩与状态

状态颜色只服务决策：

- 绿色：已完成 / 可用 / 已连接
- 黄色：需确认 / 数据过期 / 降级
- 红色：失败 / 阻断
- 灰色：未开始 / 已取消 / 无数据

不要用过多同色系深绿卡片，让页面失去信息层级。

### 密度

每屏只突出一个主动作：

- 空 thread：开始任务
- 运行中：查看进度 / 暂停
- 需确认：确认或拒绝
- 完成后：保存结果 / 生成交接包

## 状态模型

建议前端统一状态，不再直接把 daemon 原始事件映射到 UI。

```text
AgentThread
├── id
├── title
├── status: idle | composing | running | waitingForApproval | completed | failed
├── messages[]
├── activeTaskID?
├── selectedContext[]
└── updatedAt

AgentMessage
├── id
├── role: user | assistant | system
├── parts[]
├── createdAt
└── linkedArtifacts[]

AgentMessagePart
├── text
├── planSummary
├── toolCall
├── approvalRequest
├── attachment
├── evidence
├── finalOutput
└── error

CapabilityCall
├── id
├── displayName
├── status: preparing | running | waitingForApproval | completed | failed | blocked
├── summary
├── policyDecision
├── inputsSummary
├── outputSummary
└── artifactRefs[]
```

## SwiftUI 组件拆分

建议前端按以下组件落地。

### Page Level

- `AgentWorkspaceV2View`
- `AgentTopStatusBar`
- `AgentLeftRail`
- `AgentThreadWorkspace`
- `AgentInspectorPanel`
- `AgentCompactRunBar`
- `AgentRunDetailsDrawer`

### Thread Level

- `AgentThreadView`
- `AgentMessageRow`
- `UserMessageBubble`
- `AssistantMessageBlock`
- `StreamingTextView`
- `AgentPlanSummaryBlock`
- `CapabilityCallCard`
- `ActionApprovalCard`
- `EvidenceSourceChips`
- `FinalOutputCard`
- `AgentEmptyStateTemplates`

### Composer Level

- `AgentComposerBar`
- `ComposerTextEditor`
- `AttachmentStrip`
- `ContextChipBar`
- `SkillChipPicker`
- `ModelRoutePill`
- `SubmitTaskButton`

### Inspector Level

- `InspectorEmptyState`
- `MessageInspector`
- `AttachmentInspector`
- `ToolCallInspector`
- `EvidenceInspector`
- `PolicyInspector`
- `ArtifactInspector`

## 技术路线

### 推荐路线：SwiftUI-native 优先

原因：

- 当前 app 是 SwiftUI，已有 runtime、stores、services、models。
- 直接引入 React 会带来 WKWebView 通信、资源打包、状态同步和桌面集成复杂度。
- 当前最大问题是信息架构和组件层级，不是 React 能力缺失。

实现方式：

1. 保留现有 `AgentDaemonClient` 和 runtime artifact。
2. 新增 V2 UI state adapter，把 daemon/SSE/runtime 事件转换为 thread/message/part。
3. 重构 `AgentWorkspaceView` 为 Thread-first。
4. 把 Run Deck 收为 compact bar + details drawer。
5. 把工具调用、确认、附件、证据全部作为 message part 渲染。

### 备选路线：局部 React/WKWebView

只有在以下情况出现时再考虑：

- SwiftUI 文本流式渲染和复杂消息布局明显拖慢迭代。
- 需要直接复用 AI Elements / assistant-ui 的完整组件。
- Agent 工作台独立于主桌面 shell，能够承受 WebView 边界。

即便采用 WebView，也应保持：

- Swift 负责 app shell、文件权限、菜单、系统窗口。
- React 只负责 Agent Chat 工作区。
- 所有 tool/runtime 操作通过本地 HTTP/SSE daemon，不直接读真实微信或 secrets。

## Phase 计划

### Phase 1：Thread-first 信息架构

目标：进入 Agent 工作台后，用户第一眼看到的是任务对话和输入框。

任务：

- 将中央区域改为 `AgentThreadView`。
- Composer 固定底部。
- 左侧仅显示任务、上下文、能力。
- 右侧 Inspector 默认折叠或轻量空状态。
- 底部 Run Deck 改成 compact status bar。

验收：

- 用户不看日志也能发起任务。
- 运行状态可见但不抢主内容。
- 技术详情仍可展开查看。

### Phase 2：Composer 与上下文组合

目标：让 prompt、图片、上下文、工具选择自然组合。

任务：

- 输入框支持多行和快捷提交。
- 图片附件进入 `AttachmentStrip`。
- 能力选择进入 `SkillChipPicker`。
- 情报卡、Token、群组、时间窗口进入 `ContextChipBar`。
- 提交时生成统一 `AgentTaskDraft`。

验收：

- 用户能在一次提交前明确看到“将交给 Agent 的全部上下文”。
- 图片和工具不会藏在侧边栏里。

### Phase 3：Inline Tool Call Cards

目标：工具调用成为可理解的协作过程。

任务：

- 将 SSE tool events 渲染为 `CapabilityCallCard`。
- 支持 preparing/running/waiting/completed/failed/blocked。
- 默认显示人话摘要，展开显示技术字段。
- blocked/needs_confirmation 使用 `ActionApprovalCard`。

验收：

- 用户能看懂 Agent 调用了什么能力、为什么调用、结果是什么。
- 失败和阻断有可读原因。

### Phase 4：Inspector 与 Evidence

目标：依据和记录可追踪，但不压迫主界面。

任务：

- 点击 message/tool/attachment/evidence 时更新 Inspector。
- `EvidenceSourceChips` 可跳到 Inspector 详情。
- artifact path、runID、policy detail 默认折叠。

验收：

- 用户能追溯每个结果的依据。
- 技术细节存在但不干扰日常使用。

### Phase 5：长期任务体验

目标：把 long task 从 runtime artifact 变成用户能管理的任务。

任务：

- 左侧 `LongTaskRail` 显示 active/scheduled/completed。
- 每个 long task 绑定 thread。
- 支持恢复、暂停、取消、查看最近输出。
- 完成后可生成 handoff。

验收：

- 关闭重开 app 后还能找到长期任务。
- 长期任务不是 runID，而是带目标、状态和最近结论的任务卡。

## 文案原则

系统词只在技术详情出现。

| 避免主界面直接使用 | 用户层表达 |
|---|---|
| Tool Call | 能力调用 |
| Policy | 安全边界 |
| Provider | AI 模型 |
| Artifact | 记录文件 |
| Run Deck | 运行状态 |
| Daemon | 后台服务 |
| Session | 对话任务 |
| Pipeline | 处理进度 |
| Crystal | 情报卡 |

错误文案示例：

```text
图片理解暂不可用：缺少 KIMI_API_KEY。你仍可让 Agent 基于文字和本地情报继续分析。
```

```text
真实微信读取已阻断：当前版本只读取本地 normalized fixture/export 文件，不会直接访问微信客户端。
```

```text
电脑操作需要确认：Agent 只生成申请，不会直接控制你的 Mac。
```

## 验收标准

### 产品验收

- 用户打开 Agent 工作台后 5 秒内知道可以输入任务。
- 用户可以在同一个 Composer 中组合 prompt、图片、能力和上下文。
- Agent 的流式回复优先展示结论、计划摘要、工具调用和结果。
- 工具调用卡能表达运行中、需确认、已完成、失败、阻断。
- 所有外部或敏感动作都有确认或阻断说明。
- 长期任务能从左侧恢复，不依赖用户记 runID。

### 工程验收

- SwiftUI 组件不直接调用 live MCP/RPC/真实微信命令。
- UI 只消费 `AgentDaemonClient`、runtime stores 和本地 artifacts。
- 图片附件只通过 `AgentAttachmentStore` 入库并计算 hash。
- runID、artifact path、policy decision 仍完整保留在详情层。
- `swift build` 通过。
- `swift test` 通过。
- `--ui-smoke-check` 能看到 Agent 工作台主路径。

## 下一步建议

下一轮不要先继续堆更多工具能力，应优先做前端主路径重构：

```text
AgentWorkspaceView
-> AgentWorkspaceV2View
-> Thread-first layout
-> Composer context composition
-> Inline tool cards
-> Inspector/detail drawer
-> Compact run status
```

核心目标是让 Agent 操作台从“能看系统运行”变成“能自然交代任务并接管结果”。
