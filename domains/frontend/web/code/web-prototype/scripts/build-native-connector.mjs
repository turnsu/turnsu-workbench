import { build } from "esbuild";
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(web, "../../../../..");
const native = join(root, "domains/agent/code/agent-runtime/integrations/native");
const scratch = await mkdtemp(join(tmpdir(), "turnsu-connector-build-"));
const output = resolve(process.argv[2] || join(web, "dist/downloads"));
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
try {
  const result = await build({ entryPoints: { turnsu: join(native, "cli.mjs"), "pi-entry": join(native, "pi-entry.mjs") },
    outdir: scratch, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", target: "node22.19", format: "esm",
    sourcemap: false, minify: false, legalComments: "inline", metafile: true,
    banner: { js: 'import { createRequire as __turnsuCreateRequire } from "node:module"; const require = __turnsuCreateRequire(import.meta.url);' } });
  for (const file of Object.values(result.metafile.outputs)) {
    for (const dependency of file.imports) if (dependency.external && !builtins.has(dependency.path)) throw new Error(`connector_external_dependency:${dependency.path}`);
  }
  const thirdParty = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let folder = dirname(resolve(input));
    while (folder.includes("node_modules")) {
      let pkg;
      try { pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8")); } catch {}
      if (pkg?.name) {
        if (!pkg.name.startsWith("@looloomi/") && !thirdParty.has(pkg.name)) {
          const names = (await readdir(folder)).filter((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
          if (!names.length) throw new Error(`connector_license_missing:${pkg.name}`);
          const texts = await Promise.all(names.map((name) => readFile(join(folder, name), "utf8")));
          thirdParty.set(pkg.name, `${pkg.name} ${pkg.version}\n${texts.join("\n")}`);
        }
        break;
      }
      folder = dirname(folder);
    }
  }
  const files = {};
  for (const name of ["turnsu.mjs", "pi-entry.mjs"]) files[name] = new Uint8Array(await readFile(join(scratch, name)));
  files["THIRD_PARTY_NOTICES.txt"] = strToU8([...thirdParty].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text).join("\n\n---\n\n"));
  files["README.txt"] = strToU8(`Turnsu 独立连接器\n\n需要 Node.js 22.19+ 和已安装的 Codex CLI、Claude Code 或 Pi。\n当前面向 macOS/Linux 终端；Windows 尚未验收。无需项目源码，也无需 npm install。\n\n将 turnsu-connector 文件夹放进要工作的项目目录。在该项目终端运行：\nnode ./turnsu-connector/turnsu.mjs start --agent codex --url <你的 Turnsu 网址>\n--agent 可选 codex、claude、pi。首次运行打开终端给出的授权链接，用自己的团队账户批准。\n每次使用同一命令启动；连接只加入本次 Agent 启动，不改写全局配置或读取原生 Agent 凭证。\n\n你可以让 Agent 读取有权限的团队工作、使用已发布方法，或按你的明确要求提交进展。\n授权不等于 Agent 在线；本地模型、文件和工具权限仍由原生 Agent 管理。\n\nTurnsu 凭证保存在用户主目录 ~/.turnsu/connections 内的私有文件中，不保存在项目。\n每个 Agent 独立授权；同一连接不能被两个进程同时使用。\n关闭 Agent 后，可在 Turnsu 设置 → 我的 Agent 中断开连接。断开不会删除已下载文件。\n\n故障：先退出占用该连接的 Agent。连接失效或刷新中断时，在网页撤销旧授权，再用\n--session <新的私有绝对文件路径> 登录；父目录必须已存在且不应是 Git 或共享目录。\n意外退出留下 .lock 文件时，先确认文件中 PID 对应的原 Agent 已退出，再移除该锁；不要删除运行中进程的锁。\n不要复制令牌到聊天、共享目录或配置仓库。\n\nCodex MCP: https://learn.chatgpt.com/docs/extend/mcp?surface=cli\nClaude Code MCP: https://code.claude.com/docs/en/mcp\nPi 扩展按项目固定的 0.85.1 验证。\n`);
  const checksums = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]));
  files["SHA256SUMS.json"] = strToU8(`${JSON.stringify(checksums, null, 2)}\n`);
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`turnsu-connector/${name}`, [bytes, { mtime: new Date("2026-01-01T00:00:00Z") }]])), { level: 6 });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "turnsu-connector.zip"), zip);
  await writeFile(join(output, "turnsu-connector.json"), `${JSON.stringify({ version: "0.1.0", filename: "turnsu-connector.zip", bytes: zip.byteLength, sha256: createHash("sha256").update(zip).digest("hex"), node: ">=22.19.0", platforms: ["macos", "linux"], agents: ["codex", "claude", "pi"] }, null, 2)}\n`);
  console.log(`native_connector_bundle=${zip.byteLength} bytes; dependencies bundled; notices=${thirdParty.size}`);
} finally { await rm(scratch, { recursive: true, force: true }); }
