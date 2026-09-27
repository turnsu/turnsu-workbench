# M5 组件交互说明

- 2026-07-28：v2 交互重构已批准合入。配色 token 与文案对照表见
  [`M5_UX_REDESIGN_V2.md`](M5_UX_REDESIGN_V2.md) 第 1.0、8 节；关键帧见
  [`M5_KEYFRAME_BOARD.html`](M5_KEYFRAME_BOARD.html)。

## 按钮与控件（P0）

- 三级按钮：primary（靛蓝 `#4f46e5`，每屏 ≤1 个）/ secondary（白底描边 `#ddd9d3`）/
  tertiary（无边框蓝字）；danger-ghost 红字透明底。**黑色实心按钮移出体系**；
- 禁用态必须附原因：tooltip 或按钮旁 inline hint，全站二选一；
- 输入框：可见边框、圆角 8、高 38px；聚焦 = 靛蓝边 + 4px 浅环
  `rgb(79 70 229/.10)`；标签在上、帮助/错误文本在下，禁止裸标签无框；
- 原生控件全部替换：select→自定义 dropdown，number→自定义 stepper，
  file→统一 dropzone（每屏只有一个文件选择入口）；
- JSON 编辑区固定高度、等宽字体，无可拖拽 resize 手柄；
- 空态统一 EmptyState（图标容器 + 标题 + 说明 + 最多一个动作）；Banner 顶部 sticky、
  可关闭、成功类 5s 自动消退；瞬时反馈走 toast 不常驻；
- 状态 pill 统一规格，色彩之外恒有文字；深色为暖黑同族（`#1c1917`/`#292524`），
  ghost/tertiary 文字 ≥4.5:1、边框与禁用底 ≥3:1。

## 模型选择（原 ModelSwitch）

- composer 工具条只有模型按钮（模型 chip + 附件 + ⌘⏎ + 发送），**无文本/图像模式
  切换**；
- popover：列出团队开通的受治理模型，能力直接标注（支持图片 / 仅文本），底部治理
  说明（"这里只选要用的模型，账号密钥由团队统一管理"）；不展示 credential、endpoint
  或 provider payload；
- 输入时检测：拖入/粘贴图片而当前模型不支持时，图片以附件 chip 出现在 composer，
  notice 给出"换模型 ▾ / 移除图片"两个出路，发送保持禁用并附 tooltip
  （"这个模型看不懂图片"）；不在输入前拦截，不静默丢弃；
- 无可用模型：composer 上方独立 notice（原因 + "怎么开通"），发送禁用附 tooltip；
- `ArrowUp/ArrowDown/Home/End` 移动，`Enter/Space` 选择，`Esc` 关闭；关闭或选择后
  焦点回 trigger；
- route 只保存 `modelProfileId`，revision 在后端入队时 pin。

## Agent Session 栏与结果阅读页（原 Agent Drawer）

- 左栏 session 列表（236–246px）：顶部"任务 + ＋新任务 + ‹ 折叠"；折叠后收成 44px
  图标条（» 展开 + 状态点仍可见）；
- 列表按时间分组；每行 = 状态点（进行中脉冲 / 排队灰 / 待确认 amber / 完成绿）+
  标题 + 状态/时间；Loop 运行以 ⤴ 标记 + Loop 名，从看板跳入时直达；
- 进行中：时间线内联"正在处理（第 N 步，共 M 步）"+ "执行细节 ▾" 展开步骤日志 +
  显式取消；排队显示"排队第 1 位"；
- 上下文内联：执行步骤写明读取来源（"读取 6 份访谈记录"），结果卡带"来源" chip，
  不设独立上下文标签页；
- "打开结果 →" → 结果阅读页：桌面右侧 384px 面板（✕ 关闭），移动端推进式整页；
  渲染好的 Markdown + 下载/复制 + 多产物头部 1/N 翻页 + 底部"运行信息"折叠区
  （模型/来源/用时/用量）；阅读页加载失败只影响面板内并提供重试，不覆盖主任务流；
- 面板按需出现，不出现时不占版面（渐进披露保留）。

## Skill Wizard

- 专注 route（桌面 max 900px），**左侧步骤导航**：显示"第 N 步，共 7 步"，已完成
  可点击回跳，返回不丢数据；390px 为全屏 route：返回 + 步骤名 + N/M + 细进度条 +
  sticky footer；
- 步骤与内容：1 类型（2×2 卡片，工具→帧 18 工具导入，工作流→Loop 创建）→
  2 做什么（职责 + 需要的材料/需要的参数两组行编辑器，均可为空）→ 3 怎么运行
  （运行环境可选：Python 3.12 / Node.js 20 · TypeScript，均隔离沙箱；超时/内存
  stepper；环境目录由后端下发，前端不硬编码，选择只保存 runtime id）→ 4 分类
  （领域 chips，与资源库领域 rail 同一套 + 适合场景 tags；风险不由用户自评）→
  5 草稿内容（将生成文件清单 + 预览，明示创建后仍可改）→ 6 试运行（要证明什么 +
  示例输入 + 预期可选，不在向导内真跑）→ 7 最后检查（概述/定义/输入输出/包含文件/
  试运行要证明，每区"返回修改"）；
