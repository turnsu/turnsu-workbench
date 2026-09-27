# 08 · M5 迭代交叉审查与实施记录（2026-07-25）

> **Historical / superseded.** 本文只描述 2026-07-25 候选及当时的判断，其中 drawer、
> text/image mode、Python-only 创建与 page-owned Run preflight 等语义已被
> [2026-07-28 M5 v2 设计包](../../wiki/design/skill-loop-cloud-workbench-v1/m5/README.md)
> 取代；测试数字和 hash 也不是当前候选证据。不得用本文宣布当前实现或发布通过。
> 文中 “Provider smoke 4/4” 仅指 loopback test harness，不是外部 Provider、凭证或计费
> 调用证据。

> 本文记录 `07` 与真实代码、测试和 Active Truth 文档的交叉审查。模型方向维持
> 标准产品路由，不新增、不调用、也不修改 K3/Kimi CLI、API、配置或密钥。

## 一、为什么之前“看起来完成”，实际仍是旧版

结论不是单个组件漏改，而是四类证据和权威源发生分叉：

1. **文档权威分叉**：`docs/rebuild/07` 已规定 Agent 首页和新创建流程，但根
   `README`、Current Architecture、Current Frontend Truth、`INTERACTION_QA` 仍把
   7 月 9 日的 Skills/Workflows/Templates 三入口标为 current。实现者和 reviewer
   能各自引用一份“权威”得出相反结论。
2. **旧测试保护旧产品**：原 smoke/DOM 仍要求根路由 Loops、独立
   `ChatComposer`/`ImageComposer`、五种 Loop 默认入口和旧 Skill 表单。测试为绿只能
   证明旧版没坏，不能证明 M5 用户路径存在。
3. **组件存在被误当能力完成**：model picker、proposal、wizard 的局部文件存在，
   但真实路径仍可能提前创建 Loop、让浏览器选择 revision、或根本走不到七步 wizard。
4. **缺少运行分层结论**：静态源码断言、build、mock 单测和真实 DOM/Provider/
   Docker 证据没有分开。环境未运行时曾被语言上折算成“已实现”。

本轮修复的核心是把产品权威、控制链、真实用户入口与验收门重新对齐。

## 二、本轮落地

### M5-A · Agent 首页与模型开关

- `/` canonical 到 Agent，`/agent` 仅兼容；导航顺序为 Agent / Skills / Loops /
  Team library；
- Chat/Image 合并为一个底部 Task composer；详情 drawer 和图像高级参数默认关闭；
- 空状态提供示例任务与最近 Run；
- 同 Session 运行中仍可继续提交，后端 FIFO 排队；不同 Session 可并行，一个 Turn
  内 Worker 仍可并行；
- 全产品 `ModelSwitch` 使用 chip + popover，并按 capability 过滤；
- 浏览器 mutation 只发送 `modelProfileId`；Product 后端在入队时解析当前 profile
  revision 并固定到 Turn/proposal。OpenAI、Anthropic、Gemini、Stability wire
  payload 只存在于后端 executor。

### M5-B · Skill 定义与导入

- 第一屏分为定义/导入；
- 定义为七步 wizard：Prompt 或 Python Script、职责和 I/O、固定 runtime、受控分类
  和 tags、package 预览、smoke example、最终 review；
- Prompt 生成 `SKILL.md`；Script 生成 `SKILL.md` +
  `skill.runtime.json` + `scripts/main.py`，固定 Python 3.12 Docker sandbox；
- Tool 转导入已注册 Action package；Workflow 转 Loop，不生成伪 runtime；
- wizard 只创建私有 Draft；smoke example 交给真实 Tests 页，Validate/Publish 独立；
- ZIP 使用精确锁定 `fflate@0.8.2`；
- 公共 GitHub 使用无凭证 Contents API，只读取 `SKILL.md` 和可选完整 Python pair，
  不 clone、不跳转、不执行仓库内容；不完整 pair 明确拒绝。

### M5-C · Loop 创建与生命周期

- 第一屏默认文档生成/高级定义导入；空白、起点和复制收进高级入口；
- 文档生成改为独立 expiring `staged_loop_draft`：生成阶段没有 canonical Workflow；
- review 页允许编辑名称、目标、上下文、约束和节点标题；
- 保存时由 Product Store 在一个 idempotent transaction 内创建 Workflow + revision 1
  并决定 proposal；dismiss、过期和已决定 proposal 都不能创建 Loop；
