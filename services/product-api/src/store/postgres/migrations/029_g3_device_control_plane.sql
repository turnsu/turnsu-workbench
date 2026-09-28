-- G3: Product Device control plane. A Device is a durable native Desktop
-- identity bound to an existing PKCE client session, not a generic Worker
-- endpoint or an alternate command source.

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
    'work_item_create', 'work_item_update',
    'device_register', 'device_revoke'
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
      'device_register', 'device_revoke'
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
      'work_item_create', 'work_item_update',
      'device_register', 'device_revoke'
    ) OR status = 'completed'
  );

-- PostgreSQL CHECK expressions may not contain a subquery. Keep the bounded,
-- immutable JSON validation in a SQL function so both the Product API and a
-- direct database write are held to the same capability declaration rules.
CREATE FUNCTION public.device_capability_inventory_valid(inventory jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN jsonb_typeof(inventory) <> 'array' THEN false
    WHEN jsonb_array_length(inventory) > 16 THEN false
    ELSE (
      SELECT count(*) = count(DISTINCT capability_name)
        AND NOT bool_or(capability_name NOT IN (
          'file_read', 'file_write', 'notification', 'voice_input',
          'sandbox_oci', 'local_deterministic_skill'
        ))
      FROM jsonb_array_elements_text(inventory) AS capability(capability_name)
    )
  END;
$function$;

CREATE TABLE public.devices (
  device_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  owner_user_id public.product_identifier NOT NULL,
  native_client_session_id public.product_identifier NOT NULL,
  public_identity_fingerprint text COLLATE "C" NOT NULL,
  display_name text NOT NULL,
  platform text COLLATE "C" NOT NULL,
  architecture text COLLATE "C" NOT NULL,
  app_version text COLLATE "C" NOT NULL,
  worker_protocol_version text COLLATE "C" NOT NULL,
  capability_inventory jsonb NOT NULL,
  registration_status text COLLATE "C" NOT NULL,
  health text COLLATE "C" NOT NULL,
  last_seen_at timestamptz NOT NULL,
  update_required boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  registration_command_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT devices_workspace_identity_uq UNIQUE (workspace_id, device_id),
  CONSTRAINT devices_native_session_uq UNIQUE (native_client_session_id),
  CONSTRAINT devices_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT devices_owner_fk
    FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT devices_native_session_fk
    FOREIGN KEY (native_client_session_id)
    REFERENCES public.native_client_sessions (client_session_id),
  CONSTRAINT devices_registration_command_fk
    FOREIGN KEY (workspace_id, registration_command_id)
    REFERENCES public.product_commands (workspace_id, command_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT devices_public_identity_fingerprint CHECK (
    public_identity_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT devices_display_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  CONSTRAINT devices_platform CHECK (platform IN ('macos', 'windows')),
  CONSTRAINT devices_architecture CHECK (architecture IN ('arm64', 'x64')),
  CONSTRAINT devices_app_version CHECK (length(btrim(app_version)) BETWEEN 1 AND 128),
  CONSTRAINT devices_worker_protocol_version CHECK (
    length(btrim(worker_protocol_version)) BETWEEN 1 AND 128
  ),
  CONSTRAINT devices_capability_inventory CHECK (
    public.device_capability_inventory_valid(capability_inventory)
  ),
  CONSTRAINT devices_registration_status CHECK (registration_status IN ('active', 'revoked')),
  CONSTRAINT devices_health CHECK (health IN ('ready', 'offline', 'incompatible', 'revoked')),
  CONSTRAINT devices_revision_positive CHECK (revision >= 1),
  CONSTRAINT devices_time_order CHECK (
    updated_at >= created_at AND last_seen_at >= created_at
      AND (revoked_at IS NULL OR revoked_at >= created_at)
  ),
  CONSTRAINT devices_state_shape CHECK (
    (registration_status = 'active' AND revoked_at IS NULL AND health <> 'revoked')
    OR (registration_status = 'revoked' AND revoked_at IS NOT NULL AND health = 'revoked')
  ),
  CONSTRAINT devices_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX devices_workspace_visibility_idx
  ON public.devices (workspace_id, owner_user_id, updated_at DESC, device_id DESC);
CREATE INDEX devices_active_readiness_idx
  ON public.devices (workspace_id, health, last_seen_at DESC, device_id DESC)
  WHERE registration_status = 'active';

CREATE OR REPLACE FUNCTION public.enforce_device_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'device_immutable';
  END IF;
  IF ROW(
    NEW.device_id, NEW.workspace_id, NEW.owner_user_id,
    NEW.native_client_session_id, NEW.public_identity_fingerprint,
    NEW.display_name, NEW.platform, NEW.architecture,
    NEW.registration_command_id, NEW.created_at, NEW.payload
  ) IS DISTINCT FROM ROW(
    OLD.device_id, OLD.workspace_id, OLD.owner_user_id,
    OLD.native_client_session_id, OLD.public_identity_fingerprint,
    OLD.display_name, OLD.platform, OLD.architecture,
    OLD.registration_command_id, OLD.created_at, OLD.payload
  ) THEN
    RAISE EXCEPTION 'device_identity_immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1
    OR NEW.updated_at < OLD.updated_at
    OR NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'device_revision_required';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER devices_revision_guard
  BEFORE UPDATE OR DELETE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_device_revision();

CREATE OR REPLACE FUNCTION public.validate_device_native_session_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  session_row public.native_client_sessions%ROWTYPE;
  command_row public.product_commands%ROWTYPE;
  expected_fingerprint text;
BEGIN
  SELECT * INTO session_row
    FROM public.native_client_sessions
   WHERE client_session_id = NEW.native_client_session_id
   FOR SHARE;
  SELECT * INTO command_row
    FROM public.product_commands
   WHERE workspace_id = NEW.workspace_id
     AND command_id = NEW.registration_command_id
   FOR SHARE;
  expected_fingerprint := 'sha256:' || encode(digest(session_row.device_public_key, 'sha256'), 'hex');
  IF session_row.client_session_id IS NULL
    OR session_row.workspace_id <> NEW.workspace_id
    OR session_row.user_id <> NEW.owner_user_id
    OR session_row.client_kind <> 'desktop'
    OR expected_fingerprint <> NEW.public_identity_fingerprint
    OR command_row.command_id IS NULL
    OR command_row.kind <> 'device_register'
    OR command_row.effect_class <> 'administrative'
    OR command_row.target_kind <> 'device'
    OR command_row.target_id <> NEW.device_id
    OR command_row.target_revision <> 1
    OR command_row.status <> 'completed' THEN
    RAISE EXCEPTION 'device_native_session_binding_invalid' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER devices_native_session_binding_guard
  AFTER INSERT ON public.devices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_device_native_session_binding();

CREATE TABLE public.device_lifecycle_events (
  workspace_id public.product_identifier NOT NULL,
  event_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  device_id public.product_identifier NOT NULL,
  kind text COLLATE "C" NOT NULL,
  target_revision integer NOT NULL,
  status_after text COLLATE "C" NOT NULL,
  actor_user_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT device_lifecycle_events_command_uq UNIQUE (workspace_id, product_command_id),
  CONSTRAINT device_lifecycle_events_device_revision_uq
    UNIQUE (workspace_id, device_id, target_revision),
  CONSTRAINT device_lifecycle_events_command_fk
    FOREIGN KEY (workspace_id, product_command_id)
    REFERENCES public.product_commands (workspace_id, command_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT device_lifecycle_events_device_fk
    FOREIGN KEY (workspace_id, device_id)
    REFERENCES public.devices (workspace_id, device_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT device_lifecycle_events_actor_fk
    FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT device_lifecycle_events_target_revision_positive CHECK (target_revision >= 1),
  CONSTRAINT device_lifecycle_events_kind CHECK (
    (kind = 'device_register' AND target_revision = 1 AND status_after = 'active')
    OR (kind = 'device_revoke' AND target_revision >= 2 AND status_after = 'revoked')
  ),
  CONSTRAINT device_lifecycle_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX device_lifecycle_events_device_created_idx
  ON public.device_lifecycle_events (workspace_id, device_id, created_at DESC, event_id DESC);

CREATE TRIGGER device_lifecycle_events_immutable
  BEFORE UPDATE OR DELETE ON public.device_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

CREATE OR REPLACE FUNCTION public.validate_device_product_command_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_exists boolean;
BEGIN
  IF NEW.kind NOT IN ('device_register', 'device_revoke') THEN
    RETURN NEW;
  END IF;
  SELECT root.revision = NEW.target_revision
    AND event.kind = NEW.kind
    AND event.target_revision = NEW.target_revision
    AND event.status_after = root.registration_status
    AND (
      (NEW.kind = 'device_register' AND root.registration_command_id = NEW.command_id)
      OR NEW.kind = 'device_revoke'
    )
  INTO target_exists
  FROM public.device_lifecycle_events event
  JOIN public.devices root
    ON root.workspace_id = event.workspace_id AND root.device_id = event.device_id
  WHERE event.workspace_id = NEW.workspace_id
    AND event.device_id = NEW.target_id
    AND event.product_command_id = NEW.command_id;
  IF NEW.status <> 'completed' OR target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'product_command_special_target_missing' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

-- The generic special-target function deliberately has no Device knowledge;
-- this aggregate-specific trigger validates the root and immutable event.
DROP TRIGGER product_commands_special_target_guard ON public.product_commands;
CREATE CONSTRAINT TRIGGER product_commands_special_target_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.kind NOT IN (
    'project_create', 'project_members_revise',
    'work_item_create', 'work_item_update',
    'device_register', 'device_revoke'
  ) AND NOT (NEW.kind = 'agent_turn' AND NEW.target_kind IN (
    'work_item', 'work_item_continuation_turn'
  )))
  EXECUTE FUNCTION public.validate_product_command_special_target();

CREATE CONSTRAINT TRIGGER product_commands_device_target_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_device_product_command_target();
