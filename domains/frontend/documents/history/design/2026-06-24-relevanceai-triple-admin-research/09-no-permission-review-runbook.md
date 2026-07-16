# No-Permission Review Runbook

本 runbook 收束 LoopOps 人工 review 和 smoke 验收路径，避免 macOS 反复弹出“允许访问”类提示。

## One Command

同时准备 Web 与 native 人工 review：

```bash
scripts/review-loopops-all.command
```

这个入口会运行 Web `npm run review:no-permission` 和 native `scripts/review-loopops-native.command`，最后打印 Web URL 或 offline HTML、native app bundle、native checklist 和 completion matrix。它不会调用 `open`、AppleScript、Chrome、Safari、Accessibility 或屏幕录制。

它同时会生成一次性的 review session 包：

```text
domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-*.md
domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-*.json
domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-*-web.log
domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-session-*-native.log
```

人工 review 时以 session Markdown 里的 `Web review URL` 或 `Web review offline HTML` 为准。不要假设固定是 `5184`；如果 Vite 因端口占用切到 `5189` 或其他端口，session 会记录实际入口。session 也会给出 native app bundle、native checklist、completion matrix 和推荐的 `record-loopops-review.command` 记录命令。

当前稳定人工 review 入口记录在：

```text
domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/review-sessions/loopops-server-handoff-2026-06-27-152603.md
```

该 handoff 确认 `http://127.0.0.1:5188/` 返回 `HTTP/1.1 200 OK`，临时 `5189` fallback 已关闭，且没有自动打开浏览器或 native app。

## Objective Audit

人工 review 前可以先跑完整本地 objective audit：

```bash
scripts/audit-loopops-objective.command
```

这个入口会检查研究文档、截图证据、Web smoke/action/no-permission review、Swift/native action wiring、review 脚本权限模型和 manual review record artifact，并输出：

```text
loopops_objective_audit=pass
loopops_objective_audit_no_system_permissions=true
loopops_objective_audit_external_ui_automation=false
loopops_objective_audit_native_appkit_clicks_verified=false
```

它只跑 CLI 和进程内 harness，不打开浏览器或 App，不使用 AppleScript、Chrome、Safari、Accessibility、屏幕录制或系统浏览器自动化。若需要节省时间跳过完整 `swift test`，可显式设置：

```bash
LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST=1 scripts/audit-loopops-objective.command
```

## Traceability Audit

只检查 agent-team 模块链路时使用：

```bash
scripts/verify-loopops-traceability.command
```

它会读取 `14-agent-team-traceability-matrix.md`，并确认 marketplace、knowledge/toast、tool/logs、Triple chat quick GUI、Workbench/Run Result、Studio skill path、no-permission review 和 agent-team process 八个模块都有研究文档、截图、Web/Swift 源码锚点、evidence receipts 和人工 review 路径。该入口同样只读本地文件，不打开浏览器或 App。

## Manual Result Record

人工 review 结束后，用本地脚本生成一份 timestamped 记录：

```bash
scripts/record-loopops-review.command
```

如果只需要打印当前 review 状态、pass / needs-work 记录命令和后续 gate 命令，不生成新 record，使用：

```bash
scripts/print-loopops-review-closeout.command
```

这个 helper 会读取最新 `review-records/`、当前 Web URL、human review gallery 和 native visual gallery，并打印可复制的 closeout 命令。它同样不会调用 `open`、AppleScript、Chrome、Safari、Accessibility、屏幕录制或系统浏览器自动化。

默认会在 `review-records/` 下生成 Markdown 与 JSON 两个文件，状态是 `pending-manual-review`，不会自动声明通过。需要写入 review 结果时使用环境变量：

```bash
LOOPOPS_REVIEW_STATUS=needs-work \
LOOPOPS_REVIEW_BLOCKERS="Native Studio path reorder needs polish" \
LOOPOPS_REVIEW_NOTES="Web passed, native needs visual review on Skill OS." \
scripts/record-loopops-review.command
```

这个记录入口同样不会调用 `open`、AppleScript、Chrome、Safari、Accessibility、屏幕录制或系统浏览器自动化。它只写入本地 review record，方便后续把人工 blockers 回填到 `08-evidence-receipts.md` 和 `10-objective-completion-matrix.md`。为避免误批准，`pass` 记录必须提供明确 reviewer notes 且 blockers 为空；`needs-work` / `blocked` / `fail` 记录必须提供具体 blockers。

