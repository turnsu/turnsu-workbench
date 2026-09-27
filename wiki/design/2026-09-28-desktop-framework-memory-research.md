# 桌面框架与 WorkBuddy 内存调研

- 日期：2026-09-28
- 状态：调研与选型建议；已获准实验，迁移仍取决于实测
- 关联：[工作台、Skill OS 与 LOOP 迭代方案](2026-09-28-workbench-skillos-iteration-plan.md)

## 1. 当前判断

桌面底层可以替换，Tauri 2 只是当前实现，不是约束。建议进入实测候选的是 **React + Tauri** 与 **React + Electron**；Flutter、SwiftUI + WinUI 保留为需要重做渲染层时的候选。现阶段证据不足以宣布某个框架在本产品上更省内存。

原因：公司脚手架和现有界面都以 React 为基础，前两个候选可以共享同一份真实界面和工作负载，直接比较桌面外壳带来的差异。若瓶颈来自消息渲染、长驻 Agent 进程或文件同步，优化应落在实际责任模块；可以修改 Host 或 IPC，不必把调整限制在 CSS 和组件。

当前仅完成官方文档、仓库源码与本机安装包元数据调查。后文的基准、预算和工程措施均为待验证方案，不是已实现的能力。

## 2. 本次直接核实的事实

| 对象 | 已核实 | 尚未证明 |
| --- | --- | --- |
| Turnsu 桌面端 | Tauri 2，独立 React 入口；Rust 经私有 stdio 驱动 Node local-agent-host；本机 SQLite 保存会话关联与草稿 | 两个平台的长期运行内存、当前完整 GUI 黄金路径 |
| Turnsu Web | React/Vite、Astryx 组件层及 Flowgram；与桌面不是同一个页面入口 | 直接放进桌面即可满足本地工作台需求 |
| 本机 WorkBuddy | `/Applications/WorkBuddy AI.app` 的版本为 5.6.2；内置 Electron Framework 为 37.10.3，存在 Renderer、GPU、Plugin Helper | 哪个进程导致用户遇到的内存上涨、当前版本是否仍有特定泄漏 |
| 进程状态 | 采样时没有正在运行的 WorkBuddy 进程 | WorkBuddy 的空闲、工作中或峰值内存 |
| Turnsu GUI 探查 | 本轮打开现有开发包时只看到空白内容区域 | 不能将该状态的进程 RSS 当作正常工作台的性能基线；白屏原因未定位 |

版本来自本机 `Info.plist`，不是网页推断。没有启动 WorkBuddy 工作任务，也没有升级其版本、读取用户对话或修改其配置。

后续同日已重新构建 macOS 开发包，并通过实际 GUI 看到了工作台及 Skill OS 空目录；
先前白屏仅代表当时打开的旧开发包，仍不能作为资源基线。刷新请求的串行与末次合并已在
本轮代码中接入并通过聚焦测试；是否改善长期内存曲线仍待同负载实测。

Turnsu 源码依据：[桌面说明](../../domains/frontend/desktop/code/turnsu-desktop/README.md)、[Rust 入口](../../domains/frontend/desktop/code/turnsu-desktop/src-tauri/src/main.rs)、[本地 Host](../../domains/agent/code/local-agent-host/host.mjs)、[数据与权限职责](../architecture/desktop-cloud-boundary.md)。

## 3. WorkBuddy 官方资料能支持什么结论

