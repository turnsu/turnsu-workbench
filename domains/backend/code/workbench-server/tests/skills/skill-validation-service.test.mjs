import assert from "node:assert/strict";
import test from "node:test";

import * as contracts from "../../../workbench-contracts/dist/index.js";
import {
  createSkillValidationService,
  SkillValidationServiceError,
} from "../../src/skills/skill-validation-service.mjs";
import { hashSkillPackageObject } from "../../src/skills/skill-package-format.mjs";

const PACKAGE_BYTES = Buffer.from("verified uploaded package bytes", "utf8");
const OBJECT_HASH = hashSkillPackageObject(PACKAGE_BYTES);
const PACKAGE_HASH = `sha256:${"b".repeat(64)}`;
const CONTENT_HASH = `sha256:${"c".repeat(64)}`;
const OTHER_HASH = `sha256:${"d".repeat(64)}`;
const STARTED_AT = "2026-07-13T01:00:00.000Z";
const COMPLETED_AT = "2026-07-13T01:00:01.000Z";

const BASE = Object.freeze({
  workspaceId: "workspace-alpha",
  skillId: "skill-uploaded",
  draftId: "draft-uploaded-3",
  draftRevision: 3,
  contentHash: CONTENT_HASH,
  uploadId: "upload-promoted-1",
  objectId: "object-promoted-1",
  objectHash: OBJECT_HASH,
  packageHash: PACKAGE_HASH,
  permissionAcknowledged: true,
});

const CASES = Object.freeze([
  {
    name: "First case",
    purpose: "Checks the first exact result.",
    input: { value: 1 },
    expectedOutput: { doubled: 2 },
    timeoutSeconds: 10,
  },
  {
    name: "Second case",
    purpose: "Checks the second exact result.",
    input: { value: 2 },
    expectedOutput: { doubled: 4 },
    timeoutSeconds: 10,
  },
]);

test("runTests verifies one promoted package, executes ordered cases sequentially, and persists contract-safe records", async () => {
  const activeExecutions = { count: 0, maximum: 0 };
  const executorCalls = [];
  const harness = makeHarness({
    execute: async (request) => {
      activeExecutions.count += 1;
      activeExecutions.maximum = Math.max(activeExecutions.maximum, activeExecutions.count);
      executorCalls.push(request);
      await Promise.resolve();
      activeExecutions.count -= 1;
      return { doubled: request.input.value * 2 };
    },
  });

  const records = await harness.service.runTests({
    ...BASE,
    testCases: CASES,
    testRunIds: ["test-run-1", "test-run-2"],
  });

  assert.deepEqual(records.map((record) => record.testRunId), ["test-run-1", "test-run-2"]);
  assert.deepEqual(records.map((record) => record.status), ["passed", "passed"]);
  assert.equal(activeExecutions.maximum, 1);
  assert.equal(harness.loaderCalls.length, 1);
  assert.deepEqual(executorCalls.map((call) => call.input), [{ value: 1 }, { value: 2 }]);
  assert.deepEqual(Object.keys(executorCalls[0]).sort(), [
    "input",
    "inspection",
    "objectHash",
    "objectId",
    "packageHash",
    "signal",
    "workspaceId",
  ]);
  assert.equal(executorCalls[0].workspaceId, BASE.workspaceId);
  assert.equal(executorCalls[0].objectId, BASE.objectId);
  assert.equal(executorCalls[0].objectHash, BASE.objectHash);
  assert.equal(executorCalls[0].packageHash, BASE.packageHash);
  assert.deepEqual(executorCalls[0].inspection, { status: "needs_review", contentHash: PACKAGE_HASH });
  assert.ok(records.every((record) => contracts.Check(contracts.SkillTestRunSchema, record)));
  assert.deepEqual(records[0], {
    schemaVersion: "workbench-v1",
    testRunId: "test-run-1",
    workspaceId: BASE.workspaceId,
    skillId: BASE.skillId,
    skillDraftId: BASE.draftId,
    packageHash: PACKAGE_HASH,
    contentHash: CONTENT_HASH,
    testCase: CASES[0],
    status: "passed",
    diagnostics: [],
    outputPreview: { doubled: 2 },
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
  });
  assertProductSafe(records);
  assert.equal(harness.persistence.testRuns.size, 2);
});

