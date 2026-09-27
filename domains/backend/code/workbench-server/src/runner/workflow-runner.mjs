import { Check } from "@looloomi/workbench-contracts";

import { RunEventHub } from "./run-event-hub.mjs";
import { createRunLeaseCoordinator } from "./run-lease-coordinator.mjs";
import { assertWorkflowRunPersistence } from "./workflow-run-persistence.mjs";
import {
  connectionApprovalSnapshot,
  connectionApprovalSnapshotsMatch,
  isCompleteConnectionApprovalSnapshot,
} from "../connections/workspace-connection-service.mjs";
import { projectPublishedSkillVersion } from "../skills/published-skill-definition.mjs";
import { normalizeAcceptedMaterialMediaTypes } from "../attachments/material-media-types.mjs";
import { canonicalRequestHash } from "../store/serialization.mjs";
import {
  RUN_STATE_MODEL_VERSION,
  createInitialRunStateEvent,
  createLegacyImportEvent,
  createRunStateTransitionEvent,
  foldRunStateEvents,
  lifecycleStateFromRun,
  runProjectionMatchesFold,
  sourceHashForLegacyRun,
} from "./run-state-events.mjs";

const WORKBENCH_SCHEMA_VERSION = "workbench-v1";
const RUN_EVENT_SCHEMA_VERSION = "workbench-run-event-v1";
const TERMINAL = new Set(["completed", "failed", "cancelled", "partial", "effect_outcome_unknown"]);

const DEFAULT_EXECUTION_CAPABILITIES = Object.freeze({
  toolAllowlist: [],
  connectionIds: [],
  network: false,
  filesystem: "none",
  externalActions: false,
});

const ZERO_MODEL_CALL_CAPABILITIES = DEFAULT_EXECUTION_CAPABILITIES;

function connectionRequirementIdsForPlan(plan) {
  return [...new Set(
    (plan?.steps ?? [])
      .flatMap((step) => step?.capabilities?.connectionIds ?? [])
      .filter((requirementId) => typeof requirementId === "string" && requirementId.length > 0),
  )].sort();
}

function defaultExecutionLimits(node, mode) {
  const agentic = ["bounded_agent", "agent_orchestrator"].includes(mode);
  return {
    timeoutMs: node.timeoutSeconds * 1000,
    maxSteps: mode === "model_call" ? 1 : agentic ? 32 : 1,
    maxModelRequests: mode === "model_call" ? 1 : agentic ? 16 : 0,
    maxChildren: mode === "agent_orchestrator" ? 4 : 0,
    ...(agentic ? {
      maxDepth: mode === "agent_orchestrator" ? 2 : 0,
      maxSpawnedChildren: mode === "agent_orchestrator" ? 100 : 0,
      maxToolResultChars: 320_000,
    } : {}),
    maxInputBytes: 1_000_000,
    maxOutputBytes: 1_000_000,
    maxImageCount: 0,
    maxCostUsdMicros: 0,
  };
}

function modelMetadataForStep(step) {
  if (step.modelRoutingState === "pinned") {
    return {
      modelProfileRevisionId: step.modelProfileRevisionId,
      modelCapability: step.modelCapability,
      fallbackModelProfileRevisionIds: structuredClone(
        step.fallbackModelProfileRevisionIds ?? [],
      ),
    };
  }
  if (step.modelRoutingState === "legacy_unpinned") {
    return {
      modelRoutingState: "legacy_unpinned",
      ...(step.legacyModelProfileId ? { legacyModelProfileId: step.legacyModelProfileId } : {}),
      ...(step.legacyFallbackModelProfileIds ? {
        legacyFallbackModelProfileIds: structuredClone(step.legacyFallbackModelProfileIds),
      } : {}),
    };
  }
  return {};
}

function executionRequestFor({ run, node, step, skill, attempt, input, lease, effectRecovery = null }) {
  const mode = step.executionMode ?? (
    skill.executionRef?.executionMode === "orchestrator"
      ? "agent_orchestrator"
      : skill.executionRef?.executionMode === "agent"
        ? "bounded_agent"
        : skill.executionRef?.executionMode === "model"
          ? "model_call"
        : "deterministic_skill"
  );
  if (step.modelRoutingState === "legacy_unpinned") {
    throw new WorkflowRunnerError(
      "workflow_model_route_legacy_unpinned",
      "This historical Workflow model route is read-only and must be recompiled before execution.",
      { nodeId: node.nodeId },
    );
  }
  const agentic = ["bounded_agent", "agent_orchestrator"].includes(mode);
  const modelCall = mode === "model_call";
  const materialBindings = materialBindingsForStep({ run, node, skill });
  const materialRequirements = materialRequirementsForStep({ skill });
  const capabilities = executionCapabilitiesForStep({
    run,
    node,
    step,
    modelCall,
  });
  const lineage = { productCommandId: run.creationCommandId };
  // PostgreSQL B3 Workflow Runs are controller roots, not synthetic Agent
  // Turns. The legacy Mongo command shape remains unchanged until G4.
  if (run.commandLineage !== "workflow_run_canonical") {
    lineage.sessionId = run.runId;
    lineage.turnId = run.runId;
  }
  const request = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: attempt.invocationId,
    attemptId: attempt.nodeRunId,
    workspaceId: runWorkspaceId(run),
    actor: { userId: runRequestedBy(run) },
    lineage,
    controller: {
      kind: "workflow_run",
      controllerId: run.runId,
      fence: lease.fence,
    },
    mode,
    isolation: step.isolation ?? (agentic ? "container" : "process"),
    goal: String(node.description || node.title || `Execute ${node.nodeId}`).slice(0, 8000),
    input: structuredClone(input),
    limits: structuredClone(step.limits ?? defaultExecutionLimits(node, mode)),
    capabilities,
    resultSchema: structuredClone(step.resultSchema ?? skill.definition.outputSchema),
    evidenceRequirements: structuredClone(step.evidenceRequirements ?? [{
      requirementId: `output:${node.nodeId}`,
      kind: "output",
      required: true,
      description: `Return a contract-valid result for ${node.title}.`,
    }]),
    metadata: {
      executionRef: structuredClone(skill.executionRef),
      outerNodeId: node.nodeId,
      skillName: skill.definition.name,
      ...(mode === "agent_orchestrator" ? {
        orchestrationDepth: 1,
        allowedChildren: Array.isArray(skill.executionRef?.allowedChildren)
          ? [...skill.executionRef.allowedChildren]
          : [],
      } : {}),
      requestedBy: runRequestedBy(run),
      connectionSnapshots: structuredClone(
        (run.executionSnapshot.connectionBindings ?? [])
          .filter((binding) => capabilities.connectionIds.includes(binding.connectionId)),
      ),
      materialBindings,
      materialRequirements,
      externalActionConfirmed: externalActionConfirmed(run, step),
      ...(effectRecovery ? { effectRecovery: structuredClone(effectRecovery) } : {}),
      ...modelMetadataForStep(step),
    },
  };
  if (modelCall) {
    if (step.modelRoutingState !== "pinned") {
      throw new WorkflowRunnerError("workflow_model_route_unpinned", "The model-backed step has no pinned revision.", {
        nodeId: node.nodeId,
      });
    }
    request.isolation = "process";
    request.modelProfileRevisionId = step.modelProfileRevisionId;
    request.modelCapability = step.modelCapability;
    request.fallbackModelProfileRevisionIds = structuredClone(
      step.fallbackModelProfileRevisionIds ?? [],
    );
  }
  return request;
}

function reviewExecutionRequestFor({ run, node, attempt, input, lease }) {
  const lineage = { productCommandId: run.creationCommandId };
  if (run.commandLineage !== "workflow_run_canonical") {
    lineage.sessionId = run.runId;
    lineage.turnId = run.runId;
  }
  return {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: attempt.invocationId,
    attemptId: attempt.nodeRunId,
    workspaceId: runWorkspaceId(run),
    actor: { userId: runRequestedBy(run) },
    lineage,
    controller: {
      kind: "workflow_run",
      controllerId: run.runId,
      fence: lease.fence,
    },
    mode: "deterministic_skill",
    isolation: "process",
    goal: String(node.description || node.title || "Hold for Product review.").slice(0, 8000),
    input: structuredClone(input),
    limits: defaultExecutionLimits(node, "deterministic_skill"),
    capabilities: structuredClone(DEFAULT_EXECUTION_CAPABILITIES),
    resultSchema: { type: "object", additionalProperties: true },
    evidenceRequirements: [],
    metadata: {
      executionRef: {
        capabilityId: "workflow-review-gate",
        taskIntent: "hold-for-review",
        adapterVersion: "1",
      },
      outerNodeId: node.nodeId,
      requestedBy: runRequestedBy(run),
      connectionSnapshots: [],
      materialBindings: [],
      materialRequirements: [],
      externalActionConfirmed: false,
    },
  };
}

function executionCapabilitiesForStep({ run, node, step, modelCall }) {
  if (modelCall) return structuredClone(ZERO_MODEL_CALL_CAPABILITIES);
  const compiled = structuredClone(step.capabilities ?? DEFAULT_EXECUTION_CAPABILITIES);
  const bindings = new Map(
    (run.executionSnapshot.connectionBindings ?? [])
      .map((binding) => [binding?.requirementId, binding?.connectionId]),
  );
  compiled.connectionIds = [...new Set((compiled.connectionIds ?? []).map((requirementId) => {
    const connectionId = bindings.get(requirementId);
    if (typeof connectionId !== "string" || connectionId.length === 0) {
      throw new WorkflowRunnerError(
        "connection_rebind_required",
        "A required Connection is not present in the immutable Run snapshot.",
        { nodeId: node.nodeId, requirementId },
      );
    }
    return connectionId;
  }))].sort();
  return compiled;
}

function materialBindingsForStep({ run, node, skill }) {
  const schema = skill?.definition?.inputSchema;
  const properties = schema?.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const materialKeys = Object.entries(properties)
    .filter(([, definition]) => definition?.format === "attachment")
    .map(([key]) => key);
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((key) => materialKeys.includes(key))
      : [],
  );
  const bindings = (run.skillMaterialBindings ?? [])
    .filter((item) => item.nodeId === node.nodeId)
    .map((item) => structuredClone(item.binding));
  const seen = new Set();
  for (const binding of bindings) {
    if (!materialKeys.includes(binding?.materialKey) || seen.has(binding.materialKey)) {
      throw new WorkflowRunnerError(
        "run_material_bindings_invalid",
        "The Run contains an unknown or duplicate Skill material binding.",
        { nodeId: node.nodeId, materialKey: binding?.materialKey ?? null },
      );
    }
    seen.add(binding.materialKey);
  }
  const missing = [...required].filter((materialKey) => !seen.has(materialKey));
  if (missing.length > 0) {
    throw new WorkflowRunnerError(
      "run_material_bindings_required",
      "Resolve every required Skill material before starting the Run.",
      { nodeId: node.nodeId, materialKeys: missing },
    );
  }
  return bindings;
}

function materialRequirementsForStep({ skill }) {
  const properties = skill?.definition?.inputSchema?.properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties)
    .filter(([, definition]) => definition?.format === "attachment")
    .map(([materialKey, definition]) => ({
      materialKey,
      acceptedMediaTypes: normalizeAcceptedMaterialMediaTypes(
        definition.acceptedMediaTypes,
      ),
    }));
}

function externalActionConfirmed(run, step) {
  if (step.capabilities?.externalActions !== true) return false;
  const reviewNodes = new Set(
    (run.executionSnapshot?.graph?.nodes ?? [])
      .filter((node) => node.kind === "ReviewGate")
      .map((node) => node.nodeId),
  );
  return (step.dependsOn ?? []).some((nodeId) => (
    reviewNodes.has(nodeId)
    && (run.nodeRuns ?? []).some((attempt) => attempt.nodeId === nodeId && attempt.status === "completed")
  ));
}

function runMayHaveExternalActions(run) {
  return (run.executionSnapshot?.plan?.steps ?? [])
    .some((step) => step?.capabilities?.externalActions === true);
}

function executionResultModelProjection(result, step) {
  if (step.modelRoutingState !== "pinned") return {};
  const requestedModelRevisionId = result?.requestedModelRevisionId
    ?? step.modelProfileRevisionId;
  const actualModelRevisionId = result?.actualModelRevisionId ?? null;
  const artifactRefs = Array.isArray(result?.artifactRefs)
    ? structuredClone(result.artifactRefs)
    : [];
  return {
    requestedModelRevisionId,
    actualModelRevisionId,
    artifactRefs,
    fallbackUsed: actualModelRevisionId !== null
      && actualModelRevisionId !== requestedModelRevisionId,
  };
}

export class WorkflowRunnerError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "WorkflowRunnerError";
    this.code = code;
    this.details = details;
  }
}

export function createWorkflowRunner(options) {
  return new WorkflowRunner(options);
}

export class WorkflowRunner {
  #store;
  #commandIntake;
  #reviewCommandIntake;
  #cancellationCommandIntake;
  #resolveExecution;
  #resolveResourceText;
  #agentRuntime;
  #executionBroker;
  #clock;
  #idFactory;
  #hub = new RunEventHub();
  #jobs = new Map();
  #abortControllers = new Map();
  #scheduleOnStart;
  #workerId;
  #leaseDurationMs;
  #leaseTimers = new Map();
  #activeLeases = new Map();
  #faultInjector;
  #leaseCoordinator;
  #runControl;
  #runPersistence;
  #resolveConnectionApproval;

