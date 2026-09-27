# Agent / Skill / Loop Web 工作台交互 QA

更新日期：2026-08-04
执行规格：`wiki/design/skill-loop-cloud-workbench-v1/m5/`
详细测试矩阵与本轮证据：`wiki/qa/2026-07-25-m5-ux-restructure-qa.md`

> 本文件定义验收路径，不声明这些路径已经通过。build/structural inventory/state smoke、visual-only
> review 或 fake driver/provider 不能替代认证 Product API、隔离 `_test` Mongo、真实
> Docker/credential/Provider 及 hash-bound 视觉证据。

## P0 验收路径

1. `/` 打开 Agent 首页：当前用户的多 Session rail、统一底部 composer、唯一模型
   chip、可行动空状态和结果 reader 可见；不存在旧 details drawer 或 chat/image
   segmented control。
2. 创建 Skill：第一屏区分定义/导入；定义完整走七步，只生成 Draft；Prompt 与
   Python/Node.js TypeScript package 能通过真实 inspector；测试、验证、发布是后续显式动作。
3. 导入 Skill：目录、ZIP、公共 GitHub 和管理员 server path 各自走同一
   quarantine/inspector；不完整或不受治理的 runtime pair 必须拒绝。
4. 创建 Loop：文档为默认入口；生成后仍停留 `/loops/new` 的临时 proposal；
   review/edit 后点击保存才创建 revision 1；刷新时由 `?proposal=` + GET 恢复；
   dismiss/过期/非创建者都不得写 canonical Loop。
5. Loop 看板：只显示设计中、可运行、已发布共享三态；M5 主路径从 Loop 创建
   Agent task 并在 Agent result reader 阅读结果。独立 Run 页面只保留兼容/历史明细，
   不重新拥有执行状态。
6. 模型选择：前端 mutation 只发送 `modelProfileId`；后端入队时解析并固定
   `modelProfileRevisionId`；不允许 provider payload 或前端 revision 选择。无效
   route 不得留下 Session preference、Turn、message 或 queued event 部分状态。
7. 附件：浏览器先上传为 personal `AttachmentRef`；支持图片、TXT/MD/CSV、文本 PDF、
   DOCX、XLSX。模型不支持 `image_input` 时保留附件并禁用提交；扫描 PDF、宏、旧
   DOC/XLS、权限/hash/TTL 失败不得静默降级。
8. Module Agent：Inbox deep-link 必须读取当前用户 proposal；apply/reject 都走
   Product API。非重叠三方合并，同路径冲突保持 canonical Draft 不变。
9. Library update：查看影响、创建更新草稿、审查、明确应用；未确认不得改变
   installation/canonical object。
10. 中文与偏好：中文环境首次打开默认中文；主题/语言按用户隔离；路由不写入偏好。

## 每轮自动门禁

```bash
npm run build
npm run state:smoke
npm run action:smoke
npm run structural:inventory
npm run boundary:audit
```

`state:smoke` 与 `action:smoke` 直接导入 Product client、route、reducer 和 adapter，验证
可执行行为；`structural:inventory` 只检查 route 与 55 个 screen ID 的覆盖库存，
`boundary:audit` 只检查 Web import 边界和 Product API 入口。后两者不构成功能证据。

有可运行的隔离 Product server 时追加：

```bash
npm run dom:smoke
npm run focus:smoke
npm run accessibility:smoke
```

视觉预览与功能 QA 分开：`npm run review` / `review:visual:offline` 只能用于视觉预览；
`audit:capture` 对当前同源页面产生真实截图，人工只审查 12 个 hash-bound 关键帧。
55 个 screen ID 不要求逐张截图或逐项人工签字。

失败必须区分业务断言失败与环境不可用。DOM 被跳过、Docker 未启动或真实 Provider
未配置都不是通过证据；视觉 manifest 缺失或人工 verdict 未批准必须非零退出。

独立 code review 与已关闭问题见
`wiki/qa/2026-07-25-m5-ux-restructure-code-review.md`。
