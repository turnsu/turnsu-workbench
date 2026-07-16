import {
  Check,
  Errors,
  ErrorEnvelopeSchema,
  RunEventSchema,
  WORKBENCH_V1_AGENT_ENDPOINTS,
  WORKBENCH_V1_ENDPOINTS,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS,
  WORKBENCH_V1_MEMORY_ENDPOINTS,
} from "@looloomi/workbench-contracts";

import { ProductStoreError } from "../store/index.mjs";
import { createWorkbenchHostValidator } from "../security/workbench-host-validator.mjs";
import { WorkbenchSessionStore, parseCookies, sessionCookie } from "../security/workbench-session-store.mjs";

const JSON_LIMIT = 1_000_000;
const EMPTY = Object.freeze({});
const EMPTY_PAGE = Object.freeze({ nextCursor: null, hasMore: false });

const errorStatus = {
  session_required: 401,
  bearer_not_accepted: 401,
  workspace_access_forbidden: 403,
  workspace_role_forbidden: 403,
  workspace_role_invalid: 400,
  workspace_member_role_invalid: 400,
  workspace_membership_exists: 409,
  membership_management_unavailable: 503,
  invalid_host: 403,
  origin_forbidden: 403,
  fetch_site_forbidden: 403,
  csrf_invalid: 403,
  request_invalid: 400,
  precondition_required: 428,
  workflow_revision_conflict: 412,
  idempotency_key_reused: 409,
  idempotency_in_progress: 409,
  idempotency_claim_lost: 409,
  idempotency_record_incomplete: 409,
  template_read_only: 409,
  skill_not_found: 404,
  template_not_found: 404,
  workflow_not_found: 404,
  workflow_revision_not_found: 404,
  run_not_found: 404,
  route_not_found: 404,
  runner_unavailable: 503,
  run_retry_not_allowed: 409,
  run_comparison_workflow_mismatch: 409,
  run_workspace_missing: 409,
  agent_runtime_unavailable: 503,
  skill_creation_unavailable: 503,
  skill_draft_unavailable: 503,
  skill_draft_not_found: 404,
  skill_upload_not_ready: 409,
  skill_package_object_missing: 409,
  skill_activation_mismatch: 409,
  skill_activation_unavailable: 503,
  skill_publish_unavailable: 503,
  skill_activation_required: 409,
  skill_validation_failed: 409,
  skill_validation_unavailable: 503,
  skill_validation_not_found: 404,
  skill_test_run_not_found: 404,
  skill_draft_stale: 409,
  skill_package_unavailable: 409,
  skill_package_not_promoted: 409,
  skill_package_substituted: 409,
  skill_package_hash_mismatch: 409,
  skill_permission_acknowledgement_required: 400,
  skill_test_cases_invalid: 400,
  skill_test_case_invalid: 400,
  skill_test_run_ids_invalid: 400,
  skill_test_run_ids_duplicate: 400,
  skill_test_run_replayed: 409,
  skill_validation_replayed: 409,
  skill_validation_already_passed: 409,
  skill_validation_reference_invalid: 400,
  skill_validation_hash_invalid: 400,
  skill_validation_id_invalid: 400,
  skill_draft_revision_invalid: 400,
  skill_draft_conflict: 412,
  skill_draft_not_editable: 409,
  skill_draft_update_required: 400,
  skill_owner_required: 403,
  skill_version_not_found: 404,
  skill_version_history_unavailable: 503,
  skill_usage_unavailable: 503,
  skill_deprecation_unavailable: 503,
  skill_deprecation_reason_required: 400,
  skill_not_available_for_new_workflow: 409,
  skill_package_not_publishable: 409,
  skill_version_exists: 409,
  loop_creation_unavailable: 503,
  loop_duplicate_unavailable: 503,
  upload_service_unavailable: 503,
  resource_service_unavailable: 503,
  resource_not_found: 404,
  resource_not_ready: 409,
  resource_integrity_failed: 409,
  resource_label_required: 400,
  resource_media_type_unsupported: 400,
  resource_size_invalid: 400,
  resource_text_invalid: 400,
  resource_text_empty: 400,
  connection_not_found: 404,
  connection_revision_conflict: 412,
  connection_rebind_required: 409,
  connection_not_ready: 409,
  connection_binding_invalid: 400,
  connection_requirement_conflict: 409,
  loop_import_not_found: 404,
  loop_import_revision_conflict: 412,
  loop_import_already_committed: 409,
  loop_import_mapping_required: 400,
  loop_import_mapping_invalid: 409,
  loop_import_material_unavailable: 503,
  loop_upload_not_ready: 409,
  loop_package_invalid: 400,
  loop_package_not_canonical: 400,
  loop_package_too_large: 413,
  loop_package_integrity_failed: 409,
  loop_import_unavailable: 503,
  loop_export_forbidden: 403,
  upload_not_found: 404,
  upload_size_invalid: 400,
  upload_ingest_method_invalid: 400,
  upload_chunk_invalid: 400,
  upload_chunk_size_invalid: 400,
  upload_chunk_conflict: 409,
  upload_incomplete: 409,
  upload_package_invalid: 400,
  upload_state_invalid: 409,
  upload_promotion_blocked: 409,
  upload_review_acknowledgement_required: 409,
  repository_url_invalid: 400,
  repository_ref_invalid: 400,
  repository_directory_invalid: 400,
  repository_skill_not_found: 404,
  repository_file_size_invalid: 400,
  repository_response_invalid: 502,
  repository_import_unavailable: 503,
  loop_publish_unavailable: 503,
  loop_compile_required: 409,
  loop_test_run_required: 409,
  loop_definition_required: 409,
  loop_skill_version_unavailable: 409,
  loop_skill_update_unavailable: 503,
  loop_skill_update_unchanged: 409,
  loop_skill_update_not_found: 409,
  loop_skill_update_ambiguous: 409,
  loop_owner_required: 403,
  builder_proposal_unavailable: 503,
  builder_proposal_invalid: 422,
  builder_proposal_not_found: 404,
  builder_proposal_state_invalid: 409,
  agent_definition_not_found: 404,
  agent_session_not_found: 404,
  agent_turn_not_found: 404,
  agent_handoff_not_found: 404,
  agent_turn_runner_unavailable: 503,
  agent_session_closed: 409,
  agent_turn_not_running: 409,
  main_agent_object_forbidden: 400,
  module_agent_object_invalid: 400,
  agent_object_not_found: 404,
  agent_handoff_target_invalid: 409,
  main_agent_session_required: 409,
  memory_service_unavailable: 503,
  memory_candidate_not_found: 404,
  memory_not_found: 404,
  memory_access_forbidden: 403,
  memory_candidate_state_invalid: 409,
  memory_candidate_invalid: 400,
  memory_query_invalid: 400,
  memory_scope_invalid: 400,
  team_library_unavailable: 503,
  release_not_available: 404,
  installation_not_found: 404,
  test_identity_forbidden: 403,
  test_identity_invalid: 400,
};

