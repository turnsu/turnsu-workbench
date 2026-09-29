import assert from "node:assert/strict";
import test from "node:test";

import {
  runProductionWorkbenchServerCli,
  startProductionWorkbenchServer,
} from "../../src/production-composition.mjs";

test("production startup always injects the configured identity ports into the real server boundary", async () => {
  const env = { WORKBENCH_WEB_DIST: "/tmp/workbench-dist" };
  const identity = Object.freeze({
    publicOrigin: "https://workspace.example.test",
    invitationTokenSigner: { kind: "signer" },
    invitationMailer: { kind: "mailer" },
    invitationBaseUrl: "https://workspace.example.test",
    oauthProviders: Object.freeze({ google: { kind: "google" }, github: { kind: "github" } }),
  });
  let identityEnvironment;
  let serverInput;
  const store = { async close() {} };
  const secretComposition = {
    credentialResolver: { kind: "model-secret-resolver" },
    modelSecretStore: { kind: "model-secret-store" },
    connectionSecretBindingGateway: { kind: "connection-secret-gateway" },
  };

  const result = await startProductionWorkbenchServer({
    env,
    createIdentity: async (input) => {
      identityEnvironment = input.env;
      return identity;
    },
    createStore: () => store,
    createSecretComposition: (input) => {
      assert.equal(input.env, env);
      assert.equal(input.store, store);
      return secretComposition;
    },
    startServer: async (input) => {
      serverInput = input;
      return { port: 8798 };
    },
  });

  assert.equal(identityEnvironment, env);
  assert.equal(serverInput.env, env);
  assert.equal(serverInput.store, store);
  assert.equal(serverInput.distDirectory, "/tmp/workbench-dist");
  assert.equal(serverInput.origin, identity.publicOrigin);
  assert.equal(serverInput.invitationTokenSigner, identity.invitationTokenSigner);
  assert.equal(serverInput.invitationMailer, identity.invitationMailer);
  assert.equal(serverInput.invitationBaseUrl, identity.invitationBaseUrl);
  assert.equal(serverInput.oauthProviders, identity.oauthProviders);
  assert.equal(serverInput.credentialResolver, secretComposition.credentialResolver);
  assert.equal(serverInput.modelSecretStore, secretComposition.modelSecretStore);
  assert.equal(serverInput.connectionSecretBindingGateway, secretComposition.connectionSecretBindingGateway);
  assert.deepEqual(result, { port: 8798 });
});

test("the production CLI reports readiness and owns graceful shutdown for the composed server", async () => {
  const output = [];
  const errors = [];
  const signals = new Map();
  let closed = 0;
  const processRef = {
    exitCode: undefined,
    once(signal, listener) { signals.set(signal, listener); },
  };
  const running = await runProductionWorkbenchServerCli({
    env: {},
    stdout: { write(value) { output.push(value); } },
    stderr: { write(value) { errors.push(value); } },
    processRef,
    start: async () => ({ port: 9876, async close() { closed += 1; } }),
  });

  assert.equal(running.port, 9876);
  assert.deepEqual(output, ["workbench_server_ready:http://127.0.0.1:9876\n"]);
  assert.deepEqual(errors, []);
  assert.deepEqual([...signals.keys()].sort(), ["SIGINT", "SIGTERM"]);
  await signals.get("SIGTERM")();
  assert.equal(closed, 1);
  assert.equal(processRef.exitCode, 0);
});

test("the production CLI reports one startup failure and exits nonzero without an unhandled rejection", async () => {
  const errors = [];
  const processRef = { exitCode: undefined, once() {} };
  const result = await runProductionWorkbenchServerCli({
    env: {},
    stdout: { write() {} },
    stderr: { write(value) { errors.push(value); } },
    processRef,
    start: async () => { throw new TypeError("identity_public_https_origin_required"); },
  });

  assert.equal(result, null);
  assert.equal(processRef.exitCode, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /identity_public_https_origin_required/);
});