test("runTests fails closed on package substitution and stale package inspection", async (t) => {
  await t.test("object bytes substitution", async () => {
    const harness = makeHarness({
      loadedPackage: { bytes: Buffer.from("substituted", "utf8") },
    });
    await assertRejectsCode(
      harness.service.runTests({ ...BASE, testCases: [CASES[0]], testRunIds: ["test-substituted"] }),
      "skill_package_substituted",
    );
    assert.equal(harness.executorCalls.length, 0);
    assert.equal(harness.persistence.testRuns.size, 0);
  });

  await t.test("stale inspection hash", async () => {
    const harness = makeHarness({
      loadedPackage: { inspection: { contentHash: OTHER_HASH } },
    });
    await assertRejectsCode(
      harness.service.runTests({ ...BASE, testCases: [CASES[0]], testRunIds: ["test-stale"] }),
      "skill_package_hash_mismatch",
    );
    assert.equal(harness.executorCalls.length, 0);
    assert.equal(harness.persistence.testRuns.size, 0);
  });
});

test("runTests uses exact whole-output assertions", async () => {
  const harness = makeHarness({ execute: async () => ({ doubled: 2, extra: true }) });
  const [record] = await harness.service.runTests({
    ...BASE,
    testCases: [CASES[0]],
    testRunIds: ["test-output-mismatch"],
  });

  assert.equal(record.status, "failed");
  assert.equal(record.diagnostics[0].code, "skill_test_output_mismatch");
  assert.deepEqual(record.outputPreview, { doubled: 2, extra: true });
  assert.equal(contracts.Check(contracts.SkillTestRunSchema, record), true);
});

test("trusted executor policy is copied at construction and never read from Skill output", async () => {
  const executorPolicy = safeRuntime();
  const harness = makeHarness({ executorPolicy });
  executorPolicy.isolated = false;
  executorPolicy.networkDenied = false;

  const [record] = await harness.service.runTests({
    ...BASE,
    testCases: [CASES[0]],
    testRunIds: ["test-frozen-policy"],
  });
  const stored = harness.persistence.testRuns.get("test-frozen-policy");

  assert.equal(record.status, "passed");
  assert.equal(stored.evidence.isolated, true);
  assert.equal(stored.evidence.networkDenied, true);
  assert.deepEqual(stored.evidence.runtimeSummary, {
    runtimeLabel: "Python 3.12",
    permissionSummary: "No network, workspace connections, or external actions.",
  });
});

test("runTests maps blocked, timeout, cancellation, and invalid executor output to product statuses", async (t) => {
  const scenarios = [
    {
      name: "blocked",
      execute: async () => { throw executorError("skill_execution_blocked"); },
      expectedStatus: "blocked",
      expectedCode: "skill_test_execution_blocked",
    },
    {
      name: "executor timeout",
      execute: async () => { throw executorError("skill_execution_timed_out"); },
      expectedStatus: "failed",
      expectedCode: "skill_test_timed_out",
    },
    {
      name: "executor cancellation",
      execute: async () => { throw executorError("skill_execution_cancelled"); },
      expectedStatus: "cancelled",
      expectedCode: "skill_test_cancelled",
    },
    {
      name: "invalid output",
      execute: async () => ["not", "an", "object"],
      expectedStatus: "failed",
      expectedCode: "skill_test_invalid_output",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const harness = makeHarness({ execute: scenario.execute });
      const [record] = await harness.service.runTests({
        ...BASE,
        testCases: [CASES[0]],
        testRunIds: [`test-${scenario.name.replaceAll(" ", "-")}`],
      });
      assert.equal(record.status, scenario.expectedStatus);
      assert.equal(record.diagnostics[0].code, scenario.expectedCode);
      assert.equal(record.outputPreview, null);
      assert.equal(contracts.Check(contracts.SkillTestRunSchema, record), true);
      assertProductSafe(record);
    });
  }

  await t.test("domain deadline aborts the isolated executor", async () => {
    const harness = makeHarness({
      execute: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(executorError("skill_execution_cancelled")), { once: true });
      }),
    });
    const [record] = await harness.service.runTests({
      ...BASE,
      testCases: [{ ...CASES[0], timeoutSeconds: 1 }],
      testRunIds: ["test-domain-timeout"],
    });
    assert.equal(record.status, "failed");
    assert.equal(record.diagnostics[0].code, "skill_test_timed_out");
  });

  await t.test("caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = makeHarness();
    const [record] = await harness.service.runTests({
      ...BASE,
      testCases: [CASES[0]],
      testRunIds: ["test-caller-cancelled"],
      signal: controller.signal,
    });
    assert.equal(record.status, "cancelled");
    assert.equal(record.diagnostics[0].code, "skill_test_cancelled");
    assert.equal(harness.executorCalls.length, 0);
  });
});

