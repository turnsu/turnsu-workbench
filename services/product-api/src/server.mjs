import { PostgresAgentConnectorStore } from './connections/postgres-agent-connectors.mjs';
import { createManagedConnectorHttp } from './connectors/http.mjs';
import { PostgresMemberAgentService } from "./member-agents/postgres-member-agent-service.mjs";
import { PostgresNativeSkillPackageReader } from "./skills/postgres-native-skill-package-reader.mjs";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AUTHORIZATION_CAPABILITIES } from "@turnsu/workbench-contracts";

import { AgentTurnRunner } from "./agents/agent-turn-runner.mjs";
import { ProductAgentProposalService } from "./agents/agent-proposal-service.mjs";
import { StdioAgentToolApprovalServer } from "./agents/stdio-agent-tool-approval-server.mjs";
import { createPostgresAgentObjectBaseVersionResolver } from "./agents/postgres-agent-object-base-version-resolver.mjs";
import { createProductAgentExecutor } from "./agents/product-agent-executor.mjs";
import { AGENT_MATERIAL_TOOL_ID, createAgentMaterialToolExecutor } from "./tools/agent-material-tool.mjs";
import { AuthService } from "./auth/index.mjs";
import { ObjectAccessPolicy, createPostgresAgentObjectAuthorizer } from "./authorization/index.mjs";
import {
  CommandIntakeService,
  PostgresAgentCommandAuthorizer,
  PostgresAgentTurnCommandIntake,
  PostgresAgentSessionDecisionCommandIntake,
  PostgresBuilderProposalCommandIntake,
  createPostgresIdempotentMutationPort,
  createPostgresProductCommandResolver,
} from "./coordination/index.mjs";
import {
  createExecutionResolver,
  createWorkbenchApplication,
} from "./application/workbench-application.mjs";
import { bootstrapWorkbenchCatalog } from "./application/catalog-bootstrap.mjs";
import { createWorkbenchHttpHandler } from "./http/workbench-http-handler.mjs";
import { ProductMemoryService } from "./memory/product-memory-service.mjs";
import { createDeterministicSkillBackend, ExecutionBroker } from "./execution/execution-broker.mjs";
import { createConfiguredModelService } from "./execution/model-service.mjs";
import { createModelCallBackend } from "./execution/model-call-backend.mjs";
import { createPromptToolSkillBackend } from "./execution/prompt-tool-skill-backend.mjs";
import { createRemoteExecutionBackend } from "./execution/remote-execution-backend.mjs";
import { AdmissionController, AdmittedExecutionDispatcher } from "./execution/admission-controller.mjs";
import { PostgresCapacityPersistence } from "./execution/capacity-persistence.mjs";
import { PostgresExecutionPersistence } from "./execution/postgres-execution-persistence.mjs";
import { ProductToolGateway } from "./execution/product-tool-gateway.mjs";
import { StdioToolGatewayServer } from "./execution/stdio-tool-gateway-server.mjs";
import { createArtifactService } from "./artifacts/artifact-service.mjs";
import { createWorkerTranscriptArtifactService } from "./artifacts/worker-transcript-artifact-service.mjs";
import { PostgresModelConfiguration } from "./models/postgres-model-configuration.mjs";
import { PostgresModelCatalog } from "./models/postgres-model-catalog.mjs";
import { createPostgresRunControl } from "./runner/postgres-run-control.mjs";
import { createStoreRunControl } from "./runner/run-lease-coordinator.mjs";
import {
  createPostgresConnectionApprovalResolver,
  createPostgresWorkflowExecutionResolver,
} from "./runner/postgres-workflow-execution-resolver.mjs";
import { createPostgresWorkflowRunPersistence } from "./runner/postgres-workflow-run-persistence.mjs";
import { createWorkflowRunner } from "./runner/workflow-runner.mjs";
import { PostgresWorkflowRunCommandIntake } from "./runner/postgres-workflow-run-command-intake.mjs";
import { PostgresWorkflowRunReviewCommandIntake } from "./runner/postgres-workflow-run-review-command-intake.mjs";
import { PostgresWorkflowRunCancellationCommandIntake } from "./runner/postgres-workflow-run-cancellation-command-intake.mjs";
import { PostgresAutomationScheduler } from "./automations/index.mjs";
import { DeviceWorkerConnectionRegistry } from "./devices/device-worker-connection-registry.mjs";
import { DeviceRemoteWorkerTransport } from "./devices/device-remote-worker-transport.mjs";
import { DeviceWorkerGateway } from "./devices/device-worker-gateway.mjs";
import {
  AgentContainerSandbox,
  createAgentContainerBackend,
  createDockerSkillExecutor,
  createLegacyAgentRuntimeBundle,
} from "./runtime/index.mjs";
import { PostgresWorkbenchSessionStore } from "./security/postgres-workbench-session-store.mjs";
import {
  createGitHubSkillRepositorySource,
  createServerSkillImportService,
  createSkillUploadService,
  PostgresSkillUploadService,
  PostgresSkillCommandIntake,
  PostgresSkillValidationPersistence,
  PostgresSkillValidationPort,
  PostgresSystemCatalogService,
  createSkillRuntimeCatalog,
  createSkillTestRunner,
  createSkillValidationCoordinator,
  readySkillRuntimeImages,
  createTrustedSkillActivationRegistry,
} from "./skills/index.mjs";
import { createRegisteredToolCatalog } from "./tools/registered-tool-catalog.mjs";
import { createDurableLarkToolExecutor } from "./tools/durable-lark-tool-executor.mjs";
import { createLarkProfileResolver, LarkToolAdapter } from "./tools/lark-tool-adapter.mjs";
import { getLarkToolPolicy } from "./tools/lark-tool-policy.mjs";
import { createTextResourceService } from "./resources/index.mjs";
import {
  createInputAttachmentService,
  createSkillMaterialResolver,
  DockerAttachmentExtractionSandbox,
} from "./attachments/index.mjs";
import { FilesystemObjectStore } from "./storage/index.mjs";
import { ProductPostgresStore } from "./store/postgres/index.mjs";
import {
  createJsonLogger,
  createOperationsHttpHandler,
  createProductReadiness,
  MetricsRegistry,
} from "./operations/index.mjs";
import { createStaticHandler } from "./web/static-handler.mjs";
import {
  connectionApprovalSnapshot,
  connectionApprovalSnapshotsMatch,
  ConnectionDriverRegistry,
  isCompleteConnectionApprovalSnapshot,
  LarkConnectionDriver,
  PostgresWorkspaceConnectionService,
} from "./connections/index.mjs";

export const DEFAULT_WORKBENCH_PORT = 8798;

// This is a composition decision, not a storage fallback. Production receives
// the PostgreSQL browser-session owner; tests may inject an explicit fake.
export const createDefaultWorkbenchSessionStore = ({ store, clock, testSessionStore = null }) => {
  if (store instanceof ProductPostgresStore) return new PostgresWorkbenchSessionStore({ store, clock });
  if (testSessionStore) return testSessionStore;
  throw new TypeError("postgres_workbench_session_store_required");
};

export const createDefaultAuthPersistence = ({ store, clock, idFactory }) => (
  store instanceof ProductPostgresStore
    ? store.createAuthPersistence({ clock, idFactory })
    : store
);

export const createDefaultProductPostgresStore = ({ env = process.env } = {}) => {
  const connectionString = String(env.WORKBENCH_POSTGRES_URL ?? "").trim();
  if (!connectionString) throw new TypeError("workbench_postgres_url_required");
  return new ProductPostgresStore({ poolOptions: { connectionString } });
};

const sourceDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(sourceDirectory, "../../..");
const defaultDistDirectory = join(
  repositoryRoot,
  "apps/team-web/dist",
);
const defaultClock = () => new Date().toISOString();

function configuredWorkerTranscriptKey(env) {
  const source = String(env.WORKBENCH_TRANSCRIPT_ARTIFACT_KEY_BASE64 ?? "").trim();
  if (!source) return null;
  const key = Buffer.from(source, "base64");
  if (key.byteLength !== 32 || key.toString("base64") !== source) {
    throw new TypeError("worker_transcript_encryption_key_invalid");
  }
  const keyId = String(env.WORKBENCH_TRANSCRIPT_ARTIFACT_KEY_ID ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId)) {
    key.fill(0);
    throw new TypeError("worker_transcript_key_id_invalid");
  }
  return { key, keyId };
}
const defaultIdFactory = (kind) => `${kind}-${randomUUID()}`;
const TEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MEMORY_ROLE_RANK = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

function productExecutionError(code, message, status = "blocked") {
  const error = new Error(message);
  error.name = "ProductExecutionError";
  error.code = code;
  error.status = status;
  error.productSafe = true;
  return error;
}

function explicitTestStoreOwner(store, name, options = {}) {
  const factory = store?.[name];
  if (typeof factory !== "function") {
    throw new TypeError(`legacy_test_store_factory_required:${name}`);
  }
  return factory.call(store, options);
}

export async function authorizeAgentObjectForSession({
  store,
  objectKind,
  objectId,
  userId,
  workspaceId,
  workspaceRole = null,
  capabilities = null,
  objectAccessPolicy = new ObjectAccessPolicy(),
}) {
  if (store?.persistenceDriver === "postgres") {
    const authorize = typeof store.createAgentObjectAuthorizer === "function"
      ? store.createAgentObjectAuthorizer({ objectAccessPolicy })
      : createPostgresAgentObjectAuthorizer({ store, objectAccessPolicy });
    return authorize({
      objectKind, objectId, userId, workspaceId, capabilities,
    });
  }
  await store.connect();
  const membership = typeof store.authorizeWorkspace === "function"
    ? await store.authorizeWorkspace({ userId, workspaceId, minimumRole: "viewer" })
    : null;
  const persistedGrants = typeof store.listActiveObjectAccessGrants === "function"
    ? await store.listActiveObjectAccessGrants({
        workspaceId,
        objectKind,
        objectId,
        principalId: userId,
      })
    : [];
  let target = null;
  if (objectKind === "skill_draft") {
    const draft = await store.repositories?.skillDrafts?.get(objectId, { workspaceId });
    const skill = draft
      ? await store.repositories?.skillAssets?.get(draft.skillId, { workspaceId })
      : null;
    if (draft && skill) {
      target = {
        objectKind,
        objectId,
        workspaceId: skill.workspaceId ?? workspaceId,
        ownerPrincipalId: skill.ownerId,
        visibility: "private",
        grants: persistedGrants.map(({ principalId, role }) => ({ principalId, role })),
      };
    }
  } else if (objectKind === "workflow") {
    const value = await store.getWorkflow(objectId, { workspaceId });
    if (value?.workflow) {
      target = {
        objectKind,
        objectId,
        workspaceId: value.workflow.workspaceId ?? workspaceId,
        ownerPrincipalId: value.workflow.ownerId,
        visibility: value.workflow.visibility ?? "private",
        grants: [
          ...(value.workflow.accessGrants ?? []),
          ...persistedGrants.map(({ principalId, role }) => ({ principalId, role })),
        ],
      };
    }
  } else {
    throw productExecutionError(
      "agent_object_forbidden",
      "This object cannot be opened by a module Agent.",
      "permission_denied",
    );
  }
  const ownsObject = target?.ownerPrincipalId === userId;
  const principalCapabilities = Array.isArray(capabilities)
    ? capabilities
    : ownsObject
      ? AUTHORIZATION_CAPABILITIES
      : persistedGrants.flatMap((grant) => grant.capabilities ?? []);
  const decision = objectAccessPolicy.evaluate({
    principal: {
      principalId: userId,
      kind: "user",
      workspaceId,
      workspaceRole: workspaceRole ?? membership?.role ?? "member",
      capabilities: principalCapabilities,
    },
    target,
    operation: "read",
  });
  if (decision.allowed) return true;
  throw productExecutionError(
    "agent_object_forbidden",
    "This private object is not available to the current user.",
    "permission_denied",
  );
}

