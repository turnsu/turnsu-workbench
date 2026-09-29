import { isDeepStrictEqual } from "node:util";

import { hashSkillPackageObject } from "./skill-package-format.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEST_CASES = 20;
const MAX_JSON_BYTES = 256 * 1024;
const TERMINAL_TEST_STATUSES = new Set(["passed", "failed", "blocked", "cancelled"]);
const PUBLIC_RUNTIME_SUMMARY = Object.freeze({
  runtimeLabel: "Python 3.12",
  permissionSummary: "No network, workspace connections, or external actions.",
});

export class SkillValidationServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SkillValidationServiceError";
    this.code = code;
    this.productSafe = true;
  }
}

export function createSkillValidationService(options) {
  return new SkillValidationService(options);
}

// The persistence port stores immutable public records. TestRun entries pair the
// public record with private hash/isolation evidence used only by this domain.
export class SkillValidationService {
  #packageLoader;
  #persistence;
  #executorPolicy;
  #clock;

  constructor({
    packageLoader,
    persistence,
    executorPolicy,
    clock = () => new Date().toISOString(),
  } = {}) {
    if (!packageLoader?.loadPromotedPackage) {
      throw new TypeError("skill_validation_package_loader_required");
    }
    if (!persistence?.getTestRun
      || !persistence?.insertTestRun
      || !persistence?.getValidation
      || !persistence?.insertValidation) {
      throw new TypeError("skill_validation_persistence_required");
    }
    if (!isTrustedExecutorPolicy(executorPolicy)) {
      throw new TypeError("skill_validation_executor_policy_required");
    }
    if (typeof clock !== "function") {
      throw new TypeError("skill_validation_dependencies_invalid");
    }
    this.#packageLoader = packageLoader;
    this.#persistence = persistence;
    this.#executorPolicy = Object.freeze(structuredClone(executorPolicy));
    this.#clock = clock;
  }

