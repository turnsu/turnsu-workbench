-- G4 composition: Artifact bytes remain in the governed object store, while
-- this relation is the PostgreSQL canonical metadata/state authority.  It is
-- deliberately narrow: it models the ArtifactService lifecycle and does not
-- introduce a document repository replacement.
CREATE TABLE public.product_artifact_metadata (
  workspace_id public.product_identifier NOT NULL,
  artifact_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  object_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL DEFAULT 'artifact_content',
  state text COLLATE "C" NOT NULL,
  media_type text COLLATE "C" NOT NULL,
  byte_length bigint NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  owner_user_id public.product_identifier NOT NULL,
  invocation_id public.product_identifier NOT NULL,
  attempt_id public.product_identifier NOT NULL,
  execution_fence integer NOT NULL,
  capability_lease_id public.product_identifier NOT NULL,
  requested_model_revision_id public.product_identifier NOT NULL,
  actual_model_revision_id public.product_identifier NOT NULL,
  expires_at timestamptz,
  ready_at timestamptz,
  failure_code text COLLATE "C",
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, artifact_id),
  CONSTRAINT product_artifact_metadata_object_fk
    FOREIGN KEY (workspace_id, object_id, object_kind, content_hash)
    REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT product_artifact_metadata_schema_version
    CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT product_artifact_metadata_object_kind
    CHECK (object_kind = 'artifact_content'),
  CONSTRAINT product_artifact_metadata_state
    CHECK (state IN ('pending', 'ready', 'failed')),
  CONSTRAINT product_artifact_metadata_length
    CHECK (byte_length BETWEEN 1 AND 20971520),
  CONSTRAINT product_artifact_metadata_hash
    CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT product_artifact_metadata_fence
    CHECK (execution_fence >= 0),
  CONSTRAINT product_artifact_metadata_time_order
    CHECK (updated_at >= created_at),
  CONSTRAINT product_artifact_metadata_ready_shape
    CHECK ((state = 'ready') = (ready_at IS NOT NULL)),
  CONSTRAINT product_artifact_metadata_failure_shape
    CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT product_artifact_metadata_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX product_artifact_metadata_cleanup_idx
  ON public.product_artifact_metadata (workspace_id, state, updated_at, artifact_id);
CREATE INDEX product_artifact_metadata_expiry_idx
  ON public.product_artifact_metadata (workspace_id, expires_at, artifact_id)
  WHERE state = 'ready' AND expires_at IS NOT NULL;
CREATE INDEX product_artifact_metadata_attempt_idx
  ON public.product_artifact_metadata (workspace_id, invocation_id, attempt_id, artifact_id);
