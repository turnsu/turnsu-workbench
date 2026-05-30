# Agent Runtime 与 Swift 前端适配审计与修复

Date: 2026-05-29

## 1. 背景结论

本轮审计确认：项目此前已经能通过 `session/messages/events/tool-calls/public-surface` 跑通 Agent 工作台，但 Swift 前端仍按早期兼容模型消费 Agent Runtime。Agent 端进入 Control Plane / Context Plane 后，Swift 缺少稳定 typed read-model、实时事件流、run manifest、上下文摘要和脱敏后的 tool-call contract。

本轮已修复为稳定适配层：

- 旧同步接口保留；
- 新增异步 run + SSE tail；
- 每次 run 有 `run-manifest.json` 统一索引；
- Swift 读取 manifest/control/context summary，而不是从事件字符串猜流程；
- 主界面只显示轻量状态，底层细节留在详情 artifact；
- `tool-calls.json` 不再包含大段 raw JSON preview 或私聊正文。

## 2. Agent Runtime 修复

### API

- 保留 `POST /sessions/{sessionID}/messages`。
- 新增 `POST /sessions/{sessionID}/messages/async`，立即返回：
  - `runID`
  - `taskID`
  - `session`
  - `task`
  - `eventsURL`
  - `artifactPath`
- `GET /runs/{runID}/events` 改为 tailing SSE：运行中持续推送，直到 `run.completed` / `run.failed` / `run.cancelled`。
- `POST /runs/{runID}/pause|resume|cancel` 写 `control-state.json`，run loop 在 tool 间读取控制状态。

### Artifact Contract

新增：

- `run-manifest.json`
- `control-summary.json`
- `context-summary.json`
- `tool-details/{toolCallID}.json`
- `control-state.json`

更新：

- `tool-calls.json` 只保存 `outputSummary`、`detailsArtifactPath`、`redactionStatus`。
- `policy-decisions.json` 增加 `displayTitle`、`displayReason`、`severity`、`publicSummary`。
- `wechat_cli.import_export_file` 的 tool intent 修正为 `import_user_or_fixture_wechat_export`。

### Safety

- tool detail artifact 只保存脱敏摘要。
- `text/content/excerpt/sender/from/authorization/cookie/apiKey/requestBody` 等字段会被 redacted。
- live WeChat、live wechat-cli、交易、发消息、外部发布仍 blocked。

## 3. Swift 适配修复

### Data Layer

新增 typed read-model：

- `AgentRunManifest`
- `AgentControlPlaneSummary`
- `AgentContextPlaneSummary`
- `AgentRuntimeStage`
- `AgentArtifactIndexItem`
- `AgentAsyncMessageResponse`

扩展：

- `AgentStreamEvent` 支持 `stage`、`action`、`actionIntent`、`riskLevel`、`artifactKind`、`contextSourceCount`、`contextChunkCount`。
- `AgentToolCallRecord` 支持 `detailsArtifactPath`、`redactionStatus`。
- `AgentPolicyDecision` 支持轻量展示字段。

新增：

- `AgentEventStreamClient`：通过 SSE 持续读取 run events。
- `AgentRuntimeStores` 增加 run manifest、control summary、context summary 读取。

### ViewModel / UI

- `submitAgentPrompt()` 改用 async run，提交后立即订阅 SSE。
- 终态事件到达后导入 `product-mutations.json`，并刷新 session/task/tool-call/read-model。
- `AgentWorkspaceStateAdapter` 使用 manifest/control/context summary 生成运行状态。
- 主界面显示：
  - 当前阶段；
  - 上下文数量；
  - 风险边界；
  - 运行结果。
- 详情抽屉可查看 artifact index，但不把 raw tool/provider/module 暴露为主界面入口。

## 4. 验收结果

Commands:

```bash
npm test
node agent-runtime/bin/wechat-agent-daemon.mjs --async-smoke-check
swift build --scratch-path /private/tmp/wechat-radar-build
swift test --scratch-path /private/tmp/wechat-radar-test-build
swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check
```

Results:

- `npm test`: pass.
- Control Plane smoke: `control_plane_smoke=pass`.
- Daemon sync smoke: `status=completed`, `runID=run-49d0ead1-6531-4f77-8457-8f0e4deee5d0`.
- Daemon async smoke: `async_smoke=pass`, `runID=run-545b75ea-5668-4b56-bb42-811520a97855`.
- Additional async smoke: `async_smoke=pass`, `runID=run-f9c85d7c-f653-4e5c-8d0d-46967e5bab89`.
- Swift build: `Build complete! (20.05s)`.
- Swift test: `Build complete! (22.43s)`.
- UI smoke: `ui_smoke=pass`, visible window title `WeChat Intelligence Radar`, workspace `Home`, window number `250657`.

Artifact evidence:

- `runtime/agent/runs/run-545b75ea-5668-4b56-bb42-811520a97855/run-manifest.json`
  - `status=completed`
  - `currentStage=final_output`
  - `internalToolsExposed=false`
  - `artifactCount=21`
  - `contextSummary.sourceCount=7`
  - `contextSummary.chunkCount=7`
- `tool-calls.json` only contains redacted summaries and `detailsArtifactPath`.
- `rg "BTC 今天讨论|ETH CA|sender|Authorization|sk-" tool-calls.json tool-details` returned no matches.
- `wechat_cli.import_export_file` intent is `import_user_or_fixture_wechat_export`.

Protected reference evidence:

- `git -C ../wechat-cli_raw status --short`: no changed files.
- Newer-file checks against `../assignment-agent-raw` and `../wechat-cli_raw`: no files.

## 5. Residual Risks

- Async execution is still sequential MVP, not production multi-worker scheduling.
- Pause/resume/cancel is checked between tool calls, not inside long-running individual provider calls.
- SSE tail is local daemon polling over `events.ndjson`; sufficient for MVP, not optimized for high-throughput streaming.
- Swift UI shows lightweight run context; full artifact browser remains intentionally out of main workspace.