  async acceptTestRun(input = {}) {
    const request = validateSingleTestIntakeRequest(input);
    const testRunId = request.testRunIds[0];
    const existing = await this.#persistence.getTestRun({
      workspaceId: request.workspaceId,
      testRunId,
    });
    if (existing) {
      throw serviceError("skill_test_run_replayed", "This Skill test run identifier has already been used.");
    }
    const record = {
      schemaVersion: "workbench-v1",
      testRunId,
      workspaceId: request.workspaceId,
      requestedBy: request.requestedBy ?? null,
      skillId: request.skillId,
      skillDraftId: request.draftId,
      packageHash: request.packageHash,
      contentHash: request.contentHash,
      testCase: structuredClone(request.testCases[0]),
      status: "queued",
      diagnostics: [],
      outputPreview: null,
      startedAt: null,
      completedAt: null,
      executionAttempt: 1,
    };
    const evidence = testEvidence(request, this.#executorPolicy);
    await this.#persistence.insertTestRun({ record, evidence });
    return publicTestRunRecord(record);
  }

  async startAcceptedTestRun({
    workspaceId,
    testRunId,
    expectedAttempt,
    expectedClaimOwner,
    expectedClaimFence,
    expectedClaimValidAt,
  } = {}) {
    if (typeof this.#persistence.transitionTestRun !== "function") {
      throw serviceError("skill_test_lifecycle_unavailable", "Skill test lifecycle persistence is unavailable.");
    }
    const startedAt = timestamp(this.#clock);
    const record = await this.#persistence.transitionTestRun({
      workspaceId,
      testRunId,
      expectedStatuses: ["queued"],
      expectedExecutionAttempt: expectedAttempt,
      expectedClaimOwner,
      expectedClaimFence,
      expectedClaimValidAt,
      patch: {
        status: "running",
        startedAt,
        completedAt: null,
      },
    });
    if (!record) {
      throw serviceError("skill_test_transition_conflict", "The Skill test could not be started from its current state.");
    }
    return publicTestRunRecord(record);
  }

  async prepareAcceptedTest(input = {}) {
    if (typeof this.#persistence.transitionTestRun !== "function") {
      throw serviceError("skill_test_lifecycle_unavailable", "Skill test lifecycle persistence is unavailable.");
    }
    const request = validateSingleTestRequest(input);
    const testRunId = request.testRunIds[0];
    const existing = await this.#persistence.getTestRun({
      workspaceId: request.workspaceId,
      testRunId,
    });
    if (!sameAcceptedTest(existing, request, this.#executorPolicy)) {
      throw serviceError("skill_test_run_identity_mismatch", "The accepted Skill test does not match this execution request.");
    }
    if (existing.record.status !== "running") {
      throw serviceError("skill_test_transition_conflict", "The Skill test is not running.");
    }
    const loadedPackage = await this.#loadAndVerifyPackage(request);
    return Object.freeze({
      testRunId,
      startedAt: existing.record.startedAt,
      inspection: structuredClone(loadedPackage.inspection),
      executorPolicy: structuredClone(this.#executorPolicy),
    });
  }

  classifyAcceptedTestOutcome(input = {}, {
    result,
    failure,
    timedOut = false,
    callerCancelled = false,
    startedAt = null,
  } = {}) {
    const request = validateSingleTestRequest(input);
    const testRunId = request.testRunIds[0];
    const testCase = request.testCases[0];
    const outcome = classifyTestOutcome({
      result,
      failure,
      expectedOutput: testCase.expectedOutput,
      timedOut,
      callerCancelled,
    });
    return {
      schemaVersion: "workbench-v1",
      testRunId,
      workspaceId: request.workspaceId,
      skillId: request.skillId,
      skillDraftId: request.draftId,
      packageHash: request.packageHash,
      contentHash: request.contentHash,
      testCase: structuredClone(testCase),
      status: outcome.status,
      diagnostics: outcome.diagnostics,
      outputPreview: outcome.outputPreview,
      startedAt,
      completedAt: timestamp(this.#clock),
    };
  }

  classifyPersistedAcceptedTestOutcome(record, {
    result,
    failure,
    timedOut = false,
    callerCancelled = false,
    startedAt = record?.startedAt ?? null,
  } = {}) {
    if (!record || typeof record.testRunId !== "string" || typeof record.workspaceId !== "string"
      || typeof record.skillId !== "string" || typeof record.skillDraftId !== "string"
      || !record.testCase) {
      throw serviceError("skill_test_run_identity_mismatch", "The persisted Skill test identity is invalid.");
    }
    const outcome = classifyTestOutcome({
      result,
      failure,
      expectedOutput: record.testCase.expectedOutput,
      timedOut,
      callerCancelled,
    });
    return {
      schemaVersion: "workbench-v1",
      testRunId: record.testRunId,
      workspaceId: record.workspaceId,
      skillId: record.skillId,
      skillDraftId: record.skillDraftId,
      packageHash: record.packageHash,
      contentHash: record.contentHash,
      testCase: structuredClone(record.testCase),
      status: outcome.status,
      diagnostics: outcome.diagnostics,
      outputPreview: outcome.outputPreview,
      startedAt,
      completedAt: timestamp(this.#clock),
    };
  }

  async settleAcceptedTestRun({
    workspaceId,
    testRunId,
    expectedAttempt,
    expectedClaimOwner,
    expectedClaimFence,
    expectedClaimValidAt,
    expectedStatuses = ["running"],
    outcome,
  } = {}) {
    if (typeof this.#persistence.transitionTestRun !== "function") {
      throw serviceError("skill_test_lifecycle_unavailable", "Skill test lifecycle persistence is unavailable.");
    }
    if (!Array.isArray(expectedStatuses)
      || expectedStatuses.length === 0
      || expectedStatuses.some((status) => !["queued", "running"].includes(status))
      || !TERMINAL_TEST_STATUSES.has(outcome?.status)
      || outcome?.testRunId !== testRunId
      || outcome?.workspaceId !== workspaceId) {
      throw serviceError("skill_test_outcome_invalid", "The Skill test terminal outcome is invalid.");
    }
    const record = await this.#persistence.transitionTestRun({
      workspaceId,
      testRunId,
      expectedStatuses,
      expectedExecutionAttempt: Number.isSafeInteger(expectedAttempt) ? expectedAttempt : undefined,
      expectedClaimOwner,
      expectedClaimFence,
      expectedClaimValidAt,
      patch: outcome,
    });
    if (!record) {
      throw serviceError("skill_test_transition_conflict", "The Skill test result was rejected by its lifecycle fence.");
    }
    return publicTestRunRecord(record);
  }

  blockedAcceptedTestOutcome({
    workspaceId,
    testRunId,
    skillId,
    skillDraftId,
    packageHash,
    contentHash,
    testCase,
    startedAt = null,
    code = "skill_test_execution_blocked",
  } = {}) {
    return {
      schemaVersion: "workbench-v1",
      testRunId,
      workspaceId,
      skillId,
      skillDraftId,
      packageHash,
      contentHash,
      testCase: structuredClone(testCase),
      status: "blocked",
      diagnostics: [diagnostic(
        code,
        "The Skill test could not run through the governed execution path.",
        "Check runtime readiness and run the test again.",
      )],
      outputPreview: null,
      startedAt,
      completedAt: timestamp(this.#clock),
    };
  }

  cancelledAcceptedTestOutcome({
    workspaceId,
    testRunId,
    skillId,
    skillDraftId,
    packageHash,
    contentHash,
    testCase,
    startedAt = null,
  } = {}) {
    return {
      schemaVersion: "workbench-v1",
      testRunId,
      workspaceId,
      skillId,
      skillDraftId,
      packageHash,
      contentHash,
      testCase: structuredClone(testCase),
      status: "cancelled",
      diagnostics: [diagnostic(
        "skill_test_cancelled",
        "The Skill test was cancelled.",
        "Run the test again when ready.",
      )],
      outputPreview: null,
      startedAt,
      completedAt: timestamp(this.#clock),
    };
  }

  async requeueAcceptedTestRun({
    workspaceId,
    testRunId,
    expectedAttempt,
    nextAttempt,
    expectedClaimOwner,
    expectedClaimFence,
    expectedClaimValidAt,
  } = {}) {
    if (typeof this.#persistence.transitionTestRun !== "function") {
      throw serviceError("skill_test_lifecycle_unavailable", "Skill test lifecycle persistence is unavailable.");
    }
    if (!Number.isSafeInteger(expectedAttempt) || !Number.isSafeInteger(nextAttempt)
      || expectedAttempt < 1 || nextAttempt !== expectedAttempt + 1) {
      throw serviceError("skill_test_attempt_invalid", "The Skill test recovery attempt is invalid.");
    }
    const record = await this.#persistence.transitionTestRun({
      workspaceId,
      testRunId,
      expectedStatuses: ["running"],
      expectedExecutionAttempt: expectedAttempt,
      expectedClaimOwner,
      expectedClaimFence,
      expectedClaimValidAt,
      patch: {
        status: "queued",
        executionAttempt: nextAttempt,
        diagnostics: [],
        outputPreview: null,
        startedAt: null,
        completedAt: null,
      },
    });
    if (!record) {
      throw serviceError("skill_test_transition_conflict", "The Skill test recovery attempt lost its lifecycle fence.");
    }
    return publicTestRunRecord(record);
  }

  async blockAcceptedTestRun({ workspaceId, testRunId, code = "skill_test_execution_blocked" } = {}) {
    if (typeof this.#persistence.transitionTestRun !== "function") {
      throw serviceError("skill_test_lifecycle_unavailable", "Skill test lifecycle persistence is unavailable.");
    }
    const record = await this.#persistence.transitionTestRun({
      workspaceId,
      testRunId,
      expectedStatuses: ["queued", "running"],
      patch: {
        status: "blocked",
        diagnostics: [diagnostic(
          code,
          "The Skill test could not run through the governed execution path.",
          "Check runtime readiness and run the test again.",
        )],
        outputPreview: null,
        completedAt: timestamp(this.#clock),
      },
    });
    if (!record) {
      throw serviceError("skill_test_transition_conflict", "The Skill test failure could not be settled.");
    }
    return publicTestRunRecord(record);
  }

  async createValidation(input = {}) {
    const request = validateValidationRequest(input);
    const existing = await this.#persistence.getValidation({
      workspaceId: request.workspaceId,
      validationId: request.validationId,
    });
    if (existing) {
      throw serviceError("skill_validation_replayed", "This Skill validation identifier has already been used.");
    }

    await this.#loadAndVerifyPackage(request);
    const diagnostics = [];
    const safeRuntimeSummaries = [];
    let blocked = false;

    for (const testRunId of request.testRunIds) {
      const entry = await this.#persistence.getTestRun({
        workspaceId: request.workspaceId,
        testRunId,
      });
      if (!entry?.record) {
        diagnostics.push(diagnostic(
          "skill_test_run_missing",
          "A referenced Skill test run could not be found.",
          "Run the test again for this exact draft.",
        ));
        continue;
      }
      if (!sameOwner(entry.record, request)) {
        diagnostics.push(diagnostic(
          "skill_test_run_foreign",
          "A referenced Skill test run belongs to a different Skill draft.",
          "Select test runs created for this workspace and draft.",
        ));
        continue;
      }
      if (!sameContent(entry, request)) {
        diagnostics.push(diagnostic(
          "skill_test_run_stale",
          "A referenced Skill test run does not match the current package or draft content.",
          "Run every test again against the promoted package.",
        ));
        continue;
      }
      if (entry.record.status !== "passed") {
        diagnostics.push(diagnostic(
          "skill_test_run_not_passed",
          "Every referenced Skill test run must pass before validation.",
          "Resolve the failed test and run it again.",
        ));
        continue;
      }
      if (!hasSafeRuntimeAttestation(entry.evidence)) {
        blocked = true;
        diagnostics.push(diagnostic(
          "skill_test_runtime_unverified",
          "The Skill test does not prove isolated execution with network access denied.",
          "Run the test again with the isolated executor.",
        ));
        continue;
      }
      safeRuntimeSummaries.push(publicRuntimeSummary(entry.evidence.runtimeSummary));
    }

    if (diagnostics.length === 0
      && !runtimeSummariesAgree(safeRuntimeSummaries, request.testRunIds.length)) {
      blocked = true;
      diagnostics.push(diagnostic(
        "skill_test_runtime_unverified",
        "The referenced Skill tests do not share one verified isolated runtime profile.",
        "Run every test again with the same isolated executor profile.",
      ));
    }

    const now = timestamp(this.#clock);
    const record = {
      schemaVersion: "workbench-v1",
      validationId: request.validationId,
      workspaceId: request.workspaceId,
      skillId: request.skillId,
      skillDraftId: request.draftId,
      draftRevision: request.draftRevision,
      contentHash: request.contentHash,
      testRunIds: [...request.testRunIds],
      permissionAcknowledged: true,
      status: diagnostics.length === 0 ? "passed" : blocked ? "blocked" : "failed",
      diagnostics,
      runtimeSummary: safeRuntimeSummaries[0] ?? { ...PUBLIC_RUNTIME_SUMMARY },
      createdAt: now,
      completedAt: timestamp(this.#clock),
    };
    await this.#persistence.insertValidation(record);
    return structuredClone(record);
  }

  async #loadAndVerifyPackage(request) {
    let loaded;
    try {
      loaded = await this.#packageLoader.loadPromotedPackage({
        workspaceId: request.workspaceId,
        uploadId: request.uploadId,
        objectId: request.objectId,
        objectHash: request.objectHash,
        packageHash: request.packageHash,
        signal: request.signal,
      });
    } catch {
      throw serviceError(
        "skill_package_unavailable",
        "The promoted Skill package is unavailable for validation.",
      );
    }
    if (!loaded
      || loaded.workspaceId !== request.workspaceId
      || loaded.uploadId !== request.uploadId
      || loaded.objectId !== request.objectId
      || loaded.state !== "promoted") {
      throw serviceError(
        "skill_package_not_promoted",
        "The selected Skill package is not the promoted package for this draft.",
      );
    }
    if (!Buffer.isBuffer(loaded.bytes)
      || loaded.objectHash !== request.objectHash
      || hashSkillPackageObject(loaded.bytes) !== request.objectHash) {
      throw serviceError(
        "skill_package_substituted",
        "The promoted Skill package bytes do not match the selected object.",
      );
    }
    if (loaded.packageHash !== request.packageHash
      || !isPlainObject(loaded.inspection)
      || loaded.inspection.contentHash !== request.packageHash) {
      throw serviceError(
        "skill_package_hash_mismatch",
        "The promoted Skill package inspection does not match the selected package hash.",
      );
    }
    return {
      bytes: loaded.bytes,
      inspection: structuredClone(loaded.inspection),
    };
  }

}

