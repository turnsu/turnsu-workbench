import { randomUUID } from "node:crypto";
import http from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createGateEngine } from "../../../../agent/code/agent-runtime/core/gates/gate-engine.mjs";
import { buildAgentFinalReadModelV1 } from "../../../../agent/code/agent-runtime/core/final-output/final-read-model.mjs";
import { createAgentRuntimeCore } from "../../../../agent/code/agent-runtime/core/run-loop/agent-runtime-core.mjs";
import { createPiBuilderProposalGenerator } from "../../../../agent/code/agent-runtime/core/proposals/pi-builder-proposal-generator.mjs";
import { createWorkflowSkillExecutorRegistry } from "../../../../agent/code/agent-runtime/core/workflow/workflow-skill-executor-registry.mjs";
import {
  registerWorkflowConformanceExecutor,
  WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME,
} from "../../../../agent/code/agent-runtime/extensions/workflow-conformance/binding.mjs";
import {
  registerMeetingActionExtractorExecutor,
  MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME,
} from "../../../../agent/code/agent-runtime/extensions/meeting-action-extractor/binding.mjs";
import {
  installUploadedSkillExecutionPort,
  UPLOADED_SKILL_INTERNAL_TOOL_NAME,
} from "../../../../agent/code/agent-runtime/extensions/uploaded-skill-executor/binding.mjs";
import {
  createPiBackedAgentRuntime,
  createPiKernelAdapter,
} from "../../../../agent/code/agent-runtime/kernels/pi/pi-kernel-adapter.mjs";
import { resolveRuntimePaths } from "../../../../agent/code/agent-runtime/lib/runtime-paths.mjs";

import {
  AgentTurnRunner,
  MongoAgentPersistence,
  ProductAgentProposalService,
  createProductAgentExecutor,
} from "./agents/index.mjs";
import {
  createExecutionResolver,
  createWorkbenchApplication,
} from "./application/workbench-application.mjs";
import { bootstrapWorkbenchCatalog } from "./application/catalog-bootstrap.mjs";
import { createWorkbenchHttpHandler } from "./http/workbench-http-handler.mjs";
import {
  CanonicalMemoryResolver,
  MongoMemoryPersistence,
  ProductMemoryService,
} from "./memory/index.mjs";
import {
  createDeterministicSkillBackend,
  createConfiguredModelService,
  createModelCallBackend,
  createRemoteExecutionBackend,
  ExecutionBroker,
  MongoExecutionPersistence,
  ProductToolGateway,
  StdioToolGatewayServer,
} from "./execution/index.mjs";
import {
  createArtifactService,
  createProductArtifactMetadataRepositoryAdapter,
} from "./artifacts/index.mjs";
import {
  ModelCatalog,
  ModelCatalogImporter,
  createKeychainCredentialResolver,
} from "./models/index.mjs";
import { createWorkflowRunner } from "./runner/index.mjs";
import {
  AgentContainerSandbox,
  createAgentContainerBackend,
  createDockerSkillExecutor,
  createInProcessAgentAdapter,
} from "./runtime/index.mjs";
import { MongoWorkbenchSessionStore } from "./security/mongo-workbench-session-store.mjs";
import {
  createGitHubSkillRepositorySource,
  createSkillUploadService,
  createSkillValidationCoordinator,
  createTrustedSkillActivationRegistry,
} from "./skills/index.mjs";
import { createTextResourceService } from "./resources/index.mjs";
import { FilesystemObjectStore } from "./storage/index.mjs";
import { ProductMongoStore } from "./store/index.mjs";
import {
  createJsonLogger,
  createOperationsHttpHandler,
  createProductReadiness,
  MetricsRegistry,
} from "./operations/index.mjs";
import { createStaticHandler } from "./web/static-handler.mjs";

export const DEFAULT_WORKBENCH_PORT = 8798;
const DEFAULT_BUILDER_PROPOSAL_TIMEOUT_MS = 90_000;

const sourceDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(sourceDirectory, "../../../../..");
const defaultDistDirectory = join(
  repositoryRoot,
  "domains/frontend/web/code/web-prototype/dist",
);
const defaultClock = () => new Date().toISOString();
const defaultIdFactory = (kind) => `${kind}-${randomUUID()}`;
const TEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MEMORY_ROLE_RANK = Object.freeze({ viewer: 0, member: 1, maintainer: 2, owner: 3, admin: 3 });

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

