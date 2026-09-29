/**
 * A process-bound RPC seam for Product-owned Agent Tool approval.  It mirrors
 * the stdio Tool Gateway shape, but deliberately exposes only approval
 * requests: Workers cannot read or mutate the Product approval aggregate.
 */
export class StdioAgentToolApprovalServer {
  constructor({ lifecycle } = {}) {
    if (!lifecycle || typeof lifecycle.request !== "function") {
      throw new TypeError("stdio_agent_tool_approval_dependencies_invalid");
    }
    this.lifecycle = lifecycle;
  }

  async open(binding) {
    assertBinding(binding);
    let closed = false;
    return Object.freeze({
      binding: Object.freeze(structuredClone(binding)),
      handle: async (message) => {
        if (closed) throw closedError();
        return this.lifecycle.request({ binding, message });
      },
      close: async () => { closed = true; },
    });
  }
}

function assertBinding(binding) {
  if (!binding || ![binding.invocationId, binding.attemptId, binding.capabilityLeaseId]
    .every((value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value))) {
    throw new TypeError("stdio_agent_tool_approval_binding_invalid");
  }
}

function closedError() {
  const error = new Error("Product Tool approval session is closed.");
  error.code = "agent_tool_approval_session_closed";
  error.status = "blocked";
  error.productSafe = true;
  return error;
}
