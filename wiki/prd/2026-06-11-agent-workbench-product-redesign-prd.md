# Agent 综合工作台产品重设计 PRD v2

- 日期：2026-06-11
- 状态：已按 Command Desk v2 落地到 SwiftUI 默认工作台
- 范围：PRD、交互架构、静态原型与 SwiftUI 产品面；不改后端 runtime contract
- 当前实现方向：`Command Desk`
- 取代内容：`Today Desk`、`Queue Canvas 2.0`、`Split Focus Studio`、`Unified Workstream Desk` 的资料源过重方案

## 1. 产品判断

这个 App 不应该被设计成资料源浏览器、Inspector、terminal 或 dashboard。用户真正要的是一个能嵌入日常工作流的 Agent 工作台：

1. Crypto：不断布置研究任务、调用 CMC Skill Hub MCP 获取返回结果，在 App 内用 Markdown 与轻量组件渲染，并继续追问。
2. Office：拖入文件、图片、会议材料或直接下指令，让 Agent 写会议提要、行动项、PRD、报告、改写稿，并在授权后交付到飞书。

所以核心界面不是“资料源管理”，而是：

```text
快速布置任务 -> 读取/生成结果 -> 追问或改写 -> 形成可用输出 -> 保存/交付
```

WeChatCLI、CMC、Feishu、文件、图片都只是后台能力或输入方式，不是主界面的一等对象。

## 2. 核心用户与使用场景

用户是一位高频 macOS 操作者。他每天在一个本地优先 App 中做两件事：

- Crypto 研究：问 BTC/ETH/SOL、ETF、宏观、链上、群消息、跨资产相关性，得到可读的 CMC returned result 和研究结论。
- 办公写作：把会议、截图、文件、语音转写或简单指令交给 Agent，得到会议提要、待办、文档初稿或改写稿。

用户需要的是低摩擦工作台：

- 可以快速开一个任务。
- 可以围绕上一个结果连续追问。
- 可以看到权威结果，而不是 runtime 过程。
- 可以把结果复制、保存、继续改写或交付。
- 可以确认安全边界，但不想看 provider、normalizer、worker 或资料源列表。

## 3. 产品原则

### 3.1 任务比资料源重要

资料源不常驻。文件、图片、群消息、CMC result、会议材料都通过 composer 或当前任务上下文进入，不作为主导航和主面板。

### 3.2 结果比过程重要

Crypto 任务默认展示市场阅读结果和后续追问入口。Office 任务默认展示可编辑草稿和交付动作。Evidence、gate、channel preview 只在需要解释可信度或阻断时展开。

### 3.3 一个工作台，两种意图

App 不是两个产品。`Crypto` 与 `Office` 是 composer 中的任务意图和结果模板，不是两个独立 workspace。

### 3.4 追问是一等交互

每个结果后面都必须能继续追问。追问不是新建页面，而是当前任务的 continuation。

### 3.5 交付动作显式确认

复制、本地保存可以轻量完成。飞书写入、外部发送、发布、覆盖文档等高影响动作必须经过 review 与确认。当前 runtime 如果仍是 dry-run，UI 应显示为“可预览，未真实写入”。

## 4. 信息架构

顶层导航收敛为：

1. `工作台`
2. `历史`
3. `设置`

### 4.1 工作台

默认入口。它只有三块：

- 左侧：任务栈，显示正在进行、待复核、已完成的简短任务。
- 中央：结果画布，渲染当前 crypto answer 或 office draft。
- 底部：Command Composer，负责新任务、追问、附件和交付指令。

不设置常驻资料源面板。

### 4.2 历史

历史不是资料库，而是可恢复的工作记录：

- crypto 研究记录。
- office 草稿与会议提要。
- 已保存输出。
- 失败或 blocked 任务。

用户从历史中恢复任务、继续追问、复制旧结果或重新生成。

### 4.3 设置

