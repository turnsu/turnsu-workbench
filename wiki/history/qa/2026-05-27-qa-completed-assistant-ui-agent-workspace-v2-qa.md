# 2026-05-27 Assistant-UI Agent Workspace V2 QA Record

## Scope

- Product under test: `wechat-intelligence-radar-mvp` Agent workspace v2.
- QA role: Subagent E drafted the acceptance matrix; MainAgent implemented, integrated, and verified the final record.
- Source plan: `wiki/history/plan/2026-05-27-plan-completed-assistant-ui-inspired-agent-chat-workspace.md`.
- Project wiki reference: `wiki/PROJECT_WIKI.md`, Checkpoint 12.
- Date/time: 2026-05-27, Asia/Hong_Kong.
- Write boundary: implementation stayed inside `wechat-intelligence-radar-mvp`; raw/reference directories remained read-only.

## Final Verification Result

| Check | Result |
| --- | --- |
| `swift build --scratch-path /private/tmp/wechat-radar-build` | Pass: `Build complete! (16.32s)` after final UI-smoke entry update. |
| `swift test --scratch-path /private/tmp/wechat-radar-test-build` | Pass: `Build complete! (15.63s)` with `checkAgentWorkspaceV2AdapterBuildsThreadAndApprovalCards`. |
| `node agent-runtime/bin/wechat-agent-daemon.mjs --smoke-check` | Pass: `run-9b49ebba-8540-43b1-ae24-301a148e87f6`, `status=completed`. |
| `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --smoke-check` | Pass: `run-4dd60389-5617-422c-90ad-e75a5e71827d`, `status=degraded`, `freshness=degraded`, artifact path emitted. |
| `swift run --scratch-path /private/tmp/wechat-radar-build WeChatIntelligenceRadar --ui-smoke-check` | Pass: visible window, `ui_smoke_workspace=Agent Console`, `ui_smoke=pass`, `windowNumber=244921`. |
| `scripts/build-debug-app-bundle.sh` | Pass: rebuilt `.build/debug-app/WeChatIntelligenceRadar.app`. |
| `.build/debug-app/WeChatIntelligenceRadar.app/Contents/MacOS/WeChatIntelligenceRadar --ui-smoke-check` | Pass: visible window, `ui_smoke_workspace=Agent Console`, `ui_smoke=pass`, `windowNumber=244931`. |
| `open -W -n .build/debug-app/WeChatIntelligenceRadar.app --args --ui-smoke-check` | Pass: LaunchServices user-style app launch exited successfully. |
| `git -C ../wechat-cli_raw status --short` | Pass: no output. |
| Raw/reference timestamp check | Pass: `find ../assignment-agent-raw ../wechat-cli_raw -type f -newer Sources/WeChatIntelligenceRadarApp/Models/AgentWorkspaceV2Models.swift -not -path '*/node_modules/*' -print` returned no files. |
| Secret scan | Pass: scan found only env var names/redaction logic; no raw `sk-...` key material. |

## Checkpoint Summary Draft

Assistant-UI inspired Agent workspace v2 should turn the existing Agent operation surface from a runtime/log-first panel into a thread-first working space. The expected product shape is:

- Center: task thread, assistant messages, plan summaries, inline capability-call cards, approval cards, evidence chips, final outputs, and composer.
- Left: current conversations, long tasks, selected context, common capabilities, memory, and handoffs.
- Right: collapsible Inspector for selected message, attachment, tool call, evidence, policy, or artifact details.
- Bottom: compact run status with current backend service state, active run state, active capability, and controls for pause/resume/cancel/details.

This checkpoint is not primarily about adding more agent capability. The main acceptance question is whether a user can naturally explain a task, attach context, see what the Agent is doing, approve or reject sensitive actions, inspect evidence, and recover long tasks without reading raw logs or memorizing run IDs.

## Product Acceptance

