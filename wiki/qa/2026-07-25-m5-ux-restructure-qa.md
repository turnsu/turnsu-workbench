# M5 v2 UX 重构 QA 与测试用例

- 原始日期：2026-07-25
- 纠偏日期：2026-07-28
- Harness 收敛日期：2026-08-04
- 最新记录的代码证据快照：2026-07-30
- 快照 `sourceIdentity`：`sha256:2d1b8792786a35baacb9db27a92c4e81b1fb39b43c6a9bee9232dac54acac507`
- 快照 `buildIdentity`：`sha256:2f0fe8a0c0f99e127d986e22066c5061a64d5a9a036144f190378e595db2bc35`
- 适用规则：后续 source/build identity 不继承本快照的 build、DOM、视觉或功能结论；
  必须重跑对应门禁并另记证据
- 当前设计基线：
  - `wiki/design/skill-loop-cloud-workbench-v1/m5/M5_UX_REDESIGN_V2.md`
  - `wiki/design/skill-loop-cloud-workbench-v1/m5/USER_FLOWS_AND_STATES.md`
  - `wiki/design/skill-loop-cloud-workbench-v1/m5/COMPONENT_INTERACTIONS.md`
  - `wiki/design/skill-loop-cloud-workbench-v1/m5/M5_KEYFRAME_BOARD.html`
- 判定顺序：真实用户控制链与运行产物 > 能抓住错误路径的 DOM/状态测试 >
  代码与类型结构 > 文档和静态描述。

> 本次纠偏废止 2026-07-25/27 文本中“Agent drawer”“Chat/Image mode
> segmented”“Skill 创建 modal”“Loop page-owned Run Preflight 是主路径”等旧断言。
> `/loops/:id/run` 若为历史兼容保留，不得再由 M5 主 CTA 消费。

> **2026-07-30 功能证据纠正**：`npm run review` 启动的是显式
> `VITE_REVIEW_MODE=visual-only` 环境。它只能检查视觉与交互状态，不能用于
> Skill/Loop 创建、导入、Connection、Resource、Test 或执行签收。功能结论必须来自
> 真实 Workbench Product API、隔离 `_test` Mongo 和明确标记的 test driver/provider；
> fake 只能证明协议和失败边界，不能证明真实 Provider、Docker 或 credential 可用。

> **2026-08-04 Harness 收敛**：已删除合成 PNG evidence smoke 与无消费者的截图拼接脚本；
> `smoke`/`m5:smoke` 现为兼容名称，只运行 route + screen inventory 结构检查，输出明确
> 标记 `functional_evidence=false`。`review:no-permission` 和 offline export 只准备视觉预览，
> 不再运行或汇总功能 DOM。真实功能证据来自直接 import 的 API/reducer/route 行为测试，
> 或连接同源 Product API 的 DOM/E2E。

## 一、发布门定义

M5 v2 的视觉证据由两层组成，不能互相替代：

1. `visual-screen-inventory.json` 固定 **55 个**路由/状态，作为自动 route/DOM 覆盖库存；
   库存完整或静态结构命中不能证明功能完成，也不要求 55 张逐项人工截图；
2. 其中 **12 个**是视觉关键帧，必须由同源产品页面真实截图，并按
   `screenId + contentHash` 人工审批。

截图必须来自 `WKWebView.takeSnapshot` 的同源产品路由，manifest schema v4 记录
`sourceIdentity`、`buildIdentity`、进入/离开路由、内容 hash 和每条已执行结构断言。
`synthetic=true`、`composed=true`、结构断言未执行/失败、截图与 build identity 不一致
时一律失败。重新截图只使内容 hash 变化的关键帧 review 失效；未变化关键帧沿用原
审批。

以下证据都不构成视觉通过：

- build 成功、静态源码命中或 DOM 数量正确；
- 只在 manifest 写自然语言 “structuralAssertions”；
- 合成 PNG、旧截图、设计板导出图或跨 build 截图；
- 12 个关键帧中任一缺失、来自旧 build 或 capture 失败；
- 12 项人工 review 为 `pending`、缺失或存在未关闭 P0/P1。

## 二、Agent 任务工作区

