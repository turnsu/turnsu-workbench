# turnsu 仓库与工作台融合核查

- 日期：2026-09-28
- 核查对象：当日 `turnsu` 组织可访问仓库、当前桌面工作台源码与真实 macOS 窗口
- 目的：挑选能改善「打开项目 → 找到会话 → 继续工作 → 查看结果」的现有资产；不另建第二套产品状态

| 仓库 | 已核对事实 | 工作台决定 |
| --- | --- | --- |
| [`frontend-scaffold`](https://github.com/turnsu/frontend-scaffold/tree/02203ea4ecdd2da3a2c22e7accc196f5b5e7ab35) | MIT；已有 React 控件与主题，当前桌面已选择性采用按钮、输入、徽标 | 继续逐个控件接入，先解决会话与加载行为；不引入脚手架的整站路由或服务端 |
| [`assets`](https://github.com/turnsu/assets/tree/14e01d547d01fc7cacfd0e9e27af0ff2a491371e/logo) | 品牌 `turnsu-lockup.svg` / `turnsu-symbol.svg` 与工作台 Web 品牌文件逐字一致，桌面构建已从 Web 复制这些素材 | 维持现有唯一品牌文件来源，不再复制一份到桌面；需要更新品牌时核对公司素材版本 |
| [`linkcode`](https://github.com/turnsu/linkcode/tree/22c337f197665e1c53cc717b88859a45cfd8a43d) | 桌面会话与 Agent 生命周期参考；上游 [`LICENSE`](https://github.com/turnsu/linkcode/blob/22c337f197665e1c53cc717b88859a45cfd8a43d/LICENSE) 是 BUSL 1.1，包含竞争性产品限制；其加载态针对连接 Host，而非工作台本地草稿 | 只把「本机会话身份稳定、冷会话可继续、加载阶段有明确含义」作为设计参考；不复制主体代码或 UI 实现 |
| [`llm-gateway`](https://github.com/turnsu/llm-gateway/tree/9051eebc7be08f63311b44193234b83f71b89acb) | React 管理端围绕 New API 的认证、渠道和计费；根 LICENSE 是 MIT，但检查到的加载组件仍带上游 AGPL 头 | 可参考已有视觉语言，但不把网关管理页或带 AGPL 头文件挪进工作台；模型网关也不成为本机启动依赖 |
| `new-api`、`owl`、`ShotSeek`、`homepage`、`doc-templates`、`turndo-website`、`book-template` 等 | 分别是模型网关后端/框架、独立 Swift 产品、站点与模板用途；本轮没有发现可替换本机会话状态所有者的模块 | 保持独立；有明确跨产品消费场景时再评估协议或设计规范，不为“融合”引入新运行时 |

当前桌面实际问题来自本仓调用链：SQLite 的 `workspace.read` 已按 `updated_at` 返回会话，但侧栏仅显示单行标题和 Agent 缩写；切换会话在草稿与历史读取期间把 `session` 清空，于是临时渲染「今天想完成什么？」；启动时也会在恢复上次选择前显示欢迎页；长对话滚动离底后没有回到最新的就近操作。以上应在桌面 UI 与本机 Host 的既有职责内修正。

本轮实施边界：提供可持久化的本机会话重命名、当前项目会话查找与可读状态；对启动、切换、历史读取分别显示真实加载/失败与恢复；阅读旧消息时保留位置并提供回到最新入口。不会新增会话删除/归档或第三方仓库数据源，因为它们涉及持久状态与恢复语义，需要独立验收。

验证需要覆盖真实 SQLite 重开后的标题、草稿切换与错误恢复、桌面窗口中加载和会话操作。LinkCode 授权及跨系统资源对照仍由[桌面框架专项调研](2026-09-28-desktop-framework-memory-research.md)跟踪，不以参考仓库的实现推断本产品内存表现。
