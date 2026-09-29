-- G6: an Owner's explicit governance action must remain possible after the
-- Owner has enabled unattended execution.  The active Scope Policy still
-- governs background work; this migration only permits a principal-backed,
-- explicitly approved administrative decision to manage that policy or an
-- Automation.  There is no "allow everything" path and no background
-- principal may use this exception.

CREATE OR REPLACE FUNCTION public.validate_authorization_decision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_scope public.product_scopes%ROWTYPE;
  current_policy public.scope_policy_revisions%ROWTYPE;
  actor_principal public.workspace_principals%ROWTYPE;
  effective_principal public.workspace_principals%ROWTYPE;
  authorizer_principal public.workspace_principals%ROWTYPE;
  actor_grant public.scope_principal_grants%ROWTYPE;
  effective_grant public.scope_principal_grants%ROWTYPE;
  authorizer_grant public.scope_principal_grants%ROWTYPE;
  approval_request public.authorization_decisions%ROWTYPE;
  authority_now timestamptz := clock_timestamp();
  actor_active boolean;
  effective_active boolean;
  authorizer_active boolean;
  policy_grant_active boolean;
BEGIN
  IF NEW.decided_at > authority_now THEN
    RAISE EXCEPTION 'authorization_decision_from_future';
  END IF;
  IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= authority_now THEN
    RAISE EXCEPTION 'authorization_decision_expired';
  END IF;
  IF NEW.auto_approved_effect_classes IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value
      FROM unnest(NEW.auto_approved_effect_classes) AS value
      ORDER BY value
    )
    OR NEW.auto_approved_action_ids IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value
      FROM unnest(NEW.auto_approved_action_ids) AS value
      ORDER BY value
    ) THEN
    RAISE EXCEPTION 'authorization_policy_arrays_not_canonical';
  END IF;

  SELECT * INTO current_scope
  FROM public.product_scopes
  WHERE workspace_id = NEW.workspace_id AND scope_id = NEW.scope_id
  FOR SHARE;

  IF current_scope.status <> 'active'
    OR current_scope.current_policy_revision_id <> NEW.policy_revision_id THEN
    RAISE EXCEPTION 'authorization_scope_or_policy_not_current';
  END IF;

  SELECT * INTO current_policy
  FROM public.scope_policy_revisions
  WHERE workspace_id = NEW.workspace_id
    AND scope_id = NEW.scope_id
    AND policy_revision_id = NEW.policy_revision_id
  FOR SHARE;

  IF current_policy.permission_mode <> NEW.permission_mode
    OR current_policy.auto_approved_effect_classes <> NEW.auto_approved_effect_classes
    OR current_policy.auto_approved_action_ids <> NEW.auto_approved_action_ids THEN
    RAISE EXCEPTION 'authorization_policy_snapshot_mismatch';
  END IF;

  SELECT * INTO actor_principal
  FROM public.workspace_principals
  WHERE workspace_id = NEW.workspace_id
    AND principal_id = NEW.actor_principal_id
    AND principal_kind = NEW.actor_principal_kind
  FOR SHARE;
  actor_active := actor_principal.status = 'active';
  IF actor_principal.principal_kind = 'user' THEN
    SELECT actor_active AND status = 'active' INTO actor_active
    FROM public.workspace_memberships
    WHERE workspace_id = actor_principal.workspace_id
      AND user_id = actor_principal.user_id
      AND membership_id = actor_principal.membership_id
    FOR SHARE;
  END IF;

  SELECT * INTO effective_principal
  FROM public.workspace_principals
  WHERE workspace_id = NEW.workspace_id
    AND principal_id = NEW.effective_principal_id
    AND principal_kind = NEW.effective_principal_kind
  FOR SHARE;
  effective_active := effective_principal.status = 'active';
  IF effective_principal.principal_kind = 'user' THEN
    SELECT effective_active AND status = 'active' INTO effective_active
    FROM public.workspace_memberships
    WHERE workspace_id = effective_principal.workspace_id
      AND user_id = effective_principal.user_id
      AND membership_id = effective_principal.membership_id
    FOR SHARE;
  END IF;

  SELECT * INTO actor_grant
  FROM public.scope_principal_grants
  WHERE workspace_id = NEW.workspace_id AND scope_id = NEW.scope_id
    AND grant_id = NEW.actor_scope_grant_id
  FOR SHARE;
  SELECT * INTO effective_grant
  FROM public.scope_principal_grants
  WHERE workspace_id = NEW.workspace_id AND scope_id = NEW.scope_id
    AND grant_id = NEW.effective_scope_grant_id
  FOR SHARE;

  IF actor_active IS DISTINCT FROM true
    OR effective_active IS DISTINCT FROM true
    OR actor_grant.status IS DISTINCT FROM 'active'
    OR effective_grant.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'authorization_principal_or_scope_grant_inactive';
  END IF;

  IF NEW.authorization_source = 'principal'
    AND NEW.disposition = 'authorized'
    AND NEW.approval_id IS NOT NULL THEN
    SELECT * INTO approval_request
    FROM public.authorization_decisions
    WHERE workspace_id = NEW.workspace_id
      AND authorization_decision_id = NEW.approval_id
    FOR SHARE;
    IF approval_request.disposition IS DISTINCT FROM 'approval_required'
      OR approval_request.scope_id IS DISTINCT FROM NEW.scope_id
      OR approval_request.policy_revision_id IS DISTINCT FROM NEW.policy_revision_id
      OR approval_request.actor_principal_id IS DISTINCT FROM NEW.actor_principal_id
      OR approval_request.actor_principal_kind IS DISTINCT FROM NEW.actor_principal_kind
      OR approval_request.effective_principal_id IS DISTINCT FROM NEW.effective_principal_id
      OR approval_request.effective_principal_kind IS DISTINCT FROM NEW.effective_principal_kind
      OR approval_request.action_id IS DISTINCT FROM NEW.action_id
      OR approval_request.effect_class IS DISTINCT FROM NEW.effect_class
      OR approval_request.argument_digest IS DISTINCT FROM NEW.argument_digest
      OR approval_request.target_contract IS DISTINCT FROM NEW.target_contract
      OR approval_request.expires_at IS NULL
      OR approval_request.expires_at <= authority_now THEN
      RAISE EXCEPTION 'authorization_approval_request_invalid';
    END IF;

    SELECT * INTO authorizer_principal
    FROM public.workspace_principals
    WHERE workspace_id = NEW.workspace_id
      AND principal_id = NEW.authorizer_principal_id
      AND principal_kind = NEW.authorizer_principal_kind
    FOR SHARE;
    authorizer_active := authorizer_principal.status = 'active';
    IF authorizer_principal.principal_kind = 'user' THEN
      SELECT authorizer_active AND status = 'active' INTO authorizer_active
      FROM public.workspace_memberships
      WHERE workspace_id = authorizer_principal.workspace_id
        AND user_id = authorizer_principal.user_id
        AND membership_id = authorizer_principal.membership_id
      FOR SHARE;
    END IF;
    SELECT * INTO authorizer_grant
    FROM public.scope_principal_grants
    WHERE workspace_id = NEW.workspace_id
      AND scope_id = NEW.scope_id
      AND grant_id = NEW.authorizer_scope_grant_id
    FOR SHARE;
    IF authorizer_active IS DISTINCT FROM true
      OR authorizer_grant.status IS DISTINCT FROM 'active'
      OR authorizer_grant.can_approve IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'authorization_approver_inactive_or_forbidden';
    END IF;
  END IF;

  IF NEW.authorization_source = 'policy_grant' THEN
    SELECT status = 'active' AND expires_at > authority_now
    INTO policy_grant_active
    FROM public.policy_grants
    WHERE workspace_id = NEW.workspace_id
      AND scope_id = NEW.scope_id
      AND policy_grant_id = NEW.policy_grant_id
    FOR SHARE;
    IF policy_grant_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'authorization_policy_grant_inactive';
    END IF;
  END IF;

  IF NEW.disposition = 'authorized' THEN
    IF NEW.permission_mode IN ('discuss', 'plan') AND NEW.effect_class <> 'read'
      AND NOT (
        NEW.authorization_source = 'principal'
        AND NEW.approval_id IS NOT NULL
        AND NEW.effect_class = 'administrative'
        AND NEW.action_id IN (
          'scope_policy_activate', 'automation_pause', 'automation_archive'
        )
      ) THEN
      RAISE EXCEPTION 'authorization_read_only_mode';
    ELSIF NEW.permission_mode = 'interactive'
      AND NEW.effect_class <> 'read'
      AND NEW.approval_id IS NULL THEN
      RAISE EXCEPTION 'authorization_interactive_approval_required';
    ELSIF NEW.permission_mode = 'auto' AND NEW.authorization_source = 'policy_grant' AND (
      NEW.effect_class = 'administrative'
      OR NOT (NEW.effect_class = ANY(NEW.auto_approved_effect_classes))
    ) THEN
      RAISE EXCEPTION 'authorization_auto_policy_mismatch';
    ELSIF NEW.permission_mode = 'auto' AND NEW.authorization_source = 'principal'
      AND NEW.effect_class <> 'read' AND NEW.approval_id IS NULL THEN
      RAISE EXCEPTION 'authorization_explicit_approval_required';
    ELSIF NEW.permission_mode = 'custom' AND NEW.authorization_source = 'policy_grant' AND (
      NEW.effect_class = 'administrative'
      OR NOT (NEW.action_id = ANY(NEW.auto_approved_action_ids))
    ) THEN
      RAISE EXCEPTION 'authorization_custom_policy_mismatch';
    ELSIF NEW.permission_mode = 'custom' AND NEW.authorization_source = 'principal'
      AND NEW.effect_class <> 'read' AND NEW.approval_id IS NULL THEN
      RAISE EXCEPTION 'authorization_explicit_approval_required';
    END IF;
  ELSIF NEW.disposition = 'approval_required'
    AND NEW.permission_mode IN ('discuss', 'plan') THEN
    RAISE EXCEPTION 'authorization_read_only_mode_cannot_request_approval';
  END IF;

  RETURN NEW;
