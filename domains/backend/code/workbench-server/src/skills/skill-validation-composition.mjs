import { createHash, randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";
import { acceptsMaterialMediaType } from "../attachments/material-media-types.mjs";
import { createSkillValidationService } from "./skill-validation-service.mjs";
import { parseSkillPackage } from "./skill-package-format.mjs";

export const UPLOADED_SKILL_EXECUTOR_POLICY = Object.freeze({
  isolated: true,
  networkDenied: true,
  runtimeLabel: "Isolated Skill runtime",
  permissionSummary: "No network, workspace connections, or external actions.",
});
export const PROMPT_TOOL_TEST_EXECUTOR_POLICY = Object.freeze({
  isolated: true,
  networkDenied: true,
  runtimeLabel: "Product Prompt Gateway",
  permissionSummary: "Pinned model route and exact Tool allowlist; external writes are denied during tests.",
});

export function createSkillValidationCoordinator(options) {
  return new SkillValidationCoordinator(options);
}

export class SkillValidationCoordinator {
  #store;
  #objectStore;
  #isolatedExecutor;
  #executorPolicy;
  #imageDigests;
  #clock;
  #idFactory;
  #ports;
  #promptRuntime = null;

  constructor({
    store,
    objectStore,
    isolatedExecutor = null,
    executorPolicy = UPLOADED_SKILL_EXECUTOR_POLICY,
    imageDigest,
    imageDigests,
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
    ports = null,
  } = {}) {
    if ((!ports && (!store?.connect || !store?.withTransaction))
      || (ports && (typeof ports.withTransaction !== "function"
        || typeof ports.persistenceFor !== "function"
        || typeof ports.loadPromotedPackage !== "function"
        || typeof ports.createValidation !== "function"))) {
      throw new TypeError("skill_validation_store_required");
    }
    if (!objectStore?.read || (isolatedExecutor !== null && !isolatedExecutor?.execute)) {
      throw new TypeError("skill_validation_runtime_required");
    }
    const configuredDigests = normalizeImageDigests(imageDigests, imageDigest);
    if ((isolatedExecutor === null) !== (configuredDigests.size === 0)) {
      throw new TypeError("skill_validation_image_digest_required");
    }
    this.#store = store;
    this.#objectStore = objectStore;
    this.#isolatedExecutor = isolatedExecutor;
    this.#executorPolicy = Object.freeze(structuredClone(executorPolicy));
    this.#imageDigests = configuredDigests;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#ports = ports;
  }

  prepareTestIntake(input, inspection) {
    validateCoordinatorTestInput(input);
    if (input.testCases.length !== 1 || input.testRunIds.length !== 1) {
      throw productError(
        "skill_test_single_run_required",
        "Create and execute one immutable Skill test target at a time.",
      );
    }
    if (!inspection || inspection.contentHash !== input.packageHash) {
      throw productError(
        "skill_package_hash_mismatch",
        "The promoted Skill package inspection does not match this draft.",
      );
    }
    validateMaterialBindingRequirements({ inspection, testCases: input.testCases });
    const promptTool = isPromptToolInspection(inspection);
    if (!promptTool && (!this.#isolatedExecutor || !this.#imageDigests.has(inspection.manifest?.runtime?.runtime))) {
      throw productError("skill_runtime_unavailable", "Configure the Skill's isolated script runtime before testing.");
    }
    return Object.freeze({
      promptTool,
      executorPolicy: promptTool
        ? PROMPT_TOOL_TEST_EXECUTOR_POLICY
        : uploadedRuntimePolicy(inspection),
    });
  }

  acceptTestRun(input, prepared, { session, uow } = {}) {
    const policy = preparedTestPolicy(prepared);
    return this.#service(uow ?? session, policy).acceptTestRun(input);
  }

  startAcceptedTestRun(input, prepared, { session, uow } = {}) {
    const policy = preparedTestPolicy(prepared);
    return this.#service(uow ?? session, policy).startAcceptedTestRun(input);
  }

  async prepareAcceptedTestExecution(input, prepared) {
    const policy = preparedTestPolicy(prepared);
    const accepted = await this.#service(null, policy).prepareAcceptedTest(input);
    validateMaterialRequirements({
      inspection: accepted.inspection,
      testCases: input.testCases,
      resolvedMaterialsByTestCase: input.resolvedMaterialsByTestCase,
    });
    if (isPromptToolInspection(accepted.inspection) !== prepared.promptTool) {
      throw productError("skill_test_run_identity_mismatch", "The accepted Skill test package changed before execution.");
    }
    const testRunId = input.testRunIds[0];
    const executionRef = testExecutionRef(input.packageHash, testRunId, prepared.promptTool);
    const executionIdentity = this.testExecutionIdentity(testRunId, input.executionAttempt ?? 1);
    return Object.freeze({
      workspaceId: input.workspaceId,
      requestedBy: input.requestedBy,
      skillId: input.skillId,
      draftId: input.draftId,
      testRunId,
      testCase: structuredClone(input.testCases[0]),
      promptTool: prepared.promptTool,
      ...executionIdentity,
      executionRef,
      inspection: structuredClone(accepted.inspection),
      input: structuredClone(input.testCases[0].input),
      resultSchema: structuredClone(input.outputSchema),
      startedAt: accepted.startedAt,
    });
  }

  classifyAcceptedTestOutcome(input, prepared, executionOutcome) {
    const policy = preparedTestPolicy(prepared);
    return this.#service(null, policy).classifyAcceptedTestOutcome(input, executionOutcome);
  }

  classifyPersistedAcceptedTestOutcome(record, executionOutcome) {
    return this.#service(null).classifyPersistedAcceptedTestOutcome(record, executionOutcome);
  }

  settleAcceptedTestRun(input, { session, uow } = {}) {
    return this.#service(uow ?? session).settleAcceptedTestRun(input);
  }

  blockedAcceptedTestOutcome(input) {
    return this.#service(null).blockedAcceptedTestOutcome(input);
  }

  cancelledAcceptedTestOutcome(input) {
    return this.#service(null).cancelledAcceptedTestOutcome(input);
  }

  blockAcceptedTestRun(input, prepared, { session, uow } = {}) {
    const policy = prepared ? preparedTestPolicy(prepared) : this.#executorPolicy;
    return this.#service(uow ?? session, policy).blockAcceptedTestRun(input);
  }

  requeueAcceptedTestRun(input, { session, uow } = {}) {
    return this.#service(uow ?? session).requeueAcceptedTestRun(input);
  }

  async createValidation(input, { uow, session } = {}) {
    if (this.#ports) {
      if (uow !== undefined) return this.#createValidation(input, uow);
      return this.#ports.withTransaction((transactionUow) => this.#createValidation(input, transactionUow));
    }
    if (uow !== undefined) return this.#createValidation(input, uow);
    return this.#store.withTransaction(
      (transactionUow) => this.#createValidation(input, transactionUow),
      session === undefined ? {} : { session },
    );
  }

  async #createValidation(input, uow) {
    if (this.#ports) {
      return this.#ports.createValidation(input, {
        uow,
        createRecord: () => this.#serviceWithOptions({ uow }).createValidation(input),
        imageDigests: this.#imageDigests,
        idFactory: this.#idFactory,
        clock: this.#clock,
      });
    }
    await this.#transitionValidationLifecycle(input, {
      from: "draft",
      to: "validating",
      uow,
    });
    const record = await this.#serviceWithOptions({ uow }).createValidation(input);
    if (record.status !== "passed") {
      await this.#transitionValidationLifecycle(input, {
        from: "validating",
        to: "draft",
        uow,
      });
      return record;
    }
    const loaded = await this.#loadPromotedPackage(input, { uow });
    const promptTool = isPromptToolInspection(loaded.inspection);
    const runtimeId = loaded.inspection?.manifest?.runtime?.runtime ?? null;
    const runtimeImageDigest = promptTool ? null : this.#imageDigests.get(runtimeId);
    if (!promptTool && !runtimeImageDigest) {
      throw productError(
        "skill_runtime_unavailable",
        "The selected isolated Skill runtime is not configured.",
      );
    }

    const existingBinding = await this.#store.repositories.skillExecutionBindings.getExactInternal({
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      skillDraftId: input.draftId,
      draftRevision: input.draftRevision,
      contentHash: input.contentHash,
      packageHash: input.packageHash,
    }, { uow });
    if (existingBinding) {
      throw productError(
        "skill_validation_already_passed",
        "This exact Skill draft already has an approved execution binding.",
      );
    }

    const binding = {
      schemaVersion: "workbench-v1",
      executionBindingId: this.#idFactory("skill-execution-binding"),
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      skillDraftId: input.draftId,
      draftRevision: input.draftRevision,
      validationId: record.validationId,
      uploadId: input.uploadId,
      objectId: input.objectId,
      objectHash: input.objectHash,
      packageHash: input.packageHash,
      contentHash: input.contentHash,
      trustTier: promptTool ? "uploaded_prompt" : "uploaded_oci",
      executorKind: promptTool ? "prompt_tool" : "docker",
      ...(promptTool ? {} : { runtimeId, imageDigest: runtimeImageDigest }),
      executionRef: input.executionRef
        ? structuredClone(input.executionRef)
        : promptTool
          ? promptExecutionRef(input.packageHash)
          : uploadedExecutionRef(input.packageHash),
      createdAt: timestamp(this.#clock),
    };
    await this.#store.repositories.skillExecutionBindings.insertInternal(binding, { uow });
    await this.#transitionValidationLifecycle(input, {
      from: "validating",
      to: "tested",
      uow,
    });
    return record;
  }

  async #transitionValidationLifecycle(input, { from, to, uow }) {
    const repository = this.#store.repositories?.skillAssets;
    if (!repository?.get || !repository?.patch) {
      throw productError(
        "skill_validation_lifecycle_unavailable",
        "Skill validation lifecycle persistence is unavailable.",
      );
    }
    const asset = await repository.get(input.skillId, {
      workspaceId: input.workspaceId,
      uow,
    });
    if (!asset
      || asset.currentDraftId !== input.draftId
      || asset.lifecycle !== from) {
      throw productError(
        "skill_validation_state_invalid",
        "The current Skill draft is not in a valid state for validation.",
      );
    }
    const updated = await repository.patch(input.skillId, {
      lifecycle: to,
      updatedAt: timestamp(this.#clock),
    }, {
      workspaceId: input.workspaceId,
      uow,
    });
    if (!updated) {
      throw productError(
        "skill_validation_state_invalid",
        "The current Skill draft changed during validation.",
      );
    }
  }

  async getTestRun({ workspaceId, testRunId }) {
    if (this.#ports) return this.#ports.getTestRun({ workspaceId, testRunId });
    await this.#store.connect();
    return this.#store.repositories.skillTestRuns.get(testRunId, { workspaceId });
  }

  async getValidation({ workspaceId, validationId }) {
    if (this.#ports) return this.#ports.getValidation({ workspaceId, validationId });
    await this.#store.connect();
    return this.#store.repositories.skillValidations.get(validationId, { workspaceId });
  }

  async resolveValidationContext(input) {
    if (this.#ports?.resolveValidationContext) return this.#ports.resolveValidationContext(input);
    return this.#store.resolveSkillValidationContext(input);
  }

  async probeExecution({ workspaceId, executionRef } = {}) {
    try {
      const binding = await this.#resolveExecutionBinding({ workspaceId, executionRef });
      await this.#loadPromotedPackage(binding);
      if (binding.executorKind === "prompt_tool") {
        const readiness = await this.#promptRuntime?.probe?.({
          workspaceId,
          executionRef,
          binding: structuredClone(binding),
        });
        return readiness?.ready === true
          ? { status: "ready", ready: true, code: "prompt_tool_skill_ready" }
          : { status: "blocked", ready: false, code: readiness?.code ?? "prompt_tool_runtime_unavailable" };
      }
      return { status: "ready", ready: true, code: "uploaded_skill_ready" };
    } catch {
      return { status: "blocked", ready: false, code: "uploaded_skill_unavailable" };
    }
  }

  async probeRuntimes() {
    if (typeof this.#isolatedExecutor?.probeRuntimes !== "function") {
      return [...this.#imageDigests.keys()].map((runtimeId) => ({
        runtimeId,
        available: false,
        verified: false,
        reasonCode: "skill_runtime_probe_unavailable",
      }));
    }
    return this.#isolatedExecutor.probeRuntimes();
  }

  async executePublished({ workspaceId, executionRef, input, materials = [], signal } = {}) {
    const binding = await this.#resolveExecutionBinding({ workspaceId, executionRef });
    if (binding.executorKind !== "docker") {
      throw productError("prompt_tool_execution_broker_required", "Prompt Skills require the Product Execution Broker.");
    }
    const loadedPackage = await this.#loadPromotedPackage({ ...binding, signal });
    if (!this.#isolatedExecutor) throw productError("skill_runtime_unavailable", "The isolated script runtime is unavailable.");
    return this.#isolatedExecutor.execute({
      workspaceId: binding.workspaceId,
      objectId: binding.objectId,
      objectHash: binding.objectHash,
      packageHash: binding.packageHash,
      inspection: loadedPackage.inspection,
      input: structuredClone(input),
      materials: materials.map((material) => ({
        ...structuredClone(material),
        bytes: Buffer.from(material.bytes),
      })),
      signal,
    });
  }

  acceptsExecutionRef(executionRef) {
    return isUploadedExecutionRef(executionRef) || isPromptExecutionRef(executionRef);
  }

  configurePromptRuntime(runtime) {
    if (!runtime?.probe || typeof runtime.probe !== "function"
      || typeof runtime.executeTest !== "function") {
      throw new TypeError("prompt_tool_runtime_probe_required");
    }
    this.#promptRuntime = runtime;
  }

  testExecutionIdentity(testRunId, executionAttempt = 1) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(testRunId || "")) {
      throw new TypeError("skill_test_run_id_invalid");
    }
    if (!Number.isSafeInteger(executionAttempt) || executionAttempt < 1) {
      throw new TypeError("skill_test_execution_attempt_invalid");
    }
    const digest = createHash("sha256")
      .update(`${testRunId}:${executionAttempt}`)
      .digest("hex")
      .slice(0, 48);
    return Object.freeze({
      invocationId: `skill-test-invocation-${digest}`,
      attemptId: `skill-test-attempt-${digest}`,
    });
  }

  async executeTestPackage({ workspaceId, executionRef, input, materials = [], signal } = {}) {
    if (!isTestExecutionRef(executionRef) || executionRef.executionMode !== "deterministic") {
      throw productError("skill_test_execution_ref_invalid", "The Skill test execution reference is invalid.");
    }
    const loaded = await this.#loadTestExecutionPackage({ workspaceId, executionRef, signal });
    if (isPromptToolInspection(loaded.inspection)) {
      throw productError("skill_test_execution_ref_invalid", "Prompt Skills require the governed model and Tool Gateway.");
    }
    if (!this.#isolatedExecutor) throw productError("skill_runtime_unavailable", "The isolated script runtime is unavailable.");
    return this.#isolatedExecutor.execute({
      workspaceId,
      objectId: loaded.objectId,
      objectHash: loaded.objectHash,
      packageHash: loaded.packageHash,
      inspection: loaded.inspection,
      input: structuredClone(input),
      materials: materials.map((material) => ({
        ...structuredClone(material),
        bytes: Buffer.from(material.bytes),
      })),
      signal,
    });
  }

  async loadExecutionPackage({ workspaceId, executionRef, signal } = {}) {
    if (isTestExecutionRef(executionRef)) {
      const loaded = await this.#loadTestExecutionPackage({ workspaceId, executionRef, signal });
      if (executionRef.executionMode !== "agent" || !isPromptToolInspection(loaded.inspection)) {
        throw productError("prompt_tool_execution_ref_invalid", "The Skill test is not a Prompt Tool package.");
      }
      return {
        inspection: structuredClone(loaded.inspection),
        files: parseSkillPackage(loaded.bytes).map((file) => ({
          path: file.path,
          content: Buffer.from(file.content),
        })),
      };
    }
    const binding = await this.#resolveExecutionBinding({ workspaceId, executionRef });
    if (binding.executorKind !== "prompt_tool") {
      throw productError("prompt_tool_execution_ref_invalid", "The Skill is not a Prompt Tool package.");
    }
    const loaded = await this.#loadPromotedPackage({ ...binding, signal });
    return {
      binding: structuredClone(binding),
      inspection: structuredClone(loaded.inspection),
      files: parseSkillPackage(loaded.bytes).map((file) => ({
        path: file.path,
        content: Buffer.from(file.content),
      })),
    };
  }

  #service(session, executorPolicy = this.#executorPolicy) {
    return this.#serviceWithOptions({ session }, executorPolicy);
  }

  #serviceWithOptions(options, executorPolicy = this.#executorPolicy) {
    return createSkillValidationService({
      packageLoader: {
        loadPromotedPackage: (request) => this.#loadPromotedPackage(request, options),
      },
      persistence: this.#ports ? this.#ports.persistenceFor(options) : this.#persistence(options),
      executorPolicy,
      clock: this.#clock,
    });
  }

  async #loadTestExecutionPackage({ workspaceId, executionRef, signal }) {
    if (this.#ports) return this.#ports.loadTestExecutionPackage({ workspaceId, executionRef, signal });
    await this.#store.connect();
    const evidence = await this.#store.repositories.skillTestEvidence.getInternal(
      executionRef.testRunId,
      { workspaceId },
    );
    if (!evidence || !sameTestExecutionRef(executionRef, evidence.packageHash)) {
      throw productError("skill_test_execution_ref_invalid", "The Skill test execution reference is unavailable.");
    }
    return this.#loadPromotedPackage({ ...evidence, workspaceId, signal });
  }

  #persistence(options) {
    return {
      getTestRun: async ({ workspaceId, testRunId }) => {
        const [record, evidence] = await Promise.all([
          this.#store.repositories.skillTestRuns.get(testRunId, { workspaceId, ...options }),
          this.#store.repositories.skillTestEvidence.getInternal(testRunId, { workspaceId, ...options }),
        ]);
        return record && evidence ? { record, evidence } : null;
      },
      insertTestRun: async ({ record, evidence }) => {
        const insert = async (transactionUow) => {
          await this.#store.repositories.skillTestRuns.insert(record, { uow: transactionUow });
          await this.#store.repositories.skillTestEvidence.insertInternal({
            schemaVersion: "workbench-internal-v1",
            testRunId: record.testRunId,
            ...structuredClone(evidence),
            createdAt: timestamp(this.#clock),
          }, { uow: transactionUow });
        };
        if (options.uow !== undefined) return insert(options.uow);
        if (options.session !== undefined) {
          return this.#store.withTransaction(insert, { session: options.session });
        }
        return this.#store.withTransaction(insert);
      },
      transitionTestRun: ({
        workspaceId,
        testRunId,
        expectedStatuses,
        expectedExecutionAttempt,
        expectedClaimOwner,
        expectedClaimFence,
        expectedClaimValidAt,
        patch,
      }) => (
        this.#store.repositories.skillTestRuns.transition(testRunId, {
          workspaceId,
          expectedStatuses,
          expectedExecutionAttempt,
          expectedClaimOwner,
          expectedClaimFence,
          expectedClaimValidAt,
          patch,
        }, options)
      ),
      getValidation: ({ workspaceId, validationId }) =>
        this.#store.repositories.skillValidations.get(validationId, { workspaceId, ...options }),
      insertValidation: (record) =>
        this.#store.repositories.skillValidations.insert(record, options),
    };
  }

  async #loadPromotedPackage(request, options = {}) {
    if (this.#ports) return this.#ports.loadPromotedPackage(request, options);
    await this.#store.connect();
    const upload = await this.#store.repositories.uploads.get(request.uploadId, {
      workspaceId: request.workspaceId,
      ...options,
    });
    if (!upload
      || upload.state !== "promoted"
      || upload.objectId !== request.objectId
      || upload.inspection?.contentHash !== request.packageHash) {
      throw productError("skill_package_not_promoted", "The selected Skill package is not available for testing.");
    }
    const stored = await this.#objectStore.read({
      workspaceId: request.workspaceId,
      objectId: request.objectId,
      signal: request.signal,
    });
    if (stored.object?.state !== "promoted"
      || stored.object?.contentHash !== request.objectHash) {
      throw productError("skill_package_substituted", "The promoted Skill package no longer matches this draft.");
    }
    return {
      workspaceId: request.workspaceId,
      uploadId: upload.uploadId,
      objectId: upload.objectId,
      objectHash: stored.object.contentHash,
      packageHash: upload.inspection.contentHash,
      inspection: structuredClone(upload.inspection),
      state: upload.state,
      bytes: Buffer.from(stored.bytes),
    };
  }

  async #resolveExecutionBinding({ workspaceId, executionRef } = {}) {
    if (this.#ports) return this.#ports.resolveExecutionBinding({ workspaceId, executionRef, imageDigests: this.#imageDigests });
    if (
      typeof workspaceId !== "string"
      || workspaceId.length === 0
      || (!isUploadedExecutionRef(executionRef) && !isPromptExecutionRef(executionRef))
    ) {
      throw productError("uploaded_skill_execution_ref_invalid", "The published Skill binding is invalid.");
    }
    await this.#store.connect();
    const binding = await this.#store.repositories.skillExecutionBindings.getByExecutionRefInternal({
      workspaceId,
      executionRef,
    });
    const promptTool = isPromptExecutionRef(executionRef);
    const runtimeId = binding?.runtimeId ?? "python3.12";
    if (!binding
      || binding.trustTier !== (promptTool ? "uploaded_prompt" : "uploaded_oci")
      || binding.executorKind !== (promptTool ? "prompt_tool" : "docker")
      || (!promptTool && binding.imageDigest !== this.#imageDigests.get(runtimeId))
      || JSON.stringify(binding.executionRef) !== JSON.stringify(executionRef)) {
      throw productError("uploaded_skill_execution_binding_missing", "The published Skill binding is unavailable.");
    }
    return binding;
  }
}

