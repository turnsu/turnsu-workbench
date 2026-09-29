-- Administration remains authorized in the administrator's own operation
-- scope. The new Model and Secret Binding belong to the named recipient's
-- personal scope; no scope grant or private Session access is issued.
CREATE OR REPLACE FUNCTION public.validate_model_configuration_command_target()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE target_exists boolean;
BEGIN
  IF NEW.kind <> 'model_profile_create' THEN RETURN NEW; END IF;
  SELECT revision.config_hash = NEW.argument_digest
    AND revision.payload->>'configurationCommandId' = NEW.command_id
    AND revision.created_by_principal_id = NEW.effective_principal_id
    AND revision.created_by_principal_kind = 'user'
    AND revision.revision_number = NEW.target_revision
    AND binding.status = 'active' AND binding.scope_id = profile.scope_id
    AND authority_scope.scope_id = NEW.scope_id
    AND authority_scope.owner_user_id = NEW.effective_principal_id
    AND authority_scope.scope_kind = 'personal' AND authority_scope.status = 'active'
    AND recipient_scope.owner_user_id = COALESCE(revision.payload->>'configuredForUserId', NEW.effective_principal_id::text)
    AND recipient_scope.owner_user_id = COALESCE(NEW.payload->>'configuredForUserId', NEW.effective_principal_id::text)
    AND recipient_scope.scope_kind = 'personal' AND recipient_scope.status = 'active'
    AND membership.status = 'active' AND membership.role IN ('owner', 'admin')
    AND recipient_membership.status = 'active' AND recipient_membership.role IN ('owner', 'admin', 'member')
    AND administrator.disabled = false AND recipient.disabled = false
  INTO target_exists
  FROM public.model_profile_revisions revision
  JOIN public.model_profiles profile USING (workspace_id, profile_id)
  JOIN public.secret_bindings binding ON binding.workspace_id = revision.workspace_id
    AND binding.secret_binding_id = revision.secret_binding_id
  JOIN public.product_scopes authority_scope ON authority_scope.workspace_id = revision.workspace_id
    AND authority_scope.scope_id = NEW.scope_id
  JOIN public.product_scopes recipient_scope ON recipient_scope.workspace_id = profile.workspace_id
    AND recipient_scope.scope_id = profile.scope_id
  JOIN public.workspace_memberships membership ON membership.workspace_id = revision.workspace_id
    AND membership.user_id = revision.created_by_principal_id
  JOIN public.workspace_memberships recipient_membership ON recipient_membership.workspace_id = revision.workspace_id
    AND recipient_membership.user_id = recipient_scope.owner_user_id
  JOIN public.product_users administrator ON administrator.user_id = membership.user_id
  JOIN public.product_users recipient ON recipient.user_id = recipient_membership.user_id
  WHERE revision.workspace_id = NEW.workspace_id AND revision.revision_id = NEW.target_id;
  IF NEW.status <> 'completed' OR target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'model_configuration_command_target_invalid' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;
