import {
  AgentKernelError,
  KERNEL_PROFILE_MODES,
  KERNEL_PROFILE_SCHEMA_VERSION,
  PLUGIN_TRUST_LEVELS,
  assertIdentifier,
  assertVersion,
  freeze,
  normalizePluginManifest,
} from "./contracts.mjs";
import { MinimalKernelContext } from "./context.mjs";

/**
 * A Profile is an immutable, ordered plugin set.  Duplicate service providers
 * are rejected rather than resolved by load order; this gives T0/T1 services
 * a monotonic no-override guarantee from the first implementation.
 */
export function composeKernelProfile({
  id,
  revision,
  mode = "production_locked",
  plugins = [],
  baseServices = [],
} = {}) {
  const profileId = assertIdentifier(id, "kernel_profile_invalid");
  const profileRevision = assertVersion(revision, "kernel_profile_invalid");
  if (!KERNEL_PROFILE_MODES.includes(mode) || !Array.isArray(plugins) || !Array.isArray(baseServices)) {
    throw new AgentKernelError("kernel_profile_invalid");
  }
  const normalizedBaseServices = [...new Set(baseServices.map((token) => (
    assertIdentifier(token, "kernel_profile_invalid")
  )))];
  const normalizedPlugins = plugins.map(normalizePluginManifest);
  const ids = new Set();
  const providers = new Map();
  for (const plugin of normalizedPlugins) {
    if (ids.has(plugin.id)) throw new AgentKernelError("kernel_plugin_duplicate");
    ids.add(plugin.id);
    if (mode === "production_locked" && plugin.trust === "T4") {
      throw new AgentKernelError("kernel_profile_ephemeral_plugin_forbidden");
    }
    for (const token of plugin.provides) {
      if (providers.has(token) || normalizedBaseServices.includes(token)) {
        throw new AgentKernelError("kernel_service_provider_conflict");
      }
      providers.set(token, plugin.id);
    }
  }
  const ordered = topologicallyOrder(normalizedPlugins, providers, new Set(normalizedBaseServices));
  return freeze({
    schemaVersion: KERNEL_PROFILE_SCHEMA_VERSION,
    id: profileId,
    revision: profileRevision,
    mode,
    baseServices: normalizedBaseServices,
    plugins: ordered,
  });
}

export async function installKernelProfile({ context, profile } = {}) {
  if (!(context instanceof MinimalKernelContext)
    || !profile
    || profile.schemaVersion !== KERNEL_PROFILE_SCHEMA_VERSION) {
    throw new AgentKernelError("kernel_profile_install_invalid");
  }
  const pluginScopes = [];
  try {
    for (const plugin of profile.plugins) {
      for (const token of plugin.requires) context.use(token);
      const scope = context.child({
        scope: `plugin:${plugin.id}`,
        metadata: { pluginId: plugin.id, trust: plugin.trust, version: plugin.version },
      });
      const api = pluginApi({ context, scope, plugin });
      try {
        const cleanup = await plugin.setup(api);
        if (cleanup !== undefined && cleanup !== null) scope.effect(cleanup);
        pluginScopes.push(scope);
      } catch (error) {
        await scope.dispose().catch(() => {});
        throw error;
      }
    }
  } catch (error) {
    for (const scope of [...pluginScopes].reverse()) await scope.dispose().catch(() => {});
    throw error;
  }
  let disposed = false;
  return freeze({
    pluginIds: profile.plugins.map((plugin) => plugin.id),
    async dispose() {
      if (disposed) return;
      disposed = true;
      const errors = [];
      for (const scope of [...pluginScopes].reverse()) {
        try { await scope.dispose(); } catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "kernel_profile_dispose_failed");
    },
  });
}

function topologicallyOrder(plugins, providers, baseServices) {
  const remaining = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const available = new Set(baseServices);
  const ordered = [];
  while (remaining.size > 0) {
    const next = [...remaining.values()].find((plugin) => (
      plugin.requires.every((token) => available.has(token))
    ));
    if (!next) {
      const missing = [...remaining.values()]
        .flatMap((plugin) => plugin.requires)
        .find((token) => !providers.has(token) && !available.has(token));
      if (missing) throw new AgentKernelError("kernel_plugin_dependency_missing");
      throw new AgentKernelError("kernel_plugin_dependency_cycle");
    }
    remaining.delete(next.id);
    ordered.push(next);
    for (const token of next.provides) available.add(token);
  }
  return ordered;
}

function pluginApi({ context, scope, plugin }) {
  const systemPinned = plugin.trust === "T0" || plugin.trust === "T1";
  const child = (options) => scopedPluginContext({
    scope: scope.child(options),
    plugin,
    systemPinned,
  });
  return freeze({
    plugin: freeze({
      id: plugin.id,
      version: plugin.version,
      trust: plugin.trust,
      lifetime: plugin.lifetime,
      contentHash: plugin.contentHash,
    }),
    get scope() { return scope.scope; },
    provide(token, value) {
      const normalizedToken = assertIdentifier(token, "kernel_service_token_invalid");
      if (!plugin.provides.includes(normalizedToken)) {
        throw new AgentKernelError("kernel_plugin_undeclared_service");
      }
      const remove = context.provide(normalizedToken, value, { pinned: systemPinned });
      scope.effect(remove);
      return remove;
    },
    use(token, options) { return context.use(token, options); },
    // Profile listeners observe Kernel events across all run children.  The
    // listener is owned by this plugin scope and disappears on unload.
    on(type, listener) {
      const remove = context.on(type, listener);
      scope.effect(remove);
      return remove;
    },
    effect(resource) { return scope.effect(resource); },
    child,
    emit(event) { return scope.emit(event); },
  });
}

/**
 * Plugins may create owned child lifetimes, but never receive a raw Context.
 * In particular this keeps the shared Profile/root lineage and its pinned
 * providers outside a lower-trust plugin's object graph. Retained facades
 * become unusable when their owned scope is disposed during Profile unload.
 */
function scopedPluginContext({ scope, plugin, systemPinned }) {
  const provide = (token, value) => {
    const normalizedToken = assertIdentifier(token, "kernel_service_token_invalid");
    if (!plugin.provides.includes(normalizedToken)) {
      throw new AgentKernelError("kernel_plugin_undeclared_service");
    }
    return scope.provide(normalizedToken, value, { pinned: systemPinned });
  };
  return freeze({
    get scope() { return scope.scope; },
    get metadata() { return scope.metadata; },
    get disposed() { return scope.disposed; },
    provide,
    use(token, options) { return scope.use(token, options); },
    has(token) { return scope.has(token); },
    on(type, listener) { return scope.on(type, listener); },
    effect(resource) { return scope.effect(resource); },
    child(options) {
      return scopedPluginContext({ scope: scope.child(options), plugin, systemPinned });
    },
    emit(event) { return scope.emit(event); },
    dispose() { return scope.dispose(); },
  });
}