| 编号 | 用例 | 预期 |
|---|---|---|
| A-01 | 登录后打开 `/` | 默认进入 Agent；`/agent` 仅为兼容入口 |
| A-02 | 检查桌面布局 | 左侧为当前用户 Session 列表，中间为任务历史/输入，结果按需打开 reader；无旧 details drawer |
| A-03 | 新建、切换两个 Session | Session、turn、transcript 与选择状态按用户隔离；切换不串线 |
| A-04 | 同 Session 连续提交 | Turn FIFO；当前 Turn 内可并行 worker，但不会并发修改同一 Session Turn |
| A-05 | 两个 Session 执行 | 可并行，状态分别显示 queued/running/review/completed/failed/blocked |
| A-06 | 打开完成结果 | Markdown/image artifact 在 reader 中可读，可复制/下载，并显示模型、来源和耗时 |
| A-07 | 多结果与结果加载失败 | 可切换结果；失败有明确重试，不覆盖原任务历史 |
| A-08 | Loop 发起执行 | 创建或选中带 Loop 标识的 Agent task；保留 canonical Loop ID，不进入主页面 Preflight |
| A-09 | 移动端打开 Agent | 显示任务工作区与四项底部导航；无抽屉式 Agent details |
| A-10 | 附件与模型不兼容 | 显示原因，并提供换模型/移除附件；不静默丢附件或降级 |
| A-11 | Module Agent proposal | 每位协作者使用独立 Session/branch/base snapshot；Inbox 打开真实 review，明确 apply/reject；非重叠三方合并，同路径冲突不改 canonical Draft |
| A-12 | 超过 200 条历史 | Session/Turn/Event 使用稳定 cursor 增量读取；身份切换取消旧 principal 请求，不泄漏上一用户结果 |

## 三、统一模型选择与路由

| 编号 | 用例 | 预期 |
|---|---|---|
| M-01 | 打开 Agent model picker | 只有一个受治理选择器，不再拆成 chat/image 两个 picker |
| M-02 | 选择文本、图像或多模态 profile | 同一 composer 保持不变，能力说明与可接受输入随 profile 更新 |
| M-03 | 提交文本任务 | 浏览器只提交 `modelProfileId` 和产品输入；provider payload 在后端 adapter 生成 |
| M-04 | 提交图片理解任务 | 只有声明 `image_input` 的 OpenAI-compatible、Anthropic 或 Gemini profile 可接收图片；后端生成各自协议 payload |
| M-05 | 模型不支持当前附件/能力 | 前端在提交前解释，后端再次拒绝；不静默换模型 |
| M-06 | profile 不可用/无默认模型 | composer 保留输入，提交禁用并给出恢复动作 |
| M-07 | profile revision 更新 | 新 Turn 固定新 revision；历史 Turn 仍显示当时 requested/actual revision |
| M-08 | provider/model 路由失败 | Session preference、Turn、message 与 event 不产生部分写入 |
| M-09 | 图片生成 | Stability 只声明 `image_generation`，不得作为图片理解模型；生成结果只返回治理 Artifact |
| M-10 | 通用附件 | 图片、TXT/MD/CSV、文本 PDF、DOCX、XLSX 先上传为 personal `AttachmentRef`；旧 DOC/XLS、扫描 PDF/OCR、宏和超限显式 blocked |

## 四、Skill 全页创建器