function validateTestRequest(input, { requireResolvedMaterials = true } = {}) {
  const request = validateCommonRequest(input);
  if (!Array.isArray(input.testCases)
    || input.testCases.length < 1
    || input.testCases.length > MAX_TEST_CASES) {
    throw serviceError("skill_test_cases_invalid", `Provide between 1 and ${MAX_TEST_CASES} Skill test cases.`);
  }
  if (!Array.isArray(input.testRunIds) || input.testRunIds.length !== input.testCases.length) {
    throw serviceError("skill_test_run_ids_invalid", "Provide one immutable test run identifier per test case.");
  }
  const testRunIds = validateTestRunIds(input.testRunIds);
  const testCases = input.testCases.map(validateTestCase);
  if (!requireResolvedMaterials) {
    return {
      ...request,
      testCases,
      testRunIds,
      resolvedMaterialsByTestCase: testCases.map(() => []),
    };
  }
  const suppliedMaterials = input.resolvedMaterialsByTestCase
    ?? testCases.map(() => []);
  if (
    !Array.isArray(suppliedMaterials)
    || suppliedMaterials.length !== testCases.length
  ) {
    throw serviceError("skill_material_bindings_invalid", "Resolve materials for every Skill test case.");
  }
  const resolvedMaterialsByTestCase = suppliedMaterials.map(
    (materials, index) => validateResolvedMaterials(materials, testCases[index]),
  );
  return { ...request, testCases, testRunIds, resolvedMaterialsByTestCase };
}

