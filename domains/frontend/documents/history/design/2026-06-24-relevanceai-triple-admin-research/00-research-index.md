# RelevanceAI / Triple Admin Research Index

本文是 `domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/` 的证据索引与落地地图。研究结论以本目录 `screenshots/` 内截图为主，并补充 T3 Chat 公开 DOM、当前源码、当前命令输出和本地运行态审计。未在这些证据中出现的功能不写成既定事实。

## 截图证据索引

| 文件 | 看到的页面/状态 | 可作为证据的 UI literal |
| --- | --- | --- |
| `screenshots/01-relevanceai-marketplace-workforce.png` | Relevance Marketplace 的 workforce/template 列表 | `All Workforces`, `Search for anything...`, `All categories`, `Free + Paid`, `Filter by tag`, `Recently updated` |
| `screenshots/02-relevanceai-marketplace-listing-detail.png` | marketplace listing detail | `Email Marketing Agent`, `Buy $97.00`, `Creator`, `Tools`, `Integrations`, `Description`, `Example Task` |
| `screenshots/03-relevanceai-app-entry-auth-state.png` | app 内 Agents 列表与侧栏 | `Agents`, `New Agent`, `Phone`, `Default`, `Knowledge`, `Filter`, `Columns: (3)`, `Sort: Last modified`, `New Folder` |
| `screenshots/04-relevanceai-knowledge-empty.png` | Knowledge 列表/空库状态 | `Your knowledge base`, `Upload`, `Website`, `Integration`, `Blank`, `Search...`, `0 documents` |
| `screenshots/05-relevanceai-knowledge-new-modal.png` | `New Knowledge` 菜单 | `Blank`, `Upload file`, `Import from website`, `Integrations` |
| `screenshots/06-relevanceai-tools-list.png` | Tools 列表 | `Tools`, `New Tool`, `Invent`, `Default`, `MCP`, `Filter`, `Columns: (6)`, `Sort: Last modified`, `New Folder` |
| `screenshots/07-relevanceai-tools-new-menu.png` | 新建 tool 起点弹层 | `Choose a starting point`, `Default`, `Invent`, `Or build with Invent`, `Import`, `Describe a repetitive, manual task. We'll build a tool to do it...`, `Start` |
| `screenshots/08-relevanceai-tool-builder.png` | tool builder flow | `Build`, `Use`, `Logs`, `Live`, `Run tool`, `Flow`, `Notebook`, `Navigator`, `Inputs`, `Missing required values for: website_url, is_full_page`, `Python`, `export_permanent_file`, `Outputs` |
| `screenshots/09-relevanceai-tool-logs-tab.png` | tool logs/history 空状态 | `Track your tool history`, `View the status, cost to run and any errors of each bulk run.`, `All statuses`, `All users`, `No tool history found` |
| `screenshots/10-relevanceai-tasks-monitor.png` | 文件名写 tasks monitor，但截图实际为登录/注册页 | `Welcome to Relevance`, `Email`, `Continue`, `Single sign-on (SSO)`, `Continue with Google`, `Continue with Apple` |

## 公开 URL 补充证据

| URL | 看到的页面/状态 | 可作为证据的 UI literal |
| --- | --- | --- |
| `https://t3.chat/` | T3 Chat 公开首屏，作为简洁 chatbot quick GUI 的补充参照 | `New Chat`, `Toggle Sidebar`, `Search threads`, `Kimi K2(0905)`, `Instant`, `Search`, `Attach`, `Create`, `Explore`, `Code`, `Learn` |

## 模块地图

