# 06 · 迭代实施交叉审查（2026-07-24）

## 结论

最新 v2 重构方向成立，但原文包含两项已被代码证据否定的事实：

1. 本机 `~/.agents/skills` 当前是 26 个根级 `SKILL.md`，不是 25 个。
2. `binary + args + *` 不能作为授权边界。产品只接受后端注册的精确 Action ID，
   后端拥有二进制、子命令、参数 flag 与执行环境。

本轮已经按该结论实施 M1、M2 主链及 M3 执行内核，未把文档存在或单测通过误报为
真实飞书闭环完成。

## 已落地并验证

- 认证：bootstrap token、账号/Session、成员角色、CSRF/Origin、路由守卫。
- 导入：浏览器目录、受限 ZIP、公开 GitHub 仓库；管理员限定根目录 scan/import；路径
  穿越、ZIP bomb、symlink 与越权负向测试。
- Skill 身份：workspace 内规范化名称唯一，迁移在写入前检查历史冲突。
- Prompt/Tool 执行：固定模型 revision；最多 5 轮；读取引用文件；精确 Tool
  allowlist；结构化输出；模型与 Tool 输出均不获得新的指令权限。
- 模型协议：OpenAI-compatible、Anthropic、Gemini 与 Stability 保持各自原生 wire
  format；统一只发生在产品 Model Service 契约层。
- 运行时：后端、契约与前端的可执行 npm scripts 均显式使用仓库
  `.tooling/node@22.22.3`；运行时 gate 仍拒绝 `<22.19.0`。
- 写操作：编译强制直接前置 Review Gate；确认状态来自持久化 decision；稳定
  effect ID 与 Mongo receipt 防止恢复时重复写；`outcome_unknown` 禁止自动重放。
- 测试路径：脚本 Skill 继续走 Docker；无可执行文件的 Prompt/Tool Skill 走产品
  Execution Broker 和 Tool Gateway，测试阶段禁止外部写。

## 尚未验证 / 外部阻塞

- 真实闭环：缺少可用 Provider 凭证、成员 Lark OAuth/profile 与可达飞书租户，尚未
  完成“发布至少 5 个真实 Skill”和两个端到端业务 Loop。
- 单机 Mongo：当前环境没有可连接的认证 Mongo/Docker，因此新增 migration 与
  receipt 只完成了单元/契约验证，尚未做真实重启读回。
- 发布门禁：前端正在本次已授权重构中且尚未形成新提交基线，旧 frozen frontend
  hash 会按设计拒绝候选；不能改写旧 hash 来掩盖未提交变更。

## 下一迭代顺序

1. 配置单机 Mongo、Provider 与至少一个成员 Lark profile，执行 5-Skill
   publish/readiness。
2. 跑通一个只读 Loop，再跑含 Review Gate 的写 Loop，验证真实 receipt 和重启恢复。
3. 完成 IA 合页验收、移除演示数据、形成新的前端 tree 基线。
4. 重新运行发布门禁、备份/恢复和真实 Provider smoke；只有全部通过才更新生产结论。