function createTestIdentityResolver(env) {
  if (String(env.WORKBENCH_TEST_MODE || "") !== "1") return null;
  return (req) => {
    const userId = String(req.headers["x-workbench-test-user"] || "");
    const workspaceId = String(req.headers["x-workbench-test-workspace"] || "");
    if (!TEST_ID.test(userId) || !TEST_ID.test(workspaceId)) {
      const error = new Error("test_identity_invalid");
      error.code = "test_identity_invalid";
      throw error;
    }
    return { userId, workspaceId };
  };
}

function createDefaultConnectionDriverRegistry({ larkAdapter, secretBindingGateway = null } = {}) {
  const registry = new ConnectionDriverRegistry();
  if (larkAdapter) {
    registry.register({
      driverKey: "lark",
      backend: "production",
      matches: (capabilityKey) => /^lark[.:-]/i.test(String(capabilityKey)),
      driver: new LarkConnectionDriver({
        // Credential bindings are deliberately not inferred from labels or
        // environment metadata. A host Secret Store adapter must supply an
        // explicit binding before a Connection can become valid.
        credentialBindingResolver: async (context) => (
          typeof secretBindingGateway?.resolveConnectionBinding === "function"
            ? secretBindingGateway.resolveConnectionBinding(context)
            : { state: "unbound" }
        ),
        ...(typeof secretBindingGateway?.bindConnection === "function" ? {
          bindCredentialReference: (context) => secretBindingGateway.bindConnection(context),
        } : {}),
        ...(typeof secretBindingGateway?.probeConnection === "function" ? {
          probeAccount: (context) => secretBindingGateway.probeConnection(context),
        } : {}),
        ...(typeof secretBindingGateway?.revokeConnectionBinding === "function" ? {
          revokeBinding: (context) => secretBindingGateway.revokeConnectionBinding(context),
        } : {}),
      }),
    });
  }
  return registry;
}

export function createConnectionRuntimeResolver({ store, connectionService = null, driverRegistry, clock = defaultClock } = {}) {
  if ((!store?.connect && !connectionService?.getInternal) || typeof driverRegistry?.resolve !== "function") {
    throw new TypeError("connection_runtime_resolver_dependencies_invalid");
  }
  return async ({ workspaceId, connectionId, toolId, requestedBy, expectedConnection } = {}) => {
    const connection = connectionService?.getInternal
      ? await connectionService.getInternal({ connectionId, workspaceId })
      : await (async () => {
          await store.connect();
          return store.repositories.connections?.get(connectionId, { workspaceId });
        })();
    const policy = getLarkToolPolicy(toolId);
    if (!connection || !policy) {
      throw productExecutionError(
        "connection_not_ready",
        "The selected Connection is not available for this Tool.",
      );
    }
    if (!isCompleteConnectionApprovalSnapshot(expectedConnection)) {
      throw productExecutionError(
        "run_connection_snapshot_unavailable",
        "This Run has no complete immutable Connection approval snapshot and cannot safely execute this Tool.",
      );
    }
    let currentApproval = null;
    try {
      currentApproval = connectionApprovalSnapshot(connection, {
        requirementId: expectedConnection.requirementId,
        now: Date.parse(clock()),
      });
    } catch {
      currentApproval = null;
    }
    if (
      expectedConnection.connectionId !== connectionId
      || !currentApproval
      || !connectionApprovalSnapshotsMatch(expectedConnection, currentApproval)
    ) {
      throw productExecutionError(
        "connection_reapproval_required",
        "The selected Connection changed after this Run was created. Create a new Run after reviewing the current account binding.",
      );
    }
    const expiresAt = connection.validation?.expiresAt;
    const expired = typeof expiresAt === "string"
      && Date.parse(expiresAt) <= Date.parse(clock());
    if (
      connection.status !== "connected"
      || connection.validation?.status !== "valid"
      || connection.credentialState !== "bound"
      || connection.driverBackend !== "production"
      || expired
      || !connection.validation?.effects?.includes(policy.effect)
    ) {
      throw productExecutionError(
        "connection_not_ready",
        "The selected Connection is invalid, expired, or lacks the required effect.",
      );
    }
    const registration = driverRegistry.resolve(connection.capabilityKey);
    if (
      !registration
      || registration.backend !== "production"
      || registration.driverKey !== connection.driverKey
      || typeof registration.driver?.resolveRuntimeBinding !== "function"
    ) {
      throw productExecutionError(
        "connection_runtime_binding_unavailable",
        "The selected Connection has no production runtime binding.",
      );
    }
    const resolved = await registration.driver.resolveRuntimeBinding({
      workspaceId,
      connectionId,
      capabilityKey: connection.capabilityKey,
      configuration: structuredClone(connection.configuration ?? {}),
      ...(typeof connection.secretBindingId === "string" && connection.secretBindingId
        ? { secretBindingId: connection.secretBindingId }
        : {}),
      toolId,
      requestedBy,
      expectedCredentialBindingFingerprint: expectedConnection.credentialBindingFingerprint,
    });
    if (
      resolved?.ok !== true
      || !resolved.binding
      || resolved.credentialBindingFingerprint !== expectedConnection.credentialBindingFingerprint
    ) {
      throw productExecutionError(
        resolved?.code ?? "connection_runtime_binding_unavailable",
        "The selected Connection runtime binding is unavailable.",
      );
    }
    return structuredClone(resolved.binding);
  };
}

export async function resolveMemoryObjectPermission({ store, scope, context, action, objectAccessPolicy }) {
  if (!scope || scope.kind !== "object" || !context?.workspaceId) return false;
  if (action !== "read" && (MEMORY_ROLE_RANK[context.role] ?? -1) < MEMORY_ROLE_RANK.member) return false;
  try {
    return await authorizeAgentObjectForSession({
      store,
      objectKind: scope.objectKind,
      objectId: scope.objectId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      workspaceRole: context.role,
      capabilities: context.capabilities,
      objectAccessPolicy,
    });
  } catch (error) {
    if ([
      "agent_object_forbidden",
      "workflow_not_found",
      "skill_draft_not_found",
    ].includes(error?.code)) return false;
    throw error;
  }
}

export function createDefaultAgentRuntime({
  env = process.env,
  clock = defaultClock,
  idFactory = defaultIdFactory,
  uploadedSkillRuntime = null,
} = {}) {
  return createLegacyAgentRuntimeBundle({ env, clock, idFactory, uploadedSkillRuntime });
}

