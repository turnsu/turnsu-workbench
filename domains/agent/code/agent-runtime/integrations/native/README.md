# 用自己的 Agent 参与 Turnsu 团队工作

此开发版连接器把同一组 Product 工具暴露为 Codex/Claude Code 的 MCP 服务，或 Pi 的扩展。
它能读取获准访问的项目、工作项、共享结果，发现团队发布版本，准备自己的 Loop 副本、编译并发起共享执行，以及提交约定的交接内容。
每次调用仍由 Product 验证成员身份与访问权限。原生 Agent 的模型、文件与本地工具权限仍由原生客户端控制。

它支持标准指令型 Skill 的项目内固定版本安装；暂不提供专用运行环境/连接的原生绑定、另一成员的 Agent 托管执行或团队无人值守环境。MCP 工具可调用不等于原生模型已完成任务；Codex 已完成下述限定模型验收，Claude Code 与 Pi 尚未通过。

网页入口：团队资源库 → 技能详情 →「用自己的 Agent 使用」。下载包后按弹窗说明解压到项目目录；这是手动安装，不会创建 CLI 安装回执、自动覆盖已有技能或把结果自动共享给团队。依赖专用工具/运行环境的包会明确提示继续在 Turnsu 中使用。当前已验证浏览器取包和 ZIP 原始文件完整性，但内置浏览器未返回下载完成事件，文件实际落盘仍待验证。

## 工作台下载接入

在设置 → 我的 Agent →「连接我的 Agent」选择 Codex CLI、Claude Code 或 Pi。下载连接器 ZIP，
把其中 `turnsu-connector` 文件夹放进要工作的项目，在该项目终端运行页面给出的启动命令。
需要已安装的 Agent 与 Node 22.19+，无需 Turnsu 源码或 `npm install`。当前面向 macOS/Linux；Windows 未验收。

首次启动会给出浏览器授权链接；用自己的团队账户批准后打开所选 Agent。以后使用同一命令。
Codex 的 MCP 覆盖、Claude 的 `--mcp-config` 与 Pi 的扩展只用于这次启动，不修改全局配置，
也不改变原生 Agent 的模型登录或审批设置。连接凭证默认存入 `~/.turnsu/connections` 私有目录，
按 Turnsu 地址和 Agent 隔离，不放进项目目录；可通过 `--session` 使用单独的私有凭证文件。
关闭 Agent 不会撤销授权，网页设置可直接断开。连接失效时先撤销旧授权，再按包内 README 重新登录。

构建由 Web 的 `scripts/build-native-connector.mjs` 输出 ZIP、逐文件校验值和第三方许可，
只打包连接器与依赖，不包含用户配置、运行记录、原生模型或项目工作文件。
`npm run connector:check` 验证离开源码目录后的 CLI 启动与真实 Pi 0.85.1 扩展加载。
后端 B2 集成测试设置 `TURNSU_NATIVE_CONNECTOR_CLI=/absolute/extracted/turnsu.mjs` 后，
使用独立包完成真实 PKCE 登录、MCP 共享结果读取、幂等交接和撤权拒绝；不调用模型。

## 团队工作工具（当前源码）

`turnsu_create_work` 通过已有 Product 入口创建用户明确要求的团队工作；成员权限由 Product
校验。`turnsu_work_context` / `turnsu_work_updates` 读取获准的目标、决定和共享进展，
`turnsu_submit_update` 提交明确约定共享的更新。独立连接器不会自动公开原生会话。
桌面只有从「团队工作」新建或接续的对话会自动提交本次请求和最终答复，且会显示共享范围。
当前源码工具变更不代表此前下载的独立连接器包已经更新。

## 共享文件工具（当前源码）

`turnsu_project_files` 列出当前文件与未解决的冲突，`turnsu_project_file` 读取指定版本，
`turnsu_commit_project_file` 提交明确约定共享的文件。写入必须携带起始版本和稳定的幂等键；
并发修改保留为冲突，不覆盖先到达的版本。解决冲突时基于当前版本提交，并明确列出要解决的版本。
文件上限 8 MB；私有原生记录、凭据和未声明的文件不可上传。这些工具复用 Product 项目权限。
旧的已生成连接器 ZIP 不会自动包含新增工具，需要重新构建后才能分发。

