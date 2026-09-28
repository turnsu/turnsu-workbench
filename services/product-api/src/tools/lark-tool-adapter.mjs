import { createHash } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import { ProductStoreError } from "../store/errors.mjs";
import {
  sanitizeLarkActionOutput,
  sanitizeLarkToolResult,
} from "./lark-tool-output.mjs";
import { getLarkToolPolicy } from "./lark-tool-policy.mjs";

const execFileAsync = promisify(nodeExecFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 100 * 1024;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;

const hashValue = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

function error(code, message, details = {}) {
  return new ProductStoreError(code, message, details);
}

function safeEnvironment(source = process.env) {
  return Object.fromEntries([
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "TMPDIR",
    "TZ",
  ].flatMap((name) => typeof source[name] === "string" ? [[name, source[name]]] : []));
}

function validateArguments(policy, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw error("lark_tool_arguments_invalid", "Tool arguments must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(policy.arguments, key)) {
      throw error("lark_tool_argument_forbidden", "The requested tool argument is not allowed.", { argument: key });
    }
  }
  for (const [key, definition] of Object.entries(policy.arguments)) {
    const candidate = value[key];
    if (candidate === undefined) {
      if (definition.required) {
        throw error("lark_tool_argument_required", "A required tool argument is missing.", { argument: key });
      }
      continue;
    }
    if (definition.type === "string") {
      if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > definition.maxLength) {
        throw error("lark_tool_argument_invalid", "A tool text argument is invalid.", { argument: key });
      }
      if (definition.values && !definition.values.includes(candidate)) {
        throw error("lark_tool_argument_invalid", "A tool argument is outside its allowed values.", { argument: key });
      }
    } else if (definition.type === "boolean") {
      if (typeof candidate !== "boolean") {
        throw error("lark_tool_argument_invalid", "A tool boolean argument is invalid.", { argument: key });
      }
    } else if (
      definition.type === "integer"
      && (!Number.isSafeInteger(candidate) || candidate < definition.minimum || candidate > definition.maximum)
    ) {
      throw error("lark_tool_argument_invalid", "A tool integer argument is invalid.", { argument: key });
    }
  }
  const customFailure = policy.validate?.(value);
  if (customFailure) throw error("lark_tool_argument_invalid", customFailure);
}

function argumentVector(policy, value) {
  const argv = [];
  for (const [key, definition] of Object.entries(policy.arguments)) {
    const candidate = value[key];
    if (candidate === undefined || candidate === false) continue;
    argv.push(definition.flag);
    if (definition.type !== "boolean") argv.push(String(candidate));
  }
  return argv;
}

function parseOutput(stdout) {
  const source = String(stdout ?? "").trim();
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    return source;
  }
}

function valueAtPath(value, path) {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return null;
    current = current[key];
  }
  return current;
}

function normalizeExternalRef(value, policy, { containerId } = {}) {
  if (
    !value
    || typeof value !== "object"
    || value.provider !== "lark"
    || value.resourceType !== policy.driver.resourceType
    || typeof value.id !== "string"
    || !EXTERNAL_ID.test(value.id)
  ) {
    throw error("lark_external_ref_invalid", "The Lark Driver returned an invalid external reference.");
  }
  const resolvedContainerId = value.containerId ?? containerId;
  if (resolvedContainerId !== undefined && (
    typeof resolvedContainerId !== "string" || !EXTERNAL_ID.test(resolvedContainerId)
  )) {
    throw error("lark_external_ref_invalid", "The Lark Driver returned an invalid external container reference.");
  }
  return Object.freeze({
    provider: "lark",
    resourceType: policy.driver.resourceType,
    id: value.id,
    ...(resolvedContainerId ? { containerId: resolvedContainerId } : {}),
  });
}

function externalContainerId(policy, args) {
  if (policy.action === "lark.im.send_message") return args.chatId ?? args.userId;
  return policy.driver.containerArgument ? args[policy.driver.containerArgument] : undefined;
}

function externalRefFromOutput(policy, output, args) {
  for (const path of policy.driver.externalIdPaths) {
    const id = valueAtPath(output, path);
    if (typeof id !== "string" || !EXTERNAL_ID.test(id)) continue;
    return normalizeExternalRef({
      provider: "lark",
      resourceType: policy.driver.resourceType,
      id,
    }, policy, { containerId: externalContainerId(policy, args) });
  }
  return null;
}

