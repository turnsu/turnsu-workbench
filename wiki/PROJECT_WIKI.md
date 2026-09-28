# Turnsu 工作台 · 项目 Wiki

更新：2026-09-28

Turnsu 工作台以本地桌面项目为入口：打开真实目录，使用自己的 Codex、Claude Code 或 Pi 完成任务，查看文件与结果，关闭后继续。有效方法进入 Skill OS；只有需要多步骤复用时才整理成 Loop。约八人团队可在明确授权的共享项目里接力，个人原生会话、凭据和私有文件不因连接团队而自动共享。

## 从哪里读起

| 问题 | 权威入口 |
| --- | --- |
| 产品要做什么、用户路径和边界 | [Master PRD v0.6](prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md)；[产品摘要](../PRODUCT.md) |
| 现在真正实现了什么、证据与缺口 | [Current System Architecture](architecture/CURRENT_SYSTEM_ARCHITECTURE.md) |
| 下一轮工作台、Skill OS、极简 Loop 怎样迭代 | [2026-09-28 迭代方案](design/2026-09-28-workbench-skillos-iteration-plan.md) |
| 桌面外壳和 WorkBuddy 内存如何判断 | [2026-09-28 专项调研](design/2026-09-28-desktop-framework-memory-research.md) |
| turnsu 其他仓库能融合什么 | [组织仓库融合核查](design/2026-09-28-turnsu-repository-fusion-review.md) |
| 本机与云端谁持有数据和执行 | [桌面 / 云端职责边界](architecture/desktop-cloud-boundary.md) |
| 开发与验收必须遵守什么 | [仓库开发约束](../AGENTS.md)；[界面约束](../DESIGN.md) |

PRD 定义目标，不证明已交付；架构文档记录现状，不替代产品决策。9 月 28 日方案是当前迭代顺序，实际完成度只按真实入口、持久化、平台与用户操作证据更新。

## 当前产品地图

- **工作台**：项目 / 会话导航、任务输入、Agent 与模型选择、原处处理提问和权限、按需查看文件与成果。个人本地路径无需 Turnsu 云端登录。
- **Skill OS**：从已有成果整理方法，区分本机、项目和团队固定版本；查看、试做、在另一任务复用，以及经授权发布。当前桌面已有部分本地整理与团队方法入口，统一目录仍是待建设能力。
- **Loop**：Skill OS 下的可复用流程。管理首页保持简洁；复杂依赖才打开图形编辑。本机试做与团队云端运行的授权、状态和执行位置必须分别显示。
- **共享项目**：Product API / PostgreSQL 管理成员、Work Item、授权、版本和共享结果；本机 Host 管理原生 Agent 进程、会话、草稿与待同步状态。同步和接力不等于上传私人原生历史。

现有独立桌面客户端、Web 工作台、Product API 和 Agent Runtime 的具体能力与未验证项目，见[架构现状](architecture/CURRENT_SYSTEM_ARCHITECTURE.md)。Tauri 2 是当前桌面实现，不是长期架构限制；外壳决策须经过同工作负载的 macOS / Windows 验证。

## 文档导航

- [需求索引](prd/README.md)：当前 PRD 与历史裁决。
- [设计索引](design/README.md)：本轮方案、桌面调研、交互研究与旧设计包。
- [架构索引](architecture/README.md)：现状、桌面 / 云端职责和后端边界。
- [计划索引](plan/README.md)：当前迭代顺序及旧阶段计划。
- [状态索引](state/README.md)：只指向现状，不另建进度台账。
- [QA 索引](qa/README.md)：按实际候选和环境区分证据。
- [历史资料](history/)：保留但不控制当前产品方向。

仓库中的 looloomi 文件名、数据库名和迁移标识仍可能作为兼容标识存在；不要为品牌改名而改写持久化身份或历史链接。
