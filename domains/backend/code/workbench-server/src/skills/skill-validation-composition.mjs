import { createHash, randomUUID } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";
import { createSkillValidationService } from "./skill-validation-service.mjs";

export const UPLOADED_SKILL_EXECUTOR_POLICY = Object.freeze({
  isolated: true,
  networkDenied: true,
  runtimeLabel: "Python 3.12",
  permissionSummary: "No network, workspace connections, or external actions.",
});

export function createSkillValidationCoordinator(options) {
  return new SkillValidationCoordinator(options);
}

export class SkillValidationCoordinator {
  #store;
  #objectStore;
  #isolatedExecutor;
  #executorPolicy;
  #imageDigest;
  #clock;
  #idFactory;

  constructor({
    store,
    objectStore,
    isolatedExecutor,
    executorPolicy = UPLOADED_SKILL_EXECUTOR_POLICY,
    imageDigest,
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
  } = {}) {
    if (!store?.connect || !store?.withTransaction) {
      throw new TypeError("skill_validation_store_required");
    }
    if (!objectStore?.read || !isolatedExecutor?.execute) {
      throw new TypeError("skill_validation_runtime_required");
    }
    if (typeof imageDigest !== "string" || imageDigest.length === 0) {
      throw new TypeError("skill_validation_image_digest_required");
    }
    this.#store = store;
    this.#objectStore = objectStore;
    this.#isolatedExecutor = isolatedExecutor;
    this.#executorPolicy = Object.freeze(structuredClone(executorPolicy));
    this.#imageDigest = imageDigest;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  runTests(input, { session } = {}) {
    return this.#service(session).runTests(input);
  }

  async createValidation(input, { session } = {}) {
    if (!session) {
      return this.#store.withTransaction((transactionSession) =>
        this.#createValidation(input, transactionSession));
    }
    return this.#createValidation(input, session);
  }

  async #createValidation(input, session) {
    const record = await this.#service(session).createValidation(input);
    if (record.status !== "passed") return record;

    const existingBinding = await this.#store.repositories.skillExecutionBindings.getExactInternal({
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      skillDraftId: input.draftId,
      draftRevision: input.draftRevision,
      contentHash: input.contentHash,
      packageHash: input.packageHash,
    }, { session });
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
      trustTier: "uploaded_oci",
      executorKind: "docker",
      imageDigest: this.#imageDigest,
      executionRef: input.executionRef
        ? structuredClone(input.executionRef)
        : uploadedExecutionRef(input.packageHash),
      createdAt: timestamp(this.#clock),
    };
    await this.#store.repositories.skillExecutionBindings.insertInternal(binding, { session });
    return record;
  }

  async getTestRun({ workspaceId, testRunId }) {
    await this.#store.connect();
    return this.#store.repositories.skillTestRuns.get(testRunId, { workspaceId });
  }

  async getValidation({ workspaceId, validationId }) {
    await this.#store.connect();
    return this.#store.repositories.skillValidations.get(validationId, { workspaceId });
  }

  async probeExecution({ workspaceId, executionRef } = {}) {
    try {
      const binding = await this.#resolveExecutionBinding({ workspaceId, executionRef });
      await this.#loadPromotedPackage(binding);
      return { status: "ready", ready: true, code: "uploaded_skill_ready" };
    } catch {
      return { status: "blocked", ready: false, code: "uploaded_skill_unavailable" };
    }
  }

  async executePublished({ workspaceId, executionRef, input, signal } = {}) {
    const binding = await this.#resolveExecutionBinding({ workspaceId, executionRef });
    const loadedPackage = await this.#loadPromotedPackage({ ...binding, signal });
    return this.#isolatedExecutor.execute({
      workspaceId: binding.workspaceId,
      objectId: binding.objectId,
      objectHash: binding.objectHash,
      packageHash: binding.packageHash,
      inspection: loadedPackage.inspection,
      input: structuredClone(input),
      signal,
    });
  }

  #service(session) {
    return createSkillValidationService({
      packageLoader: {
        loadPromotedPackage: (request) => this.#loadPromotedPackage(request, { session }),
      },
      isolatedExecutor: this.#isolatedExecutor,
      persistence: this.#persistence(session),
      executorPolicy: this.#executorPolicy,
      clock: this.#clock,
    });
  }

  #persistence(session) {
    return {
      getTestRun: async ({ workspaceId, testRunId }) => {
        const [record, evidence] = await Promise.all([
          this.#store.repositories.skillTestRuns.get(testRunId, { workspaceId, session }),
          this.#store.repositories.skillTestEvidence.getInternal(testRunId, { workspaceId, session }),
        ]);
        return record && evidence ? { record, evidence } : null;
      },
      insertTestRun: async ({ record, evidence }) => {
        const insert = async (transactionSession) => {
          await this.#store.repositories.skillTestRuns.insert(record, { session: transactionSession });
          await this.#store.repositories.skillTestEvidence.insertInternal({
            schemaVersion: "workbench-internal-v1",
            testRunId: record.testRunId,
            ...structuredClone(evidence),
            createdAt: record.completedAt,
          }, { session: transactionSession });
        };
        if (session) return insert(session);
        return this.#store.withTransaction(insert);
      },
      getValidation: ({ workspaceId, validationId }) =>
        this.#store.repositories.skillValidations.get(validationId, { workspaceId, session }),
      insertValidation: (record) =>
        this.#store.repositories.skillValidations.insert(record, { session }),
    };
  }

  async #loadPromotedPackage(request, { session } = {}) {
    await this.#store.connect();
    const upload = await this.#store.repositories.uploads.get(request.uploadId, {
      workspaceId: request.workspaceId,
      session,
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
    if (typeof workspaceId !== "string" || workspaceId.length === 0 || !isUploadedExecutionRef(executionRef)) {
      throw productError("uploaded_skill_execution_ref_invalid", "The published Skill binding is invalid.");
    }
    await this.#store.connect();
    const binding = await this.#store.repositories.skillExecutionBindings.getByExecutionRefInternal({
      workspaceId,
      executionRef,
    });
    if (!binding
      || binding.trustTier !== "uploaded_oci"
      || binding.executorKind !== "docker"
      || binding.imageDigest !== this.#imageDigest
      || JSON.stringify(binding.executionRef) !== JSON.stringify(executionRef)) {
      throw productError("uploaded_skill_execution_binding_missing", "The published Skill binding is unavailable.");
    }
    return binding;
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

function timestamp(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : String(value);
}

function productError(code, message) {
  return new ProductStoreError(code, message);
}
