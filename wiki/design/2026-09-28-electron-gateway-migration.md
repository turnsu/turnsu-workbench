# Electron 桌面与公司模型网关接入

日期：2026-09-28。产品方向已确认；实现和验收以架构现状为准。

## 决策与范围

桌面改用 Electron + React + 私有 Node Host，移除 Tauri 开发入口。保留现有工作台、Skill OS、SQLite、原生 Agent 会话与 Product 接口。用户打开项目、发送任务、查看真实结果、退出再继续的路径应保持连贯。ShotSeek 和 doc-templates 不进入本轮工作台。

选择 Electron 是本仓的工程判断：现有 React 组件与公司脚手架可以保留，Node Host 和原生 Agent 接口无需重建；统一 Chromium 版本便于控制跨系统渲染差异。Flutter 或分别开发 SwiftUI/WinUI 会重建两套已有前端能力，当前没有足够收益支持。Electron 的进程基础成本真实存在，不能承诺换壳后比 Tauri 或 WorkBuddy 更省内存。

## 外壳与进程

- Electron 主进程只拥有窗口、原生文件选择、浏览器授权、系统密钥保护和 Host 生命周期。单主窗口；默认不启动嵌入式浏览器、多窗口或插件进程。
- React 在 sandbox/contextIsolation 中运行，关闭 Node integration，限制 CSP、导航、窗口创建、权限申请与 IPC 发送来源。preload 只暴露已知工作台操作，不暴露 Electron/文件系统对象。
- 现有 Node Host 在 Electron utility process 中运行，保留 stdio CLI 入口供独立验证。两种传输使用同一 Host，不另建会话数据库或执行引擎。
- 沿用 `ai.turnsu.desktop` 的私有状态目录与 SQLite 锁；旧外壳未退出时明确拒绝并发打开。新配置只添加可兼容字段，既有会话默认继续其原有 Agent 设置。
- 退出先关闭 Agent、Host 与待处理请求；失败/超时不自动重发任务。资源看主进程、Renderer、GPU、Host、Agent/MCP 全组，原生 Agent 单列。

依据：[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)。

## 公司 llm-gateway 的接法

依据固定版本 [`9051eeb`](https://github.com/turnsu/llm-gateway/tree/9051eebc7be08f63311b44193234b83f71b89acb)：公司网关是 New API 管理前端；网关令牌和模型转发由其后端拥有。工作台通过协议消费，不导入管理端代码、渠道配置或计费数据库。根许可证与部分文件许可证不同，本轮不复制网关源码。

工作台设置增加“模型连接”：公司网关默认地址 `https://gateway.turnsu.org/v1`；也可输入自有兼容地址。用户填写自己有权使用的令牌，选择 Responses / Messages / Chat Completions 协议，读取 `/v1/models`；只显示“模型目录可读取”，不把它冒充推理、工具调用或配额可用。令牌管理仍在公司网关。

新会话明确选择“跟随原生 Agent”或已保存连接，再选模型。尚未连接原生会话、从未提交的 Skill/Loop 准备任务也可选择来源。Codex 接 Responses、Claude Code 接 Messages、Pi 接受其原生支持的兼容协议。连接或提交后固定来源；切换供应商需新建会话，避免旧上下文被无意发送到另一服务。连接缺失、密钥不可解锁、模型不可用时阻止发送并给出修复入口，不回退到别的账号。

密钥由 Electron `safeStorage` 加密后存本机，解密只在主进程/私有 Host/所选 Agent 进程内使用；保存后的查询不返回原文。只用进程环境、启动参数中的非密钥字段或原生请求配置，不改 `~/.codex`、Claude/Pi 的全局账号和设置。密钥不进仓库、SQLite、日志、Product、URL。端点更改创建新连接；更新密钥需先结束使用该连接的任务。[safeStorage 边界](https://www.electronjs.org/docs/latest/api/safe-storage)不等于防御本机同用户恶意进程。

使用异步加密 API，系统密钥操作超时后明确提示、保留旧文件；空配置启动和列表读取不访问钥匙串。开发包实测曾因同步钥匙串调用等待系统授权而阻塞主线程，调用栈确认后已替换。正式 macOS 发行仍需稳定签名，避免更新反复触发钥匙串授权；不自动批准系统提示。

## 迭代与验收

1. 替换外壳、构建脚本与窄桥接；真实 Host 验证原数据可重开、草稿与模型保留、退出收尾。macOS 本机可验，Windows 打包与实际 IME/DPI/子进程路径单列。
2. 接入模型连接设置与三个原生适配器；使用隔离 HTTP 服务验证真实请求的协议、端点、鉴权、失败反馈和持久化，不用静态源码断言代替调用。
3. 实际桌面验证设置的空态、校验、保存、重开、模型加载、请求失败、键盘焦点与会话来源。没有公司的可用令牌时明确标记真实网关推理未验，不使用用户其他程序的凭据凑验收。
4. 长会话/多任务/后台/退出继续按内存专项的工作负载记录。未取得真实 Windows、长时间曲线与发布签名证据，不标记为双平台正式发行完成。

不在这一轮重建 Skill OS/Loop 执行模型、配置管理员控制台、云端 LLM 代理或自动升级服务。必要后续以真实使用缺口决定。
