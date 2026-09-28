-- G4 composition: Worker transcript plaintext remains encrypted in the
-- governed object store. PostgreSQL owns only the lifecycle, access scope and
-- safe audit metadata required by the product service.
CREATE TABLE public.worker_transcript_artifacts (
  workspace_id public.product_identifier NOT NULL,
  transcript_artifact_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  artifact_kind text COLLATE "C" NOT NULL DEFAULT 'worker_transcript',
  object_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL DEFAULT 'transcript_metadata',
  owner_user_id public.product_identifier NOT NULL,
  object_scope_kind public.product_identifier NOT NULL,
  object_scope_id public.product_identifier NOT NULL,
  invocation_id public.product_identifier NOT NULL,
  attempt_id public.product_identifier NOT NULL,
  sensitivity text COLLATE "C" NOT NULL DEFAULT 'sensitive',
  state text COLLATE "C" NOT NULL,
  media_type text COLLATE "C" NOT NULL,
  byte_length bigint NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  ciphertext_byte_length bigint NOT NULL,
  ciphertext_hash text COLLATE "C" NOT NULL,
  encryption jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  ready_at timestamptz,
  deleted_at timestamptz,
  deletion_reason text COLLATE "C",
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, transcript_artifact_id),
  CONSTRAINT worker_transcript_artifacts_owner_fk
    FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT worker_transcript_artifacts_object_fk
    FOREIGN KEY (workspace_id, object_id, object_kind, ciphertext_hash)
    REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT worker_transcript_artifacts_schema_version
    CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT worker_transcript_artifacts_kind
    CHECK (artifact_kind = 'worker_transcript' AND object_kind = 'transcript_metadata'),
  CONSTRAINT worker_transcript_artifacts_sensitivity CHECK (sensitivity = 'sensitive'),
  CONSTRAINT worker_transcript_artifacts_state CHECK (state IN ('pending', 'ready', 'deleted')),
  CONSTRAINT worker_transcript_artifacts_media_type
    CHECK (media_type IN ('application/json', 'application/x-ndjson', 'text/plain')),
  CONSTRAINT worker_transcript_artifacts_lengths
    CHECK (byte_length BETWEEN 1 AND 4194304 AND ciphertext_byte_length BETWEEN 1 AND 4194320),
  CONSTRAINT worker_transcript_artifacts_hashes
    CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$' AND ciphertext_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT worker_transcript_artifacts_encryption CHECK (jsonb_typeof(encryption) = 'object'),
  CONSTRAINT worker_transcript_artifacts_expiry CHECK (expires_at > created_at),
  CONSTRAINT worker_transcript_artifacts_time_order CHECK (updated_at >= created_at),
  CONSTRAINT worker_transcript_artifacts_ready_shape CHECK ((state = 'ready') = (ready_at IS NOT NULL)),
  CONSTRAINT worker_transcript_artifacts_deleted_shape CHECK (
    (state = 'deleted') = (deleted_at IS NOT NULL AND deletion_reason IS NOT NULL)
  )
);

CREATE INDEX worker_transcript_artifacts_cleanup_idx
  ON public.worker_transcript_artifacts (workspace_id, state, expires_at, transcript_artifact_id);
CREATE INDEX worker_transcript_artifacts_owner_idx
  ON public.worker_transcript_artifacts (workspace_id, owner_user_id, object_scope_kind, object_scope_id, transcript_artifact_id);

CREATE TABLE public.worker_transcript_audit_events (
  audit_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  transcript_artifact_id public.product_identifier NOT NULL,
  actor_user_id text COLLATE "C",
  action text COLLATE "C" NOT NULL,
  outcome text COLLATE "C" NOT NULL,
  reason_code text COLLATE "C",
  object_scope_kind public.product_identifier NOT NULL,
  object_scope_id public.product_identifier NOT NULL,
  invocation_id public.product_identifier,
  attempt_id public.product_identifier,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT worker_transcript_audit_events_outcome CHECK (outcome IN ('allowed', 'denied', 'error'))
);

CREATE INDEX worker_transcript_audit_events_artifact_idx
  ON public.worker_transcript_audit_events (workspace_id, transcript_artifact_id, occurred_at, audit_sequence);
