import {
  AgentKernelError,
  assertAgentLoop,
  assertSessionPort,
  composeKernelProfile,
  normalizePluginManifest,
} from "../../agent-kernel/src/index.mjs";

/**
 * Build the production-locked bridge Profile without leaking a repository,
 * secret, connection, or workspace-role concept into agent-kernel. The three
 * Product inputs are opaque ports: Session authority, Tool authority, and an
 * optional safe event observer.
 */
export function createProductKernelProfile({
  id = "product-pi",
  revision = "product-pi-first-party-v1",
  mode = "production_locked",
  loop,
  sessionPort,
  toolPipeline,
  eventObserver = null,
  firstPartyPlugins = [],
} = {}) {
  const resolvedLoop = assertAgentLoop(loop);
  const resolvedSessionPort = assertSessionPort(sessionPort);
  if (!toolPipeline || typeof toolPipeline.execute !== "function"
    || (eventObserver !== null && typeof eventObserver?.observe !== "function")
    || !Array.isArray(firstPartyPlugins)) {
    throw new AgentKernelError("product_kernel_profile_dependencies_invalid");
  }

  const resolvedFirstPartyPlugins = firstPartyPlugins.map((plugin) => {
    const manifest = normalizePluginManifest(plugin);
    if (manifest.trust !== "T2"
      || manifest.provides.some((token) => token.startsWith("product.")
        || token === "agent.loop" || token.startsWith("kernel."))) {
      throw new AgentKernelError("product_first_party_plugin_invalid");
    }
    return manifest;
  });
  const rootServices = {
    "product.session_port": resolvedSessionPort,
    "product.tool_pipeline": toolPipeline,
    ...(eventObserver ? { "product.kernel_event_observer": eventObserver } : {}),
  };
  const plugins = [
    productSessionBridgePlugin(),
    productToolBridgePlugin(),
    ...(eventObserver ? [productKernelEventObserverPlugin()] : []),
    loopPlugin(resolvedLoop),
    ...resolvedFirstPartyPlugins,
  ];
  return Object.freeze({
    profile: composeKernelProfile({
      id,
      revision,
      mode,
      baseServices: Object.keys(rootServices),
      plugins,
    }),
    // Freeze only the map: each value is a live port and must retain its own
    // lifecycle/mutable state rather than being recursively frozen.
    rootServices: Object.freeze(rootServices),
  });
}

function productSessionBridgePlugin() {
  return {
    id: "product-session-bridge",
    version: "1",
    trust: "T1",
    lifetime: "profile",
    requires: ["product.session_port"],
    provides: ["kernel.session_port"],
    setup(ctx) {
      ctx.provide("kernel.session_port", ctx.use("product.session_port"));
    },
  };
}

function productToolBridgePlugin() {
  return {
    id: "product-tool-bridge",
    version: "1",
    trust: "T1",
    lifetime: "profile",
    requires: ["product.tool_pipeline"],
    provides: ["kernel.tool_pipeline"],
    setup(ctx) {
      ctx.provide("kernel.tool_pipeline", ctx.use("product.tool_pipeline"));
    },
  };
}

function productKernelEventObserverPlugin() {
  return {
    id: "product-kernel-event-observer",
    version: "1",
    trust: "T1",
    lifetime: "profile",
    requires: ["product.kernel_event_observer"],
    provides: [],
    setup(ctx) {
      const observer = ctx.use("product.kernel_event_observer");
      ctx.on("kernel.event", (event) => observer.observe(event));
    },
  };
}

function loopPlugin(loop) {
  if (typeof loop.asKernelPlugin === "function") {
    return loop.asKernelPlugin({
      id: "pi-agent-loop",
      version: "1",
      serviceToken: "agent.loop",
    });
  }
  return {
    id: "product-agent-loop",
    version: "1",
    trust: "T1",
    lifetime: "profile",
    requires: [],
    provides: ["agent.loop"],
    setup(ctx) {
      ctx.provide("agent.loop", loop);
      return () => loop.dispose?.();
    },
  };
}