function isPromptToolInspection(inspection) {
  return !inspection?.manifest?.runtime
    && !(inspection?.inventory ?? []).some((file) => file?.kind === "executable");
}

function normalizeImageDigests(imageDigests, legacyImageDigest) {
  const values = imageDigests instanceof Map
    ? [...imageDigests.entries()]
    : imageDigests && typeof imageDigests === "object" && !Array.isArray(imageDigests)
      ? Object.entries(imageDigests)
      : [];
  if (typeof legacyImageDigest === "string" && legacyImageDigest.length > 0) {
    values.push(["python3.12", legacyImageDigest]);
  }
  return new Map(values.filter(([runtimeId, digest]) => (
    ["python3.12", "nodejs20-typescript"].includes(runtimeId)
    && typeof digest === "string"
    && digest.length > 0
  )));
}

function uploadedRuntimePolicy(inspection) {
  const runtimeId = inspection?.manifest?.runtime?.runtime;
  const runtimeLabel = runtimeId === "nodejs20-typescript"
    ? "Node.js 20 · TypeScript"
    : runtimeId === "python3.12"
      ? "Python 3.12"
      : UPLOADED_SKILL_EXECUTOR_POLICY.runtimeLabel;
  return Object.freeze({
    ...UPLOADED_SKILL_EXECUTOR_POLICY,
    runtimeLabel,
  });
}

