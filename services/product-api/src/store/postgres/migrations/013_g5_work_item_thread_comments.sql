-- G5: ongoing Work Thread comments are explicit local-write commands.  The
-- shared entry retains only product-safe text and one durable Product Command
-- reference; it never retains a private Session or Worker transcript.

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
    'work_item_promote', 'work_item_thread_entry'
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
      'work_item_promote', 'work_item_thread_entry'
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
    OR (kind NOT IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue',
        'workflow_run', 'workflow_run_cancel', 'workflow_run_review',
        'work_item_promote', 'work_item_thread_entry'
      )
      AND target_kind IS NULL
      AND target_id IS NULL
      AND target_revision IS NULL)
  );

ALTER TABLE public.work_thread_entries
  DROP CONSTRAINT work_thread_entries_kind,
  DROP CONSTRAINT work_thread_entries_reference_shape;
ALTER TABLE public.work_thread_entries
  ADD CONSTRAINT work_thread_entries_kind CHECK (
    entry_kind IN ('handoff', 'decision', 'artifact', 'comment')
  ),
  ADD CONSTRAINT work_thread_entries_reference_shape CHECK (
    (entry_kind = 'handoff' AND handoff_id IS NOT NULL AND decision_id IS NULL AND artifact_id IS NULL)
    OR (entry_kind = 'decision' AND handoff_id IS NULL AND decision_id IS NOT NULL AND artifact_id IS NULL)
    OR (entry_kind = 'artifact' AND handoff_id IS NULL AND decision_id IS NULL AND artifact_id IS NOT NULL)
    OR (entry_kind = 'comment' AND handoff_id IS NULL AND decision_id IS NULL AND artifact_id IS NULL)
  );

ALTER TABLE public.work_thread_entries
  ADD COLUMN product_command_id public.product_identifier;

-- Every pre-existing entry was the single initial handoff from a promotion.
-- Backfill its durable command before making the relationship mandatory.
UPDATE public.work_thread_entries entry_row
   SET product_command_id = promotion.product_command_id
  FROM public.work_item_promotions promotion
 WHERE promotion.workspace_id = entry_row.workspace_id
   AND promotion.work_item_id = entry_row.work_item_id
   AND entry_row.product_command_id IS NULL;

ALTER TABLE public.work_thread_entries
  ALTER COLUMN product_command_id SET NOT NULL,
  ADD CONSTRAINT work_thread_entries_command_fk
    FOREIGN KEY (product_command_id) REFERENCES public.product_commands (command_id),
  ADD CONSTRAINT work_thread_entries_command_uq UNIQUE (product_command_id);

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
  );
  IF command_matches IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'work_thread_entry_command_target_mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER work_thread_entries_command_validate
  BEFORE INSERT OR UPDATE OF product_command_id, workspace_id, work_item_id,
    entry_id, entry_kind, sequence, created_by_user_id
  ON public.work_thread_entries
  FOR EACH ROW EXECUTE FUNCTION public.validate_work_thread_entry_command();