  constructor({
    store,
    commandIntake,
    reviewCommandIntake = null,
    cancellationCommandIntake = null,
    resolveExecution,
    resolveResourceText = null,
    agentRuntime,
    executionBroker = null,
    clock = () => new Date().toISOString(),
    idFactory,
    scheduleOnStart = true,
    workerId = `worker-${process.pid}`,
    leaseDurationMs = 30000,
    faultInjector = async () => {},
    runControl = null,
    runPersistence = null,
    resolveConnectionApproval = null,
  } = {}) {
    if (
      !store
      || typeof store.withTransaction !== "function"
    ) {
      throw new TypeError("workflow_runner_store_invalid");
    }
    for (const method of ["accept", "start", "requestCancellation", "settle", "recover"]) {
      if (typeof commandIntake?.[method] !== "function") {
        throw new TypeError("workflow_runner_command_intake_required");
      }
    }
    if (reviewCommandIntake !== null && typeof reviewCommandIntake?.accept !== "function") {
      throw new TypeError("workflow_runner_review_command_intake_invalid");
    }
    if (cancellationCommandIntake !== null && typeof cancellationCommandIntake?.accept !== "function") {
      throw new TypeError("workflow_runner_cancellation_command_intake_invalid");
    }
    if (typeof resolveExecution !== "function") throw new TypeError("workflow_runner_resolve_execution_required");
    if (resolveResourceText !== null && typeof resolveResourceText !== "function") {
      throw new TypeError("workflow_runner_resource_resolver_invalid");
    }
    if (typeof agentRuntime?.buildAuthoritativeFinal !== "function") {
      throw new TypeError("workflow_runner_agent_runtime_invalid");
    }
    if (executionBroker !== null && typeof executionBroker?.execute !== "function") {
      throw new TypeError("workflow_runner_execution_broker_invalid");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("workflow_runner_clock_and_id_factory_required");
    }
    if (typeof scheduleOnStart !== "boolean") throw new TypeError("workflow_runner_schedule_option_invalid");
    requiredId(workerId, "workflow_runner_worker_id_invalid");
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1000) {
      throw new TypeError("workflow_runner_lease_duration_invalid");
    }
    if (typeof faultInjector !== "function") throw new TypeError("workflow_runner_fault_injector_invalid");
    if (resolveConnectionApproval !== null && typeof resolveConnectionApproval !== "function") {
      throw new TypeError("workflow_runner_connection_approval_resolver_invalid");
    }
    this.#store = store;
    this.#commandIntake = commandIntake;
    this.#reviewCommandIntake = reviewCommandIntake;
    this.#cancellationCommandIntake = cancellationCommandIntake;
    this.#resolveExecution = resolveExecution;
    this.#resolveResourceText = resolveResourceText;
    this.#agentRuntime = agentRuntime;
    this.#executionBroker = executionBroker;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#scheduleOnStart = scheduleOnStart;
    this.#workerId = workerId;
    this.#leaseDurationMs = leaseDurationMs;
    this.#faultInjector = faultInjector;
    // Run jobs and leases have one explicit owner. Production injects the
    // PostgreSQL B3 adapter; unit tests inject their own complete port.
    if (!runControl) throw new TypeError("workflow_run_control_required");
    this.#runControl = runControl;
    this.#leaseCoordinator = createRunLeaseCoordinator({
      runControl: this.#runControl,
      workerId,
      clock: () => this.#now(),
      leaseDurationMs,
    });
    if (!runPersistence) throw new TypeError("workflow_run_persistence_required");
    this.#runPersistence = assertWorkflowRunPersistence(runPersistence);
    this.#resolveConnectionApproval = resolveConnectionApproval;
  }

  async startRun({
    workflowId,
    workflowRevisionId,
    inputs,
    resourceRefs,
    materialBindings = [],
    idempotencyKey,
    requestId,
    requestedBy = "system",
    authorizationDecisionId = null,
    commandAuthority = null,
  }) {
    requiredId(workflowId, "workflow_id_required");
    requiredId(workflowRevisionId, "workflow_revision_id_required");
    requiredId(idempotencyKey, "idempotency_key_required");
    const execution = await this.#execution(workflowId, workflowRevisionId);
    const result = await this.#createRun({
      workflowId,
      workflowRevisionId,
      inputs,
      resourceRefs,
      materialBindings,
      idempotencyKey,
      requestId,
      requestedBy,
      authorizationDecisionId,
      commandAuthority,
      execution,
    });
    return this.#publicRun(result.run.runId);
  }

  async startRunWithCompanion({
    workflowId,
    workflowRevisionId,
    inputs,
    resourceRefs,
    materialBindings = [],
    idempotencyKey,
    requestId,
    requestedBy = "system",
    authorizationDecisionId = null,
    commandAuthority = null,
    automationRevisionId = null,
  }, { kind, persist } = {}) {
    requiredId(workflowId, "workflow_id_required");
    requiredId(workflowRevisionId, "workflow_revision_id_required");
    requiredId(idempotencyKey, "idempotency_key_required");
    requiredId(kind, "run_companion_kind_required");
    if (typeof persist !== "function") {
      throw new TypeError("run_companion_persist_required");
    }
    const execution = await this.#execution(workflowId, workflowRevisionId, {
      ...(automationRevisionId === null ? {} : { automationRevisionId }),
    });
    const result = await this.#createRun({
      workflowId,
      workflowRevisionId,
      inputs,
      resourceRefs,
      materialBindings,
      idempotencyKey,
      requestId,
      requestedBy,
      authorizationDecisionId,
      commandAuthority,
      execution,
      companion: { kind, persist },
    });
    return { run: await this.#publicRun(result.run.runId), companion: result.companion };
  }

  async #createRun({
    workflowId,
    workflowRevisionId,
    inputs,
    resourceRefs,
    materialBindings = [],
    idempotencyKey,
    requestId,
    requestedBy = "system",
    authorizationDecisionId = null,
    commandAuthority = null,
    execution,
    retryOf = null,
    retryCommand = null,
    companion = null,
  }) {
    const governedCommandAuthority = normalizeCommandAuthority(commandAuthority);
    // requestId is tracing metadata and changes on a legitimate HTTP retry.
    // It must never participate in the idempotency fingerprint.
    const request = {
      workflowId,
      workflowRevisionId,
      inputs,
      resourceRefs,
      materialBindings,
      requestedBy,
      retryOf,
      ...(retryCommand ? { retryCommand } : {}),
      ...(companion ? { companionKind: companion.kind } : {}),
    };
    const result = await this.#runPersistence.runIdempotently(
      {
        scope: companion
          ? `start-run-with-${companion.kind}:${workflowId}`
          : retryOf
            ? `retry-run:${retryOf}`
            : `start-run:${workflowId}`,
        key: idempotencyKey,
        request,
        workspaceId: execution.workspaceId,
        effectivePrincipalId: requestedBy,
        ...(governedCommandAuthority
          ? { effectivePrincipalId: governedCommandAuthority.effectivePrincipalId }
          : {}),
      },
      async (session) => {
        const now = this.#now();
        const runId = this.#idFactory("run");
        const executionSnapshot = this.#executionSnapshot({ runId, execution, plan: execution.plan, now });
        await this.#assertConnectionApprovalsCurrent(executionSnapshot, {
          runId,
          workspaceId: execution.workspaceId,
          session,
          stage: "run_creation",
        });
        const run = {
          schemaVersion: WORKBENCH_SCHEMA_VERSION,
          runId,
          workspaceId: execution.workspaceId,
          requestedBy,
          workflowId,
          workflowRevisionId,
          scopeId: execution.scopeId ?? null,
          workflowRevisionContentHash: execution.workflowRevisionContentHash ?? null,
          compileResultId: execution.compileResultId ?? null,
          executionPlanId: execution.executionPlanId ?? null,
          authorizationDecisionId,
          inputs: cloneObject(inputs, "run_inputs_invalid"),
          resourceRefs: cloneArray(resourceRefs, "run_resource_refs_invalid"),
          skillMaterialBindings: cloneArray(materialBindings, "run_material_bindings_invalid"),
          executionPlanVersion: execution.plan.schemaVersion,
          executionPlanContentHash: execution.plan.contentHash,
          status: "queued",
          currentNodeId: null,
          idempotencyKey,
          nodeRuns: [],
          reviewDecisions: [],
          authoritativeReadModel: { available: false, version: 0 },
          queuedAt: now,
          startedAt: null,
          finishedAt: null,
          createdAt: now,
          updatedAt: now,
          stateModelVersion: RUN_STATE_MODEL_VERSION,
          stateEventSequence: 1,
          creationCommandId: this.#idFactory("run-state-command"),
          executionPlanSnapshot: structuredClone(execution.plan),
          executionSnapshot,
          ...(retryOf ? { retryOf } : {}),
          ...(retryCommand ? { retryCommand: structuredClone(retryCommand) } : {}),
        };
        if (!run.workspaceId) {
          throw new WorkflowRunnerError("run_workspace_missing", "Run workspace is unavailable.", { runId });
        }
        const intake = await this.#commandIntake.accept({
          principal: this.#commandPrincipal(run),
          command: {
            schemaVersion: WORKBENCH_SCHEMA_VERSION,
            commandId: run.creationCommandId,
            kind: "workflow_run",
            sessionId: runId,
            turnId: runId,
            ...(run.scopeId ? { scopeId: run.scopeId } : {}),
            ...(run.scopeId ? {
              targetKind: "workflow_run",
              targetId: runId,
              targetRevision: 1,
            } : {}),
            ...(run.authorizationDecisionId ? {
              authorizationDecisionId: run.authorizationDecisionId,
              argumentDigest: canonicalRequestHash(request),
            } : {}),
            ...(governedCommandAuthority ?? {}),
          },
          at: now,
          session,
          persistTarget: async ({ session: transactionSession }) => {
            let persistedCompanion = null;
            if (companion) {
              persistedCompanion = await companion.persist({
                run: structuredClone(run),
                transactionSession,
              });
            }
            // PostgreSQL records retry lineage in the new immutable Run root
            // and its already-authorized Product Command. Do not reach the
            // retired repository-only `runCommands` owner from this control
            // path; the legacy fixture retains its local audit log only for
            // non-PostgreSQL unit coverage.
            if (retryCommand && this.#store?.persistenceDriver !== "postgres") {
              const retrySource = await this.#internalRun(retryOf, { session: transactionSession });
              if (!retrySource) {
                throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId: retryOf });
              }
              if (!["failed", "cancelled"].includes(retrySource.status)) {
                throw new WorkflowRunnerError(
                  "run_retry_not_allowed",
                  "Only failed or cancelled Runs can be retried.",
                  { runId: retryOf },
                );
              }
              await this.#recordCommand({
                runId: retryOf,
                workspaceId: runWorkspaceId(retrySource),
                command: "retry",
                requestedBy: retryCommand.requestedBy,
                session: transactionSession,
              });
            }
            const runJobId = this.#idFactory("run-job");
            const initialStateEvent = createInitialRunStateEvent({
              run,
              eventId: this.#idFactory("run-state-event"),
              commandId: run.creationCommandId,
              occurredAt: now,
            });
            run.stateHash = initialStateEvent.stateHash;
            const aggregate = await this.#runPersistence.createAcceptedAggregate({
              run,
              runJobId,
              initialStateEvent,
              executionPlan: execution.plan,
              executionSnapshot,
              eventTemplate: {
                schemaVersion: RUN_EVENT_SCHEMA_VERSION,
                eventId: this.#idFactory("event"),
                type: "run.queued", status: "queued", summary: "Run queued.", occurredAt: now,
              },
              uow: transactionSession,
            });
            return {
              run: aggregate.run,
              event: aggregate.event,
              ...(companion ? { companion: persistedCompanion } : {}),
            };
          },
        });
        return intake.target;
      },
    );
    this.#hub.publish(result.event);
    if (this.#scheduleOnStart) this.#schedule(result.run.runId, execution);
    return result;
  }

  async recover() {
    const aggregates = await this.#runPersistence.loadRecoverableAggregates({ now: this.#now() });
    const candidates = [];
    // PostgreSQL B3 already owns its Run lifecycle through
    // `workflow_run_events` and its explicit persistence/control ports. Its
    // native state version is intentionally not the legacy Mongo V2 event
    // model, so treating it as an import candidate would reach the retired
    // repository facade (`store.repositories.runJobs`) instead of failing
    // through the selected PostgreSQL owner.
    const postgresEventLedger = this.#store?.persistenceDriver === "postgres";
    for (const aggregate of aggregates) {
      let run = aggregate.run;
      if (!postgresEventLedger
        && run.stateModelVersion !== RUN_STATE_MODEL_VERSION
        && !TERMINAL.has(run.status)) {
        run = await this.#importLegacyActiveRun(run.runId);
      }
      if (!postgresEventLedger && run.stateModelVersion === RUN_STATE_MODEL_VERSION) {
        run = await this.#reconcileRunStateProjection(run.runId);
      }
      if (run.status === "cancellation_requested") {
        if (postgresEventLedger) {
          candidates.push({ kind: "cancellation", runId: run.runId });
          continue;
        }
        const settled = await this.#recoverRequestedCancellation(run);
        if (settled.event) this.#hub.publish(settled.event);
        run = await this.#internalRun(run.runId);
      }
      if (["queued", "running"].includes(run.status)) {
        const execution = await this.#executionForRun(run);
        candidates.push({ kind: "run", runId: run.runId, execution });
      } else if (run.status === "paused") {
        const decision = aggregate.latestDecision;
        if (decision) candidates.push({ kind: "review", runId: run.runId, decision });
      } else if (TERMINAL.has(run.status)) {
        candidates.push({ kind: "terminal", runId: run.runId });
      }
    }
    const recoveredRunIds = (await Promise.all(candidates.map(async (candidate) => (
      await (candidate.kind === "review"
        ? this.#scheduleReview(candidate.decision, { requeue: false })
        : candidate.kind === "terminal"
          ? this.#scheduleTerminal(candidate.runId)
          : candidate.kind === "cancellation"
            ? this.#scheduleCancellation(candidate.runId)
          : this.#schedule(candidate.runId, candidate.execution)) ? candidate.runId : null
    )))).filter(Boolean);
    return { recoveredRunIds };
  }

  async getRun(runId) {
    const run = await this.#publicRun(runId);
    if (!run) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
    const readModel = await this.#runPersistence.readReadModel(runId);
    return { run, readModel };
  }

  async getRunAt(runId, snapshotAt) {
    requiredId(runId, "run_id_required");
    if (typeof snapshotAt !== "string" || !Number.isFinite(Date.parse(snapshotAt))) {
      throw new WorkflowRunnerError("run_snapshot_invalid", "The Run snapshot timestamp is invalid.", { runId });
    }
    const [publicRun, internalRun] = await Promise.all([
      this.#publicRun(runId),
      this.#internalRun(runId),
    ]);
    if (!publicRun || !internalRun) {
      throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
    }
    if (internalRun.stateModelVersion !== RUN_STATE_MODEL_VERSION) {
      if (Date.parse(internalRun.updatedAt) > Date.parse(snapshotAt)) {
        throw new WorkflowRunnerError(
          "run_snapshot_changed",
          "The legacy Run changed after this Session page began.",
          { runId },
        );
      }
      return { run: publicRun, readModel: null };
    }
    const events = await this.#runPersistence.listRunStateEvents(runId);
    if (events.some((event) => (
      event.sequence > 1 && event.occurredAt === snapshotAt
    ))) {
      throw new WorkflowRunnerError(
        "run_snapshot_changed",
        "The Run changed while this Session page snapshot was being established.",
        { runId },
      );
    }
    const snapshotEvents = events.filter((event) => (
      Date.parse(event.occurredAt) <= Date.parse(snapshotAt)
    ));
    if (snapshotEvents.length === 0) {
      throw new WorkflowRunnerError("run_snapshot_changed", "The Run did not exist at this Session snapshot.", { runId });
    }
    const folded = foldRunStateEvents(snapshotEvents, { expectedRunId: runId });
    return {
      run: { ...publicRun, ...folded.state },
      readModel: null,
    };
  }

  async listRuns(workflowId, query = {}) {
    requiredId(workflowId, "workflow_id_required");
    return this.#runPersistence.listRunsByWorkflow(workflowId, query);
  }

  async listRecentRuns(workspaceId, query = {}) {
    requiredId(workspaceId, "workspace_id_required");
    return this.#runPersistence.listRecentRuns(workspaceId, {
      ...query,
      limit: Math.min(query.limit || 3, 10),
    });
  }

  async cancelRun({
    runId,
    idempotencyKey,
    requestedBy,
    reason,
    authorizationDecisionId = null,
    authorizationScopeId = null,
    authorizationAction = null,
  } = {}) {
    requiredId(runId, "run_id_required");
    requiredId(idempotencyKey, "idempotency_key_required");
    requiredId(requestedBy, "run_command_requested_by_required");
    if (this.#cancellationCommandIntake) {
      return this.#cancelPostgresRun({
        runId,
        idempotencyKey,
        requestedBy,
        reason,
        authorizationDecisionId,
        authorizationScopeId,
        authorizationAction,
      });
    }
    const result = await this.#runPersistence.runIdempotently(
      {
        scope: `cancel-run:${runId}`,
        key: idempotencyKey,
        request: { runId, requestedBy, reason: reason ?? null },
        effectivePrincipalId: requestedBy,
      },
      async (session) => {
        const run = await this.#internalRun(runId, { session });
        if (!run) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
        const command = await this.#recordCommand({ runId, workspaceId: runWorkspaceId(run), command: "cancel", requestedBy, session });
        if (TERMINAL.has(run.status)) {
          return { command, immediate: true, run: await this.#publicRun(runId, { session }), event: null };
        }
        const nodeId = run.currentNodeId;
        const attempt = nodeId ? await this.#latestAttempt(runId, nodeId, { session }) : null;
        if (attempt?.status === "running" && attempt.invocationId) {
          const requested = await this.#requestRunCancellation(run, {
            session,
            commandId: command.runCommandId,
          });
          return {
            command,
            immediate: false,
            invocationId: attempt.invocationId,
            externalActions: this.#stepMayHaveExternalActions(run, nodeId),
            event: requested.event,
          };
        }
        const cancelled = await this.#cancelStoredRun(run, {
          session,
          reason,
          abortInvocation: false,
          commandId: command.runCommandId,
        });
        return { command, immediate: true, run: await this.#publicRun(runId, { session }), event: cancelled.event };
      },
    );
    if (result.event) this.#hub.publish(result.event);
    if (result.immediate) {
      this.#abortControllers.get(runId)?.abort(new WorkflowRunnerError("run_cancelled"));
      return result.run;
    }
    const settlement = await this.#cancelInvocationAndClassify({
      invocationId: result.invocationId,
      externalActions: result.externalActions,
      reason,
    });
    this.#abortControllers.get(runId)?.abort(new WorkflowRunnerError("run_cancelled"));
    const settled = await this.#settleRequestedCancellation(runId, settlement, {
      commandId: result.command.runCommandId,
    });
    if (settled.event) this.#hub.publish(settled.event);
    return settled.run;
  }

  async #cancelPostgresRun({
    runId,
    idempotencyKey,
    requestedBy,
    reason,
    authorizationDecisionId,
    authorizationScopeId,
    authorizationAction,
  }) {
    requiredId(authorizationDecisionId, "workflow_run_cancellation_authorization_required");
    requiredId(authorizationScopeId, "workflow_run_cancellation_scope_required");
    if (authorizationAction != null && authorizationAction !== "workflow_run_cancel") {
      throw new WorkflowRunnerError("workflow_run_cancellation_authorization_action_invalid");
    }
    const request = { runId, requestedBy, reason: reason ?? null };
    const result = await this.#runPersistence.runIdempotently(
      {
        scope: `cancel-run:${runId}`,
        key: idempotencyKey,
        request,
        effectivePrincipalId: requestedBy,
      },
      async (session) => {
        const run = await this.#internalRun(runId, { session });
        if (!run) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
        return this.#cancellationCommandIntake.accept({
          principal: { workspaceId: runWorkspaceId(run), userId: requestedBy },
          command: {
            commandId: this.#idFactory("cancellation-command"),
            workspaceId: runWorkspaceId(run),
            scopeId: authorizationScopeId,
            authorizationDecisionId,
            argumentDigest: canonicalRequestHash(request),
            runId,
            requestedBy,
            reason: reason ?? null,
          },
          uow: session,
        });
      },
    );
    if (result.event) this.#hub.publish(result.event);
    if (result.run.status !== "cancellation_requested") return result.run;

    // A cancellation written by another process remains durable but is not
    // locally settled. Its current worker (or a fenced recovery worker) owns
    // the Invocation and prevents late results from the prior fence.
    const lease = this.#activeLeases.get(runId);
    const current = await this.#internalRun(runId);
    const attempt = current?.currentNodeId
      ? await this.#latestAttempt(runId, current.currentNodeId)
      : null;
    if (!lease || !attempt?.invocationId) return result.run;

    const status = await this.#cancelInvocationAndClassify({
      invocationId: attempt.invocationId,
      externalActions: this.#stepMayHaveExternalActions(current, current.currentNodeId),
      reason,
    });
    this.#abortControllers.get(runId)?.abort(new WorkflowRunnerError("run_cancelled"));
    const settled = await this.#settleRequestedCancellation(runId, status, { lease });
    if (settled.event) this.#hub.publish(settled.event);
    return settled.run;
  }

  async retryRun({
    runId,
    idempotencyKey,
    requestedBy,
    reason,
    authorizationDecisionId = null,
  } = {}) {
    requiredId(runId, "run_id_required");
    requiredId(idempotencyKey, "idempotency_key_required");
    requiredId(requestedBy, "run_command_requested_by_required");
    const original = await this.#internalRun(runId);
    if (!original) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
    if (!new Set(["failed", "cancelled"]).has(original.status)) {
      throw new WorkflowRunnerError("run_retry_not_allowed", "Only failed or cancelled Runs can be retried.", { runId });
    }
    await this.#assertRetryEffectLineageSafe(original);
    const execution = await this.#executionForRun(original);
    const result = await this.#createRun({
      workflowId: original.workflowId,
      workflowRevisionId: original.workflowRevisionId,
      inputs: original.inputs,
      resourceRefs: original.resourceRefs,
      materialBindings: original.skillMaterialBindings ?? [],
      idempotencyKey,
      requestId: `retry:${runId}`,
      requestedBy,
      authorizationDecisionId,
      execution,
      retryOf: runId,
      retryCommand: { requestedBy, reason: reason ?? null },
    });
    return this.#publicRun(result.run.runId);
  }

  async #assertRetryEffectLineageSafe(original) {
    const workspaceId = runWorkspaceId(original);
    if (!workspaceId) {
      throw new WorkflowRunnerError("run_workspace_missing", "Run workspace is unavailable.", {
        runId: original.runId,
      });
    }
    const visited = new Set();
    let current = original;
    while (current && !visited.has(current.runId)) {
      visited.add(current.runId);
      const receipts = await this.#runPersistence.listEffectReceipts({
        workspaceId, controllerId: current.runId,
      });
      const unresolved = receipts.find((receipt) =>
        ["pending", "intent_recorded", "dispatching", "outcome_unknown"].includes(receipt.status));
      if (unresolved) {
        throw new WorkflowRunnerError(
          "run_retry_effect_outcome_unresolved",
          "Resolve the previous external effect before retrying this Run.",
          { runId: original.runId, sourceRunId: current.runId, effectId: unresolved.effectId },
        );
      }
      const applied = receipts.find((receipt) => receipt.status === "succeeded");
      if (applied) {
        throw new WorkflowRunnerError(
          "run_retry_external_effect_already_applied",
          "This Run already applied an external effect and cannot be replayed as a new Run.",
          { runId: original.runId, sourceRunId: current.runId, effectId: applied.effectId },
        );
      }
      current = current.retryOf
        ? await this.#internalRun(current.retryOf)
        : null;
    }
    if (current) {
      throw new WorkflowRunnerError("run_retry_lineage_invalid", "The Run retry lineage contains a cycle.", {
        runId: original.runId,
      });
    }
  }

  async submitReviewDecision({
    runId,
    nodeId,
    expectedNodeRunId,
    decision,
    comment,
    requestedChanges = [],
    idempotencyKey,
    decidedBy,
    authorizationDecisionId = null,
    authorizationAction = null,
  }) {
    requiredId(runId, "run_id_required");
    requiredId(nodeId, "node_id_required");
    requiredId(idempotencyKey, "idempotency_key_required");
    requiredId(decidedBy, "review_decided_by_required");
    if (!new Set(["approve", "revise", "reject"]).has(decision)) {
      throw new WorkflowRunnerError("review_decision_invalid");
    }
    if (!Array.isArray(requestedChanges) || requestedChanges.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new WorkflowRunnerError("review_requested_changes_invalid");
    }
    const request = { runId, nodeId, decision, comment, requestedChanges, decidedBy,
      ...(expectedNodeRunId === undefined ? {} : { expectedNodeRunId }) };
    const result = await this.#runPersistence.runIdempotently(
      {
        scope: `review-decision:${runId}`,
        key: idempotencyKey,
        request,
        effectivePrincipalId: decidedBy,
      },
      async (session) => {
        const run = await this.#internalRun(runId, { session });
        if (!run) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
        if (run.status !== "waiting_review" || run.currentNodeId !== nodeId) {
          throw new WorkflowRunnerError("review_not_waiting", "The Run is not waiting at this Review Gate.", { runId, nodeId });
        }
        if (expectedNodeRunId !== undefined && !this.#reviewCommandIntake) {
          const current = await this.#runPersistence.readPublicRun(runId, { uow: session });
          if (!current.nodeRuns.some(node => node.nodeRunId === expectedNodeRunId && node.nodeId === nodeId && node.status === "waiting_review")) {
            throw new WorkflowRunnerError("review_stale", "This review has changed. Read the current review before deciding.");
          }
        }
        if (decision === "revise") {
          if (!requestedChanges.some(value => value.trim())) throw new WorkflowRunnerError("review_changes_required");
          reviewRevisionTarget(await this.#executionForRun(run), { nodeId });
        }
        if (decision !== "reject") {
          await this.#assertConnectionApprovalsCurrent(run.executionSnapshot, {
            runId,
            workspaceId: runWorkspaceId(run),
            session,
            stage: "review_decision",
          });
        }
        const now = this.#now();
        if (this.#reviewCommandIntake) {
          requiredId(authorizationDecisionId, "workflow_run_review_authorization_required");
          if (authorizationAction != null
            && authorizationAction !== (decision === "reject" ? "workflow_run_cancel" : "workflow_run_review")) {
            throw new WorkflowRunnerError("workflow_run_review_authorization_action_invalid");
          }
          const principal = this.#commandPrincipal(run);
          return this.#reviewCommandIntake.accept({
            principal,
            command: {
              commandId: this.#idFactory("review-command"),
              workspaceId: principal.workspaceId,
              scopeId: run.scopeId,
              authorizationDecisionId,
              argumentDigest: canonicalRequestHash(request),
              runId,
              nodeId,
              ...(expectedNodeRunId === undefined ? {} : { expectedNodeRunId }),
              decision,
              comment,
              requestedChanges: structuredClone(requestedChanges),
              decidedBy,
            },
            uow: session,
          });
        }
        const record = {
          schemaVersion: WORKBENCH_SCHEMA_VERSION,
          decisionId: this.#idFactory("review"),
          runId,
          nodeId,
          decision,
          ...(comment === undefined ? {} : { comment }),
          requestedChanges: structuredClone(requestedChanges),
          decidedBy,
          decidedAt: now,
          idempotencyKey,
          applicationStatus: "pending",
          appliedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        const recorded = await this.#runPersistence.recordReviewDecisionAndRequeue({
          record,
          now,
          idFactory: this.#idFactory,
          syncCommandLifecycle: (current, runStatus, { at, uow }) => this.#syncProductCommandLifecycle(
            current,
            runStatus,
            { at, session: uow },
          ),
          eventTemplate: {
            schemaVersion: RUN_EVENT_SCHEMA_VERSION,
            eventId: this.#idFactory("event"),
            type: "run.paused",
            status: "paused",
            summary: "Review decision received.",
            nodeId,
            occurredAt: now,
          },
          uow: session,
        });
        if (!recorded) {
          throw new WorkflowRunnerError("review_requeue_conflict", "The review continuation could not be queued.", { runId, nodeId });
        }
        return recorded;
      },
    );
    this.#hub.publish(result.event);
    this.#scheduleReview(result.decision, { requeue: false });
    return { decision: result.decision, run: result.run };
  }

  async listEvents(runId, after = 0) {
    requiredId(runId, "run_id_required");
    if (!Number.isInteger(after) || after < 0) throw new WorkflowRunnerError("event_cursor_invalid");
    // Database maintenance/decision receipts are durable internal evidence, not
    // public progress. Preserve sequence gaps so reconnect cursors remain valid.
    return (await this.#runPersistence.listRunEvents(runId, after))
      .filter((event) => !["run.lease_renewed", "run.worker_recovered", "review.decided"].includes(event.type));
  }

  subscribe(runId, listener) {
    requiredId(runId, "run_id_required");
    return this.#hub.subscribe(runId, listener);
  }

  #schedule(runId, execution) {
    if (this.#jobs.has(runId)) return this.#jobs.get(runId);
    let job;
    job = Promise.resolve()
      .then(() => this.#executeLeased(runId, (lease) => this.#execute(runId, execution, lease)))
      .finally(() => {
        if (this.#jobs.get(runId) === job) this.#jobs.delete(runId);
      });
    this.#jobs.set(runId, job);
    return job;
  }

  #scheduleTerminal(runId) {
    if (this.#jobs.has(runId)) return this.#jobs.get(runId);
    let job;
    job = Promise.resolve()
      .then(() => this.#executeLeased(runId, (lease) => this.#reconcileTerminalRun(runId, lease)))
      .finally(() => {
        if (this.#jobs.get(runId) === job) this.#jobs.delete(runId);
      });
    this.#jobs.set(runId, job);
    return job;
  }

  #scheduleCancellation(runId) {
    if (this.#jobs.has(runId)) return this.#jobs.get(runId);
    let job;
    job = Promise.resolve()
      .then(() => this.#executeLeased(runId, (lease) => this.#recoverPostgresRequestedCancellation(runId, lease)))
      .finally(() => {
        if (this.#jobs.get(runId) === job) this.#jobs.delete(runId);
      });
    this.#jobs.set(runId, job);
    return job;
  }

  #scheduleReview(decision, { requeue = true } = {}) {
    const previous = this.#jobs.get(decision.runId) ?? Promise.resolve();
    let job;
    job = Promise.resolve(previous)
      .catch(() => {})
      .then(async () => {
        if (requeue) {
          const now = this.#now();
          await this.#runPersistence.requeueReview(decision.runId, { now });
        }
        return this.#executeLeased(decision.runId, async (lease) => {
        const run = await this.#internalRun(decision.runId);
        if (!run || TERMINAL.has(run.status)) return;
        const execution = await this.#executionForRun(run);
        if (decision.appliedByPersistence) return this.#execute(decision.runId, execution, lease);
        if (decision.decision === "reject") return this.#cancelRun(run, decision, lease);
        if (decision.decision === "revise") return this.#reviseRun(run, execution, decision, lease);
        return this.#approveRun(run, execution, decision, lease);
        });
      })
      .finally(() => {
        if (this.#jobs.get(decision.runId) === job) this.#jobs.delete(decision.runId);
      });
    this.#jobs.set(decision.runId, job);
    return job;
  }

  async #executeLeased(runId, operation) {
    const lease = await this.#leaseCoordinator.claim(runId);
    if (!lease) return false;
    this.#activeLeases.set(runId, lease);
    this.#startLeaseHeartbeat(runId, lease);
    try {
      await this.#fault("post-claim", { runId, lease });
      await operation(lease);
    } catch (error) {
      if (error?.code !== "run_lease_lost") {
        try {
          await this.#failRun(runId, error, lease);
        } catch (settlementError) {
          // A secondary terminal-settlement failure must not erase the first
          // execution failure. Startup recovery needs the original code to
          // identify the missing durable boundary and repair it safely.
          if (error && typeof error === "object") {
            error.failureSettlementCode = settlementError?.code ?? "run_failure_settlement_failed";
          }
          throw error;
        }
      }
    } finally {
      this.#stopLeaseHeartbeat(runId);
      await this.#releaseLeaseProjection(runId, lease);
      this.#activeLeases.delete(runId);
    }
    return true;
  }

  #startLeaseHeartbeat(runId, lease) {
    const intervalMs = Math.max(250, Math.floor(this.#leaseDurationMs / 3));
    const state = {
      armDeadline: null,
      deadlineTimer: null,
      heartbeatPromise: null,
      lastError: null,
      leaseExpiresAt: lease.leaseExpiresAt,
      mutationDepth: 0,
      stopped: false,
      timer: null,
    };
    const abortLease = () => {
      const controller = this.#abortControllers.get(runId);
      if (!controller || controller.signal.aborted) return;
      controller.abort(new WorkflowRunnerError(
        "run_lease_lost",
        "The Run worker lease could not be renewed before its current fence expired.",
        { heartbeatCode: state.lastError?.code ?? null },
      ));
    };
    const armDeadline = () => {
      if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
      const remainingMs = Date.parse(state.leaseExpiresAt) - Date.parse(this.#now());
      state.deadlineTimer = setTimeout(abortLease, Math.max(0, remainingMs));
      state.deadlineTimer.unref?.();
    };
    state.armDeadline = armDeadline;
    const heartbeat = () => {
      if (state.stopped || state.heartbeatPromise || state.mutationDepth > 0) return;
      const now = this.#now();
      if (Date.parse(now) >= Date.parse(state.leaseExpiresAt)) {
        abortLease();
        return;
      }
      const leaseExpiresAt = addMilliseconds(now, this.#leaseDurationMs);
      const heartbeatPromise = this.#runPersistence.heartbeatLeaseProjection({
        runId,
        workerId: this.#workerId,
        fence: lease.fence,
        leaseToken: lease.leaseToken ?? null,
        now,
        leaseExpiresAt,
      });
      state.heartbeatPromise = heartbeatPromise;
      heartbeatPromise.then((result) => {
        if (state.stopped) return;
        if (!result) {
          abortLease();
          return;
        }
        const renewedExpiry = result.leaseExpiresAt
          ?? result.job?.leaseExpiresAt
          ?? result.lease?.expiresAt
          ?? leaseExpiresAt;
        if (Date.parse(renewedExpiry) > Date.parse(state.leaseExpiresAt)) {
          state.leaseExpiresAt = renewedExpiry;
        }
        state.lastError = null;
        armDeadline();
      }).catch((error) => {
        if (state.stopped) return;
        state.lastError = error;
        if (leaseHeartbeatProvesLoss(error)) abortLease();
      }).finally(() => {
        if (state.heartbeatPromise === heartbeatPromise) state.heartbeatPromise = null;
      });
    };
    armDeadline();
    state.timer = setInterval(heartbeat, intervalMs);
    state.timer.unref?.();
    this.#leaseTimers.set(runId, state);
  }

  #stopLeaseHeartbeat(runId) {
    const state = this.#leaseTimers.get(runId);
    if (state) {
      state.stopped = true;
      if (state.timer) clearInterval(state.timer);
      if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
    }
    this.#leaseTimers.delete(runId);
  }

  #extendLocalLeaseDeadline(runId, leaseExpiresAt) {
    const state = this.#leaseTimers.get(runId);
    if (!state || state.stopped) return;
    if (Date.parse(leaseExpiresAt) <= Date.parse(state.leaseExpiresAt)) return;
    state.leaseExpiresAt = leaseExpiresAt;
    state.armDeadline();
  }

  async #enterFencedLeaseMutation(runId) {
    const state = this.#leaseTimers.get(runId);
    if (!state || state.stopped) return null;
    state.mutationDepth += 1;
    if (state.heartbeatPromise) {
      await state.heartbeatPromise.catch(() => {});
    }
    return state;
  }

  #leaveFencedLeaseMutation(state) {
    if (state) state.mutationDepth = Math.max(0, state.mutationDepth - 1);
  }

  async #renewLeaseForTransition(runId, lease, session) {
    if (session || typeof this.#runControl.renewActiveFence !== "function") return;
    let renewed;
    try {
      renewed = await this.#runControl.renewActiveFence(runId, {
        workerId: this.#workerId,
        fence: lease.fence,
        leaseToken: lease.leaseToken ?? null,
        leaseDurationMs: this.#leaseDurationMs,
        minimumRemainingMs: leaseTransitionHeadroom(this.#leaseDurationMs),
      });
    } catch (error) {
      if (!leaseHeartbeatProvesLoss(error)) throw error;
      throw new WorkflowRunnerError(
        "run_lease_lost",
        "The Run worker lease is no longer current.",
        { runId, renewalCode: error?.code ?? null },
      );
    }
    if (!renewed) {
      throw new WorkflowRunnerError("run_lease_lost", "The Run worker lease is no longer current.", { runId });
    }
    this.#extendLocalLeaseDeadline(runId, renewed.leaseExpiresAt);
  }

  async #execute(runId, execution, lease) {
    let run = await this.#internalRun(runId);
    if (!run || TERMINAL.has(run.status) || run.status === "waiting_review") return;
    if (run.status === "queued") {
      const now = this.#now();
      const started = await this.#fencedTransition(runId, lease, async (options) => {
        await this.#patchRun(runId, { status: "running", startedAt: now, updatedAt: now }, options);
        const current = await this.#internalRun(runId, options);
        await this.#putReadModel(current, {}, options);
        const event = await this.#appendEvent(current, "run.started", "running", "Run started.", undefined, options);
        return { run: current, event };
      });
      run = started.run;
      this.#hub.publish(started.event);
    }
    for (const step of execution.plan.steps) {
      run = await this.#internalRun(runId);
      if (!run || run.status !== "running") return;
      await this.#assertDependencies(run, step);
      const existing = await this.#latestAttempt(runId, step.nodeId);
      let revision = null;
      if (run.pendingReviewRevision) {
        const target = reviewRevisionTarget(execution, run.pendingReviewRevision);
        if (step.nodeId === target.revisionTarget.nodeId && existing?.reviewDecisionId !== run.pendingReviewRevision.decisionId) {
          if (existing?.status !== 'completed') throw new WorkflowRunnerError('review_revision_source_unavailable');
          revision = { ...run.pendingReviewRevision, ...target,
            input: appendReviewerFeedback(existing.executionInput[target.revisionTarget.portId], run.pendingReviewRevision) };
        }
      }
      if (existing?.status === "completed" && !revision) continue;
      if (
        existing?.invocationStatus === "outcome_unknown"
        && existing?.failure?.code === "side_effect_outcome_unknown"
      ) {
        await this.#sealRecoveredUnknownRun(run, existing, lease);
        return;
      }
      const existingRunning = existing?.status === "running" && existing?.invocationId;
      if (existingRunning) {
        const recoverableReceipt = await this.#prepareEffectReceiptRecovery(
          run,
          existing,
          step,
          lease,
        );
        if (!recoverableReceipt) {
          await this.#failUnknownInvocation(run, existing, lease);
          return;
        }
        const stopped = await this.#executeEffectReceiptRecovery(
          run,
          execution,
          step,
          existing,
          recoverableReceipt,
          lease,
        );
        if (stopped) return;
        continue;
      }
      const paused = await this.#executeStep(run, execution, step, { lease,
        ...(revision ? {
          reviewDecisionId: revision.decisionId,
          inputOverrides: { [revision.revisionTarget.portId]: revision.input },
          beforeAttempt: async options => {
            const current = await this.#internalRun(runId, { uow: options.session });
            if (current.status !== 'running' || current.pendingReviewRevision?.decisionId !== revision.decisionId) {
              throw new WorkflowRunnerError('review_revision_changed');
            }
          },
        } : {}),
      });
      if (revision && !paused) await this.#fault('review-revision-completed', { runId, decisionId: revision.decisionId });
      if (paused) return;
    }
    run = await this.#internalRun(runId);
    if (run?.status === "running") await this.#completeRun(run, execution, lease);
  }

  async #approveRun(run, execution, decision, lease) {
    await this.#fencedTransition(run.runId, lease, async (options) => {
      const attempt = await this.#latestAttempt(run.runId, decision.nodeId, options);
      if (!attempt || attempt.status !== "waiting_review") throw new WorkflowRunnerError("review_gate_attempt_missing");
      const node = nodeFor(execution.revision, decision.nodeId);
      const output = reviewOutput(node, attempt.executionInput);
      const now = this.#now();
      await this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
        status: "completed", summary: "Review approved.", executionOutput: output,
        completedAt: now, updatedAt: now,
      }, options);
      await this.#syncNodeRuns(run.runId, options);
      await this.#insertCheckpoint(run.runId, attempt, "completed", lease, options);
      await this.#patchRun(run.runId, { status: "running", currentNodeId: null, updatedAt: now }, options);
      await this.#runPersistence.markReviewDecision(decision.decisionId, {
        applicationStatus: "applied",
        appliedAt: now,
        updatedAt: now,
      }, { uow: options.session });
      await this.#putReadModel(await this.#internalRun(run.runId, options), {}, options);
    });
    await this.#execute(run.runId, execution, lease);
  }

  async #reviseRun(run, execution, decision, lease) {
    const gate = execution.plan.steps.find((step) => step.nodeId === decision.nodeId);
    if (!gate) throw new WorkflowRunnerError("review_gate_not_in_plan");
    const gateNode = nodeFor(execution.revision, decision.nodeId);
    const revisionTarget = gateNode.configuration?.revisionTarget;
    if (!revisionTarget || !gate.dependsOn.includes(revisionTarget.nodeId)) {
      throw new WorkflowRunnerError("review_feedback_target_missing", "This Review Gate has no configured Skill input for requested changes.", {
        nodeId: decision.nodeId,
      });
    }
    const step = execution.plan.steps.find((candidate) => candidate.nodeId === revisionTarget.nodeId);
    const targetNode = nodeFor(execution.revision, revisionTarget.nodeId);
    if (step?.kind !== "Skill" || !targetNode.inputPorts.some((port) => port.portId === revisionTarget.portId)) {
      throw new WorkflowRunnerError("review_feedback_target_invalid", "This Review Gate points to an unavailable Skill input.", {
        nodeId: decision.nodeId,
      });
    }
    const originalInput = await this.#bindings(
      await this.#internalRun(run.runId),
      execution.revision,
      step,
      targetNode,
    );
    const revisedValue = appendReviewerFeedback(originalInput[revisionTarget.portId], decision);
    const gateAttempt = await this.#latestAttempt(run.runId, decision.nodeId);
    if (!gateAttempt || gateAttempt.status !== "waiting_review") {
      throw new WorkflowRunnerError("review_gate_attempt_missing");
    }
    await this.#executeStep(await this.#internalRun(run.runId), execution, step, {
      force: true,
      inputOverrides: { [revisionTarget.portId]: revisedValue },
      lease,
      beforeAttempt: async (options) => {
        const now = this.#now();
        await this.#patchAttempt(run.runId, decision.nodeId, gateAttempt.attempt, {
          status: "skipped",
          summary: "Changes requested.",
          completedAt: now,
          updatedAt: now,
        }, options);
        await this.#runPersistence.markReviewDecision(decision.decisionId, {
          applicationStatus: "applying",
          updatedAt: now,
        }, { uow: options.session });
        await this.#patchRun(run.runId, { status: "running", currentNodeId: revisionTarget.nodeId, updatedAt: now }, options);
      },
    });
    await this.#execute(run.runId, execution, lease);
  }

  async #cancelRun(run, decision, lease) {
    const result = await this.#cancelStoredRun(run, { reviewNodeId: decision.nodeId, lease, decision });
    if (result.event) this.#hub.publish(result.event);
  }

  async #recordCommand({ runId, workspaceId, command, requestedBy, session }) {
    if (!workspaceId) throw new WorkflowRunnerError("run_workspace_missing", "Run workspace is unavailable.", { runId });
    const now = this.#now();
    return this.#store.repositories.runCommands.insert({
      schemaVersion: WORKBENCH_SCHEMA_VERSION,
      runCommandId: this.#idFactory("run-command"),
      runId,
      workspaceId,
      command,
      requestedBy,
      requestedAt: now,
    }, { session });
  }

  async #cancelStoredRun(run, {
    session,
    reviewNodeId = null,
    lease = null,
    decision = null,
    abortInvocation = true,
    commandId = null,
  } = {}) {
    if (!run || TERMINAL.has(run.status)) return { event: null };
    if (!session) {
      if (lease) {
        return this.#fencedTransition(run.runId, lease, (options) => this.#cancelStoredRun(run, {
          session: options.session,
          reviewNodeId,
          lease,
          decision,
          abortInvocation,
          commandId,
        }));
      }
      return this.#runPersistence.transact((transactionSession) => this.#cancelStoredRun(run, {
        session: transactionSession,
        reviewNodeId,
        lease,
        decision,
        abortInvocation,
        commandId,
      }));
    }
    if (abortInvocation) {
      this.#abortControllers.get(run.runId)?.abort(new WorkflowRunnerError("run_cancelled"));
    }
    const now = this.#now();
    if (run.status !== "cancellation_requested") {
      await this.#patchRun(run.runId, { status: "cancellation_requested", updatedAt: now }, {
        session,
        commandId,
        transitionType: "run_cancellation_requested",
      });
    }
    const nodeId = reviewNodeId ?? run.currentNodeId;
    const attempt = nodeId ? await this.#latestAttempt(run.runId, nodeId, session ? { session } : {}) : null;
    if (attempt && ["waiting_review", "running"].includes(attempt.status)) {
      await this.#patchAttempt(run.runId, nodeId, attempt.attempt, {
        status: "cancelled", summary: "Run cancelled.", completedAt: now, updatedAt: now,
      }, session ? { session } : {});
    }
    await this.#syncNodeRuns(run.runId, { session });
    return this.#commitTerminalRun({ runId: run.runId, status: "cancelled", now, session, lease, decision, commandId });
  }

  async #requestRunCancellation(run, { session, commandId } = {}) {
    const now = this.#now();
    const requested = await this.#runPersistence.requestCancellation({
      runId: run.runId,
      now,
      commandId,
      idFactory: this.#idFactory,
      syncCommandLifecycle: (current, runStatus, { at, uow }) => this.#syncProductCommandLifecycle(
        current,
        runStatus,
        { at, session: uow },
      ),
      eventTemplate: {
        schemaVersion: RUN_EVENT_SCHEMA_VERSION,
        eventId: this.#idFactory("event"),
        type: "run.cancellation_requested",
        status: "cancellation_requested",
        summary: "Cancellation requested.",
        ...(run.currentNodeId ? { nodeId: run.currentNodeId } : {}),
        occurredAt: now,
      },
      uow: session,
    });
    if (!requested) {
      throw new WorkflowRunnerError("run_cancellation_fence_failed", "The Run could not enter cancellation.", { runId: run.runId });
    }
    return { event: requested.event };
  }

  async #cancelInvocationAndClassify({ invocationId, externalActions, reason } = {}) {
    if (!this.#executionBroker?.cancel) return externalActions ? "effect_outcome_unknown" : "cancelled";
    try {
      const result = await this.#executionBroker.cancel(invocationId, { reason });
      if (["cancelled", "partial", "effect_outcome_unknown"].includes(result?.status)) return result.status;
      return externalActions ? "effect_outcome_unknown" : "cancelled";
    } catch {
      return externalActions ? "effect_outcome_unknown" : "cancelled";
    }
  }

  async #recoverRequestedCancellation(run) {
    const nodeId = run.currentNodeId;
    const attempt = nodeId ? await this.#latestAttempt(run.runId, nodeId) : null;
    const externalActions = this.#stepMayHaveExternalActions(run, nodeId);
    let status = null;
    if (attempt?.invocationId && typeof this.#executionBroker?.getInvocation === "function") {
      const invocation = await Promise.resolve(
        this.#executionBroker.getInvocation(attempt.invocationId),
      ).catch(() => null);
      if (["cancelled", "partial", "effect_outcome_unknown"].includes(invocation?.result?.status)) {
        status = invocation.result.status;
      }
    }
    status ??= attempt?.invocationId
      ? await this.#cancelInvocationAndClassify({
          invocationId: attempt.invocationId,
          externalActions,
          reason: "startup_recovery",
        })
      : "cancelled";
    return this.#settleRequestedCancellation(run.runId, status, {
      commandId: run.creationCommandId,
    });
  }

  async #settleRequestedCancellation(runId, status, { commandId = null, lease = null } = {}) {
    const settle = async (session) => {
      const run = await this.#internalRun(runId, { session });
      if (!run) throw new WorkflowRunnerError("run_not_found", "Run not found.", { runId });
      if (TERMINAL.has(run.status)) return { run: await this.#publicRun(runId, { session }), event: null };
      if (run.status !== "cancellation_requested") {
        throw new WorkflowRunnerError("run_cancellation_not_requested", "The Run is not awaiting cancellation settlement.", { runId });
      }
      const nodeId = run.currentNodeId;
      const attempt = nodeId ? await this.#latestAttempt(runId, nodeId, { session }) : null;
      const failure = status === "cancelled" ? undefined : productFailure({ code: status });
      if (attempt && ["waiting_review", "running"].includes(attempt.status)) {
        await this.#patchAttempt(runId, nodeId, attempt.attempt, {
          status,
          summary: cancellationSummary(status),
          ...(failure ? { failure } : {}),
          invocationStatus: attempt.invocationId ? status : undefined,
          completedAt: this.#now(),
          updatedAt: this.#now(),
        }, { session });
      }
      await this.#syncNodeRuns(runId, { session });
      const now = this.#now();
      const terminal = await this.#commitTerminalRun({
        runId,
        status,
        now,
        failure,
        session,
        commandId,
        lease,
      });
      return { run: await this.#publicRun(runId, { session }), event: terminal.event };
    };
    if (this.#store?.persistenceDriver === "postgres") {
      if (!lease) {
        throw new WorkflowRunnerError(
          "run_lease_missing",
          "A PostgreSQL cancellation can only be settled by the current worker lease.",
          { runId },
        );
      }
      return this.#fencedTransition(runId, lease, ({ session }) => settle(session));
    }
    return this.#runPersistence.transact(settle);
  }

  async #recoverPostgresRequestedCancellation(runId, lease) {
    const run = await this.#internalRun(runId);
    if (!run || TERMINAL.has(run.status) || run.status !== "cancellation_requested") return;
    const nodeId = run.currentNodeId;
    const attempt = nodeId ? await this.#latestAttempt(runId, nodeId) : null;
    let status = null;
    if (attempt?.invocationStatus === "outcome_unknown"
      || attempt?.recoveredExecutionStatus === "effect_outcome_unknown") {
      status = "effect_outcome_unknown";
    }
    if (!status && attempt?.invocationId && typeof this.#executionBroker?.getInvocation === "function") {
      const invocation = await Promise.resolve(
        this.#executionBroker.getInvocation(attempt.invocationId),
      ).catch(() => null);
      if (["cancelled", "partial", "effect_outcome_unknown"].includes(invocation?.result?.status)) {
        status = invocation.result.status;
      } else if (["cancelled", "partial", "effect_outcome_unknown"].includes(invocation?.status)) {
        status = invocation.status;
      } else if (invocation?.status === "failed" && attempt?.invocationStatus === "outcome_unknown") {
        status = "effect_outcome_unknown";
      }
    }
    status ??= attempt?.invocationId
      ? await this.#cancelInvocationAndClassify({
          invocationId: attempt.invocationId,
          externalActions: this.#stepMayHaveExternalActions(run, nodeId),
          reason: "startup_recovery",
        })
      : "cancelled";
    const settled = await this.#settleRequestedCancellation(runId, status, { lease });
    if (settled.event) this.#hub.publish(settled.event);
  }

  #stepMayHaveExternalActions(run, nodeId) {
    const step = run.executionSnapshot?.plan?.steps?.find((candidate) => candidate.nodeId === nodeId);
    return step?.capabilities?.externalActions === true;
  }

  async #executeEffectReceiptRecovery(run, execution, step, previousAttempt, effectRecovery, lease) {
    const node = nodeFor(execution.revision, step.nodeId);
    if (node.kind !== "Skill" || !this.#executionBroker) {
      await this.#sealEffectRecoveryUnknown(run, previousAttempt, lease);
      return true;
    }
    const input = structuredClone(previousAttempt.executionInput);
    const created = await this.#createAttempt(run, node, input, { step, lease });
    const attempt = created.attempt;
    this.#hub.publish(created.event);
    const controller = new AbortController();
    this.#abortControllers.set(run.runId, controller);
    try {
      await this.#fault("post-attempt-invocation-persistence", {
        runId: run.runId,
        nodeId: node.nodeId,
        attempt,
        lease,
      });
      await this.#fencedTransition(run.runId, lease, async () => {});
      const skill = this.#pinnedSkill(execution, node);
      validatePortInput(node, input);
      validateSchema(executableInputSchema(skill.definition.inputSchema), input, "skill_input_invalid");
      if (step.modelRoutingState === "pinned") {
        validateSchema(executableInputSchema(step.parameterSchema), input, "model_input_invalid");
      }
      await this.#assertConnectionApprovalsCurrent(run.executionSnapshot, {
        runId: run.runId,
        workspaceId: runWorkspaceId(run),
        stage: "effect_receipt_recovery",
      });
      const result = await this.#executionBroker.execute(
        executionRequestFor({
          run,
          node,
          step,
          skill,
          attempt,
          input,
          lease,
          effectRecovery,
        }),
        { signal: controller.signal },
      );
      const recoveryEvidence = result.evidence?.some((item) => (
        item?.requirementId === `effect-recovery:${effectRecovery.effectId}`
        && item?.kind === "validation"
        && item?.ref === effectRecovery.effectId
      ));
      if (result.status !== "completed" || !recoveryEvidence) {
        throw new WorkflowRunnerError("effect_receipt_recovery_unverified");
      }
      const output = result.output;
      validateSchema(skill.definition.outputSchema, output, "skill_output_invalid");
      validatePortOutput(node, output);
      const now = this.#now();
      const completed = await this.#fencedTransition(run.runId, lease, async (options) => {
        await this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
          status: "completed",
          summary: `${node.title} completed from its durable effect receipt.`,
          executionOutput: output,
          invocationStatus: "completed",
          completedAt: now,
          updatedAt: now,
        }, options);
        await this.#syncNodeRuns(run.runId, options);
        await this.#insertCheckpoint(run.runId, attempt, "completed", lease, options);
        const current = await this.#internalRun(run.runId, options);
        await this.#putReadModel(current, {}, options);
        const event = await this.#appendEvent(
          current,
          "node.effect_recovery_completed",
          "completed",
          `${node.title} completed from its durable effect receipt.`,
          node.nodeId,
          options,
        );
        return { event };
      });
      this.#hub.publish(completed.event);
      return false;
    } catch (error) {
      const state = (await this.#internalRun(run.runId))?.status;
      if (["cancellation_requested", "cancelled", "partial", "effect_outcome_unknown"].includes(state)) {
        return true;
      }
      if (error?.code === "run_lease_lost") throw error;
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      await this.#sealEffectRecoveryUnknown(run, attempt, lease);
      return true;
    } finally {
      if (this.#abortControllers.get(run.runId) === controller) {
        this.#abortControllers.delete(run.runId);
      }
    }
  }

  async #sealEffectRecoveryUnknown(run, attempt, lease) {
    const failure = {
      code: "side_effect_outcome_unknown",
      message: "The original external effect could not be reconciled safely, so it was not repeated.",
      retryable: false,
    };
    const now = this.#now();
    const sealed = await this.#fencedTransition(run.runId, lease, async (options) => {
      await this.#patchAttempt(run.runId, attempt.nodeId, attempt.attempt, {
        status: "effect_outcome_unknown",
        summary: "The durable external effect could not be reconciled safely.",
        failure,
        invocationStatus: attempt.invocationId ? "outcome_unknown" : undefined,
        completedAt: now,
        updatedAt: now,
      }, options);
      await this.#syncNodeRuns(run.runId, options);
      await this.#patchRun(run.runId, {
        status: "effect_outcome_unknown",
        currentNodeId: null,
        finishedAt: now,
        updatedAt: now,
      }, {
        ...options,
        attemptId: attempt.nodeRunId,
        transitionType: "effect_receipt_recovery_unknown",
      });
      await this.#insertCheckpoint(run.runId, attempt, "effect_outcome_unknown", lease, options);
      const current = await this.#internalRun(run.runId, options);
      await this.#putReadModel(current, { failure }, options);
      const event = await this.#appendEvent(
        current,
        "node.effect_recovery_unknown",
        "effect_outcome_unknown",
        "The durable external effect could not be reconciled safely.",
        attempt.nodeId,
        options,
      );
      return { event };
    });
    this.#hub.publish(sealed.event);
    const terminal = await this.#commitTerminalRun({
      runId: run.runId,
      status: "effect_outcome_unknown",
      now,
      failure,
      lease,
    });
    if (terminal.event) this.#hub.publish(terminal.event);
  }

  async #executeStep(run, execution, step, { force = false, inputOverrides = null, lease, beforeAttempt = null, reviewDecisionId = null } = {}) {
    const node = nodeFor(execution.revision, step.nodeId);
    const input = {
      ...(await this.#bindings(run, execution.revision, step, node)),
      ...(inputOverrides ? structuredClone(inputOverrides) : {}),
    };
    const skill = node.kind === "Skill" ? this.#pinnedSkill(execution, node) : null;
    const ownsExecutionAuthority = Boolean(skill) || node.kind === "ReviewGate";
    const requestForAttempt = (attempt) => skill
      ? executionRequestFor({ run, node, step, skill, attempt, input, lease })
      : reviewExecutionRequestFor({ run, node, attempt, input, lease });
    const canReserveExecution = ownsExecutionAuthority
      && typeof this.#executionBroker?.reserveExecution === "function"
      && typeof this.#executionBroker?.prepareExecution === "function";
    const created = await this.#createAttempt(run, node, input, {
      step,
      lease,
      beforeAttempt,
      reviewDecisionId,
      reserveExecution: canReserveExecution
        ? async (attempt) => {
            const request = requestForAttempt(attempt);
            return {
              request,
              reservation: await this.#executionBroker.reserveExecution(request),
            };
          }
        : null,
      prepareExecution: ownsExecutionAuthority && typeof this.#executionBroker?.prepareExecution === "function"
        ? async (attempt, options, reserved = null) => {
            const request = reserved?.request
              ?? requestForAttempt(attempt);
            return {
              request,
              authority: await this.#executionBroker.prepareExecution(request, {
                uow: options.session,
                start: true,
                ...(reserved ? { reservation: reserved.reservation } : {}),
              }),
            };
          }
        : null,
    });
    const attempt = created.attempt;
    this.#hub.publish(created.event);
    const controller = new AbortController();
    this.#abortControllers.set(run.runId, controller);
    if (node.kind === "Skill") {
      await this.#fault("post-attempt-invocation-persistence", { runId: run.runId, nodeId: node.nodeId, attempt, lease });
      await this.#fencedTransition(run.runId, lease, async () => {});
    }
    let modelProjection = {};
    let deferredSettlement = null;
    try {
      if (node.kind === "ReviewGate") {
        const waiting = await this.#fencedTransition(run.runId, lease, async (options) => {
          const now = this.#now();
          if (created.preparedExecution && typeof this.#executionBroker?.suspendExecution === "function") {
            await this.#executionBroker.suspendExecution(created.preparedExecution.authority, {
              uow: options.session,
            });
          }
          await this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
            status: "waiting_review", summary: "Waiting for review.", updatedAt: now,
          }, options);
          await this.#syncNodeRuns(run.runId, options);
          await this.#insertCheckpoint(run.runId, attempt, "waiting_review", lease, options);
          const paused = await this.#runPersistence.pauseForReview({
            runId: run.runId,
            nodeId: node.nodeId,
            lease,
            workerId: this.#workerId,
            now,
            reviewPacket: reviewPacket(node, input),
            idFactory: this.#idFactory,
            syncCommandLifecycle: (current, runStatus, { at, uow }) => this.#syncProductCommandLifecycle(
              current,
              runStatus,
              { at, session: uow },
            ),
            eventTemplate: {
              schemaVersion: RUN_EVENT_SCHEMA_VERSION,
              eventId: this.#idFactory("event"),
              type: "review.requested",
              status: "waiting_review",
              summary: "Review requested.",
              nodeId: node.nodeId,
              occurredAt: now,
            },
            uow: options.session,
          });
          if (!paused) throw new WorkflowRunnerError("run_lease_lost");
          return { event: paused.event };
        });
        if (created.preparedExecution && typeof this.#executionBroker?.confirmExecutionSuspension === "function") {
          this.#executionBroker.confirmExecutionSuspension(created.preparedExecution.authority);
        }
        await this.#fault("waiting-review-handoff", { runId: run.runId, nodeId: node.nodeId, lease });
        this.#hub.publish(waiting.event);
        return true;
      }
      let output;
      if (node.kind === "Input") output = inputNodeOutput(node, run.inputs);
      else if (node.kind === "Skill") {
        validatePortInput(node, input);
        validateSchema(executableInputSchema(skill.definition.inputSchema), input, "skill_input_invalid");
        if (step.modelRoutingState === "pinned") {
          validateSchema(executableInputSchema(step.parameterSchema), input, "model_input_invalid");
        }
        if ((step.capabilities?.connectionIds ?? []).length > 0) {
          await this.#assertConnectionApprovalsCurrent(run.executionSnapshot, {
            runId: run.runId,
            workspaceId: runWorkspaceId(run),
            stage: "step_execution",
          });
        }
        const executionRequest = created.preparedExecution?.request
          ?? executionRequestFor({ run, node, step, skill, attempt, input, lease });
        if (!this.#executionBroker) {
          throw new WorkflowRunnerError(
            "workflow_execution_broker_unavailable",
            "The Product Execution Broker is unavailable for this Workflow step.",
            {
              nodeId: node.nodeId,
              executionMode: executionRequest.mode,
            },
          );
        }
        const canDeferSettlement = Boolean(created.preparedExecution)
          && typeof this.#executionBroker.settleExecution === "function"
          && typeof this.#executionBroker.confirmExecutionSettlement === "function";
        const executionOutcome = await this.#executionBroker.execute(
          executionRequest,
          {
            signal: controller.signal,
            ...(created.preparedExecution ? { preparedExecution: created.preparedExecution.authority } : {}),
            ...(canDeferSettlement ? { deferSettlement: true } : {}),
          },
        );
        const result = canDeferSettlement ? executionOutcome.result : executionOutcome;
        if (canDeferSettlement) deferredSettlement = executionOutcome;
        modelProjection = executionResultModelProjection(result, step);
        if (result.status !== "completed") {
          throw new WorkflowRunnerError(result.failureCode === "provider_payment_required" ? result.failureCode : `execution_${result.status}`, result.summary, {
            invocationId: attempt.invocationId,
            status: result.status,
            ...modelProjection,
          });
        }
        output = result.output;
        validateSchema(skill.definition.outputSchema, output, "skill_output_invalid");
        validatePortOutput(node, output);
      } else if (node.kind === "Output") output = outputNodeOutput(node, input);
      else if (node.kind === "Material") output = await this.#materialOutput(run, node);
      else {
        throw new WorkflowRunnerError(
          "transform_execution_not_supported",
          "This node kind is not supported by the P0 runner.", { nodeId: node.nodeId },
        );
      }
      const now = this.#now();
      const completed = await this.#fencedTransition(run.runId, lease, async (options) => {
        if (deferredSettlement) {
          await this.#executionBroker.settleExecution(deferredSettlement, { uow: options.session });
        }
        await this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
          status: "completed", summary: `${node.title} completed.`, executionOutput: output,
          invocationStatus: attempt.invocationId ? "completed" : undefined,
          ...modelProjection,
          completedAt: now, updatedAt: now,
        }, options);
        await this.#syncNodeRuns(run.runId, options);
        await this.#insertCheckpoint(run.runId, attempt, "completed", lease, options);
        const current = await this.#internalRun(run.runId, options);
        await this.#putReadModel(current, {}, options);
        const event = await this.#appendEvent(current, "node.completed", "completed", `${node.title} completed.`, node.nodeId, options);
        return { event };
      });
      if (deferredSettlement) {
        this.#executionBroker.confirmExecutionSettlement(deferredSettlement);
        deferredSettlement = null;
      }
      this.#hub.publish(completed.event);
      return false;
    } catch (error) {
      const cancellationState = (await this.#internalRun(run.runId))?.status;
      if (["cancellation_requested", "cancelled", "partial", "effect_outcome_unknown"].includes(cancellationState)) {
        return true;
      }
      if (controller.signal.aborted) {
        const abortReason = controller.signal.reason;
        if (abortReason?.code === "run_lease_lost") throw abortReason;
        if (abortReason?.code === "run_cancelled") return true;
        throw abortReason ?? error;
      }
      const failure = productFailure(error);
      const now = this.#now();
      const failed = await this.#fencedTransition(run.runId, lease, async (options) => {
        if (deferredSettlement) {
          await this.#executionBroker.settleExecution(deferredSettlement, { uow: options.session });
        }
        await this.#patchAttempt(run.runId, node.nodeId, attempt.attempt, {
          status: "failed", summary: `${node.title} failed.`, failure,
          invocationStatus: attempt.invocationId ? "failed" : undefined,
          ...modelProjection,
          completedAt: now, updatedAt: now,
        }, options);
        await this.#syncNodeRuns(run.runId, options);
        await this.#insertCheckpoint(run.runId, attempt, "failed", lease, options);
        const current = await this.#internalRun(run.runId, options);
        await this.#putReadModel(current, {}, options);
        const event = await this.#appendEvent(current, "node.failed", "failed", `${node.title} failed.`, node.nodeId, options);
        return { event };
      });
      if (deferredSettlement) {
        this.#executionBroker.confirmExecutionSettlement(deferredSettlement);
        deferredSettlement = null;
      }
      this.#hub.publish(failed.event);
      await this.#failRun(run.runId, failure, lease);
      return true;
    } finally {
      if (this.#abortControllers.get(run.runId) === controller) {
        this.#abortControllers.delete(run.runId);
      }
    }
  }

  async #completeRun(run, execution, lease) {
    const output = await this.#latestAttempt(run.runId, execution.plan.primaryOutput.nodeId);
    const finalText = output?.executionOutput?.[execution.plan.primaryOutput.portId];
    if (typeof finalText !== "string" || finalText.length === 0) {
      throw new WorkflowRunnerError("output_final_text_invalid");
    }
    const previousReadModel = await this.#runPersistence.readReadModel(run.runId);
    const authoritative = await this.#agentRuntime.buildAuthoritativeFinal({
      runId: run.runId, finalText, evidenceGaps: [], reviewPacket: previousReadModel?.reviewPacket ?? null,
    });
    if (
      authoritative?.finalText !== finalText
      || authoritative?.agentFinalReadModel?.schemaVersion !== "agent-final-read-model-v1"
      || authoritative.agentFinalReadModel.runID !== run.runId
      || authoritative.agentFinalReadModel.finalText !== finalText
    ) {
      throw new WorkflowRunnerError("final_authority_mismatch");
    }
    const now = this.#now();
    const result = await this.#commitTerminalRun({
      runId: run.runId,
      status: "completed",
      now,
      patch: {
        authoritativeReadModel: { available: true, version: 1 },
        agentFinalReadModel: structuredClone(authoritative.agentFinalReadModel),
      },
      readModel: {
        evidenceGaps: authoritative.evidenceGaps,
        reviewPacket: authoritative.reviewPacket,
      },
      lease,
    });
    await this.#fault("terminal-commit-before-publish", { runId: run.runId, status: "completed", lease });
    if (result.event) this.#hub.publish(result.event);
  }

  async #failRun(runId, error, lease = null) {
    const run = await this.#internalRun(runId);
    if (!run || TERMINAL.has(run.status)) return;
    const now = this.#now();
    const result = await this.#commitTerminalRun({
      runId,
      status: "failed",
      now,
      failure: productFailure(error),
      lease,
    });
    await this.#fault("terminal-commit-before-publish", { runId, status: "failed", lease });
    if (result.event) this.#hub.publish(result.event);
  }

  async #reconcileTerminalRun(runId, lease) {
    const run = await this.#internalRun(runId);
    if (!run || !TERMINAL.has(run.status)) return;
    const result = await this.#commitTerminalRun({
      runId,
      status: run.status,
      now: run.finishedAt ?? this.#now(),
      lease,
    });
    await this.#fault("terminal-commit-before-publish", { runId, status: run.status, lease });
    if (result.event) this.#hub.publish(result.event);
  }

  async #commitTerminalRun({ runId, status, now, patch = {}, readModel = {}, failure, session, lease = null, decision = null, commandId = null } = {}) {
    if (!TERMINAL.has(status)) throw new WorkflowRunnerError("run_terminal_status_invalid", "Run terminal status is invalid.", { runId, status });
    const transition = async ({ session: uow }) => this.#runPersistence.settleTerminalAggregate({
      runId,
      status,
      now,
      patch,
      lease,
      workerId: this.#workerId,
      commandId,
      decisionId: decision?.decisionId ?? null,
      idFactory: this.#idFactory,
      syncCommandLifecycle: (run, runStatus, { at, uow: commandUow }) => this.#syncProductCommandLifecycle(
        run,
        runStatus,
        { at, session: commandUow },
      ),
      readModelFactory: ({ run }) => terminalReadModelProjection(run, { failure, readModel }),
      eventTemplate: {
        schemaVersion: RUN_EVENT_SCHEMA_VERSION,
        eventId: this.#idFactory("event"),
        type: `run.${status}`,
        status,
        summary: terminalEventSummary(status),
        occurredAt: now,
      },
      uow,
    });
    if (lease) return this.#fencedTransition(runId, lease, transition, { session });
    return this.#runPersistence.transact(
      (uow) => transition({ session: uow }),
      { uow: session },
    );
  }

  async #createAttempt(run, node, executionInput, {
    step,
    reviewDecisionId = null,
    lease,
    beforeAttempt = null,
    reserveExecution = null,
    prepareExecution = null,
  } = {}) {
    const buildAttempt = async (options) => {
      const previous = await this.#latestAttempt(run.runId, node.nodeId, options);
      const now = this.#now();
      return {
        schemaVersion: WORKBENCH_SCHEMA_VERSION,
        nodeRunId: this.#idFactory("node-run"),
        runId: run.runId,
        nodeId: node.nodeId,
        attempt: (previous?.attempt ?? 0) + 1,
        status: "running",
        summary: "Running.",
        startedAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        executionInput: structuredClone(executionInput),
        ...(reviewDecisionId ? { reviewDecisionId } : {}),
        ...(["Skill", "ReviewGate"].includes(node.kind) ? {
          invocationId: this.#idFactory("invocation"),
          invocationStatus: "started",
          invocationStartedAt: now,
        } : {}),
        ...(step?.modelRoutingState === "pinned" ? {
          requestedModelRevisionId: step.modelProfileRevisionId,
          actualModelRevisionId: null,
          artifactRefs: [],
          fallbackUsed: false,
        } : {}),
        workerId: this.#workerId,
        fence: lease.fence,
      };
    };
    let attempt = null;
    let reserved = null;
    let preparedExecution = null;
    const persistAttempt = async (options) => {
      const now = attempt.startedAt;
      if (beforeAttempt) await beforeAttempt(options);
      preparedExecution = prepareExecution
        ? await prepareExecution(attempt, options, reserved)
        : null;
      await this.#runPersistence.createNodeAttempt(attempt, { uow: options.session });
      await this.#syncNodeRuns(run.runId, options);
      await this.#patchRun(run.runId, { currentNodeId: node.nodeId, updatedAt: now }, {
        ...options,
        attemptId: attempt.nodeRunId,
      });
      const current = await this.#internalRun(run.runId, options);
      await this.#putReadModel(current, {}, options);
      const event = await this.#appendEvent(current, "node.started", "running", `${node.title} started.`, node.nodeId, options);
      return { attempt, event, preparedExecution };
    };
    try {
      if (reserveExecution) {
        // Capacity admission may wait. Keep that wait outside the SERIALIZABLE
        // Run mutation, then atomically persist Execution authority and the
        // node attempt after the committed Capacity Lease is visible.
        attempt = await this.#fencedTransition(run.runId, lease, buildAttempt);
        reserved = await reserveExecution(attempt);
        return await this.#fencedTransition(run.runId, lease, async (options) => {
          const previous = await this.#latestAttempt(run.runId, node.nodeId, options);
          if ((previous?.attempt ?? 0) + 1 !== attempt.attempt) {
            throw new WorkflowRunnerError(
              "node_attempt_sequence_changed",
              "The node attempt sequence changed while execution capacity was being reserved.",
              { runId: run.runId, nodeId: node.nodeId },
            );
          }
          return persistAttempt(options);
        });
      }
      return await this.#fencedTransition(run.runId, lease, async (options) => {
        attempt = await buildAttempt(options);
        return persistAttempt(options);
      });
    } catch (error) {
      if (
        attempt?.invocationId
        && (reserved || preparedExecution?.authority?.schemaVersion === "workbench-admitted-prepared-execution-v1")
        && typeof this.#executionBroker?.cancel === "function"
      ) {
        try {
          await this.#executionBroker.cancel(attempt.invocationId, {
            reason: "workflow_node_attempt_persistence_failed",
          });
        } catch (cleanupError) {
          throw new WorkflowRunnerError(
            "execution_preparation_cleanup_failed",
            "The prepared execution could not be cancelled after node persistence failed.",
            { runId: run.runId, nodeId: node.nodeId, cleanupCode: cleanupError?.code ?? null },
          );
        }
      }
      throw error;
    }
  }

  async #insertCheckpoint(runId, attempt, status, lease, options) {
    if (!lease) throw new WorkflowRunnerError("run_lease_missing", "The Run has no active worker lease.", { runId });
    if (this.#runPersistence.durableBoundaryMode === "event") {
      // B3 records the fenced node/terminal event itself as the durable
      // boundary. Do not manufacture a second checkpoint after its underlying
      // execution attempt has already been settled.
      return { kind: "event_backed", runId, nodeRunId: attempt.nodeRunId, status };
    }
    const now = this.#now();
    const checkpoint = await this.#runPersistence.createCheckpoint({
      runId,
      checkpointId: this.#idFactory("checkpoint"),
      attempt,
      status,
      workerId: this.#workerId,
      fence: lease.fence,
      now,
      runState: await this.#runStateSnapshot(runId, options),
      uow: options.session,
    });
    if (!checkpoint) throw new WorkflowRunnerError("run_lease_lost", "The Run worker lease is no longer current.", { runId });
    return checkpoint;
  }

  async #bindings(run, revision, step, node) {
    if (node.kind === "Input") return {};
    const attempts = await this.#runPersistence.listNodeAttempts(run.runId, { internal: true });
    const byNode = new Map();
    for (const attempt of attempts) {
      if (attempt.status === "completed") byNode.set(attempt.nodeId, attempt);
    }
    const values = {};
    for (const binding of step.inputBindings) {
      let value;
      if (binding.source.kind === "runInput") value = run.inputs[binding.source.inputKey];
      else if (binding.source.kind === "literal") value = binding.source.value;
      else if (binding.source.kind === "resource") {
        const resource = run.resourceRefs.find((entry) => entry.resourceId === binding.source.resourceId);
        value = resource ? await this.#readResourceText(run, resource) : null;
      }
      else value = byNode.get(binding.source.nodeId)?.executionOutput?.[binding.source.portId];
      values[binding.targetPort] = applyMapping(value, edgeMapping(revision, binding, node.nodeId));
    }
    return values;
  }

  async #assertDependencies(run, step) {
    for (const nodeId of step.dependsOn) {
      const attempt = await this.#latestAttempt(run.runId, nodeId);
      if (attempt?.status !== "completed") throw new WorkflowRunnerError("dependency_not_completed", "A dependency did not complete.", { nodeId });
    }
  }

  async #materialOutput(run, node) {
    const refs = node.configuration.resourceIds.map((resourceId) =>
      run.resourceRefs.find((entry) => entry.resourceId === resourceId),
    );
    if (refs.some((ref) => !ref)) {
      throw new WorkflowRunnerError("resource_ref_not_found", "This material is not attached to the Workflow.", { nodeId: node.nodeId });
    }
    const text = (await Promise.all(refs.map((ref) => this.#readResourceText(run, ref))))
      .join("\n\n");
    const output = Object.fromEntries(node.outputPorts.map((port) => [port.portId, text]));
    validatePortOutput(node, output);
    return output;
  }

  async #readResourceText(run, ref) {
    if (!this.#resolveResourceText) {
      throw new WorkflowRunnerError("resource_execution_unavailable", "Material execution is not configured.", { resourceId: ref.resourceId });
    }
    return this.#resolveResourceText({
      workspaceId: runWorkspaceId(run),
      resourceId: ref.resourceId,
      version: ref.version,
    });
  }

  #pinnedSkill(execution, node) {
    const skills = execution.skills ?? execution.skillDefinitions;
    const resolved = skills?.get?.(`${node.skillRef.skillId}:${node.skillRef.version}`)
      ?? skills?.[`${node.skillRef.skillId}:${node.skillRef.version}`];
    const definition = resolved?.definition ?? resolved;
    if (
      !resolved?.executionRef
      || !definition?.inputSchema
      || !definition?.outputSchema
    ) {
      throw new WorkflowRunnerError("pinned_skill_contract_missing", "The pinned Skill contract is unavailable.", { nodeId: node.nodeId });
    }
    return { definition, executionRef: resolved.executionRef };
  }

  async #execution(workflowId, revisionId, options = {}) {
    const value = await this.#resolveExecution({ workflowId, revisionId, ...options });
    const revision = value?.revision ?? value?.workflowRevision;
    const compileResult = value?.compileResult ?? value?.compile;
    const plan = compileResult?.executionPlan ?? value?.executionPlan;
    if (!revision || !plan || compileResult?.status !== "ready" || plan.workflowId !== workflowId || plan.workflowRevisionId !== revisionId) {
      throw new WorkflowRunnerError("workflow_execution_not_ready");
    }
    const skillVersions = structuredClone(value.skillVersions ?? []);
    if (!hasCompletePinnedSkillVersions(plan, skillVersions)) {
      throw new WorkflowRunnerError(
        "workflow_execution_snapshot_incomplete",
        "The executable Workflow does not include every immutable pinned Skill version.",
        { workflowId, revisionId },
      );
    }
    return Object.freeze({
      revision: structuredClone(revision),
      plan: structuredClone(plan),
      skills: value.skills,
      skillDefinitions: value.skillDefinitions,
      skillVersions,
      resources: value.resources,
      workspaceId: value.workspaceId ?? null,
      scopeId: value.scopeId ?? null,
      workflowRevisionContentHash: revision.contentHash ?? value.workflowRevisionContentHash ?? null,
      compileResultId: compileResult.compileResultId ?? compileResult.id ?? value.compileResultId ?? null,
      executionPlanId: plan.planId ?? plan.executionPlanId ?? value.executionPlanId ?? null,
      loopVersionId: value.loopVersionId ?? null,
      automationRevisionId: value.automationRevisionId ?? null,
      connectionBindings: structuredClone(value.connectionBindings ?? []),
      connectionIds: structuredClone(value.connectionIds ?? []),
    });
  }

  async #executionForRun(run) {
    requiredId(run?.workspaceId, "run_workspace_missing");
    requiredId(run?.requestedBy, "run_requested_by_missing");
    let authoritativeRun = run;
    if (run.stateModelVersion === RUN_STATE_MODEL_VERSION) {
      const folded = await this.#foldRunState(run.runId);
      if (!folded.base) {
        throw new WorkflowRunnerError("run_state_base_unavailable", "The V2 Run event stream has no immutable base.", {
          runId: run.runId,
        });
      }
      authoritativeRun = {
        ...structuredClone(folded.base),
        ...structuredClone(folded.state),
        workspaceId: run.workspaceId,
        requestedBy: run.requestedBy,
        stateModelVersion: RUN_STATE_MODEL_VERSION,
        stateEventSequence: folded.sequence,
        stateHash: folded.stateHash,
      };
    }
    const snapshot = authoritativeRun.executionSnapshot;
    if (
      !snapshot?.graph
      || !snapshot?.plan
      || !Array.isArray(snapshot.skillVersions)
      || !hasCompletePinnedSkillVersions(snapshot.plan, snapshot.skillVersions)
    ) {
      throw new WorkflowRunnerError(
        "run_execution_snapshot_unavailable",
        "This historical Run has no complete immutable execution snapshot and cannot be resumed or retried.",
        { runId: run.runId },
      );
    }
    await this.#assertConnectionApprovalsCurrent(snapshot, {
      runId: run.runId,
      workspaceId: runWorkspaceId(authoritativeRun),
      stage: "run_recovery",
    });
    const skills = new Map(snapshot.skillVersions.map((version) => {
      const definition = projectPublishedSkillVersion(version);
      return [`${version.skillId}:${version.version}`, {
        definition,
        executionRef: structuredClone(version.executionRef),
      }];
    }));
    return Object.freeze({
      revision: {
        schemaVersion: snapshot.schemaVersion,
        revisionId: snapshot.workflowRevisionId,
        workflowId: snapshot.workflowId,
        graph: structuredClone(snapshot.graph),
        inputForm: structuredClone(snapshot.inputForm),
        outputDefinition: structuredClone(snapshot.outputDefinition),
        runSettings: structuredClone(snapshot.runSettings),
      },
      plan: structuredClone(snapshot.plan),
      skills,
      skillDefinitions: undefined,
      skillVersions: structuredClone(snapshot.skillVersions),
      resources: new Map(),
      workspaceId: runWorkspaceId(authoritativeRun),
      scopeId: authoritativeRun.scopeId,
      workflowRevisionContentHash: authoritativeRun.workflowRevisionContentHash ?? null,
      compileResultId: authoritativeRun.compileResultId ?? null,
      executionPlanId: authoritativeRun.executionPlanId ?? null,
      loopVersionId: snapshot.loopVersionId ?? null,
      automationRevisionId: snapshot.automationRevisionId ?? null,
      connectionBindings: structuredClone(snapshot.connectionBindings ?? []),
      connectionIds: structuredClone(snapshot.connectionIds ?? []),
    });
  }

  async #assertConnectionApprovalsCurrent(snapshot, {
    runId = snapshot?.runId,
    workspaceId,
    session,
    stage,
  } = {}) {
    const requirementIds = connectionRequirementIdsForPlan(snapshot?.plan);
    if (requirementIds.length === 0) return;
    requiredId(workspaceId, "run_workspace_missing");
    const bindings = Array.isArray(snapshot?.connectionBindings)
      ? snapshot.connectionBindings
      : [];
    const byRequirement = new Map();
    let incomplete = bindings.length !== requirementIds.length;
    for (const binding of bindings) {
      if (
        !isCompleteConnectionApprovalSnapshot(binding)
        || byRequirement.has(binding.requirementId)
      ) {
        incomplete = true;
        continue;
      }
      byRequirement.set(binding.requirementId, binding);
    }
    if (incomplete || requirementIds.some((requirementId) => !byRequirement.has(requirementId))) {
      throw new WorkflowRunnerError(
        "run_connection_snapshot_unavailable",
        "This Run has no complete immutable Connection approval snapshot and cannot be resumed or replayed.",
        { runId, stage },
      );
    }
    const repository = this.#store.repositories?.connections;
    const resolveCurrent = this.#resolveConnectionApproval
      ?? (typeof repository?.get === "function"
        ? async ({ connectionId, requirementId }) => {
            const current = await repository.get(connectionId, {
              workspaceId,
              ...(session ? { session } : {}),
            });
            return current
              ? connectionApprovalSnapshot(current, {
                  requirementId,
                  now: Date.parse(this.#now()),
                })
              : null;
          }
        : null);
    if (!resolveCurrent) {
      throw new WorkflowRunnerError(
        "run_connection_snapshot_unavailable",
        "The Connection approval repository is unavailable for this Run.",
        { runId, stage },
      );
    }
    for (const requirementId of requirementIds) {
      const expected = byRequirement.get(requirementId);
      let currentApproval = null;
      try {
        currentApproval = await resolveCurrent({
          workspaceId,
          connectionId: expected.connectionId,
          requirementId,
          session,
          now: this.#now(),
          automationRevisionId: snapshot?.automationRevisionId ?? null,
        });
      } catch {
        currentApproval = null;
      }
      if (!currentApproval || !connectionApprovalSnapshotsMatch(expected, currentApproval)) {
        throw new WorkflowRunnerError(
          "connection_reapproval_required",
          "This Connection changed after the Run was created. Create a new Run and review the current account binding.",
          {
            runId,
            stage,
            requirementId,
            connectionId: expected.connectionId,
            expectedApprovalFingerprint: expected.approvalFingerprint,
            currentApprovalFingerprint: currentApproval?.approvalFingerprint ?? null,
          },
        );
      }
    }
  }

  async #emit(run, type, status, summary, nodeId, options = {}) {
    const event = await this.#appendEvent(run, type, status, summary, nodeId, options);
    this.#hub.publish(event);
    return event;
  }

  async #appendEvent(run, type, status, summary, nodeId, { session, occurredAt, eventId } = {}) {
    return this.#runPersistence.appendRunEvent({
      run,
      eventTemplate: {
        schemaVersion: RUN_EVENT_SCHEMA_VERSION, eventId: eventId ?? this.#idFactory("event"), type,
        ...(nodeId ? { nodeId } : {}), status, summary, occurredAt: occurredAt ?? this.#now(),
      },
      uow: session,
    });
  }

  async #putReadModel(run, overrides = {}, options = {}) {
    return this.#runPersistence.projectReadModel({
      run, overrides, now: this.#now(), uow: options.session,
    });
  }

  async #syncNodeRuns(runId, options = {}) {
    const updated = await this.#runPersistence.syncNodeRuns({
      runId,
      now: this.#now(),
      idFactory: this.#idFactory,
      uow: options.session,
    });
    if (!updated) {
      throw new WorkflowRunnerError("run_state_projection_conflict", "The Run state projection changed concurrently.", { runId });
    }
    return updated;
  }

  async #patchRun(runId, patch, options = {}) {
    if (!options.session) {
      return this.#runPersistence.transact(
        (session) => this.#patchRun(runId, patch, { ...options, session }),
      );
    }
    const {
      transitionType,
      commandId,
      attemptId,
      effectReceiptId,
      ...repositoryOptions
    } = options;
    let updated;
    try {
      updated = await this.#runPersistence.transitionRunState({
        runId, patch, metadata: { transitionType, commandId, attemptId, effectReceiptId },
        idFactory: this.#idFactory, now: this.#now(), uow: repositoryOptions.session,
      });
    } catch (error) {
      if (error?.code === "run_state_prior_hash_invalid") {
        throw new WorkflowRunnerError(error.code, "The Run state projection is not aligned with its authoritative event stream.", { runId });
      }
      throw error;
    }
    if (!updated) throw new WorkflowRunnerError("run_state_projection_conflict", "The Run state projection changed concurrently.", { runId });
    if (patch.status) await this.#syncProductCommandLifecycle(updated, patch.status, {
      at: patch.finishedAt ?? patch.updatedAt ?? this.#now(),
      session: repositoryOptions.session,
    });
    return updated;
  }
  #commandPrincipal(run) {
    const workspaceId = runWorkspaceId(run);
    const userId = runRequestedBy(run);
    if (!workspaceId) {
      throw new WorkflowRunnerError("run_workspace_missing", "Run workspace is unavailable.", {
        runId: run?.runId,
      });
    }
    requiredId(userId, "run_requested_by_missing");
    return { workspaceId, userId };
  }
  async #syncProductCommandLifecycle(run, runStatus, { at, session } = {}) {
    const principal = this.#commandPrincipal(run);
    const commandId = run.creationCommandId;
    requiredId(commandId, "run_creation_command_missing");
    const commandStatus = productCommandStatusForRun(runStatus);
    if (commandStatus === "accepted") {
      const current = await this.#commandIntake.recover({ principal, commandId, session });
      if (current?.status === "accepted") return current;
      throw new WorkflowRunnerError("run_command_transition_invalid", "A Run command cannot return to accepted.", {
        runId: run.runId,
        commandStatus: current?.status ?? null,
      });
    }
    if (commandStatus === "running") {
      return this.#commandIntake.start({ principal, commandId, at, session });
    }
    if (commandStatus === "cancellation_requested") {
      return this.#commandIntake.requestCancellation({ principal, commandId, at, session });
    }
    return this.#commandIntake.settle({ principal, commandId, status: commandStatus, at, session });
  }
  #internalRun(runId, options = {}) { return this.#runPersistence.readInternalRun(runId, options); }
  #publicRun(runId, options = {}) { return this.#runPersistence.readPublicRun(runId, options); }
  async #latestAttempt(runId, nodeId, options = {}) {
    const items = await this.#runPersistence.listNodeAttempts(runId, {
      internal: true,
      uow: options.session,
    });
    return items.filter((item) => item.nodeId === nodeId).at(-1) ?? null;
  }

  async #runStateSnapshot(runId, options = {}) {
    const folded = await this.#foldRunState(runId, options);
    return {
      schemaVersion: "workbench-run-state-snapshot-v2",
      runId,
      sequence: folded.sequence,
      stateHash: folded.stateHash,
      state: folded.state,
      base: folded.base,
    };
  }

  async #foldRunState(runId, options = {}) {
    return this.#runPersistence.readRunState(runId, { uow: options.session });
  }

  async #reconcileRunStateProjection(runId, options = {}) {
    if (!options.session) {
      return this.#store.withTransaction(
        (session) => this.#reconcileRunStateProjection(runId, { ...options, session }),
      );
    }
    const run = await this.#internalRun(runId, options);
    if (!run || run.stateModelVersion !== RUN_STATE_MODEL_VERSION) return run;
    const folded = await this.#foldRunState(runId, options);
    if (runProjectionMatchesFold(run, folded)) return run;
    const repaired = await this.#store.repositories.runs.repairStateProjection(runId, {
      state: folded.state,
      stateEventSequence: folded.sequence,
      stateHash: folded.stateHash,
      expectedProjectionSequence: run.stateEventSequence,
      expectedProjectionHash: run.stateHash,
    }, options);
    if (!repaired) {
      const latestRun = await this.#internalRun(runId, options);
      const latestFold = await this.#foldRunState(runId, options);
      if (runProjectionMatchesFold(latestRun, latestFold)) return latestRun;
      throw new WorkflowRunnerError("run_state_projection_repair_failed", "The Run state projection could not be rebuilt.", { runId });
    }
    return repaired;
  }

  async #importLegacyActiveRun(runId) {
    return this.#store.withTransaction(async (session) => {
      const current = await this.#internalRun(runId, { session });
      if (!current || TERMINAL.has(current.status)) return current;
      if (current.stateModelVersion === RUN_STATE_MODEL_VERSION) {
        return this.#reconcileRunStateProjection(runId, { session });
      }
      const now = this.#now();
      const drainWorkerId = `migration:${this.#workerId}`;
      const drain = await this.#store.repositories.runJobs.claimMigrationDrainByRun(runId, {
        workerId: drainWorkerId,
        now,
        session,
      });
      if (!drain) {
        throw new WorkflowRunnerError(
          "run_state_legacy_drain_unavailable",
          "The legacy Run is still owned by an active worker and cannot be cut over.",
          { runId },
        );
      }
      await this.#store.repositories.runLeases.cancelByRun(runId, { cancelledAt: now, session });
      let events = await this.#store.repositories.runStateEvents.listByRun(runId, { session });
      if (events.length === 0) {
        const imported = createLegacyImportEvent({
          run: current,
          eventId: `run-state-import:${runId}`.slice(0, 128),
          commandId: `legacy-cutover:${runId}`.slice(0, 128),
          occurredAt: now,
        });
        await this.#store.repositories.runStateEvents.append(imported, { session });
        events = [imported];
      }
      const folded = foldRunStateEvents(events, { expectedRunId: runId });
      const sourceHash = sourceHashForLegacyRun(current);
      if (
        events[0]?.transitionType !== "run_state_imported"
        || events[0]?.payload?.sourceHash !== sourceHash
        || !runProjectionMatchesFold({
          ...current,
          stateModelVersion: RUN_STATE_MODEL_VERSION,
          stateEventSequence: folded.sequence,
          stateHash: folded.stateHash,
        }, folded)
      ) {
        throw new WorkflowRunnerError(
          "run_state_legacy_shadow_diverged",
          "The legacy Run does not match its candidate event stream.",
          { runId },
        );
      }
      const updated = await this.#store.repositories.runs.importStateModelV2(runId, {
        stateEventSequence: folded.sequence,
        stateHash: folded.stateHash,
        creationCommandId: events[0].commandId,
        expectedLifecycle: lifecycleStateFromRun(current),
        expectedSourceHash: sourceHash,
      }, { session });
      if (!updated) throw new WorkflowRunnerError("run_state_legacy_cutover_conflict", "The legacy Run could not be atomically cut over.", { runId });
      await this.#commandIntake.accept({
        principal: this.#commandPrincipal(updated),
        command: {
          schemaVersion: WORKBENCH_SCHEMA_VERSION,
          commandId: updated.creationCommandId,
          kind: "workflow_run",
          sessionId: runId,
          turnId: runId,
        },
        at: updated.createdAt ?? now,
        session,
        persistTarget: async () => updated,
      });
      const released = await this.#store.repositories.runJobs.completeMigrationDrainByRun(runId, {
        workerId: drainWorkerId,
        fence: drain.fence,
        now,
        session,
      });
      if (!released) throw new WorkflowRunnerError("run_state_legacy_drain_release_failed", "The migrated Run could not be re-queued.", { runId });
      return updated;
    });
  }

  #executionSnapshot({ runId, execution, plan, now }) {
    return {
      schemaVersion: WORKBENCH_SCHEMA_VERSION,
      runId,
      workflowId: plan.workflowId,
      workflowRevisionId: plan.workflowRevisionId,
      loopVersionId: execution.loopVersionId ?? null,
      ...(typeof execution.automationRevisionId === "string"
        ? { automationRevisionId: execution.automationRevisionId }
        : {}),
      graph: structuredClone(execution.revision.graph),
      inputForm: structuredClone(execution.revision.inputForm),
      outputDefinition: structuredClone(execution.revision.outputDefinition),
      runSettings: structuredClone(execution.revision.runSettings),
      plan: structuredClone(plan),
      planHash: plan.contentHash,
      skillVersions: structuredClone(execution.skillVersions ?? []),
      resourceObjectIds: (execution.resources ? [...execution.resources.values()] : []).map((resource) => resource.objectId).filter(Boolean).sort(),
      connectionBindings: structuredClone(execution.connectionBindings ?? []),
      connectionIds: structuredClone(execution.connectionIds ?? []),
      createdAt: now,
    };
  }

  async #putRunSnapshot(runId, plan, executionSnapshot, { session } = {}) {
    await this.#runPersistence.saveExecutionSnapshot({
      runId, executionPlan: plan, executionSnapshot, uow: session,
    });
  }

  async #patchAttempt(runId, nodeId, attempt, patch, options = {}) {
    const payload = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const updated = await this.#runPersistence.patchNodeAttempt({
      runId,
      nodeId,
      attempt,
      patch: payload,
      uow: options.session,
    });
    if (!updated) throw new WorkflowRunnerError("node_attempt_transition_conflict", "The node attempt changed before this transition.", { runId, nodeId, attempt });
    return updated;
  }

  async #fencedTransition(runId, lease, mutation, { session } = {}) {
    if (!lease) throw new WorkflowRunnerError("run_lease_missing", "The Run has no active worker lease.", { runId });
    const heartbeatState = await this.#enterFencedLeaseMutation(runId);
    try {
      await this.#renewLeaseForTransition(runId, lease, session);
      const transitionStartedAt = this.#now();
      const result = await this.#runPersistence.withFencedTransaction({
        runId,
        workerId: this.#workerId,
        fence: lease.fence,
        leaseToken: lease.leaseToken ?? null,
        now: transitionStartedAt,
        uow: session,
        assertActiveFence: (candidateRunId, input) => this.#runControl.assertActiveFence(candidateRunId, input),
        mutation: ({ uow }) => mutation({ session: uow }),
      });
      if (result === null) throw new WorkflowRunnerError("run_lease_lost", "The Run worker lease is no longer current.", { runId });
      return result;
    } finally {
      this.#leaveFencedLeaseMutation(heartbeatState);
    }
  }

  async #releaseLeaseProjection(runId, lease) {
    const run = await this.#internalRun(runId);
    const finishedAt = this.#now();
    await this.#runPersistence.releaseLeaseProjection({
      runId,
      workerId: this.#workerId,
      fence: lease.fence,
      leaseToken: lease.leaseToken ?? null,
      status: runJobStatus(run?.status),
      now: finishedAt,
    });
  }

  async #failUnknownInvocation(run, attempt, lease) {
    const failure = {
      code: "side_effect_outcome_unknown",
      message: "The previous Skill invocation may have produced an effect, so it was not repeated.",
      retryable: false,
    };
    const now = this.#now();
    await this.#fencedTransition(run.runId, lease, async (options) => {
      await this.#patchAttempt(run.runId, attempt.nodeId, attempt.attempt, {
        status: "failed",
        summary: "The previous Skill result is unknown.",
        failure,
        invocationStatus: "outcome_unknown",
        completedAt: now,
        updatedAt: now,
      }, options);
      await this.#syncNodeRuns(run.runId, options);
      await this.#insertCheckpoint(run.runId, attempt, "failed", lease, options);
    });
    await this.#failRun(run.runId, failure, lease);
  }

  async #sealRecoveredUnknownRun(run, attempt, lease) {
    const failure = attempt.failure ?? {
      code: "side_effect_outcome_unknown",
      message: "The previous Skill invocation may have produced an effect, so it was not repeated.",
      retryable: false,
    };
    const now = this.#now();
    const result = await this.#commitTerminalRun({
      runId: run.runId,
      status: attempt.recoveredExecutionStatus === "effect_outcome_unknown"
        ? "effect_outcome_unknown"
        : "failed",
      now,
      failure: productFailure(failure),
      lease,
    });
    await this.#fault("terminal-commit-before-publish", {
      runId: run.runId,
      status: attempt.recoveredExecutionStatus === "effect_outcome_unknown"
        ? "effect_outcome_unknown"
        : "failed",
      lease,
    });
    if (result.event) this.#hub.publish(result.event);
  }

  async #prepareEffectReceiptRecovery(run, attempt, step, lease) {
    if (step?.capabilities?.externalActions !== true || !this.#executionBroker?.cancel) return null;
    const workspaceId = runWorkspaceId(run);
    if (!workspaceId) return null;
    const receipts = await this.#runPersistence.listEffectReceipts({
      workspaceId,
      controllerId: run.runId,
      nodeId: attempt.nodeId,
      invocationId: attempt.invocationId,
    });
    if (receipts.length !== 1) return null;
    const [receipt] = receipts;
    const approval = (run.executionSnapshot?.connectionBindings ?? []).find((binding) => (
      binding.requirementId === receipt.requirementId
      && binding.connectionId === receipt.connectionId
    ));
    if (!approval
      || !connectionApprovalSnapshotsMatch(approval, receipt)
      || receipt.invocationId !== attempt.invocationId
      || receipt.attemptId !== attempt.nodeRunId
      || receipt.controllerId !== run.runId
      || receipt.nodeId !== attempt.nodeId
      || typeof receipt.effectId !== "string"
      || typeof receipt.action !== "string"
      || !(step.capabilities?.toolAllowlist ?? []).includes(receipt.action)) return null;
    const queryReconciliation = receipt.driverCapabilities?.reconcile === "query";
    const dispatchLeaseExpired = Number.isFinite(Date.parse(receipt.reconcileAfter))
      && Date.parse(receipt.reconcileAfter) <= Date.parse(this.#now());
    const safelyRecoverable = ["succeeded", "intent_recorded"].includes(receipt.status)
      || (receipt.status === "dispatching" && queryReconciliation && dispatchLeaseExpired)
      || (receipt.status === "outcome_unknown" && queryReconciliation);
    if (!safelyRecoverable) return null;

    const settlement = await Promise.resolve(this.#executionBroker.cancel(attempt.invocationId, {
      reason: "external_effect_receipt_recovery",
    })).catch(() => null);
    if (!settlement || !["effect_outcome_unknown", "cancelled"].includes(settlement.status)) return null;

    const now = this.#now();
    const prepared = await this.#fencedTransition(run.runId, lease, async (options) => {
      await this.#patchAttempt(run.runId, attempt.nodeId, attempt.attempt, {
        status: "effect_outcome_unknown",
        summary: "The interrupted invocation was sealed before receipt-backed recovery.",
        failure: {
          code: "side_effect_outcome_unknown",
          message: "A durable receipt permits query-backed recovery in a new invocation.",
          retryable: false,
        },
        invocationStatus: "outcome_unknown",
        completedAt: now,
        updatedAt: now,
      }, options);
      await this.#syncNodeRuns(run.runId, options);
      await this.#patchRun(run.runId, {
        currentNodeId: attempt.nodeId,
        updatedAt: now,
      }, {
        ...options,
        attemptId: attempt.nodeRunId,
        effectReceiptId: receipt.effectId,
        transitionType: "effect_receipt_recovery_started",
      });
      await this.#insertCheckpoint(run.runId, attempt, "effect_outcome_unknown", lease, options);
      const current = await this.#internalRun(run.runId, options);
      await this.#putReadModel(current, {}, options);
      const event = await this.#appendEvent(
        current,
        "node.effect_recovery_started",
        "running",
        "A durable external-effect receipt will be reconciled before replay.",
        attempt.nodeId,
        options,
      );
      return { event };
    });
    this.#hub.publish(prepared.event);
    return {
      schemaVersion: "workbench-effect-recovery-v1",
      effectId: receipt.effectId,
      action: receipt.action,
      connectionId: receipt.connectionId,
      requirementId: receipt.requirementId,
      approvalFingerprint: receipt.approvalFingerprint,
      credentialBindingFingerprint: receipt.credentialBindingFingerprint,
      driverBackend: receipt.driverBackend,
      sourceInvocationId: receipt.invocationId,
      sourceAttemptId: receipt.attemptId,
    };
  }

  #fault(boundary, context) {
    return this.#faultInjector(boundary, structuredClone(context));
  }

  #now() { return String(this.#clock()); }
}