- 看板只映射设计中/可运行/已发布共享三态；Run 结果保持独立 immutable Run；
- 修复了 `initialLoopDraft` 缺少 `workflowFallbackAllowed:false` 导致当前 revision
  schema 不完整的问题。

### M5-D · 中文、IA 与真相源

- locale/theme 偏好按认证用户分区；未保存偏好且浏览器中文时默认中文；route 不再被
  写成跨用户 UI 偏好；
- 删除 fixture 文案重写映射，真实 Product 数据不再被前端改名；
- PRODUCT、README、Current Architecture、Current Frontend Truth、Interaction QA
  和 rebuild index 已统一指向 M5；
- 新增 `m5:smoke` 和 M5 QA 矩阵；旧 smoke/DOM 已改为新路径。

### M5-E · 审查后控制链加固

- staged proposal 的模型生成移出 Mongo transaction，以稳定 invocation 做外部
  幂等；短事务只负责持久化结果，重放不会重复调用模型；
- Agent Turn 使用稳定 turn ID，并将 Turn、用户消息、queued event 和 Session model
  preference 原子写入；无效 route 在任何状态变更之前失败；
- 私有 Skill Draft 的 package、test、validation 以及 staged proposal 的
  get/commit/dismiss 都按当前用户校验 owner，非 owner 对外统一 not found；
- proposal 增加 GET 恢复接口，前端在 `?proposal=` 全页刷新后以服务端状态恢复；
- GitHub import 的幂等重放不再重读可变 branch，不完整 Python runtime pair 映射为
  可行动的 422；
- 视觉与无权限 gate 改为 fail closed：DOM 未执行或 manifest 缺失时必须阻断。

## 三、契约与持久化增量

- Agent Turn 和 Builder/Loop proposal 的前端请求使用 `modelProfileId`；
- 新增 staged Loop proposal generate/get/commit/dismiss HTTP contracts；
- staged proposal 继续使用 `builder_proposals` 持久化，但以 `kind` 区分，commit 是
  唯一创建首个 canonical revision 的入口；
- GitHub Script import 的公开 package 范围为完整 Python runtime pair；
- 没有新增绕过 Product Controller 的 Worker 或 provider HTTP 接口。

## 四、验证证据

已验证：

- Contracts：47/47；
- M5 后端定向回归：85/85；
- Backend 全量：484 tests，470 pass，14 个条件 skip，0 fail；
- Frontend production build、`smoke`、`action:smoke`、`state:smoke`、
  `m5:smoke`：通过；
- evidence manifest 规则测试覆盖 55 个必需 screen ID；
- DOM、focus、accessibility、capture 四个 Swift gate 均通过 parse；
- staged proposal 无提前 canonical 写入、原子 commit、expired/decided 拒绝有负向测试；
- Agent profile→revision pin、旧 Turn 不漂移、provider 请求边界有契约/单测；
- GitHub Prompt/Script 完整 pair 和不完整 pair 拒绝有单测；
- 独立前后端 code review 已完成，修复后无未关闭 P0/P1。完整记录见
  [`wiki/qa/2026-07-25-m5-ux-restructure-code-review.md`](../../wiki/qa/2026-07-25-m5-ux-restructure-code-review.md)。

环境边界：

- provider-smoke 在受限 sandbox 曾因 `listen 127.0.0.1 -> EPERM` 失败；在允许
  临时回环监听的本机环境已 4/4 通过，并纳入上述全量结果；
- Docker daemon 当前不可用，认证 Mongo + Docker 的完整 DOM、Python sandbox、
  backup/restore 与真实 Provider 不在本轮重新声明为通过；
- 更新后的 DOM/focus/accessibility 脚本仍须对隔离 Product server 真实运行，语法
  通过不等于 DOM 行为通过；
- 实际视觉审计因 M5 manifest 不存在而返回 `visual_manifest_unreadable`；这是预期的
  阻断证据，不是通过；
- 未冻结新的 frontend tree，也未用历史截图替代 M5 视觉验收；
- 未进行真实外部 Provider 计费调用。

完整用例见
[`wiki/qa/2026-07-25-m5-ux-restructure-qa.md`](../../wiki/qa/2026-07-25-m5-ux-restructure-qa.md)。

## 五、当前结论

- M5 代码、契约与独立 code review 已完成，修复后无未关闭 P0/P1，可签收为新的
  **代码实施基线**；
- M5 尚不能签收新的视觉/发布基线，直到 DOM、focus、accessibility 和人工视觉走查；
- 单机生产状态仍是 `NO-GO`，服从既有 Mongo/Docker/Provider/供应链/升级回滚门，
  不能由 UI 重构测试替代。
