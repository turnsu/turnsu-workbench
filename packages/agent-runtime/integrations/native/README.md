# 原生 Agent 团队连接

本模块提供用户主动授权后的团队工具、Skill 安装和受限执行协议。桌面 Host 使用同一接口连接可选 Product 服务；私有原生会话与凭据不进入团队存储。

`cli.mjs` 是原生连接器入口，`login.mjs` 负责浏览器授权与 PKCE，`session.mjs` 负责本机凭据与刷新，`product-tools.mjs` 定义允许的团队工具。`install-skill.mjs` 校验包内容和目标路径；受限 Pi 执行使用独立临时目录及明确限额。

接口与行为变更需验证授权范围、幂等、撤销、重开和失败恢复。运行包内 `npm run test:native-product`；真实供应商和设备验收单独记录在仓库 Wiki。
