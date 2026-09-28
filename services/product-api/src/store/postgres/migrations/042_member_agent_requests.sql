-- One explicit member consent binds an existing Product execution. This is not a run ledger.
DO $migration$
DECLARE c text; old_expression text; allowed text;
BEGIN
 FOREACH c IN ARRAY ARRAY['product_commands_kind','product_commands_session_turn_shape','product_commands_special_target_shape','product_commands_special_completed'] LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO STRICT old_expression FROM pg_constraint WHERE conrelid='public.product_commands'::regclass AND conname=c;
  allowed := CASE c WHEN 'product_commands_kind' THEN 'true' WHEN 'product_commands_session_turn_shape' THEN 'session_id IS NULL AND turn_id IS NULL'
    WHEN 'product_commands_special_target_shape' THEN 'target_kind = ''member_agent_request'' AND target_id IS NOT NULL AND target_revision BETWEEN 1 AND 3 AND ((kind = ''member_agent_request_accept'' AND effect_class = ''execute'') OR (kind <> ''member_agent_request_accept'' AND effect_class = ''write_local''))'
    ELSE '(kind = ''member_agent_request_accept'' OR status = ''completed'')' END;
  EXECUTE format('ALTER TABLE public.product_commands DROP CONSTRAINT %I',c);
  EXECUTE format('ALTER TABLE public.product_commands ADD CONSTRAINT %I CHECK ((kind IN (''member_agent_request_create'',''member_agent_request_accept'',''member_agent_request_decline'',''member_agent_request_cancel'') AND (%s)) OR (kind NOT IN (''member_agent_request_create'',''member_agent_request_accept'',''member_agent_request_decline'',''member_agent_request_cancel'') AND (%s)))',c,allowed,old_expression);
 END LOOP;
END $migration$;
ALTER TABLE public.execution_invocations DROP CONSTRAINT execution_invocations_controller_kind;
ALTER TABLE public.execution_invocations ADD CONSTRAINT execution_invocations_controller_kind CHECK(controller_kind IN ('workflow_run','agent_turn','skill_creation_turn','skill_test','member_agent_request'));
ALTER TABLE public.execution_invocations DROP CONSTRAINT execution_invocations_lineage_shape;
ALTER TABLE public.execution_invocations ADD CONSTRAINT execution_invocations_lineage_shape CHECK((controller_kind IN ('agent_turn','skill_creation_turn') AND lineage_session_id IS NOT NULL AND lineage_turn_id IS NOT NULL) OR (controller_kind IN ('workflow_run','skill_test') AND ((lineage_session_id IS NULL AND lineage_turn_id IS NULL) OR (lineage_session_id IS NOT NULL AND lineage_turn_id IS NOT NULL))) OR (controller_kind='member_agent_request' AND lineage_session_id IS NULL AND lineage_turn_id IS NULL));
CREATE TABLE public.member_agent_requests (
 workspace_id public.product_identifier NOT NULL,
 request_id public.product_identifier NOT NULL,
 work_item_id public.product_identifier NOT NULL,
 requester_user_id public.product_identifier NOT NULL,
 provider_user_id public.product_identifier NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$'),
 contract jsonb NOT NULL CHECK(jsonb_typeof(contract)='object'),
 instructions text NOT NULL CHECK(length(instructions) BETWEEN 1 AND 128000),
 revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 3),
 consent text NOT NULL DEFAULT 'pending' CHECK(consent IN ('pending','accepted','declined','revoked')),
 create_command_id public.product_identifier NOT NULL,
 accept_command_id public.product_identifier,
 device_id public.product_identifier,
 native_client_session_id public.product_identifier,
 ticket jsonb,
 invocation_id public.product_identifier,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(workspace_id,request_id),
 UNIQUE(workspace_id,invocation_id),
 FOREIGN KEY(workspace_id,work_item_id) REFERENCES public.work_items(workspace_id,work_item_id),
 FOREIGN KEY(workspace_id,requester_user_id) REFERENCES public.workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,provider_user_id) REFERENCES public.workspace_memberships(workspace_id,user_id),
 FOREIGN KEY(workspace_id,create_command_id) REFERENCES public.product_commands(workspace_id,command_id),
 FOREIGN KEY(workspace_id,accept_command_id) REFERENCES public.product_commands(workspace_id,command_id),
 FOREIGN KEY(workspace_id,invocation_id) REFERENCES public.execution_invocations(workspace_id,invocation_id),
 FOREIGN KEY(device_id) REFERENCES public.devices(device_id),
 FOREIGN KEY(native_client_session_id) REFERENCES public.native_client_sessions(client_session_id),
 CHECK(requester_user_id <> provider_user_id),
 CHECK((accept_command_id IS NULL AND device_id IS NULL AND native_client_session_id IS NULL AND ticket IS NULL AND invocation_id IS NULL) OR (accept_command_id IS NOT NULL AND device_id IS NOT NULL AND native_client_session_id IS NOT NULL AND ticket IS NOT NULL)),
 CHECK(expires_at > created_at)
);
CREATE FUNCTION public.guard_member_agent_request() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'member_agent_request_immutable'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.workspace_id,NEW.request_id,NEW.work_item_id,NEW.requester_user_id,NEW.provider_user_id,NEW.request_digest,NEW.contract,NEW.instructions,NEW.create_command_id,NEW.expires_at,NEW.created_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.request_id,OLD.work_item_id,OLD.requester_user_id,OLD.provider_user_id,OLD.request_digest,OLD.contract,OLD.instructions,OLD.create_command_id,OLD.expires_at,OLD.created_at)
 OR (OLD.accept_command_id IS NOT NULL AND ROW(NEW.accept_command_id,NEW.device_id,NEW.native_client_session_id,NEW.ticket) IS DISTINCT FROM ROW(OLD.accept_command_id,OLD.device_id,OLD.native_client_session_id,OLD.ticket))
 OR NEW.revision <> OLD.revision + CASE WHEN NEW.consent IS DISTINCT FROM OLD.consent THEN 1 ELSE 0 END
 OR (OLD.invocation_id IS NOT NULL AND NEW.invocation_id IS DISTINCT FROM OLD.invocation_id)
 OR (OLD.consent IN ('declined','revoked') AND NEW.consent <> OLD.consent) OR (OLD.consent='accepted' AND NEW.consent NOT IN ('accepted','revoked'))) THEN RAISE EXCEPTION 'member_agent_request_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.product_commands c WHERE c.workspace_id=NEW.workspace_id AND c.command_id=NEW.create_command_id AND c.kind='member_agent_request_create' AND c.target_id=NEW.request_id AND c.effective_principal_id=NEW.requester_user_id AND c.status='completed') THEN RAISE EXCEPTION 'member_agent_request_command_invalid'; END IF;
 IF NEW.accept_command_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.product_commands c JOIN public.devices d ON d.device_id=NEW.device_id WHERE c.workspace_id=NEW.workspace_id AND c.command_id=NEW.accept_command_id AND c.kind='member_agent_request_accept' AND c.target_id=NEW.request_id AND c.effective_principal_id=NEW.provider_user_id AND d.workspace_id=NEW.workspace_id AND d.owner_user_id=NEW.provider_user_id AND d.native_client_session_id=NEW.native_client_session_id) THEN RAISE EXCEPTION 'member_agent_request_provider_invalid'; END IF;
 IF NEW.invocation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.execution_invocations i WHERE i.workspace_id=NEW.workspace_id AND i.invocation_id=NEW.invocation_id AND i.product_command_id=NEW.accept_command_id AND i.controller_kind='member_agent_request' AND i.controller_id=NEW.request_id AND i.mode='bounded_agent' AND i.isolation='remote' AND i.payload->'request'->'actor'->>'userId'=NEW.provider_user_id) THEN RAISE EXCEPTION 'member_agent_request_invocation_invalid'; END IF;
 RETURN NEW;
