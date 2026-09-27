import {
  ProductApiError,
  ProductClientProtocolError,
} from "@looloomi/product-client";
import { createAuthProductClient } from "@looloomi/product-client/auth";
import { createInboxProductClient } from "@looloomi/product-client/inbox";
import { createReadinessProductClient } from "@looloomi/product-client/readiness";
import { createAutomationProductClient } from "@looloomi/product-client/automation";
import { createDeviceProductClient } from "@looloomi/product-client/devices";
import { createScopeProductClient } from "@looloomi/product-client/scope";
import { createRunProductClient } from "@looloomi/product-client/runs";
import { createWorkItemProductClient } from "@looloomi/product-client/work-items";
import { createWorkspaceProductClient } from "@looloomi/product-client/workspace";

const API_PREFIX = "/api/workbench/v1";
const SKILL_PACKAGE_FORMAT = "workbench-skill-package-v1";

export const RUN_EVENT_TYPES = Object.freeze([
  "run.queued",
  "run.started",
  "node.started",
  "node.progress",
  "node.completed",
  "node.failed",
  "review.requested",
  "run.paused",
  "run.cancellation_requested",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.partial",
  "run.effect_outcome_unknown",
]);

export const RUN_TERMINAL_STATUSES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "partial",
  "effect_outcome_unknown",
]);

const RUN_TERMINAL_STATUS_SET = new Set(RUN_TERMINAL_STATUSES);
const RUN_CANCELLABLE_STATUS_SET = new Set(["queued", "running"]);
const RUN_REPEAT_OR_RETRY_STATUS_SET = new Set(["completed", "failed", "cancelled"]);
const PUBLIC_AUTH_MUTATION_OPERATIONS = new Set([
  "register",
  "login",
  "inspectInvitation",
  "startOAuth",
]);

export function isTerminalRunStatus(status) {
  return RUN_TERMINAL_STATUS_SET.has(status);
}

export function canCancelRun(status) {
  return RUN_CANCELLABLE_STATUS_SET.has(status);
}

export function canRepeatOrRetryRun(status) {
  return RUN_REPEAT_OR_RETRY_STATUS_SET.has(status);
}

export class WorkbenchApiError extends Error {
  constructor({ code, message, details = {}, retryable = false, requestId = "", status = 0 } = {}) {
    super(message || code || "workbench_request_failed");
    this.name = "WorkbenchApiError";
    this.code = code || "workbench_request_failed";
    this.details = details;
    this.retryable = Boolean(retryable);
    this.requestId = requestId;
    this.status = status;
  }
}

function queryString(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `?${value}` : "";
}

