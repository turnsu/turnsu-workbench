-- G1: a user must not be able to confirm a Handoff or apply/reject a Module
-- proposal through a membership check alone.  These decision transitions are
-- named Product Commands, with an immutable authority record and exactly one
-- durable Session event.  They deliberately do not introduce a second
-- Session event source.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.agent_session_decision_events (
  workspace_id public.product_identifier NOT NULL,
  decision_event_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  session_id public.product_identifier NOT NULL,
  session_event_id public.product_identifier NOT NULL,
  target_kind text COLLATE "C" NOT NULL,
  target_id public.product_identifier NOT NULL,
  target_revision integer NOT NULL,
  action_kind text COLLATE "C" NOT NULL,
  status_after text COLLATE "C" NOT NULL,
  actor_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, decision_event_id),
  CONSTRAINT agent_session_decision_events_command_fk
    FOREIGN KEY (product_command_id)
    REFERENCES public.product_commands (command_id),
  CONSTRAINT agent_session_decision_events_session_fk
    FOREIGN KEY (session_id)
    REFERENCES public.agent_sessions (session_id),
  CONSTRAINT agent_session_decision_events_session_event_fk
    FOREIGN KEY (session_event_id)
    REFERENCES public.agent_session_events (event_id),
  CONSTRAINT agent_session_decision_events_actor_fk
    FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT agent_session_decision_events_command_uq UNIQUE (product_command_id),
  CONSTRAINT agent_session_decision_events_session_event_uq UNIQUE (session_event_id),
  CONSTRAINT agent_session_decision_events_target_positive CHECK (target_revision >= 1),
  CONSTRAINT agent_session_decision_events_target_kind CHECK (
    (target_kind = 'agent_handoff' AND action_kind = 'agent_handoff_confirm'
      AND status_after = 'confirmed')
    OR (target_kind = 'agent_proposal' AND action_kind = 'agent_proposal_apply'
      AND status_after IN ('accepted', 'conflicting'))
    OR (target_kind = 'agent_proposal' AND action_kind = 'agent_proposal_reject'
      AND status_after = 'rejected')
  ),
  CONSTRAINT agent_session_decision_events_payload_object CHECK (
    jsonb_typeof(payload) = 'object'
  )
);