function nodeFor(revision, nodeId) {
  const node = revision.graph?.nodes?.find((candidate) => candidate.nodeId === nodeId);
  if (!node) throw new WorkflowRunnerError("execution_node_missing", "The execution node is missing.", { nodeId });
  return node;
}

function inputNodeOutput(node, inputs) {
  const output = {};
  for (const fieldId of node.configuration.fieldIds) output[fieldId] = inputs[fieldId];
  validatePortOutput(node, output);
  return output;
}

function outputNodeOutput(node, input) {
  validatePortInput(node, input);
  const first = node.inputPorts[0]?.portId;
  const text = input[first];
  if (typeof text !== "string" || text.length === 0) throw new WorkflowRunnerError("output_final_text_invalid");
  return { [node.outputPorts[0].portId]: text };
}

function reviewOutput(node, input) {
  const first = node.inputPorts[0]?.portId;
  return Object.fromEntries(node.outputPorts.map((port) => [port.portId, input[first]]));
}

function reviewPacket(node, input) {
  const items = Object.values(input).map(stringifyItem).filter(Boolean);
  return {
    nodeId: node.nodeId,
    title: node.title,
    summary: node.configuration.instructions,
    items: items.map(value => value.slice(0, 1000000)),
    ...(items.some(value => value.length > 1000000) ? { contentTruncated: true } : {}),
    canRequestChanges: Boolean(node.configuration.allowRevision && node.configuration.revisionTarget),
  };
}

