import { createLegacyPiRuntimeComponents } from "../../../../../agent/code/agent-runtime/public-api.mjs";
import { createFirstPartyBusinessPluginRuntime } from "../../../../../agent/code/plugins/src/index.mjs";

import { createInProcessAgentAdapter } from "./in-process-agent-adapter.mjs";

/**
 * Compatibility composition isolated from Product server.mjs. Product code
 * receives opaque runtime ports from Agent Runtime's public API, while
 * deterministic business Skills are first-party Kernel plugins.
 */
export function createLegacyAgentRuntimeBundle({
  env = process.env,
  clock = () => new Date().toISOString(),
  idFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
  uploadedSkillRuntime = null,
} = {}) {
  const piComponents = createLegacyPiRuntimeComponents({ env, clock, idFactory });
  const businessPluginRuntime = createFirstPartyBusinessPluginRuntime({
    uploadedSkillExecutionPort: uploadedSkillRuntime,
    clock,
    idFactory,
  });
  const agentRuntime = createInProcessAgentAdapter({
    agentRuntimeCore: piComponents.agentRuntimeCore,
    runtimeKernel: piComponents.runtimeKernel,
    executorRegistry: piComponents.executorRegistry,
    uploadedSkillRuntime,
    businessPluginRuntime,
    now: clock,
  });
  return Object.freeze({
    agentRuntime,
    async dispose() {
      await Promise.resolve(piComponents.dispose?.()).catch(() => {});
      await Promise.resolve(businessPluginRuntime.dispose?.()).catch(() => {});
    },
  });
}
