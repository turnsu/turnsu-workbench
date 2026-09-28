# Turnsu 工作台 · 界面与体验约束

产品入口和优先顺序见[Master PRD v0.6](wiki/prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md)及[当前迭代方案](wiki/design/2026-09-28-workbench-skillos-iteration-plan.md)；实现事实见[Current System Architecture](wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)。本页不是第二份 PRD。

桌面界面以工作台和 Skill OS 两个一级入口组织。左侧是项目与会话，中间是正在完成的工作，文件与成果在需要时打开；Agent、模型、引用和共享范围紧靠发送动作。权限回应、失败和恢复是任务的一部分，不藏到诊断面板。空态只提供可执行的开始动作，不展示虚构统计。Loop 是 Skill OS 的次级管理入口，列表保持精简；复杂作者编辑仍可进入原有依赖画布。

公司脚手架的 React 组件和主题按固定版本选用。复用交互结构、焦点和密度，而不是复制后台菜单、假数据、整套 SSR 路由或演示页。保留来源许可；组件替换不得改变草稿、流式消息、中文输入法、权限弹窗、文件引用和真实 Product 调用的语义。现有 Turnsu 品牌资产可继续使用。

桌面验收要操作真实目录、原生 Agent、文件结果和重开恢复，并在 macOS 与 Windows 分别检查窗口、输入、缩放、键盘、无障碍和长历史。Web 已有 Agent/Work/Skills/Loops 等路由仍需保持可用；Web 的 M5 设计包是既有页面证据，不再定义桌面主导航。Web 的共享路径需由同源 Product API 和隔离 PostgreSQL 验证。构建、DOM、静态截图或受控 provider 只能证明各自层面的事情。

已有工作流画布保留真实依赖编辑与上下文设置；Loop 管理首页不因此暴露编译字段、节点配置和原始 JSON。操作必须有明确可用、禁用、加载、失败与恢复状态。

## 模型连接

模型来源在任务输入处明确显示，默认跟随原生 Agent。选择公司网关后再读取模型，不把目录可读等同于推理可用；失败时保留输入并给出可恢复原因。设置仅呈现工作台需要的连接、协议和模型，不引入网关渠道/计费管理。绑定后的会话不静默改发其他服务；保存后的密钥不回显。
