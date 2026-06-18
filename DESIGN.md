# 设计

## 目标

这个 App 是一个面向本地优先统一 Agent 的 macOS 生产力工作台。视觉系统应该原生、极简，并能承受日常长时间使用。它不应该像加密交易终端、工程观测平台或通用 AI 聊天产品。

设计参数：

- DESIGN_VARIANCE: 4
- MOTION_INTENSITY: 2
- VISUAL_DENSITY: 5

## 平台

- 原生 macOS SwiftUI。
- system-adaptive appearance，light-first。
- 优先使用 Apple 原生控件：sidebar、segmented control、sheet、popover、split view、toolbar-like command region。
- 当标准 macOS affordance 已经能准确表达动作时，避免自造控件。

## 信息架构

全局导航应把当前并列的产品表面收束成三个用户可见区域：

- Workbench：任务栈、结果画布、command composer、final answer、office draft、追问和交付动作。
- History：已完成的 crypto answers、office drafts、meeting summaries 和 saved follow-ups。
- Settings：runtime 状态、隐私、provider readiness、retention 和 diagnostics。

Workbench 是默认产品表面。Home、Agent、Library、Ops 不应继续像多个互相竞争的 App。

## 布局

Workbench 当前实现方向：Blocks Workbench。

Blocks Workbench 布局：

- 左侧 Block Rail：固定展示 `Crypto`、`Markets`、`Office` 三个 Domain Blocks；每个 block 内展示少量可执行 Loop Templates 和当前 Active Loops。
- 中央结果画布：根据当前 block 渲染结果。Crypto 显示 CMC returned result、market markdown、价格/证据说明和下一轮追问；Markets 显示 equity / macro / cross-asset research draft、evidence gaps 和 review tasks；Office 显示会议提要、文档草稿、Cloud ASR 状态和 Feishu preview/confirmation。
- 底部 Loop Composer：当前选中 block 决定 placeholder、quick prompts、附件 affordance 和默认能力包；`/add` 打开当前 Domain 的 Loop Template selector，不展示 raw skills。
- 详情 sheet：数据说明、复核、Policy、CMC、Loop、Memory、Subagents 只在 task-local sheet 中打开，不常驻为运维面板。

Adaptive layout rules:

- Primary workspace content must fill the available window width; do not cap Blocks Workbench with a small fixed `maxWidth`.
- Breakpoints: compact `< 1100pt`, regular `1100..<1500pt`, wide `>= 1500pt`.
- Compact: task stack, result canvas, and composer stack vertically; controls wrap instead of compressing titles.
- Regular: task stack keeps a stable minimum width while result canvas and composer fill remaining space.
- Wide: task stack and support columns can expand proportionally but must clamp to comfortable reading widths; the result canvas remains the main fill surface.
- Top command controls use a wrapping/adaptive layout; search and filters must not push buttons out of the window.

History 布局：

- 一个可恢复的工作记录列表，用筛选切换 Crypto answers、Markets drafts、Office drafts、Meeting summaries 和 Saved follow-ups。
- 历史记录支持打开、继续追问、复制、重新生成。
- 不做常驻资料源浏览器。
- 结果记录与草稿/交付面板使用 adaptive split；窄窗口纵向堆叠，宽窗口双栏填满，不使用漂浮固定右栏。

Settings 布局：

- runtime 与隐私设置使用标准 grouped form。
- CMC、WeChatCLI、Feishu 和 local file access 的连接状态在这里展示。
- logs、provider health 和 artifact index 继续作为 diagnostics，不作为主导航。

## 色彩

色彩策略：克制。

Light mode：

- 背景：低 chroma 的近白中性色。
- Sidebar：略微抬升的中性 surface。
- 内容 surface：白色或近白实体填充。
- 主文本：接近黑色的 graphite。
- 次级文本：满足 AA 对比度的 graphite gray。
- Accent：system blue，仅用于选中态、主动作和链接。

Dark mode：

- 背景：中性 graphite，不做 black-gold cockpit。
- Sidebar 与内容 surface：阶梯式 graphite layer。
- 文本：高对比度 warm-neutral white。
- Accent：system blue 或低饱和 adaptive blue，不使用大面积金色渐变。

状态色：

- 成功：green。
- Warning/degraded：amber。
- Blocked/error：red。
- Info/current selection：blue。

默认 surface 不使用渐变、glow、彩色玻璃或装饰性 accent wash。

## 字体

- 产品 UI 使用 Apple system font。
- labels、body、controls 和 data 使用同一字体家族。
- 产品字号保持紧凑：
  - Page/workspace title：20-24 pt semibold。
  - Section title：13-15 pt semibold。
  - Body：12-14 pt regular。
  - Metadata：10-12 pt regular 或 medium。
- compact panel 内不使用 display typography。
- 不使用 gradient text。
- 除少量紧凑 table/category header 外，不使用宽字距全大写标签。

## 组件

核心组件：

- Sidebar row。
- Block row。
- Loop template row。
- Active loop row。
- Status pill。
- Capability package chip。
- Intent segmented control。
- Attachment chip。
- Result canvas。
- Follow-up prompt chip。
- Loop template launcher action。
- Delivery preview row。
- Evidence/review/policy summary row。
- Detail sheet。
- Empty queue state。
- Running task state。
- Blocked task state。

组件规则：

- Card 只用于重复对象或聚焦任务块。
- 避免 cards inside cards。
- 增加另一个带边框容器前，优先使用 separator、grouped surface 和留白。
- 主动作只使用一种 accent treatment。
- 次级动作使用 plain 或 bordered 样式。
- 破坏性或高影响动作必须显式确认，并使用清楚的 verb-object label。

## 动效

- 动效用于解释状态变化，不用于装饰。
- 默认 transition：150-220 ms ease-out。
- 只使用轻微的选择移动、sheet reveal、queue update 和 progress change。
- 不使用 page-load choreography。
- reduced motion 必须禁用非必要动效。

## 文案

- UI 文案应命名用户的工作，不命名 runtime implementation。
- 优先使用短标签：Workbench、History、Crypto、Markets、Office、Answer、Draft、Follow-up、Review、Settings。
- 避免在 App 内写解释产品功能的长文案。
- 不展示 raw provider ID、internal tool ID、normalizer name、worker name、artifact field name 或 secret。
- Feishu 继续保持交付动作表述；除非 task-local review 需要 channel preview，否则不进入常驻工作台。

## 原型方向

当前重构探索已收敛为 Blocks Workbench：

- Block Rail Workbench：当前实现方向。左侧 Domain Blocks + Loop Templates + Active Loops，右侧 block-aware result canvas，底部 Loop Composer。
- Loop Board Workbench：备选原型。中间以 loop 卡片和状态流为主，适合同时管理多个并行研究/办公 loop。
- Focused Run Workbench：备选原型。当前 run 画布最大化，blocks 作为紧凑 launcher，适合深度研究或长文档草稿。

Swift 实现状态：Blocks Workbench 已落地为默认 Workbench。Command Desk v2、Today Desk、Queue Canvas 2.0、Split Focus Studio 和上一版 Unified Workstream Desk 已归档为历史参考，不再作为 active 原型。
