import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdir, cp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = resolve(root, '../../packages/agent-host');
const out = resolve(process.argv[2]);
const require = createRequire(resolve(root, 'package.json'));
await mkdir(out, { recursive: true });
const result = await require('esbuild').build({ entryPoints: { entry: resolve(host, 'entry.mjs'), 'desktop-entry': resolve(host, 'desktop-entry.mjs'), 'model-connections': resolve(host, 'model-connections.mjs') }, outdir: out, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]', splitting: true, bundle: true, platform: 'node', target: 'node22', format: 'esm', minify: true, write: false, metafile: true,
  banner: { js: 'import { createRequire as turnsuRequire } from "node:module"; const require = turnsuRequire(import.meta.url);' } });
// The desktop may consume public contracts; Product services and PostgreSQL stay in the cloud build.
const forbidden = Object.keys(result.metafile.inputs).filter(path => /(?:^|\/)services\/|(?:^|\/)node_modules\/(?:pg|pg-pool|postgres)\//.test(path.replaceAll('\\', '/')));
if (forbidden.length) throw new Error('desktop_cloud_dependency_boundary: ' + forbidden.join(', '));
// This directory contains only generated chunks; discard superseded SDK copies after a successful
// compile so rebuilding an app never ships stale provider code beside the current entry.
await rm(resolve(out, 'chunks'), { recursive: true, force: true });
for (const file of result.outputFiles) { await mkdir(dirname(file.path), { recursive: true }); await writeFile(file.path, file.contents); }
const notices = resolve(out, 'notices'); await mkdir(notices, { recursive: true });
await cp(resolve(host, 'node_modules/@anthropic-ai/claude-agent-sdk/README.md'), resolve(notices, 'claude-agent-sdk-README.md'));
// pi's published packages omit the monorepo LICENSE; preserve the exact upstream v0.85.1 notice.
await cp(resolve(root, 'notices/pi-0.85.1-LICENSE'), resolve(notices, 'pi-0.85.1-LICENSE'));
const packages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.replaceAll('\\', '/').match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.add(resolve(match[1]));
}
const inventory = [];
for (const path of packages) {
  const pkg = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8'));
  const folder = resolve(notices, (pkg.name + '-' + pkg.version).replace(/[^a-zA-Z0-9._-]/g, '_'));
  const files = (await readdir(path, { withFileTypes: true })).filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice)(\.|$)/i.test(entry.name));
  if (files.length) { await mkdir(folder, { recursive: true }); for (const file of files) await cp(resolve(path, file.name), resolve(folder, file.name)); }
  inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license || null });
}
await writeFile(resolve(notices, 'bundled-packages.json'), JSON.stringify(inventory, null, 2));
console.log('Turnsu local host bundled; the isolated Pi SDK loads on demand. User CLIs remain external.');

await cp(resolve(host, 'pi-gateway-extension.mjs'), resolve(out, 'pi-gateway-extension.mjs'));
await cp(resolve(host, 'pi-gateway-extension.mjs'), resolve(out, 'chunks/pi-gateway-extension.mjs'));
