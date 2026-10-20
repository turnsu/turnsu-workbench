import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { mkdir, cp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "package.json"));
const { build } = require("esbuild");
export const workerPlugin = {
  name: 'turnsu-inline-map-worker',
  setup(builder) {
    builder.onResolve({ filter: /\?turnsu-worker$/ }, args => ({ path: args.path.replace(/\?turnsu-worker$/, ''), namespace: 'turnsu-worker' }));
    builder.onLoad({ filter: /.*/, namespace: 'turnsu-worker' }, async args => {
      const result = await build({ entryPoints: [require.resolve(args.path)], bundle: true, platform: 'browser', format: 'iife', minify: true, write: false });
      // Module workers created from blob:null fail in opaque App frames.
      // A self-contained data module keeps the frame opaque and needs no URL
      // endpoint or permission to read its parent document.
      return { contents: 'export default ' + JSON.stringify('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')), loader: 'js' };
    });
  },
};
export async function buildUi() {
await mkdir(resolve(root, "dist/brand"), { recursive: true });
// Remove the retired fixed-side-form entry from incremental development builds.
for(const name of ["surface.html","surface-host.js"])await rm(resolve(root,"dist",name),{force:true});
const uiBuild = await build({ entryPoints: [resolve(root, "src/main.jsx"), resolve(root, "src/surface.jsx")], bundle: true, outdir: resolve(root, "dist"), format: "esm", platform: "browser", jsx: "automatic", plugins: [workerPlugin], minify: true, sourcemap: false, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, assetNames: 'fonts/[name]-[hash]', define: { "process.env.NODE_ENV": '"production"' }, metafile: true });
const fontLicenses = ['OFL-noto-sans-sc.txt', 'OFL-Inter.txt', 'OFL-IBM-Plex-Mono.txt'];
const currentOutputs = new Set(Object.keys(uiBuild.metafile.outputs).map(path => resolve(path)));
// Incremental builds must not ship retired font families or older hashed files.
for (const file of await readdir(resolve(root, 'dist/fonts'), { withFileTypes: true })) {
  const path = resolve(root, 'dist/fonts', file.name);
  if (file.isFile() && !currentOutputs.has(path) && !fontLicenses.includes(file.name)) await rm(path);
}
for (const name of fontLicenses) await cp(resolve(root, 'src/shared/fonts', name), resolve(root, 'dist/fonts', name));
await rm(resolve(root, 'dist/licenses'), { recursive: true, force: true });
await cp(resolve(root, "licenses"), resolve(root, "dist/licenses"), { recursive: true });
await mkdir(resolve(root, 'dist/licenses/fonts'), { recursive: true });
for (const name of fontLicenses) await cp(resolve(root, 'src/shared/fonts', name), resolve(root, 'dist/licenses/fonts', name));
await cp(resolve(root, "public/brand"), resolve(root, "dist/brand"), { recursive: true });
await writeFile(resolve(root, "dist/index.html"), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Turnsu 工作台</title><link rel="stylesheet" href="./main.css"></head><body><div id="root"></div><script type="module" src="./main.js"></script></body></html>');
console.log("Turnsu desktop UI built.");

const script = (await readFile(resolve(root, 'dist/surface.js'),'utf8')).replaceAll('</script','<\\/script');
let css = await readFile(resolve(root, 'dist/surface.css'),'utf8');
// UI and math fonts travel with both isolated Apps. The native App
// retains packaged CJK subsets; external hosts use their system CJK fallback.
for (const rule of css.match(/@font-face\s*\{[^}]*\}/g) || []) {
  if (!/KaTeX|font-family:["']?(?:Inter|IBM Plex Mono)/i.test(rule)) continue;
  const match = rule.match(/url\((?:["'])?([^)'" ]+\.(woff2|ttf))(?:["'])?\)/);
  if (!match) throw new Error('Missing self-contained App font: ' + rule.slice(0, 160));
  const bytes = await readFile(resolve(root, 'dist', match[1]));
  const kind = match[2], format = kind === 'ttf' ? 'truetype' : 'woff2';
  const rewritten = rule.replace(/src:[^;}]+/, 'src:url(data:font/' + kind + ';base64,' + bytes.toString('base64') + ') format("' + format + '")');
  css = css.replace(rule, rewritten);
}
await writeFile(resolve(root, 'dist/ui-app.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><div id="root"></div><script type="module">'+script+'</script></body></html>');
const catalogOptions = {
  tools: [{ name: 'task_data', description: 'Read an existing key of document.data by its exact name. Returns {value: JSON}. This is NOT a file reader. Arguments: {name: string}.' }],
  additionalRules: ['Read source files with your authorized file tools, then put verified rows in document.data (for example $rows) and bind ReviewTable($rows, columns). Prefer direct bindings; Query is unnecessary for already available data. Never pass a filename to task_data unless it is an actual document.data key.',
    'Save local state; only a human @ToAssistant action confirms execution. TaskFiles may only open paths already returned in the task assets or results; a file read by the Agent is not automatically an attached material. Use a source label for other verified files.',
    'Host actions must be standalone: never combine ToAssistant, ImportFiles, ContinueTask, OpenUrl or CopyToClipboard with another step in Action([...]). Such plans are rejected before any step executes. Let the person adjust or import, review the updated page, then confirm with a separate button. Multiple local Set/Reset steps are supported.',
    'Images and route lookups use declared public providers through the current task; report failures rather than inventing media.',
    'Only Query("task_data",{name:...},{value:null}) is available. Mutation, @Run and arbitrary tool names are unavailable. Report missing data; never fabricate mock data or execute business operations from a component.'],
};
const catalogBuild = await build({ stdin: { contents: `import {library} from ${JSON.stringify(resolve(root, 'src/intelligence-ui/upstream/library.ts'))}; export default {schema:library.toJSONSchema(),prompt:library.prompt({tools:${JSON.stringify(catalogOptions.tools)},bindings:true,preamble:'You are the original host Agent. Use the task-owned Turnsu OpenUI library; no second model or conversation.',additionalRules:${JSON.stringify(catalogOptions.additionalRules)}})};`, resolveDir: root }, platform:'node', format:'esm', jsx:'automatic', bundle:true, write:false, plugins:[workerPlugin], loader:{'.css':'empty'}, define:{'process.env.NODE_ENV':'"production"'}, banner:{js:'import { createRequire } from "node:module";const require=createRequire(' + JSON.stringify(resolve(root, 'package.json')) + ');'} });
const catalog = (await import('data:text/javascript;base64,' + Buffer.from(catalogBuild.outputFiles[0].text).toString('base64'))).default;
await writeFile(resolve(root, 'dist/openui-library.json'), JSON.stringify(catalog.schema));
await writeFile(resolve(root, 'dist/openui-library.md'), '# Turnsu OpenUI component and function reference\n\nSource: https://github.com/thesysdev/open-intelligent-ui/tree/03213439358bf3408ad61a46ec9e3230c5572e48 (MIT).\n\n' + catalog.prompt);
const packages = new Set();
for (const input of Object.keys(uiBuild.metafile.inputs)) {
  const match = input.replaceAll('\\', '/').match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.add(resolve(match[1]));
}
const inventory = [];
for (const path of packages) {
  const pkg = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8'));
  const folder = resolve(root, 'dist/licenses', (pkg.name + '-' + pkg.version).replace(/[^a-zA-Z0-9._-]/g, '_'));
  await mkdir(folder, { recursive: true });
  for (const file of await readdir(path, { withFileTypes: true })) if (file.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(file.name)) await cp(resolve(path, file.name), resolve(folder, file.name));
  inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license || null });
}
await cp(resolve(root, 'src/intelligence-ui/upstream/PROVENANCE.json'), resolve(root, 'dist/licenses/open-intelligent-ui-PROVENANCE.json'));
await writeFile(resolve(root, 'dist/licenses/ui-packages.json'), JSON.stringify(inventory, null, 2));

}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) await buildUi();
