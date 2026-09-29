# 团队 Product API

遵循根目录 AGENTS.md 与 wiki/architecture.md。

- 共享 schema 只由 `packages/contracts` 定义。
- HTTP、应用服务、PostgreSQL、执行与 Agent 适配器分层；权限检查必须落在真实服务入口。
- 原生会话和密钥不进入共享存储；运行事件持久化后才可发送给客户端。
- 不恢复旧业务 daemon，不引入非 PostgreSQL 生产 fallback。
- 测试只用隔离目录及 `_test` 数据库。API、数据库、真实 Worker / 模型验收分别声明。
