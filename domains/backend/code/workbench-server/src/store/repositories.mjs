import { ProductStoreError } from "./errors.mjs";
import {
  cloneValue,
  withoutExecutionPlanInternals,
  withoutMongoId,
  withoutNodeRunInternals,
  withoutRunInternals,
  withoutSkillInternals,
  withoutWorkflowInternals,
} from "./serialization.mjs";

const writeOptions = ({ session } = {}, extra = {}) =>
  session ? { ...extra, session } : { ...extra };

const boundedLimit = (limit, fallback = 100) =>
  Math.max(1, Math.min(Number.isInteger(limit) ? limit : fallback, 1000));
const duplicateKey = (error) => error?.code === 11000 || error?.codeName === "DuplicateKey";
const publicNodeAttempt = (document) => {
  const value = withoutNodeRunInternals(document);
  if (!value) return value;
  for (const field of ["invocationId", "invocationStatus", "invocationStartedAt", "workerId", "fence"]) {
    delete value[field];
  }
  return value;
};
const publicReviewDecision = (document) => {
  const value = withoutMongoId(document);
  if (!value) return value;
  delete value.applicationStatus;
  delete value.appliedAt;
  return value;
};

const listDocuments = async (
  collection,
  filter,
  { session, limit, sort = { updatedAt: -1 } } = {},
  serialize = withoutMongoId,
) => {
  let cursor = collection.find(filter, writeOptions({ session }));
  if (sort) cursor = cursor.sort(sort);
  const documents = await cursor.limit(boundedLimit(limit)).toArray();
  return documents.map(serialize);
};

class Repository {
  constructor(collection) {
    if (!collection) throw new TypeError("repository_collection_required");
    this.collection = collection;
  }

  async insertDocument(document, options = {}, serialize = withoutMongoId) {
    const payload = withoutMongoId(document);
    await this.collection.insertOne(payload, writeOptions(options));
    return serialize(payload);
  }
}

export class ProductUserRepository extends Repository {
  insert(user, options) {
    return this.insertDocument(user, options);
  }

  async get(userId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ userId }, writeOptions(options)),
    );
  }

  async ensure(user, options = {}) {
    const payload = withoutMongoId(user);
    await this.collection.updateOne(
      { userId: payload.userId },
      { $setOnInsert: payload },
      writeOptions(options, { upsert: true }),
    );
    return this.get(payload.userId, options);
  }
}

export class WorkspaceRepository extends Repository {
  insert(workspace, options) {
    return this.insertDocument(workspace, options);
  }

  async get(workspaceId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ workspaceId }, writeOptions(options)),
    );
  }

  async ensure(workspace, options = {}) {
    const payload = withoutMongoId(workspace);
    await this.collection.updateOne(
      { workspaceId: payload.workspaceId },
      { $setOnInsert: payload },
      writeOptions(options, { upsert: true }),
    );
    return this.get(payload.workspaceId, options);
  }
}

export class MembershipRepository extends Repository {
  insert(membership, options) {
    return this.insertDocument(membership, options);
  }

  async get(workspaceId, userId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ workspaceId, userId }, writeOptions(options)),
    );
  }

  listByWorkspace(workspaceId, options = {}) {
    return listDocuments(this.collection, { workspaceId }, options);
  }

  listByUser(userId, options = {}) {
    return listDocuments(this.collection, { userId }, options);
  }

  async ensure(membership, options = {}) {
    const payload = withoutMongoId(membership);
    await this.collection.updateOne(
      { workspaceId: payload.workspaceId, userId: payload.userId },
      { $setOnInsert: payload },
      writeOptions(options, { upsert: true }),
    );
    return this.get(payload.workspaceId, payload.userId, options);
  }
}

export class ProductSessionRepository extends Repository {
  insert(session, options) {
    return this.insertDocument(session, options);
  }

