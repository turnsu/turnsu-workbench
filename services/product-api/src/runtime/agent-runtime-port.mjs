export const AGENT_RUNTIME_PORT_METHODS = Object.freeze([
  "probeSkill",
  "invokeSkillNode",
  "buildAuthoritativeFinal",
  "cancelInvocation",
]);

export class AgentRuntimePortError extends Error {
  constructor(code) {
    super(code);
    this.name = "AgentRuntimePortError";
    this.code = code;
  }
}

export class AgentRuntimePort {
  async probeSkill() {
    throw new AgentRuntimePortError("agent_runtime_port_not_implemented");
  }

  async invokeSkillNode() {
    throw new AgentRuntimePortError("agent_runtime_port_not_implemented");
  }

  async generateBuilderProposal() {
    throw new AgentRuntimePortError("builder_proposal_unavailable");
  }

  async buildAuthoritativeFinal() {
    throw new AgentRuntimePortError("agent_runtime_port_not_implemented");
  }

  async cancelInvocation() {
    throw new AgentRuntimePortError("agent_runtime_port_not_implemented");
  }
}

// Proposal generation is deliberately optional until a model-backed, typed
// PI lane is available. Callers must test it explicitly and surface blocked.
export function supportsBuilderProposal(port) {
  return typeof port?.generateBuilderProposal === "function"
    && port.generateBuilderProposal !== AgentRuntimePort.prototype.generateBuilderProposal;
}

export function assertAgentRuntimePort(port) {
  if (!port || AGENT_RUNTIME_PORT_METHODS.some((method) => (
    typeof port[method] !== "function"
    || port[method] === AgentRuntimePort.prototype[method]
  ))) {
    throw new AgentRuntimePortError("agent_runtime_port_invalid");
  }
  return port;
}
