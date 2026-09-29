export class StdioToolGatewayServer {
  constructor({ gateway } = {}) {
    if (!gateway?.handle) throw new TypeError("stdio_tool_gateway_dependencies_invalid");
    this.gateway = gateway;
  }

  async open(binding) {
    if (!binding?.invocationId || !binding?.attemptId || !binding?.capabilityLeaseId) {
      throw new TypeError("stdio_tool_gateway_binding_invalid");
    }
    let closed = false;
    let finalSnapshot = null;
    const snapshot = () => finalSnapshot ?? this.gateway.snapshot?.(binding) ?? {
      requestedModelRevisionId: null,
      actualModelRevisionId: null,
    };
    return Object.freeze({
      binding: Object.freeze(structuredClone(binding)),
      handle: (message) => {
        if (closed) {
          const error = new Error("Gateway session is closed.");
          error.code = "gateway_session_closed";
          error.productSafe = true;
          throw error;
        }
        return this.gateway.handle(message, binding);
      },
      snapshot,
      close: async () => {
        if (closed) return;
        finalSnapshot = structuredClone(snapshot());
        closed = true;
        this.gateway?.release?.(binding);
      },
    });
  }
}
