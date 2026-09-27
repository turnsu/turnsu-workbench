# M5 v2 UX 重构交叉 Code Review

- 原始日期：2026-07-25
- 重审日期：2026-07-30
- Harness 收敛日期：2026-08-04
- 代码证据快照：`sourceIdentity sha256:2d1b8792786a35baacb9db27a92c4e81b1fb39b43c6a9bee9232dac54acac507`；
  `buildIdentity sha256:2f0fe8a0c0f99e127d986e22066c5061a64d5a9a036144f190378e595db2bc35`
- 适用规则：该快照不自动覆盖后续 source/build identity；后续候选须重新验证
- 审查基线：`wiki/design/skill-loop-cloud-workbench-v1/m5/` 下的 v2 redesign、
  flows/states、component interactions 与 keyframe board
- 范围：Agent、模型选择、Skill creator、Loop lifecycle/Agent handoff、Library、
  responsive、证据门禁

## 一、结论

2026-07-25/27 文档中的“代码层 P0=0、P1=0、M5 可作为完成基线”不能继续使用。
当时通过的门禁包含旧产品假设，并把局部组件、build、静态 selector 和部分 capture
错误上升为完整落地。

本次重审采用的签收语义是：

- **代码存在不等于真实主路径消费；**
- **按钮文案更新不等于控制链更新；**
- **PNG 存在不等于来自当前 build 的真实产品状态；**
- **自然语言结构描述不等于断言被执行；**
- **55 个自动状态与 12 个人工关键帧是两层门，不是 67 张设计稿。**

2026-07-30 再审发现，前一版仍把 controlled manual-review fixture、静态调用存在和
真实 Product API 功能就绪混在同一完成叙事里；同时创建入口没有按操作区分 Draft、
Test、Run、Import readiness。因此 2026-07-29 的“代码级 P0/P1 已清零”已经失效。

截至该证据快照，纠偏实现已经补齐 Product-owned operation-specific readiness、Skill/Loop 创建与
恢复语义、Connection fail-closed、Attachment→Workspace Resource、typed NotFound 和
Library review URL 恢复，并通过与快照对应代码的自动化门；但**功能人工签收、视觉签收和
单机生产发布仍全部为 NO-GO**。`npm run review` 现在显式标记为 `visual-only`，
不得再用于 Skill/Loop/Connection/Resource 功能签收。

2026-08-04 已进一步收敛验证体系：删除合成 evidence manifest 与无消费者的截图拼接，
把 `smoke`/`m5:smoke` 降为明确的结构覆盖库存，把 `review:no-permission`/offline 降为
visual-only 预览；源码字符串命中不再输出功能通过。保留的功能证据是直接 import 的
API/reducer/route 行为测试，以及连接真实同源 Product API 的 DOM/E2E。

## 二、旧版被误判完成的根因

1. **权威基线漂移**：旧 QA 仍引用 2026-07-25 v3 语义，而最新设计已经取消 Agent
   details drawer、chat/image mode segmented、Skill creator modal 与主路径
   Run Preflight。
2. **测试保护旧实现**：旧 `m5-ux-smoke` 的源码字符串断言与旧 DOM、focus、accessibility、capture 主动要求
   旧 drawer、旧 model selector、旧 Skill modal、旧 preflight，因此绿灯会阻止新设计。
3. **文案与控制链混淆**：Loop CTA 已显示 “Run in Agent”，但审查时实际 handler 仍可
   调用 `workspace.prepareRun`，说明产品表层与真实所有权没有一起迁移。
4. **局部完成被上升为全局完成**：model picker、proposal、wizard 单独存在，却未证明
   个人 Session、结果 reader、Node runtime、Loop-to-Agent、移动端和 Library 组合链路。
5. **视觉证据门过弱**：旧 `structuralAssertions` 只是字符串 metadata，没有在页面执行；
   PNG 校验只看格式/尺寸/hash，无法拒绝声明为 synthetic/composed 的图。
6. **历史证据混用**：旧 capture 来自旧 dist 或只覆盖部分 screen；缺失状态仍被文字
   总结成“基线通过”。
7. **环境能力被简化成入口布尔值**：前端曾硬编码 Skill/Workflow create available，
   没有区分“可以保存私有 Draft”与“可以测试/运行/导入”。
8. **材料语义混淆**：Skill Step 2 的 schema 声明被呈现成“添加材料”，而真实 sample
   上传和执行 binding 不在同一创建流中。