CREATE TRIGGER agent_session_decision_events_immutable
  BEFORE UPDATE OR DELETE ON public.agent_session_decision_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

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
    'work_item_promote', 'work_item_thread_entry', 'work_item_decision_record',
    'scope_policy_activate',
    'automation_create', 'automation_revise', 'automation_activate',
    'automation_pause', 'automation_archive',
    'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject'
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
      'work_item_promote', 'work_item_thread_entry', 'work_item_decision_record',
      'scope_policy_activate',
      'automation_create', 'automation_revise', 'automation_activate',
      'automation_pause', 'automation_archive',
      'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject'
    ) AND session_id IS NULL AND turn_id IS NULL)
    OR (kind IN ('builder_proposal', 'skill_test', 'cancel_skill_test', 'skill_validation')
      AND ((session_id IS NULL AND turn_id IS NULL)
        OR (session_id IS NOT NULL AND turn_id IS NOT NULL)))
  );

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_special_target_shape;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_special_target_shape CHECK (
    (kind = 'scope_create' AND effect_class = 'administrative'
      AND target_kind = 'product_scope' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'scope_principal_grant_issue' AND effect_class = 'administrative'
      AND target_kind = 'scope_principal_grant' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'policy_grant_issue' AND effect_class = 'administrative'
      AND target_kind = 'policy_grant' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'object_access_grant_issue' AND effect_class = 'administrative'
      AND target_kind = 'object_access_grant' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'workflow_run' AND effect_class = 'execute'
      AND target_kind = 'workflow_run' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'workflow_run_review' AND effect_class = 'write_local'
      AND target_kind = 'workflow_run_review' AND target_id IS NOT NULL AND target_revision >= 1)
    OR (kind = 'workflow_run_cancel' AND effect_class = 'execute'
      AND target_kind = 'workflow_run_cancellation' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'work_item_promote' AND effect_class = 'execute'
      AND target_kind = 'work_item' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'work_item_thread_entry' AND effect_class = 'write_local'
      AND target_kind = 'work_thread_entry' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'work_item_decision_record' AND effect_class = 'write_local'
      AND target_kind = 'work_item_decision' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'scope_policy_activate' AND effect_class = 'administrative'
      AND target_kind = 'scope_policy_revision' AND target_id IS NOT NULL AND target_revision >= 2)
    OR (kind = 'automation_create' AND effect_class = 'administrative'
      AND target_kind = 'automation' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'automation_revise' AND effect_class = 'administrative'
      AND target_kind = 'automation' AND target_id IS NOT NULL AND target_revision >= 2)
    OR (kind IN ('automation_activate', 'automation_pause', 'automation_archive')
      AND effect_class = 'administrative'
      AND target_kind = 'automation' AND target_id IS NOT NULL AND target_revision >= 1)
    OR (kind = 'agent_handoff_confirm' AND effect_class = 'write_local'
      AND target_kind = 'agent_handoff' AND target_id IS NOT NULL AND target_revision >= 1)
    OR (kind IN ('agent_proposal_apply', 'agent_proposal_reject')
      AND effect_class = 'write_local'
      AND target_kind = 'agent_proposal' AND target_id IS NOT NULL AND target_revision >= 1)
    OR (kind NOT IN (
        'scope_create', 'scope_principal_grant_issue', 'policy_grant_issue',
        'object_access_grant_issue', 'workflow_run', 'workflow_run_cancel',
        'workflow_run_review', 'work_item_promote', 'work_item_thread_entry',
        'work_item_decision_record', 'scope_policy_activate',
        'automation_create', 'automation_revise', 'automation_activate',
        'automation_pause', 'automation_archive',
        'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject'
      ) AND target_kind IS NULL AND target_id IS NULL AND target_revision IS NULL)
  );

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_special_completed;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_special_completed CHECK (
    kind NOT IN (
      'scope_create', 'scope_principal_grant_issue', 'policy_grant_issue',
      'object_access_grant_issue', 'workflow_run_cancel', 'workflow_run_review',
      'scope_policy_activate', 'automation_create', 'automation_revise',
      'automation_activate', 'automation_pause', 'automation_archive'
    ) OR status = 'completed'
  );

CREATE OR REPLACE FUNCTION public.validate_product_command_special_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_exists boolean;
  actual_contract jsonb;
