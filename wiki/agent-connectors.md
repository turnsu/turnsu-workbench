# 托管 Agent 接入运维

WorkBuddy 和 Muse 复用 Product API。普通本机 Agent、文件工具和本地计划不依赖这项服务。连接器不会自动创建客户账号、提交平台审核或把整个项目上传。

## 部署与密钥

按[开发指南](development.md)启动 PostgreSQL 与 Product API，设置 `WORKBENCH_PUBLIC_ORIGIN` 为实际 HTTPS 地址，启用已有桌面设备授权。迁移 046 创建客户范围内的账号、交接、事件、操作回执和本机请求；共享 Product Store 的事务与授权入口。

配置项：

| 配置 | 内容 |
| --- | --- |
| `TURNSU_CONNECTOR_SECRET_KEY_FILE` | Secret Store 挂载的文件，内容为 32 个随机字节的 base64；用于数据库凭据和交接内容的 AES-GCM 加密 |
| `TURNSU_WORKBUDDY_CLIENT_ID` | Turnsu 获批的第三方应用 ID |
| `TURNSU_WORKBUDDY_CLIENT_SECRET_FILE` | 应用密钥的 Secret Store 文件路径；不发给桌面 |
| `WORKBENCH_PUBLIC_ORIGIN` | 无路径的实际 HTTPS 服务 origin |

加密主密钥须与数据库一起备份，但分开保存。直接换掉它会使已有授权和材料无法解密；本轮不提供在线主密钥轮换。开发协议测试可使用进程内合成密钥；生产模式拒绝从明文环境变量读取上述密钥。部署不得记录请求正文、Authorization 或回调 query；反向代理访问日志需要去掉该回调的 query。

每个交接记录固定客户、用户、连接、执行器和原生 ID。接口要求已认证的桌面设备凭据，不接受浏览器 cookie 代替。重复 requestId 只返回同一回执；内容变化或结果不确定时拒绝重放。响应丢失后先查原任务，不能创建另一个任务来模拟恢复。

## WorkBuddy 平台配置

在[第三方应用后台流程](https://open.workbuddy.cn/docs/third-party-app)准备并审核 Turnsu 应用。回调登记为实际服务地址下的 `/api/workbench/v1/agent-connectors/callback/workbuddy`。应用介绍须说明：员工主动选择材料；默认只读取和调用已有本地助理；云端任务另行授权；可在工作台撤销接入；不会自动发送微信或读取全部电脑资料。

基础权限：`user.localassistant.readable`、`user.localassistant.invokable`。选择云端任务时追加 `user.task.readable`、`user.task.invokable`。不默认申请手机号或积分权限。

本地助理展示接口报告的在线状态；其共用消息流不能被表述为项目独立会话，也不承诺目录绑定或停止。云端任务先保存创建 ID，再等待执行环境就绪，使用官方配对 SSE/POST ACP 通道；单次权限需用户选择。实时通道丢失后不会重发 prompt，成果仍通过 REST 查询；用户核对最近一次输入后才能恢复工作台的完成/停止状态。

桌面授权成功、应用审核通过、协议替身测试通过均不是实际任务验收。正式启用前需用获批应用跑创建、追问、单次批准、停止、断线、撤销和下载，并核对平台返回的实际权限行为。[Open API](https://open.workbuddy.cn/docs/openapi)

## Muse 双向交接

在工作台创建专属连接器凭据后，将显示的 endpoint 和凭据配置到 Muse 平台的获批连接器中。凭据有效 30 天；数据库只保留其哈希，撤销后立即失效。尚未确认 Muse 官方登记与执行协议；下表是 **Turnsu 服务提供的合同**，不能据此宣称 Muse 已经原生接通。

所有调用向 endpoint 后追加 `/操作名`，使用 POST JSON 和 `Authorization: Bearer <连接器凭据>`：

| 操作 | 输入与效果 |
| --- | --- |
| `inbox` | 列出此连接器未结束的交接 ID |
| `pickup` | `taskId, confirmedByUser:true`；必须先在 Muse 确认，才返回主动选定的任务和文件 |
| `progress` / `result` | `taskId, eventId, text, attachments?`；eventId 去重，result 表示 Muse 报告完成；尚有本机请求时拒绝完成 |
| `local.request` | `taskId, requestId, tool, reason, arguments`；tool 只允许 documents/computer；进入工作台审批 |
| `local.result` | `taskId, requestId`；查询完成、拒绝、不确定或失败回执 |

本机批准必须同时满足当前项目的工具权限。结果丢失先复用本机回执，不再执行。超大截图和文件留在本机，不自动上云。当前只支持公开 HTTPS 成果下载地址；下载拒绝私有网络、重定向和越界文件。连接器需另外实现 Muse 官方要求的登记适配，真实双向联调前保持“等待接手”。[Muse 平台](https://muse.ai/platform)

## Manus 客户配置

个人账号使用官方 API v2 Key，保存在系统加密凭据文件中。Team 账号由客户管理员创建标准 `team` Open App，仅配置 `create_task`，登记桌面界面填写的精确 loopback 回调。桌面采用 S256 PKCE，不保存 client_secret；state 单次有效 10 分钟。授权、刷新、撤销与任务权限分别处理，刷新响应丢失后要求重新授权，不重复消费 refresh token。

普通 Team 应用仅限同一团队，不能作为所有客户的通用 Manus 登录。客户端不解析 JWT 隐藏字段，通过 `user.me` 核对稳定账号身份。实际 Team 账号联调前，PKCE 测试只算客户端协议与凭据持久化验收。[Manus Open App](https://open.manus.ai/docs/v2/open-app)

## 材料保留与当前限制

默认外发仅包含每次明确选定的提示词、引用、文件和版本摘要。交接有 30 天操作有效期；**有效期不是自动删除期限**，此版本保留加密历史以支持追溯。部署方必须按客户约定管理数据库备份和历史保留；未配置客户保留策略前不要接入敏感生产材料。主密钥轮换、客户自助彻底删除和官方 Muse 登记适配仍需单独验收，不隐藏为已完成。
