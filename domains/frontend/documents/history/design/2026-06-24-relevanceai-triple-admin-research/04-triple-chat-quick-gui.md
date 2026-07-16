# Triple Chatbot Quick GUI

本篇聚焦简洁 chatbot、快捷 GUI、scope、attachments、quick actions，并映射到 looloomi 的 run / builder / review chat。用户后续把需求澄清为“triple 那一部分的 chatbot 很简洁，并且有快捷 GUI”，因此本篇的验收对象是 chatbot quick-GUI 模式，而不是证明某个产品命名。公开可访问的 `https://t3.chat/` 仍作为补充参照，因为它和“简洁 chatbot + 近输入框快捷 GUI”的形态高度一致。

## 截图证据

- `screenshots/03-relevanceai-app-entry-auth-state.png`：左侧一级导航有 `Chat`，说明 chat 是主入口之一。
- `screenshots/03-relevanceai-app-entry-auth-state.png`：Agents 页顶部有 `Phone`, `Default`, `Knowledge` 快捷入口，可作为 chat scope / mode 的参考。
- `screenshots/04-relevanceai-knowledge-empty.png`：Knowledge 页面有 `Upload`, `Website`, `Integration`, `Blank`，可映射为 chat attachments 或 context source。
- `screenshots/06-relevanceai-tools-list.png`：Tools 与 Agents 同在 Build 区域，chat 应能调用用户已配置的 tools，但 UI 只展示用户可理解的 tool 名称、状态和结果。
- `screenshots/08-relevanceai-tool-builder.png`：tool detail 有 `Build`, `Use`, `Logs`，可映射为 builder chat、run chat、review chat 三种上下文。
- `screenshots/09-relevanceai-tool-logs-tab.png`：logs 页面关注 history、status、cost、errors，review chat 应能围绕这些信息做解释和下一步。

## T3 Chat 公开首屏证据

公开 URL：`https://t3.chat/`  
浏览器标题：`T3 Chat | AI chat with GPT-5, Claude, Gemini, and more`

Browser DOM 读取到的关键 UI literal：

- Sidebar / thread control：`New Chat`、`Go to Canvas`、`Search threads`、`Login`。
- Top quick controls：`Toggle Sidebar`、`Search`、`New Thread`。
- Composer helper：`Press Enter to send, Shift + Enter for new line`、`Message input`。
- Model / mode strip：`Kimi K2(0905)`、`Instant`、`Search`、`Attach`。
- Secondary controls：`Enable temporary chat mode`、`Settings`。
- Prompt quick actions：`Create`、`Explore`、`Code`、`Learn`。
- Example prompts：`How does AI work?`、`Are black holes real?`、`How many Rs are in the word "strawberry"?`、`What is the meaning of life?`。

截图 API 在该页面上超时，因此当前 T3 证据是公开 URL + Browser DOM 快照，而不是本地 PNG 截图。产品结论仍然足够清晰：T3 的 quick GUI 不是大卡片工作台，而是一个轻量 composer 周边系统，由模型选择、临时模式、搜索、附件、设置、prompt category 和 example prompt 组成。

## Triple / T3 参照边界

本轮额外公开检索覆盖了这些意图组合：`Triple + AI chat + quick actions`、`Triple + Toggle Sidebar + Search threads`、`Triple + Create Explore Code Learn`、`Triple + Attach + Search`。没有找到另一个明确叫 `Triple` 且同时匹配 chat quick GUI 的公开产品页面。能直接访问且与用户描述高度吻合的是 `T3 Chat`。因此本篇把 `T3 Chat` 当作公开补充参照；最终产品要求按“简洁 chatbot + 快捷 GUI 模式”验收。

## 产品原则

- chat 是工作入口，不是唯一界面。复杂配置放在 split detail、菜单、表格行中；chat 负责发起、解释、修正、复用。
- quick GUI 应当贴在输入框或侧栏上，提供 scope、attachments、quick actions，而不是用长提示词教育用户。
- chat 中不要暴露内部执行实现词。用户看到的是 agent、tool、knowledge、run、history、status、error 和 output。
- run、builder、review 三种 chat 上下文要共享组件，但默认 quick actions 不同。

## 三种 Chat Context