## 源码开发接入

在已安装项目依赖并构建 `workbench-contracts`、`product-client` 的 checkout 中操作，要求 Node 22.19+。
下面的 `CONNECTOR` 指向本目录，`SESSION` 为每个原生客户端单独创建的绝对文件路径。父目录须已存在；不要将凭证文件放进 Git 或共享目录。

```sh
CONNECTOR="/absolute/checkout/domains/agent/code/agent-runtime/integrations/native"
SESSION="/absolute/private-directory/turnsu-codex.json"
node "$CONNECTOR/cli.mjs" login --url http://127.0.0.1:8798 --session "$SESSION"
```

终端会显示 Turnsu 授权链接。使用自己的成员账户在浏览器批准后，连接器通过本机回调与 PKCE 换取凭证，保存为仅本用户可读写的文件。不会读取原生 Agent 的登录凭证。

Codex（安装版本 0.150.1 的 CLI 参数已核对）：

```sh
codex mcp add turnsu -- node "$CONNECTOR/cli.mjs" mcp --session "$SESSION"
```

Claude Code（安装版本 2.1.132 的 CLI 参数已核对；使用独立 `SESSION` 重新登录）：

```sh
claude mcp add --scope local --transport stdio turnsu -- node "$CONNECTOR/cli.mjs" mcp --session "$SESSION"
```

Pi（扩展 API 对照项目固定的 0.85.1；使用独立 `SESSION` 重新登录）：

```sh
TURNSU_SESSION_FILE="$SESSION" pi --extension "$CONNECTOR/pi-entry.mjs"
```

可以向自己的 Agent 下达具体请求，例如：

> 查看 Turnsu 中我可访问的工作项，读取“每周反馈”的共享结果，提出三项改进建议。先把建议给我看；我确认后再提交到该工作项。

或者明确授权共享执行：

> 用团队发布的每周反馈 Loop v1.0.0，在我自己的执行配置下整理下面的反馈，并将输入与结果共享给这个工作项的成员。

服务不暴露通用 HTTP、Shell 或凭证工具。写操作要求稳定的 `idempotencyKey`，失败重试必须沿用；接受回执与运行完成不同，应读取 `turnsu_work_results` 跟进。

## 用自己的 Agent 安装团队技能

通过 `turnsu_methods` 选择一个明确发布版本，使用其 `releaseId`。关闭占用这个 `SESSION` 的 MCP/扩展进程，或为安装器单独登录一个私有凭证文件。

```sh
node "$CONNECTOR/cli.mjs" install-skill --session "$SESSION" \
  --agent codex --project /absolute/path/to/my-project --release release-id
```

`--agent` 可选 `codex`、`claude`、`pi`。分别安装到该项目的 `.agents/skills`、`.claude/skills`、`.pi/skills`，不改用户全局配置。安装保留发布包中的 `SKILL.md` 和引用文件原始字节；本地 `.turnsu-install.json` 保存来源和版本，只用于检测本地安装变化，不赋予 Product 权限。

重复安装同版本会核对文件并返回已有安装。更新必须明确指定新旧版本：

```sh
node "$CONNECTOR/cli.mjs" install-skill --session "$SESSION" \
  --agent codex --project /absolute/path/to/my-project --release new-release-id --replace old-release-id
```

同名非 Turnsu 技能、本地修改、新增文件或符号链接都会停止覆盖；先保存自己的修改，再选择另一个项目目录安装。安装中断遗留 `.turnsu-install.lock` 时先核对其中 PID 已退出，并检查项目下 `.turnsu-skill-stage-*` / `.turnsu-skill-backup-*`，不要直接删除含原版本的备份。

当前支持不依赖专用运行环境、可执行脚本、Product Tool 或 Connection 的指令型包；这些依赖未接通时返回明确错误，继续在 Turnsu 内使用。安装回执为 `nativeExecution: not_verified`，不会将下载或文件发现当成执行成功。原生模型和工具权限仍由各客户端管理。撤权可以禁止之后的下载，无法抹除已下载文件。