function stringifyItem(value) { return typeof value === "string" ? value : JSON.stringify(value); }
function reviewRevisionTarget(execution, decision) {
  const gate = execution.plan.steps.find(step => step.nodeId === decision.nodeId);
  const node = nodeFor(execution.revision, decision.nodeId);
  const revisionTarget = node.configuration?.revisionTarget;
  if (!node.configuration?.allowRevision || !revisionTarget || !gate?.dependsOn.includes(revisionTarget.nodeId)) {
    throw new WorkflowRunnerError('review_feedback_target_missing');
  }
  const step = execution.plan.steps.find(step => step.nodeId === revisionTarget.nodeId);
  const targetNode = nodeFor(execution.revision, revisionTarget.nodeId);
  if (step?.kind !== 'Skill' || !targetNode.inputPorts.some(port => port.portId === revisionTarget.portId && port.schema?.type === 'string')) {
    throw new WorkflowRunnerError('review_feedback_target_invalid');
  }
  return { revisionTarget };
}

function appendReviewerFeedback(value, decision) {
  if (typeof value !== "string") {
    throw new WorkflowRunnerError("review_feedback_target_invalid", "Requested changes require a text Skill input.", { nodeId: decision.nodeId });
  }
  const messages = [decision.comment, ...(decision.requestedChanges || [])]
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim());
  if (!messages.length) {
    throw new WorkflowRunnerError("review_feedback_missing", "Requested changes need reviewer feedback.", { nodeId: decision.nodeId });
  }
  return `${value}\n\nReviewer feedback:\n${messages.map((item) => `- ${item}`).join("\n")}`;
}
function edgeMapping(revision, binding, targetNodeId) {
  if (binding.source.kind !== "nodeOutput") return undefined;
  return revision.graph.edges?.find((edge) => edge.sourceNodeId === binding.source.nodeId && edge.sourcePort === binding.source.portId && edge.targetNodeId === targetNodeId && edge.targetPort === binding.targetPort)?.mappingExpression;
}
function applyMapping(value, expression) {
  if (expression === undefined || expression === "identity") return structuredClone(value);
  if (typeof expression !== "string" || !expression.startsWith("/")) throw new WorkflowRunnerError("binding_mapping_invalid");
  let current = value;
  for (const raw of expression.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || !Object.hasOwn(current, token)) throw new WorkflowRunnerError("binding_mapping_missing");
    current = current[token];
  }
  return structuredClone(current);
}

