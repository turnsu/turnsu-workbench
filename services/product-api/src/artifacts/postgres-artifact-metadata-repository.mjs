/**
 * PostgreSQL implementation of the narrow ArtifactService metadata port.
 *
 * Artifact bytes never enter PostgreSQL.  The canonical object reference and
 * the pending → ready/failed state machine do, so service callers retain the
 * same fencing and reconciliation behaviour without obtaining a SQL client.
 */
export class PostgresArtifactMetadataRepository {
  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_artifact_metadata_store_required");
    }
    this.store = store;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({
      query(uow, text, values = []) { return execute(uow, { text, values }); },
    }));
  }

  async createPending(record) {
    return this.#transaction(async (query) => {
      await query(`
        INSERT INTO public.product_objects (
          workspace_id, object_id, schema_version, object_kind, content_hash,
          size_bytes, media_type, storage_backend, storage_key, storage_version,
          state, created_at, payload
        ) VALUES (
          $1, $2, 'workbench-v1', 'artifact_content', $3,
          $4, $5, 'governed_object_store', $2, $3,
          'promoted', $6::timestamptz, $7::jsonb
        ) ON CONFLICT (workspace_id, object_id) DO NOTHING
      `, [
        record.workspaceId, record.objectId, record.contentHash, record.byteLength,
        record.mediaType, record.createdAt,
        JSON.stringify({ source: 'artifact_metadata', artifactId: record.artifactId }),
      ]);
      const row = (await query(`
        INSERT INTO public.product_artifact_metadata (
          workspace_id, artifact_id, schema_version, object_id, state, media_type,
          byte_length, content_hash, owner_user_id, invocation_id, attempt_id,
          execution_fence, capability_lease_id, requested_model_revision_id,
          actual_model_revision_id, expires_at, ready_at, failure_code,
          created_at, updated_at, payload
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16::timestamptz, NULL, NULL,
          $17::timestamptz, $18::timestamptz, $19::jsonb
        ) RETURNING *
      `, recordValues(record))).rows[0];
      return artifactFromRow(row);
    });
  }

  async get({ workspaceId, artifactId }) {
    return this.#transaction(async (query) => artifactFromRow((await query(`
      SELECT * FROM public.product_artifact_metadata
       WHERE workspace_id = $1 AND artifact_id = $2
    `, [workspaceId, artifactId])).rows[0]));
  }

  async list({
    workspaceId,
    states = null,
    expiresBefore = null,
    updatedBefore = null,
    invocationId = null,
    attemptId = null,
    objectId = null,
    limit = 100,
  } = {}) {
    return this.#transaction(async (query) => (await query(`
      SELECT * FROM public.product_artifact_metadata
       WHERE workspace_id = $1
         AND ($2::text[] IS NULL OR state = ANY($2::text[]))
         AND ($3::timestamptz IS NULL OR expires_at <= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR updated_at <= $4::timestamptz)
         AND ($5::text IS NULL OR invocation_id = $5)
         AND ($6::text IS NULL OR attempt_id = $6)
         AND ($7::text IS NULL OR object_id = $7)
       ORDER BY updated_at ASC, artifact_id ASC
       LIMIT $8
    `, [
      workspaceId, Array.isArray(states) && states.length ? states : null,
      expiresBefore ?? null, updatedBefore ?? null, invocationId ?? null,
      attemptId ?? null, objectId ?? null, safeLimit(limit),
    ])).rows.map(artifactFromRow));
  }

  async transition({ workspaceId, artifactId, expectedState, nextState, expectedFence, patch = {} }) {
    const row = await this.#transaction(async (query) => (await query(`
      UPDATE public.product_artifact_metadata
         SET state = $4,
             ready_at = CASE WHEN $4 = 'ready' THEN $5::timestamptz ELSE ready_at END,
             failure_code = CASE WHEN $4 = 'failed' THEN $6 ELSE NULL END,
             updated_at = $7::timestamptz,
             payload = payload || $8::jsonb
       WHERE workspace_id = $1 AND artifact_id = $2
         AND state = $3 AND execution_fence = $9
       RETURNING *
    `, [
      workspaceId, artifactId, expectedState, nextState,
      patch.readyAt ?? null, patch.failureCode ?? null,
      patch.updatedAt ?? new Date().toISOString(), JSON.stringify(payloadPatch(patch)), expectedFence,
    ])).rows[0]);
    return artifactFromRow(row);
  }

  async delete({ workspaceId, artifactId, expectedStates = null }) {
    return this.#transaction(async (query) => {
      const deleted = (await query(`
        DELETE FROM public.product_artifact_metadata
         WHERE workspace_id = $1 AND artifact_id = $2
           AND ($3::text[] IS NULL OR state = ANY($3::text[]))
         RETURNING artifact_id
      `, [workspaceId, artifactId,
        Array.isArray(expectedStates) && expectedStates.length ? expectedStates : null])).rows[0];
      return Boolean(deleted);
    });
  }

  #transaction(work) {
    return this.store.withTransaction((uow) => work((text, values) => this.sql.query(uow, text, values)));
  }
}

function recordValues(record) {
  return [
    record.workspaceId, record.artifactId, record.schemaVersion, record.objectId, record.state,
    record.mediaType, record.byteLength, record.contentHash, record.ownerUserId,
    record.invocationId, record.attemptId, record.fence, record.capabilityLeaseId,
    record.requestedModelRevisionId, record.actualModelRevisionId, record.expiresAt ?? null,
    record.createdAt, record.updatedAt, JSON.stringify(payloadForRecord(record)),
  ];
}

function payloadForRecord(record) {
  return {
    dimensions: record.dimensions ?? null,
    generation: record.generation ?? null,
    source: record.source ?? null,
    execution: record.execution ?? null,
    objectScope: record.objectScope ?? null,
  };
}

function payloadPatch(patch) {
  const value = { ...patch };
  for (const key of ['readyAt', 'failureCode', 'updatedAt']) delete value[key];
  return value;
}

function artifactFromRow(row) {
  if (!row) return null;
  const payload = row.payload ?? {};
  return {
    schemaVersion: row.schema_version,
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    objectId: row.object_id,
    state: row.state,
    mediaType: row.media_type,
    byteLength: Number(row.byte_length),
    contentHash: row.content_hash,
    ownerUserId: row.owner_user_id,
    invocationId: row.invocation_id,
    attemptId: row.attempt_id,
    fence: Number(row.execution_fence),
    capabilityLeaseId: row.capability_lease_id,
    requestedModelRevisionId: row.requested_model_revision_id,
    actualModelRevisionId: row.actual_model_revision_id,
    expiresAt: iso(row.expires_at),
    readyAt: iso(row.ready_at),
    failureCode: row.failure_code,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    dimensions: payload.dimensions ?? null,
    generation: payload.generation ?? null,
    source: payload.source ?? null,
    execution: payload.execution ?? null,
    objectScope: payload.objectScope ?? null,
  };
}

function safeLimit(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1000) : 100;
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}