9. **恢复路由没有对象所有权**：非法 route 静默回 Agent；stale proposal、Library
   update draft 和同路由 query 变化缺少可恢复状态。
10. **Connection metadata 冒充验证**：label/permissionSummary 可进入 validate，
    即使 opaque credential、production driver 与真实 probe 从未存在。

## 三、交叉审查发现

| 等级 | 发现 | 正确边界 | 状态 |
|---|---|---|---|
| P1 | controlled manual-review fixture 缺少真实创建/导入接口，却被用于人工功能判断 | fixture 只能是 visual-only；功能 QA 必须连接真实 Product API + `_test` Mongo | 已显式标记 visual-only，API client 在发出网络请求前拒绝全部业务 mutation；功能证据仍未验证 |
| P1 | Global Create/Skill/Loop 曾使用硬编码 availability，入口后才发现 model/runtime/tool/connection/backend 不可用 | 一个 Product-owned read model 按 draftable/testable/runnable/importable 给出状态、reason 和 recovery；mutation 提交时复验 | 已新增 `/workspace/feature-readiness`，删除硬编码布尔真相源，并补后端 composition 测试 |
| P1 | Skill 默认 output description 为空但校验必填，只显示通用错误 | 默认值可见；必填/重复 identifier 使用字段级错误、摘要和首错聚焦 | 已修复并加入静态防回退；真实 DOM/focus 待验证 |
| P1 | Step 2 材料 schema 与 sample upload 混淆 | Step 2 只声明 slot；Step 6 通过 personal Attachment/Workspace Resource 形成 `materialBindings`，不写 canonical Draft | 已接入；Attachment/Resource 服务测试通过，真实 Docker material 路径待验证 |
| P1 | Blank Loop 主入口绕过已有名称/确认表单 | 先确认名称和私有 Draft，再调用 Product API；失败保留输入 | 已修复主入口可达性与 retry |
| P1 | Proposal backend/model 不可用时可能在执行后失败或把手动 fallback 报成成功 | mutation 在 durable invocation 前复验；fallback 必须二次确认“手动 Draft”，stale URL 显式失败 | 已修复并有后端/静态门；真实 Provider E2E 待验证 |
| P1 | Connection 仅填写描述即可 validate，前端未使用 opaque credential binding | 只有 bound credential + production driver + probe/scope/effect 才 valid；无 binder 时明确 unavailable | 已 fail closed；真实 credential/driver 尚未提供，不能签收成功路径 |
| P1 | CreateResource 仅支持粘贴文本，Loop import 无法建立文件 Resource | personal Attachment 经权限/hash/TTL/processing 复验后提升为 immutable Workspace Resource | 已支持图片/TXT/MD/CSV/text PDF/DOCX/XLSX；真实 extraction sandbox 待验证 |
| P1 | unknown route 回 Agent、Inbox setup route 不可恢复、update draft 刷新丢上下文 | typed NotFound；setup 指向受治理恢复面；`updateDraftId` 立即写 URL 并按终态清除 | 已修复并通过 routing/M5 静态门 |
| P1 | 移动端仍暴露目录/ZIP/GitHub/server import | 手机只开放轻量定义；导入显示回桌面边界且不渲染 file picker | 已修复；390px DOM/截图待验证 |
| P1 | Loop 主 CTA 的 “Run in Agent” 曾消费 `prepareRun`/page preflight | 必须创建/选择个人 Agent task，携带 canonical Loop ID | 已改为 `startLoopAgentTask` + 精确 Session deep-link；静态 gate 通过，等待 DOM 实跑 |
| P1 | Loop handoff 一度只生成 `/?session=...`，Agent 端没有消费 query，可能仍打开旧/首个 Session | 生产者与消费者必须共同证明刚创建的 Session，且只能接受当前用户 Session 列表中的 ID | 已补 query 消费、合法列表校验、切换/新建 URL 同步；新增假阳性回归 gate 并通过 |
| P1 | 旧 M5 smoke 断言 Agent drawer、双模型 picker、Skill modal、preflight | 门禁必须按 2026-07-28 基线 fail-closed | 已重写 |
| P1 | capture 的结构条件只写字符串，不执行 | inventory 定义机器断言；截图前逐条执行，失败不得产出合格 shot | 已修复 |
| P1 | 合成或拼接 PNG 可通过文件层校验 | manifest v4 要求同源 WKWebView provenance，拒绝 synthetic/composed | 已修复契约与负向测试 |
| P1 | 旧 visual inventory 与最新 25 个设计 frame 无映射 | 55 状态逐项映射 frame，12 项独立人工 review | 已修复 |
| P1 | Agent result/session 的关键状态缺少稳定 DOM 契约时无法证明 | result copy/download/run-info、Session new/list/collapse/queue/Loop marker 必须可执行验证 | `surface`、`composer`、`model-unavailable` 与结果/Session DOM 已补齐；静态 gate 通过，等待认证 DOM 实跑 |
| P1 | Skill DOM/capture 仍填写已删除字段并期待 modal | `/skills/new` 全页七步向导，契约材料/参数/产物与 runtime catalog 是权威 | QA 已重写；等待真实 DOM |
| P1 | Tool 卡片一度只执行 `setMode("tool")`，正文却落入 server import，注册目录变量和连接函数未被消费 | 目录必须来自 Product API；只显示并生成精确注册 Action ID；仍走统一 inspector | 已补 Product API catalog、Action ID DOM、连接与 retry；静态及 package 负向 gate 通过，等待认证 DOM |
| P1 | lifecycle handler 缺失 runtime/tool catalog/Loop Agent task 路由 | 浏览器只能通过正式 Product API 消费这些能力 | `listSkillRuntimes`、`listRegisteredToolPackages`、`startLoopAgentTask` 已接入 handler 与契约测试 |
| P1 | Loop handoff 曾只创建 Session，没有消费真实 Run/timeline/result/cancel | Product Runner 是 Run 唯一权威，Agent 页只能读取和操作真实 Run | 已接入 Run、invocation、event、artifact、result 和 cancel；活动 Run 轮询，终态停止并最终 refetch |
| P1 | `startRun` 把 trace-only `requestId` 放入幂等指纹 | 相同业务命令重试不得因 trace ID 变化产生新 Run | 已从业务指纹移除并增加回归测试 |
| P1 | Mongo Agent Session 写入与 Product idempotency receipt 非同一事务 | Session/Turn 与 receipt 必须原子提交 | 已共用 Product 事务；失败不留下部分 Session |
| P1 | Runner 读取源对象失败曾伪装成业务 `blocked` | 基础设施读取失败必须是可重试 503，不得成为成功业务状态 | 已 fail-closed 为 source read error |
| P1 | Builder proposal 仍受共享 Session busy 限制 | proposal 是独立 bounded worker，不占用共享 Agent Session | 已迁移至独立 worker 控制链 |
| P1 | Module Agent proposal 曾只写 Mongo，前端无法读取/应用/拒绝，个人 branch 也没有保存三方合并 base snapshot | proposal 必须经个人 Session/branch 的 Product API 明确决定；非重叠 rebase，同路径冲突不改 canonical | 已补 base snapshot、GET/apply/reject、Skill/Loop 三方合并、冲突记录、前端 review 与跨用户负向测试 |
| P1 | Inbox 曾受普通 repository 1,000 行上限影响，且同一路由 query 变化不一定重新消费 | 需要处理 read model 必须完整、cursor 稳定、action route 可重复触发 | 已使用显式完整 read-model scan 并补 1,005 行回归；前端以 navigation key 重新消费 |
| P1 | legacy daemon/native launcher 仍可能被误作生产控制面 | 当前生产只能进入 Product API/Runner/Broker；旧入口必须默认拒绝且不进入 release | daemon 与 native client 默认 exit 64，release allowlist 排除 daemon；仅显式 test/compatibility override 可运行 |
| P1 | 通用附件、图片理解和 Skill material 曾停留在 UI/类型层 | Attachment 必须个人隔离、可提取、可绑定；`image_input` 必须前后端及 Provider shape 双重验证 | 已接入 Attachment Service、Sandbox derived representation、Turn/material binding、三类视觉协议和负向测试 |
| P1 | Connection metadata 曾可被误报为 valid，且 Run 可能在重绑后使用新连接 | 只有真实 driver probe 可 valid；Run 必须冻结 Connection revision/driver/capability/validation | 已补 driver 边界与执行快照，运行时重绑明确 `connection_rebind_required` |
| P1 | Skill creator/编辑器在浏览器生成 runtime starter 和协议字段 | Product runtime catalog 与 package scaffold 必须是唯一权威 | 已新增 Product-owned scaffold API；编辑器只消费服务端 package/files/manifest |
| P1 | 中文/超长 Skill 名、描述和接口名可能生成非法或碰撞包 | scaffold 输出必须稳定、唯一、符合 inspector 限制且保留完整人类文本 | 已用稳定 digest 后缀、字段边界与接口去重修复，并通过 scaffold→inspector 测试 |
| P1 | Skills 路由实际渲染触发 `runLoop is not defined` | route smoke 必须覆盖可运行页面，旧 Preflight 只能走当前 Agent handoff | 已删除 stale workspace export，并把兼容 Preflight 改为 `runLoopInAgent` |
| P1 | Agent backend 已注册但 Docker/image 实际不可用或未验证时，readiness/mutation 曾可能继续 | “注册”不是“可运行”；readiness 与 proposal mutation 必须要求 verified probe，并在 store/external/invocation 副作用前 fail closed | 已新增 `probeBackend`，区分 missing/unverified/ready/unavailable；staged/existing proposal 对 unverified 均零副作用拒绝，并有定向测试 |
| P1 | portable Loop import 曾只检查 Connection `connected + valid` | import、Run 和 Library 必须复用同一 production Connection operational check，拒绝 unbound/test/expired | 已统一复用 `connectionOperationalIssue`，并增加 credential/backend/expiry 负向矩阵 |
| P1 | 图片 Attachment 可提升为 ready Resource，但旧 consumer 只会 UTF-8 `readText` | 图片 Resource 必须按治理后的原始 bytes + 引用进入 material resolver；文本读取仍应拒绝非文本 | 已新增 `readContent` 并让 resolver 消费 bytes；图片 Resource 定向测试通过 |
| P1 | Loop proposal retry 成功只更新组件 state，未写新 `proposalId` URL | 初次生成和 retry 必须共享 URL ownership，刷新恢复同一 staged proposal | 已调用统一 `replaceStagedProposalLocation`，routing/M5 门通过 |
| P1 | Skill sample 与 Workspace Resource 上传存在旧请求覆盖新选择、关闭后落副作用的竞态 | 每个 material row 与 Resource dialog 都要 generation fence；stale Attachment 清理；提交期间禁止关闭 | 已加入 per-row upload token、stale Attachment 删除、dialog mounted/generation guard 与 side-effect 分离 |
| P2 | malformed GitHub runtime manifest 未映射稳定 Product error | repository 输入错误应为可恢复的 422，不能泄漏为 500 | 已映射 `repository_runtime_manifest_invalid` 并加入 HTTP 回归 |
| P2 | fake Connection driver 曾被测试标成 production，跳过的 Mongo test 又断言伪成功 | fake 必须标 test；无真实 binder/driver 的测试应证明 `needs_setup`/`connection_not_ready` | 已改为 test backend；HTTP/Mongo 集成用例改为 fail-closed，真实成功路径保留为环境 gate |
| P2 | accessibility 用 Skill creator 证明 modal focus trap | Skill creator 非 modal；改用仍合法的 Loop importer dialog | 已修复 |
| P2 | focus smoke 要求旧 drawer 和 `model.chat` | 要求个人 Session/New task 和单一 `model` picker | 已修复 |
| P2 | 重新截图可能错误地让全部人工 review 失效 | 只按 `screenId + contentHash` 失效变化项 | 已有逻辑并新增定向回归 |
| P2 | 非法 Agent deep-link 曾静默选中其他 Session | URL 指定的对象必须精确成功或显式失败 | 已改为 exact fetch/notfound/forbidden，不静默回退 |
| P2 | Skill 最终 review 未显示执行预算 | 用户保存 Draft 前必须看见 timeout/memory/network/scratch | 已补完整预算摘要 |
| P2 | 对话框初始焦点仅依赖 `requestAnimationFrame` | 嵌入式 WebKit 被节流时焦点仍必须立即进入 dialog | 已同步聚焦 dialog 并异步聚焦首控件；WebKit focus trap 实跑通过 |