function defaultIdFactory() {
  return globalThis.crypto?.randomUUID?.() ?? `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function encoded(value) {
  return encodeURIComponent(String(value));
}

export function formatSkillPackageBytes(files) {
  const records = Array.isArray(files) ? files.map((file) => ({
    path: String(file?.path ?? ""),
    content: String(file?.contentBase64 ?? ""),
  })) : [];
  records.sort((left, right) => (
    left.path.localeCompare(right.path) || left.content.localeCompare(right.content)
  ));
  return new TextEncoder().encode(`${JSON.stringify({ format: SKILL_PACKAGE_FORMAT, files: records })}\n`);
}

export function encodeBytesBase64(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return globalThis.btoa(parts.join(""));
}

export function createWorkbenchApiClient({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  eventSourceFactory = (url, options) => new EventSource(url, options),
  idFactory = defaultIdFactory,
  basePath = API_PREFIX,
  reviewMode = import.meta.env?.VITE_REVIEW_MODE || "",
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("workbench_fetch_required");
  let csrfToken = "";
  let sessionRefreshPromise = null;
  let sessionEpoch = 0;
  let sessionPrincipal = "";
  const productClientOptions = {
    fetch: fetchImpl,
    basePath,
    csrfToken: (operationId) => (
      PUBLIC_AUTH_MUTATION_OPERATIONS.has(operationId) ? undefined : (csrfToken || undefined)
    ),
  };
  const workspaceProductClient = createWorkspaceProductClient(productClientOptions);
  const authProductClient = createAuthProductClient(productClientOptions);
  const readinessProductClient = createReadinessProductClient(productClientOptions);
  const inboxProductClient = createInboxProductClient(productClientOptions);
  const automationProductClient = createAutomationProductClient(productClientOptions);
  const deviceProductClient = createDeviceProductClient(productClientOptions);
  const scopeProductClient = createScopeProductClient(productClientOptions);
  const runProductClient = createRunProductClient(productClientOptions);
  const workItemProductClient = createWorkItemProductClient(productClientOptions);
  let modelProductClientPromise = null;

  function modelProductClient() {
    if (!modelProductClientPromise) {
      modelProductClientPromise = import("@looloomi/product-client/model")
        .then(({ createModelProductClient }) => createModelProductClient(productClientOptions));
    }
    return modelProductClientPromise;
  }

  function installSession(result) {
    const nextToken = result.data?.session?.csrfToken || "";
    const nextUserId = result.data?.session?.userId || "";
    const nextWorkspaceId = result.data?.session?.workspaceId || "";
    const nextPrincipal = nextUserId && nextWorkspaceId
      ? `${nextUserId}:${nextWorkspaceId}`
      : "";
    if (!nextToken || !nextPrincipal) {
      throw new WorkbenchApiError({
        code: "workspace_session_invalid",
        message: "The Workbench session could not be initialized.",
      });
    }
    if (sessionPrincipal && sessionPrincipal !== nextPrincipal) sessionEpoch += 1;
    csrfToken = nextToken;
    sessionPrincipal = nextPrincipal;
    return result;
  }

  function refreshSession() {
    if (!sessionRefreshPromise) {
      const refreshEpoch = sessionEpoch;
      let activeRefresh;
      activeRefresh = requestProduct(workspaceProductClient, "workspace", {})
        .then((result) => {
          if (sessionEpoch !== refreshEpoch) {
            throw principalChanged();
          }
          return installSession(result);
        })
        .finally(() => {
          if (sessionRefreshPromise === activeRefresh) sessionRefreshPromise = null;
        });
      sessionRefreshPromise = activeRefresh;
    }
    return sessionRefreshPromise;
  }

  async function installAuthenticatedSession(result) {
    const workspaceResult = await refreshSession();
    const authPrincipal = `${result.data.user.userId}:${result.data.workspaceId}`;
    const workspacePrincipal = `${workspaceResult.data.session.userId}:${workspaceResult.data.session.workspaceId}`;
    if (authPrincipal !== workspacePrincipal) {
      client.resetSession();
      throw new WorkbenchApiError({
        code: "auth_session_principal_mismatch",
        message: "The authenticated account does not match the active workspace session.",
        status: 409,
      });
    }
    return result;
  }

  async function request(path, {
    method = "GET",
    data,
    ifMatch,
    idempotencyKey,
    query,
    signal,
    keepalive = false,
    retrySession = true,
    publicMutation = false,
  } = {}) {
    const mutation = method !== "GET";
    if (mutation) ensureVisualMutationAllowed(path);
    if (mutation && !publicMutation && !csrfToken) {
      if (retrySession) await refreshSession();
      else {
        throw new WorkbenchApiError({
          code: "workspace_session_required",
          message: "Open the workspace before making changes.",
          status: 401,
        });
      }
    }
    const requestEpoch = sessionEpoch;
    const requestPrincipal = sessionPrincipal;
    const headers = { Accept: "application/json" };
    const resolvedIdempotencyKey = mutation && !publicMutation
      ? (idempotencyKey || idFactory())
      : idempotencyKey;
    let body;
    if (mutation) {
      headers["Content-Type"] = "application/json";
      if (resolvedIdempotencyKey) headers["Idempotency-Key"] = resolvedIdempotencyKey;
      if (!publicMutation) headers["X-Workbench-CSRF"] = csrfToken;
      if (ifMatch) headers["If-Match"] = ifMatch;
      body = JSON.stringify({ schemaVersion: "workbench-api-v1", data });
    }
    let response;
    try {
      response = await fetchImpl(`${basePath}${path}${queryString(query)}`, {
        method,
        headers,
        body,
        credentials: "same-origin",
        signal,
        keepalive,
      });
    } catch (error) {
      throw new WorkbenchApiError({
        code: "workbench_unreachable",
        message: "The local Workbench service could not be reached.",
        details: { reason: error?.message || "network_error" },
        retryable: true,
      });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const sessionRejected = response.status === 401
        || (response.status === 403 && payload?.code === "csrf_invalid");
      if (mutation && !publicMutation && retrySession && sessionRejected) {
        csrfToken = "";
        await refreshSession();
        if (
          sessionEpoch !== requestEpoch
          || !requestPrincipal
          || sessionPrincipal !== requestPrincipal
        ) {
          throw principalChanged();
        }
        return request(path, {
          method,
          data,
          ifMatch,
          idempotencyKey: resolvedIdempotencyKey,
          query,
          retrySession: false,
          publicMutation,
          signal,
          keepalive,
        });
      }
      throw new WorkbenchApiError({
        ...(payload && typeof payload === "object" ? payload : {}),
        status: response.status,
      });
    }
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new WorkbenchApiError({
        code: "workbench_response_invalid",
        message: "The Workbench returned an invalid response.",
        status: response.status,
      });
    }
    return {
      data: payload.data,
      page: payload.page,
      requestId: payload.requestId,
      etag: response.headers.get("etag"),
    };
  }

  async function requestSessionProduct(operationId, input, {
    signal,
    retrySession = true,
  } = {}) {
    if (!csrfToken) {
      if (retrySession) await refreshSession();
      else {
        throw new WorkbenchApiError({
          code: "workspace_session_required",
          message: "Open the workspace before making changes.",
          status: 401,
        });
      }
    }
    const requestEpoch = sessionEpoch;
    const requestPrincipal = sessionPrincipal;
    try {
      return await requestProduct(
        await modelProductClient(),
        operationId,
        input,
        { signal },
      );
    } catch (error) {
      const sessionRejected = error instanceof WorkbenchApiError
        && (error.status === 401 || (error.status === 403 && error.code === "csrf_invalid"));
      if (!retrySession || !sessionRejected) throw error;
      csrfToken = "";
      await refreshSession();
      if (
        sessionEpoch !== requestEpoch
        || !requestPrincipal
        || sessionPrincipal !== requestPrincipal
      ) {
        throw principalChanged();
      }
      return requestSessionProduct(operationId, input, {
        signal,
        retrySession: false,
      });
    }
  }

  async function requestArtifactContent(path) {
    let response;
    try {
      response = await fetchImpl(`${basePath}${path}`, {
        method: "GET",
        headers: { Accept: "image/png, image/jpeg, image/webp" },
        credentials: "same-origin",
      });
    } catch (error) {
      throw new WorkbenchApiError({
        code: "workbench_unreachable",
        message: "The local Workbench service could not be reached.",
        details: { reason: error?.message || "network_error" },
        retryable: true,
      });
    }
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // An authorization intermediary may return an empty body.
      }
      throw new WorkbenchApiError({
        ...(payload && typeof payload === "object" ? payload : {}),
        status: response.status,
      });
    }
    const mediaType = String(response.headers.get("content-type") || "").split(";", 1)[0];
    if (!["image/png", "image/jpeg", "image/webp"].includes(mediaType)) {
      throw new WorkbenchApiError({
        code: "artifact_response_invalid",
        message: "The generated image has an unsupported format.",
        status: response.status,
      });
    }
    return {
      blob: await response.blob(),
      mediaType,
      byteLength: Number(response.headers.get("content-length") || 0),
      etag: response.headers.get("etag"),
    };
  }

  const client = {
    authStatus() {
      return requestProduct(authProductClient, "authStatus", {});
    },
    async register(data, options = {}) {
      ensureVisualMutationAllowed("/auth/register");
      const result = await requestProduct(authProductClient, "register", {
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      });
      return installAuthenticatedSession(result);
    },
    async login(data) {
      const result = await requestProduct(authProductClient, "login", {
        body: { schemaVersion: "workbench-api-v1", data },
      });
      return installAuthenticatedSession(result);
    },
    async logout() {
      ensureVisualMutationAllowed("/auth/logout");
      if (!csrfToken) {
        throw new WorkbenchApiError({
          code: "workspace_session_required",
          message: "Open the workspace before making changes.",
          status: 401,
        });
      }
      const result = await requestProduct(authProductClient, "logout", {
        body: { schemaVersion: "workbench-api-v1", data: {} },
      });
      client.resetSession();
      return result;
    },
    listMembers(options = {}) {
      return requestProduct(authProductClient, "listMembers", {}, options);
    },
    updateMember(userId, data, options = {}) {
      return requestProduct(authProductClient, "updateMember", {
        pathParams: { userId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    listInvitations(options = {}) {
      return requestProduct(authProductClient, "listInvitations", {}, options);
    },
    createInvitation(data, options = {}) {
      ensureVisualMutationAllowed("/workspace/invitations");
      return requestProduct(authProductClient, "createInvitation", {
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    revokeInvitation(invitationId, options = {}) {
      ensureVisualMutationAllowed(`/workspace/invitations/${encoded(invitationId)}/revoke`);
      return requestProduct(authProductClient, "revokeInvitation", {
        pathParams: { invitationId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data: {} },
      }, options);
    },
    resendInvitation(invitationId, options = {}) {
      ensureVisualMutationAllowed(`/workspace/invitations/${encoded(invitationId)}/resend`);
      return requestProduct(authProductClient, "resendInvitation", {
        pathParams: { invitationId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data: {} },
      }, options);
    },
    inspectInvitation(token, options = {}) {
      return requestProduct(authProductClient, "inspectInvitation", {
        body: { schemaVersion: "workbench-api-v1", data: { token } },
      }, options);
    },
    startOAuth(provider, { token, bindExistingAccount = false } = {}, options = {}) {
      return requestProduct(authProductClient, "startOAuth", {
        pathParams: { provider },
        body: {
          schemaVersion: "workbench-api-v1",
          data: { token, ...(bindExistingAccount ? { bindExistingAccount: true } : {}) },
        },
      }, options);
    },
    listOwnNativeClientSessions(options = {}) {
      return requestProduct(authProductClient, "listOwnNativeClientSessions", {}, options);
    },
    revokeOwnNativeClientSession(clientSessionId, options = {}) {
      ensureVisualMutationAllowed(`/auth/native/sessions/${encoded(clientSessionId)}/revoke`);
      return requestProduct(authProductClient, "revokeOwnNativeClientSession", {
        pathParams: { clientSessionId }, body: { schemaVersion: "workbench-api-v1", data: {} },
      }, options);
    },
    approveNativeAuthorization(authorizationId, options = {}) {
      return requestProduct(authProductClient, "approveNativeAuthorization", {
        body: {
          schemaVersion: "workbench-api-v1",
          data: { authorizationId },
        },
      }, options);
    },
    async bootstrap() {
      return refreshSession();
    },
    getWorkspaceFeatureReadiness(options = {}) {
      return requestProduct(
        readinessProductClient,
        "getWorkspaceFeatureReadiness",
        {},
        options,
      );
    },
    listScopes(options = {}) {
      return requestProduct(scopeProductClient, "listScopes", {}, options);
    },
    getScope(scopeId, options = {}) {
      return requestProduct(scopeProductClient, "getScope", {
        pathParams: { scopeId },
      }, options);
    },
    reviseScopePolicy(scopeId, data, { ifMatch, idempotencyKey, ...options } = {}) {
      ensureVisualMutationAllowed(`/scopes/${encoded(scopeId)}/policy`);
      return requestProduct(scopeProductClient, "reviseScopePolicy", {
        pathParams: { scopeId },
        headers: {
          "Idempotency-Key": idempotencyKey || idFactory(),
          "If-Match": ifMatch,
        },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    listAutomations(query = {}, options = {}) {
      return requestProduct(automationProductClient, "listAutomations", { query }, options);
    },
    listAutomationCandidates(query = {}, options = {}) {
      return requestProduct(automationProductClient, "listAutomationCandidates", { query }, options);
    },
    createAutomation(data, { idempotencyKey, ...options } = {}) {
      ensureVisualMutationAllowed("/automations");
      return requestProduct(automationProductClient, "createAutomation", {
        headers: { "Idempotency-Key": idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    getAutomation(automationId, options = {}) {
      return requestProduct(automationProductClient, "getAutomation", {
        pathParams: { automationId },
      }, options);
    },
    reviseAutomation(automationId, data, { ifMatch, idempotencyKey, ...options } = {}) {
      ensureVisualMutationAllowed(`/automations/${encoded(automationId)}`);
      return requestProduct(automationProductClient, "reviseAutomation", {
        pathParams: { automationId },
        headers: {
          "Idempotency-Key": idempotencyKey || idFactory(),
          "If-Match": ifMatch,
        },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    transitionAutomation(automationId, transition, { ifMatch, idempotencyKey, ...options } = {}) {
      const operations = {
        activate: "activateAutomation",
        pause: "pauseAutomation",
        archive: "archiveAutomation",
      };
      const operationId = operations[transition];
      if (!operationId) throw new WorkbenchApiError({
        code: "automation_transition_invalid",
        message: "This Automation transition is not supported.",
      });
      ensureVisualMutationAllowed(`/automations/${encoded(automationId)}/${transition}`);
      return requestProduct(automationProductClient, operationId, {
        pathParams: { automationId },
        headers: {
          "Idempotency-Key": idempotencyKey || idFactory(),
          "If-Match": ifMatch,
        },
        body: { schemaVersion: "workbench-api-v1", data: {} },
      }, options);
    },
    listAutomationOccurrences(automationId, query = {}, options = {}) {
      return requestProduct(automationProductClient, "listAutomationOccurrences", {
        pathParams: { automationId },
        query,
      }, options);
    },
    listDevices(options = {}) {
      return requestProduct(deviceProductClient, "listDevices", {}, options);
    },
    revokeDevice(deviceId, data = {}, options = {}) {
      ensureVisualMutationAllowed(`/devices/${encoded(deviceId)}/revoke`);
      return requestProduct(deviceProductClient, "revokeDevice", {
        pathParams: { deviceId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    getActiveSession() { return request("/session"); },
    listRecentWork(query) { return request("/recent-work", { query }); },
    async createModelProfile(data, options = {}) {
      ensureVisualMutationAllowed("/model-profiles");
      return requestProduct(await modelProductClient(), "createModelProfile", {
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    async listModelProfiles({ profileId, capabilities = [], context, selectedRevisionId, readiness, cursor, limit } = {}, options = {}) {
      const query = {};
      if (profileId) query.profileId = profileId;
      if (capabilities.length) query.capabilities = capabilities.join(",");
      if (context) query.context = context;
      if (selectedRevisionId) query.selectedRevisionId = selectedRevisionId;
      if (readiness) query.readiness = readiness;
      if (cursor) query.cursor = cursor;
      if (limit !== undefined && limit !== null) query.limit = limit;
      return requestProduct(
        await modelProductClient(),
        "listModelProfiles",
        { query },
        options,
      );
    },
    listAgentDefinitions() { return request("/agent-definitions"); },
    listAgentSessions(query, options = {}) { return request("/agent-sessions", { query, ...options }); },
    createAgentSession(data, options = {}) {
      return request("/agent-sessions", { method: "POST", data, ...options });
    },
    getAgentSession(sessionId, options = {}) { return request(`/agent-sessions/${encoded(sessionId)}`, options); },
    promoteAgentSessionToWorkItem(sessionId, data, options = {}) {
      ensureVisualMutationAllowed(`/agent-sessions/${encoded(sessionId)}/promote-to-work-item`);
      return requestProduct(workItemProductClient, "promoteAgentSessionToWorkItem", {
        pathParams: { sessionId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    listProjects(query = {}, options = {}) {
      return requestProduct(workItemProductClient, "listProjects", { query }, options);
    },
    createProject(data, { idempotencyKey, ...options } = {}) {
      ensureVisualMutationAllowed("/projects");
      return requestProduct(workItemProductClient, "createProject", {
        headers: { "Idempotency-Key": idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    getProject(projectId, options = {}) {
      return requestProduct(workItemProductClient, "getProject", {
        pathParams: { projectId },
      }, options);
    },
    reviseProjectMembers(projectId, data, { ifMatch, idempotencyKey, ...options } = {}) {
      ensureVisualMutationAllowed(`/projects/${encoded(projectId)}/members`);
      return requestProduct(workItemProductClient, "reviseProjectMembers", {
        pathParams: { projectId },
        headers: {
          "Idempotency-Key": idempotencyKey || idFactory(),
          "If-Match": ifMatch,
        },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    listWorkItems(query = {}, options = {}) {
      return requestProduct(workItemProductClient, "listWorkItems", { query }, options);
    },
    createTeamWorkItem(data, { idempotencyKey, ...options } = {}) {
      ensureVisualMutationAllowed("/work-items");
      return requestProduct(workItemProductClient, "createTeamWorkItem", {
        headers: { "Idempotency-Key": idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    createTeamWorkItemAgentEntry(data, { idempotencyKey, ...options } = {}) {
      ensureVisualMutationAllowed("/work-items/agent-entry");
      return requestProduct(workItemProductClient, "createTeamWorkItemAgentEntry", {
        headers: { "Idempotency-Key": idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    updateTeamWorkItem(workItemId, data, { ifMatch, idempotencyKey, ...options } = {}) {
      ensureVisualMutationAllowed(`/work-items/${encoded(workItemId)}`);
      return requestProduct(workItemProductClient, "updateTeamWorkItem", {
        pathParams: { workItemId },
        headers: {
          "Idempotency-Key": idempotencyKey || idFactory(),
          "If-Match": ifMatch,
        },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    listWorkItemPromotionParticipants(options = {}) {
      return requestProduct(workItemProductClient, "listWorkItemPromotionParticipants", {}, options);
    },
    getWorkItem(workItemId, options = {}) {
      return requestProduct(workItemProductClient, "getWorkItem", {
        pathParams: { workItemId },
      }, options);
    },
    listWorkItemLoopRuns(workItemId, options = {}) {
      return requestProduct(workItemProductClient, "listWorkItemLoopRuns", { pathParams: { workItemId } }, options);
    },
    startWorkItemLoopRun(workItemId, data, { idempotencyKey, ...options } = {}) {
      ensureVisualMutationAllowed(`/work-items/${encoded(workItemId)}/loop-runs`);
      return requestProduct(workItemProductClient, "startWorkItemLoopRun", {
        pathParams: { workItemId }, headers: { "Idempotency-Key": idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    listWorkItemThreadEntries(workItemId, query = {}, options = {}) {
      return requestProduct(workItemProductClient, "listWorkItemThreadEntries", {
        pathParams: { workItemId },
        query,
      }, options);
    },
    createWorkItemThreadComment(workItemId, data, options = {}) {
      ensureVisualMutationAllowed(`/work-items/${encoded(workItemId)}/thread-entries`);
      return requestProduct(workItemProductClient, "createWorkItemThreadComment", {
        pathParams: { workItemId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    recordWorkItemDecision(workItemId, data, options = {}) {
      ensureVisualMutationAllowed(`/work-items/${encoded(workItemId)}/decisions`);
      return requestProduct(workItemProductClient, "recordWorkItemDecision", {
        pathParams: { workItemId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    createWorkItemContinuation(workItemId, options = {}) {
      ensureVisualMutationAllowed(`/work-items/${encoded(workItemId)}/continuations`);
      return requestProduct(workItemProductClient, "createWorkItemContinuation", {
        pathParams: { workItemId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data: {} },
      }, options);
    },
    createWorkItemContinuationAgentEntry(workItemId, data, options = {}) {
      ensureVisualMutationAllowed(`/work-items/${encoded(workItemId)}/agent-entry`);
      return requestProduct(workItemProductClient, "createWorkItemContinuationAgentEntry", {
        pathParams: { workItemId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    revokeWorkItemAccessGrant(workItemId, grantId, options = {}) {
      ensureVisualMutationAllowed(`/work-items/${encoded(workItemId)}/access-grants/${encoded(grantId)}/revoke`);
      return requestProduct(workItemProductClient, "revokeWorkItemAccessGrant", {
        pathParams: { workItemId, grantId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data: {} },
      }, options);
    },
    selectAgentSessionModel(sessionId, data, options = {}) {
      ensureVisualMutationAllowed(`/agent-sessions/${encoded(sessionId)}/model`);
      return requestSessionProduct("selectAgentSessionModel", {
        pathParams: { sessionId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, { signal: options.signal });
    },
    listAgentTurns(sessionId, query, options = {}) {
      return request(`/agent-sessions/${encoded(sessionId)}/turns`, { query, ...options });
    },
    createAgentTurn(sessionId, data, options = {}) {
      return request(`/agent-sessions/${encoded(sessionId)}/turns`, { method: "POST", data, ...options });
    },
    getAgentTurn(sessionId, turnId, options = {}) {
      return request(`/agent-sessions/${encoded(sessionId)}/turns/${encoded(turnId)}`, options);
    },
    cancelAgentTurn(sessionId, turnId, data = {}, options = {}) {
      return request(`/agent-sessions/${encoded(sessionId)}/turns/${encoded(turnId)}/cancel`, {
        method: "POST",
        data,
        ...options,
      });
    },
    listAgentSessionEvents(sessionId, query, options = {}) {
      return request(`/agent-sessions/${encoded(sessionId)}/events`, { query, ...options });
    },
    getAgentProposal(sessionId, proposalId, options = {}) {
      return request(
        `/agent-sessions/${encoded(sessionId)}/proposals/${encoded(proposalId)}`,
        options,
      );
    },
    applyAgentProposal(sessionId, proposalId, options = {}) {
      return request(
        `/agent-sessions/${encoded(sessionId)}/proposals/${encoded(proposalId)}/apply`,
        { method: "POST", data: {}, ...options },
      );
    },
    rejectAgentProposal(sessionId, proposalId, options = {}) {
      return request(
        `/agent-sessions/${encoded(sessionId)}/proposals/${encoded(proposalId)}/reject`,
        { method: "POST", data: {}, ...options },
      );
    },
    listAttachments(query, options = {}) { return request("/attachments", { query, ...options }); },
    getAttachment(attachmentId, options = {}) {
      return request(`/attachments/${encoded(attachmentId)}`, options);
    },
    createAttachment(data, options = {}) {
      return request("/attachments", { method: "POST", data, ...options });
    },
    retryAttachment(attachmentId, options = {}) {
      return request(`/attachments/${encoded(attachmentId)}/retry`, {
        method: "POST",
        data: {},
        ...options,
      });
    },
    deleteAttachment(attachmentId, options = {}) {
      return request(`/attachments/${encoded(attachmentId)}`, {
        method: "DELETE",
        data: {},
        ...options,
      });
    },
    getInbox(query = {}, options = {}) {
      return requestProduct(inboxProductClient, "getInbox", { query }, options);
    },
    listSkills(query) { return request("/skills", { query }); },
    listSkillAssets(query) { return request("/skill-assets", { query }); },
    listSkillRuntimes() { return request("/skill-runtimes"); },
    listRegisteredToolPackages() { return request("/registered-tool-packages"); },
    getSkill(skillId) { return request(`/skills/${encoded(skillId)}`); },
    createSkill(data, options = {}) { return request("/skills", { method: "POST", data, ...options }); },
    getSkillDraft(skillId, draftId) {
      return request(`/skills/${encoded(skillId)}/drafts/${encoded(draftId)}`);
    },
    getSkillDraftPackage(skillId, draftId) {
      return request(`/skills/${encoded(skillId)}/drafts/${encoded(draftId)}/package`);
    },
    replaceSkillDraftPackage(skillId, draftId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/skills/${encoded(skillId)}/drafts/${encoded(draftId)}/package`, {
        method: "PUT",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    createNextSkillDraft(skillId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/skills/${encoded(skillId)}/drafts`, { method: "POST", data, ifMatch, idempotencyKey });
    },
    updateSkillDraft(skillId, draftId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/skills/${encoded(skillId)}/drafts/${encoded(draftId)}`, {
        method: "PATCH",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    createSkillTest(skillId, draftId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/skills/${encoded(skillId)}/drafts/${encoded(draftId)}/tests`, {
        method: "POST",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    getSkillTestRun(skillId, testRunId) {
      return request(`/skills/${encoded(skillId)}/tests/${encoded(testRunId)}`);
    },
    createSkillValidation(skillId, draftId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/skills/${encoded(skillId)}/drafts/${encoded(draftId)}/validations`, {
        method: "POST",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    getSkillValidation(skillId, validationId) {
      return request(`/skills/${encoded(skillId)}/validations/${encoded(validationId)}`);
    },
    scaffoldSkillDraftPackage(data, options = {}) {
      return request("/skill-draft-packages/scaffold", { method: "POST", data, ...options });
    },
    listSkillVersions(skillId) { return request(`/skills/${encoded(skillId)}/versions`); },
    getSkillUsage(skillId) { return request(`/skills/${encoded(skillId)}/usage`); },
    getSkillVersionDiff(skillId, fromVersionId, toVersionId) {
      return request(`/skills/${encoded(skillId)}/versions/${encoded(fromVersionId)}/diff/${encoded(toVersionId)}`);
    },
    deprecateSkill(skillId, data, options = {}) {
      return request(`/skills/${encoded(skillId)}/deprecate`, { method: "POST", data, ...options });
    },
    publishSkill(skillId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/skills/${encoded(skillId)}/publish`, { method: "POST", data, ifMatch, idempotencyKey });
    },
    createUpload(data, options = {}) { return request("/uploads", { method: "POST", data, ...options }); },
    importSkillRepository(data, options = {}) {
      return request("/uploads/repository", { method: "POST", data, ...options });
    },
    scanServerSkills(data) {
      return request("/skills/scan", { method: "POST", data });
    },
    importServerSkills(data, options = {}) {
      return request("/skills/import", { method: "POST", data, ...options });
    },
    uploadSkillPackage(uploadId, data, options = {}) {
      return request(`/uploads/${encoded(uploadId)}/package`, { method: "POST", data, ...options });
    },
    uploadChunk(uploadId, chunkIndex, data, options = {}) {
      return request(`/uploads/${encoded(uploadId)}/chunks/${encoded(chunkIndex)}`, {
        method: "PUT",
        data,
        ...options,
      });
    },
    completeUpload(uploadId, options = {}) {
      return request(`/uploads/${encoded(uploadId)}/complete`, { method: "POST", data: {}, ...options });
    },
    getUpload(uploadId) { return request(`/uploads/${encoded(uploadId)}`); },
    promoteUpload(uploadId, data = {}, options = {}) {
      return request(`/uploads/${encoded(uploadId)}/promote`, { method: "POST", data, ...options });
    },
    listResources(query) { return request("/resources", { query }); },
    getResource(resourceId) { return request(`/resources/${encoded(resourceId)}`); },
    createResource(data, options = {}) { return request("/resources", { method: "POST", data, ...options }); },
    createResourceFromAttachment(data, options = {}) {
      return request("/resources/from-attachment", { method: "POST", data, ...options });
    },
    listConnections(query) { return request("/connections", { query }); },
    getConnection(connectionId) { return request(`/connections/${encoded(connectionId)}`); },
    createConnection(data, options = {}) {
      return request("/connections", { method: "POST", data, ...options });
    },
    updateConnection(connectionId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/connections/${encoded(connectionId)}`, {
        method: "PATCH",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    validateConnection(connectionId, { ifMatch, idempotencyKey } = {}) {
      return request(`/connections/${encoded(connectionId)}/validate`, {
        method: "POST",
        data: {},
        ifMatch,
        idempotencyKey,
      });
    },
    bindConnectionCredential(connectionId, secretRef, { ifMatch, idempotencyKey } = {}) {
      return request(`/connections/${encoded(connectionId)}/credential-binding`, {
        method: "POST",
        data: { secretRef },
        ifMatch,
        idempotencyKey,
      });
    },
    createLoop(data, options = {}) { return request("/loops", { method: "POST", data, ...options }); },
    createLoopFromRelease(releaseId, data = {}, options = {}) {
      return request(`/team-library/${encoded(releaseId)}/workflows`, { method: "POST", data, ...options });
    },
    listTemplates(query) { return request("/templates", { query }); },
    getNativeSkillPackage(releaseId) { return request(`/team-library/${encoded(releaseId)}/native-skill-package`); },
    listTeamLibrary(query) { return request("/team-library", { query }); },
    installTeamRelease(releaseId, data = { connectionIds: [], connectionBindings: [] }, options = {}) {
      return request(`/team-library/${encoded(releaseId)}/install`, { method: "POST", data, ...options });
    },
    listInstallations(query) { return request("/installations", { query }); },
    getInstallation(installationId) { return request(`/installations/${encoded(installationId)}`); },
    getInstallationUpdateImpact(installationId, releaseId, options = {}) {
      return request(`/installations/${encoded(installationId)}/update-impact`, {
        query: { releaseId },
        ...options,
      });
    },
    createInstallationUpdateDraft(installationId, data, options = {}) {
      return request(`/installations/${encoded(installationId)}/update-drafts`, {
        method: "POST",
        data,
        ...options,
      });
    },
    getInstallationUpdateDraft(updateDraftId, options = {}) {
      return request(`/installation-update-drafts/${encoded(updateDraftId)}`, options);
    },
    refreshInstallationUpdateDraft(updateDraftId, data = {}, options = {}) {
      return request(`/installation-update-drafts/${encoded(updateDraftId)}/refresh`, {
        method: "POST",
        data,
        ...options,
      });
    },
    confirmInstallationUpdateDraft(updateDraftId, data = {}, options = {}) {
      return request(`/installation-update-drafts/${encoded(updateDraftId)}/confirm`, {
        method: "POST",
        data,
        ...options,
      });
    },
    keepCurrentInstallationVersion(updateDraftId, options = {}) {
      return request(`/installation-update-drafts/${encoded(updateDraftId)}/keep-current`, {
        method: "POST",
        data: {},
        ...options,
      });
    },
    getTemplate(templateId) { return request(`/templates/${encoded(templateId)}`); },
    listWorkflows(query) { return request("/workflows", { query }); },
    getWorkflow(workflowId) { return request(`/workflows/${encoded(workflowId)}`); },
    getWorkflowRevision(workflowId, revisionId) {
      return request(`/workflows/${encoded(workflowId)}/revisions/${encoded(revisionId)}`);
    },
    saveWorkflowRevision(workflowId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/workflows/${encoded(workflowId)}/revisions`, {
        method: "POST",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    saveLoopRevision(workflowId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/loops/${encoded(workflowId)}/revisions`, {
        method: "POST",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    generateStagedLoopProposal(data, { idempotencyKey } = {}) {
      return request("/loop-draft-proposals", { method: "POST", data, idempotencyKey });
    },
    getStagedLoopProposal(proposalId) {
      return request(`/loop-draft-proposals/${encoded(proposalId)}`);
    },
    commitStagedLoopProposal(proposalId, data, { idempotencyKey } = {}) {
      return request(`/loop-draft-proposals/${encoded(proposalId)}/commit`, {
        method: "POST",
        data,
        idempotencyKey,
      });
    },
    dismissStagedLoopProposal(proposalId, { idempotencyKey } = {}) {
      return request(`/loop-draft-proposals/${encoded(proposalId)}/dismiss`, {
        method: "POST",
        data: {},
        idempotencyKey,
      });
    },
    publishLoop(workflowId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/loops/${encoded(workflowId)}/publish`, { method: "POST", data, ifMatch, idempotencyKey });
    },
    compileWorkflow(workflowId, workflowRevisionId, options = {}) {
      return request(`/workflows/${encoded(workflowId)}/compile`, {
        method: "POST",
        data: { workflowRevisionId },
        ...options,
      });
    },
    startRun(workflowId, data, options = {}) {
      return request(`/workflows/${encoded(workflowId)}/runs`, { method: "POST", data, ...options });
    },
    startLoopAgentTask(workflowId, data, options = {}) {
      return request(`/loops/${encoded(workflowId)}/agent-tasks`, {
        method: "POST",
        data,
        ...options,
      });
    },
    listWorkflowRuns(workflowId, query) {
      return request(`/workflows/${encoded(workflowId)}/runs`, { query });
    },
    getRun(runId, options = {}) {
      return requestProduct(runProductClient, "getRun", {
        pathParams: { runId },
      }, options);
    },
    listRunInvocations(runId) { return request(`/runs/${encoded(runId)}/invocations`); },
    listRunExecutionEvents(runId, query) {
      return request(`/runs/${encoded(runId)}/execution-events`, { query });
    },
    getArtifact(artifactId) { return request(`/artifacts/${encoded(artifactId)}`); },
    getArtifactContent(artifactId) {
      return requestArtifactContent(`/artifacts/${encoded(artifactId)}/content`);
    },
    artifactContentUrl(artifactId) {
      return `${basePath}/artifacts/${encoded(artifactId)}/content`;
    },
    submitReviewDecision(runId, data, options = {}) {
      ensureVisualMutationAllowed(`/runs/${encoded(runId)}/review-decisions`);
      return requestProduct(runProductClient, "submitReviewDecision", {
        pathParams: { runId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    cancelRun(runId, data = {}, options = {}) {
      ensureVisualMutationAllowed(`/runs/${encoded(runId)}/cancel`);
      return requestProduct(runProductClient, "cancelRun", {
        pathParams: { runId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    retryRun(runId, data = {}, options = {}) {
      ensureVisualMutationAllowed(`/runs/${encoded(runId)}/retry`);
      return requestProduct(runProductClient, "retryRun", {
        pathParams: { runId },
        headers: { "Idempotency-Key": options.idempotencyKey || idFactory() },
        body: { schemaVersion: "workbench-api-v1", data },
      }, options);
    },
    openRunEventStream(runId, { after = 0, onEvent, onError, onOpen } = {}) {
      const source = eventSourceFactory(
        `${basePath}/runs/${encoded(runId)}/events${queryString({ after })}`,
        { withCredentials: true },
      );
      const receive = (message) => {
        try {
          const event = JSON.parse(message.data);
          onEvent?.(event);
        } catch (error) {
          onError?.(new WorkbenchApiError({
            code: "run_event_invalid",
            message: "A run update could not be read.",
            details: { reason: error?.message || "invalid_json" },
          }));
        }
      };
      for (const type of RUN_EVENT_TYPES) source.addEventListener(type, receive);
      if (onError) source.addEventListener("error", onError);
      if (onOpen) source.addEventListener("open", onOpen);
      return source;
    },
    hasSession() { return Boolean(csrfToken); },
    resetSession() {
      sessionEpoch += 1;
      csrfToken = "";
      sessionPrincipal = "";
      sessionRefreshPromise = null;
    },
  };

  function ensureVisualMutationAllowed(path) {
    if (reviewMode === "visual-only" && path !== "/auth/login") {
      throw new WorkbenchApiError({
        code: "visual_review_mutation_forbidden",
        message: "The visual review environment cannot change product data.",
        status: 409,
      });
    }
  }

  return Object.freeze(client);
}

async function requestProduct(productClient, operationId, input, options = {}) {
  try {
    const response = await productClient.call(operationId, input, options);
    return {
      data: response.body.data,
      page: response.body.page,
      requestId: response.body.requestId,
      etag: response.headers.ETag || null,
    };
  } catch (error) {
    if (error instanceof ProductApiError) {
      throw new WorkbenchApiError({
        code: error.code,
        message: error.message,
        details: error.details,
        retryable: error.retryable,
        requestId: error.requestId,
        status: error.status,
      });
    }
    if (error instanceof ProductClientProtocolError) {
      if (error.stage === "transport") {
        throw new WorkbenchApiError({
          code: "workbench_unreachable",
          message: "The local Workbench service could not be reached.",
          details: { operationId: error.operationId },
          retryable: true,
        });
      }
      throw new WorkbenchApiError({
        code: "workbench_response_invalid",
        message: "The Workbench returned an invalid response.",
        details: { operationId: error.operationId, stage: error.stage },
        status: error.status || 0,
      });
    }
    throw error;
  }
}

function principalChanged() {
  return new WorkbenchApiError({
    code: "workbench_principal_changed",
    message: "The signed-in user changed before this request completed. The change was not replayed.",
    status: 409,
  });
}

export const workbenchApi = createWorkbenchApiClient();