| ID | Acceptance target | Expected behavior | QA status |
| --- | --- | --- | --- |
| PROD-001 | First 5 seconds | Opening Agent workspace makes the task composer and thread-first workflow obvious. | Pending implementation verification |
| PROD-002 | Empty thread | Empty state offers task templates such as daily analysis, token check, image analysis, and long monitoring, and inserts the template into Composer instead of auto-running. | Pending implementation verification |
| PROD-003 | Composer composition | One Composer can show prompt text, image/file attachments, capability chips, context chips, model route, and submit state before the task starts. | Pending implementation verification |
| PROD-004 | Message flow | Agent output prioritizes user-readable plan summary, capability calls, evidence, result cards, and final recommendations. | Pending implementation verification |
| PROD-005 | Inline capability cards | Capability cards display preparing, running, waiting for approval, completed, failed, and blocked states with readable summaries. | Pending implementation verification |
| PROD-006 | Approval UX | Sensitive actions render as explicit approval or blocked cards explaining action, read/write scope, external-send risk, reason, and rejection outcome. | Pending implementation verification |
| PROD-007 | Evidence UX | Evidence chips and Inspector let users trace messages, attachments, tool results, policy decisions, artifact paths, and run IDs without making these fields the primary UI. | Pending implementation verification |
| PROD-008 | Long tasks | Long tasks are visible as task cards with objective, status, latest conclusion, and resume controls, not only as run IDs. | Pending implementation verification |
| PROD-009 | Copy and language | Main UI uses user-facing Chinese terms such as 能力调用, 安全边界, AI 模型, 记录文件, 运行状态, 后台服务, 对话任务, 处理进度, 情报卡. | Pending implementation verification |
| PROD-010 | Visual density | Logs, raw paths, technical IDs, and provider details are available in detail layers but do not dominate the main thread. | Pending implementation verification |

## Engineering Acceptance

| ID | Acceptance target | Expected behavior | QA status |
| --- | --- | --- | --- |
| ENG-001 | SwiftUI-native path | V2 is implemented as SwiftUI-native components unless a later explicit WebView decision is made. | Pending implementation verification |
| ENG-002 | Component boundary | Page, thread, composer, capability card, approval card, evidence, Inspector, and compact run status are separated into maintainable SwiftUI components or equivalent local patterns. | Pending implementation verification |
| ENG-003 | Runtime boundary | SwiftUI views consume `AgentDaemonClient`, runtime stores, and local artifacts through adapters; views do not call live MCP/RPC or real WeChat commands directly. | Pending implementation verification |
| ENG-004 | Event mapping | Daemon/SSE/runtime events are mapped into thread/message/part state before rendering, instead of leaking raw daemon events into the UI. | Pending implementation verification |
| ENG-005 | Attachment storage | Image/file attachments flow through the local attachment store, include hash/mime/size metadata, and show external-send state. | Pending implementation verification |
| ENG-006 | Details retained | `runID`, artifact path, policy decision, inputs summary, output summary, and error details remain preserved in Inspector/details. | Pending implementation verification |
| ENG-007 | Build gate | `swift build` passes from the project root. | Placeholder |
| ENG-008 | Test gate | `swift test` passes from the project root. | Placeholder |
| ENG-009 | Smoke gate | `--ui-smoke-check` verifies the Agent workspace v2 main path, not only the earlier dashboard or Crystal console. | Placeholder |

## Safety Acceptance

