# 04 · Skill 导入规范与 MVP 闭环 v2

## Skill 来源事实

本机 `~/.agents/skills/` 下有 26 个真实 Skill（lark-* 系列，`SKILL.md` + 可能的
`references/` 子目录），通过 `lark-cli` 执行真实飞书操作。注意两个约束：

1. **它们是"指令 + CLI 工具"型 Skill，不是纯 prompt**：正文会引用 `references/`
   下的详细文档、包含确认流程约定、依赖 `lark-cli` 的具体子命令。只把正文塞进
   system prompt 无法形成受控工具协议——必须配合 `02` 的 lark Tool Adapter。
2. **它们在使用者的电脑上，不在服务器上**：团队部署后，成员的浏览器无法让服务器
   扫到自己电脑的 `~/.agents/skills`。所以导入以**浏览器上传为主**；"服务器路径扫描"
   只是 admin 在服务器本机操作的便利通道。

## Skill 包格式（MVP 支持的最小规范）

```
my-skill/
├── SKILL.md          # 必需：frontmatter + 指令正文
├── references/       # 可选：指令引用的详细文档，随包上传
└── scripts/          # 可选：辅助脚本
```

`SKILL.md` frontmatter（宽松解析，缺省宽容）：

```yaml
---
name: lark-calendar            # 必需，kebab-case，团队内唯一
description: 飞书日历管理        # 必需，一句话
inputs:                        # 可选，声明后画布步骤配置自动生成表单
  - name: date
    type: string
    required: false
    description: 查询日期，如 "today" / "2026-07-25"
outputs:                       # 可选
  - name: agenda
    type: markdown
tools:                         # 可选，Tool Adapter allowlist 声明
  - action: lark.calendar.agenda
    effect: read
    confirm: false
  - action: lark.calendar.create
    effect: write
    confirm: true
dependencies:                  # 可选，readiness 检查用
  - type: cli
    name: lark-cli
---
（正文：指令。可引用 references/ 下的文件，执行时按需注入。）
```

未声明 `tools` 的 Skill = 纯 prompt skill（无 CLI 权限）。声明了 `tools` 的走
Tool Adapter，受 allowlist/Schema/确认/receipt 全套约束（见 `02`）。

## 导入链路

### 通道 A：浏览器上传（主通道，所有成员）

1. "上传 Skill"对话框选"上传目录"（`webkitdirectory`）或"上传 zip"。
2. 走现有 quarantine → 静态检查（`skill-package-inspector.mjs`）→ 草稿链路；
   检查项扩展：`tools` allowlist 语法、frontmatter 可解析、name 唯一。
3. 出现在列表，状态 = 草稿。

### 通道 B：服务器路径导入（仅 admin，服务器本机）

1. admin 在导入对话框第三 tab 输入服务器路径（默认预填 `~/.agents/skills`）。
2. `POST /skills/scan` 扫描一级子目录，返回发现的 Skill（name/description/已存在标记）。
3. 勾选 → `POST /skills/import` 复制入库存草稿。
4. 安全约束：白名单根目录（`WORKBENCH_SKILL_IMPORT_ROOTS`），拒绝路径穿越；
   UI 明确标注"扫描的是服务器目录"。

### 发布

任何 member 可发布草稿为不可变 `skillVersion`（语义化版本 + 说明）。
只有已发布版本能拖入画布——保证 Loop 固定版本可重放。

## Prompt + Tool 执行语义

运行一个声明了 `tools` 的 Skill 节点时：

1. system prompt = SKILL.md 正文（`references/` 按正文引用惰性注入）。
2. user message = 节点输入（表单值 + 上游输出引用渲染）。
3. 走 ModelService（节点上 ModelPicker 选定并在编译时固定 revision）；OpenAI、
   Anthropic、Gemini 分别保持各自原生协议，不把所有 Provider 强行伪装为
   `chat/completions`。
4. 模型请求工具调用时：Tool Gateway 校验精确 Action ID、invocation、attempt、
   capability lease、参数 Schema 与预算；后端再把 Action 映射为固定的
   `lark-cli` argv，并以 `execFile` 数组参数执行（无 shell）。
5. 含写 Action 的节点必须直接依赖 Review Gate；确认 decision 未完成时不执行，
   缺少 Gate 时编译直接 blocked。完成后记录 durable effect receipt，结果不明时
   禁止自动重放。
6. 最终文本 = 节点输出，入 Run 事件流和 artifacts；副作用状态对接
   `side_effect_outcome_unknown`，进程中断时语义正确。

## 两个 MVP 闭环（验收脚本）

### 闭环 A：日程待办晨报（standup digest）

```
[lark-calendar: 查今日日程] → [lark-task: 查未完成任务] → [daily-digest-writer(纯 prompt)] → [lark-im: 发送到团队群(写操作,需确认)]
```

- 节点 4 的 `lark-cli im send` 命中 confirm 模式 → Run 在发送前挂起等确认。
- 验证点：4 节点 DAG 编译通过；SSE 事件按序到达；确认后群里真实收到消息。

### 闭环 B：会议纪要 → 行动项任务（meeting follow-up）

```
[lark-minutes: 获取指定妙记摘要] → [action-writer(纯 prompt 或确定性提取)] → [lark-task: 批量创建任务(写操作,需确认)]
```

- 验证点：上游输出被下游正确引用；确认后 lark-task 真实建出任务；
  **重跑时 effect receipt 使已创建的写操作被跳过或要求显式确认，不产生重复任务**。

### 闭环验收的通用断言

1. 两个闭环由**不同成员**各自创建、运行成功（各自的 lark-cli 用户级凭证）。
2. 第三人 Fork 闭环 A，改 chat_id 参数，重跑，并对比两次 Run 的输出与事件。
   **重跑语义**：同一 Loop/Skill 版本 + 同一输入的确定性重放；外部状态（日程、
   任务列表、LLM 输出）天然可能不同——对比视图展示差异而不是承诺复现。
3. 全程浏览器完成，无 fixture、无直接操作数据库（lark-cli 各成员的首次 OAuth
   授权除外）。

## Readiness 规则

Skill 发布前服务端检查（结果展示在详情页）：

- frontmatter 可解析、name 唯一、`tools` allowlist 语法合法；
- 声明的 `dependencies[].cli` 在服务器 PATH 存在；
- 声明了 `tools` 的 Skill 还需：allowlist 非空、写操作子命令已标 `confirm`；
- prompt skill 要求模型目录中至少一个 provider 就绪（现有 ModelService readiness）。

检查不过 → 发布按钮禁用并列出原因（遵守当前 M5 的“可见控件必须真实工作”规则）。
