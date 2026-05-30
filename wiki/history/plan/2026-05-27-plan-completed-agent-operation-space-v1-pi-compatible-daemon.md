# 2026-05-27 Agent 操作空间 v1：Pi-Compatible Daemon + Chat Stream

## Summary

本轮把 `Agent 操作台` 从 pipeline/log 监控页升级为本地 Agent 工作空间 v1。实现采用 Swift 桌面端 + 本地 Node daemon：Swift 负责 UI、交互和 artifact 展示；`agent-runtime/` 负责 Pi-style capability/skill/extension 镜像、HTTP/SSE API、长期任务、tool call、policy、provider readiness 和 run artifact。

安全边界保持不变：不运行真实微信读取、不运行 live `wechat-cli`、不交易、不发消息、不发布外部内容。DeepSeek/Kimi key 只允许通过环境变量读取，不写入代码、wiki、runtime 或日志。

## Implemented

- 新增 `agent-runtime/`：
  - `bin/wechat-agent-daemon.mjs` 提供 `GET /health`、`GET /capabilities`、`POST /sessions`、`GET /sessions/{id}`、`POST /sessions/{id}/messages`、`GET /runs/{id}/events`、`pause/resume/cancel`。
  - `runtime/capability-registry.json` 定义 Pi-style capabilities 和工具 manifest。
  - `runtime/model-providers.json` 定义 DeepSeek 文本/工具调用和 Kimi 图片分析 provider routing。
  - `extensions/`、`skills/`、`prompts/` 保持 Pi package 镜像结构。
- 新增 daemon 脚本：
  - `scripts/start-agent-daemon.sh`
  - `scripts/stop-agent-daemon.sh`
- 新增 runtime artifacts：
  - `runtime/agent/sessions/{sessionID}.json`
  - `runtime/agent/tasks/{taskID}.json`
  - `runtime/agent/runs/{runID}/events.ndjson`
  - `planner-envelope.json`
  - `tool-calls.json`
  - `model-route.json`
  - `attachments.json`
  - `policy-decisions.json`
  - `final-output.md`
- 新增 Swift 端 Agent workspace：
  - models: `AgentDaemonStatus`、`AgentSession`、`AgentMessage`、`AgentAttachment`、`AgentStreamEvent`、`AgentToolManifest`、`AgentToolCallRecord`、`AgentLongTask`。
  - services: `AgentDaemonClient`、`AgentStreamStore`、`AgentAttachmentStore`、`AgentToolRegistryStore`。
  - UI: Agent sessions、长期任务、插件/skill palette、Chat Stream、Composer、Agent Inspector、Agent Run Deck。
- 图片输入：
  - 通过文件选择加入图片。
  - 图片复制到 `runtime/agent/attachments/{attachmentID}/original.*`。
  - 写入 sha256、mime、size、artifact path。
  - 默认选中 `image.analyze_with_kimi`。

## Policy / Provider Rules

- 本地 runtime 读写工具：`pass`。
- `image.analyze_with_kimi`：按用户偏好设为 `pass`，但记录附件 hash 和 policy decision。
- `computer_use.request`：`needs_confirmation`，v1 不执行真实 Computer Use。
- live WeChat、live `wechat-cli`、trade、send message、publish external：`blocked`。
- provider 不可用时显示 `blocked_missing_provider_config` / missing env，不冒充真实 LLM。
- `DEEPSEEK_API_KEY`、`KIMI_API_KEY` 等 key 必须来自环境变量；用户此前在聊天中暴露过 key，生产使用前应轮换。

## Verification

- `node agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check`: pass，生成 `session-c63d1efb-f808-471c-9ceb-27029a10a0f1`、`run-92d7caa7-fd1f-4228-8999-a076f2abe444`、`task-0bece959-56a9-42f0-a329-13668a439454`。
- `GET /health`: pass，返回 daemon 状态、provider readiness、capability registry、tool manifest 和 policy matrix。
- `swift build --scratch-path /private/tmp/wechat-radar-build`: pass，`Build complete! (11.63s)`；后续 bundle 脚本 build `0.34s`。
- `swift test --scratch-path /private/tmp/wechat-radar-test-build`: pass，`Build complete! (12.74s)`。
- `scripts/build-debug-app-bundle.sh`: pass。
- `.build/debug-app/WeChatIntelligenceRadar.app/Contents/MacOS/WeChatIntelligenceRadar --ui-smoke-check`: pass，`ui_smoke=pass`，`windowNumber=243957`。
- Secret scan: no user-provided API key found in `agent-runtime`、`Sources`、`wiki`、`scripts` or `runtime/agent`; code contains only env variable names and redaction logic.

## Known Limitations

- 当前 daemon 在 Codex sandbox 后台脚本验证中会被执行环境回收；以前台 daemon 验证 HTTP health 成功。用户本机终端直接运行 `scripts/start-agent-daemon.sh` 应按普通 `nohup` 后台进程工作。
- v1 没有实现 LaunchAgent/system daemon。
- v1 没有执行真实 Computer Use，只生成 `needs_confirmation` 工具建议。
- Kimi 图片分析和 DeepSeek streaming 的 live smoke 需要用户在本机环境变量中配置已轮换的 key 后再执行。
