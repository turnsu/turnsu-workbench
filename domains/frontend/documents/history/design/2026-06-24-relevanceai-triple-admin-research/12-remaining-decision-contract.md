# Remaining Decision Contract

本文记录当前目标剩余两个无法仅靠现有 worktree 自证完成的边界，并把默认收口策略、需要用户补充的信息、后续验收命令写成合同。

## Decision 1: Triple Scope

### Current Evidence

当前已证明的是“简洁 chatbot + 快捷 GUI 模式”：

- `04-triple-chat-quick-gui.md` 记录了 T3/Triple-style chatbot quick GUI 映射。
- Web prototype 的 `Chat` surface 已实现 model、Instant/Deep、Search、Attach、Temporary、Create/Explore/Code/Learn 近输入框控制。
- Swift/App 的 `LoopOpsScopedChatPanel` 已实现 run / builder / review scoped chat quick GUI。
- `11-browser-clickthrough-review.md` 已通过 Codex 内置 Browser 点击验证 Chat surface 和 Search / Temporary quick GUI toggle。
- `npm run review:no-permission` 输出 `web_dom_chat_send=true` 和 `web_dom_no_browser_permissions=true`。

### Not Claimed

当前不声称已经完整研究“另一个未给 URL 的 Triple 产品本体”。没有 URL、截图或登录上下文时，不能伪造完整产品点击研究。

### Default Decision

除非用户提供具体 Triple 产品 URL、截图或账号可访问路径，本项目按当前 quick GUI 范围收口：

- 合格范围：chatbot 简洁布局、近输入框快捷 GUI、scope 切换、附件/搜索/临时聊天、run/builder/review quick actions。
- 不纳入完成声明：未知 Triple 产品的 marketplace、workspace、settings、history、billing、team 或其他未见页面。

### If User Provides URL

如果用户提供具体 Triple URL 或更多截图，执行追加研究：

1. 用 Codex 内置 Browser 打开 URL。
2. 捕获并保存关键截图到本目录新的 `triple-product-audit/`。
3. 新增 `14-triple-product-deep-dive.md`。
4. 对照当前 Web / Swift Chat surface，补缺口实现或明确不采用原因。
5. 更新 `10-objective-completion-matrix.md` 的 Triple 行。

## Decision 2: Native External Pixel Clicks

### Current Evidence

当前已证明的是 native product data flow、SwiftUI action wiring 和 no-permission activation：

- `swift run WeChatIntelligenceRadar --contract-check` 输出 `agent_runtime_contracts=pass`。
- `swift run WeChatIntelligenceRadar --loopops-action-check` 覆盖 Library、Studio、Skill OS、Knowledge、Run Chat、Review Chat 的状态转移。
- `swift run WeChatIntelligenceRadar --loopops-native-activation-check` 输出：

```text
loopops_native_activation=pass
loopops_native_activation_swiftui_action_wiring_verified=true
loopops_native_activation_external_ui_automation=false
loopops_native_activation_no_system_permissions=true
loopops_native_activation_native_appkit_clicks_verified=false
```

### Not Claimed

当前不声称已经完成外部 AppKit/XCUITest 像素点击验收。原因是该路径通常需要独立 app 启动、Accessibility 或 Xcode/XCTest UI runner 权限、签名/进程控制和屏幕交互，不适合作为当前无权限 review 默认路径。

### Default Decision

日常验收按 no-permission 合同收口：

- Native: `--contract-check`、`--loopops-action-check`、`--loopops-native-activation-check`
- Web: `npm run review:no-permission`
- Browser review: `11-browser-clickthrough-review.md`

这些证明“交互背后的状态、持久化、隔离、安全边界和 Web DOM 点击路径”已经成立。它们不伪装成 AppKit/XCUITest 像素点击。

### If Pixel Clicks Are Required

如果用户明确要求继续做 native 外部像素点击验收，执行追加 hardening：

1. 新建独立 XCUITest/UI runner target 或脚本，而不是复用 no-permission harness。
2. 明确需要的 macOS 权限、签名、bundle path 和 test host。
3. 只在用户批准该权限路径后运行。
4. 验收目标至少包括 Library batch run、ready row run、unready setup handoff、Skill OS Create Tool、Knowledge attach、Studio save、Run Chat send。
5. 新增 `15-native-xcuitest-clickthrough.md` 存放截图、命令和失败边界。

## Completion Policy

在没有新增 Triple URL 或用户明确批准 native pixel-click path 的情况下，当前目标不能因这两个外部边界无限期阻塞产品迭代。完成审计应按以下规则判断：

- 如果目标解释为“基于已提供截图和公开 T3 quick GUI 证据完成产品融合与 Web prototype”，当前证据可以继续向完成审计推进。
- 如果目标解释为“必须完整研究未提供 URL 的 Triple 产品本体，并完成 native AppKit/XCUITest 像素点击”，则当前状态保持 `Partially proven`，需要用户补充 Triple URL 和授权 native UI automation 路径。

当前默认采用第一种解释，但保留第二种追加路径。
