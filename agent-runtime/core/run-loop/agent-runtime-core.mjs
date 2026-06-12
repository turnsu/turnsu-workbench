import { buildRouteContext } from "../capability/capability-normalizer.mjs";

export function createAgentRuntimeCore({ router, gateEngine, piKernel, finalOutput, artifacts, providerExecutor, capabilityCatalog }) {
  return new AgentRuntimeCore({ router, gateEngine, piKernel, finalOutput, artifacts, providerExecutor, capabilityCatalog });
}

export class AgentRuntimeCore {
  constructor({ router, gateEngine, piKernel, finalOutput, artifacts, providerExecutor, capabilityCatalog = null } = {}) {
    this.router = router;
    this.gateEngine = gateEngine;
    this.piKernel = piKernel;
    this.finalOutput = finalOutput;
    this.artifacts = artifacts;
    this.providerExecutor = providerExecutor;
    this.capabilityCatalog = capabilityCatalog;
  }

  normalizeRunRequest(request) {
    return buildRouteContext({ ...request, capabilityCatalog: request.capabilityCatalog || this.capabilityCatalog });
  }

  planTools(request) {
    const normalized = this.normalizeRunRequest(request);
    const tools = this.router.inferTools({
      prompt: normalized.prompt,
      selectedToolNames: normalized.selectedToolNames,
      attachments: normalized.attachments,
      selectedSkillIDs: normalized.legacySelectedSkillIDs,
      selectedExtensionIDs: normalized.legacySelectedExtensionIDs,
      projectToolNames: request.projectToolNames || [],
    });
    return {
      schemaVersion: "core-route-plan-v1",
      tools,
      normalizedCapabilities: normalized.selectedCapabilityIDs,
      resolvedCapabilityIDs: normalized.resolvedCapabilityIDs,
      unknownCapabilityIDs: normalized.unknownCapabilityIDs,
      compatibilityMode: normalized.compatibilityMode,
      legacySelectedSkillIDs: normalized.legacySelectedSkillIDs,
      legacySelectedExtensionIDs: normalized.legacySelectedExtensionIDs,
      diagnostics: this.router.cmcToolSelectionDiagnostic(
        normalized.prompt,
        normalized.legacySelectedSkillIDs,
        normalized.selectedToolNames,
        tools,
      ),
    };
  }

  guardFinalOutput(args) {
    return this.gateEngine.guardFinalOutput(args);
  }

  productMutationPolicyForRun(toolObservations) {
    return this.gateEngine.productMutationPolicyForRun(toolObservations);
  }

  buildFinalReadModel(args) {
    return this.finalOutput.buildAgentFinalReadModelV1({
      ...args,
      productMutationPolicyForRun: (toolObservations) => this.productMutationPolicyForRun(toolObservations),
    });
  }

  buildDeterministicAssistantText(args, deps = {}) {
    return this.finalOutput.buildDeterministicAssistantText(args, deps);
  }

  buildDegradedMarketFinalText(args, deps = {}) {
    return this.finalOutput.buildDegradedMarketFinalText(args, deps);
  }

  writeFinalReadModelArtifact(args) {
    return this.artifacts.writeAgentFinalReadModelArtifact(args);
  }

  async writeAuthoritativeFinalOutput(args) {
    return this.artifacts.writeAuthoritativeFinalOutput(args);
  }

  writeCapabilityLoopReadModels(runDir, args) {
    return this.artifacts.writeCapabilityLoopReadModels(runDir, args);
  }

  async executeKernelTool(toolName, params) {
    return this.piKernel.executeTool(toolName, params);
  }

  async executeRuntimeTool(toolName, params, deps = {}) {
    return this.providerExecutor.executeRuntimeToolViaCore(toolName, params, {
      ...deps,
      piKernel: this.piKernel,
    });
  }
}
