const WRITE_ROLES = new Set(["owner", "admin", "member"]);
// Pi validates the final output against its result schema; provider-native JSON Schema is not required.
const BUILDER_CAPABILITIES = ["chat", "tool_calling"];

const decision = (status, reasonCode, message, recoveryRoute = null, action = "none") =>
  Object.freeze({ status, reasonCode, message, recoveryRoute, action });

const ready = (message = "This operation is ready.") =>
  decision("ready", "ready", message);

const forbidden = (message = "Your workspace role cannot perform this operation.") =>
  decision("forbidden", "workspace_role_forbidden", message, "/members", "contact_admin");

const unavailable = (reasonCode, message, recoveryRoute = null, action = "contact_admin") =>
  decision("unavailable", reasonCode, message, recoveryRoute, action);

const needsSetup = (reasonCode, message, recoveryRoute, action = "navigate") =>
  decision("needs_setup", reasonCode, message, recoveryRoute, action);

const checking = (reasonCode, message, recoveryRoute, action = "retry") =>
  decision("checking", reasonCode, message, recoveryRoute, action);

function writeGate(role, value) {
  return WRITE_ROLES.has(role) ? value : forbidden();
}

function action(capability, phases) {
  return Object.freeze(Object.fromEntries(
    Object.entries(phases).filter(([, value]) => value),
  ));
}

