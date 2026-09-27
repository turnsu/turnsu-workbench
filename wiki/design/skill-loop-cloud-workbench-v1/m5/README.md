# M5 UI 与交互设计包

- 日期：2026-07-28（v2 交互重构已批准合入）
- 状态：批准并作为当前 M5 实施权威
- 历史产品草案：[`docs/rebuild/07-ux-restructure-m5.md`](../../../../docs/rebuild/07-ux-restructure-m5.md)（冲突处已被本包替代）
- 设计稿：[`M5_KEYFRAME_BOARD.html`](M5_KEYFRAME_BOARD.html)（25 帧关键帧）
- 交互细节：[`COMPONENT_INTERACTIONS.md`](COMPONENT_INTERACTIONS.md)；核心流：[`USER_FLOWS_AND_STATES.md`](USER_FLOWS_AND_STATES.md)
- 配色与文案规范：[`M5_UX_REDESIGN_V2.md`](M5_UX_REDESIGN_V2.md) 第 1.0、8 节；诊断记录：[`M5_UX_OPTIMIZATION_PROPOSAL.md`](M5_UX_OPTIMIZATION_PROPOSAL.md)
- 旧版副本：`_backup-v1/`（v1 四件，保留一个里程碑周期）
- 适用范围：Agent、Model Switch、Skill、Loop、Team Library、中文、390px 与恢复状态

## 1. 设计判断

这是面向 8-15 人团队的严肃 B2B Agent 工作台重构，不是营销站，也不是另起一套
视觉系统。

- `DESIGN_VARIANCE: 4`、`MOTION_INTENSITY: 2`、`VISUAL_DENSITY: 6` 维持不变；
- 配色（2026-07-28 批准）：暖米白底 `#f7f6f3`、暖黑墨色 `#1b1917`、单一靛蓝 accent
  `#4f46e5`、低饱和状态色、暖调阴影、更浅边线；深色为暖黑同族，不做简单反色
  （完整 token 表见 M5_UX_REDESIGN_V2.md 1.0）；
- 按钮三级（primary/secondary/tertiary），**每屏只有一个 primary**；黑色实心按钮
  移出体系；取消/返回一律 tertiary；
- 卡片只承载独立对象，分区用标题 + 分隔线，禁止卡片套卡片与双标题；
- 状态不只靠颜色表达；每个错误一个原因 + 一个恢复动作；空态统一 EmptyState；
- 界面文案说人话：schema / 编译 / canonical / 冒烟 / FIFO / input schema 等工程词
  不进界面（对照表见 M5_UX_REDESIGN_V2.md 第 8 节）。

## 2. 方案选择

| 方案 | 做法 | 结果 |
|---|---|---|
| A：扩展现有 Loop 视觉语言 | 保留 shell、行结构和抽屉语义，补 Agent、Skill、Library 与状态帧 | **采用**。风险最低，M5 产品语义与既有设计连续 |
| B：仅整理当前实现 | 不补设计稿，只继续修 CSS 和 gate | 拒绝。会再次出现组件存在但页面方向不一致 |
| C：引入新的组件系统 | 使用 Fluent、Carbon 或新的通用模板重做 | 拒绝。会制造第二套视觉真相，并扩大迁移范围 |

2026-07-28 的 v2 重构沿用方案 A，并明确替代旧界面的单 Main Session、text/image
模式切换、Skill modal、Loop Run preflight 主入口和 Python-only 产品选择。它不改变
Product API 作为唯一控制面、Runner 作为 Run 权威、浏览器 profile-only、Draft /
proposal 控制链及按功能域加载边界。

## 3. 规格、设计、实现和证据对照

