import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const distDir = path.join(rootDir, "dist");
const indexPath = path.join(distDir, "index.html");
const offlinePath = path.join(distDir, "loopops-admin-offline.html");

function fail(message) {
  throw new Error(message);
}

function readDist(relativePath) {
  return fs.readFileSync(path.join(distDir, relativePath), "utf8");
}

if (!fs.existsSync(indexPath)) {
  fail("dist/index.html is missing; run npm run build before exporting offline review");
}

const builtIndexHTML = fs.readFileSync(indexPath, "utf8");
let html = builtIndexHTML;

const cssMatch = html.match(/<link\s+rel="stylesheet"[^>]*href="(?:\.\/|\/)([^"]+\.css)"[^>]*>/);
const jsMatch = html.match(/<script\s+type="module"[^>]*src="(?:\.\/|\/)([^"]+\.js)"[^>]*><\/script>/);

if (!cssMatch) fail("built index is missing a stylesheet asset link");
if (!jsMatch) fail("built index is missing a module script asset link");

const cssAssetPath = cssMatch[1];
const jsAssetPath = jsMatch[1];
const css = readDist(cssAssetPath).replace(/<\/style/gi, "<\\/style");
const js = readDist(jsAssetPath).replace(/<\/script/gi, "<\\/script");

const title = builtIndexHTML.match(/<title>(.*?)<\/title>/)?.[1] ?? "LoopOps Admin";
html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style data-loopops-offline-asset="${cssAssetPath}">
${css}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" data-loopops-offline-asset="${jsAssetPath}">
${js}
    </script>
  </body>
</html>
`;

const htmlShell = html
  .replace(/<script type="module" data-loopops-offline-asset="[^"]+">[\s\S]*?<\/script>/, "<script data-loopops-inlined></script>")
  .replace(/<style data-loopops-offline-asset="[^"]+">[\s\S]*?<\/style>/, "<style data-loopops-inlined></style>");
if (/<(?:script|link)[^>]+(?:src|href)="(?:\.\/|\/)assets\//.test(htmlShell)) {
  fail("offline review export still references external built assets");
}

fs.writeFileSync(offlinePath, html);

const stats = fs.statSync(offlinePath);
const relativeOfflinePath = path.relative(rootDir, offlinePath);

console.log("web_visual_preview_export=ready");
console.log("web_visual_preview_scope=visual-only");
console.log("web_visual_preview_functional_evidence=false");
console.log(`web_visual_preview_path=${offlinePath}`);
console.log(`web_visual_preview_relative_path=${relativeOfflinePath}`);
console.log(`web_visual_preview_bytes=${stats.size}`);
console.log(`web_visual_preview_css=${cssAssetPath}`);
console.log(`web_visual_preview_js=${jsAssetPath}`);
