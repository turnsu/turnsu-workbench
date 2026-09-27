import {
  AgentKernelError,
  KERNEL_PROFILE_MODES,
  normalizePluginManifest,
  freeze,
} from "./contracts.mjs";
import { MinimalKernelContext } from "./context.mjs";
import { composeKernelProfile, installKernelProfile } from "./profile.mjs";

/**
 * Dev/sandbox-only lifecycle host. It deliberately has no filesystem watcher,
 * database, Product API, or credential. A developer HMR bridge may call
 * replace(); production never constructs this host.
 */
export class DynamicPluginHost {
  #context;
  #mode;
  #allowedCapabilities;
  #signatureVerifier;
  #clock;
  #records = new Map();
  #availableServices;
  #disposed = false;

  constructor({
    context,
    mode,
    allowedCapabilities = [],
    baseServices = [],
    signatureVerifier = null,
    clock = () => new Date().toISOString(),
  } = {}) {
    if (!(context instanceof MinimalKernelContext)
      || !["developer_dynamic", "sandbox_ephemeral"].includes(mode)
      || !Array.isArray(allowedCapabilities) || !Array.isArray(baseServices)
      || (signatureVerifier !== null && typeof signatureVerifier !== "function")
      || typeof clock !== "function") {
      throw new AgentKernelError("dynamic_plugin_host_dependencies_invalid");
    }
    this.#context = context;
    this.#mode = mode;
    this.#allowedCapabilities = new Set(normalizeTokens(allowedCapabilities));
    this.#availableServices = new Set(normalizeTokens(baseServices));
    this.#signatureVerifier = signatureVerifier;
    this.#clock = clock;
  }

  inspect() {
    this.#assertActive();
    return freeze({
      mode: this.#mode,
      plugins: [...this.#records.values()].map(({ manifest }) => publicManifest(manifest)),
    });
  }

  async load(plugin) {
    this.#assertActive();
    const manifest = normalizePluginManifest(plugin);
    if (this.#records.has(manifest.id)) throw new AgentKernelError("dynamic_plugin_already_loaded");
    await this.#assertLoadable(manifest);
    const profile = composeKernelProfile({
      id: `dynamic.${manifest.id}`,
      revision: manifest.version,
      mode: this.#mode,
      baseServices: [...this.#availableServices],
      plugins: [manifest],
    });
    const installation = await installKernelProfile({ context: this.#context, profile });
    this.#records.set(manifest.id, { manifest, installation });
    for (const token of manifest.provides) this.#availableServices.add(token);
    return publicManifest(manifest);
  }

  async unload(pluginId) {
    this.#assertActive();
    const record = this.#records.get(pluginId);
    if (!record) return freeze({ unloaded: false });
    const dependents = [...this.#records.values()].filter(({ manifest }) => (
      manifest.id !== pluginId && manifest.requires.some((token) => record.manifest.provides.includes(token))
    ));
    if (dependents.length > 0) throw new AgentKernelError("dynamic_plugin_dependency_active");
    await record.installation.dispose();
    this.#records.delete(pluginId);
    for (const token of record.manifest.provides) this.#availableServices.delete(token);
    return freeze({ unloaded: true });
  }

  async replace(plugin) {
    this.#assertActive();
    if (this.#mode !== "developer_dynamic") throw new AgentKernelError("dynamic_plugin_replace_forbidden");
    const manifest = normalizePluginManifest(plugin);
    const existing = this.#records.get(manifest.id);
    if (!existing) return this.load(manifest);
    const previous = existing.manifest;
    await this.unload(previous.id);
    try {
      return await this.load(manifest);
    } catch (error) {
      await this.load(previous).catch(() => {});
      throw error;
    }
  }

  async reapExpired() {
    this.#assertActive();
    const now = Date.parse(this.#clock());
    if (!Number.isFinite(now)) throw new AgentKernelError("dynamic_plugin_clock_invalid");
    const expired = [...this.#records.values()]
      .map(({ manifest }) => manifest)
      .filter((manifest) => manifest.trust === "T4" && Date.parse(manifest.expiresAt) <= now)
      .map((manifest) => manifest.id);
    for (const id of expired) await this.unload(id);
    return freeze({ expired });
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    const records = [...this.#records.values()].reverse();
    this.#records.clear();
    await Promise.allSettled(records.map(({ installation }) => installation.dispose()));
  }

  async #assertLoadable(manifest) {
    if (["T0", "T1"].includes(manifest.trust)) {
      throw new AgentKernelError("dynamic_plugin_system_trust_forbidden");
    }
    if (manifest.provides.some((token) => token.startsWith("kernel.") || token.startsWith("system."))) {
      throw new AgentKernelError("dynamic_plugin_reserved_service_forbidden");
    }
    if (manifest.capabilities.some((capability) => !this.#allowedCapabilities.has(capability))) {
      throw new AgentKernelError("dynamic_plugin_capability_denied");
    }
    if (this.#mode === "sandbox_ephemeral") {
      if (manifest.trust !== "T4" || manifest.lifetime !== "ephemeral" || manifest.expiresAt === null) {
        throw new AgentKernelError("sandbox_ephemeral_plugin_invalid");
      }
      if (Date.parse(manifest.expiresAt) <= Date.parse(this.#clock())) {
        throw new AgentKernelError("sandbox_ephemeral_plugin_expired");
      }
    } else if (manifest.trust === "T4") {
      throw new AgentKernelError("developer_dynamic_ephemeral_plugin_forbidden");
    }
    if (manifest.trust === "T3") {
      if (!this.#signatureVerifier) throw new AgentKernelError("workspace_plugin_signature_verifier_required");
      const verified = await this.#signatureVerifier(publicManifest(manifest));
      if (verified !== true) throw new AgentKernelError("workspace_plugin_signature_invalid");
    }
  }

  #assertActive() {
    if (this.#disposed) throw new AgentKernelError("dynamic_plugin_host_disposed");
  }
}

export function createDynamicPluginHost(options = {}) {
  return new DynamicPluginHost(options);
}

function normalizeTokens(values) {
  return [...new Set(values.map((value) => {
    if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) {
      throw new AgentKernelError("dynamic_plugin_token_invalid");
    }
    return value;
  }))];
}

function publicManifest(manifest) {
  return freeze({
    id: manifest.id,
    version: manifest.version,
    trust: manifest.trust,
    lifetime: manifest.lifetime,
    contentHash: manifest.contentHash,
    signature: manifest.signature,
    expiresAt: manifest.expiresAt,
    requires: [...manifest.requires],
    provides: [...manifest.provides],
    capabilities: [...manifest.capabilities],
  });
}
