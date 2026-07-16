import { buildRouteContext } from "../capability/capability-normalizer.mjs";

export function createAgentRuntimeCore({ router, gateEngine, piKernel, finalOutput, artifacts, providerExecutor, capabilityCatalog, builderProposalGenerator }) {
  return new AgentRuntimeCore({ router, gateEngine, piKernel, finalOutput, artifacts, providerExecutor, capabilityCatalog, builderProposalGenerator });
}

export class AgentRuntimeCore {
  constructor({ router, gateEngine, piKernel, finalOutput, artifacts, providerExecutor, capabilityCatalog = null, builderProposalGenerator = null } = {}) {
    this.router = router;
    this.gateEngine = gateEngine;
    this.piKernel = piKernel;
    this.finalOutput = finalOutput;
    this.artifacts = artifacts;
    this.providerExecutor = providerExecutor;
    this.capabilityCatalog = capabilityCatalog;
    this.builderProposalGenerator = builderProposalGenerator;
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

  async executeKernelTool(toolName, params, options = {}) {
    return this.piKernel.executeTool(toolName, params, options);
  }

  skillReadiness(skillID) {
    if (typeof this.piKernel?.skillReadiness !== "function") {
      return {
        skillID: String(skillID || ""),
        status: "blocked",
        ready: false,
        code: "pi_skill_binding_unavailable",
      };
    }
    return this.piKernel.skillReadiness(skillID);
  }

  async invokeSkill(skillOrRequest, input, options = {}) {
    if (typeof this.piKernel?.invokeSkill !== "function") {
      throw new Error("pi_skill_invocation_unavailable");
    }
    if (typeof skillOrRequest !== "object" || skillOrRequest === null) {
      return this.piKernel.invokeSkill(skillOrRequest, input, options);
    }
    const { skillID, input: skillInput, ...invocationOptions } = skillOrRequest;
    return this.piKernel.invokeSkill(skillID, skillInput, invocationOptions);
  }

  async generateBuilderProposal(input) {
    if (typeof this.builderProposalGenerator?.generate !== "function") {
      const error = new Error("Workflow suggestions are temporarily unavailable.");
      error.code = "builder_proposal_unavailable";
      throw error;
    }
    return this.builderProposalGenerator.generate(input);
  }

  async executeRuntimeTool(toolName, params, deps = {}) {
    return this.providerExecutor.executeRuntimeToolViaCore(toolName, params, {
      ...deps,
      piKernel: this.piKernel,
    });
  }
}
