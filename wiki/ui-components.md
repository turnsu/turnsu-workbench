# 内嵌 Intelligence UI：通用组件与组装合同

2026-10-14 · 用户已确认澄白方向，并纠正为对话内按需交互；授权重做工作台布局。本次将原 27 个组件职责收敛为 7 类；订单、客服、文档仅是组合示例，不注册业务专属组件。

## 给人阅读

| 原子组件 | 职责 | 合并原清单 |
| --- | --- | --- |
| Layout | 顺序、网格、分组，容纳子组件 | Stack / Grid / Panel / Form；切换和弹窗由宿主提供 |
| Text | 标题、说明、来源字段 | Text / FieldValue / SourceRecord |
| Field | 文本、数字、枚举、勾选；统一草稿与校验 | 6 种输入的字段部分 / TaskInput |
| DataView | 有界表格、列表和变更对照 | Spreadsheet / IssueList / DiffList / ColumnMapping / TaskResults |
| Assets | 选择、导入、预览、下载；逐文件回执 | FilePicker / AssetList / Image |
| Status | 真实阶段、错误、部分完成、下一步 | StatusBadge / Notice / Progress |
| Action | 已注册动作及执行反馈 | ActionButton |

这 7 类是可复用交互职责，不要求新建 7 套基础库。浏览器画面、电脑画面、授权与停止属于 3 个宿主控件，不进入模型可任意配置的组件目录。澄白用于工作台与任务内容。7 类是内部组装合同，用户不接触组件名称、绑定字段或技术回执。

员工在对话输入区描述工作并添加材料；需要核对或补充时，Agent 在对话中呈现相应内容。内容可展开到浏览器式区域，展开/收起复用同一实例与持久化状态。没有交互请求时不显示默认任务表单。Agent 可按任务更新组件排列和数据；输入与排版改变不会自动执行。文件导入、启动执行、保存成果、把结果交给 Agent 是独立动作；失败时只恢复对应动作。

## 给 Agent 和开发者

组装采用声明式树：稳定 node id、type、受限 props、binding 和 children。只 Layout 接受 children；所有数据来自当前 session 绑定的 surface，不接受脚本、任意 HTML、表达式、任意工具名或模型传入的授权身份。最多 64 节点、6 层、120 KiB 描述；表格分页，附件按需加载。Field 使用稳定键绑定草稿，DataView 绑定数组，Assets 绑定 Host 校验的文件记录；多组件共享同一数据对象。

宿主原子执行遵循：读取 → 校验/保存草稿 → 导入选定文件 → 提交原会话 → 保存成果 → 回传原 Agent。提交和回传有独立请求 ID；同一请求重试不得再执行。新布局不能覆盖未保存草稿；用 revision 检测冲突。未知组件、字段、动作、跨项目/会话标识拒绝，不能默默降级。

正式验收仍须在现有工作台内完成。内嵌浏览器、Browser Use、CUA、文件与 Agent 回传使用同一项目、会话和授权；运行状态来自 Host。权限不能由 Skill、网页或组件树授予。资源预算与 Linux 主验证、macOS/Windows 实机证据要求见[实施计划](next-workbench.md)。早期评审稿已移出源码；当前组件合同与实际桌面代码共同维护，不保留另一套演示工作台。