| 编号 | 用例 | 预期 |
|---|---|---|
| S-01 | 从 Global Create 选择 Skill | 进入 `/skills/new` 全页创建器，不打开 Skill modal |
| S-02 | 第一屏 | 清楚区分“定义新技能”和“导入已有技能” |
| S-03 | 七步 Prompt 创建 | 类型→契约→runtime→组织→package→smoke→review，可返回已完成步骤 |
| S-04 | 契约编辑 | materials 可为零；parameters 可为零；outputs 至少一个；字段校验可行动 |
| S-05 | Script runtime | runtime catalog 来自 Product API；至少支持 Python 3.12 与 Node.js 20 + TypeScript，选项显示隔离/网络/预算边界 |
| S-06 | runtime unavailable | 选项禁用并解释；不得偷偷使用 Python 或宿主进程 fallback |
| S-07 | package preview | 生成文件和内容可检查；不会在浏览器执行上传代码 |
| S-08 | smoke 定义 | 记录 purpose、sample input、可选 expected outcome，不伪装为已通过测试 |
| S-09 | review/save | 先创建私有 Draft；Test、Validate、Publish 分离 |
| S-10 | 导入目录/ZIP/GitHub | 进入同一 inspector；路径穿越、重复、炸弹压缩、超限和 runtime pair 不完整被拒绝 |
| S-11 | Tool 类型 | 目录只来自 Product API `/registered-tool-packages`；展示精确 Action ID、读写影响与确认要求；只能连接 `registered` 项 |
| S-11a | Tool 连接成功 | 生成的 `SKILL.md` 只声明所选注册项返回的 Action ID，并重新走统一 inspector；不会暴露 command、args、secret 或 connection |
| S-11b | Tool 目录/连接失败 | 保留当前选择并提供显式 retry；空目录、未注册项和非法 Action ID 均不得被包装成 Skill Draft |
| S-12 | 移动端创建 | 页面与固定 footer 可达；44×44 目标尺寸；无横向溢出 |
| S-13 | material:file Test/执行 | 只提交 Attachment/Resource binding；容器只读随机路径，无宿主路径、无网络、无 host fallback；权限/hash/TTL 再验证 |
| S-14 | 默认 output 与字段错误 | 默认产物不是隐藏阻塞；必填/重复 identifier 显示字段级错误、缺失摘要并聚焦首个错误 |
| S-15 | 材料声明与样本 | Step 2 只声明材料 slot；Step 6 才上传 personal Attachment 或选择 Workspace Resource；sample 不写入 canonical Draft、日志或 Memory |
| S-16 | Draft/test/run readiness | 可创建 Draft 但测试/运行未就绪时允许保存并解释阻塞；mutation 提交时后端再次校验 |
| S-17 | GitHub 错误恢复 | 非法 URL、not found、private/forbidden、redirect、rate limit、超限和取消均保留 URL/ref/subdir 输入并提供 retry |
| S-18 | 移动端导入 | 只开放轻量“定义新 Skill”；目录/ZIP/GitHub/server import 显示“请在桌面继续”，不渲染不可兑现 file picker |

## 五、Loop 创建、生命周期与 Agent handoff

| 编号 | 用例 | 预期 |
|---|---|---|
| L-01 | 打开 `/loops/new` | 文档生成、定义导入、起点和复制入口可发现 |
| L-02 | 文档生成 | 只写 expiring staged proposal；未确认前无 canonical Loop/revision |
| L-03 | proposal review | 显示“尚未创建”，可编辑、dismiss、apply；不能静默覆盖 |
| L-04 | apply proposal | 单事务创建 Workflow + revision 1，并把 proposal 标为 applied |
| L-05 | 看板 | 只有 Draft / Ready / Shared；Run 结果不成为 lifecycle lane |
| L-06 | Ready 卡片运行 | 主 CTA 调用 Agent handoff；不调用 `prepareRun` 或 `RunPreflightView` |
| L-07 | Agent 中的 Loop task | Session source 标记 Loop，显示运行状态、取消、结果和原 Loop 引用 |
| L-08 | 外层 Loop 与动态 worker | canonical Loop 图保持不变；worker/child 只出现在执行 timeline |
| L-09 | 起点/复制 | 从可用对象创建个人分支或新 Draft；版本冲突显式处理 |
| L-10 | proposal 重放/刷新 | 可按 creator/workspace/TTL 恢复；模型调用不重复；非创建者不可决定 |
| L-11 | 空白 Loop | 先显示名称和“创建私有 Draft”确认，再调用 Product API；失败保留输入并可 retry，成功后进入 Builder |
| L-12 | proposal 不可用 | 模型/backend/credential 不可用时保留文档；不静默换模型；转手动 Draft 必须再次明确确认 |
| L-13 | stale proposal URL | `/loops/new?proposal=...` 不存在、过期或无权时显式失败并提供 retry/返回；不得回 Agent 或盲建 Loop |
| L-14 | create flow ownership | Skill back/cancel 固定回 `/skills`，Loop 固定回 `/loops`；刷新和同路由 query 变化恢复同一上下文 |

## 六、Library、移动端、权限与恢复

