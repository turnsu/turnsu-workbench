# PiAgent-backed Runtime Adoption

Date: 2026-05-27

## 结论

本轮后端与 Agent 能力补足不再继续自研完整 Agent runtime，而是采用 `@earendil-works/pi-coding-agent` 作为本地 daemon 的底层 session / ResourceLoader / extension / tool calling 能力。Swift 桌面端仍只负责 UI、状态展示和 runtime artifact 浏览；Node daemon 负责 Pi SDK 适配、工具执行、policy artifact 和 product mutation inbox。

## 直接采用

- Pi SDK：通过 `createAgentSession`、`DefaultResourceLoader`、`SessionManager` 创建本地 Agent session。
- Pi ResourceLoader：加载本项目 `agent-runtime/extensions/wechat-onchain-tools.ts`、`skills/`、`prompts/`。
- Pi extension tool 机制：首批微信 x 链上工具改为真实 `pi.registerTool(...)`，不再只是描述型 `.ts` contract。
- Pi package 约定：`agent-runtime/package.json` 固定依赖 `@earendil-works/pi-coding-agent@0.75.5` 和 `typebox@1.1.38`，安装使用 `--ignore-scripts`。

参考资料：

- Pi SDK: https://pi.dev/docs/latest/sdk
- Pi Packages: https://pi.dev/docs/latest/packages
- Pi Earendil 迁移说明: https://pi.dev/news/2026/5/7/pi-has-a-new-home

## 本地改造

- 当前 daemon 保留原 HTTP/SSE API：`/health`、`/capabilities`、`/sessions`、`/sessions/{id}/messages`、`/runs/{id}/events`、`pause/resume/cancel`。
- Daemon 内部新增 `PiBackedAgentRuntime`，启动时初始化 Pi SDK session，并禁用 `bash/edit/write` 等高权限 built-in 工具。
- DeepSeek/Kimi provider 继续沿用本项目环境变量配置与 redaction 规则；Pi SDK 用作 Agent kernel 和 tool runtime，不强行改写现有 provider adapter。
- Pi tools 写入 `runtime/agent/runs/{runID}/product-mutations.json`，Swift `RuntimeBackend` 再按 runID 导入允许的本地对象。
- Product mutation 支持本地 `tasks/watchlistItems/crystals/proposals/memory/handoffs`，并用 `idempotencyKeys` 防止重复写入。
- `/health` 增加 `piRuntime` 与 `bridges` 状态，记录 SDK 版本、extension 加载、active tools、built-in tool 暴露状态和 bridge freshness。

## 暂不采用

- 不 shell out 到全局 `pi` CLI；避免桌面 UI 与 daemon 生命周期不可控。
- 不启用 Pi built-in `bash/edit/write`；第一阶段只启用本项目 custom tools。
- 不采用 `assignment-agent-raw` 中的 Feishu、Rokid、Office、ASR、live IM receive/send/publish 能力。
- 不引入 Docker worker、Hermes 自动学习和外部发布链路。
- 不运行真实微信读取、live wechat-cli、交易、发消息或外部发布。

## 风险与处理

- `@earendil-works/pi-coding-agent@0.75.5` 声明 Node `>=22.19.0`，当前本地 smoke 使用 Node `22.17.0` 可运行但存在兼容风险。后续应升级 Node 后再做 live provider smoke。
- Pi package extension 具备完整系统权限。本项目只加载仓库内的 `wechat-onchain-tools.ts`，并通过 policy 阻断高风险动作。
- Provider key 仍只读环境变量；runtime artifact 不记录 API key、Authorization header、cookie 或 raw request body。

## 验收记录

- `node domains/agent/code/agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check` 已验证 Pi runtime 初始化、extension 加载、custom tools 执行、policy/tool/model-route/product-mutation artifacts 写入。
- Smoke run 的 `model-route.json` 显示 `runtimeKernel=pi_sdk_backed`、Pi SDK 已初始化、注册项目工具、`bash/edit/write` 为 disabled。
- Smoke run 的 `product-mutations.json` 已写出 crystal、proposal、handoff、task，并保留 idempotency keys。
