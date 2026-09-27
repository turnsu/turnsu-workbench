-- G5: an accountable owner records an immutable shared Decision and its Work
-- Thread entry through one local-write Product Command. Contributors retain
-- the separate comment path; proposal/reviewer approval is a later aggregate.

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
    'work_item_promote', 'work_item_thread_entry', 'work_item_decision_record'
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
      'work_item_promote', 'work_item_thread_entry', 'work_item_decision_record'
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
    OR (kind NOT IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue',
        'workflow_run', 'workflow_run_cancel', 'workflow_run_review',
        'work_item_promote', 'work_item_thread_entry', 'work_item_decision_record'
      )
      AND target_kind IS NULL
      AND target_id IS NULL
      AND target_revision IS NULL)
  );

CREATE OR REPLACE FUNCTION public.validate_work_thread_entry_command()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  command_row public.product_commands%ROWTYPE;
  command_matches boolean;
BEGIN
  SELECT * INTO command_row
    FROM public.product_commands
   WHERE command_id = NEW.product_command_id
   FOR SHARE;

  IF command_row.command_id IS NULL
    OR command_row.workspace_id <> NEW.workspace_id
    OR command_row.quota_user_id <> NEW.created_by_user_id
    OR command_row.status NOT IN ('accepted', 'completed') THEN
    RAISE EXCEPTION 'work_thread_entry_command_invalid'
      USING ERRCODE = '23503';
  END IF;

  command_matches := (
    command_row.kind = 'work_item_promote'
    AND command_row.effect_class = 'execute'
    AND command_row.target_kind = 'work_item'
    AND command_row.target_id = NEW.work_item_id
    AND command_row.target_revision = 1
    AND NEW.entry_kind = 'handoff'
    AND NEW.sequence = 1
  ) OR (
    command_row.kind = 'work_item_thread_entry'
    AND command_row.effect_class = 'write_local'
    AND command_row.target_kind = 'work_thread_entry'
    AND command_row.target_id = NEW.entry_id
    AND command_row.target_revision = 1
    AND NEW.entry_kind = 'comment'
  ) OR (
    command_row.kind = 'work_item_decision_record'
    AND command_row.effect_class = 'write_local'
    AND command_row.target_kind = 'work_item_decision'
    AND command_row.target_id = NEW.decision_id
    AND command_row.target_revision = 1
    AND NEW.entry_kind = 'decision'
  );
  IF command_matches IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'work_thread_entry_command_target_mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;