设置承载：

- 能力连接状态：CMC、WeChatCLI、Feishu、local files。
- 隐私与本地存储。
- 飞书授权与 dry-run / live 状态。
- diagnostics。

这些不进入日常工作台。

## 5. Command Composer

Composer 是核心产品控件。

必须支持：

- `Crypto` / `Office` 意图切换。
- 自然语言输入。
- 继续追问当前结果。
- 拖入文件、图片、音频或文档。
- 常用任务快捷项。
- `Cmd+Return` 提交。
- Escape 关闭弹层。

### 5.1 Crypto 意图

默认任务：

- 复核 BTC / ETH / SOL 宏观观点。
- 分析 ETF 流、链上、衍生品、跨资产关系。
- 解释 CMC Skill Hub 返回结果。
- 跟踪某个 token 或 watchlist。
- 追问当前结论。

UI 只显示用户可理解状态：

- `CMC result ready`
- `prices limited`
- `needs follow-up`
- `answer saved`

不显示 MCP、provider、raw response、internal tool。

### 5.2 Office 意图

默认任务：

- 写会议提要。
- 提取行动项。
- 写 PRD / 报告 / 周报。
- 改写或总结拖入文档。
- 将草稿准备为飞书交付。

UI 只显示用户可理解状态：

- `draft ready`
- `needs review`
- `Feishu preview`
- `saved locally`

如果未来开启 live Feishu 写入，必须在交付前明确显示写入对象和确认动作。

## 6. 结果画布

### 6.1 Crypto Answer Canvas

默认展示：

- 任务标题。
- 简短市场结论。
- CMC Skill Hub returned result 的可读摘要。
- 必要的数据说明：价格是否来自 Skill Hub 原文，是否缺少结构化 price snapshot。
- Markdown 正文。
- 后续追问建议。
- 操作：追问、复制、保存、创建跟进。

不默认展示：

- 资料源列表。
- provider details。
- artifact path。
- raw gate JSON。

### 6.2 Office Draft Canvas

默认展示：

- 草稿类型：会议提要、行动项、文档、改写稿。
- 可读正文。
- 结构化块：摘要、行动项、决策、风险、后续问题。
- 附件或输入文件的简短提示。
- 交付状态：本地保存、飞书预览、待确认。
- 操作：继续改写、复制、保存、准备飞书交付。

不默认展示：

- 资料包表。
- transcript chunk list。
- worker 状态。

## 7. 详情与复核

详情只在用户需要时打开。

Crypto 详情：

- CMC 返回摘要。
- price gate 说明。
- WeChat 群消息是否参与。
- evidence 是否足够。

Office 详情：

- 使用了哪些附件或会议材料。
- 哪些行动项缺 owner / date。
- 飞书交付预览。
- 安全确认。

详情是解释层，不是主界面。

## 8. 非目标

- 不做资料源浏览器作为主产品。
- 不做常驻 Inspector。
- 不做 dashboard 式指标页。
- 不暴露 internal tools、providers、normalizers、workers。
- 不默认真实交易、微信发送、外部发布或飞书覆盖写入。
- SwiftUI 已按 Command Desk v2 落地；后续只在此方向上做交互和视觉细化。

## 9. 原型验收

本轮 active 原型只保留三类：

1. `Command Desk`：综合工作台默认屏。
2. `Crypto Answer Loop`：CMC result 渲染与连续追问。
3. `Office Writing Loop`：拖入材料、生成草稿、准备飞书交付。

合格标准：

- 没有常驻资料源面板。
- 没有常驻 Inspector。
- 首屏能直接开始 crypto 或 office 任务。
- 当前结果能追问。
- Crypto 结果以 CMC 返回内容和 Markdown / 组件渲染为核心。
- Office 结果以草稿正文和交付动作为核心。
- WeChatCLI 只作为“群消息输入已可用”的后台能力状态，不作为工作台入口。
