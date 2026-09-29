# 开发指南

下面命令对应当前实现。本地 To B 交付遵循[本地交付计划](roadmap.md)和[开发约束](../AGENTS.md)。可选团队与客户业务连接只有经过真实路径验收后才能列为可用能力。

## 桌面

使用 Node.js ≥22.19，执行 `npm run setup` 安装各独立包的锁定依赖，并构建共享协议。然后执行 `npm start`。开发源码在 `apps/desktop`；本地状态与原生 Agent 在 `packages/agent-host`。

- `npm test`：Host 的 SQLite / 文件 / 协议回归，以及桌面桥接与刷新回归。
- `npm run build`：桌面 UI 和私有 Host 独立构建，无需团队 Web 或 PostgreSQL。
- `npm run test:electron --prefix apps/desktop`：真实 Electron 的 Host 与系统凭据边界检查。
- `npm run package --prefix apps/desktop -- --platform=darwin --arch=arm64`：macOS 包。
- `npm run package --prefix apps/desktop -- --platform=win32 --arch=x64`：Windows 包；跨平台打包不能代替 Windows 设备验收。

桌面数据默认放在系统应用数据目录下的 `ai.turnsu.desktop`，保留既有安装的数据位置。`TURNSU_DESKTOP_STATE` 只用于隔离开发 / 验收目录。不要让两个进程打开同一数据库；Host 有独占锁。密钥存入操作系统保护的凭据文件，不写入 SQLite 或日志。

模型连接在桌面设置中配置。Codex 使用 Responses，Claude Code 使用 Anthropic Messages，Pi 支持界面列出的兼容协议；OpenCode 通过 ACP 使用原生提供商或工作台已选的 OpenAI Chat 兼容网关。网关目录和 OpenCode 会话模型识别已在受控环境检查，真实公司网关推理仍未验收。模型目录检查本身不能代替推理验收。

## Linux 开发机验证

Linux 开发机可在隔离目录使用 Node.js ≥22.19 或一次性 Node 容器安装锁定依赖，执行 `npm run setup`、`npm test`、`npm run build`。这验证 Host、桌面逻辑和构建，不安装 macOS 客户端，也不启动现有企业服务。安装 OpenCode CLI 后可运行 `TURNSU_OPENCODE_BIN=/path/to/opencode node packages/agent-host/test/opencode-native-smoke.mjs`，验证 ACP 建会话和恢复；加 `TURNSU_OPENCODE_TEST_TURN=1` 会发送一条合成模型任务；加 `TURNSU_OPENCODE_TEST_GATEWAY=1 TURNSU_OPENCODE_GATEWAY_TURN=1` 会用本机合成 Chat 网关验证实际请求。`PATH` 中可找到 CLI 且模型可用时，`node packages/agent-host/test/opencode-host-smoke.mjs` 会在临时项目完成读写文件、Host 重开和续跑。测试中的 SQLite、微信桥样本和项目目录必须来自临时目录；不要把客户聊天或密钥复制到测试镜像。真实 macOS 微信分享、Windows 桌面交互与发行签名分别在对应系统验收。

## 可选团队服务

执行 `npm run setup -- --team`。按 `.env.example` 配置独立 PostgreSQL、对象存储和服务密钥，运行 `scripts/start-workbench-server.sh`。生产部署必须保留 TLS、服务端授权、幂等、事务及持久化边界。新工作区从空内容开始；测试样例不得自动出现在用户项目。

## CI 与交付构建验证

GitHub Actions 的 `Verify workbench` 在指向 `main` 的 PR、推送 `main` 和手动触发时运行。Linux 分别验证本地 Host／桌面逻辑、1 万条会话下的启动、分页和 Host 内存预算、构建后 Agent runtime 的实际运行，以及可选团队服务、Web、隔离 PostgreSQL 行为；Worker 镜像构建后还运行真实非特权容器中的 Pi 会话和动态子任务，验证产品网关、结果、会话记录保存与清理。macOS 与 Windows runner 安装锁定依赖、运行本地测试与真实 Electron Host／系统凭据检查，并生成桌面开发包。`main` 的无签名开发包保存在限时 7 天的 Actions artifact 中供检查。流程不使用客户凭据，不部署服务，也不发布正式安装包。Host 的合成内存预算不代表包含 Electron Renderer 和原生 Agent 的长时资源验收；跨平台打包和 Electron 无窗口检查也不能替代客户机器上的完整界面、真实 Agent 登录与权限、签名、公证、升级验收。

`npm run test:team` 检查服务端与团队 Web；真实 PostgreSQL 验证使用 `npm run test:postgres:isolated --prefix services/product-api`。原生连接器仅用于用户主动授权的团队连接。

Agent Worker 镜像从仓库根目录构建：`docker build -f deploy/agent-image/Dockerfile .`。配置不可变镜像摘要后才可在团队执行服务中启用。普通桌面任务不要求 Docker。

## 提交

先检查差异与受影响调用方；测试使用临时目录或 `_test` 数据库。只提交源码、必要测试、锁文件和当前文档。构建产物、截图库存、运行日志、会话、凭据及私人项目材料不进入仓库。

跨仓库修改按职责提交：工作台保存导入消费者与客服能力，微信桥保存原生分享与交接生产者，固定兼容版本后联合验收。不要将整个桥仓库、旧应答 UI 或客户数据复制进来；协议变更同时检查旧接收方。