const actionByOperation = Object.freeze({
  workspace: "workspace",
  getActiveSession: "getActiveSession",
  listMemberships: "listMemberships",
  addMembership: "addMembership",
  listSkills: "listSkills",
  getSkill: "getSkill",
  createSkill: "createSkill",
  listSkillAssets: "listSkillAssets",
  getSkillDraft: "getSkillDraft",
  updateSkillDraft: "updateSkillDraft",
  getSkillDraftPackage: "getSkillDraftPackage",
  replaceSkillDraftPackage: "replaceSkillDraftPackage",
  createSkillTest: "createSkillTest",
  getSkillTestRun: "getSkillTestRun",
  createSkillValidation: "createSkillValidation",
  getSkillValidation: "getSkillValidation",
  createNextSkillDraft: "createNextSkillDraft",
  getSkillUsage: "getSkillUsage",
  listSkillVersions: "listSkillVersions",
  getSkillVersionDiff: "getSkillVersionDiff",
  deprecateSkill: "deprecateSkill",
  publishSkill: "publishSkill",
  createUpload: "createUpload",
  importSkillRepository: "importSkillRepository",
  uploadPackage: "uploadPackage",
  uploadChunk: "uploadChunk",
  completeUpload: "completeUpload",
  getUpload: "getUpload",
  promoteUpload: "promoteUpload",
  listResources: "listResources",
  createResource: "createResource",
  getResource: "getResource",
  listConnections: "listConnections",
  createConnection: "createConnection",
  getConnection: "getConnection",
  updateConnection: "updateConnection",
  validateConnection: "validateConnection",
  createLoop: "createLoop",
  createLoopImport: "createLoopImport",
  getLoopImport: "getLoopImport",
  commitLoopImport: "commitLoopImport",
  exportLoop: "exportLoop",
  duplicateLoop: "duplicateLoop",
  saveLoopRevision: "saveLoopRevision",
  createLoopSkillUpdate: "createLoopSkillUpdate",
  getLoopSkillUpdatePreview: "getLoopSkillUpdatePreview",
  generateLoopProposal: "generateLoopProposal",
  applyLoopProposal: "applyLoopProposal",
  dismissLoopProposal: "dismissLoopProposal",
  publishLoop: "publishLoop",
  listTeamLibrary: "listTeamLibrary",
  installRelease: "installRelease",
  getInstallation: "getInstallation",
  listInstallations: "listInstallations",
  adoptInstallationRelease: "adoptInstallationRelease",
  useReleaseAsStartingPoint: "useReleaseAsStartingPoint",
  forkTeamLibraryLoop: "forkTeamLibraryLoop",
  listTemplates: "listTemplates",
  getTemplate: "getTemplate",
  useTemplate: "useTemplate",
  listWorkflows: "listWorkflows",
  getWorkflow: "getWorkflow",
  getWorkflowRevision: "getWorkflowRevision",
  saveWorkflowRevision: "saveWorkflowRevision",
  compileWorkflow: "compileWorkflow",
  startRun: "startRun",
  listWorkflowRuns: "listWorkflowRuns",
  getRun: "getRun",
  getRunComparison: "getRunComparison",
  createLoopDraftFromRun: "createLoopDraftFromRun",
  submitReviewDecision: "submitReviewDecision",
  cancelRun: "cancelRun",
  retryRun: "retryRun",
  listAgentDefinitions: "listAgentDefinitions",
  createAgentSession: "createAgentSession",
  getAgentSession: "getAgentSession",
  createAgentTurn: "createAgentTurn",
  getAgentTurn: "getAgentTurn",
  cancelAgentTurn: "cancelAgentTurn",
  listAgentSessionEvents: "listAgentSessionEvents",
  listAgentHandoffs: "listAgentHandoffs",
  confirmAgentHandoff: "confirmAgentHandoff",
  listRunInvocations: "listRunInvocations",
  listRunExecutionEvents: "listRunExecutionEvents",
  listMemoryCandidates: "listMemoryCandidates",
  approveMemoryCandidate: "approveMemoryCandidate",
  rejectMemoryCandidate: "rejectMemoryCandidate",
  listMemories: "listMemories",
  deleteMemory: "deleteMemory",
});

