# Implementation Acceptance Spec

本篇把前四篇研究转成 Swift/App 与 Web prototype 的验收点，并记录当前实现证据。本文不定义新的外部执行能力；所有 run、tool、knowledge 交互仍保持在现有 review-safe 边界内。

## 当前落地证据

- Swift/App：`LoopOpsModels.swift` 已包含 template listing、knowledge source、tool draft/log、run ledger、share-safe log preview、toast、quick action 等用户可见模型；`LoopOpsLocalStore.swift` 持久化 knowledge/tool/logs/skill stacks/run ledgers/share-safe logs；`LoopOpsViews.swift` 承载 Loop Library、Skill OS、Knowledge、Studio、Workbench、Run Result、Scoped Chat。
- Swift/App：Scoped Chat 已补近输入框 quick GUI，包含 model、Instant/Deep、Search、Temporary、Create/Explore/Code/Learn；`--ui-smoke-check` 输出 `ui_smoke_loopops_chat_quick_gui_visible=true`。
- Swift/App：本地 `LoopOpsToolDraft` 已合成为 Skill OS package，能进入 Skill OS、Workforce、Studio shelf；原生 `New Tool` 已对齐 Web 的 `Invent / Default / Import` 起点，并补齐 Tool name、Task description、Input scope 三个可编辑字段；`Import` 会创建 `Imported Review Tool` 并在 Tool Logs 写入 `Starting point: Import` 与 input scope，由 `--contract-check`、`--loopops-action-check`、`--loopops-interaction-coverage-check` 覆盖。
- Swift run 接线：`DashboardViewModel.runLoopContract(_:)` / `runLoopContracts(_:)` 复用现有 `postMessageAsync`，没有新增外部执行通道；Loop run 启动后会按 `runID -> contract` 写入本地 run ledger / share-safe preview，final read model 读到后刷新同一条记录。
- Swift run readiness：`LoopContract` 现在暴露 `readinessLabel`、`setupChecklistItems`、`setupPrompt`；`DashboardViewModel.runLoopContract(_:)` 统一拦截 unready contract，聚焦 Studio / Builder Chat、预填 setup prompt、写入 builder-scoped receipt，并且不生成后台 run。
- Swift run scope：`LoopOpsRunLaunchRequest` 保持默认 `contract:` 调用兼容，同时每次 launch 生成 `loop-run-{contractID}-{launchID}` 的实例级 chat scope；`--loopops-acceptance-check` 现覆盖 3 个 batch run 加同一 `crypto-market-report-loop` 的 2 次重复运行，并输出 `loopops_acceptance_same_contract_repeat_runs_isolated=true`、`loopops_acceptance_ledgers=5`。
- Swift/App Skill OS drop：`LoopOpsSkillPathDropResolver` 统一解析 `loopops-skill` / `loopops-stack` drop payload，修复“插入到 beforeID 前后又被旧 order 重排”的问题；`--loopops-action-check` 覆盖 skill payload 插入、已有 skill 拖拽移动去重、stack payload 展开、移除 skill path row 后保存重开，并输出 `loopops_action_skill_stack_drag_payload=true`、`loopops_action_skill_stack_drop_reorder=true`、`loopops_action_skill_stack_remove_persists=true`。
- Swift/App 持久化：`LoopOpsLocalStore` 已从分散 mirror 改为完整 strict snapshot 同步；review packet upsert 会自动推进同 run 的 ledger decision 和 share-safe preview，并写入 `LoopOpsLocalJSONStore`。`--loopops-action-check` 输出 `loopops_action_review_packet_upsert_updates_ledger=true` 与 `loopops_action_strict_snapshot_full_sync=true`。
- Swift/App 无权限 UI action contract：`--loopops-ui-action-check` 把 83 个 required interaction IDs、17 个动态 row/run/skill path/review IDs 与 33 条 `runActionChecks()` 状态转移绑定成同一条回归；`--loopops-interaction-coverage-check` 进一步枚举 27 个 native 关键交互，覆盖 Loop Library marketplace install、unready row 到 Studio / Builder Chat setup、Workbench Review Guide path/checklist、manual review record handoff、Skill OS Import 起点、Tool name / description / input scope 表单字段和 Tool Log source tag 的状态证明，确认每项都有 stable anchor、状态证明和 no-system-permission 运行方式；`--loopops-interaction-replay-check` 逐条输出同 27 个交互的 before/after 状态证据，并继续明确 `native_appkit_clicks_verified=false`，不把尚未完成的 AppKit/XCUITest 点击伪装成完成。
- Swift/App native activation：`--loopops-native-activation-check` 新增无权限进程内 action wiring 检查，覆盖 Loop Library batch run、row run、unready setup、Workbench active queue selection、Workbench Review Guide path/checklist、manual review record handoff、Skill OS Create Tool Default/Import/form fields/start 和 Run Chat send 共 12 个关键 review action。该入口输出 `external_ui_automation=false` 与 `native_appkit_clicks_verified=false`，证明 SwiftUI action wiring 与状态转移，不声称完成外部 AppKit/XCUITest 像素点击。
- Web prototype：`web-prototype/src/App.jsx` 已实现 `Workbench`、`Loop Library`、`Skill OS`、`Chat`、`Studio`、`Knowledge` 六个 review 状态；并补强为同一组跨模块状态对象：Loop Library row run 会生成 Workbench active run、review packet、share-safe log；Loop Library 现在把 readiness 变成真实运行约束，`Ready to run` 才能进入 queue，`Limited` / `Needs setup` 会留在 Library detail、切到 Builder Chat、预填 setup prompt 并显示 toast；Loop Contract / Run Ledger / Review Packet / Share-safe Log 四个库分区现在都是真实 linked rows，Ledger/Packet/Log row 会打开对应 Workbench Run Result；Skill OS 可维护 ordered skill stack，Tool Logs 按当前 tool 隔离并可一键打开 Review Chat；Studio 可保存 loop contract 与 stack，且右侧 structured contract blocks 可直接编辑 steps、review rule、exit 和 output shape；Studio 具备 save-state、Review changes、Reset draft 和 ordered stack dirty feedback；Workbench 具备 Empty queue / Seeded review 模式和内置 Review Guide，四条产品 review path 可直接打开 Loop Library、Knowledge、Skill OS Create Tool 和 Chat；Review Guide 现在有可点击的 manual review checklist、progress 和 per-path checked state，方便人工 review 逐项标记；Knowledge 具备页面级 starter、search、status filter，可新建并 attach 到 Chat。
- Web prototype：`web-prototype/src/loopopsModel.js` 现在承载 App 与 `scripts/action-smoke.mjs` 共用的纯交互规则，包括 Loop readiness、installability、setup prompt、resource bindings、run tool logs、Knowledge starter/filter、Tool draft、Tool Use validation、Tool Logs filter、Skill Stack 插入/删除。`App.jsx` 只保留 React 状态更新和视图事件，action-smoke 通过同一个模型验证状态转移，降低“测试逻辑复制一套”的漂移风险。
- Web prototype：`npm run smoke` 源码合同检查覆盖 Workbench 默认入口、Swift starter loop IDs、六个页面、核心 `data-testid` 锚点、Workbench Review Guide、manual review checklist、manual review record handoff、右上页面语义 primary action、Loop Library readiness setup handoff、Skill OS / Studio drag-drop execution path、Tool Log to Review Chat、Knowledge starter/search/status filter、`Review rule` 文案、Studio editable contract blocks、Studio save-state/review/reset、Builder Chat patch receipt、Workbench empty/seeded mode、Library linked artifact sections、shared LoopOps model hooks、dark-mode contrast selectors 和隐藏内部词过滤；最新输出 `web_prototype_smoke=pass`、`web_prototype_testids=104`、`web_prototype_forbidden_terms=0`。
- Web prototype：新增 `npm run focus:smoke` WebKit 焦点合同检查，覆盖 6 个页面的可聚焦 nav、当前页面 primary action、focusable control 数量，并输出 `product-design-audit-web/focus-smoke-manifest.json` 记录 focus order；最新输出 `web_focus_smoke=pass`、`web_focus_surfaces=6`。
- Web prototype：新增 `npm run audit:capture` WebKit 截图验收，生成 `product-design-audit-web/01`、`06b`、`10` 等 11 张 PNG 和 `screenshot-manifest.json`；同一脚本支持 390 x 844 mobile capture，输出到 `product-design-audit-web-mobile/`；`product-design-audit-web/README.md` 记录了截图级 UX/accessibility audit，并已根据截图修复 Workbench 默认入口、toolbar 截断、toast 遮挡、Studio contract 窄卡片、Workbench skill path 换行、右上 primary action 语义、Studio step editor 断字、Studio save-state、Workbench empty state、nav accessible label、移动端 nav 过高、长 Trigger/Output 单行截断，以及 dark-mode 下浅色卡片继承浅色文字的问题。
- 运行态人工点验：首选 `scripts/review-loopops-web.command`，它只检查或启动本地 HTTP server，不打开系统浏览器、不调用 AppleScript、不读取屏幕、不触发 Accessibility。首选地址是 `http://127.0.0.1:5184/`，若端口被占用则以 Vite 打印的 `Local:` 地址为准。`web-prototype/` 内 `npm run review:no-permission` 聚合 `build`、`smoke`、`action:smoke`、本地 server 检查/启动、`dom:smoke` 和系统自动化禁用检查；当前 sandbox 下 localhost/WebKit file navigation 受限时，会明确输出 `web_no_permission_review_server=offline_fallback`、`web_no_permission_review_auto_open=false`、`web_no_permission_review_system_automation=false`、`web_offline_review=pass`，并给出 `dist/loopops-admin-offline.html` 供人工 review，不把系统权限弹窗作为继续验收的前提。历史 WebKit clickthrough 证据保留在 `11-browser-clickthrough-review.md`。
- 测试信号：`swift test` 当前验证 test target 可构建；本机 toolchain 缺少 `XCTest` / Swift `Testing` discovery，但 `swift run WeChatIntelligenceRadar --contract-check` 是可执行合同检查入口，已覆盖 policy 边界、LoopOps skill binding/stack round-trip、ordered skill path、run isolation、Skill OS 内部能力过滤、knowledge/tool/log persistence 和 interaction IDs。强验收以 `--contract-check`、`--loopops-ui-action-check`、`--loopops-interaction-coverage-check`、`--loopops-interaction-replay-check`、`--ui-smoke-check` 和本机运行态点验共同判断。

