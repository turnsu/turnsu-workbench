# M5 UX 前端落地、路由资源拆分与交叉审查

> **Historical / superseded evidence (2026-07-29).** 本报告仅适用于 2026-07-27
> 旧 M5 v3 候选。其 drawer、`mode + modelProfileId`、Run preflight 语义已被
> [M5 v2 设计包](../design/skill-loop-cloud-workbench-v1/m5/README.md) 取代；引用的
> schema-v3 capture 缺少现行 provenance/已执行断言，23/55 只能视为历史 UI 诊断，
> 不能作为当前真实截图、自动 QA PASS 或视觉签收证据。本文中的 source/build hash
> 与测试计数亦不得覆盖当前 QA；文中的 “Provider smoke 4/4” 是 loopback test harness，
> 不是外部 Provider、credential 或计费调用证据。

- 日期：2026-07-27
- 范围：M5 UX、Agent / Skill / Loop / Team Library 前端、模型选择、route/data/resource boundary
- 历史结论：当时的代码/自动化基线曾判定通过；按现行证据契约该 PASS 已失效，
  当前视觉发布仍为 `NO-GO`

## 1. 结论

这次重做已经把 M5 v3 的产品方向接入真实前端，并修复了旧版 `App.jsx`、全局
workspace hook 和全量静态资源共同造成的首屏越界加载。独立前端、后端和 QA 交叉审查
没有留下 P0/P1 代码问题。

但这不等于 M5 已经视觉签收。当前真实环境缺少可用 Provider、部分 lifecycle 测试
对象和 prepared recovery state，因而无法获得全部 55 个自动状态截图；12 个关键帧也
尚未由用户按当前截图 hash 人工批准。视觉 gate 正确地保持 blocked，未复用历史截图，
也未用合成 PNG 或 fixture 冒充真实状态。

## 2. 为什么此前仍显示旧版

这不是单个 CSS 或组件遗漏，而是实施与验收共同失真：

1. 旧 pre-M5 页面、旧静态 smoke 和历史截图仍在隐式保护旧结构，组件存在被误当成
   新页面已经落地；
2. `App.jsx` 静态导入 Agent、Skills、Loops、Builder、Runs、Team Library 和大量
   dialog，route 只是切换显示，不是真正的功能边界；
3. 全局 `useWorkbenchServerState` 在进入 Agent 时请求多个产品域的数据，代码懒加载
   与数据懒加载没有同时成立；
4. CSS、i18n、dialog 和 query ownership 都在全局，修改某一功能仍会把其他功能带入
   首屏；
5. 55 个 screen ID 一度被错误解释成 55 份高保真人工签收，而旧 gate 又没有强制
   capture 完整性和 build provenance，导致“清单存在”和“页面真实完成”混在一起；
6. 旧证据未绑定当前源码与构建内容，重构后仍可能误用旧图得到错误结论。

本轮把产品规格、设计、实现、构建产物和真实浏览器证据重新串成一条可校验链路。

## 3. 权威设计包

当前 M5 设计方向延续既有 Loop 视觉语言，没有引入第二套组件系统：

- [`M5 UI 与交互设计包`](../design/skill-loop-cloud-workbench-v1/m5/README.md)
- [`Agent / Skill / Loop 用户流与状态`](../design/skill-loop-cloud-workbench-v1/m5/USER_FLOWS_AND_STATES.md)
- [`ModelSwitch、Drawer、Wizard 与 Proposal 交互`](../design/skill-loop-cloud-workbench-v1/m5/COMPONENT_INTERACTIONS.md)
- [`可运行关键帧总览`](../design/skill-loop-cloud-workbench-v1/m5/M5_KEYFRAME_BOARD.html)

设计包明确了：

- Agent 是任务第一的单 composer 历史流；
- 浏览器只持有 `mode + modelProfileId`，Provider 协议与凭证仍由后端拥有；
- Skill 先分流“定义/导入”，七步 wizard 只创建私有 Draft；
- Loop 的文档生成只产生 staged proposal，确认后才修改 canonical Draft；
- Loop 的设计中、可运行、已发布共享三态与 immutable Run 分离；
- 55 个 screen ID 用于自动覆盖，人工视觉 review 只覆盖 12 个代表性关键帧。

## 4. 已落地的真实前端

### 4.1 路由与所有权

