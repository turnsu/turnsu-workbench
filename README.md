# Turnsu 工作台

Turnsu 工作台是面向企业员工的本地 Agent 工作入口。打开项目，导入或引用资料，选择已有的 Codex、Pi、Claude Code 或 OpenCode，完成任务并核对项目文件；会话、草稿和可见结果留在本机，重开后可以继续。团队共享和云端复杂任务按客户授权启用，不是本地任务的前置条件。

## 用户路径

1. 打开一个本地项目文件夹，用系统选择器导入资料，或在项目文件面板选择已有文件。导入保留原文件，项目副本放在 `Imported/`；同名文件不覆盖。
2. 选择本机已有且已登录的 Agent，按需选择模型来源。新任务可记住个人或本项目默认值；已开始的会话固定执行器和原生会话 ID。
3. 描述目标并引用选定文本。工作台显示回答、工具活动和原生权限请求；停止或断开后可核对结果再恢复。
4. 在项目文件中预览文本、系统打开常用文档或定位其他文件。有效做法可整理成 Skill；Loop 只用于需要顺序复用的步骤。

macOS 上可主动选择微信桥 v1 交接，核对原文和解析覆盖后在本机任务中引用。导入本身不调用模型、不上云、不发微信。Windows 可通过系统选择器导入授权导出的普通文件；当前不宣称自动解析 ZIP、图片、音频或扫描 PDF。

**本地工作台不等于离线模型。** Agent 若连接远程模型，会按其账号和配置发送输入。工作台也不能替客户已有 Agent 的全部原生工具设置强制统一沙箱。

## 当前状态

本地项目、会话分页、草稿、资料引用、Codex、Pi、Claude Code、OpenCode、Skill OS、简明 Loop 和可选团队接线已有实现。本轮加入 OpenCode ACP 适配、本机文件导入及成果系统打开路径。Linux 开发机的 Host 回归、构建，以及真实 OpenCode 项目文件任务与重开续跑已验证；GitHub Actions 上 macOS、Windows 的 Host 行为、原生 Electron 检查与无签名打包也已通过。其他 Agent 的本轮真实任务、macOS/Windows 文件对话框与可见交互、签名发行和长时完整进程组内存仍需对应设备验收。当前不能把它标为已完成正式跨平台客户交付。证据见[验证记录](wiki/verification.md)，退出条件见[本地交付计划](wiki/roadmap.md)。

## 开发

需要 Node.js ≥22.19；每个包保留自己的锁文件。原生 Agent CLI 与登录由用户配置，工作台不改写全局配置。

```sh
npm run setup
npm test
npm run build
npm start
```

`npm run package` 生成桌面包。桌面由 Electron、React 和私有 Node Host 组成；日常构建及自动测试可以在 Turnsu Linux 开发机的隔离环境进行，不需在个人 Mac 上反复安装。macOS 与 Windows 的系统交互和发行包需要各自实机验收。

| 路径 | 内容 |
| --- | --- |
| `apps/desktop` | 桌面界面、主进程和安全 IPC |
| `packages/agent-host` | 本机状态、四种 Agent、资料与恢复 |
| `apps/team-web`、`services/product-api` | 可选团队管理与共享事项 |
| `packages` | 共享契约、客户端和运行模块 |
| `deploy`、`wiki` | 可选部署与现行文档 |

[产品定义](PRODUCT.md) · [交互设计](DESIGN.md) · [开发指南](wiki/development.md) · [开发约束](AGENTS.md)
