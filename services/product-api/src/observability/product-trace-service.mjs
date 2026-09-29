const SCHEMA_VERSION = "workbench-v1";
const MAX_TRACE_RECORDS = 4096;

export class ProductTraceError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "ProductTraceError";
    this.code = code;
    this.details = details;
  }
}

export async function buildProductTrace({ store, productCommandId, userId, workspaceId } = {}) {
  requiredId(productCommandId, "product_command_id_required");
  requiredId(userId, "trace_user_id_required");
  requiredId(workspaceId, "trace_workspace_id_required");
  const repositories = store?.repositories;
  const commands = repository(repositories, "productCommands");
  const command = await commands.get({ commandId: productCommandId, workspaceId, userId });
  if (!command) {
    throw new ProductTraceError("product_trace_not_found", "Product trace not found.", { productCommandId });
  }

  const commandNodeId = nodeId("product_command", productCommandId);
  const nodes = [traceNode({
    kind: "product_command",
    entityId: productCommandId,
    parentNodeId: null,
    status: command.status,
    record: command,
  })];
  const realtimeCallNodeId = command.kind === "skill_creation_realtime_call"
    ? nodeId("realtime_call", command.turnId)
    : null;
  if (realtimeCallNodeId) nodes.push(traceNode({
    kind: "realtime_call",
    entityId: command.turnId,
    parentNodeId: commandNodeId,
    status: command.status,
    record: command,
  }));

  const [agentTurns, creationTurns, admissions, capacityLeases, invocations] = await Promise.all([
    list(repository(repositories, "agentTurns"), { productCommandId }),
    list(repository(repositories, "skillCreationTurns"), { productCommandId }),
    list(repository(repositories, "admissionWaiting"), { workspaceId, commandId: productCommandId }),
    list(repository(repositories, "capacityLeases"), { workspaceId, commandId: productCommandId }),
    list(repository(repositories, "executionInvocations"), {
      workspaceId,
      "request.lineage.productCommandId": productCommandId,
    }),
  ]);

  for (const turn of agentTurns) nodes.push(traceNode({
    kind: "agent_turn",
    entityId: turn.turnId,
    parentNodeId: commandNodeId,
    status: turn.status,
    record: turn,
  }));
  for (const turn of creationTurns) nodes.push(traceNode({
    kind: "skill_creation_turn",
    entityId: turn.turnId,
    parentNodeId: commandNodeId,
    status: turn.status,
    record: turn,
  }));
  for (const admission of admissions) nodes.push(traceNode({
    kind: "admission",
    entityId: admission.admissionId,
    parentNodeId: commandNodeId,
    status: admission.state,
    record: admission,
  }));
  for (const lease of capacityLeases) nodes.push(traceNode({
    kind: "capacity_lease",
    entityId: lease.capacityLeaseId,
    parentNodeId: nodeId("admission", lease.admissionId),
    status: lease.status,
    record: lease,
  }));
  for (const invocation of invocations) nodes.push(traceNode({
    kind: "invocation",
    entityId: invocation.invocationId,
    parentNodeId: invocation.request?.capacityAuthority?.admissionId
      ? nodeId("admission", invocation.request.capacityAuthority.admissionId)
      : commandNodeId,
    status: invocation.status,
    record: invocation,
  }));

  const invocationIds = [...new Set(invocations.map((item) => item.invocationId))];
  const turnIds = [...agentTurns, ...creationTurns].map((item) => item.turnId);
  const [attempts, effects, capabilityLeases, proposals, builderProposals, patches, realtimePatches, artifacts, transcriptArtifacts] = await Promise.all([
    listByAny(repository(repositories, "executionAttempts"), "invocationId", invocationIds),
    listByAny(repository(repositories, "externalEffectReceipts"), "invocationId", invocationIds, { workspaceId }),
    listByAny(repository(repositories, "capabilityLeases"), "invocationId", invocationIds, { workspaceId }),
    listByAny(repository(repositories, "agentObjectProposals"), "turnId", turnIds, { workspaceId }),
    list(repository(repositories, "builderProposals"), { workspaceId, productCommandId }),
    listByAny(repository(repositories, "skillCreationPatches"), "sourceTurnId", turnIds, { workspaceId }),
    list(repository(repositories, "skillCreationPatches"), { workspaceId, productCommandId }),
    listByAny(repository(repositories, "productArtifacts"), "invocationId", invocationIds, { workspaceId }),
    listByAny(repository(repositories, "workerTranscriptArtifacts"), "invocationId", invocationIds, { workspaceId }),
  ]);

  const realtimeExecutionInvocationId = realtimeCallNodeId
    && command.invocationId
    && invocations.some((item) => item.invocationId === command.invocationId)
    && attempts.some((item) => (
      item.invocationId === command.invocationId
      && (!command.attemptId || item.attemptId === command.attemptId)
    ))
    ? command.invocationId
    : null;

  for (const attempt of attempts) nodes.push(traceNode({
    kind: "execution_attempt",
    entityId: attempt.attemptId,
    parentNodeId: nodeId("invocation", attempt.invocationId),
    status: attempt.status,
    record: attempt,
  }));
  for (const effect of effects) nodes.push(traceNode({
    kind: "effect_receipt",
    entityId: effect.effectId,
    parentNodeId: nodeId("invocation", effect.invocationId),
    status: effect.status,
    record: effect,
  }));
  for (const lease of capabilityLeases) nodes.push(traceNode({
    kind: "capability_lease",
    entityId: lease.capabilityLeaseId,
    parentNodeId: nodeId("invocation", lease.invocationId),
    status: lease.status,
    record: lease,
  }));
  for (const proposal of proposals) nodes.push(traceNode({
    kind: "proposal",
    entityId: proposal.proposalId,
    parentNodeId: nodeId("agent_turn", proposal.turnId),
    status: proposal.status,
    record: proposal,
  }));
  for (const proposal of builderProposals) nodes.push(traceNode({
    kind: "proposal",
    entityId: proposal.proposalId,
    parentNodeId: commandNodeId,
    status: proposal.status,
    record: proposal,
  }));
  const uniquePatches = new Map(
    [...patches, ...realtimePatches].map((patch) => [patch.patchId, patch]),
  );
  for (const patch of uniquePatches.values()) {
    const isRealtimePatch = Boolean(
      realtimeCallNodeId
      && patch.productCommandId === productCommandId
      && patch.realtimeCallId === command.turnId,
    );
    const realtimePatchParentNodeId = realtimeExecutionInvocationId
      ? nodeId("invocation", realtimeExecutionInvocationId)
      : realtimeCallNodeId;
    const toolCallNodeId = patch.providerCallId
      ? nodeId("tool_call", patch.providerCallId)
      : null;
    if (toolCallNodeId) nodes.push(traceNode({
      kind: "tool_call",
      entityId: patch.providerCallId,
      parentNodeId: isRealtimePatch ? realtimePatchParentNodeId : commandNodeId,
      status: patch.status ?? "completed",
      record: patch,
    }));
    nodes.push(traceNode({
    kind: "proposal",
    entityId: patch.patchId,
    parentNodeId: toolCallNodeId
      ?? (isRealtimePatch ? realtimePatchParentNodeId : nodeId("skill_creation_turn", patch.sourceTurnId)),
    status: patch.status ?? "proposed",
    record: patch,
    }));
  }
  for (const artifact of artifacts) nodes.push(traceNode({
    kind: "artifact",
    entityId: artifact.artifactId,
    parentNodeId: nodeId("invocation", artifact.invocationId),
    status: artifact.state,
    record: artifact,
  }));
  for (const artifact of transcriptArtifacts) nodes.push(traceNode({
    kind: "artifact",
    entityId: artifact.transcriptArtifactId,
    parentNodeId: nodeId("invocation", artifact.invocationId),
    status: artifact.state,
    record: artifact,
  }));

  nodes.sort((left, right) => (
    left.occurredAt.localeCompare(right.occurredAt)
    || left.nodeId.localeCompare(right.nodeId)
  ));
  if (nodes.length > MAX_TRACE_RECORDS) {
    throw new ProductTraceError("product_trace_too_large", "Product trace exceeds the governed record limit.", {
      productCommandId,
      limit: MAX_TRACE_RECORDS,
    });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    productCommandId,
    workspaceId,
    nodes,
  };
}

