import { randomUUID } from "node:crypto";

import { MongoClient } from "mongodb";

import {
  DEFAULT_MONGODB_URI,
  DEFAULT_PRODUCT_DATABASE,
  PRODUCT_COLLECTIONS,
  PRODUCT_INDEX_DEFINITIONS,
  PRODUCT_REPLICA_SET,
  PRODUCT_TRANSACTION_OPTIONS,
} from "./constants.mjs";
import { ProductStoreError } from "./errors.mjs";
import {
  collectReleaseConnectionRequirements,
  persistConnectionBindings,
  validateRequiredConnectionBindings,
} from "../connections/workspace-connection-service.mjs";
import {
  inspectPortableLoopImport,
  rewritePortableLoopImportGraph,
} from "../loops/portable-loop-package.mjs";
import {
  AuditEventRepository,
  ConnectionBindingRepository,
  CompileResultRepository,
  ExecutionPlanRepository,
  IdempotencyRepository,
  LoopImportRepository,
  MembershipRepository,
  ProductSessionRepository,
  ProductRecordRepository,
  ProductUserRepository,
  ReviewDecisionRepository,
  RunEventRepository,
  RunNodeAttemptRepository,
  RunJobRepository,
  RunLeaseRepository,
  RunReadModelRepository,
  RunRepository,
  SkillExecutionBindingRepository,
  SkillRepository,
  SkillTestEvidenceRepository,
  SkillTestRunRepository,
  SkillValidationRepository,
  SkillVersionRepository,
  TemplateRepository,
  WorkflowRepository,
  WorkflowRevisionRepository,
  WorkspaceRepository,
  WorkspaceConnectionRepository,
} from "./repositories.mjs";
import {
  canonicalRequestHash,
  cloneValue,
  formatSkillDraftEtag,
  formatWorkflowEtag,
  requestData,
  withoutWorkflowInternals,
} from "./serialization.mjs";

const duplicateKey = (error) => error?.code === 11000 || error?.codeName === "DuplicateKey";

const requiredString = (value, code) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProductStoreError(code, code);
  }
  return value;
};

const utcNow = () => new Date().toISOString();

const asTimestamp = (value) =>
  value instanceof Date ? value.toISOString() : String(value);

const defaultIdFactory = (kind) => `${kind}-${randomUUID()}`;
const roleRank = Object.freeze({ viewer: 0, member: 1, maintainer: 2, owner: 3 });

const productSafeLoopImport = (record) => record ? {
  schemaVersion: record.schemaVersion,
  importId: record.importId,
  uploadId: record.uploadId,
  status: record.status,
  sourceContentHash: record.sourceContentHash,
  portableLoop: cloneValue(record.portableLoop),
  requirementStates: cloneValue(record.requirementStates ?? []),
  diagnostics: cloneValue(record.diagnostics ?? []),
  committedWorkflowId: record.committedWorkflowId ?? null,
  committedRevisionId: record.committedRevisionId ?? null,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
} : null;

const formatLoopImportEtag = (record) => {
  if (!record?.importId || !Number.isInteger(record.revision) || record.revision < 1) {
    throw new TypeError("loop_import_etag_requires_revision");
  }
  return `"liv1:${record.importId}:${record.revision}:${record.sourceContentHash}"`;
};

const initialImportRequirementStates = (portableLoop) => [
  ...(portableLoop?.requirements?.skills ?? []).map(({ ref }) => ({ ref, kind: "skill", status: "unmapped" })),
  ...(portableLoop?.requirements?.connections ?? []).map(({ ref }) => ({ ref, kind: "connection", status: "unmapped" })),
  ...(portableLoop?.requirements?.materials ?? []).map(({ ref }) => ({ ref, kind: "material", status: "unmapped" })),
].sort((left, right) => left.ref.localeCompare(right.ref));

const revisionContent = ({
  graph,
  inputForm,
  outputDefinition,
  resourceRefs,
  runSettings,
  definition,
}) => ({ graph, inputForm, outputDefinition, resourceRefs, runSettings, definition });

const defaultRunSettings = (template) => ({
  maxParallelism: 1,
  defaultTimeoutSeconds: Math.max(
    1,
    ...template.graph.nodes.map((node) => node.timeoutSeconds ?? 1),
  ),
});

const templateOutputDefinition = (template) => {
  const expectedOutputs = cloneValue(template.expectedOutputs);
  const [primary] = expectedOutputs;
  if (!primary) {
    throw new ProductStoreError(
      "template_output_missing",
      "The template has no expected output.",
      { templateId: template.templateId },
    );
  }
  return {
    primary: { nodeId: primary.nodeId, portId: primary.portId },
    expectedOutputs,
  };
};

const publicWorkflow = (workflow) => withoutWorkflowInternals(workflow);
const emptyObjectSchema = Object.freeze({ type: "object", properties: {}, required: [] });
const defaultSkillRisk = Object.freeze({ level: "low", externalAction: false, summary: "No external action is configured." });
const loopTextSchema = Object.freeze({ type: "string", minLength: 1, maxLength: 10000 });
const schemaFields = (schema) => Object.keys(schema?.properties ?? {}).sort();
const labels = (items, key = "id") => items.map((item) => item?.[key]).filter(Boolean).sort();
const clipped = (value, max = 360) => String(value || "").slice(0, max) || "Not specified";
const changed = (left, right) => canonicalRequestHash(left) !== canonicalRequestHash(right);
const diffEntry = (field, didChange, summary, severity = "info") => ({
  field,
  changed: didChange,
  summary: clipped(summary, 2000),
  severity,
});
const skillVersionSummary = (version) => ({
  skillVersionId: version.skillVersionId,
  skillId: version.skillId,
  version: version.version,
  name: version.name,
  description: version.description,
  category: version.category,
  validation: {
    status: version.validation.status,
    testedAt: version.validation.testedAt,
  },
  publishedBy: version.publishedBy,
  publishedAt: version.publishedAt,
});
const loopSkillUpdateVersion = (version) => ({
  skillVersionId: version.skillVersionId,
  version: version.version,
  name: version.name,
  description: version.description,
  risk: cloneValue(version.risk),
  connectionRequirements: cloneValue(version.connectionRequirements ?? []),
});

const skillDraftContentHash = (draft) => canonicalRequestHash({
  skillDraftId: draft.skillDraftId,
  skillId: draft.skillId,
  baseVersionId: draft.baseVersionId,
  revision: draft.revision,
  name: draft.name,
  description: draft.description,
  category: draft.category,
  inputSchema: draft.inputSchema,
  outputSchema: draft.outputSchema,
  risk: draft.risk,
  dependencies: draft.dependencies,
  connectionRequirements: draft.connectionRequirements,
  files: draft.files,
});

const skillReferenceKey = (reference) => `${reference.skillId}\u0000${reference.version}`;