| 编号 | 用例 | 预期 |
|---|---|---|
| C-01 | Team Library 桌面 | 领域 rail、类型 tabs、资产列表、上下文 preview 同时成立 |
| C-02 | Library 筛选 | domain/type/status 组合结果一致；空搜索有原因和清除动作 |
| C-03 | Library 移动端 | 单列可读，底部四项导航可达，无页面横向滚动 |
| C-04 | viewer | 创建、安装、更新、运行等写动作禁用并解释原因 |
| C-05 | 中文/英文、亮/暗主题 | 用户作用域持久化；不同用户互不覆盖；产品术语与设计基线一致 |
| C-06 | loading/empty/error/blocked/conflict | 显示原因、影响和恢复动作；不把降级写成成功 |
| C-07 | 200% zoom/390px | 关键信息不丢失，控件有 accessible name，交互目标至少 44px |
| C-08 | modal accessibility | 只对仍合法的 importer/duplicate dialog 验证 focus trap、Escape 和 opener 恢复；Skill creator 不作为 modal 用例 |
| C-09 | Connection 验证 | 仅填写名称/权限描述仍为 `needs_setup/checking`；只有 driver + opaque secretRef 的真实 probe/scope/effect 验证可进入 valid |
| C-10 | Library 更新 | `查看影响 → 创建更新草稿 → 审查 → 明确应用`；确认前 installation/canonical object 不变，既有 Run 保持原 pinned revision |
| C-11 | Inbox | proposal/conflict、review、Library update、Connection、Run、runtime/model 项使用同一 cursor read model；action route 可在当前路由重复消费 |
| C-12 | operation-specific readiness | Global Create、Skill/Loop 入口和 Inbox 消费同一 Product-owned read model；区分 draftable/testable/runnable/importable 与 reason/recovery |
| C-13 | Connection fail closed | 未绑定受治理 opaque credential 或无 production driver/probe 时保持 `needs_setup`，不能仅凭 label/permissionSummary 进入 valid |
| C-14 | Workspace Resource 上传 | personal Attachment 经权限/hash/TTL/processing 复验后提升为 immutable Resource version；Attachment/Resource/Artifact 不混用 |
| C-15 | 非法路由 | 未知、非法编码、缺失 ID 显示 typed NotFound 和对应列表返回动作，不静默回 Agent |
| C-16 | Library review 恢复 | 创建 update draft 后 URL 立即写入 `updateDraftId`；刷新恢复同一 review，终态清除 query，重复决定幂等 |

## 七、自动化命令与带日期证据快照

无需后端即可执行：

```bash
npm run build
npm run state:smoke
npm run action:smoke
npm run structural:inventory
npm run boundary:audit
env CLANG_MODULE_CACHE_PATH=/private/tmp/m5-swift-cache \
  xcrun swiftc -typecheck scripts/capture-audit.swift
```

证据分类：`state:smoke`/`action:smoke` 是直接 import 的行为测试；
`structural:inventory` 是覆盖库存；`boundary:audit` 是 import/Product API 入口边界；
build、库存和边界检查都不能替代真实功能 E2E。

需要认证 Product API、Mongo 和实际 Web 服务：

```bash
swift scripts/dom-smoke.swift
swift scripts/focus-smoke.swift
swift scripts/accessibility-smoke.swift
swift scripts/capture-audit.swift
node scripts/visual-evidence-audit.mjs
```

### 7.1 2026-07-30 纠偏证据快照

该快照已验证：

- Contracts 全量：52/52 pass；
- Backend 扩展全量命令
  `../../../../.tooling/node/bin/node --test tests/**/*.test.mjs`
  在允许受控本机 loopback bind 的执行环境中：574 tests，
  557 pass / 17 个环境或集成 gate skip / 0 fail；Provider smoke 使用本机 fake
  endpoint，只证明 adapter request/response shape，不是外部 Provider 证据；
- Frontend production build、bundle budget、完整 `state:smoke`、当时的 `m5:smoke`：
  全部通过；当时的 M5 静态 gate 新增了 Product readiness、visual-only marker、typed
  NotFound、Skill sample material、Loop blank/proposal recovery、Connection
  fail-closed、Resource promotion 和 Library URL 恢复的防回退断言；API client smoke
  还证明 visual-only 环境会在 `fetch` 前拒绝业务 mutation，而不是依赖 fixture 返回错误；
- 快照 `sourceIdentity`：
  `sha256:2d1b8792786a35baacb9db27a92c4e81b1fb39b43c6a9bee9232dac54acac507`；
  快照 `buildIdentity`：
  `sha256:2f0fe8a0c0f99e127d986e22066c5061a64d5a9a036144f190378e595db2bc35`；
- JS entry 257,745 raw / 79,441 gzip；含入口 CSS 的初始资源为
  273,354 raw / 83,367 gzip；Agent 首屏依赖为 687,714 raw / 189,961 gzip；
  Flowgram 仍为 657,159 raw / 193,308 gzip 的 Builder-only deferred vendor，
  因而 Vite 仍打印一个 >500 kB warning；bundle gate 只对这一已记录例外放行。