function repository(repositories, name) {
  const value = repositories?.[name];
  if (!value) throw new ProductTraceError("product_trace_storage_unavailable", "Product trace storage is unavailable.", { repository: name });
  return value;
}

async function list(value, filter) {
  if (typeof value.listAllForReadModel !== "function") {
    throw new ProductTraceError(
      "product_trace_storage_unavailable",
      "Product trace storage cannot prove a complete result.",
    );
  }
  return value.listAllForReadModel(filter, { sort: { createdAt: 1 } });
}

async function listByAny(value, field, ids, base = {}) {
  if (ids.length === 0) return [];
  return list(value, { ...base, [field]: { $in: ids } });
}

function traceNode({ kind, entityId, parentNodeId, status, record }) {
  requiredId(entityId, "product_trace_entity_id_invalid");
  const occurredAt = record.createdAt
    ?? record.queuedAt
    ?? record.issuedAt
    ?? record.requestedAt
    ?? record.updatedAt;
  if (typeof occurredAt !== "string") {
    throw new ProductTraceError("product_trace_timestamp_invalid", "A traced record has no stable timestamp.", {
      kind,
      entityId,
    });
  }
  return {
    nodeId: nodeId(kind, entityId),
    kind,
    entityId,
    parentNodeId,
    status: String(status ?? "unknown").slice(0, 64),
    occurredAt,
  };
}

function nodeId(kind, entityId) {
  return `${kind}:${entityId}`;
}

function requiredId(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new ProductTraceError(code);
  }
}