BEGIN
  IF NEW.kind = 'scope_create' THEN
    SELECT s.creation_mode = 'command'
      AND s.creation_command_id = NEW.command_id
      AND s.creation_authority_scope_id = NEW.scope_id
      AND s.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeKind', s.scope_kind, 'ownerUserId', s.owner_user_id,
        'ownerPrincipalId', s.owner_principal_id, 'projectId', s.project_id,
        'creatorPrincipalId', s.created_by_principal_id,
        'creatorPrincipalKind', s.created_by_principal_kind,
        'policy', jsonb_build_object(
          'policyRevisionId', p.policy_revision_id, 'revision', p.revision,
          'observationTier', p.observation_tier, 'permissionMode', p.permission_mode,
          'autoApprovedEffectClasses', to_jsonb(p.auto_approved_effect_classes),
          'autoApprovedActionIds', to_jsonb(p.auto_approved_action_ids),
          'contentHash', p.policy_content_hash
        ),
        'initialGrant', jsonb_build_object(
          'grantId', g.grant_id, 'subjectPrincipalId', g.principal_id,
          'subjectPrincipalKind', g.principal_kind, 'accessKind', g.access_kind,
          'capabilities', to_jsonb(g.capabilities), 'canApprove', g.can_approve
        )
      ) INTO target_exists, actual_contract
    FROM public.product_scopes s
    JOIN public.scope_policy_revisions p
      ON p.workspace_id = s.workspace_id AND p.scope_id = s.scope_id
     AND p.policy_revision_id = s.current_policy_revision_id AND p.revision = 1
    JOIN public.scope_principal_grants g
      ON g.workspace_id = s.workspace_id AND g.scope_id = s.scope_id
     AND g.issuance_kind = 'scope_creation'
    WHERE s.workspace_id = NEW.workspace_id AND s.scope_id = NEW.target_id;
  ELSIF NEW.kind = 'scope_principal_grant_issue' THEN
    SELECT g.issuance_kind IN ('command', 'membership_recovery')
      AND g.issuance_command_id = NEW.command_id
      AND g.issuance_authority_scope_id = NEW.scope_id
      AND g.status = 'active' AND g.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeId', g.scope_id, 'grantId', g.grant_id,
        'subjectPrincipalId', g.principal_id, 'subjectPrincipalKind', g.principal_kind,
        'accessKind', g.access_kind, 'capabilities', to_jsonb(g.capabilities),
        'canApprove', g.can_approve, 'grantorPrincipalId', g.granted_by_principal_id,
        'grantorPrincipalKind', g.granted_by_principal_kind,
        'issuanceKind', g.issuance_kind, 'status', g.status
      ) INTO target_exists, actual_contract
    FROM public.scope_principal_grants g
    WHERE g.workspace_id = NEW.workspace_id AND g.grant_id = NEW.target_id;
  ELSIF NEW.kind = 'policy_grant_issue' THEN
    SELECT g.issuance_command_id = NEW.command_id AND g.scope_id = NEW.scope_id
      AND g.status = 'active' AND g.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeId', g.scope_id, 'policyGrantId', g.policy_grant_id,
        'subjectPrincipalId', g.subject_principal_id,
        'subjectPrincipalKind', g.subject_principal_kind,
        'subjectScopeGrantId', g.subject_scope_grant_id,
        'policyRevisionId', g.policy_revision_id,
        'authorizerPrincipalId', g.authorized_by_principal_id,
        'authorizerPrincipalKind', g.authorized_by_principal_kind,
        'authorizerScopeGrantId', g.authorizer_scope_grant_id,
        'expiresAt', to_char(g.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'reviewAt', CASE WHEN g.review_at IS NULL THEN NULL ELSE to_char(
          g.review_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) END,
        'status', g.status
      ) INTO target_exists, actual_contract
    FROM public.policy_grants g
    WHERE g.workspace_id = NEW.workspace_id AND g.policy_grant_id = NEW.target_id;
  ELSIF NEW.kind = 'object_access_grant_issue' THEN
    SELECT g.product_command_id = NEW.command_id AND g.scope_id = NEW.scope_id
      AND g.status = 'active' AND g.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeId', g.scope_id, 'grantId', g.grant_id, 'objectKind', g.object_kind,
        'objectId', g.object_id, 'subjectPrincipalId', g.principal_id,
        'subjectPrincipalKind', g.principal_kind, 'role', g.role,
        'capabilities', to_jsonb(g.capabilities), 'status', g.status
      ) INTO target_exists, actual_contract
    FROM public.object_access_grants g
    WHERE g.workspace_id = NEW.workspace_id AND g.grant_id = NEW.target_id;
  ELSIF NEW.kind = 'scope_policy_activate' THEN
    SELECT activation.command_id = NEW.command_id
      AND scope.current_policy_revision_id = activation.policy_revision_id
      AND policy.revision = NEW.target_revision
    INTO target_exists
    FROM public.scope_policy_activations activation
    JOIN public.product_scopes scope
      ON scope.workspace_id = activation.workspace_id AND scope.scope_id = activation.scope_id
    JOIN public.scope_policy_revisions policy
      ON policy.workspace_id = activation.workspace_id AND policy.scope_id = activation.scope_id
     AND policy.policy_revision_id = activation.policy_revision_id
    WHERE activation.workspace_id = NEW.workspace_id AND activation.scope_id = NEW.scope_id
      AND activation.policy_revision_id = NEW.target_id;
  ELSIF NEW.kind IN (
    'automation_create', 'automation_revise', 'automation_activate',
    'automation_pause', 'automation_archive'
  ) THEN
    SELECT event.command_id = NEW.command_id AND event.kind = NEW.kind
      AND event.target_revision = NEW.target_revision AND root.write_version = NEW.target_revision
      AND root.status = event.status_after
      AND ((NEW.kind = 'automation_create' AND root.current_revision_number = 1
            AND root.current_revision_id = event.automation_revision_id)
        OR (NEW.kind = 'automation_revise' AND root.current_revision_id = event.automation_revision_id)
        OR (NEW.kind IN ('automation_activate', 'automation_pause', 'automation_archive')
            AND event.automation_revision_id = root.current_revision_id))
    INTO target_exists
    FROM public.automation_lifecycle_events event
    JOIN public.automations root
      ON root.workspace_id = event.workspace_id AND root.automation_id = event.automation_id
    WHERE event.workspace_id = NEW.workspace_id AND event.automation_id = NEW.target_id;
  ELSIF NEW.kind = 'agent_handoff_confirm' THEN
    SELECT event.product_command_id = NEW.command_id
      AND event.target_kind = 'agent_handoff'
      AND event.target_id = NEW.target_id
      AND event.target_revision = NEW.target_revision
      AND event.action_kind = NEW.kind AND event.status_after = 'confirmed'
      AND event.actor_user_id = NEW.quota_user_id
      AND event.session_id = handoff.target_session_id
      AND handoff.workspace_id = NEW.workspace_id AND handoff.user_id = NEW.quota_user_id
      AND handoff.status = 'confirmed'
      AND session_event.sequence = NEW.target_revision
      AND session_event.type = 'agent.handoff.confirmed'
      AND session_event.payload ->> 'productCommandId' = NEW.command_id
    INTO target_exists
    FROM public.agent_session_decision_events event
    JOIN public.agent_handoffs handoff ON handoff.handoff_id = event.target_id
    JOIN public.agent_session_events session_event ON session_event.event_id = event.session_event_id
    WHERE event.workspace_id = NEW.workspace_id AND event.product_command_id = NEW.command_id;
  ELSIF NEW.kind IN ('agent_proposal_apply', 'agent_proposal_reject') THEN
    SELECT event.product_command_id = NEW.command_id
      AND event.target_kind = 'agent_proposal'
      AND event.target_id = NEW.target_id
      AND event.target_revision = NEW.target_revision
      AND event.action_kind = NEW.kind
      AND event.actor_user_id = NEW.quota_user_id
      AND event.session_id = proposal.session_id
      AND proposal.workspace_id = NEW.workspace_id AND proposal.user_id = NEW.quota_user_id
      AND ((NEW.kind = 'agent_proposal_apply'
            AND event.status_after IN ('accepted', 'conflicting')
            AND proposal.status = event.status_after
            AND session_event.type = CASE event.status_after
              WHEN 'accepted' THEN 'agent.proposal.accepted'
              ELSE 'agent.proposal.conflicting' END)
        OR (NEW.kind = 'agent_proposal_reject'
            AND event.status_after = 'rejected' AND proposal.status = 'rejected'
            AND session_event.type = 'agent.proposal.rejected'))
      AND session_event.sequence = NEW.target_revision
      AND session_event.payload ->> 'productCommandId' = NEW.command_id
    INTO target_exists
    FROM public.agent_session_decision_events event
    JOIN public.agent_object_proposals proposal ON proposal.proposal_id = event.target_id
    JOIN public.agent_session_events session_event ON session_event.event_id = event.session_event_id
    WHERE event.workspace_id = NEW.workspace_id AND event.product_command_id = NEW.command_id;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.status <> 'completed' OR target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'product_command_special_target_missing' USING ERRCODE = '23503';
  END IF;
  IF NEW.kind IN (
    'scope_create', 'scope_principal_grant_issue',
    'policy_grant_issue', 'object_access_grant_issue'
  ) AND actual_contract IS DISTINCT FROM NEW.target_contract THEN
    RAISE EXCEPTION 'product_command_target_contract_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

