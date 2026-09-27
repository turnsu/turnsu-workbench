const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTENT_HASH = /^sha256:[a-f0-9]{64}$/;

export const KERNEL_EVENT_SCHEMA_VERSION = "agent-kernel-event-v1";
export const MODEL_VISIBLE_EVENT_SCHEMA_VERSION = "agent-kernel-model-visible-event-v1";
export const KERNEL_PROFILE_SCHEMA_VERSION = "agent-kernel-profile-v1";
export const EXECUTION_GRANT_SCHEMA_VERSION = "agent-kernel-execution-grant-v1";
export const RENDER_INTENT_SCHEMA_VERSION = "agent-kernel-render-intent-v1";

export const EFFECT_CLASSES = Object.freeze([
  "read",
  "write_local",
  "execute",
  "external_write",
  "administrative",
]);

export const PLUGIN_TRUST_LEVELS = Object.freeze(["T0", "T1", "T2", "T3", "T4"]);
export const PLUGIN_LIFETIMES = Object.freeze(["kernel", "profile", "run", "ephemeral"]);
export const KERNEL_PROFILE_MODES = Object.freeze([
  "production_locked",
  "developer_dynamic",
  "sandbox_ephemeral",
]);

export class AgentKernelError extends Error {
  constructor(code, message = code, { cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentKernelError";
    this.code = code;
  }
}

/**
 * The only runtime boundary that Product code will eventually need.  The
 * methods intentionally contain no Product Store, workspace-role, or provider
 * semantics; those remain bridge inputs rather than Kernel state.
 */
export class AgentKernelPort {
  capabilities() {
    throw new AgentKernelError("agent_kernel_port_not_implemented");
  }

  run() {
    throw new AgentKernelError("agent_kernel_port_not_implemented");
  }

  resume() {
    throw new AgentKernelError("agent_kernel_port_not_implemented");
  }

  async cancel() {
    throw new AgentKernelError("agent_kernel_port_not_implemented");
  }

  async dispose() {
    throw new AgentKernelError("agent_kernel_port_not_implemented");
  }
}

export class AgentLoop {
  run() {
    throw new AgentKernelError("agent_loop_not_implemented");
  }

  async cancel() {
    throw new AgentKernelError("agent_loop_not_implemented");
  }

  async compact() {
    throw new AgentKernelError("agent_loop_compaction_unavailable");
  }
}

export class SessionPort {
  async append() {
    throw new AgentKernelError("session_port_not_implemented");
  }

  replay() {
    throw new AgentKernelError("session_port_not_implemented");
  }

  async checkpoint() {
    throw new AgentKernelError("session_port_checkpoint_unavailable");
  }
}

export function assertAgentKernelPort(port) {
  const methods = ["capabilities", "run", "resume", "cancel", "dispose"];
  if (!port || methods.some((method) => typeof port[method] !== "function")) {
    throw new AgentKernelError("agent_kernel_port_invalid");
  }
  return port;
}

export function assertAgentLoop(loop) {
  if (!loop || typeof loop.run !== "function" || typeof loop.cancel !== "function") {
    throw new AgentKernelError("agent_loop_invalid");
  }
  return loop;
}

export function assertSessionPort(port) {
  if (!port || typeof port.append !== "function" || typeof port.replay !== "function") {
    throw new AgentKernelError("session_port_invalid");
  }
  return port;
}

export function assertIdentifier(value, code = "kernel_identifier_invalid") {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new AgentKernelError(code);
  }
  return value;
}

export function assertVersion(value, code = "kernel_version_invalid") {
  if (typeof value !== "string" || !VERSION.test(value)) {
    throw new AgentKernelError(code);
  }
  return value;
}

export function assertEffectClass(value, code = "kernel_effect_class_invalid") {
  if (!EFFECT_CLASSES.includes(value)) throw new AgentKernelError(code);
  return value;
}