## 四、QA 门禁重构

### 4.1 Inventory v2

`scripts/visual-screen-inventory.json` 现在固定：

- `schemaVersion: 2`；
- `designBaseline: 2026-07-28-m5-v2`；
- 55 个唯一 screen ID；
- 12 个 `manual-keyframe`；
- 设计 frame `00–19` 全覆盖，包括 Skill 细分 frame `05B–05F`；
- 每项至少一个可执行 `structuralAssertions`。

支持的结构断言是：

- `selector_exists` / `selector_absent`；
- `count_at_least` / `count_at_most` / `count_equals`；
- `attribute_equals`；
- `min_target_size`。

### 4.2 Capture 与 evidence schema v4

`capture-audit.swift` 在 snapshot 前执行 inventory 中该 screen 的全部断言。任何断言
失败都会形成 named failure，不会生成“看起来正常”的合格证据。

每个成功 shot 记录：

- `structuralCriteria`：给人的检查说明；
- `structuralAssertions`：机器实际执行结果、actual、时间；
- `captureProvenance`：WKWebView engine、same-origin mode、前后 route、
  source/build identity、content hash、`synthetic=false`、`composed=false`。

`visual-evidence-audit.mjs` 核对 12 个当前关键帧的 provenance、PNG、viewport、
build identity 和 hash-bound 人工 review。其余 43 个 screen ID 只属于覆盖库存；
不得因为未逐张截图而阻塞视觉 review，也不得把库存完整解释成功能完成。