-- The non-authoritative Session envelope projection begins with the two
-- production event streams already guaranteed to carry a Product Command:
-- Agent Session events and Execution Broker events.  It has no command
-- handlers, never stores transcript content, and only gives consumers a
-- scope-local cursor plus safe object references.
CREATE TABLE public.session_domain_events (
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  event_id public.product_identifier NOT NULL,
  session_id public.product_identifier NOT NULL,
  session_kind text COLLATE "C" NOT NULL,
  session_sequence bigint NOT NULL,
  domain_sequence bigint NOT NULL,
  actor jsonb NOT NULL,
  authorizer jsonb NOT NULL,
  branch jsonb,
  lineage jsonb,
  payload_class text COLLATE "C" NOT NULL,
  payload_ref jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT session_domain_events_scope_sequence_uq
    UNIQUE (workspace_id, scope_id, domain_sequence),
  CONSTRAINT session_domain_events_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT session_domain_events_session_kind CHECK (session_kind IN (
    'personal_task', 'work_branch', 'module_creation', 'automation',
    'skill_creation', 'worker'
  )),
  CONSTRAINT session_domain_events_sequences_positive CHECK (
    session_sequence >= 1 AND domain_sequence >= 1
  ),
  CONSTRAINT session_domain_events_actor_object CHECK (jsonb_typeof(actor) = 'object'),
  CONSTRAINT session_domain_events_authorizer_object CHECK (jsonb_typeof(authorizer) = 'object'),
  CONSTRAINT session_domain_events_branch_object CHECK (
    branch IS NULL OR jsonb_typeof(branch) = 'object'
  ),
  CONSTRAINT session_domain_events_lineage_object CHECK (
    lineage IS NULL OR jsonb_typeof(lineage) = 'object'
  ),
  CONSTRAINT session_domain_events_payload_class CHECK (
    payload_class IN ('private', 'product_safe', 'internal')
  ),
  CONSTRAINT session_domain_events_payload_ref_object CHECK (
    jsonb_typeof(payload_ref) = 'object'
  )
);