function validateSingleTestRequest(input) {
  const request = validateTestRequest(input);
  if (request.testCases.length !== 1 || request.testRunIds.length !== 1) {
    throw serviceError("skill_test_single_run_required", "Create and execute one immutable Skill test target at a time.");
  }
  return request;
}

function validateSingleTestIntakeRequest(input) {
  const request = validateTestRequest(input, { requireResolvedMaterials: false });
  if (request.testCases.length !== 1 || request.testRunIds.length !== 1) {
    throw serviceError("skill_test_single_run_required", "Create and execute one immutable Skill test target at a time.");
  }
  return request;
}

function testEvidence(request, executorPolicy) {
  return {
    workspaceId: request.workspaceId,
    skillId: request.skillId,
    skillDraftId: request.draftId,
    draftRevision: request.draftRevision,
    uploadId: request.uploadId,
    objectId: request.objectId,
    objectHash: request.objectHash,
    packageHash: request.packageHash,
    contentHash: request.contentHash,
    isolated: executorPolicy?.isolated === true,
    networkDenied: executorPolicy?.networkDenied === true,
    runtimeSummary: executorPolicy ? publicRuntimeSummary(executorPolicy) : null,
  };
}

function sameAcceptedTest(entry, request, executorPolicy) {
  return Boolean(entry?.record && entry?.evidence)
    && sameOwner(entry.record, request)
    && sameContent(entry, request)
    && entry.record.testRunId === request.testRunIds[0]
    && isDeepStrictEqual(entry.record.testCase, request.testCases[0])
    && entry.evidence.isolated === (executorPolicy?.isolated === true)
    && entry.evidence.networkDenied === (executorPolicy?.networkDenied === true)
    && isDeepStrictEqual(entry.evidence.runtimeSummary, publicRuntimeSummary(executorPolicy));
}