function validateCoordinatorTestInput(input) {
  const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const sha256 = /^sha256:[a-f0-9]{64}$/;
  if (!input || ["workspaceId", "skillId", "draftId", "uploadId", "objectId"]
    .some((key) => !stableId.test(input[key] || ""))
    || ["contentHash", "objectHash", "packageHash"]
      .some((key) => !sha256.test(input[key] || ""))
    || input.permissionAcknowledged !== true
    || !Array.isArray(input.testCases)
    || !Array.isArray(input.testRunIds)) {
    throw productError(
      "skill_validation_request_invalid",
      "The Skill test request is invalid.",
    );
  }
}

function validateMaterialRequirements({
  inspection,
  testCases,
  resolvedMaterialsByTestCase,
}) {
  validateMaterialBindingRequirements({ inspection, testCases });
  const requirements = (inspection?.manifest?.inputs ?? [])
    .filter((input) => input?.type === "file");
  const byKey = new Map(requirements.map((requirement) => [
    requirement.name,
    requirement,
  ]));
  for (let index = 0; index < testCases.length; index += 1) {
    const bindings = testCases[index]?.materialBindings ?? [];
    const resolved = resolvedMaterialsByTestCase?.[index] ?? [];
    if (resolved.length !== bindings.length) {
      throw productError(
        "skill_material_unavailable",
        "Every Skill material must resolve before execution.",
      );
    }
    for (const material of resolved) {
      const requirement = byKey.get(material.materialKey);
      if (
        requirement
        && !acceptsMaterialMediaType(
          requirement.acceptedMediaTypes,
          material.mediaType,
        )
      ) {
        throw productError(
          "skill_material_media_type_mismatch",
          `Material "${material.materialKey}" does not match the Skill's accepted formats.`,
        );
      }
    }
  }
}