export function createWorkbenchComposition({
  store,
  agentRuntime,
  executionBroker,
  allowUnadmittedExecutionBrokerForTests = false,
  executionBackends = [],
  remoteTransport = null,
  agentTurnRunner,
  capacityPersistence = null,
  executionPersistence = null,
  agentPersistence = null,
  memoryPersistence = null,
  externalEffectPersistence = null,
  agentExecutor = null,
  agentProposalService = null,
  agentSandbox = null,
  toolGateway = null,
  gatewayModelExecutor = null,
  modelService = null,
  modelCatalog = null,
  credentialResolver = null,
  modelSecretStore = null,
  artifactService = null,
  workerTranscriptArtifactService = null,
  gatewayToolExecutor = null,
  memoryService,
  metrics = null,
  runner,
  automationScheduler = null,
  skillUploadService,
  serverSkillImportService,
  skillValidationService,
  skillValidationPersistence = null,
  skillRuntimeCatalog = null,
  registeredToolCatalog = null,
  textResourceService,
  inputAttachmentService,
  connectionDriverRegistry = null,
  connectionSecretBindingGateway = null,
  commandIntake = null,
  objectAccessPolicy = new ObjectAccessPolicy(),
  trustedSkillActivationRegistry = createTrustedSkillActivationRegistry({
    agentRuntimeRoot: join(repositoryRoot, "packages/agent-runtime"),
  }),
  clock = defaultClock,
  idFactory = defaultIdFactory,
  env = process.env,
  objectStoreRoot = env.WORKBENCH_OBJECT_STORE_ROOT,
} = {}) {
  const postgresComposition = store?.persistenceDriver === "postgres";
  // A supplied RemoteWorkerTransport is an explicit test/deployment choice.
  // Otherwise PostgreSQL production composition installs the single governed
  // outbound Desktop transport; it has no public Worker API or fallback.
  const productDeviceWorkerRegistry = postgresComposition && !remoteTransport
    ? new DeviceWorkerConnectionRegistry({
      clock,
      idFactory,
      leaseStore: store.createDeviceExecutionLeaseStore({ clock, idFactory }),
    })
    : null;
  const productRemoteTransport = remoteTransport ?? (productDeviceWorkerRegistry
    ? new DeviceRemoteWorkerTransport({ registry: productDeviceWorkerRegistry })
    : null);
  const workbenchTestMode = String(env.WORKBENCH_TEST_MODE || "") === "1";
  if (allowUnadmittedExecutionBrokerForTests === true && !workbenchTestMode) {
    throw new TypeError("test_execution_broker_override_requires_test_mode");
  }
  const rawTestBrokerAllowed = Boolean(
    executionBroker
    && workbenchTestMode
    && allowUnadmittedExecutionBrokerForTests === true,
  );
  if (executionBroker && !rawTestBrokerAllowed) {
    throw new TypeError("unadmitted_execution_broker_forbidden");
  }
  if (!store || typeof store.connect !== "function") {
    throw new TypeError("workbench_store_required");
  }
  if (!postgresComposition && !workbenchTestMode) {
    throw new TypeError("non_postgres_composition_requires_test_mode");
  }
  const productCommandIntake = commandIntake ?? (postgresComposition
    ? null
    : new CommandIntakeService({ store, now: clock }));
  // Agent commands have a PostgreSQL-specific intake because their authority
  // is a real immutable decision.  Other legacy command families remain
  // outside this M1 cutover and cannot silently borrow the Agent authority.
  const productAgentCommandIntake = postgresComposition
    ? new PostgresAgentTurnCommandIntake({ store })
    : productCommandIntake;
  const productAgentPersistence = agentPersistence ?? (agentTurnRunner ? null : postgresComposition
    ? store.createAgentPersistence({ commandIntake: productAgentCommandIntake, clock })
    : explicitTestStoreOwner(store, "createAgentPersistence", { commandIntake: productCommandIntake, clock }));
  const productAgentSessionDecisionCommandIntake = postgresComposition
    ? new PostgresAgentSessionDecisionCommandIntake({ store })
    : null;
  const postgresDefaultWorkspaceId = String(env.WORKBENCH_DEFAULT_WORKSPACE_ID || "workspace-local");
  const productWorkflowCommandIntake = postgresComposition
    ? new PostgresWorkflowRunCommandIntake({ store })
    : productCommandIntake;
  const productWorkflowReviewCommandIntake = postgresComposition
    ? new PostgresWorkflowRunReviewCommandIntake({ store })
    : null;
  const productWorkflowCancellationCommandIntake = postgresComposition
    ? new PostgresWorkflowRunCancellationCommandIntake({ store })
    : null;
  const productWorkflowRunControl = runner ? null : postgresComposition
    ? createPostgresRunControl({ store, workspaceId: postgresDefaultWorkspaceId, idFactory })
    : workbenchTestMode ? createStoreRunControl(store) : null;
  const productWorkflowRunPersistence = runner ? null : postgresComposition
    ? createPostgresWorkflowRunPersistence({ store, workspaceId: postgresDefaultWorkspaceId })
    : workbenchTestMode ? explicitTestStoreOwner(store, "createWorkflowRunPersistence") : null;
  const productWorkflowExecutionResolver = postgresComposition
    ? createPostgresWorkflowExecutionResolver({ store })
    : createExecutionResolver({ store });
  const productConnectionApprovalResolver = postgresComposition
    ? createPostgresConnectionApprovalResolver({ store })
    : null;
  const productAgentCommandAuthorizer = postgresComposition
    ? new PostgresAgentCommandAuthorizer({ store, clock, idFactory })
    : null;
  const productAgentToolApprovalLifecycle = postgresComposition
    ? store.createAgentToolApprovalLifecycle({
      commandAuthorizer: productAgentCommandAuthorizer,
      clock,
      idFactory,
    })
    : null;
  const productSkillCommandIntake = postgresComposition
    ? new PostgresSkillCommandIntake({ store })
    : productCommandIntake;
  const productBuilderProposalCommandIntake = postgresComposition
    ? new PostgresBuilderProposalCommandIntake({ store })
    : null;
  const productIdempotentMutationPort = postgresComposition
    ? createPostgresIdempotentMutationPort({ store, clock })
    : null;
  const runtimeBundle = agentRuntime
    ? { agentRuntime, dispose: null }
    : createDefaultAgentRuntime({
      env,
      clock,
      idFactory,
      uploadedSkillRuntime: skillValidationService,
    });
  const productExecutionPersistence = executionBroker ? null : (
    executionPersistence ?? (postgresComposition
      ? new PostgresExecutionPersistence({ store })
      : explicitTestStoreOwner(store, "createExecutionPersistence"))
  );
  // Cloud composition accepts only an explicitly injected, governed resolver.
  // A process environment hint must never turn a macOS Keychain reference into
  // a cloud Provider credential or silently choose a second secret authority.
  const productCredentialResolver = credentialResolver ?? null;
  const modelReadinessResolver = async ({ revision }) => {
      if (!productCredentialResolver) return { state: "unavailable", reason: "credential_resolver_unavailable" };
      try {
        // PostgreSQL revisions carry an opaque SecretBinding ID. The injected
        // resolver is the governed Product gateway; no browser or environment
        // credential reference is substituted when that gateway is absent.
        const reference = revision.secretBindingId ?? revision.credentialRef;
        if (!reference) return { state: "unavailable", reason: "secret_binding_gateway_unavailable" };
        await productCredentialResolver.resolve(reference, {
          workspaceId: revision.workspaceId,
          revision,
        });
        return { state: "ready" };
      } catch {
        return { state: "unavailable", reason: "credential_unavailable" };
      }
    };
  const productModelCatalog = modelCatalog ?? (postgresComposition
    ? new PostgresModelCatalog({ store, readinessResolver: modelReadinessResolver })
    : explicitTestStoreOwner(store, "createModelCatalog", {
      clock: () => new Date(clock()), idFactory, readinessResolver: modelReadinessResolver,
    }));
  const artifactObjectStore = productExecutionPersistence
    && typeof objectStoreRoot === "string" && objectStoreRoot.trim()
    ? new FilesystemObjectStore({ rootDir: objectStoreRoot, now: clock })
    : null;
  const productArtifactService = artifactService ?? (artifactObjectStore ? createArtifactService({
    metadataRepository: postgresComposition
      ? store.createArtifactMetadataRepository()
      : explicitTestStoreOwner(store, "createArtifactMetadataRepository"),
    executionPersistence: productExecutionPersistence,
    objectStore: artifactObjectStore,
    clock,
    idFactory,
  }) : null);
  const transcriptKey = workerTranscriptArtifactService ? null : configuredWorkerTranscriptKey(env);
  const productWorkerTranscriptArtifactService = workerTranscriptArtifactService ?? (
    artifactObjectStore && transcriptKey
      ? (() => {
        const repository = postgresComposition
          ? store.createWorkerTranscriptArtifactRepository()
          : explicitTestStoreOwner(store, "createWorkerTranscriptArtifactRepository");
        return createWorkerTranscriptArtifactService({
          repository,
          objectStore: artifactObjectStore,
          encryptionKey: transcriptKey.key,
          keyId: transcriptKey.keyId,
          clock,
          idFactory,
          audit: async (event) => {
            if (postgresComposition) {
              await repository.appendAudit(event);
              return;
            }
            await store.connect?.();
            await store.repositories.auditEvents.append({
              schemaVersion: "workbench-v1",
              auditEventId: idFactory("audit"),
              workspaceId: event.workspaceId,
              actorId: event.actorUserId,
              action: event.action,
              entityKind: "worker_transcript_artifact",
              entityId: event.transcriptArtifactId,
              outcome: event.outcome,
              reasonCode: event.reasonCode,
              objectScope: event.objectScope,
              invocationId: event.invocationId,
              attemptId: event.attemptId,
              occurredAt: event.occurredAt,
              createdAt: event.occurredAt,
            });
          },
        });
      })()
      : null
  );
  transcriptKey?.key.fill(0);
  const recordModelAttempt = productExecutionPersistence?.appendEvent
    ? async (event) => {
      await productExecutionPersistence.appendEvent(event.invocationId, (sequence) => ({
        schemaVersion: "workbench-execution-fabric-v1",
        eventId: idFactory("execution-event"),
        invocationId: event.invocationId,
        attemptId: event.attemptId,
        sequence,
        type: `model.attempt.${event.phase}`,
        status: "running",
        payload: {
          modelProfileId: event.profileId,
          requestedModelRevisionId: event.requestedModelRevisionId,
          actualModelRevisionId: event.actualModelRevisionId,
          capability: event.capability,
          provider: event.provider,
          protocol: event.protocol,
          fallback: event.fallback === true,
          ...(event.code ? { code: event.code } : {}),
          ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
          ...(event.usage ? { usage: structuredClone(event.usage) } : {}),
        },
        occurredAt: clock(),
      }));
      metrics?.increment("workbench_model_attempts_total", {
        outcome: event.phase,
        fallback: event.fallback === true ? "true" : "false",
        capability: event.capability,
        provider: event.provider,
      });
    }
    : null;
  const configuredGatewayModelExecutor = modelService
    ?? gatewayModelExecutor
    ?? createConfiguredModelService({
      env,
      catalog: productModelCatalog,
      credentialResolver: productCredentialResolver,
      artifactService: productArtifactService,
      observer: recordModelAttempt,
    });
  const configuredLarkToolAdapter = !gatewayToolExecutor
    && typeof env.WORKBENCH_LARK_CLI_PATH === "string"
    && env.WORKBENCH_LARK_CLI_PATH.trim()
      ? new LarkToolAdapter({
          binaryPath: env.WORKBENCH_LARK_CLI_PATH.trim(),
          profileResolver: createLarkProfileResolver({
            prefix: env.WORKBENCH_LARK_PROFILE_PREFIX || "workbench",
          }),
          env,
        })
      : null;
  const productConnectionDriverRegistry = connectionDriverRegistry
    ?? createDefaultConnectionDriverRegistry({
      larkAdapter: configuredLarkToolAdapter,
      secretBindingGateway: connectionSecretBindingGateway,
    });
  const externalGatewayToolExecutor = gatewayToolExecutor ?? (
    configuredLarkToolAdapter && !postgresComposition
      ? createDurableLarkToolExecutor({
          adapter: configuredLarkToolAdapter,
          persistence: externalEffectPersistence ?? explicitTestStoreOwner(store, "createExternalEffectPersistence"),
          connectionResolver: createConnectionRuntimeResolver({
            store,
            driverRegistry: productConnectionDriverRegistry,
            clock,
          }),
          clock,
        })
      : null
  );
  const materialToolExecutor = postgresComposition
    && typeof productAgentPersistence?.listSessionAttachmentRefs === "function"
    && typeof inputAttachmentService?.readText === "function"
      ? createAgentMaterialToolExecutor({ agentPersistence: productAgentPersistence, inputAttachmentService })
      : null;
  const configuredGatewayToolExecutor = materialToolExecutor
    ? Object.assign(async (input) => {
        if (input.toolId === AGENT_MATERIAL_TOOL_ID) return materialToolExecutor(input);
        if (externalGatewayToolExecutor) return externalGatewayToolExecutor(input);
        throw productExecutionError("tool_backend_unavailable", "This tool is unavailable.");
      }, typeof externalGatewayToolExecutor?.reconcileEffect === "function"
        ? { reconcileEffect: externalGatewayToolExecutor.reconcileEffect.bind(externalGatewayToolExecutor) }
        : {})
    : externalGatewayToolExecutor;
  const skillMaterialResolver = createSkillMaterialResolver({
    store,
    inputAttachmentService,
    textResourceService,
  });
  const productAdmissionController = executionBroker ? null : new AdmissionController({
    persistence: capacityPersistence ?? (postgresComposition
      ? new PostgresCapacityPersistence({ store })
      : explicitTestStoreOwner(store, "createCapacityPersistence")),
    clock,
    idFactory,
    resolveProductCommand: postgresComposition
      ? createPostgresProductCommandResolver({ store })
      : async (identity) => {
        await store.connect();
        return store.repositories.productCommands.get(identity);
      },
  });
  const rawProductExecutionBroker = executionBroker ?? new ExecutionBroker({
    persistence: productExecutionPersistence,
    clock,
    idFactory,
    capacityAuthorizer: productAdmissionController,
  });
  const productExecutionBroker = executionBroker ?? new AdmittedExecutionDispatcher({
    broker: rawProductExecutionBroker,
    admissionController: productAdmissionController,
  });
  const productExecutionDispatcher = productExecutionBroker;
  if (!executionBroker) {
    productExecutionBroker.registerBackend({
      mode: "deterministic_skill",
      isolation: "process",
      backend: createDeterministicSkillBackend({
        agentRuntime: runtimeBundle.agentRuntime,
        materialResolver: skillMaterialResolver,
      }),
    });
    if (configuredGatewayModelExecutor) {
      productExecutionBroker.registerBackend({
        mode: "model_call",
        isolation: "process",
        backend: createModelCallBackend({
          modelService: configuredGatewayModelExecutor,
          attachmentResolver: inputAttachmentService?.resolveForTurn
            ? inputAttachmentService.resolveForTurn.bind(inputAttachmentService)
            : null,
        }),
      });
    }
  }
  const productToolGateway = toolGateway ?? (productExecutionPersistence ? new ProductToolGateway({
    persistence: productExecutionPersistence,
    modelExecutor: configuredGatewayModelExecutor,
    toolExecutor: configuredGatewayToolExecutor,
    clock,
    observer: metrics
      ? ({ outcome, code }) => metrics.increment("workbench_gateway_requests_total", { outcome, code })
      : null,
  }) : null);
  if (
    !executionBroker
    && typeof skillValidationService?.executeTestPackage === "function"
    && !executionBackends.some((item) => item.mode === "deterministic_skill" && item.isolation === "container")
  ) {
    productExecutionBroker.registerBackend({
      mode: "deterministic_skill",
      isolation: "container",
      backend: {
        async execute({ request, signal, checkpoint }) {
          await checkpoint?.({ phase: "dispatching_skill_test" });
          const materials = request.metadata?.materialBindings?.length
            ? await skillMaterialResolver({
              workspaceId: request.workspaceId,
              requestedBy: request.metadata.requestedBy,
              bindings: request.metadata.materialBindings,
              requirements: request.metadata.materialRequirements ?? [],
              signal,
            })
            : [];
          if (request.metadata?.materialBindings?.length !== materials.length) {
            throw productExecutionError("skill_material_unavailable", "One or more Skill test materials are unavailable.", "blocked");
          }
          const output = await skillValidationService.executeTestPackage({
            workspaceId: request.workspaceId,
            executionRef: request.metadata.executionRef,
            input: request.input,
            materials,
            signal,
          });
          return {
            output,
            summary: "Skill test completed in the governed container runtime.",
            evidence: [],
            usage: {
              steps: 1,
              modelRequests: 0,
              inputBytes: Buffer.byteLength(JSON.stringify(request.input), "utf8")
                + materials.reduce((total, material) => total + material.bytes.byteLength, 0),
              outputBytes: Buffer.byteLength(JSON.stringify(output), "utf8"),
              imageCount: 0,
              costUsdMicros: 0,
            },
          };
        },
      },
    });
  }
  if (
    !executionBroker
    && productToolGateway
    && typeof skillValidationService?.loadExecutionPackage === "function"
    && !executionBackends.some((item) => item.mode === "bounded_agent" && item.isolation === "process")
  ) {
    productExecutionBroker.registerBackend({
      mode: "bounded_agent",
      isolation: "process",
      backend: createPromptToolSkillBackend({
        packageLoader: skillValidationService,
        toolGateway: productToolGateway,
        materialResolver: skillMaterialResolver,
      }),
    });
    skillValidationService.configurePromptRuntime?.({
      probe: async ({ workspaceId, executionRef }) => {
        if (!configuredGatewayModelExecutor) {
          return { ready: false, code: "provider_unavailable" };
        }
        const loaded = await skillValidationService.loadExecutionPackage({
          workspaceId,
          executionRef,
        });
        if ((loaded.inspection?.manifest?.tools ?? []).length === 0) {
          return { ready: true };
        }
        return configuredLarkToolAdapter
          ? configuredLarkToolAdapter.probe()
          : { ready: false, code: "lark_cli_unavailable" };
      },
      executeTest: async () => {
        throw productExecutionError(
          "skill_test_command_intake_required",
          "Prompt Skill tests must start through the Product API command intake.",
        );
      },
    });
  }
  const productAgentSandbox = agentSandbox ?? (
    env.WORKBENCH_AGENT_IMAGE && productToolGateway
      ? new AgentContainerSandbox({
        image: env.WORKBENCH_AGENT_IMAGE,
        gatewayServer: new StdioToolGatewayServer({
          gateway: productToolGateway,
        }),
        ...(productAgentToolApprovalLifecycle ? {
          approvalServer: new StdioAgentToolApprovalServer({
            lifecycle: productAgentToolApprovalLifecycle,
          }),
        } : {}),
        transcriptArtifactService: productWorkerTranscriptArtifactService,
        requireTranscriptArtifact: true,
        ...(env.WORKBENCH_AGENT_SANDBOX_ROOT ? { tempRoot: env.WORKBENCH_AGENT_SANDBOX_ROOT } : {}),
      })
      : null
  );
  if (productAgentSandbox) {
    for (const mode of ["bounded_agent", "agent_orchestrator"]) {
      const explicitlyRegistered = executionBackends.some((item) => item.mode === mode && item.isolation === "container");
      if (!explicitlyRegistered) {
        productExecutionBroker.registerBackend({
          mode,
          isolation: "container",
          backend: createAgentContainerBackend({ sandbox: productAgentSandbox }),
        });
      }
    }
  }
  if (productRemoteTransport) {
    const remoteBackend = createRemoteExecutionBackend({ transport: productRemoteTransport });
    for (const mode of productDeviceWorkerRegistry
      ? ["deterministic_skill"]
      : ["deterministic_skill", "model_call", "bounded_agent", "agent_orchestrator"]) {
      const explicitlyRegistered = executionBackends.some((item) => item.mode === mode && item.isolation === "remote");
      if (!explicitlyRegistered) {
        productExecutionBroker.registerBackend({ mode, isolation: "remote", backend: remoteBackend });
      }
    }
  }
  for (const registration of executionBackends) {
    productExecutionBroker.registerBackend(registration);
  }
  const productSkillTestRunner = skillValidationService
    ? createSkillTestRunner({
        store,
        ...(skillValidationPersistence ? { skillTestPersistence: skillValidationPersistence } : {}),
        ...(typeof skillValidationService.resolveValidationContext === "function" ? {
          resolveSkillValidationContext: (input) => skillValidationService.resolveValidationContext(input),
        } : {}),
        commandIntake: productSkillCommandIntake,
        skillValidationService,
        executionDispatcher: productExecutionDispatcher,
        materialResolver: skillMaterialResolver,
        modelService: configuredGatewayModelExecutor,
        clock,
      })
    : null;
  const productRunner = runner ?? createWorkflowRunner({
    store,
    resolveExecution: productWorkflowExecutionResolver,
    resolveResourceText: textResourceService?.readText?.bind(textResourceService),
    agentRuntime: runtimeBundle.agentRuntime,
    executionBroker: productExecutionBroker,
    admissionController: productAdmissionController,
    commandIntake: productWorkflowCommandIntake,
    reviewCommandIntake: productWorkflowReviewCommandIntake,
    cancellationCommandIntake: productWorkflowCancellationCommandIntake,
    idempotentMutationPort: productIdempotentMutationPort,
    runControl: productWorkflowRunControl,
    runPersistence: productWorkflowRunPersistence,
    resolveConnectionApproval: productConnectionApprovalResolver,
    clock,
    idFactory,
  });
  const productAutomationScheduler = automationScheduler ?? (postgresComposition
    ? new PostgresAutomationScheduler({
        persistence: store.createAutomationSchedulerPersistence(),
        workflowRunner: productRunner,
        workspaceId: postgresDefaultWorkspaceId,
      })
    : null);
  const productAutomationLifecycle = postgresComposition
    ? store.createAutomationLifecycle({ clock, idFactory })
    : null;
  const productDeviceLifecycle = postgresComposition
    ? store.createDeviceLifecycle({
      commandAuthorizer: productAgentCommandAuthorizer,
      clock,
      idFactory,
      onDeviceRevoked: ({ deviceId }) => productDeviceWorkerRegistry?.disconnectDevice(deviceId, {
        reason: "device_revoked",
      }),
    })
    : null;
  const productAgentProposalService = agentProposalService ?? new ProductAgentProposalService({ store, clock, idFactory });
  const productAgentExecutor = agentExecutor ?? createProductAgentExecutor({
    proposalService: productAgentProposalService, materialToolsAvailable: Boolean(materialToolExecutor),
  });
  const productAgentTurnRunner = agentTurnRunner ?? new AgentTurnRunner({
    persistence: productAgentPersistence,
    executionBroker: productExecutionBroker,
    executor: productAgentExecutor,
    clock,
    idFactory,
    authorizeObject: (input) => authorizeAgentObjectForSession({
      store,
      objectAccessPolicy,
      ...input,
    }),
    commandAuthorizer: productAgentCommandAuthorizer,
    resolveModelSelection: async ({
      workspaceId,
      userId,
      kind,
      session,
      modelProfileId,
      modelProfileRevisionId,
      requiredCapabilities,
    }) => {
      let resolved;
      if (modelProfileRevisionId) {
        resolved = await productModelCatalog.resolveRevision({
          revisionId: modelProfileRevisionId,
          workspaceId,
          userId,
          capabilities: requiredCapabilities,
          requireReady: true,
        });
      } else {
        let selectedProfileId = modelProfileId || session?.lastUsedModelProfileId;
        if (!selectedProfileId) {
          const policy = await productModelCatalog.getWorkspacePolicy(workspaceId, { userId });
          const capability = kind === "model_task" ? "image_generation" : requiredCapabilities.includes("structured_output") ? "structured_output" : "tool_calling";
          selectedProfileId = policy?.defaultProfileIdsByCapability?.[capability];
        }
        if (!selectedProfileId) {
          throw productExecutionError("model_route_unresolved", "No compatible model profile is configured.");
        }
        resolved = await productModelCatalog.resolveCurrentProfile({
          profileId: selectedProfileId,
          workspaceId,
          userId,
          capabilities: requiredCapabilities,
          requireReady: true,
        });
      }
      return {
        revisionId: resolved.revision.revisionId,
        profileId: resolved.profile.profileId,
        limits: structuredClone(resolved.revision.limits ?? {}),
        capability: kind === "model_task"
          ? "image_generation"
          : requiredCapabilities.includes("structured_output")
            ? "structured_output"
            : "tool_calling",
      };
    },
    resolveBaseVersion: postgresComposition
      ? createPostgresAgentObjectBaseVersionResolver({ store })
      : async ({ objectKind, objectId, workspaceId }) => {
      if (objectKind === "workflow") {
        const value = await store.getWorkflow(objectId, { workspaceId });
        const revision = await store.repositories?.workflowRevisions?.get(
          objectId,
          value.workflow.currentRevisionId,
          { workspaceId },
        );
        return revision
          ? {
              baseVersionId: revision.revisionId,
              baseSnapshot: revision,
            }
          : null;
      }
      if (objectKind === "skill_draft") {
        await store.connect();
        const draft = await store.repositories?.skillDrafts?.get(objectId, { workspaceId });
        return draft
          ? {
              baseVersionId: `${draft.skillDraftId}:${draft.revision}`,
              baseSnapshot: draft,
            }
          : null;
      }
      return null;
    },
  });
  productAgentToolApprovalLifecycle?.bindAgentTurnRunner(productAgentTurnRunner);
  const productWorkItemPromotionLifecycle = postgresComposition
    ? store.createWorkItemPromotionLifecycle({
      commandAuthorizer: productAgentCommandAuthorizer,
      agentTurnRunner: productAgentTurnRunner,
      clock,
      idFactory,
    })
    : null;
  const productTeamWorkLifecycle = postgresComposition
    ? store.createTeamWorkLifecycle({
      promotionLifecycle: productWorkItemPromotionLifecycle,
      objectStore: artifactObjectStore,
      clock,
      idFactory,
    })
    : null;
  const productMemoryService = memoryService ?? new ProductMemoryService({
    persistence: memoryPersistence ?? (postgresComposition
      ? store.createMemoryPersistence()
      : explicitTestStoreOwner(store, "createMemoryPersistence")),
    clock,
    idFactory,
    objectPermissionResolver: ({ scope, context, action }) => resolveMemoryObjectPermission({
      store,
      scope,
      context,
      action,
      objectAccessPolicy,
    }),
    canonicalResolver: postgresComposition
      ? store.createCanonicalMemoryResolver()
      : explicitTestStoreOwner(store, "createCanonicalMemoryResolver"),
  });
  const artifactReady = artifactObjectStore?.initialize?.() ?? Promise.resolve();
  const modelCatalogReady = importModelCatalogFromEnvironment({
    env,
    catalog: productModelCatalog,
    workspaceId: env.WORKBENCH_DEFAULT_WORKSPACE_ID || "workspace-local",
    createImporter: postgresComposition
      ? null
      : (options) => explicitTestStoreOwner(store, "createModelCatalogImporter", options),
  });
  const productSkillDraftLifecycle = postgresComposition
    ? store.createSkillDraftLifecycle({ clock, idFactory })
    : null;
  const productSkillReadModel = postgresComposition ? store.createSkillReadModel() : null;
  const productLoopDraftLifecycle = postgresComposition
    ? store.createLoopDraftLifecycle({ clock, idFactory })
    : null;
  const productWorkflowCompileLifecycle = postgresComposition
    ? store.createWorkflowCompileLifecycle({ clock, idFactory, modelCatalog: productModelCatalog,
        probeSkill: (executionRef, options) => runtimeBundle.agentRuntime.probeSkill(executionRef, options) })
    : null;
  const productWorkflowReadModel = postgresComposition ? store.createWorkflowReadModel() : null;
  const productBuilderProposalReadModel = postgresComposition ? store.createBuilderProposalReadModel() : null;
  const productBuilderProposalLifecycle = postgresComposition
    ? store.createBuilderProposalLifecycle({
      clock,
      commandIntake: productBuilderProposalCommandIntake,
      commandAuthorizer: productAgentCommandAuthorizer,
    })
    : null;
  const productAgentProposalReadModel = postgresComposition ? store.createAgentProposalReadModel() : null;
  const productSessionDomainReadModel = postgresComposition ? store.createSessionDomainReadModel() : null;
  const productAgentHandoffLifecycle = postgresComposition
    ? store.createAgentHandoffLifecycle({
      clock,
      idFactory,
      commandAuthorizer: productAgentCommandAuthorizer,
      commandIntake: productAgentSessionDecisionCommandIntake,
    })
    : null;
  const productAgentProposalLifecycle = postgresComposition
    ? store.createAgentProposalLifecycle({
      clock,
      idFactory,
      commandAuthorizer: productAgentCommandAuthorizer,
      commandIntake: productAgentSessionDecisionCommandIntake,
    })
    : null;
  const productExternalMutationPort = postgresComposition
    ? store.createExternalMutationPort({ clock })
    : null;
  const productConnectionService = postgresComposition
    ? new PostgresWorkspaceConnectionService({
      store,
      driverRegistry: productConnectionDriverRegistry,
      idempotentMutationPort: productIdempotentMutationPort,
      externalMutationPort: productExternalMutationPort,
      clock,
      idFactory,
    })
    : null;
  const productInboxReadModel = postgresComposition ? store.createInboxReadModel() : null;
  const productWorkspaceReadModel = postgresComposition ? store.createWorkspaceReadModel() : null;
  const productObjectReadModel = postgresComposition ? store.createProductObjectReadModel() : null;
  const productCompatibilityCatalogReadModel = postgresComposition ? store.createCompatibilityCatalogReadModel() : null;
  const productTeamLibraryReadModel = postgresComposition ? store.createTeamLibraryReadModel() : null;
  const productTeamLibraryLifecycle = postgresComposition
    ? store.createTeamLibraryLifecycle({ clock, idFactory })
    : null;
  const productSystemCatalogService = postgresComposition
    && typeof objectStoreRoot === "string" && objectStoreRoot.trim()
    ? new PostgresSystemCatalogService({
      store,
      objectStore: new FilesystemObjectStore({ rootDir: objectStoreRoot, now: clock }),
      teamLibraryLifecycle: productTeamLibraryLifecycle,
      probeSkill: runtimeBundle.agentRuntime?.probeSkill?.bind(runtimeBundle.agentRuntime),
      clock,
    })
    : null;
  const productNativeSkillPackageReader = postgresComposition && artifactObjectStore ? new PostgresNativeSkillPackageReader({ store, objectStore: artifactObjectStore }) : null;
  const productMemberAgentService = postgresComposition && productNativeSkillPackageReader && !productExecutionBroker.hasBackend({mode:"bounded_agent",isolation:"remote"})
    ? new PostgresMemberAgentService({store,authorizer:productAgentCommandAuthorizer,dispatcher:productExecutionBroker,
      readSkillPackage:input=>productNativeSkillPackageReader.read(input),
      readLoopPackage:input=>productLoopDraftLifecycle.getNativeLoopPackage({...input,readSkillPackage:args=>productNativeSkillPackageReader.read(args)}),clock,idFactory}) : null;
  if (productMemberAgentService) productExecutionBroker.registerBackend({mode:"bounded_agent",isolation:"remote",backend:productMemberAgentService.backend});
  const productWorkspaceAuthorizer = postgresComposition ? store.createAuthPersistence({ clock, idFactory }) : null;
  const application = createWorkbenchApplication({
    store,
    agentRuntime: runtimeBundle.agentRuntime,
    agentProposalService: productAgentProposalService,
    executionBroker: productExecutionBroker,
    admissionController: productAdmissionController,
    agentTurnRunner: productAgentTurnRunner,
    agentProposalReadModel: productAgentProposalReadModel,
    sessionDomainReadModel: productSessionDomainReadModel,
    agentProposalLifecycle: productAgentProposalLifecycle,
    agentToolApprovalLifecycle: productAgentToolApprovalLifecycle,
    agentHandoffLifecycle: productAgentHandoffLifecycle,
    workItemLifecycle: productTeamWorkLifecycle ?? productWorkItemPromotionLifecycle,
    memoryService: productMemoryService,
    artifactService: productArtifactService,
    workerTranscriptArtifactService: productWorkerTranscriptArtifactService,
    modelCatalog: productModelCatalog,
    modelConfiguration: postgresComposition && modelSecretStore
      ? new PostgresModelConfiguration({ store, authorizer: productAgentCommandAuthorizer, secretStore: modelSecretStore }) : null,
    modelService: configuredGatewayModelExecutor,
    runner: productRunner,
    skillDraftLifecycle: productSkillDraftLifecycle,
    skillReadModel: productSkillReadModel,
    loopDraftLifecycle: productLoopDraftLifecycle,
    workflowCompileLifecycle: productWorkflowCompileLifecycle,
    workflowReadModel: productWorkflowReadModel,
    builderProposalReadModel: productBuilderProposalReadModel,
    builderProposalLifecycle: productBuilderProposalLifecycle,
    inboxReadModel: productInboxReadModel,
    workspaceReadModel: productWorkspaceReadModel,
    objectReadModel: productObjectReadModel,
    compatibilityCatalogReadModel: productCompatibilityCatalogReadModel,
    teamLibraryReadModel: productTeamLibraryReadModel,
    nativeSkillPackageReader: productNativeSkillPackageReader,
    memberAgentService: productMemberAgentService,
    teamLibraryLifecycle: productTeamLibraryLifecycle,
    systemCatalogService: productSystemCatalogService,
    workspaceAuthorizer: productWorkspaceAuthorizer,
    skillUploadService,
    serverSkillImportService,
    skillValidationService,
    skillValidationContextResolver: skillValidationService?.resolveValidationContext?.bind(skillValidationService),
    skillTestRunner: productSkillTestRunner,
    skillRuntimeCatalog,
    registeredToolCatalog: registeredToolCatalog ?? createRegisteredToolCatalog(),
    textResourceService,
    inputAttachmentService,
    connectionDriverRegistry: productConnectionDriverRegistry,
    connectionService: productConnectionService,
    trustedSkillActivationRegistry,
    commandIntake: productCommandIntake,
    skillCommandIntake: productSkillCommandIntake,
    skillCommandAuthorizer: productAgentCommandAuthorizer,
    workflowCommandAuthorizer: productAgentCommandAuthorizer,
    idempotentMutationPort: productIdempotentMutationPort,
    externalMutationPort: productExternalMutationPort,
    automationLifecycle: productAutomationLifecycle,
    deviceLifecycle: productDeviceLifecycle,
    objectAccessPolicy,
    clock,
    idFactory,
  });
  return {
    store,
    memberAgentService: productMemberAgentService,
    agentRuntime: runtimeBundle.agentRuntime,
    executionBroker: productExecutionBroker,
    admissionController: productAdmissionController,
    commandIntake: productCommandIntake,
    toolGateway: productToolGateway,
    gatewayModelExecutor: configuredGatewayModelExecutor,
    systemCatalogService: productSystemCatalogService,
    modelService: configuredGatewayModelExecutor,
    providerProbe: configuredGatewayModelExecutor?.probe
      ? () => configuredGatewayModelExecutor.probe({
        workspaceId: env.WORKBENCH_DEFAULT_WORKSPACE_ID || "workspace-local",
      })
      : null,
    agentSandbox: productAgentSandbox,
    remoteTransport: productRemoteTransport,
    agentTurnRunner: productAgentTurnRunner,
    agentExecutor: productAgentExecutor,
    agentProposalService: productAgentProposalService,
    memoryService: productMemoryService,
    artifactService: productArtifactService,
    workerTranscriptArtifactService: productWorkerTranscriptArtifactService,
    modelCatalog: productModelCatalog,
    artifactReady,
    modelCatalogReady,
    skillTestRunner: productSkillTestRunner,
    disposeRuntime: async () => { await productMemberAgentService?.dispose(); return runtimeBundle.dispose?.(); },
    runner: productRunner,
    automationScheduler: productAutomationScheduler,
    automationLifecycle: productAutomationLifecycle,
    deviceLifecycle: productDeviceLifecycle,
    deviceWorkerRegistry: productDeviceWorkerRegistry,
    application,
  };
}