function normalizeEffectResult(value, { policy, effectId }) {
  if (!value || !["succeeded", "not_applied", "unknown"].includes(value.outcome)) {
    throw error("lark_effect_reconciliation_invalid", "The Lark Driver returned an invalid effect outcome.");
  }
  if (value.outcome !== "succeeded") return { outcome: value.outcome };
  const externalRef = normalizeExternalRef(value.externalRef, policy);
  const receiptValue = value.receipt && typeof value.receipt === "object" && !Array.isArray(value.receipt)
    ? value.receipt
    : {};
  const normalized = sanitizeLarkToolResult(policy.action, {
    status: "succeeded",
    action: policy.action,
    effect: "write",
    output: value.output,
    externalRef,
    receipt: {
      ...receiptValue,
      receiptId: typeof receiptValue.receiptId === "string"
        ? receiptValue.receiptId
      : `lark-effect:${effectId}`,
      action: policy.action,
      effect: "write",
      externalRef,
    },
  });
  return {
    outcome: "succeeded",
    output: normalized.output,
    externalRef: normalized.externalRef,
    receipt: normalized.receipt,
  };
}

export class LarkToolAdapter {
  constructor({
    binaryPath,
    profileResolver,
    execFile = execFileAsync,
    clock = () => new Date().toISOString(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    env = process.env,
    effectReconciler = null,
    effectCanceller = null,
  } = {}) {
    if (typeof binaryPath !== "string" || !isAbsolute(binaryPath)) {
      throw new TypeError("lark_cli_absolute_path_required");
    }
    if (typeof profileResolver !== "function" || typeof execFile !== "function") {
      throw new TypeError("lark_tool_adapter_dependencies_invalid");
    }
    if (effectReconciler !== null && typeof effectReconciler !== "function") {
      throw new TypeError("lark_effect_reconciler_invalid");
    }
    if (effectCanceller !== null && typeof effectCanceller !== "function") {
      throw new TypeError("lark_effect_canceller_invalid");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > DEFAULT_TIMEOUT_MS) {
      throw new TypeError("lark_tool_timeout_invalid");
    }
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1_024 || maxOutputBytes > DEFAULT_MAX_OUTPUT_BYTES) {
      throw new TypeError("lark_tool_output_limit_invalid");
    }
    this.binaryPath = binaryPath;
    this.profileResolver = profileResolver;
    this.execFile = execFile;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
    this.environment = safeEnvironment(env);
    this.effectReconciler = effectReconciler;
    this.effectCanceller = effectCanceller;
  }

  async probe() {
    try {
      await access(this.binaryPath);
      return { ready: true, status: "ready" };
    } catch {
      return { ready: false, status: "blocked", code: "lark_cli_unavailable" };
    }
  }

  effectCapabilities(action) {
    const policy = getLarkToolPolicy(action);
    if (!policy || policy.effect !== "write") {
      return Object.freeze({ idempotency: "none", reconcile: "none", cancel: "none" });
    }
    return Object.freeze({
      idempotency: policy.driver.idempotency,
      reconcile: policy.driver.reconcile === "query" && this.effectReconciler ? "query" : "none",
      cancel: policy.driver.cancel === "cooperative" && this.effectCanceller
        ? "cooperative"
        : "transport_only",
    });
  }

  async reconcileEffect({ action, effectId, profile, externalRef, signal } = {}) {
    const policy = getLarkToolPolicy(action);
    if (!policy || policy.effect !== "write") {
      throw error("lark_tool_not_allowed", "The requested Lark effect action is not registered.");
    }
    if (this.effectCapabilities(action).reconcile !== "query" || !this.effectReconciler) {
      throw error("lark_effect_reconciliation_unavailable", "This Lark action cannot be queried for reconciliation.");
    }
    if (typeof effectId !== "string" || effectId.length < 8 || effectId.length > 128 || !PROFILE.test(profile)) {
      throw error("lark_effect_reconciliation_invalid", "The Lark reconciliation request is invalid.");
    }
    const result = await this.effectReconciler({
      action,
      effectId,
      profile,
      externalRef: externalRef ? normalizeExternalRef(externalRef, policy) : null,
      signal,
    });
    return normalizeEffectResult(result, { policy, effectId });
  }