const activeLifecycleEndpoints = [
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getActiveSession,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listMemberships,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.addMembership,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createSkill,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listSkillAssets,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillDraft,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.updateSkillDraft,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillDraftPackage,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.replaceSkillDraftPackage,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createSkillTest,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillTestRun,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createSkillValidation,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillValidation,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createNextSkillDraft,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillUsage,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listSkillVersions,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getSkillVersionDiff,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.deprecateSkill,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getRunComparison,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoopDraftFromRun,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.publishSkill,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createUpload,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.importSkillRepository,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.uploadPackage,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.uploadChunk,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.completeUpload,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getUpload,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.promoteUpload,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listResources,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createResource,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getResource,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listConnections,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createConnection,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getConnection,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.updateConnection,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.validateConnection,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoop,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoopImport,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getLoopImport,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.commitLoopImport,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.exportLoop,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.duplicateLoop,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.saveLoopRevision,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.createLoopSkillUpdate,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getLoopSkillUpdatePreview,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.generateLoopProposal,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.applyLoopProposal,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.dismissLoopProposal,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.publishLoop,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listTeamLibrary,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.installRelease,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.getInstallation,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.listInstallations,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.adoptInstallationRelease,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.useReleaseAsStartingPoint,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.forkTeamLibraryLoop,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.cancelRun,
  WORKBENCH_V1_LIFECYCLE_ENDPOINTS.retryRun,
];

const routeDefinitions = [
  ...Object.values(WORKBENCH_V1_ENDPOINTS),
  ...activeLifecycleEndpoints,
  ...Object.values(WORKBENCH_V1_AGENT_ENDPOINTS),
  ...Object.values(WORKBENCH_V1_MEMORY_ENDPOINTS),
].map((endpoint) => ({
  endpoint,
  pattern: new RegExp(`^${endpoint.path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`),
}));

const errors = (schema, value) => [...Errors(schema, value)].map(({ instancePath, message }) => ({ instancePath, message }));