  async getByTokenHash(tokenHash, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ tokenHash, revokedAt: null }, writeOptions(options)),
    );
  }

  async revoke(sessionId, revokedAt, options = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { sessionId, revokedAt: null },
        { $set: { revokedAt } },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class ProductRecordRepository extends Repository {
  constructor(collection, { idField, immutable = false } = {}) {
    super(collection);
    if (typeof idField !== "string" || idField.length === 0) throw new TypeError("product_record_id_field_required");
    this.idField = idField;
    this.immutable = immutable;
  }

  insert(record, options) {
    return this.insertDocument(record, options);
  }

  async get(id, { workspaceId, ...options } = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        { [this.idField]: id, ...(workspaceId ? { workspaceId } : {}) },
        writeOptions(options),
      ),
    );
  }

  list({ workspaceId, ...options } = {}) {
    return listDocuments(
      this.collection,
      workspaceId ? { workspaceId } : {},
      options,
    );
  }

  listBySourceWorkspace(sourceWorkspaceId, options = {}) {
    return listDocuments(this.collection, { sourceWorkspaceId }, options);
  }

  async patch(id, patch, { workspaceId, ...options } = {}) {
    if (this.immutable) {
      throw new ProductStoreError("immutable_record", "This product record is immutable.");
    }
    const payload = withoutMongoId(patch);
    delete payload[this.idField];
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { [this.idField]: id, ...(workspaceId ? { workspaceId } : {}) },
        { $set: payload },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }

  async patchAndUnset(id, patch, unsetFields, { workspaceId, ...options } = {}) {
    if (this.immutable) {
      throw new ProductStoreError("immutable_record", "This product record is immutable.");
    }
    const payload = withoutMongoId(patch);
    delete payload[this.idField];
    const unset = Object.fromEntries(
      [...new Set(unsetFields ?? [])]
        .filter((field) => typeof field === "string" && field.length > 0 && field !== this.idField)
        .map((field) => [field, ""]),
    );
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { [this.idField]: id, ...(workspaceId ? { workspaceId } : {}) },
        { $set: payload, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class ModelProfileRepository extends Repository {
  insert(profile, options) {
    return this.insertDocument(profile, options);
  }

  async ensure(profile, options = {}) {
    const payload = withoutMongoId(profile);
    await this.collection.updateOne(
      { profileId: payload.profileId },
      { $setOnInsert: payload },
      writeOptions(options, { upsert: true }),
    );
    return this.getInternal(payload.profileId, options);
  }

  async getInternal(profileId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ profileId }, writeOptions(options)),
    );
  }

  async get(profileId, { workspaceId, ...options } = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        {
          profileId,
          $or: workspaceId
            ? [{ scope: "global" }, { scope: "workspace", workspaceId }]
            : [{ scope: "global" }],
        },
        writeOptions(options),
      ),
    );
  }

  listAuthorized({ workspaceId, enabled, ...options } = {}) {
    const filter = {
      $or: workspaceId
        ? [{ scope: "global" }, { scope: "workspace", workspaceId }]
        : [{ scope: "global" }],
      ...(typeof enabled === "boolean" ? { enabled } : {}),
    };
    return listDocuments(
      this.collection,
      filter,
      { ...options, sort: { displayName: 1, profileId: 1 } },
    );
  }

  async updateMetadata(
    profileId,
    { scope, workspaceId, displayName, enabled, updatedAt },
    options = {},
  ) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        {
          profileId,
          scope,
          ...(scope === "workspace" ? { workspaceId } : {}),
        },
        { $set: { displayName, enabled, updatedAt } },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }

  async advanceCurrentRevision(
    profileId,
    { expectedCurrentRevisionId, currentRevisionId, updatedAt },
    options = {},
  ) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { profileId, currentRevisionId: expectedCurrentRevisionId },
        { $set: { currentRevisionId, updatedAt } },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class ModelProfileRevisionRepository extends Repository {
  insert(revision, options) {
    return this.insertDocument(revision, options);
  }

  async get(revisionId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ revisionId }, writeOptions(options)),
    );
  }

  async getForProfile(profileId, revisionId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ profileId, revisionId }, writeOptions(options)),
    );
  }

  async findByConfigHash(profileId, configHash, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ profileId, configHash }, writeOptions(options)),
    );
  }

  async latestByProfile(profileId, options = {}) {
    const documents = await listDocuments(
      this.collection,
      { profileId },
      { ...options, limit: 1, sort: { revisionNumber: -1 } },
    );
    return documents[0] ?? null;
  }

  listByProfile(profileId, options = {}) {
    return listDocuments(
      this.collection,
      { profileId },
      { ...options, sort: { revisionNumber: -1 } },
    );
  }

  async update() {
    throw new ProductStoreError(
      "model_profile_revision_immutable",
      "Model profile revisions are immutable.",
    );
  }

  async delete() {
    throw new ProductStoreError(
      "model_profile_revision_immutable",
      "Model profile revisions are immutable.",
    );
  }
}

export class WorkspaceModelRoutingPolicyRepository extends Repository {
  insert(policy, options) {
    return this.insertDocument(policy, options);
  }

