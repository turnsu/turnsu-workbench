# OpenUI 智能交互与 Research 组件

## 给人阅读

工作台只有一套智能交互渲染器。助手在当前对话里生成核对页，用户修改数字时立即重算，草稿自动保存；点击确认才把固定版本交给同一位助手继续。浏览器、文件、历史、权限和成果仍由现有 Host 管理。展开内容、切换主题、重开会话不会另建任务。

v5A Research 的阅读顺序是结论、依据、调整与确认、来源。白色阅读区、衬线标题、薄分隔线和小号按钮统一用于工作台与生成内容；不靠层层卡片划分层级。指标带计算口径或真实参照，金额保留原始精度。原始材料与真实成果分别标识，确认成功不等于业务完成。

| 组件 | 使用场景 |
| --- | --- |
| ResearchSummary | 先给有依据的结论，再补一句解释 |
| Metric | 数值、单位、口径或比较；四列在窄卡片降为两列 |
| ResearchSection / KeyValue | 证据分组与简短事实，不增加一层卡片 |
| ReviewTable | 原值核对、受限列编辑、列表与前后对照；超过 40 行分页 |
| Comparison | 并列方案或支持与保留意见；窄卡片纵向排列 |
| ResearchNote | 口径、缺失信息与限制，不能伪装成成功状态 |
| Sources / TaskFiles | 真实来源与 Host 已登记文件；未知文件不能打开 |
| ActionBar | 解释下一步，并提供一项主要确认操作 |

原有图表、Markdown、数学、图片、地图和受隔离 HTML 仍由同一 OpenUI 组件库提供。它们不会取得宿主 DOM、文件权限或 Agent 控制权。

## 给 Agent 和开发者

组件目录以当前构建生成的 `turnsu://ui/library` 为准。上游为 MIT 的 Open Intelligent UI，固定版本与许可见 `apps/desktop/src/intelligence-ui/upstream/PROVENANCE.json`。只采用渲染器、组件与函数，不采用示例聊天、localStorage 会话库或模型网关。

`turnsu_ui present` 接受 `{format:"openui", title, program, data, streaming?}`。`program` 是 OpenUI 声明语言，`$variable` 与同一份 Host 草稿绑定；`@Set` 只改变本地状态。`Query("task_data", {name}, fallback)` 只读当前页面数据，不允许模型指定任意工具。`@ToAssistant` 经过可见输入校验、版本校验和幂等确认后交给原 Agent；生成中、未解决的渲染错误及接收状态不确定时不能提交。

业务数据、金额精度和计算口径来自任务来源，不能套用文档示例数值。Host 已显示 `document.title`，正文从结论开始。新内容不能覆盖未提交的修改。旧树形页面在 Host 读取时单向转成 OpenUI，保留原数据键、只读列约束、revision、时间和确认回执；浏览器端没有第二个旧渲染器。

界面合同与持久化放在 `packages/agent-host/ui/`；App 与 Research 组件在 `apps/desktop/src/intelligence-ui/`；共用视觉与基础操作在 `src/shared/`。迁移及确认回归在 Host 的 `test/ui/`，桌面状态测试在 `test/unit/`，生产 Electron 路径由 `test/conversation-ui-smoke.mjs` 和 `test/research-ui-check.mjs` 覆盖。受控 Agent 检查与真实 Agent 验收分别记录，不能相互替代。