export function normalizeSessionRef(value, code = "kernel_session_ref_invalid") {
  if (!isRecord(value)) throw new AgentKernelError(code);
  const sessionId = assertIdentifier(value.sessionId, code);
  const branchId = value.branchId === undefined || value.branchId === null
    ? null
    : assertIdentifier(value.branchId, code);
  return freeze({ sessionId, branchId });
}

/**
 * An ExecutionGrant is an opaque, short-lived authority input from the Product
 * bridge.  It is intentionally a shrinking allow-list: a plugin may choose to
 * deny a call, but it cannot add a tool, effect class, budget, or lifetime.
 */
export function createExecutionGrant({
  grantId,
  expiresAt,
  allowedToolIds,
  allowedEffectClasses,
  maxToolCalls = 0,
  scopeRef = null,
} = {}) {
  const normalizedGrantId = assertIdentifier(grantId, "execution_grant_invalid");
  const normalizedExpiry = normalizeTimestamp(expiresAt, "execution_grant_invalid");
  const tools = normalizedIdentifiers(allowedToolIds, "execution_grant_invalid");
  const effects = normalizedEffects(allowedEffectClasses, "execution_grant_invalid");
  // A no-tool Product Run is a valid, deliberately deny-all authority. It
  // must not carry a sentinel Tool just to satisfy the Kernel contract.
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0
    || (maxToolCalls > 0 && (tools.length === 0 || effects.length === 0))) {
    throw new AgentKernelError("execution_grant_invalid");
  }
  const normalizedScopeRef = scopeRef === null ? null : assertIdentifier(scopeRef, "execution_grant_invalid");
  const value = {
    schemaVersion: EXECUTION_GRANT_SCHEMA_VERSION,
    grantId: normalizedGrantId,
    expiresAt: normalizedExpiry,
    allowedToolIds: tools,
    allowedEffectClasses: effects,
    maxToolCalls,
    scopeRef: normalizedScopeRef,
    allows({ toolId, effectClass, now = new Date().toISOString(), usedToolCalls = 0 } = {}) {
      if (Date.parse(normalizedExpiry) <= Date.parse(normalizeTimestamp(now, "execution_grant_time_invalid"))) return false;
      if (!Number.isInteger(usedToolCalls) || usedToolCalls < 0 || usedToolCalls >= maxToolCalls) return false;
      return tools.includes(toolId) && effects.includes(effectClass);
    },
  };
  return freeze(value);
}

export function assertExecutionGrant(value) {
  if (!value || value.schemaVersion !== EXECUTION_GRANT_SCHEMA_VERSION || typeof value.allows !== "function") {
    throw new AgentKernelError("execution_grant_invalid");
  }
  assertIdentifier(value.grantId, "execution_grant_invalid");
  normalizeTimestamp(value.expiresAt, "execution_grant_invalid");
  normalizedIdentifiers(value.allowedToolIds, "execution_grant_invalid");
  normalizedEffects(value.allowedEffectClasses, "execution_grant_invalid");
  if (!Number.isInteger(value.maxToolCalls) || value.maxToolCalls < 0
    || (value.maxToolCalls > 0 && (value.allowedToolIds.length === 0 || value.allowedEffectClasses.length === 0))) {
    throw new AgentKernelError("execution_grant_invalid");
  }
  return value;
}

/** JSON-safe authority handoff for a Worker boundary. The callable allows()
 * method is deliberately rehydrated inside the receiving Kernel process. */
export function serializeExecutionGrant(value) {
  const grant = assertExecutionGrant(value);
  return freeze({
    schemaVersion: EXECUTION_GRANT_SCHEMA_VERSION,
    grantId: grant.grantId,
    expiresAt: grant.expiresAt,
    allowedToolIds: [...grant.allowedToolIds],
    allowedEffectClasses: [...grant.allowedEffectClasses],
    maxToolCalls: grant.maxToolCalls,
    scopeRef: grant.scopeRef,
  });
}

