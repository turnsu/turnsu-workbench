const API_PREFIX = "/api/workbench/v1";
const SKILL_PACKAGE_FORMAT = "workbench-skill-package-v1";
export const PORTABLE_LOOP_PACKAGE_MEDIA_TYPE = "application/vnd.looloomi.loop-package+json";

export const RUN_EVENT_TYPES = Object.freeze([
  "run.queued",
  "run.started",
  "node.started",
  "node.progress",
  "node.completed",
  "node.failed",
  "review.requested",
  "run.paused",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

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

export function portableLoopFilename(contentDisposition, fallback = "loop.loop.json") {
  const match = String(contentDisposition || "").match(/filename="([A-Za-z0-9][A-Za-z0-9._-]*\.loop\.json)"/i);
  return match?.[1] || fallback;
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
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("workbench_fetch_required");
  let csrfToken = "";
  let sessionRefreshPromise = null;

  function installSession(result) {
    csrfToken = result.data?.session?.csrfToken || "";
    if (!csrfToken) {
      throw new WorkbenchApiError({
        code: "workspace_session_invalid",
        message: "The Workbench session could not be initialized.",
      });
    }
    return result;
  }

  function refreshSession() {
    if (!sessionRefreshPromise) {
      sessionRefreshPromise = request("/workspace", { retrySession: false })
        .then(installSession)
        .finally(() => {
          sessionRefreshPromise = null;
        });
    }
    return sessionRefreshPromise;
  }

  async function request(path, {
    method = "GET",
    data,
    ifMatch,
    idempotencyKey,
    query,
    retrySession = true,
  } = {}) {
    const mutation = method !== "GET";
    if (mutation && !csrfToken) {
      if (retrySession) await refreshSession();
      else {
        throw new WorkbenchApiError({
          code: "workspace_session_required",
          message: "Open the workspace before making changes.",
          status: 401,
        });
      }
    }
    const headers = { Accept: "application/json" };
    const resolvedIdempotencyKey = mutation ? (idempotencyKey || idFactory()) : undefined;
    let body;
    if (mutation) {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = resolvedIdempotencyKey;
      headers["X-Workbench-CSRF"] = csrfToken;
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
      if (mutation && retrySession && sessionRejected) {
        csrfToken = "";
        await refreshSession();
        return request(path, {
          method,
          data,
          ifMatch,
          idempotencyKey: resolvedIdempotencyKey,
          query,
          retrySession: false,
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

  async function requestPortableLoop(path, { query, ifNoneMatch } = {}) {
    const headers = { Accept: PORTABLE_LOOP_PACKAGE_MEDIA_TYPE };
    if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
    let response;
    try {
      response = await fetchImpl(`${basePath}${path}${queryString(query)}`, {
        method: "GET",
        headers,
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

    const etag = response.headers.get("etag");
    const contentDisposition = response.headers.get("content-disposition");
    if (response.status === 304) {
      return {
        bytes: null,
        notModified: true,
        etag,
        filename: portableLoopFilename(contentDisposition),
        mediaType: PORTABLE_LOOP_PACKAGE_MEDIA_TYPE,
      };
    }
    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        // Product-safe error fields are optional when an intermediary rejects the request.
      }
      throw new WorkbenchApiError({
        ...(payload && typeof payload === "object" ? payload : {}),
        status: response.status,
      });
    }
    const mediaType = String(response.headers.get("content-type") || "").split(";", 1)[0];
    if (mediaType !== PORTABLE_LOOP_PACKAGE_MEDIA_TYPE) {
      throw new WorkbenchApiError({
        code: "loop_export_response_invalid",
        message: "The Loop download has an unsupported format.",
        status: response.status,
      });
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      notModified: false,
      etag,
      filename: portableLoopFilename(contentDisposition),
      mediaType,
    };
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
    async bootstrap() {
      return refreshSession();
    },
    getActiveSession() { return request("/session"); },
    listModelProfiles({ capabilities = [], context, selectedRevisionId, readiness, cursor, limit } = {}) {
      return request("/model-profiles", {
        query: {
          capabilities: capabilities.length ? capabilities.join(",") : undefined,
          context,
          selectedRevisionId,
          readiness,
          cursor,
          limit,
        },
      });
    },
    listAgentDefinitions() { return request("/agent-definitions"); },
    createAgentSession(data, options = {}) {
      return request("/agent-sessions", { method: "POST", data, ...options });
    },
    getAgentSession(sessionId) { return request(`/agent-sessions/${encoded(sessionId)}`); },
    selectAgentSessionModel(sessionId, data, options = {}) {
      return request(`/agent-sessions/${encoded(sessionId)}/model`, { method: "POST", data, ...options });
    },
    listAgentTurns(sessionId, query) {
      return request(`/agent-sessions/${encoded(sessionId)}/turns`, { query });
    },
    createAgentTurn(sessionId, data, options = {}) {
      return request(`/agent-sessions/${encoded(sessionId)}/turns`, { method: "POST", data, ...options });
    },
    getAgentTurn(sessionId, turnId) {
      return request(`/agent-sessions/${encoded(sessionId)}/turns/${encoded(turnId)}`);
    },
    cancelAgentTurn(sessionId, turnId, data = {}, options = {}) {
      return request(`/agent-sessions/${encoded(sessionId)}/turns/${encoded(turnId)}/cancel`, {
        method: "POST",
        data,
        ...options,
      });
    },
    listAgentSessionEvents(sessionId, query) {
      return request(`/agent-sessions/${encoded(sessionId)}/events`, { query });
    },
    listSkills(query) { return request("/skills", { query }); },
    listSkillAssets(query) { return request("/skill-assets", { query }); },
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
    createLoop(data, options = {}) { return request("/loops", { method: "POST", data, ...options }); },
    createLoopImport(data, options = {}) {
      return request("/loop-imports", { method: "POST", data, ...options });
    },
    getLoopImport(importId) { return request(`/loop-imports/${encoded(importId)}`); },
    commitLoopImport(importId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/loop-imports/${encoded(importId)}/commit`, {
        method: "POST",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    exportLoop(workflowId, revisionId, { ifNoneMatch } = {}) {
      return requestPortableLoop(`/loops/${encoded(workflowId)}/export`, {
        query: { revisionId },
        ifNoneMatch,
      });
    },
    duplicateLoop(workflowId, data, options = {}) {
      return request(`/loops/${encoded(workflowId)}/duplicate`, { method: "POST", data, ...options });
    },
    listTemplates(query) { return request("/templates", { query }); },
    listTeamLibrary(query) { return request("/team-library", { query }); },
    installTeamRelease(releaseId, data = { connectionIds: [], connectionBindings: [] }, options = {}) {
      return request(`/team-library/${encoded(releaseId)}/install`, { method: "POST", data, ...options });
    },
    listInstallations(query) { return request("/installations", { query }); },
    getInstallation(installationId) { return request(`/installations/${encoded(installationId)}`); },
    adoptInstallationRelease(installationId, data, options = {}) {
      return request(`/installations/${encoded(installationId)}/adopt-release`, { method: "POST", data, ...options });
    },
    useTeamReleaseAsStartingPoint(releaseId, data, options = {}) {
      return request(`/team-library/${encoded(releaseId)}/starting-point`, { method: "POST", data, ...options });
    },
    forkTeamLoopRelease(releaseId, data, options = {}) {
      return request(`/team-library/${encoded(releaseId)}/fork`, { method: "POST", data, ...options });
    },
    getTemplate(templateId) { return request(`/templates/${encoded(templateId)}`); },
    useTemplate(templateId, data, options = {}) {
      return request(`/templates/${encoded(templateId)}/workflows`, { method: "POST", data, ...options });
    },
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
    createLoopSkillUpdate(workflowId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/loops/${encoded(workflowId)}/skill-updates`, {
        method: "POST",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    getLoopSkillUpdatePreview(workflowId, skillVersionId) {
      return request(`/loops/${encoded(workflowId)}/skill-updates/${encoded(skillVersionId)}`);
    },
    generateLoopProposal(workflowId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/loops/${encoded(workflowId)}/proposals`, {
        method: "POST",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    applyLoopProposal(workflowId, proposalId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/loops/${encoded(workflowId)}/proposals/${encoded(proposalId)}/apply`, {
        method: "POST",
        data,
        ifMatch,
        idempotencyKey,
      });
    },
    dismissLoopProposal(workflowId, proposalId, data, { ifMatch, idempotencyKey } = {}) {
      return request(`/loops/${encoded(workflowId)}/proposals/${encoded(proposalId)}/dismiss`, {
        method: "POST",
        data,
        ifMatch,
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
    listWorkflowRuns(workflowId, query) {
      return request(`/workflows/${encoded(workflowId)}/runs`, { query });
    },
    getRun(runId) { return request(`/runs/${encoded(runId)}`); },
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
    getRunComparison(runId, otherRunId) {
      return request(`/runs/${encoded(runId)}/comparison/${encoded(otherRunId)}`);
    },
    createLoopDraftFromRun(runId, data, options = {}) {
      return request(`/runs/${encoded(runId)}/draft`, { method: "POST", data, ...options });
    },
    submitReviewDecision(runId, data, options = {}) {
      return request(`/runs/${encoded(runId)}/review-decisions`, { method: "POST", data, ...options });
    },
    cancelRun(runId, data = {}, options = {}) {
      return request(`/runs/${encoded(runId)}/cancel`, { method: "POST", data, ...options });
    },
    retryRun(runId, data = {}, options = {}) {
      return request(`/runs/${encoded(runId)}/retry`, { method: "POST", data, ...options });
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
  };
  return Object.freeze(client);
}

export const workbenchApi = createWorkbenchApiClient();