| 研究文档 | 覆盖模块 | 主要截图证据 | 目标落地面 |
| --- | --- | --- | --- |
| `01-marketplace-template-library.md` | marketplace、template card、listing detail、filters、install/clone/readiness | 01, 02, 03 | Loop Library / 模板库 |
| `02-knowledge-toast-system.md` | knowledge library、new knowledge menu、toast/event feedback | 04, 05, 03 | looloomi 知识库与通知 |
| `03-tool-creation-logs.md` | new tool modal、builder flow、logs/history | 06, 07, 08, 09 | Skill OS / Tool OS 管理面 |
| `04-triple-chat-quick-gui.md` | simple chatbot、quick GUI、scope、attachments、quick actions | 03, 04, 06, 08, T3 Chat 公开 DOM | run / builder / review chat |
| `05-implementation-acceptance-spec.md` | Swift/App 与 Web prototype 验收 | 全部截图 | 产品落地验收 |
| `07-agent-team-final-audit.md` | sub-agent 审计分工、实现闭环与剩余边界 | 当前 repo 与运行态证据 | 完成性判断 |
| `08-evidence-receipts.md` | 构建、smoke、contract 和 sub-agent receipts | 当前源码与命令输出 | 可复查凭据 |
| `09-no-permission-review-runbook.md` | 无系统权限人工 review 与 smoke 路径 | 当前脚本与命令输出 | 避免 macOS 权限弹窗 |
| `10-objective-completion-matrix.md` | 原始目标逐项完成矩阵 | 当前源码、文档、截图和命令输出 | 人工 review 核对表 |
| `11-browser-clickthrough-review.md` | Codex 内置 Browser 真实 DOM 点击巡检 | 当前 `http://127.0.0.1:5184/` 运行态 | Web 人工 review 点击证据 |
| `12-remaining-decision-contract.md` | Triple scope 与 native pixel-click 剩余决策合同 | 当前证据边界与用户授权需求 | 防止剩余 gap 无限空转 |
| `13-native-manual-review-checklist.md` | Native App 人工 review checklist | 当前 debug app bundle 与 no-permission harness | 不用系统权限弹窗也能逐项记录 native review |
| `14-agent-team-traceability-matrix.md` | agent-team 模块追踪矩阵 | 研究文档、截图、Web/Swift 源码、smoke/harness 和 manual review path | 证明每个模块从调研到落地都有 repo 内证据 |
| `15-goal-completion-gate.md` | 目标完成门槛 | full objective audit、review session、pending human review record | 区分自动验收已通过与人工视觉/产品批准未记录 |
| `16-human-review-gallery.md` | 人工 review 截图库 | desktop/mobile 15-step Product Design captures | 把 Workbench、Loop Library、Skill OS、Studio、Knowledge、Chat 的截图核查点合成一条人工路线 |
| `17-manager-acceptance-closeout.md` | manager acceptance gate | design evidence path、latest review record、native click boundary | 区分 review-ready 和 human-approved，并阻止 pending record 或 native click false 被误报成最终批准 |
| `human-review-gallery.html` | 本地静态人工 review 页面 | desktop/mobile 15-step screenshots paired side by side | 不打开浏览器、不访问网络，供用户手动打开后快速肉眼核查 |
| `review-records/` | 人工 review 结果记录 | `scripts/record-loopops-review.command` 输出的 Markdown + JSON | 把人工 pass/blockers/notes 留成可复查凭据 |

## 共通设计约束

- 优先采用 database rows、split detail、menus、轻量顶部工具条和底部 toast，不把主路径做成多层浮层卡片。
- 列表页需要支持 search、filter、columns、sort、folder 或等价能力；这些能力在 Agents、Knowledge、Tools 截图中反复出现。
- 详情页要能从列表进入，左侧或主区展示 metadata，右侧或下方展示 sample / run / history，不把证据和状态藏在不可发现的面板里。
- 产品 UI 文案不得暴露内部执行实现词；用户只看到 agent、tool、knowledge、run、history、status、cost、error、owner、last modified 等可理解概念。
- looloomi 视觉应靠近 Notion/RelevanceAI：白底、细分隔线、表格行、紧凑控件、少装饰。

## 当前实现证据