该快照尚未验证，后续 build 也不得继承为通过：

- 认证 Mongo + 真实 Product API 的 Prompt/Script/Tool Skill 七步完整 E2E；
- 真实 Docker 中 Attachment extraction 与 Skill material 只读挂载；
- 真实 Connection credential binding/probe；默认 Lark production driver 当前明确
  fail closed，前端显示 `connection_credential_binding_unavailable`；
- 外部 Provider、真实 GitHub 网络错误矩阵与实际计费调用；
- 390px 真实 DOM/focus/accessibility、55 状态 route/DOM 覆盖运行、该快照 build 的
  12 个关键帧真实 capture 与人工 review；
- 该快照环境的单机 diagnostics 为 `not_ready`：`config=false`，四个 Mongo Keychain account
  均不可用，`docker=false`。这些是环境 gate，不是代码 pass。

### 7.2 2026-07-29 先前证据快照

以下内容保留用于追溯，但其测试数量与 build hash 已由 7.1 替代，不能再作为“当前”
证据：

- inventory schema v2：55/55 唯一状态，12/12 人工关键帧子集，覆盖设计 frame
  `00–19`（含 `05B–05F`）；
- 当时的 synthetic evidence contract smoke 曾通过负向矩阵；该脚本已于 2026-08-04
  删除，不能再作为当前视觉证据。当前只接受 `capture-audit.swift` 的真实页面截图；
- `capture-audit.swift`、`dom-smoke.swift`、`focus-smoke.swift`、
  `accessibility-smoke.swift`：逐文件 Swift typecheck 通过；
- Contracts：50/50 通过；
- Backend 全量在允许本地 loopback bind 的执行环境中：559 tests，545 pass，
  14 个环境/集成 gate skip，0 fail；
- Agent 全量通过，runtime-integrity 覆盖 75,741 个 repository runtime files；
  快照 manifest digest 为
  `bc655a10b4e65757660ecbb7b7c2f4d2c8e781e9a52d96c7fe3267c6787e9b1c`；
- production build、bundle budget、完整 `state:smoke` 与 M5 gate：通过；
  快照 `sourceIdentity` 为
  `sha256:b1fc2dc72801e0193b3bbc58fa357c10c7536d0ab606f96133c8cc821543b3c6`，
  `buildIdentity` 为
  `sha256:e2f786d9a25a9f243eaf9dbea5f608eb6e4ad9cf427c67369b25a1c4da232684`；
- JS 入口为 256,107 raw / 78,941 gzip / 68,294 Brotli；含入口 CSS 的初始资源为
  271,264 raw / 82,747 gzip / 71,584 Brotli；Agent 首屏依赖为
  681,429 raw / 188,009 gzip / 161,830 Brotli。Agent、Skills、Loops、Builder、
  Runs、Library 与 Members 均为独立异步 route chunk；`fflate` 只在 ZIP 路径加载；
  唯一超过 500 kB 的 `Flowgram` chunk 为 657,159 raw / 193,308 gzip，且只在
  Builder 路由异步加载；
- 当时的 M5 静态 gate 命中 Loop CTA 调用 Product
  `startLoopAgentTask`，并用返回的精确 `sessionId` deep-link 到 Agent，而不是进入
  page-owned preflight；Agent 会精确读取 deep-linked Session，非法、无权或不存在
  Session 显式失败，不再回退到列表中的其他 Session；同时要求 Tool catalog 来自
  Product API、显示精确 Action ID，并通过 Product-owned scaffold 进入统一 inspector；
  这些是历史结构线索，不是功能执行证明，当前候选必须由行为测试或真实 E2E 复验；
- Tool package 定向负向测试：通过，已证明 `pending` 注册状态不能生成 package，
  生成结果不包含 `command`、`args`、`secret` 或 `credential` 字段。
- Product-owned Skill scaffold 定向测试：通过，已证明纯中文名、超长同前缀名、
  2,000 字描述、1,001 字接口描述和规范化后的接口名冲突都能生成稳定、可检查、
  不碰撞的合法包；
- 同源 production dist + 受控 Product API 视觉桩上的
  `accessibility-smoke.swift` 实跑通过：8 个 200% zoom/390px 组合、16 个
  locale/theme accessible-name 组合、Loop importer 正/反向 focus trap、Escape
  关闭与 opener focus 恢复均为 0 failure。该结果证明当前前端产物的布局与焦点契约，
  不替代认证 Mongo 或真实业务运行；
