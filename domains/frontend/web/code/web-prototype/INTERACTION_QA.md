# Skill / Workflow / Loop Web 工作台交互 QA 记录

日期：2026-07-09
范围：`domains/frontend/web/code/web-prototype`

## 本轮目标

把 web prototype 从旧的多页 LoopOps 形态收敛为唯一产品主线：管理 Skill、管理 Workflow / Loop、用 Skill 通过模板和画布创建 Workflow / Loop，并完成 mock run 与复用。

## 严重级别

- P0：Skill / Workflow / Template 主流程无法完成，或核心动作静默失效。
- P1：主流程按钮误导用户、不可达、无反馈，或可能造成改动丢失。
- P2：次级但预期存在的交互缺少焦点、禁用态、反馈或自动化覆盖。
- P3：不阻塞当前原型的后续集成债务。

## 已收敛的产品面

| 区域 | 当前状态 |
| --- | --- |
| 主导航 | 已收敛为 `Skills`、`Workflows`、`Templates` |
| Skills | 支持 create skill、搜索、筛选、查看 contract、Add to workflow |
| Workflows | 支持 create workflow、搜索、筛选、行选择、run、edit、duplicate、run ledger、attached resources |
| Templates / Builder | 支持 template clone、skill drag/drop、node select/move/delete/connect、Inspector 编辑、BuilderPatch dismiss/apply、debug preview、mock run |
| Runs | 不再是主导航；作为 Workflow detail 的 run ledger |
| Knowledge | 不再是主导航；作为 Workflow attached resources |
| Chat | 不再是主产品；作为 scoped run/builder/review control layer |

## 本轮修复 / 重构记录

### P0：产品入口过多，旧页面继续定义主产品

修复前：主导航仍暴露 Workbench、Loops、Skills、Builder、Runs、Knowledge，导致产品继续向监控/知识库/运行记录页面扩张。

修复后：主导航只保留 Skills、Workflows、Templates。旧 Workbench / Runs / Knowledge 入口不再作为用户可见主入口，也不再作为正常页面分支。

证据：`npm run smoke` 断言 seed navigation 只有三对象入口，并显式禁止 Workbench/Runs/Knowledge 作为 top-level nav。

### P0：缺少创建 Skill / Workflow 的工作台动作

修复前：原型主要能添加既有 skill 和 clone template，但没有清晰的 `Create skill` / `Create workflow` 入口。

修复后：TopBar 和页面内增加 `Create skill`、`Create workflow`，状态层新增 `makeSkillPackage` 与 `createBlankWorkflow`。

证据：`npm run action:smoke` 输出 `web_action_skill_create=true`、`web_action_workflow_create=true`。

### P1：模板与 Builder 分离不清

修复前：Builder 是独立 nav item，模板 clone 主要在 Loops 列表里完成，用户很难理解“模板 -> clone -> canvas 编排”的创建路径。

修复后：Templates 页面直接包含 template list 与 Builder canvas。Template 只能 clone，clone 后进入 owned workflow 编辑。

证据：`npm run dom:smoke` 输出 `web_dom_template_clone=true`。

### P1：删除节点入口不够显式

修复前：删除节点主要藏在 canvas node 内的小图标和键盘删除里。

修复后：Node Inspector 增加 `Delete node` 显式按钮，并保留 canvas 节点删除和 Delete/Backspace。

证据：`npm run dom:smoke` 输出 `web_dom_builder_drag_drop=true` 与 `web_dom_builder_inspector=true`，并验证删除后可见节点数减少。

### P1：Workflow 运行结果不应是独立 Runs 产品

修复前：Runs 是独立主页面，容易回到监控台模型。

修复后：RunLedger 被嵌入 Workflow detail。Mock run 后回到 Workflows 并展示 ledger。

证据：`npm run dom:smoke` 输出 `web_dom_run_ledger=true`。

### P2：数据边界仍像单一 seed 大桶

修复后：`skillCatalog`、`workflowLibrary`、`runLedgers`、`resourceSources`、`builderConversations`、`navigation` 均已成为真实数据边界。旧 seed 聚合文件已物理删除，状态层和脚本直接消费拆分后的对象模型。

证据：`npm run smoke` 断言新增数据边界文件存在，并断言旧 seed 聚合文件不存在。

### P3：FlowGram 只做依赖探测

修复前：`LoopCanvas` 在组件内部直接动态导入 FlowGram，只用来探测依赖可用性，没有独立 adapter，也没有 graph 映射测试。

修复后：新增 `canvas/flowgramAdapter.js`，集中导入 FlowGram editor 包，提供 Loop workflow nodes / edges 到 FlowGram document JSON 的映射，并验证 editor、context、preset、document entrypoint 存在。`LoopCanvas` 只读取 adapter 状态和映射结果，不再直接访问第三方包。

证据：`npm run smoke` 断言 FlowGram import 只能存在于 canvas adapter；`npm run action:smoke` 断言 adapter 保留 node 数、edge link 数和节点标题，并输出 `web_action_flowgram_adapter=true`。

### P3：旧 surface 文件未物理删除

修复前：旧 Workbench / Runs / Knowledge 组件已不在主路由中，但文件仍保留，容易让后续改动回到旧产品面。

修复后：旧 `WorkbenchView`、`RunsView`、`KnowledgeView` 和旧 `loopopsModel` 已物理删除。主导航仍只保留 `Skills`、`Workflows`、`Templates`。

证据：`npm run smoke` 断言这些旧文件不存在。

## 阻塞项记录

当前没有未解决的 P0-P3 死按钮、不可达主流程或未归档的结构债务。

## 验证结果

从 `domains/frontend/web/code/web-prototype` 运行：

```bash
npm run build
npm run smoke
npm run action:smoke
npm run dom:smoke
npm run focus:smoke
npm run review:no-permission
npm run audit:capture
```

结果：

- `npm run build`：通过。
- `npm run smoke`：通过，30 个 source files、21 个 module boundaries、39 个 test ids。
- `npm run action:smoke`：通过，覆盖 create skill、create workflow、duplicate workflow、template clone、drag position、connect、delete、patch、compile preview、FlowGram adapter。
- `npm run dom:smoke`：通过，覆盖三入口、主题、语言、template clone、workflow create、skill create、skill add、drag/drop、patch、run ledger。
- `npm run focus:smoke`：通过，覆盖 3 个主表面。
- `npm run audit:capture`：通过，捕获 6 张截图，无横向溢出。
- `npm run review:no-permission`：通过；该聚合脚本在沙箱内走 offline fallback，DOM 子项被标记为 sandbox file navigation skipped。真实 HTTP DOM / focus / audit 已单独通过。