function validatePortInput(node, input) { validatePorts(node.inputPorts, input, "skill_input_invalid"); }
function validatePortOutput(node, output) { validatePorts(node.outputPorts, output, "skill_output_invalid"); }
function validateSchema(schema, value, code) { if (!Check(schema, value)) throw new WorkflowRunnerError(code); }
function executableInputSchema(schema) {
  if (schema?.type !== "object" || !schema.properties) return schema;
  const properties = Object.fromEntries(
    Object.entries(schema.properties)
      .filter(([, definition]) => definition?.format !== "attachment"),
  );
  const required = (schema.required ?? []).filter((key) => Object.hasOwn(properties, key));
  return {
    ...schema,
    properties,
    required,
  };
}
function validatePorts(ports, value, code) {
  for (const port of ports) {
    if (port.required && !Object.hasOwn(value, port.portId)) throw new WorkflowRunnerError(code);
    if (Object.hasOwn(value, port.portId) && !Check(port.schema, value[port.portId])) throw new WorkflowRunnerError(code);
  }
}

function terminalReadModelProjection(run, { failure, readModel }) {
  if (run.status === "completed") {
    return {
      ...readModel,
      status: "completed",
      currentNodeId: null,
      finalAnswer: completedFinalAnswer(run),
      failure: null,
    };
  }
  if (["failed", "partial", "effect_outcome_unknown"].includes(run.status)) {
    const durableFailure = [...(run.nodeRuns ?? [])]
      .reverse()
      .find((nodeRun) => nodeRun.status === "failed" && nodeRun.failure)?.failure;
    return {
      ...readModel,
      status: run.status,
      currentNodeId: null,
      finalAnswer: null,
      failure: structuredClone(failure ?? durableFailure ?? productFailure({ code: run.status })),
    };
  }
  return {
    ...readModel,
    status: "cancelled",
    currentNodeId: null,
    finalAnswer: null,
    failure: null,
  };
}