对于实际提交的关键帧，审查器继续拒绝：

- 结构断言失败或缺失；
- synthetic/composed；
- capture 前后 route 不一致；
- 当前内容 hash 改变；
- 历史 rejected hash；
- 当前 P0/P1 与 P2 finding；
- source/build mismatch。

### 4.3 用户路径门

- `m5-ux-smoke.mjs`：只检查 route 行为和 55/12 screen inventory 契约，输出
  `functional_evidence=false`；不再扫描产品源码以证明主路径；
- `dom-smoke.swift`：Skill 七步真实填写，Ready Loop 主 CTA 后必须进入 Agent task；
- `focus-smoke.swift`：单 model picker 的 Arrow/Home/End/Escape/return-focus，个人
  Session/New task 与新 Library；
- `accessibility-smoke.swift`：Skill creator 按全页处理，只对合法 importer dialog
  证明 focus trap；
- `routing-smoke.mjs`：不再把 `/loops/:id/run` 当作 M5 主路径验收。

## 五、已验证与未验证

2026-07-30 证据快照已验证：

- 55 inventory / 12 manual keyframe 的覆盖定义存在；旧 synthetic contract smoke 已删除；
- 当前 visual audit 仍以 `screenId + contentHash` 绑定人工 review；
- `capture-audit.swift`、`dom-smoke.swift`、`focus-smoke.swift`、
  `accessibility-smoke.swift` 均逐文件 Swift typecheck 通过；