`App.jsx` 现在只拥有 bootstrap、auth、workspace shell、route registry、lazy boundary
以及顶层 loading/error。Agent、Skills、Loops、Builder、Runs、Team Library 和 Members
均为动态 feature route，并分别拥有自己的 query/mutation、局部状态、dialog、CSS 和
i18n namespace。

进入 Agent 的 clean reload 不再下载 Skills、Loops、Builder、Runs、Team Library、
Flowgram 或 `fflate`；也不再主动获取这些域的列表或详情。

### 4.2 产品边界

- Agent：统一 composer、空状态、recent work、可选 drawer、FIFO Turn 语义；
- Model：轻量 chip/popover，text/image capability 过滤，禁用和不匹配显式失败；
- Skill：定义/ZIP/GitHub/Server import 分流，七步 wizard，Draft/Test/Validate/Publish
  分离；
- Loop：创建入口、staged proposal、三态看板和 Run route 分离；
- Run Preflight：以已编译 `ExecutionPlan.steps[].capabilities.externalActions` 为
  权威，不再从 Skill 列表推断外部动作；
- Team Library：浏览、权限、安装/更新状态由 feature 自己加载；
- 390px：shell 单列、drawer 变 bottom sheet，全局 Create 为 icon-only 但保留明确
  `aria-label="Create"`；
- 重复导航：`?mode=upload` 和 `?create=` 每次消费后都会发送 route navigation event，
  连续两次触发已回归。

真实控制链保持：

```text
Web
  -> Workbench Product API
  -> Product Store / Workflow Runner
  -> Agent Runtime / Provider adapter
```

浏览器未直连 Agent daemon 或 Provider，未接触密钥，也没有建立另一套模型真相源。

## 5. Bundle 与首屏资源

### 5.1 改造前后

| 指标 | 改造前 | 改造后 | 变化 |
|---|---:|---:|---:|
| main JS raw | 933,132 B | 252,172 B | -73.0% |
| main JS gzip | 约 255,975 B | 77,982 B | -69.5% |
| Agent initial raw | 1,222,442 B | 618,756 B | -49.4% |
| Agent initial gzip | 305,269 B | 169,832 B | -44.4% |
| 全局 CSS raw | 288,912 B | shell 与 feature CSS 分离 | 首屏不再携带全部 route 样式 |
| `>500 kB` chunk | 2 | 1 | 只剩 Builder-only Flowgram |

最终 entry initial 为 266,571 B raw / 81,615 B gzip / 70,626 B Brotli。

主要 feature chunk：

| Feature | JS raw | JS gzip | CSS raw | CSS gzip |
|---|---:|---:|---:|---:|
| Agent | 14,586 B | 4,515 B | 9,243 B | 2,140 B |
| Skills | 74,998 B | 18,689 B | 184,975 B | 24,659 B |
| Loops | 73,751 B | 16,772 B | 182,957 B | 24,620 B |
| Builder | 51,589 B | 13,517 B | — | — |
| Runs | 12,129 B | 3,530 B | — | — |
| Team Library | 23,221 B | 5,473 B | — | — |

`fflate` 为 ZIP import 路径的动态 chunk：31,795 B raw / 12,167 B gzip。

Flowgram 仍为 657,159 B raw / 193,308 B gzip / 161,197 B Brotli。它是唯一超过
500 kB 的 chunk，但只在 Builder Canvas route 动态加载，不进入 Agent 首屏。当前
公开入口不能在不复制第三方内部实现的情况下进一步安全切分；退出条件是上游提供
更细粒度、可 tree-shake 的稳定公开入口，或 Builder 改用更小的公开渲染边界。没有
通过提高 `chunkSizeWarningLimit` 隐藏该事实。

### 5.2 Agent clean reload 的真实资源

WebKit Resource Timing 只观察到 Agent 首屏必需资源：

- main entry / shell CSS；
- `AgentRoute`、`ArtifactImage`、`ModelSwitch`、`StatusPill`；
- `panel-right-open`；
- `useMainAgent`、`useShellWorkspace`、`useWorkspaceUi`；
- Agent route CSS。

真实 API 请求只有：

- `/api/workbench/v1/auth/status`
- `/api/workbench/v1/session`
- `/api/workbench/v1/workspace`
- `/api/workbench/v1/agent-definitions`
- `/api/workbench/v1/model-profiles`
- `/api/workbench/v1/recent-work`

没有 Skills、Loops、Builder、Runs 或 Team Library 的列表/详情请求。

## 6. 自动化与运行证据

当前前端源码：

