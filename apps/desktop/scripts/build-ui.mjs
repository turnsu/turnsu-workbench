import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { mkdir, cp, writeFile, readFile, rm } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "package.json"));
const { build } = require("esbuild");
await mkdir(resolve(root, "dist/brand"), { recursive: true });
// Remove the retired fixed-side-form entry from incremental development builds.
for(const name of ["surface.html","surface-host.js"])await rm(resolve(root,"dist",name),{force:true});
await build({ entryPoints: [resolve(root, "src/main.jsx"), resolve(root, "src/surface.jsx")], bundle: true, outdir: resolve(root, "dist"), format: "esm", platform: "browser", minify: true, sourcemap: false, define: { "process.env.NODE_ENV": '"production"' }, metafile: true });
await cp(resolve(root, "public/brand"), resolve(root, "dist/brand"), { recursive: true });
await writeFile(resolve(root, "dist/index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Turnsu 工作台</title><link rel="stylesheet" href="./main.css"></head><body><div id="root"></div><script type="module" src="./main.js"></script></body></html>');
console.log("Turnsu desktop UI built.");

const script = (await readFile(resolve(root, 'dist/surface.js'),'utf8')).replaceAll('</script','<\\/script');
const css = await readFile(resolve(root, 'dist/surface.css'),'utf8');
await writeFile(resolve(root, 'dist/ui-app.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><div id="root"></div><script type="module">'+script+'</script></body></html>');