function addedSkillReferences(baseGraph, nextGraph) {
  const remaining = new Map();
  for (const node of baseGraph?.nodes ?? []) {
    if (node.kind !== "Skill" || !node.skillRef) continue;
    const key = skillReferenceKey(node.skillRef);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const added = [];
  for (const node of nextGraph?.nodes ?? []) {
    if (node.kind !== "Skill" || !node.skillRef) continue;
    const key = skillReferenceKey(node.skillRef);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else added.push(node.skillRef);
  }
  return added;
}

async function rejectRetiredSkillReferences({ skillAssets, references, workspaceId, options }) {
  for (const reference of references) {
    const asset = await skillAssets.get(reference.skillId, { workspaceId, ...options });
    if (asset?.lifecycle === "deprecated") {
      throw new ProductStoreError(
        "skill_not_available_for_new_workflow",
        "This Skill is no longer available for new workflow steps.",
        { skillId: reference.skillId, version: reference.version },
      );
    }
  }
}

function initialLoopDraft() {
  const input = {
    nodeId: "node-input",
    title: "Goal",
    description: "The outcome this Loop should produce.",
    position: { x: 0, y: 0 },
    inputPorts: [],
    outputPorts: [{ portId: "goal", name: "Goal", schema: cloneValue(loopTextSchema), required: true }],
    inputBindings: [],
    reviewPolicy: { mode: "none" },
    retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
    timeoutSeconds: 60,
    display: { collapsed: false },
    kind: "Input",
    configuration: { fieldIds: ["goal"] },
  };
  const output = {
    nodeId: "node-output",
    title: "Result",
    description: "The current Loop result.",
    position: { x: 420, y: 0 },
    inputPorts: [{ portId: "result", name: "Result", schema: cloneValue(loopTextSchema), required: true }],
    outputPorts: [{ portId: "result", name: "Result", schema: cloneValue(loopTextSchema), required: true }],
    inputBindings: [{
      targetPort: "result",
      source: { kind: "nodeOutput", nodeId: "node-input", portId: "goal" },
    }],
    reviewPolicy: { mode: "none" },
    retryPolicy: { maxAttempts: 1, backoffMilliseconds: 0 },
    timeoutSeconds: 60,
    display: { collapsed: false },
    kind: "Output",
    configuration: { format: "markdown" },
  };
  return {
    graph: {
      nodes: [input, output],
      edges: [{
        edgeId: "edge-input-output",
        sourceNodeId: "node-input",
        sourcePort: "goal",
        targetNodeId: "node-output",
        targetPort: "result",
      }],
    },
    inputForm: {
      fields: [{
        fieldId: "goal",
        label: "Goal",
        description: "What should this Loop produce?",
        schema: cloneValue(loopTextSchema),
        required: true,
      }],
    },
    outputDefinition: {
      primary: { nodeId: "node-output", portId: "result" },
      expectedOutputs: [{
        nodeId: "node-output",
        portId: "result",
        label: "Result",
        mediaType: "text/markdown",
      }],
    },
    runSettings: { maxParallelism: 1, defaultTimeoutSeconds: 60 },
  };
}

export class ProductMongoStore {
  constructor(options = {}) {
    this.uri =
      options.uri ??
      process.env.WORKBENCH_MONGODB_URI ??
      process.env.MONGODB_URI ??
      DEFAULT_MONGODB_URI;
    this.dbName =
      options.dbName ??
      process.env.WORKBENCH_MONGODB_DB ??
      process.env.MONGODB_DB ??
      DEFAULT_PRODUCT_DATABASE;
    this.serverSelectionTimeoutMS =
      options.serverSelectionTimeoutMS ??
      Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? 5_000);
    this.clock = options.clock ?? utcNow;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.defaultSession = options.session ?? null;

    this.client = options.client ?? null;
    this.db = options.db ?? null;
    this.ownsClient = !options.client && !options.db;
    this.readyPromise = null;
    this.repositories = null;
    this.indexesReady = false;

    if (this.db) this.#bindRepositories();
  }

  async connect() {
    if (this.db && this.repositories && this.indexesReady) return this.db;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.#connect();
    try {
      return await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  async #connect() {
    if (!this.client) {
      this.client = new MongoClient(this.uri, {
        appName: "looloomi-workbench-product-store",
        serverSelectionTimeoutMS: this.serverSelectionTimeoutMS,
      });
      await this.client.connect();
    } else if (this.ownsClient && typeof this.client.connect === "function") {
      await this.client.connect();
    }

    if (!this.db) {
      if (typeof this.client?.db !== "function") {
        throw new TypeError("mongo_client_db_method_required");
      }
      this.db = this.client.db(this.dbName);
    }
    this.#bindRepositories();
    await this.ensureIndexes();
    this.indexesReady = true;
    return this.db;
  }

  #bindRepositories() {
    const collection = (name) => this.db.collection(name);
    this.repositories = Object.freeze({
      users: new ProductUserRepository(collection(PRODUCT_COLLECTIONS.users)),
      workspaces: new WorkspaceRepository(collection(PRODUCT_COLLECTIONS.workspaces)),
      memberships: new MembershipRepository(collection(PRODUCT_COLLECTIONS.memberships)),
      sessions: new ProductSessionRepository(collection(PRODUCT_COLLECTIONS.sessions)),
      skillAssets: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.skillAssets), { idField: "skillId" }),
      skills: new SkillRepository(collection(PRODUCT_COLLECTIONS.skills)),
      skillDrafts: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.skillDrafts), { idField: "skillDraftId" }),
      skillVersions: new SkillVersionRepository(collection(PRODUCT_COLLECTIONS.skillVersions)),
      skillTestRuns: new SkillTestRunRepository(collection(PRODUCT_COLLECTIONS.skillTestRuns)),
      skillTestEvidence: new SkillTestEvidenceRepository(collection(PRODUCT_COLLECTIONS.skillTestEvidence)),
      skillValidations: new SkillValidationRepository(collection(PRODUCT_COLLECTIONS.skillValidations)),
      skillExecutionBindings: new SkillExecutionBindingRepository(collection(PRODUCT_COLLECTIONS.skillExecutionBindings)),
      templates: new TemplateRepository(collection(PRODUCT_COLLECTIONS.templates)),
      workflows: new WorkflowRepository(collection(PRODUCT_COLLECTIONS.workflows)),
      workflowRevisions: new WorkflowRevisionRepository(
        collection(PRODUCT_COLLECTIONS.workflowRevisions),
      ),
      loopImports: new LoopImportRepository(collection(PRODUCT_COLLECTIONS.loopImports)),
      loopVersions: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.loopVersions), { idField: "loopVersionId", immutable: true }),
      assetReleases: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.assetReleases), { idField: "releaseId", immutable: true }),
      assetInstallations: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.assetInstallations), { idField: "installationId" }),
      uploads: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.uploads), { idField: "uploadId" }),
      objects: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.objects), { idField: "objectId", immutable: true }),
      resources: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.resources), { idField: "resourceId", immutable: true }),
      connections: new WorkspaceConnectionRepository(collection(PRODUCT_COLLECTIONS.connections)),
      connectionBindings: new ConnectionBindingRepository(collection(PRODUCT_COLLECTIONS.connectionBindings)),
      builderProposals: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.builderProposals), { idField: "proposalId" }),
      compileResults: new CompileResultRepository(
        collection(PRODUCT_COLLECTIONS.compileResults),
      ),
      executionPlans: new ExecutionPlanRepository(
        collection(PRODUCT_COLLECTIONS.executionPlans),
      ),
      runs: new RunRepository(collection(PRODUCT_COLLECTIONS.runs)),
      runJobs: new RunJobRepository(collection(PRODUCT_COLLECTIONS.runJobs)),
      runLeases: new RunLeaseRepository(collection(PRODUCT_COLLECTIONS.runLeases)),
      runCheckpoints: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.runCheckpoints), { idField: "checkpointId", immutable: true }),
      runCommands: new ProductRecordRepository(collection(PRODUCT_COLLECTIONS.runCommands), { idField: "runCommandId", immutable: true }),
      runNodeAttempts: new RunNodeAttemptRepository(
        collection(PRODUCT_COLLECTIONS.runNodeAttempts),
      ),
      runEvents: new RunEventRepository(collection(PRODUCT_COLLECTIONS.runEvents)),
      runTerminalTransitions: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.runTerminalTransitions),
        { idField: "terminalTransitionId", immutable: true },
      ),
      runReadModels: new RunReadModelRepository(
        collection(PRODUCT_COLLECTIONS.runReadModels),
      ),
      reviewDecisions: new ReviewDecisionRepository(
        collection(PRODUCT_COLLECTIONS.reviewDecisions),
      ),
      executionInvocations: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.executionInvocations),
        { idField: "invocationId" },
      ),
      executionAttempts: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.executionAttempts),
        { idField: "attemptId" },
      ),
      executionEvents: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.executionEvents),
        { idField: "eventId", immutable: true },
      ),
      executionCheckpoints: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.executionCheckpoints),
        { idField: "checkpointId", immutable: true },
      ),
      capabilityLeases: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.capabilityLeases),
        { idField: "capabilityLeaseId" },
      ),
      agentSessions: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.agentSessions),
        { idField: "sessionId" },
      ),
      agentTurns: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.agentTurns),
        { idField: "turnId" },
      ),
      agentMessages: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.agentMessages),
        { idField: "messageId", immutable: true },
      ),
      agentBranches: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.agentBranches),
        { idField: "branchId", immutable: true },
      ),
      agentSessionEvents: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.agentSessionEvents),
        { idField: "eventId", immutable: true },
      ),
      agentHandoffs: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.agentHandoffs),
        { idField: "handoffId" },
      ),
      mergeConflicts: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.mergeConflicts),
        { idField: "mergeConflictId" },
      ),
      memoryCandidates: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.memoryCandidates),
        { idField: "candidateId" },
      ),
      durableMemories: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.durableMemories),
        { idField: "memoryId" },
      ),
      memoryEvents: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.memoryEvents),
        { idField: "memoryEventId", immutable: true },
      ),
      memoryDeletionTombstones: new ProductRecordRepository(
        collection(PRODUCT_COLLECTIONS.memoryDeletionTombstones),
        { idField: "tombstoneId", immutable: true },
      ),
      idempotencyRecords: new IdempotencyRepository(
        collection(PRODUCT_COLLECTIONS.idempotencyRecords),
      ),
      auditEvents: new AuditEventRepository(collection(PRODUCT_COLLECTIONS.auditEvents)),
    });
  }

  async ensureIndexes() {
    if (!this.db) throw new TypeError("product_store_not_connected");
    await Promise.all(
      PRODUCT_INDEX_DEFINITIONS.map(({ collection, indexes }) =>
        this.db.collection(collection).createIndexes(
          indexes.map(({ key, options }) => ({ key, ...options })),
        ),
      ),
    );
  }

  async health() {
    const db = await this.connect();
    const [ping, hello] = await Promise.all([
      db.command({ ping: 1 }),
      db.admin().command({ hello: 1 }),
    ]);
    return {
      ok: ping.ok === 1,
      database: this.dbName,
      replicaSet: hello.setName ?? null,
      writablePrimary: hello.isWritablePrimary === true,
    };
  }

  async close({ closeInjectedClient = false } = {}) {
    if (this.client && (this.ownsClient || closeInjectedClient)) {
      await this.client.close();
    }
    this.client = this.ownsClient ? null : this.client;
    this.db = null;
    this.repositories = null;
    this.indexesReady = false;
    this.readyPromise = null;
  }

  async dropTestDatabase() {
    if (!this.dbName.endsWith("_test")) {
      throw new ProductStoreError(
        "destructive_cleanup_requires_test_database",
        "Destructive cleanup is restricted to databases ending in _test.",
        { database: this.dbName },
      );
    }
    const db = await this.connect();
    await db.dropDatabase();
    this.db = null;
    this.repositories = null;
    this.indexesReady = false;
    this.readyPromise = null;
    return { database: this.dbName, dropped: true };
  }

  dropDatabase() {
    return this.dropTestDatabase();
  }

  async withTransaction(callback, { session = this.defaultSession } = {}) {
    const execute = (targetSession) => {
      if (typeof targetSession.inTransaction === "function" && targetSession.inTransaction()) {
        return callback(targetSession);
      }
      if (typeof targetSession.withTransaction !== "function") {
        throw new TypeError("mongo_session_with_transaction_required");
      }
      return targetSession.withTransaction(
        () => callback(targetSession),
        PRODUCT_TRANSACTION_OPTIONS,
      );
    };

    if (session) return execute(session);
    if (typeof this.client?.startSession !== "function") {
      throw new TypeError("mongo_client_start_session_required");
    }
    const ownedSession = this.client.startSession();
    try {
      return await execute(ownedSession);
    } finally {
      await ownedSession.endSession();
    }
  }

  #timestamp() {
    return asTimestamp(this.clock());
  }

  async ensurePrivateWorkspace({
    userId = "user-local",
    workspaceId = "workspace-local",
    displayName = "Local owner",
    workspaceName = "Private workspace",
    session,
  } = {}) {
    requiredString(userId, "user_id_required");
    requiredString(workspaceId, "workspace_id_required");
    await this.connect();
    return this.withTransaction(async (transactionSession) => {
      const options = { session: transactionSession };
      const now = this.#timestamp();
      const user = await this.repositories.users.ensure({
        schemaVersion: "workbench-v1",
        userId,
        displayName,
        createdAt: now,
        updatedAt: now,
      }, options);
      const workspace = await this.repositories.workspaces.ensure({
        schemaVersion: "workbench-v1",
        workspaceId,
        name: workspaceName,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      }, options);
      const membership = await this.repositories.memberships.ensure({
        schemaVersion: "workbench-v1",
        membershipId: `membership-${workspaceId}-${userId}`,
        workspaceId,
        userId,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      }, options);
      return { user, workspace, membership };
    }, { session: session ?? this.defaultSession });
  }

  async authorizeWorkspace({ userId, workspaceId, minimumRole = "viewer", session } = {}) {
    requiredString(userId, "user_id_required");
    requiredString(workspaceId, "workspace_id_required");
    if (!Object.hasOwn(roleRank, minimumRole)) {
      throw new ProductStoreError("workspace_role_invalid", "The required workspace role is invalid.");
    }
    await this.connect();
    const membership = await this.repositories.memberships.get(workspaceId, userId, { session });
    if (!membership) {
      throw new ProductStoreError("workspace_access_forbidden", "You do not have access to this workspace.");
    }
    if ((roleRank[membership.role] ?? -1) < roleRank[minimumRole]) {
      throw new ProductStoreError("workspace_role_forbidden", "Your workspace role cannot perform this action.");
    }
    return cloneValue(membership);
  }

  async addWorkspaceMembership({
    workspaceId,
    userId,
    displayName,
    role,
    addedBy,
    idempotencyKey,
    session,
  } = {}) {
    requiredString(workspaceId, "workspace_id_required");
    requiredString(userId, "user_id_required");
    requiredString(displayName, "user_display_name_required");
    requiredString(addedBy, "user_id_required");
    if (!["maintainer", "member", "viewer"].includes(role)) {
      throw new ProductStoreError("workspace_member_role_invalid", "The requested workspace role is invalid.");
    }
    return this.runIdempotentMutation({
      scope: `add-workspace-membership:${workspaceId}`,
      key: idempotencyKey,
      request: { userId, displayName, role },
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { session: transactionSession };
      const workspace = await this.repositories.workspaces.get(workspaceId, options);
      if (!workspace) throw new ProductStoreError("workspace_access_forbidden", "The workspace was not found.");
      const existing = await this.repositories.memberships.get(workspaceId, userId, options);
      if (existing) {
        throw new ProductStoreError("workspace_membership_exists", "This person already belongs to the workspace.");
      }
      const now = this.#timestamp();
      await this.repositories.users.ensure({
        schemaVersion: "workbench-v1",
        userId,
        displayName,
        createdAt: now,
        updatedAt: now,
      }, options);
      const membership = await this.repositories.memberships.insert({
        schemaVersion: "workbench-v1",
        membershipId: `membership-${workspaceId}-${userId}`,
        workspaceId,
        userId,
        role,
        createdAt: now,
        updatedAt: now,
      }, options);
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: addedBy,
        action: "workspace.membership_added",
        entityKind: "workspace_membership",
        entityId: membership.membershipId,
        createdAt: now,
      }, options);
      return membership;
    });
  }

  #resolveIdempotency(record, requestHash) {
    if (record.requestHash !== requestHash) {
      throw new ProductStoreError(
        "idempotency_key_reused",
        "The idempotency key was already used with a different request body.",
        { scope: record.scope, key: record.key },
      );
    }
    if (record.response === null || record.response === undefined) {
      throw new ProductStoreError(
        "idempotency_record_incomplete",
        "The idempotent mutation has no committed response.",
        { scope: record.scope, key: record.key },
      );
    }
    return cloneValue(record.response);
  }

  async runIdempotentMutation(
    { scope, key, request, workspaceId, session },
    mutation,
  ) {
    requiredString(scope, "idempotency_scope_required");
    requiredString(key, "idempotency_key_required");
    if (!request || typeof request !== "object") {
      throw new ProductStoreError("idempotency_request_body_required");
    }
    const requestSnapshot = cloneValue(request);
    const requestHash = canonicalRequestHash(requestSnapshot);
    const tenantScope = workspaceId
      ? `workspace:${requiredString(workspaceId, "workspace_id_required")}:${scope}`
      : scope;
    await this.connect();

    const transact = async (transactionSession) => {
      const options = { session: transactionSession };
      const existing = await this.repositories.idempotencyRecords.getInternal(
        tenantScope,
        key,
        options,
      );
      if (existing) return this.#resolveIdempotency(existing, requestHash);

      const now = this.#timestamp();
      await this.repositories.idempotencyRecords.insertPending(
        {
          scope: tenantScope,
          key,
          requestHash,
          response: null,
          createdAt: now,
          updatedAt: now,
        },
        options,
      );
      const response = await mutation(transactionSession);
      await this.repositories.idempotencyRecords.complete(
        tenantScope,
        key,
        response,
        this.#timestamp(),
        options,
      );
      return cloneValue(response);
    };

    try {
      return await this.withTransaction(transact, { session });
    } catch (error) {
      if (!duplicateKey(error) || session?.inTransaction?.()) throw error;
      const committed = await this.repositories.idempotencyRecords.getInternal(tenantScope, key);
      if (!committed) throw error;
      return this.#resolveIdempotency(committed, requestHash);
    }
  }

  async runIdempotentExternalMutation({
    scope,
    key,
    request,
    workspaceId,
    operationIdKind,
    leaseMilliseconds = 180_000,
    recover,
  } = {}, mutation) {
    requiredString(scope, "idempotency_scope_required");
    requiredString(key, "idempotency_key_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(operationIdKind, "idempotency_operation_kind_required");
    if (!request || typeof request !== "object" || typeof mutation !== "function") {
      throw new ProductStoreError("idempotency_request_body_required");
    }
    if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000) {
      throw new ProductStoreError("idempotency_lease_invalid");
    }
    await this.connect();
    const tenantScope = `workspace:${workspaceId}:${scope}`;
    const requestHash = canonicalRequestHash(cloneValue(request));
    const leaseOwner = this.idFactory("idempotency-owner");
    const now = this.#timestamp();
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMilliseconds).toISOString();
    let claim = await this.repositories.idempotencyRecords.getInternal(tenantScope, key);

    if (!claim) {
      try {
        claim = await this.repositories.idempotencyRecords.insertPending({
          scope: tenantScope,
          key,
          requestHash,
          response: null,
          operationId: this.idFactory(operationIdKind),
          state: "executing",
          executionAttempt: 1,
          leaseOwner,
          leaseExpiresAt,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (!duplicateKey(error)) throw error;
        claim = await this.repositories.idempotencyRecords.getInternal(tenantScope, key);
      }
    }

    if (!claim) throw new ProductStoreError("idempotency_record_incomplete", "The idempotent operation could not be claimed.");
    if (claim.requestHash !== requestHash) {
      throw new ProductStoreError(
        "idempotency_key_reused",
        "The idempotency key was already used with a different request body.",
        { scope: tenantScope, key },
      );
    }
    if (claim.response !== null && claim.response !== undefined) return cloneValue(claim.response);
    if (!claim.operationId) {
      throw new ProductStoreError("idempotency_record_incomplete", "The idempotent operation has no stable operation identifier.");
    }
    if (claim.leaseOwner !== leaseOwner) {
      if (typeof claim.leaseExpiresAt === "string" && claim.leaseExpiresAt > now) {
        throw new ProductStoreError("idempotency_in_progress", "This request is already in progress.");
      }
      claim = await this.repositories.idempotencyRecords.takeOverExternal(tenantScope, key, {
        requestHash,
        leaseOwner,
        leaseExpiresAt,
        now,
      });
      if (!claim) throw new ProductStoreError("idempotency_in_progress", "This request is already being resumed.");
    }

    try {
      const recovered = typeof recover === "function" ? await recover(claim.operationId) : null;
      const response = recovered ?? await mutation(claim.operationId);
      const completed = await this.repositories.idempotencyRecords.completeExternal(tenantScope, key, {
        requestHash,
        leaseOwner,
        response,
        updatedAt: this.#timestamp(),
      });
      if (!completed) {
        throw new ProductStoreError("idempotency_claim_lost", "The idempotent operation claim expired before completion.");
      }
      return cloneValue(response);
    } catch (error) {
      await this.repositories.idempotencyRecords.releaseExternal(tenantScope, key, {
        requestHash,
        leaseOwner,
        failureCode: typeof error?.code === "string" ? error.code : "internal_error",
        updatedAt: this.#timestamp(),
      }).catch(() => {});
      throw error;
    }
  }

  async createSkill({
    idempotencyKey,
    request,
    workspaceId,
    authoredBy,
    trustedActivation = null,
    skillId,
    skillDraftId,
    session,
  } = {}) {
    requiredString(workspaceId, "workspace_id_required");
    requiredString(authoredBy, "user_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    if (!data || typeof data !== "object") {
      throw new ProductStoreError("create_skill_request_required", "Skill details are required.");
    }
    requiredString(data.name, "skill_name_required");
    requiredString(data.description, "skill_description_required");
    requiredString(data.category, "skill_category_required");
    return this.runIdempotentMutation(
      {
        scope: "create-skill",
        key: idempotencyKey,
        request: requestSnapshot,
        workspaceId,
        session: session ?? this.defaultSession,
      },
      async (transactionSession) => {
        const options = { session: transactionSession };
        const now = this.#timestamp();
        const nextSkillId = skillId ?? this.idFactory("skill");
        const nextDraftId = skillDraftId ?? this.idFactory("skill-draft");
        let upload = null;
        let packageObject = null;
        if (data.uploadId !== undefined) {
          upload = await this.repositories.uploads.get(data.uploadId, { workspaceId, ...options });
          if (
            !upload
            || upload.state !== "promoted"
            || !["passed", "needs_review"].includes(upload.inspection?.status)
            || !upload.objectId
          ) {
            throw new ProductStoreError("skill_upload_not_ready", "Promote a reviewed Skill package before creating this Skill.");
          }
          packageObject = await this.repositories.objects.get(upload.objectId, { workspaceId, ...options });
          if (!packageObject) {
            throw new ProductStoreError("skill_package_object_missing", "The promoted Skill package is unavailable.");
          }
        }
        if (trustedActivation && (!upload || trustedActivation.packageContentHash !== upload.inspection.contentHash)) {
          throw new ProductStoreError("skill_activation_mismatch", "The trusted Skill activation does not match this package.");
        }
        const skill = {
          schemaVersion: "workbench-v1",
          skillId: nextSkillId,
          workspaceId,
          ownerId: authoredBy,
          visibility: "private",
          lifecycle: trustedActivation ? "ready" : "draft",
          currentDraftId: nextDraftId,
          latestPublishedVersionId: null,
          createdAt: now,
          updatedAt: now,
        };
        const draft = {
          schemaVersion: "workbench-v1",
          skillDraftId: nextDraftId,
          skillId: nextSkillId,
          workspaceId,
          baseVersionId: null,
          revision: 1,
          name: data.name,
          description: data.description,
          category: data.category,
          inputSchema: cloneValue(trustedActivation?.inputSchema ?? emptyObjectSchema),
          outputSchema: cloneValue(trustedActivation?.outputSchema ?? emptyObjectSchema),
          risk: cloneValue(defaultSkillRisk),
          dependencies: [],
          connectionRequirements: [],
          files: packageObject ? [{
            path: "package.skill-package",
            objectId: packageObject.objectId,
            contentHash: packageObject.contentHash,
            mediaType: packageObject.mediaType,
            sizeBytes: packageObject.sizeBytes,
          }] : [],
          ...(trustedActivation ? { executionRef: cloneValue(trustedActivation.executionRef) } : {}),
          updatedBy: authoredBy,
          createdAt: now,
          updatedAt: now,
        };
        const insertedSkill = await this.repositories.skillAssets.insert(skill, options);
        const insertedDraft = await this.repositories.skillDrafts.insert(draft, options);
        return { skill: insertedSkill, draft: insertedDraft };
      },
    );
  }

  async getSkillDraft({ skillId, draftId, workspaceId, session } = {}) {
    requiredString(skillId, "skill_id_required");
    requiredString(draftId, "skill_draft_id_required");
    requiredString(workspaceId, "workspace_id_required");
    await this.connect();
    const options = { workspaceId, session: session ?? this.defaultSession };
    const skill = await this.repositories.skillAssets.get(skillId, options);
    if (!skill) {
      throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
    }
    const draft = await this.repositories.skillDrafts.get(draftId, options);
    if (!draft || draft.skillId !== skillId) {
      throw new ProductStoreError("skill_draft_not_found", "Skill draft not found.", { skillId, draftId });
    }
    return { skill, draft };
  }

  async resolveSkillValidationContext({ skillId, draftId, workspaceId, session } = {}) {
    const { skill, draft } = await this.getSkillDraft({ skillId, draftId, workspaceId, session });
    if (skill.currentDraftId !== draftId) {
      throw new ProductStoreError(
        "skill_draft_stale",
        "Only the current Skill draft can be tested or validated.",
        { skillId, draftId },
      );
    }
    const options = { workspaceId, session: session ?? this.defaultSession };
    const packageFile = draft.files?.find((file) => file?.objectId && file?.contentHash);
    if (!packageFile) {
      throw new ProductStoreError(
        "skill_package_not_publishable",
        "Add a promoted Skill package before testing this draft.",
        { skillId, draftId },
      );
    }
    const [packageObject, uploads] = await Promise.all([
      this.repositories.objects.get(packageFile.objectId, options),
      this.repositories.uploads.list(options),
    ]);
    const upload = uploads.find((entry) => entry.objectId === packageFile.objectId);
    if (!upload || upload.state !== "promoted" || !upload.inspection?.contentHash) {
      throw new ProductStoreError(
        "skill_package_not_publishable",
        "Promote the inspected Skill package before testing this draft.",
        { skillId, draftId },
      );
    }
    if (!packageObject || packageObject.contentHash !== packageFile.contentHash) {
      throw new ProductStoreError(
        "skill_package_object_missing",
        "The promoted Skill package is unavailable.",
        { skillId, draftId },
      );
    }
    return {
      skill,
      draft,
      uploadId: upload.uploadId,
      objectId: packageObject.objectId,
      objectHash: packageObject.contentHash,
      packageHash: upload.inspection.contentHash,
      contentHash: skillDraftContentHash(draft),
      inspection: cloneValue(upload.inspection),
    };
  }

  async createNextSkillDraft({
    skillId,
    idempotencyKey,
    ifMatch,
    request,
    workspaceId,
    authoredBy,
    skillDraftId,
    session,
  } = {}) {
    requiredString(skillId, "skill_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(authoredBy, "user_id_required");
    requiredString(ifMatch, "skill_draft_etag_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.baseVersionId, "base_skill_version_required");
    return this.runIdempotentMutation({
      scope: `create-next-skill-draft:${skillId}`,
      key: idempotencyKey,
      request: { ifMatch, request: requestSnapshot },
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { workspaceId, session: transactionSession };
      const skill = await this.repositories.skillAssets.get(skillId, options);
      if (!skill) throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
      if (skill.ownerId !== authoredBy) {
        throw new ProductStoreError("skill_owner_required", "Only the Skill owner can create its next version.", { skillId });
      }
      if (skill.lifecycle !== "ready" || !skill.latestPublishedVersionId) {
        throw new ProductStoreError("skill_update_not_ready", "Finish the current Skill draft before creating another version.", { skillId });
      }
      const currentDraft = skill.currentDraftId
        ? await this.repositories.skillDrafts.get(skill.currentDraftId, options)
        : null;
      if (!currentDraft || formatSkillDraftEtag(currentDraft) !== ifMatch) {
        throw new ProductStoreError("skill_draft_conflict", "The Skill draft changed after it was read.", { skillId });
      }
      const baseVersion = await this.repositories.skillVersions.get(data.baseVersionId, options);
      if (!baseVersion || baseVersion.skillId !== skillId) {
        throw new ProductStoreError("skill_version_not_found", "The selected Skill version was not found.", { skillId });
      }
      const packageObject = await this.repositories.objects.get(baseVersion.packageObjectId, options);
      if (!packageObject) {
        throw new ProductStoreError("skill_package_object_missing", "The published Skill package is unavailable.", {
          skillId,
          skillVersionId: baseVersion.skillVersionId,
        });
      }
      const drafts = await this.repositories.skillDrafts.list(options);
      const nextRevision = Math.max(0, ...drafts.filter((draft) => draft.skillId === skillId).map((draft) => draft.revision)) + 1;
      const now = this.#timestamp();
      const draft = await this.repositories.skillDrafts.insert({
        schemaVersion: "workbench-v1",
        skillDraftId: skillDraftId ?? this.idFactory("skill-draft"),
        skillId,
        workspaceId,
        baseVersionId: baseVersion.skillVersionId,
        revision: nextRevision,
        name: baseVersion.name,
        description: baseVersion.description,
        category: baseVersion.category,
        inputSchema: cloneValue(baseVersion.inputSchema),
        outputSchema: cloneValue(baseVersion.outputSchema),
        risk: cloneValue(baseVersion.risk),
        dependencies: cloneValue(baseVersion.dependencies),
        connectionRequirements: cloneValue(baseVersion.connectionRequirements),
        files: [{
          path: "package.skill-package",
          objectId: packageObject.objectId,
          contentHash: packageObject.contentHash,
          mediaType: packageObject.mediaType,
          sizeBytes: packageObject.sizeBytes,
        }],
        executionRef: cloneValue(baseVersion.executionRef),
        updatedBy: authoredBy,
        createdAt: now,
        updatedAt: now,
      }, { session: transactionSession });
      const updatedSkill = await this.repositories.skillAssets.patch(skillId, {
        currentDraftId: draft.skillDraftId,
        lifecycle: "draft",
        updatedAt: now,
      }, options);
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: authoredBy,
        action: "skill.next_draft_created",
        entityKind: "skill_draft",
        entityId: draft.skillDraftId,
        createdAt: now,
      }, { session: transactionSession });
      return { skill: updatedSkill, draft };
    });
  }

  async updateSkillDraft({
    skillId,
    draftId,
    idempotencyKey,
    ifMatch,
    request,
    workspaceId,
    authoredBy,
    session,
  } = {}) {
    requiredString(skillId, "skill_id_required");
    requiredString(draftId, "skill_draft_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(authoredBy, "user_id_required");
    requiredString(ifMatch, "skill_draft_etag_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
      throw new ProductStoreError("skill_draft_update_required", "Choose at least one Skill detail to update.");
    }
    const editableFields = [
      "name",
      "description",
      "category",
      "inputSchema",
      "outputSchema",
      "risk",
      "dependencies",
      "connectionRequirements",
    ];
    const patch = Object.fromEntries(
      editableFields
        .filter((field) => Object.hasOwn(data, field))
        .map((field) => [field, cloneValue(data[field])]),
    );
    return this.runIdempotentMutation(
      {
        scope: `update-skill-draft:${skillId}:${draftId}`,
        key: idempotencyKey,
        request: { ifMatch, request: requestSnapshot },
        workspaceId,
        session: session ?? this.defaultSession,
      },
      async (transactionSession) => {
        const options = { workspaceId, session: transactionSession };
        const skill = await this.repositories.skillAssets.get(skillId, options);
        if (!skill) throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
        if (skill.ownerId !== authoredBy) {
          throw new ProductStoreError("skill_owner_required", "Only the Skill owner can update its draft.", { skillId });
        }
        if (skill.lifecycle !== "draft") {
          throw new ProductStoreError("skill_draft_not_editable", "Create a new Skill version before changing published details.", { skillId, draftId });
        }
        if (skill.currentDraftId !== draftId) {
          throw new ProductStoreError("skill_draft_conflict", "This is no longer the active Skill draft.", { skillId, draftId });
        }
        const draft = await this.repositories.skillDrafts.get(draftId, options);
        if (!draft || draft.skillId !== skillId) {
          throw new ProductStoreError("skill_draft_not_found", "Skill draft not found.", { skillId, draftId });
        }
        if (formatSkillDraftEtag(draft) !== ifMatch) {
          throw new ProductStoreError("skill_draft_conflict", "The Skill draft changed after it was read.", { skillId, draftId });
        }
        const now = this.#timestamp();
        const updatedDraft = await this.repositories.skillDrafts.patch(draftId, {
          ...patch,
          revision: draft.revision + 1,
          updatedBy: authoredBy,
          updatedAt: now,
        }, options);
        await this.repositories.skillAssets.patch(skillId, {
          lifecycle: "draft",
          updatedAt: now,
        }, options);
        await this.repositories.auditEvents.append({
          schemaVersion: "workbench-v1",
          auditEventId: this.idFactory("audit"),
          workspaceId,
          actorId: authoredBy,
          action: "skill.draft_updated",
          entityKind: "skill_draft",
          entityId: draftId,
          createdAt: now,
        }, { session: transactionSession });
        return { draft: updatedDraft };
      },
    );
  }

  async replaceSkillDraftPackage({
    skillId,
    draftId,
    idempotencyKey,
    ifMatch,
    request,
    workspaceId,
    authoredBy,
    replacement,
    session,
  } = {}) {
    requiredString(skillId, "skill_id_required");
    requiredString(draftId, "skill_draft_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(authoredBy, "user_id_required");
    requiredString(ifMatch, "skill_draft_etag_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.uploadId, "upload_id_required");
    if (!replacement || replacement.uploadId !== data.uploadId) {
      throw new ProductStoreError("skill_package_substituted", "The selected Skill package changed before it could be saved.");
    }
    return this.runIdempotentMutation({
      scope: `replace-skill-draft-package:${skillId}:${draftId}`,
      key: idempotencyKey,
      request: { ifMatch, request: requestSnapshot },
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { workspaceId, session: transactionSession };
      const skill = await this.repositories.skillAssets.get(skillId, options);
      if (!skill) throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
      if (skill.ownerId !== authoredBy) {
        throw new ProductStoreError("skill_owner_required", "Only the Skill owner can replace its package.", { skillId });
      }
      if (skill.lifecycle !== "draft") {
        throw new ProductStoreError("skill_draft_not_editable", "Create a new Skill version before replacing the published package.", { skillId, draftId });
      }
      if (skill.currentDraftId !== draftId) {
        throw new ProductStoreError("skill_draft_conflict", "This is no longer the active Skill draft.", { skillId, draftId });
      }
      const draft = await this.repositories.skillDrafts.get(draftId, options);
      if (!draft || draft.skillId !== skillId) {
        throw new ProductStoreError("skill_draft_not_found", "Skill draft not found.", { skillId, draftId });
      }
      if (formatSkillDraftEtag(draft) !== ifMatch) {
        throw new ProductStoreError("skill_draft_conflict", "The Skill draft changed after it was read.", { skillId, draftId });
      }
      const upload = await this.repositories.uploads.get(data.uploadId, options);
      if (!upload || upload.state !== "promoted" || upload.objectId !== replacement.objectId) {
        throw new ProductStoreError("skill_package_not_promoted", "Promote the selected Skill package before saving it.", { skillId, draftId });
      }
      const packageObject = await this.repositories.objects.get(replacement.objectId, options);
      if (
        !packageObject
        || packageObject.contentHash !== replacement.contentHash
        || packageObject.mediaType !== replacement.mediaType
        || packageObject.sizeBytes !== replacement.sizeBytes
      ) {
        throw new ProductStoreError("skill_package_substituted", "The selected Skill package changed before it could be saved.", { skillId, draftId });
      }
      const now = this.#timestamp();
      const updatedDraft = await this.repositories.skillDrafts.patchAndUnset(draftId, {
        files: [{
          path: "package.skill-package",
          objectId: packageObject.objectId,
          contentHash: packageObject.contentHash,
          mediaType: packageObject.mediaType,
          sizeBytes: packageObject.sizeBytes,
        }],
        revision: draft.revision + 1,
        updatedBy: authoredBy,
        updatedAt: now,
      }, ["executionRef"], options);
      await this.repositories.skillAssets.patch(skillId, {
        lifecycle: "draft",
        updatedAt: now,
      }, options);
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: authoredBy,
        action: "skill.draft_package_replaced",
        entityKind: "skill_draft",
        entityId: draftId,
        createdAt: now,
      }, { session: transactionSession });
      return { draft: updatedDraft };
    });
  }

  async getSkillUsageImpact({ skillId, workspaceId, session } = {}) {
    requiredString(skillId, "skill_id_required");
    requiredString(workspaceId, "workspace_id_required");
    await this.connect();
    const options = { workspaceId, session: session ?? this.defaultSession };
    const skill = await this.repositories.skillAssets.get(skillId, options);
    if (!skill) throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
    const latest = skill.latestPublishedVersionId
      ? await this.repositories.skillVersions.get(skill.latestPublishedVersionId, options)
      : null;
    const workflows = await this.repositories.workflows.list(options);
    const affectedWorkflows = [];
    for (const workflow of workflows) {
      const revision = await this.repositories.workflowRevisions.get(
        workflow.workflowId,
        workflow.currentRevisionId,
        options,
      );
      if (!revision?.graph?.nodes?.some((node) => node.kind === "Skill" && node.skillRef?.skillId === skillId)) continue;
      affectedWorkflows.push({
        workflowId: workflow.workflowId,
        revisionId: revision.revisionId,
        name: workflow.name,
        visibility: workflow.visibility ?? "private",
        state: workflow.lifecycle ?? (workflow.readiness === "Ready" ? "ready" : "draft"),
      });
    }
    return {
      skillId,
      latestVersionId: latest?.skillVersionId ?? null,
      latestVersion: latest?.version ?? null,
      affectedWorkflows,
    };
  }

  async listSkillVersions({ skillId, workspaceId, limit, session } = {}) {
    requiredString(skillId, "skill_id_required");
    requiredString(workspaceId, "workspace_id_required");
    await this.connect();
    const versions = await this.repositories.skillVersions.listBySkill(skillId, {
      workspaceId,
      limit,
      session: session ?? this.defaultSession,
    });
    return versions.map(skillVersionSummary);
  }

  async getSkillVersionDiff({ skillId, fromVersionId, toVersionId, workspaceId, session } = {}) {
    requiredString(skillId, "skill_id_required");
    requiredString(fromVersionId, "skill_version_id_required");
    requiredString(toVersionId, "skill_version_id_required");
    requiredString(workspaceId, "workspace_id_required");
    await this.connect();
    const options = { workspaceId, session: session ?? this.defaultSession };
    const [from, to] = await Promise.all([
      this.repositories.skillVersions.get(fromVersionId, options),
      this.repositories.skillVersions.get(toVersionId, options),
    ]);
    if (!from || from.skillId !== skillId || !to || to.skillId !== skillId) {
      throw new ProductStoreError("skill_version_not_found", "A selected Skill version was not found.", { skillId });
    }
    const fromInputs = schemaFields(from.inputSchema);
    const toInputs = schemaFields(to.inputSchema);
    const fromOutputs = schemaFields(from.outputSchema);
    const toOutputs = schemaFields(to.outputSchema);
    const fromDependencies = labels(from.dependencies);
    const toDependencies = labels(to.dependencies);
    const fromConnections = labels(from.connectionRequirements, "label");
    const toConnections = labels(to.connectionRequirements, "label");
    return {
      skillId,
      fromVersionId: from.skillVersionId,
      fromVersion: from.version,
      toVersionId: to.skillVersionId,
      toVersion: to.version,
      entries: [
        diffEntry("purpose", from.description !== to.description || from.name !== to.name, "The Skill description or name changed."),
        diffEntry("required_information", changed(fromInputs, toInputs), `Needs: ${toInputs.join(", ") || "no named fields"}.`),
        diffEntry("creates", changed(fromOutputs, toOutputs), `Creates: ${toOutputs.join(", ") || "no named fields"}.`),
        diffEntry("risk", changed(from.risk, to.risk), `Risk: ${to.risk.level}. ${clipped(to.risk.summary, 300)}`, "warning"),
        diffEntry("dependencies", changed(fromDependencies, toDependencies), `Uses: ${toDependencies.join(", ") || "none"}.`),
        diffEntry("connections", changed(fromConnections, toConnections), `Connections: ${toConnections.join(", ") || "none"}.`, "warning"),
        diffEntry("package", from.packageHash !== to.packageHash, "The approved Skill package changed.", "warning"),
      ],
    };
  }

  async deprecateSkill({ skillId, idempotencyKey, request, workspaceId, deprecatedBy, session } = {}) {
    requiredString(skillId, "skill_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(deprecatedBy, "user_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.reason, "skill_deprecation_reason_required");
    return this.runIdempotentMutation({
      scope: `deprecate-skill:${skillId}`,
      key: idempotencyKey,
      request: requestSnapshot,
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { workspaceId, session: transactionSession };
      const skill = await this.repositories.skillAssets.get(skillId, options);
      if (!skill) throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
      if (skill.ownerId !== deprecatedBy) {
        throw new ProductStoreError("skill_owner_required", "Only the Skill owner can deprecate it.", { skillId });
      }
      const now = this.#timestamp();
      const updated = await this.repositories.skillAssets.patch(skillId, {
        lifecycle: "deprecated",
        retirement: {
          reason: data.reason,
          retiredAt: now,
          retiredBy: deprecatedBy,
        },
        updatedAt: now,
      }, options);
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: deprecatedBy,
        action: "skill.deprecated",
        entityKind: "skill",
        entityId: skillId,
        createdAt: now,
      }, { session: transactionSession });
      return updated;
    });
  }

  async publishSkill({
    skillId,
    idempotencyKey,
    ifMatch,
    request,
    workspaceId,
    publishedBy,
    skillVersionId,
    releaseId,
    session,
  } = {}) {
    requiredString(skillId, "skill_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(publishedBy, "user_id_required");
    requiredString(ifMatch, "skill_draft_etag_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.version, "skill_version_required");
    if (typeof data?.releaseNotes !== "string") {
      throw new ProductStoreError("skill_publish_request_invalid", "Skill publication details are invalid.");
    }
    return this.runIdempotentMutation(
      {
        scope: `publish-skill:${skillId}`,
        key: idempotencyKey,
        request: { ifMatch, request: requestSnapshot },
        workspaceId,
        session: session ?? this.defaultSession,
      },
      async (transactionSession) => {
        const options = { session: transactionSession };
        const skill = await this.repositories.skillAssets.get(skillId, { workspaceId, ...options });
        if (!skill) throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
        if (!skill.currentDraftId) {
          throw new ProductStoreError("skill_draft_not_found", "This Skill has no draft to publish.", { skillId });
        }
        const draft = await this.repositories.skillDrafts.get(skill.currentDraftId, { workspaceId, ...options });
        if (!draft) throw new ProductStoreError("skill_draft_not_found", "Skill draft not found.", { skillId });
        if (formatSkillDraftEtag(draft) !== ifMatch) {
          throw new ProductStoreError("skill_draft_conflict", "The Skill draft changed after it was read.", { skillId });
        }
        if (draft.files.length === 0) {
          throw new ProductStoreError("skill_package_not_publishable", "A trusted Skill package is required before publication.", { skillId });
        }
        const packageFile = draft.files[0];
        const upload = (await this.repositories.uploads.list({ workspaceId, ...options }))
          .find((entry) => entry.objectId === packageFile.objectId);
        if (
          !upload
          || upload.state !== "promoted"
          || !["passed", "needs_review"].includes(upload.inspection?.status)
        ) {
          throw new ProductStoreError("skill_package_not_publishable", "The Skill package must remain promoted and verified.", { skillId });
        }
        const packageObject = await this.repositories.objects.get(packageFile.objectId, { workspaceId, ...options });
        if (!packageObject || packageObject.contentHash !== packageFile.contentHash) {
          throw new ProductStoreError("skill_package_object_missing", "The promoted Skill package is unavailable.", { skillId });
        }
        const contentHash = skillDraftContentHash(draft);
        const validation = await this.repositories.skillValidations.getExactPassed({
          workspaceId,
          skillId,
          skillDraftId: draft.skillDraftId,
          draftRevision: draft.revision,
          contentHash,
        }, options);
        if (!validation) {
          throw new ProductStoreError(
            "skill_validation_failed",
            "Run and pass validation for this exact Skill draft before publication.",
            { skillId, draftId: draft.skillDraftId },
          );
        }
        const binding = await this.repositories.skillExecutionBindings.getExactInternal({
          workspaceId,
          skillId,
          skillDraftId: draft.skillDraftId,
          draftRevision: draft.revision,
          contentHash,
          packageHash: upload.inspection.contentHash,
          validationId: validation.validationId,
        }, options);
        if (!binding?.executionRef) {
          throw new ProductStoreError(
            "skill_activation_required",
            "This exact validated Skill draft has no approved execution binding.",
            { skillId, draftId: draft.skillDraftId },
          );
        }
        const existing = (await this.repositories.skillVersions.list({ workspaceId, ...options }))
          .find((entry) => entry.skillId === skillId && entry.version === data.version);
        if (existing) {
          throw new ProductStoreError("skill_version_exists", "This Skill version already exists.", { skillId, version: data.version });
        }
        const now = this.#timestamp();
        const immutableContent = {
          packageHash: upload.inspection.contentHash,
          name: draft.name,
          description: draft.description,
          category: draft.category,
          inputSchema: draft.inputSchema,
          outputSchema: draft.outputSchema,
          risk: draft.risk,
          dependencies: draft.dependencies,
          connectionRequirements: draft.connectionRequirements,
          executionRef: binding.executionRef,
        };
        const version = await this.repositories.skillVersions.insert({
          schemaVersion: "workbench-v1",
          skillVersionId: skillVersionId ?? this.idFactory("skill-version"),
          skillId,
          workspaceId,
          version: data.version,
          packageObjectId: packageObject.objectId,
          packageHash: upload.inspection.contentHash,
          contentHash: canonicalRequestHash(immutableContent),
          manifest: cloneValue(upload.inspection.manifest ?? {}),
          name: draft.name,
          description: draft.description,
          category: draft.category,
          inputSchema: cloneValue(draft.inputSchema),
          outputSchema: cloneValue(draft.outputSchema),
          risk: cloneValue(draft.risk),
          dependencies: cloneValue(draft.dependencies),
          connectionRequirements: cloneValue(draft.connectionRequirements),
          validation: {
            validationId: validation.validationId,
            status: validation.status,
            diagnostics: cloneValue(validation.diagnostics),
            testedAt: validation.completedAt,
            contentHash: validation.contentHash,
            testRunIds: cloneValue(validation.testRunIds),
          },
          executionRef: cloneValue(binding.executionRef),
          publishedBy,
          publishedAt: now,
        }, options);
        const updatedSkill = await this.repositories.skillAssets.patch(skillId, {
          latestPublishedVersionId: version.skillVersionId,
          lifecycle: "ready",
          updatedAt: now,
        }, { workspaceId, ...options });
        if (!updatedSkill) throw new ProductStoreError("skill_not_found", "Skill not found.", { skillId });
        const release = await this.repositories.assetReleases.insert({
          schemaVersion: "workbench-v1",
          releaseId: releaseId ?? this.idFactory("release"),
          sourceWorkspaceId: workspaceId,
          assetKind: "skill",
          assetId: skillId,
          versionId: version.skillVersionId,
          version: version.version,
          contentHash: version.contentHash,
          visibility: "workspace",
          startingPoint: false,
          releaseNotes: data.releaseNotes,
          dependencies: cloneValue(version.dependencies),
          publishedBy,
          publishedAt: now,
        }, options);
        await this.repositories.auditEvents.append({
          schemaVersion: "workbench-v1",
          auditEventId: this.idFactory("audit"),
          workspaceId,
          actorId: publishedBy,
          action: "skill.published",
          entityKind: "skill_version",
          entityId: version.skillVersionId,
          createdAt: now,
        }, options);
        return { skill: updatedSkill, version, release };
      },
    );
  }

  async createLoop({
    idempotencyKey,
    request,
    workspaceId,
    authoredBy,
    workflowId,
    revisionId,
    session,
  } = {}) {
    requiredString(workspaceId, "workspace_id_required");
    requiredString(authoredBy, "user_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    if (!data || typeof data !== "object") {
      throw new ProductStoreError("create_loop_request_required", "Loop details are required.");
    }
    requiredString(data.name, "workflow_name_required");
    if (!data.definition || typeof data.definition !== "object") {
      throw new ProductStoreError("loop_definition_required", "A Loop definition is required.");
    }
    return this.runIdempotentMutation(
      {
        scope: "create-loop",
        key: idempotencyKey,
        request: requestSnapshot,
        workspaceId,
        session: session ?? this.defaultSession,
      },
      async (transactionSession) => {
        const options = { session: transactionSession };
        const now = this.#timestamp();
        const nextWorkflowId = workflowId ?? this.idFactory("workflow");
        const nextRevisionId = revisionId ?? this.idFactory("revision");
        const draft = initialLoopDraft();
        const revision = {
          schemaVersion: "workbench-v1",
          revisionId: nextRevisionId,
          workflowId: nextWorkflowId,
          revisionNumber: 1,
          baseRevisionId: null,
          graph: draft.graph,
          inputForm: draft.inputForm,
          outputDefinition: draft.outputDefinition,
          resourceRefs: [],
          runSettings: draft.runSettings,
          definition: cloneValue(data.definition),
          contentHash: canonicalRequestHash(revisionContent({ ...draft, resourceRefs: [], definition: data.definition })),
          authoredBy,
          saveReason: "Created from a goal.",
          compile: { status: "blocked", diagnostics: [] },
          createdAt: now,
          updatedAt: now,
        };
        const workflow = {
          schemaVersion: "workbench-v1",
          workflowId: nextWorkflowId,
          workspaceId,
          name: data.name,
          description: data.description ?? "",
          status: "draft",
          archived: false,
          ownerId: authoredBy,
          visibility: "private",
          lifecycle: "draft",
          currentRevisionId: nextRevisionId,
          createdAt: now,
          updatedAt: now,
          revisionNumber: 1,
          writeVersion: 1,
        };
        const insertedWorkflow = await this.repositories.workflows.insert(workflow, options);
        const insertedRevision = await this.repositories.workflowRevisions.insert(revision, options);
        return { workflow: insertedWorkflow, revision: insertedRevision };
      },
    );
  }

  async createLoopImport({
    uploadId,
    portableLoop,
    sourceContentHash,
    idempotencyKey,
    workspaceId,
    importedBy,
    importId,
    session,
  } = {}) {
    requiredString(uploadId, "upload_id_required");
    requiredString(sourceContentHash, "loop_package_hash_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(importedBy, "user_id_required");
    if (!portableLoop || typeof portableLoop !== "object") {
      throw new ProductStoreError("loop_package_invalid", "The Loop package could not be read.");
    }
    return this.runIdempotentMutation({
      scope: "create-loop-import",
      key: idempotencyKey,
      request: { uploadId, sourceContentHash },
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { workspaceId, session: transactionSession };
      const upload = await this.repositories.uploads.get(uploadId, options);
      if (
        !upload
        || (upload.assetKind ?? "skill") !== "loop"
        || upload.state !== "ready_draft"
        || !upload.objectId
      ) {
        throw new ProductStoreError("loop_upload_not_ready", "Finish checking the Loop package before importing it.");
      }
      const object = await this.repositories.objects.get(upload.objectId, options);
      if (!object || object.contentHash !== sourceContentHash) {
        throw new ProductStoreError("loop_package_integrity_failed", "The Loop package failed an integrity check.");
      }
      const now = this.#timestamp();
      const requirementStates = initialImportRequirementStates(portableLoop);
      const record = await this.repositories.loopImports.insert({
        schemaVersion: "workbench-v1",
        importId: importId ?? this.idFactory("loop-import"),
        workspaceId,
        uploadId,
        importedBy,
        status: requirementStates.length > 0 ? "needs_mapping" : "ready",
        sourceContentHash,
        portableLoop: cloneValue(portableLoop),
        requirementStates,
        diagnostics: [],
        committedWorkflowId: null,
        committedRevisionId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }, options);
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: importedBy,
        action: "loop.import_inspected",
        entityKind: "loop_import",
        entityId: record.importId,
        createdAt: now,
      }, options);
      return { data: productSafeLoopImport(record), etag: formatLoopImportEtag(record) };
    });
  }

  async getLoopImport({ importId, workspaceId, session } = {}) {
    requiredString(importId, "loop_import_id_required");
    requiredString(workspaceId, "workspace_id_required");
    await this.connect();
    const record = await this.repositories.loopImports.get(importId, {
      workspaceId,
      session: session ?? this.defaultSession,
    });
    if (!record) {
      throw new ProductStoreError("loop_import_not_found", "This Loop import was not found.");
    }
    return { data: productSafeLoopImport(record), etag: formatLoopImportEtag(record) };
  }

  async commitLoopImport({
    importId,
    idempotencyKey,
    ifMatch,
    request,
    workspaceId,
    importedBy,
    resolveEmbeddedMaterial,
    workflowId,
    revisionId,
    session,
  } = {}) {
    requiredString(importId, "loop_import_id_required");
    requiredString(ifMatch, "loop_import_etag_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(importedBy, "user_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    if (!data || typeof data !== "object") {
      throw new ProductStoreError("loop_import_mapping_required", "Choose the required workspace dependencies before importing this Loop.");
    }

    return this.runIdempotentMutation({
      scope: `commit-loop-import:${importId}`,
      key: idempotencyKey,
      request: { ifMatch, request: requestSnapshot },
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { workspaceId, session: transactionSession };
      const record = await this.repositories.loopImports.get(importId, options);
      if (!record) {
        throw new ProductStoreError("loop_import_not_found", "This Loop import was not found.");
      }
      if (record.status === "committed") {
        throw new ProductStoreError("loop_import_already_committed", "This Loop package has already been imported.");
      }
      if (formatLoopImportEtag(record) !== ifMatch) {
        throw new ProductStoreError("loop_import_revision_conflict", "The Loop import changed after it was opened.");
      }

      const report = await inspectPortableLoopImport({
        source: record.portableLoop,
        workspaceId,
        mappings: data,
        resolveSkillVersion: ({ skillVersionId }) => this.repositories.skillVersions.get(skillVersionId, options),
        resolveMaterial: async (query) => {
          if (query.resolution?.kind === "embeddedMaterial") {
            return resolveEmbeddedMaterial?.({ ...query, session: transactionSession });
          }
          return this.repositories.resources.get(query.resourceId, options);
        },
        resolveConnection: ({ connectionId }) => this.repositories.connections.get(connectionId, options),
      });
      if (report.status !== "ready") {
        throw new ProductStoreError(
          "loop_import_mapping_invalid",
          "One or more selected dependencies do not exactly match this Loop package.",
          { diagnostics: report.diagnostics, requirementStates: report.requirementStates },
        );
      }

      const draft = rewritePortableLoopImportGraph({
        portableLoop: record.portableLoop,
        resolutions: report.resolutions,
      });
      const now = this.#timestamp();
      const nextWorkflowId = workflowId ?? this.idFactory("workflow");
      const nextRevisionId = revisionId ?? this.idFactory("revision");
      const revision = {
        schemaVersion: "workbench-v1",
        revisionId: nextRevisionId,
        workflowId: nextWorkflowId,
        revisionNumber: 1,
        baseRevisionId: null,
        ...cloneValue(draft.revision),
        contentHash: canonicalRequestHash(revisionContent(draft.revision)),
        authoredBy: importedBy,
        saveReason: `Imported from portable Loop package ${record.sourceContentHash}.`,
        compile: { status: "blocked", diagnostics: [] },
        createdAt: now,
        updatedAt: now,
      };
      const workflow = {
        schemaVersion: "workbench-v1",
        workflowId: nextWorkflowId,
        workspaceId,
        ...cloneValue(draft.workflow),
        ownerId: importedBy,
        currentRevisionId: nextRevisionId,
        revisionNumber: 1,
        writeVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      const insertedWorkflow = await this.repositories.workflows.insert(workflow, options);
      const insertedRevision = await this.repositories.workflowRevisions.insert(revision, options);
      await persistConnectionBindings({
        repositories: this.repositories,
        workspaceId,
        targetKind: "workflow_revision",
        targetId: nextRevisionId,
        bindings: draft.connectionBindings,
        boundBy: importedBy,
        boundAt: now,
        options: { session: transactionSession },
      });
      const committed = await this.repositories.loopImports.patchWithRevision(importId, record.revision, {
        status: "committed",
        requirementStates: report.requirementStates,
        diagnostics: [],
        committedWorkflowId: nextWorkflowId,
        committedRevisionId: nextRevisionId,
        revision: record.revision + 1,
        updatedAt: now,
      }, options);
      if (!committed) {
        throw new ProductStoreError("loop_import_revision_conflict", "The Loop import changed while it was being committed.");
      }
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: importedBy,
        action: "loop.import_committed",
        entityKind: "workflow",
        entityId: nextWorkflowId,
        createdAt: now,
      }, options);
      return {
        workflow: publicWorkflow(insertedWorkflow),
        revision: insertedRevision,
        etag: formatWorkflowEtag(workflow),
      };
    });
  }

  async useTemplate({
    templateId,
    idempotencyKey,
    request,
    workspaceId = "workspace-local",
    authoredBy = "user-local",
    workflowId,
    revisionId,
    runSettings,
    session,
  }) {
    requiredString(templateId, "template_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    if (!data || typeof data !== "object") {
      throw new ProductStoreError("use_template_request_required");
    }
    requiredString(data.templateVersion, "template_version_required");
    requiredString(data.name, "workflow_name_required");

    return this.runIdempotentMutation(
      {
        scope: `use-template:${templateId}`,
        key: idempotencyKey,
        request: requestSnapshot,
        workspaceId,
        session: session ?? this.defaultSession,
      },
      async (transactionSession) => {
        const options = { session: transactionSession };
        const template = await this.repositories.templates.get(
          templateId,
          data.templateVersion,
          options,
        );
        if (!template) {
          throw new ProductStoreError("template_not_found", "Template not found.", {
            templateId,
            templateVersion: data.templateVersion,
          });
        }
        await rejectRetiredSkillReferences({
          skillAssets: this.repositories.skillAssets,
          references: addedSkillReferences(null, template.graph),
          workspaceId,
          options,
        });

        const nextWorkflowId = workflowId ?? this.idFactory("workflow");
        const nextRevisionId = revisionId ?? this.idFactory("revision");
        const now = this.#timestamp();
        const outputDefinition = templateOutputDefinition(template);
        const nextRunSettings = cloneValue(runSettings ?? defaultRunSettings(template));
        const revision = {
          schemaVersion: template.schemaVersion,
          revisionId: nextRevisionId,
          workflowId: nextWorkflowId,
          revisionNumber: 1,
          baseRevisionId: null,
          graph: cloneValue(template.graph),
          inputForm: cloneValue(template.inputForm),
          outputDefinition,
          resourceRefs: [],
          runSettings: nextRunSettings,
          contentHash: canonicalRequestHash(
            revisionContent({
              graph: template.graph,
              inputForm: template.inputForm,
              outputDefinition,
              resourceRefs: [],
              runSettings: nextRunSettings,
            }),
          ),
          authoredBy,
          saveReason: `Created from template ${template.templateId}@${template.templateVersion}.`,
          compile: { status: "blocked", diagnostics: [] },
          createdAt: now,
          updatedAt: now,
        };
        const workflow = {
          schemaVersion: template.schemaVersion,
          workflowId: nextWorkflowId,
          workspaceId,
          name: data.name,
          description: template.description,
          status: template.availability.status === "available" ? "draft" : "blocked",
          archived: false,
          currentRevisionId: nextRevisionId,
          sourceTemplate: {
            templateId: template.templateId,
            templateVersion: template.templateVersion,
          },
          createdAt: now,
          updatedAt: now,
          revisionNumber: 1,
          writeVersion: 1,
        };

        const insertedWorkflow = await this.repositories.workflows.insert(workflow, options);
        const insertedRevision = await this.repositories.workflowRevisions.insert(
          revision,
          options,
        );
        return { workflow: insertedWorkflow, revision: insertedRevision };
      },
    );
  }

  async duplicateLoop({
    workflowId,
    idempotencyKey,
    request,
    workspaceId,
    authoredBy,
    duplicatedWorkflowId,
    revisionId,
    sourceRevisionId,
    session,
  } = {}) {
    requiredString(workflowId, "workflow_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(authoredBy, "user_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.name, "workflow_name_required");

    return this.runIdempotentMutation(
      {
        scope: `duplicate-loop:${workflowId}`,
        key: idempotencyKey,
        request: { sourceRevisionId: sourceRevisionId ?? null, request: requestSnapshot },
        workspaceId,
        session: session ?? this.defaultSession,
      },
      async (transactionSession) => {
        const options = { session: transactionSession };
        const sourceWorkflow = await this.repositories.workflows.getInternal(workflowId, {
          workspaceId,
          ...options,
        });
        if (!sourceWorkflow) {
          throw new ProductStoreError("workflow_not_found", "Workflow not found.", { workflowId });
        }
        const copiedFromRevisionId = sourceRevisionId ?? sourceWorkflow.currentRevisionId;
        const sourceRevision = await this.repositories.workflowRevisions.get(
          workflowId,
          copiedFromRevisionId,
          options,
        );
        if (!sourceRevision) {
          throw new ProductStoreError(
            "workflow_revision_not_found",
            "Workflow revision not found.",
            { workflowId, revisionId: copiedFromRevisionId },
          );
        }

        const now = this.#timestamp();
        const nextWorkflowId = duplicatedWorkflowId ?? this.idFactory("workflow");
        const nextRevisionId = revisionId ?? this.idFactory("revision");
        const revisionContentValue = {
          graph: cloneValue(sourceRevision.graph),
          inputForm: cloneValue(sourceRevision.inputForm),
          outputDefinition: cloneValue(sourceRevision.outputDefinition),
          resourceRefs: cloneValue(sourceRevision.resourceRefs),
          runSettings: cloneValue(sourceRevision.runSettings),
          definition: cloneValue(sourceRevision.definition),
        };
        const revision = {
          ...revisionContentValue,
          schemaVersion: sourceRevision.schemaVersion,
          revisionId: nextRevisionId,
          workflowId: nextWorkflowId,
          revisionNumber: 1,
          baseRevisionId: null,
          contentHash: canonicalRequestHash(revisionContent(revisionContentValue)),
          authoredBy,
          saveReason: `Copied from workflow ${workflowId} revision ${sourceRevision.revisionId}.`,
          compile: { status: "blocked", diagnostics: [] },
          createdAt: now,
          updatedAt: now,
        };
        const workflow = {
          schemaVersion: sourceWorkflow.schemaVersion,
          workflowId: nextWorkflowId,
          workspaceId,
          name: data.name,
          description: sourceWorkflow.description,
          status: sourceWorkflow.status === "blocked" ? "blocked" : "draft",
          archived: false,
          ownerId: authoredBy,
          visibility: "private",
          lifecycle: sourceWorkflow.status === "blocked" ? "blocked" : "draft",
          currentRevisionId: nextRevisionId,
          ...(sourceWorkflow.sourceTemplate ? { sourceTemplate: cloneValue(sourceWorkflow.sourceTemplate) } : {}),
          sourceWorkflow: {
            workflowId,
            revisionId: sourceRevision.revisionId,
          },
          createdAt: now,
          updatedAt: now,
          revisionNumber: 1,
          writeVersion: 1,
        };
        const insertedWorkflow = await this.repositories.workflows.insert(workflow, options);
        const insertedRevision = await this.repositories.workflowRevisions.insert(revision, options);
        return { workflow: insertedWorkflow, revision: insertedRevision };
      },
    );
  }

  async getWorkflow(workflowId, { workspaceId, session } = {}) {
    await this.connect();
    const workflow = await this.repositories.workflows.getInternal(workflowId, {
      workspaceId,
      session: session ?? this.defaultSession,
    });
    if (!workflow) {
      throw new ProductStoreError("workflow_not_found", "Workflow not found.", {
        workflowId,
      });
    }
    return {
      workflow: publicWorkflow(workflow),
      etag: formatWorkflowEtag(workflow),
    };
  }

  async saveWorkflowRevision({
    workflowId,
    idempotencyKey,
    ifMatch,
    request,
    workspaceId,
    authoredBy = "user-local",
    revisionId,
    session,
  }) {
    requiredString(workflowId, "workflow_id_required");
    requiredString(ifMatch, "workflow_etag_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    if (!data || typeof data !== "object") {
      throw new ProductStoreError("save_revision_request_required");
    }
    requiredString(data.baseRevisionId, "base_revision_id_required");

    return this.runIdempotentMutation(
      {
        scope: `save-workflow-revision:${workflowId}`,
        key: idempotencyKey,
        request: { ifMatch, request: requestSnapshot },
        workspaceId,
        session: session ?? this.defaultSession,
      },
      async (transactionSession) => {
        const options = { session: transactionSession };
        const workflow = await this.repositories.workflows.getInternal(workflowId, { workspaceId, ...options });
        if (!workflow) {
          throw new ProductStoreError("workflow_not_found", "Workflow not found.", {
            workflowId,
          });
        }
        const currentEtag = formatWorkflowEtag(workflow);
        if (ifMatch !== currentEtag || data.baseRevisionId !== workflow.currentRevisionId) {
          throw new ProductStoreError(
            "workflow_revision_conflict",
            "The workflow changed after it was read.",
            {
              workflowId,
              expectedEtag: ifMatch,
              currentEtag,
              expectedBaseRevisionId: data.baseRevisionId,
              currentRevisionId: workflow.currentRevisionId,
            },
          );
        }

        const baseRevision = await this.repositories.workflowRevisions.get(
          workflowId,
          data.baseRevisionId,
          { workspaceId, ...options },
        );
        if (!baseRevision) {
          throw new ProductStoreError(
            "workflow_revision_not_found",
            "Workflow revision not found.",
            { workflowId, revisionId: data.baseRevisionId },
          );
        }
        await rejectRetiredSkillReferences({
          skillAssets: this.repositories.skillAssets,
          references: addedSkillReferences(baseRevision.graph, data.graph),
          workspaceId,
          options,
        });
        const nextDefinition = data.definition ?? baseRevision.definition;

        const nextRevisionId = revisionId ?? this.idFactory("revision");
        const nextRevisionNumber = workflow.revisionNumber + 1;
        const nextWriteVersion = workflow.writeVersion + 1;
        const now = this.#timestamp();
        const revision = {
          schemaVersion: workflow.schemaVersion,
          revisionId: nextRevisionId,
          workflowId,
          revisionNumber: nextRevisionNumber,
          baseRevisionId: data.baseRevisionId,
          graph: cloneValue(data.graph),
          inputForm: cloneValue(data.inputForm),
          outputDefinition: cloneValue(data.outputDefinition),
          resourceRefs: cloneValue(data.resourceRefs),
          runSettings: cloneValue(data.runSettings),
          ...(nextDefinition ? { definition: cloneValue(nextDefinition) } : {}),
          contentHash: canonicalRequestHash(revisionContent({ ...data, definition: nextDefinition })),
          authoredBy,
          saveReason: data.saveReason,
          compile: { status: "blocked", diagnostics: [] },
          createdAt: now,
          updatedAt: now,
        };
        const insertedRevision = await this.repositories.workflowRevisions.insert(
          revision,
          options,
        );
        const advancedWorkflow = await this.repositories.workflows.advanceRevisionInternal(
          workflowId,
          {
            expectedRevisionId: workflow.currentRevisionId,
            expectedWriteVersion: workflow.writeVersion,
            currentRevisionId: nextRevisionId,
            revisionNumber: nextRevisionNumber,
            writeVersion: nextWriteVersion,
            updatedAt: now,
          },
          { workspaceId, ...options },
        );
        if (!advancedWorkflow) {
          throw new ProductStoreError(
            "workflow_revision_conflict",
            "The workflow changed while the revision was being saved.",
            { workflowId },
          );
        }
        return {
          workflow: publicWorkflow(advancedWorkflow),
          revision: insertedRevision,
          etag: formatWorkflowEtag(advancedWorkflow),
        };
      },
    );
  }

  async getLoopSkillUpdatePreview({
    workflowId,
    skillVersionId,
    workspaceId,
    requestedBy,
    session,
  } = {}) {
    requiredString(workflowId, "workflow_id_required");
    requiredString(skillVersionId, "skill_version_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(requestedBy, "user_id_required");
    await this.connect();
    const options = { workspaceId, session: session ?? this.defaultSession };
    const workflow = await this.repositories.workflows.getInternal(workflowId, options);
    if (!workflow) {
      throw new ProductStoreError("workflow_not_found", "Workflow not found.", { workflowId });
    }
    if (workflow.ownerId !== requestedBy) {
      throw new ProductStoreError("loop_owner_required", "Only the Loop owner can create an update draft.", { workflowId });
    }
    const targetVersion = await this.repositories.skillVersions.get(skillVersionId, options);
    if (!targetVersion) {
      throw new ProductStoreError("skill_version_not_found", "The selected Skill version was not found.", { skillVersionId });
    }
    await rejectRetiredSkillReferences({
      skillAssets: this.repositories.skillAssets,
      references: [{ skillId: targetVersion.skillId, version: targetVersion.version }],
      workspaceId,
      options,
    });
    const baseRevision = await this.repositories.workflowRevisions.get(
      workflowId,
      workflow.currentRevisionId,
      options,
    );
    if (!baseRevision) {
      throw new ProductStoreError("workflow_revision_not_found", "Workflow revision not found.", {
        workflowId,
        revisionId: workflow.currentRevisionId,
      });
    }
    const matchingNodes = baseRevision.graph.nodes.filter(
      (node) => node.kind === "Skill" && node.skillRef?.skillId === targetVersion.skillId,
    );
    const currentVersions = [...new Set(
      matchingNodes
        .map((node) => node.skillRef?.version)
        .filter((version) => version && version !== targetVersion.version),
    )];
    if (currentVersions.length === 0) {
      const code = matchingNodes.length > 0 ? "loop_skill_update_unchanged" : "loop_skill_update_not_found";
      throw new ProductStoreError(code, matchingNodes.length > 0
        ? "This Loop already uses the selected Skill version."
        : "This Loop does not use the selected Skill.", {
        workflowId,
        skillId: targetVersion.skillId,
      });
    }
    if (currentVersions.length > 1) {
      throw new ProductStoreError(
        "loop_skill_update_ambiguous",
        "This Loop uses more than one version of the Skill. Update each version from the Builder.",
        { workflowId, skillId: targetVersion.skillId },
      );
    }
    const [fromVersion] = currentVersions;
    const currentVersion = await this.repositories.skillVersions.getBySkillRef(
      targetVersion.skillId,
      fromVersion,
      options,
    );
    if (!currentVersion) {
      throw new ProductStoreError("skill_version_not_found", "The current Skill version was not found.", {
        skillId: targetVersion.skillId,
        version: fromVersion,
      });
    }
    const diff = await this.getSkillVersionDiff({
      skillId: targetVersion.skillId,
      fromVersionId: currentVersion.skillVersionId,
      toVersionId: targetVersion.skillVersionId,
      workspaceId,
      session: options.session,
    });
    return {
      preview: {
        workflowId,
        workflowRevisionId: baseRevision.revisionId,
        workflowName: workflow.name,
        skillId: targetVersion.skillId,
        currentVersion: loopSkillUpdateVersion(currentVersion),
        targetVersion: loopSkillUpdateVersion(targetVersion),
        affectedNodes: matchingNodes
          .filter((node) => node.skillRef?.version === fromVersion)
          .map((node) => ({ nodeId: node.nodeId, title: node.title })),
        changes: diff.entries,
        requiresTestRun: true,
      },
      etag: formatWorkflowEtag(workflow),
    };
  }

  async createLoopSkillUpdate({
    workflowId,
    idempotencyKey,
    ifMatch,
    request,
    workspaceId,
    authoredBy,
    revisionId,
    session,
  } = {}) {
    requiredString(workflowId, "workflow_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(authoredBy, "user_id_required");
    requiredString(ifMatch, "workflow_etag_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.skillId, "skill_id_required");
    requiredString(data?.fromVersion, "skill_version_required");
    requiredString(data?.toVersion, "skill_version_required");
    if (data.fromVersion === data.toVersion) {
      throw new ProductStoreError("loop_skill_update_unchanged", "Choose a newer Skill version before creating an update.");
    }
    return this.runIdempotentMutation(
      {
        scope: `create-loop-skill-update:${workflowId}`,
        key: idempotencyKey,
        request: { ifMatch, request: requestSnapshot },
        workspaceId,
        session: session ?? this.defaultSession,
      },
      async (transactionSession) => {
        const options = { workspaceId, session: transactionSession };
        const workflow = await this.repositories.workflows.getInternal(workflowId, options);
        if (!workflow) {
          throw new ProductStoreError("workflow_not_found", "Workflow not found.", { workflowId });
        }
        if (workflow.ownerId !== authoredBy) {
          throw new ProductStoreError("loop_owner_required", "Only the Loop owner can create an update draft.", { workflowId });
        }
        const currentEtag = formatWorkflowEtag(workflow);
        if (ifMatch !== currentEtag) {
          throw new ProductStoreError("workflow_revision_conflict", "The workflow changed after it was read.", {
            workflowId,
            expectedEtag: ifMatch,
            currentEtag,
          });
        }
        const targetVersion = await this.repositories.skillVersions.getBySkillRef(
          data.skillId,
          data.toVersion,
          options,
        );
        if (!targetVersion) {
          throw new ProductStoreError("skill_version_not_found", "The selected Skill version was not found.", {
            skillId: data.skillId,
            version: data.toVersion,
          });
        }
        const resolvedConnectionBindings = await validateRequiredConnectionBindings({
          requirements: targetVersion.connectionRequirements ?? [],
          connectionBindings: data.connectionBindings ?? [],
          repositories: this.repositories,
          workspaceId,
          options,
        });
        await rejectRetiredSkillReferences({
          skillAssets: this.repositories.skillAssets,
          references: [{ skillId: data.skillId, version: data.toVersion }],
          workspaceId,
          options,
        });
        const baseRevision = await this.repositories.workflowRevisions.get(
          workflowId,
          workflow.currentRevisionId,
          options,
        );
        if (!baseRevision) {
          throw new ProductStoreError("workflow_revision_not_found", "Workflow revision not found.", {
            workflowId,
            revisionId: workflow.currentRevisionId,
          });
        }
        let replacements = 0;
        const graph = cloneValue(baseRevision.graph);
        graph.nodes = graph.nodes.map((node) => {
          if (
            node.kind !== "Skill"
            || node.skillRef?.skillId !== data.skillId
            || node.skillRef?.version !== data.fromVersion
          ) return node;
          replacements += 1;
          return { ...node, skillRef: { skillId: data.skillId, version: data.toVersion } };
        });
        if (replacements === 0) {
          throw new ProductStoreError("loop_skill_update_not_found", "This workflow does not use the selected Skill version.", {
            workflowId,
            skillId: data.skillId,
            version: data.fromVersion,
          });
        }
        const now = this.#timestamp();
        const nextRevisionId = revisionId ?? this.idFactory("revision");
        const revision = {
          schemaVersion: workflow.schemaVersion,
          revisionId: nextRevisionId,
          workflowId,
          revisionNumber: workflow.revisionNumber + 1,
          baseRevisionId: baseRevision.revisionId,
          graph,
          inputForm: cloneValue(baseRevision.inputForm),
          outputDefinition: cloneValue(baseRevision.outputDefinition),
          resourceRefs: cloneValue(baseRevision.resourceRefs),
          runSettings: cloneValue(baseRevision.runSettings),
          ...(baseRevision.definition ? { definition: cloneValue(baseRevision.definition) } : {}),
          contentHash: canonicalRequestHash(revisionContent({
            graph,
            inputForm: baseRevision.inputForm,
            outputDefinition: baseRevision.outputDefinition,
            resourceRefs: baseRevision.resourceRefs,
            runSettings: baseRevision.runSettings,
            definition: baseRevision.definition,
          })),
          authoredBy,
          saveReason: `Updated ${data.skillId} from ${data.fromVersion} to ${targetVersion.version}.`,
          compile: { status: "blocked", diagnostics: [] },
          createdAt: now,
          updatedAt: now,
        };
        const insertedRevision = await this.repositories.workflowRevisions.insert(revision, options);
        const priorBindings = await this.repositories.connectionBindings.listByTarget({
          workspaceId,
          targetKind: "workflow_revision",
          targetId: baseRevision.revisionId,
        }, options);
        const replacedRequirementIds = new Set(
          (targetVersion.connectionRequirements ?? []).map((requirement) => requirement.requirementId),
        );
        const nextBindings = [
          ...priorBindings
            .filter((binding) => !replacedRequirementIds.has(binding.requirementId))
            .map(({ requirementId, connectionId }) => ({ requirementId, connectionId })),
          ...resolvedConnectionBindings,
        ];
        await persistConnectionBindings({
          repositories: this.repositories,
          workspaceId,
          targetKind: "workflow_revision",
          targetId: nextRevisionId,
          bindings: nextBindings,
          boundBy: authoredBy,
          boundAt: now,
          options,
        });
        const advancedWorkflow = await this.repositories.workflows.advanceRevisionInternal(
          workflowId,
          {
            expectedRevisionId: workflow.currentRevisionId,
            expectedWriteVersion: workflow.writeVersion,
            currentRevisionId: nextRevisionId,
            revisionNumber: revision.revisionNumber,
            writeVersion: workflow.writeVersion + 1,
            updatedAt: now,
          },
          options,
        );
        if (!advancedWorkflow) {
          throw new ProductStoreError("workflow_revision_conflict", "The workflow changed while the update was being saved.", { workflowId });
        }
        await this.repositories.auditEvents.append({
          schemaVersion: "workbench-v1",
          auditEventId: this.idFactory("audit"),
          workspaceId,
          actorId: authoredBy,
          action: "loop.skill_update_created",
          entityKind: "workflow_revision",
          entityId: nextRevisionId,
          createdAt: now,
        }, { session: transactionSession });
        if (resolvedConnectionBindings.length > 0) {
          await this.repositories.auditEvents.append({
            schemaVersion: "workbench-v1",
            auditEventId: this.idFactory("audit"),
            workspaceId,
            actorId: authoredBy,
            action: "connection.rebound",
            entityKind: "workflow_revision",
            entityId: nextRevisionId,
            createdAt: now,
          }, { session: transactionSession });
        }
        return {
          workflow: publicWorkflow(advancedWorkflow),
          revision: insertedRevision,
          etag: formatWorkflowEtag(advancedWorkflow),
        };
      },
    );
  }

  async publishLoop({
    workflowId,
    idempotencyKey,
    ifMatch,
    request,
    workspaceId,
    releasedBy,
    loopVersionId,
    releaseId,
    session,
  } = {}) {
    requiredString(workflowId, "workflow_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(releasedBy, "user_id_required");
    requiredString(ifMatch, "workflow_etag_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.version, "loop_version_required");
    if (typeof data?.releaseNotes !== "string" || typeof data?.startingPoint !== "boolean") {
      throw new ProductStoreError("loop_publish_request_invalid", "Loop publication details are invalid.");
    }
    return this.runIdempotentMutation({
      scope: `publish-loop:${workflowId}`,
      key: idempotencyKey,
      request: { ifMatch, request: requestSnapshot },
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { session: transactionSession };
      const workflow = await this.repositories.workflows.getInternal(workflowId, { ...options, workspaceId });
      if (!workflow) throw new ProductStoreError("workflow_not_found", "Workflow not found.", { workflowId });
      if (formatWorkflowEtag(workflow) !== ifMatch) {
        throw new ProductStoreError("workflow_revision_conflict", "The workflow changed after it was read.", { workflowId });
      }
      if (workflow.latestCompile?.revisionId !== workflow.currentRevisionId || workflow.latestCompile?.status !== "ready") {
        throw new ProductStoreError("loop_compile_required", "Compile the current Loop revision before publishing.", { workflowId });
      }
      const completedRun = await this.repositories.runs.getLatestCompletedByWorkflowRevision(
        workflowId,
        workflow.currentRevisionId,
        options,
      );
      if (!completedRun) {
        throw new ProductStoreError(
          "loop_test_run_required",
          "Complete a test run of the current saved Loop before publishing.",
          { workflowId, workflowRevisionId: workflow.currentRevisionId },
        );
      }
      const revision = await this.repositories.workflowRevisions.get(workflowId, workflow.currentRevisionId, options);
      if (!revision?.definition) {
        throw new ProductStoreError("loop_definition_required", "A Loop definition is required before publication.", { workflowId });
      }
      const pinnedSkills = revision.graph.nodes
        .filter((node) => node.kind === "Skill")
        .map((node) => cloneValue(node.skillRef));
      for (const skillRef of pinnedSkills) {
        const published = await this.repositories.skillVersions.getBySkillRef(
          skillRef.skillId,
          skillRef.version,
          { workspaceId, ...options },
        );
        if (!published) {
          throw new ProductStoreError("loop_skill_version_unavailable", "Publish each referenced Skill version before publishing this Loop.", {
            workflowId,
            skillRef,
          });
        }
      }
      const nextLoopVersionId = loopVersionId ?? this.idFactory("loop-version");
      const nextReleaseId = releaseId ?? this.idFactory("release");
      const now = this.#timestamp();
      const loopVersion = await this.repositories.loopVersions.insert({
        schemaVersion: "workbench-v1",
        loopVersionId: nextLoopVersionId,
        workflowId,
        workflowRevisionId: revision.revisionId,
        workspaceId,
        version: data.version,
        definition: cloneValue(revision.definition),
        pinnedSkills,
        contentHash: revision.contentHash,
        releasedBy,
        releasedAt: now,
      }, options);
      const release = await this.repositories.assetReleases.insert({
        schemaVersion: "workbench-v1",
        releaseId: nextReleaseId,
        sourceWorkspaceId: workspaceId,
        assetKind: "loop",
        assetId: workflowId,
        versionId: nextLoopVersionId,
        version: loopVersion.version,
        contentHash: revision.contentHash,
        visibility: "workspace",
        startingPoint: data.startingPoint,
        releaseNotes: data.releaseNotes,
        dependencies: [],
        publishedBy: releasedBy,
        publishedAt: now,
      }, options);
      const shared = await this.repositories.workflows.markSharedInternal(
        workflowId,
        {
          expectedRevisionId: workflow.currentRevisionId,
          expectedWriteVersion: workflow.writeVersion,
          updatedAt: now,
        },
        options,
      );
      if (!shared) throw new ProductStoreError("workflow_revision_conflict", "The workflow changed while publishing.", { workflowId });
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: releasedBy,
        action: "loop.published",
        entityKind: "loop_version",
        entityId: loopVersion.loopVersionId,
        createdAt: now,
      }, options);
      return { loopVersion, release };
    });
  }

  async listTeamLibrary({ workspaceId, session } = {}) {
    requiredString(workspaceId, "workspace_id_required");
    await this.connect();
    return this.repositories.assetReleases.listBySourceWorkspace(workspaceId, { session: session ?? this.defaultSession });
  }

  async installRelease({
    releaseId,
    idempotencyKey,
    request,
    workspaceId,
    installedBy,
    installationId,
    session,
  } = {}) {
    requiredString(releaseId, "release_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(installedBy, "user_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot) ?? {};
    return this.runIdempotentMutation({
      scope: `install-release:${releaseId}`,
      key: idempotencyKey,
      request: requestSnapshot,
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { session: transactionSession };
      const release = await this.repositories.assetReleases.get(releaseId, options);
      if (!release || release.sourceWorkspaceId !== workspaceId || release.visibility !== "workspace") {
        throw new ProductStoreError("release_not_available", "This Team library item is not available in the current workspace.", { releaseId });
      }
      const requirements = await collectReleaseConnectionRequirements({
        release,
        repositories: this.repositories,
        options,
      });
      const resolvedConnectionBindings = await validateRequiredConnectionBindings({
        requirements,
        connectionBindings: data.connectionBindings ?? [],
        repositories: this.repositories,
        workspaceId,
        options,
      });
      const existing = (await this.repositories.assetInstallations.list({ workspaceId, ...options }))
        .find((item) => item.releaseId === releaseId && item.state !== "removed");
      const now = this.#timestamp();
      const installation = existing ?? await this.repositories.assetInstallations.insert({
          schemaVersion: "workbench-v1",
          installationId: installationId ?? this.idFactory("installation"),
          workspaceId,
          releaseId,
          assetKind: release.assetKind,
          upstreamAssetId: release.assetId,
          pinnedVersionId: release.versionId,
          state: "installed",
          installedBy,
          installedAt: now,
          updatedAt: now,
        }, options);
      await persistConnectionBindings({
        repositories: this.repositories,
        workspaceId,
        targetKind: "asset_installation",
        targetId: installation.installationId,
        bindings: resolvedConnectionBindings,
        boundBy: installedBy,
        boundAt: now,
        options,
      });
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: installedBy,
        action: "team_library.installed",
        entityKind: "asset_installation",
        entityId: installation.installationId,
        createdAt: now,
      }, options);
      if (resolvedConnectionBindings.length > 0) {
        await this.repositories.auditEvents.append({
          schemaVersion: "workbench-v1",
          auditEventId: this.idFactory("audit"),
          workspaceId,
          actorId: installedBy,
          action: "connection.rebound",
          entityKind: "asset_installation",
          entityId: installation.installationId,
          createdAt: now,
        }, options);
      }
      return installation;
    });
  }

  async adoptInstallationRelease({
    installationId,
    idempotencyKey,
    request,
    workspaceId,
    adoptedBy,
    session,
  } = {}) {
    requiredString(installationId, "installation_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(adoptedBy, "user_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.releaseId, "release_id_required");
    return this.runIdempotentMutation({
      scope: `adopt-installation-release:${installationId}`,
      key: idempotencyKey,
      request: requestSnapshot,
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { workspaceId, session: transactionSession };
      const installation = await this.repositories.assetInstallations.get(installationId, options);
      if (!installation || installation.state === "removed") {
        throw new ProductStoreError("installation_not_found", "This installed item is not available.", { installationId });
      }
      const release = await this.repositories.assetReleases.get(data.releaseId, { session: transactionSession });
      if (
        !release
        || release.sourceWorkspaceId !== workspaceId
        || release.visibility !== "workspace"
        || release.assetKind !== installation.assetKind
        || release.assetId !== installation.upstreamAssetId
      ) {
        throw new ProductStoreError("release_not_available", "This release cannot update the installed item.", {
          installationId,
          releaseId: data.releaseId,
        });
      }
      const requirements = await collectReleaseConnectionRequirements({
        release,
        repositories: this.repositories,
        options,
      });
      const resolvedConnectionBindings = await validateRequiredConnectionBindings({
        requirements,
        connectionBindings: data.connectionBindings ?? [],
        repositories: this.repositories,
        workspaceId,
        options,
      });
      if (installation.releaseId === release.releaseId && installation.pinnedVersionId === release.versionId) {
        await persistConnectionBindings({
          repositories: this.repositories,
          workspaceId,
          targetKind: "asset_installation",
          targetId: installationId,
          bindings: resolvedConnectionBindings,
          boundBy: adoptedBy,
          boundAt: this.#timestamp(),
          options,
        });
        return installation;
      }
      const now = this.#timestamp();
      const updated = await this.repositories.assetInstallations.patch(installationId, {
        releaseId: release.releaseId,
        pinnedVersionId: release.versionId,
        state: "installed",
        updatedAt: now,
      }, options);
      await persistConnectionBindings({
        repositories: this.repositories,
        workspaceId,
        targetKind: "asset_installation",
        targetId: installationId,
        bindings: resolvedConnectionBindings,
        boundBy: adoptedBy,
        boundAt: now,
        options,
      });
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: adoptedBy,
        action: "team_library.installation_updated",
        entityKind: "asset_installation",
        entityId: installationId,
        createdAt: now,
      }, { session: transactionSession });
      if (resolvedConnectionBindings.length > 0) {
        await this.repositories.auditEvents.append({
          schemaVersion: "workbench-v1",
          auditEventId: this.idFactory("audit"),
          workspaceId,
          actorId: adoptedBy,
          action: "connection.rebound",
          entityKind: "asset_installation",
          entityId: installationId,
          createdAt: now,
        }, { session: transactionSession });
      }
      return updated;
    });
  }

  async useReleaseAsStartingPoint({
    releaseId,
    idempotencyKey,
    request,
    workspaceId,
    authoredBy,
    workflowId,
    revisionId,
    session,
  } = {}) {
    requiredString(releaseId, "release_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(authoredBy, "user_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.name, "workflow_name_required");
    return this.runIdempotentMutation({
      scope: `release-starting-point:${releaseId}`,
      key: idempotencyKey,
      request: requestSnapshot,
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { session: transactionSession };
      const release = await this.repositories.assetReleases.get(releaseId, options);
      if (
        !release
        || release.sourceWorkspaceId !== workspaceId
        || release.visibility !== "workspace"
        || release.assetKind !== "loop"
        || !release.startingPoint
      ) {
        throw new ProductStoreError("release_not_available", "This Team library item is not available as a starting point.", { releaseId });
      }
      const requirements = await collectReleaseConnectionRequirements({
        release,
        repositories: this.repositories,
        options,
      });
      const resolvedConnectionBindings = await validateRequiredConnectionBindings({
        requirements,
        connectionBindings: data.connectionBindings ?? [],
        repositories: this.repositories,
        workspaceId,
        options,
      });
      const loopVersion = await this.repositories.loopVersions.get(release.versionId, { ...options, workspaceId });
      if (!loopVersion) throw new ProductStoreError("loop_version_not_found", "The released Loop version was not found.", { releaseId });
      const sourceRevision = await this.repositories.workflowRevisions.get(
        loopVersion.workflowId,
        loopVersion.workflowRevisionId,
        options,
      );
      if (!sourceRevision) throw new ProductStoreError("workflow_revision_not_found", "The released Loop revision was not found.", { releaseId });
      const nextWorkflowId = workflowId ?? this.idFactory("workflow");
      const nextRevisionId = revisionId ?? this.idFactory("revision");
      const now = this.#timestamp();
      const workflow = await this.repositories.workflows.insert({
        schemaVersion: "workbench-v1",
        workflowId: nextWorkflowId,
        workspaceId,
        name: data.name,
        description: `Created from Team library release ${releaseId}.`,
        status: "draft",
        archived: false,
        ownerId: authoredBy,
        visibility: "private",
        lifecycle: "draft",
        currentRevisionId: nextRevisionId,
        createdAt: now,
        updatedAt: now,
        revisionNumber: 1,
        writeVersion: 1,
      }, options);
      const revision = await this.repositories.workflowRevisions.insert({
        schemaVersion: "workbench-v1",
        revisionId: nextRevisionId,
        workflowId: nextWorkflowId,
        revisionNumber: 1,
        baseRevisionId: null,
        graph: cloneValue(sourceRevision.graph),
        inputForm: cloneValue(sourceRevision.inputForm),
        outputDefinition: cloneValue(sourceRevision.outputDefinition),
        resourceRefs: cloneValue(sourceRevision.resourceRefs),
        runSettings: cloneValue(sourceRevision.runSettings),
        definition: cloneValue(sourceRevision.definition),
        contentHash: sourceRevision.contentHash,
        authoredBy,
        saveReason: `Created from Team library release ${releaseId}.`,
        compile: { status: "blocked", diagnostics: [] },
        createdAt: now,
        updatedAt: now,
      }, options);
      await persistConnectionBindings({
        repositories: this.repositories,
        workspaceId,
        targetKind: "workflow_revision",
        targetId: nextRevisionId,
        bindings: resolvedConnectionBindings,
        boundBy: authoredBy,
        boundAt: now,
        options,
      });
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: authoredBy,
        action: "team_library.starting_point_created",
        entityKind: "workflow",
        entityId: nextWorkflowId,
        createdAt: now,
      }, options);
      if (resolvedConnectionBindings.length > 0) {
        await this.repositories.auditEvents.append({
          schemaVersion: "workbench-v1",
          auditEventId: this.idFactory("audit"),
          workspaceId,
          actorId: authoredBy,
          action: "connection.rebound",
          entityKind: "workflow_revision",
          entityId: nextRevisionId,
          createdAt: now,
        }, options);
      }
      return { workflow, revision };
    });
  }

  async forkTeamLibraryLoop({
    releaseId,
    idempotencyKey,
    request,
    workspaceId,
    authoredBy,
    workflowId,
    revisionId,
    session,
  } = {}) {
    requiredString(releaseId, "release_id_required");
    requiredString(workspaceId, "workspace_id_required");
    requiredString(authoredBy, "user_id_required");
    const requestSnapshot = cloneValue(request);
    const data = requestData(requestSnapshot);
    requiredString(data?.name, "workflow_name_required");
    return this.runIdempotentMutation({
      scope: `fork-team-library-loop:${releaseId}`,
      key: idempotencyKey,
      request: requestSnapshot,
      workspaceId,
      session: session ?? this.defaultSession,
    }, async (transactionSession) => {
      const options = { session: transactionSession };
      const release = await this.repositories.assetReleases.get(releaseId, options);
      if (
        !release
        || release.sourceWorkspaceId !== workspaceId
        || release.visibility !== "workspace"
        || release.assetKind !== "loop"
      ) {
        throw new ProductStoreError("release_not_available", "This Team library Loop is not available in the current workspace.", { releaseId });
      }
      const requirements = await collectReleaseConnectionRequirements({
        release,
        repositories: this.repositories,
        options,
      });
      const resolvedConnectionBindings = await validateRequiredConnectionBindings({
        requirements,
        connectionBindings: data.connectionBindings ?? [],
        repositories: this.repositories,
        workspaceId,
        options,
      });
      const loopVersion = await this.repositories.loopVersions.get(release.versionId, { ...options, workspaceId });
      if (!loopVersion) {
        throw new ProductStoreError("loop_version_not_found", "The released Loop version was not found.", { releaseId });
      }
      const sourceRevision = await this.repositories.workflowRevisions.get(
        loopVersion.workflowId,
        loopVersion.workflowRevisionId,
        options,
      );
      if (!sourceRevision) {
        throw new ProductStoreError("workflow_revision_not_found", "The released Loop revision was not found.", { releaseId });
      }

      const nextWorkflowId = workflowId ?? this.idFactory("workflow");
      const nextRevisionId = revisionId ?? this.idFactory("revision");
      const now = this.#timestamp();
      const revisionContentValue = {
        graph: cloneValue(sourceRevision.graph),
        inputForm: cloneValue(sourceRevision.inputForm),
        outputDefinition: cloneValue(sourceRevision.outputDefinition),
        resourceRefs: cloneValue(sourceRevision.resourceRefs),
        runSettings: cloneValue(sourceRevision.runSettings),
        definition: cloneValue(sourceRevision.definition),
      };
      const workflow = await this.repositories.workflows.insert({
        schemaVersion: "workbench-v1",
        workflowId: nextWorkflowId,
        workspaceId,
        name: data.name,
        description: `Forked from Team library release ${releaseId}.`,
        status: "draft",
        archived: false,
        ownerId: authoredBy,
        visibility: "private",
        lifecycle: "draft",
        currentRevisionId: nextRevisionId,
        sourceWorkflow: {
          workflowId: loopVersion.workflowId,
          revisionId: sourceRevision.revisionId,
        },
        sourceRelease: {
          releaseId,
          sourceWorkspaceId: release.sourceWorkspaceId,
          versionId: loopVersion.loopVersionId,
          forkedAt: now,
        },
        createdAt: now,
        updatedAt: now,
        revisionNumber: 1,
        writeVersion: 1,
      }, options);
      const revision = await this.repositories.workflowRevisions.insert({
        ...revisionContentValue,
        schemaVersion: sourceRevision.schemaVersion,
        revisionId: nextRevisionId,
        workflowId: nextWorkflowId,
        revisionNumber: 1,
        baseRevisionId: null,
        contentHash: canonicalRequestHash(revisionContent(revisionContentValue)),
        authoredBy,
        saveReason: `Forked from Team library release ${releaseId}.`,
        compile: { status: "blocked", diagnostics: [] },
        createdAt: now,
        updatedAt: now,
      }, options);
      await persistConnectionBindings({
        repositories: this.repositories,
        workspaceId,
        targetKind: "workflow_revision",
        targetId: nextRevisionId,
        bindings: resolvedConnectionBindings,
        boundBy: authoredBy,
        boundAt: now,
        options,
      });
      await this.repositories.auditEvents.append({
        schemaVersion: "workbench-v1",
        auditEventId: this.idFactory("audit"),
        workspaceId,
        actorId: authoredBy,
        action: "team_library.loop_forked",
        entityKind: "workflow",
        entityId: nextWorkflowId,
        createdAt: now,
      }, options);
      if (resolvedConnectionBindings.length > 0) {
        await this.repositories.auditEvents.append({
          schemaVersion: "workbench-v1",
          auditEventId: this.idFactory("audit"),
          workspaceId,
          actorId: authoredBy,
          action: "connection.rebound",
          entityKind: "workflow_revision",
          entityId: nextRevisionId,
          createdAt: now,
        }, options);
      }
      return { workflow, revision };
    });
  }

  async appendRunEvent(event, { session } = {}) {
    requiredString(event?.runId, "run_id_required");
    requiredString(event?.eventId, "event_id_required");
    await this.connect();
    return this.withTransaction(
      async (transactionSession) => {
        const options = { session: transactionSession };
        const run = await this.repositories.runs.incrementEventSequence(
          event.runId,
          options,
        );
        if (!run) {
          throw new ProductStoreError("run_not_found", "Run not found.", {
            runId: event.runId,
          });
        }
        const { _id, sequence: _ignoredSequence, ...eventWithoutSequence } = event;
        return this.repositories.runEvents.insert(
          {
            ...cloneValue(eventWithoutSequence),
            sequence: run.eventSequence,
          },
          options,
        );
      },
      { session: session ?? this.defaultSession },
    );
  }
}

export { PRODUCT_REPLICA_SET };
