# 系统架构

## 本地工作台

```text
Electron 桌面 / React
  → 隔离 preload IPC
  → 私有 Node Host
      → SQLite：项目、会话索引、草稿、Agent 偏好、可见消息与导入索引
      → 原生 Kimi Code / Codex / OpenCode / oh-my-pi / Pi / Claude Code 进程
      → 本机项目文件、用户选定的导入副本与 Skill OS
      → 可选微信桥 v1 交接消费者
      → 可选 Product API：显式共享的事项与资料
```

Electron 主进程只处理窗口、系统文件对话框、受限文件打开、团队授权和加密凭据。渲染器无 Node 权限，Host 不开放本机 HTTP 端口。主进程拒绝渲染器直接提交任意导入路径；导入先由系统对话框选择，再由 Host 校验普通文件、容量和目标目录。源文件不改写，同名导入不覆盖；团队共享项目禁止走此私有导入入口，以免文件被同步。项目成果由 Host 限定在当前项目内，主进程只允许常用文档类型交给系统默认应用，其他类型定位到文件夹。

Host 以 SQLite 保存可见工作状态和原生会话 ID，不复制用户全部原生历史。项目选择和会话索引不会启动所有 Agent；只有读取模型、执行或主动恢复时连接所选执行器。闲置连接可释放，运行中、待批准和停止中的连接保留。历史索引和消息分页，UI 只保留当前页与正在查看的一页；资源边界详见[会话与内存](memory.md)。

## Agent 与模型

| 执行器 | 原生接入 | 本版限制 |
| --- | --- | --- |
| Codex | App Server；原生 thread ID、事件与批准 | 原生 CLI 与账号仍需用户配置 |
| Pi | RPC；本机 session 文件与扩展请求 | 当前会话恢复可能读取该会话完整原生消息 |
| Claude Code | CLI SDK；原生 session ID、流和工具批准 | 原生账号及工具权限由用户控制 |
| OpenCode | ACP 私有 stdio；session/new、load、prompt、permission、cancel | 单次允许/拒绝；原生提供商或已选的 OpenAI Chat 兼容网关，权限与停止仍需桌面实测 |
| Kimi Code | `kimi acp` 私有 stdio；沿用 ACP 会话、模型、权限与停止 | 沿用其原生账号和模型配置；桌面已建会话并列出模型，实际任务被当前账号订阅权限 403 拒绝 |
| oh-my-pi | `omp acp` 私有 stdio；沿用 ACP 会话、模型、权限与停止 | 沿用其原生账号和模型配置；目前只有适配器行为测试，真实 CLI/模型任务待验收 |

Agent 和模型来源分开。现有模型连接可供明确支持该协议的执行器使用，密钥保存在系统保护的凭据存储中；更换模型端点不等于更换 Agent。OpenCode 可沿用原生提供商，也可选工作台中的 OpenAI Chat 兼容网关：Host 只为该进程注入临时提供商配置和密钥环境变量，不改写用户的全局 OpenCode 配置；Responses / Anthropic Messages 连接不会被伪装为 Chat。会话一旦开始，执行器、工作目录和模型来源不静默替换。无 Agent 或未登录时保留草稿并说明恢复动作。

Kimi Code 与 oh-my-pi 当前通过各自原生配置选择模型；工作台可读取 ACP 暴露的模型目录，但尚未给它们注入 Turnsu 模型网关。WorkBuddy 的[开放平台](https://open.workbuddy.cn/docs/third-party-app)提供经审核的第三方应用、OAuth 2.1 和本地助理/云端任务 API；其[Open API](https://open.workbuddy.cn/docs/openapi)不是本机 CLI stdio 协议。没有应用凭据及用户授权前，工作台不得在 Agent 选择器中声称能直接驱动 WorkBuddy，也不得借用其本地会话或权限。将来接入时应单列授权、结果和成本边界。

工作台不是第四套推理循环：各适配器拥有其原生协议差异，Host 统一管理项目、会话状态、可见事件、权限请求和资源回收。一个 Agent 不支持的工具或恢复能力必须明确显示，不伪造跨 Agent 无损迁移。跨 Agent 接续只传用户确认的目标、材料、结果和未决事项。

## 资料、权限与可选共享

项目文件只在用户打开或引用时读取。文本引用在发送时固定内容和哈希；大文件不直接塞进模型上下文。系统导入保留源文件，项目副本置于 `Imported/`；每次最多 10 个普通文件，单文件 32 MiB、总计 128 MiB。工作台不假装已经解析所有二进制文档；能否读取取决于所选 Agent 及已授权工具。

微信桥归档只有用户主动打开后才预览；工作台校验 v1 manifest、相对路径、大小与 SHA-256，保存本机私有快照，并区分收到、解析和本次引用的记录。导入本身不调用模型、不上云、不发微信。微信桥的原生分享入口由桥仓库拥有，本仓库只维护工作台消费者及本地任务接续。客服路径见[客服与微信桥](customer-service.md)。

团队连接为可选边界。Product API 拥有共享事项、成员权限、审批和回执，原生 Agent 拥有用户私有会话与上下文；共享时只传明确选定的资料、结果和版本。云端任务成功接收、执行结束、员工审核和业务系统写入分别确认。没有企业接口时，本地工作仍可完整运行，但不宣称云端客服或客户业务系统已接通。

## 源码职责

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | Electron、React、系统文件操作与安全 IPC |
| `packages/agent-host` | 本机状态、各 Agent 适配、资料引用、会话与资源回收 |
| `packages/agent-runtime` | 原生工具协议和受限执行能力 |
| `packages/contracts` / `packages/product-client` | 可选团队服务协议和客户端 |
| `services/product-api` / `apps/team-web` | 共享事项、权限、团队管理 |
| `deploy` | 可选服务部署 |

不在桌面构建中引入团队 Web 或服务端运行依赖。原生 Skill 导出保持对可执行内容、隐藏配置和外部依赖的拒绝边界；未来连接器须另行验证来源、权限和版本，不能借 Skill 安装绕过。