- capture harness 已直接覆盖当前 Skill contract、Python/Node runtime、组织、package、
  smoke、注册 Tool、Test/Validate/Publish，以及 Loop 起点/复制和移动 Library；只能由
  真实运行任务形成的 Agent queued/running/result/error 状态仍要求显式 prepared
  Product API state，不允许合成。
- 通用 Attachment、图片理解 capability/provider request shape、个人权限/TTL/hash、
  DOCX/XLSX/文本 PDF/MD/CSV 提取、扫描 PDF/宏/路径穿越/超限负向路径已由 Backend
  测试覆盖；Stability 仍是 `image_generation`-only。
- Module Agent proposal 现由 Product API 读取、apply/reject；个人 branch 保存 immutable
  base snapshot，Skill/Loop 三方合并的非冲突、冲突不落 canonical、跨用户拒绝和事务
  边界均有定向测试。真实 Mongo 的嵌套决策回滚用例已加入 integration suite。
- Inbox 已移除普通列表的 1,000 行截断，前端同路由 action query 会重新消费；
  225 个 Session 的 Mongo-shape persistence keyset 测试已覆盖同时间戳 ID tie-breaker、
  `taskStatus` 过滤、无重复/无缺口和跨用户隔离。Turn/Event 的 225 条 cursor 测试也通过；
  真实 Mongo + HTTP + UI 的大历史组合路径仍在环境未验证项中。

尚未验证：

- 该快照候选的认证 Mongo 实跑：临时启动因 `keychain_secret_unavailable` fail-closed；
- 该快照候选的真实 Docker sandbox：集成用例因 `Docker daemon is unavailable` 明确 skip，
  未发生宿主 fallback；
- 认证 Mongo 下完整 DOM/focus 与用户数据隔离实跑；
- 认证 Mongo 下超过 200 个 Session 的 HTTP/UI 增量分页组合实跑；
- 55 状态的 route/DOM 覆盖运行，以及 12 个关键帧的真实同源 capture；
- 12/12 当前内容 hash 的人工审批；
- 外部 Provider 计费调用。

该快照 build 上的 `npm run audit:evidence` 已按预期 fail closed：
`visual_manifest_unreadable:ENOENT` 与 `visual_manual_review_unreadable:ENOENT`。这证明
缺失的 capture/manual review 没有被 build、静态 gate 或历史截图伪装为通过。

该快照的页面人工抽查使用对应 production dist，并用临时、同源、无密钥的 Product API
视觉桩只准备可重复 UI 状态。它发现并关闭了 Skills 路由的 `runLoop is not defined`
真实运行错误、旧中英文导航文案、Agent 空状态双 `h1`、对话框初始焦点和旧中性主按钮
样式问题。视觉桩及其截图只能作为实现对照和缺陷发现证据，不能作为真实后端、用户数据
或 12 项人工视觉签收。

2026-07-30 的第二轮独立安全、前端行为与证据复审曾发现 readiness 将“已注册”
误报为可运行、portable Loop 的 Connection 复验不完整、图片 Resource 消费断链、
proposal retry URL 不恢复、异步上传竞态、视觉桩仍可发送业务 mutation 等问题。
这些问题已分别通过 Product backend probe、统一 Connection operational check、
governed binary Resource read、URL 恢复、generation fence 与 visual-only mutation
fence 修复；最终复核结论单独记录在 Code Review 中。此前已关闭的问题还包括：
private Skill/Loop 的 Module-Agent 与 Memory 对象授权、proposal apply/reject 的 actor
幂等隔离、附件 crash-recovery 与 TTL keyset 清理、请求 Session 的 fail-closed UI、
认证 revalidation generation fence，以及 Library 更新决策后的 URL/终态按钮清理。
仍保留的 P2/发布退出条件见 Code Review；这些未被静态 gate 或单机假设改写为通过。

## 八、签收规则

- 任一主 CTA 仍进入旧控制链、任一权限/模型错误静默降级、任一结构断言未真实执行：
  `NO-GO`；
- 代码/契约 gate、DOM/focus/accessibility、55 状态覆盖库存、12 项真实 capture 与人工关键帧是分别
  记录的门，不以一项通过替代另一项；
- M5 UI 通过不替代单机生产的 Mongo、Docker、Provider、backup/restore、
  upgrade/rollback 与供应链门。

交叉审查见
[`2026-07-25-m5-ux-restructure-code-review.md`](2026-07-25-m5-ux-restructure-code-review.md)。