  async get(workspaceId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ workspaceId }, writeOptions(options)),
    );
  }

  async updateVersioned(
    workspaceId,
    {
      expectedPolicyVersion,
      nextPolicyVersion,
      defaultProfileIdsByCapability,
      workflowFallbackAllowed,
      updatedAt,
    },
    options = {},
  ) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { workspaceId, policyVersion: expectedPolicyVersion },
        {
          $set: {
            defaultProfileIdsByCapability,
            workflowFallbackAllowed,
            policyVersion: nextPolicyVersion,
            updatedAt,
          },
        },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class ProductArtifactRepository extends Repository {
  create(record, options) {
    const payload = withoutMongoId(record);
    if (typeof payload.artifactId !== "string" || payload.artifactId.length === 0
      || typeof payload.workspaceId !== "string" || payload.workspaceId.length === 0
      || typeof payload.attemptId !== "string" || payload.attemptId.length === 0
      || !Number.isInteger(payload.fence) || payload.fence < 0
      || !["quarantined", "pending"].includes(payload.state)) {
      throw new TypeError("product_artifact_initial_metadata_invalid");
    }
    return this.insertDocument(payload, options);
  }

  async getById(artifactId, { workspaceId, ...options } = {}) {
    requiredWorkspaceId(workspaceId);
    return withoutMongoId(
      await this.collection.findOne({ artifactId, workspaceId }, writeOptions(options)),
    );
  }

  async getReady(artifactId, { workspaceId, ...options } = {}) {
    requiredWorkspaceId(workspaceId);
    return withoutMongoId(
      await this.collection.findOne(
        { artifactId, workspaceId, state: "ready" },
        writeOptions(options),
      ),
    );
  }

  listPending({ workspaceId, before, ...options } = {}) {
    return listDocuments(
      this.collection,
      {
        ...(workspaceId ? { workspaceId } : {}),
        state: "pending",
        ...(before ? { updatedAt: { $lte: before } } : {}),
      },
      { ...options, sort: { updatedAt: 1 } },
    );
  }

  listForCleanup({
    workspaceId,
    states,
    expiresBefore,
    invocationId,
    attemptId,
    objectId,
    before,
    limit,
    ...options
  } = {}) {
    requiredWorkspaceId(workspaceId);
    const expectedStates = states === undefined ? null : normalizeExpectedStates(states, null);
    return listDocuments(
      this.collection,
      {
        workspaceId,
        ...(expectedStates ? { state: { $in: expectedStates } } : {}),
        ...(expiresBefore ? { expiresAt: { $lte: expiresBefore } } : {}),
        ...(invocationId ? { invocationId } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(objectId ? { objectId } : {}),
        ...(before ? { updatedAt: { $lte: before } } : {}),
      },
      { ...options, limit, sort: { updatedAt: 1 } },
    );
  }

  markReady(artifactId, transition, options = {}) {
    return this.#transition(artifactId, "ready", transition, ["pending"], options);
  }

  markFailed(artifactId, transition, options = {}) {
    return this.#transition(
      artifactId,
      "failed",
      transition,
      ["quarantined", "pending"],
      options,
    );
  }

  async delete(artifactId, { workspaceId, expectedStates, ...options } = {}) {
    requiredWorkspaceId(workspaceId);
    const states = normalizeExpectedStates(expectedStates, null);
    const result = await this.collection.deleteOne(
      {
        artifactId,
        workspaceId,
        ...(states ? { state: { $in: states } } : {}),
      },
      writeOptions(options),
    );
    return result?.deletedCount === 1;
  }

  async #transition(artifactId, nextState, transition = {}, allowedStates, options = {}) {
    const {
      workspaceId,
      expectedState,
      expectedStates,
      expectedFence,
      ...patch
    } = transition ?? {};
    requiredWorkspaceId(workspaceId);
    if (expectedFence === undefined || expectedFence === null) {
      throw new TypeError("artifact_transition_fence_required");
    }
    const states = normalizeExpectedStates(
      expectedStates ?? (expectedState ? [expectedState] : null),
      allowedStates,
    );
    if (states.some((state) => !allowedStates.includes(state))) {
      throw new TypeError("artifact_transition_state_invalid");
    }
    const payload = withoutMongoId(patch);
    for (const field of ["artifactId", "workspaceId", "attemptId", "state", "fence", "createdAt"]) {
      delete payload[field];
    }
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        {
          artifactId,
          workspaceId,
          fence: expectedFence,
          state: states.length === 1 ? states[0] : { $in: states },
        },
        { $set: { ...payload, state: nextState } },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

function requiredWorkspaceId(workspaceId) {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new TypeError("artifact_workspace_id_required");
  }
}

function normalizeExpectedStates(value, fallback) {
  const states = value === null || value === undefined
    ? fallback
    : (Array.isArray(value) ? value : [value]);
  if (states === null) return null;
  if (states.length === 0 || states.some((state) => typeof state !== "string" || state.length === 0)) {
    throw new TypeError("artifact_transition_state_invalid");
  }
  return [...new Set(states)];
}