[官方中文更新日志](https://www.codebuddy.cn/docs/workbuddy/Changelog)记录了多类性能修复：

| 版本 | 日志所述问题类别，以下为概括 |
| --- | --- |
| 5.6.0，2026-09-19 | 减少流式回复计时带来的无效界面更新 |
| 5.5.0，2026-09-01 | 优化内置浏览器标签切换和后台资源使用 |
| 5.3.12，2026-08-12 | 修复本地助理内存快速增长、白屏或崩溃 |
| 4.24.0，页面未标明确切日期 | 修复长对话与多任务下的内存和渲染故障 |
| 4.9.2，页面未标明确切日期 | 修复重复卸载套件引起的内存泄漏 |

这些是厂商历史修复声明，不是对本机 5.6.2 的诊断。它们把调查方向具体指向会话、浏览器与插件生命周期，也说明不能只用“Electron 吃内存”解释现象。中文站全文已通过只读 HTTP 获取；国际站更新日志较旧，没有拿它替代中文版版本证据。

### 可以验证的原因树

| 假设 | 预期观察 | 怎样区分 |
| --- | --- | --- |
| 框架及进程基础开销 | 冷启动后较高，随后进入稳定平台 | 没有任务、预览和扩展的空闲样本 |
| 长对话 / Markdown / 工具日志常驻 | 历史长度或输出量增加时 Renderer 显著增长 | 同一任务逐段增加历史，切走再返回，检查对象保留与 DOM |
| 多标签 / 产物预览 | 每打开一项新增 Renderer、GPU 或文档服务开销 | 逐项打开与关闭，检查关联进程和内存回落 |
| Agent / MCP / 扩展生命周期 | 工作结束后相关后台进程持续累积 | 记录任务开始、结束、关闭前后的进程树与句柄 |
| 文件索引 / 同步 / 大文件缓冲 | 大项目或同步时 Host 增长 | 同样会话搭配小目录与大目录，单独关闭同步作对照 |
| 缓存和内存泄漏 | 缓存应趋于稳定；泄漏会随等量循环持续增长 | 相同负载多轮执行、恢复到同一状态，观察长期斜率及引用链 |

以上均为排查假设。单张活动监视器截图、安装包体积、单个主进程的 RSS 都不能确定泄漏原因。

## 4. 框架候选与取舍

| 路线 | 公司 React 组件复用 | 跨系统特征 | 内存判断 | 当前建议 |
| --- | --- | --- | --- | --- |
| React + Tauri | 高；组件与产品状态可保留 | macOS 使用 WKWebView，Windows 使用 WebView2；渲染与系统版本存在差异 | 不捆绑浏览器发行体；仍有 WebView、GPU、Rust 和现有 Node Host 开销 | 进入同负载实测，不预设胜出 |
| React + Electron | 高；主要迁移桌面 IPC、窗口及打包 | 同一 Chromium 发行版本便于控制渲染差异；系统交互仍需分别适配 | Chromium 多进程和 Node 有基础成本；是否增长取决于生命周期与界面实现 | 作为正式对照候选，不因 WorkBuddy 个案排除 |
| Flutter | React 组件不能直接变成 Flutter 控件；可复用设计语言与业务协议 | 自有 UI 渲染体系，系统能力通过平台集成 | 不能用“原生编译”推导低内存；需额外验证文本、预览、插件 | 当前不优先；前两者无法达到体验指标时再投入 |
| SwiftUI + WinUI | 主要复用视觉规范、协议、Host；两套 UI 需要重建 | 更直接使用各平台 UI 能力，同时维护两套界面 | 仍受文档预览、Agent、缓存影响，没有自动低内存保证 | 仅在明确的原生交互或资源瓶颈值得重建时考虑 |

依据：[Tauri 进程模型](https://v2.tauri.app/concept/process-model/)、[WebView 版本](https://v2.tauri.app/reference/webview-versions/)、[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[Flutter 架构](https://docs.flutter.dev/resources/architectural-overview)、[SwiftUI](https://developer.apple.com/swiftui/)、[WinUI](https://learn.microsoft.com/en-us/windows/apps/winui/winui3/)。表中“当前建议”与迁移成本为针对本仓库的工程判断。

特别注意 Windows：WebView2 也包含浏览器、渲染和 GPU 等进程，多个用户数据目录会产生多组相关进程。因此不能把 Tauri 在 Windows 上视为一个轻量单进程程序。[Microsoft 进程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)

### 最终选择规则

1. 两个平台都能完成真实本地任务、权限回应、结果查看、关停与恢复，才有资格比较性能。
2. 相同 React UI、相同本地 Host、相同数据和 Agent 版本，比较 release 包；先隔离外壳差异。
3. 若耗时和内存主要落在 Host / Agent，应调整那一层，再决定是否迁移外壳。
4. 两者都通过体验与资源门槛时，比较打包、升级、原生适配与长期维护成本；现有实现仅影响迁移成本，不决定结论。
5. 如果现有 WebView 在必须支持的 macOS / Windows 上存在无法合理修复的渲染或无障碍问题，允许迁移 Electron；若两条 React 路线都不达标，再评估渲染层重建。

## 5. Turnsu 当前值得优先测量的开销

| 代码观察 | 可能影响；不是已证实的泄漏 | 首先验证 |
| --- | --- | --- |
| [main.jsx](../../domains/frontend/desktop/code/turnsu-desktop/src/main.jsx) 每次刷新都读取 workspace 与当前 session；本轮已加入在途串行及末次合并 | 原先可能在消息流期间重复序列化、跨进程复制及 React/Markdown 重新处理；新队列的资源收益尚未实测 | 相同输出下请求次数、传输字节、主线程耗时 |
| 同一入口静态导入团队、同步、技能和 Loop 面板 | 首次打开需要加载不立即使用的代码 | release bundle 的实际首屏依赖与解析成本 |
| [host.mjs](../../domains/agent/code/local-agent-host/host.mjs) 中 Pi / Claude 连接按会话放入 Map，未看到统一的空闲逐出策略；退出应用时关闭 | 多个原生会话可能保留进程和状态 | 依次打开、完成、切换任务后，存活连接与进程是否累积 |
| [shared-files.mjs](../../domains/agent/code/local-agent-host/shared-files.mjs) 对共享项目每 5 秒调度同步，已有运行中去重 | 项目数量和目录规模增加时产生后台 I/O；不能仅凭计时器判定泄漏 | 空闲 / 文件变化 / 无网三个状态的扫描量与唤醒率 |
| [历史读取](../../domains/agent/code/local-agent-host/message-history.mjs) 已使用最多 40 条、通常最多 256,000 字符的分页窗口，单条超长记录例外 | 这是已有保护；极长单条和流式文本仍可造成峰值 | 2,400 条历史与单条超长输出分别测试，不重复重建已有分页 |

后续可能采用的措施：面板按需加载、可见消息窗口、单次刷新在途合并、隐藏页面降低展示刷新、预览销毁、限量缓存、空闲会话释放及可恢复重连。它们按实测瓶颈选择，不提前整体重构。暂停显示刷新不能暂停权限等待、任务完成记录或必要的同步；释放会话前必须证明原生恢复可靠。

## 6. 实测方案

### 同负载、分层归因

- **设备**：至少一台真实 Apple Silicon Mac 和一台真实 Windows x64 机器；建议各覆盖一台团队最低内存配置。Intel Mac、Windows ARM64 按团队设备清单确定是否进入首发，不在没有机器时声称支持。
- **构建**：固定候选提交、release 模式、系统 / WebView / GPU / Agent 版本、文件集、任务输入与同步状态。关闭开发服务器和 DevTools；测量工具开销单独说明。
- **比较范围**：整款应用及其相关 WebView / GPU / Host；原生 Agent、MCP、预览服务单列，同时报告含它们的用户侧总成本。WebKit 服务不一定挂在应用 PID 下面，不能仅靠父子 PID 归属。
- **计量**：macOS 看 physical footprint、内存压力、压缩与 swap；Windows 看 Private Bytes / private working set 和系统 commit。RSS 可作线索，不能跨系统直接排名，也不能将共享页重复累计成精确总量。
- **工具**：系统活动监视器、Instruments / vmmap；Windows Process Explorer / VMMap；自有 Electron 候选可补充 `app.getAppMetrics()` 与 heap snapshot。不开启第三方应用的调试端口来冒充已获取堆证据。

[Electron 内存 API](https://www.electronjs.org/docs/latest/api/process#processgetprocessmemoryinfo)也说明 macOS 的压缩会影响 RSS 解释；[VMMap](https://learn.microsoft.com/en-us/sysinternals/downloads/vmmap)可区分 committed memory 与 working set。[Electron 性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)可用于定位不必要工作与启动负担。

### 场景与判断

| 场景 | 操作 | 关键证据 |
| --- | --- | --- |
| 冷 / 热启动 | 无团队连接，打开真实本地项目，允许输入 | 从进程启动到可操作；完整进程内存，不只空窗口 |
| 长历史 | 2,400 条可追溯测试消息，反复前后翻页并切换会话 | 原记录完整；可见窗口、主线程耗时与稳态内存有界 |
| 长输出 | 受控流式文本、代码、表格，再用真实 Agent 完成一份固定文件任务 | 合成负载用于归因；真实任务用于实际入口验证，结果分开报告 |
| 多会话 | 顺序使用 10 个会话；另测 3 个并发任务 | 页面关闭后释放情况；活动任务和待回应权限不被误终止 |
| 文件与预览 | 在隔离目录查看长文、文件树，重复打开关闭已支持的预览 | 缓存和视图实例数量是否回到稳定范围；不扩展新预览能力 |
| 隐藏与唤醒 | 空闲后台 30 分钟，睡眠 / 唤醒，网络断开再恢复 | CPU、唤醒、内存曲线，未提交草稿和待确认回执保留 |
| 恢复与退出 | 停止、退出、重开，在隔离副本中做异常退出 | 无无主后台进程；原生会话继续；不会自动重跑已提交任务 |

### 建议预算，待基线校准

以下是产品试点的起始目标，不是行业标准，也不是当前成绩：

- 本地冷启动到可输入 p95 ≤ 3 秒；已读任务切换 p95 ≤ 300ms；正常输入反馈 ≤ 100ms。
- 不启动原生 Agent / MCP / 文档服务时，完整外壳与 Host 的稳态私有内存目标 ≤ 350 MiB；长历史浏览目标 ≤ 600 MiB。Mac 与 Windows 分别记录其对应口径。
- 固定工作负载在预热后做等量打开 / 关闭循环；回到相同空闲状态，后半段不得持续随循环数增长。若相对前半段稳态中位数增加超过 10% 或 50 MiB，触发对象 / 进程归因；该阈值是调查触发线，不是“没有泄漏”的证明。
- 空闲后台 CPU 以单逻辑核 100% 为口径，持续平均目标 ≤ 1%；真实同步产生的短时开销单独解释。
- 原生 Agent 的资源不能从总账消失。先测单任务、三任务完整应用组成本，再确定并发预算和可理解的资源提示；不靠隐藏进程或截断用户结果通过指标。

## 7. macOS 与 Windows 必须分别解决的工作

当前 [Rust 入口](../../domains/frontend/desktop/code/turnsu-desktop/src-tauri/src/main.rs)调用 `/usr/bin/open`，默认运行时文件名为 `node`；[打包脚本](../../domains/frontend/desktop/code/turnsu-desktop/scripts/build-macos.sh)只组装 `.app`；[Agent 发现](../../domains/agent/code/local-agent-host/codex.mjs)按无扩展名可执行文件查找。它们证明存在平台工作，不能用“Tauri 支持 Windows”替代。

| 方面 | macOS | Windows |
| --- | --- | --- |
| 导航与输入 | Cmd 快捷键、中文组合输入、系统菜单、VoiceOver | Ctrl 快捷键、中文 IME、Narrator、高对比度 |
| 布局 | 原生标题栏安全区、Retina、多显示器、触控板 | 100/125/150/200% 缩放、多显示器、窗口贴靠与最小宽度 |
| 文件与 Agent | 签名后的路径 / 沙箱行为、Apple Silicon / Intel 包 | 空格与中文路径、盘符、`.exe` / `.cmd` / PATH、默认浏览器授权返回 |
| 生命周期 | 关窗与退出区分、睡眠恢复、子进程退出 | 后台驻留约定、休眠恢复、整个任务进程树退出与孤儿回收 |
| 分发 | 签名、公证、升级与失败回退 | 安装 / 卸载 / 升级、签名、运行时和架构选择 |

若选 Tauri，Windows 的 WebView2 运行时分发是明确的安装决策；在线引导、离线安装和固定版本各有不同成本，不能仅看主程序体积。[官方安装说明](https://v2.tauri.app/distribute/windows-installer/)

## 8. 下一步产物与边界

本轮调研到此可以支撑候选与实验设计，仍不能选出性能赢家或宣布 WorkBuddy 泄漏根因。后续在方案获准进入实验后，交付同 UI / 同 Host 的候选结果表、进程归因、真实双平台操作录像或截图，以及一份明确的保留 / 迁移决策。

当前没有运行该对照实验，没有改桌面底层，没有升级 WorkBuddy，也没有修改 Product 或本地数据职责。
