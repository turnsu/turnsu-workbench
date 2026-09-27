# looloomi 重构迭代文档（Skill OS / Loop OS 团队版）v3

> **Historical implementation set (superseded on 2026-07-28).** 本目录保留 M1–M5
> 决策与实施历史，不再是当前 M5 产品/交互权威。当前设计从
> [`wiki/design/skill-loop-cloud-workbench-v1/m5/README.md`](../../wiki/design/skill-loop-cloud-workbench-v1/m5/README.md)
> 开始；当前控制链边界看
> [`CURRENT_SYSTEM_ARCHITECTURE.md`](../../wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md)、
> 带日期、identity 的实现与验证快照看
> [`M5 QA`](../../wiki/qa/2026-07-25-m5-ux-restructure-qa.md) 和
> [`M5 code review`](../../wiki/qa/2026-07-25-m5-ux-restructure-code-review.md)。
> `07`/`08` 不能覆盖已批准的 2026-07-28 M5 v2 设计或当前控制链。

> v3 说明（2026-07-25）：M1/M2 主链/M3 执行内核已实施并经交叉审查（见 `06`）。
> `07` 曾是 M5 的产品/交互执行规格，`08` 是当时的代码/文档交叉审查与实施记录。pre-M5
> 页面规格、三入口前端和三页视觉收口记录均不具有 Active Truth 权限。
>
> **v3 清理的过期决策**：
> - "本机 25 个 lark Skill" → 实为 26 个（`06` 更正）；
> - "`binary + args + *` allowlist" → 已废弃，以实施的**精确 Action ID 注册**为准（`06`）；
> - "`/agent` 与 NL proposal 去留由 IA 验收决定" → 已裁决：保留并升级为产品首页
>   （`07` D1，用户确认通用 Agent 聊天可作首页）；
> - "Stability 图像生成冻结" → 解冻，并入 Agent 工作区统一任务流（`07` Batch A）；
> - "模型开关沿用现有 ModelPicker 形态" → 改为轻量 chip+popover 共享组件（`07` Batch A）。
>
> v2 修订说明（历史记录）：

> v2 修订说明：v1 经交叉 review 发现关键事实错误、权限模型缺陷和执行安全问题，
> 本版已全面修订。主要变化：
> 1. 非 MVP 子系统（Memory / Remote / Stability / 模型路由）**冻结隐藏，不删除**底层契约与迁移；
> 2. 保留多模型路由、多协议 executor、ModelPicker、Sandbox、Agent Slice 0–4 成果；
> 3. Skill 导入改为浏览器上传为主，服务器路径扫描仅管理员本机可用；
> 4. lark-cli 走受控 Tool Adapter（allowlist + 参数 Schema + 用户级凭证 + 确认 + effect receipt），
>    不允许模型生成的命令在宿主裸跑；
> 5. admin 初始化改用一次性 bootstrap token，不用"首个注册者"；
> 6. 修正"无 Python""重跑可复现"等事实错误。
>
> 本文档集只保留当时的产品重构执行依据；当前实施不得从本目录恢复已被替代的 M5
> 产品语义，并始终**服从仓库 `AGENTS.md` 的开发规则**：保持
> Web -> Product API -> Store/Runner -> Agent Runtime Core -> PI Kernel 的依赖方向，
> 不破坏已实现的 Product API、Runner、Agent Runtime 和 PI 边界。
> 交给 Codex（或任何执行 Agent）时，M5 必须从顶部链接的当前设计包和 QA 开始读；
> `05-execution-plan.md` 仅用于追溯历史批次。

## 背景一句话

截至本历史文档集形成时，代码是一个契约驱动的单机原型，M5 静态/状态门禁已形成；
`08` 中的测试计数和 hash 只是历史快照，最新的带日期证据只在顶部链接的 M5 QA 记录维护。
但 8–15 人团队场景的三个前提（真实账号、真实业务 Skill、多人可达部署）尚未完成。
本次重构用增量收敛的方式补齐团队能力：**加法优先（认证/导入/部署），减法保守
（UI 隐藏而非删除底层），已确认的 Agent 与模型路由能力一律保留。**

## 文档索引

| 文件 | 内容 | 读者 |
|---|---|---|
| `01-product-definition.md` | 产品定位、范围 in/out、信息架构、成功标准 | 所有人 |
| `02-architecture-and-cut-list.md` | 保留/冻结/新增清单、认证设计、数据模型、执行底层决策 | 后端/架构 |
| `04-skill-import-and-mvp-loops.md` | Skill 导入规范、lark Tool Adapter、两个 MVP 闭环 | 后端/前端 |
| `05-execution-plan.md` | 里程碑、任务批次、并行策略、验收标准 | 执行者（Codex） |
| `06-iteration-implementation-review.md` | M1–M3 实施交叉审查：已验证项、外部阻塞、下一迭代顺序 | 所有人 |
| `07-ux-restructure-m5.md` | 历史 UX 草案：含已被 M5 v2 覆盖的 drawer/mode/preflight 决策 | 历史参考 |
| `08-iteration-reconciliation-and-implementation.md` | 2026-07-25 旧候选的交叉审查与实施快照 | 历史参考 |

归档：[`wiki/history/plan/2026-07-24-pre-m5-ui-ux-spec.md`](../../wiki/history/plan/2026-07-24-pre-m5-ui-ux-spec.md)
记录了 M5 前的页面规格，只可用作历史背景；当前开发不得以它覆盖当前 M5 v2 设计包。

## 执行纪律（给 Codex）

1. **增量收敛**：先做加法（认证、启动链、导入），非 MVP 功能只做 UI 层隐藏/降级，
   **不删除**后端契约、迁移、executor、Agent 子系统。删除仅限：前端无消费的死导出/
   死 i18n key、演示数据硬编码、以及确认归档的 legacy 入口（见 `02` 清单）。
2. **不允许引入新依赖**除非 `02` 中明确列出（`bcryptjs`）或为已验收的浏览器 ZIP
   解包使用精确锁定的 `fflate@0.8.2`。执行层不新增语言栈。
3. **每个按钮必须有真实行为**——这是 M5 和 `DESIGN.md` 的铁律，违反即验收失败。
4. **文档漂移即 bug**：改了行为就同步改 `PRODUCT.md` / `README.md` / 本套文档；
   与 `AGENTS.md`、`wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md` 冲突时，先停下来对齐，
   不得擅自宣布某份文档失效。
5. 沙箱、effect receipt、`side_effect_outcome_unknown` 语义属于安全边界，任何执行链路
   改动不得削弱它们。