> 证据快照时点：2026-07-30；`sourceIdentity` =
> `sha256:2d1b8792786a35baacb9db27a92c4e81b1fb39b43c6a9bee9232dac54acac507`，
> `buildIdentity` =
> `sha256:2f0fe8a0c0f99e127d986e22066c5061a64d5a9a036144f190378e595db2bc35`。
> 表内“自动化层已验证”只表示该快照通过契约、单元/组合测试、
> state smoke 与 production build，不表示认证 Product API 功能签收、人工视觉签收或
> 生产发布，也不自动覆盖后续 source/build identity。运行数字与后续证据快照只在
> [`M5 QA`](../../../qa/2026-07-25-m5-ux-restructure-qa.md) 维护。

| 范围 | 规格 | 已有设计 | 2026-07-30 实现快照 | 证据快照 | 判定 |
|---|---|---|---|---|---|
| Agent 首页 | 多 session 版面、建议卡、结果阅读页 | M5 关键帧 01/02 | 当前用户 Session rail、统一 composer、内联执行状态和结果 reader 已接 Product API；Loop deep-link 只选择当前用户列表中的精确 Session | Agent/contract/backend gate + production build | 自动化层已验证；认证 DOM 与当前截图待验证 |
| Model Switch | 无模式切换、能力标注、输入时检测、profile-only | 组件交互规格 | 单一 profile picker、附件能力检测、禁用/恢复反馈与 profile-only 请求已落地 | model/contract/state smoke | 自动化层已验证；真实 Provider 与认证 DOM 待验证 |
| Skill 创建 | 定义/导入、七步、私有 Draft | M5 关键帧 04–06+05B–05F | 全页七步 wizard、材料/参数/产物、Product runtime 目录、注册 Tool Action、ZIP/GitHub/Server import 与 Draft 边界已落地 | contract/backend/package/state/M5 gate + build | 自动化层已验证；Python/Node 真实容器与认证 DOM 待验证 |
| Loop 创建 | 文档/定义导入、staged proposal、第二跳落地页 | M5 关键帧 07/08/17/18 | staged generate/get/commit/dismiss、文档/导入/空白/起点/复制第二跳均已接真实状态 | backend/state/M5 gate + build | 自动化层已验证；认证 DOM 待验证 |
| Loop 三态 | 设计中/可运行/已发布共享；Run 回 Agent 页 | lifecycle 母版 + 帧 09 | 看板只投影 lifecycle；Ready CTA 走 Product `startLoopAgentTask` 并 deep-link 精确 Session，不消费 page-owned preflight | contract/backend/M5 gate + build | 控制链自动化层已验证；完整 Run 轨迹待认证环境验证 |
| Team Library | 领域分类、浏览、安装/更新 | M5 关键帧 13/16 | 三栏 route/query/权限/更新状态已落地，领域来自后端 release read model 而非前端文案推断 | backend/state/M5 gate + build | 自动化层已验证；认证 DOM 待验证 |
| 中文 | 用户偏好优先，无偏好时中文环境默认中文 | 中文 Loop 与创建关键帧 | 用户作用域偏好与 feature namespace 已落地 | i18n/state/build gate | 自动化层已验证；该快照 build 的认证 accessibility 与截图待验证 |
| 390px | Agent 与创建流程可完成；四页齐全 | 390px 关键帧 14–16 | 单列、四项底部导航、创建 sticky footer 与显式 aria-label 已落地 | build + 静态/类型 gate | 静态/构建层已验证；该快照 build 的 390px 截图与人工 review 待验证 |
| 恢复状态 | loading/error/permission/conflict/recovery | 状态板规格（帧 19） | Banner、ObjectQueryState、模型/附件/Tool/runtime 显式错误与恢复动作已落地 | state/M5 gate + fail-closed capture contract | 自动化层已验证；prepared state 的真实 capture 待验证 |
| 加载边界 | Agent 只加载 Agent 代码和数据 | AppBootstrap/feature ownership | 7 个 lazy route、域 query/dialog/CSS/i18n 已拆分 | production manifest + bundle audit | 构建层已验证；Flowgram 保持 Builder-only deferred |