## 全局验收

- UI 风格偏 Notion/RelevanceAI：白底、细分隔线、database rows、split detail、轻量菜单、少浮层卡片。
- 主导航至少能表达 `Marketplace/Library`, `Chat`, `Agents`, `Tools`, `Knowledge` 这些用户概念。
- 列表页通用能力：search、filter、columns、sort、row action。
- 详情页通用能力：metadata、readiness/status、primary CTA、history 或 activity。
- 系统反馈有 toast；长任务状态也要落在 row/detail 中，不能只靠瞬时提示。
- 产品 UI 不展示内部执行实现词；用户只看到可理解的业务对象、状态、成本、错误、输出。

## Swift / App 验收

### Loop Library

- 有模板库入口，可展示 template/agent/workflow rows 或 cards。
- 支持搜索、类型筛选、分类筛选、access/readiness 筛选、最近更新排序。
- 打开 template detail 后能看到 summary、creator/source、integrations、required inputs、required knowledge、example task、readiness。
- CTA 至少区分 `Preview`、`Install/Clone`、`Open`、`Finish setup` 的状态。
- 从 detail 的 example task 能进入 run chat，并带入 template scope。

### Knowledge

- 有 Knowledge 列表，row 显示 name、source type、documents、linked agents 或 loops、updated、status。
- `New Knowledge` 菜单包含 `Blank`、`Upload file`、`Import from website`、`Integrations` 或等价入口。
- 创建空 collection 后能展示 `0 documents` 或等价状态。
- 导入开始、成功、失败有 toast；列表 row 同步显示持续状态。
- 在 chat 或 agent/tool 设置里能选择 knowledge collection 作为 scope。