export class WorkspaceConnectionRepository extends ProductRecordRepository {
  constructor(collection) {
    super(collection, { idField: "connectionId" });
  }

  async patchWithRevision(connectionId, expectedRevision, patch, { workspaceId, ...options } = {}) {
    const payload = withoutMongoId(patch);
    delete payload.connectionId;
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { connectionId, workspaceId, revision: expectedRevision },
        { $set: payload },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class LoopImportRepository extends ProductRecordRepository {
  constructor(collection) {
    super(collection, { idField: "importId" });
  }

  async patchWithRevision(importId, expectedRevision, patch, { workspaceId, ...options } = {}) {
    const payload = withoutMongoId(patch);
    delete payload.importId;
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { importId, workspaceId, revision: expectedRevision },
        { $set: payload },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class ConnectionBindingRepository extends Repository {
  async replaceForTarget(record, options = {}) {
    const { workspaceId, targetKind, targetId, bindings, boundBy, boundAt } = record;
    await this.collection.deleteMany(
      { workspaceId, targetKind, targetId },
      writeOptions(options),
    );
    const documents = (bindings ?? []).map((binding) => ({
      workspaceId,
      targetKind,
      targetId,
      requirementId: binding.requirementId,
      connectionId: binding.connectionId,
      boundBy,
      boundAt,
    }));
    if (documents.length > 0) await this.collection.insertMany(documents, writeOptions(options));
    return documents.map(withoutMongoId);
  }

  listByTarget({ workspaceId, targetKind, targetId }, options = {}) {
    return listDocuments(
      this.collection,
      { workspaceId, targetKind, targetId },
      { ...options, sort: { requirementId: 1 } },
    );
  }
}

export class RunJobRepository extends Repository {
  insert(job, options) {
    return this.insertDocument(job, options);
  }

  async getByRun(runId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ runId }, writeOptions(options)),
    );
  }

  list(options = {}) {
    return listDocuments(this.collection, {}, options, withoutMongoId);
  }

  listRecoverable(now, options = {}) {
    return listDocuments(this.collection, {
      $or: [
        { status: "queued" },
        { status: { $in: ["leased", "running"] }, leaseExpiresAt: { $lte: now } },
      ],
    }, { ...options, sort: { queuedAt: 1 } }, withoutMongoId);
  }

  async claimByRun(runId, { workerId, now, leaseExpiresAt, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        {
          runId,
          $or: [
            { status: "queued" },
            { status: { $in: ["leased", "running"] }, leaseExpiresAt: { $lte: now } },
          ],
        },
        {
          $set: {
            status: "leased",
            leaseOwner: workerId,
            leaseExpiresAt,
            heartbeatAt: now,
            updatedAt: now,
          },
          $inc: { fence: 1 },
        },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async heartbeatByRun(runId, { workerId, fence, now, leaseExpiresAt, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId, leaseOwner: workerId, fence, status: { $in: ["leased", "running"] } },
        { $set: { status: "running", heartbeatAt: now, leaseExpiresAt, updatedAt: now } },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async assertActiveFence(runId, { workerId, fence, now, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        {
          runId,
          leaseOwner: workerId,
          fence,
          status: { $in: ["leased", "running"] },
          leaseExpiresAt: { $gt: now },
        },
        { $set: { lastFencedWriteAt: now } },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async finishByRun(runId, { workerId, fence, status, now, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId, leaseOwner: workerId, fence },
        {
          $set: {
            status,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now,
            updatedAt: now,
          },
        },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async requeueByRun(runId, { now, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId, status: "paused" },
        {
          $set: {
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now,
            updatedAt: now,
          },
        },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async pauseByRun(runId, { workerId, fence, now, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId, leaseOwner: workerId, fence, status: { $in: ["leased", "running"] } },
        {
          $set: {
            status: "paused",
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now,
            updatedAt: now,
          },
        },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async abandonClaimByRun(runId, { workerId, fence, now, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        {
          runId,
          leaseOwner: workerId,
          fence,
          status: { $in: ["leased", "running"] },
        },
        {
          $set: {
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now,
            updatedAt: now,
          },
        },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async cancelByRun(runId, { now, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        {
          runId,
          status: { $in: ["queued", "leased", "running", "paused"] },
        },
        {
          $set: {
            status: "cancelled",
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: now,
            updatedAt: now,
          },
        },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async nextCheckpointSequence(runId, { workerId, fence, now, session } = {}) {
    const job = withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId, leaseOwner: workerId, fence },
        { $inc: { checkpointSequence: 1 }, $set: { updatedAt: now } },
        writeOptions({ session }, { returnDocument: "after", projection: { checkpointSequence: 1 } }),
      ),
    );
    return job?.checkpointSequence ?? null;
  }

  async nextTerminalCheckpointSequence(runId, { now, session } = {}) {
    const job = withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId },
        { $inc: { checkpointSequence: 1 }, $set: { updatedAt: now } },
        writeOptions({ session }, { returnDocument: "after", projection: { checkpointSequence: 1 } }),
      ),
    );
    return job?.checkpointSequence ?? null;
  }
}

export class RunLeaseRepository extends Repository {
  async acquire(lease, options = {}) {
    const payload = withoutMongoId(lease);
    try {
      return withoutMongoId(
        await this.collection.findOneAndUpdate(
          {
            runId: payload.runId,
            $or: [
              { fence: { $lt: payload.fence } },
              { fence: payload.fence, workerId: payload.workerId },
              { fence: { $exists: false } },
            ],
          },
          { $set: payload },
          writeOptions(options, { upsert: true, returnDocument: "after" }),
        ),
      );
    } catch (error) {
      if (duplicateKey(error)) return null;
      throw error;
    }
  }

  async heartbeat(runId, { workerId, fence, heartbeatAt, expiresAt, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId, workerId, fence, status: "active" },
        { $set: { heartbeatAt, expiresAt, updatedAt: heartbeatAt } },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async release(runId, { workerId, fence, releasedAt, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId, workerId, fence, status: "active" },
        { $set: { status: "released", releasedAt, updatedAt: releasedAt } },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }

  async cancelByRun(runId, { cancelledAt, session } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId, status: "active" },
        {
          $set: {
            status: "cancelled",
            releasedAt: cancelledAt,
            updatedAt: cancelledAt,
          },
        },
        writeOptions({ session }, { returnDocument: "after" }),
      ),
    );
  }
}

export class SkillRepository extends Repository {
  insert(skill, options) {
    return this.insertDocument(skill, options, withoutSkillInternals);
  }

  async upsert(skill, options = {}) {
    const payload = withoutMongoId(skill);
    await this.collection.replaceOne(
      { skillId: payload.skillId, version: payload.version },
      payload,
      writeOptions(options, { upsert: true }),
    );
    return withoutSkillInternals(payload);
  }

  async get(skillId, version, options = {}) {
    if (version && typeof version === "object") {
      options = version;
      version = undefined;
    }
    const { workspaceId, ...repositoryOptions } = options;
    const filter = { skillId, ...(version ? { version } : {}), ...(workspaceId ? { workspaceId } : {}) };
    if (version) {
      return withoutSkillInternals(
        await this.collection.findOne(filter, writeOptions(repositoryOptions)),
      );
    }
    const documents = await listDocuments(
      this.collection,
      filter,
      { ...repositoryOptions, limit: 1 },
      withoutSkillInternals,
    );
    return documents[0] ?? null;
  }

  list({ workspaceId, status, category, ...options } = {}) {
    const filter = {};
    if (workspaceId) filter.workspaceId = workspaceId;
    if (status) filter.status = status;
    if (category) filter.category = category;
    return listDocuments(this.collection, filter, options, withoutSkillInternals);
  }
}

export class SkillVersionRepository extends ProductRecordRepository {
  constructor(collection) {
    super(collection, { idField: "skillVersionId", immutable: true });
  }

  async getBySkillRef(skillId, version, { workspaceId, ...options } = {}) {
    if (!workspaceId) throw new TypeError("workspace_id_required");
    return withoutMongoId(
      await this.collection.findOne(
        { workspaceId, skillId, version },
        writeOptions(options),
      ),
    );
  }

  listBySkill(skillId, { workspaceId, ...options } = {}) {
    if (!skillId) throw new TypeError("skill_id_required");
    if (!workspaceId) throw new TypeError("workspace_id_required");
    return listDocuments(
      this.collection,
      { workspaceId, skillId },
      {
        ...options,
        sort: { publishedAt: -1, skillVersionId: -1 },
      },
    );
  }
}

export class SkillTestRunRepository extends Repository {
  insert(record, options) {
    return this.insertDocument(record, options);
  }

  async get(testRunId, { workspaceId, ...options } = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        { testRunId, ...(workspaceId ? { workspaceId } : {}) },
        writeOptions(options),
      ),
    );
  }
}

// Isolation attestations and object/package references are deliberately kept
// behind an internal-only repository. No public serializer is exposed.
export class SkillTestEvidenceRepository extends Repository {
  insertInternal(evidence, options) {
    return this.insertDocument(evidence, options);
  }

  async getInternal(testRunId, { workspaceId, ...options } = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        { testRunId, ...(workspaceId ? { workspaceId } : {}) },
        writeOptions(options),
      ),
    );
  }
}

export class SkillValidationRepository extends Repository {
  insert(record, options) {
    return this.insertDocument(record, options);
  }