| Context | 入口 | 主要目标 | 默认 quick actions |
| --- | --- | --- | --- |
| run chat | `Chat` 一级入口、template detail 的 example task、tool `Use` tab | 发起任务、选择 agent/tool/knowledge、返回结果 | `Run`, `Attach`, `Select knowledge`, `Choose tool`, `Save output` |
| builder chat | `New Agent`, `New Tool`, tool `Build` tab | 从自然语言生成或修改 agent/tool/workflow | `Add input`, `Add step`, `Test`, `Publish`, `Explain changes` |
| review chat | `Logs`, task/history/detail | 解释失败、比较 run、生成复盘、提出修复 | `Explain error`, `Retry`, `Open run`, `Create fix`, `Export summary` |

## Scope 设计

scope 是 chat 的显式上下文选择，不靠用户猜。

建议 scope chips：

- `Workspace`：默认搜索/使用当前 workspace 的 agents、tools、knowledge。
- `Agent`：限定某个 agent。
- `Tool`：限定某个 tool。
- `Knowledge`：限定一个或多个 knowledge collections。
- `Template`：从 Loop Library 的 listing detail 发起时自动带入。
- `Run`：从 history/logs 进入 review chat 时自动带入。

scope chip 必须可见、可移除、可切换。对于缺少权限或未 ready 的 scope，显示 `Needs setup` 并给出下一步。

## Attachments 设计

attachments 不只是一枚回形针，应该和 Knowledge 新建入口一致：

- `Upload file`：上传本地文件作为本次 chat 附件，或保存为 knowledge。
- `Import from website`：输入 URL，作为一次性上下文或保存到 knowledge。
- `Use knowledge`：选择已有 collection。
- `Use integration`：从已连接服务选择内容。

每个 attachment 显示 source、状态、是否保存到 knowledge。失败时给 toast 和 row-level error。

## Quick Actions

输入框上方或右侧建议使用轻量按钮，不做大面积卡片。

T3-style composer actions:

- `Model`：显示当前模型和成本/速度提示，例如 T3 的 `Kimi K2(0905)` 与 `$$·`。
- `Instant`：表达响应模式或临时轻量运行。
- `Search`：作为 web / workspace search 的显式开关；不可用时要说明 plan 或 setup 限制。
- `Attach`：作为文件/knowledge/website 入口，而不是单一回形针。
- `Temporary chat`：让用户明确本轮是否进入持久 memory / ledger。
- `Create / Explore / Code / Learn`：作为 prompt category，而不是隐藏在 slash command 里。

Run chat：

- `Choose agent`
- `Choose tool`
- `Select knowledge`
- `Use template`
- `Run`

Builder chat：

- `Create from prompt`
- `Add required input`
- `Test step`
- `Publish`
- `Open logs`

Review chat：

- `Explain run`
- `Show errors`
- `Retry`
- `Compare`
- `Export`

## 映射到 looloomi

- Loop Library detail 的 `Example Task` 可以一键带入 run chat。
- Knowledge row 可以一键 `Ask with this knowledge`。
- Tool detail 的 `Use` tab 与 run chat 共用 input form。
- Tool detail 的 `Logs` tab 可打开 review chat，自动带入 run history。
- builder chat 生成的配置必须落在可见 form/flow 上，不能只存在于聊天文本中。
- looloomi 的 composer 应吸收 T3 的轻量原则：把 `scope`、`model/capability`、`search`、`attach`、`temporary/private`、`quick prompt category` 作为近输入框的可见控件；不要把它们做成另一层配置页。

## 落地验收点

- Chat 入口存在，且支持显式 scope chip。
- chat 可以选择 knowledge、tool 或 agent 作为上下文。
- attachments 至少覆盖 file、website、knowledge 三类。
- quick actions 会随 run/builder/review context 改变。
- 从 template detail、knowledge row、tool use/logs 能进入对应 chat，并保留上下文。
- 本篇的完成证据是：RelevanceAI 已有截图中的 Chat/Knowledge/Tool 结构、T3 Chat 公开 DOM 的近输入框快捷控件、以及 Web prototype 中已经落地的 model / instant / search / attach / temporary / prompt category / run-builder-review quick actions。
