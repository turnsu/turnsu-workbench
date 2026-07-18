import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  authenticatedMongoUri,
  buildDaemonEnvironment,
  ensureLocalDirectories,
  localPaths,
  materializeMongoSecrets,
  readLocalConfig,
  writeLocalConfig,
} from "../../../../operations/local/local-runtime.mjs";
import { LOCAL_SECRET_ACCOUNTS, modelCredentialAccount } from "../../../../operations/local/keychain.mjs";
import { buildReleaseManifest } from "../../../../operations/local/release-manager.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;

function secretKeychain() {
  const values = new Map([
    [LOCAL_SECRET_ACCOUNTS.mongoUsername, "workbench_admin"],
    [LOCAL_SECRET_ACCOUNTS.mongoPassword, "p".repeat(48)],
    [LOCAL_SECRET_ACCOUNTS.mongoReplicaKey, Buffer.alloc(32, 1).toString("base64")],
    [LOCAL_SECRET_ACCOUNTS.modelApiKey, "host-model-secret"],
    [modelCredentialAccount("deepseek-main"), "host-deepseek-secret"],
  ]);
  return { async read(account) { return values.get(account); } };
}

test("local runtime materializes only Mongo container secrets with owner-only permissions", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-local-runtime-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = localPaths(root);
  await ensureLocalDirectories(paths);
  const mongo = await materializeMongoSecrets(paths, { keychain: secretKeychain() });
  assert.equal(mongo.username, "workbench_admin");
  for (const name of ["mongo-root-username", "mongo-root-password", "mongo-replica-key"]) {
    const info = await stat(`${paths.secrets}/${name}`);
    assert.equal(info.mode & 0o077, 0);
  }
  assert.equal(await readFile(`${paths.secrets}/mongo-root-password`, "utf8"), `${"p".repeat(48)}\n`);
  assert.equal((await readFile(`${paths.secrets}/mongo-replica-key`, "utf8")).includes("host-model-secret"), false);
});

test("daemon configuration is validated, contains no persisted API key, and builds an authenticated host environment", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-local-config-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = localPaths(root);
  const config = await writeLocalConfig({
    modelCatalogImport: {
      schemaVersion: "model-catalog-import-v1",
      profiles: [{
        profileId: "deepseek-default",
        displayName: "DeepSeek",
        scope: "global",
        enabled: true,
        provider: "deepseek",
        protocol: "openai_compatible_chat",
        providerModelId: "deepseek-chat",
        capabilities: ["chat", "tool_calling", "structured_output"],
        parameterSchemaVersion: "model-parameters-v1",
        defaults: {},
        limits: {},
        credentialRef: "deepseek-main",
        endpoint: "https://api.deepseek.com",
        policyVersion: "1",
      }],
      routingPolicies: [{
        workspaceId: "workspace-local",
        defaultProfileIdsByCapability: { chat: "deepseek-default" },
        workflowFallbackAllowed: false,
      }],
    },
    agentImage: DIGEST,
    skillImage: `repository/skill@${DIGEST}`,
    port: 8798,
    database: "looloomi_workbench",
    logLevel: "info",
  }, paths);
  assert.equal(config.schemaVersion, "looloomi-local-config-v3");
  assert.deepEqual(await readLocalConfig(paths), config);
  assert.equal((await readFile(paths.config, "utf8")).includes("host-model-secret"), false);

  const env = await buildDaemonEnvironment({ paths, baseEnv: { PATH: "/usr/bin:/bin" }, keychain: secretKeychain() });
  assert.equal(env.WORKBENCH_LOCAL_PRODUCTION, "1");
  assert.equal(JSON.parse(env.WORKBENCH_MODEL_CATALOG_IMPORT_JSON).profiles[0].provider, "deepseek");
  assert.deepEqual(JSON.parse(env.WORKBENCH_MODEL_ROUTING_REQUIREMENTS_JSON), [{
    workspaceId: "workspace-local",
    capabilities: ["chat"],
  }]);
  assert.equal(env.WORKBENCH_MODEL_CREDENTIAL_STORE, "macos-keychain");
  assert.equal(Object.hasOwn(env, "WORKBENCH_MODEL_CREDENTIALS_JSON"), false);
  assert.equal(Object.hasOwn(env, "WORKBENCH_MODEL_API_KEY"), false);
  assert.match(env.WORKBENCH_MONGODB_URI, /^mongodb:\/\/workbench_admin:p{48}@127\.0\.0\.1:27017\//);
  assert.equal(env.WORKBENCH_AGENT_IMAGE, DIGEST);
});

