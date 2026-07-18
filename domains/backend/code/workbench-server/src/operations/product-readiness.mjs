import {
  agentExecutionFabricMigration,
  agentProposalsAndActiveBranchesMigration,
  backfillDefaultWorkspaceMigration,
  productMemoryMigration,
  runnerTerminalTransitionsMigration,
  modelRoutingMigration,
} from "../store/migrations/index.mjs";
import { ReadinessRegistry } from "./readiness-registry.mjs";

const EXPECTED_MIGRATIONS = Object.freeze([
  backfillDefaultWorkspaceMigration,
  runnerTerminalTransitionsMigration,
  agentExecutionFabricMigration,
  productMemoryMigration,
  agentProposalsAndActiveBranchesMigration,
  modelRoutingMigration,
]);

export function createProductReadiness({
  store,
  startupState,
  agentSandbox = null,
  providerProbe = null,
  requireAgent = false,
  requireProvider = false,
  requireMigrations = false,
  modelCatalog = null,
  modelRoutingRequirements = [],
  requireModelRouting = false,
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
  registry.register("model_routing", () => verifyRequiredModelCapabilityDefaults({
    modelCatalog,
    requirements: modelRoutingRequirements,
  }), { required: requireModelRouting });
  return registry;
}

export async function verifyRequiredModelCapabilityDefaults({ modelCatalog, requirements = [] } = {}) {
  if (!modelCatalog || !Array.isArray(requirements) || requirements.length === 0) return { ok: false };
  try {
    for (const requirement of requirements) {
      if (typeof requirement?.workspaceId !== "string" || requirement.workspaceId.length === 0
        || !Array.isArray(requirement.capabilities) || requirement.capabilities.length === 0) return { ok: false };
      const policy = await modelCatalog.getWorkspacePolicy(requirement.workspaceId);
      if (!policy) return { ok: false };
      for (const capability of requirement.capabilities) {
        const profileId = policy.defaultProfileIdsByCapability?.[capability];
        if (typeof profileId !== "string" || profileId.length === 0) return { ok: false };
        const resolved = await modelCatalog.resolveCurrentProfile({
          workspaceId: requirement.workspaceId,
          profileId,
          capabilities: [capability],
          requireReady: true,
        });
        if (!new Set(["ready", "degraded"]).has(resolved?.readiness?.state)) return { ok: false };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
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