END;
$function$;

-- Scope policy revisions are immutable documents.  Their activation is a
-- separate append-only event so the current pointer, the policy document, and
-- the completed Product Command can be checked together.
CREATE TABLE public.scope_policy_activations (
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  policy_revision_id public.product_identifier NOT NULL,
  policy_revision_number integer NOT NULL,
  prior_policy_revision_id public.product_identifier NOT NULL,
  command_id public.product_identifier NOT NULL,
  activated_by_user_id public.product_identifier NOT NULL,
  activated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, scope_id, policy_revision_id),
  CONSTRAINT scope_policy_activations_policy_fk
    FOREIGN KEY (workspace_id, scope_id, policy_revision_id)
    REFERENCES public.scope_policy_revisions (workspace_id, scope_id, policy_revision_id),
  CONSTRAINT scope_policy_activations_prior_policy_fk
    FOREIGN KEY (workspace_id, scope_id, prior_policy_revision_id)
    REFERENCES public.scope_policy_revisions (workspace_id, scope_id, policy_revision_id),
  CONSTRAINT scope_policy_activations_command_fk
    FOREIGN KEY (command_id) REFERENCES public.product_commands (command_id),
  CONSTRAINT scope_policy_activations_actor_fk
    FOREIGN KEY (workspace_id, activated_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT scope_policy_activations_number_positive CHECK (policy_revision_number >= 2),
  CONSTRAINT scope_policy_activations_distinct_policy CHECK (
    policy_revision_id <> prior_policy_revision_id
  ),
  CONSTRAINT scope_policy_activations_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT scope_policy_activations_command_uq UNIQUE (command_id)
);

