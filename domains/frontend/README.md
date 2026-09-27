# 前端领域

当前首要产品入口是[Turnsu Desktop](desktop/code/turnsu-desktop/README.md)，独立 React 界面经本机 Host 操作真实项目和用户自己的 Agent。[Web 工作台](web/README.md)保留已接入 Product API 的团队能力；旧 app/Swift 资料只是历史背景。

- [产品方向](../../PRODUCT.md)与[Master PRD v0.6](../../wiki/prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md)
- [当前架构事实](../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)
- [工作台与 Skill OS 迭代](../../wiki/design/2026-09-28-workbench-skillos-iteration-plan.md)
- [桌面 / 云端职责](../../wiki/architecture/desktop-cloud-boundary.md)

工作台先完成真实目录、Agent 任务、权限回应、文件结果和重开恢复；Skill OS 再把真实来源、版本、试做与复用形成清晰路径。Loop 管理保持简洁，复杂依赖编辑按需进入。可见控制必须有真实交互及对应的失败恢复；UI 构建通过不证明 native GUI、Product 授权或 Windows 体验。共享组件只在实际跨端消费者出现后提取。