function validateValidationRequest(input) {
  const request = validateCommonRequest(input);
  if (!STABLE_ID.test(input.validationId || "")) {
    throw serviceError("skill_validation_id_invalid", "Provide a valid immutable Skill validation identifier.");
  }
  if (!Array.isArray(input.testRunIds)
    || input.testRunIds.length < 1
    || input.testRunIds.length > MAX_TEST_CASES) {
    throw serviceError("skill_test_run_ids_invalid", "Provide the bounded Skill test run references.");
  }
  return {
    ...request,
    validationId: input.validationId,
    testRunIds: validateTestRunIds(input.testRunIds),
  };
}

function validateCommonRequest(input) {
  for (const key of ["workspaceId", "skillId", "draftId", "uploadId", "objectId"]) {
    if (!STABLE_ID.test(input[key] || "")) {
      throw serviceError("skill_validation_reference_invalid", "A Skill validation reference is invalid.");
    }
  }
  for (const key of ["contentHash", "objectHash", "packageHash"]) {
    if (!SHA256.test(input[key] || "")) {
      throw serviceError("skill_validation_hash_invalid", "A required exact content hash is invalid.");
    }
  }
  if (!Number.isSafeInteger(input.draftRevision) || input.draftRevision < 1) {
    throw serviceError("skill_draft_revision_invalid", "The Skill draft revision is invalid.");
  }
  if (input.requestedBy !== undefined && !STABLE_ID.test(input.requestedBy || "")) {
    throw serviceError("skill_validation_reference_invalid", "The Skill validation requester is invalid.");
  }
  if (input.permissionAcknowledged !== true) {
    throw serviceError(
      "skill_permission_acknowledgement_required",
      "Acknowledge the reviewed Skill permissions before testing or validation.",
    );
  }
  if (input.signal !== undefined && !isAbortSignal(input.signal)) {
    throw serviceError("skill_validation_signal_invalid", "The Skill validation cancellation signal is invalid.");
  }
  return {
    workspaceId: input.workspaceId,
    ...(input.requestedBy === undefined ? {} : { requestedBy: input.requestedBy }),
    skillId: input.skillId,
    draftId: input.draftId,
    draftRevision: input.draftRevision,
    contentHash: input.contentHash,
    uploadId: input.uploadId,
    objectId: input.objectId,
    objectHash: input.objectHash,
    packageHash: input.packageHash,
    permissionAcknowledged: true,
    signal: input.signal,
  };
}

