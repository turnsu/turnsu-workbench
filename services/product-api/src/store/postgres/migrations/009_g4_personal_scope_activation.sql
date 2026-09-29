-- Every active workspace member needs one personal authority Scope.  The
-- workspace creator still owns the one-time seed; later member activation is
-- a separate, self-owned aggregate and must never reuse that seed mode.

ALTER TABLE public.product_scopes
  DROP CONSTRAINT product_scopes_creation_mode,
  DROP CONSTRAINT product_scopes_creation_shape;

ALTER TABLE public.product_scopes
  ADD CONSTRAINT product_scopes_creation_mode CHECK (
    creation_mode IN (
      'workspace_initial_seed', 'system_initial_seed', 'membership_activation', 'command'
    )
  ),
  ADD CONSTRAINT product_scopes_creation_shape CHECK (
    (creation_mode = 'command'
      AND creation_command_id IS NOT NULL
      AND creation_authority_scope_id IS NOT NULL
      AND creation_authority_scope_id <> scope_id)
    OR (creation_mode IN (
      'workspace_initial_seed', 'system_initial_seed', 'membership_activation'
    )
      AND creation_command_id IS NULL
      AND creation_authority_scope_id IS NULL)
  );

CREATE OR REPLACE FUNCTION public.validate_product_scope_creation_aggregate()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  scope_row public.product_scopes%ROWTYPE;
  policy_count integer;
  initial_grant_count integer;
  seed_authority_valid boolean;
  command_authority_valid boolean;
BEGIN
  SELECT * INTO scope_row
  FROM public.product_scopes
  WHERE workspace_id = NEW.workspace_id AND scope_id = NEW.scope_id;

  SELECT count(*) INTO policy_count
  FROM public.scope_policy_revisions p
  WHERE p.workspace_id = scope_row.workspace_id
    AND p.scope_id = scope_row.scope_id
    AND p.revision = 1
    AND p.policy_revision_id = scope_row.current_policy_revision_id
    AND p.created_by_principal_id = scope_row.created_by_principal_id
    AND p.created_by_principal_kind = scope_row.created_by_principal_kind;

  SELECT count(*) INTO initial_grant_count
  FROM public.scope_principal_grants g
  WHERE g.workspace_id = scope_row.workspace_id
    AND g.scope_id = scope_row.scope_id
    AND g.issuance_kind = 'scope_creation'
    AND g.principal_id = scope_row.created_by_principal_id
    AND g.principal_kind = scope_row.created_by_principal_kind
    AND g.access_kind = 'operation'
    AND g.status = 'active'
    AND g.revision = 1;

  IF scope_row.revision <> 1 OR policy_count <> 1 OR initial_grant_count <> 1 THEN
    RAISE EXCEPTION 'product_scope_initial_aggregate_incomplete'
      USING ERRCODE = '23503';
  END IF;

  IF scope_row.creation_mode = 'workspace_initial_seed' THEN
    SELECT w.created_by = scope_row.owner_user_id
      AND scope_row.owner_user_id = scope_row.created_by_principal_id
      AND scope_row.created_by_principal_kind = 'user'
      AND scope_row.scope_kind = 'personal'
      AND m.role = 'owner'
      AND m.status = 'active'
      AND p.status = 'active'
      AND (SELECT count(*) FROM public.product_scopes seeded
        WHERE seeded.workspace_id = scope_row.workspace_id) = 1
    INTO seed_authority_valid
    FROM public.product_workspaces w
    JOIN public.workspace_memberships m
      ON m.workspace_id = w.workspace_id AND m.user_id = w.created_by
    JOIN public.workspace_principals p
      ON p.workspace_id = m.workspace_id
     AND p.principal_id = m.user_id
     AND p.principal_kind = 'user'
     AND p.membership_id = m.membership_id
    WHERE w.workspace_id = scope_row.workspace_id;
    IF seed_authority_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'workspace_initial_scope_seed_forbidden'
        USING ERRCODE = '23514';
    END IF;
  ELSIF scope_row.creation_mode = 'system_initial_seed' THEN
    SELECT scope_row.workspace_id = 'system-catalog'
      AND w.created_by = 'system-catalog'
      AND p.status = 'active'
      AND c.status = 'enabled'
    INTO seed_authority_valid
    FROM public.product_workspaces w
    JOIN public.workspace_principals p
      ON p.workspace_id = w.workspace_id
     AND p.principal_id = 'system-catalog'
     AND p.principal_kind = 'system'
    JOIN public.skill_system_catalog_principals c
      ON c.principal_id = p.principal_id
     AND c.product_user_id = 'system-catalog'
    WHERE w.workspace_id = scope_row.workspace_id;
    IF seed_authority_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'system_initial_scope_seed_forbidden'
        USING ERRCODE = '23514';
    END IF;
  ELSIF scope_row.creation_mode = 'membership_activation' THEN
    SELECT scope_row.scope_kind = 'personal'
      AND scope_row.owner_user_id = scope_row.created_by_principal_id
      AND scope_row.created_by_principal_kind = 'user'
      AND membership.status = 'active'
      AND principal.status = 'active'
      AND principal.membership_id = membership.membership_id
      AND (SELECT count(*) FROM public.product_scopes personal
        WHERE personal.workspace_id = scope_row.workspace_id
          AND personal.scope_kind = 'personal'
          AND personal.owner_user_id = scope_row.owner_user_id
          AND personal.status = 'active') = 1
    INTO seed_authority_valid
    FROM public.workspace_memberships membership
    JOIN public.workspace_principals principal
      ON principal.workspace_id = membership.workspace_id
     AND principal.principal_id = membership.user_id
     AND principal.principal_kind = 'user'
    WHERE membership.workspace_id = scope_row.workspace_id
      AND membership.user_id = scope_row.owner_user_id;
    IF seed_authority_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'membership_activation_scope_forbidden'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT c.status = 'completed'
      AND c.kind = 'scope_create'
      AND c.effect_class = 'administrative'
      AND c.scope_id = scope_row.creation_authority_scope_id
      AND c.effective_principal_id = scope_row.created_by_principal_id
      AND c.effective_principal_kind = scope_row.created_by_principal_kind
      AND c.target_kind = 'product_scope'
      AND c.target_id = scope_row.scope_id
      AND c.target_revision = 1
    INTO command_authority_valid
    FROM public.product_commands c
    WHERE c.workspace_id = scope_row.workspace_id
      AND c.command_id = scope_row.creation_command_id;
    IF command_authority_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'product_scope_creation_command_invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
