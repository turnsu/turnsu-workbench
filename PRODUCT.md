# 产品

## 当前产品目标

Looloomi 是一个面向个人与团队的 **Skill 与 Loop 云端工作台**。

它只解决五件相互连接的事情：

- 管理、测试、版本化和微调大量 Skill；
- 用明确目标和多个 Skill 创建可重复执行的 Loop；
- 管理、试运行、发布、复用和持续改进 Loop；
- 在团队工作区内共享、安装、Fork 和显式升级 Skill/Loop；
- 在云端创建或上传 Skill 与 Loop，同时保证权限、密钥和执行安全。

完整目标需求见 [Master PRD](wiki/prd/2026-07-10-skill-loop-cloud-workbench-master-prd.md)。
当前已经实现和仍然缺失的能力，以
[Current System Architecture](wiki/architecture/CURRENT_SYSTEM_ARCHITECTURE.md) 为准。

## 统一产品语言

- `Skill`：可版本化、可验证、可执行的能力包。
- `Loop`：由目标契约、Skill 执行图、输入、复核、输出和验收规则组成的可复用流程。
- `Run`：固定使用某个 Loop 版本和 Skill 版本的一次执行。
- `Team library`：工作区内已发布、可发现和复用的 Skill/Loop。
- `Template`：被标记为推荐起点的已发布 Loop 版本，不是独立一级对象。

`Workflow` 作为现有后端模型和执行图术语暂时保留，主界面统一使用 `Loop`。不得新建
一套与现有 Workflow 修订、编译和 Run 平行的数据系统。

## 核心用户

- 高频使用大量 Skill、希望减少重复组合的个人操作者；
- 创建、测试和维护 Skill 的作者；
- 把业务目标编排成可执行 Loop 的构建者；
- 负责团队资产发布、版本、权限和风险的维护者。

## 产品入口

主导航收敛为：

- `Skills`
- `Loops`
- `Team library`

全局创建入口提供：创建 Skill、上传 Skill、创建 Loop、上传 Loop。

Builder 是 Loop 的编辑页面；Run 是 Loop 的运行记录；Template 位于创建流程和团队库。
它们不再各自成为互相竞争的一级产品。

## 产品原则

1. 先管理对象，再使用聊天。聊天只生成待确认的草稿或结构化修改建议。
2. 先让人理解，再允许执行。用途、需要、生成、权限、复核和停止条件必须清楚。
3. 已发布版本不可变；每次 Run 固定 Loop 和所有 Skill 的准确版本。
4. Loop 同时拥有可读目标契约和可执行图，二者缺一不可。
5. Readiness 只能由服务端验证、编译和运行环境检查推导。
6. 团队共享包和元数据，不共享发布者密钥；连接在安装/运行工作区重新绑定。
7. Run 结果、失败、证据和复核决策要能推动下一版 Skill/Loop。

## 当前与目标边界

当前 P0 是 local-first、单用户、同源 Product API 的真实闭环。目标 V1 在这套边界上补齐：

- 真实业务 Skill 创建、上传、验证、测试与发布；
- 通用 Loop 创建、目标契约、上传、版本和发布；
- 团队工作区、成员角色、云端资产库、安装/Fork/更新；
- 对象存储、密钥隔离、上传隔离与执行沙箱；
- durable queue、崩溃恢复、取消/重试和真实 revise 输入。

## 非目标

- 不做独立股票、会议、crypto、research 等垂直产品；它们只能作为 Skill/Loop 示例。
- V1 不做公开市场、计费、创作者商业化或跨组织联邦。
- 不做通用 Agent 聊天首页、provider 面板、ops console 或监控驾驶舱。
- 不允许浏览器直接调用 Agent daemon、读取密钥或接收 provider/tool 原始事件。
- 不允许 Agent 静默修改、发布或重排 Loop。

## 验收结果

产品完成的标志不是“画布能拖节点”，而是两个团队成员可以从空工作区完成：创建/上传
Skill、验证发布、发现安装、创建 Loop、编排试运行、人工复核、发布共享、显式升级、重跑
比较，并且版本、权限、密钥、事件和最终结果都有可验证的后端与 Agent 证据。