export function normalizeKernelEvent(event, {
  runId,
  session,
  sequence,
  eventId,
  occurredAt,
} = {}) {
  if (!isRecord(event)) throw new AgentKernelError("kernel_event_invalid");
  const normalizedRunId = assertIdentifier(runId, "kernel_event_invalid");
  const normalizedSession = normalizeSessionRef(session, "kernel_event_invalid");
  const normalizedType = assertIdentifier(event.type, "kernel_event_invalid");
  if (event.runId !== undefined && event.runId !== normalizedRunId) {
    throw new AgentKernelError("kernel_event_run_mismatch");
  }
  if (event.session !== undefined && !sameSession(event.session, normalizedSession)) {
    throw new AgentKernelError("kernel_event_session_mismatch");
  }
  if (!Number.isInteger(sequence) || sequence < 1) throw new AgentKernelError("kernel_event_invalid");
  const modelVisible = event.modelVisible === true;
  const payload = cloneValue(event.payload === undefined ? null : event.payload, "kernel_event_payload_invalid");
  return freeze({
    schemaVersion: KERNEL_EVENT_SCHEMA_VERSION,
    eventId: assertIdentifier(eventId, "kernel_event_invalid"),
    runId: normalizedRunId,
    session: normalizedSession,
    sequence,
    type: normalizedType,
    modelVisible,
    payload,
    occurredAt: normalizeTimestamp(occurredAt, "kernel_event_invalid"),
  });
}

export function toModelVisibleEvent(event) {
  if (!event?.modelVisible || event.schemaVersion !== KERNEL_EVENT_SCHEMA_VERSION) {
    throw new AgentKernelError("kernel_event_not_model_visible");
  }
  return normalizeModelVisibleEvent({
    schemaVersion: MODEL_VISIBLE_EVENT_SCHEMA_VERSION,
    eventId: event.eventId,
    runId: event.runId,
    session: cloneValue(event.session, "model_visible_event_invalid"),
    sequence: event.sequence,
    type: event.type,
    payload: cloneValue(event.payload, "model_visible_event_invalid"),
    occurredAt: event.occurredAt,
  });
}

/**
 * SessionPort providers receive this public, immutable projection instead of
 * a live KernelEvent.  Keeping its validation in the contract package lets a
 * Product bridge persist and replay model-visible content without importing a
 * Loop implementation or a Product database implementation into the Kernel.
 */
export function normalizeModelVisibleEvent(event, code = "model_visible_event_invalid") {
  if (!isRecord(event) || event.schemaVersion !== MODEL_VISIBLE_EVENT_SCHEMA_VERSION) {
    throw new AgentKernelError(code);
  }
  if (!Number.isInteger(event.sequence) || event.sequence < 1) {
    throw new AgentKernelError(code);
  }
  return freeze({
    schemaVersion: MODEL_VISIBLE_EVENT_SCHEMA_VERSION,
    eventId: assertIdentifier(event.eventId, code),
    runId: assertIdentifier(event.runId, code),
    session: normalizeSessionRef(event.session, code),
    sequence: event.sequence,
    type: assertIdentifier(event.type, code),
    payload: cloneValue(event.payload === undefined ? null : event.payload, code),
    occurredAt: normalizeTimestamp(event.occurredAt, code),
  });
}

// Render Intent is a versioned data protocol, not a UI-plugin execution hook.
// A future signed/sandboxed renderer may consume it without being granted a
// Product API, secret, or host capability.
export function createRenderIntent({ intentId, version, kind, payload = null } = {}) {
  return freeze({
    schemaVersion: RENDER_INTENT_SCHEMA_VERSION,
    intentId: assertIdentifier(intentId, "render_intent_invalid"),
    version: assertVersion(version, "render_intent_invalid"),
    kind: assertIdentifier(kind, "render_intent_invalid"),
    payload: cloneValue(payload, "render_intent_invalid"),
  });
}

