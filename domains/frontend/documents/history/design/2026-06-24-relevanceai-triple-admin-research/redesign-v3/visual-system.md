# Visual System

Status: `core-guidance`

## Product Register

LoopOps 是 task-first product UI。设计服务于工作，不追求惊喜。界面首先要帮助用户判断：

- 哪些 Loop 可以运行。
- 当前 run 的权威结果是什么。
- 哪些证据或输入缺失。
- 下一步是追问、复核、保存、克隆还是继续配置。

## Design Direction

- 参考 Notion database、Linear list、Apple productivity app 的密度和克制。
- 高密度来自行、分割线、属性区、split pane，不来自更多卡片。
- 页面应像工作台，不像演示后台、能力清单或营销页。
- 允许推翻旧稿，只要保留对象关系和安全边界。

## Layout

- 左侧 workspace nav 固定。
- 主区域优先使用 database row、page detail、inspector rail、split result。
- 宽屏可以是 nav / object list / detail or result / inspector。
- 窄屏先显示 object list，detail 进入 pushed page 或 drawer。
- 避免装饰性的 page card、card inside card、同尺寸面板堆叠。
- 工具面板、detail pane、modal、toast 可以有克制边框和 6-10px radius。

## Surface Model

| Surface | Primary Object | Secondary Object | Layout |
| --- | --- | --- | --- |
| Workbench | Active run | Result, queue, Run Chat | queue rail + result page + chat inspector |
| Loop Library | Loop Contract | template, ledger, review packet | database + detail page |
| Skill OS | Tool or Skill package | stack, log | database + tool detail + stack shelf |
| Studio | Loop Contract draft | patch receipt, skill path | contract page + builder inspector |
| Knowledge | Source | attachment scope, activity | database + source detail |
| Tool Logs | Tool run log | review chat | log table + log detail |
| Scoped Chat | Chat thread | quick controls, attachments | compact transcript + composer rail |

## Visual Language

- Font: system UI, matching SwiftUI and Apple platform defaults.
- Page title around 22 px semibold; object title around 15 px semibold; row text around 13 px.
- Light-first palette: app background `#f6f7f8`, surface `#ffffff`, separator `#dfe3e8`, primary text `#15171a`, secondary text `#5f6772`, accent `#0a84ff`.
- Blue only marks selected object, primary action, or focused link.
- Status colors stay small and paired with text.
- No glow, no hero gradient, no decorative glass, no purple-blue AI gradient.

## Interaction

- Database rows are the default object presentation.
- Row hover reveals secondary actions.
- Primary click has one meaning per mode.
- Detail/open actions use explicit icon buttons.
- One primary action per local decision area.
- Toast is transient product feedback with one recovery action, not a log row.
- Modal is for focused creation or hard decisions; page detail and drawer are preferred for normal work.

## Chat And Logs

- Chat is a control layer with visible scope near the thread and composer.
- Global, Run, Builder and Review chat scopes remain distinct.
- Quick controls stay near the composer.
- Attachments are object chips with source and scope.
- Logs are evidence, not backend dumps.
- Raw payloads, provider IDs, runtime names, schema fields, workers and artifacts stay out of primary product UI.

## Copy

- Keep chrome concise and product-facing.
- Use one locale per control surface; task content may be Chinese or mixed domain language.
- Do not mix Chinese and English inside one control label unless it is a proper noun.
- Prefer user language such as `Needs review`, `Missing input`, `Requires confirmation`, `Open log`.
- Avoid internal workflow words such as provider, runtime, schema, raw id, worker, artifact and harness.
