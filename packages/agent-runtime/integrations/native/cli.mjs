#!/usr/bin/env node
import { startNativeAgent } from "./start-agent.mjs";
import { assertSupportedNodeVersion } from "../../lib/node-version-gate.mjs";
import { installNativeSkill } from "./install-skill.mjs";
import { parseArgs } from "node:util";
import { loginNativeProduct } from "./login.mjs";
import { openNativeProductSession } from "./session.mjs";
import { serveProductMcp } from "./mcp-server.mjs";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { session: { type: "string" }, url: { type: "string" }, agent: { type: "string" }, project: { type: "string" }, release: { type: "string" }, replace: { type: "string" } } });
  assertSupportedNodeVersion();
  if (positionals[0] === "help" || !positionals.length) {
    process.stdout.write("Turnsu 连接器 · Node 22.19+\n在项目目录运行：node turnsu.mjs start --agent codex|claude|pi --url <Turnsu网址>\n首次运行请打开终端给出的链接，用自己的团队账户批准连接。\n后续运行同一命令即可。可用 --session <私有绝对路径> 创建独立连接。\n关闭 Agent 不会撤销授权；在 Turnsu 设置 → 我的 Agent 中可断开。\n");
  } else if (positionals[0] === "start" && values.agent && values.url) {
    process.exitCode = await startNativeAgent({ agent: values.agent, baseUrl: values.url, cliPath: process.argv[1], sessionPath: values.session,
      onAuthorization: (url) => process.stderr.write(`请在浏览器中打开并批准连接：\n${url}\n`),
      onStatus: (message) => process.stderr.write(message) });
  } else if (positionals[0] === "login" && values.session && values.url) {
    const result = await loginNativeProduct({ baseUrl: values.url, sessionPath: values.session,
      onAuthorization: (url) => { process.stderr.write(`在浏览器中打开并批准这个设备连接：\n${url}\n`); } });
    process.stderr.write(`已连接工作区 ${result.workspaceId}。凭证保存在指定的私有文件中。\n`);
  } else if (positionals[0] === "mcp" && values.session) {
    const { product, release } = await openNativeProductSession(values.session);
    const server = await serveProductMcp(product);
    server.onclose = () => { release().catch(() => {}); };
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); await release(); process.exit(0); });
  } else if (positionals[0] === "install-skill" && values.session && values.agent && values.project && values.release) {
    const session = await openNativeProductSession(values.session);
    try {
      const receipt = await installNativeSkill({ product: session.product, releaseId: values.release,
        agent: values.agent, projectDirectory: values.project, replaceReleaseId: values.replace });
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
      process.stderr.write("技能已保存在指定项目。请在原生 Agent 中选择该技能；安装成功不代表已完成原生执行验证。\n");
    } finally { await session.release(); }
  } else if (positionals[0] === "logout" && values.session) {
    const session = await openNativeProductSession(values.session);
    try { await session.revoke(); process.stderr.write("此原生客户端的 Turnsu 连接已撤销。\n"); }
    finally { await session.release(); }
  } else throw new Error("Usage: cli.mjs login --url <https-origin> --session <absolute-private-file> | mcp|logout --session <absolute-private-file> | install-skill --session <file> --agent codex|claude|pi --project <absolute-directory> --release <release-id> [--replace <current-release-id>]");
} catch (error) {
  const code = error.code || error.message;
  const messages = {
    unsupported_node_version: "请先安装 Node.js 22.19 或更新版本。",
    native_session_in_use_login_separately_for_each_client: "这个连接正由另一个 Agent 使用。先关闭它，或用 --session 指定另一个私有文件登录。",
    native_session_stale_lock_check_owner_before_removal: "上次运行意外结束。请先确认原 Agent 已退出，再按连接器 README 的恢复说明处理锁文件。",
    native_session_reconnect_required: "连接需要重新授权。请在 Turnsu 设置中断开旧连接，再用 --session 指定新的私有文件重新登录。",
    native_connection_private_directory_required: "凭证目录不是当前用户独占的普通目录。请检查 ~/.turnsu 权限，不要使用共享目录或符号链接。",
    native_session_origin_mismatch: "这个凭证文件属于另一个 Turnsu 地址。请使用对应地址，或选择新的私有凭证文件。",
    ERR_PARSE_ARGS_UNKNOWN_OPTION: "无法识别参数。运行 node turnsu.mjs help 查看用法。",
  };
  process.stderr.write(`${messages[code] || (String(code).startsWith("native_agent_not_installed:") ? "没有找到所选 Agent，或它不能启动。请先确认对应 CLI 已安装且能正常运行。" : code)}\n`);
  process.exitCode = 1;
}