export function createWorkbenchServer({
  store,
  agentRuntime,
  executionBroker,
  allowUnadmittedExecutionBrokerForTests = false,
  executionBackends,
  remoteTransport,
  agentTurnRunner,
  capacityPersistence = null,
  executionPersistence = null,
  agentPersistence = null,
  memoryPersistence = null,
  externalEffectPersistence = null,
  agentExecutor,
  agentProposalService,
  agentSandbox,
  toolGateway,
  gatewayModelExecutor,
  modelService,
  modelCatalog,
  credentialResolver,
  modelSecretStore,
  artifactService,
  workerTranscriptArtifactService,
  gatewayToolExecutor,
  memoryService,
  runner,
  automationScheduler = null,
  distDirectory = defaultDistDirectory,
  bootstrapCatalog = true,
  application,
  authService,
  authPersistence = null,
  invitationTokenSigner = null,
  invitationMailer = null,
  invitationBaseUrl = null,
  oauthProviders = {},
  nativeClientSessions = null,
  httpHandler,
  sessionStore,
  testSessionStore = null,
  skillUploadService,
  serverSkillImportService,
  skillValidationService,
  skillRuntimeCatalog,
  registeredToolCatalog,
  textResourceService,
  inputAttachmentService,
  connectionDriverRegistry,
  connectionSecretBindingGateway,
  commandIntake = null,
  trustedSkillActivationRegistry,
  startupRecovery,
  objectStoreRoot = process.env.WORKBENCH_OBJECT_STORE_ROOT,
  testIdentityResolver,
  allowedHosts,
  origin,
  logger = null,
  metrics = null,
  readiness = null,
  providerProbe = null,
  clock = defaultClock,
  idFactory = defaultIdFactory,
  env = process.env,
} = {}) {
  // The actual Product Server has one canonical storage composition.  Tests
  // may inject an in-memory/store fixture, but an omitted store is always PG.
  const productStore = store ?? createDefaultProductPostgresStore({ env });
  const testMode = String(env.WORKBENCH_TEST_MODE || "") === "1";
  if (productStore?.persistenceDriver !== "postgres" && !testMode) {
    throw new TypeError("product_postgres_store_required");
  }
  const productAuthService = authService ?? new AuthService({
    store: productStore,
    persistence: authPersistence ?? createDefaultAuthPersistence({
      store: productStore,
      clock,
      idFactory,
    }),
    bootstrapAdminToken: env.WORKBENCH_BOOTSTRAP_ADMIN_TOKEN,
    registrationOpen: ["1", "true"].includes(String(env.WORKBENCH_REGISTRATION_OPEN ?? "").toLowerCase()),
    workspaceId: env.WORKBENCH_DEFAULT_WORKSPACE_ID ?? "workspace-local",
    workspaceName: env.WORKBENCH_DEFAULT_WORKSPACE_NAME ?? "Team workspace",
    bcryptCost: Number(env.WORKBENCH_BCRYPT_COST ?? 12),
    invitationTokenSigner,
    invitationMailer,
    invitationBaseUrl,
    oauthProviders,
    nativeClientSessions: nativeClientSessions ?? (
      productStore?.persistenceDriver === "postgres"
        ? productStore.createNativeClientSessionStore({ clock, idFactory })
        : null
    ),
    nativeRedirectOrigins: parseNativeRedirectOrigins(env.WORKBENCH_NATIVE_REDIRECT_ORIGINS),
    nativeAuthorizationBaseUrl: env.WORKBENCH_NATIVE_AUTHORIZATION_PATH ?? "/native/authorize",
    publicOrigin: origin,
    clock,
    idFactory,
});
  const operationsMetrics = metrics ?? new MetricsRegistry();
  const operationsLogger = logger ?? createJsonLogger({ level: env.WORKBENCH_LOG_LEVEL ?? "info" });
  const upload = resolveSkillUploadService({
    store: productStore,
    skillUploadService,
    objectStoreRoot,
    clock,
    idFactory,
  });
  const resources = resolveTextResourceService({
    store: productStore,
    textResourceService,
    objectStoreRoot,
    clock,
    idFactory,
  });
  const attachments = resolveInputAttachmentService({
    store: productStore,
    inputAttachmentService,
    objectStoreRoot,
    extractorImage: env.WORKBENCH_ATTACHMENT_EXTRACTOR_IMAGE
      ?? env.WORKBENCH_NODE_SKILL_IMAGE,
    extractionRoot: env.WORKBENCH_ATTACHMENT_EXTRACTION_ROOT
      ?? env.WORKBENCH_EXECUTION_ROOT,
    clock,
    idFactory,
  });
  const serverImport = serverSkillImportService ?? resolveServerSkillImportService({
    env,
    store: productStore,
    skillUploadService: upload.service,
  });
  const runtimeImages = readySkillRuntimeImages({
    pythonImage: env.WORKBENCH_DOCKER_IMAGE,
    nodeImage: env.WORKBENCH_NODE_SKILL_IMAGE,
  });
  const productSkillRuntimeCatalog = skillRuntimeCatalog ?? createSkillRuntimeCatalog({
    pythonImage: env.WORKBENCH_DOCKER_IMAGE,
    nodeImage: env.WORKBENCH_NODE_SKILL_IMAGE,
  });
  const productRegisteredToolCatalog = registeredToolCatalog ?? createRegisteredToolCatalog();
  const validation = resolveSkillValidationService({
    store: productStore,
    skillValidationService,
    objectStoreRoot,
    executionRoot: env.WORKBENCH_EXECUTION_ROOT,
    runtimeImages,
    clock,
    idFactory,
  });
  const composition = application
    ? {
        store: productStore,
        agentRuntime,
        agentSandbox,
        runner,
        automationScheduler,
        executionBroker,
        disposeRuntime: null,
        application,
      }
    : createWorkbenchComposition({
      store: productStore,
      agentRuntime,
      executionBroker,
      allowUnadmittedExecutionBrokerForTests,
      executionBackends,
      remoteTransport,
      agentTurnRunner,
      capacityPersistence,
      executionPersistence,
      agentPersistence,
      memoryPersistence,
      externalEffectPersistence,
      agentExecutor,
      agentProposalService,
      agentSandbox,
      toolGateway,
      gatewayModelExecutor,
      modelService,
      modelCatalog,
      credentialResolver,
      modelSecretStore,
      artifactService,
      workerTranscriptArtifactService,
      gatewayToolExecutor,
      memoryService,
      metrics: operationsMetrics,
      runner,
      automationScheduler,
      skillUploadService: upload.service,
      serverSkillImportService: serverImport,
      skillValidationService: validation.service,
      skillValidationPersistence: validation.persistence,
      skillRuntimeCatalog: productSkillRuntimeCatalog,
      registeredToolCatalog: productRegisteredToolCatalog,
      textResourceService: resources.service,
      inputAttachmentService: attachments.service,
      connectionDriverRegistry,
      connectionSecretBindingGateway,
      commandIntake,
      trustedSkillActivationRegistry,
      clock,
      idFactory,
      env,
      objectStoreRoot,
    });
  // PostgreSQL schema ownership is one-shot and precedes every bootstrap
  // consumer.  Composition may construct narrow ports before this barrier,
  // but no catalog, auth, or HTTP readiness path may query an unmigrated DB.
  // Injected applications are test hosts, not a production startup path.
  const migrationsReady = !application
    && productStore?.persistenceDriver === "postgres"
    && typeof productStore.runMigrations === "function"
    ? productStore.runMigrations()
    : Promise.resolve();
  const identityReady = migrationsReady.then(() => (bootstrapCatalog
    ? (productStore?.persistenceDriver === "postgres"
        ? productAuthService.ensureWorkspace()
        : testMode && typeof productStore.ensurePrivateWorkspace === "function"
        ? productStore.ensurePrivateWorkspace()
        : productStore.ensureTeamWorkspace?.({
            workspaceId: env.WORKBENCH_DEFAULT_WORKSPACE_ID ?? "workspace-local",
            workspaceName: env.WORKBENCH_DEFAULT_WORKSPACE_NAME ?? "Team workspace",
          }))
    : undefined));
  // New workspaces start empty. Bundled catalog content is an isolated test fixture.
  const catalogReady = identityReady.then(() => (bootstrapCatalog && String(env.WORKBENCH_TEST_MODE || "") === "1"
    ? productStore?.persistenceDriver === "postgres"
      ? Promise.resolve().then(() => {
        if (!composition.systemCatalogService) throw new TypeError("postgres_system_catalog_object_store_required");
        return composition.systemCatalogService.ensureGlobalSource();
      })
      : Promise.resolve(identityReady).then(() => bootstrapWorkbenchCatalog({
        store: productStore,
        agentRuntime: composition.agentRuntime,
        testMode: String(env.WORKBENCH_TEST_MODE || "") === "1"
          && String(env.WORKBENCH_TEST_BUSINESS_SKILL || "") !== "1",
        clock,
        workspaceId: env.WORKBENCH_DEFAULT_WORKSPACE_ID ?? "workspace-local",
      }))
    : undefined));
  // Runner recovery reads durable state only after the selected Store has
  // completed its startup handshake.
  const storeReady = migrationsReady.then(() => (!application && typeof productStore.connect === "function"
    ? productStore.connect()
    : undefined));
  const recoveryReady = startupRecovery
    ? Promise.resolve().then(() => startupRecovery())
    : Promise.resolve();
  const observeAttachmentCleanup = (result = {}) => {
    if (Number(result.expired) > 0) {
      operationsMetrics.increment(
        "workbench_attachment_cleanup_total",
        { outcome: "expired" },
        Number(result.expired),
      );
    }
    const failuresByCode = new Map();
    for (const failure of result.failures ?? []) {
      const candidate = String(failure?.code ?? "attachment_delete_failed");
      const code = /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
        ? candidate
        : "attachment_delete_failed";
      failuresByCode.set(code, (failuresByCode.get(code) ?? 0) + 1);
    }
    for (const [code, count] of failuresByCode) {
      operationsMetrics.increment(
        "workbench_attachment_cleanup_total",
        { outcome: "failed", code },
        count,
      );
      operationsLogger.warn("attachment.cleanup_failed", {
        component: "attachment_cleanup",
        code,
        count,
      });
    }
    return result;
  };
  const startupState = { ready: false, error: null };
  const ready = Promise.all([
    storeReady,
    catalogReady,
    identityReady,
    upload.ready,
    validation.ready,
    validation.recovery,
    recoveryReady,
    resources.ready,
    attachments.ready,
    composition.artifactReady ?? Promise.resolve(),
    composition.modelCatalogReady ?? Promise.resolve(),
  ])
    .then(async () => {
      if (attachments.service?.expireDue) {
        observeAttachmentCleanup(await attachments.service.expireDue());
      }
      if (typeof composition.artifactService?.reconcile === "function") {
        await composition.artifactService.reconcile({
          workspaceId: env.WORKBENCH_DEFAULT_WORKSPACE_ID ?? "workspace-local",
        });
      }
      if (typeof composition.workerTranscriptArtifactService?.cleanupExpired === "function") {
        await composition.workerTranscriptArtifactService.cleanupExpired();
      }
      if (typeof composition.agentSandbox?.scavenge === "function") {
        await composition.agentSandbox.scavenge();
      }
      if (typeof composition.admissionController?.recover === "function") {
        await composition.admissionController.recover();
      }
      if (composition.memberAgentService) await composition.memberAgentService.recover();
      if (typeof composition.executionBroker?.recoverStreams === "function") {
        await composition.executionBroker.recoverStreams();
      }
      if (typeof composition.skillTestRunner?.recover === "function") {
        await composition.skillTestRunner.recover();
      }
      if (typeof composition.runner?.recover === "function") {
        await composition.runner.recover();
      }
      if (typeof composition.agentTurnRunner?.recover === "function") {
        await composition.agentTurnRunner.recover();
      }
      if (typeof composition.automationScheduler?.pollDue === "function") {
        await composition.automationScheduler.pollDue({ limit: 10 });
      }
      startupState.ready = true;
    })
    .catch((error) => {
      startupState.error = error;
      throw error;
    });
  const productionMode = String(env.WORKBENCH_LOCAL_PRODUCTION || "") === "1";
  const modelRoutingRequirements = parseModelRoutingRequirements(
    env.WORKBENCH_MODEL_ROUTING_REQUIREMENTS_JSON,
  );
  const productReadiness = readiness ?? (
    testMode && productStore?.persistenceDriver !== "postgres"
      ? {
          async check() {
            const readyState = startupState.ready === true && startupState.error == null;
            return {
              ready: readyState,
              checks: [{ name: "startup", status: readyState ? "ok" : "failed" }],
            };
          },
        }
      : createProductReadiness({
          store: productStore,
          startupState,
          agentSandbox: composition.agentSandbox,
          providerProbe: providerProbe ?? composition.providerProbe,
          requireAgent: productionMode,
          requireProvider: productionMode,
          requireMigrations: productionMode,
          modelCatalog: composition.modelCatalog ?? modelCatalog,
          modelRoutingRequirements,
          requireModelRouting: productionMode,
        })
  );
  const operations = createOperationsHttpHandler({
    readiness: productReadiness,
    metrics: operationsMetrics,
    store: productStore,
    logger: operationsLogger,
  });
  const productSessionStore = sessionStore ?? createDefaultWorkbenchSessionStore({
    store: productStore,
    clock,
    testSessionStore,
  });
  const api = httpHandler ?? createWorkbenchHttpHandler({
    application: composition.application,
    sessionStore: productSessionStore,
    authService: productAuthService,
    testIdentityResolver: testIdentityResolver ?? createTestIdentityResolver(env),
    allowTestSessionBootstrap: testMode,
    allowedHosts,
    origin,
    clock,
    internalErrorReporter: createInternalErrorReporter({ env, logger: operationsLogger, metrics: operationsMetrics }),
    requestObserver: createRequestObserver({ logger: operationsLogger, metrics: operationsMetrics }),
  });
  const connectors = createManagedConnectorHttp({ createPersistence: productStore?.persistenceDriver === 'postgres' ? key => new PostgresAgentConnectorStore(productStore, key) : null, authService: productAuthService, env, origin });
  const staticHandler = createStaticHandler({ distDirectory });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    try {
      if (await operations(req, res)) return;
      await ready;
      if (await connectors(req, res)) return;
      if (pathname.startsWith("/api/workbench/v1")) return api(req, res);
      if (!await staticHandler(req, res)) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ code: "route_not_found" }));
      }
    } catch {
      if (res.headersSent) return res.destroy();
      const body = JSON.stringify({ code: "service_not_ready" });
      res.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    }
  });
  server.on("close", () => connectors.close());
  const deviceWorkerGateway = composition.deviceWorkerRegistry && composition.deviceLifecycle
    ? new DeviceWorkerGateway({
      authService: productAuthService,
      deviceLifecycle: composition.deviceLifecycle,
      registry: composition.deviceWorkerRegistry,
    }).attach(server)
    : null;
  const attachmentCleanupTimer = attachments.service?.expireDue
    ? setInterval(
        () => attachments.service.expireDue()
          .then(observeAttachmentCleanup)
          .catch((error) => {
            const candidate = String(error?.code ?? "attachment_cleanup_failed");
            const code = /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
              ? candidate
              : "attachment_cleanup_failed";
            operationsMetrics.increment(
              "workbench_attachment_cleanup_total",
              { outcome: "error", code },
            );
            operationsLogger.warn("attachment.cleanup_error", {
              component: "attachment_cleanup",
              code,
              count: 1,
            });
          }),
        15 * 60 * 1000,
      )
    : null;
  attachmentCleanupTimer?.unref?.();
  const transcriptCleanupTimer = composition.workerTranscriptArtifactService?.cleanupExpired
    ? setInterval(
        () => composition.workerTranscriptArtifactService.cleanupExpired().catch((error) => {
          operationsLogger.warn("worker_transcript.cleanup_error", {
            component: "worker_transcript_cleanup",
            code: typeof error?.code === "string" ? error.code : "worker_transcript_cleanup_failed",
          });
        }),
        15 * 60 * 1000,
      )
    : null;
  transcriptCleanupTimer?.unref?.();
  const invitationOutboxTimer = invitationMailer
    && typeof productAuthService.deliverInvitationOutbox === "function"
    ? setInterval(
      () => productAuthService.deliverInvitationOutbox({ limit: 10 }).catch((error) => {
        const candidate = String(error?.code ?? "invitation_delivery_failed");
        const code = /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
          ? candidate
          : "invitation_delivery_failed";
        operationsMetrics.increment("workbench_invitation_delivery_total", { outcome: "error", code });
        operationsLogger.warn("invitation.delivery_error", {
          component: "invitation_delivery",
          code,
        });
      }),
      60 * 1000,
    )
    : null;
  invitationOutboxTimer?.unref?.();
  if (invitationOutboxTimer) {
    ready.then(() => productAuthService.deliverInvitationOutbox({ limit: 10 })).catch((error) => {
      const candidate = String(error?.code ?? "invitation_delivery_failed");
      const code = /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
        ? candidate
        : "invitation_delivery_failed";
      operationsMetrics.increment("workbench_invitation_delivery_total", { outcome: "error", code });
      operationsLogger.warn("invitation.delivery_error", {
        component: "invitation_delivery",
        code,
      });
    });
  }
  const automationPollTimer = composition.automationScheduler?.pollDue
    ? setInterval(
      () => ready
        .then(() => composition.automationScheduler.pollDue({ limit: 10 }))
        .then((result) => {
          operationsMetrics.increment("workbench_automation_poll_total", { outcome: "success" });
          for (const outcome of ["accepted", "blocked", "skipped", "misfired"]) {
            const count = Number(result?.[outcome] ?? 0);
            if (count > 0) {
              operationsMetrics.increment(
                "workbench_automation_occurrence_total",
                { outcome },
                count,
              );
            }
          }
        })
        .catch((error) => {
          const candidate = String(error?.code ?? "automation_poll_failed");
          const code = /^[a-z][a-z0-9_]{0,63}$/.test(candidate)
            ? candidate
            : "automation_poll_failed";
          operationsMetrics.increment("workbench_automation_poll_total", { outcome: "error", code });
          operationsLogger.warn("automation.poll_error", {
            component: "automation_scheduler",
            code,
          });
        }),
      60 * 1000,
    )
    : null;
  automationPollTimer?.unref?.();
  const close = async () => {
    if (attachmentCleanupTimer) clearInterval(attachmentCleanupTimer);
    if (transcriptCleanupTimer) clearInterval(transcriptCleanupTimer);
    if (invitationOutboxTimer) clearInterval(invitationOutboxTimer);
    if (automationPollTimer) clearInterval(automationPollTimer);
    deviceWorkerGateway?.close();
    composition.deviceWorkerRegistry?.close?.();
    if (server.listening) {
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
    await composition.skillTestRunner?.stop?.();
    await composition.disposeRuntime?.();
    composition.workerTranscriptArtifactService?.dispose?.();
    await productStore.close?.();
  };
  return {
    ...composition,
    authService: productAuthService,
    sessionStore: productSessionStore,
    server,
    ready,
    close,
    operations: { handler: operations, readiness: productReadiness, metrics: operationsMetrics, logger: operationsLogger },
  };
}

