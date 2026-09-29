import { createInvitationIdentityComposition } from "./auth/invitation-identity-composition.mjs";
import {
  createDefaultProductPostgresStore,
  startWorkbenchServer,
} from "./server.mjs";
import { createMountedSecretBindingComposition } from "./security/mounted-cloud-secret-store.mjs";

/**
 * Canonical executable composition for the Product API. Keeping this outside
 * the HTTP server module ensures every supported executable path receives the
 * same identity ports instead of relying on callers to remember them.
 */
export async function startProductionWorkbenchServer({
  env = process.env,
  createIdentity = createInvitationIdentityComposition,
  createStore = createDefaultProductPostgresStore,
  createSecretComposition = createMountedSecretBindingComposition,
  startServer = startWorkbenchServer,
  serverOptions = {},
} = {}) {
  if (typeof createIdentity !== "function" || typeof createStore !== "function"
    || typeof createSecretComposition !== "function" || typeof startServer !== "function") {
    throw new TypeError("production_composition_dependencies_invalid");
  }
  if (!serverOptions || typeof serverOptions !== "object" || Array.isArray(serverOptions)) {
    throw new TypeError("production_server_options_invalid");
  }
  const identity = await createIdentity({ env });
  const ownsStore = !serverOptions.store;
  const store = serverOptions.store ?? createStore({ env });
  try {
    const secrets = createSecretComposition({ env, store });
    return await startServer({
      ...serverOptions,
      store,
      env,
      distDirectory: serverOptions.distDirectory ?? env.WORKBENCH_WEB_DIST,
      origin: identity.publicOrigin,
      invitationTokenSigner: identity.invitationTokenSigner,
      invitationMailer: identity.invitationMailer,
      invitationBaseUrl: identity.invitationBaseUrl,
      oauthProviders: identity.oauthProviders,
      credentialResolver: secrets.credentialResolver,
      modelSecretStore: secrets.modelSecretStore,
      connectionSecretBindingGateway: secrets.connectionSecretBindingGateway,
    });
  } catch (error) {
    if (ownsStore) await store?.close?.().catch(() => {});
    throw error;
  }
}

export async function runProductionWorkbenchServerCli({
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  processRef = process,
  start = startProductionWorkbenchServer,
} = {}) {
  if (typeof start !== "function" || typeof stdout?.write !== "function"
    || typeof stderr?.write !== "function" || typeof processRef?.once !== "function") {
    throw new TypeError("production_cli_dependencies_invalid");
  }
  let running;
  const shutdown = async () => {
    try {
      await running?.close?.();
      processRef.exitCode = 0;
    } catch (error) {
      stderr.write(`${error?.stack || error}\n`);
      processRef.exitCode = 1;
    }
  };
  try {
    running = await start({ env });
    stdout.write(`workbench_server_ready:http://127.0.0.1:${running.port}\n`);
    processRef.once("SIGINT", shutdown);
    processRef.once("SIGTERM", shutdown);
    return running;
  } catch (error) {
    stderr.write(`${error?.stack || error}\n`);
    processRef.exitCode = 1;
    return null;
  }
}
