# Marketplace / Template Library

本篇聚焦 RelevanceAI marketplace 如何组织 agent/template card、listing detail、filters、install/clone/readiness，并映射到 looloomi 的 Loop Library。

## 截图证据

- `screenshots/01-relevanceai-marketplace-workforce.png`：`Relevance Marketplace` 顶部有全局 search、`Builders`、`Integrations`、`Categories`、`Start for free`；列表标题是 `All Workforces`，卡片展示名称、类型、简短描述、creator/category、价格和 integration 图标。
- `screenshots/01-relevanceai-marketplace-workforce.png`：筛选控件包括 `All Workforces`、`All categories`、`Free + Paid`、`Filter by tag`、`Recently updated`。
- `screenshots/02-relevanceai-marketplace-listing-detail.png`：detail 页有 breadcrumb、title、type、`Buy $97.00`、复制/分享样式按钮、`Creator`、`Tools`、`Integrations`、`Description`。
- `screenshots/02-relevanceai-marketplace-listing-detail.png`：detail 页右侧展示 workforce 流程预览和 `Example Task`，下方显示一次 agent 执行过程中的 used tools 与输出报告片段。
- `screenshots/03-relevanceai-app-entry-auth-state.png`：app 内 `Marketplace` 是一级导航，说明 marketplace 与 workspace 内资源管理并列，而不是隐藏在设置页。

## 产品观察

- marketplace 首屏先回答“能装什么”：大标题、搜索、筛选、排序和卡片网格并列出现。
- card 不需要承载完整说明，只承载名称、类型、资源数量、短描述、来源/分类、价格或成本信号、可用集成图标。
- listing detail 承担“是否值得安装”的判断：creator、tools、integrations、description、example task、流程预览、运行样例都在一个详情页内。
- 价格按钮 `Buy $97.00` 是明确 CTA；对 looloomi 可映射为 `Install`, `Clone`, `Use template`, `Preview` 或 `Request access`，具体文案取决于模板是否可直接使用。
- readiness 不应只用抽象评分，应该拆成用户可理解项：需要哪些 knowledge、需要哪些 integrations、需要哪些 inputs、是否有 example run。

## 映射到 Loop Library

Loop Library 建议采用“列表/卡片 + split detail”的模板库，而不是单纯 gallery。

### Library 列表

建议字段：

| 字段 | UI 显示 | 来源证据 |
| --- | --- | --- |
| template name | 模板名称，如 `Website Monitor` | 01、03 的 card/row name |
| type | `Agent`, `Workflow`, `Tool pack` 等用户可理解类型 | 01 的 `Workforce` |
| summary | 一句话说明 | 01 的卡片描述 |
| category | 业务分类 | 01 的 `All categories` 与 card 分类 |
| integrations | 图标或短标签 | 01、02 的 integration icon |
| price/access | `Free`, `Paid`, `Team only`, `Installed` | 01 的 `Free + Paid`、02 的 `Buy $97.00` |
| updated | `Last modified` 或 `Recently updated` | 01、03 |

筛选必须包括：

- search：placeholder 可用 `Search templates...`。
- type：`All templates`, `Agents`, `Workflows`, `Tools`。
- category：对应业务域。
- access：`Free`, `Paid`, `Installed`, `Needs setup`。
- tag：轻量 `Filter by tag`。
- sort：`Recently updated`, `Most used`, `Newest`。

### Listing detail

detail 建议采用两栏或 split detail：

- 左栏：icon、name、type、CTA、creator、category、integrations、required inputs、required knowledge。
- 右栏：preview graph 或 step list、example task、sample output、readiness checklist。
- 底部：版本、最近更新、使用限制、安装记录。

CTA 状态：

- `Preview`：打开只读详情，不写入 workspace。
- `Install`：模板可直接安装。
- `Clone`：复制到当前 workspace 后可编辑。
- `Finish setup`：已复制但缺少 integration、knowledge 或 required input。
- `Open`：已安装且 ready。

## Readiness 规格

每个模板在 detail 页显示 readiness，不使用黑盒分数作为唯一判断。

| 状态 | 用户看到 | 触发条件 |
| --- | --- | --- |
| Ready | `Ready to run` | 必需 integration、knowledge、input schema 都满足 |
| Needs setup | `Needs setup` | 至少一个必需项未配置 |
| Limited | `Limited` | 可运行但缺少可选增强项 |
| Unavailable | `Unavailable` | 当前 plan 或权限不可用 |

Readiness 明细：

- `Integrations`：显示已连接、未连接、需要授权。
- `Knowledge`：显示是否需要绑定知识库。
- `Inputs`：列出 required fields。
- `Example task`：可直接填入 run chat 的示例。

## 落地验收点

- Loop Library 有列表或卡片视图，且支持 search、filter、sort。
- 点击模板能打开 detail，不需要离开 library 才能判断安装价值。
- detail 中至少显示 creator/source、integrations、description、example task、CTA、readiness。
- installed/clone 后进入可编辑副本，不覆盖原模板。
- 未 ready 的模板必须给出缺失项，而不是只禁用 run。