  async cancelEffect({ action, effectId, profile, externalRef, reason, signal } = {}) {
    const policy = getLarkToolPolicy(action);
    if (!policy || policy.effect !== "write") {
      throw error("lark_tool_not_allowed", "The requested Lark effect action is not registered.");
    }
    if (this.effectCapabilities(action).cancel !== "cooperative" || !this.effectCanceller) {
      throw error("lark_effect_cancel_unavailable", "This Lark action does not support cooperative cancellation.");
    }
    if (typeof effectId !== "string" || effectId.length < 8 || effectId.length > 128 || !PROFILE.test(profile)) {
      throw error("lark_effect_cancel_invalid", "The Lark cancellation request is invalid.");
    }
    const result = await this.effectCanceller({
      action,
      effectId,
      profile,
      externalRef: externalRef ? normalizeExternalRef(externalRef, policy) : null,
      reason,
      signal,
    });
    return normalizeEffectResult(result, { policy, effectId });
  }

  async execute({
    action,
    skillName,
    arguments: args = {},
    userId,
    profile: governedProfile,
    confirmed = false,
    effectId,
    signal,
  } = {}) {
    const policy = getLarkToolPolicy(action);
    if (!policy || !policy.skillNames.includes(skillName)) {
      throw error("lark_tool_not_allowed", "This Skill is not allowed to use the requested Lark action.");
    }
    validateArguments(policy, args);
    if (policy.confirmationRequired && confirmed !== true) {
      return {
        status: "confirmation_required",
        action,
        effect: policy.effect,
        confirmation: {
          action,
          summary: `Confirm ${action} before the external write is executed.`,
        },
      };
    }
    if (policy.effect === "write" && (typeof effectId !== "string" || effectId.length < 8 || effectId.length > 128)) {
      throw error("lark_effect_id_required", "A stable effect identifier is required for a Lark write.");
    }
    const profile = governedProfile ?? await this.profileResolver({ userId, action });
    if (typeof profile !== "string" || !PROFILE.test(profile)) {
      throw error("lark_connection_profile_unavailable", "This Connection has no governed Lark CLI profile.");
    }
    const argv = [
      "--profile",
      profile,
      ...policy.command,
      "--as",
      "user",
      "--format",
      "json",
      ...argumentVector(policy, args),
    ];
    if (policy.effect === "write" && policy.driver.idempotency === "provider_key") {
      argv.push("--idempotency-key", effectId);
    }
    let output;
    try {
      output = await this.execFile(this.binaryPath, argv, {
        encoding: "utf8",
        env: this.environment,
        maxBuffer: this.maxOutputBytes,
        timeout: this.timeoutMs,
        signal,
        windowsHide: true,
      });
    } catch (cause) {
      if (cause?.name === "AbortError" || signal?.aborted) {
        throw error("lark_tool_cancelled", "The Lark tool call was cancelled.");
      }
      if (cause?.killed && cause?.signal === "SIGTERM") {
        throw error("lark_tool_timeout", "The Lark tool call exceeded its deadline.");
      }
      if (cause?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw error("lark_tool_output_limit_exceeded", "The Lark tool output exceeded the product limit.");
      }
      throw error("lark_tool_failed", "The Lark tool call failed.", {
        exitCode: Number.isInteger(cause?.code) ? cause.code : undefined,
      });
    }
    const stdout = String(output?.stdout ?? "");
    const normalizedOutput = sanitizeLarkActionOutput(action, parseOutput(stdout));
    const completedAt = String(this.clock());
    const externalRef = policy.effect === "write"
      ? externalRefFromOutput(policy, normalizedOutput, args)
      : null;
    if (policy.effect === "write" && !externalRef) {
      throw error(
        "lark_external_ref_missing",
        "The external write returned without a verifiable Lark resource reference.",
        { action },
      );
    }
    const receipt = {
      receiptId: policy.effect === "write" ? `lark-effect:${effectId}` : `lark-read:${hashValue(`${action}\0${completedAt}`)}`,
      action,
      effect: policy.effect,
      commandDigest: hashValue(JSON.stringify({ action, args, profile })),
      outputDigest: hashValue(stdout),
      completedAt,
      ...(externalRef ? { externalRef } : {}),
    };
    return sanitizeLarkToolResult(action, {
      status: "succeeded",
      action,
      effect: policy.effect,
      output: normalizedOutput,
      ...(externalRef ? { externalRef } : {}),
      receipt,
    });
  }
}

export function createLarkProfileResolver({ prefix = "workbench" } = {}) {
  if (!PROFILE.test(prefix)) throw new TypeError("lark_profile_prefix_invalid");
  return async ({ userId } = {}) => {
    if (typeof userId !== "string" || userId.length === 0) return null;
    return `${prefix}-${createHash("sha256").update(userId).digest("hex").slice(0, 20)}`;
  };
}
