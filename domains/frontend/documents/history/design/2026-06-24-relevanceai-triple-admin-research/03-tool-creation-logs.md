# Tool Creation / Logs

本篇聚焦 new tool modal、builder flow、logs/history，并映射到 looloomi 的 Skill OS / Tool OS 管理面。

## 截图证据

- `screenshots/06-relevanceai-tools-list.png`：`Tools` 页面是 database rows，顶部有 `New Tool`、`Filter`、`Columns: (6)`、`Sort: Last modified`、`New Folder`、视图切换。
- `screenshots/06-relevanceai-tools-list.png`：行字段包括 `Tool name`, `Description`, `Type`, `Integrations`, `Agents`, `Owner`, `Last modified`。
- `screenshots/06-relevanceai-tools-list.png`：顶部快捷分类是 `Invent`, `Default`, `MCP`；这里仅作为截图 literal 记录，looloomi 产品 UI 不需要照搬不适合用户理解的分类名。
- `screenshots/07-relevanceai-tools-new-menu.png`：`New Tool` 后出现 `Choose a starting point`，支持 `Default`、`Invent`、`Import`，并有一句自然语言输入：`Describe a repetitive, manual task. We'll build a tool to do it...`。
- `screenshots/08-relevanceai-tool-builder.png`：builder 页顶部有 `Build`, `Use`, `Logs` 三个 tab，右上有 `Run tool`，状态为 `Live`。
- `screenshots/08-relevanceai-tool-builder.png`：画布中有 `Inputs`、中间步骤 `Python`、`export_permanent_file`、`Outputs`，并明确提示 `Missing required values for: website_url, is_full_page`。
- `screenshots/09-relevanceai-tool-logs-tab.png`：logs 页标题为 `Track your tool history`，说明是 `View the status, cost to run and any errors of each bulk run.`，筛选有 `All statuses` 和 `All users`，空状态是 `No tool history found`。

## 产品观察

- Tool 列表不是代码仓库视图，而是运营管理视图：谁拥有、谁在用、关联哪些 agents、最后修改时间。
- 新建 tool 的首步不是直接进入复杂编辑器，而是先选 starting point，并允许用自然语言描述重复任务。
- builder 的主导航压缩为 `Build / Use / Logs`，用户心智清晰：搭建、试用、追踪。
- 输入缺失提示在 `Inputs` 节点内直接呈现，错误靠近需要修复的位置。
- logs 关注业务可理解的 status、cost、errors、user，不把执行细节暴露为主界面概念。

## 映射到 Skill OS / Tool OS

looloomi 可以把“技能/工具”统一成用户可管理的 Tool rows，但在 detail 中区分用途。

### Tools 列表

建议字段：

| 字段 | 说明 |
| --- | --- |
| name | tool 名称 |
| description | 一句话能力说明 |
| type | `Action`, `Analysis`, `Import`, `Export`, `Automation` 等用户可理解类型 |
| integrations | 依赖的外部连接 |
| used by | 关联 agents / loops |
| owner | 负责人 |
| status | `Draft`, `Live`, `Needs setup`, `Failed` |
| last modified | 最近修改时间 |

列表能力：

- search。
- filter by type/status/integration/owner。
- columns selector。
- sort by last modified。
- new folder 或 collection grouping。
- list/grid 切换可选，但 list 是默认。

### New Tool 起点

建议起点：

- `Start from blank`：进入 builder，自行配置 input、steps、output。
- `Describe task`：自然语言生成初稿，输入框承载“重复、手工任务”的描述。
- `Import`：从已有定义、文件或模板导入。

不建议在用户 UI 中直接暴露内部构建分类。可在高级模式或开发者说明中保留，但主路径用业务语义。

### Builder flow

builder 至少包括：

- 顶部状态：name、icon、`Draft/Live`、保存状态、发布状态。
- tabs：`Build`, `Use`, `Logs`。
- `Build`：flow canvas 或 step list，显示 Inputs、Steps、Outputs。
- `Use`：可填写 required inputs 并运行。
- `Logs`：展示 run history。
- 节点级校验：缺少 required values 时靠近 Inputs 显示。
- 全局 CTA：`Run tool`、`Share`、`Publish` 或等价动作。

### Logs / History

history rows 建议字段：

| 字段 | 说明 |
| --- | --- |
| time | run 时间 |
| status | success / failed / cancelled / running |
| user | 发起人 |
| input summary | 输入摘要 |
| cost | 成本或 credits |
| duration | 耗时 |
| error | 用户可读错误 |
| output | 输出摘要或链接 |

空状态文案可参考：`No tool history found`。有记录时应支持 `All statuses`、`All users`、time range。

## 落地验收点

- Tools 页面有 row list，字段覆盖 name、description、type、integrations、used by、owner、last modified 或等价内容。
- `New Tool` 打开 starting point，不直接把用户丢进空白复杂画布。
- builder detail 有 `Build / Use / Logs` 或等价三段式。
- required input 缺失必须显示在可修复位置。
- logs/history 可以按 status 和 user 筛选，空状态明确。
