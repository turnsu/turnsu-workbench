import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentKernelError,
  MinimalKernelContext,
  createDynamicPluginHost,
} from "../src/index.mjs";

const hash = `sha256:${"a".repeat(64)}`;

test("developer Plugin Host unloads services, listeners, and Effects, and its HMR replace is reversible", async (t) => {
  const root = new MinimalKernelContext({ scope: "root" });
  const host = createDynamicPluginHost({
    context: root,
    mode: "developer_dynamic",
    allowedCapabilities: ["render.intent"],
  });
  t.after(async () => {
    await host.dispose();
    await root.dispose();
  });
  let events = 0;
  let disposed = 0;
  await host.load(plugin({
    id: "planner-dev",
    capabilities: ["render.intent"],
    provides: ["planner.dev"],
    setup(ctx) {
      ctx.provide("planner.dev", { revision: 1 });
      ctx.on("planner.tick", () => { events += 1; });
      ctx.effect(() => { disposed += 1; });
    },
  }));
  await root.emit({ type: "planner.tick" });
  assert.equal(events, 1);
  assert.deepEqual(root.use("planner.dev"), { revision: 1 });
  await host.replace(plugin({
    id: "planner-dev",
    version: "2",
    capabilities: ["render.intent"],
    provides: ["planner.dev"],
    setup(ctx) { ctx.provide("planner.dev", { revision: 2 }); },
  }));
  assert.equal(disposed, 1);
  assert.deepEqual(root.use("planner.dev"), { revision: 2 });
  await host.unload("planner-dev");
  assert.equal(root.use("planner.dev", { optional: true }), undefined);
  assert.equal(disposed, 1);
  assert.deepEqual(host.inspect().plugins, []);
});

test("dynamic plugins cannot replace system providers or expand their declared capability set", async (t) => {
  const root = new MinimalKernelContext({ scope: "root" });
  const host = createDynamicPluginHost({ context: root, mode: "developer_dynamic", allowedCapabilities: ["read.only"] });
  t.after(async () => { await host.dispose(); await root.dispose(); });
  await assert.rejects(host.load(plugin({ id: "system-override", provides: ["system.gateway"] })), code("dynamic_plugin_reserved_service_forbidden"));
  await assert.rejects(host.load(plugin({ id: "capability-expand", capabilities: ["host.shell"] })), code("dynamic_plugin_capability_denied"));
  await assert.rejects(host.load(plugin({ id: "ephemeral-dev", trust: "T4", lifetime: "ephemeral", contentHash: hash, expiresAt: "2035-01-01T00:00:00.000Z" })), code("developer_dynamic_ephemeral_plugin_forbidden"));
});

test("signed workspace plugins require a verifier, while sandbox ephemeral plugins are TTL-bound", async (t) => {
  const root = new MinimalKernelContext({ scope: "root" });
  let now = "2026-08-14T00:00:00.000Z";
  const sandbox = createDynamicPluginHost({
    context: root,
    mode: "sandbox_ephemeral",
    allowedCapabilities: ["render.intent"],
    clock: () => now,
  });
  t.after(async () => { await sandbox.dispose(); await root.dispose(); });
  await sandbox.load(plugin({
    id: "ephemeral-render",
    trust: "T4",
    lifetime: "ephemeral",
    contentHash: hash,
    expiresAt: "2026-08-14T00:01:00.000Z",
    capabilities: ["render.intent"],
    provides: ["render.ephemeral"],
  }));
  now = "2026-08-14T00:02:00.000Z";
  assert.deepEqual(await sandbox.reapExpired(), { expired: ["ephemeral-render"] });
  assert.equal(root.use("render.ephemeral", { optional: true }), undefined);

  const dev = createDynamicPluginHost({
    context: root,
    mode: "developer_dynamic",
    allowedCapabilities: [],
    signatureVerifier: async (manifest) => manifest.signature.keyId === "workspace-key-1",
  });
  t.after(() => dev.dispose());
  await dev.load(plugin({
    id: "signed-workspace-plugin",
    trust: "T3",
    contentHash: hash,
    signature: { keyId: "workspace-key-1", value: "abcdefghijklmnopqrstuvwxyz012345" },
    provides: ["workspace.plugin"],
  }));
  assert.equal(dev.inspect().plugins[0].signature.keyId, "workspace-key-1");
});

function plugin({
  id,
  version = "1",
  trust = "T2",
  lifetime = "profile",
  contentHash,
  signature,
  expiresAt,
  requires = [],
  provides = [],
  capabilities = [],
  setup = () => {},
} = {}) {
  return { id, version, trust, lifetime, contentHash, signature, expiresAt, requires, provides, capabilities, setup };
}

function code(expected) {
  return (error) => error instanceof AgentKernelError && error.code === expected;
}