function validateMaterialBindingRequirements({ inspection, testCases }) {
  const requirements = (inspection?.manifest?.inputs ?? [])
    .filter((input) => input?.type === "file");
  const byKey = new Map(requirements.map((requirement) => [
    requirement.name,
    requirement,
  ]));
  for (let index = 0; index < testCases.length; index += 1) {
    const bindings = testCases[index]?.materialBindings ?? [];
    const boundKeys = new Set(bindings.map((binding) => binding.materialKey));
    for (const binding of bindings) {
      if (!byKey.has(binding.materialKey)) {
        throw productError(
          "skill_material_binding_unknown",
          `Material "${binding.materialKey}" is not declared by this Skill.`,
        );
      }
    }
    for (const requirement of requirements) {
      if (requirement.required === true && !boundKeys.has(requirement.name)) {
        throw productError(
          "skill_material_required",
          `Required material "${requirement.name}" is missing.`,
        );
      }
    }
  }
}

function uploadedExecutionRef(packageHash) {
  const digest = createHash("sha256").update(packageHash).digest("hex").slice(0, 48);
  return {
    capabilityId: `uploaded-${digest}`,
    taskIntent: "execute",
    adapterVersion: "1",
    executionMode: "deterministic",
  };
}

function promptExecutionRef(packageHash) {
  const digest = createHash("sha256").update(packageHash).digest("hex").slice(0, 48);
  return {
    capabilityId: `prompt-${digest}`,
    taskIntent: "execute",
    adapterVersion: "1",
    executionMode: "agent",
  };
}

