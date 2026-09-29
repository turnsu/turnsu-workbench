-- G1 Harness bridge: an external Tool call is a Product-owned approval
-- aggregate.  Kernel/Worker may request it over a narrow RPC seam, but only
-- an explicit Product Command can decide it and queue a resumptive Agent Turn.

CREATE TABLE public.agent_tool_approvals (
  approval_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  scope_id public.product_identifier NOT NULL,
  policy_revision_id public.product_identifier NOT NULL,
  owner_user_id public.product_identifier NOT NULL,
  session_id public.product_identifier NOT NULL,
  source_turn_id public.product_identifier NOT NULL,
  source_product_command_id public.product_identifier NOT NULL,
  source_invocation_id public.product_identifier NOT NULL,
  source_attempt_id public.product_identifier NOT NULL,
  source_capability_lease_id public.product_identifier NOT NULL,
  tool_id public.product_identifier NOT NULL,
  connection_id public.product_identifier NOT NULL,
  input_digest text COLLATE "C" NOT NULL,
  authorization_request_id public.product_identifier NOT NULL,
  tool_authorization_decision_id public.product_identifier,
  decision_authorization_decision_id public.product_identifier,
  decision_command_id public.product_identifier,
  resume_turn_id public.product_identifier,
  status text COLLATE "C" NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_tool_approvals_schema_version
    CHECK (schema_version = 'workbench-agent-tool-approval-v1'),
  CONSTRAINT agent_tool_approvals_status
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  CONSTRAINT agent_tool_approvals_revision_positive CHECK (revision >= 1),
  CONSTRAINT agent_tool_approvals_input_digest CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT agent_tool_approvals_time_order CHECK (updated_at >= created_at),
  CONSTRAINT agent_tool_approvals_terminal_shape CHECK (
    (status = 'pending' AND decided_at IS NULL
      AND tool_authorization_decision_id IS NULL
      AND decision_authorization_decision_id IS NULL
      AND decision_command_id IS NULL
      AND resume_turn_id IS NULL)
    OR (status = 'approved' AND decided_at IS NOT NULL
      AND tool_authorization_decision_id IS NOT NULL
      AND decision_authorization_decision_id IS NOT NULL
      AND decision_command_id IS NOT NULL
      AND resume_turn_id IS NOT NULL)
    OR (status = 'rejected' AND decided_at IS NOT NULL
      AND tool_authorization_decision_id IS NULL
      AND decision_authorization_decision_id IS NOT NULL
      AND decision_command_id IS NULL
      AND resume_turn_id IS NULL)
    OR (status = 'expired' AND decided_at IS NOT NULL
      AND tool_authorization_decision_id IS NULL
      AND decision_authorization_decision_id IS NULL
      AND decision_command_id IS NULL
      AND resume_turn_id IS NULL)
  ),
  CONSTRAINT agent_tool_approvals_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT agent_tool_approvals_owner_fk
    FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT agent_tool_approvals_session_fk
    FOREIGN KEY (session_id, owner_user_id, workspace_id)
    REFERENCES public.agent_sessions (session_id, user_id, workspace_id),
  CONSTRAINT agent_tool_approvals_source_turn_fk
    FOREIGN KEY (session_id, source_turn_id)
    REFERENCES public.agent_turns (session_id, turn_id),
  CONSTRAINT agent_tool_approvals_source_command_fk
    FOREIGN KEY (workspace_id, source_product_command_id)
    REFERENCES public.product_commands (workspace_id, command_id),
  CONSTRAINT agent_tool_approvals_source_invocation_fk
    FOREIGN KEY (workspace_id, source_invocation_id)
    REFERENCES public.execution_invocations (workspace_id, invocation_id),
  CONSTRAINT agent_tool_approvals_source_attempt_fk
    FOREIGN KEY (source_invocation_id, source_attempt_id)
    REFERENCES public.execution_attempts (invocation_id, attempt_id),
  CONSTRAINT agent_tool_approvals_source_lease_fk
    FOREIGN KEY (source_invocation_id, source_attempt_id, source_capability_lease_id)
    REFERENCES public.capability_leases (invocation_id, attempt_id, capability_lease_id),
  CONSTRAINT agent_tool_approvals_request_decision_fk
    FOREIGN KEY (workspace_id, authorization_request_id)
    REFERENCES public.authorization_decisions (workspace_id, authorization_decision_id),
  CONSTRAINT agent_tool_approvals_tool_decision_fk
    FOREIGN KEY (workspace_id, tool_authorization_decision_id)
    REFERENCES public.authorization_decisions (workspace_id, authorization_decision_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_tool_approvals_decision_authority_fk
    FOREIGN KEY (workspace_id, decision_authorization_decision_id)
    REFERENCES public.authorization_decisions (workspace_id, authorization_decision_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_tool_approvals_decision_command_fk
    FOREIGN KEY (workspace_id, decision_command_id)
    REFERENCES public.product_commands (workspace_id, command_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_tool_approvals_resume_turn_fk
    FOREIGN KEY (session_id, resume_turn_id)
    REFERENCES public.agent_turns (session_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT agent_tool_approvals_request_identity_uq UNIQUE (
    workspace_id, source_invocation_id, source_attempt_id, tool_id, input_digest
  )
);

CREATE INDEX agent_tool_approvals_owner_pending_idx
  ON public.agent_tool_approvals (workspace_id, owner_user_id, created_at DESC)
  WHERE status = 'pending';
CREATE UNIQUE INDEX agent_tool_approvals_resume_command_uq
  ON public.agent_tool_approvals (workspace_id, decision_command_id)
  WHERE decision_command_id IS NOT NULL;

CREATE FUNCTION public.enforce_agent_tool_approval_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'agent_tool_approval_terminal' USING ERRCODE = '55000';
  END IF;
  IF ROW(
      NEW.approval_id, NEW.workspace_id, NEW.schema_version, NEW.scope_id,
      NEW.policy_revision_id, NEW.owner_user_id, NEW.session_id,
      NEW.source_turn_id, NEW.source_product_command_id, NEW.source_invocation_id,
      NEW.source_attempt_id, NEW.source_capability_lease_id, NEW.tool_id,
      NEW.connection_id, NEW.input_digest, NEW.authorization_request_id,
      NEW.expires_at, NEW.created_at, NEW.payload
    ) IS DISTINCT FROM ROW(
      OLD.approval_id, OLD.workspace_id, OLD.schema_version, OLD.scope_id,
      OLD.policy_revision_id, OLD.owner_user_id, OLD.session_id,
      OLD.source_turn_id, OLD.source_product_command_id, OLD.source_invocation_id,
      OLD.source_attempt_id, OLD.source_capability_lease_id, OLD.tool_id,
      OLD.connection_id, OLD.input_digest, OLD.authorization_request_id,
      OLD.expires_at, OLD.created_at, OLD.payload
    ) THEN
    RAISE EXCEPTION 'agent_tool_approval_identity_immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected', 'expired')
    OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'agent_tool_approval_transition_invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER agent_tool_approvals_lifecycle_guard
  BEFORE UPDATE OR DELETE ON public.agent_tool_approvals
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_tool_approval_mutation();

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_kind;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_kind CHECK (kind IN (
    'agent_turn', 'cancel_agent_turn', 'agent_tool_approval_decide',
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
    'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject',
    'project_create', 'project_members_revise',
    'work_item_create', 'work_item_update',
    'device_register', 'device_revoke'
  ));

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_session_turn_shape;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_session_turn_shape CHECK (
    (kind IN (
      'agent_turn', 'cancel_agent_turn', 'agent_tool_approval_decide',
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
      'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject',
      'project_create', 'project_members_revise',
      'work_item_create', 'work_item_update',
      'device_register', 'device_revoke'
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
    OR (kind = 'project_create' AND effect_class = 'administrative'
      AND target_kind = 'project' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'project_members_revise' AND effect_class = 'administrative'
      AND target_kind = 'project' AND target_id IS NOT NULL AND target_revision >= 2)
    OR (kind = 'work_item_create' AND effect_class = 'write_local'
      AND target_kind = 'work_item' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'work_item_update' AND effect_class = 'write_local'
      AND target_kind = 'work_item' AND target_id IS NOT NULL AND target_revision >= 2)
    OR (kind = 'agent_turn' AND effect_class = 'execute'
      AND target_kind = 'work_item' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'agent_turn' AND effect_class = 'execute'
      AND target_kind = 'work_item_continuation_turn' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind = 'agent_tool_approval_decide' AND effect_class = 'execute'
      AND target_kind = 'agent_tool_approval' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind IN ('device_register', 'device_revoke') AND effect_class = 'administrative'
      AND target_kind = 'device' AND target_id IS NOT NULL AND target_revision >= 1)
    OR (kind NOT IN (
      'scope_create', 'scope_principal_grant_issue', 'policy_grant_issue',
      'object_access_grant_issue', 'workflow_run', 'workflow_run_cancel',
      'workflow_run_review', 'work_item_promote', 'work_item_thread_entry',
      'work_item_decision_record', 'scope_policy_activate',
      'automation_create', 'automation_revise', 'automation_activate',
      'automation_pause', 'automation_archive',
      'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject',
      'project_create', 'project_members_revise',
      'work_item_create', 'work_item_update',
      'device_register', 'device_revoke', 'agent_tool_approval_decide'
    ) AND target_kind IS NULL AND target_id IS NULL AND target_revision IS NULL)
  );

DROP TRIGGER product_commands_special_target_guard ON public.product_commands;
CREATE CONSTRAINT TRIGGER product_commands_special_target_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.kind NOT IN (
    'project_create', 'project_members_revise',
    'work_item_create', 'work_item_update',
    'device_register', 'device_revoke', 'agent_tool_approval_decide'
  ) AND NOT (NEW.kind = 'agent_turn' AND NEW.target_kind IN (
    'work_item', 'work_item_continuation_turn'
  )))
  EXECUTE FUNCTION public.validate_product_command_special_target();

CREATE FUNCTION public.validate_agent_tool_approval_product_command_target()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_exists boolean;
BEGIN
  IF NEW.kind <> 'agent_tool_approval_decide' THEN RETURN NEW; END IF;
  SELECT approval.status = 'approved'
    AND approval.scope_id = NEW.scope_id
    AND approval.owner_user_id = NEW.quota_user_id
    AND approval.session_id = NEW.session_id
    AND approval.resume_turn_id = NEW.turn_id
    AND approval.decision_command_id = NEW.command_id
    AND approval.decision_authorization_decision_id = NEW.authorization_decision_id
    AND NEW.target_kind = 'agent_tool_approval'
    AND NEW.target_id = approval.approval_id
    AND NEW.target_revision = 1
  INTO target_exists
  FROM public.agent_tool_approvals approval
  WHERE approval.workspace_id = NEW.workspace_id
    AND approval.approval_id = NEW.target_id;
  IF NEW.status NOT IN ('accepted', 'running', 'completed', 'blocked', 'failed', 'cancelled')
    OR target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'agent_tool_approval_command_target_invalid' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER product_commands_agent_tool_approval_target_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_agent_tool_approval_product_command_target();

-- Allow a resumptive Agent command to write the same sole Product Session
-- ledger.  The command remains tied to a specific approved Tool aggregate.
CREATE OR REPLACE FUNCTION public.project_execution_kernel_model_visible_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  invocation_row public.execution_invocations%ROWTYPE;
  session_row public.agent_sessions%ROWTYPE;
  turn_row public.agent_turns%ROWTYPE;
  command_row public.product_commands%ROWTYPE;
  existing_row public.agent_session_events%ROWTYPE;
  model_event jsonb;
  session_sequence bigint;
  model_event_id text;
  model_event_type text;
  event_status text;
BEGIN
  IF NEW.type <> 'agent.kernel.model_visible' THEN RETURN NEW; END IF;
  model_event := NEW.payload -> 'modelVisibleEvent';
  IF jsonb_typeof(model_event) <> 'object'
    OR model_event ->> 'schemaVersion' <> 'agent-kernel-model-visible-event-v1'
    OR model_event ->> 'eventId' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
    OR model_event ->> 'runId' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
    OR model_event ->> 'type' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(model_event -> 'session') <> 'object'
    OR model_event #>> '{session,sessionId}' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
    OR ((model_event #>> '{session,branchId}') IS NOT NULL
      AND model_event #>> '{session,branchId}' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$')
    OR jsonb_typeof(model_event -> 'sequence') <> 'number'
    OR model_event ->> 'sequence' !~ '^[1-9][0-9]*$'
    OR model_event ->> 'occurredAt' IS NULL THEN
    RAISE EXCEPTION 'kernel_session_event_invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO invocation_row FROM public.execution_invocations
   WHERE invocation_id = NEW.invocation_id FOR SHARE;
  IF NOT FOUND OR invocation_row.attempt_id <> NEW.attempt_id
    OR invocation_row.controller_kind <> 'agent_turn'
    OR invocation_row.lineage_session_id IS NULL OR invocation_row.lineage_turn_id IS NULL THEN
    RAISE EXCEPTION 'kernel_session_event_lineage_invalid' USING ERRCODE = '23503';
  END IF;
  SELECT * INTO command_row FROM public.product_commands
   WHERE workspace_id = invocation_row.workspace_id AND command_id = invocation_row.product_command_id
   FOR SHARE;
  IF NOT FOUND OR command_row.kind NOT IN ('agent_turn', 'agent_tool_approval_decide')
    OR command_row.session_id <> invocation_row.lineage_session_id
    OR command_row.turn_id <> invocation_row.lineage_turn_id
    OR (command_row.kind = 'agent_tool_approval_decide'
      AND (command_row.target_kind <> 'agent_tool_approval' OR command_row.target_id IS NULL)) THEN
    RAISE EXCEPTION 'kernel_session_event_command_invalid' USING ERRCODE = '23503';
  END IF;
  SELECT * INTO session_row FROM public.agent_sessions
   WHERE session_id = invocation_row.lineage_session_id AND workspace_id = invocation_row.workspace_id FOR UPDATE;
  SELECT * INTO turn_row FROM public.agent_turns
   WHERE turn_id = invocation_row.lineage_turn_id AND session_id = invocation_row.lineage_session_id
     AND workspace_id = invocation_row.workspace_id FOR SHARE;
  IF session_row.session_id IS NULL OR NOT FOUND
    OR turn_row.product_command_id <> invocation_row.product_command_id
    OR model_event #>> '{session,sessionId}' <> invocation_row.lineage_session_id
    OR (model_event #>> '{session,branchId}') IS DISTINCT FROM session_row.branch_id THEN
    RAISE EXCEPTION 'kernel_session_event_scope_invalid' USING ERRCODE = '23503';
  END IF;
  model_event_id := model_event ->> 'eventId'; model_event_type := model_event ->> 'type';
  SELECT * INTO existing_row FROM public.agent_session_events WHERE event_id = model_event_id FOR SHARE;
  IF FOUND THEN
    IF existing_row.session_id <> invocation_row.lineage_session_id
      OR existing_row.turn_id <> invocation_row.lineage_turn_id
      OR existing_row.payload ->> 'productCommandId' <> invocation_row.product_command_id
      OR existing_row.payload -> 'modelVisibleEvent' IS DISTINCT FROM model_event THEN
      RAISE EXCEPTION 'kernel_session_event_identity_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;
  UPDATE public.agent_sessions SET event_sequence = event_sequence + 1
   WHERE session_id = session_row.session_id RETURNING event_sequence INTO session_sequence;
  event_status := CASE
    WHEN model_event_type LIKE '%cancel%' THEN 'cancelled'
    WHEN model_event_type LIKE '%failed%' THEN 'failed'
    WHEN model_event_type LIKE '%denied%' OR model_event_type LIKE '%pending%'
      OR model_event_type LIKE '%uncertain%' THEN 'blocked'
    ELSE 'completed' END;
  INSERT INTO public.agent_session_events (
    event_id, session_id, turn_id, schema_version, sequence, type, status, summary, occurred_at, payload
  ) VALUES (
    model_event_id, invocation_row.lineage_session_id, invocation_row.lineage_turn_id,
    'workbench-v1', session_sequence, 'kernel.' || model_event_type, event_status,
    'Agent Kernel ' || model_event_type, (model_event ->> 'occurredAt')::timestamptz,
    jsonb_build_object(
      'schemaVersion', 'workbench-v1', 'eventId', model_event_id,
      'sessionId', invocation_row.lineage_session_id, 'turnId', invocation_row.lineage_turn_id,
      'type', 'kernel.' || model_event_type, 'status', event_status,
      'summary', 'Agent Kernel ' || model_event_type, 'occurredAt', model_event ->> 'occurredAt',
      'productCommandId', invocation_row.product_command_id, 'modelVisibleEvent', model_event
    )
  );
  RETURN NEW;
END;
$function$;