  async get(validationId, { workspaceId, ...options } = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        { validationId, ...(workspaceId ? { workspaceId } : {}) },
        writeOptions(options),
      ),
    );
  }

  async getExactPassed({ workspaceId, skillId, skillDraftId, draftRevision, contentHash }, options = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        {
          workspaceId,
          skillId,
          skillDraftId,
          draftRevision,
          contentHash,
          status: "passed",
        },
        writeOptions(options, { sort: { completedAt: -1 } }),
      ),
    );
  }
}

// Execution bindings are immutable internal authority. Product API callers
// only receive the public executionRef copied onto a published SkillVersion.
export class SkillExecutionBindingRepository extends Repository {
  insertInternal(binding, options) {
    return this.insertDocument(binding, options);
  }

  async getExactInternal({
    workspaceId,
    skillId,
    skillDraftId,
    draftRevision,
    contentHash,
    packageHash,
    validationId,
  }, options = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        {
          workspaceId,
          skillId,
          skillDraftId,
          draftRevision,
          contentHash,
          packageHash,
          ...(validationId ? { validationId } : {}),
        },
        writeOptions(options),
      ),
    );
  }

  async getByExecutionRefInternal({ workspaceId, executionRef }, options = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        {
          workspaceId,
          "executionRef.capabilityId": executionRef?.capabilityId,
          "executionRef.taskIntent": executionRef?.taskIntent,
          "executionRef.adapterVersion": executionRef?.adapterVersion,
          "executionRef.executionMode": executionRef?.executionMode,
        },
        writeOptions(options, { sort: { createdAt: -1 } }),
      ),
    );
  }
}