- source identity：
  `sha256:fbd234c828b743acd4aa42974cde70ee25461930665edc72c2cbb7b881cfc5c4`
- build identity：
  `sha256:4010a30fc406a023b9423005389dd6984ff66542fce4f1a2c81ee005ad4f9908`

已通过：

- production build；
- bundle budget audit；
- core route/static smoke；
- 9 个 M5 state smoke；
- model routing、Skill definition/ZIP package smoke；
- 真实 HTTP Product server 上的 WebKit focus smoke；
- 390px / 200% zoom accessibility smoke；
- build identity 前后不变与 capture provenance 校验；
- 55 screen / 12 manual-keyframe 契约测试；
- 恶意构造的 54/55、伪造空 `failures`/`missingScreenIds` 均被 gate 拒绝。

Focus evidence：
`/private/tmp/looloomi-m5-focus-20260727-current/focus-smoke-manifest.json`

Accessibility evidence：
`/private/tmp/looloomi-m5-accessibility-20260727-current.json`

## 7. 真实截图与人工 review

最终当前构建的截图结果将在以下目录保留：

`/private/tmp/looloomi-m5-capture-20260727-current`

这次 capture 与上面的 source/build identity 绑定。它必须完整报告未能准备的状态，
不能因为数组被写成空值而通过。最终结果：

- capture status：`blocked`
- 当前构建真实截图：23/55
- 明确失败状态：31
- 未覆盖 screen ID：32
- 已捕获人工关键帧：7/12，全部保持 `pending`
- 缺失人工关键帧：`agent-running-result`、`model-switch-capabilities`、
  `loop-staged-proposal-review`、`loop-lifecycle-run-boundary`、`state-board`
- visual evidence audit：按预期 fail-closed，48 个独立错误；没有 source/build
  identity mismatch。

阻断原因被保留为真实产品状态：当前环境没有 Provider、editable/ready/published
Loop、可采用的 Team release 和 prepared recovery-state 输入。没有用 DOM/fetch stub、
宿主 fallback 或历史截图替代。

用户人工 review 的 12 个重点：

1. Agent 空态是否一眼知道要做什么；
2. Agent 运行/结果流是否自然；
3. ModelSwitch 的能力过滤、禁用和失败反馈是否可信；
4. Skill 定义/导入与 Draft/Test/Publish 边界；
5. Skill wizard 最终 review；
6. Loop 创建入口；
7. staged proposal review/edit/confirm；
8. Loop lifecycle 与 Run 结果边界；
9. Team Library；
10. Agent 390px；
11. 创建流程 390px；
12. loading/error/permission/conflict/recovery 状态板。

## 8. 独立交叉审查

### Frontend / QA

- P0：0
- P1：0
- 已修复：Preflight 权威 capability、重复 route query、移动端 Create accessible name、
  55/55 gate 与 build/capture identity 绑定。

### Backend / Product API

- P0：0
- P1：0
- Contracts：47/47；
- Backend：491 tests，477 pass，14 skip，0 fail；
- Provider smoke：4/4（在允许本地 listen 的独立运行中）。

后端剩余 P2：

- nonterminal invocation 启动恢复尚无通用 reconciliation；
- Mongo process-kill fault injection 尚未覆盖，现有为 in-memory crash-window 证明；
- existing Workflow proposal 尚无独立 GET refresh recovery；
- execution-events 的公开 projection 仍为较宽的 `JsonObject`。

这些问题不推翻本轮前端 M5 和 route/resource split 结论，但进入单机生产发布前仍应
纳入发布 gate。

## 9. 发布判定

| 层级 | 判定 | 原因 |
|---|---|---|
| M5 设计包 | PASS | 规格、关键页面、状态、组件交互和 390px 已闭环 |
| 前端实现 | PASS | 真实 route/data/resource boundary 与 Product API 已接入 |
| 前端代码审查 | PASS | P0/P1 = 0 |
| 自动 QA 基线 | PASS | build、smoke、bundle、focus、a11y、provenance 通过 |
| M5 视觉发布 | **NO-GO** | 未达到 55/55 当前构建截图和 12/12 hash-bound 人工批准 |
| 单机生产发布 | 仍受生产 gate 约束 | 本轮没有绕过 Provider、恢复、镜像和发布演练要求 |

因此可以把当前代码作为下一轮 M5 视觉补证和用户审查的实施基线，但不能在缺少真实
页面状态和用户人工 review 时宣称“55 屏已签收”或“生产可发布”。
