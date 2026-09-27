# 07 · UX 重构整合（M5）v3（历史执行草案）

> **权威更新（2026-07-28）：** 本文已被
> [`wiki/design/skill-loop-cloud-workbench-v1/m5/README.md`](../../wiki/design/skill-loop-cloud-workbench-v1/m5/README.md)
> 及其链接的 2026-07-28 关键帧、组件交互和用户流替代。本文保留用于解释 7 月 25 日
> 的决策过程，不再约束当前实现。发生冲突时，以新 M5 包为准；其中已经批准多任务
> Agent、无模式切换、Loop 直接进入 Agent task、专注页 Skill wizard，以及由 Product
> API 下发的 Python 3.12 / Node.js 20 TypeScript 沙箱 runtime catalog。

> 来源文档：`wiki/design/skill-loop-cloud-workbench-v1/docs/PRODUCT_AND_FRONTEND_RESTRUCTURE_V1.md`
> （2026-07-25，人工 review + AI 梳理）。本文档是它经交叉 review 后的执行版：
> 合理部分原样采纳，冲突与缺口在此裁决并钉死边界。源文档保留在设计目录作背景，
> **执行以本文档为准**。

## 交叉 review 结论

源文档四个对象的 UX 诊断全部成立（composer 错位、模型选择器过重、Skill 创建
package-first、workflow 泄漏内部表示），与此前前端 review 发现的问题一致。采纳。
但有 4 处必须裁决，裁决如下：

### D1 · Agent 工作区作为主入口（用户已确认：通用 Agent 聊天可作首页）

源文档 §1/§12 把 "Start a task -> get a result" 定为主动线、把 Agent 工作区定为
primary entry point。这与 PRODUCT.md 旧非目标"不做通用 Agent 聊天首页"字面冲突。

**裁决（2026-07-25 用户确认）：采纳源文档，且不限定为"只能调用团队资产"**——

- 产品定位：Skill OS / Loop OS 团队管理系统 + 通用 Agent 任务入口。两者并存，
  Agent 工作区就是产品首页（landing page），通用聊天/任务发起是合法用途。
- Agent 工作区的能力：自由对话与任务发起、调用团队库已发布的 Skill 与 Loop、
  查看结果与 artifacts；对象管理（建/编/发 Skill 和 Loop）仍在 Skills/Loops 完成。
- 执行计划包含一项**同步修订 PRODUCT.md** 的任务：删除"不做通用 Agent 聊天首页"
  非目标，改写为"Agent 工作区是产品首页与任务入口"。不改 PRODUCT.md 就实施 =
  文档漂移，按纪律视为 bug。

### D2 · Script Skill 的执行位置（含沙箱利弊说明）

源文档 §6.3 wizard 里 Script Skill 可选 Python/Node/Shell runtime，但未说在哪执行。

**已被 2026-07-28 裁决替代：** Script Skill 仍一律走 Docker 沙箱；Product 后端
现在拥有 runtime catalog，并可治理 `python3.12 / scripts/main.py` 与
`nodejs20-typescript / scripts/main.ts`。前端只提交 `runtimeId`，不得提交镜像、
命令或宿主路径。未配置 digest-pinned image 的 runtime 必须显示 unavailable，
不得回退宿主裸跑。Shell 仍不在支持范围。

**为什么 Script Skill 必须沙箱（好处）**：

- Script Skill 是用户上传的任意代码，也可能是 AI 生成的代码——不可信。容器边界
  挡住删文件、偷数据、对外发请求等破坏，伤不到服务器和其他成员的数据；
- 模型 API key 等机密在容器外，容器内代码读不到；
- 每次执行环境一致，结果可复现；现有 `docker-skill-executor` 已实现（digest-pin
  镜像、无网络、只读 root、非 root、资源限额），成本已经付过。

**沙箱的代价（坏处）与应对**：

- 每次运行要起容器，慢几秒；镜像要预装 Python/Node 运行时，需维护；
- 镜像内没有 `lark-cli` 和成员的 OAuth 登录态——所以**需要成员身份的 CLI 工具
  不走沙箱**，走 Tool Adapter（精确 Action ID + 写操作确认 + effect receipt，
  见 `02`/`04`），在宿主机受控执行；
- 结论：两条执行路径各有安全边界——**不可信代码 → Docker 沙箱；团队自有 CLI →
  Tool Adapter**。互不替代。

### D3 · 文档生成工作流（doc-to-workflow）的边界

源文档 §7.3 把"从文档生成工作流"定为默认创建路径。该能力沿用 typed Builder
operation，但不能复用“已有 canonical Loop 的 revision proposal”写入语义；M5 使用
独立的 `staged_loop_draft` generate/get/commit/dismiss 契约。

