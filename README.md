# Turnsu 工作台

Turnsu 工作台是桌面优先的本地 Agent 工作台：在真实项目中用自己的 Codex、Claude Code 或 Pi 完成工作，保留原生会话与本机文件，随后把有效方法沉淀为 Skill，并在需要多步骤复用时整理为 Loop。团队共享项目通过现有 Product API 明确授权和同步结果；连接团队不自动公开个人会话、凭据或目录。

## 从这里开始

- [项目 Wiki](wiki/PROJECT_WIKI.md)：需求、设计、架构、计划和验证入口。
- [Master PRD v0.6](wiki/prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md)：产品目标与边界。
- [Current System Architecture](wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)：已实现能力和未完成的真实验收。
- [工作台 / Skill OS / LOOP 迭代方案](wiki/design/2026-09-28-workbench-skillos-iteration-plan.md)：当前实施顺序。
- [桌面框架与内存调研](wiki/design/2026-09-28-desktop-framework-memory-research.md)：macOS / Windows 选型和资源验证方法。
- [开发约束](AGENTS.md)、[产品摘要](PRODUCT.md)、[界面约束](DESIGN.md)。

## 当前代码

| 部分 | 路径 | 责任 |
| --- | --- | --- |
| 桌面工作台 | [turnsu-desktop](domains/frontend/desktop/code/turnsu-desktop/README.md) | 当前 Tauri 2 + React 开发客户端；本地项目、对话和文件界面 |
| 本机 Agent Host | [local-agent-host](domains/agent/code/local-agent-host/) | 原生 Agent 协议、SQLite 会话关联、草稿与同步回执 |
| Product API | [workbench-server](domains/backend/code/workbench-server/) | PostgreSQL 中的团队授权、共享工作、固定版本和运行记录 |
| Web 工作台 | [web-prototype](domains/frontend/web/code/web-prototype/) | 已有 Web 功能；本轮不作为本地桌面主入口 |

Tauri 2 是现状而非固定架构。公司前端脚手架的组件与主题按固定版本选择性接入；完整应用路由、SSR 服务和演示数据不直接搬入桌面。平台迁移和内存优势须由相同工作负载的 macOS / Windows 实测决定。

## 本地桌面开发

先阅读[桌面构建与验证说明](domains/frontend/desktop/code/turnsu-desktop/README.md#build--run-macos)。目前有 macOS 开发包脚本，尚无经过真实设备验收的 Windows 分发。需要仓库 Node、Rust/Cargo、Xcode 命令行工具，以及用户自行安装并登录的 Agent CLI；本地任务不要求启动 Web、Docker 或 Turnsu 云端。开发包不等于签名公证的发行版。

## 团队 Product 服务

团队共享路径需要现有 Product 服务和独立的 PostgreSQL 数据源；它与本机 Agent Host 的 SQLite 职责不同。配置和运行以[后端说明](domains/backend/README.md)及[架构现状](wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)为准。测试只能使用明确命名的 _test 数据库和隔离运行目录，不要把历史 fixture 或构建通过当作真实协作验收。

仓库中保留的 looloomi 文件路径、数据库名称和迁移标识是兼容身份；品牌迁移不应破坏既有数据。