## 4. 页面和状态总览

### Agent（帧 01/02，移动端帧 14）

- 多 session 版面：左栏任务列表（按时间分组、状态点、⤴ Loop 运行标记、可折叠为
  44px 图标条）；主区对话流；composer 固定底部，提交即开新任务；
- 取消"上下文/运行详情/产物"三 tab drawer：上下文内联（执行步骤写明读取来源），
  运行详情 = 进行中内联"执行细节 ▾" + 完成后阅读页底部"运行信息"折叠区；
- 结果闭环：结果卡 chips + "打开结果 →" → 结果阅读页（Markdown 渲染 + 下载/复制 +
  多产物 1/N 翻页 + 运行信息折叠区）；移动端为推进式整页；
- FIFO 明确显示"排队第 1 位"，失败不自动切换模型或伪装成功。

### Model Switch（帧 03）

- 无"文本/图像"模式切换：composer 工具条只有模型按钮；
- popover 列出团队开通的受治理模型，能力直接标注（支持图片 / 仅文本）；
- 输入时检测：拖入/粘贴图片而模型不支持时，附件 chip + notice 给出
  "换模型 / 移除图片"两个出路，发送禁用附原因；
- route 只保存 `modelProfileId`，Provider 协议和密钥仍由 Product 后端拥有。

### Skill（帧 04–06、05B–05F、10–12，移动端帧 15）

- 入口专注页：定义新技能（7 步向导）/ 导入已有技能 / 工具（已注册 Action 导入，
  帧 18）/ 工作流（转 Loop 创建）；
- 向导左侧步骤导航：类型 → 做什么 → 怎么运行 → 分类 → 草稿内容 → 试运行 →
  最后检查；已完成可回跳，返回不丢数据；
- "需要什么"为材料/参数双组模型：需要的材料（文件/文本，必须/可选）+ 需要的
  参数（入参，必须/可选），都可为空并明说"不需要，直接就能跑"；
- 运行环境用户可选（Python 3.12 / Node.js 20 · TypeScript，均隔离沙箱），环境目录
  由后端下发、前端不硬编码；风险不由用户自评，由系统按能力边界推导；
- 最后检查为完整总览：概述/定义/输入输出/包含文件/试运行要证明，每区可返回修改；
- 试运行与发布为显性三步：先试跑一次 → 确认它的能力范围 → 发布固定版本
  （完成折叠、当前展开、后续锁定）；
- 详情页去双标题，名称可 ✎ 行内重命名（包名/ID 与版本规则不变）。

### Loop（帧 07–09、17–18，移动端帧 16）

- 三态看板只表达 lifecycle（设计中/可运行/已共享），不内嵌运行；运行入口
  "▶ 去 Agent 页运行 →" 在 Agent 任务栏生成 ⤴ 任务，统一执行与输出，状态回写看板；
- 看板动作：primary 新建 Loop + secondary 上传 Loop；AI 命令条为 hero 条（⌘K）；
  drop target 只在目标列高亮；空列统一 EmptyLane；
- 创建入口两卡（从文档生成 / 导入定义）+ 其他起点内联行；删除通栏取消；
- 第二跳落地页：空白 Loop → builder 大纲；从起点开始 → 起点模板库（帧 17）；
  复制现有 Loop → 选择对话框（帧 18）；
- staged proposal review 常驻"Loop 还没有创建" banner，字段与节点标题行内可编辑，
  未确认时没有 canonical Loop。

### Team Library（帧 13/16）

- 平台化三栏：领域 rail（产品/研究/数据/工程，带计数 + 状态过滤）→ 类型 tabs +
  行列表 → 预览面板；
- 每行露出用途一句话、"材料 → 产物"、领域标签、被几个工作流用、安装状态与唯一
  动作——不点进去就知道资产干什么、属于哪个领域；
- 预览面板：能做什么/包含什么/用在哪/版本对比 + 唯一主按钮（安装 / 看看影响再
  决定）；