- footer 恒为：左 tertiary"← 上一步"（第 1 步为"取消"），右 primary"继续 →"；
  下一步只在当前字段校验通过后可用；
- 第 7 步 footer 常驻治理承诺（只有你能看到 · 保存后不会自动运行或发布）；
- 创建 Draft 后明确进入对象 route，Test、Validate、Publish 不在 wizard 内自动发生。

## 试运行与发布（Skill 详情内）

- 显性三步：① 先试跑一次 → ② 确认它的能力范围 → ③ 发布固定版本；
- 完成步折叠为绿色 ✓ 摘要（可展开重跑）；当前步展开；后续步锁定并注明解锁条件；
- 步骤 1 表单按控件规格；主按钮卡内右对齐；结果（通过/失败/日志）以结果面板呈现；
- 步骤 2：能力范围摘要 notice + checkbox"我明白它能做什么、不能做什么" +
  primary"确认，继续"（步骤 1 通过前锁定附原因）；
- 步骤 3：版本号 + 变更说明 + 受影响工作流列表；发布按钮步骤 2 完成前锁定，原因
  走 tooltip；发布版本不可编辑，现有 Loop 保持各自锁定版本。

## Proposal Review

- 顶部常驻 info banner："Loop 还没有创建"，确认后才保存为草稿，刷新从 Product API
  恢复；
- Definition 字段与节点标题行内可编辑（hover 出编辑动作），服务端 proposal 是刷新
  恢复真相；
- 右侧摘要卡：校验状态列表 + 唯一 primary"保存为草稿" + tertiary"放弃提案"；
  validation 只表示 proposal schema 状态，不显示 canonical readiness；
- commit pending 时禁止重复提交；幂等重放返回同一 Workflow/revision；
- expired、permission 和 conflict 均不创建替代空 Draft。

## Loop 三态看板

- 页面动作：primary"＋ 新建 Loop" + secondary"⇪ 上传 Loop"（技能入口走顶栏 + 新建）；
- 只表达对象 lifecycle（设计中/可运行/已共享），不内嵌运行；可运行卡的运行入口为
  跳转链接"▶ 去 Agent 页运行 →"，在 Agent 任务栏生成 ⤴ 任务；Run 结果回 Agent 页
  统一输出，状态回写看板；
- 空列统一 EmptyLane（"如何到达这里"说明 + 适用时一个动作）；拖拽进行中只有目标列
  高亮 drop target；
- Loop 卡：名称 + 状态 pill + 元信息（节点/技能数/相对时间）+ hover 快捷操作
  （编辑/⋯）；时间一律相对化；
- AI 命令条为 hero 条（✦ + ⌘K + 聚焦环），视觉区别于普通输入框。

## 创建第二跳（Loop 与 Skill 入口的落地页）

- 空白 Loop → 直接进 builder 大纲（builder 复用现有关键帧）；
- 从起点开始 → 起点模板库：领域 chips 筛选 + 模板卡网格（用途/包含内容/发布组/
  版本），"用这个起点"复制草稿进 builder；
- 复制现有 Loop → 选择对话框：搜索 + 行选择，页脚注明"复制为新草稿，原 Loop 不变"，
  "复制并打开"进 builder；
- 工具技能导入 → 团队已注册工具列表（名称/能力/精确 Action ID/已注册状态），接入后
  同样走 草稿 → 试跑 → 确认 → 发布；后端只接受精确批准的 Action ID。

## Team Library

- 三栏：领域 rail（全部资产 + 产品/研究/数据/工程，带计数；已安装/有更新状态过滤；
  脚注注明本版不含权限设置）→ 类型 tabs（技能/工作流/起点模板，带计数）+ 搜索 +
  行列表 → 预览面板；
- 行：图标 + 名称 + 用途一句话 + "材料 → 产物" chips + 领域标签 + 被 N 个工作流用 +
  安装状态 + 唯一动作（安装 / 查看更新 / 打开）；
- 预览面板：能做什么 + 包含什么 + 用在哪 + 版本对比 + 治理 notice + 唯一主按钮
  （安装 / 看看影响再决定）；
- viewer、缺 Connection、版本冲突、更新影响均使用明确原因和恢复动作。

## 移动端

- 主导航为底部 tab bar（Agent/技能/工作流/资源库，图标 + 短标签）；顶栏合并一行
  （logo / ＋ / 铃铛徽标 / 头像）；
- Agent：任务列表 → 任务详情 → 结果阅读页三层推进；
- 创建：全屏向导（见 Skill Wizard）；移动端不提供技能包文件导入，显示边界说明 +
  复制链接/发送到邮箱回桌面继续；
- 工作流：三态 lanes 单列竖排；资源库：领域 chips 横滑 + 行结构；
- 触控目标 ≥44px；drawer 变 bottom sheet。

## Route Loading

- Shell 保持稳定，feature route 区域显示同形 skeleton；
- chunk load error、Product API error、permission、not found 分别处理；
- nav hover/focus 可以预加载模块，但不得抓取完整 feature 数据；
- 身份切换先取消旧 principal query，再卸载 feature route；
- lazy fallback 不显示上一用户或上一对象的残影。