export class TemplateRepository extends Repository {
  insert(template, options) {
    return this.insertDocument(template, options);
  }

  async get(templateId, templateVersion, options = {}) {
    if (templateVersion && typeof templateVersion === "object") {
      options = templateVersion;
      templateVersion = undefined;
    }
    const filter = templateVersion
      ? { templateId, templateVersion }
      : { templateId };
    if (templateVersion) {
      return withoutMongoId(
        await this.collection.findOne(filter, writeOptions(options)),
      );
    }
    const documents = await listDocuments(
      this.collection,
      filter,
      { ...options, limit: 1 },
    );
    return documents[0] ?? null;
  }

  list({ category, ...options } = {}) {
    return listDocuments(
      this.collection,
      category ? { category } : {},
      options,
    );
  }

  async update() {
    throw new ProductStoreError("template_read_only", "Templates are permanently read-only.");
  }

  async delete() {
    throw new ProductStoreError("template_read_only", "Templates are permanently read-only.");
  }
}

export class WorkflowRepository extends Repository {
  insert(workflow, options) {
    return this.insertDocument(workflow, options, withoutWorkflowInternals);
  }

  async get(workflowId, options = {}) {
    const { workspaceId, ...repositoryOptions } = options;
    return withoutWorkflowInternals(
      await this.collection.findOne({ workflowId, ...(workspaceId ? { workspaceId } : {}) }, writeOptions(repositoryOptions)),
    );
  }

  async getInternal(workflowId, options = {}) {
    const { workspaceId, ...repositoryOptions } = options;
    return withoutMongoId(
      await this.collection.findOne({ workflowId, ...(workspaceId ? { workspaceId } : {}) }, writeOptions(repositoryOptions)),
    );
  }

  list({ workspaceId, status, archived, ...options } = {}) {
    const filter = {};
    if (workspaceId) filter.workspaceId = workspaceId;
    if (status) filter.status = status;
    if (typeof archived === "boolean") filter.archived = archived;
    return listDocuments(this.collection, filter, options, withoutWorkflowInternals);
  }

  async advanceRevisionInternal(
    workflowId,
    {
      expectedRevisionId,
      expectedWriteVersion,
      currentRevisionId,
      revisionNumber,
      writeVersion,
      updatedAt,
    },
    options = {},
  ) {
    const { workspaceId, session, ...rest } = options;
    const document = await this.collection.findOneAndUpdate(
      {
        workflowId,
        ...(workspaceId ? { workspaceId } : {}),
        currentRevisionId: expectedRevisionId,
        writeVersion: expectedWriteVersion,
      },
      {
        $set: { currentRevisionId, revisionNumber, writeVersion, updatedAt },
      },
      writeOptions({ session, ...rest }, { returnDocument: "after" }),
    );
    return withoutMongoId(document);
  }