test("legacy local model configuration migrates to one V3 catalog import", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-local-config-v1-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = localPaths(root);
  const config = await writeLocalConfig({
    schemaVersion: "looloomi-local-config-v1",
    modelBaseUrl: "https://legacy.example/v1",
    model: "legacy/model",
    agentImage: DIGEST,
    skillImage: `repository/skill@${DIGEST}`,
    port: 8798,
    database: "looloomi_workbench",
    logLevel: "info",
  }, paths);
  assert.equal(config.schemaVersion, "looloomi-local-config-v3");
  assert.equal(config.modelCatalogImport.profiles[0].profileId, "legacy-default");
  assert.equal(config.modelCatalogImport.profiles[0].protocol, "openai_compatible_chat");
  assert.equal(config.modelCatalogImport.profiles[0].credentialRef, "legacy-default");
});

test("local catalog import rejects unsupported Stability model IDs and capability-default mismatch", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-local-invalid-model-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = localPaths(root);
  const base = {
    agentImage: DIGEST,
    skillImage: `repository/skill@${DIGEST}`,
    port: 8798,
    database: "looloomi_workbench",
    logLevel: "info",
  };
  const stability = {
    profileId: "stability-image",
    displayName: "Stability Core",
    scope: "global",
    enabled: true,
    provider: "stability",
    protocol: "stability_image_v2",
    providerModelId: "stable-image-ultra",
    capabilities: ["image_generation"],
    parameterSchemaVersion: "model-parameters-v1",
    defaults: {},
    limits: {},
    credentialRef: "stability-main",
    endpoint: "https://api.stability.ai",
    policyVersion: "1",
  };
  await assert.rejects(writeLocalConfig({
    ...base,
    modelCatalogImport: {
      schemaVersion: "model-catalog-import-v1",
      profiles: [stability],
      routingPolicies: [{
        workspaceId: "workspace-local",
        defaultProfileIdsByCapability: { image_generation: stability.profileId },
        workflowFallbackAllowed: false,
      }],
    },
  }, paths), { code: "local_config_invalid" });

  const validCore = await writeLocalConfig({
    ...base,
    modelCatalogImport: {
      schemaVersion: "model-catalog-import-v1",
      profiles: [{
        ...stability,
        providerModelId: "stable-image-core",
        defaults: { aspectRatio: "21:9", seed: 4_294_967_294 },
      }],
      routingPolicies: [{
        workspaceId: "workspace-local",
        defaultProfileIdsByCapability: { image_generation: stability.profileId },
        workflowFallbackAllowed: false,
      }],
    },
  }, paths);
  assert.equal(validCore.modelCatalogImport.profiles[0].limits.maxCostUsdMicros, 30_000);
  assert.ok(validCore.modelCatalogImport.profiles[0].parameterSupport.aspectRatios.includes("9:21"));

  await assert.rejects(writeLocalConfig({
    ...base,
    modelCatalogImport: {
      schemaVersion: "model-catalog-import-v1",
      profiles: [{
        ...stability,
        providerModelId: "stable-image-core",
        defaults: { seed: 4_294_967_295 },
      }],
      routingPolicies: [{
        workspaceId: "workspace-local",
        defaultProfileIdsByCapability: { image_generation: stability.profileId },
        workflowFallbackAllowed: false,
      }],
    },
  }, paths), { code: "local_config_invalid" });

  await assert.rejects(writeLocalConfig({
    ...base,
    modelCatalogImport: {
      schemaVersion: "model-catalog-import-v1",
      profiles: [{
        ...stability,
        providerModelId: "stable-image-core",
        defaults: { nested: { apiKey: "must-never-enter-the-catalog" } },
      }],
      routingPolicies: [{
        workspaceId: "workspace-local",
        defaultProfileIdsByCapability: { image_generation: stability.profileId },
        workflowFallbackAllowed: false,
      }],
    },
  }, paths), { code: "local_config_invalid" });

  await assert.rejects(writeLocalConfig({
    ...base,
    modelCatalogImport: {
      schemaVersion: "model-catalog-import-v1",
      profiles: [{ ...stability, providerModelId: "stable-image-core" }],
      routingPolicies: [{
        workspaceId: "workspace-local",
        defaultProfileIdsByCapability: { chat: stability.profileId },
        workflowFallbackAllowed: false,
      }],
    },
  }, paths), { code: "local_config_invalid" });
});