async function resolveMemoryObjectPermission({ store, scope, context, action }) {
  if (!scope || scope.kind !== "object" || !context?.workspaceId) return false;
  if (action !== "read" && (MEMORY_ROLE_RANK[context.role] ?? -1) < MEMORY_ROLE_RANK.member) return false;
  try {
    if (scope.objectKind === "workflow") {
      await store.getWorkflow(scope.objectId, { workspaceId: context.workspaceId });
      return true;
    }
    if (scope.objectKind === "skill_draft") {
      await store.connect();
      return Boolean(await store.repositories?.skillDrafts?.get(scope.objectId, { workspaceId: context.workspaceId }));
    }
  } catch (error) {
    if (["workflow_not_found", "skill_draft_not_found"].includes(error?.code)) return false;
    throw error;
  }
  return false;
}

export function createDefaultAgentRuntime({
  env = process.env,
  clock = defaultClock,
  idFactory = defaultIdFactory,
  uploadedSkillRuntime = null,
} = {}) {
  const paths = resolveRuntimePaths({ env });
  const workbenchTestMode = String(env.WORKBENCH_TEST_MODE || "") === "1";
  const agentTestMode = String(env.WECHAT_AGENT_TEST_MODE || "") === "1";
  const testBusinessSkill = workbenchTestMode
    && String(env.WORKBENCH_TEST_BUSINESS_SKILL || "") === "1";
  if (workbenchTestMode !== agentTestMode) {
    throw new Error("workbench_and_agent_test_mode_must_match");
  }

  const extensionPackage = workbenchTestMode && !testBusinessSkill
    ? {
      id: "workflow-conformance",
      extensionPath: join(paths.agentRuntimeRoot, "extensions/workflow-conformance/extension.ts"),
      manifest: { testOnly: true },
    }
    : {
      id: "meeting-action-extractor",
      extensionPath: join(paths.agentRuntimeRoot, "extensions/meeting-action-extractor/extension.ts"),
      manifest: { testOnly: false },
    };
  const projectToolNames = workbenchTestMode && !testBusinessSkill
    ? [WORKFLOW_CONFORMANCE_INTERNAL_TOOL_NAME]
    : [MEETING_ACTION_EXTRACTOR_INTERNAL_TOOL_NAME];
  const extensionPackages = [extensionPackage];
  let disposeUploadedSkillExecutionPort = null;
  if (typeof uploadedSkillRuntime?.executePublished === "function"
    && typeof uploadedSkillRuntime?.probeExecution === "function") {
    const uploadedExtensionPackage = {
      id: "uploaded-skill-executor",
      extensionPath: join(paths.agentRuntimeRoot, "extensions/uploaded-skill-executor/extension.ts"),
      manifest: { testOnly: false },
    };
    extensionPackages.push(uploadedExtensionPackage);
    projectToolNames.push(UPLOADED_SKILL_INTERNAL_TOOL_NAME);
  }
  const piRuntime = createPiBackedAgentRuntime({
    projectRoot: paths.repoRoot,
    agentRuntimeRoot: paths.agentRuntimeRoot,
    piAgentDir: paths.piAgentDir,
    piExtensionPath: extensionPackage.extensionPath,
    piSkillPath: join(paths.agentRuntimeRoot, "skills"),
    piPromptPath: join(paths.agentRuntimeRoot, "prompts"),
    projectToolNames,
    discoverExtensionPaths: () => extensionPackages.map((item) => item.extensionPath),
    discoverExtensionPackages: () => extensionPackages,
    now: clock,
    safeId: idFactory,
  });
  const piKernel = createPiKernelAdapter(piRuntime);
  const executorRegistry = createWorkflowSkillExecutorRegistry();
  if (workbenchTestMode && !testBusinessSkill) {
    registerWorkflowConformanceExecutor(executorRegistry, { env });
  } else {
    registerMeetingActionExtractorExecutor(executorRegistry);
  }
  const agentRuntimeCore = createAgentRuntimeCore({
    router: {},
    gateEngine: createGateEngine({ now: clock }),
    piKernel,
    finalOutput: { buildAgentFinalReadModelV1 },
    artifacts: {},
    providerExecutor: {},
    capabilityCatalog: { capabilities: [] },
    builderProposalGenerator: createPiBuilderProposalGenerator({
      cwd: paths.repoRoot,
      agentDir: paths.piAgentDir,
      timeoutMs: DEFAULT_BUILDER_PROPOSAL_TIMEOUT_MS,
    }),
  });
  const agentRuntime = createInProcessAgentAdapter({
    agentRuntimeCore,
    piKernel,
    executorRegistry,
    uploadedSkillRuntime,
    now: clock,
  });
  if (extensionPackages.length > 1) {
    disposeUploadedSkillExecutionPort = installUploadedSkillExecutionPort(uploadedSkillRuntime);
  }
  return {
    agentRuntime,
    piRuntime,
    dispose: disposeUploadedSkillExecutionPort,
  };
}

