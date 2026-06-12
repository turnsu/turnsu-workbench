# Agent 综合工作台交互架构重设计 v2

- 日期：2026-06-11
- 状态：已按 Command Desk v2 落地到 SwiftUI 默认工作台
- 当前实现方向：`Command Desk`
- 对应 PRD：`wiki/prd/2026-06-11-agent-workbench-product-redesign-prd.md`

## 1. 交互结论

上一版原型仍然把资料源、queue、evidence drawer 放得太重。用户真实工作流不是管理资料源，而是快速让 Agent 做两类垂直任务：

1. Crypto 数据获取与分析。
2. 会议提要和文档撰写。

因此交互中心应从：

```text
资料源 -> task -> evidence -> output
```

改为：

```text
command -> answer/draft -> follow-up -> save/deliver
```

## 2. App Shell

顶层导航：

- `工作台`
- `历史`
- `设置`

移除主导航中的：

- Agent Console。
- 资料源 / Library 作为独立主入口。
- Ops。
- WeChatCLI。

### 2.1 工作台

工作台承载当前全部工作。

布局：

- 左侧窄任务栈：当前任务、今日完成、待复核。
- 中央结果画布：当前 answer 或 draft。
- 底部 composer：新任务和追问。
- 顶部轻量状态：本地、CMC、Feishu、隐私。

没有常驻右侧 Inspector。

### 2.2 历史

历史承载过去输出，不承载资料源管理。

列表类型：

- Crypto answers。
- Office drafts。
- Meeting summaries。
- Saved follow-ups。

每条历史记录可以：

- 打开。
- 继续追问。
- 复制。
- 重新生成。

### 2.3 设置

设置承载能力连接和诊断。

内容：

- CMC Skill Hub 状态。
- WeChatCLI 群消息读取配置。
- Feishu 授权和 dry-run / live 状态。
- local file access。
- runtime diagnostics。

## 3. Command Composer

Composer 是主工作控件。

结构：

- 左侧任务意图切换：`Crypto`、`Office`。
- 中间输入区：自然语言指令。
- 附件区：文件、图片、音频、文档。
- 快捷任务：随意图变化。
- 右侧提交按钮。

### 3.1 Crypto Composer

快捷任务：

- 复核 BTC 宏观 thesis。
- 分析 ETF 流和跨资产关系。
- 解释 CMC 返回结果。
- 跟踪某个 token。
- 追问当前答案。

提交后：

- 调用 CMC Skill Hub。
- 如果用户选择了群消息上下文，再引入 WeChatCLI 读取结果。
- 返回 Markdown 和前端组件。
- App 不展示 MCP 和资料读取过程。

### 3.2 Office Composer

快捷任务：

- 写会议提要。
- 提取行动项。
- 写 PRD。
- 改写文档。
- 准备飞书交付。

提交后：

- 读取拖入文件、图片、音频或文档。
- 生成 draft canvas。
- 若请求飞书交付，先生成 review preview。
- 真实写入必须确认，当前 dry-run 状态要明确。

## 4. Result Canvas

Result Canvas 是主阅读面。

### 4.1 Crypto Answer Loop

区块：

- 标题与任务状态。
- CMC returned summary。
- Markdown answer。
- 轻量数据说明。
- Follow-up prompts。
- 操作区：追问、复制、保存、创建跟进。

状态表达：

- `CMC result ready`
- `prices limited`
- `answer ready`
- `needs more data`

不展示：

- 资料源表。
- artifact path。
- raw provider。
- raw gate object。

### 4.2 Office Writing Loop

区块：

- 草稿标题和类型。
- 文件/图片/会议输入提示。
- 正文编辑预览。
- 行动项或文档结构。
- Feishu handoff preview。
- 操作区：改写、复制、保存、准备交付。

状态表达：

- `draft ready`
- `needs review`
- `Feishu preview`
- `saved locally`

## 5. 详情层

详情只在用户主动点击时打开。

入口：

- Crypto：`数据说明`
- Office：`复核交付`
- History：`任务记录`

详情内容：

- 为什么有些价格不可用。
- CMC 返回是否可展示。
- 哪些附件被使用。
- 飞书交付会写到哪里。
- 哪些高影响动作需要确认。

详情层不能重新变成资料源浏览器。

## 6. 状态模型

任务状态：

- `Running`
- `Ready`
- `Needs review`
- `Blocked`
- `Saved`

能力状态：

- `CMC ready`
- `CMC limited`
- `WeChat context available`
- `Feishu preview`
- `Feishu needs confirmation`

这些状态出现在任务 header 或提交按钮附近，不占据主画布。

## 7. Swift 落地边界

后续实现必须遵守：

- `DashboardViewModel` 不决定 final precedence。
- `AgentFinalReadModel.finalText` 仍是唯一最终答案来源。
- 不从历史、详情、session message 或 stream blob 拼 final。
- `RuntimeRightInspectorView` 不进入默认产品 shell。
- WeChatCLI 不作为主导航。
- Feishu live 写入必须经过显式确认。

## 8. SwiftUI 落地记录

当前已按 `Command Desk` 进入 SwiftUI 实现。

- 默认入口是 `工作台`，显示任务栈、结果画布和 Command Composer。
- 主导航收敛为 `工作台 / 历史 / 设置`。
- `Crypto` 与 `Office` 是 composer 任务意图，不是顶层 workspace。
- 历史替代资料源 / Library 主入口，仅作为已完成结果、草稿和追问恢复入口。
- 默认产品路径不再渲染 `RuntimeRightInspectorView`。
- Feishu 交付仍保持 preview / confirm 边界，不作为常驻工作台入口。
