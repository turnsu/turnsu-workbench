import {
  agentExecutionFabricMigration,
  agentProposalsAndActiveBranchesMigration,
  backfillDefaultWorkspaceMigration,
  productMemoryMigration,
  runnerTerminalTransitionsMigration,
} from "../store/migrations/index.mjs";
import { ReadinessRegistry } from "./readiness-registry.mjs";

const EXPECTED_MIGRATIONS = Object.freeze([
  backfillDefaultWorkspaceMigration,
  runnerTerminalTransitionsMigration,
  agentExecutionFabricMigration,
  productMemoryMigration,
  agentProposalsAndActiveBranchesMigration,
]);

export function createProductReadiness({
  store,
  startupState,
  agentSandbox = null,
  providerProbe = null,
  requireAgent = false,
  requireProvider = false,
  requireMigrations = false,
  timeoutMs = 3000,
} = {}) {
  if (!store || !startupState) throw new TypeError("product_readiness_dependencies_invalid");
  const registry = new ReadinessRegistry({ timeoutMs });
  registry.register("startup", () => ({ ok: startupState.ready === true && startupState.error == null }));
  registry.register("mongo", async () => {
    const result = await store.health();
    return { ok: result?.ok === true && result?.writablePrimary === true };
  });
  registry.register("migrations", () => verifyMigrations(store), { required: requireMigrations });
  registry.register("agent_sandbox", () => agentSandbox?.probe?.() ?? { available: false }, { required: requireAgent });
  registry.register("provider", () => providerProbe?.() ?? { available: false }, { required: requireProvider });
  return registry;
}

export async function verifyMigrations(store) {
  const db = await store.connect();
  const applied = await db.collection("product_schema_migrations").find(
    { status: "applied" },
    { projection: { version: 1, checksum: 1 } },
  ).toArray();
  const byVersion = new Map(applied.map((item) => [item.version, item.checksum]));
  return {
    ok: EXPECTED_MIGRATIONS.every((migration) => byVersion.get(migration.version) === migration.checksum),
  };
}

export { EXPECTED_MIGRATIONS };
