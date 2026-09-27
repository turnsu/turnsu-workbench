# Archived: Pre-M5 三个视觉基准页面 Design QA

> 历史记录，不是 M5 的视觉范围或签收条件。M5 以 `docs/rebuild/07-ux-restructure-m5.md`
> 和根目录 `DESIGN.md` 为准，必须完整覆盖 Agent、Skill、Loop、模型开关与其真实产品状态。

## 对照范围

- 视口：`1487 x 1058`，桌面，light theme，English。
- 浏览器：Codex in-app Browser，本机 `http://127.0.0.1:5184/`。
- 状态：隔离 Product API 数据库中的真实可编辑 Loop、真实 revision 和真实画布数据；未使用客户端 mock readiness、compile、run 或 final answer。
- 检查重点：区域比例、信息层级、排版密度、字体、颜色、控件尺寸、主动作位置、画布可用面积和交互完整性。

## 视觉证据

### Loop 生命周期看板

- 设计真源：`../product-design-audit-web/visual-baselines/2026-07-15/loop-lifecycle-reference.png`
- 实现截图：`../product-design-audit-web/visual-baselines/2026-07-15/loop-lifecycle-actual.png`
- 并排对照：`../product-design-audit-web/visual-baselines/2026-07-15/loop-lifecycle-comparison.png`

### Create Loop

- 设计真源：`../product-design-audit-web/visual-baselines/2026-07-15/create-loop-reference.png`
- 实现截图：`../product-design-audit-web/visual-baselines/2026-07-15/create-loop-actual.png`
- 并排对照：`../product-design-audit-web/visual-baselines/2026-07-15/create-loop-comparison.png`

### Builder Canvas

- 设计真源：`../product-design-audit-web/visual-baselines/2026-07-15/builder-canvas-reference.png`
- 实现截图：`../product-design-audit-web/visual-baselines/2026-07-15/builder-canvas-actual.png`
- 并排对照：`../product-design-audit-web/visual-baselines/2026-07-15/builder-canvas-comparison.png`

完整页面对照已经按同一视口合成。参考图和实现图都保留原始 `1487 x 1058` 文件，可用于放大检查导航、表单、节点、端口、编辑器和底部运行栏；因此没有另建重复的局部裁切文件。

## 对照迭代记录

### Pass 1：结构和主次关系

- `[P1]` 生命周期页仍带有旧列表页语法，缺少明确的 Drafts / Ready / Shared 生命周期。修复：重写为三列生命周期看板，恢复 AI 命令入口、快速创建动作、状态点和卡片动作。
- `[P1]` Create Loop 未形成参考图中的五入口加右侧目标表单闭环。修复：实现 Describe a goal、Start blank、Use a starting point、Upload a Loop、Duplicate existing Loop 五种模式，并保持同一表单和真实创建动作。
- `[P1]` Builder 的画布没有占据页面主区域，Step editor 不完整。修复：重构为 Skill picker、最大化 Canvas、完整 Step editor 和底部 Test run 四区，并保留 Definition / Outline / Canvas 表示切换。
- `[P2]` Builder 视觉数据不足以表达真实编排。修复：使用 Pre-market Research 工作流的六个业务步骤和五条真实连接，显示端口、分支、人工复核、结果节点与选中态。

### Pass 2：密度、对齐和可读性

- `[P2]` 生命周期空列最初贴近顶部，造成视觉重心失衡。修复：将 Ready / Shared 的可操作空状态垂直居中，并保留底部拖放目标。
- `[P2]` Builder 节点最初偏大，第三到第五步无法在首屏形成完整流程。修复：收紧节点宽度、字段间距和画布网格，在不裁切 Step editor 的前提下展示完整主链和分支。
- `[P2]` 顶部 shell 的旧导航、按钮密度和页面标题与参考图不一致。修复：统一为 light-first 顶栏，保留 Skills / Loops / Team library，并把全局创建和当前工作区放在稳定位置。

### Pass 3：最终复核

- 重新截图并生成三张并排对照。
- P0：`0`
- P1：`0`
- P2：`0`

## 必检表面

- 字体与排版：使用单一产品 sans 栈，标题、导航、字段标签、辅助信息和状态文本形成稳定层级；长标题采用截断或合理换行，没有按钮或节点文字溢出。
- 间距与布局：三页均保持参考图的宽屏工作台比例；Create Loop 左右分区、生命周期三列、Builder 三栏加底栏的空间关系清楚；主动作位置稳定。
- 色彩与 tokens：以白色和冷中性表面为主，蓝色只用于主动作、当前选择和交互焦点；绿色、紫色、橙色只用于语义状态；未使用装饰渐变或暗色驾驶舱。
- 图像与资源：三张参考图均为纯产品 UI，不含需要生成或替换的照片、插画和产品图。头像使用当前账户数据提供的轻量身份标识；图标来自项目现有图标库，没有手绘 SVG 或 CSS 图形替代素材。
- 文案与内容：使用 Weekly Product Review、Meeting Follow-up、Pre-market Research 等稳定业务样例；未显示 provider、artifact、schema、mock、fixture 等内部词。
- 交互与状态：Create Loop 五入口、AI 待审建议、Loop 编辑、画布 Add / drag / select / move / delete / connect / reconnect / Esc / zoom / fit / minimap、Step editor 和底部试运行均保留真实行为。
- 可访问性：焦点顺序测试覆盖三个页面；缩放和标签测试覆盖 6 个 zoom cases 与 12 个 label cases；交互控件使用可见焦点和语义标签。

## 剩余 P3

- 生命周期参考图展示 3 个 Ready 和 3 个 Shared 对象；隔离测试数据库当前只有 Draft 对象。实现保留服务端状态权威，使用明确可操作的空状态，不伪造 Ready / Shared 卡片。
- Builder 参考图的 Skill picker 有多项真实 Skill；隔离数据库当前仅注册一个可用 Skill。实现保持真实 registry，不添加仅用于截图的假资源。
- 顶栏账户区使用通用账户标识，而参考图使用照片头像。这是账户数据差异，不影响任务层级或操作。

## 行为回归

- `npm run build`：通过。存在既有 bundle size warning，不影响当前页面功能。
- `npm run smoke`：通过。
- `npm run action:smoke`：通过。
- `npm run state:smoke`：通过。
- `npm run focus:smoke`：通过，3 个页面。
- `npm run accessibility:smoke`：通过，6 个缩放场景、12 个标签场景。
- `npm run dom:smoke`：三个页面路由与视觉结构检查已通过后，阻塞在既有后端步骤 `passing uploaded Skill test` 超时。Agent daemon 因无效 PID owner 记录拒绝启动；本任务按约束未修改 runtime/PID/后端来绕过该失败。
- `npm run review:no-permission`：进入其内部 `dom:smoke` 后被同一 uploaded Skill 后端超时阻塞。

上述两个失败属于真实 Skill 执行测试环境阻塞，不是三个视觉基准页面的 P0/P1/P2 视觉缺陷，也没有通过跳过测试或恢复客户端 mock 隐藏。

## 最终结论

三个页面的可见 P0、P1、P2 已清零；保留的差异均为服务端测试数据密度或账户数据差异，列为 P3。视觉实现可进入用户批准环节。

final result: passed