  async updateCompileSummary(
    workflowId,
    { revisionId, status, compiledAt },
    options = {},
  ) {
    const document = await this.collection.findOneAndUpdate(
      { workflowId, currentRevisionId: revisionId },
      {
        $set: {
          status: status === "ready" ? "ready" : "blocked",
          latestCompile: { revisionId, status, compiledAt },
          updatedAt: compiledAt,
        },
      },
      writeOptions(options, { returnDocument: "after" }),
    );
    return withoutWorkflowInternals(document);
  }

  async markSharedInternal(
    workflowId,
    { expectedRevisionId, expectedWriteVersion, updatedAt },
    options = {},
  ) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        {
          workflowId,
          currentRevisionId: expectedRevisionId,
          writeVersion: expectedWriteVersion,
        },
        {
          $set: { lifecycle: "shared", visibility: "workspace", updatedAt },
          $inc: { writeVersion: 1 },
        },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class WorkflowRevisionRepository extends Repository {
  insert(revision, options) {
    return this.insertDocument(revision, options);
  }

  async get(workflowId, revisionId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        { workflowId, revisionId },
        writeOptions(options),
      ),
    );
  }

  listByWorkflow(workflowId, options = {}) {
    return listDocuments(
      this.collection,
      { workflowId },
      { ...options, sort: { revisionNumber: -1 } },
    );
  }

  async update() {
    throw new ProductStoreError(
      "workflow_revision_immutable",
      "Workflow revisions are immutable.",
    );
  }

  async delete() {
    throw new ProductStoreError(
      "workflow_revision_immutable",
      "Workflow revisions are immutable.",
    );
  }
}

export class CompileResultRepository extends Repository {
  insert(compileResult, options) {
    return this.insertDocument(compileResult, options);
  }

  async getLatest(workflowRevisionId, options = {}) {
    const documents = await listDocuments(
      this.collection,
      { workflowRevisionId },
      { ...options, limit: 1, sort: { compiledAt: -1 } },
    );
    return documents[0] ?? null;
  }
}

export class ExecutionPlanRepository extends Repository {
  async insert(planId, executionPlan, options = {}) {
    if (planId && typeof planId === "object") {
      options = executionPlan ?? {};
      executionPlan = planId;
      planId = executionPlan.planId;
    }
    if (!planId) throw new TypeError("execution_plan_id_required");
    const payload = { ...withoutMongoId(executionPlan), planId };
    await this.collection.insertOne(payload, writeOptions(options));
    return withoutExecutionPlanInternals(payload);
  }

  async get(planId, options = {}) {
    return withoutExecutionPlanInternals(
      await this.collection.findOne({ planId }, writeOptions(options)),
    );
  }

  async getInternal(planId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ planId }, writeOptions(options)),
    );
  }
}

export class RunRepository extends Repository {
  async insert(run, options = {}) {
    const payload = { ...withoutRunInternals(run), eventSequence: 0 };
    await this.collection.insertOne(payload, writeOptions(options));
    return withoutRunInternals(payload);
  }

  async get(runId, options = {}) {
    return withoutRunInternals(
      await this.collection.findOne({ runId }, writeOptions(options)),
    );
  }

  async getInternal(runId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ runId }, writeOptions(options)),
    );
  }

  listByWorkflow(workflowId, { status, ...options } = {}) {
    return listDocuments(
      this.collection,
      status ? { workflowId, status } : { workflowId },
      options,
      withoutRunInternals,
    );
  }

  async getLatestCompletedByWorkflowRevision(workflowId, workflowRevisionId, options = {}) {
    return withoutRunInternals(
      await this.collection.findOne(
        { workflowId, workflowRevisionId, status: "completed" },
        writeOptions(options, { sort: { finishedAt: -1, updatedAt: -1 } }),
      ),
    );
  }

  async patch(runId, patch, options = {}) {
    const payload = withoutMongoId(patch);
    delete payload.runId;
    delete payload.eventSequence;
    const document = await this.collection.findOneAndUpdate(
      { runId },
      { $set: payload },
      writeOptions(options, { returnDocument: "after" }),
    );
    return withoutRunInternals(document);
  }

  async incrementEventSequence(runId, options = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId },
        { $inc: { eventSequence: 1 } },
        writeOptions(options, {
          returnDocument: "after",
          projection: { runId: 1, eventSequence: 1 },
        }),
      ),
    );
  }
}

export class RunNodeAttemptRepository extends Repository {
  async insert(attempt, options = {}) {
    const payload = withoutMongoId(attempt);
    await this.collection.insertOne(payload, writeOptions(options));
    return publicNodeAttempt(payload);
  }

  async get(runId, nodeId, attempt, options = {}) {
    return publicNodeAttempt(
      await this.collection.findOne(
        { runId, nodeId, attempt },
        writeOptions(options),
      ),
    );
  }