**裁决：采纳为默认路径。对用户可见的规则只有一条：AI 只出"提案"，人点保存才算数。**

具体含义（用大白话钉死，避免实现走样）：

- 用户给文档/需求文本 → AI 生成一份工作流草图（目标、节点、连线、参数建议）；
- 草图进入**预览/编辑界面**：用户可以看、可以改，点"保存为草稿"才成为真正的
  Loop 草稿；不点保存，团队库里什么都不会出现；
- proposal ID 写入 `/loops/new?proposal=...`，刷新时从 Product API 按
  `workspace + createdBy` 恢复；前端内存、URL 或 transcript 都不是 proposal 真相源；
- 模型/Worker 调用必须发生在 Mongo transaction 外；调用使用稳定 operation /
  invocation ID，完成后只用短事务写入 proposal 与审计，重放不能再次调用模型；
- AI 任何时候不得直接创建、修改、重排已存在的 Loop（包括别人的）。这条是
  PRODUCT.md 原则 1 的既有要求，不是新限制；
- 对用户体验的唯一影响：生成后有一个"确认/编辑"步骤，而不是生成即上线。
  画布编辑是生成后的修改手段，两条路径在画布汇合。

### D4 · GitHub 仓库导入（用户已确认：需要该能力）

源文档 §6.4 的 GitHub import 是新后端能力（clone、凭证、供应链检查）。

**裁决（2026-07-25 用户确认）：这是需要的能力，纳入 M5 Batch B 实做**，定位为
高级导入路径，范围分两档：

- **M5 内实做（公共仓库）**：后端使用受限 GitHub Contents API 读取指定目录的
  `SKILL.md`，以及可选但必须成对出现的 `skill.runtime.json` +
  `scripts/main.py`，而不是在产品主机 clone 仓库；每个文件有
  1 MiB 上限、15 秒 timeout、禁止重定向、无凭证、无 submodule/hook/脚本执行，随后
  进入既有 quarantine → inspector → 草稿链路。UI 作为“导入已有技能”的第三个来源
  正式开放（不是 disabled 占位）。UI 必须说明：仅支持公共仓库、`SKILL.md`
  必需性、Python runtime 文件必须成对、支持的包文件范围和后续检查。
- **排 V1.1**：私有仓库（需要 per-user access token 的采集、加密存储与轮换）。

供应链安全要求（与 zip 上传同等标准）：克隆内容视为不可信输入，只允许进入
quarantine；禁止执行仓库内任何脚本（post-clone hook、submodule 自动初始化默认关）；
克隆产物与目录上传走同一套静态检查。

## M5 范围（采纳源文档 §10/§12，顺序按其理由保留）

源文档的实施顺序理由成立：Agent 工作区是主入口，其心智模型不先修正，次要流程
改进仍会感觉不一致。

### Batch A · Agent 工作区 IA + 轻量模型开关（同源文档 §5/§8，合并做）

- 主 composer 从右侧栏移到底部通栏，位于主视觉轴；
- 右侧面板降为可选 drawer（context / run details / artifacts / 高级控制）；
- 文本与图像生成统一为同一任务输入系统：同一 composer，图像走"当前图像能力模型"
  默认值，结果进同一任务/输出流；高级图像参数（宽高比/seed/格式/negative prompt）
  收进可展开的高级区（默认折叠）；
- 空状态可行动：示例任务 + 最近工作，不放被动空白；
- **轻量模型开关**（共享组件，全产品统一）：composer 旁的紧凑 chip，点击开
  popover；只显示当前任务模式可用的 model profile，按能力分组（text/image），
  展示 name/provider/revision/能力简述；前端只持有 `mode` + `modelProfileId`，
  不接触任何 provider 特定 payload（现状后端已拥有路由，前端只改表现层）。
- 该组件同时替换 Loop 工作台步骤配置里的 ModelPicker 表现形态（契约不变）。

### Batch B · Skill 创建入口分流 + 定义向导（源文档 §6）

- 第一屏二选一：`定义新技能` / `导入已有技能`；
- 导入路径 = 已实现能力（浏览器目录上传；受限 ZIP；admin 服务器路径）+
  **GitHub 公共仓库导入（M5 内实做，见 D4）**；
  UI 说明期望文件、SKILL.md 必需性、缺失元数据能否生成、将运行哪些校验；
- 定义路径 wizard（7 步）：类型（Prompt/Tool/Script/Workflow）→ 职责与输入输出 →
  执行方式（按类型条件显示；Script 钉死 Docker 沙箱，见 D2）→ 主分类（受控：
  finance/research/coding/automation/image/data/ops/other）+ 自由 tags →
  生成 `SKILL.md`（或受支持 Python sandbox package）脚手架草稿 → 冒烟测试（1 个
  示例输入 + 1 个预期效果描述）→ 最终 review 并创建**私有 Draft**；
