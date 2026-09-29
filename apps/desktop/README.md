# Turnsu 桌面

Electron + React 界面通过窄 IPC 访问私有 Node Host，接入本机 Codex、Pi、Claude Code 和 OpenCode。项目、草稿、可见消息与原生会话 ID 保存在本机；系统文件选择器可向项目导入普通文件，常用成果可由系统打开。团队协作按需连接。

从仓库根目录执行 `npm run setup`，然后 `npm start`。本包 `npm run build` 独立构建 UI 与 Host，不依赖团队 Web。

- [开发指南](../../wiki/development.md)
- [会话与资源策略](../../wiki/memory.md)
- [验证记录](../../wiki/verification.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)