  async getInternal(runId, nodeId, attempt, options = {}) {
    return withoutMongoId(
      await this.collection.findOne(
        { runId, nodeId, attempt },
        writeOptions(options),
      ),
    );
  }

  listByRun(runId, options = {}) {
    return listDocuments(
      this.collection,
      { runId },
      { ...options, sort: { createdAt: 1, nodeId: 1, attempt: 1 } },
      publicNodeAttempt,
    );
  }

  listInternalByRun(runId, options = {}) {
    return listDocuments(
      this.collection,
      { runId },
      { ...options, sort: { createdAt: 1, nodeId: 1, attempt: 1 } },
    );
  }

  async patch(runId, nodeId, attempt, patch, options = {}) {
    const payload = withoutMongoId(patch);
    delete payload.runId;
    delete payload.nodeId;
    delete payload.attempt;
    return publicNodeAttempt(
      await this.collection.findOneAndUpdate(
        { runId, nodeId, attempt },
        { $set: payload },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }

  async patchInternal(runId, nodeId, attempt, patch, options = {}) {
    const payload = withoutMongoId(patch);
    delete payload.runId;
    delete payload.nodeId;
    delete payload.attempt;
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { runId, nodeId, attempt },
        { $set: payload },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class RunEventRepository extends Repository {
  insert(event, options) {
    return this.insertDocument(event, options);
  }

  listAfter(runId, after = 0, options = {}) {
    return listDocuments(
      this.collection,
      { runId, sequence: { $gt: after } },
      { ...options, sort: { sequence: 1 } },
    );
  }
}

export class ReviewDecisionRepository extends Repository {
  async insert(decision, options = {}) {
    const payload = withoutMongoId(decision);
    await this.collection.insertOne(payload, writeOptions(options));
    return publicReviewDecision(payload);
  }

  listByRun(runId, options = {}) {
    return listDocuments(
      this.collection,
      { runId },
      { ...options, sort: { decidedAt: 1 } },
      publicReviewDecision,
    );
  }

  listInternalByRun(runId, options = {}) {
    return listDocuments(
      this.collection,
      { runId },
      { ...options, sort: { decidedAt: 1 } },
    );
  }

  async patch(decisionId, patch, options = {}) {
    const payload = withoutMongoId(patch);
    delete payload.decisionId;
    return publicReviewDecision(
      await this.collection.findOneAndUpdate(
        { decisionId },
        { $set: payload },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class RunReadModelRepository extends Repository {
  async put(readModel, options = {}) {
    const payload = withoutMongoId(readModel);
    await this.collection.replaceOne(
      { runId: payload.runId },
      payload,
      writeOptions(options, { upsert: true }),
    );
    return withoutMongoId(payload);
  }

  async get(runId, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ runId }, writeOptions(options)),
    );
  }
}

export class IdempotencyRepository extends Repository {
  async getInternal(scope, key, options = {}) {
    return withoutMongoId(
      await this.collection.findOne({ scope, key }, writeOptions(options)),
    );
  }

  insertPending(record, options) {
    return this.insertDocument(record, options);
  }

  async takeOverExternal(scope, key, { requestHash, leaseOwner, leaseExpiresAt, now, options = {} } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        {
          scope,
          key,
          requestHash,
          response: null,
          leaseExpiresAt: { $lte: now },
        },
        {
          $set: {
            state: "executing",
            leaseOwner,
            leaseExpiresAt,
            updatedAt: now,
          },
          $inc: { executionAttempt: 1 },
        },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }

  async completeExternal(scope, key, { requestHash, leaseOwner, response, updatedAt, options = {} } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { scope, key, requestHash, leaseOwner, response: null },
        {
          $set: {
            state: "completed",
            response: cloneValue(response),
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt,
          },
        },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }

  async releaseExternal(scope, key, { requestHash, leaseOwner, failureCode, updatedAt, options = {} } = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { scope, key, requestHash, leaseOwner, response: null },
        {
          $set: {
            state: "retryable",
            leaseOwner: null,
            leaseExpiresAt: updatedAt,
            lastFailureCode: failureCode,
            updatedAt,
          },
        },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }

  async complete(scope, key, response, updatedAt, options = {}) {
    return withoutMongoId(
      await this.collection.findOneAndUpdate(
        { scope, key },
        { $set: { response: cloneValue(response), updatedAt } },
        writeOptions(options, { returnDocument: "after" }),
      ),
    );
  }
}

export class AuditEventRepository extends Repository {
  append(event, options) {
    return this.insertDocument(event, options);
  }

  list(options = {}) {
    return listDocuments(
      this.collection,
      {},
      { ...options, sort: { occurredAt: -1 } },
    );
  }
}