CREATE TRIGGER scope_policy_activations_immutable
  BEFORE UPDATE OR DELETE ON public.scope_policy_activations
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

-- Automation lifecycle events are not a second scheduler state machine.  They
-- bind each completed administration command to the Automation aggregate that
-- it created or advanced.
CREATE TABLE public.automation_lifecycle_events (
  workspace_id public.product_identifier NOT NULL,
  command_id public.product_identifier NOT NULL,
  automation_id public.product_identifier NOT NULL,
  automation_revision_id public.product_identifier,
  kind text COLLATE "C" NOT NULL,
  target_revision integer NOT NULL,
  status_after text COLLATE "C" NOT NULL,
  created_by_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, command_id),
  CONSTRAINT automation_lifecycle_events_root_fk
    FOREIGN KEY (workspace_id, automation_id)
    REFERENCES public.automations (workspace_id, automation_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT automation_lifecycle_events_revision_fk
    FOREIGN KEY (workspace_id, automation_revision_id)
    REFERENCES public.automation_revisions (workspace_id, automation_revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT automation_lifecycle_events_command_fk
    FOREIGN KEY (command_id) REFERENCES public.product_commands (command_id),
  CONSTRAINT automation_lifecycle_events_actor_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT automation_lifecycle_events_kind CHECK (kind IN (
    'automation_create', 'automation_revise', 'automation_activate',
    'automation_pause', 'automation_archive'
  )),
  CONSTRAINT automation_lifecycle_events_target_positive CHECK (target_revision >= 1),
  CONSTRAINT automation_lifecycle_events_status CHECK (status_after IN (
    'active', 'paused', 'archived'
  )),
  CONSTRAINT automation_lifecycle_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT automation_lifecycle_events_command_uq UNIQUE (command_id)
);

CREATE INDEX automation_lifecycle_events_automation_created_idx
  ON public.automation_lifecycle_events (workspace_id, automation_id, created_at DESC, command_id DESC);

CREATE TRIGGER automation_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON public.automation_lifecycle_events
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
    'automation_pause', 'automation_archive'
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
      'automation_pause', 'automation_archive'
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
    OR (kind = 'work_item_thread_entry'
      AND effect_class = 'write_local'
      AND target_kind = 'work_thread_entry'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind = 'work_item_decision_record'
      AND effect_class = 'write_local'
      AND target_kind = 'work_item_decision'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind = 'scope_policy_activate'
      AND effect_class = 'administrative'
      AND target_kind = 'scope_policy_revision'
      AND target_id IS NOT NULL
      AND target_revision >= 2)
    OR (kind = 'automation_create'
      AND effect_class = 'administrative'
      AND target_kind = 'automation'
      AND target_id IS NOT NULL
      AND target_revision = 1)
    OR (kind = 'automation_revise'
      AND effect_class = 'administrative'
      AND target_kind = 'automation'
      AND target_id IS NOT NULL
      AND target_revision >= 2)
    OR (kind IN ('automation_activate', 'automation_pause', 'automation_archive')
      AND effect_class = 'administrative'
      AND target_kind = 'automation'
      AND target_id IS NOT NULL
      AND target_revision >= 1)
    OR (kind NOT IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue',
        'workflow_run', 'workflow_run_cancel', 'workflow_run_review',
        'work_item_promote', 'work_item_thread_entry', 'work_item_decision_record',
        'scope_policy_activate',
        'automation_create', 'automation_revise', 'automation_activate',
        'automation_pause', 'automation_archive'
      )
      AND target_kind IS NULL
      AND target_id IS NULL
      AND target_revision IS NULL)
  );

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_special_completed;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_special_completed CHECK (
    kind NOT IN (
      'scope_create', 'scope_principal_grant_issue',
      'policy_grant_issue', 'object_access_grant_issue',
      'workflow_run_cancel', 'workflow_run_review',
      'scope_policy_activate',
      'automation_create', 'automation_revise', 'automation_activate',
      'automation_pause', 'automation_archive'
    ) OR status = 'completed'
  );

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_target_contract_shape;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_target_contract_shape CHECK (
    (kind IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue'
      )
      AND target_contract IS NOT NULL
      AND jsonb_typeof(target_contract) = 'object')
    OR (kind NOT IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue'
      ) AND target_contract IS NULL)
  );