function completedFinalAnswer(run) {
  const authority = run.agentFinalReadModel;
  const snapshot = run.executionSnapshot;
  const outputNodeId = snapshot?.plan?.primaryOutput?.nodeId;
  const outputNode = snapshot?.graph?.nodes?.find((node) => node.nodeId === outputNodeId);
  const format = outputNode?.configuration?.format;
  if (
    authority?.schemaVersion !== "agent-final-read-model-v1"
    || authority.runID !== run.runId
    || typeof authority.finalText !== "string"
    || authority.finalText.length === 0
    || !new Set(["markdown", "text", "json"]).has(format)
  ) {
    throw new WorkflowRunnerError("terminal_run_authority_invalid", "Completed Run authority is unavailable.", { runId: run.runId });
  }
  return {
    format,
    content: authority.finalText,
    createdAt: run.finishedAt,
  };
}

function terminalEventSummary(status) {
  if (status === "completed") return "Run completed.";
  if (status === "failed") return "Run failed.";
  if (status === "partial") return "Run stopped after partial external effects.";
  if (status === "effect_outcome_unknown") return "Run stopped with an unknown external effect outcome.";
  return "Run cancelled.";
}

function cancellationSummary(status) {
  if (status === "partial") return "Run stopped after partial external effects.";
  if (status === "effect_outcome_unknown") return "Run stopped with an unknown external effect outcome.";
  return "Run cancelled.";
}