function validateTestRunIds(values) {
  if (!values.every((value) => STABLE_ID.test(value || ""))) {
    throw serviceError("skill_test_run_ids_invalid", "A Skill test run identifier is invalid.");
  }
  if (new Set(values).size !== values.length) {
    throw serviceError("skill_test_run_ids_duplicate", "Skill test run identifiers must be unique.");
  }
  return [...values];
}

function validateTestCase(value) {
  if (!isPlainObject(value)
    || !hasOnlyKeys(value, [
      "name",
      "purpose",
      "input",
      "expectedOutput",
      "timeoutSeconds",
      "materialBindings",
      "connectionBindings",
    ])
    || !boundedText(value.name, 200)
    || !boundedText(value.purpose, 2_000)
    || !isPlainJsonObject(value.input)
    || (value.expectedOutput !== undefined && !isPlainJsonObject(value.expectedOutput))
    || !Number.isSafeInteger(value.timeoutSeconds)
    || value.timeoutSeconds < 1
    || value.timeoutSeconds > 120
    || jsonBytes(value.input) > MAX_JSON_BYTES
    || (value.expectedOutput !== undefined && jsonBytes(value.expectedOutput) > MAX_JSON_BYTES)
    || !validMaterialBindingRefs(value.materialBindings ?? [])
    || !validConnectionBindingRefs(value.connectionBindings ?? [])) {
    throw serviceError(
      "skill_test_case_invalid",
      "Each Skill test case requires bounded object input, an optional exact expected output, and a 1-120 second timeout.",
    );
  }
  return structuredClone(value);
}