- wizard 不把自然语言“预期效果”伪装成 exact JSON assertion；它作为测试目的说明
  交给真实 Tests 页，`expectedOutput` 默认留空。Test → Validate → Publish 是 Draft
  创建后的独立显式流程，wizard 内没有隐含发布；
- Tool Skill 的“工具契约绑定”复用已实施的**精确 Action ID 注册**（见 `06`）。
  当前定义 wizard 不允许新建任意 Tool 命令；Tool Skill 必须从带已注册 Action 声明的
  包导入，inspector 逐项验证 Skill 名称与 Action 绑定，绝不接受用户填写 binary/args。

### Batch C · 工作流创建分流 + 三态可见（源文档 §7）

- 第一屏二选一：`从文档生成工作流`（默认）/ `导入工作流定义`（高级）；
- 文档路径：Markdown/PRD/需求笔记/目标+约束文本 → 提取目标/约束/输入输出 →
  生成节点与依赖提案 → 用户 review/编辑（D3 边界）→ 存草稿 → 试运行 → 发布；
- 暂存 proposal 可刷新恢复，但只允许创建者读取、提交或 dismiss；其他协作者即使
  在同一 workspace 也得到 not found，不能接管个人临时分支；
- 导入路径：`.loop.json` 等正式定义文件，明确标注"高级/仅导入"；
- Loop 生命周期三态可见：`设计中` / `可运行` / `已发布共享`。`有结果`属于某次
  immutable Run，而不是 Loop 的状态；结果必须进入 Run 记录和比较视图，不能把一次
  Run 的输出伪装成整个 Loop 的当前状态。看板和详情页必须让用户知道自己在编辑、
  测试、发布还是回顾某次 Run。

### Batch D · 中文优先 + 高级设置收敛 + IA 合页验收（源文档 §9 + `06` 剩余项）

- 语言默认：有 workspace/用户偏好用偏好；中文优先上下文默认中文；不依赖手动切换；
- 全产品扫一遍"默认 vs 高级"：每个创建/执行页默认只显示最少必要输入，高级设置
  可折叠，内部产物（loop.json、revision hash、lease 等）不做默认首屏 UX；
- IA 合页验收（`06` 下一迭代第 4 项）：旧路由能力映射走查 + 移除残留演示数据 +
  形成新的前端 tree 基线（为发布门禁解锁）。

## 验收标准（整合源文档 §11）

### Agent 工作区

- 第一眼可识别为任务发起页；composer 底部居中通栏；模型切换是 chip+popover；
- 图像生成不默认占据独立重型侧表单；空状态有可点的示例任务。

### Skill 创建

- 定义 vs 导入一屏可辨；`从草稿开始` 升级为完整定义向导；
- 类型/输入输出/runtime/分类/冒烟测试结构显式；Script 沙箱边界未被突破。
- 完成向导只创建私有 Draft；自然语言 smoke outcome 不会被转换成 exact JSON；
  Test、Validate、Publish 仍是后续独立动作。

### 工作流创建

- 文档生成是默认路径且只产待确认草稿；`.loop.json` 仅高级导入；
- proposal 刷新可由 Product API 恢复，跨用户读取/提交/dismiss 被拒绝，模型调用不在
  Mongo transaction 内；
- 设计/可运行/已发布共享三态在 Loop 页面可辨，Run 结果不与 Loop 状态混淆。

### 模型开关

- 表现为快速开关而非页面区块；前端无任何 provider 特定请求格式；
- 后端仅凭 `modelProfileId` 完成路由（契约测试覆盖）。

## 创建、导入与能力就绪纠偏（2026-07-30）

M5 的“入口可发现”不等于“对应运行条件已就绪”。Global Create、Skill/Loop 创建、
Inbox 恢复动作统一消费 Product-owned operation-specific readiness，并分别显示
`draftable`、`testable`、`runnable`、`importable` 的
`ready | needs_setup | checking | unavailable | forbidden`、稳定原因和恢复动作。
前端不得硬编码可用；所有 mutation 在提交时仍由后端复验，read model 不是授权依据。

- Skill Step 2 只声明材料 slot、参数和产物；Step 6 才为试运行绑定 personal
  Attachment 或 Workspace Resource。sample 不进入 canonical Draft、普通日志或 Memory。
- 可保存私有 Draft 但暂时不可测试/运行是合法状态；最终 review 必须同时显示三层状态。
- 空白 Loop 先确认名称与“创建私有 Draft”，成功后才进入 Builder；文档生成只产 staged
  proposal。proposal backend 不可用时保留输入，切换手动 Draft 必须再次确认。
- Connection 只有 opaque credential 已绑定、production driver 的 probe/scope/effect
  验证通过才为 valid；label/permissionSummary 不能构成验证。