### Tools / Skills

- Tools 列表展示 name、description、type、integrations、used by、owner、status、last modified。
- `New Tool` 先进入 starting point：`Default` blank、`Invent` describe task、`Import` existing definition。
- Tool detail 至少有 `Build`、`Use`、`Logs` 三段式体验。
- `Build` 能展示 Inputs、Steps、Outputs 或等价结构。
- required input 缺失时，在 input 区域附近显示用户可修复的提示。
- `Use` 能填写 required inputs 并运行。
- `Logs` 能显示 status、user、time、cost/duration、error/output summary，并支持 status/user 筛选。
- 本地创建的 `LoopOpsToolDraft` 必须出现在 Skill OS 列表和 Studio shelf，不只保存在隐藏 store 里。

### Chat

- Chat 有显式 scope chip，并能展示来自 template、knowledge、tool、run 的上下文。
- 支持 file、website、knowledge attachment。
- 输入框附近有简洁 chatbot quick GUI：model/capability、instant/deep、search、attach、temporary/private、prompt category。
- run chat、builder chat、review chat 的 quick actions 不同。
- 从 Loop Library detail、Knowledge row、Tool `Use`、Tool `Logs` 进入 chat 时保留上下文。
- chat 返回的引用和结果使用用户可理解名称，不显示内部执行实现。