export function createWorkbenchComposition({
  store = new ProductMongoStore(),
  agentRuntime,
  executionBroker,
  executionBackends = [],
  remoteTransport = null,
  agentTurnRunner,
  agentExecutor = null,
  agentProposalService = null,
  agentSandbox = null,
  toolGateway = null,
  gatewayModelExecutor = null,
  modelService = null,
  modelCatalog = null,
  credentialResolver = null,
  artifactService = null,
  gatewayToolExecutor = null,
  memoryService,
  metrics = null,
  runner,
  skillUploadService,
  skillValidationService,
  textResourceService,
  trustedSkillActivationRegistry = createTrustedSkillActivationRegistry({
    agentRuntimeRoot: join(repositoryRoot, "domains/agent/code/agent-runtime"),
  }),
  clock = defaultClock,
  idFactory = defaultIdFactory,
  env = process.env,
  objectStoreRoot = env.WORKBENCH_OBJECT_STORE_ROOT,
} = {}) {
  const runtimeBundle = agentRuntime
    ? { agentRuntime, piRuntime: null, dispose: null }
    : createDefaultAgentRuntime({
      env,
      clock,
      idFactory,
      uploadedSkillRuntime: skillValidationService,
    });
  const executionPersistence = executionBroker ? null : new MongoExecutionPersistence({ store });
  const productCredentialResolver = credentialResolver ?? (
    String(env.WORKBENCH_MODEL_KEYCHAIN_SERVICE || "").trim()
      ? createKeychainCredentialResolver({ service: String(env.WORKBENCH_MODEL_KEYCHAIN_SERVICE).trim() })
      : null
  );
  const productModelCatalog = modelCatalog ?? new ModelCatalog({
    store,
    clock: () => new Date(clock()),
    idFactory,
    readinessResolver: async ({ revision }) => {
      if (!productCredentialResolver) return { state: "unavailable", reason: "credential_resolver_unavailable" };
      try {
        await productCredentialResolver.resolve(revision.credentialRef);
        return { state: "ready" };
      } catch {
        return { state: "unavailable", reason: "credential_unavailable" };
      }
    },
  });
  const artifactObjectStore = !artifactService && executionPersistence
    && typeof objectStoreRoot === "string" && objectStoreRoot.trim()
    ? new FilesystemObjectStore({ rootDir: objectStoreRoot, now: clock })
    : null;
  const productArtifactService = artifactService ?? (artifactObjectStore ? createArtifactService({
    metadataRepository: createProductArtifactMetadataRepositoryAdapter(store),
    executionPersistence,
    objectStore: artifactObjectStore,
    clock,
    idFactory,
  }) : null);
  const recordModelAttempt = executionPersistence?.appendEvent
    ? async (event) => {
      await executionPersistence.appendEvent(event.invocationId, (sequence) => ({
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
  const productExecutionBroker = executionBroker ?? new ExecutionBroker({
    persistence: executionPersistence,
    clock,
    idFactory,
  });
  if (!executionBroker) {
    productExecutionBroker.registerBackend({
      mode: "deterministic_skill",
      isolation: "process",
      backend: createDeterministicSkillBackend({ agentRuntime: runtimeBundle.agentRuntime }),
    });
    if (configuredGatewayModelExecutor) {
      productExecutionBroker.registerBackend({
        mode: "model_call",
        isolation: "process",
        backend: createModelCallBackend({ modelService: configuredGatewayModelExecutor }),
      });
    }
  }
  const productToolGateway = toolGateway ?? (executionPersistence ? new ProductToolGateway({
    persistence: executionPersistence,
    modelExecutor: configuredGatewayModelExecutor,
    toolExecutor: gatewayToolExecutor,
    clock,
    observer: metrics
      ? ({ outcome, code }) => metrics.increment("workbench_gateway_requests_total", { outcome, code })
      : null,
  }) : null);
  const productAgentSandbox = agentSandbox ?? (
    env.WORKBENCH_AGENT_IMAGE && productToolGateway
      ? new AgentContainerSandbox({
        image: env.WORKBENCH_AGENT_IMAGE,
        gatewayServer: new StdioToolGatewayServer({
          gateway: productToolGateway,
        }),
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
  if (remoteTransport) {
    const remoteBackend = createRemoteExecutionBackend({ transport: remoteTransport });
    for (const mode of ["deterministic_skill", "model_call", "bounded_agent", "agent_orchestrator"]) {
      const explicitlyRegistered = executionBackends.some((item) => item.mode === mode && item.isolation === "remote");
      if (!explicitlyRegistered) {
        productExecutionBroker.registerBackend({ mode, isolation: "remote", backend: remoteBackend });
      }
    }
  }
  for (const registration of executionBackends) {
    productExecutionBroker.registerBackend(registration);
  }
  const productRunner = runner ?? createWorkflowRunner({
    store,
    resolveExecution: createExecutionResolver({ store }),
    resolveResourceText: textResourceService?.readText?.bind(textResourceService),
    agentRuntime: runtimeBundle.agentRuntime,
    executionBroker: productExecutionBroker,
    clock,
    idFactory,
  });
  const productAgentProposalService = agentProposalService ?? new ProductAgentProposalService({ store, clock, idFactory });
  const productAgentExecutor = agentExecutor ?? createProductAgentExecutor({ proposalService: productAgentProposalService });
  const productAgentTurnRunner = agentTurnRunner ?? new AgentTurnRunner({
    persistence: new MongoAgentPersistence({ store }),
    executionBroker: productExecutionBroker,
    executor: productAgentExecutor,
    clock,
    idFactory,
    resolveModelSelection: async ({
      workspaceId,
      kind,
      modelProfileRevisionId,
      requiredCapabilities,
    }) => {
      const resolved = await productModelCatalog.resolveRevision({
        revisionId: modelProfileRevisionId,
        workspaceId,
        capabilities: requiredCapabilities,
        requireReady: true,
      });
      return {
        revisionId: resolved.revision.revisionId,
        profileId: resolved.profile.profileId,
        capability: kind === "model_task"
          ? "image_generation"
          : requiredCapabilities.includes("structured_output")
            ? "structured_output"
            : "tool_calling",
      };
    },
    resolveBaseVersion: async ({ objectKind, objectId, workspaceId }) => {
      if (objectKind === "workflow") {
        return (await store.getWorkflow(objectId, { workspaceId })).workflow.currentRevisionId;
      }
      if (objectKind === "skill_draft") {
        await store.connect();
        const draft = await store.repositories?.skillDrafts?.get(objectId, { workspaceId });
        return draft ? `${draft.skillDraftId}:${draft.revision}` : null;
      }
      return null;
    },
  });
  const productMemoryService = memoryService ?? new ProductMemoryService({
    persistence: new MongoMemoryPersistence({ store }),
    clock,
    idFactory,
    objectPermissionResolver: ({ scope, context, action }) => resolveMemoryObjectPermission({
      store,
      scope,
      context,
      action,
    }),
    canonicalResolver: new CanonicalMemoryResolver({ store }),
  });
  const artifactReady = artifactObjectStore?.initialize?.() ?? Promise.resolve();
  const modelCatalogReady = importModelCatalogFromEnvironment({
    env,
    catalog: productModelCatalog,
    workspaceId: env.WORKBENCH_DEFAULT_WORKSPACE_ID || "workspace-local",
  });
  const application = createWorkbenchApplication({
    store,
    agentRuntime: runtimeBundle.agentRuntime,
    executionBroker: productExecutionBroker,
    agentTurnRunner: productAgentTurnRunner,
    memoryService: productMemoryService,
    artifactService: productArtifactService,
    modelCatalog: productModelCatalog,
    modelService: configuredGatewayModelExecutor,
    runner: productRunner,
    skillUploadService,
    skillValidationService,
    textResourceService,
    trustedSkillActivationRegistry,
    clock,
    idFactory,
  });
  return {
    store,
    agentRuntime: runtimeBundle.agentRuntime,
    executionBroker: productExecutionBroker,
    toolGateway: productToolGateway,
    gatewayModelExecutor: configuredGatewayModelExecutor,
    modelService: configuredGatewayModelExecutor,
    providerProbe: configuredGatewayModelExecutor?.probe
      ? () => configuredGatewayModelExecutor.probe({
        workspaceId: env.WORKBENCH_DEFAULT_WORKSPACE_ID || "workspace-local",
      })
      : null,
    agentSandbox: productAgentSandbox,
    remoteTransport,
    agentTurnRunner: productAgentTurnRunner,
    agentExecutor: productAgentExecutor,
    agentProposalService: productAgentProposalService,
    memoryService: productMemoryService,
    artifactService: productArtifactService,
    modelCatalog: productModelCatalog,
    artifactReady,
    modelCatalogReady,
    piRuntime: runtimeBundle.piRuntime,
    disposeRuntime: runtimeBundle.dispose,
    runner: productRunner,
    application,
  };
}

export function createWorkbenchServer({
  store,
  agentRuntime,
  executionBroker,
  executionBackends,
  remoteTransport,
  agentTurnRunner,
  agentExecutor,
  agentProposalService,
  agentSandbox,
  toolGateway,
  gatewayModelExecutor,
  modelService,
  modelCatalog,
  credentialResolver,
  artifactService,
  gatewayToolExecutor,
  memoryService,
  runner,
  distDirectory = defaultDistDirectory,
  bootstrapCatalog = true,
  application,
  httpHandler,
  sessionStore,
  skillUploadService,
  skillValidationService,
  textResourceService,
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
  const productStore = store ?? new ProductMongoStore();
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
  const validation = resolveSkillValidationService({
    store: productStore,
    skillValidationService,
    objectStoreRoot,
    executionRoot: env.WORKBENCH_EXECUTION_ROOT,
    imageDigest: env.WORKBENCH_DOCKER_IMAGE,
    clock,
    idFactory,
  });
  const composition = application
    ? { store: productStore, agentRuntime, agentSandbox, runner, piRuntime: null, disposeRuntime: null, application }
    : createWorkbenchComposition({
      store: productStore,
      agentRuntime,
      executionBroker,
      executionBackends,
      remoteTransport,
      agentTurnRunner,
      agentExecutor,
      agentProposalService,
      agentSandbox,
      toolGateway,
      gatewayModelExecutor,
      modelService,
      modelCatalog,
      credentialResolver,
      artifactService,
      gatewayToolExecutor,
      memoryService,
      metrics: operationsMetrics,
      runner,
      skillUploadService: upload.service,
      skillValidationService: validation.service,
      textResourceService: resources.service,
      trustedSkillActivationRegistry,
      clock,
      idFactory,
      env,
      objectStoreRoot,
    });
  const catalogReady = bootstrapCatalog
    ? bootstrapWorkbenchCatalog({
      store: productStore,
      agentRuntime: composition.agentRuntime,
      testMode: String(env.WORKBENCH_TEST_MODE || "") === "1"
        && String(env.WORKBENCH_TEST_BUSINESS_SKILL || "") !== "1",
      clock,
      workspaceId: "workspace-local",
    })
    : Promise.resolve();
  const identityReady = bootstrapCatalog && typeof productStore.ensurePrivateWorkspace === "function"
    ? productStore.ensurePrivateWorkspace()
    : Promise.resolve();
  // Runner recovery reads durable repositories. A fresh ProductMongoStore does
  // not bind those repositories until connect() has completed.
  const storeReady = !application && typeof productStore.connect === "function"
    ? productStore.connect()
    : Promise.resolve();
  const recoveryReady = startupRecovery
    ? Promise.resolve().then(() => startupRecovery())
    : Promise.resolve();
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
    composition.artifactReady ?? Promise.resolve(),
    composition.modelCatalogReady ?? Promise.resolve(),
  ])
    .then(async () => {
      if (typeof composition.artifactService?.reconcile === "function") {
        await composition.artifactService.reconcile();
      }
      if (typeof composition.agentSandbox?.scavenge === "function") {
        await composition.agentSandbox.scavenge();
      }
      if (typeof composition.runner?.recover === "function") {
        await composition.runner.recover();
      }
      if (typeof composition.agentTurnRunner?.recover === "function") {
        await composition.agentTurnRunner.recover();
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
  const productReadiness = readiness ?? createProductReadiness({
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
  });
  const operations = createOperationsHttpHandler({
    readiness: productReadiness,
    metrics: operationsMetrics,
    store: productStore,
    logger: operationsLogger,
  });
  const api = httpHandler ?? createWorkbenchHttpHandler({
    application: composition.application,
    sessionStore: sessionStore ?? new MongoWorkbenchSessionStore({ store: productStore, clock }),
    testIdentityResolver: testIdentityResolver ?? createTestIdentityResolver(env),
    allowedHosts,
    origin,
    clock,
    internalErrorReporter: createInternalErrorReporter({ env, logger: operationsLogger, metrics: operationsMetrics }),
    requestObserver: createRequestObserver({ logger: operationsLogger, metrics: operationsMetrics }),
  });
  const staticHandler = createStaticHandler({ distDirectory });
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    try {
      if (await operations(req, res)) return;
      await ready;
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
  const close = async () => {
    if (server.listening) {
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
    composition.piRuntime?.session?.dispose?.();
    composition.disposeRuntime?.();
    await productStore.close?.();
  };
  return {
    ...composition,
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
        capabilities: [...new Set(item.capabilities)],
      };
    });
  } catch {
    return [];
  }
}

function importModelCatalogFromEnvironment({ env, catalog, workspaceId }) {
  const source = String(env.WORKBENCH_MODEL_CATALOG_IMPORT_JSON || "").trim();
  if (!source) return Promise.resolve({ profiles: [], policies: [] });
  let configuration;
  try { configuration = JSON.parse(source); }
  catch { return Promise.reject(new TypeError("workbench_model_catalog_import_json_invalid")); }
  const importer = new ModelCatalogImporter({ catalog });
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

function resolveTextResourceService({ store, textResourceService, objectStoreRoot, clock, idFactory }) {
  if (textResourceService) return { service: textResourceService, ready: Promise.resolve() };
  if (typeof objectStoreRoot !== "string" || objectStoreRoot.trim().length === 0) {
    return { service: null, ready: Promise.resolve() };
  }
  const objectStore = new FilesystemObjectStore({ rootDir: objectStoreRoot, now: clock });
  return {
    service: createTextResourceService({ store, objectStore, clock, idFactory }),
    ready: objectStore.initialize(),
  };
}

function resolveSkillValidationService({
  store,
  skillValidationService,
  objectStoreRoot,
  executionRoot,
  imageDigest,
  clock,
  idFactory,
}) {
  if (skillValidationService) return { service: skillValidationService, ready: Promise.resolve(), recovery: Promise.resolve() };
  if (typeof objectStoreRoot !== "string" || objectStoreRoot.trim().length === 0
    || typeof imageDigest !== "string" || imageDigest.trim().length === 0) {
    return { service: null, ready: Promise.resolve(), recovery: Promise.resolve() };
  }
  const objectStore = new FilesystemObjectStore({ rootDir: objectStoreRoot, now: clock });
  const isolatedExecutor = createDockerSkillExecutor({
    objectStore,
    image: imageDigest,
    ...(typeof executionRoot === "string" && executionRoot.trim() ? { tempRoot: executionRoot } : {}),
  });
  const ready = objectStore.initialize();
  return {
    service: createSkillValidationCoordinator({
      store,
      objectStore,
      isolatedExecutor,
      imageDigest,
      clock,
      idFactory,
    }),
    ready,
    recovery: ready.then(() => isolatedExecutor.scavenge()),
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
  return { ...composed, port };
}

function isMainModule() {
  return Boolean(process.argv[1])
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  let running;
  const shutdown = async () => {
    try {
      await running?.close?.();
      process.exitCode = 0;
    } catch (error) {
      console.error(error?.stack || error);
      process.exitCode = 1;
    }
  };
  startWorkbenchServer()
    .then((value) => {
      running = value;
      process.stdout.write(`workbench_server_ready:http://127.0.0.1:${value.port}\n`);
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error) => {
      console.error(error?.stack || error);
      process.exitCode = 1;
    });
}
