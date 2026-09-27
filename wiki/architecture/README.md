# 架构索引

- [Current System Architecture](CURRENT_SYSTEM_ARCHITECTURE.md)：实现现状、真实消费者、验证范围和缺口的唯一当前说明。
- [桌面 / 云端职责边界](desktop-cloud-boundary.md)：本机 Host / SQLite 与 Product API / PostgreSQL 的数据、执行和同步责任。
- [SkillOS / LoopOS 后端架构](2026-08-01-skillos-loopos-backend-architecture.md)：既有发布、编译、运行与授权模型。
- [桌面框架与内存调研](../design/2026-09-28-desktop-framework-memory-research.md)：外壳候选和待验证的资源假设。

目标以[Master PRD v0.6](../prd/2026-08-04-looloomi-team-intelligence-workspace-master-prd.md)为准。本机原生 Agent 会话不由云端 Product 接管；共享对象、授权与发布版本也不在桌面复制第二份权威。Tauri 2 是现状，不是必须维持的选型。

[2026-07-16 单机生产加固设计](2026-07-16-backend-agent-local-production-hardening-design.md)与[历史架构](../history/architecture/)保留为特定阶段依据，不决定当前桌面入口。
