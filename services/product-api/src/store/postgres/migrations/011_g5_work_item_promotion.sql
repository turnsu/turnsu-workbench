-- G5: a promoted Work Item is a distinct team aggregate.  The private Agent
-- Session provenance stays in the restricted promotion ledger; none of the
-- shared Work Item, Handoff Capsule, Decision, Artifact reference, or Thread
-- records has a source-session or transcript column.

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_kind;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_kind CHECK (kind IN (
    'agent_turn', 'cancel_agent_turn',
    'skill_creation_turn', 'cancel_skill_creation_turn',
    'skill_creation_realtime_call', 'finish_skill_creation_realtime_call',
    'cancel_skill_creation_realtime_call', 'builder_proposal',
    'skill_test', 'cancel_skill_test', 'skill_validation',
    'workflow_run', 'workflow_run_cancel', 'workflow_run_review',
    'workflow_run_step',
    'scope_create', 'scope_principal_grant_issue',
    'policy_grant_issue', 'object_access_grant_issue',
    'work_item_promote'
  ));

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_session_turn_shape;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_session_turn_shape CHECK (
    (kind IN (
      'agent_turn', 'cancel_agent_turn',
      'skill_creation_turn', 'cancel_skill_creation_turn',
      'skill_creation_realtime_call', 'finish_skill_creation_realtime_call',
      'cancel_skill_creation_realtime_call'
    ) AND session_id IS NOT NULL AND turn_id IS NOT NULL)
    OR (kind IN (
      'workflow_run', 'workflow_run_cancel', 'workflow_run_review',
      'workflow_run_step',
      'scope_create', 'scope_principal_grant_issue',
      'policy_grant_issue', 'object_access_grant_issue',
      'work_item_promote'
    ) AND session_id IS NULL AND turn_id IS NULL)
    OR (kind IN ('builder_proposal', 'skill_test', 'cancel_skill_test', 'skill_validation')
      AND ((session_id IS NULL AND turn_id IS NULL)
        OR (session_id IS NOT NULL AND turn_id IS NOT NULL)))
  );

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_special_target_shape;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_special_target_shape CHECK (
    (kind = 'scope_create'
      AND effect_class = 'administrative'
      AND target_kind = 'product_scope'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind = 'scope_principal_grant_issue'
      AND effect_class = 'administrative'
      AND target_kind = 'scope_principal_grant'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind = 'policy_grant_issue'
      AND effect_class = 'administrative'
      AND target_kind = 'policy_grant'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind = 'object_access_grant_issue'
      AND effect_class = 'administrative'
      AND target_kind = 'object_access_grant'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind = 'workflow_run'
      AND effect_class = 'execute'
      AND target_kind = 'workflow_run'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind = 'workflow_run_review'
      AND effect_class = 'write_local'
      AND target_kind = 'workflow_run_review'
      AND target_id IS NOT NULL
      AND target_revision >= 1)
    OR (kind = 'workflow_run_cancel'
      AND effect_class = 'execute'
      AND target_kind = 'workflow_run_cancellation'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind = 'work_item_promote'
      AND effect_class = 'execute'
      AND target_kind = 'work_item'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind NOT IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue',
        'workflow_run', 'workflow_run_cancel', 'workflow_run_review',
        'work_item_promote'
      )
      AND target_kind IS NULL
      AND target_id IS NULL
      AND target_revision IS NULL)
  );

