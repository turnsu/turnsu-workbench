# Root Cause

Status: `reference`

## Summary

上一轮没有失败在“功能完全没做”，而是失败在把产品质量错误地翻译成了工程可观测性。代码证明了很多状态流存在，但没有证明一个高频用户愿意长期使用这个界面。

## What Went Wrong

1. 验收对象错了。
   旧文档把 `swift test`、`npm run smoke`、`data-testid`、状态机、计数和非空截图当作完成依据。这些只能证明结构存在，不能证明层级、密度、操作优先级和交互反馈是对的。

2. UI 被后端能力牵着走。
   Loop、Skill、Tool Log、Knowledge、Run Result 都被放到了前台，但很多地方像能力清单，而不是用户任务流。结果是功能可见，意图不清。

3. 信息架构没有先收敛。
   Workbench、Library、Skill OS、Studio、Knowledge、Chat 同时堆出很多对象。每个对象都有 row、card、panel、toast、chat，但主次关系没有统一规则。

4. 视觉语言不够产品化。
   旧版大量使用面板和卡片承载每个功能点，导致“卡片套卡片”、状态 chip 过多、列表密度不稳定。Notion database 和 Apple productivity 的克制感没有落到组件规则里。

5. 文案混合与状态命名削弱信任。
   英文产品标签、中文任务描述、内部状态词和技术性语句混在一起。用户要判断按钮到底是运行、安装、编辑、复制还是打开日志。

6. QA 激励方向偏了。
   旧 QA 鼓励新增 anchor、字段、pass line 和截图数量。它自然会推动继续堆功能，而不是减少噪音、调整层级、压缩控件、重写空态和打磨 modal/toast/log/chat。

## Evidence From Current Files

- `final-audit.md` 多次使用 `testids=177`、`action_summary_count=53`、`nonblank captures=6`、`nativeAppKitClicksVerified=false` 作为状态证据，同时仍标记 visual/product QA 为 partial。
- `LoopOpsNativeActivationHarness.swift` 明确验证的是 in-process activation、state-backed evidence 和 no system permissions，不验证像素级点击、视觉质量或用户理解。
- `LoopOpsNativeVisualHarness.swift` 的截图验收条件是文件大小和 sampled color count，不能证明布局好坏。
- `web-prototype/scripts/smoke.mjs` 大量检查字符串和 `data-testid` anchor，只能证明元素存在。
- 旧模块文档的 `Still Not Done` 多次提到 visual polish、screenshot-level visual QA、cleaner layout 和 AppKit click proof。

## Corrective Direction

本轮把顺序改回产品设计链路：

1. 目标稿先行。
2. 每个模块独立定义 IA、用户路径、状态表和验收标准。
3. 人工 review 目标稿。
4. 目标稿被认可后，才重构 Web prototype。
5. Web 设计被认可后，再同步 native。
6. 旧 harness 只做 regression，不做产品完成依据。

## Completion Boundary

如果目标稿仍像旧 demo，必须停止工程实现，回到视觉系统和目标稿。不能通过新增测试、状态字段、非空截图或 pass 日志来绕过这个判断。
