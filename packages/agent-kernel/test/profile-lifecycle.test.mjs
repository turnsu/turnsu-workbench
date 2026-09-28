import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentKernelError,
  MinimalKernelContext,
  composeKernelProfile,
  installKernelProfile,
} from "../src/index.mjs";

test("a Profile unload removes its service, listener, and Effect from the shared context", async () => {
  const root = new MinimalKernelContext({ scope: "root" });
  let listenerCalls = 0;
  let effectDisposals = 0;
  const profile = composeKernelProfile({
    id: "profile-unload-proof",
    revision: "1",
    plugins: [{
      id: "system-lifecycle-proof",
      version: "1",
      trust: "T1",
      lifetime: "profile",
      provides: ["system.lifecycle"],
      async setup(ctx) {
        ctx.provide("system.lifecycle", { active: true });
        ctx.on("kernel.tick", () => { listenerCalls += 1; });
        ctx.effect(() => { effectDisposals += 1; });
      },
    }],
  });
  const installed = await installKernelProfile({ context: root, profile });
  assert.deepEqual(root.use("system.lifecycle"), { active: true });
  await root.emit({ type: "kernel.tick" });
  assert.equal(listenerCalls, 1);

  await installed.dispose();
  assert.equal(root.use("system.lifecycle", { optional: true }), undefined);
  await root.emit({ type: "kernel.tick" });
  assert.equal(listenerCalls, 1);
  assert.equal(effectDisposals, 1);
  await root.dispose();
});

test("a lower-trust plugin cannot escape through a child Context or replace a pinned T1 service", async () => {
  const root = new MinimalKernelContext({ scope: "root" });
  let retainedChild;
  const original = Object.freeze({ owner: "T1-original" });
  const profile = composeKernelProfile({
    id: "profile-trust-boundary-proof",
    revision: "1",
    plugins: [{
      id: "trusted-service",
      version: "1",
      trust: "T1",
      lifetime: "profile",
      provides: ["system.service"],
      setup(ctx) { ctx.provide("system.service", original); },
    }, {
      id: "lower-trust-attacker",
      version: "1",
      trust: "T2",
      lifetime: "profile",
      requires: ["system.service"],
      provides: [],
      setup(ctx) {
        retainedChild = ctx.child({ scope: "attacker:child" });
        assert.equal(retainedChild.parent, undefined);
        assert.throws(
          () => retainedChild.provide("system.service", { owner: "T2-replaced" }),
          code("kernel_plugin_undeclared_service"),
        );
      },
    }],
  });

  const installed = await installKernelProfile({ context: root, profile });
  assert.equal(root.use("system.service"), original);

  await installed.dispose();
  assert.equal(retainedChild.disposed, true);
  assert.throws(
    () => retainedChild.use("system.service", { optional: true }),
    code("kernel_context_disposed"),
  );
  await root.dispose();
});

test("a pinned service cannot be replaced through the Context that owns it", async () => {
  const root = new MinimalKernelContext({ scope: "root" });
  const original = Object.freeze({ owner: "root" });
  root.provide("system.service", original, { pinned: true });

  assert.throws(
    () => root.provide("system.service", { owner: "replacement" }, { replace: true }),
    code("kernel_service_pinned"),
  );
  assert.equal(root.use("system.service"), original);
  await root.dispose();
});

function code(expected) {
  return (error) => error instanceof AgentKernelError && error.code === expected;
}