test("createValidation passes only exact persisted passed runs with safe runtime attestations", async () => {
  const harness = makeHarness();
  await harness.service.runTests({
    ...BASE,
    testCases: CASES,
    testRunIds: ["test-valid-1", "test-valid-2"],
  });

  const validation = await harness.service.createValidation({
    ...BASE,
    validationId: "validation-1",
    testRunIds: ["test-valid-1", "test-valid-2"],
  });

  assert.deepEqual(validation, {
    schemaVersion: "workbench-v1",
    validationId: "validation-1",
    workspaceId: BASE.workspaceId,
    skillId: BASE.skillId,
    skillDraftId: BASE.draftId,
    draftRevision: BASE.draftRevision,
    contentHash: CONTENT_HASH,
    testRunIds: ["test-valid-1", "test-valid-2"],
    permissionAcknowledged: true,
    status: "passed",
    diagnostics: [],
    runtimeSummary: {
      runtimeLabel: "Python 3.12",
      permissionSummary: "No network, workspace connections, or external actions.",
    },
    createdAt: STARTED_AT,
    completedAt: COMPLETED_AT,
  });
  assert.equal(contracts.Check(contracts.SkillValidationRecordSchema, validation), true);
  assertProductSafe(validation);
  assert.equal(harness.persistence.validations.size, 1);
  assert.equal(harness.loaderCalls.length, 2);
});

test("createValidation rejects missing acknowledgement and records failed or blocked evidence safely", async (t) => {
  await t.test("permission acknowledgement is explicit", async () => {
    const harness = makeHarness();
    await assertRejectsCode(
      harness.service.createValidation({
        ...BASE,
        permissionAcknowledged: false,
        validationId: "validation-no-ack",
        testRunIds: ["test-missing"],
      }),
      "skill_permission_acknowledgement_required",
    );
    assert.equal(harness.persistence.validations.size, 0);
  });

  const scenarios = [
    {
      name: "missing TestRun",
      mutate: () => {},
      testRunId: "test-missing",
      expectedStatus: "failed",
      expectedCode: "skill_test_run_missing",
    },
    {
      name: "failed TestRun",
      mutate: (entry) => { entry.record.status = "failed"; },
      expectedStatus: "failed",
      expectedCode: "skill_test_run_not_passed",
    },
    {
      name: "foreign TestRun",
      mutate: (entry) => { entry.record.workspaceId = "workspace-foreign"; },
      expectedStatus: "failed",
      expectedCode: "skill_test_run_foreign",
    },
    {
      name: "stale content hash",
      mutate: (entry) => { entry.record.contentHash = OTHER_HASH; },
      expectedStatus: "failed",
      expectedCode: "skill_test_run_stale",
    },
    {
      name: "unsafe runtime",
      mutate: (entry) => { entry.evidence.networkDenied = false; },
      expectedStatus: "blocked",
      expectedCode: "skill_test_runtime_unverified",
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async () => {
      const harness = makeHarness();
      const testRunId = scenario.testRunId ?? `test-evidence-${index}`;
      if (!scenario.testRunId) {
        await harness.service.runTests({
          ...BASE,
          testCases: [CASES[0]],
          testRunIds: [testRunId],
        });
        scenario.mutate(harness.persistence.testRuns.get(testRunId));
      }
      const validation = await harness.service.createValidation({
        ...BASE,
        validationId: `validation-negative-${index}`,
        testRunIds: [testRunId],
      });
      assert.equal(validation.status, scenario.expectedStatus);
      assert.equal(validation.diagnostics[0].code, scenario.expectedCode);
      assert.equal(contracts.Check(contracts.SkillValidationRecordSchema, validation), true);
      assertProductSafe(validation);
    });
  }
});

