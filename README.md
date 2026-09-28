# Turnsu 工作台

围绕本地项目、原生 Agent 会话与可复用方法的桌面工作台。

打开项目，使用自己的 **Pi、Claude Code 或 Codex** 完成任务，在会话中查看结果和文件，再将经过验证的方法沉淀到 **Skill OS**。Loop 用来组织重复步骤，保持简明。

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

[产品定义](PRODUCT.md) · [交互原则](DESIGN.md) · [开发约束](AGENTS.md) · [Wiki](wiki/README.md)
