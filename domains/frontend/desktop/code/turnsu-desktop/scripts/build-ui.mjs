import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { mkdir, cp, writeFile } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The checkout already owns these exact React/Markdown/icon dependencies. No second frontend
// application is loaded; this builds a small local desktop entry with its own lifecycle.
const web = resolve(root, "../../../web/code/web-prototype");
let require;
try { require = createRequire(resolve(root, "package.json")); require.resolve("esbuild"); }
catch { require = createRequire(resolve(web, "package.json")); }
const { build } = require("esbuild");
await mkdir(resolve(root, "dist/brand"), { recursive: true });
await build({ entryPoints: [resolve(root, "src/main.jsx")], bundle: true, outdir: resolve(root, "dist"), format: "esm", platform: "browser", minify: true, sourcemap: false, nodePaths: [resolve(web, "node_modules")], define: { "process.env.NODE_ENV": '"production"' }, metafile: true });
await cp(resolve(web, "public/brand/turnsu"), resolve(root, "dist/brand"), { recursive: true });
await writeFile(resolve(root, "dist/index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Turnsu</title><link rel="stylesheet" href="./main.css"></head><body><div id="root"></div><script type="module" src="./main.js"></script></body></html>');
console.log("Turnsu desktop UI built.");
