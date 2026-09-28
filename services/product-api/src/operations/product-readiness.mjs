import { ReadinessRegistry } from "./readiness-registry.mjs";

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
  if (store.persistenceDriver !== "postgres") {
    throw new TypeError("postgres_product_store_required");
  }
  const postgresOperations = store.createOperationalReadiness?.();
  if (!postgresOperations) {
    throw new TypeError("postgres_operational_readiness_required");
  }
  const registry = new ReadinessRegistry({ timeoutMs });
  registry.register("startup", () => ({ ok: startupState.ready === true && startupState.error == null }));
  registry.register("postgres", () => postgresOperations.probe());
  registry.register("migrations", () => verifyMigrations(store, { postgresOperations }), { required: requireMigrations });
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
      const policy = await modelCatalog.getWorkspacePolicy(requirement.workspaceId, { scopeId: requirement.scopeId, userId: requirement.userId });
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

export async function verifyMigrations(store, { postgresOperations = null } = {}) {
  if (store?.persistenceDriver !== "postgres") return { ok: false };
  const operations = postgresOperations ?? store.createOperationalReadiness?.();
  if (!operations?.verifyMigrations) return { ok: false };
  return operations.verifyMigrations();
}