function createInternalErrorReporter({ env, logger, metrics }) {
  const proofDiagnostics = String(env.WORKBENCH_PROOF_DIAGNOSTICS || "") === "1";
  return (diagnostic) => {
    metrics.increment("workbench_internal_errors_total", { component: "http" });
    logger.error("http.request.internal_error", {
      requestId: diagnostic.requestId,
      code: diagnostic.code ?? diagnostic.codeName ?? diagnostic.name,
      component: "http",
    });
    if (proofDiagnostics) process.stderr.write(`workbench_internal_error=${JSON.stringify(diagnostic)}\n`);
  };
}

function createRequestObserver({ logger, metrics }) {
  return ({ requestId, traceId, method, operation, statusCode, durationMs }) => {
    const status = String(statusCode);
    metrics.increment("workbench_http_requests_total", { operation, status });
    metrics.observe("workbench_http_request_duration_ms", { operation, status }, durationMs);
    logger.info("http.request.completed", {
      requestId,
      traceId,
      method,
      operation,
      statusCode,
      durationMs,
      component: "http",
    });
  };
}

const MODEL_ROUTING_CAPABILITIES = new Set([
  "chat",
  "tool_calling",
  "structured_output",
  "image_input",
  "image_generation",
]);

function parseModelRoutingRequirements(source) {
  if (typeof source !== "string" || !source.trim()) return [];
  try {
    const value = JSON.parse(source);
    if (!Array.isArray(value) || value.length === 0) return [];
    return value.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.workspaceId !== "string" || !item.workspaceId.trim()
        || !Array.isArray(item.capabilities) || item.capabilities.length === 0
        || item.capabilities.some((capability) => !MODEL_ROUTING_CAPABILITIES.has(capability))) {
        throw new TypeError("workbench_model_routing_requirements_invalid");
      }
      return {
        workspaceId: item.workspaceId.trim(),
        ...(typeof item.scopeId === "string" && item.scopeId.trim() ? { scopeId: item.scopeId.trim() } : {}),
        ...(typeof item.userId === "string" && item.userId.trim() ? { userId: item.userId.trim() } : {}),
        capabilities: [...new Set(item.capabilities)],
      };
    });
  } catch {
    return [];
  }
}

