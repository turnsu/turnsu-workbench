import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  BUILD_IDENTITY_SCHEMA,
  computeDistIdentity,
  computeSourceIdentity,
} from "./build-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const manifestPath = path.join(dist, ".vite", "manifest.json");
const buildIdentityPath = path.join(dist, "build-identity.json");

assert.ok(fs.existsSync(manifestPath), "Run the production build before bundle:audit.");
assert.ok(fs.existsSync(buildIdentityPath), "The production build identity is missing; run npm run build.");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const buildIdentity = JSON.parse(fs.readFileSync(buildIdentityPath, "utf8"));
assert.equal(buildIdentity.schemaVersion, BUILD_IDENTITY_SCHEMA, "Unexpected build identity schema.");
assert.equal(
  buildIdentity.sourceIdentity,
  computeSourceIdentity(root),
  "The dist directory is stale relative to current frontend source.",
);
assert.equal(
  buildIdentity.buildIdentity,
  computeDistIdentity(dist),
  "The dist assets do not match their build identity.",
);
const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
const routeKeys = [
  "src/features/agent/AgentRoute.jsx",
  "src/features/work/WorkRoute.jsx",
  "src/features/skills/SkillsRoute.jsx",
  "src/features/loops/LoopsRoute.jsx",
  "src/features/builder/BuilderRoute.jsx",
  "src/features/runs/RunsRoute.jsx",
  "src/features/library/LibraryRoute.jsx",
  "src/features/members/MembersRoute.jsx",
  "src/features/automations/AutomationsRoute.jsx",
  "src/features/not-found/NotFoundRoute.jsx",
];
const modelClientKey = Object.keys(manifest).find((key) => (
  key.endsWith("/product-client/dist/model.js")
));

assert.equal(entryKey, "index.html", "The product entry changed unexpectedly.");
assert.ok(modelClientKey, "The Model ProductClient lazy boundary is missing.");
const entryDynamicImports = new Set(manifest[entryKey].dynamicImports);
for (const key of routeKeys) {
  assert.ok(entryDynamicImports.has(key), `${key} is not a direct lazy route boundary.`);
}
const authorizationKeys = [
  "src/components/auth/InvitationAcceptScreen.jsx",
  "src/components/auth/NativeAuthorizationScreen.jsx",
];
for (const key of authorizationKeys) {
  assert.ok(entryDynamicImports.has(key), `${key} is not an on-demand authorization screen.`);
}
assert.deepEqual(
  [...entryDynamicImports].filter((key) => !routeKeys.includes(key) && !authorizationKeys.includes(key)),
  [modelClientKey],
  "Only the governed Model ProductClient and authorization screens may be extra entry-level lazy boundaries.",
);
for (const key of routeKeys) {
  assert.equal(manifest[key]?.isDynamicEntry, true, `${key} is not a dynamic route entry.`);
}

function bytesFor(file) {
  const content = fs.readFileSync(path.join(dist, file));
  return {
    file,
    raw: content.byteLength,
    gzip: gzipSync(content, { level: 9 }).byteLength,
    brotli: brotliCompressSync(content).byteLength,
  };
}

function staticClosure(keys) {
  const visited = new Set();
  const visit = (key) => {
    if (!key || visited.has(key)) return;
    visited.add(key);
    for (const dependency of manifest[key]?.imports || []) visit(dependency);
  };
  for (const key of keys) visit(key);
  return visited;
}

function assetsFor(keys) {
  const files = new Set();
  for (const key of keys) {
    const entry = manifest[key];
    if (!entry) continue;
    if (entry.file) files.add(entry.file);
    for (const css of entry.css || []) files.add(css);
  }
  return [...files].map(bytesFor);
}

function totals(assets) {
  return assets.reduce(
    (total, asset) => ({
      raw: total.raw + asset.raw,
      gzip: total.gzip + asset.gzip,
      brotli: total.brotli + asset.brotli,
    }),
    { raw: 0, gzip: 0, brotli: 0 },
  );
}

const entryAsset = bytesFor(manifest[entryKey].file);
assert.ok(entryAsset.raw <= 450_000, `Main entry exceeds 450 kB raw: ${entryAsset.raw}.`);
assert.ok(entryAsset.gzip <= 150_000, `Main entry exceeds 150 kB gzip: ${entryAsset.gzip}.`);