## Web Prototype 验收

### 页面与路由

- [x] 至少有 Library、Knowledge、Tools/Skill OS、Chat 四个可切换页面或原型状态。
- [x] 每个资源列表使用 row/table 为主，允许 compact card 但不能只有营销式大卡片。
- [x] Library detail 与 Tool detail 使用 split detail 或同页 detail；Knowledge detail 通过 row/context scope 表达，不依赖全屏 modal。

### Interaction

- [x] search/filter/sort 控件可点击并有可见状态；sort 会改变列表排序。
- [x] Columns 控件会在 6/8 列之间切换，并显示 source / required knowledge。
- [x] `New Knowledge` 与 `New Tool` 菜单可打开，菜单项与文案可见。
- [x] tool builder 的 `Build / Use / Logs` tab 可切换。
- [x] Run Tool 会追加当前 tool 的 log；Logs 按 selected tool 隔离，status/user filter 真实过滤；只有过滤结果为空时显示 `No tool history found`。
- [x] Tool Log 可一键打开 Review Chat，并带入 tool、status、output 上下文。
- [x] Chat composer 附近有 `model`、`Instant`、`Search`、`Attach`、`Temporary`、`Create / Explore / Code / Learn` 快捷 GUI。
- [x] Chat quick action 和 Send 会进入 scoped transcript，不只弹 toast。
- [x] Run/Builder/Review quick action 会切换到对应 scope 后写入 transcript。
- [x] Studio `Open packet` 会进入 Review Chat，并写入 builder handoff review 消息。
- [x] Knowledge 页面级 starter 和 `New Knowledge` 菜单都会把 Blank/Upload/Website/Integrations 选择插入列表，并显示 Draft/Syncing 状态。
- [x] Knowledge search 和 status filter 会过滤列表行，并由 DOM smoke 点击验证 Website starter 与 Syncing filter。
- [x] `Create Tool` 会把新工具插入 Skill OS，并追加 Draft log。
- [x] toast 能在创建、导入、保存、失败等动作后出现并可关闭；Web prototype 最多显示两条并自动清理旧消息。
- [x] Web 原型 starter loop IDs 对齐 Swift：`crypto-market-report-loop`、`crypto-defi-opportunity-scan`、`crypto-thesis-review`、`crypto-trade-plan-review`。
- [x] Web 原型关键交互具备稳定 `data-testid`：Library contract/run/open、Workbench active queue/run result/run chat、Skill OS package/execution path、Knowledge new menu、Studio contract page、Review Packet decisions。
- [x] Web 原型关键 focusable controls 具备可读 accessible labels；`focus-smoke-manifest.json` 中 6 个 surface 的 unlabeled count 均为 0。
- [x] Library row click 进入后台 run 队列，并生成同一 run 的 Final Answer、Review Packet、Share-safe Log 与 scoped Run Chat。
- [x] Library row click 只允许 `Ready to run` loop 入队；`Limited` / `Needs setup` loop 点击会进入 setup detail、切到 Builder Chat，并预填缺失 input/knowledge。
- [x] Skill OS 可把 skill 加入 active stack，path rows 可 Up/Down/Remove，Studio 保存时使用该 ordered stack。
- [x] Studio contract summary 使用 Notion 式 block list，不再把长文本压进三列窄卡片。
- [x] Studio structured contract blocks 可直接编辑 steps、review rule、exit 和 output shape；`Add step` / `Remove` 可见且可聚焦。
- [x] Studio save-state 可区分 saved/unsaved，Review changes 可显示 changed blocks，Reset draft 可恢复已保存 Loop。
- [x] Workbench 可在 Empty queue 与 Seeded review 之间切换，并在空状态保留 Run Chat 和明确 CTA。
- [x] Workbench 是 Web prototype 默认入口。
- [x] Workbench Review Guide 可直接打开 Loop Library、Knowledge、Skill OS Create Tool 和 Chat，便于人工 review 四条核心路径。
- [x] 移动端 390 x 844 同路径截图验收通过，11 个步骤均无水平溢出；mobile nav 使用两行 workspace tab 布局。
- [x] 右上 primary action 按页面语义变化：Workbench/Loop Library 为 `Run selected`，Skill OS 为 `Create tool`，Studio 为 `Save Loop`，Knowledge 为 `New Knowledge`，Chat 为 `Send message`。
- [x] `npm run smoke` 可重复检查 starter IDs、六个页面、关键测试锚点和禁用内部词过滤。
- [x] `npm run focus:smoke` 可重复检查 6 个页面的 nav、primary action 和可聚焦控件数量，并输出 focus order manifest。
- [x] `npm run audit:capture` 可重复生成 11 张 Web review 截图，并通过 `product-design-audit-web/README.md` 形成截图级审计。

### Visual QA

- [x] 主要表格列在桌面宽度不重叠；窄宽度下隐藏表头并转为单列。
- [x] 控件文案不溢出按钮。
- [x] 右上 primary action、列表工具条、左侧导航层级稳定，并按页面语义变更。
- [x] 不使用大面积同色渐变或装饰性背景作为核心工作区。

## 模块验收矩阵

| 模块 | 最小可验收 | 完整可验收 |
| --- | --- | --- |
| Loop Library | 列表 + detail + install/clone CTA | readiness、example task、integrations、installed state |
| Knowledge | 列表 + New Knowledge 菜单 + toast | source sync status、linked agents、chat scope |
| Tools | 列表 + New Tool 起点 + Build/Use/Logs | run input validation、history filters、publish/share state |
| Chat | scope + attachments + run action | run/builder/review context actions、从各 detail 深链进入 |

## 当前边界

- 不新增外部发布、交易、微信/飞书发送、tool router 或 final answer authority。
- 不把 provider、runtime、gate、raw tool payload 作为用户主界面概念。
- 不根据未见截图补写 RelevanceAI 或 Triple 的未验证功能。
- Web prototype 是交互原型，不替代 Swift native App 的实际运行能力。
