import { isDeepStrictEqual } from "node:util";

import { hashSkillPackageObject } from "./skill-package-format.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_TEST_CASES = 20;
const MAX_JSON_BYTES = 256 * 1024;
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
  #isolatedExecutor;
  #persistence;
  #executorPolicy;
  #clock;
  #setTimer;
  #clearTimer;

  constructor({
    packageLoader,
    isolatedExecutor,
    persistence,
    executorPolicy,
    clock = () => new Date().toISOString(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (!packageLoader?.loadPromotedPackage) {
      throw new TypeError("skill_validation_package_loader_required");
    }
    if (!isolatedExecutor?.execute) {
      throw new TypeError("skill_validation_isolated_executor_required");
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
    if (typeof clock !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function") {
      throw new TypeError("skill_validation_dependencies_invalid");
    }
    this.#packageLoader = packageLoader;
    this.#isolatedExecutor = isolatedExecutor;
    this.#persistence = persistence;
    this.#executorPolicy = Object.freeze(structuredClone(executorPolicy));
    this.#clock = clock;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  async runTests(input = {}) {
    const request = validateTestRequest(input);
    for (const testRunId of request.testRunIds) {
      const existing = await this.#persistence.getTestRun({
        workspaceId: request.workspaceId,
        testRunId,
      });
      if (existing) {
        throw serviceError("skill_test_run_replayed", "This Skill test run identifier has already been used.");
      }
    }

    const loadedPackage = await this.#loadAndVerifyPackage(request);
    const records = [];
    for (let index = 0; index < request.testCases.length; index += 1) {
      const entry = await this.#runTestCase({
        request,
        loadedPackage,
        testCase: request.testCases[index],
        testRunId: request.testRunIds[index],
      });
      await this.#persistence.insertTestRun(entry);
      records.push(structuredClone(entry.record));
    }
    return records;
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

  async #runTestCase({ request, loadedPackage, testCase, testRunId }) {
    const startedAt = timestamp(this.#clock);
    let result;
    let failure;
    let timedOut = false;
    let callerCancelled = request.signal?.aborted === true;
    let runtimeSummary = null;

    if (!callerCancelled) {
      const controller = new AbortController();
      const onCallerAbort = () => {
        callerCancelled = true;
        controller.abort(request.signal?.reason);
      };
      request.signal?.addEventListener("abort", onCallerAbort, { once: true });
      const timer = this.#setTimer(() => {
        timedOut = true;
        controller.abort(serviceError("skill_test_timed_out", "The Skill test exceeded its time limit."));
      }, testCase.timeoutSeconds * 1_000);
      try {
        result = await this.#isolatedExecutor.execute({
          workspaceId: request.workspaceId,
          objectId: request.objectId,
          objectHash: request.objectHash,
          packageHash: request.packageHash,
          inspection: loadedPackage.inspection,
          input: structuredClone(testCase.input),
          signal: controller.signal,
        });
      } catch (error) {
        failure = error;
      } finally {
        this.#clearTimer(timer);
        request.signal?.removeEventListener("abort", onCallerAbort);
      }
    }

    const outcome = classifyTestOutcome({
      result,
      failure,
      expectedOutput: testCase.expectedOutput,
      timedOut,
      callerCancelled,
    });
    runtimeSummary = this.#executorPolicy;
    const record = {
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
    return {
      record,
      evidence: {
        workspaceId: request.workspaceId,
        skillId: request.skillId,
        skillDraftId: request.draftId,
        draftRevision: request.draftRevision,
        uploadId: request.uploadId,
        objectId: request.objectId,
        objectHash: request.objectHash,
        packageHash: request.packageHash,
        contentHash: request.contentHash,
        isolated: runtimeSummary?.isolated === true,
        networkDenied: runtimeSummary?.networkDenied === true,
        runtimeSummary: runtimeSummary ? publicRuntimeSummary(runtimeSummary) : null,
      },
    };
  }
}

function validateTestRequest(input) {
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
  return { ...request, testCases, testRunIds };
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
    || !hasOnlyKeys(value, ["name", "purpose", "input", "expectedOutput", "timeoutSeconds"])
    || !boundedText(value.name, 200)
    || !boundedText(value.purpose, 2_000)
    || !isPlainJsonObject(value.input)
    || (value.expectedOutput !== undefined && !isPlainJsonObject(value.expectedOutput))
    || !Number.isSafeInteger(value.timeoutSeconds)
    || value.timeoutSeconds < 1
    || value.timeoutSeconds > 120
    || jsonBytes(value.input) > MAX_JSON_BYTES
    || (value.expectedOutput !== undefined && jsonBytes(value.expectedOutput) > MAX_JSON_BYTES)) {
    throw serviceError(
      "skill_test_case_invalid",
      "Each Skill test case requires bounded object input, an optional exact expected output, and a 1-120 second timeout.",
    );
  }
  return structuredClone(value);
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
    if (failure.code === "skill_execution_invalid_output"
      || failure.code === "skill_execution_output_limit") {
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
    && value.runtimeLabel === PUBLIC_RUNTIME_SUMMARY.runtimeLabel
    && value.permissionSummary === PUBLIC_RUNTIME_SUMMARY.permissionSummary;
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
