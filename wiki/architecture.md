# 系统架构

```text
Electron 桌面 / React
  → 隔离 preload IPC
  → 私有 Node Host
      → 本地 SQLite（项目、会话索引、草稿、可见消息）
      → 原生 Pi / Claude Code / Codex
      → 本机项目文件与 Skill
      → 可选 Product API（显式共享）

团队 Web → Product API → PostgreSQL / 执行控制 / Worker
```

桌面主进程管理窗口、文件选择器和系统加密凭据。渲染器没有 Node 权限；Host 不暴露公共 HTTP 端口。密钥不进入 SQLite、团队存储或 UI 日志。模型来源按会话固定，不能静默切换。

原生 Agent 拥有执行上下文、权限行为与原生会话文件。Host 保存原生会话 ID 和可见结果，以便连接回收后继续任务；它不复制用户全部 Agent 历史。原生模型执行可能按 Agent 自己的策略读取当前会话，其内存不能用 UI 分页上限推断。

团队服务只接收用户显式共享的工作、版本、文件和结果。服务端验证成员权限、版本、幂等和回执；网络中断或结果不确定不能触发自动重复执行。登录和团队同步不作为本地任务的前提。

## 源码职责

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | 桌面界面、Electron、打包 |
| `packages/agent-host` | 私有本地状态、原生 Agent 接入、资源回收 |
| `packages/agent-runtime` | 原生工具协议、Skill 安装、受限执行与 Worker |
| `packages/contracts` / `packages/product-client` | 共享协议与团队服务客户端 |
| `packages/agent-kernel*` / `packages/product-bridge` / `packages/agent-plugins` | 可选团队执行的内核与授权接线 |
| `apps/team-web` | 团队管理界面 |
| `services/product-api` | 权限、共享对象、Skill / Loop 版本、执行与持久化 |
| `deploy` | 可选服务部署资源 |

资源策略见 [会话与内存](memory.md)，开发入口见 [开发指南](development.md)。