CREATE TABLE public.work_items (
  work_item_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  project_id public.product_identifier,
  schema_version text COLLATE "C" NOT NULL,
  title text NOT NULL,
  objective text NOT NULL,
  status text COLLATE "C" NOT NULL,
  priority text COLLATE "C" NOT NULL,
  accountable_owner_user_id public.product_identifier NOT NULL,
  requestor_user_id public.product_identifier NOT NULL,
  work_thread_id public.product_identifier NOT NULL,
  source_kind text COLLATE "C" NOT NULL,
  due_at timestamptz,
  blocked_reason text,
  next_action text,
  created_by_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT work_items_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT work_items_accountable_owner_fk
    FOREIGN KEY (workspace_id, accountable_owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_items_requestor_fk
    FOREIGN KEY (workspace_id, requestor_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_items_created_by_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_items_workspace_identity_uq UNIQUE (workspace_id, work_item_id),
  CONSTRAINT work_items_thread_identity_uq UNIQUE (workspace_id, work_thread_id),
  CONSTRAINT work_items_workspace_thread_identity_uq
    UNIQUE (workspace_id, work_item_id, work_thread_id),
  CONSTRAINT work_items_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT work_items_title CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT work_items_objective CHECK (length(btrim(objective)) BETWEEN 1 AND 2000),
  CONSTRAINT work_items_status CHECK (status IN (
    'draft', 'ready', 'active', 'waiting_review', 'completed', 'blocked', 'cancelled'
  )),
  CONSTRAINT work_items_priority CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  CONSTRAINT work_items_source CHECK (source_kind = 'private_agent_task'),
  CONSTRAINT work_items_completed_shape CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT work_items_time_order CHECK (updated_at >= created_at),
  CONSTRAINT work_items_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT work_items_private_payload_forbidden CHECK (
    NOT (payload ?| ARRAY[
      'sourceSessionId', 'source_session_id', 'transcript', 'rawTranscript',
      'workerLog', 'worker_log', 'providerPayload', 'provider_payload', 'secret'
    ])
  )
);

CREATE INDEX work_items_workspace_updated_idx
  ON public.work_items (workspace_id, updated_at DESC, work_item_id DESC);

-- This is deliberately the only relation that retains private task provenance.
-- It is never projected by the Product API or Work Thread read model.
CREATE TABLE public.work_item_promotions (
  promotion_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  source_session_id public.product_identifier NOT NULL,
  source_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT work_item_promotions_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES public.work_items (workspace_id, work_item_id),
  CONSTRAINT work_item_promotions_command_fk
    FOREIGN KEY (product_command_id) REFERENCES public.product_commands (command_id),
  CONSTRAINT work_item_promotions_source_session_fk
    FOREIGN KEY (source_session_id, source_user_id, workspace_id)
    REFERENCES public.agent_sessions (session_id, user_id, workspace_id),
  CONSTRAINT work_item_promotions_workspace_identity_uq UNIQUE (workspace_id, promotion_id),
  CONSTRAINT work_item_promotions_source_session_uq UNIQUE (workspace_id, source_session_id),
  CONSTRAINT work_item_promotions_work_item_uq UNIQUE (workspace_id, work_item_id),
  CONSTRAINT work_item_promotions_command_uq UNIQUE (product_command_id)
);

CREATE TABLE public.work_item_handoff_capsules (
  handoff_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  promotion_id public.product_identifier NOT NULL,
  summary text NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  created_by_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT work_item_handoff_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES public.work_items (workspace_id, work_item_id),
  CONSTRAINT work_item_handoff_promotion_fk
    FOREIGN KEY (workspace_id, promotion_id)
    REFERENCES public.work_item_promotions (workspace_id, promotion_id),
  CONSTRAINT work_item_handoff_creator_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_handoff_identity_uq UNIQUE (workspace_id, handoff_id),
  CONSTRAINT work_item_handoff_promotion_uq UNIQUE (workspace_id, promotion_id),
  CONSTRAINT work_item_handoff_summary CHECK (length(btrim(summary)) BETWEEN 1 AND 8000),
  CONSTRAINT work_item_handoff_hash CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT work_item_handoff_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT work_item_handoff_private_payload_forbidden CHECK (
    NOT (payload ?| ARRAY[
      'sourceSessionId', 'source_session_id', 'transcript', 'rawTranscript',
      'workerLog', 'worker_log', 'providerPayload', 'provider_payload', 'secret'
    ])
  )
);

CREATE TABLE public.work_item_access_grants (
  grant_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  access_level text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  promotion_id public.product_identifier NOT NULL,
  created_by_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_by_user_id public.product_identifier,
  revoked_at timestamptz,
  CONSTRAINT work_item_access_grants_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES public.work_items (workspace_id, work_item_id),
  CONSTRAINT work_item_access_grants_promotion_fk
    FOREIGN KEY (workspace_id, promotion_id)
    REFERENCES public.work_item_promotions (workspace_id, promotion_id),
  CONSTRAINT work_item_access_grants_user_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_access_grants_creator_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_access_grants_revoker_fk
    FOREIGN KEY (workspace_id, revoked_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_access_grants_identity_uq UNIQUE (workspace_id, grant_id),
  CONSTRAINT work_item_access_grants_access CHECK (access_level IN ('owner', 'contribute', 'read')),
  CONSTRAINT work_item_access_grants_status CHECK (status IN ('active', 'revoked')),
  CONSTRAINT work_item_access_grants_revocation_shape CHECK (
    (status = 'active' AND revoked_by_user_id IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_by_user_id IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX work_item_access_grants_one_active_user_uq
  ON public.work_item_access_grants (workspace_id, work_item_id, user_id)
  WHERE status = 'active';
CREATE INDEX work_item_access_grants_active_lookup_idx
  ON public.work_item_access_grants (workspace_id, user_id, work_item_id)
  WHERE status = 'active';

CREATE TABLE public.work_item_member_roles (
  workspace_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  role text COLLATE "C" NOT NULL,
  created_by_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, work_item_id, user_id, role),
  CONSTRAINT work_item_member_roles_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES public.work_items (workspace_id, work_item_id),
  CONSTRAINT work_item_member_roles_user_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_member_roles_creator_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_member_roles_role CHECK (role IN (
    'accountable_owner', 'requestor', 'assignee', 'reviewer', 'participant', 'watcher'
  ))
);

CREATE TABLE public.work_item_decisions (
  decision_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  question text NOT NULL,
  options jsonb NOT NULL,
  chosen_outcome text NOT NULL,
  rationale text,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_objects jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_user_id public.product_identifier NOT NULL,
  approver_user_id public.product_identifier,
  supersedes_decision_id public.product_identifier,
  created_at timestamptz NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  CONSTRAINT work_item_decisions_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES public.work_items (workspace_id, work_item_id),
  CONSTRAINT work_item_decisions_author_fk
    FOREIGN KEY (workspace_id, author_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_decisions_approver_fk
    FOREIGN KEY (workspace_id, approver_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_decisions_supersedes_fk
    FOREIGN KEY (workspace_id, supersedes_decision_id)
    REFERENCES public.work_item_decisions (workspace_id, decision_id),
  CONSTRAINT work_item_decisions_identity_uq UNIQUE (workspace_id, decision_id),
  CONSTRAINT work_item_decisions_question CHECK (length(btrim(question)) BETWEEN 1 AND 1000),
  CONSTRAINT work_item_decisions_options CHECK (jsonb_typeof(options) = 'array'),
  CONSTRAINT work_item_decisions_chosen_outcome CHECK (length(btrim(chosen_outcome)) BETWEEN 1 AND 2000),
  CONSTRAINT work_item_decisions_evidence_refs CHECK (jsonb_typeof(evidence_refs) = 'array'),
  CONSTRAINT work_item_decisions_affected_objects CHECK (jsonb_typeof(affected_objects) = 'array'),
  CONSTRAINT work_item_decisions_hash CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$')
);

CREATE INDEX work_item_decisions_work_item_idx
  ON public.work_item_decisions (workspace_id, work_item_id, created_at, decision_id);

CREATE TABLE public.work_item_artifact_refs (
  workspace_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  artifact_id public.product_identifier NOT NULL,
  media_type text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  storage_version text COLLATE "C" NOT NULL,
  published_by_user_id public.product_identifier NOT NULL,
  published_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, work_item_id, artifact_id),
  CONSTRAINT work_item_artifact_refs_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES public.work_items (workspace_id, work_item_id),
  CONSTRAINT work_item_artifact_refs_publisher_fk
    FOREIGN KEY (workspace_id, published_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_artifact_refs_media_type CHECK (
    media_type IN ('image/png', 'image/jpeg', 'image/webp')
  ),
  CONSTRAINT work_item_artifact_refs_hash CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT work_item_artifact_refs_storage_version CHECK (length(storage_version) BETWEEN 1 AND 512)
);

CREATE TABLE public.work_thread_entries (
  entry_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  work_thread_id public.product_identifier NOT NULL,
  sequence bigint NOT NULL,
  entry_kind text COLLATE "C" NOT NULL,
  summary text NOT NULL,
  handoff_id public.product_identifier,
  decision_id public.product_identifier,
  artifact_id public.product_identifier,
  content_hash text COLLATE "C" NOT NULL,
  created_by_user_id public.product_identifier NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT work_thread_entries_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id, work_thread_id)
    REFERENCES public.work_items (workspace_id, work_item_id, work_thread_id),
  CONSTRAINT work_thread_entries_handoff_fk
    FOREIGN KEY (workspace_id, handoff_id)
    REFERENCES public.work_item_handoff_capsules (workspace_id, handoff_id),
  CONSTRAINT work_thread_entries_decision_fk
    FOREIGN KEY (workspace_id, decision_id)
    REFERENCES public.work_item_decisions (workspace_id, decision_id),
  CONSTRAINT work_thread_entries_artifact_fk
    FOREIGN KEY (workspace_id, work_item_id, artifact_id)
    REFERENCES public.work_item_artifact_refs (workspace_id, work_item_id, artifact_id),
  CONSTRAINT work_thread_entries_creator_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_thread_entries_identity_uq UNIQUE (workspace_id, entry_id),
  CONSTRAINT work_thread_entries_sequence_uq UNIQUE (workspace_id, work_item_id, sequence),
  CONSTRAINT work_thread_entries_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT work_thread_entries_kind CHECK (entry_kind IN ('handoff', 'decision', 'artifact')),
  CONSTRAINT work_thread_entries_reference_shape CHECK (
    (entry_kind = 'handoff' AND handoff_id IS NOT NULL AND decision_id IS NULL AND artifact_id IS NULL)
    OR (entry_kind = 'decision' AND handoff_id IS NULL AND decision_id IS NOT NULL AND artifact_id IS NULL)
    OR (entry_kind = 'artifact' AND handoff_id IS NULL AND decision_id IS NULL AND artifact_id IS NOT NULL)
  ),
  CONSTRAINT work_thread_entries_summary CHECK (length(btrim(summary)) BETWEEN 1 AND 8000),
  CONSTRAINT work_thread_entries_hash CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT work_thread_entries_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT work_thread_entries_private_payload_forbidden CHECK (
    NOT (payload ?| ARRAY[
      'sourceSessionId', 'source_session_id', 'transcript', 'rawTranscript',
      'workerLog', 'worker_log', 'providerPayload', 'provider_payload', 'secret'
    ])
  )
);

CREATE INDEX work_thread_entries_work_item_idx
  ON public.work_thread_entries (workspace_id, work_item_id, sequence, entry_id);
