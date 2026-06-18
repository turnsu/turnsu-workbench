# 产品

## 默认类别

product

## 用户

核心用户是一位高频使用本地 macOS App 的个人操作者。他在日常工作中用统一 Agent 完成三类高频任务：crypto 数据获取与分析、equity / cross-asset markets research、会议提要和文档撰写。

用户打开这个 App 不是为了浏览装饰性的仪表盘，而是要快速回答：

- 我能不能马上布置一个 crypto、markets 或 office 任务？
- 当前结果能不能继续追问或改写？
- 哪个最终结果是权威结果？
- 这份结果能不能复制、保存或交付？
- 哪些安全边界需要我确认，同时不暴露内部工具和运行时管线？

## 产品目的

looloomi 是一个本地优先的统一 Agent 工作台。它把任务布置、连续追问、CMC 结果阅读、Markets Research 草稿、会议提要、文档草稿、复核和交付动作收束到一个安静的桌面工作界面中。

成功状态是：这个 App 像一个完整的 macOS 工作应用，而不是终端、聊天记录或运维控制台。

当前实现状态：Blocks Workbench 是 SwiftUI 默认工作台。主导航保持 Workbench / History / Settings；Workbench 由 Domain Blocks、Loop Templates、Active Loops、block-aware result canvas 和 Loop Composer 组成。Crypto、Markets、Office 是用户可见的垂直 block；CMC、Markets Research、Office/Meeting、Cloud ASR、Feishu、WeChatCLI、memory 和 subagent coordination 继续作为后台能力或任务状态出现。Command Desk v2 是上一版可用基线，不再是最终 active design。

- 首屏是可工作的界面，而不是系统说明页、日志页或运行监控页。
- 用户不需要理解实现细节，也能开始新任务或恢复旧任务。
- 当前任务、最终答案、草稿正文和下一步动作可以一眼扫到。
- 常用 crypto market loop、markets research loop、office drafting loop 可以从 Domain Block 内快速启动，并能在结果上 review、continue、refine 或 prepare delivery。
- 内部 runtime 概念只出现在 artifact、诊断或设置中。

## 品牌个性

安静、精确、私密。

产品气质应更接近 Apple 原生生产力应用，而不是加密交易终端或 AI demo。它通过克制的层级、稳定的控件和可预测的交互建立信任，而不是通过装饰效果建立气氛。

## 反参考

- 默认首屏像 Bloomberg 式高密度交易终端。
- 只靠聊天历史承载任务状态的 chat-only shell。
- 常驻日志、资料源列表、provider 状态、policy matrix 或 artifact 列表的运维看板。
- 黑色驾驶舱、发光边框、大面积渐变和密集状态 chip。
- App 内出现营销页式 hero、超大卡片和解释功能的长文案。
- 暴露 raw provider、internal tool、normalizer、worker、raw artifact field、secret 或 runtime implementation name。

## 设计原则

1. 从命令和结果出发，不从资料源出发。
   默认界面要先展示可布置的任务、当前结果、追问入口和下一步动作。资料源和 runtime 细节是辅助层。

2. 一个权威答案。
   UI 不允许让用户在 stream blob、session message 和 artifact 文件之间做判断。最终输出只来自 final read model。

3. 渐进式细节。
   Evidence、context、review、policy 和 artifacts 都可以查看，但不能和当前结果画布抢主层级。

4. 展示能力包，不展示基础设施。
   Crypto、Markets Research、Office/Meeting、飞书交付和本地输入以用户可理解的任务意图出现。内部 provider 和 tool name 继续隐藏。

5. 安静的可信感。
   使用 Apple 风格的间距、层级、原生控件和克制色彩。界面应当退到任务背后。

## 无障碍与包容性

- 默认支持 system-adaptive light/dark appearance，以 light-first 构图为基线，并保持完整 dark mode parity。
- 尊重 reduced motion 和 reduced transparency。
- 正文和控件对比度必须达到 WCAG AA。
- 长中文任务标题、混合英文 ID、市场 symbol 必须能稳定截断或换行，不得重叠。
- 颜色不能作为唯一状态表达；必须同时依赖标签、图标和位置。
