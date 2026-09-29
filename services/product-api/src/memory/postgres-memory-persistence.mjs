/**
 * PostgreSQL implementation of the product MemoryPersistence boundary.
 *
 * It deliberately exposes memory operations, never a pool, client, table, or
 * SQL callback.  ProductMemoryService can therefore use the same persistence
 * contract for MongoDB and PostgreSQL without making storage a caller concern.
 */
export class PostgresMemoryPersistence {
  constructor({ store } = {}) {
    if (!store || typeof store.bindAdapter !== "function" || typeof store.withTransaction !== "function") {
      throw new TypeError("postgres_memory_store_required");
    }
    this.store = store;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({
      query(uow, text, values = []) { return execute(uow, { text, values }); },
    }));
  }

  async submitCandidate(candidate, event) {
    return this.#transaction(async (query) => {
      await query(`
        INSERT INTO public.memory_candidates (
          candidate_id, workspace_id, schema_version, scope_kind, scope_owner_user_id,
          scope_object_kind, scope_object_id, subject_kind, subject_id, source_kind,
          source_id, source_version_id, source_verified, confidence, sensitivity, status,
          created_by, submitted_by_kind, policy_version, expires_at, created_at, decided_at, payload
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22, $23::jsonb
        )
      `, candidateValues(candidate));
      await insertEvent(query, event);
      return clone(candidate);
    });
  }

  async getCandidate(candidateId, workspaceId) {
    return this.#transaction(async (query) => candidateFromRow((await query(`
      SELECT * FROM public.memory_candidates
       WHERE candidate_id = $1 AND workspace_id = $2
    `, [candidateId, workspaceId])).rows[0]));
  }

  async patchCandidate(candidateId, workspaceId, patch) {
    return this.#transaction(async (query) => candidateFromRow((await query(`
      UPDATE public.memory_candidates
         SET status = COALESCE($3, status),
             decided_at = COALESCE($4::timestamptz, decided_at),
             payload = payload || $5::jsonb
       WHERE candidate_id = $1 AND workspace_id = $2
       RETURNING *
    `, [candidateId, workspaceId, patch.status ?? null, patch.decidedAt ?? null,
      JSON.stringify(candidatePayloadPatch(patch))])).rows[0]));
  }

  async listCandidates({ workspaceId, status, scope, limit = 500 }) {
    return this.#transaction(async (query) => (await query(`
      SELECT * FROM public.memory_candidates
       WHERE workspace_id = $1
         AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR scope_kind = $3)
       ORDER BY created_at DESC, candidate_id DESC
       LIMIT $4
    `, [workspaceId, status ?? null, scope ?? null, safeLimit(limit)])).rows.map(candidateFromRow));
  }

  async promoteCandidate({ candidateId, workspaceId, memory, candidatePatch, event }) {
    return this.#transaction(async (query) => {
      const candidate = (await query(`
        UPDATE public.memory_candidates
           SET status = $3, decided_at = $4::timestamptz,
               payload = payload || $5::jsonb
         WHERE candidate_id = $1 AND workspace_id = $2 AND status = 'pending'
         RETURNING *
      `, [candidateId, workspaceId, candidatePatch.status, candidatePatch.decidedAt,
        JSON.stringify(candidatePayloadPatch(candidatePatch))])).rows[0];
      if (!candidate) return null;
      await query(`
        INSERT INTO public.durable_memories (
          memory_id, candidate_id, workspace_id, schema_version, scope_kind, scope_owner_user_id,
          scope_object_kind, scope_object_id, subject_kind, subject_id, source_kind, source_id,
          source_version_id, source_verified, statement, confidence, sensitivity, status, created_by,
          promoted_by, promotion_mode, policy_version, expires_at, created_at, updated_at, payload
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23, $24, $25, $26::jsonb
        )
      `, memoryValues(memory));
      await insertEvent(query, event);
      return { candidate: candidateFromRow(candidate), memory: clone(memory) };
    });
  }

  async rejectCandidate({ candidateId, workspaceId, candidatePatch, event }) {
    return this.#transaction(async (query) => {
      const row = (await query(`
        UPDATE public.memory_candidates
           SET status = $3, decided_at = $4::timestamptz,
               payload = payload || $5::jsonb
         WHERE candidate_id = $1 AND workspace_id = $2 AND status = 'pending'
         RETURNING *
      `, [candidateId, workspaceId, candidatePatch.status, candidatePatch.decidedAt,
        JSON.stringify(candidatePayloadPatch(candidatePatch))])).rows[0];
      if (!row) return null;
      await insertEvent(query, event);
      return candidateFromRow(row);
    });
  }

  async getMemory(memoryId, workspaceId) {
    return this.#transaction(async (query) => memoryFromRow((await query(`
      SELECT * FROM public.durable_memories
       WHERE memory_id = $1 AND workspace_id = $2
    `, [memoryId, workspaceId])).rows[0]));
  }

  async searchMemories({ workspaceId, scopes, subject, text, tags, now, limit = 500 }) {
    return this.#transaction(async (query) => {
      const hasText = Boolean(String(text ?? "").trim());
      const rows = (await query(`
        SELECT durable_memories.*,
               CASE WHEN $6::boolean
                    THEN ts_rank_cd(search_document, to_tsquery('simple', regexp_replace(regexp_replace(trim($7::text), '[^[:alnum:]_]+', ' ', 'g'), '[[:space:]]+', ' | ', 'g')))
                    ELSE 0::real END AS search_score
          FROM public.durable_memories
         WHERE workspace_id = $1
           AND scope_kind = ANY($2::text[])
           AND status = 'active'
           AND (expires_at IS NULL OR expires_at > $3::timestamptz)
           AND ($4::text IS NULL OR (subject_kind = $4 AND subject_id = $5))
           AND (cardinality($8::text[]) = 0 OR (payload -> 'tags') ?| $8::text[])
           AND (NOT $6::boolean OR search_document @@ to_tsquery('simple', regexp_replace(regexp_replace(trim($7::text), '[^[:alnum:]_]+', ' ', 'g'), '[[:space:]]+', ' | ', 'g')))
         ORDER BY search_score DESC, confidence DESC, updated_at DESC, memory_id ASC
         LIMIT $9
      `, [workspaceId, scopes, now, subject?.kind ?? null, subject?.subjectId ?? null,
        hasText, hasText ? String(text).trim() : "", Array.isArray(tags) ? tags : [], safeLimit(limit)])).rows;
      return rows.map((row) => ({ ...memoryFromRow(row), searchScore: Number(row.search_score ?? 0) }));
    });
  }

  async deleteMemoryWithTombstone(memoryId, workspaceId, tombstone, event) {
    return this.#transaction(async (query) => {
      const deleted = (await query(`
        DELETE FROM public.durable_memories
         WHERE memory_id = $1 AND workspace_id = $2
         RETURNING candidate_id
      `, [memoryId, workspaceId])).rows[0];
      if (!deleted) return null;
      await query(`DELETE FROM public.memory_candidates WHERE candidate_id = $1 AND workspace_id = $2`,
        [deleted.candidate_id, workspaceId]);
      await query(`
        INSERT INTO public.memory_deletion_tombstones (
          tombstone_id, workspace_id, schema_version, memory_id_hash, scope_kind,
          deleted_by, reason, policy_version, deleted_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb)
      `, tombstoneValues(tombstone));
      await insertEvent(query, event);
      return clone(tombstone);
    });
  }

  async getTombstoneByMemoryHash(memoryIdHash, workspaceId) {
    return this.#transaction(async (query) => tombstoneFromRow((await query(`
      SELECT * FROM public.memory_deletion_tombstones
       WHERE memory_id_hash = $1 AND workspace_id = $2
    `, [memoryIdHash, workspaceId])).rows[0]));
  }

  async listEvents({ workspaceId, limit = 500 }) {
    return this.#transaction(async (query) => (await query(`
      SELECT * FROM public.memory_events
       WHERE workspace_id = $1
       ORDER BY created_at ASC, memory_event_id ASC
       LIMIT $2
    `, [workspaceId, safeLimit(limit)])).rows.map(eventFromRow));
  }

  async appendEvent(event) {
    return this.#transaction(async (query) => {
      await insertEvent(query, event);
      return clone(event);
    });
  }

  // This is intentionally an operational method, not a generic delete API.
  // The clock is PostgreSQL's trusted server clock; callers cannot supply it.
  async sweepExpired({ limit = 500 } = {}) {
    return this.#transaction(async (query) => {
      const rows = (await query(`
        WITH due AS (
          SELECT candidate_id, workspace_id
            FROM public.memory_candidates
           WHERE expires_at IS NOT NULL AND expires_at <= clock_timestamp()
           ORDER BY expires_at ASC, candidate_id ASC
           LIMIT $1
           FOR UPDATE
        ), removed_memories AS (
          DELETE FROM public.durable_memories memory
           USING due
           WHERE memory.workspace_id = due.workspace_id
             AND memory.candidate_id = due.candidate_id
           RETURNING memory.memory_id
        ), removed_candidates AS (
          DELETE FROM public.memory_candidates candidate
           USING due
           WHERE candidate.workspace_id = due.workspace_id
             AND candidate.candidate_id = due.candidate_id
           RETURNING candidate.candidate_id
        )
        SELECT
          (SELECT count(*)::int FROM removed_candidates) AS deleted_candidate_count,
          (SELECT count(*)::int FROM removed_memories) AS deleted_memory_count
      `, [safeLimit(limit)])).rows[0];
      return Object.freeze({
        deletedCandidateCount: Number(rows?.deleted_candidate_count ?? 0),
        deletedMemoryCount: Number(rows?.deleted_memory_count ?? 0),
        clock: "postgres.clock_timestamp",
      });
    });
  }

  async explainFullTextSearch({ workspaceId, scopes, subject, text, tags = [] }) {
    return this.#transaction(async (query) => {
      // This diagnostic is not the product query path. Disabling sequential
      // scans proves the declared GIN index is eligible for the exact same
      // predicate while keeping the ordinary query planner untouched.
      await query("SELECT set_config('enable_seqscan', 'off', true)");
      await query("SELECT set_config('enable_indexscan', 'off', true)");
      return (await query(`
      EXPLAIN (FORMAT JSON, COSTS OFF)
      SELECT memory_id FROM public.durable_memories
       WHERE workspace_id = $1 AND scope_kind = ANY($2::text[])
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > clock_timestamp())
         AND ($3::text IS NULL OR (subject_kind = $3 AND subject_id = $4))
         AND (cardinality($5::text[]) = 0 OR (payload -> 'tags') ?| $5::text[])
         AND search_document @@ to_tsquery('simple', regexp_replace(regexp_replace(trim($6::text), '[^[:alnum:]_]+', ' ', 'g'), '[[:space:]]+', ' | ', 'g'))
      `, [workspaceId, scopes, subject?.kind ?? null, subject?.subjectId ?? null,
        tags, String(text ?? "").trim()])).rows[0]?.["QUERY PLAN"] ?? null;
    });
  }

  // Index-eligibility proof kept separate from the selective product query:
  // a small tenant can legitimately make its composite ownership index cheaper
  // than GIN. This confirms the same tsquery expression has a real GIN path.
  async explainFullTextIndex({ text }) {
    return this.#transaction(async (query) => {
      await query("SELECT set_config('enable_seqscan', 'off', true)");
      return (await query(`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT memory_id FROM public.durable_memories
         WHERE search_document @@ to_tsquery('simple', regexp_replace(regexp_replace(trim($1::text), '[^[:alnum:]_]+', ' ', 'g'), '[[:space:]]+', ' | ', 'g'))
      `, [String(text ?? "").trim()])).rows[0]?.["QUERY PLAN"] ?? null;
    });
  }

  #transaction(work) {
    return this.store.withTransaction((uow) => work((text, values) => this.sql.query(uow, text, values)));
  }
}

function candidateValues(candidate) {
  const scope = scopeColumns(candidate.scope);
  return [candidate.candidateId, candidate.workspaceId, candidate.schemaVersion, scope.kind, scope.ownerUserId,
    scope.objectKind, scope.objectId, candidate.subject.kind, candidate.subject.subjectId, candidate.source.kind,
    candidate.source.sourceId, candidate.source.versionId, candidate.source.verified, candidate.confidence,
    candidate.sensitivity, candidate.status, candidate.createdBy, candidate.submittedByKind,
    candidate.policyVersion, candidate.expiresAt, candidate.createdAt, candidate.decidedAt,
    JSON.stringify(candidatePayload(candidate))];
}

function memoryValues(memory) {
  const scope = scopeColumns(memory.scope);
  return [memory.memoryId, memory.candidateId, memory.workspaceId, memory.schemaVersion, scope.kind,
    scope.ownerUserId, scope.objectKind, scope.objectId, memory.subject.kind, memory.subject.subjectId,
    memory.source.kind, memory.source.sourceId, memory.source.versionId, memory.source.verified,
    memory.statement, memory.confidence, memory.sensitivity, memory.status, memory.createdBy,
    memory.promotedBy, memory.promotionMode, memory.policyVersion, memory.expiresAt, memory.createdAt,
    memory.updatedAt, JSON.stringify(memoryPayload(memory))];
}

function tombstoneValues(tombstone) {
  return [tombstone.tombstoneId, tombstone.workspaceId, tombstone.schemaVersion, tombstone.memoryIdHash,
    tombstone.scopeKind, tombstone.deletedBy, tombstone.reason, tombstone.policyVersion, tombstone.deletedAt];
}

async function insertEvent(query, event) {
  await query(`
    INSERT INTO public.memory_events (
      memory_event_id, workspace_id, schema_version, candidate_id, memory_id, type,
      actor_id, created_at, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
  `, [event.memoryEventId, event.workspaceId, event.schemaVersion, event.candidateId,
    event.memoryId, event.type, event.actorId, event.createdAt, JSON.stringify(event.metadata)]);
}

function candidateFromRow(row) {
  if (!row) return null;
  const payload = row.payload ?? {};
  return {
    schemaVersion: row.schema_version, candidateId: row.candidate_id, workspaceId: row.workspace_id,
    scope: scopeFromRow(row), subject: { kind: row.subject_kind, subjectId: row.subject_id },
    statement: payload.statement, tags: payload.tags ?? [],
    source: sourceFromRow(row), evidence: payload.evidence ?? [], confidence: Number(row.confidence),
    sensitivity: row.sensitivity, expiresAt: iso(row.expires_at), createdBy: row.created_by,
    policyVersion: row.policy_version, submittedByKind: row.submitted_by_kind, status: row.status,
    createdAt: iso(row.created_at), decidedAt: iso(row.decided_at),
  };
}

function memoryFromRow(row) {
  if (!row) return null;
  const payload = row.payload ?? {};
  return {
    schemaVersion: row.schema_version, memoryId: row.memory_id, candidateId: row.candidate_id,
    workspaceId: row.workspace_id, scope: scopeFromRow(row),
    subject: { kind: row.subject_kind, subjectId: row.subject_id }, statement: row.statement,
    tags: payload.tags ?? [], source: sourceFromRow(row), evidence: payload.evidence ?? [],
    confidence: Number(row.confidence), sensitivity: row.sensitivity, expiresAt: iso(row.expires_at),
    createdBy: row.created_by, policyVersion: row.policy_version, status: row.status,
    promotedBy: row.promoted_by, promotionMode: row.promotion_mode, createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventFromRow(row) {
  return {
    schemaVersion: row.schema_version, memoryEventId: row.memory_event_id, workspaceId: row.workspace_id,
    candidateId: row.candidate_id, memoryId: row.memory_id, type: row.type, actorId: row.actor_id,
    metadata: row.payload ?? {}, createdAt: iso(row.created_at),
  };
}

function tombstoneFromRow(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version, tombstoneId: row.tombstone_id, workspaceId: row.workspace_id,
    memoryIdHash: row.memory_id_hash, scopeKind: row.scope_kind, deletedBy: row.deleted_by,
    reason: row.reason, policyVersion: row.policy_version, deletedAt: iso(row.deleted_at),
  };
}

function scopeColumns(scope) {
  return scope.kind === "personal"
    ? { kind: "personal", ownerUserId: scope.ownerUserId, objectKind: null, objectId: null }
    : scope.kind === "object"
      ? { kind: "object", ownerUserId: null, objectKind: scope.objectKind, objectId: scope.objectId }
      : { kind: "workspace", ownerUserId: null, objectKind: null, objectId: null };
}

function scopeFromRow(row) {
  return row.scope_kind === "personal"
    ? { kind: "personal", ownerUserId: row.scope_owner_user_id }
    : row.scope_kind === "object"
      ? { kind: "object", objectKind: row.scope_object_kind, objectId: row.scope_object_id }
      : { kind: "workspace" };
}

function sourceFromRow(row) {
  return { kind: row.source_kind, sourceId: row.source_id, versionId: row.source_version_id,
    verified: row.source_verified };
}

function candidatePayload(candidate) {
  return { statement: candidate.statement, tags: clone(candidate.tags), evidence: clone(candidate.evidence) };
}

function memoryPayload(memory) {
  return { tags: clone(memory.tags), evidence: clone(memory.evidence) };
}

function candidatePayloadPatch(patch) {
  const result = {};
  for (const key of ["statement", "tags", "evidence"]) if (patch[key] !== undefined) result[key] = clone(patch[key]);
  return result;
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }
function clone(value) { return value == null ? value : structuredClone(value); }
function safeLimit(value) { return Math.min(Math.max(Number(value) || 1, 1), 1_000); }