function parseQuery(url) {
  const value = {};
  for (const [key, raw] of url.searchParams) {
    if (Object.hasOwn(value, key)) return { duplicate: key };
    value[key] = raw;
  }
  for (const key of ["limit", "after"]) {
    if (key in value) {
      if (!/^\d+$/.test(value[key])) return { invalid: key };
      value[key] = Number(value[key]);
    }
  }
  if ("archived" in value) {
    if (value.archived !== "true" && value.archived !== "false") return { invalid: "archived" };
    value.archived = value.archived === "true";
  }
  return { value };
}

function contractHeaders(req, endpoint) {
  const requested = {};
  for (const name of [...endpoint.requiredRequestHeaders, ...endpoint.optionalRequestHeaders]) {
    const value = req.headers[name.toLowerCase()];
    if (value !== undefined) requested[name] = Array.isArray(value) ? value[0] : value;
  }
  return requested;
}

async function readJson(req) {
  let size = 0;
  let source = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new ProductStoreError("request_invalid", "Request body is too large.");
    source += chunk;
  }
  if (!source) throw new ProductStoreError("request_invalid", "JSON request body is required.");
  try { return JSON.parse(source); } catch { throw new ProductStoreError("request_invalid", "Request body must be valid JSON."); }
}

function writeJson(res, status, value, headers = EMPTY, mediaType = "application/json") {
  res.writeHead(status, { "content-type": `${mediaType}; charset=utf-8`, ...headers });
  res.end(JSON.stringify(value));
}

function externalOrigin(req, configuredOrigin) {
  if (configuredOrigin) return configuredOrigin;
  return `http://${req.headers.host}`;
}

function productError(error, requestId) {
  const code = typeof error?.code === "string" ? error.code : "internal_error";
  const status = errorStatus[code] ?? 500;
  const body = {
    code,
    message: status === 500 ? "The Workbench request could not be completed." : (error?.message ?? code),
    details: publicDetails(error?.details),
    retryable: error?.retryable === true
      || code === "runner_unavailable"
      || code === "agent_runtime_unavailable"
      || code === "idempotency_in_progress"
      || code === "idempotency_claim_lost",
    requestId,
  };
  return { status, body };
}

function publicDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return sanitizeDetails(value);
}

function sanitizeDetails(value) {
  const forbidden = new Set([
    "tool", "toolid", "toolname", "provider", "providerid", "providerpayload",
    "artifact", "artifactpath", "secret", "token", "tokenhash", "bearertoken",
    "csrftoken", "schemapath", "filesystempath", "runtimepath",
    "workspaceid", "requestedby", "objectid", "packageobjectid", "packagehash",
    "contenthash", "manifest", "executionref", "publishedby", "updatedby", "authoredby",
  ]);
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !forbidden.has(key.toLowerCase()))
    .map(([key, item]) => [key, sanitizeDetails(item)]));
}

async function requireSession(req, sessionStore) {
  const session = await sessionStore.get(parseCookies(req.headers.cookie).workbench_session);
  if (!session) throw new ProductStoreError("session_required", "A Workbench session is required.");
  return session;
}

async function ensureMutationSecurity({ req, sessionStore, configuredOrigin }) {
  if (req.headers.authorization) throw new ProductStoreError("bearer_not_accepted", "Bearer authentication is not accepted.");
  const session = await requireSession(req, sessionStore);
  if (req.headers.origin !== externalOrigin(req, configuredOrigin)) {
    throw new ProductStoreError("origin_forbidden", "Request Origin does not match this Workbench.");
  }
  if (req.headers["sec-fetch-site"] !== "same-origin") {
    throw new ProductStoreError("fetch_site_forbidden", "Cross-site mutation requests are not accepted.");
  }
  if (req.headers["x-workbench-csrf"] !== session.csrfToken) {
    throw new ProductStoreError("csrf_invalid", "The Workbench CSRF token is invalid.");
  }
  return session;
}

function validate(schema, value, label) {
  if (!Check(schema, value)) {
    throw new ProductStoreError("request_invalid", `${label} does not match the Workbench contract.`, { errors: errors(schema, value) });
  }
}

function responseData(value) {
  return value?.data === undefined ? value : value.data;
}