- inventory JSON 有效、screen ID 唯一、设计 frame 覆盖完整。
- 当时产品实现合并后的 `m5-ux-smoke` 曾以源码字符串命中 Loop Agent task 的
  `startLoopAgentTask`、精确 `sessionId` deep-link 和 Agent 端合法 Session 消费代码
  存在；这只保留为历史线索，不替代认证 Product API 运行轨迹；
- Contracts 52/52；Backend 扩展全量命令
  `../../../../.tooling/node/bin/node --test tests/**/*.test.mjs`
  在允许受控本机 loopback bind 的执行环境中为
  574 tests，557 pass / 17 skip / 0 fail；loopback Provider smoke 只证明协议
  adapter shape，不是外部 Provider 证据；
- Agent 全量与 75,741 文件 runtime-integrity 通过，快照 manifest digest 为
  `bc655a10b4e65757660ecbb7b7c2f4d2c8e781e9a52d96c7fe3267c6787e9b1c`；
- production build、bundle budget、完整 state smoke 与 M5 gate 通过。该快照
  `sourceIdentity` 为
  `sha256:2d1b8792786a35baacb9db27a92c4e81b1fb39b43c6a9bee9232dac54acac507`，
  `buildIdentity` 为
  `sha256:2f0fe8a0c0f99e127d986e22066c5061a64d5a9a036144f190378e595db2bc35`；
- JS entry 257,745 raw / 79,441 gzip；含入口 CSS 的初始资源为
  273,354 raw / 83,367 gzip；所有业务页面按 route lazy load；
  `fflate` 仅 ZIP 路径动态加载。唯一大于 500 kB 的 Flowgram vendor 为 Builder-only
  异步 chunk（657,159 raw / 193,308 gzip），不进入 Agent 首屏；
