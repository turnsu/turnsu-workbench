import { join } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const result = (ready, code, availableModelCount = 0) => Object.freeze({
  ready,
  code,
  availableModelCount,
});

export async function inspectPiBuilderProviderReadiness({
  agentDir,
  // Since Pi 0.83 the SDK no longer exports AuthStorage/ModelRegistry; the default
  // auth source is the auth.json path consumed by ModelRuntime.create(). The
  // factory hooks keep tests independent from the concrete SDK wiring.
  authStorageFactory = (authPath) => authPath,
  modelRegistryFactory = (authPath, modelsPath) => ModelRuntime.create({ authPath, modelsPath }),
} = {}) {
  if (typeof agentDir !== "string" || !agentDir) {
    throw new TypeError("pi_builder_provider_agent_dir_required");
  }
  if (typeof authStorageFactory !== "function" || typeof modelRegistryFactory !== "function") {
    throw new TypeError("pi_builder_provider_readiness_factory_required");
  }

  try {
    const authStorage = authStorageFactory(join(agentDir, "auth.json"));
    const modelRegistry = await modelRegistryFactory(authStorage, join(agentDir, "models.json"));
    await modelRegistry.refresh();
    if (modelRegistry.getError()) {
      return result(false, "builder_provider_configuration_invalid");
    }
    const availableModels = await modelRegistry.getAvailable();
    if (!Array.isArray(availableModels) || availableModels.length === 0) {
      return result(false, "builder_provider_not_configured");
    }
    return result(true, "builder_provider_ready", availableModels.length);
  } catch {
    return result(false, "builder_provider_readiness_unavailable");
  }
}
