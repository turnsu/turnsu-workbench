-- G2: Project-backed Team Work. A Project owns the durable team container and
-- its Project Scope; Work Items remain the canonical collaboration records.
-- These relations deliberately extend the existing promotion flow instead of
-- creating a second collaboration or authorization store.

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
    'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject',
    'project_create', 'project_members_revise',
    'work_item_create', 'work_item_update'
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
      'agent_handoff_confirm', 'agent_proposal_apply', 'agent_proposal_reject',
      'project_create', 'project_members_revise',
      'work_item_create', 'work_item_update'
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

ALTER TABLE public.product_commands
  DROP CONSTRAINT product_commands_special_completed;
ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_special_completed CHECK (
    kind NOT IN (
      'scope_create', 'scope_principal_grant_issue', 'policy_grant_issue',
      'object_access_grant_issue', 'workflow_run_cancel', 'workflow_run_review',
      'scope_policy_activate', 'automation_create', 'automation_revise',
      'automation_activate', 'automation_pause', 'automation_archive',
      'project_create', 'project_members_revise',
      'work_item_create', 'work_item_update'
    ) OR status = 'completed'
  );

CREATE TABLE public.projects (
  project_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  title text NOT NULL,
  objective text NOT NULL,
  status text COLLATE "C" NOT NULL,
  accountable_owner_user_id public.product_identifier NOT NULL,
  creation_command_id public.product_identifier NOT NULL,
  write_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT projects_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT projects_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT projects_owner_fk
    FOREIGN KEY (workspace_id, accountable_owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT projects_creation_command_fk
    FOREIGN KEY (creation_command_id) REFERENCES public.product_commands (command_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT projects_workspace_identity_uq UNIQUE (workspace_id, project_id),
  CONSTRAINT projects_workspace_scope_uq UNIQUE (workspace_id, scope_id),
  CONSTRAINT projects_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT projects_title CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT projects_objective CHECK (length(btrim(objective)) BETWEEN 1 AND 2000),
  CONSTRAINT projects_status CHECK (status IN ('active', 'archived')),
  CONSTRAINT projects_write_version_positive CHECK (write_version >= 1),
  CONSTRAINT projects_archive_shape CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT projects_time_order CHECK (
    updated_at >= created_at AND (archived_at IS NULL OR archived_at >= created_at)
  ),
  CONSTRAINT projects_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX projects_workspace_updated_idx
  ON public.projects (workspace_id, updated_at DESC, project_id DESC);

CREATE FUNCTION public.enforce_project_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'archived' THEN
    RAISE EXCEPTION 'project_terminal';
  END IF;
  IF ROW(NEW.project_id, NEW.workspace_id, NEW.scope_id, NEW.schema_version,
         NEW.title, NEW.objective, NEW.accountable_owner_user_id,
         NEW.creation_command_id, NEW.created_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.project_id, OLD.workspace_id, OLD.scope_id, OLD.schema_version,
         OLD.title, OLD.objective, OLD.accountable_owner_user_id,
         OLD.creation_command_id, OLD.created_at, OLD.payload) THEN
    RAISE EXCEPTION 'project_identity_immutable';
  END IF;
  IF ROW(NEW.status, NEW.archived_at) IS DISTINCT FROM ROW(OLD.status, OLD.archived_at)
    AND NEW.write_version <> OLD.write_version + 1 THEN
    RAISE EXCEPTION 'project_revision_required';
  END IF;
  IF NEW.write_version < OLD.write_version OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'project_revision_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER projects_revision_guard
  BEFORE UPDATE OR DELETE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_revision();

CREATE FUNCTION public.validate_project_scope_link()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  linked boolean;
BEGIN
  SELECT scope.scope_kind = 'project'
    AND scope.project_id = NEW.project_id
    AND scope.status = 'active'
  INTO linked
  FROM public.product_scopes scope
  WHERE scope.workspace_id = NEW.workspace_id AND scope.scope_id = NEW.scope_id;
  IF linked IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'project_scope_link_invalid' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER projects_scope_link_guard
  AFTER INSERT OR UPDATE OF scope_id, project_id, workspace_id ON public.projects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_project_scope_link();

CREATE TABLE public.project_memberships (
  workspace_id public.product_identifier NOT NULL,
  project_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  role text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  created_by_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  removed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, project_id, user_id),
  CONSTRAINT project_memberships_project_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects (workspace_id, project_id),
  CONSTRAINT project_memberships_user_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT project_memberships_creator_fk
    FOREIGN KEY (workspace_id, created_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT project_memberships_role CHECK (role IN ('owner', 'member')),
  CONSTRAINT project_memberships_status CHECK (status IN ('active', 'removed')),
  CONSTRAINT project_memberships_revision_positive CHECK (revision >= 1),
  CONSTRAINT project_memberships_removed_shape CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CONSTRAINT project_memberships_time_order CHECK (
    updated_at >= created_at AND (removed_at IS NULL OR removed_at >= created_at)
  ),
  CONSTRAINT project_memberships_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX project_memberships_one_active_owner_uq
  ON public.project_memberships (workspace_id, project_id)
  WHERE status = 'active' AND role = 'owner';
CREATE INDEX project_memberships_active_user_idx
  ON public.project_memberships (workspace_id, user_id, project_id)
  WHERE status = 'active';

CREATE FUNCTION public.enforce_project_membership_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project_membership_immutable';
  END IF;
  IF ROW(NEW.workspace_id, NEW.project_id, NEW.user_id, NEW.role,
         NEW.created_by_user_id, NEW.created_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.workspace_id, OLD.project_id, OLD.user_id, OLD.role,
         OLD.created_by_user_id, OLD.created_at, OLD.payload) THEN
    RAISE EXCEPTION 'project_membership_identity_immutable';
  END IF;
  IF ROW(NEW.status, NEW.removed_at) IS DISTINCT FROM ROW(OLD.status, OLD.removed_at)
    AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'project_membership_revision_required';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'project_membership_revision_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER project_memberships_revision_guard
  BEFORE UPDATE OR DELETE ON public.project_memberships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_membership_revision();

CREATE TABLE public.project_lifecycle_events (
  workspace_id public.product_identifier NOT NULL,
  event_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  project_id public.product_identifier NOT NULL,
  kind text COLLATE "C" NOT NULL,
  target_revision integer NOT NULL,
  status_after text COLLATE "C" NOT NULL,
  actor_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT project_lifecycle_events_command_fk
    FOREIGN KEY (product_command_id) REFERENCES public.product_commands (command_id),
  CONSTRAINT project_lifecycle_events_project_fk
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES public.projects (workspace_id, project_id),
  CONSTRAINT project_lifecycle_events_actor_fk
    FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT project_lifecycle_events_command_uq UNIQUE (product_command_id),
  CONSTRAINT project_lifecycle_events_target_positive CHECK (target_revision >= 1),
  CONSTRAINT project_lifecycle_events_kind CHECK (
    (kind = 'project_create' AND target_revision = 1 AND status_after = 'active')
    OR (kind = 'project_members_revise' AND target_revision >= 2 AND status_after = 'active')
  ),
  CONSTRAINT project_lifecycle_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TRIGGER project_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON public.project_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

ALTER TABLE public.work_items
  ADD COLUMN write_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.work_items
  DROP CONSTRAINT work_items_source;
ALTER TABLE public.work_items
  ADD CONSTRAINT work_items_source CHECK (
    source_kind IN ('private_agent_task', 'team_work_item')
  ),
  ADD CONSTRAINT work_items_write_version_positive CHECK (write_version >= 1);

ALTER TABLE public.work_items
  ADD CONSTRAINT work_items_project_fk
  FOREIGN KEY (workspace_id, project_id)
  REFERENCES public.projects (workspace_id, project_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.work_item_access_grants
  ALTER COLUMN promotion_id DROP NOT NULL;

ALTER TABLE public.work_item_handoff_capsules
  ALTER COLUMN promotion_id DROP NOT NULL,
  ADD COLUMN origin_kind text COLLATE "C" NOT NULL DEFAULT 'private_task_promotion';
ALTER TABLE public.work_item_handoff_capsules
  ADD CONSTRAINT work_item_handoff_capsules_origin_shape CHECK (
    (origin_kind = 'private_task_promotion' AND promotion_id IS NOT NULL)
    OR (origin_kind = 'team_work_item' AND promotion_id IS NULL)
  );

CREATE UNIQUE INDEX work_item_access_grants_one_active_owner_uq
  ON public.work_item_access_grants (workspace_id, work_item_id)
  WHERE status = 'active' AND access_level = 'owner';

ALTER TABLE public.work_item_member_roles
  ADD COLUMN status text COLLATE "C" NOT NULL DEFAULT 'active',
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN removed_at timestamptz;
UPDATE public.work_item_member_roles
   SET updated_at = created_at
 WHERE updated_at IS NULL;
ALTER TABLE public.work_item_member_roles
  ALTER COLUMN updated_at SET NOT NULL,
  ADD CONSTRAINT work_item_member_roles_status CHECK (status IN ('active', 'removed')),
  ADD CONSTRAINT work_item_member_roles_revision_positive CHECK (revision >= 1),
  ADD CONSTRAINT work_item_member_roles_removed_shape CHECK (
    (status = 'removed') = (removed_at IS NOT NULL)
  ),
  ADD CONSTRAINT work_item_member_roles_time_order CHECK (
    updated_at >= created_at AND (removed_at IS NULL OR removed_at >= created_at)
  );

CREATE FUNCTION public.enforce_work_item_member_role_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'work_item_member_role_immutable';
  END IF;
  IF ROW(NEW.workspace_id, NEW.work_item_id, NEW.user_id, NEW.role,
         NEW.created_by_user_id, NEW.created_at)
      IS DISTINCT FROM
     ROW(OLD.workspace_id, OLD.work_item_id, OLD.user_id, OLD.role,
         OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'work_item_member_role_identity_immutable';
  END IF;
  IF ROW(NEW.status, NEW.removed_at) IS DISTINCT FROM ROW(OLD.status, OLD.removed_at)
    AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'work_item_member_role_revision_required';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'work_item_member_role_revision_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER work_item_member_roles_revision_guard
  BEFORE UPDATE OR DELETE ON public.work_item_member_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_work_item_member_role_revision();

CREATE TABLE public.work_item_lifecycle_events (
  workspace_id public.product_identifier NOT NULL,
  event_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  kind text COLLATE "C" NOT NULL,
  target_revision integer NOT NULL,
  status_after text COLLATE "C" NOT NULL,
  accountable_owner_user_id public.product_identifier NOT NULL,
  actor_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT work_item_lifecycle_events_command_fk
    FOREIGN KEY (product_command_id) REFERENCES public.product_commands (command_id),
  CONSTRAINT work_item_lifecycle_events_work_item_fk
    FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES public.work_items (workspace_id, work_item_id),
  CONSTRAINT work_item_lifecycle_events_owner_fk
    FOREIGN KEY (workspace_id, accountable_owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_lifecycle_events_actor_fk
    FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT work_item_lifecycle_events_command_uq UNIQUE (product_command_id),
  CONSTRAINT work_item_lifecycle_events_target_positive CHECK (target_revision >= 1),
  CONSTRAINT work_item_lifecycle_events_kind CHECK (
    (kind = 'work_item_create' AND target_revision = 1)
    OR (kind = 'work_item_update' AND target_revision >= 2)
  ),
  CONSTRAINT work_item_lifecycle_events_status CHECK (status_after IN (
    'draft', 'ready', 'active', 'waiting_review', 'completed', 'blocked', 'cancelled'
  )),
  CONSTRAINT work_item_lifecycle_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX work_item_lifecycle_events_work_item_idx
  ON public.work_item_lifecycle_events (workspace_id, work_item_id, target_revision);

CREATE TRIGGER work_item_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON public.work_item_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

CREATE INDEX work_items_project_updated_idx
  ON public.work_items (workspace_id, project_id, updated_at DESC, work_item_id DESC)
  WHERE project_id IS NOT NULL;

-- A direct Team Work Item begins with a product-safe baseline context. It
-- deliberately uses the same capsule relation as a private promotion so a
-- teammate continuation is always derived from shared material only.
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
    command_row.kind = 'work_item_create'
    AND command_row.effect_class = 'write_local'
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

CREATE FUNCTION public.validate_team_work_product_command_target()
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
      ON root.workspace_id = event.workspace_id
     AND root.project_id = event.project_id
    WHERE event.workspace_id = NEW.workspace_id
      AND event.project_id = NEW.target_id
      AND event.product_command_id = NEW.command_id
      AND event.kind = NEW.kind
      AND event.target_revision = NEW.target_revision;
  ELSIF NEW.kind IN ('work_item_create', 'work_item_update') THEN
    SELECT root.write_version = NEW.target_revision
      AND root.status = event.status_after
      AND root.accountable_owner_user_id = event.accountable_owner_user_id
      AND ((NEW.kind = 'work_item_create' AND root.source_kind = 'team_work_item')
        OR NEW.kind = 'work_item_update')
    INTO target_exists
    FROM public.work_item_lifecycle_events event
    JOIN public.work_items root
      ON root.workspace_id = event.workspace_id
     AND root.work_item_id = event.work_item_id
    WHERE event.workspace_id = NEW.workspace_id
      AND event.work_item_id = NEW.target_id
      AND event.product_command_id = NEW.command_id
      AND event.kind = NEW.kind
      AND event.target_revision = NEW.target_revision;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.status <> 'completed' OR target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'product_command_special_target_missing' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

-- The pre-existing generic special-target trigger is intentionally unaware
-- of the Team Work aggregate. Keep its original function and make its trigger
-- skip only the four kinds that are checked by the narrow aggregate trigger.
DROP TRIGGER product_commands_special_target_guard ON public.product_commands;
CREATE CONSTRAINT TRIGGER product_commands_special_target_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.kind NOT IN (
    'project_create', 'project_members_revise',
    'work_item_create', 'work_item_update'
  ))
  EXECUTE FUNCTION public.validate_product_command_special_target();

CREATE CONSTRAINT TRIGGER product_commands_team_work_target_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_team_work_product_command_target();
