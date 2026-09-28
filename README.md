# Turnsu 工作台

面向企业客户的本地 Agent 工作台，连接员工本机资料、可复用工作方法与公司的云端系统。

目标是让员工处理本地工作、整理客户需求、授权云端处理并核验结果；所有客户使用同一客户端，通过插件、Skill 与企业配置适配业务。客服与微信记录导入纳入完整迭代，Loop 保持简明。

**当前处于产品迭代阶段。** [完整迭代计划](wiki/roadmap.md)及[客服 / 微信桥方案](wiki/customer-service.md)已写入 Wiki，待确认后开发；企业受管执行和客服云端闭环尚未实现，不作为当前可用能力宣传。

## 现有基础

打开本地项目，使用自己的 **Pi、Claude Code 或 Codex**，在会话中查看结果和文件，并通过 **Skill OS** 整理可复用方法。具体完成证据与未验证项见[验证记录](wiki/verification.md)。

- **本地工作**：项目、会话索引、消息和未发送草稿保存在本机，支持重开继续。
- **明确的模型来源**：沿用原生 Agent 配置，或为任务选择兼容网关；密钥由操作系统加密保存。
- **按需加载**：会话列表按项目分页，历史按页读取，闲置原生连接自动回收。
- **可选团队协作**：显式共享工作、文件、Skill / Loop 版本与结果。本地使用不要求团队登录。

## 开始开发

需要 Node.js 22.19 或更新版本。原生 Agent CLI 由用户自行安装与登录；桌面不会更改它们的全局配置。

```sh
npm run setup
npm start
```

```sh
npm test        # 本地 Host 与桌面回归
npm run build  # 独立构建桌面
npm run package
```

桌面使用 Electron、React 与私有 Node Host。生成物在 `.build/`，不提交到仓库。macOS 与 Windows 的真实设备验收状态见 [验证记录](wiki/verification.md)。

## 仓库结构

```text
apps/desktop        桌面应用
apps/team-web       可选团队管理界面
packages/           本地 Host、Agent 协议、共享契约与执行模块
services/product-api  可选团队服务
deploy/            服务部署资源
wiki/               当前产品、架构与开发文档
```

[产品定义](PRODUCT.md) · [迭代计划](wiki/roadmap.md) · [交互原则](DESIGN.md) · [开发约束](AGENTS.md) · [Wiki](wiki/README.md)
