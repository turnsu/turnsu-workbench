-- G2 follow-up: a New Team Work Agent entry is one accepted Agent Product
-- Command with both its normal Session/Turn lineage and its newly-created
-- Work Item target.  It is intentionally still `agent_turn`: cancellation,
-- Admission, Broker dispatch and durable Agent recovery retain one owner.

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
    -- A regular Agent Turn remains targetless. This narrow alternative is
    -- available only to the first turn that creates a Team Work Item.
    OR (kind = 'agent_turn' AND effect_class = 'execute'
      AND target_kind = 'work_item' AND target_id IS NOT NULL AND target_revision = 1)
    OR (kind NOT IN (
      'scope_create', 'scope_principal_grant_issue', 'policy_grant_issue',
      'object_access_grant_issue', 'workflow_run', 'workflow_run_cancel',
      'workflow_run_review', 'work_item_promote', 'work_item_thread_entry',
      'work_item_decision_record', 'scope_policy_activate',
      'automation_create', 'automation_revise', 'automation_activate',
      'automation_pause', 'automation_archive',
      'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject',
      'project_create', 'project_members_revise',
      'work_item_create', 'work_item_update'
    ) AND target_kind IS NULL AND target_id IS NULL AND target_revision IS NULL)
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
    RAISE EXCEPTION 'work_thread_entry_command_invalid' USING ERRCODE = '23503';
  END IF;

  command_matches := (
    command_row.kind = 'work_item_promote'
    AND command_row.effect_class = 'execute'
    AND command_row.target_kind = 'work_item'
    AND command_row.target_id = NEW.work_item_id
    AND command_row.target_revision = 1
    AND NEW.entry_kind = 'handoff' AND NEW.sequence = 1
  ) OR (
    command_row.kind = 'work_item_create'
    AND command_row.effect_class = 'write_local'
    AND command_row.target_kind = 'work_item'
    AND command_row.target_id = NEW.work_item_id
    AND command_row.target_revision = 1
    AND NEW.entry_kind = 'handoff' AND NEW.sequence = 1
  ) OR (
    command_row.kind = 'agent_turn'
    AND command_row.effect_class = 'execute'
    AND command_row.target_kind = 'work_item'
    AND command_row.target_id = NEW.work_item_id
    AND command_row.target_revision = 1
    AND NEW.entry_kind = 'handoff' AND NEW.sequence = 1
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
    RAISE EXCEPTION 'work_thread_entry_command_target_mismatch' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_team_work_product_command_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_exists boolean;
BEGIN
  IF NEW.kind IN ('project_create', 'project_members_revise') THEN
    SELECT root.write_version = NEW.target_revision
      AND root.status = event.status_after
      AND ((NEW.kind = 'project_create' AND root.creation_command_id = NEW.command_id)
        OR NEW.kind = 'project_members_revise')
    INTO target_exists
    FROM public.project_lifecycle_events event
    JOIN public.projects root
      ON root.workspace_id = event.workspace_id AND root.project_id = event.project_id
    WHERE event.workspace_id = NEW.workspace_id
      AND event.project_id = NEW.target_id
      AND event.product_command_id = NEW.command_id
      AND event.kind = NEW.kind
      AND event.target_revision = NEW.target_revision;
  ELSIF NEW.kind IN ('work_item_create', 'work_item_update')
    OR (NEW.kind = 'agent_turn' AND NEW.target_kind = 'work_item') THEN
    SELECT root.write_version = NEW.target_revision
      AND root.status = event.status_after
      AND root.accountable_owner_user_id = event.accountable_owner_user_id
      AND ((NEW.kind IN ('work_item_create', 'agent_turn') AND root.source_kind = 'team_work_item')
        OR NEW.kind = 'work_item_update')
    INTO target_exists
    FROM public.work_item_lifecycle_events event
    JOIN public.work_items root
      ON root.workspace_id = event.workspace_id AND root.work_item_id = event.work_item_id
    WHERE event.workspace_id = NEW.workspace_id
      AND event.work_item_id = NEW.target_id
      AND event.product_command_id = NEW.command_id
      AND event.kind = CASE WHEN NEW.kind = 'work_item_update'
        THEN 'work_item_update' ELSE 'work_item_create' END
      AND event.target_revision = NEW.target_revision;
  ELSE
    RETURN NEW;
  END IF;

  -- An Agent Turn starts accepted and transitions with the durable Turn; the
  -- Work target is nevertheless fully present before that accepted response.
  IF ((NEW.kind <> 'agent_turn' AND NEW.status <> 'completed')
    OR target_exists IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'product_command_special_target_missing' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

-- Keep the original generic target trigger away from the single constrained
-- Agent Work entry; the aggregate-specific trigger above validates it at
-- commit with the Work lifecycle event and root.
DROP TRIGGER product_commands_special_target_guard ON public.product_commands;
CREATE CONSTRAINT TRIGGER product_commands_special_target_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.kind NOT IN (
    'project_create', 'project_members_revise',
    'work_item_create', 'work_item_update'
  ) AND NOT (NEW.kind = 'agent_turn' AND NEW.target_kind = 'work_item'))
  EXECUTE FUNCTION public.validate_product_command_special_target();