function responseEnvelope(endpoint, value, requestId) {
  const data = responseData(value);
  const body = endpoint.operationId.startsWith("list")
    ? { schemaVersion: "workbench-api-v1", data: data.data ?? data, page: value?.page ?? data?.page ?? EMPTY_PAGE, requestId }
    : { schemaVersion: "workbench-api-v1", data, requestId };
  if (!Check(endpoint.responseBodySchema, body)) {
    throw new ProductStoreError("internal_response_invalid", "Product response failed its contract check.", { errors: errors(endpoint.responseBodySchema, body) });
  }
  return body;
}

function contractResponse(endpoint, value, requestId) {
  if (endpoint.responseMediaType && endpoint.responseMediaType !== "application/json") {
    const body = responseData(value);
    if (!Check(endpoint.responseBodySchema, body)) {
      throw new ProductStoreError("internal_response_invalid", "Product response failed its contract check.", {
        errors: errors(endpoint.responseBodySchema, body),
      });
    }
    return { body, rawBody: value?.rawBody, mediaType: endpoint.responseMediaType };
  }
  return { body: responseEnvelope(endpoint, value, requestId), mediaType: "application/json" };
}

function writeSse(res, event) {
  if (!Check(RunEventSchema, event)) throw new ProductStoreError("internal_response_invalid", "Run event failed its contract check.");
  res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createWorkbenchHttpHandler({
  application,
  sessionStore = new WorkbenchSessionStore(),
  origin,
  requestIdFactory = () => `request-${crypto.randomUUID()}`,
  sessionTokenFactory,
  csrfTokenFactory,
  clock,
  allowedHosts,
  testIdentityResolver = null,
  internalErrorReporter = null,
} = {}) {
  if (!application) throw new TypeError("workbench_application_required");
  if (internalErrorReporter !== null && typeof internalErrorReporter !== "function") {
    throw new TypeError("workbench_internal_error_reporter_invalid");
  }
  const validateHost = createWorkbenchHostValidator({ allowedHosts, origin });
  if (sessionTokenFactory || csrfTokenFactory || clock) {
    sessionStore = new WorkbenchSessionStore({ tokenFactory: sessionTokenFactory, csrfTokenFactory, clock });
  }
  return async (req, res) => {
    const requestId = requestIdFactory();
    try {
      const requestHost = validateHost(req.headers.host);
      if (req.headers.authorization) {
        throw new ProductStoreError("bearer_not_accepted", "Bearer authentication is not accepted.");
      }
      const url = new URL(req.url, `http://${requestHost}`);
      const route = routeDefinitions.find(({ endpoint, pattern }) => endpoint.method === req.method && pattern.test(url.pathname));
      if (!route) throw new ProductStoreError("route_not_found", "Workbench route not found.");
      const match = route.pattern.exec(url.pathname);
      const path = Object.fromEntries(Object.entries(match?.groups ?? {}).map(([key, value]) => [key, decodeURIComponent(value)]));
      validate(route.endpoint.pathParamsSchema, path, "Path parameters");
      const parsedQuery = parseQuery(url);
      if (parsedQuery.duplicate || parsedQuery.invalid) throw new ProductStoreError("request_invalid", "Query parameters are invalid.");
      const query = parsedQuery.value;
      validate(route.endpoint.querySchema, query, "Query parameters");

      if (route.endpoint.operationId === "workspace") {
        const existing = await sessionStore.get(parseCookies(req.headers.cookie).workbench_session);
        const hasTestIdentityHeader = Boolean(
          req.headers["x-workbench-test-user"] || req.headers["x-workbench-test-workspace"],
        );
        if (hasTestIdentityHeader && typeof testIdentityResolver !== "function") {
          throw new ProductStoreError("test_identity_forbidden", "Test identity headers are not accepted.");
        }
        const testIdentity = hasTestIdentityHeader ? testIdentityResolver(req) : null;
        const bootstrap = existing
          ? null
          : (typeof application.bootstrapSession === "function"
            ? await application.bootstrapSession({ requestId, testIdentity })
            : { userId: "user-local", workspaceId: "workspace-local" });
        const issued = existing
          ? null
          : await sessionStore.issue({
            userId: bootstrap.userId,
            activeWorkspaceId: bootstrap.activeWorkspaceId ?? bootstrap.workspaceId,
          });
        const session = existing ?? issued;
        const data = await application.workspace({ requestId, auth: session });
        data.session = { csrfToken: session.csrfToken, expiresAt: session.expiresAt };
        const body = responseEnvelope(route.endpoint, data, requestId);
        return writeJson(
          res,
          200,
          body,
          issued ? { "set-cookie": sessionCookie(issued.token, 8 * 60 * 60) } : EMPTY,
        );
      }

      const session = await requireSession(req, sessionStore);

      if (route.endpoint.operationId === "getRunEvents") {
        validate(route.endpoint.requestHeadersSchema, contractHeaders(req, route.endpoint), "Request headers");
        const after = query.after ?? Number(req.headers["last-event-id"] ?? 0);
        let unsubscribe = () => {};
        let closed = false;
        let buffering = true;
        let lastSequence = after;
        const buffered = [];
        const close = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
        };
        const deliver = (event) => {
          if (closed || event.sequence <= after || event.sequence <= lastSequence) return;
          writeSse(res, event);
          lastSequence = event.sequence;
        };
        const receive = (event) => {
          if (closed) return;
          if (buffering) buffered.push(event);
          else deliver(event);
        };
        try {
          unsubscribe = await application.subscribe(path.runId, receive, session);
          req.once("close", close);
          res.once("close", close);
          const events = await application.listEvents({ runId: path.runId, after, auth: session });
          if (closed) return;
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const replay = [...events, ...buffered].sort((left, right) => left.sequence - right.sequence);
          for (const event of replay) deliver(event);
          buffered.length = 0;
          buffering = false;
          return;
        } catch (error) {
          close();
          req.off("close", close);
          res.off("close", close);
          throw error;
        }
      }

      let body;
      const headers = contractHeaders(req, route.endpoint);
      if (route.endpoint.mutation) {
        await ensureMutationSecurity({ req, sessionStore, configuredOrigin: origin });
        if (route.endpoint.requiredRequestHeaders.includes("If-Match") && !headers["If-Match"]) {
          throw new ProductStoreError("precondition_required", "If-Match is required before this change can be saved.");
        }
        body = await readJson(req);
        validate(route.endpoint.requestBodySchema, body, "Request body");
      }
      validate(route.endpoint.requestHeadersSchema, headers, "Request headers");
      const action = application[actionByOperation[route.endpoint.operationId]];
      if (typeof action !== "function") throw new TypeError(`workbench_application_method_missing:${route.endpoint.operationId}`);
      const value = await action({
        ...path,
        query,
        request: body,
        idempotencyKey: headers["Idempotency-Key"],
        ifMatch: headers["If-Match"],
        ifNoneMatch: headers["If-None-Match"],
        requestId,
        auth: session,
      });
      const responseHeaders = {
        ...(value?.responseHeaders ?? EMPTY),
        ...(value?.etag ? { ETag: value.etag } : EMPTY),
      };
      validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
      if (value?.notModified === true) {
        res.writeHead(304, responseHeaders);
        res.end();
        return;
      }
      const response = contractResponse(route.endpoint, value, requestId);
      if (response.rawBody) {
        res.writeHead(route.endpoint.successStatus, {
          "content-type": `${response.mediaType}; charset=utf-8`,
          ...responseHeaders,
        });
        res.end(response.rawBody);
        return;
      }
      writeJson(res, route.endpoint.successStatus, response.body, responseHeaders, response.mediaType);
    } catch (error) {
      const { status, body } = productError(error, requestId);
      if (status === 500 && internalErrorReporter) {
        try { internalErrorReporter(projectInternalError(error, requestId)); } catch {}
      }
      if (!Check(ErrorEnvelopeSchema, body)) throw error;
      writeJson(res, status, body);
    }
  };
}

function projectInternalError(error, requestId) {
  const safeToken = (value, fallback = undefined) => (
    typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : fallback
  );
  const labels = Array.isArray(error?.errorLabels)
    ? error.errorLabels.map((value) => safeToken(value)).filter(Boolean).slice(0, 8)
    : [];
  const stackFrames = typeof error?.stack === "string"
    ? error.stack.split("\n").slice(1).map((line) => line.trim())
      .filter((line) => line.startsWith("at ")).slice(0, 6).map((line) => line.slice(0, 500))
    : [];
  return {
    requestId,
    name: safeToken(error?.name, "Error"),
    ...(Number.isInteger(error?.code) ? { numericCode: error.code } : {}),
    ...(safeToken(error?.codeName) ? { codeName: safeToken(error.codeName) } : {}),
    labels,
    stackFrames,
  };
}