- Swift/App 已新增 Loop Library、Skill OS、Knowledge、Studio、Workbench 导航与交互锚点，核心文件见 `domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/LoopOpsViews.swift`、`domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsModels.swift`、`domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsLocalStore.swift`。
- Swift/App 已补近输入框 quick GUI：model、Instant/Deep、Search、Temporary、Create/Explore/Code/Learn，并把本地 `LoopOpsToolDraft` 合成为 Skill OS package；原生 Skill OS `New Tool` 已对齐 `Invent / Default / Import` 起点，sheet 里有 Tool name、Task description、Input scope 三个可编辑字段，Import 会生成 `Imported Review Tool` 并写入 source-tagged Tool Log。
- Swift/App 已补 native readiness handoff：`Ready` Loop 才进入后台 run，`Needs setup` Loop 统一聚焦 Studio / Builder Chat、预填 setup prompt，并在 `--loopops-action-check` 输出 `loopops_action_library_unready_loop_setup=true`。
- Swift/App Knowledge detail 已补 `Attach to latest run`，会把 Knowledge source 绑定到最新 run chat，并记录 `loopops_action_knowledge_attach_to_run=true`。
- Web 原型位于 `web-prototype/`，人工 review 默认执行 `scripts/review-loopops-web.command` 或 `npm run review`；首选地址是 `http://127.0.0.1:5184/`，如果端口被占用则以 Vite 打印的 `Local:` 地址或 `review-sessions/loopops-session-*.md` 记录为准；如果本地策略禁止绑定 localhost，则执行 `scripts/review-loopops-web-offline.command` 生成 `dist/loopops-admin-offline.html` 单文件 review artifact；页面包含 `Workbench`、`Loop Library`、`Skill OS`、`Chat`、`Studio`、`Knowledge`。
- Web + Native 统一人工 review preflight 可执行 `scripts/review-loopops-all.command`；它复用 Web `npm run review:no-permission` 和 native `scripts/review-loopops-native.command`，只打印人工入口，不打开浏览器或 App。
- 可执行 traceability audit 可执行 `scripts/verify-loopops-traceability.command`；它检查 `14-agent-team-traceability-matrix.md` 中的八个 `trace.*` 模块是否都有研究文档、截图、Web/Swift 源码锚点、evidence receipt 和人工 review path。
- 可执行 objective audit 可执行 `scripts/audit-loopops-objective.command`；它把 traceability audit、研究文档、截图证据、Web smoke/action/no-permission review、Swift/native action wiring、review 脚本权限模型和 manual review record artifact 串成一个本地 CLI 审计入口，输出 `loopops_objective_audit=pass/fail`，不打开浏览器或 App。
- 人工 review 结果记录可执行 `scripts/record-loopops-review.command`；它默认生成 `pending-manual-review` 的 Markdown + JSON record，不打开浏览器或 App，也不调用系统 automation。用 `LOOPOPS_REVIEW_STATUS`、`LOOPOPS_REVIEW_BLOCKERS`、`LOOPOPS_REVIEW_NOTES` 写入人工结论。
- Web Workbench 的 Review Guide 已把 manual review record handoff 产品化：页面内展示 record command、pending/ready 状态、环境变量和 Markdown/JSON artifact 位置，并由 DOM smoke 点击 `Prepare record` 验证状态切换。
- Native Workbench 的 Review Guide 也已补 manual review record handoff：显示 `scripts/record-loopops-review.command`、pending/ready 状态和 Markdown/JSON artifact 提示，并由 `--loopops-interaction-replay-check` 验证 `workbench_review_record_handoff=true`。
- Web prototype 已补状态闭环：Tool row 详情切换、Create Tool 入列表、Tool Use required input validation、Logs 按当前 tool 隔离并可打开 Review Chat、Knowledge starter/search/status filter、新建入列表、Loop detail 的 Context & tools 绑定、Run Result 显示本次 Knowledge/Tools、Loop Library ready row run、unready setup handoff、Chat transcript。
- Web prototype 已补真实 DOM action smoke：`npm run review:no-permission` 会先生成离线 review artifact，再启动或复用本地 review server 并运行 WebKit DOM 点击链；如果 localhost 被策略阻止，会尝试 `file://` 离线 DOM smoke，当前 sandbox 下若 WebKit file navigation 被拦截则输出 `offline_fallback` 与 `skipped_sandbox_file_navigation` 而不直接失败。HTTP DOM 路径覆盖 Loop Library ready run、unready setup handoff、Context & tools、Skill OS Create Tool Import 起点与表单字段、Skill OS Use validation、Tool Log to Review Chat、Knowledge starter/search/filter、Knowledge attach 和 Chat send；该路径不控制系统浏览器、不调用 AppleScript、不读取屏幕。
- 最新构建与 smoke receipt 见 `08-evidence-receipts.md`。

## 验收 checklist

- [x] 八个 Markdown 文档存在，且只引用 `screenshots/` 内真实文件名。
- [x] 每个模块都有“截图证据”“产品观察”“映射到 looloomi”“落地验收点”。
- [x] marketplace 映射到 Loop Library 时包含 card/listing detail/filter/install 或 clone/readiness。
- [x] knowledge 映射包含 Upload / Website / Integration / Blank 四类入口，以及 toast/event feedback。
- [x] tool 映射包含 New Tool 起点、builder 的 Build/Use/Logs、输入缺失提示、history 空状态。
- [x] chatbot/quick GUI 映射包含 scope、attachments、quick actions、run/builder/review 三种上下文，并已在 Web prototype 补充 T3-style composer controls。
- [x] Swift/App 与 Web prototype 验收点可逐项检查，并已更新到当前实现边界。
- [x] 原始目标已有逐项 completion matrix，明确 Proven / Partially proven / Not claimed，避免把 action wiring 误报成 AppKit/XCUITest 点击完成。
- [x] Web prototype 已追加 Codex 内置 Browser 点击巡检，覆盖 Workbench、Loop Library、Skill OS、Knowledge、Chat、Studio 的核心真实 DOM 点击路径。
- [x] 剩余 Triple URL 与 native AppKit/XCUITest pixel-click 缺口已写成决策合同，明确默认收口策略和用户提供信息后的追加路径。
- [x] Native manual review checklist 已补，人工打开 app 时可逐项核对 Workbench Review Guide、Library、Skill OS、Studio、Knowledge、Run Chat 和 Review Chat。
- [x] Objective audit 已补，人工 review 前可先跑 `scripts/audit-loopops-objective.command` 获取完整 no-permission 证据清单。
- [x] Agent-team traceability matrix 已补，八个模块都有 research/source/evidence/manual review 映射，并由 `scripts/verify-loopops-traceability.command` 校验。