## Web Review

首选入口：

```bash
scripts/review-loopops-web.command
```

这个入口只做两件事：

- 如果 `http://127.0.0.1:5184/` 已可访问且页面内容是 `LoopOps Admin`，直接打印 URL 并退出。
- 如果服务未运行，在 `web-prototype/` 内启动 `npm run review`。

它不会调用 `open`、AppleScript、Chrome、Safari、Accessibility、屏幕录制或系统浏览器自动化。

人工 review 首选地址通常为：

```text
http://127.0.0.1:5184/
```

如果 `5184` 已被占用，Vite 会在终端里打印新的 `Local:` 地址，例如本轮人工 review 使用的 `http://127.0.0.1:5189/`。这种情况下以终端打印的 `Local:` 地址或 `scripts/review-loopops-all.command` 生成的 session Markdown 为准，不需要改用系统浏览器或任何权限弹窗路径。

在 Codex sandbox 内直接绑定或探测 localhost 可能出现 `listen EPERM` 或连接失败；这属于 sandbox 网络限制，不是 macOS 隐私权限弹窗。需要人工 review 时，保持 no-permission 路径不变：用本地 server 的实际 `Local:` URL，或使用 offline HTML fallback，不改用 AppleScript、Accessibility、屏幕录制或系统浏览器自动化。

如果本地策略或 sandbox 禁止绑定 localhost，使用离线 fallback：

```bash
scripts/review-loopops-web-offline.command
```

它会构建单文件 review artifact：

```text
domains/frontend/web/code/web-prototype/dist/loopops-admin-offline.html
```

这个 fallback 不绑定端口、不启动系统浏览器、不调用 AppleScript、Chrome、Safari、Accessibility 或屏幕录制。它适合人工视觉/交互 review 的兜底路径；需要 WebKit DOM 点击链时仍使用可访问的本地 HTTP URL。

## Web Verification

无需打开任何浏览器的验收入口：

```bash
cd domains/frontend/web/code/web-prototype
npm run review:no-permission
```

它会执行：

- `npm run build`
- `npm run smoke`
- `npm run action:smoke`
- 生成 `dist/loopops-admin-offline.html` 离线 review artifact
- 检查 review server 优先绑定在 `127.0.0.1:5184`
- 检查 Web prototype 的 smoke/capture/action 脚本不包含系统级 automation 入口
- 如果本地 review server 可用，执行 WebKit DOM smoke
- 如果本地 review server 被端口策略阻止，尝试用 `file://.../loopops-admin-offline.html` 执行同一套 DOM smoke
- 如果当前 sandbox 的 WebKit file navigation 也被阻止，输出 `web_no_permission_review_server=offline_fallback`、`web_no_permission_review_dom_smoke_source=skipped_sandbox_file_navigation`，并保留 build/smoke/action/offline artifact 证据

## Native App Review

只构建、验证并打印人工 review 入口：

```bash
scripts/review-loopops-native.command
```

这个入口会输出 `.build/debug-app/WeChatIntelligenceRadar.app` 和 `13-native-manual-review-checklist.md`。它不会调用 `open`、AppleScript、Chrome、Safari、Accessibility 或屏幕录制。

无需打开 app 的 native action wiring 验收入口：

```bash
swift run WeChatIntelligenceRadar --loopops-native-activation-check
```

它覆盖关键 LoopOps review action 的进程内 SwiftUI action wiring，并明确输出 `external_ui_automation=false` 与 `native_appkit_clicks_verified=false`。该入口适合日常 no-permission 回归，但不能替代行为级 AppKit/XCUITest 像素点击验收。

`scripts/launch-app.command` 默认仍会构建并打开 native app。需要只构建、不打开、不关闭旧进程时使用：

```bash
LOOLOOMI_NO_OPEN=1 scripts/launch-app.command
```

需要打开 app 但不清理旧进程时使用：

```bash
LOOLOOMI_NO_KILL=1 scripts/launch-app.command
```

人工点击路径见：

```text
domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/13-native-manual-review-checklist.md
```

## Avoid

除非用户明确要求，不使用这些路径做常规 review：

- `osascript`
- `open -a Chrome` / `open -a Safari`
- `System Events`
- Accessibility / screen-control 自动点击
- 屏幕录制式验收
- 外部浏览器自动化