- 本版不含权限设置：团队内均可安装，可见性以标签区分（团队 / 仅本组）；
- viewer、缺 Connection、版本冲突、更新影响均使用明确原因和恢复动作。

## 5. 人工视觉关键帧

55 个 screen ID 是自动状态和路由库存，不代表 55 张高保真设计，也不要求逐张人工
批准。人工 review 固定在以下 12 个代表帧（设计稿共 25 帧，覆盖这 12 帧及其
中间步骤与第二跳页面）：

1. `agent-home-empty`
2. `agent-running-result`
3. `model-switch-capabilities`
4. `skill-create-entry`
5. `skill-wizard-review`
6. `loop-create-entry`
7. `loop-staged-proposal-review`
8. `loop-lifecycle-run-boundary`
9. `team-library`
10. `agent-mobile`
11. `creation-mobile`
12. `state-board`

Capture manifest 只记录真实路由、状态、截图、source/build identity 和内容 hash。人工
review 单独保存，以 `screenId + contentHash` 绑定。截图内容未变化时保留原结论；只有
发生变化的画面失效。

## 6. 响应式与可访问性

- Desktop shell 高度 54px，一级导航单行；
- 1280px 仍保留阅读面板，但不得把主任务压到不可用宽度；任务栏可折叠；
- 390px 主导航为底部 tab bar（Agent/技能/工作流/资源库，图标+短标签）；
  创建步骤保持 sticky footer；drawer 变 bottom sheet；结果阅读页为推进式整页；
- 移动端不提供技能包文件导入（无对应文件语义），给回桌面通路；
- 所有主要触控目标至少 44px；
- popover、dialog、drawer 关闭后焦点回到触发器；
- 状态不能只靠颜色表达；错误提供一个原因和一个恢复动作；
- 200% zoom 无页面级横向滚动，Canvas 例外但必须提供 Outline 等价路线。

## 7. 实施边界

```text
AppBootstrap
  -> Auth
  -> WorkspaceShell
  -> Lazy Feature Route
      -> feature-owned query / mutation / state / dialog / CSS / i18n
      -> Product API
```

- App 不拥有业务对象列表、editor、Run stream 或 feature mutation；
- Agent 首屏只请求 auth、workspace/session、Agent definitions/profile/session/turns 和
  任务列表（session read model）；
- `fflate` 只在用户选择 ZIP 后加载；
- Flowgram 只在 Builder Canvas 进入后加载；
- 浏览器只发送 `modelProfileId`，Provider 协议和密钥仍由 Product 后端拥有；
- 运行环境目录由 Product API 下发，前端不硬编码 runtime；
- 未进入的 route 不下载页面代码，也不抓取该域对象列表或私有详情。

## 8. 设计自审

- 无 `TBD`、占位页面或第二套视觉方向；
- Agent、Skill、Loop、Library 的对象与动作边界和已批准的 M5 v2 一致；
- 25 帧关键帧无悬空入口：每个创建入口的第二跳都有落地页，向导七步全有内容稿，
  "打开结果"闭环到结果阅读页；
- 所有创建动作都停在 Draft/proposal 边界，没有静默发布或运行；
- 资源拆分改变加载所有权，不改变 Product API、Runner 或 Agent Runtime 控制链。

## 9. 实施与签收边界

截至 2026-07-28，设计包 v2 已批准合入：关键帧总览、组件交互、用户流与本 README
为实施基线；`M5_UX_REDESIGN_V2.md` 保留配色与文案规范（第 1.0、8 节），
`_backup-v1/` 保留 v1 四件一个里程碑周期。视觉发布仍须同时满足 55/55 自动状态
捕获和 12 个关键帧的 hash-bound 人工结论。缺 Provider、缺测试对象或缺 prepared
state 时 gate 必须保持 `blocked`，不能生成 fixture 或沿用历史截图替代。
