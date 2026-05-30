# Wiki History Archive

Updated: 2026-05-27

## 归档规则

`wiki/history/` 用于保存已经完成、被新架构取代、或只作为历史决策背景存在的 Markdown 文档。当前有效的架构文档继续保留在 `wiki/architecture/`；新的计划、PRD、QA 文档在完成后再移动到对应 history 分类。

命名格式：

```text
YYYY-MM-DD-{category}-{status}-{topic}.md
```

- `category`：`plan`、`prd`、`architecture`、`qa`。
- `status`：`completed` 表示已按本地 MVP 或当时验收标准实现；`superseded` 表示文档仍有参考价值，但已被后续架构或实现取代。
- `topic`：保留原主题的短横线命名，便于按时间和语义检索。

## 当前归档清单

| 当前路径 | 类型 | 状态 | 原始含义 | 归档原因 |
| --- | --- | --- | --- | --- |
| `wiki/history/plan/2026-05-24-plan-completed-next-stage-agent-capability-optimization.md` | Plan | Completed | 数据存储、Agent run、运维状态、fixture 文件化、测试补齐 | 对应 runtime store、run artifact、sync state、fixture adapter、smoke/test 目标已进入代码 |
| `wiki/history/plan/2026-05-24-plan-completed-personal-bloomberg-wechat-onchain-terminal.md` | Plan | Completed | 个人 Bloomberg 风格微信 x 链上终端骨架 | 对应多 workspace 桌面 shell、Token Terminal、watchlist、Data/Ops 已实现 |
| `wiki/history/plan/2026-05-24-plan-completed-runtime-data-agent-ops-overhaul.md` | Plan | Completed | RuntimeBackend、数据管理、Agent pipeline、Ops health 总体改造 | 对应 RuntimeBackend/Repository、store、module run、health/manifest 已实现 |
| `wiki/history/prd/2026-05-26-prd-completed-yansu-inspired-wechat-onchain-agent-console.md` | PRD | Completed | Yansu-inspired proactive console PRD | Crystal、Proposal、Memory、Handoff、Proactive Session 本地 MVP 已实现 |
| `wiki/history/plan/2026-05-27-plan-completed-agent-operation-space-v1-pi-compatible-daemon.md` | Plan | Completed | Agent 操作空间 v1：daemon、chat stream、tool/skill、附件、长期任务 | Node daemon、Swift Agent workspace、artifact、provider readiness、policy tool call 已实现 |
| `wiki/history/plan/2026-05-27-plan-completed-agent-workspace-ui-ux-product-redesign.md` | Plan | Completed | Agent 工作台 UI/UX 产品重构方向 | 后续 Assistant-UI V2 workspace 已落地，作为产品设计背景保留 |
| `wiki/history/plan/2026-05-27-plan-completed-assistant-ui-inspired-agent-chat-workspace.md` | Plan | Completed | Assistant-UI inspired SwiftUI-native Agent ChatUI workspace | V2 state adapter、thread-first layout、composer、inline cards、run bar、QA 已实现 |
| `wiki/history/qa/2026-05-26-qa-completed-computer-use-product-level-qa.md` | QA | Completed | Computer Use 产品级 QA 与修复前缺陷记录 | P0/P1 问题已修复并保留为历史 QA 基线 |
| `wiki/history/qa/2026-05-27-qa-completed-assistant-ui-agent-workspace-v2-qa.md` | QA | Completed | Agent Workspace V2 QA | V2 前端验收已完成，作为历史质量记录归档 |
| `wiki/history/architecture/2026-05-27-architecture-superseded-backend-agent-data-capability-audit.md` | Architecture | Superseded | 后端、Agent、数据能力审计 | 后续已采用 Pi SDK backed daemon，审计仍作为缺口来源和决策背景 |

## 当前仍有效文档

- `wiki/PROJECT_WIKI.md`：项目总索引、当前状态、决策、后续 TODO。
- `wiki/architecture/2026-05-27-project-structure-agent-capability-sync.md`：当前项目结构与 Agent 能力同步文档。
- `wiki/architecture/2026-05-27-piagent-backed-runtime-adoption.md`：Pi SDK backed runtime 采纳决策与实现记录。

## 后续维护要求

- 新增计划或 PRD 完成后，移动到 `wiki/history/plan/` 或 `wiki/history/prd/` 并改名标注 `completed`。
- 架构文档被新实现取代后，移动到 `wiki/history/architecture/` 并标注 `superseded`，不要直接删除。
- QA 文档完成对应修复后，移动到 `wiki/history/qa/` 并标注 `completed`，在 `PROJECT_WIKI.md` 保留摘要和链接。
- 主索引不得继续引用已移动的旧路径。
