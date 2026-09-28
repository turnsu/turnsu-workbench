-- Add one explicit, completed model setup command without weakening any
-- existing command shape. Keep the current expressions (including Tool resume).
DO $migration$
DECLARE
  constraint_name text;
  old_expression text;
  new_expression text;
BEGIN
  FOREACH constraint_name IN ARRAY ARRAY[
    'product_commands_kind', 'product_commands_session_turn_shape',
    'product_commands_special_target_shape', 'product_commands_special_completed'
  ] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO STRICT old_expression
      FROM pg_constraint WHERE conrelid = 'public.product_commands'::regclass AND conname = constraint_name;
    new_expression := CASE constraint_name
      WHEN 'product_commands_kind' THEN 'true'
      WHEN 'product_commands_session_turn_shape' THEN 'session_id IS NULL AND turn_id IS NULL'
      WHEN 'product_commands_special_target_shape' THEN
        'effect_class = ''administrative'' AND target_kind = ''model_profile_revision'' AND target_id IS NOT NULL AND target_revision = 1'
      ELSE 'status = ''completed''' END;
    EXECUTE format('ALTER TABLE public.product_commands DROP CONSTRAINT %I', constraint_name);
    EXECUTE format('ALTER TABLE public.product_commands ADD CONSTRAINT %I CHECK ((kind = ''model_profile_create'' AND (%s)) OR (kind <> ''model_profile_create'' AND (%s)))',
      constraint_name, new_expression, old_expression);
  END LOOP;
END;
$migration$;

DROP TRIGGER product_commands_special_target_guard ON public.product_commands;
CREATE CONSTRAINT TRIGGER product_commands_special_target_guard
  AFTER INSERT ON public.product_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind NOT IN (
    'project_create', 'project_members_revise', 'work_item_create', 'work_item_update',
    'device_register', 'device_revoke', 'agent_tool_approval_decide', 'model_profile_create'
  ) AND NOT (NEW.kind = 'agent_turn' AND NEW.target_kind IN ('work_item', 'work_item_continuation_turn')))
  EXECUTE FUNCTION public.validate_product_command_special_target();

CREATE FUNCTION public.validate_model_configuration_command_target()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE target_exists boolean;
BEGIN
  IF NEW.kind <> 'model_profile_create' THEN RETURN NEW; END IF;
  SELECT revision.config_hash = NEW.argument_digest
    AND revision.payload->>'configurationCommandId' = NEW.command_id
    AND profile.scope_id = NEW.scope_id
    AND revision.created_by_principal_id = NEW.effective_principal_id
    AND revision.created_by_principal_kind = 'user'
    AND revision.revision_number = NEW.target_revision
    AND binding.status = 'active'
    AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
  INTO target_exists
  FROM public.model_profile_revisions revision
  JOIN public.model_profiles profile USING (workspace_id, profile_id)
  JOIN public.secret_bindings binding ON binding.workspace_id = revision.workspace_id
    AND binding.secret_binding_id = revision.secret_binding_id
  JOIN public.workspace_memberships membership ON membership.workspace_id = revision.workspace_id
    AND membership.user_id = revision.created_by_principal_id
  WHERE revision.workspace_id = NEW.workspace_id AND revision.revision_id = NEW.target_id;
  IF NEW.status <> 'completed' OR target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'model_configuration_command_target_invalid' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE CONSTRAINT TRIGGER product_commands_model_configuration_target_guard
  AFTER INSERT ON public.product_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.validate_model_configuration_command_target();