export async function evaluateWorkspaceFeatureReadiness({
  context,
  store,
  clock,
  skillUploadService,
  serverSkillImportService,
  skillRuntimeCatalog,
  skillValidationService,
  registeredToolCatalog,
  textResourceService,
  inputAttachmentService,
  connectionDriverRegistry,
  executionBroker,
  modelCatalog,
  skillDraftLifecycle,
  loopDraftLifecycle,
  connectionService,
} = {}) {
  const role = context.role;
  const canWrite = WRITE_ROLES.has(role);
  const knownRuntimes = (Array.isArray(skillRuntimeCatalog) ? skillRuntimeCatalog : [])
    .map((runtime) => runtime.runtimeId)
    .filter(Boolean);
  const configuredRuntimes = (Array.isArray(skillRuntimeCatalog) ? skillRuntimeCatalog : [])
    .filter((runtime) => runtime.availability === "ready")
    .map((runtime) => runtime.runtimeId)
    .filter(Boolean);
  const runtimeProbe = typeof skillValidationService?.probeRuntimes === "function"
    ? await skillValidationService.probeRuntimes().catch(() => [])
    : [];
  const runtimeProbeById = new Map(runtimeProbe.map((entry) => [entry.runtimeId, entry]));
  const readyRuntimes = (Array.isArray(skillRuntimeCatalog) ? skillRuntimeCatalog : [])
    .filter((runtime) => runtime.availability === "ready")
    .filter((runtime) => {
      const probe = runtimeProbeById.get(runtime.runtimeId);
      return probe?.available === true && probe?.verified === true;
    })
    .map((runtime) => runtime.runtimeId)
    .sort();
  const toolPackages = Array.isArray(registeredToolCatalog) ? registeredToolCatalog : [];
  const modelProfiles = modelCatalog?.listProfiles
    ? await modelCatalog.listProfiles({
        workspaceId: context.workspaceId,
        userId: context.userId,
        capabilities: BUILDER_CAPABILITIES,
        includeDisabled: true,
      })
    : [];
  const selectableBuilderModels = modelProfiles.filter((profile) => profile.selectable === true);
  const attachmentCapabilities = inputAttachmentService?.capabilities?.() ?? {
    readyMediaTypes: [],
    unavailableMediaTypes: [],
  };
  const hasSkillUpload = Boolean(
    skillUploadService?.createUpload
    && skillUploadService?.inspectUpload
    && skillUploadService?.promoteUpload,
  );
  const hasAgentContainer = executionBroker?.hasBackend?.({
    mode: "bounded_agent",
    isolation: "container",
  }) === true;
  const agentContainerProbe = hasAgentContainer && executionBroker?.probeBackend
    ? await executionBroker.probeBackend({
        mode: "bounded_agent",
        isolation: "container",
      })
    : hasAgentContainer
      ? { available: true, verified: false }
      : { available: false, verified: true };
  const hasPromptTestBackend = Boolean(skillValidationService?.prepareTestIntake) && executionBroker?.hasBackend?.({
    mode: "bounded_agent",
    isolation: "process",
  }) === true;
  const account = role === "owner" && typeof store?.getAuthAccount === "function"
    ? await store.getAuthAccount(context.userId).catch(() => null)
    : null;
  const serverImportAllowed = Boolean(
    role === "owner"
    && account?.role === "admin"
    && account?.disabled !== true
    && serverSkillImportService?.scan
    && serverSkillImportService?.import,
  );
  const connectionCapabilities = toolPackages
    .flatMap((toolPackage) => toolPackage.actions ?? [])
    .map((item) => item.actionId)
    .filter(Boolean);
  const connectionDescriptors = connectionDriverRegistry?.describe
    ? await Promise.all(connectionCapabilities.map((capabilityKey) =>
        connectionDriverRegistry.describe(capabilityKey)))
    : [];
  const productionConnection = connectionDescriptors.find((descriptor) =>
    descriptor.registered && descriptor.backend === "production");
  const connectionBindingReady = Boolean(
    productionConnection?.bindingAvailable && productionConnection?.probeAvailable,
  );
  const connectionRepository = store?.repositories?.connections;
  const workspaceConnections = connectionBindingReady && (connectionService?.list || connectionRepository)
    ? await (connectionService?.list
      ? connectionService.list({ workspaceId: context.workspaceId, query: { includeDisabled: true, limit: 1000 } })
      : typeof connectionRepository.listAllForReadModel === "function"
        ? connectionRepository.listAllForReadModel({ workspaceId: context.workspaceId })
        : connectionRepository.list({ workspaceId: context.workspaceId, limit: 1000 })
      ).catch(() => null)
    : [];
  const readinessNow = Date.parse(typeof clock === "function" ? String(clock()) : new Date().toISOString());
  const readyProductionConnections = Array.isArray(workspaceConnections)
    ? workspaceConnections.filter((connection) => (
        connection?.driverBackend === "production"
        && connectionCapabilities.includes(connection?.capabilityKey)
        && connection?.credentialState === "bound"
        && connection?.status === "connected"
        && connection?.validation?.status === "valid"
        && (
          typeof connection.validation?.expiresAt !== "string"
          || Date.parse(connection.validation.expiresAt) > readinessNow
        )
      ))
    : [];

  const hasSkillDraft = Boolean(skillDraftLifecycle?.createSkill || store?.createSkill || hasSkillUpload);
  const draftSkill = hasSkillDraft
    ? ready("A private Skill Draft can be created.")
    : unavailable(
        "skill_upload_service_unavailable",
        "Private Skill Draft storage is not configured.",
        "/skills/new",
      );
  const promptTest = hasPromptTestBackend && selectableBuilderModels.length > 0
    ? ready("Prompt Skill testing is ready.")
    : needsSetup(
        hasPromptTestBackend ? "model_route_unresolved" : "skill_test_backend_unavailable",
        hasPromptTestBackend
          ? "Configure a selectable chat model before testing this Prompt Skill."
          : "The governed Prompt Skill test backend is unavailable.",
        "/library?setup=models",
        "contact_admin",
      );
  const scriptTest = readyRuntimes.length > 0
    ? ready("At least one isolated Script runtime is configured.")
    : needsSetup(
        configuredRuntimes.length > 0 ? "skill_runtime_probe_unavailable" : "skill_runtime_unavailable",
        configuredRuntimes.length > 0
          ? "The configured Script runtime could not be verified against the local Docker daemon and pinned image. You may still save a Draft."
          : "No isolated Script runtime is configured. You may still save a Draft.",
        "/skills/new?mode=define&setup=runtime",
        "contact_admin",
      );
  const registeredToolImport = toolPackages.length > 0
    ? ready("Registered Tool packages are available.")
    : unavailable(
        "registered_tool_catalog_empty",
        "No registered Tool packages are available.",
        "/skills/new?mode=tool",
      );
  const connectionDecision = !productionConnection
    ? unavailable(
        "connection_driver_unavailable",
        "No production Connection driver is registered.",
        "/library?setup=connections",
      )
    : connectionBindingReady
      ? ready("A governed credential binding and probe flow is available.")
      : needsSetup(
          productionConnection.bindingAvailable
            ? "connection_probe_unavailable"
            : "connection_credential_binding_unavailable",
          productionConnection.bindingAvailable
            ? "The Connection driver cannot perform a real account probe."
            : "A governed credential binding service is not configured.",
          "/library?setup=connections",
          "contact_admin",
        );
  const connectedToolDecision = connectionDecision.status !== "ready"
    ? connectionDecision
    : workspaceConnections === null
      ? checking(
          "connection_instances_checking",
          "Connection instances could not be checked. Retry before testing or running this Tool Skill.",
          "/library?setup=connections",
        )
      : readyProductionConnections.length > 0
        ? ready("At least one governed production Connection is bound, probed, and valid.")
        : needsSetup(
            "connection_instance_required",
            "Bind and validate a production Connection before testing or running this Tool Skill.",
            "/library?setup=connections",
          );
  const resourceDecision = textResourceService?.create
    ? ready("Reusable workspace text material can be created.")
    : unavailable(
        "resource_service_unavailable",
        "Reusable workspace material storage is not configured.",
        "/library?setup=resources",
      );
  const resourceFileDecision = (
    textResourceService?.createFromAttachment
    && inputAttachmentService?.create
    && inputAttachmentService?.resolveMaterialBindings
  )
    ? ready("Governed files can be uploaded and promoted to reusable workspace material.")
    : unavailable(
        "resource_file_import_unavailable",
        "Governed file upload and promotion are not configured for workspace material.",
        "/library?setup=resources",
      );
  const proposalDecision = !agentContainerProbe.available
    ? unavailable(
        "agent_container_backend_unavailable",
        "The isolated Loop proposal worker is unavailable.",
        "/loops/new?mode=document",
      )
    : !agentContainerProbe.verified
      ? checking(
          "agent_container_backend_checking",
          "The isolated Loop proposal worker is registered but has not been runtime-verified.",
          "/loops/new?mode=document",
        )
    : selectableBuilderModels.length === 0
      ? needsSetup(
          "model_route_unresolved",
          "Configure a selectable Loop design model before generating a proposal.",
          "/library?setup=models",
          "contact_admin",
        )
      : ready("Staged Loop proposals can be generated.");
  return {
    data: {
      schemaVersion: "workbench-v1",
      workspaceId: context.workspaceId,
      workspaceRole: role,
      evaluatedAt: typeof clock === "function" ? String(clock()) : new Date().toISOString(),
      actions: {
        promptSkill: action("promptSkill", {
          draftable: writeGate(role, draftSkill),
          testable: writeGate(role, promptTest),
          runnable: writeGate(role, promptTest),
        }),
        scriptSkill: action("scriptSkill", {
          draftable: writeGate(role, knownRuntimes.length > 0
            ? draftSkill
            : unavailable("skill_runtime_catalog_empty", "No governed Script runtime is defined.", "/skills/new")),
          testable: writeGate(role, scriptTest),
          runnable: writeGate(role, scriptTest),
        }),
        registeredToolSkill: action("registeredToolSkill", {
          importable: writeGate(role, registeredToolImport),
          testable: writeGate(role, connectedToolDecision),
          runnable: writeGate(role, connectedToolDecision),
        }),
        skillDirectoryImport: action("skillDirectoryImport", {
          importable: writeGate(role, hasSkillUpload
            ? ready("A desktop directory can be inspected and imported.")
            : unavailable("skill_upload_service_unavailable", "Skill import storage is unavailable.", "/skills/new")),
        }),
        skillZipImport: action("skillZipImport", {
          importable: writeGate(role, hasSkillUpload
            ? ready("A desktop ZIP can be inspected and imported.")
            : unavailable("skill_upload_service_unavailable", "Skill import storage is unavailable.", "/skills/new")),
        }),
        publicGithubSkillImport: action("publicGithubSkillImport", {
          importable: writeGate(role, skillUploadService?.importRepository
            ? ready("Public GitHub Skill import is available; remote liveness is checked on submit.")
            : unavailable("github_import_unavailable", "Public GitHub import is not configured.", "/skills/new")),
        }),
        serverSkillImport: action("serverSkillImport", {
          importable: serverImportAllowed
            ? ready("Administrator server-path import is available.")
            : canWrite && role !== "owner"
              ? forbidden("Only a workspace owner with an administrator account can import server paths.")
              : unavailable("server_skill_import_unavailable", "Administrator server-path import is unavailable.", "/skills/new"),
        }),
        blankLoop: action("blankLoop", {
          draftable: writeGate(role, typeof loopDraftLifecycle?.createLoop === "function" || typeof store?.createLoop === "function"
            ? ready("A private blank Loop Draft can be created.")
            : unavailable("loop_creation_unavailable", "Loop Draft storage is unavailable.", "/loops")),
        }),
        stagedLoopProposal: action("stagedLoopProposal", {
          draftable: writeGate(role, proposalDecision),
        }),
        connectionSetup: action("connectionSetup", {
          runnable: writeGate(role, connectionDecision),
        }),
        workspaceResource: action("workspaceResource", {
          draftable: writeGate(role, resourceDecision),
          importable: writeGate(role, resourceFileDecision),
        }),
      },
      support: {
        readyRuntimeIds: readyRuntimes,
        registeredToolPackageCount: toolPackages.length,
        selectableBuilderModelCount: selectableBuilderModels.length,
        readyAttachmentMediaTypes: [...(attachmentCapabilities.readyMediaTypes ?? [])].sort(),
        unavailableAttachmentMediaTypes: [...(attachmentCapabilities.unavailableMediaTypes ?? [])].sort(),
      },
    },
    responseHeaders: { "Cache-Control": "private, no-store" },
  };
}