function validConnectionBindingRefs(bindings) {
  return Array.isArray(bindings)
    && bindings.length <= 32
    && new Set(bindings.map((binding) => binding?.requirementId)).size === bindings.length
    && bindings.every((binding) => (
      STABLE_ID.test(binding?.requirementId || "")
      && STABLE_ID.test(binding?.connectionId || "")
    ));
}

function validMaterialBindingRefs(bindings) {
  return Array.isArray(bindings)
    && bindings.length <= 32
    && new Set(bindings.map((binding) => binding?.materialKey)).size === bindings.length
    && bindings.every((binding) => (
      STABLE_ID.test(binding?.materialKey || "")
      && ["attachment", "workspace_resource"].includes(binding?.source?.kind)
    ));
}

function validateResolvedMaterials(materials, testCase) {
  if (!Array.isArray(materials) || materials.length !== (testCase.materialBindings ?? []).length) {
    throw serviceError("skill_material_bindings_invalid", "Every declared Skill material must resolve exactly once.");
  }
  const requested = new Map((testCase.materialBindings ?? []).map((binding) => [
    binding.materialKey,
    binding.source.kind,
  ]));
  const seen = new Set();
  for (const material of materials) {
    if (
      !isPlainObject(material)
      || !requested.has(material.materialKey)
      || requested.get(material.materialKey) !== material.kind
      || seen.has(material.materialKey)
      || !Buffer.isBuffer(material.bytes)
      || material.bytes.byteLength < 1
      || material.bytes.byteLength > 16 * 1024 * 1024
      || !SHA256.test(material.contentHash || "")
      || typeof material.mediaType !== "string"
      || material.mediaType.length > 128
      || (
        material.contextText !== null
        && material.contextText !== undefined
        && (typeof material.contextText !== "string" || material.contextText.length > 120_000)
      )
    ) {
      throw serviceError("skill_material_bindings_invalid", "A resolved Skill material is invalid or stale.");
    }
    seen.add(material.materialKey);
  }
  return materials.map(cloneResolvedMaterial);
}

function cloneResolvedMaterial(material) {
  return {
    materialKey: material.materialKey,
    kind: material.kind,
    mediaType: material.mediaType,
    contentHash: material.contentHash,
    bytes: Buffer.from(material.bytes),
    contextText: material.contextText ?? null,
  };
}

function publicTestRunRecord(record) {
  const value = structuredClone(record);
  for (const field of [
    "requestedBy",
    "executionAttempt",
    "runnerClaimOwner",
    "runnerClaimFence",
    "runnerClaimExpiresAt",
    "settlementFailureCode",
    "settlementRetryAt",
  ]) delete value[field];
  return value;
}