function parseNativeRedirectOrigins(source) {
  if (typeof source !== "string" || !source.trim()) return [];
  const values = source.split(",").map((value) => value.trim()).filter(Boolean);
  const origins = values.map((value) => {
    let url;
    try { url = new URL(value); }
    catch { throw new TypeError("workbench_native_redirect_origins_invalid"); }
    if (url.origin !== value || !["http:", "https:"].includes(url.protocol)) {
      throw new TypeError("workbench_native_redirect_origins_invalid");
    }
    return url.origin;
  });
  return [...new Set(origins)];
}

function importModelCatalogFromEnvironment({ env, catalog, workspaceId, createImporter = null }) {
  const source = String(env.WORKBENCH_MODEL_CATALOG_IMPORT_JSON || "").trim();
  if (!source) return Promise.resolve({ profiles: [], policies: [] });
  let configuration;
  try { configuration = JSON.parse(source); }
  catch { return Promise.reject(new TypeError("workbench_model_catalog_import_json_invalid")); }
  if (typeof createImporter !== "function") {
    return Promise.reject(new TypeError("model_catalog_import_unavailable"));
  }
  const importer = createImporter({ catalog });
  return importer.importConfiguration(configuration, {
    workspaceId,
    allowLoopbackEndpoints: String(env.WORKBENCH_MODEL_ALLOW_LOOPBACK_ENDPOINTS || "") === "1"
      && String(env.WORKBENCH_LOCAL_PRODUCTION || "") !== "1",
  });
}