| ID | Acceptance target | Expected behavior | QA status |
| --- | --- | --- | --- |
| SAFE-001 | Live WeChat boundary | Real WeChat app access and live `wechat-cli` history/search/init remain blocked unless explicitly approved in a future policy change. | Pending verification |
| SAFE-002 | Raw directory protection | `wechat-cli_raw`, `assignment-agent-raw`, and other raw/reference directories are not written by this work. | Pending verification |
| SAFE-003 | Secret handling | Provider credentials are read only from environment/configured runtime boundaries; no API key is written to source, wiki, runtime artifact, or screenshot evidence. | Pending verification |
| SAFE-004 | External data send | Any action that may externalize image, file, chat, token, or user context has an approval card or blocked state with hash/source context. | Pending implementation verification |
| SAFE-005 | Computer control | Computer-use or desktop-control requests are approval-only and do not execute silently from the Agent workspace. | Pending implementation verification |
| SAFE-006 | Trading/publishing | Trading, sending messages, posting externally, or modifying third-party systems remain blocked or approval-gated. | Pending implementation verification |
| SAFE-007 | Degraded truthfulness | Missing providers, stale market data, unavailable Kimi vision, unavailable on-chain bridge, and blocked live WeChat are shown as degraded/blocked instead of being fabricated as fresh. | Pending implementation verification |

## Known Limitations

- This record verifies local MVP behavior and deterministic smoke paths; it is not a live DeepSeek/Kimi or real Computer Use execution test.
- The existing `PROJECT_WIKI.md` now needs the corresponding implementation checkpoint to distinguish the earlier plan record from this completed V2 pass.
- Direct Computer Use state capture has previously been unreliable for the macOS SwiftUI window; acceptance should prefer deterministic app-bundle launch smoke plus visible-window assertions, with screenshots as supporting evidence if needed.
- XCTest/Testing import availability has historically been limited in this local SwiftPM setup; `swift test` should still be run as the current compile/test gate, with smoke checks covering runtime behavior.
- Kimi vision, live on-chain providers, live WeChat reads, and external model routing may be unavailable or intentionally blocked depending on local environment variables and policy.
- Long-task persistence must be validated after closing and reopening the app; a single runtime artifact inspection is not enough for product acceptance.
- The product copy should continue to hide raw terms such as Tool Call, Policy, Provider, Artifact, Run Deck, Daemon, Session, Pipeline, and Crystal from the primary user path unless they are in technical details.

## Verification Command Placeholders

Run these after the implementation lands. Record actual command output, dates, and artifact paths in a follow-up QA pass.

| Check | Command | Expected result | Actual result |
| --- | --- | --- | --- |
| Build | `swift build` | Build completes successfully. | Pass |
| Tests | `swift test` | Test target builds/runs successfully under the local framework constraints. | Pass |
| Runtime smoke | `swift run WeChatIntelligenceRadar --smoke-check` | Runtime completes or degrades honestly with expected artifacts. | Pass |
| UI smoke | `swift run WeChatIntelligenceRadar --ui-smoke-check` | Visible window opens and asserts Agent workspace v2 main path. | Pass |
| App bundle build | `scripts/build-debug-app-bundle.sh` | Current executable is packaged into `.build/debug-app/WeChatIntelligenceRadar.app`. | Pass |
| App bundle UI smoke | `open -W -n .build/debug-app/WeChatIntelligenceRadar.app --args --ui-smoke-check` | User-style app launch verifies the same Agent workspace v2 path. | Pass |
| Protected raw dirs | `git -C ../wechat-cli_raw status --short` | No changed files. | Pass |
| Protected reference dirs | `find ../assignment-agent-raw ../wechat-cli_raw -type f -newer Sources/WeChatIntelligenceRadarApp/Models/AgentWorkspaceV2Models.swift -not -path '*/node_modules/*' -print` | No newly modified reference files. | Pass |
| QA document scope | `git status --short wiki/history/qa/2026-05-27-qa-completed-assistant-ui-agent-workspace-v2-qa.md` | Repo has no `.git` at project root; file is present and updated. | Pass |

## Follow-Up Wiki Checkpoint Text

If the implementation later passes the gates above, the project wiki can add a concise checkpoint note similar to:

```text
2026-05-27 Assistant-UI inspired Agent workspace v2 QA: verified the thread-first Agent workspace with composer-centered task submission, inline capability cards, approval cards, evidence Inspector, compact run status, and preserved safety boundaries for live WeChat, external data sends, secrets, and raw reference directories.
```

Do not add this completion note until the implementation and verification commands have actual evidence.