ALTER TABLE public.authorization_decisions
  DROP CONSTRAINT authorization_decisions_target_contract_shape;
ALTER TABLE public.authorization_decisions
  ADD CONSTRAINT authorization_decisions_target_contract_shape CHECK (
    (action_id IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue'
      )
      AND target_contract IS NOT NULL
      AND jsonb_typeof(target_contract) = 'object')
    OR (action_id NOT IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue'
      ) AND target_contract IS NULL)
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
        'scopeKind', s.scope_kind,
        'ownerUserId', s.owner_user_id,
        'ownerPrincipalId', s.owner_principal_id,
        'projectId', s.project_id,
        'creatorPrincipalId', s.created_by_principal_id,
        'creatorPrincipalKind', s.created_by_principal_kind,
        'policy', jsonb_build_object(
          'policyRevisionId', p.policy_revision_id,
          'revision', p.revision,
          'observationTier', p.observation_tier,
          'permissionMode', p.permission_mode,
          'autoApprovedEffectClasses', to_jsonb(p.auto_approved_effect_classes),
          'autoApprovedActionIds', to_jsonb(p.auto_approved_action_ids),
          'contentHash', p.policy_content_hash
        ),
        'initialGrant', jsonb_build_object(
          'grantId', g.grant_id,
          'subjectPrincipalId', g.principal_id,
          'subjectPrincipalKind', g.principal_kind,
          'accessKind', g.access_kind,
          'capabilities', to_jsonb(g.capabilities),
          'canApprove', g.can_approve
        )
      )
    INTO target_exists, actual_contract
    FROM public.product_scopes s
    JOIN public.scope_policy_revisions p
      ON p.workspace_id = s.workspace_id
     AND p.scope_id = s.scope_id
     AND p.policy_revision_id = s.current_policy_revision_id
     AND p.revision = 1
    JOIN public.scope_principal_grants g
      ON g.workspace_id = s.workspace_id
     AND g.scope_id = s.scope_id
     AND g.issuance_kind = 'scope_creation'
    WHERE s.workspace_id = NEW.workspace_id AND s.scope_id = NEW.target_id;
  ELSIF NEW.kind = 'scope_principal_grant_issue' THEN
    SELECT g.issuance_kind IN ('command', 'membership_recovery')
      AND g.issuance_command_id = NEW.command_id
      AND g.issuance_authority_scope_id = NEW.scope_id
      AND g.status = 'active'
      AND g.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeId', g.scope_id,
        'grantId', g.grant_id,
        'subjectPrincipalId', g.principal_id,
        'subjectPrincipalKind', g.principal_kind,
        'accessKind', g.access_kind,
        'capabilities', to_jsonb(g.capabilities),
        'canApprove', g.can_approve,
        'grantorPrincipalId', g.granted_by_principal_id,
        'grantorPrincipalKind', g.granted_by_principal_kind,
        'issuanceKind', g.issuance_kind,
        'status', g.status
      )
    INTO target_exists, actual_contract
    FROM public.scope_principal_grants g
    WHERE g.workspace_id = NEW.workspace_id AND g.grant_id = NEW.target_id;
  ELSIF NEW.kind = 'policy_grant_issue' THEN
    SELECT g.issuance_command_id = NEW.command_id
      AND g.scope_id = NEW.scope_id
      AND g.status = 'active'
      AND g.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeId', g.scope_id,
        'policyGrantId', g.policy_grant_id,
        'subjectPrincipalId', g.subject_principal_id,
        'subjectPrincipalKind', g.subject_principal_kind,
        'subjectScopeGrantId', g.subject_scope_grant_id,
        'policyRevisionId', g.policy_revision_id,
        'authorizerPrincipalId', g.authorized_by_principal_id,
        'authorizerPrincipalKind', g.authorized_by_principal_kind,
        'authorizerScopeGrantId', g.authorizer_scope_grant_id,
        'expiresAt', to_char(
          g.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'reviewAt', CASE WHEN g.review_at IS NULL THEN NULL ELSE to_char(
          g.review_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) END,
        'status', g.status
      )
    INTO target_exists, actual_contract
    FROM public.policy_grants g
    WHERE g.workspace_id = NEW.workspace_id AND g.policy_grant_id = NEW.target_id;
  ELSIF NEW.kind = 'object_access_grant_issue' THEN
    SELECT g.product_command_id = NEW.command_id
      AND g.scope_id = NEW.scope_id
      AND g.status = 'active'
      AND g.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeId', g.scope_id,
        'grantId', g.grant_id,
        'objectKind', g.object_kind,
        'objectId', g.object_id,
        'subjectPrincipalId', g.principal_id,
        'subjectPrincipalKind', g.principal_kind,
        'role', g.role,
        'capabilities', to_jsonb(g.capabilities),
        'status', g.status
      )
    INTO target_exists, actual_contract
    FROM public.object_access_grants g
    WHERE g.workspace_id = NEW.workspace_id AND g.grant_id = NEW.target_id;
  ELSIF NEW.kind = 'scope_policy_activate' THEN
    SELECT activation.command_id = NEW.command_id
      AND scope.current_policy_revision_id = activation.policy_revision_id
      AND policy.revision = NEW.target_revision
    INTO target_exists
    FROM public.scope_policy_activations activation
    JOIN public.product_scopes scope
      ON scope.workspace_id = activation.workspace_id
     AND scope.scope_id = activation.scope_id
    JOIN public.scope_policy_revisions policy
      ON policy.workspace_id = activation.workspace_id
     AND policy.scope_id = activation.scope_id
     AND policy.policy_revision_id = activation.policy_revision_id
    WHERE activation.workspace_id = NEW.workspace_id
      AND activation.scope_id = NEW.scope_id
      AND activation.policy_revision_id = NEW.target_id;
  ELSIF NEW.kind IN (
    'automation_create', 'automation_revise', 'automation_activate',
    'automation_pause', 'automation_archive'
  ) THEN
    SELECT event.command_id = NEW.command_id
      AND event.kind = NEW.kind
      AND event.target_revision = NEW.target_revision
      AND root.write_version = NEW.target_revision
      AND root.status = event.status_after
      AND (
        (NEW.kind = 'automation_create'
          AND root.current_revision_number = 1
          AND root.current_revision_id = event.automation_revision_id)
        OR (NEW.kind = 'automation_revise'
          AND root.current_revision_id = event.automation_revision_id)
        OR (NEW.kind IN ('automation_activate', 'automation_pause', 'automation_archive')
          AND event.automation_revision_id = root.current_revision_id)
      )
    INTO target_exists
    FROM public.automation_lifecycle_events event
    JOIN public.automations root
      ON root.workspace_id = event.workspace_id
     AND root.automation_id = event.automation_id
    WHERE event.workspace_id = NEW.workspace_id
      AND event.automation_id = NEW.target_id;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.status <> 'completed' OR target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'product_command_special_target_missing'
      USING ERRCODE = '23503';
  END IF;
  IF actual_contract IS DISTINCT FROM NEW.target_contract THEN
    RAISE EXCEPTION 'product_command_target_contract_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