const routeMetrics = Object.fromEntries(routeKeys.map((key) => {
  const metric = bytesFor(manifest[key].file);
  assert.ok(metric.raw <= 250_000, `${key} exceeds 250 kB raw: ${metric.raw}.`);
  assert.ok(metric.gzip <= 80_000, `${key} exceeds 80 kB gzip: ${metric.gzip}.`);
  const css = (manifest[key].css || []).map(bytesFor);
  for (const asset of css) {
    assert.ok(asset.raw <= 250_000, `${key} CSS exceeds 250 kB raw: ${asset.raw}.`);
    assert.ok(asset.gzip <= 80_000, `${key} CSS exceeds 80 kB gzip: ${asset.gzip}.`);
  }
  return [key, { ...metric, css }];
}));

const agentClosure = staticClosure([entryKey, "src/features/agent/AgentRoute.jsx"]);
for (const forbidden of routeKeys.filter((key) => !key.includes("/agent/"))) {
  assert.ok(!agentClosure.has(forbidden), `Agent initial closure contains ${forbidden}.`);
}

const flowgramKey = "node_modules/@flowgram.ai/editor/dist/esm/index.js";
const fflateKey = "node_modules/fflate/esm/browser.js";
assert.deepEqual(
  manifest["src/features/builder/BuilderRoute.jsx"].dynamicImports,
  [flowgramKey],
  "Flowgram must stay behind the Builder route.",
);
assert.deepEqual(
  manifest["src/features/skills/SkillsRoute.jsx"].dynamicImports,
  [fflateKey],
  "fflate must stay behind the Skills ZIP-import path.",
);
assert.ok(!agentClosure.has(flowgramKey), "Agent initial closure contains Flowgram.");
assert.ok(!agentClosure.has(fflateKey), "Agent initial closure contains fflate.");
assert.ok(!agentClosure.has(modelClientKey), "Agent initial closure eagerly contains the Model ProductClient.");
for (const feature of ["skills", "loops", "builder", "runs", "library", "automations", "work"]) {
  const routeKey = `src/features/${feature}/${feature[0].toUpperCase()}${feature.slice(1)}Route.jsx`;
  const route = manifest[routeKey];
  assert.equal(route?.css?.length, 1, `${feature} must own one route-scoped CSS asset.`);
  const css = fs.readFileSync(path.join(dist, route.css[0]), "utf8");
  assert.ok(
    css.includes(`.shell.feature-${feature}`),
    `${feature} CSS is missing its shell scope.`,
  );
  assert.ok(
    !/(^|})\.shell(?:\{|,)/.test(css),
    `${feature} CSS contains an unscoped shell rule.`,
  );
}

const javascriptAssets = fs.readdirSync(path.join(dist, "assets"))
  .filter((file) => file.endsWith(".js"))
  .map((file) => bytesFor(`assets/${file}`));
const over500k = javascriptAssets.filter((asset) => asset.raw > 500_000);
assert.deepEqual(
  over500k.map((asset) => asset.file),
  [manifest[flowgramKey].file],
  "Only the deferred Flowgram vendor may exceed 500 kB raw.",
);

const entryAssets = assetsFor(staticClosure([entryKey]));
const agentAssets = assetsFor(agentClosure);
// Keep the full Agent closure observable, while gating the boundaries we can
// act on: entry size, route ownership, and deferred heavyweight vendors.
// Astryx currently ships one shared, highly-compressible CSS artifact; treating
// its raw bytes as product JavaScript regression would make this gate misleading.
const agentInitialTotals = totals(agentAssets);
const report = {
  schemaVersion: 1,
  result: "pass",
  sourceIdentity: buildIdentity.sourceIdentity,
  buildIdentity: buildIdentity.buildIdentity,
  entry: entryAsset,
  entryInitial: {
    ...totals(entryAssets),
    files: entryAssets.map((asset) => asset.file).sort(),
  },
  agentInitial: {
    ...agentInitialTotals,
    files: agentAssets.map((asset) => asset.file).sort(),
  },
  routes: routeMetrics,
  deferredVendors: {
    flowgram: bytesFor(manifest[flowgramKey].file),
    fflate: bytesFor(manifest[fflateKey].file),
  },
  deferredProductClients: {
    model: bytesFor(manifest[modelClientKey].file),
  },
  over500k: over500k.map((asset) => asset.file),
};

console.log(JSON.stringify(report, null, 2));