function hasCompletePinnedSkillVersions(plan, skillVersions) {
  const available = new Set(
    skillVersions.map((version) => `${version?.skillId}:${version?.version}`),
  );
  return (plan?.pinnedSkills ?? []).every(
    (skillRef) => available.has(`${skillRef?.skillId}:${skillRef?.version}`),
  );
}

function productFailure(error) {
  if (error?.code === "provider_payment_required") return { code: error.code, message: "The model provider requires account credit or billing action. Ask the account owner to resolve billing, or select another authorized model before retrying.", retryable: false };
  return { code: error?.code ?? "workflow_execution_failed", message: "The workflow could not complete.", retryable: false };
}
function runWorkspaceId(run) {
  return run?.workspaceId ?? null;
}
function runRequestedBy(run) {
  return run?.requestedBy ?? null;
}
function productCommandStatusForRun(status) {
  if (status === "queued") return "accepted";
  if (["running", "waiting_review", "paused"].includes(status)) return "running";
  if (status === "cancellation_requested") return "cancellation_requested";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (["partial", "effect_outcome_unknown"].includes(status)) return "blocked";
  return "failed";
}
function requiredId(value, code) { if (typeof value !== "string" || value.length === 0) throw new WorkflowRunnerError(code); }
function normalizeCommandAuthority(value) {
  if (value == null) return null;
  if (value.actorPrincipalKind !== "scheduler"
    || value.effectivePrincipalKind !== "automation") {
    throw new WorkflowRunnerError("run_command_authority_kind_invalid");
  }
  requiredId(value.actorPrincipalId, "run_command_actor_required");
  requiredId(value.effectivePrincipalId, "run_command_effective_principal_required");
  return Object.freeze({
    actorPrincipalId: value.actorPrincipalId,
    actorPrincipalKind: "scheduler",
    effectivePrincipalId: value.effectivePrincipalId,
    effectivePrincipalKind: "automation",
  });
}
function addMilliseconds(value, milliseconds) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new WorkflowRunnerError("runner_clock_invalid");
  return new Date(time + milliseconds).toISOString();
}
function leaseHeartbeatProvesLoss(error) {
  if (error?.code === "run_lease_lost") return true;
  return /workflow_run_(?:stale_lease_renewal|lease_renewal_target_invalid)/.test(String(error?.message));
}
function leaseTransitionHeadroom(leaseDurationMs) {
  return Math.min(2_000, Math.max(750, Math.floor(leaseDurationMs / 2)));
}
function runJobStatus(runStatus) {
  if (["completed", "failed", "cancelled", "partial", "effect_outcome_unknown"].includes(runStatus)) return runStatus;
  if (["waiting_review", "paused"].includes(runStatus)) return "paused";
  return "failed";
}
function cloneObject(value, code) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowRunnerError(code); return structuredClone(value); }
function cloneArray(value, code) { if (!Array.isArray(value)) throw new WorkflowRunnerError(code); return structuredClone(value); }