test("authenticated Mongo URI percent-encodes credentials and fixes replica/auth source", () => {
  assert.equal(
    authenticatedMongoUri({ username: "workbench_admin", password: "p:/?#[]@" }),
    "mongodb://workbench_admin:p%3A%2F%3F%23%5B%5D%40@127.0.0.1:27017/?replicaSet=rs0&authSource=admin",
  );
});

test("local operations CLI exposes the production lifecycle without external side effects in help", async () => {
  const cli = new URL("../../../../operations/local/workbench-local.mjs", import.meta.url);
  const output = await new Promise((resolve, reject) => {
    execFile(process.execPath, [cli.pathname, "help"], { maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
  const commands = JSON.parse(output).commands;
  for (const command of [
    "install", "preflight", "start", "stop", "restart", "status", "backup",
    "restore-drill", "upgrade", "rollback", "diagnostics", "smoke-chat", "smoke-stability",
  ]) assert.ok(commands.includes(command), command);
});

test("local upgrade verifies release gates before creating a backup or reading runtime secrets", async (t) => {
  const root = await mkdtemp("/private/tmp/looloomi-local-upgrade-gate-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = localPaths(`${root}/install`);
  await writeLocalConfig({
    modelBaseUrl: "https://provider.example/v1",
    model: "provider/model-a",
    agentImage: DIGEST,
    skillImage: `repository/skill@${DIGEST}`,
    port: 8798,
    database: "looloomi_upgrade_test",
    logLevel: "info",
  }, paths);
  const bundle = `${root}/bundle`;
  await mkdir(`${bundle}/app`, { recursive: true });
  await mkdir(`${bundle}/release-evidence`, { recursive: true });
  await writeFile(`${bundle}/app/server.mjs`, "export const ready = true;\n");
  await writeFile(`${bundle}/release-evidence/release-gates.json`, `${JSON.stringify({
    schemaVersion: "looloomi-release-gates-v1",
    sourceCommit: "c".repeat(40),
    generatedAt: "2026-07-17T00:00:00.000Z",
    gates: {},
  })}\n`);
  const cli = new URL("../../../../operations/local/workbench-local.mjs", import.meta.url);
  const manifestFailure = await new Promise((resolve) => {
    execFile(process.execPath, [cli.pathname, "manifest", "--root", paths.root, "--bundle", bundle,
      "--version", "blocked-candidate"], { maxBuffer: 128 * 1024 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  assert.notEqual(manifestFailure.error, null);
  assert.equal(manifestFailure.stdout, "");
  const manifestProductError = manifestFailure.stderr.trim().split("\n").find((line) => line.startsWith("{"));
  assert.deepEqual(JSON.parse(manifestProductError), { code: "release_gates_not_passed" });
  await assert.rejects(readFile(`${bundle}/release-manifest.json`, "utf8"), { code: "ENOENT" });

  const manifest = await buildReleaseManifest({
    root: bundle,
    version: "blocked-candidate",
    files: ["app/server.mjs", "release-evidence/release-gates.json"],
    sourceCommit: "c".repeat(40),
    agentImage: DIGEST,
    skillImage: `repository/skill@${DIGEST}`,
    mongoImage: `mongo@${DIGEST}`,
    frontendTreeHash: "d".repeat(40),
  });
  await writeFile(`${bundle}/release-manifest.json`, `${JSON.stringify(manifest)}\n`);

  const failure = await new Promise((resolve) => {
    execFile(process.execPath, [cli.pathname, "upgrade", "--root", paths.root, "--bundle", bundle],
      { maxBuffer: 128 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
  assert.notEqual(failure.error, null);
  const productError = failure.stderr.trim().split("\n").find((line) => line.startsWith("{"));
  assert.deepEqual(JSON.parse(productError), { code: "release_gates_not_passed" });
  assert.equal(failure.stdout, "");
  assert.deepEqual(await readdir(paths.backups), []);
});