- Tool package 正向/负向测试通过：只允许 `registered` 项，生成 manifest 保留
  `action/effect/confirm`，不包含执行命令、参数或密钥字段。
- 最终独立复核针对 backend probe、portable Connection、binary Resource resolver、
  proposal URL/upload 竞态、Resource side effect 与 visual-only mutation fence 重找反例；
  修复 `registered-unverified` proposal 后，该复核范围 P0=0、P1=0。
- 2026-07-29 build 的同源受控视觉桩曾通过 WebKit accessibility smoke，但当前
  source/build identity 已变化；该结果只能作为历史缺陷发现记录，不能继承为当前
  DOM、accessibility 或功能通过。

尚未验证：

- 认证 Mongo + 该快照 dist 上的完整用户数据/权限 DOM 实跑；
- Ready Loop → Agent personal Session → Turn/worker → result reader 的完整轨迹；
- Python 与 Node.js/TypeScript runtime 在真实 sandbox 的创建/测试；
- 55 状态 route/DOM 覆盖运行，以及 12/12 当前 build capture 与对应 hash 人工审批；
- 外部模型 Provider 的计费 smoke。

该快照 build 的 `npm run audit:evidence` 返回 exit 1，并明确报告
`visual_manifest_unreadable:ENOENT`、`visual_manual_review_unreadable:ENOENT`；因此视觉
与人工签收仍为真实的 fail-closed gate，而不是由旧截图继承的通过状态。

受控视觉桩没有被误报为生产链通过：它只为该快照 production dist 准备 UI 状态，用于
发现路由运行错误、视觉偏差和可访问性缺陷；不写 Mongo、不执行 Skill/Loop、不调用
Provider，也不构成人工关键帧审批。

已知残余 P2/发布例外：

- Inbox 当前在单机进程内聚合完整 workspace 源记录；多机或大租户前需物化/增量索引化，
  不能简单提高内存扫描规模；
- 上传 Skill 容器仍可通过 `/proc/self/mountinfo` 观察只读 bind mount 的宿主 backing
  path；在真实生产开放不受信任上传 Skill 前，需要隐藏/替换 `/proc` 暴露并递归净化
  结果字段；
- Attachment extraction 的前实例目录清理基于“单实例独占 temp root”；未来多实例共享
  目录前需要 instance marker/lease；
- Lark Tool 输出目前为敏感字段黑名单；启用真实 Lark credential driver 前必须改成
  action-specific output allowlist；
- Flowgram 仍是 657,159 raw 的 Builder-only deferred vendor；升级为更细粒度公开入口后
  应重新评估拆分；
- 17 个 backend skip 对应需要真实 Mongo/Docker/外部环境的 gate，不能解释为通过；
- 当前认证 Mongo 启动因 `keychain_secret_unavailable` fail-closed，Docker 集成因 daemon
  unavailable skip；`workbench_local diagnostics` 的精确失败项为 `config=false`、
  四个 Mongo Keychain account 均不可用及 `docker=false`，没有 fallback 为成功；
- visual evidence schema 尚未内建 fixture/backend 的 `evidenceTier`；当前 visual-only
  mutation fence 与文档可以保证功能证据不混用，但未来自动化审计应显式记录 fixture
  identity，避免仅靠流程约束；
- Provider release evidence contract 尚不能从结构上区分 external Provider 与 test
  double；当前文档已把 loopback smoke 限定为 adapter shape，生产 release 仍必须提供
  独立外部 Provider 证据。

## 六、最终签收要求

只有同时满足以下条件，Code Review 才可更新为 M5 v2 `GO`：

1. Loop 主 CTA 没有任何旧 `prepareRun`/preflight 消费路径；
2. 两用户的 Session、transcript、权限和临时分支隔离有真实负向证据；
3. Agent 统一 model picker 与后端 model route 的 requested/actual revision 一致；
4. Skill 全页 creator 的 Python 和 Node/TypeScript 都来自治理 runtime catalog；
5. 55 状态覆盖库存无缺口，12 个关键帧 capture 全部来自同一 source/build identity；
6. 12 项人工关键帧全部为当前 content hash 的 approved，且无 open P0/P1；
7. 全量 build、contracts、backend、Agent 与单机生产门分别通过。

在这些证据完成前，正确状态是 **M5 v2 corrective implementation candidate /
functional, visual and production NO-GO**。代码实现、真实功能签收、人工视觉签收和
生产发布是四项独立结论。