function testExecutionRef(packageHash, testRunId, promptTool) {
  const digest = createHash("sha256")
    .update(`${packageHash}:${testRunId}`)
    .digest("hex")
    .slice(0, 48);
  return {
    capabilityId: `${promptTool ? "prompt" : "skill-test"}-${digest}`,
    taskIntent: "execute",
    adapterVersion: "1",
    executionMode: promptTool ? "agent" : "deterministic",
    testRunId,
  };
}

function isTestExecutionRef(value) {
  return Boolean(
    value
    && typeof value === "object"
    && /^(?:prompt|skill-test)-[a-f0-9]{48}$/.test(value.capabilityId || "")
    && value.taskIntent === "execute"
    && value.adapterVersion === "1"
    && ["agent", "deterministic"].includes(value.executionMode)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.testRunId || ""),
  );
}

function sameTestExecutionRef(executionRef, packageHash) {
  return isTestExecutionRef(executionRef)
    && executionRef.capabilityId === testExecutionRef(
      packageHash,
      executionRef.testRunId,
      executionRef.executionMode === "agent",
    ).capabilityId;
}

function preparedTestPolicy(prepared) {
  if (!prepared
    || typeof prepared.promptTool !== "boolean"
    || !isTrustedPreparedPolicy(prepared.executorPolicy)) {
    throw new TypeError("skill_test_preparation_required");
  }
  return prepared.executorPolicy;
}

function isTrustedPreparedPolicy(value) {
  return value?.isolated === true
    && value?.networkDenied === true
    && typeof value?.runtimeLabel === "string"
    && typeof value?.permissionSummary === "string";
}

function isUploadedExecutionRef(value) {
  return Boolean(
    value
    && typeof value === "object"
    && /^uploaded-[a-f0-9]{48}$/.test(value.capabilityId || "")
    && value.taskIntent === "execute"
    && value.adapterVersion === "1"
    && value.executionMode === "deterministic",
  );
}

function isPromptExecutionRef(value) {
  return Boolean(
    value
    && typeof value === "object"
    && /^prompt-[a-f0-9]{48}$/.test(value.capabilityId || "")
    && value.taskIntent === "execute"
    && value.adapterVersion === "1"
    && value.executionMode === "agent",
  );
}

function timestamp(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : String(value);
}

function productError(code, message) {
  return new ProductStoreError(code, message);
}
