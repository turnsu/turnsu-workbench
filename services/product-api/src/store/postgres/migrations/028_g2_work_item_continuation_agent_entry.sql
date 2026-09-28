-- G2 follow-up: a member's first requested Turn on a shared Work Item is
-- accepted atomically with their continuation branch. Each Turn has its own
-- immutable target identity, so it never consumes or rewrites the Work Item
-- root command that originally created or promoted the shared record.

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

CREATE TABLE public.work_item_continuation_turn_events (
  workspace_id public.product_identifier NOT NULL,
  event_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  continuation_id public.product_identifier NOT NULL,
  agent_session_id public.product_identifier NOT NULL,
  turn_id public.product_identifier NOT NULL,
  actor_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT work_item_continuation_turn_events_command_uq UNIQUE (workspace_id, product_command_id),
  CONSTRAINT work_item_continuation_turn_events_turn_uq UNIQUE (workspace_id, turn_id),
  CONSTRAINT work_item_continuation_turn_events_command_fk
    FOREIGN KEY (workspace_id, product_command_id)
    REFERENCES public.product_commands (workspace_id, command_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT work_item_continuation_turn_events_continuation_fk
    FOREIGN KEY (workspace_id, continuation_id)
    REFERENCES public.work_item_continuations (workspace_id, continuation_id),
  CONSTRAINT work_item_continuation_turn_events_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES public.work_items (workspace_id, work_item_id),
  CONSTRAINT work_item_continuation_turn_events_session_fk
    FOREIGN KEY (agent_session_id)
    REFERENCES public.agent_sessions (session_id),
  CONSTRAINT work_item_continuation_turn_events_turn_fk
    FOREIGN KEY (agent_session_id, turn_id)
    REFERENCES public.agent_turns (session_id, turn_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT work_item_continuation_turn_events_actor_fk
    FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_continuation_turn_events_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX work_item_continuation_turn_events_work_item_idx
  ON public.work_item_continuation_turn_events (workspace_id, work_item_id, created_at DESC, event_id DESC);

CREATE OR REPLACE FUNCTION public.validate_work_item_continuation_turn_event()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  command_row public.product_commands%ROWTYPE;
  continuation_row public.work_item_continuations%ROWTYPE;
  turn_matches boolean;
BEGIN
  SELECT * INTO command_row
    FROM public.product_commands
   WHERE workspace_id = NEW.workspace_id
     AND command_id = NEW.product_command_id
   FOR SHARE;
  SELECT * INTO continuation_row
    FROM public.work_item_continuations
   WHERE workspace_id = NEW.workspace_id
     AND continuation_id = NEW.continuation_id
   FOR SHARE;
  SELECT EXISTS (
    SELECT 1 FROM public.agent_turns turn_row
     WHERE turn_row.workspace_id = NEW.workspace_id
       AND turn_row.user_id = NEW.actor_user_id
       AND turn_row.session_id = NEW.agent_session_id
       AND turn_row.turn_id = NEW.turn_id
       AND turn_row.product_command_id = NEW.product_command_id
  ) INTO turn_matches;
  IF command_row.command_id IS NULL
    OR command_row.kind <> 'agent_turn'
    OR command_row.effect_class <> 'execute'
    OR command_row.target_kind <> 'work_item_continuation_turn'
    OR command_row.target_id <> NEW.turn_id
    OR command_row.target_revision <> 1
    OR continuation_row.continuation_id IS NULL
    OR continuation_row.work_item_id <> NEW.work_item_id
    OR continuation_row.agent_session_id <> NEW.agent_session_id
    OR continuation_row.user_id <> NEW.actor_user_id
    OR turn_matches IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'work_item_continuation_turn_event_invalid' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER work_item_continuation_turn_events_guard
  AFTER INSERT ON public.work_item_continuation_turn_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_work_item_continuation_turn_event();

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
  ELSIF NEW.kind = 'agent_turn' AND NEW.target_kind = 'work_item_continuation_turn' THEN
    SELECT continuation.work_item_id = event.work_item_id
      AND continuation.agent_session_id = event.agent_session_id
      AND continuation.user_id = event.actor_user_id
      AND event.turn_id = NEW.target_id
    INTO target_exists
    FROM public.work_item_continuation_turn_events event
    JOIN public.work_item_continuations continuation
      ON continuation.workspace_id = event.workspace_id
     AND continuation.continuation_id = event.continuation_id
    WHERE event.workspace_id = NEW.workspace_id
      AND event.product_command_id = NEW.command_id;
  ELSE
    RETURN NEW;
  END IF;

  IF ((NEW.kind <> 'agent_turn' AND NEW.status <> 'completed')
    OR target_exists IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'product_command_special_target_missing' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER product_commands_special_target_guard ON public.product_commands;
CREATE CONSTRAINT TRIGGER product_commands_special_target_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.kind NOT IN (
    'project_create', 'project_members_revise',
    'work_item_create', 'work_item_update'
  ) AND NOT (NEW.kind = 'agent_turn' AND NEW.target_kind IN (
    'work_item', 'work_item_continuation_turn'
  )))
  EXECUTE FUNCTION public.validate_product_command_special_target();
