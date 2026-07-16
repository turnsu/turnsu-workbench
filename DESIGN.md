# 设计

> Status: visual reimplementation active. The connected Web behavior is not the accepted visual
> target. The selected design handoff and key frames remain the implementation authority.

## 当前设计权威

按以下顺序使用设计资料：

1. [Selected AI-native lifecycle board](wiki/design/skill-loop-cloud-workbench-v1/visual-directions/selected-ai-native-lifecycle-board.png)
2. [Selected direction and functional closure](wiki/design/skill-loop-cloud-workbench-v1/docs/SELECTED_DIRECTION_AND_FUNCTIONAL_CLOSURE.md)
3. [Key frames](wiki/design/skill-loop-cloud-workbench-v1/key-frames/README.md)
4. [Design acceptance](wiki/design/skill-loop-cloud-workbench-v1/docs/DESIGN_ACCEPTANCE.md)

此前 Web 截图只证明功能、响应式和无障碍运行，未还原选定设计。旧版 `Skills / Workflows /
Templates` 页面结构、Templates-first Builder、灰色数据库式 Loop 看板和暗色驾驶舱均不是视觉权威。

## 产品框架

主导航固定为：

- `Skills`
- `Loops`
- `Team library`

Templates 是 Loop 的起点，不是一级导航。Run 属于 Loop。Builder 是 Loop 的 Definition、
Outline 和 Canvas 编辑路线。AI 只生成待确认建议，不静默修改对象。

## 当前实施顺序

先完成并批准三个视觉基准：Loop 生命周期看板、Create Loop、Builder Canvas。它们确定
shell、token、排版、控件、列表、画布、drawer 和 action hierarchy。三页通过前不批量扩展
其他关键帧或移动端状态。

## 视觉和交互规则

- Light-first，克制蓝色强调，清晰层级，避免暗色驾驶舱默认观感。
- 列表像列表，卡片只用于真正独立对象；禁止卡片套卡片。
- Canvas 在 Canvas 模式中占最大区域，Skill picker 与 Step editor 服务画布而非挤压画布。
- Save、Validate、Test、Run、Publish 必须是不同动作。
- 所有可见按钮真实执行、进入完整流程、显示禁用原因与恢复动作，或被移除。
- 中英文、light/dark、键盘、WCAG AA 和后续 390px 适配必须共享同一设计系统。
- 使用真实、稳定的业务示例，禁止测试 ID、`copy copy` 和 conformance fixture 成为主视觉数据。

## 视觉完成定义

每个基准页面必须在同视口提供参考图、实现图和并排对照，记录实际偏差并修复 P0/P1/P2。
构建成功、截图数量、无横向溢出、DOM smoke 或等待用户批准都不能代替 Design QA。