- 临时输入是 personal Attachment；可复用材料是 immutable Workspace Resource version；
  执行输出是 Artifact，三者不得混为同一真相源。
- 未知 route、stale proposal/update draft 和 Inbox setup 必须进入可解释的恢复面，
  不得静默回 Agent。
- 移动端只兑现轻量“定义新 Skill”；目录、ZIP、GitHub 和 server import 显示回桌面
  边界，不渲染不可操作的 file picker。
- `npm run review` 是显式 `visual-only` 环境。它可发现布局/状态问题，但不能证明
  Skill/Loop/Connection/Resource 功能；真实功能 QA 必须连接 Product API 与隔离
  `_test` Mongo，fake driver/provider 只证明协议与失败边界。visual-only API client
  必须在发出网络请求前拒绝业务 mutation；不得依赖不完整 fixture 的 4xx/5xx 来充当
  功能边界。

## M5 完整实施与验收边界（2026-07-26 澄清）

M5 的 Batch A–D 是本轮**完整实现范围**。不得以“先完成三个视觉基准页”或
“55 个 screen ID 规则存在”缩减、替代或提前宣布 M5 完成。Agent 工作区、模型开关、
Skill 创建/导入、Loop 暂存 proposal 与三态、中文/高级项/IA 合页均须按本文件真实
落地并接受验收。

前 `03-ui-ux-spec.md` 属于 pre-M5 规格，已归档。它不再定义当前路由、页面骨架、
创建方式、模型选择或视觉范围；其中“所有可见控件必须真实工作”等通用原则已由本文件、
`DESIGN.md` 与当前架构规则承接。

验收分为彼此不可替代的四层：

1. **代码与契约**：schema、后端、权限、幂等、静态前端门禁必须通过；这不构成浏览器
   或视觉通过。
2. **真实产品路径**：在隔离 `_test` Mongo、同源 Product API、测试身份下运行
   Agent、Skill Draft、staged proposal、commit/reload、权限隔离、DOM/focus/accessibility。
   视觉测试可使用确定性的测试专用 Builder 结果来构造界面状态，但该结果不能被报告为
   真实 Provider 证明。
3. **自动状态覆盖与真实截图**：55 个 screen ID 是路由、状态和 DOM 的自动化覆盖库存，
   用于发现遗漏，不要求 55 个画面逐一人工签字。`capture-audit.swift` 必须从真实
   Product API 页面捕获当前画面并生成 capture manifest；合成 PNG、静态文件检查或历史
   截图均不算真实页面证据。
4. **关键帧人工签收与发布迁移**：人工视觉 review 聚焦约 12 个代表核心流程、移动端和
   恢复状态的关键帧，检查层级、密度、可读性和交互语义。capture manifest 与人工
   review 记录必须分离；人工记录绑定 `screenId`、截图或内容 hash、review 时间和结论，
   只有对应画面内容变化时才失效，重新 capture 不得无条件把全部结论重置为 pending。
   只有代码已提交、自动覆盖和关键帧证据完成且人工 P0/P1 关闭后，才能把新的
   `domains/frontend` Git tree 写入发布基线。真实 Provider、Docker/Sandbox、备份恢复
   仍由独立运行/生产门禁验证，不能混入视觉结论。

当前人工关键帧最小集合为：Agent 空状态首页、Agent 运行/结果流、Model chip +
popover、Skill 创建入口、Skill wizard 最终 review、Loop 创建入口、staged proposal
review/edit、Loop 三态与 Run 边界、Team Library、Agent 移动端、创建流程移动端，以及
loading/error/permission/recovery 状态板。缺少任一真实截图时应报告 `unverified`，
但不阻塞可以独立完成的设计稿、路由拆分和 bundle 重构。

当前发布代码中的 frozen frontend tree 是**上一已批准版本**的安全发布基线，而不是
M5 的产品规格，也不要求 GitHub push。它只允许在 M5 验证完成后的受控迁移中更新：
先形成干净的本地 Git commit，再记录该 commit 的 `domains/frontend` tree hash，最后
重跑 release gate。不得通过改写旧 hash、忽略前端脏改动或复用历史截图绕过迁移。

## 前置依赖（来自 `06`，M5 不覆盖这些）

1. 单机 Mongo + Provider 凭证 + ≥1 个成员 Lark profile，跑 5-Skill publish/readiness；
2. 只读 Loop → 含 Review Gate 写 Loop 的真实 receipt 与重启恢复验证；
3. M5 完成后：发布门禁 + 备份/恢复 + 真实 Provider smoke 全过，才更新生产结论。

## V1.1 顺延项

- GitHub 私有仓库导入（per-user access token 采集/加密存储/轮换，见 D4）；
- 图像生成高级参数的完整面板；
- wizard 的模板库/分类治理后台。
