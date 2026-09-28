# 团队 Web

遵循根目录 AGENTS.md、PRODUCT.md 与 DESIGN.md。本包是可选团队界面，桌面不依赖本包构建。

- 只访问 Product API；不直接调用执行器或获取 provider 密钥。
- 本机运行与包内 smoke 验证由开发者完成；用户未要求时不自动打开系统浏览器。
- 模型选择器只展示适合会话的 chat / multimodal profile；纯图像生成能力不作为主会话模型。
- 结果阅读区域保留键盘操作与用户宽度偏好；移动端可独立展开。
- 真实服务和实际渲染是交互验收依据，fixture 预览不能证明执行成功。
