# 隔离浏览器运行环境

Cua Driver 固定为 0.30.4，下载时校验官方发行包 SHA-256；基础镜像固定 digest，Chromium 固定 Debian 包版本。软件源不再提供该版本时构建失败，由维护者升级并重新验收，不自动漂移版本。

`seccomp.json` 基于 [Moby profiles 6fe7deb](https://github.com/moby/profiles/tree/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp)，许可证见 `LICENSE.moby`。额外允许 `clone`、`setns`、`unshare`、`chroot`，供非 root Chromium 在容器内建立用户命名空间和自身沙盒；`clone3` 沿用 ENOSYS 回退。容器仍使用 `cap-drop=ALL`、`no-new-privileges`、只读根文件系统和资源限额。不能使用 `--no-sandbox`、特权容器或宿主 Docker socket 替代此策略。

版本调整后运行 `test/verify-computer-docker.mjs`，验证真实页面读取、越界拒绝和停止回收。此测试不能替代本机应用或 macOS/Windows 可见交互验收。
