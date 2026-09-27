# 项目领域

当前产品是[Turnsu 工作台](../PRODUCT.md)：本地桌面工作先可用，团队共享再通过现有 Product API 授权接力。[Master PRD v0.6](../wiki/prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md)定义目标，[架构现状](../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)定义已实现事实。

| 领域 | 当前职责 |
| --- | --- |
| [frontend/desktop](frontend/desktop/code/turnsu-desktop/README.md) | 独立桌面客户端；本地项目、会话、任务和结果的主要入口 |
| [frontend/web](frontend/web/README.md) | 已有 Web 工作台；继续维护已用的 Product 路径 |
| frontend/app | 历史 Swift 资料，不是当前桌面实现 |
| backend | Product API、PostgreSQL、授权、共享工作、固定版本和云端执行 |
| agent | 本机多 Agent Host 与受 Product 管理的 Worker / Runtime |

桌面与 Web 可以共享真实公共契约和经验证的组件，不应强行共享同一页面布局或把本机 Host 变成第二个 Product 控制面。历史路径和数据库身份保留兼容；具体开发约束见[AGENTS.md](../AGENTS.md)。
