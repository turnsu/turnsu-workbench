-- Private human-attested evidence of local execution. This ledger grants no
-- managed Run completion, compilation readiness, publication or device authority.
CREATE TABLE public.local_loop_trial_receipts (
  workspace_id public.product_identifier NOT NULL,
  trial_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  workflow_revision_id public.product_identifier NOT NULL,
  revision_content_hash text COLLATE "C" NOT NULL,
  local_trial_id text COLLATE "C" NOT NULL,
  reviewed_by public.product_identifier NOT NULL,
  agent_kind text COLLATE "C" NOT NULL,
  input_summary text NOT NULL,
  output text NOT NULL,
  output_hash text COLLATE "C" NOT NULL,
  review_note text NOT NULL,
  provenance text COLLATE "C" NOT NULL DEFAULT 'member_attested_local',
  review_state text COLLATE "C" NOT NULL DEFAULT 'human_reviewed',
  visibility text COLLATE "C" NOT NULL DEFAULT 'private',
  reported_completed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  request_hash text COLLATE "C" NOT NULL,
  PRIMARY KEY (workspace_id, trial_id),
  CONSTRAINT local_loop_trial_identity_uq UNIQUE (workspace_id, reviewed_by, local_trial_id),
  FOREIGN KEY (workspace_id, workflow_id, workflow_revision_id, revision_content_hash)
    REFERENCES public.workflow_revisions (workspace_id, workflow_id, revision_id, content_hash),
  FOREIGN KEY (workspace_id, reviewed_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CHECK (agent_kind IN ('codex', 'claude', 'pi')),
  CHECK (local_trial_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$'),
  CHECK (length(input_summary) <= 16000),
  CHECK (length(output) BETWEEN 1 AND 64000),
  CHECK (length(review_note) BETWEEN 1 AND 4000),
  CHECK (output_hash ~ '^sha256:[a-f0-9]{64}$'),
  CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CHECK (provenance = 'member_attested_local' AND review_state = 'human_reviewed' AND visibility = 'private')
);
CREATE TRIGGER local_loop_trial_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.local_loop_trial_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();