END $body$;
CREATE TRIGGER member_agent_request_guard BEFORE INSERT OR UPDATE OR DELETE ON public.member_agent_requests FOR EACH ROW EXECUTE FUNCTION public.guard_member_agent_request();
-- Preserve all existing aggregate guards; this target is checked separately.
DROP TRIGGER product_commands_special_target_guard ON public.product_commands;
CREATE CONSTRAINT TRIGGER product_commands_special_target_guard
 AFTER INSERT ON public.product_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (NEW.kind NOT IN ('project_create','project_members_revise','work_item_create','work_item_update','device_register','device_revoke','agent_tool_approval_decide','model_profile_create','project_file_commit','member_agent_request_create','member_agent_request_accept','member_agent_request_decline','member_agent_request_cancel') AND NOT (NEW.kind='agent_turn' AND NEW.target_kind IN ('work_item','work_item_continuation_turn')))
 EXECUTE FUNCTION public.validate_product_command_special_target();
CREATE FUNCTION public.validate_member_agent_command() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.member_agent_requests r WHERE r.workspace_id=NEW.workspace_id AND r.request_id=NEW.target_id AND r.revision=NEW.target_revision AND ((NEW.kind='member_agent_request_create' AND r.create_command_id=NEW.command_id AND r.requester_user_id=NEW.effective_principal_id) OR (NEW.kind='member_agent_request_accept' AND r.accept_command_id=NEW.command_id AND r.provider_user_id=NEW.effective_principal_id) OR (NEW.kind='member_agent_request_decline' AND r.provider_user_id=NEW.effective_principal_id AND r.consent='declined') OR (NEW.kind='member_agent_request_cancel' AND NEW.effective_principal_id IN (r.provider_user_id,r.requester_user_id) AND r.consent='revoked'))) THEN RAISE EXCEPTION 'member_agent_command_target_invalid'; END IF;
 RETURN NEW;
END $body$;
CREATE CONSTRAINT TRIGGER member_agent_command_guard AFTER INSERT ON public.product_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind IN ('member_agent_request_create','member_agent_request_accept','member_agent_request_decline','member_agent_request_cancel')) EXECUTE FUNCTION public.validate_member_agent_command();
