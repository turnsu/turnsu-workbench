# Knowledge / Toast System

本篇聚焦 knowledge library、new knowledge menu、toast/event feedback，并映射到 looloomi 的知识库与通知系统。

## 截图证据

- `screenshots/04-relevanceai-knowledge-empty.png`：`Knowledge` 页面标题为 `Your knowledge base`，顶部有 `Upload`, `Website`, `Integration`, `Blank` 四个入口。
- `screenshots/04-relevanceai-knowledge-empty.png`：列表区有 `Search...`，已有一个 knowledge row，显示 `0 documents`，行尾有更多菜单。
- `screenshots/05-relevanceai-knowledge-new-modal.png`：右上 `New Knowledge` 打开菜单，包含 `Blank`, `Upload file`, `Import from website`, `Integrations`，并配有短说明。
- `screenshots/03-relevanceai-app-entry-auth-state.png` 和 `screenshots/04-relevanceai-knowledge-empty.png`：右下角有 `What's New` toast/announcement 样式入口，可关闭。
- `screenshots/03-relevanceai-app-entry-auth-state.png`：左侧导航将 `Knowledge` 与 `Agents`, `Tools`, `Workforce` 并列放在 Build 区域。

## 产品观察

- Knowledge 是 workspace 资源库，不是聊天附件的临时入口；它有独立导航、列表、搜索和创建菜单。
- 新建入口同时存在两个层级：页面中部的快捷方式和右上 `New Knowledge` 菜单，适合新用户和熟练用户。
- `Blank` 是一等入口，说明知识库可以先建容器再填充内容。
- `Upload file` 与 `Import from website` 文案明确来源，减少用户对导入方式的猜测。
- 右下 `What's New` 证明系统反馈可以轻量驻留，不需要阻断当前工作。

## 映射到 looloomi 知识库

looloomi 知识库建议采用 database row 形态，每个 row 是一个 knowledge collection。

### Knowledge 列表字段

| 字段 | UI 显示 |
| --- | --- |
| name | knowledge collection 名称 |
| source type | `Blank`, `Upload`, `Website`, `Integration` |
| documents | 文档数，例如 `0 documents` |
| linked agents | 绑定的 agents 或 workflows |
| updated | 最近更新时间 |
| owner | owner 或 workspace |
| status | `Ready`, `Syncing`, `Needs attention`, `Empty` |

### New Knowledge 菜单

菜单项建议保留截图中的概念，但文案可适配：

- `Blank`：创建空 collection，适合先搭结构。
- `Upload file`：上传 CSV、Excel、JSON、PDF、Audio 等文件；具体格式以产品实际支持为准，不在 UI 承诺未实现格式。
- `Import from website`：输入 URL 后抓取公开网页内容。
- `Integrations`：从已连接的第三方服务导入或同步。

页面中部快捷入口可用图标按钮：`Upload`, `Website`, `Integration`, `Blank`。右上按钮保持主操作：`New Knowledge`。

## Toast / Event Feedback

系统反馈建议分三层：

| 层级 | 用途 | UI 形态 |
| --- | --- | --- |
| toast | 创建成功、导入开始、保存完成、轻微错误 | 右下角轻量提示，可关闭 |
| row status | sync/import/run 的持续状态 | 列表行内 `Syncing`, `Failed`, `Ready` |
| detail activity | 需要追溯的事件 | detail 里的 activity/history |

示例文案：

- `Knowledge created`
- `Import started`
- `Website import needs review`
- `Upload failed: unsupported file type`
- `Knowledge linked to 3 agents`

不要把内部执行实现词显示给用户。用户只需要看到来源、状态、下一步和可恢复动作。

## 与 chat/agent 的关系

- 在 chat 中，knowledge 应作为 `Scope` 或 `Context` 的可选项出现，用户可以选择某个 collection。
- 在 agent/detail 中，knowledge 是可绑定资源，显示为 `Knowledge` section。
- 在 run 结果中，引用过的 knowledge 应显示为用户可理解的 source name，不显示内部检索链路。

## 落地验收点

- Knowledge 页有独立导航入口，并能展示 collection rows。
- `New Knowledge` 菜单包含至少 Blank、Upload、Website、Integration 四类入口。
- 创建空 collection 后可以看到 `0 documents` 或等价空状态。
- 导入/创建/失败都有 toast，同时 row status 可持续展示状态。
- chat 或 agent 设置里可以选择 knowledge scope。
