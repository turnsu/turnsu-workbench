# 开发指南

下面命令对应当前实现。To B、客服与微信桥接入遵循[待确认迭代计划](roadmap.md)和[开发约束](../AGENTS.md)；本轮只更新文档，用户确认后再执行开发。不要把规划中的受管安装或企业配置写成已经可用的命令。

## 桌面

使用 Node.js ≥22.19，执行 `npm run setup` 安装各独立包的锁定依赖，并构建共享协议。然后执行 `npm start`。开发源码在 `apps/desktop`；本地状态与原生 Agent 在 `packages/agent-host`。

- `npm test`：Host 的 SQLite / 文件 / 协议回归，以及桌面桥接与刷新回归。
- `npm run build`：桌面 UI 和私有 Host 独立构建，无需团队 Web 或 PostgreSQL。
- `npm run test:electron --prefix apps/desktop`：真实 Electron 的 Host 与系统凭据边界检查。
- `npm run package --prefix apps/desktop -- --platform=darwin --arch=arm64`：macOS 包。
- `npm run package --prefix apps/desktop -- --platform=win32 --arch=x64`：Windows 包；跨平台打包不能代替 Windows 设备验收。

桌面数据默认放在系统应用数据目录下的 `ai.turnsu.desktop`，保留既有安装的数据位置。`TURNSU_DESKTOP_STATE` 只用于隔离开发 / 验收目录。不要让两个进程打开同一数据库；Host 有独占锁。密钥存入操作系统保护的凭据文件，不写入 SQLite 或日志。

模型连接在桌面设置中配置。Codex 使用 Responses，Claude Code 使用 Anthropic Messages，Pi 支持界面列出的兼容协议。模型目录检查仅证明目录可读取，不能代替真实推理验收。

## 可选团队服务

执行 `npm run setup -- --team`。按 `.env.example` 配置独立 PostgreSQL、对象存储和服务密钥，运行 `scripts/start-workbench-server.sh`。生产部署必须保留 TLS、服务端授权、幂等、事务及持久化边界。新工作区从空内容开始；测试样例不得自动出现在用户项目。

`npm run test:team` 检查服务端与团队 Web；真实 PostgreSQL 验证使用 `npm run test:postgres:isolated --prefix services/product-api`。原生连接器仅用于用户主动授权的团队连接。

Agent Worker 镜像从仓库根目录构建：`docker build -f deploy/agent-image/Dockerfile .`。配置不可变镜像摘要后才可在团队执行服务中启用。普通桌面任务不要求 Docker。

## 提交

先检查差异与受影响调用方；测试使用临时目录或 `_test` 数据库。只提交源码、必要测试、锁文件和当前文档。构建产物、截图库存、运行日志、会话、凭据及私人项目材料不进入仓库。

跨仓库修改按职责提交：工作台保存导入消费者与客服能力，微信桥保存原生分享与交接生产者，固定兼容版本后联合验收。不要将整个桥仓库、旧应答 UI 或客户数据复制进来；协议变更同时检查旧接收方。