function resolveSkillUploadService({ store, skillUploadService, objectStoreRoot, clock, idFactory }) {
  if (skillUploadService) return { service: skillUploadService, ready: Promise.resolve() };
  if (typeof objectStoreRoot !== "string" || objectStoreRoot.trim().length === 0) {
    return { service: null, ready: Promise.resolve() };
  }
  const objectStore = new FilesystemObjectStore({ rootDir: objectStoreRoot, now: clock });
  if (store?.persistenceDriver === "postgres") {
    return {
      service: new PostgresSkillUploadService({ store, objectStore, clock, idFactory }),
      ready: objectStore.initialize(),
    };
  }
  return {
    service: createSkillUploadService({
      store,
      objectStore,
      repositorySource: createGitHubSkillRepositorySource(),
      clock,
      idFactory,
    }),
    ready: objectStore.initialize(),
  };
}

function resolveServerSkillImportService({ env, store, skillUploadService }) {
  const roots = String(env.WORKBENCH_SKILL_IMPORT_ROOTS ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (roots.length === 0 || !skillUploadService) return null;
  return createServerSkillImportService({
    allowedRoots: roots,
    store,
    skillUploadService,
  });
}

function resolveTextResourceService({ store, textResourceService, objectStoreRoot, clock, idFactory }) {
  if (textResourceService) return { service: textResourceService, ready: Promise.resolve() };
  if (typeof objectStoreRoot !== "string" || objectStoreRoot.trim().length === 0) {
    return { service: null, ready: Promise.resolve() };
  }
  const objectStore = new FilesystemObjectStore({ rootDir: objectStoreRoot, now: clock });
  return {
    service: createTextResourceService({
      ...(store?.persistenceDriver === "postgres"
        ? { persistence: store.createTextResourcePersistence({ clock }) }
        : { store }),
      objectStore,
      clock,
      idFactory,
    }),
    ready: objectStore.initialize(),
  };
}

function resolveInputAttachmentService({
  store,
  inputAttachmentService,
  objectStoreRoot,
  extractorImage,
  extractionRoot,
  clock,
  idFactory,
}) {
  if (inputAttachmentService) {
    return { service: inputAttachmentService, ready: Promise.resolve() };
  }
  if (typeof objectStoreRoot !== "string" || objectStoreRoot.trim().length === 0) {
    return { service: null, ready: Promise.resolve() };
  }
  const objectStore = new FilesystemObjectStore({
    rootDir: objectStoreRoot,
    now: clock,
  });
  let extractionSandbox = null;
  if (
    typeof extractorImage === "string" &&
    /@sha256:[a-f0-9]{64}$/.test(extractorImage)
  ) {
    extractionSandbox = new DockerAttachmentExtractionSandbox({
      image: extractorImage,
      ...(typeof extractionRoot === "string" && extractionRoot.trim()
        ? { tempRoot: extractionRoot }
        : {}),
    });
  }
  return {
    service: createInputAttachmentService({
      ...(store?.persistenceDriver === "postgres"
        ? { persistence: store.createInputAttachmentPersistence({ clock }) }
        : { store }),
      objectStore,
      extractionSandbox,
      clock,
      idFactory,
    }),
    ready: Promise.all([
      objectStore.initialize(),
      extractionSandbox?.initialize?.() ?? Promise.resolve(),
    ]),
  };
}

function resolveSkillValidationService({
  store,
  skillValidationService,
  objectStoreRoot,
  executionRoot,
  runtimeImages,
  clock,
  idFactory,
}) {
  if (skillValidationService) return { service: skillValidationService, ready: Promise.resolve(), recovery: Promise.resolve() };
  if (typeof objectStoreRoot !== "string" || objectStoreRoot.trim().length === 0) {
    return { service: null, ready: Promise.resolve(), recovery: Promise.resolve() };
  }
  const objectStore = new FilesystemObjectStore({ rootDir: objectStoreRoot, now: clock });
  const isolatedExecutor = runtimeImages?.size > 0 ? createDockerSkillExecutor({
    objectStore,
    images: runtimeImages,
    ...(typeof executionRoot === "string" && executionRoot.trim() ? { tempRoot: executionRoot } : {}),
  }) : null;
  const ready = objectStore.initialize();
  const persistence = store?.persistenceDriver === "postgres"
    ? new PostgresSkillValidationPersistence({ store, clock })
    : null;
  const ports = persistence
    ? new PostgresSkillValidationPort({ store, objectStore, persistence })
    : null;
  return {
    service: createSkillValidationCoordinator({
      store,
      objectStore,
      isolatedExecutor,
      imageDigests: runtimeImages,
      clock,
      idFactory,
      ...(ports ? { ports } : {}),
    }),
    persistence,
    ready,
    recovery: ready.then(() => isolatedExecutor?.scavenge()),
  };
}

export async function startWorkbenchServer(options = {}) {
  const composed = createWorkbenchServer(options);
  await composed.ready;
  const port = options.port ?? Number(process.env.WORKBENCH_PORT ?? DEFAULT_WORKBENCH_PORT);
  await new Promise((resolveListen, reject) => {
    composed.server.once("error", reject);
    composed.server.listen(port, "127.0.0.1", resolveListen);
  });
  const address = composed.server.address();
  const listeningPort = address && typeof address === "object" ? address.port : port;
  return { ...composed, port: listeningPort };
}

function isMainModule() {
  return Boolean(process.argv[1])
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  const { runProductionWorkbenchServerCli } = await import("./production-composition.mjs");
  await runProductionWorkbenchServerCli();
}