-- A Run's public ResourceRef uses `version`, while the Automation pin ledger
-- uses the explicit database name `resource_version`.  The old projection
-- compared different shapes and therefore made a resource-pinned Automation
-- impossible to accept.  Preserve the exact pinned resource and attach the
-- public-safe label from the pinned Resource row.
CREATE OR REPLACE FUNCTION public.validate_automation_occurrence_accepted_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  occurrence_row public.automation_occurrences%ROWTYPE;
  revision_row public.automation_revisions%ROWTYPE;
  accepted_valid boolean;
  expected_resources jsonb;
  actual_resources jsonb;
BEGIN
  IF TG_TABLE_NAME = 'automation_occurrences' THEN
    occurrence_row := NEW;
  ELSE
    SELECT occurrence.* INTO occurrence_row
    FROM public.automation_occurrences occurrence
    WHERE occurrence.workspace_id = NEW.workspace_id
      AND (
        (TG_TABLE_NAME = 'product_commands'
          AND occurrence.product_command_id = NEW.command_id)
        OR (TG_TABLE_NAME = 'workflow_runs'
          AND occurrence.run_id = NEW.run_id)
      );
  END IF;
  IF occurrence_row.status IS DISTINCT FROM 'accepted' THEN RETURN NEW; END IF;

  SELECT * INTO revision_row
  FROM public.automation_revisions revision
  WHERE revision.workspace_id = occurrence_row.workspace_id
    AND revision.automation_revision_id
      = occurrence_row.automation_revision_id;
  PERFORM public.assert_automation_revision_consumable(
    occurrence_row.workspace_id, occurrence_row.automation_id,
    occurrence_row.automation_revision_id,
    occurrence_row.observed_policy_grant_revision
  );

  SELECT decision.actor_principal_kind = 'scheduler'
    AND decision.effective_principal_id = revision_row.automation_principal_id
    AND decision.effective_principal_kind = 'automation'
    AND decision.authorization_source = 'policy_grant'
    AND decision.policy_grant_id = revision_row.policy_grant_id
    AND decision.scope_id = revision_row.scope_id
    AND decision.policy_revision_id = revision_row.scope_policy_revision_id
    AND decision.action_id = 'workflow_run'
    AND decision.effect_class = 'execute'
    AND decision.disposition = 'authorized'
    AND decision.decided_at <= occurrence_row.accepted_at
    AND command.authorization_decision_id
      = occurrence_row.authorization_decision_id
    AND command.actor_principal_id = decision.actor_principal_id
    AND command.actor_principal_kind = 'scheduler'
    AND command.effective_principal_id = revision_row.automation_principal_id
    AND command.effective_principal_kind = 'automation'
    AND command.scope_id = revision_row.scope_id
    AND command.policy_revision_id = revision_row.scope_policy_revision_id
    AND command.kind = 'workflow_run'
    AND command.effect_class = 'execute'
    AND command.target_kind = 'workflow_run'
    AND command.target_id = occurrence_row.run_id
    AND command.target_revision = 1
    AND command.quota_user_id = revision_row.owner_user_id
    AND command.status = 'accepted'
    AND run.scope_id = revision_row.scope_id
    AND run.workflow_id = revision_row.workflow_id
    AND run.workflow_revision_id = revision_row.workflow_revision_id
    AND run.workflow_revision_content_hash
      = revision_row.workflow_revision_content_hash
    AND run.compile_result_id = revision_row.compile_result_id
    AND run.execution_plan_id = revision_row.execution_plan_id
    AND run.execution_plan_content_hash
      = revision_row.execution_plan_content_hash
    AND run.idempotency_key = occurrence_row.occurrence_id
    AND run.status = 'queued'
    AND run.event_sequence = 1
    AND run.inputs = '{}'::jsonb
  INTO accepted_valid
  FROM public.authorization_decisions decision
  JOIN public.product_commands command
    ON command.workspace_id = decision.workspace_id
   AND command.command_id = occurrence_row.product_command_id
  JOIN public.workflow_runs run
    ON run.workspace_id = command.workspace_id
   AND run.product_command_id = command.command_id
   AND run.run_id = occurrence_row.run_id
  WHERE decision.workspace_id = occurrence_row.workspace_id
    AND decision.authorization_decision_id
      = occurrence_row.authorization_decision_id;
  IF accepted_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'automation_occurrence_accepted_lineage_mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'resourceId', input_pin.resource_id,
      'version', input_pin.resource_version,
      'label', resource.label,
      'contentHash', input_pin.resource_content_hash
    ) ORDER BY input_pin.input_name), '[]'::jsonb)
  INTO expected_resources
  FROM public.automation_input_pins input_pin
  JOIN public.workspace_resources resource
    ON resource.workspace_id = input_pin.workspace_id
   AND resource.resource_id = input_pin.resource_id
   AND resource.resource_version = input_pin.resource_version
   AND resource.content_hash = input_pin.resource_content_hash
  WHERE input_pin.workspace_id = occurrence_row.workspace_id
    AND input_pin.automation_revision_id
      = occurrence_row.automation_revision_id;
  SELECT run.resource_refs INTO actual_resources
  FROM public.workflow_runs run
  WHERE run.workspace_id = occurrence_row.workspace_id
    AND run.run_id = occurrence_row.run_id;
  IF actual_resources IS DISTINCT FROM expected_resources THEN
    RAISE EXCEPTION 'automation_occurrence_resource_pin_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
