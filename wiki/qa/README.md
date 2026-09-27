# Turnsu 工作台 · 验证入口

当前实现证据、实际完成范围和未验证边界见
[Current System Architecture](../architecture/CURRENT_SYSTEM_ARCHITECTURE.md)。桌面开发入口与构建命令见
[Turnsu Desktop](../../domains/frontend/desktop/code/turnsu-desktop/README.md)；本轮方案的退出条件见
[工作台 / Skill OS / LOOP 迭代方案](../design/2026-09-28-workbench-skillos-iteration-plan.md)。
本机 SQLite 和受控 Agent 测试、macOS 开发包构建及空目录 GUI 导航，不等于 Windows、
已填充 Skill 的真实 GUI、真实 Agent 复用或团队双成员验收。

以下文件是带日期的既有实现证据，不作为当前完成状态的第二份台账：

- [../../domains/frontend/web/code/web-prototype/INTERACTION_QA.md](../../domains/frontend/web/code/web-prototype/INTERACTION_QA.md)
- [2026-07-10-skill-workflow-loop-first-slice-acceptance.md](2026-07-10-skill-workflow-loop-first-slice-acceptance.md)
- [2026-07-16-backend-agent-slices-0-4-acceptance.md](2026-07-16-backend-agent-slices-0-4-acceptance.md)
- [2026-07-16-backend-agent-slices-0-4-independent-code-review.md](2026-07-16-backend-agent-slices-0-4-independent-code-review.md)
- [2026-07-16-backend-agent-slices-0-4-production-readiness-review.md](2026-07-16-backend-agent-slices-0-4-production-readiness-review.md)
- [2026-07-17-backend-agent-slices-0-4-single-machine-production-readiness.md](2026-07-17-backend-agent-slices-0-4-single-machine-production-readiness.md)
  — Slice 0–4 historical closure and single-machine release decision (`NO-GO`)
- [2026-08-01-skillos-loopos-iterations-0-6-implementation-review.md](2026-08-01-skillos-loopos-iterations-0-6-implementation-review.md)
  — dated SkillOS / LoopOS Iterations 0–6 evidence
- [2026-07-25-m5-ux-restructure-qa.md](2026-07-25-m5-ux-restructure-qa.md)
  — historical Web M5 Agent/Skill/Loop/model/attachment UX test matrix and dated evidence snapshots;
  a snapshot does not automatically cover a later source/build identity. The 55-screen list is a
  structural coverage inventory; only 12 current, hash-bound keyframes require human visual review.
- [2026-07-25-m5-ux-restructure-code-review.md](2026-07-25-m5-ux-restructure-code-review.md)
  — independent frontend/backend findings, Module proposal/Inbox/runtime closure evidence, and remaining visual/release boundaries

Historical/superseded QA:

- [2026-07-27-m5-ux-frontend-route-resource-review.md](2026-07-27-m5-ux-frontend-route-resource-review.md)
  — old M5 v3 route/resource snapshot. Its schema-v3 captures, product semantics, hashes and
  PASS statements are not current acceptance evidence.

The rejected 2026-07-14 visual closure and final-audit records were removed. They incorrectly
treated functional screenshot coverage as completed visual implementation. New visual acceptance
must follow [the selected design handoff](../design/skill-loop-cloud-workbench-v1/HANDOFF.md) and
the current rules in [DESIGN.md](../../DESIGN.md).

`npm run review`, offline review exports, structural inventories and static DOM contracts are not
functional acceptance. Functional QA must use the same-origin Product API candidate and isolated
test data; visual-only fixtures may only prepare or inspect visual states.

Older QA records are archived under [../history/qa/](../history/qa/). They are historical evidence, not current acceptance criteria.

The 2026-07-16 three-surface visual-restoration record is pre-M5 historical evidence. It must not
be used to approve, limit or replace M5 visual acceptance.