export function normalizePluginManifest(plugin) {
  if (!isRecord(plugin)) throw new AgentKernelError("kernel_plugin_invalid");
  const id = assertIdentifier(plugin.id, "kernel_plugin_invalid");
  const version = assertVersion(plugin.version, "kernel_plugin_invalid");
  if (!PLUGIN_TRUST_LEVELS.includes(plugin.trust) || !PLUGIN_LIFETIMES.includes(plugin.lifetime)) {
    throw new AgentKernelError("kernel_plugin_invalid");
  }
  if (typeof plugin.setup !== "function") throw new AgentKernelError("kernel_plugin_invalid");
  const requires = normalizedIdentifiers(plugin.requires ?? [], "kernel_plugin_invalid");
  const provides = normalizedIdentifiers(plugin.provides ?? [], "kernel_plugin_invalid");
  const capabilities = normalizedIdentifiers(plugin.capabilities ?? [], "kernel_plugin_invalid");
  const contentHash = plugin.contentHash === undefined || plugin.contentHash === null
    ? null
    : String(plugin.contentHash);
  const signature = normalizePluginSignature(plugin.signature);
  const expiresAt = plugin.expiresAt === undefined || plugin.expiresAt === null
    ? null
    : normalizeTimestamp(plugin.expiresAt, "kernel_plugin_invalid");
  if ((plugin.trust === "T3" || plugin.trust === "T4") && !CONTENT_HASH.test(contentHash ?? "")) {
    throw new AgentKernelError("kernel_plugin_content_hash_required");
  }
  if (plugin.trust === "T3" && signature === null) {
    throw new AgentKernelError("kernel_plugin_signature_required");
  }
  if (plugin.trust === "T4" && plugin.lifetime !== "ephemeral") {
    throw new AgentKernelError("kernel_plugin_ephemeral_lifetime_required");
  }
  if ((plugin.trust === "T0" || plugin.trust === "T1") && plugin.lifetime === "ephemeral") {
    throw new AgentKernelError("kernel_plugin_system_lifetime_invalid");
  }
  return freeze({
    id,
    version,
    trust: plugin.trust,
    lifetime: plugin.lifetime,
    contentHash,
    signature,
    expiresAt,
    requires,
    provides,
    capabilities,
    setup: plugin.setup,
  });
}

// JavaScript's runtime equivalent of the KernelPlugin interface. The returned
// manifest is immutable and carries trust, lifetime, version and dependency
// declarations before any setup code is allowed to run.
export function assertKernelPlugin(plugin) {
  return normalizePluginManifest(plugin);
}

export function cloneValue(value, code = "kernel_value_invalid") {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new AgentKernelError(code, code, { cause: error });
  }
}

export function freeze(value) {
  return deepFreeze(value);
}

function normalizedIdentifiers(values, code) {
  if (!Array.isArray(values)) throw new AgentKernelError(code);
  const normalized = [...new Set(values.map((value) => assertIdentifier(value, code)))];
  return freeze(normalized);
}

function normalizedEffects(values, code) {
  if (!Array.isArray(values)) throw new AgentKernelError(code);
  const normalized = [...new Set(values.map((value) => assertEffectClass(value, code)))];
  return freeze(normalized);
}

function normalizeTimestamp(value, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new AgentKernelError(code);
  }
  return new Date(value).toISOString();
}

function normalizePluginSignature(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)
    || typeof value.keyId !== "string" || !IDENTIFIER.test(value.keyId)
    || typeof value.value !== "string" || !/^[A-Za-z0-9_-]{16,4096}$/.test(value.value)) {
    throw new AgentKernelError("kernel_plugin_signature_invalid");
  }
  return freeze({ keyId: value.keyId, value: value.value });
}

function sameSession(left, right) {
  return isRecord(left)
    && left.sessionId === right.sessionId
    && (left.branchId ?? null) === right.branchId;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}