function classifyTestOutcome({ result, failure, expectedOutput, timedOut, callerCancelled }) {
  if (timedOut || failure?.code === "skill_execution_timed_out") {
    return failedOutcome("skill_test_timed_out", "The Skill test exceeded its time limit.");
  }
  if (callerCancelled || failure?.code === "skill_execution_cancelled") {
    return {
      status: "cancelled",
      diagnostics: [diagnostic("skill_test_cancelled", "The Skill test was cancelled.", "Run the test again when ready.")],
      outputPreview: null,
    };
  }
  if (failure) {
    const providerMessage = {
      provider_auth_failed: "The model credentials were rejected. Update the model connection and retry.",
      provider_payment_required: "The model provider requires account credit or billing action. Resolve billing or select another authorized model before retrying.",
      provider_rate_limited: "The model provider is busy. Wait briefly and retry.",
      provider_content_rejected: "The model provider rejected this input. Review the sample and retry.",
      provider_timeout: "The model provider timed out. Retry or choose another configured model.",
      provider_request_invalid: "The model provider rejected the request format. Check the model configuration.",
      provider_request_failed: "The model provider could not be reached. Check the connection and retry.",
      provider_response_invalid: "The model returned an unreadable response. Retry the test.",
      provider_response_too_large: "The model response was too large. Narrow the requested output.",
      model_cost_budget_exceeded: "The test exceeded its model budget. Narrow the sample and retry.",
    }[failure.code];
    if (providerMessage) return failedOutcome(failure.code, providerMessage);
    if (failure.code === "skill_execution_invalid_output"
      || failure.code === "skill_execution_output_limit"
      || failure.code === "execution_result_schema_mismatch"
      || failure.code === "prompt_skill_output_invalid"
      || failure.code === "prompt_skill_output_truncated") {
      return failedOutcome("skill_test_invalid_output", "The Skill returned an invalid or oversized result.");
    }
    return {
      status: "blocked",
      diagnostics: [diagnostic(
        "skill_test_execution_blocked",
        "The Skill could not run in the isolated test runtime.",
        "Check the package runtime and try again.",
      )],
      outputPreview: null,
    };
  }
  if (!isPlainJsonObject(result) || jsonBytes(result) > MAX_JSON_BYTES) {
    return failedOutcome("skill_test_invalid_output", "The Skill returned an invalid or unverifiable result.");
  }
  if (expectedOutput !== undefined && !isDeepStrictEqual(result, expectedOutput)) {
    return {
      status: "failed",
      diagnostics: [diagnostic(
        "skill_test_output_mismatch",
        "The Skill result did not exactly match the expected output.",
        "Review the expected output or update the Skill package.",
      )],
      outputPreview: structuredClone(result),
    };
  }
  return { status: "passed", diagnostics: [], outputPreview: structuredClone(result) };
}

function failedOutcome(code, message) {
  return {
    status: "failed",
    diagnostics: [diagnostic(code, message, "Review the test result and run it again.")],
    outputPreview: null,
  };
}

function sameOwner(record, request) {
  return record.workspaceId === request.workspaceId
    && record.skillId === request.skillId
    && record.skillDraftId === request.draftId;
}

function sameContent(entry, request) {
  const { record, evidence } = entry;
  return record.packageHash === request.packageHash
    && record.contentHash === request.contentHash
    && evidence?.workspaceId === request.workspaceId
    && evidence?.skillId === request.skillId
    && evidence?.skillDraftId === request.draftId
    && evidence?.draftRevision === request.draftRevision
    && evidence?.uploadId === request.uploadId
    && evidence?.objectId === request.objectId
    && evidence?.objectHash === request.objectHash
    && evidence?.packageHash === request.packageHash
    && evidence?.contentHash === request.contentHash;
}

function hasSafeRuntimeAttestation(evidence) {
  return evidence?.isolated === true
    && evidence?.networkDenied === true
    && isPublicRuntimeSummary(evidence.runtimeSummary);
}

function isTrustedExecutorPolicy(value) {
  return isPlainObject(value)
    && hasOnlyKeys(value, ["isolated", "networkDenied", "runtimeLabel", "permissionSummary"])
    && value.isolated === true
    && value.networkDenied === true
    && isPublicRuntimeSummary(value);
}

function isPublicRuntimeSummary(value) {
  return isPlainObject(value)
    && boundedText(value.runtimeLabel, 100)
    && boundedText(value.permissionSummary, 1_000);
}

function publicRuntimeSummary(value) {
  return {
    runtimeLabel: value.runtimeLabel,
    permissionSummary: value.permissionSummary,
  };
}

function runtimeSummariesAgree(summaries, expectedCount) {
  return summaries.length === expectedCount
    && summaries.length > 0
    && summaries.every((summary) => isDeepStrictEqual(summary, summaries[0]));
}

function diagnostic(code, message, recoveryAction) {
  return { code, message, severity: "error", recoveryAction };
}

function timestamp(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : String(value);
}

function isAbortSignal(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function isPlainJsonObject(value) {
  if (!isPlainObject(value)) return false;
  try {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(value)), value);
  } catch {
    return false;
  }
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function serviceError(code, message) {
  return new SkillValidationServiceError(code, message);
}