test("immutable IDs reject duplicate references and replay without executing or overwriting", async () => {
  const harness = makeHarness();

  await assertRejectsCode(
    harness.service.runTests({
      ...BASE,
      testCases: CASES,
      testRunIds: ["test-duplicate", "test-duplicate"],
    }),
    "skill_test_run_ids_duplicate",
  );
  assert.equal(harness.executorCalls.length, 0);

  await harness.service.runTests({
    ...BASE,
    testCases: [CASES[0]],
    testRunIds: ["test-immutable"],
  });
  await assertRejectsCode(
    harness.service.runTests({
      ...BASE,
      testCases: [CASES[0]],
      testRunIds: ["test-immutable"],
    }),
    "skill_test_run_replayed",
  );
  assert.equal(harness.executorCalls.length, 1);

  await assertRejectsCode(
    harness.service.createValidation({
      ...BASE,
      validationId: "validation-duplicates",
      testRunIds: ["test-immutable", "test-immutable"],
    }),
    "skill_test_run_ids_duplicate",
  );

  await harness.service.createValidation({
    ...BASE,
    validationId: "validation-immutable",
    testRunIds: ["test-immutable"],
  });
  await assertRejectsCode(
    harness.service.createValidation({
      ...BASE,
      validationId: "validation-immutable",
      testRunIds: ["test-immutable"],
    }),
    "skill_validation_replayed",
  );
  assert.equal(harness.persistence.validations.size, 1);
});

test("test case count and exact assertion inputs are bounded before package loading", async () => {
  const harness = makeHarness();
  await assertRejectsCode(
    harness.service.runTests({
      ...BASE,
      testCases: Array.from({ length: 21 }, () => CASES[0]),
      testRunIds: Array.from({ length: 21 }, (_, index) => `test-${index}`),
    }),
    "skill_test_cases_invalid",
  );
  const [withoutExactAssertion] = await harness.service.runTests({
    ...BASE,
    testCases: [{ ...CASES[0], expectedOutput: undefined }],
    testRunIds: ["test-no-assertion"],
  });
  assert.equal(withoutExactAssertion.status, "passed");
  assert.equal(harness.loaderCalls.length, 1);
});

function makeHarness({ execute, loadedPackage = {}, executorPolicy = safeRuntime() } = {}) {
  const persistence = new MemoryPersistence();
  const loaderCalls = [];
  const executorCalls = [];
  const packageLoader = {
    async loadPromotedPackage(request) {
      loaderCalls.push(request);
      return {
        workspaceId: BASE.workspaceId,
        uploadId: BASE.uploadId,
        objectId: BASE.objectId,
        state: "promoted",
        objectHash: OBJECT_HASH,
        packageHash: PACKAGE_HASH,
        bytes: PACKAGE_BYTES,
        inspection: { status: "needs_review", contentHash: PACKAGE_HASH },
        ...loadedPackage,
        inspection: {
          status: "needs_review",
          contentHash: PACKAGE_HASH,
          ...loadedPackage.inspection,
        },
      };
    },
  };
  const isolatedExecutor = {
    async execute(request) {
      executorCalls.push(request);
      return execute ? execute(request) : { doubled: request.input.value * 2 };
    },
  };
  return {
    service: createSkillValidationService({
      packageLoader,
      isolatedExecutor,
      persistence,
      executorPolicy,
      clock: sequenceClock(),
      setTimer: (callback) => setTimeout(callback, 5),
      clearTimer: clearTimeout,
    }),
    persistence,
    loaderCalls,
    executorCalls,
  };
}

class MemoryPersistence {
  testRuns = new Map();
  validations = new Map();

  async getTestRun({ testRunId }) {
    return this.testRuns.get(testRunId) ?? null;
  }

  async insertTestRun(entry) {
    if (this.testRuns.has(entry.record.testRunId)) throw new Error("duplicate_test_run");
    const stored = structuredClone(entry);
    this.testRuns.set(entry.record.testRunId, stored);
    return structuredClone(stored);
  }

  async getValidation({ validationId }) {
    return this.validations.get(validationId) ?? null;
  }

  async insertValidation(record) {
    if (this.validations.has(record.validationId)) throw new Error("duplicate_validation");
    const stored = structuredClone(record);
    this.validations.set(record.validationId, stored);
    return structuredClone(stored);
  }
}

function safeRuntime() {
  return {
    isolated: true,
    networkDenied: true,
    runtimeLabel: "Python 3.12",
    permissionSummary: "No network, workspace connections, or external actions.",
  };
}

function executorError(code) {
  return Object.assign(new Error("internal details must not escape"), { code });
}

function sequenceClock() {
  let call = 0;
  return () => (call++ % 2 === 0 ? STARTED_AT : COMPLETED_AT);
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (failure) => {
    assert.ok(failure instanceof SkillValidationServiceError);
    assert.equal(failure.code, code);
    assert.equal(failure.productSafe, true);
    return true;
  });
}

function assertProductSafe(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "imageDigest",
    "container",
    "packagePath",
    "provider",
    "tool",
    "environment",
    "objectId",
    "uploadId",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `record exposed ${forbidden}`);
  }
}