CREATE TRIGGER session_domain_events_immutable
  BEFORE UPDATE OR DELETE ON public.session_domain_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

CREATE TABLE public.session_domain_scope_cursors (
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  next_sequence bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, scope_id),
  CONSTRAINT session_domain_scope_cursors_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT session_domain_scope_cursors_positive CHECK (next_sequence >= 1)
);

CREATE TABLE public.session_domain_outbox (
  outbox_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  session_event_id public.product_identifier NOT NULL,
  domain_sequence bigint NOT NULL,
  status text COLLATE "C" NOT NULL DEFAULT 'queued',
  lease_owner public.product_identifier,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT session_domain_outbox_event_fk
    FOREIGN KEY (workspace_id, session_event_id)
    REFERENCES public.session_domain_events (workspace_id, event_id),
  CONSTRAINT session_domain_outbox_event_uq UNIQUE (workspace_id, session_event_id),
  CONSTRAINT session_domain_outbox_sequence_positive CHECK (domain_sequence >= 1),
  CONSTRAINT session_domain_outbox_status CHECK (status IN (
    'queued', 'leased', 'delivered', 'failed'
  )),
  CONSTRAINT session_domain_outbox_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT session_domain_outbox_lease_shape CHECK (
    (status = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT session_domain_outbox_delivered_shape CHECK (
    (status = 'delivered') = (delivered_at IS NOT NULL)
  ),
  CONSTRAINT session_domain_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX session_domain_outbox_dispatch_idx
  ON public.session_domain_outbox (status, available_at, outbox_id)
  WHERE status IN ('queued', 'failed');

CREATE OR REPLACE FUNCTION public.project_session_domain_event(
  source_event_id public.product_identifier,
  source_session_id public.product_identifier,
  source_session_kind text,
  source_session_sequence bigint,
  source_workspace_id public.product_identifier,
  resolved_scope_id public.product_identifier,
  source_command_id public.product_identifier,
  source_payload_class text,
  source_payload_id public.product_identifier,
  source_payload_kind text,
  source_payload_state text,
  source_occurred_at timestamptz,
  source_branch jsonb DEFAULT NULL,
  source_lineage jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_row public.product_commands%ROWTYPE;
  decision_row public.authorization_decisions%ROWTYPE;
  allocated_sequence bigint;
  reference_hash text;
  actor_document jsonb;
  authorizer_document jsonb;
  payload_kind_safe text;
  payload_state_safe text;
BEGIN
  IF source_command_id IS NULL OR resolved_scope_id IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO command_row
  FROM public.product_commands command
  WHERE command.workspace_id = source_workspace_id
    AND command.command_id = source_command_id
  FOR SHARE;
  IF NOT FOUND OR command_row.scope_id <> resolved_scope_id THEN
    RAISE EXCEPTION 'session_domain_event_command_scope_mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO decision_row
  FROM public.authorization_decisions decision
  WHERE decision.workspace_id = command_row.workspace_id
    AND decision.authorization_decision_id = command_row.authorization_decision_id
  FOR SHARE;
  IF NOT FOUND OR decision_row.disposition <> 'authorized' THEN
    RAISE EXCEPTION 'session_domain_event_authority_missing' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.session_domain_events
     WHERE workspace_id = source_workspace_id AND event_id = source_event_id
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.session_domain_scope_cursors (
    workspace_id, scope_id, next_sequence, updated_at
  ) VALUES (source_workspace_id, resolved_scope_id, 2, clock_timestamp())
  ON CONFLICT (workspace_id, scope_id)
  DO UPDATE SET next_sequence = public.session_domain_scope_cursors.next_sequence + 1,
                updated_at = EXCLUDED.updated_at
  RETURNING next_sequence - 1 INTO allocated_sequence;

  actor_document := jsonb_build_object(
    'principalId', decision_row.actor_principal_id,
    'kind', decision_row.actor_principal_kind
  );
  IF decision_row.authorization_source = 'principal' THEN
    authorizer_document := jsonb_build_object(
      'kind', 'principal',
      'principal', jsonb_build_object(
        'principalId', decision_row.authorizer_principal_id,
        'kind', decision_row.authorizer_principal_kind
      )
    );
  ELSIF decision_row.authorization_source = 'policy_grant' THEN
    authorizer_document := jsonb_build_object(
      'kind', 'policy_grant',
      'policyGrantId', decision_row.policy_grant_id,
      'subject', jsonb_build_object(
        'principalId', decision_row.effective_principal_id,
        'kind', decision_row.effective_principal_kind
      ),
      'workspaceId', decision_row.workspace_id,
      'scopeId', decision_row.scope_id,
      'policyRevisionId', decision_row.policy_revision_id
    );
  ELSE
    RAISE EXCEPTION 'session_domain_event_authorizer_source_invalid' USING ERRCODE = '23514';
  END IF;
  IF source_payload_class NOT IN ('private', 'product_safe', 'internal')
    OR source_payload_kind IS NULL OR source_payload_state IS NULL THEN
    RAISE EXCEPTION 'session_domain_event_payload_reference_invalid' USING ERRCODE = '23514';
  END IF;
  payload_kind_safe := regexp_replace(lower(source_payload_kind), '[^a-z0-9]+', '_', 'g');
  payload_state_safe := regexp_replace(lower(source_payload_state), '[^a-z0-9]+', '_', 'g');
  IF payload_kind_safe !~ '^[a-z][a-z0-9_]*$'
    OR payload_state_safe !~ '^[a-z][a-z0-9_]*$'
    OR char_length(payload_kind_safe) > 64 OR char_length(payload_state_safe) > 64 THEN
    RAISE EXCEPTION 'session_domain_event_payload_reference_invalid' USING ERRCODE = '23514';
  END IF;
  reference_hash := 'sha256:' || encode(digest(concat_ws('|',
    source_event_id, source_session_id, source_session_sequence::text,
    source_payload_class, source_payload_id, source_payload_kind,
    coalesce(source_payload_state, ''), source_command_id,
    source_occurred_at::text
  ), 'sha256'), 'hex');
  INSERT INTO public.session_domain_events (
    workspace_id, scope_id, event_id, session_id, session_kind,
    session_sequence, domain_sequence, actor, authorizer, branch, lineage,
    payload_class, payload_ref, occurred_at
  ) VALUES (
    source_workspace_id, resolved_scope_id, source_event_id, source_session_id,
    source_session_kind, source_session_sequence, allocated_sequence,
    actor_document, authorizer_document, source_branch, source_lineage,
    source_payload_class, jsonb_build_object(
      'id', source_payload_id, 'kind', payload_kind_safe,
      'state', payload_state_safe, 'contentHash', reference_hash
    ), source_occurred_at
  );
  INSERT INTO public.session_domain_outbox (
    outbox_id, workspace_id, scope_id, session_event_id, domain_sequence, payload
  ) VALUES (
    ('session-outbox-' || encode(digest(source_event_id::text, 'sha256'), 'hex'))::public.product_identifier,
    source_workspace_id, resolved_scope_id, source_event_id, allocated_sequence,
    jsonb_build_object('domain', 'session', 'seq', allocated_sequence)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.project_agent_session_domain_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  session_row public.agent_sessions%ROWTYPE;
  resolved_scope_id public.product_identifier;
  resolved_command_id public.product_identifier;
  mapped_session_kind text;
  branch_document jsonb;
  continuation_work_item_id public.product_identifier;
  continuation_handoff_id public.product_identifier;
BEGIN
  SELECT * INTO session_row FROM public.agent_sessions
  WHERE session_id = NEW.session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_domain_agent_session_missing' USING ERRCODE = '23503'; END IF;
  resolved_command_id := COALESCE(
    NULLIF(NEW.payload ->> 'productCommandId', '')::public.product_identifier,
    (SELECT turn.product_command_id FROM public.agent_turns turn
      WHERE turn.turn_id = NEW.turn_id AND turn.session_id = NEW.session_id)
  );
  IF resolved_command_id IS NULL THEN RETURN NEW; END IF;
  -- The command authority scope, not a mutable object's storage scope, is the
  -- sole replay boundary.  A Module branch may operate on a shared object but
  -- remains a private user Session until it is explicitly promoted.
  SELECT command.scope_id INTO resolved_scope_id
    FROM public.product_commands command
   WHERE command.workspace_id = session_row.workspace_id
     AND command.command_id = resolved_command_id;
  IF resolved_scope_id IS NULL THEN
    RAISE EXCEPTION 'session_domain_agent_scope_missing' USING ERRCODE = '23514';
  END IF;
  SELECT continuation.work_item_id, continuation.handoff_id
    INTO continuation_work_item_id, continuation_handoff_id
    FROM public.work_item_continuations continuation
   WHERE continuation.workspace_id = session_row.workspace_id
     AND continuation.agent_session_id = session_row.session_id
   LIMIT 1;
  mapped_session_kind := CASE
    WHEN continuation_work_item_id IS NOT NULL THEN 'work_branch'
    WHEN session_row.scope_kind = 'module' THEN 'module_creation'
    ELSE 'personal_task'
  END;
  branch_document := CASE WHEN session_row.scope_kind = 'module' THEN jsonb_build_object(
    'branchId', session_row.branch_id
  ) ELSE NULL END;
  PERFORM public.project_session_domain_event(
    NEW.event_id, NEW.session_id, mapped_session_kind, NEW.sequence,
    session_row.workspace_id, resolved_scope_id, resolved_command_id,
    'product_safe', NEW.event_id, NEW.type, NEW.status,
    NEW.occurred_at, branch_document,
    jsonb_strip_nulls(jsonb_build_object(
      'productCommandId', resolved_command_id,
      'workItemId', continuation_work_item_id,
      'handoffId', continuation_handoff_id
    ))
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER agent_session_events_project_domain_envelope
  AFTER INSERT ON public.agent_session_events
  FOR EACH ROW EXECUTE FUNCTION public.project_agent_session_domain_event();

CREATE OR REPLACE FUNCTION public.project_execution_session_domain_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  invocation_row public.execution_invocations%ROWTYPE;
  command_scope_id public.product_identifier;
BEGIN
  SELECT * INTO invocation_row FROM public.execution_invocations
  WHERE invocation_id = NEW.invocation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_domain_execution_invocation_missing' USING ERRCODE = '23503'; END IF;
  SELECT scope_id INTO command_scope_id FROM public.product_commands
  WHERE workspace_id = invocation_row.workspace_id
    AND command_id = invocation_row.product_command_id;
  IF command_scope_id IS NULL THEN
    RAISE EXCEPTION 'session_domain_execution_command_missing' USING ERRCODE = '23503';
  END IF;
  PERFORM public.project_session_domain_event(
    NEW.event_id, NEW.invocation_id, 'worker', NEW.sequence,
    invocation_row.workspace_id, command_scope_id, invocation_row.product_command_id,
    'product_safe', NEW.event_id, NEW.type, NEW.status, NEW.occurred_at,
    NULL,
    jsonb_strip_nulls(jsonb_build_object(
      'runId', CASE WHEN invocation_row.controller_kind = 'workflow_run'
        THEN invocation_row.controller_id ELSE NULL END,
      'invocationId', NEW.invocation_id,
      'attemptId', NEW.attempt_id,
      'productCommandId', invocation_row.product_command_id,
      'turnId', invocation_row.lineage_turn_id
    ))
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER execution_events_project_domain_envelope
  AFTER INSERT ON public.execution_events
  FOR EACH ROW EXECUTE FUNCTION public.project_execution_session_domain_event();