目录依据：[Codex Skills](https://learn.chatgpt.com/docs/build-skills)、[Claude Code Skills](https://code.claude.com/docs/en/skills)；Pi 以项目锁定的 0.85.1 包内 `docs/skills.md` 与实际技能加载器为准。

## 停用与故障恢复

关闭使用该连接的原生客户端后执行：

```sh
node "$CONNECTOR/cli.mjs" logout --session "$SESSION"
```

撤销成功才删除本地凭证。成员/工作项撤权由 Product 在之后的每次调用中重新校验；已读取的内容不会被远程抹除。

- 同一个凭证文件仅允许一个原生进程占用；Codex、Claude Code、Pi 各自登录，避免轮换凭证相互干扰。
- 意外退出留下 `.lock` 时，先确认文件内 PID 已退出，再移除这个锁文件。连接器不自行抢占其他进程的凭证。
- 刷新响应丢失会标记 `refreshPending`，之后拒绝重放旧 refresh token。使用新的文件路径重新登录，不把不确定刷新当成成功。
- 权限/模型/依赖不满足时原样失败，不换用发布者凭证、不切换 Agent、不自动进入同事的私人会话。

## 已有验证与尚缺验收

- 官方 MCP SDK 1.30.0 真实协议协商与工具调用；Pi 扩展使用相同工具定义。
- 独立 stdio 子进程 → 原生 Bearer HTTP → Product Application → 隔离 PostgreSQL：读取第二成员的共享 Loop 结果、交接写入、幂等重试、撤权后拒绝读取。
- 凭证权限、单进程占用、刷新不确定性检查。
- 2026-09-22：真实 Codex CLI 经本机 PKCE 登录、MCP 工具读取第二成员的共享结果与受众，并主动提交带精确结果的交接；隔离 PostgreSQL 验证只有一条记录，且没有把工作标记为已验收。退出码为 0。此验收使用合成资料，不代表已由原生 Agent 执行整个每周反馈工作流。
- 同日 Claude Code 模型账户返回 401，Pi 当前模型账户也返回 401，均未完成模型驱动验收。需各自恢复登录后重试，不自动替换用户凭证。
- 可选真实客户端验收：在 Workbench Server 包目录执行 `TURNSU_NATIVE_CLIENT_ACCEPTANCE=codex WORKBENCH_POSTGRES_TEST_FILE=tests/store/postgres-b2-loop-library-constraints.integration.test.mjs ../../../../.tooling/node/bin/node tests/store/run-isolated-postgres.mjs`。客户端值可用 `codex,claude,pi`；该选项会使用各客户端现有模型账户并消耗额度，默认测试不启用。
- 2026-09-22：另一成员通过真实 PKCE/Bearer HTTP 下载固定发布包；CLI 安装及 Codex/Claude/Pi 项目目录的原始文件、重复安装、显式更新、本地修改保护通过验证。Pi 0.85.1 加载器可识别安装的标准技能。私有草稿仍返回 404，撤销连接及暂停成员后禁止下载。
- 原生 Codex CLI 0.150.1 实际读取安装的 `SKILL.md` 和 `references/format.md`，根据合成反馈输出两条带原话依据的建议及未知频次。可在 Server 包目录运行 `TURNSU_NATIVE_SKILL_ACCEPTANCE=codex WORKBENCH_POSTGRES_TEST_FILE=tests/http/postgres-skill-upload.integration.test.mjs ../../../../.tooling/node/bin/node tests/store/run-isolated-postgres.mjs` 复现；该选项消耗现有 Codex 账户额度。
- 尚未验证：三种原生客户端完成整个每周反馈任务、专用依赖绑定、跨成员委托与常驻环境。不能用上述协议或限定模型测试替代这些验收。

协议依据：[MCP SDK](https://ts.sdk.modelcontextprotocol.io/)、[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)。Pi 扩展接口以项目安装包的 `docs/extensions.md` 为准。
