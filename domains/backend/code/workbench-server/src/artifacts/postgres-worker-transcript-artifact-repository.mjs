/** PostgreSQL metadata/audit owner for encrypted Worker transcripts. */
export class PostgresWorkerTranscriptArtifactRepository {
  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_worker_transcript_store_required");
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
        ) VALUES ($1, $2::text, 'workbench-v1', 'transcript_metadata', $3,
          $4, 'application/octet-stream', 'governed_object_store', $2, $3,
          'quarantined', $5::timestamptz, $6::jsonb)
      `, [
        record.workspaceId, record.objectId, record.ciphertextHash,
        record.ciphertextByteLength, record.createdAt,
        JSON.stringify({ source: 'worker_transcript', transcriptArtifactId: record.transcriptArtifactId }),
      ]);
      return transcriptFromRow((await query(`
        INSERT INTO public.worker_transcript_artifacts (
          workspace_id, transcript_artifact_id, schema_version, object_id,
          owner_user_id, object_scope_kind, object_scope_id, invocation_id, attempt_id,
          state, media_type, byte_length, content_hash, ciphertext_byte_length, ciphertext_hash,
          encryption, expires_at, ready_at, deleted_at, deletion_reason, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15,
          $16::jsonb, $17::timestamptz, NULL, NULL, NULL, $18::timestamptz, $19::timestamptz
        ) RETURNING *
      `, recordValues(record))).rows[0]);
    });
  }

  async get({ workspaceId, transcriptArtifactId }) {
    return this.#transaction(async (query) => transcriptFromRow((await query(`
      SELECT * FROM public.worker_transcript_artifacts
       WHERE workspace_id = $1 AND transcript_artifact_id = $2
    `, [workspaceId, transcriptArtifactId])).rows[0]));
  }

  async list({ workspaceId = null, states = null, expiresBefore = null, limit = 100 } = {}) {
    return this.#transaction(async (query) => (await query(`
      SELECT * FROM public.worker_transcript_artifacts
       WHERE ($1::text IS NULL OR workspace_id = $1)
         AND ($2::text[] IS NULL OR state = ANY($2::text[]))
         AND ($3::timestamptz IS NULL OR expires_at <= $3::timestamptz)
       ORDER BY expires_at ASC, transcript_artifact_id ASC
       LIMIT $4
    `, [workspaceId, arrayOrNull(states), expiresBefore, safeLimit(limit)])).rows.map(transcriptFromRow));
  }

  async transition({ workspaceId, transcriptArtifactId, expectedState, nextState, patch = {} }) {
    return this.#transaction(async (query) => transcriptFromRow((await query(`
      WITH updated AS (
        UPDATE public.worker_transcript_artifacts
           SET state = $4,
               ready_at = CASE WHEN $4 = 'ready' THEN $5::timestamptz ELSE ready_at END,
               deleted_at = CASE WHEN $4 = 'deleted' THEN $6::timestamptz ELSE deleted_at END,
               deletion_reason = CASE WHEN $4 = 'deleted' THEN $7 ELSE deletion_reason END,
               updated_at = $8::timestamptz
         WHERE workspace_id = $1 AND transcript_artifact_id = $2 AND state = $3
         RETURNING *
      ), object_state AS (
        UPDATE public.product_objects object
           SET state = CASE WHEN updated.state = 'ready' THEN 'promoted' ELSE 'deleted' END
          FROM updated
         WHERE object.workspace_id = updated.workspace_id AND object.object_id = updated.object_id
         RETURNING object.object_id
      )
      SELECT updated.* FROM updated
    `, [
      workspaceId, transcriptArtifactId, expectedState, nextState,
      patch.readyAt ?? null, patch.deletedAt ?? null, patch.deletionReason ?? null,
      patch.updatedAt ?? new Date().toISOString(),
    ])).rows[0]));
  }

  async appendAudit(event) {
    await this.#transaction((query) => query(`
      INSERT INTO public.worker_transcript_audit_events (
        workspace_id, transcript_artifact_id, actor_user_id, action, outcome, reason_code,
        object_scope_kind, object_scope_id, invocation_id, attempt_id, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
    `, [
      event.workspaceId, event.transcriptArtifactId, event.actorUserId,
      event.action, event.outcome, event.reasonCode, event.objectScope.objectKind,
      event.objectScope.objectId, event.invocationId, event.attemptId, event.occurredAt,
    ]));
  }

  #transaction(work) {
    return this.store.withTransaction((uow) => work((text, values) => this.sql.query(uow, text, values)));
  }
}

function recordValues(record) {
  return [
    record.workspaceId, record.transcriptArtifactId, record.schemaVersion, record.objectId,
    record.ownerUserId, record.objectScope.objectKind, record.objectScope.objectId,
    record.invocationId, record.attemptId, record.state, record.mediaType,
    record.byteLength, record.contentHash, record.ciphertextByteLength, record.ciphertextHash,
    JSON.stringify(record.encryption), record.expiresAt, record.createdAt, record.updatedAt,
  ];
}

function transcriptFromRow(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    transcriptArtifactId: row.transcript_artifact_id,
    artifactKind: row.artifact_kind,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    objectScope: { objectKind: row.object_scope_kind, objectId: row.object_scope_id },
    invocationId: row.invocation_id,
    attemptId: row.attempt_id,
    sensitivity: row.sensitivity,
    state: row.state,
    objectId: row.object_id,
    mediaType: row.media_type,
    byteLength: Number(row.byte_length),
    contentHash: row.content_hash,
    ciphertextByteLength: Number(row.ciphertext_byte_length),
    ciphertextHash: row.ciphertext_hash,
    encryption: row.encryption,
    expiresAt: iso(row.expires_at),
    readyAt: iso(row.ready_at),
    deletedAt: iso(row.deleted_at),
    deletionReason: row.deletion_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function arrayOrNull(value) { return Array.isArray(value) && value.length ? value : null; }
function safeLimit(value) { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1000) : 100; }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
