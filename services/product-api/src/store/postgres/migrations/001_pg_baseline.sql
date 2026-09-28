-- PostgreSQL Product Store clean-slate baseline: G2 core, B1, B2, B3, B4A, and B4B.
--
-- This baseline does not yet claim the complete active-family inventory; later
-- G2 batches own the remaining product families. Query, authority and concurrency
-- keys stay relational while each business table retains only non-indexed extension
-- fields in payload. This file contains no seed data.

CREATE DOMAIN public.product_identifier AS text COLLATE "C"
  CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

CREATE TABLE public.product_schema_migrations (
  version text COLLATE "C" PRIMARY KEY,
  checksum text COLLATE "C" NOT NULL,
  description text NOT NULL,
  status text COLLATE "C" NOT NULL DEFAULT 'applied',
  applied_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT product_schema_migrations_version_format
    CHECK (version ~ '^[0-9]{3}_[a-z0-9_]+$'),
  CONSTRAINT product_schema_migrations_checksum_format
    CHECK (checksum ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT product_schema_migrations_applied_status
    CHECK (status = 'applied')
);

CREATE TABLE public.product_users (
  user_id public.product_identifier PRIMARY KEY,
  schema_version text COLLATE "C" NOT NULL,
  display_name text NOT NULL,
  username text,
  username_normalized text COLLATE "C",
  password_hash text,
  account_role text COLLATE "C",
  disabled boolean NOT NULL DEFAULT false,
  bootstrap_admin_claim boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT product_users_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT product_users_account_role CHECK (account_role IS NULL OR account_role IN ('admin', 'member')),
  CONSTRAINT product_users_bootstrap_role CHECK (NOT bootstrap_admin_claim OR account_role = 'admin'),
  CONSTRAINT product_users_time_order CHECK (updated_at >= created_at),
  CONSTRAINT product_users_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX product_users_username_normalized_uq
  ON public.product_users (username_normalized)
  WHERE username_normalized IS NOT NULL;
CREATE UNIQUE INDEX product_users_one_bootstrap_admin_uq
  ON public.product_users (bootstrap_admin_claim)
  WHERE bootstrap_admin_claim;

CREATE TABLE public.product_workspaces (
  workspace_id public.product_identifier PRIMARY KEY,
  schema_version text COLLATE "C" NOT NULL,
  name text NOT NULL,
  created_by public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT product_workspaces_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT product_workspaces_time_order CHECK (updated_at >= created_at),
  CONSTRAINT product_workspaces_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.workspace_memberships (
  membership_id public.product_identifier NOT NULL,
  workspace_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  role text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL DEFAULT 'active',
  revision integer NOT NULL DEFAULT 1,
  suspended_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_memberships_membership_id_uq UNIQUE (membership_id),
  CONSTRAINT workspace_memberships_authority_identity_uq
    UNIQUE (workspace_id, user_id, membership_id),
  CONSTRAINT workspace_memberships_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT workspace_memberships_user_fk
    FOREIGN KEY (user_id) REFERENCES public.product_users (user_id),
  CONSTRAINT workspace_memberships_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT workspace_memberships_role CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  CONSTRAINT workspace_memberships_status CHECK (status IN ('active', 'suspended', 'removed')),
  CONSTRAINT workspace_memberships_revision_positive CHECK (revision >= 1),
  CONSTRAINT workspace_memberships_status_shape CHECK (
    (status = 'active' AND suspended_at IS NULL AND removed_at IS NULL)
    OR (status = 'suspended' AND suspended_at IS NOT NULL AND removed_at IS NULL)
    OR (status = 'removed' AND removed_at IS NOT NULL)
  ),
  CONSTRAINT workspace_memberships_lifecycle_time_order CHECK (
    (suspended_at IS NULL OR suspended_at >= created_at)
    AND (removed_at IS NULL OR removed_at >= created_at)
  ),
  CONSTRAINT workspace_memberships_time_order CHECK (updated_at >= created_at),
  CONSTRAINT workspace_memberships_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX workspace_memberships_user_workspace_idx
  ON public.workspace_memberships (user_id, workspace_id, status);

CREATE FUNCTION public.enforce_workspace_membership_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workspace_membership_terminal';
  END IF;
  IF NEW.membership_id IS DISTINCT FROM OLD.membership_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'workspace_membership_identity_immutable';
  END IF;
  IF ROW(NEW.role, NEW.status, NEW.suspended_at, NEW.removed_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.role, OLD.status, OLD.suspended_at, OLD.removed_at, OLD.payload)
    AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'workspace_membership_revision_required';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'workspace_membership_revision_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_execution_effect_receipt_parent_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  affected_invocation_id public.product_identifier;
  inconsistent boolean;
BEGIN
  affected_invocation_id := CASE TG_TABLE_NAME
    WHEN 'execution_invocations' THEN NEW.invocation_id
    WHEN 'execution_attempts' THEN NEW.invocation_id
    WHEN 'external_effect_receipts' THEN NEW.invocation_id
    ELSE NULL
  END;
  IF affected_invocation_id IS NULL THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.execution_attempts attempt
    WHERE attempt.invocation_id = affected_invocation_id
      AND attempt.status IN (
        'completed', 'failed', 'cancelled', 'blocked', 'partial',
        'effect_outcome_unknown', 'timeout', 'permission_denied',
        'sandbox_unavailable', 'remote_backend_unavailable'
      )
      AND (
        (attempt.status = 'completed' AND EXISTS (
          SELECT 1 FROM public.external_effect_receipts receipt
          WHERE receipt.invocation_id = attempt.invocation_id
            AND receipt.attempt_id = attempt.attempt_id
            AND receipt.status <> 'succeeded'
        ))
        OR (attempt.status = 'effect_outcome_unknown' AND (
          NOT EXISTS (
            SELECT 1 FROM public.external_effect_receipts receipt
            WHERE receipt.invocation_id = attempt.invocation_id
              AND receipt.attempt_id = attempt.attempt_id
              AND receipt.status = 'outcome_unknown'
          ) OR EXISTS (
            SELECT 1 FROM public.external_effect_receipts receipt
            WHERE receipt.invocation_id = attempt.invocation_id
              AND receipt.attempt_id = attempt.attempt_id
              AND receipt.status IN ('pending', 'intent_recorded', 'dispatching')
          )
        ))
        OR (attempt.status NOT IN ('completed', 'effect_outcome_unknown')
          AND EXISTS (
            SELECT 1 FROM public.external_effect_receipts receipt
            WHERE receipt.invocation_id = attempt.invocation_id
              AND receipt.attempt_id = attempt.attempt_id
              AND receipt.status NOT IN ('succeeded', 'cancelled')
          ))
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.execution_invocations invocation
    WHERE invocation.invocation_id = affected_invocation_id
      AND invocation.status IN (
        'completed', 'failed', 'cancelled', 'blocked', 'partial',
        'effect_outcome_unknown', 'timeout', 'permission_denied',
        'sandbox_unavailable', 'remote_backend_unavailable'
      )
      AND (
        (invocation.status = 'completed' AND EXISTS (
          SELECT 1 FROM public.external_effect_receipts receipt
          WHERE receipt.invocation_id = invocation.invocation_id
            AND receipt.status <> 'succeeded'
        ))
        OR (invocation.status = 'effect_outcome_unknown' AND (
          NOT EXISTS (
            SELECT 1 FROM public.external_effect_receipts receipt
            WHERE receipt.invocation_id = invocation.invocation_id
              AND receipt.status = 'outcome_unknown'
          ) OR EXISTS (
            SELECT 1 FROM public.external_effect_receipts receipt
            WHERE receipt.invocation_id = invocation.invocation_id
              AND receipt.status IN ('pending', 'intent_recorded', 'dispatching')
          )
        ))
        OR (invocation.status NOT IN ('completed', 'effect_outcome_unknown')
          AND EXISTS (
            SELECT 1 FROM public.external_effect_receipts receipt
            WHERE receipt.invocation_id = invocation.invocation_id
              AND receipt.status NOT IN ('succeeded', 'cancelled')
          ))
      )
  ) INTO inconsistent;
  IF inconsistent THEN
    RAISE EXCEPTION 'execution_effect_receipt_parent_inconsistent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_memberships_revision_guard
  BEFORE UPDATE OR DELETE ON public.workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_membership_revision();

-- G2 B4A: minimum workspace/scope authority foundation. Account-level roles are
-- deliberately absent from every authority FK below.

CREATE TABLE public.workspace_principals (
  workspace_id public.product_identifier NOT NULL,
  principal_id public.product_identifier NOT NULL,
  principal_kind text COLLATE "C" NOT NULL,
  user_id public.product_identifier,
  membership_id public.product_identifier,
  status text COLLATE "C" NOT NULL DEFAULT 'active',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, principal_id),
  CONSTRAINT workspace_principals_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT workspace_principals_user_membership_fk
    FOREIGN KEY (workspace_id, user_id, membership_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id, membership_id),
  CONSTRAINT workspace_principals_kind_identity_uq
    UNIQUE (workspace_id, principal_id, principal_kind),
  CONSTRAINT workspace_principals_user_identity_uq
    UNIQUE NULLS NOT DISTINCT (workspace_id, principal_id, principal_kind, user_id),
  CONSTRAINT workspace_principals_kind CHECK (
    principal_kind IN ('user', 'automation', 'connector', 'scheduler', 'system')
  ),
  CONSTRAINT workspace_principals_user_shape CHECK (
    (principal_kind = 'user'
      AND user_id IS NOT NULL
      AND membership_id IS NOT NULL
      AND principal_id = user_id)
    OR (principal_kind <> 'user' AND user_id IS NULL AND membership_id IS NULL)
  ),
  CONSTRAINT workspace_principals_status CHECK (status IN ('active', 'revoked')),
  CONSTRAINT workspace_principals_revision_positive CHECK (revision >= 1),
  CONSTRAINT workspace_principals_revocation_shape CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  ),
  CONSTRAINT workspace_principals_time_order CHECK (
    updated_at >= created_at AND (revoked_at IS NULL OR revoked_at >= created_at)
  ),
  CONSTRAINT workspace_principals_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX workspace_principals_active_kind_idx
  ON public.workspace_principals (workspace_id, principal_kind, principal_id)
  WHERE status = 'active';

CREATE FUNCTION public.enforce_workspace_principal_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'workspace_principal_terminal';
  END IF;
  IF ROW(NEW.workspace_id, NEW.principal_id, NEW.principal_kind, NEW.user_id,
         NEW.membership_id, NEW.created_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.workspace_id, OLD.principal_id, OLD.principal_kind, OLD.user_id,
         OLD.membership_id, OLD.created_at, OLD.payload) THEN
    RAISE EXCEPTION 'workspace_principal_identity_immutable';
  END IF;
  IF ROW(NEW.status, NEW.revoked_at) IS DISTINCT FROM ROW(OLD.status, OLD.revoked_at)
    AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'workspace_principal_revision_required';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'workspace_principal_revision_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_principals_revision_guard
  BEFORE UPDATE OR DELETE ON public.workspace_principals
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_principal_revision();

CREATE TABLE public.product_scopes (
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  scope_kind text COLLATE "C" NOT NULL,
  owner_user_id public.product_identifier,
  owner_principal_id public.product_identifier,
  owner_principal_kind text COLLATE "C"
    GENERATED ALWAYS AS (CASE WHEN scope_kind = 'personal' THEN 'user' END) STORED,
  project_id public.product_identifier,
  status text COLLATE "C" NOT NULL DEFAULT 'active',
  revision integer NOT NULL DEFAULT 1,
  current_policy_revision_id public.product_identifier NOT NULL,
  created_by_principal_id public.product_identifier NOT NULL,
  created_by_principal_kind text COLLATE "C" NOT NULL,
  creation_mode text COLLATE "C" NOT NULL,
  creation_command_id public.product_identifier,
  creation_authority_scope_id public.product_identifier,
  creation_target_kind text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN creation_mode = 'command' THEN 'product_scope' END
  ) STORED,
  creation_target_revision integer GENERATED ALWAYS AS (
    CASE WHEN creation_mode = 'command' THEN 1 END
  ) STORED,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, scope_id),
  CONSTRAINT product_scopes_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT product_scopes_owner_principal_fk
    FOREIGN KEY (workspace_id, owner_principal_id, owner_principal_kind, owner_user_id)
    REFERENCES public.workspace_principals (workspace_id, principal_id, principal_kind, user_id),
  CONSTRAINT product_scopes_creator_principal_fk
    FOREIGN KEY (workspace_id, created_by_principal_id, created_by_principal_kind)
    REFERENCES public.workspace_principals (workspace_id, principal_id, principal_kind),
  CONSTRAINT product_scopes_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT product_scopes_kind CHECK (scope_kind IN ('personal', 'project')),
  CONSTRAINT product_scopes_kind_shape CHECK (
    (scope_kind = 'personal'
      AND owner_user_id IS NOT NULL
      AND owner_principal_id IS NOT NULL
      AND project_id IS NULL)
    OR (scope_kind = 'project'
      AND owner_user_id IS NULL
      AND owner_principal_id IS NULL
      AND project_id IS NOT NULL)
  ),
  CONSTRAINT product_scopes_personal_creator CHECK (
    scope_kind <> 'personal'
    OR (owner_user_id = created_by_principal_id
      AND owner_principal_id = created_by_principal_id
      AND created_by_principal_kind = 'user')
  ),
  CONSTRAINT product_scopes_creation_mode CHECK (
    creation_mode IN ('workspace_initial_seed', 'system_initial_seed', 'command')
  ),
  CONSTRAINT product_scopes_creation_shape CHECK (
    (creation_mode = 'command'
      AND creation_command_id IS NOT NULL
      AND creation_authority_scope_id IS NOT NULL
      AND creation_authority_scope_id <> scope_id)
    OR (creation_mode IN ('workspace_initial_seed', 'system_initial_seed')
      AND creation_command_id IS NULL
      AND creation_authority_scope_id IS NULL)
  ),
  CONSTRAINT product_scopes_system_seed_shape CHECK (
    creation_mode <> 'system_initial_seed'
    OR (workspace_id = 'system-catalog'
      AND scope_id = 'system-catalog'
      AND scope_kind = 'project'
      AND project_id = 'system-catalog'
      AND created_by_principal_id = 'system-catalog'
      AND created_by_principal_kind = 'system')
  ),
  CONSTRAINT product_scopes_status CHECK (status IN ('active', 'archived')),
  CONSTRAINT product_scopes_revision_positive CHECK (revision >= 1),
  CONSTRAINT product_scopes_archive_shape CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT product_scopes_time_order CHECK (
    updated_at >= created_at AND (archived_at IS NULL OR archived_at >= created_at)
  ),
  CONSTRAINT product_scopes_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX product_scopes_one_active_personal_uq
  ON public.product_scopes (workspace_id, owner_user_id)
  WHERE scope_kind = 'personal' AND status = 'active';
CREATE UNIQUE INDEX product_scopes_one_active_project_uq
  ON public.product_scopes (workspace_id, project_id)
  WHERE scope_kind = 'project' AND status = 'active';
CREATE UNIQUE INDEX product_scopes_one_workspace_seed_uq
  ON public.product_scopes (workspace_id, creation_mode)
  WHERE creation_mode = 'workspace_initial_seed';
CREATE UNIQUE INDEX product_scopes_one_system_seed_uq
  ON public.product_scopes (workspace_id, creation_mode)
  WHERE creation_mode = 'system_initial_seed';

CREATE FUNCTION public.enforce_product_scope_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'archived' THEN
    RAISE EXCEPTION 'product_scope_terminal';
  END IF;
  IF ROW(NEW.workspace_id, NEW.scope_id, NEW.schema_version, NEW.scope_kind,
         NEW.owner_user_id, NEW.owner_principal_id, NEW.project_id,
         NEW.created_by_principal_id, NEW.created_by_principal_kind,
         NEW.creation_mode, NEW.creation_command_id,
         NEW.creation_authority_scope_id,
         NEW.created_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.workspace_id, OLD.scope_id, OLD.schema_version, OLD.scope_kind,
         OLD.owner_user_id, OLD.owner_principal_id, OLD.project_id,
         OLD.created_by_principal_id, OLD.created_by_principal_kind,
         OLD.creation_mode, OLD.creation_command_id,
         OLD.creation_authority_scope_id,
         OLD.created_at, OLD.payload) THEN
    RAISE EXCEPTION 'product_scope_identity_immutable';
  END IF;
  IF ROW(NEW.status, NEW.current_policy_revision_id, NEW.archived_at)
      IS DISTINCT FROM
     ROW(OLD.status, OLD.current_policy_revision_id, OLD.archived_at)
    AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'product_scope_revision_required';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'product_scope_revision_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER product_scopes_revision_guard
  BEFORE UPDATE OR DELETE ON public.product_scopes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_product_scope_revision();

CREATE TABLE public.scope_policy_revisions (
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  policy_revision_id public.product_identifier NOT NULL,
  revision integer NOT NULL,
  observation_tier text COLLATE "C" NOT NULL,
  permission_mode text COLLATE "C" NOT NULL,
  auto_approved_effect_classes text[] NOT NULL DEFAULT ARRAY[]::text[],
  auto_approved_action_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  policy_content_hash text COLLATE "C" NOT NULL,
  created_by_principal_id public.product_identifier NOT NULL,
  created_by_principal_kind text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, scope_id, policy_revision_id),
  CONSTRAINT scope_policy_revisions_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT scope_policy_revisions_creator_fk
    FOREIGN KEY (workspace_id, created_by_principal_id, created_by_principal_kind)
    REFERENCES public.workspace_principals (workspace_id, principal_id, principal_kind),
  CONSTRAINT scope_policy_revisions_revision_uq UNIQUE (workspace_id, scope_id, revision),
  CONSTRAINT scope_policy_revisions_revision_positive CHECK (revision >= 1),
  CONSTRAINT scope_policy_revisions_observation CHECK (
    observation_tier IN ('private', 'workspace_readable', 'observation_disabled')
  ),
  CONSTRAINT scope_policy_revisions_permission_mode CHECK (
    permission_mode IN ('discuss', 'plan', 'interactive', 'auto', 'custom')
  ),
  CONSTRAINT scope_policy_revisions_effect_classes_closed CHECK (
    auto_approved_effect_classes <@ ARRAY[
      'read', 'write_local', 'execute', 'external_write', 'administrative'
    ]::text[]
    AND array_position(auto_approved_effect_classes, NULL) IS NULL
    AND cardinality(auto_approved_effect_classes) <= 5
  ),
  CONSTRAINT scope_policy_revisions_action_ids_bounded CHECK (
    array_position(auto_approved_action_ids, NULL) IS NULL
    AND cardinality(auto_approved_action_ids) <= 128
  ),
  CONSTRAINT scope_policy_revisions_mode_shape CHECK (
    (permission_mode IN ('discuss', 'plan', 'interactive')
      AND cardinality(auto_approved_effect_classes) = 0
      AND cardinality(auto_approved_action_ids) = 0)
    OR (permission_mode = 'auto'
      AND cardinality(auto_approved_effect_classes) >= 1
      AND cardinality(auto_approved_action_ids) = 0)
    OR (permission_mode = 'custom'
      AND cardinality(auto_approved_effect_classes) = 0
      AND cardinality(auto_approved_action_ids) >= 1)
  ),
  CONSTRAINT scope_policy_revisions_hash_format
    CHECK (policy_content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT scope_policy_revisions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

ALTER TABLE public.product_scopes
  ADD CONSTRAINT product_scopes_current_policy_fk
  FOREIGN KEY (workspace_id, scope_id, current_policy_revision_id)
  REFERENCES public.scope_policy_revisions (workspace_id, scope_id, policy_revision_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public.validate_scope_policy_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.auto_approved_effect_classes IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value
      FROM unnest(NEW.auto_approved_effect_classes) AS value
      ORDER BY value
    )
    OR NEW.auto_approved_action_ids IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value
      FROM unnest(NEW.auto_approved_action_ids) AS value
      ORDER BY value
    ) THEN
    RAISE EXCEPTION 'scope_policy_arrays_not_canonical';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER scope_policy_revisions_validate
  BEFORE INSERT ON public.scope_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION public.validate_scope_policy_revision_insert();

CREATE TABLE public.scope_principal_grants (
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  grant_id public.product_identifier NOT NULL,
  principal_id public.product_identifier NOT NULL,
  principal_kind text COLLATE "C" NOT NULL,
  access_kind text COLLATE "C" NOT NULL,
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  can_approve boolean NOT NULL DEFAULT false,
  granted_by_principal_id public.product_identifier NOT NULL,
  granted_by_principal_kind text COLLATE "C" NOT NULL,
  issuance_kind text COLLATE "C" NOT NULL,
  issuance_authority_scope_id public.product_identifier,
  issuance_command_id public.product_identifier,
  issuance_authorization_decision_id public.product_identifier,
  issuance_argument_digest text COLLATE "C",
  issuance_command_kind text COLLATE "C" GENERATED ALWAYS AS (
    CASE issuance_kind
      WHEN 'scope_creation' THEN 'scope_create'
      WHEN 'command' THEN 'scope_principal_grant_issue'
      WHEN 'membership_recovery' THEN 'scope_principal_grant_issue'
    END
  ) STORED,
  issuance_effect_class text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN issuance_command_id IS NOT NULL THEN 'administrative' END
  ) STORED,
  issuance_disposition text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN issuance_command_id IS NOT NULL THEN 'authorized' END
  ) STORED,
  issuance_target_kind text COLLATE "C" GENERATED ALWAYS AS (
    CASE issuance_kind
      WHEN 'scope_creation' THEN 'product_scope'
      WHEN 'command' THEN 'scope_principal_grant'
      WHEN 'membership_recovery' THEN 'scope_principal_grant'
    END
  ) STORED,
  issuance_target_id public.product_identifier GENERATED ALWAYS AS (
    CASE issuance_kind
      WHEN 'scope_creation' THEN scope_id
      WHEN 'command' THEN grant_id
      WHEN 'membership_recovery' THEN grant_id
    END
  ) STORED,
  issuance_target_revision integer GENERATED ALWAYS AS (
    CASE WHEN issuance_command_id IS NOT NULL THEN 1 END
  ) STORED,
  status text COLLATE "C" NOT NULL DEFAULT 'active',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, grant_id),
  CONSTRAINT scope_principal_grants_scope_fk
    FOREIGN KEY (workspace_id, scope_id) REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT scope_principal_grants_principal_fk
    FOREIGN KEY (workspace_id, principal_id, principal_kind)
    REFERENCES public.workspace_principals (workspace_id, principal_id, principal_kind),
  CONSTRAINT scope_principal_grants_grantor_fk
    FOREIGN KEY (workspace_id, granted_by_principal_id, granted_by_principal_kind)
    REFERENCES public.workspace_principals (workspace_id, principal_id, principal_kind),
  CONSTRAINT scope_principal_grants_authority_uq
    UNIQUE (workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind),
  CONSTRAINT scope_principal_grants_access_kind CHECK (access_kind IN ('observation', 'operation')),
  CONSTRAINT scope_principal_grants_capabilities_closed CHECK (
    capabilities <@ ARRAY[
      'object.execute', 'object.publish', 'object.delete', 'object.share', 'object.manage_access'
    ]::text[]
    AND array_position(capabilities, NULL) IS NULL
    AND cardinality(capabilities) <= 5
  ),
  CONSTRAINT scope_principal_grants_observation_shape CHECK (
    access_kind <> 'observation' OR (cardinality(capabilities) = 0 AND NOT can_approve)
  ),
  CONSTRAINT scope_principal_grants_issuance_shape CHECK (
    (issuance_kind = 'scope_creation'
      AND issuance_command_id IS NULL
      AND issuance_authority_scope_id IS NULL
      AND issuance_authorization_decision_id IS NULL
      AND issuance_argument_digest IS NULL)
    OR (issuance_kind = 'scope_creation'
      AND issuance_command_id IS NOT NULL
      AND issuance_authority_scope_id IS NOT NULL
      AND issuance_authority_scope_id <> scope_id
      AND issuance_authorization_decision_id IS NOT NULL
      AND issuance_argument_digest IS NOT NULL)
    OR (issuance_kind = 'command'
      AND issuance_command_id IS NOT NULL
      AND issuance_authority_scope_id = scope_id
      AND issuance_authorization_decision_id IS NOT NULL
      AND issuance_argument_digest IS NOT NULL)
    OR (issuance_kind = 'membership_recovery'
      AND issuance_command_id IS NOT NULL
      AND issuance_authority_scope_id IS NOT NULL
      AND issuance_authority_scope_id <> scope_id
      AND issuance_authorization_decision_id IS NOT NULL
      AND issuance_argument_digest IS NOT NULL)
  ),
  CONSTRAINT scope_principal_grants_issuance_digest CHECK (
    issuance_argument_digest IS NULL
    OR issuance_argument_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT scope_principal_grants_status CHECK (status IN ('active', 'revoked')),
  CONSTRAINT scope_principal_grants_revision_positive CHECK (revision >= 1),
  CONSTRAINT scope_principal_grants_revocation_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT scope_principal_grants_time_order CHECK (
    updated_at >= created_at AND (revoked_at IS NULL OR revoked_at >= created_at)
  ),
  CONSTRAINT scope_principal_grants_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX scope_principal_grants_one_active_uq
  ON public.scope_principal_grants (
    workspace_id, scope_id, principal_id, principal_kind, access_kind
  ) WHERE status = 'active';
CREATE UNIQUE INDEX scope_principal_grants_one_scope_creation_uq
  ON public.scope_principal_grants (workspace_id, scope_id)
  WHERE issuance_kind = 'scope_creation';
CREATE UNIQUE INDEX scope_principal_grants_one_issuance_command_uq
  ON public.scope_principal_grants (workspace_id, issuance_command_id)
  WHERE issuance_command_id IS NOT NULL;

CREATE FUNCTION public.validate_scope_principal_grant_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  scope_creation_matches boolean;
  recovery_allowed boolean;
  recovery_rights_match boolean;
  issuance_command_current boolean;
  subject_principal public.workspace_principals%ROWTYPE;
  subject_membership_active boolean;
  subject_membership_revision integer;
  authority_now timestamptz := clock_timestamp();
BEGIN
  IF NEW.created_at > authority_now THEN
    RAISE EXCEPTION 'scope_principal_grant_from_future';
  END IF;
  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'scope_principal_grant_initial_status_invalid';
  END IF;
  IF NEW.capabilities IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value FROM unnest(NEW.capabilities) AS value ORDER BY value
    ) THEN
    RAISE EXCEPTION 'scope_principal_grant_capabilities_not_canonical';
  END IF;

  SELECT * INTO subject_principal
  FROM public.workspace_principals p
  WHERE p.workspace_id = NEW.workspace_id
    AND p.principal_id = NEW.principal_id
    AND p.principal_kind = NEW.principal_kind
  FOR SHARE;
  IF subject_principal.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'scope_principal_grant_subject_inactive';
  END IF;
  IF NEW.principal_kind = 'user' THEN
    SELECT m.status = 'active', m.revision
    INTO subject_membership_active, subject_membership_revision
    FROM public.workspace_memberships m
    WHERE m.workspace_id = subject_principal.workspace_id
      AND m.user_id = subject_principal.user_id
      AND m.membership_id = subject_principal.membership_id
    FOR SHARE;
    IF subject_membership_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'scope_principal_grant_subject_inactive';
    END IF;
  END IF;

  IF NEW.issuance_kind = 'scope_creation' THEN
    SELECT s.status = 'active'
      AND s.created_by_principal_id = NEW.principal_id
      AND s.created_by_principal_kind = NEW.principal_kind
      AND NEW.granted_by_principal_id = NEW.principal_id
      AND NEW.granted_by_principal_kind = NEW.principal_kind
      AND NEW.principal_kind IN ('user', 'system', 'automation', 'connector', 'scheduler')
      AND NEW.access_kind = 'operation'
      AND NEW.can_approve
      AND (
        (s.creation_mode IN ('workspace_initial_seed', 'system_initial_seed')
          AND NEW.issuance_command_id IS NULL)
        OR (s.creation_mode = 'command'
          AND NEW.issuance_command_id = s.creation_command_id
          AND NEW.issuance_authority_scope_id = s.creation_authority_scope_id)
      )
    INTO scope_creation_matches
    FROM public.product_scopes s
    WHERE s.workspace_id = NEW.workspace_id AND s.scope_id = NEW.scope_id
    FOR KEY SHARE;

    IF scope_creation_matches IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'scope_principal_grant_invalid_scope_creation';
    END IF;
  END IF;

  IF NEW.issuance_kind = 'membership_recovery' THEN
    SELECT s.status = 'active'
      AND s.created_by_principal_id = NEW.principal_id
      AND s.created_by_principal_kind = 'user'
      AND NEW.principal_kind = 'user'
      AND original_grant.principal_id = s.created_by_principal_id
      AND original_grant.principal_kind = s.created_by_principal_kind
      AND original_grant.access_kind = 'operation'
      AND NEW.grant_id <> original_grant.grant_id
      AND subject_membership_revision > 1
      AND NEW.access_kind = 'operation'
      AND NOT EXISTS (
        SELECT 1 FROM public.scope_principal_grants active_grant
        WHERE active_grant.workspace_id = NEW.workspace_id
          AND active_grant.scope_id = NEW.scope_id
          AND active_grant.access_kind = 'operation'
          AND active_grant.status = 'active'
      ),
      NEW.capabilities = original_grant.capabilities
        AND NEW.can_approve = original_grant.can_approve
    INTO recovery_allowed, recovery_rights_match
    FROM public.product_scopes s
    JOIN public.scope_principal_grants original_grant
      ON original_grant.workspace_id = s.workspace_id
     AND original_grant.scope_id = s.scope_id
     AND original_grant.issuance_kind = 'scope_creation'
    WHERE s.workspace_id = NEW.workspace_id AND s.scope_id = NEW.scope_id
    FOR KEY SHARE OF s, original_grant;
    IF recovery_allowed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'scope_principal_grant_recovery_not_allowed';
    END IF;
    IF recovery_rights_match IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'scope_principal_grant_recovery_rights_mismatch';
    END IF;
  END IF;

  IF NEW.issuance_command_id IS NOT NULL THEN
    SELECT c.status = 'completed' AND c.created_at <= NEW.created_at
    INTO issuance_command_current
    FROM public.product_commands c
    WHERE c.workspace_id = NEW.workspace_id
      AND c.command_id = NEW.issuance_command_id
    FOR SHARE;
    IF issuance_command_current IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'scope_principal_grant_issuance_command_inactive';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_scope_principal_grant_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'scope_principal_grant_terminal';
  END IF;
  IF ROW(NEW.workspace_id, NEW.scope_id, NEW.grant_id,
         NEW.principal_id, NEW.principal_kind, NEW.access_kind,
         NEW.capabilities, NEW.can_approve,
         NEW.granted_by_principal_id, NEW.granted_by_principal_kind,
         NEW.issuance_kind, NEW.issuance_authority_scope_id,
         NEW.issuance_command_id,
         NEW.issuance_authorization_decision_id, NEW.issuance_argument_digest,
         NEW.created_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.workspace_id, OLD.scope_id, OLD.grant_id,
         OLD.principal_id, OLD.principal_kind, OLD.access_kind,
         OLD.capabilities, OLD.can_approve,
         OLD.granted_by_principal_id, OLD.granted_by_principal_kind,
         OLD.issuance_kind, OLD.issuance_authority_scope_id,
         OLD.issuance_command_id,
         OLD.issuance_authorization_decision_id, OLD.issuance_argument_digest,
         OLD.created_at, OLD.payload) THEN
    RAISE EXCEPTION 'scope_principal_grant_identity_immutable';
  END IF;
  IF ROW(NEW.status, NEW.revoked_at) IS DISTINCT FROM ROW(OLD.status, OLD.revoked_at)
    AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'scope_principal_grant_revision_required';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'scope_principal_grant_revision_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER scope_principal_grants_validate
  BEFORE INSERT ON public.scope_principal_grants
  FOR EACH ROW EXECUTE FUNCTION public.validate_scope_principal_grant_insert();

CREATE TRIGGER scope_principal_grants_revision_guard
  BEFORE UPDATE OR DELETE ON public.scope_principal_grants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_scope_principal_grant_revision();

CREATE TABLE public.policy_grants (
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  policy_grant_id public.product_identifier NOT NULL,
  subject_principal_id public.product_identifier NOT NULL,
  subject_principal_kind text COLLATE "C" NOT NULL,
  subject_scope_grant_id public.product_identifier NOT NULL,
  access_kind text COLLATE "C" GENERATED ALWAYS AS ('operation') STORED,
  policy_revision_id public.product_identifier NOT NULL,
  authorized_by_principal_id public.product_identifier NOT NULL,
  authorized_by_principal_kind text COLLATE "C" NOT NULL,
  authorizer_scope_grant_id public.product_identifier NOT NULL,
  authorizer_access_kind text COLLATE "C" GENERATED ALWAYS AS ('operation') STORED,
  issuance_command_id public.product_identifier NOT NULL,
  issuance_authorization_decision_id public.product_identifier NOT NULL,
  issuance_argument_digest text COLLATE "C" NOT NULL,
  issuance_command_kind text COLLATE "C"
    GENERATED ALWAYS AS ('policy_grant_issue') STORED,
  issuance_effect_class text COLLATE "C"
    GENERATED ALWAYS AS ('administrative') STORED,
  issuance_disposition text COLLATE "C"
    GENERATED ALWAYS AS ('authorized') STORED,
  issuance_target_kind text COLLATE "C"
    GENERATED ALWAYS AS ('policy_grant') STORED,
  issuance_target_revision integer GENERATED ALWAYS AS (1) STORED,
  status text COLLATE "C" NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  review_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, policy_grant_id),
  CONSTRAINT policy_grants_subject_scope_fk
    FOREIGN KEY (
      workspace_id, scope_id, subject_scope_grant_id,
      subject_principal_id, subject_principal_kind, access_kind
    ) REFERENCES public.scope_principal_grants (
      workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind
    ),
  CONSTRAINT policy_grants_authorizer_scope_fk
    FOREIGN KEY (
      workspace_id, scope_id, authorizer_scope_grant_id,
      authorized_by_principal_id, authorized_by_principal_kind, authorizer_access_kind
    ) REFERENCES public.scope_principal_grants (
      workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind
    ),
  CONSTRAINT policy_grants_policy_fk
    FOREIGN KEY (workspace_id, scope_id, policy_revision_id)
    REFERENCES public.scope_policy_revisions (workspace_id, scope_id, policy_revision_id),
  CONSTRAINT policy_grants_authority_uq UNIQUE (
    workspace_id, scope_id, policy_grant_id,
    subject_principal_id, subject_principal_kind, policy_revision_id
  ),
  CONSTRAINT policy_grants_access_kind CHECK (
    access_kind = 'operation' AND authorizer_access_kind = 'operation'
  ),
  CONSTRAINT policy_grants_status CHECK (
    status IN ('active', 'revoked', 'expired', 'revalidation_required')
  ),
  CONSTRAINT policy_grants_revision_positive CHECK (revision >= 1),
  CONSTRAINT policy_grants_expiry_order CHECK (
    expires_at > created_at AND (review_at IS NULL OR review_at >= created_at)
  ),
  CONSTRAINT policy_grants_issuance_digest_format CHECK (
    issuance_argument_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT policy_grants_revocation_shape CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
  ),
  CONSTRAINT policy_grants_time_order CHECK (
    updated_at >= created_at AND (revoked_at IS NULL OR revoked_at >= created_at)
  ),
  CONSTRAINT policy_grants_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX policy_grants_subject_active_idx
  ON public.policy_grants (
    workspace_id, scope_id, subject_principal_kind, subject_principal_id, expires_at
  ) WHERE status = 'active';
CREATE UNIQUE INDEX policy_grants_one_active_subject_policy_uq
  ON public.policy_grants (
    workspace_id, scope_id, subject_principal_kind, subject_principal_id, policy_revision_id
  ) WHERE status = 'active';
CREATE UNIQUE INDEX policy_grants_one_issuance_command_uq
  ON public.policy_grants (workspace_id, issuance_command_id);

CREATE FUNCTION public.validate_policy_grant_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  subject_grant_active boolean;
  authorizer_grant_active boolean;
  issuance_command_current boolean;
  authority_now timestamptz := clock_timestamp();
BEGIN
  IF NEW.created_at > authority_now OR NEW.expires_at <= authority_now THEN
    RAISE EXCEPTION 'policy_grant_time_invalid';
  END IF;
  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'policy_grant_initial_status_invalid';
  END IF;
  SELECT status = 'active' INTO subject_grant_active
  FROM public.scope_principal_grants
  WHERE workspace_id = NEW.workspace_id
    AND scope_id = NEW.scope_id
    AND grant_id = NEW.subject_scope_grant_id
  FOR SHARE;
  SELECT status = 'active' INTO authorizer_grant_active
  FROM public.scope_principal_grants
  WHERE workspace_id = NEW.workspace_id
    AND scope_id = NEW.scope_id
    AND grant_id = NEW.authorizer_scope_grant_id
  FOR SHARE;
  SELECT status = 'completed' AND created_at <= NEW.created_at
  INTO issuance_command_current
  FROM public.product_commands
  WHERE workspace_id = NEW.workspace_id
    AND command_id = NEW.issuance_command_id
  FOR SHARE;
  IF subject_grant_active IS DISTINCT FROM true
    OR authorizer_grant_active IS DISTINCT FROM true
    OR issuance_command_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'policy_grant_issuance_inactive';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_policy_grant_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'active' THEN
    RAISE EXCEPTION 'policy_grant_terminal';
  END IF;
  IF ROW(NEW.workspace_id, NEW.scope_id, NEW.policy_grant_id,
         NEW.subject_principal_id, NEW.subject_principal_kind,
         NEW.subject_scope_grant_id, NEW.policy_revision_id,
         NEW.authorized_by_principal_id, NEW.authorized_by_principal_kind,
         NEW.authorizer_scope_grant_id, NEW.issuance_command_id,
         NEW.issuance_authorization_decision_id, NEW.issuance_argument_digest,
         NEW.expires_at, NEW.review_at, NEW.created_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.workspace_id, OLD.scope_id, OLD.policy_grant_id,
         OLD.subject_principal_id, OLD.subject_principal_kind,
         OLD.subject_scope_grant_id, OLD.policy_revision_id,
         OLD.authorized_by_principal_id, OLD.authorized_by_principal_kind,
         OLD.authorizer_scope_grant_id, OLD.issuance_command_id,
         OLD.issuance_authorization_decision_id, OLD.issuance_argument_digest,
         OLD.expires_at, OLD.review_at, OLD.created_at, OLD.payload) THEN
    RAISE EXCEPTION 'policy_grant_identity_immutable';
  END IF;
  IF ROW(NEW.status, NEW.revoked_at) IS DISTINCT FROM ROW(OLD.status, OLD.revoked_at)
    AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'policy_grant_revision_required';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'policy_grant_revision_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER policy_grants_revision_guard
  BEFORE UPDATE OR DELETE ON public.policy_grants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_policy_grant_revision();

CREATE TRIGGER policy_grants_validate
  BEFORE INSERT ON public.policy_grants
  FOR EACH ROW EXECUTE FUNCTION public.validate_policy_grant_insert();

CREATE TABLE public.authorization_decisions (
  workspace_id public.product_identifier NOT NULL,
  authorization_decision_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  policy_revision_id public.product_identifier NOT NULL,
  actor_principal_id public.product_identifier NOT NULL,
  actor_principal_kind text COLLATE "C" NOT NULL,
  actor_scope_grant_id public.product_identifier NOT NULL,
  actor_access_kind text COLLATE "C" GENERATED ALWAYS AS ('operation') STORED,
  effective_principal_id public.product_identifier NOT NULL,
  effective_principal_kind text COLLATE "C" NOT NULL,
  effective_scope_grant_id public.product_identifier NOT NULL,
  effective_access_kind text COLLATE "C" GENERATED ALWAYS AS ('operation') STORED,
  authorization_source text COLLATE "C" NOT NULL,
  authorizer_principal_id public.product_identifier,
  authorizer_principal_kind text COLLATE "C",
  authorizer_scope_grant_id public.product_identifier,
  authorizer_access_kind text COLLATE "C"
    GENERATED ALWAYS AS (
      CASE WHEN authorization_source = 'principal' THEN 'operation' END
    ) STORED,
  policy_grant_id public.product_identifier,
  action_id public.product_identifier NOT NULL,
  effect_class text COLLATE "C" NOT NULL,
  argument_digest text COLLATE "C" NOT NULL,
  target_contract jsonb,
  target_contract_key jsonb GENERATED ALWAYS AS (
    coalesce(target_contract, 'null'::jsonb)
  ) STORED,
  permission_mode text COLLATE "C" NOT NULL,
  auto_approved_effect_classes text[] NOT NULL DEFAULT ARRAY[]::text[],
  auto_approved_action_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  destructive_status text COLLATE "C" NOT NULL DEFAULT 'clear',
  destructive_rule_version public.product_identifier NOT NULL,
  disposition text COLLATE "C" NOT NULL,
  approval_id public.product_identifier,
  approval_reference_disposition text COLLATE "C"
    GENERATED ALWAYS AS (
      CASE WHEN approval_id IS NOT NULL THEN 'approval_required' END
    ) STORED,
  reason_code text COLLATE "C" NOT NULL,
  decided_at timestamptz NOT NULL,
  expires_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, authorization_decision_id),
  CONSTRAINT authorization_decisions_policy_fk
    FOREIGN KEY (workspace_id, scope_id, policy_revision_id)
    REFERENCES public.scope_policy_revisions (workspace_id, scope_id, policy_revision_id),
  CONSTRAINT authorization_decisions_actor_scope_fk
    FOREIGN KEY (
      workspace_id, scope_id, actor_scope_grant_id,
      actor_principal_id, actor_principal_kind, actor_access_kind
    ) REFERENCES public.scope_principal_grants (
      workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind
    ),
  CONSTRAINT authorization_decisions_effective_scope_fk
    FOREIGN KEY (
      workspace_id, scope_id, effective_scope_grant_id,
      effective_principal_id, effective_principal_kind, effective_access_kind
    ) REFERENCES public.scope_principal_grants (
      workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind
    ),
  CONSTRAINT authorization_decisions_authorizer_scope_fk
    FOREIGN KEY (
      workspace_id, scope_id, authorizer_scope_grant_id,
      authorizer_principal_id, authorizer_principal_kind, authorizer_access_kind
    ) REFERENCES public.scope_principal_grants (
      workspace_id, scope_id, grant_id, principal_id, principal_kind, access_kind
    ),
  CONSTRAINT authorization_decisions_policy_grant_fk
    FOREIGN KEY (
      workspace_id, scope_id, policy_grant_id,
      effective_principal_id, effective_principal_kind, policy_revision_id
    ) REFERENCES public.policy_grants (
      workspace_id, scope_id, policy_grant_id,
      subject_principal_id, subject_principal_kind, policy_revision_id
    ),
  CONSTRAINT authorization_decisions_authority_uq UNIQUE (
    workspace_id, authorization_decision_id, scope_id, policy_revision_id,
    actor_principal_id, actor_principal_kind,
    effective_principal_id, effective_principal_kind,
    action_id, effect_class, argument_digest, target_contract_key, disposition
  ),
  CONSTRAINT authorization_decisions_approval_reference_fk
    FOREIGN KEY (
      workspace_id, approval_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind,
      action_id, effect_class, argument_digest, target_contract_key,
      approval_reference_disposition
    ) REFERENCES public.authorization_decisions (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind,
      action_id, effect_class, argument_digest, target_contract_key, disposition
    ) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT authorization_decisions_actor_access CHECK (actor_access_kind = 'operation'),
  CONSTRAINT authorization_decisions_effective_access CHECK (effective_access_kind = 'operation'),
  CONSTRAINT authorization_decisions_authorizer_access CHECK (
    authorizer_access_kind IS NULL OR authorizer_access_kind = 'operation'
  ),
  CONSTRAINT authorization_decisions_source_shape CHECK (
    (authorization_source = 'principal'
      AND authorizer_principal_id IS NOT NULL
      AND authorizer_principal_kind IS NOT NULL
      AND authorizer_scope_grant_id IS NOT NULL
      AND authorizer_access_kind = 'operation'
      AND (
        (disposition = 'authorized' AND approval_id IS NOT NULL)
        OR (
          authorizer_principal_id = effective_principal_id
          AND authorizer_principal_kind = effective_principal_kind
          AND authorizer_scope_grant_id = effective_scope_grant_id
        )
      )
      AND policy_grant_id IS NULL)
    OR (authorization_source = 'policy_grant'
      AND authorizer_principal_id IS NULL
      AND authorizer_principal_kind IS NULL
      AND authorizer_scope_grant_id IS NULL
      AND authorizer_access_kind IS NULL
      AND policy_grant_id IS NOT NULL
      AND approval_id IS NULL)
  ),
  CONSTRAINT authorization_decisions_effect_class CHECK (
    effect_class IN ('read', 'write_local', 'execute', 'external_write', 'administrative')
  ),
  CONSTRAINT authorization_decisions_argument_digest_format
    CHECK (argument_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT authorization_decisions_target_contract_shape CHECK (
    (action_id IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue'
      )
      AND target_contract IS NOT NULL
      AND jsonb_typeof(target_contract) = 'object')
    OR (action_id NOT IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue'
      ) AND target_contract IS NULL)
  ),
  CONSTRAINT authorization_decisions_permission_mode CHECK (
    permission_mode IN ('discuss', 'plan', 'interactive', 'auto', 'custom')
  ),
  CONSTRAINT authorization_decisions_effect_classes_closed CHECK (
    auto_approved_effect_classes <@ ARRAY[
      'read', 'write_local', 'execute', 'external_write', 'administrative'
    ]::text[]
    AND array_position(auto_approved_effect_classes, NULL) IS NULL
    AND cardinality(auto_approved_effect_classes) <= 5
  ),
  CONSTRAINT authorization_decisions_action_ids_bounded CHECK (
    array_position(auto_approved_action_ids, NULL) IS NULL
    AND cardinality(auto_approved_action_ids) <= 128
  ),
  CONSTRAINT authorization_decisions_destructive_status CHECK (
    destructive_status IN ('clear', 'hard_denied')
  ),
  CONSTRAINT authorization_decisions_disposition CHECK (
    disposition IN ('authorized', 'approval_required', 'denied')
  ),
  CONSTRAINT authorization_decisions_approval_shape CHECK (
    (disposition = 'approval_required'
      AND approval_id = authorization_decision_id
      AND expires_at IS NOT NULL)
    OR (disposition = 'authorized')
    OR (disposition = 'denied' AND approval_id IS NULL)
  ),
  CONSTRAINT authorization_decisions_hard_denial CHECK (
    destructive_status <> 'hard_denied' OR disposition = 'denied'
  ),
  CONSTRAINT authorization_decisions_expiry_order CHECK (
    expires_at IS NULL OR expires_at > decided_at
  ),
  CONSTRAINT authorization_decisions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX authorization_decisions_one_final_per_approval_uq
  ON public.authorization_decisions (workspace_id, approval_id)
  WHERE disposition = 'authorized' AND approval_id IS NOT NULL;

CREATE FUNCTION public.reject_immutable_authority_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'immutable_authority_history';
END;
$function$;

CREATE FUNCTION public.validate_authorization_decision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  current_scope public.product_scopes%ROWTYPE;
  current_policy public.scope_policy_revisions%ROWTYPE;
  actor_principal public.workspace_principals%ROWTYPE;
  effective_principal public.workspace_principals%ROWTYPE;
  authorizer_principal public.workspace_principals%ROWTYPE;
  actor_grant public.scope_principal_grants%ROWTYPE;
  effective_grant public.scope_principal_grants%ROWTYPE;
  authorizer_grant public.scope_principal_grants%ROWTYPE;
  approval_request public.authorization_decisions%ROWTYPE;
  authority_now timestamptz := clock_timestamp();
  actor_active boolean;
  effective_active boolean;
  authorizer_active boolean;
  policy_grant_active boolean;
BEGIN
  IF NEW.decided_at > authority_now THEN
    RAISE EXCEPTION 'authorization_decision_from_future';
  END IF;
  IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= authority_now THEN
    RAISE EXCEPTION 'authorization_decision_expired';
  END IF;
  IF NEW.auto_approved_effect_classes IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value
      FROM unnest(NEW.auto_approved_effect_classes) AS value
      ORDER BY value
    )
    OR NEW.auto_approved_action_ids IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value
      FROM unnest(NEW.auto_approved_action_ids) AS value
      ORDER BY value
    ) THEN
    RAISE EXCEPTION 'authorization_policy_arrays_not_canonical';
  END IF;

  SELECT * INTO current_scope
  FROM public.product_scopes
  WHERE workspace_id = NEW.workspace_id AND scope_id = NEW.scope_id
  FOR SHARE;

  IF current_scope.status <> 'active'
    OR current_scope.current_policy_revision_id <> NEW.policy_revision_id THEN
    RAISE EXCEPTION 'authorization_scope_or_policy_not_current';
  END IF;

  SELECT * INTO current_policy
  FROM public.scope_policy_revisions
  WHERE workspace_id = NEW.workspace_id
    AND scope_id = NEW.scope_id
    AND policy_revision_id = NEW.policy_revision_id
  FOR SHARE;

  IF current_policy.permission_mode <> NEW.permission_mode
    OR current_policy.auto_approved_effect_classes <> NEW.auto_approved_effect_classes
    OR current_policy.auto_approved_action_ids <> NEW.auto_approved_action_ids THEN
    RAISE EXCEPTION 'authorization_policy_snapshot_mismatch';
  END IF;

  SELECT * INTO actor_principal
  FROM public.workspace_principals
  WHERE workspace_id = NEW.workspace_id
    AND principal_id = NEW.actor_principal_id
    AND principal_kind = NEW.actor_principal_kind
  FOR SHARE;
  actor_active := actor_principal.status = 'active';
  IF actor_principal.principal_kind = 'user' THEN
    SELECT actor_active AND status = 'active' INTO actor_active
    FROM public.workspace_memberships
    WHERE workspace_id = actor_principal.workspace_id
      AND user_id = actor_principal.user_id
      AND membership_id = actor_principal.membership_id
    FOR SHARE;
  END IF;

  SELECT * INTO effective_principal
  FROM public.workspace_principals
  WHERE workspace_id = NEW.workspace_id
    AND principal_id = NEW.effective_principal_id
    AND principal_kind = NEW.effective_principal_kind
  FOR SHARE;
  effective_active := effective_principal.status = 'active';
  IF effective_principal.principal_kind = 'user' THEN
    SELECT effective_active AND status = 'active' INTO effective_active
    FROM public.workspace_memberships
    WHERE workspace_id = effective_principal.workspace_id
      AND user_id = effective_principal.user_id
      AND membership_id = effective_principal.membership_id
    FOR SHARE;
  END IF;

  SELECT * INTO actor_grant
  FROM public.scope_principal_grants
  WHERE workspace_id = NEW.workspace_id AND scope_id = NEW.scope_id
    AND grant_id = NEW.actor_scope_grant_id
  FOR SHARE;
  SELECT * INTO effective_grant
  FROM public.scope_principal_grants
  WHERE workspace_id = NEW.workspace_id AND scope_id = NEW.scope_id
    AND grant_id = NEW.effective_scope_grant_id
  FOR SHARE;

  IF actor_active IS DISTINCT FROM true
    OR effective_active IS DISTINCT FROM true
    OR actor_grant.status IS DISTINCT FROM 'active'
    OR effective_grant.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'authorization_principal_or_scope_grant_inactive';
  END IF;

  IF NEW.authorization_source = 'principal'
    AND NEW.disposition = 'authorized'
    AND NEW.approval_id IS NOT NULL THEN
    SELECT * INTO approval_request
    FROM public.authorization_decisions
    WHERE workspace_id = NEW.workspace_id
      AND authorization_decision_id = NEW.approval_id
    FOR SHARE;
    IF approval_request.disposition IS DISTINCT FROM 'approval_required'
      OR approval_request.scope_id IS DISTINCT FROM NEW.scope_id
      OR approval_request.policy_revision_id IS DISTINCT FROM NEW.policy_revision_id
      OR approval_request.actor_principal_id IS DISTINCT FROM NEW.actor_principal_id
      OR approval_request.actor_principal_kind IS DISTINCT FROM NEW.actor_principal_kind
      OR approval_request.effective_principal_id IS DISTINCT FROM NEW.effective_principal_id
      OR approval_request.effective_principal_kind IS DISTINCT FROM NEW.effective_principal_kind
      OR approval_request.action_id IS DISTINCT FROM NEW.action_id
      OR approval_request.effect_class IS DISTINCT FROM NEW.effect_class
      OR approval_request.argument_digest IS DISTINCT FROM NEW.argument_digest
      OR approval_request.target_contract IS DISTINCT FROM NEW.target_contract
      OR approval_request.expires_at IS NULL
      OR approval_request.expires_at <= authority_now THEN
      RAISE EXCEPTION 'authorization_approval_request_invalid';
    END IF;

    SELECT * INTO authorizer_principal
    FROM public.workspace_principals
    WHERE workspace_id = NEW.workspace_id
      AND principal_id = NEW.authorizer_principal_id
      AND principal_kind = NEW.authorizer_principal_kind
    FOR SHARE;
    authorizer_active := authorizer_principal.status = 'active';
    IF authorizer_principal.principal_kind = 'user' THEN
      SELECT authorizer_active AND status = 'active' INTO authorizer_active
      FROM public.workspace_memberships
      WHERE workspace_id = authorizer_principal.workspace_id
        AND user_id = authorizer_principal.user_id
        AND membership_id = authorizer_principal.membership_id
      FOR SHARE;
    END IF;
    SELECT * INTO authorizer_grant
    FROM public.scope_principal_grants
    WHERE workspace_id = NEW.workspace_id
      AND scope_id = NEW.scope_id
      AND grant_id = NEW.authorizer_scope_grant_id
    FOR SHARE;
    IF authorizer_active IS DISTINCT FROM true
      OR authorizer_grant.status IS DISTINCT FROM 'active'
      OR authorizer_grant.can_approve IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'authorization_approver_inactive_or_forbidden';
    END IF;
  END IF;

  IF NEW.authorization_source = 'policy_grant' THEN
    SELECT status = 'active' AND expires_at > authority_now
    INTO policy_grant_active
    FROM public.policy_grants
    WHERE workspace_id = NEW.workspace_id
      AND scope_id = NEW.scope_id
      AND policy_grant_id = NEW.policy_grant_id
    FOR SHARE;
    IF policy_grant_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'authorization_policy_grant_inactive';
    END IF;
  END IF;

  IF NEW.disposition = 'authorized' THEN
    IF NEW.permission_mode IN ('discuss', 'plan') AND NEW.effect_class <> 'read' THEN
      RAISE EXCEPTION 'authorization_read_only_mode';
    ELSIF NEW.permission_mode = 'interactive'
      AND NEW.effect_class <> 'read'
      AND NEW.approval_id IS NULL THEN
      RAISE EXCEPTION 'authorization_interactive_approval_required';
    ELSIF NEW.permission_mode = 'auto' AND (
      NEW.authorization_source <> 'policy_grant'
      OR NEW.effect_class = 'administrative'
      OR NOT (NEW.effect_class = ANY(NEW.auto_approved_effect_classes))
    ) THEN
      RAISE EXCEPTION 'authorization_auto_policy_mismatch';
    ELSIF NEW.permission_mode = 'custom' AND (
      NEW.authorization_source <> 'policy_grant'
      OR NEW.effect_class = 'administrative'
      OR NOT (NEW.action_id = ANY(NEW.auto_approved_action_ids))
    ) THEN
      RAISE EXCEPTION 'authorization_custom_policy_mismatch';
    END IF;
  ELSIF NEW.disposition = 'approval_required'
    AND NEW.permission_mode IN ('discuss', 'plan') THEN
    RAISE EXCEPTION 'authorization_read_only_mode_cannot_request_approval';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER scope_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON public.scope_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

CREATE TRIGGER authorization_decisions_validate
  BEFORE INSERT ON public.authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION public.validate_authorization_decision_insert();

CREATE TRIGGER authorization_decisions_immutable
  BEFORE UPDATE OR DELETE ON public.authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

CREATE TABLE public.object_access_grants (
  workspace_id public.product_identifier NOT NULL,
  grant_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL,
  object_id public.product_identifier NOT NULL,
  principal_id public.product_identifier NOT NULL,
  principal_kind text COLLATE "C" NOT NULL,
  role text COLLATE "C" NOT NULL,
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  product_command_id public.product_identifier NOT NULL,
  issuance_command_kind text COLLATE "C"
    GENERATED ALWAYS AS ('object_access_grant_issue') STORED,
  issuance_target_kind text COLLATE "C"
    GENERATED ALWAYS AS ('object_access_grant') STORED,
  issuance_target_revision integer GENERATED ALWAYS AS (1) STORED,
  status text COLLATE "C" NOT NULL DEFAULT 'active',
  revision integer NOT NULL DEFAULT 1,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, grant_id),
  CONSTRAINT object_access_grants_scope_fk
    FOREIGN KEY (workspace_id, scope_id) REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT object_access_grants_principal_fk
    FOREIGN KEY (workspace_id, principal_id, principal_kind)
    REFERENCES public.workspace_principals (workspace_id, principal_id, principal_kind),
  CONSTRAINT object_access_grants_object_kind CHECK (
    object_kind IN ('skill', 'skill_draft', 'workflow')
  ),
  CONSTRAINT object_access_grants_role CHECK (role IN ('owner', 'maintainer', 'editor', 'reviewer', 'viewer')),
  CONSTRAINT object_access_grants_capabilities_closed CHECK (
    capabilities <@ ARRAY[
      'object.execute', 'object.publish', 'object.delete', 'object.share', 'object.manage_access'
    ]::text[]
    AND array_position(capabilities, NULL) IS NULL
    AND cardinality(capabilities) <= 5
  ),
  CONSTRAINT object_access_grants_status CHECK (status IN ('active', 'revoked')),
  CONSTRAINT object_access_grants_revision_positive CHECK (revision >= 1),
  CONSTRAINT object_access_grants_revocation_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT object_access_grants_time_order CHECK (updated_at >= created_at),
  CONSTRAINT object_access_grants_revoke_time CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT object_access_grants_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX object_access_grants_active_principal_uq
  ON public.object_access_grants (
    workspace_id, scope_id, object_kind, object_id, principal_kind, principal_id
  ) WHERE status = 'active';
CREATE INDEX object_access_grants_principal_active_idx
  ON public.object_access_grants (
    workspace_id, scope_id, principal_kind, principal_id, status, updated_at DESC
  );
CREATE UNIQUE INDEX object_access_grants_one_issuance_command_uq
  ON public.object_access_grants (workspace_id, product_command_id);

CREATE FUNCTION public.validate_object_access_grant_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  command_current boolean;
  subject_active boolean;
  subject_principal public.workspace_principals%ROWTYPE;
  derived_scope_id public.product_identifier;
BEGIN
  IF NEW.status <> 'active' THEN
    RAISE EXCEPTION 'object_access_grant_initial_status_invalid';
  END IF;
  IF NEW.capabilities IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value FROM unnest(NEW.capabilities) AS value ORDER BY value
    ) THEN
    RAISE EXCEPTION 'object_access_grant_capabilities_not_canonical';
  END IF;

  SELECT * INTO subject_principal
  FROM public.workspace_principals p
  WHERE p.workspace_id = NEW.workspace_id
    AND p.principal_id = NEW.principal_id
    AND p.principal_kind = NEW.principal_kind
  FOR SHARE;
  subject_active := subject_principal.status = 'active';
  IF subject_principal.principal_kind = 'user' THEN
    SELECT subject_active AND m.status = 'active'
    INTO subject_active
    FROM public.workspace_memberships m
    WHERE m.workspace_id = subject_principal.workspace_id
      AND m.user_id = subject_principal.user_id
      AND m.membership_id = subject_principal.membership_id
    FOR SHARE;
  END IF;
  IF subject_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'object_access_grant_subject_inactive';
  END IF;

  IF NEW.object_kind = 'skill' THEN
    SELECT scope_id INTO derived_scope_id
    FROM public.skill_assets
    WHERE workspace_id = NEW.workspace_id AND skill_id = NEW.object_id
    FOR KEY SHARE;
  ELSIF NEW.object_kind = 'skill_draft' THEN
    SELECT a.scope_id INTO derived_scope_id
    FROM public.skill_drafts d
    JOIN public.skill_assets a
      ON a.workspace_id = d.workspace_id AND a.skill_id = d.skill_id
    WHERE d.workspace_id = NEW.workspace_id AND d.skill_draft_id = NEW.object_id
    FOR KEY SHARE OF a;
  ELSIF NEW.object_kind = 'workflow' THEN
    SELECT scope_id INTO derived_scope_id
    FROM public.workflows
    WHERE workspace_id = NEW.workspace_id AND workflow_id = NEW.object_id
    FOR KEY SHARE;
  END IF;

  IF derived_scope_id IS NULL OR derived_scope_id <> NEW.scope_id THEN
    RAISE EXCEPTION 'object_access_grant_object_scope_mismatch';
  END IF;

  SELECT c.status = 'completed' AND c.created_at <= NEW.created_at
  INTO command_current
  FROM public.product_commands c
  WHERE c.workspace_id = NEW.workspace_id
    AND c.command_id = NEW.product_command_id
    AND c.scope_id = NEW.scope_id
    AND c.kind = 'object_access_grant_issue'
    AND c.target_kind = 'object_access_grant'
    AND c.target_id = NEW.grant_id
    AND c.target_revision = 1
  FOR SHARE;

  IF command_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'object_access_grant_command_inactive';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_object_access_grant_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'object_access_grant_terminal';
  END IF;
  IF ROW(NEW.workspace_id, NEW.grant_id, NEW.scope_id, NEW.object_kind, NEW.object_id,
         NEW.principal_id, NEW.principal_kind, NEW.role, NEW.capabilities,
         NEW.product_command_id, NEW.created_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.workspace_id, OLD.grant_id, OLD.scope_id, OLD.object_kind, OLD.object_id,
         OLD.principal_id, OLD.principal_kind, OLD.role, OLD.capabilities,
         OLD.product_command_id, OLD.created_at, OLD.payload) THEN
    RAISE EXCEPTION 'object_access_grant_identity_immutable';
  END IF;
  IF ROW(NEW.status, NEW.revoked_at) IS DISTINCT FROM ROW(OLD.status, OLD.revoked_at)
    AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'object_access_grant_revision_required';
  END IF;
  IF NEW.revision < OLD.revision OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'object_access_grant_revision_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER object_access_grants_validate
  BEFORE INSERT ON public.object_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.validate_object_access_grant_insert();

CREATE TRIGGER object_access_grants_revision_guard
  BEFORE UPDATE OR DELETE ON public.object_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_object_access_grant_revision();

CREATE FUNCTION public.revoke_membership_authority_epoch()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  transition_time timestamptz := clock_timestamp();
BEGIN
  IF ROW(NEW.role, NEW.status) IS DISTINCT FROM ROW(OLD.role, OLD.status) THEN
    UPDATE public.scope_principal_grants
    SET status = 'revoked',
        revision = revision + 1,
        revoked_at = transition_time,
        updated_at = GREATEST(updated_at, transition_time)
    WHERE workspace_id = NEW.workspace_id
      AND principal_id = NEW.user_id
      AND principal_kind = 'user'
      AND status = 'active';

    UPDATE public.object_access_grants
    SET status = 'revoked',
        revision = revision + 1,
        revoked_at = transition_time,
        updated_at = GREATEST(updated_at, transition_time)
    WHERE workspace_id = NEW.workspace_id
      AND principal_id = NEW.user_id
      AND principal_kind = 'user'
      AND status = 'active';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_memberships_revoke_authority_epoch
  AFTER UPDATE OF role, status ON public.workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION public.revoke_membership_authority_epoch();

CREATE TABLE public.product_commands (
  command_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  actor_principal_id public.product_identifier NOT NULL,
  actor_principal_kind text COLLATE "C" NOT NULL,
  effective_principal_id public.product_identifier NOT NULL,
  effective_principal_kind text COLLATE "C" NOT NULL,
  authorization_decision_id public.product_identifier NOT NULL,
  policy_revision_id public.product_identifier NOT NULL,
  effect_class text COLLATE "C" NOT NULL,
  argument_digest text COLLATE "C" NOT NULL,
  target_contract jsonb,
  target_contract_key jsonb GENERATED ALWAYS AS (
    coalesce(target_contract, 'null'::jsonb)
  ) STORED,
  authorization_disposition text COLLATE "C"
    GENERATED ALWAYS AS ('authorized') STORED,
  quota_user_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL,
  session_id public.product_identifier,
  turn_id public.product_identifier,
  session_lineage_key text COLLATE "C"
    GENERATED ALWAYS AS (coalesce(session_id, '@none')) STORED,
  turn_lineage_key text COLLATE "C"
    GENERATED ALWAYS AS (coalesce(turn_id, '@none')) STORED,
  target_command_id public.product_identifier,
  target_command_kind text COLLATE "C" GENERATED ALWAYS AS (
    CASE kind
      WHEN 'cancel_agent_turn' THEN 'agent_turn'
      WHEN 'cancel_skill_creation_turn' THEN 'skill_creation_turn'
      WHEN 'finish_skill_creation_realtime_call' THEN 'skill_creation_realtime_call'
      WHEN 'cancel_skill_creation_realtime_call' THEN 'skill_creation_realtime_call'
      WHEN 'cancel_skill_test' THEN 'skill_test'
    END
  ) STORED,
  target_kind text COLLATE "C",
  target_id public.product_identifier,
  target_revision integer,
  invocation_id public.product_identifier,
  attempt_id public.product_identifier,
  status text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  finished_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT product_commands_quota_user_fk
    FOREIGN KEY (workspace_id, quota_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT product_commands_decision_fk
    FOREIGN KEY (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind,
      kind, effect_class, argument_digest, target_contract_key,
      authorization_disposition
    ) REFERENCES public.authorization_decisions (
      workspace_id, authorization_decision_id, scope_id, policy_revision_id,
      actor_principal_id, actor_principal_kind,
      effective_principal_id, effective_principal_kind,
      action_id, effect_class, argument_digest, target_contract_key, disposition
    ),
  CONSTRAINT product_commands_lineage_uq UNIQUE (command_id, session_id, turn_id),
  CONSTRAINT product_commands_tenant_identity_uq UNIQUE (workspace_id, quota_user_id, command_id),
  CONSTRAINT product_commands_workspace_identity_uq UNIQUE (workspace_id, command_id),
  CONSTRAINT product_commands_decision_consumption_uq
    UNIQUE (workspace_id, authorization_decision_id),
  CONSTRAINT product_commands_issuance_authority_uq UNIQUE (
    workspace_id, command_id, scope_id,
    effective_principal_id, effective_principal_kind,
    authorization_decision_id, kind, effect_class, argument_digest,
    authorization_disposition, target_kind, target_id, target_revision
  ),
  CONSTRAINT product_commands_scope_creation_authority_uq UNIQUE (
    workspace_id, command_id, scope_id,
    effective_principal_id, effective_principal_kind,
    target_kind, target_id, target_revision
  ),
  CONSTRAINT product_commands_builder_authority_uq UNIQUE (
    workspace_id, command_id, scope_id,
    effective_principal_id, effective_principal_kind, kind
  ),
  CONSTRAINT product_commands_execution_lineage_uq UNIQUE (
    workspace_id, command_id, session_lineage_key, turn_lineage_key
  ),
  CONSTRAINT product_commands_tenant_lineage_uq
    UNIQUE (workspace_id, quota_user_id, command_id, session_id, turn_id),
  CONSTRAINT product_commands_target_authority_uq UNIQUE (
    workspace_id, command_id, scope_id, kind,
    session_lineage_key, turn_lineage_key
  ),
  CONSTRAINT product_commands_special_target_authority_uq UNIQUE (
    workspace_id, command_id, scope_id, kind,
    target_kind, target_id, target_revision
  ),
  CONSTRAINT product_commands_target_fk
    FOREIGN KEY (
      workspace_id, target_command_id, scope_id, target_command_kind,
      session_lineage_key, turn_lineage_key
    ) REFERENCES public.product_commands (
      workspace_id, command_id, scope_id, kind,
      session_lineage_key, turn_lineage_key
    ),
  CONSTRAINT product_commands_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT product_commands_kind CHECK (kind IN (
    'agent_turn', 'cancel_agent_turn',
    'skill_creation_turn', 'cancel_skill_creation_turn',
    'skill_creation_realtime_call', 'finish_skill_creation_realtime_call',
    'cancel_skill_creation_realtime_call', 'builder_proposal',
    'skill_test', 'cancel_skill_test', 'skill_validation',
    'workflow_run', 'workflow_run_cancel', 'workflow_run_review',
    'workflow_run_step',
    'scope_create', 'scope_principal_grant_issue',
    'policy_grant_issue', 'object_access_grant_issue'
  )),
  CONSTRAINT product_commands_target_shape CHECK (
    (kind IN (
      'cancel_agent_turn', 'cancel_skill_creation_turn',
      'finish_skill_creation_realtime_call', 'cancel_skill_creation_realtime_call',
      'cancel_skill_test'
    )) = (target_command_id IS NOT NULL)
  ),
  CONSTRAINT product_commands_session_turn_shape CHECK (
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
      'policy_grant_issue', 'object_access_grant_issue'
    )
      AND session_id IS NULL AND turn_id IS NULL)
    OR (kind IN ('builder_proposal', 'skill_test', 'cancel_skill_test', 'skill_validation')
      AND ((session_id IS NULL AND turn_id IS NULL)
        OR (session_id IS NOT NULL AND turn_id IS NOT NULL)))
  ),
  CONSTRAINT product_commands_status CHECK (status IN (
    'accepted', 'running', 'cancellation_requested',
    'completed', 'failed', 'cancelled', 'blocked'
  )),
  CONSTRAINT product_commands_argument_digest_format CHECK (
    argument_digest ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT product_commands_target_contract_shape CHECK (
    (kind IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue'
      )
      AND target_contract IS NOT NULL
      AND jsonb_typeof(target_contract) = 'object')
    OR (kind NOT IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue'
      ) AND target_contract IS NULL)
  ),
  CONSTRAINT product_commands_effect_class CHECK (
    effect_class IN ('read', 'write_local', 'execute', 'external_write', 'administrative')
  ),
  CONSTRAINT product_commands_special_target_shape CHECK (
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
    OR (kind NOT IN (
        'scope_create', 'scope_principal_grant_issue',
        'policy_grant_issue', 'object_access_grant_issue',
        'workflow_run', 'workflow_run_cancel', 'workflow_run_review'
      )
      AND target_kind IS NULL
      AND target_id IS NULL
      AND target_revision IS NULL)
  ),
  CONSTRAINT product_commands_special_completed CHECK (
    kind NOT IN (
      'scope_create', 'scope_principal_grant_issue',
      'policy_grant_issue', 'object_access_grant_issue',
      'workflow_run_cancel', 'workflow_run_review'
    ) OR status = 'completed'
  ),
  CONSTRAINT product_commands_not_self_target CHECK (
    target_command_id IS NULL OR target_command_id <> command_id
  ),
  CONSTRAINT product_commands_time_order CHECK (updated_at >= created_at),
  CONSTRAINT product_commands_finished_state CHECK (
    (status IN ('completed', 'failed', 'cancelled', 'blocked')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT product_commands_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX product_commands_session_turn_kind_uq
  ON public.product_commands (workspace_id, session_id, turn_id, kind)
  WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX product_commands_special_target_consumption_uq
  ON public.product_commands (
    workspace_id, target_kind, target_id, target_revision
  ) WHERE target_kind IS NOT NULL;
CREATE INDEX product_commands_recovery_idx
  ON public.product_commands (workspace_id, quota_user_id, status, updated_at, command_id);

ALTER TABLE public.scope_principal_grants
  ADD CONSTRAINT scope_principal_grants_issuance_command_fk
  FOREIGN KEY (
    workspace_id, issuance_command_id, issuance_authority_scope_id,
    granted_by_principal_id, granted_by_principal_kind,
    issuance_authorization_decision_id, issuance_command_kind,
    issuance_effect_class, issuance_argument_digest, issuance_disposition,
    issuance_target_kind, issuance_target_id, issuance_target_revision
  ) REFERENCES public.product_commands (
    workspace_id, command_id, scope_id,
    effective_principal_id, effective_principal_kind,
    authorization_decision_id, kind,
    effect_class, argument_digest, authorization_disposition,
    target_kind, target_id, target_revision
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.policy_grants
  ADD CONSTRAINT policy_grants_issuance_command_fk
  FOREIGN KEY (
    workspace_id, issuance_command_id, scope_id,
    authorized_by_principal_id, authorized_by_principal_kind,
    issuance_authorization_decision_id, issuance_command_kind,
    issuance_effect_class, issuance_argument_digest, issuance_disposition,
    issuance_target_kind, policy_grant_id, issuance_target_revision
  ) REFERENCES public.product_commands (
    workspace_id, command_id, scope_id,
    effective_principal_id, effective_principal_kind,
    authorization_decision_id, kind,
    effect_class, argument_digest, authorization_disposition,
    target_kind, target_id, target_revision
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.product_scopes
  ADD CONSTRAINT product_scopes_creation_command_fk
  FOREIGN KEY (
    workspace_id, creation_command_id, creation_authority_scope_id,
    created_by_principal_id, created_by_principal_kind,
    creation_target_kind, scope_id, creation_target_revision
  ) REFERENCES public.product_commands (
    workspace_id, command_id, scope_id,
    effective_principal_id, effective_principal_kind,
    target_kind, target_id, target_revision
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.object_access_grants
  ADD CONSTRAINT object_access_grants_issuance_command_fk
  FOREIGN KEY (
    workspace_id, product_command_id, scope_id, issuance_command_kind,
    issuance_target_kind, grant_id, issuance_target_revision
  ) REFERENCES public.product_commands (
    workspace_id, command_id, scope_id, kind,
    target_kind, target_id, target_revision
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public.validate_product_command_authority_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  authority_current boolean;
  authority_now timestamptz := clock_timestamp();
BEGIN
  IF NEW.created_at > authority_now THEN
    RAISE EXCEPTION 'product_command_from_future';
  END IF;

  -- Lock every mutable authority row before evaluating it. A concurrent revoke,
  -- suspension or policy-pointer change must serialize before command acceptance.
  PERFORM 1 FROM public.product_scopes
  WHERE workspace_id = NEW.workspace_id AND scope_id = NEW.scope_id
  FOR SHARE;
  PERFORM 1 FROM public.workspace_principals p
  JOIN public.authorization_decisions d ON d.workspace_id = p.workspace_id
  WHERE d.workspace_id = NEW.workspace_id
    AND d.authorization_decision_id = NEW.authorization_decision_id
    AND (p.principal_id, p.principal_kind) IN (
      (d.actor_principal_id, d.actor_principal_kind),
      (d.effective_principal_id, d.effective_principal_kind),
      (d.authorizer_principal_id, d.authorizer_principal_kind)
    )
  ORDER BY p.principal_id, p.principal_kind
  FOR SHARE OF p;
  PERFORM 1 FROM public.scope_principal_grants g
  JOIN public.authorization_decisions d
    ON d.workspace_id = g.workspace_id
  WHERE d.workspace_id = NEW.workspace_id
    AND d.authorization_decision_id = NEW.authorization_decision_id
    AND g.grant_id IN (
      d.actor_scope_grant_id, d.effective_scope_grant_id, d.authorizer_scope_grant_id
    )
  ORDER BY g.grant_id
  FOR SHARE OF g;
  PERFORM 1 FROM public.workspace_memberships m
  WHERE m.workspace_id = NEW.workspace_id
    AND (
      m.user_id = NEW.quota_user_id
      OR EXISTS (
        SELECT 1 FROM public.workspace_principals p
        WHERE p.workspace_id = m.workspace_id
          AND p.user_id = m.user_id
          AND p.membership_id = m.membership_id
          AND EXISTS (
            SELECT 1 FROM public.authorization_decisions d
            WHERE d.workspace_id = NEW.workspace_id
              AND d.authorization_decision_id = NEW.authorization_decision_id
              AND (p.principal_id, p.principal_kind) IN (
                (d.actor_principal_id, d.actor_principal_kind),
                (d.effective_principal_id, d.effective_principal_kind),
                (d.authorizer_principal_id, d.authorizer_principal_kind)
              )
          )
      )
    )
  ORDER BY m.user_id
  FOR SHARE;
  PERFORM 1 FROM public.policy_grants pg
  JOIN public.authorization_decisions d
    ON d.workspace_id = pg.workspace_id AND d.policy_grant_id = pg.policy_grant_id
  WHERE d.workspace_id = NEW.workspace_id
    AND d.authorization_decision_id = NEW.authorization_decision_id
  FOR SHARE OF pg;

  SELECT d.disposition = 'authorized'
    AND s.status = 'active'
    AND s.current_policy_revision_id = d.policy_revision_id
    AND d.decided_at <= NEW.created_at
    AND (d.expires_at IS NULL OR d.expires_at > authority_now)
    AND ap.status = 'active'
    AND ep.status = 'active'
    AND ag.status = 'active'
    AND eg.status = 'active'
    AND (ap.principal_kind <> 'user' OR am.status = 'active')
    AND (ep.principal_kind <> 'user' OR em.status = 'active')
    AND qm.status = 'active'
    AND (
      d.authorization_source <> 'principal'
      OR (
        hp.status = 'active'
        AND hg.status = 'active'
        AND (hp.principal_kind <> 'user' OR hm.status = 'active')
      )
    )
    AND (
      d.authorization_source <> 'policy_grant'
      OR (pg.status = 'active' AND pg.expires_at > authority_now)
    )
  INTO authority_current
  FROM public.authorization_decisions d
  JOIN public.product_scopes s
    ON s.workspace_id = d.workspace_id AND s.scope_id = d.scope_id
  JOIN public.workspace_principals ap
    ON ap.workspace_id = d.workspace_id
   AND ap.principal_id = d.actor_principal_id
   AND ap.principal_kind = d.actor_principal_kind
  JOIN public.workspace_principals ep
    ON ep.workspace_id = d.workspace_id
   AND ep.principal_id = d.effective_principal_id
   AND ep.principal_kind = d.effective_principal_kind
  JOIN public.scope_principal_grants ag
    ON ag.workspace_id = d.workspace_id AND ag.grant_id = d.actor_scope_grant_id
  JOIN public.scope_principal_grants eg
    ON eg.workspace_id = d.workspace_id AND eg.grant_id = d.effective_scope_grant_id
  LEFT JOIN public.workspace_principals hp
    ON hp.workspace_id = d.workspace_id
   AND hp.principal_id = d.authorizer_principal_id
   AND hp.principal_kind = d.authorizer_principal_kind
  LEFT JOIN public.scope_principal_grants hg
    ON hg.workspace_id = d.workspace_id
   AND hg.grant_id = d.authorizer_scope_grant_id
  LEFT JOIN public.workspace_memberships am
    ON am.workspace_id = ap.workspace_id
   AND am.user_id = ap.user_id
   AND am.membership_id = ap.membership_id
  LEFT JOIN public.workspace_memberships em
    ON em.workspace_id = ep.workspace_id
   AND em.user_id = ep.user_id
   AND em.membership_id = ep.membership_id
  LEFT JOIN public.workspace_memberships hm
    ON hm.workspace_id = hp.workspace_id
   AND hm.user_id = hp.user_id
   AND hm.membership_id = hp.membership_id
  JOIN public.workspace_memberships qm
    ON qm.workspace_id = NEW.workspace_id AND qm.user_id = NEW.quota_user_id
  LEFT JOIN public.policy_grants pg
    ON pg.workspace_id = d.workspace_id AND pg.policy_grant_id = d.policy_grant_id
  WHERE d.workspace_id = NEW.workspace_id
    AND d.authorization_decision_id = NEW.authorization_decision_id
    AND d.action_id = NEW.kind
    AND d.effect_class = NEW.effect_class
    AND d.argument_digest = NEW.argument_digest;

  IF authority_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'product_command_authority_inactive';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_product_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'product_command_immutable';
  END IF;
  IF ROW(NEW.command_id, NEW.workspace_id, NEW.scope_id,
         NEW.actor_principal_id, NEW.actor_principal_kind,
         NEW.effective_principal_id, NEW.effective_principal_kind,
         NEW.authorization_decision_id, NEW.policy_revision_id,
         NEW.effect_class, NEW.argument_digest, NEW.target_contract,
         NEW.quota_user_id,
         NEW.schema_version, NEW.kind, NEW.session_id, NEW.turn_id,
         NEW.target_command_id, NEW.target_kind, NEW.target_id,
         NEW.target_revision, NEW.created_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.command_id, OLD.workspace_id, OLD.scope_id,
         OLD.actor_principal_id, OLD.actor_principal_kind,
         OLD.effective_principal_id, OLD.effective_principal_kind,
         OLD.authorization_decision_id, OLD.policy_revision_id,
         OLD.effect_class, OLD.argument_digest, OLD.target_contract,
         OLD.quota_user_id,
         OLD.schema_version, OLD.kind, OLD.session_id, OLD.turn_id,
         OLD.target_command_id, OLD.target_kind, OLD.target_id,
         OLD.target_revision, OLD.created_at, OLD.payload) THEN
    RAISE EXCEPTION 'product_command_authority_immutable';
  END IF;
  IF OLD.status IN ('completed', 'failed', 'cancelled', 'blocked')
    AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'product_command_terminal';
  END IF;
  IF NOT (CASE OLD.status
    WHEN 'accepted' THEN NEW.status IN (
      'accepted', 'running', 'cancellation_requested',
      'completed', 'failed', 'cancelled', 'blocked'
    )
    WHEN 'running' THEN NEW.status IN (
      'running', 'cancellation_requested',
      'completed', 'failed', 'cancelled', 'blocked'
    )
    WHEN 'cancellation_requested' THEN NEW.status IN (
      'cancellation_requested', 'completed', 'failed', 'cancelled', 'blocked'
    )
    ELSE NEW.status = OLD.status
  END) THEN
    RAISE EXCEPTION 'product_command_invalid_transition';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'product_command_time_regression';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER product_commands_validate_authority
  BEFORE INSERT ON public.product_commands
  FOR EACH ROW EXECUTE FUNCTION public.validate_product_command_authority_insert();

CREATE TRIGGER product_commands_mutation_guard
  BEFORE UPDATE OR DELETE ON public.product_commands
  FOR EACH ROW EXECUTE FUNCTION public.enforce_product_command_mutation();

CREATE FUNCTION public.validate_product_scope_creation_aggregate()
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

CREATE CONSTRAINT TRIGGER product_scopes_creation_aggregate_guard
  AFTER INSERT ON public.product_scopes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_product_scope_creation_aggregate();

CREATE FUNCTION public.validate_product_command_special_target()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_exists boolean;
  actual_contract jsonb;
BEGIN
  IF NEW.kind = 'scope_create' THEN
    SELECT s.creation_mode = 'command'
      AND s.creation_command_id = NEW.command_id
      AND s.creation_authority_scope_id = NEW.scope_id
      AND s.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeKind', s.scope_kind,
        'ownerUserId', s.owner_user_id,
        'ownerPrincipalId', s.owner_principal_id,
        'projectId', s.project_id,
        'creatorPrincipalId', s.created_by_principal_id,
        'creatorPrincipalKind', s.created_by_principal_kind,
        'policy', jsonb_build_object(
          'policyRevisionId', p.policy_revision_id,
          'revision', p.revision,
          'observationTier', p.observation_tier,
          'permissionMode', p.permission_mode,
          'autoApprovedEffectClasses', to_jsonb(p.auto_approved_effect_classes),
          'autoApprovedActionIds', to_jsonb(p.auto_approved_action_ids),
          'contentHash', p.policy_content_hash
        ),
        'initialGrant', jsonb_build_object(
          'grantId', g.grant_id,
          'subjectPrincipalId', g.principal_id,
          'subjectPrincipalKind', g.principal_kind,
          'accessKind', g.access_kind,
          'capabilities', to_jsonb(g.capabilities),
          'canApprove', g.can_approve
        )
      )
    INTO target_exists, actual_contract
    FROM public.product_scopes s
    JOIN public.scope_policy_revisions p
      ON p.workspace_id = s.workspace_id
     AND p.scope_id = s.scope_id
     AND p.policy_revision_id = s.current_policy_revision_id
     AND p.revision = 1
    JOIN public.scope_principal_grants g
      ON g.workspace_id = s.workspace_id
     AND g.scope_id = s.scope_id
     AND g.issuance_kind = 'scope_creation'
    WHERE s.workspace_id = NEW.workspace_id AND s.scope_id = NEW.target_id;
  ELSIF NEW.kind = 'scope_principal_grant_issue' THEN
    SELECT g.issuance_kind IN ('command', 'membership_recovery')
      AND g.issuance_command_id = NEW.command_id
      AND g.issuance_authority_scope_id = NEW.scope_id
      AND g.status = 'active'
      AND g.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeId', g.scope_id,
        'grantId', g.grant_id,
        'subjectPrincipalId', g.principal_id,
        'subjectPrincipalKind', g.principal_kind,
        'accessKind', g.access_kind,
        'capabilities', to_jsonb(g.capabilities),
        'canApprove', g.can_approve,
        'grantorPrincipalId', g.granted_by_principal_id,
        'grantorPrincipalKind', g.granted_by_principal_kind,
        'issuanceKind', g.issuance_kind,
        'status', g.status
      )
    INTO target_exists, actual_contract
    FROM public.scope_principal_grants g
    WHERE g.workspace_id = NEW.workspace_id AND g.grant_id = NEW.target_id;
  ELSIF NEW.kind = 'policy_grant_issue' THEN
    SELECT g.issuance_command_id = NEW.command_id
      AND g.scope_id = NEW.scope_id
      AND g.status = 'active'
      AND g.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeId', g.scope_id,
        'policyGrantId', g.policy_grant_id,
        'subjectPrincipalId', g.subject_principal_id,
        'subjectPrincipalKind', g.subject_principal_kind,
        'subjectScopeGrantId', g.subject_scope_grant_id,
        'policyRevisionId', g.policy_revision_id,
        'authorizerPrincipalId', g.authorized_by_principal_id,
        'authorizerPrincipalKind', g.authorized_by_principal_kind,
        'authorizerScopeGrantId', g.authorizer_scope_grant_id,
        'expiresAt', to_char(
          g.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'reviewAt', CASE WHEN g.review_at IS NULL THEN NULL ELSE to_char(
          g.review_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) END,
        'status', g.status
      )
    INTO target_exists, actual_contract
    FROM public.policy_grants g
    WHERE g.workspace_id = NEW.workspace_id AND g.policy_grant_id = NEW.target_id;
  ELSIF NEW.kind = 'object_access_grant_issue' THEN
    SELECT g.product_command_id = NEW.command_id
      AND g.scope_id = NEW.scope_id
      AND g.status = 'active'
      AND g.revision = NEW.target_revision,
      jsonb_build_object(
        'scopeId', g.scope_id,
        'grantId', g.grant_id,
        'objectKind', g.object_kind,
        'objectId', g.object_id,
        'subjectPrincipalId', g.principal_id,
        'subjectPrincipalKind', g.principal_kind,
        'role', g.role,
        'capabilities', to_jsonb(g.capabilities),
        'status', g.status
      )
    INTO target_exists, actual_contract
    FROM public.object_access_grants g
    WHERE g.workspace_id = NEW.workspace_id AND g.grant_id = NEW.target_id;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.status <> 'completed' OR target_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'product_command_special_target_missing'
      USING ERRCODE = '23503';
  END IF;
  IF actual_contract IS DISTINCT FROM NEW.target_contract THEN
    RAISE EXCEPTION 'product_command_target_contract_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER product_commands_special_target_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_product_command_special_target();

-- G2 B4B Batch A: model, secret and routing authority. A SecretBinding is one
-- immutable concrete store binding; its lifecycle may advance, but its owner,
-- scope and selected store never change.

CREATE TABLE public.secret_bindings (
  workspace_id public.product_identifier NOT NULL,
  secret_binding_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  owner_kind text COLLATE "C" NOT NULL,
  owner_id public.product_identifier NOT NULL,
  secret_source text COLLATE "C" NOT NULL,
  store_binding_ref public.product_identifier NOT NULL,
  store_binding_revision integer NOT NULL,
  credential_fingerprint text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  status_revision integer NOT NULL DEFAULT 1,
  created_by_principal_id public.product_identifier NOT NULL,
  created_by_principal_kind text COLLATE "C" NOT NULL,
  probed_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, secret_binding_id),
  CONSTRAINT secret_bindings_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT secret_bindings_creator_fk
    FOREIGN KEY (workspace_id, created_by_principal_id, created_by_principal_kind)
    REFERENCES public.workspace_principals (workspace_id, principal_id, principal_kind),
  CONSTRAINT secret_bindings_owner_identity_uq
    UNIQUE (workspace_id, secret_binding_id, owner_kind, owner_id, scope_id),
  CONSTRAINT secret_bindings_store_revision_uq
    UNIQUE (workspace_id, secret_source, store_binding_ref, store_binding_revision),
  CONSTRAINT secret_bindings_schema_version
    CHECK (schema_version = 'workbench-secret-binding-v1'),
  CONSTRAINT secret_bindings_owner_kind CHECK (
    owner_kind IN ('connection', 'model_profile_revision')
  ),
  CONSTRAINT secret_bindings_source CHECK (
    secret_source IN ('cloud_secret_store', 'desktop_keychain')
  ),
  CONSTRAINT secret_bindings_store_revision_positive CHECK (store_binding_revision >= 1),
  CONSTRAINT secret_bindings_status_revision_positive CHECK (status_revision >= 1),
  CONSTRAINT secret_bindings_status CHECK (
    status IN ('pending', 'active', 'expired', 'revoked', 'invalid')
  ),
  CONSTRAINT secret_bindings_fingerprint_format CHECK (
    credential_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT secret_bindings_status_shape CHECK (
    (status = 'pending' AND probed_at IS NULL AND revoked_at IS NULL)
    OR (status = 'active'
      AND probed_at IS NOT NULL
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > updated_at))
    OR (status = 'invalid' AND revoked_at IS NULL)
    OR (status = 'expired'
      AND expires_at IS NOT NULL
      AND expires_at <= updated_at
      AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT secret_bindings_time_order CHECK (
    updated_at >= created_at
    AND (probed_at IS NULL OR probed_at >= created_at)
    AND (expires_at IS NULL OR expires_at >= created_at)
    AND (revoked_at IS NULL OR revoked_at >= created_at)
  ),
  CONSTRAINT secret_bindings_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX secret_bindings_model_revision_owner_uq
  ON public.secret_bindings (workspace_id, owner_id)
  WHERE owner_kind = 'model_profile_revision';
CREATE INDEX secret_bindings_owner_status_idx
  ON public.secret_bindings (workspace_id, owner_kind, owner_id, status);

CREATE FUNCTION public.enforce_secret_binding_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'secret_binding_terminal'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'active'
    AND (NEW.probed_at IS NULL OR NEW.probed_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'secret_binding_active_probe_invalid'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'secret_binding_terminal'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
      NEW.workspace_id, NEW.secret_binding_id, NEW.scope_id, NEW.schema_version,
      NEW.owner_kind, NEW.owner_id, NEW.secret_source, NEW.store_binding_ref,
      NEW.store_binding_revision, NEW.credential_fingerprint,
      NEW.created_by_principal_id, NEW.created_by_principal_kind,
      NEW.expires_at, NEW.created_at, NEW.payload
    ) IS DISTINCT FROM ROW(
      OLD.workspace_id, OLD.secret_binding_id, OLD.scope_id, OLD.schema_version,
      OLD.owner_kind, OLD.owner_id, OLD.secret_source, OLD.store_binding_ref,
      OLD.store_binding_revision, OLD.credential_fingerprint,
      OLD.created_by_principal_id, OLD.created_by_principal_kind,
      OLD.expires_at, OLD.created_at, OLD.payload
    ) THEN
    RAISE EXCEPTION 'secret_binding_identity_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.status, NEW.probed_at, NEW.revoked_at)
      IS DISTINCT FROM ROW(OLD.status, OLD.probed_at, OLD.revoked_at)
    AND NEW.status_revision <> OLD.status_revision + 1 THEN
    RAISE EXCEPTION 'secret_binding_status_revision_required'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status_revision < OLD.status_revision
    OR NEW.updated_at < OLD.updated_at
    OR (OLD.probed_at IS NOT NULL AND NEW.probed_at < OLD.probed_at) THEN
    RAISE EXCEPTION 'secret_binding_lifecycle_regression'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('active', 'invalid', 'revoked'))
    OR (OLD.status = 'active' AND NEW.status IN ('expired', 'invalid', 'revoked'))
    OR (OLD.status = 'invalid' AND NEW.status IN ('active', 'revoked'))
    OR (OLD.status = 'expired' AND NEW.status = 'revoked')
  ) THEN
    RAISE EXCEPTION 'secret_binding_lifecycle_transition_forbidden'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER secret_bindings_lifecycle_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.secret_bindings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_secret_binding_lifecycle();

CREATE TABLE public.model_profiles (
  profile_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  profile_scope text COLLATE "C" NOT NULL,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  current_revision_id public.product_identifier NOT NULL,
  current_revision_number integer NOT NULL,
  created_by_principal_id public.product_identifier NOT NULL,
  created_by_principal_kind text COLLATE "C" NOT NULL,
  write_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT model_profiles_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT model_profiles_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT model_profiles_creator_fk
    FOREIGN KEY (workspace_id, created_by_principal_id, created_by_principal_kind)
    REFERENCES public.workspace_principals (workspace_id, principal_id, principal_kind),
  CONSTRAINT model_profiles_authority_uq
    UNIQUE (workspace_id, profile_id, scope_id, profile_scope),
  CONSTRAINT model_profiles_workspace_identity_uq UNIQUE (workspace_id, profile_id),
  CONSTRAINT model_profiles_schema_version CHECK (schema_version = 'workbench-model-catalog-v1'),
  CONSTRAINT model_profiles_scope CHECK (profile_scope IN ('global', 'workspace')),
  CONSTRAINT model_profiles_global_authority CHECK (
    (profile_scope = 'global'
      AND workspace_id = 'system-catalog'
      AND scope_id = 'system-catalog'
      AND created_by_principal_id = 'system-catalog'
      AND created_by_principal_kind = 'system')
    OR (profile_scope = 'workspace' AND workspace_id <> 'system-catalog')
  ),
  CONSTRAINT model_profiles_display_name_length CHECK (length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT model_profiles_revision_positive CHECK (
    current_revision_number >= 1 AND write_version >= 1
  ),
  CONSTRAINT model_profiles_time_order CHECK (updated_at >= created_at),
  CONSTRAINT model_profiles_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX model_profiles_workspace_enabled_idx
  ON public.model_profiles (workspace_id, enabled, profile_id);

CREATE FUNCTION public.enforce_model_profile_root_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'model_profile_delete_forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
      NEW.profile_id, NEW.workspace_id, NEW.scope_id, NEW.schema_version,
      NEW.profile_scope, NEW.created_by_principal_id, NEW.created_by_principal_kind,
      NEW.created_at, NEW.payload
    ) IS DISTINCT FROM ROW(
      OLD.profile_id, OLD.workspace_id, OLD.scope_id, OLD.schema_version,
      OLD.profile_scope, OLD.created_by_principal_id, OLD.created_by_principal_kind,
      OLD.created_at, OLD.payload
    ) THEN
    RAISE EXCEPTION 'model_profile_identity_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.display_name, NEW.enabled, NEW.current_revision_id, NEW.current_revision_number)
      IS DISTINCT FROM
     ROW(OLD.display_name, OLD.enabled, OLD.current_revision_id, OLD.current_revision_number)
    AND NEW.write_version <> OLD.write_version + 1 THEN
    RAISE EXCEPTION 'model_profile_write_version_required'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.write_version < OLD.write_version
    OR NEW.current_revision_number < OLD.current_revision_number
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'model_profile_revision_regression'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
    AND NEW.current_revision_number <> OLD.current_revision_number + 1 THEN
    RAISE EXCEPTION 'model_profile_direct_revision_required'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER model_profiles_revision_guard
  BEFORE UPDATE OR DELETE ON public.model_profiles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_model_profile_root_revision();

CREATE TABLE public.model_profile_revisions (
  revision_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  profile_id public.product_identifier NOT NULL,
  revision_number integer NOT NULL,
  base_revision_id public.product_identifier,
  base_revision_number integer,
  schema_version text COLLATE "C" NOT NULL,
  provider text COLLATE "C" NOT NULL,
  protocol text COLLATE "C" NOT NULL,
  provider_model_ref text NOT NULL,
  capabilities text[] NOT NULL,
  parameter_support jsonb NOT NULL,
  limits jsonb NOT NULL,
  data_policy jsonb NOT NULL,
  cost_policy jsonb NOT NULL,
  parameter_schema_version text COLLATE "C" NOT NULL,
  policy_version text COLLATE "C" NOT NULL,
  config_hash text COLLATE "C" NOT NULL,
  deployment_key public.product_identifier NOT NULL,
  secret_binding_id public.product_identifier NOT NULL,
  created_by_principal_id public.product_identifier NOT NULL,
  created_by_principal_kind text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT model_profile_revisions_profile_fk
    FOREIGN KEY (workspace_id, profile_id)
    REFERENCES public.model_profiles (workspace_id, profile_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT model_profile_revisions_secret_binding_fk
    FOREIGN KEY (workspace_id, secret_binding_id)
    REFERENCES public.secret_bindings (workspace_id, secret_binding_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT model_profile_revisions_creator_fk
    FOREIGN KEY (workspace_id, created_by_principal_id, created_by_principal_kind)
    REFERENCES public.workspace_principals (workspace_id, principal_id, principal_kind),
  CONSTRAINT model_profile_revisions_number_uq
    UNIQUE (workspace_id, profile_id, revision_number),
  CONSTRAINT model_profile_revisions_pointer_uq
    UNIQUE (workspace_id, profile_id, revision_id, revision_number),
  CONSTRAINT model_profile_revisions_base_fk
    FOREIGN KEY (workspace_id, profile_id, base_revision_id, base_revision_number)
    REFERENCES public.model_profile_revisions (
      workspace_id, profile_id, revision_id, revision_number
    ),
  CONSTRAINT model_profile_revisions_schema_version
    CHECK (schema_version = 'workbench-model-catalog-v1'),
  CONSTRAINT model_profile_revisions_number_positive CHECK (revision_number >= 1),
  CONSTRAINT model_profile_revisions_base_shape CHECK (
    (revision_number = 1 AND base_revision_id IS NULL AND base_revision_number IS NULL)
    OR (revision_number > 1
      AND base_revision_id IS NOT NULL
      AND base_revision_number = revision_number - 1)
  ),
  CONSTRAINT model_profile_revisions_not_self_base
    CHECK (base_revision_id IS NULL OR base_revision_id <> revision_id),
  CONSTRAINT model_profile_revisions_provider CHECK (
    provider IN ('deepseek', 'openai', 'anthropic', 'gemini', 'stability', 'custom')
  ),
  CONSTRAINT model_profile_revisions_protocol CHECK (
    protocol IN (
      'openai_compatible_chat', 'openai_realtime', 'anthropic_messages',
      'gemini_generate_content', 'stability_image_v2'
    )
  ),
  CONSTRAINT model_profile_revisions_provider_protocol CHECK (
    (protocol = 'openai_compatible_chat' AND provider IN ('deepseek', 'openai', 'custom'))
    OR (protocol = 'openai_realtime' AND provider = 'openai')
    OR (protocol = 'anthropic_messages' AND provider = 'anthropic')
    OR (protocol = 'gemini_generate_content' AND provider = 'gemini')
    OR (protocol = 'stability_image_v2' AND provider = 'stability')
  ),
  CONSTRAINT model_profile_revisions_capabilities_closed CHECK (
    cardinality(capabilities) BETWEEN 1 AND 9
    AND array_position(capabilities, NULL) IS NULL
    AND capabilities <@ ARRAY[
      'chat', 'tool_calling', 'structured_output', 'image_input',
      'image_generation', 'realtime_audio_input', 'realtime_audio_output',
      'realtime_turn_detection', 'realtime_barge_in'
    ]::text[]
  ),
  CONSTRAINT model_profile_revisions_protocol_capabilities CHECK (
    (protocol IN ('openai_compatible_chat', 'anthropic_messages', 'gemini_generate_content')
      AND capabilities @> ARRAY['chat']::text[]
      AND NOT capabilities && ARRAY[
        'image_generation', 'realtime_audio_input', 'realtime_audio_output',
        'realtime_turn_detection', 'realtime_barge_in'
      ]::text[])
    OR (protocol = 'openai_realtime'
      AND capabilities @> ARRAY[
        'chat', 'tool_calling', 'realtime_audio_input', 'realtime_audio_output',
        'realtime_turn_detection', 'realtime_barge_in'
      ]::text[]
      AND NOT capabilities && ARRAY['image_generation']::text[])
    OR (protocol = 'stability_image_v2'
      AND cardinality(capabilities) = 1
      AND capabilities @> ARRAY['image_generation']::text[])
  ),
  CONSTRAINT model_profile_revisions_provider_model_length
    CHECK (length(provider_model_ref) BETWEEN 1 AND 256),
  CONSTRAINT model_profile_revisions_versions_length CHECK (
    length(parameter_schema_version) BETWEEN 1 AND 64
    AND length(policy_version) BETWEEN 1 AND 64
  ),
  CONSTRAINT model_profile_revisions_hash_format
    CHECK (config_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT model_profile_revisions_documents CHECK (
    jsonb_typeof(parameter_support) = 'object'
    AND jsonb_typeof(limits) = 'object'
    AND jsonb_typeof(data_policy) = 'object'
    AND jsonb_typeof(cost_policy) = 'object'
    AND jsonb_typeof(payload) = 'object'
  )
);

ALTER TABLE public.model_profiles
  ADD CONSTRAINT model_profiles_current_revision_fk
  FOREIGN KEY (workspace_id, profile_id, current_revision_id, current_revision_number)
  REFERENCES public.model_profile_revisions (
    workspace_id, profile_id, revision_id, revision_number
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public.reject_immutable_governance_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'immutable_governance_revision_mutation_forbidden: %', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER model_profile_revisions_immutable
  BEFORE UPDATE OR DELETE ON public.model_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_governance_revision_mutation();

CREATE FUNCTION public.validate_model_profile_revision_content()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  distinct_capability_count integer;
BEGIN
  SELECT count(DISTINCT capability)
    INTO distinct_capability_count
  FROM unnest(NEW.capabilities) AS capability;
  IF distinct_capability_count <> cardinality(NEW.capabilities) THEN
    RAISE EXCEPTION 'model_profile_revision_capabilities_not_unique'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER model_profile_revisions_content_guard
  BEFORE INSERT ON public.model_profile_revisions
  FOR EACH ROW EXECUTE FUNCTION public.validate_model_profile_revision_content();

CREATE FUNCTION public.validate_model_secret_binding_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  affected_revision_id public.product_identifier;
  invalid boolean;
BEGIN
  affected_revision_id := CASE
    WHEN TG_TABLE_NAME = 'model_profile_revisions'
      THEN (to_jsonb(NEW) ->> 'revision_id')::public.product_identifier
    WHEN to_jsonb(NEW) ->> 'owner_kind' = 'model_profile_revision'
      THEN (to_jsonb(NEW) ->> 'owner_id')::public.product_identifier
    ELSE NULL
  END;
  IF affected_revision_id IS NULL THEN RETURN NEW; END IF;

  SELECT NOT EXISTS (
    SELECT 1
    FROM public.model_profile_revisions revision
    JOIN public.model_profiles profile
      ON profile.workspace_id = revision.workspace_id
     AND profile.profile_id = revision.profile_id
    JOIN public.secret_bindings binding
      ON binding.workspace_id = revision.workspace_id
     AND binding.secret_binding_id = revision.secret_binding_id
    WHERE revision.revision_id = affected_revision_id
      AND binding.owner_kind = 'model_profile_revision'
      AND binding.owner_id = revision.revision_id
      AND binding.scope_id = profile.scope_id
      AND (profile.profile_scope <> 'global'
        OR binding.secret_source = 'cloud_secret_store')
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'model_profile_revision_secret_binding_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER model_profile_revisions_secret_binding_guard
  AFTER INSERT ON public.model_profile_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_model_secret_binding_aggregate();

CREATE CONSTRAINT TRIGGER secret_bindings_model_owner_guard
  AFTER INSERT OR UPDATE ON public.secret_bindings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_model_secret_binding_aggregate();

CREATE FUNCTION public.assert_model_revision_consumable(
  consumer_workspace_id public.product_identifier,
  consumer_scope_id public.product_identifier,
  selected_revision_id public.product_identifier,
  required_capability text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM 1
  FROM public.model_profile_revisions revision
  JOIN public.model_profiles profile
    ON profile.workspace_id = revision.workspace_id
   AND profile.profile_id = revision.profile_id
  JOIN public.secret_bindings binding
    ON binding.workspace_id = revision.workspace_id
   AND binding.secret_binding_id = revision.secret_binding_id
  JOIN public.product_scopes consumer_scope
    ON consumer_scope.workspace_id = consumer_workspace_id
   AND consumer_scope.scope_id = consumer_scope_id
   AND consumer_scope.status = 'active'
  WHERE revision.revision_id = selected_revision_id
    AND profile.enabled
    AND (profile.profile_scope = 'global'
      OR (profile.workspace_id = consumer_workspace_id
        AND profile.scope_id = consumer_scope_id))
    AND binding.scope_id = profile.scope_id
    AND binding.owner_kind = 'model_profile_revision'
    AND binding.owner_id = revision.revision_id
    AND binding.secret_source = 'cloud_secret_store'
    AND binding.status = 'active'
    AND binding.probed_at IS NOT NULL
    AND binding.probed_at <= clock_timestamp()
    AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
    AND (required_capability IS NULL
      OR revision.capabilities @> ARRAY[required_capability]::text[])
  FOR SHARE OF profile, binding, consumer_scope;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model_revision_not_consumable: %', selected_revision_id
      USING ERRCODE = '23514';
  END IF;
END;
$function$;

CREATE TABLE public.workspace_model_policy_revisions (
  workspace_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  policy_revision_id public.product_identifier NOT NULL,
  revision integer NOT NULL,
  base_policy_revision_id public.product_identifier,
  base_revision integer,
  schema_version text COLLATE "C" NOT NULL,
  capability_model_revision_ids jsonb NOT NULL,
  workflow_fallback_allowed boolean NOT NULL DEFAULT false,
  policy_version text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  created_by public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, policy_revision_id),
  CONSTRAINT workspace_model_policy_revisions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT workspace_model_policy_revisions_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT workspace_model_policy_revisions_creator_fk
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT workspace_model_policy_revisions_number_uq
    UNIQUE (workspace_id, scope_id, revision),
  CONSTRAINT workspace_model_policy_revisions_pointer_uq
    UNIQUE (workspace_id, scope_id, policy_revision_id, revision),
  CONSTRAINT workspace_model_policy_revisions_base_fk
    FOREIGN KEY (workspace_id, scope_id, base_policy_revision_id, base_revision)
    REFERENCES public.workspace_model_policy_revisions (
      workspace_id, scope_id, policy_revision_id, revision
    ),
  CONSTRAINT workspace_model_policy_revisions_schema_version
    CHECK (schema_version = 'workbench-model-policy-v1'),
  CONSTRAINT workspace_model_policy_revisions_revision_positive CHECK (revision >= 1),
  CONSTRAINT workspace_model_policy_revisions_base_shape CHECK (
    (revision = 1 AND base_policy_revision_id IS NULL AND base_revision IS NULL)
    OR (revision > 1
      AND base_policy_revision_id IS NOT NULL
      AND base_revision = revision - 1)
  ),
  CONSTRAINT workspace_model_policy_revisions_policy_version_length
    CHECK (length(policy_version) BETWEEN 1 AND 64),
  CONSTRAINT workspace_model_policy_revisions_hash_format
    CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT workspace_model_policy_revisions_documents CHECK (
    jsonb_typeof(capability_model_revision_ids) = 'object'
    AND jsonb_typeof(payload) = 'object'
  )
);

CREATE FUNCTION public.validate_workspace_model_policy_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  capability text;
  selected_revision text;
BEGIN
  FOR capability, selected_revision IN
    SELECT key, value
    FROM jsonb_each_text(NEW.capability_model_revision_ids)
  LOOP
    IF capability NOT IN (
      'chat', 'tool_calling', 'structured_output', 'image_input',
      'image_generation', 'realtime_audio_input', 'realtime_audio_output',
      'realtime_turn_detection', 'realtime_barge_in'
    ) THEN
      RAISE EXCEPTION 'workspace_model_policy_capability_unknown: %', capability
        USING ERRCODE = '23514';
    END IF;
    PERFORM public.assert_model_revision_consumable(
      NEW.workspace_id, NEW.scope_id,
      selected_revision::public.product_identifier, capability
    );
  END LOOP;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_model_policy_revisions_validate
  BEFORE INSERT ON public.workspace_model_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_model_policy_revision();

CREATE TRIGGER workspace_model_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON public.workspace_model_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_governance_revision_mutation();

CREATE FUNCTION public.validate_model_revision_consumer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  required_capability text;
  consumer_scope_id public.product_identifier;
BEGIN
  IF TG_TABLE_NAME = 'agent_turns' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
        OR NEW.required_model_capability IS DISTINCT FROM OLD.required_model_capability
        OR NEW.requested_model_revision_id IS DISTINCT FROM OLD.requested_model_revision_id
        OR (OLD.actual_model_revision_id IS NOT NULL
          AND NEW.actual_model_revision_id IS DISTINCT FROM OLD.actual_model_revision_id) THEN
        RAISE EXCEPTION 'agent_turn_model_pin_immutable'
          USING ERRCODE = '55000';
      END IF;
      IF NEW.actual_model_revision_id IS NOT DISTINCT FROM OLD.actual_model_revision_id THEN
        RETURN NEW;
      END IF;
    END IF;
    SELECT CASE session.scope_kind
      WHEN 'main' THEN personal_scope.scope_id
      WHEN 'module' THEN COALESCE(skill.scope_id, workflow.scope_id)
    END INTO consumer_scope_id
    FROM public.agent_sessions session
    LEFT JOIN public.product_scopes personal_scope
      ON session.scope_kind = 'main'
     AND personal_scope.workspace_id = session.workspace_id
     AND personal_scope.scope_kind = 'personal'
     AND personal_scope.owner_user_id = session.user_id
     AND personal_scope.status = 'active'
    LEFT JOIN public.skill_drafts draft
      ON session.scope_kind = 'module'
     AND session.object_kind = 'skill_draft'
     AND draft.workspace_id = session.workspace_id
     AND draft.skill_draft_id = session.object_id
    LEFT JOIN public.skill_assets skill
      ON skill.workspace_id = draft.workspace_id
     AND skill.skill_id = draft.skill_id
    LEFT JOIN public.workflows workflow
      ON session.scope_kind = 'module'
     AND session.object_kind = 'workflow'
     AND workflow.workspace_id = session.workspace_id
     AND workflow.workflow_id = session.object_id
    WHERE session.workspace_id = NEW.workspace_id
      AND session.session_id = NEW.session_id
      AND session.user_id = NEW.user_id;
    IF consumer_scope_id IS NULL THEN
      RAISE EXCEPTION 'agent_session_consumer_scope_missing: %', NEW.session_id
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
    FROM public.scope_principal_grants grant_record
    JOIN public.product_scopes scope_record
      ON scope_record.workspace_id = grant_record.workspace_id
     AND scope_record.scope_id = grant_record.scope_id
     AND scope_record.status = 'active'
    JOIN public.workspace_principals principal
      ON principal.workspace_id = grant_record.workspace_id
     AND principal.principal_id = grant_record.principal_id
     AND principal.principal_kind = grant_record.principal_kind
     AND principal.status = 'active'
    JOIN public.workspace_memberships membership
      ON membership.workspace_id = principal.workspace_id
     AND membership.membership_id = principal.membership_id
     AND membership.user_id = principal.user_id
     AND membership.status = 'active'
    WHERE grant_record.workspace_id = NEW.workspace_id
      AND grant_record.scope_id = consumer_scope_id
      AND grant_record.principal_id = NEW.user_id
      AND grant_record.principal_kind = 'user'
      AND grant_record.access_kind = 'operation'
      AND grant_record.status = 'active'
    FOR SHARE OF grant_record, scope_record, principal, membership;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'agent_session_scope_grant_missing: %', NEW.session_id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.requested_model_revision_id IS NOT NULL THEN
      PERFORM public.assert_model_revision_consumable(
        NEW.workspace_id, consumer_scope_id, NEW.requested_model_revision_id,
        NEW.required_model_capability
      );
    END IF;
    IF NEW.actual_model_revision_id IS NOT NULL THEN
      PERFORM public.assert_model_revision_consumable(
        NEW.workspace_id, consumer_scope_id, NEW.actual_model_revision_id,
        NEW.required_model_capability
      );
    END IF;
  ELSIF TG_TABLE_NAME = 'agent_context_events' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
        OR NEW.model_profile_revision_id IS DISTINCT FROM OLD.model_profile_revision_id THEN
        RAISE EXCEPTION 'agent_context_event_model_pin_immutable'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
    SELECT CASE session.scope_kind
      WHEN 'main' THEN personal_scope.scope_id
      WHEN 'module' THEN COALESCE(skill.scope_id, workflow.scope_id)
    END INTO consumer_scope_id
    FROM public.agent_sessions session
    LEFT JOIN public.product_scopes personal_scope
      ON session.scope_kind = 'main'
     AND personal_scope.workspace_id = session.workspace_id
     AND personal_scope.scope_kind = 'personal'
     AND personal_scope.owner_user_id = session.user_id
     AND personal_scope.status = 'active'
    LEFT JOIN public.skill_drafts draft
      ON session.scope_kind = 'module'
     AND session.object_kind = 'skill_draft'
     AND draft.workspace_id = session.workspace_id
     AND draft.skill_draft_id = session.object_id
    LEFT JOIN public.skill_assets skill
      ON skill.workspace_id = draft.workspace_id
     AND skill.skill_id = draft.skill_id
    LEFT JOIN public.workflows workflow
      ON session.scope_kind = 'module'
     AND session.object_kind = 'workflow'
     AND workflow.workspace_id = session.workspace_id
     AND workflow.workflow_id = session.object_id
    WHERE session.workspace_id = NEW.workspace_id
      AND session.session_id = NEW.session_id
      AND session.user_id = NEW.user_id;
    IF consumer_scope_id IS NULL THEN
      RAISE EXCEPTION 'agent_session_consumer_scope_missing: %', NEW.session_id
        USING ERRCODE = '23514';
    END IF;
    PERFORM 1
    FROM public.scope_principal_grants grant_record
    JOIN public.product_scopes scope_record
      ON scope_record.workspace_id = grant_record.workspace_id
     AND scope_record.scope_id = grant_record.scope_id
     AND scope_record.status = 'active'
    JOIN public.workspace_principals principal
      ON principal.workspace_id = grant_record.workspace_id
     AND principal.principal_id = grant_record.principal_id
     AND principal.principal_kind = grant_record.principal_kind
     AND principal.status = 'active'
    JOIN public.workspace_memberships membership
      ON membership.workspace_id = principal.workspace_id
     AND membership.membership_id = principal.membership_id
     AND membership.user_id = principal.user_id
     AND membership.status = 'active'
    WHERE grant_record.workspace_id = NEW.workspace_id
      AND grant_record.scope_id = consumer_scope_id
      AND grant_record.principal_id = NEW.user_id
      AND grant_record.principal_kind = 'user'
      AND grant_record.access_kind = 'operation'
      AND grant_record.status = 'active'
    FOR SHARE OF grant_record, scope_record, principal, membership;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'agent_session_scope_grant_missing: %', NEW.session_id
        USING ERRCODE = '23514';
    END IF;
    PERFORM public.assert_model_revision_consumable(
      NEW.workspace_id, consumer_scope_id,
      NEW.model_profile_revision_id, 'structured_output'
    );
  ELSIF TG_TABLE_NAME = 'execution_plan_model_pins' THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'execution_plan_model_pin_immutable'
        USING ERRCODE = '55000';
    END IF;
    SELECT step.value ->> 'modelCapability' INTO required_capability
    FROM public.execution_plans plan
    CROSS JOIN LATERAL jsonb_array_elements(plan.plan_document -> 'steps') AS step(value)
    WHERE plan.workspace_id = NEW.workspace_id
      AND plan.plan_id = NEW.plan_id
      AND step.value ->> 'nodeId' = NEW.node_id;
    IF required_capability IS NULL THEN
      RAISE EXCEPTION 'execution_plan_model_capability_missing: %', NEW.plan_id
        USING ERRCODE = '23514';
    END IF;
    SELECT workflow.scope_id INTO consumer_scope_id
    FROM public.execution_plans plan
    JOIN public.workflows workflow
      ON workflow.workspace_id = plan.workspace_id
     AND workflow.workflow_id = plan.workflow_id
    WHERE plan.workspace_id = NEW.workspace_id
      AND plan.plan_id = NEW.plan_id;
    IF consumer_scope_id IS NULL THEN
      RAISE EXCEPTION 'execution_plan_consumer_scope_missing: %', NEW.plan_id
        USING ERRCODE = '23514';
    END IF;
    PERFORM public.assert_model_revision_consumable(
      NEW.workspace_id, consumer_scope_id,
      NEW.model_profile_revision_id, required_capability
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TABLE public.admission_waiting (
  admission_id public.product_identifier PRIMARY KEY,
  command_id public.product_identifier NOT NULL,
  workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL,
  invocation_id public.product_identifier,
  session_id public.product_identifier,
  turn_id public.product_identifier,
  state text COLLATE "C" NOT NULL,
  queue_slot_held boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  released_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT admission_waiting_command_fk
    FOREIGN KEY (workspace_id, command_id)
    REFERENCES public.product_commands (workspace_id, command_id),
  CONSTRAINT admission_waiting_command_authority_uq
    UNIQUE (admission_id, workspace_id, command_id),
  CONSTRAINT admission_waiting_command_identity_uq
    UNIQUE NULLS NOT DISTINCT (command_id, kind, invocation_id),
  CONSTRAINT admission_waiting_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT admission_waiting_kind CHECK (kind IN ('command_turn', 'execution_invocation')),
  CONSTRAINT admission_waiting_kind_identity CHECK (
    (kind = 'command_turn' AND invocation_id IS NULL AND session_id IS NOT NULL AND turn_id IS NOT NULL)
    OR (kind = 'execution_invocation' AND invocation_id IS NOT NULL)
  ),
  CONSTRAINT admission_waiting_state CHECK (state IN (
    'waiting_session_turn', 'waiting_capacity', 'running',
    'cancellation_requested', 'released', 'cancelled'
  )),
  CONSTRAINT admission_waiting_release_state CHECK (
    (state IN ('released', 'cancelled')) = (released_at IS NOT NULL)
  ),
  CONSTRAINT admission_waiting_time_order CHECK (updated_at >= created_at),
  CONSTRAINT admission_waiting_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX admission_waiting_workspace_fifo_idx
  ON public.admission_waiting (workspace_id, state, created_at, admission_id);
CREATE INDEX admission_waiting_session_fifo_idx
  ON public.admission_waiting (session_id, state, created_at, admission_id)
  WHERE session_id IS NOT NULL;

CREATE TABLE public.capacity_counters (
  counter_id public.product_identifier PRIMARY KEY,
  schema_version text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL,
  used integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT capacity_counters_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT capacity_counters_used_nonnegative CHECK (used >= 0),
  CONSTRAINT capacity_counters_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX capacity_counters_kind_updated_idx
  ON public.capacity_counters (kind, updated_at);

CREATE TABLE public.agent_branches (
  branch_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  object_kind text COLLATE "C" NOT NULL,
  object_id public.product_identifier NOT NULL,
  base_version_id public.product_identifier NOT NULL,
  status text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_branches_workspace_user_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT agent_branches_scope_uq
    UNIQUE (branch_id, user_id, workspace_id, object_kind, object_id, base_version_id),
  CONSTRAINT agent_branches_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_branches_object_kind CHECK (object_kind IN ('skill_draft', 'workflow')),
  CONSTRAINT agent_branches_status CHECK (
    status IN ('active', 'conflicting', 'merged', 'rejected', 'closed')
  ),
  CONSTRAINT agent_branches_time_order CHECK (updated_at >= created_at),
  CONSTRAINT agent_branches_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX agent_branches_one_active_user_object_uq
  ON public.agent_branches (user_id, workspace_id, object_kind, object_id)
  WHERE status = 'active';
CREATE INDEX agent_branches_user_object_created_idx
  ON public.agent_branches (user_id, workspace_id, object_kind, object_id, created_at DESC);

CREATE TABLE public.agent_sessions (
  session_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  definition_id public.product_identifier NOT NULL,
  scope_kind text COLLATE "C" NOT NULL,
  object_kind text COLLATE "C",
  object_id public.product_identifier,
  branch_id public.product_identifier,
  base_version_id public.product_identifier,
  source_kind text COLLATE "C" NOT NULL,
  source_workflow_id public.product_identifier,
  source_workflow_revision_id public.product_identifier,
  source_run_id public.product_identifier,
  title text NOT NULL,
  task_status text COLLATE "C" NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  status text COLLATE "C" NOT NULL,
  last_used_model_profile_id public.product_identifier,
  model_preference_state text COLLATE "C" NOT NULL,
  active_turn_id public.product_identifier,
  session_epoch integer NOT NULL DEFAULT 1,
  turn_sequence bigint NOT NULL DEFAULT 0,
  message_sequence bigint NOT NULL DEFAULT 0,
  event_sequence bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_sessions_workspace_user_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT agent_sessions_identity_uq UNIQUE (session_id, user_id, workspace_id),
  CONSTRAINT agent_sessions_workspace_session_uq UNIQUE (workspace_id, session_id),
  CONSTRAINT agent_sessions_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_sessions_scope CHECK (
    (scope_kind = 'main' AND object_kind IS NULL AND object_id IS NULL
      AND branch_id IS NULL AND base_version_id IS NULL)
    OR (scope_kind = 'module' AND object_kind IN ('skill_draft', 'workflow')
      AND object_id IS NOT NULL AND branch_id IS NOT NULL AND base_version_id IS NOT NULL)
  ),
  CONSTRAINT agent_sessions_module_branch_fk
    FOREIGN KEY (branch_id, user_id, workspace_id, object_kind, object_id, base_version_id)
    REFERENCES public.agent_branches (
      branch_id, user_id, workspace_id, object_kind, object_id, base_version_id
    ),
  CONSTRAINT agent_sessions_source CHECK (
    (source_kind = 'manual' AND source_workflow_id IS NULL
      AND source_workflow_revision_id IS NULL AND source_run_id IS NULL)
    OR (source_kind = 'loop_run' AND source_workflow_id IS NOT NULL
      AND source_workflow_revision_id IS NOT NULL AND source_run_id IS NOT NULL)
  ),
  CONSTRAINT agent_sessions_task_status CHECK (task_status IN (
    'idle', 'queued', 'running', 'waiting_review',
    'completed', 'failed', 'cancelled', 'blocked'
  )),
  CONSTRAINT agent_sessions_status CHECK (status IN ('active', 'closed')),
  CONSTRAINT agent_sessions_model_state CHECK (model_preference_state IN ('preference_only', 'legacy_unpinned')),
  CONSTRAINT agent_sessions_epoch_positive CHECK (session_epoch >= 1),
  CONSTRAINT agent_sessions_sequences_nonnegative CHECK (
    turn_sequence >= 0 AND message_sequence >= 0 AND event_sequence >= 0
  ),
  CONSTRAINT agent_sessions_time_order CHECK (updated_at >= created_at),
  CONSTRAINT agent_sessions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX agent_sessions_active_module_scope_uq
  ON public.agent_sessions (
    user_id, workspace_id, definition_id, scope_kind, object_id, branch_id
  )
  WHERE scope_kind = 'module' AND status = 'active';
CREATE UNIQUE INDEX agent_sessions_workspace_source_run_uq
  ON public.agent_sessions (workspace_id, source_run_id)
  WHERE source_kind = 'loop_run';
CREATE INDEX agent_sessions_user_task_updated_idx
  ON public.agent_sessions (
    user_id, workspace_id, definition_id, task_status, updated_at DESC, created_at DESC, session_id DESC
  );

CREATE TABLE public.agent_turns (
  turn_id public.product_identifier PRIMARY KEY,
  session_id public.product_identifier NOT NULL,
  workspace_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  product_command_id public.product_identifier,
  cancellation_command_id public.product_identifier,
  kind text COLLATE "C" NOT NULL,
  sequence bigint NOT NULL,
  status text COLLATE "C" NOT NULL,
  internal_status text COLLATE "C",
  model_routing_state text COLLATE "C" NOT NULL,
  required_model_capability text COLLATE "C",
  requested_model_revision_id public.product_identifier,
  actual_model_revision_id public.product_identifier,
  session_epoch integer NOT NULL DEFAULT 1,
  turn_fence integer NOT NULL DEFAULT 1,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_turns_session_fk
    FOREIGN KEY (session_id, user_id, workspace_id)
    REFERENCES public.agent_sessions (session_id, user_id, workspace_id),
  CONSTRAINT agent_turns_session_turn_uq UNIQUE (session_id, turn_id),
  CONSTRAINT agent_turns_session_sequence_uq UNIQUE (session_id, sequence),
  CONSTRAINT agent_turns_product_command_fk
    FOREIGN KEY (workspace_id, user_id, product_command_id, session_id, turn_id)
    REFERENCES public.product_commands (
      workspace_id, quota_user_id, command_id, session_id, turn_id
    ),
  CONSTRAINT agent_turns_cancellation_command_fk
    FOREIGN KEY (workspace_id, user_id, cancellation_command_id, session_id, turn_id)
    REFERENCES public.product_commands (
      workspace_id, quota_user_id, command_id, session_id, turn_id
    ),
  CONSTRAINT agent_turns_requested_model_revision_fk
    FOREIGN KEY (requested_model_revision_id)
    REFERENCES public.model_profile_revisions (revision_id),
  CONSTRAINT agent_turns_actual_model_revision_fk
    FOREIGN KEY (actual_model_revision_id)
    REFERENCES public.model_profile_revisions (revision_id),
  CONSTRAINT agent_turns_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_turns_kind CHECK (kind IN ('agent_message', 'model_task', 'legacy_unpinned')),
  CONSTRAINT agent_turns_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT agent_turns_status CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'blocked')),
  CONSTRAINT agent_turns_internal_status CHECK (internal_status IS NULL OR internal_status = 'cancellation_requested'),
  CONSTRAINT agent_turns_model_state CHECK (model_routing_state IN ('pinned', 'legacy_unpinned')),
  CONSTRAINT agent_turns_required_model_capability CHECK (
    (model_routing_state = 'legacy_unpinned' AND required_model_capability IS NULL)
    OR (model_routing_state = 'pinned'
      AND required_model_capability IS NOT NULL
      AND (
        (kind = 'agent_message' AND required_model_capability IN (
          'chat', 'tool_calling', 'structured_output', 'image_input'
        ))
        OR (kind = 'model_task' AND required_model_capability = 'image_generation')
      ))
  ),
  CONSTRAINT agent_turns_model_revision_shape CHECK (
    (model_routing_state = 'pinned'
      AND requested_model_revision_id IS NOT NULL
      AND kind <> 'legacy_unpinned')
    OR (model_routing_state = 'legacy_unpinned'
      AND requested_model_revision_id IS NULL
      AND actual_model_revision_id IS NULL
      AND kind = 'legacy_unpinned')
  ),
  CONSTRAINT agent_turns_completed_model_revision_shape CHECK (
    model_routing_state <> 'pinned'
    OR status <> 'completed'
    OR (
      actual_model_revision_id IS NOT NULL
      AND actual_model_revision_id IS NOT DISTINCT FROM requested_model_revision_id
    )
  ),
  CONSTRAINT agent_turns_fence_positive CHECK (session_epoch >= 1 AND turn_fence >= 1),
  CONSTRAINT agent_turns_started_state CHECK (started_at IS NULL OR started_at >= queued_at),
  CONSTRAINT agent_turns_finished_state CHECK (
    (status IN ('completed', 'failed', 'cancelled', 'blocked')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT agent_turns_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX agent_turns_session_status_sequence_idx
  ON public.agent_turns (session_id, status, sequence);
CREATE INDEX agent_turns_product_command_idx
  ON public.agent_turns (product_command_id)
  WHERE product_command_id IS NOT NULL;

CREATE CONSTRAINT TRIGGER agent_turns_model_revision_guard
  AFTER INSERT OR UPDATE ON public.agent_turns
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.validate_model_revision_consumer();

ALTER TABLE public.agent_sessions
  ADD CONSTRAINT agent_sessions_active_turn_fk
  FOREIGN KEY (session_id, active_turn_id)
  REFERENCES public.agent_turns (session_id, turn_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.agent_messages (
  message_id public.product_identifier PRIMARY KEY,
  session_id public.product_identifier NOT NULL,
  turn_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  sequence bigint NOT NULL,
  role text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_messages_turn_fk
    FOREIGN KEY (session_id, turn_id)
    REFERENCES public.agent_turns (session_id, turn_id),
  CONSTRAINT agent_messages_session_sequence_uq UNIQUE (session_id, sequence),
  CONSTRAINT agent_messages_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_messages_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT agent_messages_role CHECK (role IN ('user', 'assistant', 'system')),
  CONSTRAINT agent_messages_kind CHECK (kind IN ('turn', 'steer', 'result', 'context_capsule')),
  CONSTRAINT agent_messages_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.agent_context_events (
  context_event_id public.product_identifier PRIMARY KEY,
  session_id public.product_identifier NOT NULL,
  workspace_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  through_message_sequence bigint NOT NULL,
  source_hash text COLLATE "C" NOT NULL,
  prompt_revision text COLLATE "C" NOT NULL,
  model_profile_revision_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier,
  turn_id public.product_identifier NOT NULL,
  invocation_id public.product_identifier,
  failure_code text COLLATE "C",
  retry_after timestamptz,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_context_events_session_identity_fk
    FOREIGN KEY (session_id, user_id, workspace_id)
    REFERENCES public.agent_sessions (session_id, user_id, workspace_id),
  CONSTRAINT agent_context_events_turn_fk
    FOREIGN KEY (session_id, turn_id)
    REFERENCES public.agent_turns (session_id, turn_id),
  CONSTRAINT agent_context_events_product_command_fk
    FOREIGN KEY (product_command_id, session_id, turn_id)
    REFERENCES public.product_commands (command_id, session_id, turn_id),
  CONSTRAINT agent_context_events_model_revision_fk
    FOREIGN KEY (model_profile_revision_id)
    REFERENCES public.model_profile_revisions (revision_id),
  CONSTRAINT agent_context_events_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_context_events_status CHECK (status IN ('completed', 'failed')),
  CONSTRAINT agent_context_events_source_hash
    CHECK (source_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT agent_context_events_sequence_nonnegative CHECK (through_message_sequence >= 0),
  CONSTRAINT agent_context_events_outcome CHECK (
    (status = 'completed' AND failure_code IS NULL AND retry_after IS NULL)
    OR (status = 'failed' AND failure_code IS NOT NULL AND retry_after IS NOT NULL)
  ),
  CONSTRAINT agent_context_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX agent_context_events_completed_source_uq
  ON public.agent_context_events (
    session_id, source_hash, prompt_revision, model_profile_revision_id
  )
  WHERE status = 'completed';
CREATE INDEX agent_context_events_latest_idx
  ON public.agent_context_events (session_id, created_at DESC, context_event_id DESC);

CREATE CONSTRAINT TRIGGER agent_context_events_model_revision_guard
  AFTER INSERT OR UPDATE ON public.agent_context_events
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.validate_model_revision_consumer();

CREATE TABLE public.agent_session_events (
  event_id public.product_identifier PRIMARY KEY,
  session_id public.product_identifier NOT NULL,
  turn_id public.product_identifier,
  schema_version text COLLATE "C" NOT NULL,
  sequence bigint NOT NULL,
  type text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  summary text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_session_events_session_fk
    FOREIGN KEY (session_id) REFERENCES public.agent_sessions (session_id),
  CONSTRAINT agent_session_events_turn_fk
    FOREIGN KEY (session_id, turn_id)
    REFERENCES public.agent_turns (session_id, turn_id),
  CONSTRAINT agent_session_events_session_sequence_uq UNIQUE (session_id, sequence),
  CONSTRAINT agent_session_events_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_session_events_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT agent_session_events_status CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'blocked')),
  CONSTRAINT agent_session_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.agent_handoffs (
  handoff_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  source_session_id public.product_identifier NOT NULL,
  target_session_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_handoffs_source_session_fk
    FOREIGN KEY (source_session_id, user_id, workspace_id)
    REFERENCES public.agent_sessions (session_id, user_id, workspace_id),
  CONSTRAINT agent_handoffs_target_session_fk
    FOREIGN KEY (target_session_id, user_id, workspace_id)
    REFERENCES public.agent_sessions (session_id, user_id, workspace_id),
  CONSTRAINT agent_handoffs_distinct_sessions CHECK (source_session_id <> target_session_id),
  CONSTRAINT agent_handoffs_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_handoffs_status CHECK (status IN ('pending', 'confirmed', 'dismissed')),
  CONSTRAINT agent_handoffs_confirmation_state CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CONSTRAINT agent_handoffs_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX agent_handoffs_target_status_created_idx
  ON public.agent_handoffs (target_session_id, status, created_at DESC);

CREATE TABLE public.agent_object_proposals (
  proposal_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  user_id public.product_identifier NOT NULL,
  session_id public.product_identifier NOT NULL,
  turn_id public.product_identifier NOT NULL,
  branch_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  definition_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL,
  object_id public.product_identifier NOT NULL,
  base_version_id public.product_identifier NOT NULL,
  status text COLLATE "C" NOT NULL,
  created_by public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_object_proposals_session_identity_fk
    FOREIGN KEY (session_id, user_id, workspace_id)
    REFERENCES public.agent_sessions (session_id, user_id, workspace_id),
  CONSTRAINT agent_object_proposals_turn_fk
    FOREIGN KEY (session_id, turn_id)
    REFERENCES public.agent_turns (session_id, turn_id),
  CONSTRAINT agent_object_proposals_branch_fk
    FOREIGN KEY (branch_id, user_id, workspace_id, object_kind, object_id, base_version_id)
    REFERENCES public.agent_branches (
      branch_id, user_id, workspace_id, object_kind, object_id, base_version_id
    ),
  CONSTRAINT agent_object_proposals_session_turn_uq UNIQUE (session_id, turn_id),
  CONSTRAINT agent_object_proposals_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_object_proposals_object_kind CHECK (object_kind IN ('skill_draft', 'workflow')),
  CONSTRAINT agent_object_proposals_status CHECK (status IN ('proposed', 'conflicting', 'accepted', 'rejected', 'superseded')),
  CONSTRAINT agent_object_proposals_decision_state CHECK (
    (status IN ('accepted', 'rejected', 'superseded')) = (decided_at IS NOT NULL)
  ),
  CONSTRAINT agent_object_proposals_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX agent_object_proposals_object_branch_created_idx
  ON public.agent_object_proposals (
    workspace_id, user_id, object_kind, object_id, branch_id, created_at DESC
  );

CREATE TABLE public.execution_invocations (
  invocation_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  attempt_id public.product_identifier NOT NULL,
  parent_invocation_id public.product_identifier,
  product_command_id public.product_identifier NOT NULL,
  lineage_session_id public.product_identifier,
  lineage_turn_id public.product_identifier,
  lineage_session_key text COLLATE "C"
    GENERATED ALWAYS AS (coalesce(lineage_session_id, '@none')) STORED,
  lineage_turn_key text COLLATE "C"
    GENERATED ALWAYS AS (coalesce(lineage_turn_id, '@none')) STORED,
  controller_kind text COLLATE "C" NOT NULL,
  controller_id public.product_identifier NOT NULL,
  controller_fence integer NOT NULL,
  mode text COLLATE "C" NOT NULL,
  isolation text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  event_sequence bigint NOT NULL DEFAULT 0,
  execution_fence integer NOT NULL,
  capacity_admission_id public.product_identifier NOT NULL,
  capacity_lease_id public.product_identifier NOT NULL,
  capacity_fence integer NOT NULL,
  capacity_backend_key text COLLATE "C" NOT NULL,
  capacity_provider_key text COLLATE "C" NOT NULL,
  capability_lease_id public.product_identifier NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT execution_invocations_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT execution_invocations_workspace_identity_uq UNIQUE (workspace_id, invocation_id),
  CONSTRAINT execution_invocations_workspace_session_identity_uq
    UNIQUE (workspace_id, lineage_session_key, invocation_id),
  CONSTRAINT execution_invocations_workspace_raw_session_identity_uq
    UNIQUE (workspace_id, lineage_session_id, invocation_id),
  CONSTRAINT execution_invocations_parent_authority_uq UNIQUE (
    workspace_id, invocation_id, product_command_id,
    lineage_session_key, lineage_turn_key, controller_kind, controller_id,
    controller_fence
  ),
  CONSTRAINT execution_invocations_parent_authority_fk
    FOREIGN KEY (
      workspace_id, parent_invocation_id, product_command_id,
      lineage_session_key, lineage_turn_key, controller_kind, controller_id,
      controller_fence
    )
    REFERENCES public.execution_invocations (
      workspace_id, invocation_id, product_command_id,
      lineage_session_key, lineage_turn_key, controller_kind, controller_id,
      controller_fence
    ),
  CONSTRAINT execution_invocations_command_fk
    FOREIGN KEY (workspace_id, product_command_id)
    REFERENCES public.product_commands (workspace_id, command_id),
  CONSTRAINT execution_invocations_command_lineage_fk
    FOREIGN KEY (
      workspace_id, product_command_id, lineage_session_key, lineage_turn_key
    ) REFERENCES public.product_commands (
      workspace_id, command_id, session_lineage_key, turn_lineage_key
    ),
  CONSTRAINT execution_invocations_schema_version CHECK (schema_version = 'workbench-execution-fabric-v1'),
  CONSTRAINT execution_invocations_controller_kind CHECK (controller_kind IN (
    'workflow_run', 'agent_turn', 'skill_creation_turn', 'skill_test'
  )),
  CONSTRAINT execution_invocations_lineage_shape CHECK (
    (controller_kind IN ('agent_turn', 'skill_creation_turn')
      AND lineage_session_id IS NOT NULL AND lineage_turn_id IS NOT NULL)
    OR (controller_kind IN ('workflow_run', 'skill_test')
      AND ((lineage_session_id IS NULL AND lineage_turn_id IS NULL)
        OR (lineage_session_id IS NOT NULL AND lineage_turn_id IS NOT NULL)))
  ),
  CONSTRAINT execution_invocations_mode CHECK (mode IN (
    'deterministic_skill', 'model_call', 'realtime_audio', 'bounded_agent', 'agent_orchestrator'
  )),
  CONSTRAINT execution_invocations_isolation CHECK (isolation IN ('process', 'container', 'remote')),
  CONSTRAINT execution_invocations_status CHECK (status IN (
    'queued', 'running', 'cancellation_requested', 'completed', 'failed', 'cancelled',
    'blocked', 'partial', 'effect_outcome_unknown', 'timeout', 'permission_denied',
    'sandbox_unavailable', 'remote_backend_unavailable'
  )),
  CONSTRAINT execution_invocations_sequences_nonnegative CHECK (event_sequence >= 0 AND execution_fence >= 0),
  CONSTRAINT execution_invocations_capacity_fence_positive CHECK (capacity_fence >= 1),
  CONSTRAINT execution_invocations_capacity_backend CHECK (
    capacity_backend_key = mode || ':' || isolation
  ),
  CONSTRAINT execution_invocations_not_self_parent CHECK (
    parent_invocation_id IS NULL OR parent_invocation_id <> invocation_id
  ),
  CONSTRAINT execution_invocations_time_order CHECK (updated_at >= created_at),
  CONSTRAINT execution_invocations_terminal_time CHECK (
    (status IN (
      'completed', 'failed', 'cancelled', 'blocked', 'partial', 'effect_outcome_unknown',
      'timeout', 'permission_denied', 'sandbox_unavailable', 'remote_backend_unavailable'
    )) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT execution_invocations_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX execution_invocations_controller_created_idx
  ON public.execution_invocations (workspace_id, controller_kind, controller_id, created_at DESC);
CREATE INDEX execution_invocations_command_lineage_idx
  ON public.execution_invocations (
    workspace_id, product_command_id, created_at, invocation_id
  );

CREATE TABLE public.execution_attempts (
  attempt_id public.product_identifier PRIMARY KEY,
  invocation_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  attempt_number integer NOT NULL,
  status text COLLATE "C" NOT NULL,
  fence integer NOT NULL,
  checkpoint_sequence bigint NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT execution_attempts_invocation_fk
    FOREIGN KEY (invocation_id) REFERENCES public.execution_invocations (invocation_id),
  CONSTRAINT execution_attempts_invocation_attempt_uq UNIQUE (invocation_id, attempt_id),
  CONSTRAINT execution_attempts_number_uq UNIQUE (invocation_id, attempt_number),
  CONSTRAINT execution_attempts_schema_version CHECK (schema_version = 'workbench-execution-fabric-v1'),
  CONSTRAINT execution_attempts_number_positive CHECK (attempt_number >= 1),
  CONSTRAINT execution_attempts_status CHECK (status IN (
    'queued', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'partial',
    'effect_outcome_unknown', 'timeout', 'permission_denied', 'sandbox_unavailable',
    'remote_backend_unavailable'
  )),
  CONSTRAINT execution_attempts_sequences_nonnegative CHECK (fence >= 0 AND checkpoint_sequence >= 0),
  CONSTRAINT execution_attempts_time_order CHECK (updated_at >= created_at),
  CONSTRAINT execution_attempts_terminal_time CHECK (
    (status IN (
      'completed', 'failed', 'cancelled', 'blocked', 'partial', 'effect_outcome_unknown',
      'timeout', 'permission_denied', 'sandbox_unavailable', 'remote_backend_unavailable'
    )) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT execution_attempts_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

ALTER TABLE public.execution_invocations
  ADD CONSTRAINT execution_invocations_attempt_authority_fk
  FOREIGN KEY (invocation_id, attempt_id)
  REFERENCES public.execution_attempts (invocation_id, attempt_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.execution_events (
  event_id public.product_identifier PRIMARY KEY,
  invocation_id public.product_identifier NOT NULL,
  attempt_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  sequence bigint NOT NULL,
  type text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT execution_events_attempt_fk
    FOREIGN KEY (invocation_id, attempt_id)
    REFERENCES public.execution_attempts (invocation_id, attempt_id),
  CONSTRAINT execution_events_invocation_sequence_uq UNIQUE (invocation_id, sequence),
  CONSTRAINT execution_events_schema_version CHECK (schema_version = 'workbench-execution-fabric-v1'),
  CONSTRAINT execution_events_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT execution_events_status CHECK (status IN (
    'queued', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'partial',
    'effect_outcome_unknown', 'timeout', 'permission_denied', 'sandbox_unavailable',
    'remote_backend_unavailable'
  )),
  CONSTRAINT execution_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.execution_checkpoints (
  checkpoint_id public.product_identifier PRIMARY KEY,
  invocation_id public.product_identifier NOT NULL,
  attempt_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  sequence bigint NOT NULL,
  fence integer NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT execution_checkpoints_attempt_fk
    FOREIGN KEY (invocation_id, attempt_id)
    REFERENCES public.execution_attempts (invocation_id, attempt_id),
  CONSTRAINT execution_checkpoints_attempt_sequence_uq UNIQUE (invocation_id, attempt_id, sequence),
  CONSTRAINT execution_checkpoints_schema_version CHECK (schema_version = 'workbench-execution-fabric-v1'),
  CONSTRAINT execution_checkpoints_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT execution_checkpoints_fence_nonnegative CHECK (fence >= 0),
  CONSTRAINT execution_checkpoints_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.capability_leases (
  capability_lease_id public.product_identifier PRIMARY KEY,
  invocation_id public.product_identifier NOT NULL,
  attempt_id public.product_identifier NOT NULL,
  workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  fence integer NOT NULL,
  status text COLLATE "C" NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT capability_leases_invocation_workspace_fk
    FOREIGN KEY (workspace_id, invocation_id)
    REFERENCES public.execution_invocations (workspace_id, invocation_id),
  CONSTRAINT capability_leases_attempt_fk
    FOREIGN KEY (invocation_id, attempt_id)
    REFERENCES public.execution_attempts (invocation_id, attempt_id),
  CONSTRAINT capability_leases_invocation_attempt_uq UNIQUE (invocation_id, attempt_id),
  CONSTRAINT capability_leases_authority_uq
    UNIQUE (invocation_id, attempt_id, capability_lease_id),
  CONSTRAINT capability_leases_schema_version CHECK (schema_version = 'workbench-execution-fabric-v1'),
  CONSTRAINT capability_leases_fence_nonnegative CHECK (fence >= 0),
  CONSTRAINT capability_leases_status CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT capability_leases_time_order CHECK (expires_at > issued_at AND updated_at >= issued_at),
  CONSTRAINT capability_leases_revocation_state CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT capability_leases_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX capability_leases_workspace_invocation_issued_idx
  ON public.capability_leases (workspace_id, invocation_id, issued_at, capability_lease_id);
CREATE INDEX capability_leases_expires_idx
  ON public.capability_leases (expires_at)
  WHERE status = 'active';

ALTER TABLE public.execution_invocations
  ADD CONSTRAINT execution_invocations_capability_authority_fk
  FOREIGN KEY (invocation_id, attempt_id, capability_lease_id)
  REFERENCES public.capability_leases (invocation_id, attempt_id, capability_lease_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.agent_child_spawn_counters (
  counter_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  session_id public.product_identifier,
  parent_scope_invocation_id public.product_identifier,
  schema_version text COLLATE "C" NOT NULL,
  count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_child_spawn_counters_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT agent_child_spawn_counters_session_fk
    FOREIGN KEY (workspace_id, session_id)
    REFERENCES public.agent_sessions (workspace_id, session_id),
  CONSTRAINT agent_child_spawn_counters_parent_fk
    FOREIGN KEY (workspace_id, parent_scope_invocation_id)
    REFERENCES public.execution_invocations (workspace_id, invocation_id),
  CONSTRAINT agent_child_spawn_counters_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_child_spawn_counters_workspace_identity_uq UNIQUE (workspace_id, counter_id),
  CONSTRAINT agent_child_spawn_counters_scope_identity_uq
    UNIQUE NULLS NOT DISTINCT (
      workspace_id, counter_id, session_id, parent_scope_invocation_id
    ),
  CONSTRAINT agent_child_spawn_counters_session_identity_uq
    UNIQUE (workspace_id, counter_id, session_id),
  CONSTRAINT agent_child_spawn_counters_invocation_identity_uq
    UNIQUE (workspace_id, counter_id, parent_scope_invocation_id),
  CONSTRAINT agent_child_spawn_counters_scope CHECK (
    (session_id IS NOT NULL AND parent_scope_invocation_id IS NULL)
    OR (session_id IS NULL AND parent_scope_invocation_id IS NOT NULL)
  ),
  CONSTRAINT agent_child_spawn_counters_count_nonnegative CHECK (count >= 0),
  CONSTRAINT agent_child_spawn_counters_time_order CHECK (updated_at >= created_at),
  CONSTRAINT agent_child_spawn_counters_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX agent_child_spawn_counters_workspace_session_idx
  ON public.agent_child_spawn_counters (workspace_id, session_id)
  WHERE session_id IS NOT NULL;

CREATE TABLE public.agent_child_spawn_reservations (
  counter_id public.product_identifier NOT NULL,
  workspace_id public.product_identifier NOT NULL,
  session_id public.product_identifier,
  parent_scope_invocation_id public.product_identifier,
  parent_invocation_id public.product_identifier NOT NULL,
  child_key public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  reserved_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (counter_id, child_key),
  CONSTRAINT agent_child_spawn_reservations_counter_session_fk
    FOREIGN KEY (workspace_id, counter_id, session_id)
    REFERENCES public.agent_child_spawn_counters (workspace_id, counter_id, session_id),
  CONSTRAINT agent_child_spawn_reservations_counter_invocation_fk
    FOREIGN KEY (workspace_id, counter_id, parent_scope_invocation_id)
    REFERENCES public.agent_child_spawn_counters (
      workspace_id, counter_id, parent_scope_invocation_id
    ),
  CONSTRAINT agent_child_spawn_reservations_parent_fk
    FOREIGN KEY (workspace_id, parent_invocation_id)
    REFERENCES public.execution_invocations (workspace_id, invocation_id),
  CONSTRAINT agent_child_spawn_reservations_session_parent_fk
    FOREIGN KEY (workspace_id, session_id, parent_invocation_id)
    REFERENCES public.execution_invocations (
      workspace_id, lineage_session_id, invocation_id
    ),
  CONSTRAINT agent_child_spawn_reservations_parent_key_uq
    UNIQUE (workspace_id, parent_invocation_id, child_key),
  CONSTRAINT agent_child_spawn_reservations_schema_version
    CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT agent_child_spawn_reservations_scope CHECK (
    (session_id IS NOT NULL AND parent_scope_invocation_id IS NULL)
    OR (session_id IS NULL AND parent_scope_invocation_id IS NOT NULL)
  ),
  CONSTRAINT agent_child_spawn_reservations_invocation_parent CHECK (
    parent_scope_invocation_id IS NULL
    OR parent_invocation_id = parent_scope_invocation_id
  ),
  CONSTRAINT agent_child_spawn_reservations_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.capacity_leases (
  capacity_lease_id public.product_identifier PRIMARY KEY,
  admission_id public.product_identifier NOT NULL,
  command_id public.product_identifier NOT NULL,
  workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  backend_key text COLLATE "C" NOT NULL,
  provider_key text COLLATE "C" NOT NULL,
  fence integer NOT NULL,
  lease_duration_ms integer NOT NULL,
  status text COLLATE "C" NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  updated_at timestamptz NOT NULL,
  dimensions jsonb NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT capacity_leases_admission_fk
    FOREIGN KEY (admission_id, workspace_id, command_id)
    REFERENCES public.admission_waiting (
      admission_id, workspace_id, command_id
    ),
  CONSTRAINT capacity_leases_command_fk
    FOREIGN KEY (workspace_id, command_id)
    REFERENCES public.product_commands (workspace_id, command_id),
  CONSTRAINT capacity_leases_authority_uq UNIQUE (
    capacity_lease_id, admission_id, command_id, workspace_id,
    backend_key, provider_key, fence
  ),
  CONSTRAINT capacity_leases_admission_fence_uq UNIQUE (admission_id, fence),
  CONSTRAINT capacity_leases_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT capacity_leases_fence_positive CHECK (fence >= 1),
  CONSTRAINT capacity_leases_duration_positive CHECK (lease_duration_ms > 0),
  CONSTRAINT capacity_leases_status CHECK (status IN ('active', 'released')),
  CONSTRAINT capacity_leases_time_order CHECK (expires_at > issued_at AND updated_at >= issued_at),
  CONSTRAINT capacity_leases_release_state CHECK ((status = 'released') = (released_at IS NOT NULL)),
  CONSTRAINT capacity_leases_dimensions_array CHECK (jsonb_typeof(dimensions) = 'array'),
  CONSTRAINT capacity_leases_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX capacity_leases_status_expires_idx
  ON public.capacity_leases (status, expires_at);
CREATE INDEX capacity_leases_workspace_status_issued_idx
  ON public.capacity_leases (workspace_id, status, issued_at);

ALTER TABLE public.execution_invocations
  ADD CONSTRAINT execution_invocations_capacity_authority_fk
  FOREIGN KEY (
    capacity_lease_id, capacity_admission_id, product_command_id,
    workspace_id,
    capacity_backend_key, capacity_provider_key,
    capacity_fence
  )
  REFERENCES public.capacity_leases (
    capacity_lease_id, admission_id, command_id,
    workspace_id,
    backend_key, provider_key, fence
  );

ALTER TABLE public.agent_context_events
  ADD CONSTRAINT agent_context_events_invocation_fk
  FOREIGN KEY (workspace_id, invocation_id)
  REFERENCES public.execution_invocations (workspace_id, invocation_id);

CREATE TABLE public.workbench_browser_sessions (
  session_id public.product_identifier PRIMARY KEY,
  user_id public.product_identifier NOT NULL,
  active_workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  token_hash text COLLATE "C" NOT NULL,
  csrf_token text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT workbench_browser_sessions_membership_fk
    FOREIGN KEY (active_workspace_id, user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT workbench_browser_sessions_token_hash_uq UNIQUE (token_hash),
  CONSTRAINT workbench_browser_sessions_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT workbench_browser_sessions_token_hash_format
    CHECK (token_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT workbench_browser_sessions_expiry CHECK (expires_at > created_at),
  CONSTRAINT workbench_browser_sessions_revoke_time CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT workbench_browser_sessions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX workbench_browser_sessions_expires_idx
  ON public.workbench_browser_sessions (expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE public.memory_candidates (
  candidate_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  scope_kind text COLLATE "C" NOT NULL,
  scope_owner_user_id public.product_identifier,
  scope_object_kind text COLLATE "C",
  scope_object_id public.product_identifier,
  subject_kind text COLLATE "C" NOT NULL,
  subject_id public.product_identifier NOT NULL,
  source_kind text COLLATE "C" NOT NULL,
  source_id public.product_identifier NOT NULL,
  source_version_id public.product_identifier,
  source_verified boolean NOT NULL,
  confidence double precision NOT NULL,
  sensitivity text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  created_by public.product_identifier NOT NULL,
  submitted_by_kind text COLLATE "C" NOT NULL,
  policy_version text COLLATE "C" NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT memory_candidates_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT memory_candidates_personal_owner_fk
    FOREIGN KEY (workspace_id, scope_owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT memory_candidates_workspace_identity_uq UNIQUE (workspace_id, candidate_id),
  CONSTRAINT memory_candidates_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT memory_candidates_scope CHECK (
    (scope_kind = 'personal' AND scope_owner_user_id IS NOT NULL
      AND scope_object_kind IS NULL AND scope_object_id IS NULL)
    OR (scope_kind = 'object' AND scope_owner_user_id IS NULL
      AND scope_object_kind IN ('workflow', 'skill_draft') AND scope_object_id IS NOT NULL)
    OR (scope_kind = 'workspace' AND scope_owner_user_id IS NULL
      AND scope_object_kind IS NULL AND scope_object_id IS NULL)
  ),
  CONSTRAINT memory_candidates_source_kind CHECK (source_kind IN ('canonical_object', 'agent', 'worker', 'external', 'transcript')),
  CONSTRAINT memory_candidates_confidence CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT memory_candidates_sensitivity CHECK (sensitivity IN ('low', 'moderate', 'high')),
  CONSTRAINT memory_candidates_status CHECK (status IN ('pending', 'promoted', 'rejected', 'expired')),
  CONSTRAINT memory_candidates_submitter CHECK (submitted_by_kind IN ('agent', 'worker', 'user', 'system')),
  CONSTRAINT memory_candidates_decision_state CHECK (
    (status IN ('promoted', 'rejected')) = (decided_at IS NOT NULL)
  ),
  CONSTRAINT memory_candidates_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX memory_candidates_scope_status_created_idx
  ON public.memory_candidates (workspace_id, scope_kind, status, created_at DESC);
CREATE INDEX memory_candidates_expires_idx
  ON public.memory_candidates (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE public.durable_memories (
  memory_id public.product_identifier PRIMARY KEY,
  candidate_id public.product_identifier NOT NULL,
  workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  scope_kind text COLLATE "C" NOT NULL,
  scope_owner_user_id public.product_identifier,
  scope_object_kind text COLLATE "C",
  scope_object_id public.product_identifier,
  subject_kind text COLLATE "C" NOT NULL,
  subject_id public.product_identifier NOT NULL,
  source_kind text COLLATE "C" NOT NULL,
  source_id public.product_identifier NOT NULL,
  source_version_id public.product_identifier,
  source_verified boolean NOT NULL,
  statement text NOT NULL,
  confidence double precision NOT NULL,
  sensitivity text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  created_by public.product_identifier NOT NULL,
  promoted_by public.product_identifier NOT NULL,
  promotion_mode text COLLATE "C" NOT NULL,
  policy_version text COLLATE "C" NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_document tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, coalesce(statement, '')), 'A')
    || setweight(to_tsvector('simple'::regconfig, coalesce(payload ->> 'tags', '')), 'B')
  ) STORED,
  CONSTRAINT durable_memories_candidate_fk
    FOREIGN KEY (workspace_id, candidate_id)
    REFERENCES public.memory_candidates (workspace_id, candidate_id),
  CONSTRAINT durable_memories_candidate_uq UNIQUE (candidate_id),
  CONSTRAINT durable_memories_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT durable_memories_scope CHECK (
    (scope_kind = 'personal' AND scope_owner_user_id IS NOT NULL
      AND scope_object_kind IS NULL AND scope_object_id IS NULL)
    OR (scope_kind = 'object' AND scope_owner_user_id IS NULL
      AND scope_object_kind IN ('workflow', 'skill_draft') AND scope_object_id IS NOT NULL)
    OR (scope_kind = 'workspace' AND scope_owner_user_id IS NULL
      AND scope_object_kind IS NULL AND scope_object_id IS NULL)
  ),
  CONSTRAINT durable_memories_source_kind CHECK (source_kind IN ('canonical_object', 'agent', 'worker', 'external', 'transcript')),
  CONSTRAINT durable_memories_confidence CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT durable_memories_sensitivity CHECK (sensitivity IN ('low', 'moderate', 'high')),
  CONSTRAINT durable_memories_status CHECK (status = 'active'),
  CONSTRAINT durable_memories_promotion_mode CHECK (promotion_mode IN ('manual', 'policy')),
  CONSTRAINT durable_memories_time_order CHECK (updated_at >= created_at),
  CONSTRAINT durable_memories_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX durable_memories_scope_subject_status_idx
  ON public.durable_memories (
    workspace_id, scope_kind, subject_kind, subject_id, status, updated_at DESC
  );
CREATE INDEX durable_memories_search_gin_idx
  ON public.durable_memories USING gin (search_document);
CREATE INDEX durable_memories_expires_idx
  ON public.durable_memories (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE public.memory_events (
  memory_event_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  candidate_id public.product_identifier,
  memory_id public.product_identifier,
  type text COLLATE "C" NOT NULL,
  actor_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT memory_events_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT memory_events_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT memory_events_type CHECK (type IN (
    'candidate.submitted', 'candidate.approved', 'candidate.rejected', 'memory.deleted'
  )),
  CONSTRAINT memory_events_identity CHECK (candidate_id IS NOT NULL OR memory_id IS NOT NULL),
  CONSTRAINT memory_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX memory_events_workspace_created_idx
  ON public.memory_events (workspace_id, created_at, memory_event_id);

CREATE TABLE public.memory_deletion_tombstones (
  tombstone_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  memory_id_hash text COLLATE "C" NOT NULL,
  scope_kind text COLLATE "C" NOT NULL,
  deleted_by public.product_identifier NOT NULL,
  reason text NOT NULL,
  policy_version text COLLATE "C" NOT NULL,
  deleted_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT memory_deletion_tombstones_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT memory_deletion_tombstones_memory_hash_uq UNIQUE (memory_id_hash),
  CONSTRAINT memory_deletion_tombstones_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT memory_deletion_tombstones_hash CHECK (memory_id_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT memory_deletion_tombstones_scope CHECK (scope_kind IN ('personal', 'object', 'workspace')),
  CONSTRAINT memory_deletion_tombstones_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX memory_deletion_tombstones_workspace_deleted_idx
  ON public.memory_deletion_tombstones (workspace_id, deleted_at DESC);

CREATE TABLE public.external_effect_receipts (
  workspace_id public.product_identifier NOT NULL,
  effect_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  invocation_id public.product_identifier NOT NULL,
  attempt_id public.product_identifier NOT NULL,
  controller_id public.product_identifier,
  node_id public.product_identifier,
  connection_id public.product_identifier NOT NULL,
  requirement_id public.product_identifier,
  action text COLLATE "C" NOT NULL,
  argument_digest text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  reconcile_after timestamptz,
  dispatch_started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, effect_id),
  CONSTRAINT external_effect_receipts_invocation_workspace_fk
    FOREIGN KEY (workspace_id, invocation_id)
    REFERENCES public.execution_invocations (workspace_id, invocation_id),
  CONSTRAINT external_effect_receipts_attempt_fk
    FOREIGN KEY (invocation_id, attempt_id)
    REFERENCES public.execution_attempts (invocation_id, attempt_id),
  CONSTRAINT external_effect_receipts_schema_version CHECK (schema_version = 'workbench-internal-v1'),
  CONSTRAINT external_effect_receipts_argument_digest_format
    CHECK (argument_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT external_effect_receipts_status CHECK (status IN (
    'pending', 'intent_recorded', 'dispatching', 'outcome_unknown', 'succeeded', 'cancelled'
  )),
  CONSTRAINT external_effect_receipts_time_order CHECK (updated_at >= created_at),
  CONSTRAINT external_effect_receipts_dispatch_state CHECK (
    (status IN ('dispatching', 'outcome_unknown')
      AND dispatch_started_at IS NOT NULL AND reconcile_after IS NOT NULL)
    OR (status = 'succeeded' AND dispatch_started_at IS NOT NULL)
    OR (status IN ('pending', 'intent_recorded', 'cancelled'))
  ),
  CONSTRAINT external_effect_receipts_terminal_state CHECK (
    (status = 'succeeded' AND completed_at IS NOT NULL AND failed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'outcome_unknown' AND failed_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
    OR (status IN ('pending', 'intent_recorded', 'dispatching')
      AND completed_at IS NULL AND cancelled_at IS NULL)
  ),
  CONSTRAINT external_effect_receipts_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX external_effect_receipts_controller_created_idx
  ON public.external_effect_receipts (workspace_id, controller_id, created_at DESC);
CREATE INDEX external_effect_receipts_status_updated_idx
  ON public.external_effect_receipts (workspace_id, status, updated_at);

-- G2 B1: immutable object metadata, governed materials, and Skill lifecycle.

CREATE TABLE public.product_objects (
  workspace_id public.product_identifier NOT NULL,
  object_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  object_kind text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  size_bytes bigint NOT NULL,
  media_type text COLLATE "C" NOT NULL,
  storage_backend text COLLATE "C" NOT NULL,
  storage_key text COLLATE "C" NOT NULL,
  storage_version text COLLATE "C" NOT NULL,
  state text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, object_id),
  CONSTRAINT product_objects_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT product_objects_authority_uq
    UNIQUE (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT product_objects_content_kind_uq
    UNIQUE (workspace_id, content_hash, object_kind),
  CONSTRAINT product_objects_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT product_objects_kind CHECK (object_kind IN (
    'skill_package', 'loop_package', 'attachment_source',
    'attachment_representation', 'resource_content', 'artifact_content',
    'private_session_content', 'idempotency_response', 'transcript_metadata'
  )),
  CONSTRAINT product_objects_hash_format
    CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT product_objects_size_bounds CHECK (size_bytes BETWEEN 0 AND 1073741824),
  CONSTRAINT product_objects_media_type_length CHECK (length(media_type) BETWEEN 1 AND 128),
  CONSTRAINT product_objects_storage_fields CHECK (
    length(storage_backend) BETWEEN 1 AND 64
    AND length(storage_key) BETWEEN 1 AND 1024
    AND length(storage_version) BETWEEN 1 AND 128
  ),
  CONSTRAINT product_objects_state CHECK (state IN ('quarantined', 'promoted', 'deleted')),
  CONSTRAINT product_objects_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX product_objects_workspace_kind_created_idx
  ON public.product_objects (workspace_id, object_kind, created_at DESC, object_id);

CREATE TABLE public.upload_sessions (
  workspace_id public.product_identifier NOT NULL,
  upload_id public.product_identifier NOT NULL,
  requested_by public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  asset_kind text COLLATE "C" NOT NULL,
  state text COLLATE "C" NOT NULL,
  file_name text NOT NULL,
  size_bytes bigint NOT NULL,
  media_type text COLLATE "C" NOT NULL,
  ingest_method text COLLATE "C" NOT NULL,
  received_bytes bigint NOT NULL DEFAULT 0,
  total_chunks integer NOT NULL DEFAULT 0,
  received_chunks integer NOT NULL DEFAULT 0,
  object_id public.product_identifier,
  object_kind text COLLATE "C",
  object_content_hash text COLLATE "C",
  package_hash text COLLATE "C",
  inspection_status text COLLATE "C",
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, upload_id),
  CONSTRAINT upload_sessions_requester_fk
    FOREIGN KEY (workspace_id, requested_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT upload_sessions_object_fk
    FOREIGN KEY (workspace_id, object_id, object_kind, object_content_hash)
    REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT upload_sessions_object_authority_uq
    UNIQUE (workspace_id, upload_id, object_id, object_content_hash, package_hash),
  CONSTRAINT upload_sessions_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT upload_sessions_asset_kind CHECK (asset_kind IN ('skill', 'loop')),
  CONSTRAINT upload_sessions_state CHECK (state IN (
    'selecting', 'uploading', 'quarantined', 'scanning', 'parsing',
    'needs_decision', 'ready_draft', 'failed', 'promoted'
  )),
  CONSTRAINT upload_sessions_ingest_method CHECK (
    ingest_method IN ('files', 'resumable', 'repository')
  ),
  CONSTRAINT upload_sessions_sizes CHECK (
    size_bytes BETWEEN 0 AND 1073741824
    AND received_bytes >= 0 AND received_bytes <= size_bytes
    AND total_chunks BETWEEN 0 AND 256
    AND received_chunks BETWEEN 0 AND total_chunks
  ),
  CONSTRAINT upload_sessions_file_name_length CHECK (length(file_name) BETWEEN 1 AND 512),
  CONSTRAINT upload_sessions_media_type_length CHECK (length(media_type) BETWEEN 1 AND 128),
  CONSTRAINT upload_sessions_object_shape CHECK (
    (object_id IS NULL AND object_kind IS NULL AND object_content_hash IS NULL)
    OR (object_id IS NOT NULL AND object_kind IS NOT NULL AND object_content_hash IS NOT NULL)
  ),
  CONSTRAINT upload_sessions_object_kind CHECK (
    object_kind IS NULL
    OR (asset_kind = 'skill' AND object_kind = 'skill_package')
    OR (asset_kind = 'loop' AND object_kind = 'loop_package')
  ),
  CONSTRAINT upload_sessions_object_required CHECK (
    state NOT IN ('needs_decision', 'ready_draft', 'promoted') OR object_id IS NOT NULL
  ),
  CONSTRAINT upload_sessions_hash_formats CHECK (
    (object_content_hash IS NULL OR object_content_hash ~ '^sha256:[a-f0-9]{16,64}$')
    AND (package_hash IS NULL OR package_hash ~ '^sha256:[a-f0-9]{16,64}$')
  ),
  CONSTRAINT upload_sessions_inspection_status CHECK (
    inspection_status IS NULL OR inspection_status IN ('passed', 'needs_review', 'failed')
  ),
  CONSTRAINT upload_sessions_time_order CHECK (updated_at >= created_at),
  CONSTRAINT upload_sessions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX upload_sessions_workspace_state_updated_idx
  ON public.upload_sessions (workspace_id, state, updated_at DESC, upload_id);

CREATE TABLE public.input_attachments (
  workspace_id public.product_identifier NOT NULL,
  attachment_id public.product_identifier NOT NULL,
  attachment_version integer NOT NULL,
  owner_user_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  scope_kind text COLLATE "C" NOT NULL,
  file_name text NOT NULL,
  media_type text COLLATE "C" NOT NULL,
  size_bytes bigint NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  object_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL DEFAULT 'attachment_source',
  source text COLLATE "C" NOT NULL DEFAULT 'user_upload',
  processing_status text COLLATE "C" NOT NULL,
  processing_code text COLLATE "C",
  processing_message text NOT NULL,
  processing_retryable boolean NOT NULL,
  row_revision integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, attachment_id, attachment_version),
  CONSTRAINT input_attachments_owner_fk
    FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT input_attachments_object_fk
    FOREIGN KEY (workspace_id, object_id, object_kind, content_hash)
    REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT input_attachments_content_authority_uq
    UNIQUE (workspace_id, attachment_id, attachment_version, content_hash),
  CONSTRAINT input_attachments_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT input_attachments_personal_scope CHECK (scope_kind = 'personal'),
  CONSTRAINT input_attachments_object_kind CHECK (object_kind = 'attachment_source'),
  CONSTRAINT input_attachments_source CHECK (source = 'user_upload'),
  CONSTRAINT input_attachments_version_positive CHECK (attachment_version >= 1),
  CONSTRAINT input_attachments_row_revision_positive CHECK (row_revision >= 1),
  CONSTRAINT input_attachments_file_name_length CHECK (length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT input_attachments_media_type CHECK (media_type IN (
    'image/png', 'image/jpeg', 'image/webp',
    'text/plain', 'text/markdown', 'text/csv', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )),
  CONSTRAINT input_attachments_size_bounds CHECK (size_bytes BETWEEN 1 AND 16777216),
  CONSTRAINT input_attachments_hash_format CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT input_attachments_processing_status CHECK (
    processing_status IN ('processing', 'ready', 'failed', 'blocked', 'deleted', 'expired')
  ),
  CONSTRAINT input_attachments_processing_message
    CHECK (length(processing_message) <= 1000),
  CONSTRAINT input_attachments_processing_code CHECK (
    processing_code IS NULL OR processing_code IN (
      'attachment_format_unsupported', 'attachment_ocr_required',
      'attachment_too_large', 'attachment_limit_exceeded',
      'attachment_integrity_failed', 'attachment_mime_mismatch',
      'attachment_macro_forbidden', 'attachment_path_traversal',
      'attachment_malicious_package', 'attachment_processing_unavailable',
      'attachment_processing_failed', 'attachment_expired',
      'attachment_deleted', 'attachment_forbidden'
    )
  ),
  CONSTRAINT input_attachments_processing_state CHECK (
    (processing_status IN ('processing', 'ready') AND processing_code IS NULL)
    OR (processing_status IN ('blocked', 'failed') AND processing_code IS NOT NULL)
    OR (processing_status = 'deleted' AND processing_code = 'attachment_deleted')
    OR (processing_status = 'expired' AND processing_code = 'attachment_expired')
  ),
  CONSTRAINT input_attachments_deleted_state CHECK (
    (processing_status IN ('deleted', 'expired')) = (deleted_at IS NOT NULL)
  ),
  CONSTRAINT input_attachments_ttl CHECK (expires_at > created_at),
  CONSTRAINT input_attachments_delete_time CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CONSTRAINT input_attachments_time_order CHECK (updated_at >= created_at),
  CONSTRAINT input_attachments_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX input_attachments_owner_updated_idx
  ON public.input_attachments (
    workspace_id, owner_user_id, updated_at DESC, attachment_id, attachment_version DESC
  );
CREATE INDEX input_attachments_expires_idx
  ON public.input_attachments (expires_at)
  WHERE deleted_at IS NULL;

CREATE TABLE public.attachment_derived_representations (
  workspace_id public.product_identifier NOT NULL,
  representation_id public.product_identifier NOT NULL,
  attachment_id public.product_identifier NOT NULL,
  attachment_version integer NOT NULL,
  attachment_content_hash text COLLATE "C" NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  representation_kind text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  character_count integer NOT NULL DEFAULT 0,
  representation_object_id public.product_identifier,
  representation_object_kind text COLLATE "C",
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, representation_id),
  CONSTRAINT attachment_derived_representations_attachment_fk
    FOREIGN KEY (workspace_id, attachment_id, attachment_version, attachment_content_hash)
    REFERENCES public.input_attachments (
      workspace_id, attachment_id, attachment_version, content_hash
    ),
  CONSTRAINT attachment_derived_representations_object_fk
    FOREIGN KEY (
      workspace_id, representation_object_id, representation_object_kind, content_hash
    ) REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT attachment_derived_representations_schema_version
    CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT attachment_derived_representations_kind CHECK (
    representation_kind IN (
      'binary_reference', 'utf8_text', 'document_text', 'spreadsheet_tables'
    )
  ),
  CONSTRAINT attachment_derived_representations_hash_format
    CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT attachment_derived_representations_character_count
    CHECK (character_count BETWEEN 0 AND 2000000),
  CONSTRAINT attachment_derived_representations_object_shape CHECK (
    (representation_kind = 'binary_reference'
      AND representation_object_id IS NULL
      AND representation_object_kind IS NULL
      AND character_count = 0
      AND content_hash = attachment_content_hash)
    OR (representation_kind IN ('utf8_text', 'document_text', 'spreadsheet_tables')
      AND representation_object_id IS NOT NULL
      AND representation_object_kind = 'attachment_representation')
  ),
  CONSTRAINT attachment_derived_representations_evidence_array
    CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 10000),
  CONSTRAINT attachment_derived_representations_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.workspace_resources (
  workspace_id public.product_identifier NOT NULL,
  resource_id public.product_identifier NOT NULL,
  resource_version text COLLATE "C" NOT NULL,
  created_by public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  label text NOT NULL,
  media_type text COLLATE "C" NOT NULL,
  size_bytes bigint NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  object_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL DEFAULT 'resource_content',
  source_kind text COLLATE "C" NOT NULL,
  source_attachment_id public.product_identifier,
  source_attachment_version integer,
  source_attachment_content_hash text COLLATE "C",
  readiness_status text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, resource_id, resource_version),
  CONSTRAINT workspace_resources_creator_fk
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT workspace_resources_object_fk
    FOREIGN KEY (workspace_id, object_id, object_kind, content_hash)
    REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT workspace_resources_source_attachment_fk
    FOREIGN KEY (
      workspace_id, source_attachment_id, source_attachment_version,
      source_attachment_content_hash
    ) REFERENCES public.input_attachments (
      workspace_id, attachment_id, attachment_version, content_hash
    ),
  CONSTRAINT workspace_resources_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT workspace_resources_version_length
    CHECK (length(resource_version) BETWEEN 1 AND 64),
  CONSTRAINT workspace_resources_object_kind CHECK (object_kind = 'resource_content'),
  CONSTRAINT workspace_resources_label_length CHECK (length(label) BETWEEN 1 AND 200),
  CONSTRAINT workspace_resources_media_type_length CHECK (length(media_type) BETWEEN 1 AND 128),
  CONSTRAINT workspace_resources_size_bounds CHECK (size_bytes BETWEEN 1 AND 16777216),
  CONSTRAINT workspace_resources_hash_format CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT workspace_resources_source CHECK (
    (source_kind = 'text_entry'
      AND source_attachment_id IS NULL
      AND source_attachment_version IS NULL
      AND source_attachment_content_hash IS NULL)
    OR (source_kind = 'attachment'
      AND source_attachment_id IS NOT NULL
      AND source_attachment_version IS NOT NULL
      AND source_attachment_content_hash IS NOT NULL)
  ),
  CONSTRAINT workspace_resources_readiness CHECK (
    readiness_status IN ('processing', 'ready', 'blocked', 'deleted')
  ),
  CONSTRAINT workspace_resources_time_order CHECK (updated_at >= created_at),
  CONSTRAINT workspace_resources_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX workspace_resources_workspace_updated_idx
  ON public.workspace_resources (workspace_id, updated_at DESC, resource_id, resource_version);

CREATE FUNCTION public.enforce_root_scope_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.scope_id IS DISTINCT FROM OLD.scope_id THEN
    RAISE EXCEPTION 'product_root_scope_immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TABLE public.skill_assets (
  workspace_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  owner_user_id public.product_identifier,
  owner_system_principal_id public.product_identifier,
  schema_version text COLLATE "C" NOT NULL,
  name_normalized text COLLATE "C" NOT NULL,
  visibility text COLLATE "C" NOT NULL,
  lifecycle text COLLATE "C" NOT NULL,
  current_draft_id public.product_identifier,
  latest_published_version_id public.product_identifier,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, skill_id),
  CONSTRAINT skill_assets_owner_fk
    FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT skill_assets_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT skill_assets_scope_identity_uq
    UNIQUE (workspace_id, skill_id, scope_id),
  CONSTRAINT skill_assets_owner_shape CHECK (
    (owner_user_id IS NOT NULL) <> (owner_system_principal_id IS NOT NULL)
  ),
  CONSTRAINT skill_assets_system_owner_uq
    UNIQUE (workspace_id, skill_id, owner_system_principal_id),
  CONSTRAINT skill_assets_name_uq UNIQUE (workspace_id, name_normalized),
  CONSTRAINT skill_assets_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT skill_assets_name_nonempty CHECK (length(name_normalized) BETWEEN 1 AND 256),
  CONSTRAINT skill_assets_visibility CHECK (visibility IN ('private', 'workspace')),
  CONSTRAINT skill_assets_lifecycle CHECK (
    lifecycle IN ('draft', 'validating', 'tested', 'published', 'deprecated', 'archived')
  ),
  CONSTRAINT skill_assets_time_order CHECK (updated_at >= created_at),
  CONSTRAINT skill_assets_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX skill_assets_workspace_lifecycle_updated_idx
  ON public.skill_assets (workspace_id, lifecycle, updated_at DESC, skill_id);

CREATE TRIGGER skill_assets_scope_immutable
  BEFORE UPDATE ON public.skill_assets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_root_scope_immutable();

CREATE TABLE public.skill_system_catalog_principals (
  principal_id public.product_identifier PRIMARY KEY,
  product_user_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT skill_system_catalog_principals_user_fk
    FOREIGN KEY (product_user_id) REFERENCES public.product_users (user_id),
  CONSTRAINT skill_system_catalog_principals_schema_version
    CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT skill_system_catalog_principals_identity CHECK (
    principal_id = 'system-catalog' AND product_user_id = principal_id
  ),
  CONSTRAINT skill_system_catalog_principals_status CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT skill_system_catalog_principals_time_order CHECK (updated_at >= created_at),
  CONSTRAINT skill_system_catalog_principals_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

ALTER TABLE public.skill_assets
  ADD CONSTRAINT skill_assets_system_owner_fk
  FOREIGN KEY (owner_system_principal_id)
  REFERENCES public.skill_system_catalog_principals (principal_id);

CREATE TABLE public.skill_system_catalog_sources (
  workspace_id public.product_identifier NOT NULL,
  catalog_source_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  system_principal_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  source_locator text COLLATE "C" NOT NULL,
  source_revision text COLLATE "C" NOT NULL,
  source_manifest_hash text COLLATE "C" NOT NULL,
  package_object_id public.product_identifier NOT NULL,
  package_object_kind text COLLATE "C" NOT NULL DEFAULT 'skill_package',
  package_object_hash text COLLATE "C" NOT NULL,
  package_hash text COLLATE "C" NOT NULL,
  published_version_content_hash text COLLATE "C" NOT NULL,
  runtime_probe_id public.product_identifier NOT NULL,
  runtime_probe_status text COLLATE "C" NOT NULL,
  runtime_probe_code text COLLATE "C" NOT NULL,
  runtime_probe_digest text COLLATE "C" NOT NULL,
  execution_ref jsonb NOT NULL,
  execution_ref_hash text COLLATE "C" NOT NULL,
  probed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  definition jsonb NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, catalog_source_id),
  CONSTRAINT skill_system_catalog_sources_asset_fk
    FOREIGN KEY (workspace_id, skill_id, system_principal_id)
    REFERENCES public.skill_assets (workspace_id, skill_id, owner_system_principal_id),
  CONSTRAINT skill_system_catalog_sources_principal_fk
    FOREIGN KEY (system_principal_id)
    REFERENCES public.skill_system_catalog_principals (principal_id),
  CONSTRAINT skill_system_catalog_sources_object_fk
    FOREIGN KEY (
      workspace_id, package_object_id, package_object_kind, package_object_hash
    ) REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT skill_system_catalog_sources_authority_uq UNIQUE (
    workspace_id, catalog_source_id, skill_id, system_principal_id,
    package_object_id, package_object_hash, package_hash, published_version_content_hash
  ),
  CONSTRAINT skill_system_catalog_sources_schema_version
    CHECK (schema_version = 'workbench-internal-v1'),
  CONSTRAINT skill_system_catalog_sources_principal
    CHECK (system_principal_id = 'system-catalog'),
  CONSTRAINT skill_system_catalog_sources_locator
    CHECK (
      source_locator ~ '^bundled://[A-Za-z0-9._/-]+$'
      AND length(source_locator) BETWEEN 11 AND 512
    ),
  CONSTRAINT skill_system_catalog_sources_revision_length
    CHECK (length(source_revision) BETWEEN 1 AND 128),
  CONSTRAINT skill_system_catalog_sources_object_kind
    CHECK (package_object_kind = 'skill_package'),
  CONSTRAINT skill_system_catalog_sources_hash_formats CHECK (
    source_manifest_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND package_object_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND package_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND published_version_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND runtime_probe_digest ~ '^sha256:[a-f0-9]{16,64}$'
    AND execution_ref_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT skill_system_catalog_sources_runtime_probe
    CHECK (
      runtime_probe_status = 'ready'
      AND length(runtime_probe_code) BETWEEN 1 AND 128
    ),
  CONSTRAINT skill_system_catalog_sources_execution_ref_object
    CHECK (jsonb_typeof(execution_ref) = 'object'),
  CONSTRAINT skill_system_catalog_sources_definition_object
    CHECK (jsonb_typeof(definition) = 'object'),
  CONSTRAINT skill_system_catalog_sources_time_order CHECK (
    probed_at <= created_at
  ),
  CONSTRAINT skill_system_catalog_sources_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.legacy_skill_definitions (
  legacy_definition_id public.product_identifier PRIMARY KEY,
  schema_version text COLLATE "C" NOT NULL,
  scope_kind text COLLATE "C" NOT NULL,
  workspace_id public.product_identifier,
  owner_user_id public.product_identifier,
  skill_id public.product_identifier NOT NULL,
  version text COLLATE "C" NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  category text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT legacy_skill_definitions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT legacy_skill_definitions_owner_fk
    FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT legacy_skill_definitions_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT legacy_skill_definitions_scope CHECK (
    (scope_kind = 'global' AND workspace_id IS NULL AND owner_user_id IS NULL)
    OR (scope_kind = 'workspace' AND workspace_id IS NOT NULL AND owner_user_id IS NOT NULL)
  ),
  CONSTRAINT legacy_skill_definitions_version_nonempty CHECK (length(version) BETWEEN 1 AND 128),
  CONSTRAINT legacy_skill_definitions_status CHECK (
    status IN ('draft', 'validating', 'ready', 'blocked', 'retired')
  ),
  CONSTRAINT legacy_skill_definitions_time_order CHECK (updated_at >= created_at),
  CONSTRAINT legacy_skill_definitions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX legacy_skill_definitions_global_identity_uq
  ON public.legacy_skill_definitions (skill_id, version)
  WHERE scope_kind = 'global';
CREATE UNIQUE INDEX legacy_skill_definitions_workspace_identity_uq
  ON public.legacy_skill_definitions (workspace_id, skill_id, version)
  WHERE scope_kind = 'workspace';

CREATE TABLE public.skill_drafts (
  workspace_id public.product_identifier NOT NULL,
  skill_draft_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  base_version_id public.product_identifier,
  draft_revision integer NOT NULL,
  package_object_id public.product_identifier,
  package_object_kind text COLLATE "C",
  package_object_hash text COLLATE "C",
  package_hash text COLLATE "C",
  content_hash text COLLATE "C" NOT NULL,
  updated_by public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  definition jsonb NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, skill_draft_id),
  CONSTRAINT skill_drafts_skill_fk
    FOREIGN KEY (workspace_id, skill_id)
    REFERENCES public.skill_assets (workspace_id, skill_id),
  CONSTRAINT skill_drafts_editor_fk
    FOREIGN KEY (workspace_id, updated_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT skill_drafts_package_object_fk
    FOREIGN KEY (
      workspace_id, package_object_id, package_object_kind, package_object_hash
    ) REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT skill_drafts_skill_identity_uq
    UNIQUE (workspace_id, skill_id, skill_draft_id),
  CONSTRAINT skill_drafts_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT skill_drafts_revision_positive CHECK (draft_revision >= 1),
  CONSTRAINT skill_drafts_package_shape CHECK (
    (package_object_id IS NULL AND package_object_kind IS NULL
      AND package_object_hash IS NULL AND package_hash IS NULL)
    OR (package_object_id IS NOT NULL AND package_object_kind = 'skill_package'
      AND package_object_hash IS NOT NULL AND package_hash IS NOT NULL)
  ),
  CONSTRAINT skill_drafts_hash_formats CHECK (
    (package_object_hash IS NULL OR package_object_hash ~ '^sha256:[a-f0-9]{16,64}$')
    AND (package_hash IS NULL OR package_hash ~ '^sha256:[a-f0-9]{16,64}$')
    AND content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT skill_drafts_time_order CHECK (updated_at >= created_at),
  CONSTRAINT skill_drafts_definition_object CHECK (jsonb_typeof(definition) = 'object'),
  CONSTRAINT skill_drafts_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.skill_draft_revision_snapshots (
  workspace_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  skill_draft_id public.product_identifier NOT NULL,
  draft_revision integer NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  package_object_id public.product_identifier,
  package_object_kind text COLLATE "C",
  package_object_hash text COLLATE "C",
  package_hash text COLLATE "C",
  content_hash text COLLATE "C" NOT NULL,
  created_by public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  definition jsonb NOT NULL,
  PRIMARY KEY (workspace_id, skill_draft_id, draft_revision),
  CONSTRAINT skill_draft_revision_snapshots_draft_fk
    FOREIGN KEY (workspace_id, skill_id, skill_draft_id)
    REFERENCES public.skill_drafts (workspace_id, skill_id, skill_draft_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT skill_draft_revision_snapshots_creator_fk
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT skill_draft_revision_snapshots_package_object_fk
    FOREIGN KEY (
      workspace_id, package_object_id, package_object_kind, package_object_hash
    ) REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT skill_draft_revision_snapshots_authority_uq UNIQUE (
    workspace_id, skill_id, skill_draft_id, draft_revision,
    package_object_id, package_object_hash, package_hash, content_hash
  ),
  CONSTRAINT skill_draft_revision_snapshots_schema_version
    CHECK (schema_version = 'workbench-internal-v1'),
  CONSTRAINT skill_draft_revision_snapshots_revision_positive CHECK (draft_revision >= 1),
  CONSTRAINT skill_draft_revision_snapshots_package_shape CHECK (
    (package_object_id IS NULL AND package_object_kind IS NULL
      AND package_object_hash IS NULL AND package_hash IS NULL)
    OR (package_object_id IS NOT NULL AND package_object_kind = 'skill_package'
      AND package_object_hash IS NOT NULL AND package_hash IS NOT NULL)
  ),
  CONSTRAINT skill_draft_revision_snapshots_hash_formats CHECK (
    (package_object_hash IS NULL OR package_object_hash ~ '^sha256:[a-f0-9]{16,64}$')
    AND (package_hash IS NULL OR package_hash ~ '^sha256:[a-f0-9]{16,64}$')
    AND content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT skill_draft_revision_snapshots_definition_object
    CHECK (jsonb_typeof(definition) = 'object')
);

ALTER TABLE public.skill_drafts
  ADD CONSTRAINT skill_drafts_current_snapshot_fk
  FOREIGN KEY (
    workspace_id, skill_id, skill_draft_id, draft_revision,
    package_object_id, package_object_hash, package_hash, content_hash
  ) REFERENCES public.skill_draft_revision_snapshots (
    workspace_id, skill_id, skill_draft_id, draft_revision,
    package_object_id, package_object_hash, package_hash, content_hash
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.product_commands
  ADD CONSTRAINT product_commands_typed_tenant_lineage_uq
  UNIQUE (workspace_id, quota_user_id, command_id, session_id, turn_id, kind);

CREATE TABLE public.skill_test_runs (
  workspace_id public.product_identifier NOT NULL,
  test_run_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  skill_draft_id public.product_identifier NOT NULL,
  draft_revision integer NOT NULL,
  requested_by public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  command_kind text COLLATE "C" NOT NULL DEFAULT 'skill_test',
  schema_version text COLLATE "C" NOT NULL,
  package_hash text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  upload_id public.product_identifier NOT NULL,
  object_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL DEFAULT 'skill_package',
  object_hash text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  test_case jsonb NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_preview jsonb,
  execution_attempt integer NOT NULL DEFAULT 1,
  runner_claim_owner public.product_identifier,
  runner_claim_fence integer NOT NULL DEFAULT 0,
  runner_claim_expires_at timestamptz,
  row_revision integer NOT NULL DEFAULT 1,
  accepted_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, test_run_id),
  CONSTRAINT skill_test_runs_draft_fk
    FOREIGN KEY (workspace_id, skill_id, skill_draft_id)
    REFERENCES public.skill_drafts (workspace_id, skill_id, skill_draft_id),
  CONSTRAINT skill_test_runs_command_fk
    FOREIGN KEY (
      workspace_id, requested_by, product_command_id,
      skill_draft_id, test_run_id, command_kind
    ) REFERENCES public.product_commands (
      workspace_id, quota_user_id, command_id, session_id, turn_id, kind
    ),
  CONSTRAINT skill_test_runs_snapshot_fk
    FOREIGN KEY (
      workspace_id, skill_id, skill_draft_id, draft_revision,
      object_id, object_hash, package_hash, content_hash
    ) REFERENCES public.skill_draft_revision_snapshots (
      workspace_id, skill_id, skill_draft_id, draft_revision,
      package_object_id, package_object_hash, package_hash, content_hash
    ),
  CONSTRAINT skill_test_runs_upload_fk
    FOREIGN KEY (workspace_id, upload_id, object_id, object_hash, package_hash)
    REFERENCES public.upload_sessions (
      workspace_id, upload_id, object_id, object_content_hash, package_hash
    ),
  CONSTRAINT skill_test_runs_object_fk
    FOREIGN KEY (workspace_id, object_id, object_kind, object_hash)
    REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT skill_test_runs_snapshot_uq
    UNIQUE (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash
    ),
  CONSTRAINT skill_test_runs_validation_authority_uq UNIQUE (
    workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
    upload_id, object_id, object_hash, package_hash, content_hash, status
  ),
  CONSTRAINT skill_test_runs_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT skill_test_runs_command_kind CHECK (command_kind = 'skill_test'),
  CONSTRAINT skill_test_runs_revision_positive CHECK (draft_revision >= 1),
  CONSTRAINT skill_test_runs_object_kind CHECK (object_kind = 'skill_package'),
  CONSTRAINT skill_test_runs_hash_formats CHECK (
    object_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND package_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT skill_test_runs_status CHECK (
    status IN ('queued', 'running', 'passed', 'failed', 'blocked', 'cancelled')
  ),
  CONSTRAINT skill_test_runs_test_case_object CHECK (jsonb_typeof(test_case) = 'object'),
  CONSTRAINT skill_test_runs_diagnostics_array CHECK (jsonb_typeof(diagnostics) = 'array'),
  CONSTRAINT skill_test_runs_attempt_fence CHECK (
    execution_attempt >= 1 AND runner_claim_fence >= 0 AND row_revision >= 1
  ),
  CONSTRAINT skill_test_runs_claim_shape CHECK (
    (runner_claim_owner IS NULL) = (runner_claim_expires_at IS NULL)
  ),
  CONSTRAINT skill_test_runs_started_state CHECK (
    started_at IS NULL OR started_at >= accepted_at
  ),
  CONSTRAINT skill_test_runs_terminal_state CHECK (
    (status IN ('passed', 'failed', 'blocked', 'cancelled')) = (completed_at IS NOT NULL)
  ),
  CONSTRAINT skill_test_runs_time_order CHECK (updated_at >= accepted_at),
  CONSTRAINT skill_test_runs_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX skill_test_runs_recovery_idx
  ON public.skill_test_runs (status, started_at, test_run_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX skill_test_runs_draft_completed_idx
  ON public.skill_test_runs (
    workspace_id, skill_id, skill_draft_id, completed_at DESC, test_run_id
  );

CREATE TABLE public.skill_test_evidence (
  workspace_id public.product_identifier NOT NULL,
  test_run_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  skill_draft_id public.product_identifier NOT NULL,
  draft_revision integer NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  upload_id public.product_identifier NOT NULL,
  object_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL DEFAULT 'skill_package',
  object_hash text COLLATE "C" NOT NULL,
  package_hash text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  isolated boolean NOT NULL,
  network_denied boolean NOT NULL,
  runtime_summary jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, test_run_id),
  CONSTRAINT skill_test_evidence_test_run_fk
    FOREIGN KEY (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash
    ) REFERENCES public.skill_test_runs (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash
    ),
  CONSTRAINT skill_test_evidence_draft_fk
    FOREIGN KEY (workspace_id, skill_id, skill_draft_id)
    REFERENCES public.skill_drafts (workspace_id, skill_id, skill_draft_id),
  CONSTRAINT skill_test_evidence_upload_fk
    FOREIGN KEY (workspace_id, upload_id, object_id, object_hash, package_hash)
    REFERENCES public.upload_sessions (
      workspace_id, upload_id, object_id, object_content_hash, package_hash
    ),
  CONSTRAINT skill_test_evidence_object_fk
    FOREIGN KEY (workspace_id, object_id, object_kind, object_hash)
    REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT skill_test_evidence_validation_authority_uq UNIQUE (
    workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
    upload_id, object_id, object_hash, package_hash, content_hash,
    isolated, network_denied
  ),
  CONSTRAINT skill_test_evidence_schema_version CHECK (schema_version = 'workbench-internal-v1'),
  CONSTRAINT skill_test_evidence_revision_positive CHECK (draft_revision >= 1),
  CONSTRAINT skill_test_evidence_object_kind CHECK (object_kind = 'skill_package'),
  CONSTRAINT skill_test_evidence_hash_formats CHECK (
    object_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND package_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT skill_test_evidence_runtime_summary_object
    CHECK (jsonb_typeof(runtime_summary) = 'object'),
  CONSTRAINT skill_test_evidence_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX skill_test_evidence_draft_revision_idx
  ON public.skill_test_evidence (
    workspace_id, skill_draft_id, draft_revision, content_hash, test_run_id
  );

CREATE TABLE public.skill_validations (
  workspace_id public.product_identifier NOT NULL,
  validation_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  skill_draft_id public.product_identifier NOT NULL,
  draft_revision integer NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  upload_id public.product_identifier NOT NULL,
  object_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL DEFAULT 'skill_package',
  object_hash text COLLATE "C" NOT NULL,
  package_hash text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  primary_test_run_id public.product_identifier NOT NULL,
  primary_test_status text COLLATE "C" NOT NULL,
  primary_evidence_isolated boolean NOT NULL,
  primary_evidence_network_denied boolean NOT NULL,
  permission_acknowledged boolean NOT NULL,
  status text COLLATE "C" NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  runtime_summary jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, validation_id),
  CONSTRAINT skill_validations_draft_fk
    FOREIGN KEY (workspace_id, skill_id, skill_draft_id)
    REFERENCES public.skill_drafts (workspace_id, skill_id, skill_draft_id),
  CONSTRAINT skill_validations_upload_fk
    FOREIGN KEY (workspace_id, upload_id, object_id, object_hash, package_hash)
    REFERENCES public.upload_sessions (
      workspace_id, upload_id, object_id, object_content_hash, package_hash
    ),
  CONSTRAINT skill_validations_object_fk
    FOREIGN KEY (workspace_id, object_id, object_kind, object_hash)
    REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT skill_validations_primary_test_run_fk
    FOREIGN KEY (
      workspace_id, primary_test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash,
      primary_test_status
    ) REFERENCES public.skill_test_runs (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash, status
    ),
  CONSTRAINT skill_validations_primary_evidence_fk
    FOREIGN KEY (
      workspace_id, primary_test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash,
      primary_evidence_isolated, primary_evidence_network_denied
    ) REFERENCES public.skill_test_evidence (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash,
      isolated, network_denied
    ),
  CONSTRAINT skill_validations_authority_uq UNIQUE (
    workspace_id, validation_id, skill_id, skill_draft_id, draft_revision,
    upload_id, object_id, object_hash, package_hash, content_hash, status
  ),
  CONSTRAINT skill_validations_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT skill_validations_revision_positive CHECK (draft_revision >= 1),
  CONSTRAINT skill_validations_object_kind CHECK (object_kind = 'skill_package'),
  CONSTRAINT skill_validations_hash_formats CHECK (
    object_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND package_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT skill_validations_status CHECK (status IN ('passed', 'failed', 'blocked')),
  CONSTRAINT skill_validations_primary_test_status CHECK (
    primary_test_status IN ('passed', 'failed', 'blocked', 'cancelled')
  ),
  CONSTRAINT skill_validations_passed_requirements CHECK (
    status <> 'passed'
    OR (
      permission_acknowledged
      AND primary_test_status = 'passed'
      AND primary_evidence_isolated
      AND primary_evidence_network_denied
    )
  ),
  CONSTRAINT skill_validations_diagnostics_array CHECK (jsonb_typeof(diagnostics) = 'array'),
  CONSTRAINT skill_validations_runtime_summary_object
    CHECK (jsonb_typeof(runtime_summary) = 'object'),
  CONSTRAINT skill_validations_time_order CHECK (completed_at >= created_at),
  CONSTRAINT skill_validations_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX skill_validations_exact_passed_idx
  ON public.skill_validations (
    workspace_id, skill_id, skill_draft_id, draft_revision,
    content_hash, completed_at DESC, validation_id
  ) WHERE status = 'passed';

CREATE TABLE public.skill_validation_test_runs (
  workspace_id public.product_identifier NOT NULL,
  validation_id public.product_identifier NOT NULL,
  test_run_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  skill_draft_id public.product_identifier NOT NULL,
  draft_revision integer NOT NULL,
  upload_id public.product_identifier NOT NULL,
  object_id public.product_identifier NOT NULL,
  object_hash text COLLATE "C" NOT NULL,
  package_hash text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  validation_status text COLLATE "C" NOT NULL,
  test_status text COLLATE "C" NOT NULL,
  evidence_isolated boolean NOT NULL,
  evidence_network_denied boolean NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, validation_id, test_run_id),
  CONSTRAINT skill_validation_test_runs_validation_fk
    FOREIGN KEY (
      workspace_id, validation_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash, validation_status
    ) REFERENCES public.skill_validations (
      workspace_id, validation_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash, status
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT skill_validation_test_runs_test_run_fk
    FOREIGN KEY (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash, test_status
    ) REFERENCES public.skill_test_runs (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash, status
    ),
  CONSTRAINT skill_validation_test_runs_evidence_fk
    FOREIGN KEY (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash,
      evidence_isolated, evidence_network_denied
    ) REFERENCES public.skill_test_evidence (
      workspace_id, test_run_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash,
      isolated, network_denied
    ),
  CONSTRAINT skill_validation_test_runs_schema_version
    CHECK (schema_version = 'workbench-internal-v1'),
  CONSTRAINT skill_validation_test_runs_revision_positive CHECK (draft_revision >= 1),
  CONSTRAINT skill_validation_test_runs_hash_formats CHECK (
    object_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND package_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT skill_validation_test_runs_passed_requirements CHECK (
    validation_status <> 'passed'
    OR (
      test_status = 'passed'
      AND evidence_isolated
      AND evidence_network_denied
    )
  ),
  CONSTRAINT skill_validation_test_runs_authority_uq UNIQUE (
    workspace_id, validation_id, test_run_id, skill_id, skill_draft_id,
    draft_revision, upload_id, object_id, object_hash, package_hash,
    content_hash, validation_status, test_status,
    evidence_isolated, evidence_network_denied
  )
);

ALTER TABLE public.skill_validations
  ADD CONSTRAINT skill_validations_primary_membership_fk
  FOREIGN KEY (
    workspace_id, validation_id, primary_test_run_id, skill_id, skill_draft_id,
    draft_revision, upload_id, object_id, object_hash, package_hash,
    content_hash, status, primary_test_status,
    primary_evidence_isolated, primary_evidence_network_denied
  ) REFERENCES public.skill_validation_test_runs (
    workspace_id, validation_id, test_run_id, skill_id, skill_draft_id,
    draft_revision, upload_id, object_id, object_hash, package_hash,
    content_hash, validation_status, test_status,
    evidence_isolated, evidence_network_denied
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.skill_execution_bindings (
  workspace_id public.product_identifier NOT NULL,
  execution_binding_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  skill_draft_id public.product_identifier NOT NULL,
  draft_revision integer NOT NULL,
  validation_id public.product_identifier NOT NULL,
  validation_status text COLLATE "C" NOT NULL DEFAULT 'passed',
  schema_version text COLLATE "C" NOT NULL,
  upload_id public.product_identifier NOT NULL,
  object_id public.product_identifier NOT NULL,
  object_kind text COLLATE "C" NOT NULL DEFAULT 'skill_package',
  object_hash text COLLATE "C" NOT NULL,
  package_hash text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  published_version_content_hash text COLLATE "C" NOT NULL,
  trust_tier text COLLATE "C" NOT NULL,
  executor_kind text COLLATE "C" NOT NULL,
  runtime_id public.product_identifier,
  image_digest text COLLATE "C",
  capability_id public.product_identifier NOT NULL,
  task_intent public.product_identifier NOT NULL,
  adapter_version text COLLATE "C" NOT NULL,
  execution_mode text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, execution_binding_id),
  CONSTRAINT skill_execution_bindings_validation_fk
    FOREIGN KEY (
      workspace_id, validation_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash, validation_status
    ) REFERENCES public.skill_validations (
      workspace_id, validation_id, skill_id, skill_draft_id, draft_revision,
      upload_id, object_id, object_hash, package_hash, content_hash, status
    ),
  CONSTRAINT skill_execution_bindings_draft_fk
    FOREIGN KEY (workspace_id, skill_id, skill_draft_id)
    REFERENCES public.skill_drafts (workspace_id, skill_id, skill_draft_id),
  CONSTRAINT skill_execution_bindings_upload_fk
    FOREIGN KEY (workspace_id, upload_id, object_id, object_hash, package_hash)
    REFERENCES public.upload_sessions (
      workspace_id, upload_id, object_id, object_content_hash, package_hash
    ),
  CONSTRAINT skill_execution_bindings_object_fk
    FOREIGN KEY (workspace_id, object_id, object_kind, object_hash)
    REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT skill_execution_bindings_validation_uq UNIQUE (workspace_id, validation_id),
  CONSTRAINT skill_execution_bindings_authority_uq UNIQUE (
    workspace_id, execution_binding_id, skill_id, skill_draft_id, draft_revision,
    validation_id, object_id, object_hash, package_hash, content_hash,
    published_version_content_hash
  ),
  CONSTRAINT skill_execution_bindings_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT skill_execution_bindings_validation_status CHECK (validation_status = 'passed'),
  CONSTRAINT skill_execution_bindings_revision_positive CHECK (draft_revision >= 1),
  CONSTRAINT skill_execution_bindings_object_kind CHECK (object_kind = 'skill_package'),
  CONSTRAINT skill_execution_bindings_hash_formats CHECK (
    object_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND package_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND published_version_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND (image_digest IS NULL OR image_digest ~ '^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$')
  ),
  CONSTRAINT skill_execution_bindings_executor CHECK (
    (trust_tier = 'uploaded_prompt' AND executor_kind = 'prompt_tool'
      AND runtime_id IS NULL AND image_digest IS NULL)
    OR (trust_tier = 'uploaded_oci' AND executor_kind = 'docker'
      AND runtime_id IN ('python3.12', 'nodejs20-typescript')
      AND image_digest IS NOT NULL)
  ),
  CONSTRAINT skill_execution_bindings_execution_mode CHECK (
    execution_mode IN ('deterministic', 'agent')
  ),
  CONSTRAINT skill_execution_bindings_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.skill_versions (
  workspace_id public.product_identifier NOT NULL,
  skill_version_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  version text COLLATE "C" NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  source_kind text COLLATE "C" NOT NULL,
  source_skill_draft_id public.product_identifier,
  source_draft_revision integer,
  validation_id public.product_identifier,
  execution_binding_id public.product_identifier,
  system_catalog_source_id public.product_identifier,
  package_object_id public.product_identifier NOT NULL,
  package_object_kind text COLLATE "C" NOT NULL DEFAULT 'skill_package',
  package_object_hash text COLLATE "C" NOT NULL,
  package_hash text COLLATE "C" NOT NULL,
  validated_draft_content_hash text COLLATE "C",
  content_hash text COLLATE "C" NOT NULL,
  published_by_user_id public.product_identifier,
  published_by_system_principal_id public.product_identifier,
  published_at timestamptz NOT NULL,
  definition jsonb NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, skill_version_id),
  CONSTRAINT skill_versions_skill_fk
    FOREIGN KEY (workspace_id, skill_id)
    REFERENCES public.skill_assets (workspace_id, skill_id),
  CONSTRAINT skill_versions_source_draft_fk
    FOREIGN KEY (workspace_id, skill_id, source_skill_draft_id)
    REFERENCES public.skill_drafts (workspace_id, skill_id, skill_draft_id),
  CONSTRAINT skill_versions_user_publisher_fk
    FOREIGN KEY (workspace_id, published_by_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT skill_versions_system_publisher_fk
    FOREIGN KEY (published_by_system_principal_id)
    REFERENCES public.skill_system_catalog_principals (principal_id),
  CONSTRAINT skill_versions_package_object_fk
    FOREIGN KEY (
      workspace_id, package_object_id, package_object_kind, package_object_hash
    ) REFERENCES public.product_objects (workspace_id, object_id, object_kind, content_hash),
  CONSTRAINT skill_versions_binding_fk
    FOREIGN KEY (
      workspace_id, execution_binding_id, skill_id, source_skill_draft_id,
      source_draft_revision, validation_id, package_object_id,
      package_object_hash, package_hash, validated_draft_content_hash, content_hash
    ) REFERENCES public.skill_execution_bindings (
      workspace_id, execution_binding_id, skill_id, skill_draft_id,
      draft_revision, validation_id, object_id, object_hash, package_hash, content_hash,
      published_version_content_hash
    ),
  CONSTRAINT skill_versions_system_catalog_source_fk
    FOREIGN KEY (
      workspace_id, system_catalog_source_id, skill_id,
      published_by_system_principal_id, package_object_id,
      package_object_hash, package_hash, content_hash
    ) REFERENCES public.skill_system_catalog_sources (
      workspace_id, catalog_source_id, skill_id,
      system_principal_id, package_object_id,
      package_object_hash, package_hash, published_version_content_hash
    ),
  CONSTRAINT skill_versions_skill_identity_uq
    UNIQUE (workspace_id, skill_id, skill_version_id),
  CONSTRAINT skill_versions_version_uq UNIQUE (workspace_id, skill_id, version),
  CONSTRAINT skill_versions_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT skill_versions_source_kind
    CHECK (source_kind IN ('validated_draft', 'system_catalog')),
  CONSTRAINT skill_versions_source_shape CHECK (
    (source_kind = 'validated_draft'
      AND source_skill_draft_id IS NOT NULL
      AND source_draft_revision IS NOT NULL
      AND validation_id IS NOT NULL
      AND execution_binding_id IS NOT NULL
      AND validated_draft_content_hash IS NOT NULL
      AND system_catalog_source_id IS NULL
      AND published_by_user_id IS NOT NULL
      AND published_by_system_principal_id IS NULL)
    OR (source_kind = 'system_catalog'
      AND source_skill_draft_id IS NULL
      AND source_draft_revision IS NULL
      AND validation_id IS NULL
      AND execution_binding_id IS NULL
      AND validated_draft_content_hash IS NULL
      AND system_catalog_source_id IS NOT NULL
      AND published_by_user_id IS NULL
      AND published_by_system_principal_id IS NOT NULL)
  ),
  CONSTRAINT skill_versions_version_nonempty CHECK (length(version) BETWEEN 1 AND 128),
  CONSTRAINT skill_versions_revision_positive CHECK (
    source_draft_revision IS NULL OR source_draft_revision >= 1
  ),
  CONSTRAINT skill_versions_package_object_kind CHECK (package_object_kind = 'skill_package'),
  CONSTRAINT skill_versions_hash_formats CHECK (
    package_object_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND package_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND (
      validated_draft_content_hash IS NULL
      OR validated_draft_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    )
    AND content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT skill_versions_definition_object CHECK (jsonb_typeof(definition) = 'object'),
  CONSTRAINT skill_versions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX skill_versions_skill_published_idx
  ON public.skill_versions (workspace_id, skill_id, published_at DESC, skill_version_id);

ALTER TABLE public.skill_drafts
  ADD CONSTRAINT skill_drafts_base_version_fk
  FOREIGN KEY (workspace_id, skill_id, base_version_id)
  REFERENCES public.skill_versions (workspace_id, skill_id, skill_version_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.skill_assets
  ADD CONSTRAINT skill_assets_current_draft_fk
  FOREIGN KEY (workspace_id, skill_id, current_draft_id)
  REFERENCES public.skill_drafts (workspace_id, skill_id, skill_draft_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.skill_assets
  ADD CONSTRAINT skill_assets_latest_version_fk
  FOREIGN KEY (workspace_id, skill_id, latest_published_version_id)
  REFERENCES public.skill_versions (workspace_id, skill_id, skill_version_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public.require_enabled_catalog_principal_for_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  current_status text;
BEGIN
  SELECT status INTO current_status
  FROM public.skill_system_catalog_principals
  WHERE principal_id = NEW.system_principal_id
  FOR UPDATE;
  IF NOT FOUND OR current_status <> 'enabled' THEN
    RAISE EXCEPTION 'system_catalog_principal_not_enabled: %', NEW.system_principal_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER skill_system_catalog_sources_require_enabled_principal
  BEFORE INSERT ON public.skill_system_catalog_sources
  FOR EACH ROW EXECUTE FUNCTION public.require_enabled_catalog_principal_for_source();

CREATE FUNCTION public.require_enabled_catalog_principal_for_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  current_status text;
BEGIN
  SELECT status INTO current_status
  FROM public.skill_system_catalog_principals
  WHERE principal_id = NEW.published_by_system_principal_id
  FOR UPDATE;
  IF NOT FOUND OR current_status <> 'enabled' THEN
    RAISE EXCEPTION 'system_catalog_principal_not_enabled: %', NEW.published_by_system_principal_id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER skill_versions_require_enabled_system_principal
  BEFORE INSERT ON public.skill_versions
  FOR EACH ROW
  WHEN (NEW.source_kind = 'system_catalog')
  EXECUTE FUNCTION public.require_enabled_catalog_principal_for_version();

CREATE FUNCTION public.require_skill_version_authoritative_definition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  authoritative_definition jsonb;
BEGIN
  IF NEW.source_kind = 'validated_draft' THEN
    SELECT definition INTO authoritative_definition
    FROM public.skill_draft_revision_snapshots
    WHERE workspace_id = NEW.workspace_id
      AND skill_id = NEW.skill_id
      AND skill_draft_id = NEW.source_skill_draft_id
      AND draft_revision = NEW.source_draft_revision;
  ELSIF NEW.source_kind = 'system_catalog' THEN
    SELECT definition INTO authoritative_definition
    FROM public.skill_system_catalog_sources
    WHERE workspace_id = NEW.workspace_id
      AND catalog_source_id = NEW.system_catalog_source_id
      AND skill_id = NEW.skill_id
      AND system_principal_id = NEW.published_by_system_principal_id;
  END IF;

  IF FOUND AND NEW.definition IS DISTINCT FROM authoritative_definition THEN
    RAISE EXCEPTION 'skill_version_definition_not_authoritative: %', NEW.skill_version_id
      USING ERRCODE = '23514', CONSTRAINT = 'skill_versions_definition_authority';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER skill_versions_require_authoritative_definition
  BEFORE INSERT ON public.skill_versions
  FOR EACH ROW EXECUTE FUNCTION public.require_skill_version_authoritative_definition();

CREATE FUNCTION public.enforce_skill_asset_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.lifecycle = OLD.lifecycle
    OR NEW.lifecycle NOT IN ('draft', 'validating', 'tested', 'published', 'deprecated', 'archived')
  THEN
    RETURN NEW;
  END IF;

  IF (CASE OLD.lifecycle
    WHEN 'draft' THEN NEW.lifecycle = 'validating'
    WHEN 'validating' THEN NEW.lifecycle IN ('draft', 'tested')
    WHEN 'tested' THEN NEW.lifecycle IN ('draft', 'published')
    WHEN 'published' THEN NEW.lifecycle = 'deprecated'
    WHEN 'deprecated' THEN NEW.lifecycle = 'archived'
    ELSE false
  END) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'skill_asset_lifecycle_transition_forbidden: % -> %', OLD.lifecycle, NEW.lifecycle
    USING ERRCODE = '23514', CONSTRAINT = 'skill_assets_lifecycle_transition';
END;
$function$;

CREATE TRIGGER skill_assets_enforce_lifecycle_transition
  BEFORE UPDATE OF lifecycle ON public.skill_assets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_skill_asset_lifecycle_transition();

CREATE FUNCTION public.reject_terminal_skill_test_run_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF OLD.status IN ('passed', 'failed', 'blocked', 'cancelled') THEN
    RAISE EXCEPTION 'terminal_skill_test_run_mutation_forbidden: %', OLD.test_run_id
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER skill_test_runs_terminal_immutable
  BEFORE UPDATE OR DELETE ON public.skill_test_runs
  FOR EACH ROW EXECUTE FUNCTION public.reject_terminal_skill_test_run_mutation();

CREATE FUNCTION public.reject_immutable_skill_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'immutable_skill_history_mutation_forbidden: %', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER skill_draft_revision_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.skill_draft_revision_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_skill_history_mutation();

CREATE TRIGGER skill_validation_test_runs_immutable
  BEFORE UPDATE OR DELETE ON public.skill_validation_test_runs
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_skill_history_mutation();

CREATE TRIGGER skill_test_evidence_immutable
  BEFORE UPDATE OR DELETE ON public.skill_test_evidence
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_skill_history_mutation();

CREATE TRIGGER skill_validations_immutable
  BEFORE UPDATE OR DELETE ON public.skill_validations
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_skill_history_mutation();

CREATE TRIGGER skill_execution_bindings_immutable
  BEFORE UPDATE OR DELETE ON public.skill_execution_bindings
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_skill_history_mutation();

CREATE TRIGGER skill_system_catalog_sources_immutable
  BEFORE UPDATE OR DELETE ON public.skill_system_catalog_sources
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_skill_history_mutation();

CREATE TRIGGER skill_versions_immutable
  BEFORE UPDATE OR DELETE ON public.skill_versions
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_skill_history_mutation();

-- G2 B2: Loop/Library canonical families. Relationship tables below are
-- normalized edges of these families, not separate product aggregates.

ALTER TABLE public.skill_versions
  ADD CONSTRAINT skill_versions_loop_pin_authority_uq
  UNIQUE (workspace_id, skill_id, skill_version_id, version, content_hash);

ALTER TABLE public.workspace_resources
  ADD CONSTRAINT workspace_resources_loop_pin_authority_uq
  UNIQUE (workspace_id, resource_id, resource_version, content_hash);

CREATE TABLE public.templates (
  template_id public.product_identifier NOT NULL,
  template_version text COLLATE "C" NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  category text COLLATE "C" NOT NULL,
  display jsonb NOT NULL,
  input_form jsonb NOT NULL,
  graph jsonb NOT NULL,
  included_skills jsonb NOT NULL,
  expected_outputs jsonb NOT NULL,
  review_policy jsonb NOT NULL,
  availability_status text COLLATE "C" NOT NULL,
  availability_diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (template_id, template_version),
  CONSTRAINT templates_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT templates_version_nonempty CHECK (length(template_version) BETWEEN 1 AND 128),
  CONSTRAINT templates_text_lengths CHECK (
    length(name) BETWEEN 1 AND 200
    AND length(description) BETWEEN 1 AND 2000
    AND length(category) BETWEEN 1 AND 100
  ),
  CONSTRAINT templates_availability CHECK (
    availability_status IN ('available', 'blocked', 'incompatible')
  ),
  CONSTRAINT templates_documents CHECK (
    jsonb_typeof(display) = 'object'
    AND jsonb_typeof(input_form) = 'object'
    AND jsonb_typeof(graph) = 'object'
    AND jsonb_typeof(included_skills) = 'array'
    AND jsonb_typeof(expected_outputs) = 'array'
    AND jsonb_array_length(expected_outputs) >= 1
    AND jsonb_typeof(review_policy) = 'object'
    AND jsonb_typeof(availability_diagnostics) = 'array'
  ),
  CONSTRAINT templates_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX templates_catalog_idx
  ON public.templates (category, availability_status, template_id, template_version);

CREATE TABLE public.workflows (
  workspace_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  owner_user_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text COLLATE "C" NOT NULL,
  lifecycle text COLLATE "C" NOT NULL,
  visibility text COLLATE "C" NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  current_revision_id public.product_identifier NOT NULL,
  current_revision_number integer NOT NULL,
  write_version integer NOT NULL DEFAULT 1,
  source_template_id public.product_identifier,
  source_template_version text COLLATE "C",
  source_workflow_id public.product_identifier,
  source_workflow_revision_id public.product_identifier,
  source_release_workspace_id public.product_identifier,
  source_release_id public.product_identifier,
  source_release_version_id public.product_identifier,
  source_release_asset_kind text COLLATE "C" GENERATED ALWAYS AS (
    CASE WHEN source_release_id IS NULL THEN NULL ELSE 'loop' END
  ) STORED,
  latest_compile_result_id public.product_identifier,
  latest_run_id public.product_identifier,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, workflow_id),
  CONSTRAINT workflows_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT workflows_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT workflows_owner_fk
    FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT workflows_template_fk
    FOREIGN KEY (source_template_id, source_template_version)
    REFERENCES public.templates (template_id, template_version),
  CONSTRAINT workflows_revision_pointer_uq UNIQUE (
    workspace_id, workflow_id, current_revision_id, current_revision_number
  ),
  CONSTRAINT workflows_scope_identity_uq UNIQUE (
    workspace_id, workflow_id, scope_id
  ),
  CONSTRAINT workflows_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT workflows_name_length CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT workflows_description_length CHECK (length(description) <= 2000),
  CONSTRAINT workflows_status CHECK (status IN ('draft', 'ready', 'blocked')),
  CONSTRAINT workflows_lifecycle CHECK (
    lifecycle IN ('draft', 'ready', 'shared', 'blocked', 'deprecated')
  ),
  CONSTRAINT workflows_visibility CHECK (visibility IN ('private', 'workspace')),
  CONSTRAINT workflows_visibility_lifecycle CHECK (
    (visibility = 'workspace' AND lifecycle IN ('shared', 'deprecated'))
    OR (visibility = 'private' AND lifecycle IN ('draft', 'ready', 'blocked'))
  ),
  CONSTRAINT workflows_ready_shared CHECK (lifecycle <> 'shared' OR status = 'ready'),
  CONSTRAINT workflows_private_draft_shape CHECK (
    lifecycle <> 'draft' OR (visibility = 'private' AND status = 'draft')
  ),
  CONSTRAINT workflows_revision_cas_positive CHECK (
    current_revision_number >= 1 AND write_version >= 1
  ),
  CONSTRAINT workflows_source_template_shape CHECK (
    (source_template_id IS NULL) = (source_template_version IS NULL)
  ),
  CONSTRAINT workflows_source_workflow_shape CHECK (
    (source_workflow_id IS NULL) = (source_workflow_revision_id IS NULL)
  ),
  CONSTRAINT workflows_source_release_shape CHECK (
    (source_release_workspace_id IS NULL
      AND source_release_id IS NULL
      AND source_release_version_id IS NULL)
    OR (source_release_workspace_id IS NOT NULL
      AND source_release_id IS NOT NULL
      AND source_release_version_id IS NOT NULL)
  ),
  CONSTRAINT workflows_source_release_workspace CHECK (
    source_release_workspace_id IS NULL OR source_release_workspace_id = workspace_id
  ),
  CONSTRAINT workflows_not_self_source CHECK (
    source_workflow_id IS NULL OR source_workflow_id <> workflow_id
  ),
  CONSTRAINT workflows_time_order CHECK (updated_at >= created_at),
  CONSTRAINT workflows_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX workflows_workspace_lifecycle_updated_idx
  ON public.workflows (workspace_id, lifecycle, updated_at DESC, workflow_id);
CREATE INDEX workflows_workspace_owner_visibility_updated_idx
  ON public.workflows (workspace_id, owner_user_id, visibility, updated_at DESC, workflow_id);
CREATE INDEX workflows_workspace_status_archived_updated_idx
  ON public.workflows (workspace_id, status, archived, updated_at DESC, workflow_id);

CREATE TRIGGER workflows_scope_immutable
  BEFORE UPDATE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.enforce_root_scope_immutable();

CREATE TABLE public.workflow_revisions (
  workspace_id public.product_identifier NOT NULL,
  revision_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  revision_number integer NOT NULL,
  base_revision_id public.product_identifier,
  base_revision_number integer,
  schema_version text COLLATE "C" NOT NULL,
  graph jsonb NOT NULL,
  input_form jsonb NOT NULL,
  output_definition jsonb NOT NULL,
  resource_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_settings jsonb NOT NULL,
  definition jsonb,
  content_hash text COLLATE "C" NOT NULL,
  authored_by public.product_identifier NOT NULL,
  save_reason text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, revision_id),
  CONSTRAINT workflow_revisions_workflow_fk
    FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES public.workflows (workspace_id, workflow_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT workflow_revisions_author_fk
    FOREIGN KEY (workspace_id, authored_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT workflow_revisions_number_uq
    UNIQUE (workspace_id, workflow_id, revision_number),
  CONSTRAINT workflow_revisions_identity_uq
    UNIQUE (workspace_id, workflow_id, revision_id),
  CONSTRAINT workflow_revisions_pointer_uq
    UNIQUE (workspace_id, workflow_id, revision_id, revision_number),
  CONSTRAINT workflow_revisions_content_uq
    UNIQUE (workspace_id, workflow_id, revision_id, content_hash),
  CONSTRAINT workflow_revisions_base_fk
    FOREIGN KEY (
      workspace_id, workflow_id, base_revision_id, base_revision_number
    ) REFERENCES public.workflow_revisions (
      workspace_id, workflow_id, revision_id, revision_number
    ),
  CONSTRAINT workflow_revisions_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT workflow_revisions_number_positive CHECK (revision_number >= 1),
  CONSTRAINT workflow_revisions_base_shape CHECK (
    (revision_number = 1
      AND base_revision_id IS NULL
      AND base_revision_number IS NULL)
    OR (revision_number > 1
      AND base_revision_id IS NOT NULL
      AND base_revision_number IS NOT NULL
      AND base_revision_number = revision_number - 1)
  ),
  CONSTRAINT workflow_revisions_not_self_base CHECK (
    base_revision_id IS NULL OR base_revision_id <> revision_id
  ),
  CONSTRAINT workflow_revisions_hash_format
    CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT workflow_revisions_documents CHECK (
    jsonb_typeof(graph) = 'object'
    AND jsonb_typeof(input_form) = 'object'
    AND jsonb_typeof(output_definition) = 'object'
    AND jsonb_typeof(resource_refs) = 'array'
    AND jsonb_typeof(run_settings) = 'object'
    AND (definition IS NULL OR jsonb_typeof(definition) = 'object')
  ),
  CONSTRAINT workflow_revisions_save_reason_length
    CHECK (length(save_reason) BETWEEN 1 AND 1000),
  CONSTRAINT workflow_revisions_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX workflow_revisions_workflow_number_idx
  ON public.workflow_revisions (workspace_id, workflow_id, revision_number DESC);

ALTER TABLE public.workflows
  ADD CONSTRAINT workflows_current_revision_fk
  FOREIGN KEY (workspace_id, workflow_id, current_revision_id, current_revision_number)
  REFERENCES public.workflow_revisions (
    workspace_id, workflow_id, revision_id, revision_number
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.workflows
  ADD CONSTRAINT workflows_source_workflow_fk
  FOREIGN KEY (workspace_id, source_workflow_id, source_workflow_revision_id)
  REFERENCES public.workflow_revisions (workspace_id, workflow_id, revision_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.workspace_connections (
  workspace_id public.product_identifier NOT NULL,
  connection_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  created_by public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  label text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  current_revision_id public.product_identifier NOT NULL,
  current_revision_number integer NOT NULL,
  write_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, connection_id),
  CONSTRAINT workspace_connections_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT workspace_connections_creator_fk
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT workspace_connections_scope_identity_uq
    UNIQUE (workspace_id, connection_id, scope_id),
  CONSTRAINT workspace_connections_label_uq UNIQUE (workspace_id, label),
  CONSTRAINT workspace_connections_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT workspace_connections_label_length CHECK (length(label) BETWEEN 1 AND 200),
  CONSTRAINT workspace_connections_revision_positive CHECK (
    current_revision_number >= 1 AND write_version >= 1
  ),
  CONSTRAINT workspace_connections_time_order CHECK (updated_at >= created_at),
  CONSTRAINT workspace_connections_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX workspace_connections_enabled_updated_idx
  ON public.workspace_connections (workspace_id, enabled, updated_at DESC, connection_id);

CREATE TABLE public.workspace_connection_revisions (
  workspace_id public.product_identifier NOT NULL,
  connection_revision_id public.product_identifier NOT NULL,
  connection_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  revision_number integer NOT NULL,
  base_revision_id public.product_identifier,
  base_revision_number integer,
  schema_version text COLLATE "C" NOT NULL,
  capability_key text COLLATE "C" NOT NULL,
  driver_key text COLLATE "C" NOT NULL,
  driver_backend text COLLATE "C" NOT NULL,
  safe_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_state text COLLATE "C" NOT NULL,
  secret_binding_id public.product_identifier,
  credential_binding_fingerprint text COLLATE "C",
  readiness_status text COLLATE "C" NOT NULL,
  validation_status text COLLATE "C" NOT NULL,
  validation_message text NOT NULL,
  validation_principal text,
  validation_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation_checked_at timestamptz,
  validation_expires_at timestamptz,
  content_hash text COLLATE "C" NOT NULL,
  created_by public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, connection_revision_id),
  CONSTRAINT workspace_connection_revisions_connection_fk
    FOREIGN KEY (workspace_id, connection_id, scope_id)
    REFERENCES public.workspace_connections (workspace_id, connection_id, scope_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT workspace_connection_revisions_secret_binding_fk
    FOREIGN KEY (workspace_id, secret_binding_id)
    REFERENCES public.secret_bindings (workspace_id, secret_binding_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT workspace_connection_revisions_creator_fk
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT workspace_connection_revisions_number_uq
    UNIQUE (workspace_id, connection_id, revision_number),
  CONSTRAINT workspace_connection_revisions_pointer_uq
    UNIQUE (workspace_id, connection_id, connection_revision_id, revision_number),
  CONSTRAINT workspace_connection_revisions_base_fk
    FOREIGN KEY (workspace_id, connection_id, base_revision_id, base_revision_number)
    REFERENCES public.workspace_connection_revisions (
      workspace_id, connection_id, connection_revision_id, revision_number
    ),
  CONSTRAINT workspace_connection_revisions_schema_version
    CHECK (schema_version = 'workbench-connection-v1'),
  CONSTRAINT workspace_connection_revisions_number_positive CHECK (revision_number >= 1),
  CONSTRAINT workspace_connection_revisions_base_shape CHECK (
    (revision_number = 1 AND base_revision_id IS NULL AND base_revision_number IS NULL)
    OR (revision_number > 1
      AND base_revision_id IS NOT NULL
      AND base_revision_number = revision_number - 1)
  ),
  CONSTRAINT workspace_connection_revisions_not_self_base
    CHECK (base_revision_id IS NULL OR base_revision_id <> connection_revision_id),
  CONSTRAINT workspace_connection_revisions_keys CHECK (
    length(capability_key) BETWEEN 1 AND 128
    AND length(driver_key) BETWEEN 1 AND 128
  ),
  CONSTRAINT workspace_connection_revisions_driver_backend CHECK (
    driver_backend IN ('production', 'test')
  ),
  CONSTRAINT workspace_connection_revisions_credential_state CHECK (
    credential_state IN ('unbound', 'bound', 'expired')
  ),
  CONSTRAINT workspace_connection_revisions_readiness_status CHECK (
    readiness_status IN ('connected', 'needs_setup', 'checking')
  ),
  CONSTRAINT workspace_connection_revisions_validation_status CHECK (
    validation_status IN ('never_checked', 'checking', 'valid', 'invalid')
  ),
  CONSTRAINT workspace_connection_revisions_binding_shape CHECK (
    (credential_state = 'unbound'
      AND secret_binding_id IS NULL
      AND credential_binding_fingerprint IS NULL)
    OR (credential_state IN ('bound', 'expired')
      AND secret_binding_id IS NOT NULL
      AND credential_binding_fingerprint IS NOT NULL)
  ),
  CONSTRAINT workspace_connection_revisions_connected_shape CHECK (
    readiness_status <> 'connected'
    OR (
      credential_state = 'bound'
      AND validation_status = 'valid'
      AND validation_checked_at IS NOT NULL
      AND credential_binding_fingerprint IS NOT NULL
    )
  ),
  CONSTRAINT workspace_connection_revisions_validation_shape CHECK (
    (validation_status IN ('never_checked', 'checking') AND validation_checked_at IS NULL)
    OR (validation_status IN ('valid', 'invalid') AND validation_checked_at IS NOT NULL)
  ),
  CONSTRAINT workspace_connection_revisions_hash_format CHECK (
    content_hash ~ '^sha256:[0-9a-f]{64}$'
    AND (credential_binding_fingerprint IS NULL
      OR credential_binding_fingerprint ~ '^sha256:[0-9a-f]{64}$')
  ),
  CONSTRAINT workspace_connection_revisions_documents CHECK (
    jsonb_typeof(safe_configuration) = 'object'
    AND jsonb_typeof(validation_scopes) = 'array'
    AND jsonb_typeof(validation_effects) = 'array'
    AND jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT workspace_connection_revisions_safe_configuration CHECK (
    safe_configuration - ARRAY['accountLabel', 'permissionSummary']::text[] = '{}'::jsonb
    AND (
      NOT safe_configuration ? 'accountLabel'
      OR (
        jsonb_typeof(safe_configuration -> 'accountLabel') = 'string'
        AND length(safe_configuration ->> 'accountLabel') BETWEEN 1 AND 200
      )
    )
    AND (
      NOT safe_configuration ? 'permissionSummary'
      OR (
        jsonb_typeof(safe_configuration -> 'permissionSummary') = 'string'
        AND length(safe_configuration ->> 'permissionSummary') BETWEEN 1 AND 1000
      )
    )
  ),
  CONSTRAINT workspace_connection_revisions_validation_expiry_order CHECK (
    validation_expires_at IS NULL
    OR (validation_checked_at IS NOT NULL AND validation_expires_at > validation_checked_at)
  )
);

CREATE INDEX workspace_connection_revisions_capability_readiness_idx
  ON public.workspace_connection_revisions (
    workspace_id, capability_key, readiness_status, connection_id, revision_number DESC
  );

ALTER TABLE public.workspace_connections
  ADD CONSTRAINT workspace_connections_current_revision_fk
  FOREIGN KEY (
    workspace_id, connection_id, current_revision_id, current_revision_number
  ) REFERENCES public.workspace_connection_revisions (
    workspace_id, connection_id, connection_revision_id, revision_number
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION public.enforce_workspace_connection_root_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workspace_connection_delete_forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
      NEW.workspace_id, NEW.connection_id, NEW.scope_id, NEW.created_by,
      NEW.schema_version, NEW.label, NEW.created_at, NEW.payload
    ) IS DISTINCT FROM ROW(
      OLD.workspace_id, OLD.connection_id, OLD.scope_id, OLD.created_by,
      OLD.schema_version, OLD.label, OLD.created_at, OLD.payload
    ) THEN
    RAISE EXCEPTION 'workspace_connection_identity_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.enabled, NEW.current_revision_id, NEW.current_revision_number)
      IS DISTINCT FROM ROW(OLD.enabled, OLD.current_revision_id, OLD.current_revision_number)
    AND NEW.write_version <> OLD.write_version + 1 THEN
    RAISE EXCEPTION 'workspace_connection_write_version_required'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.write_version < OLD.write_version
    OR NEW.current_revision_number < OLD.current_revision_number
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'workspace_connection_revision_regression'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
    AND NEW.current_revision_number <> OLD.current_revision_number + 1 THEN
    RAISE EXCEPTION 'workspace_connection_direct_revision_required'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_connections_revision_guard
  BEFORE UPDATE OR DELETE ON public.workspace_connections
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_connection_root_revision();

CREATE TRIGGER workspace_connection_revisions_immutable
  BEFORE UPDATE OR DELETE ON public.workspace_connection_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_governance_revision_mutation();

CREATE FUNCTION public.validate_connection_secret_binding_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  affected_binding_id public.product_identifier;
  invalid boolean;
BEGIN
  affected_binding_id := CASE
    WHEN TG_TABLE_NAME = 'workspace_connection_revisions'
      THEN (to_jsonb(NEW) ->> 'secret_binding_id')::public.product_identifier
    WHEN to_jsonb(NEW) ->> 'owner_kind' = 'connection'
      THEN (to_jsonb(NEW) ->> 'secret_binding_id')::public.product_identifier
    ELSE NULL
  END;
  IF affected_binding_id IS NULL THEN RETURN NEW; END IF;

  SELECT NOT EXISTS (
    SELECT 1
    FROM public.secret_bindings binding
    JOIN public.workspace_connections connection
      ON connection.workspace_id = binding.workspace_id
     AND connection.connection_id = binding.owner_id
     AND connection.scope_id = binding.scope_id
    JOIN public.workspace_connection_revisions revision
      ON revision.workspace_id = connection.workspace_id
     AND revision.connection_id = connection.connection_id
     AND revision.secret_binding_id = binding.secret_binding_id
     AND revision.credential_binding_fingerprint = binding.credential_fingerprint
    WHERE binding.workspace_id = NEW.workspace_id
      AND binding.secret_binding_id = affected_binding_id
      AND binding.owner_kind = 'connection'
  ) INTO invalid;
  IF invalid THEN
    RAISE EXCEPTION 'workspace_connection_secret_binding_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER workspace_connection_revisions_secret_owner_guard
  AFTER INSERT ON public.workspace_connection_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_connection_secret_binding_aggregate();

CREATE CONSTRAINT TRIGGER secret_bindings_connection_owner_guard
  AFTER INSERT OR UPDATE ON public.secret_bindings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_connection_secret_binding_aggregate();

CREATE FUNCTION public.validate_workspace_connection_revision_readiness()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  canonical_effects jsonb;
  string_effect_count integer;
BEGIN
  IF jsonb_typeof(NEW.validation_effects) <> 'array' THEN
    RAISE EXCEPTION 'workspace_connection_validation_effects_not_canonical'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) FILTER (WHERE jsonb_typeof(effect) = 'string'),
    COALESCE(jsonb_agg(to_jsonb(effect_text) ORDER BY effect_text), '[]'::jsonb)
  INTO string_effect_count, canonical_effects
  FROM (
    SELECT DISTINCT effect, effect #>> '{}' AS effect_text
    FROM jsonb_array_elements(NEW.validation_effects) AS effect
    WHERE jsonb_typeof(effect) = 'string'
      AND length(effect #>> '{}') BETWEEN 1 AND 128
  ) canonical;
  IF string_effect_count <> jsonb_array_length(NEW.validation_effects)
    OR NEW.validation_effects IS DISTINCT FROM canonical_effects THEN
    RAISE EXCEPTION 'workspace_connection_validation_effects_not_canonical'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.secret_binding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.secret_bindings binding
    WHERE binding.workspace_id = NEW.workspace_id
      AND binding.secret_binding_id = NEW.secret_binding_id
      AND binding.scope_id = NEW.scope_id
      AND binding.owner_kind = 'connection'
      AND binding.owner_id = NEW.connection_id
      AND NEW.credential_binding_fingerprint = binding.credential_fingerprint
      AND (
        NEW.readiness_status <> 'connected'
        OR (binding.secret_source = 'cloud_secret_store'
          AND binding.status = 'active'
          AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp()))
      )
  ) THEN
    RAISE EXCEPTION 'workspace_connection_secret_binding_not_ready'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.readiness_status = 'connected' AND (
    NEW.validation_checked_at IS NULL
    OR NEW.validation_checked_at > clock_timestamp()
    OR (NEW.validation_expires_at IS NOT NULL
      AND NEW.validation_expires_at <= clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'workspace_connection_validation_not_fresh'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_connection_revisions_readiness_guard
  BEFORE INSERT ON public.workspace_connection_revisions
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_connection_revision_readiness();

CREATE FUNCTION public.assert_workspace_connection_consumable(
  consumer_workspace_id public.product_identifier,
  consumer_scope_id public.product_identifier,
  selected_connection_id public.product_identifier,
  required_capability_key text DEFAULT NULL,
  required_effects jsonb DEFAULT '[]'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM 1
  FROM public.workspace_connections connection
  JOIN public.workspace_connection_revisions revision
    ON revision.workspace_id = connection.workspace_id
   AND revision.connection_id = connection.connection_id
   AND revision.connection_revision_id = connection.current_revision_id
   AND revision.revision_number = connection.current_revision_number
  JOIN public.secret_bindings binding
    ON binding.workspace_id = revision.workspace_id
   AND binding.secret_binding_id = revision.secret_binding_id
   AND binding.scope_id = revision.scope_id
   AND binding.owner_kind = 'connection'
   AND binding.owner_id = revision.connection_id
   AND binding.credential_fingerprint = revision.credential_binding_fingerprint
  JOIN public.product_scopes consumer_scope
    ON consumer_scope.workspace_id = consumer_workspace_id
   AND consumer_scope.scope_id = consumer_scope_id
   AND consumer_scope.status = 'active'
  WHERE connection.workspace_id = consumer_workspace_id
    AND connection.connection_id = selected_connection_id
    AND connection.scope_id = consumer_scope_id
    AND connection.enabled
    AND revision.scope_id = consumer_scope_id
    AND revision.driver_backend = 'production'
    AND revision.credential_state = 'bound'
    AND revision.readiness_status = 'connected'
    AND revision.validation_status = 'valid'
    AND (required_capability_key IS NULL
      OR revision.capability_key = required_capability_key)
    AND revision.validation_effects @> required_effects
    AND revision.validation_checked_at IS NOT NULL
    AND revision.validation_checked_at <= clock_timestamp()
    AND (revision.validation_expires_at IS NULL
      OR revision.validation_expires_at > clock_timestamp())
    AND binding.secret_source = 'cloud_secret_store'
    AND binding.status = 'active'
    AND binding.probed_at IS NOT NULL
    AND binding.probed_at <= clock_timestamp()
    AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
  FOR SHARE OF connection, binding, consumer_scope;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workspace_connection_not_consumable: %', selected_connection_id
      USING ERRCODE = '23514';
  END IF;
END;
$function$;

CREATE TABLE public.compile_results (
  workspace_id public.product_identifier NOT NULL,
  compile_result_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  workflow_revision_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  execution_plan_id public.product_identifier,
  plan_pins_finalized boolean GENERATED ALWAYS AS (
    CASE WHEN execution_plan_id IS NULL THEN NULL ELSE true END
  ) STORED,
  ordered_steps jsonb NOT NULL,
  required_run_inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_resources jsonb NOT NULL DEFAULT '[]'::jsonb,
  unavailable_skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  orphan_node_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  unreachable_node_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  invalid_cycles jsonb NOT NULL DEFAULT '[]'::jsonb,
  port_schema_mismatches jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_gates jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_nodes jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  recovery_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  compiled_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, compile_result_id),
  CONSTRAINT compile_results_revision_fk
    FOREIGN KEY (workspace_id, workflow_id, workflow_revision_id)
    REFERENCES public.workflow_revisions (workspace_id, workflow_id, revision_id),
  CONSTRAINT compile_results_plan_uq UNIQUE (workspace_id, execution_plan_id),
  CONSTRAINT compile_results_revision_identity_uq UNIQUE (
    workspace_id, compile_result_id, workflow_id, workflow_revision_id
  ),
  CONSTRAINT compile_results_authority_uq UNIQUE (
    workspace_id, compile_result_id, execution_plan_id,
    workflow_id, workflow_revision_id, status
  ),
  CONSTRAINT compile_results_plan_projection_uq UNIQUE (
    workspace_id, compile_result_id, execution_plan_id,
    workflow_id, workflow_revision_id, status, ordered_steps, review_gates
  ),
  CONSTRAINT compile_results_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT compile_results_status CHECK (status IN ('ready', 'blocked', 'invalid')),
  CONSTRAINT compile_results_plan_shape CHECK (
    (status = 'ready' AND execution_plan_id IS NOT NULL)
    OR (status IN ('blocked', 'invalid') AND execution_plan_id IS NULL)
  ),
  CONSTRAINT compile_results_documents CHECK (
    jsonb_typeof(ordered_steps) = 'array'
    AND jsonb_typeof(required_run_inputs) = 'array'
    AND jsonb_typeof(missing_bindings) = 'array'
    AND jsonb_typeof(missing_resources) = 'array'
    AND jsonb_typeof(unavailable_skills) = 'array'
    AND jsonb_typeof(orphan_node_ids) = 'array'
    AND jsonb_typeof(unreachable_node_ids) = 'array'
    AND jsonb_typeof(invalid_cycles) = 'array'
    AND jsonb_typeof(port_schema_mismatches) = 'array'
    AND jsonb_typeof(review_gates) = 'array'
    AND jsonb_typeof(output_nodes) = 'array'
    AND jsonb_typeof(warnings) = 'array'
    AND jsonb_typeof(recovery_actions) = 'array'
    AND jsonb_typeof(payload) = 'object'
  )
);

CREATE INDEX compile_results_revision_latest_idx
  ON public.compile_results (
    workspace_id, workflow_revision_id, compiled_at DESC, compile_result_id DESC
  );

CREATE TABLE public.execution_plans (
  workspace_id public.product_identifier NOT NULL,
  plan_id public.product_identifier NOT NULL,
  compile_result_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  workflow_revision_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  plan_version integer NOT NULL,
  compile_status text COLLATE "C" GENERATED ALWAYS AS ('ready') STORED,
  content_hash text COLLATE "C" NOT NULL,
  model_routing_state text COLLATE "C" NOT NULL,
  plan_document jsonb NOT NULL,
  ordered_steps jsonb GENERATED ALWAYS AS (
    jsonb_path_query_array(plan_document, '$.steps[*].nodeId')
  ) STORED,
  review_gates jsonb GENERATED ALWAYS AS (
    jsonb_path_query_array(plan_document, '$.reviewGates[*].nodeId')
  ) STORED,
  pins_finalized boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, plan_id),
  CONSTRAINT execution_plans_revision_fk
    FOREIGN KEY (workspace_id, workflow_id, workflow_revision_id)
    REFERENCES public.workflow_revisions (workspace_id, workflow_id, revision_id),
  CONSTRAINT execution_plans_compile_result_uq UNIQUE (workspace_id, compile_result_id),
  CONSTRAINT execution_plans_authority_uq UNIQUE (
    workspace_id, plan_id, compile_result_id, workflow_id, workflow_revision_id
  ),
  CONSTRAINT execution_plans_finalized_authority_uq UNIQUE (
    workspace_id, plan_id, compile_result_id, workflow_id,
    workflow_revision_id, pins_finalized
  ),
  CONSTRAINT execution_plans_schema_version
    CHECK (schema_version = 'workbench-execution-plan-v2'),
  CONSTRAINT execution_plans_plan_version CHECK (plan_version = 2),
  CONSTRAINT execution_plans_hash_format
    CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT execution_plans_model_routing_state CHECK (
    model_routing_state IN ('pinned', 'legacy_unpinned', 'not_applicable')
  ),
  CONSTRAINT execution_plans_document_coherence CHECK (
    jsonb_typeof(plan_document) = 'object'
    AND plan_document ?& ARRAY[
      'schemaVersion', 'planVersion', 'workflowId', 'workflowRevisionId',
      'generatedAt', 'contentHash', 'maxParallelism', 'modelRoutingState',
      'pinnedSkills', 'steps', 'reviewGates', 'primaryOutput'
    ]::text[]
    AND jsonb_typeof(plan_document -> 'schemaVersion') = 'string'
    AND jsonb_typeof(plan_document -> 'planVersion') = 'string'
    AND jsonb_typeof(plan_document -> 'workflowId') = 'string'
    AND jsonb_typeof(plan_document -> 'workflowRevisionId') = 'string'
    AND jsonb_typeof(plan_document -> 'generatedAt') = 'string'
    AND jsonb_typeof(plan_document -> 'contentHash') = 'string'
    AND jsonb_typeof(plan_document -> 'modelRoutingState') = 'string'
    AND plan_document ->> 'schemaVersion' = schema_version
    AND plan_document ->> 'planVersion' = plan_version::text
    AND plan_document ->> 'workflowId' = workflow_id
    AND plan_document ->> 'workflowRevisionId' = workflow_revision_id
    AND plan_document ->> 'contentHash' = content_hash
    AND plan_document ->> 'modelRoutingState' = model_routing_state
    AND (plan_document ->> 'generatedAt')::timestamptz = generated_at
    AND jsonb_typeof(plan_document -> 'maxParallelism') = 'number'
    AND jsonb_typeof(plan_document -> 'pinnedSkills') = 'array'
    AND jsonb_typeof(plan_document -> 'steps') = 'array'
    AND jsonb_array_length(plan_document -> 'steps') >= 1
    AND jsonb_typeof(plan_document -> 'reviewGates') = 'array'
    AND jsonb_typeof(plan_document -> 'primaryOutput') = 'object'
    AND jsonb_typeof(ordered_steps) = 'array'
    AND jsonb_typeof(review_gates) = 'array'
  ),
  CONSTRAINT execution_plans_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

ALTER TABLE public.compile_results
  ADD CONSTRAINT compile_results_execution_plan_fk
  FOREIGN KEY (
    workspace_id, execution_plan_id, compile_result_id,
    workflow_id, workflow_revision_id, plan_pins_finalized
  ) REFERENCES public.execution_plans (
    workspace_id, plan_id, compile_result_id, workflow_id,
    workflow_revision_id, pins_finalized
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.execution_plans
  ADD CONSTRAINT execution_plans_compile_result_fk
  FOREIGN KEY (
    workspace_id, compile_result_id, plan_id,
    workflow_id, workflow_revision_id, compile_status, ordered_steps, review_gates
  ) REFERENCES public.compile_results (
    workspace_id, compile_result_id, execution_plan_id,
    workflow_id, workflow_revision_id, status, ordered_steps, review_gates
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.execution_plan_model_pins (
  workspace_id public.product_identifier NOT NULL,
  plan_id public.product_identifier NOT NULL,
  node_id public.product_identifier NOT NULL,
  pin_role text COLLATE "C" NOT NULL,
  ordinal integer NOT NULL,
  model_profile_revision_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, plan_id, node_id, pin_role, ordinal),
  CONSTRAINT execution_plan_model_pins_plan_fk
    FOREIGN KEY (workspace_id, plan_id)
    REFERENCES public.execution_plans (workspace_id, plan_id),
  CONSTRAINT execution_plan_model_pins_model_revision_fk
    FOREIGN KEY (model_profile_revision_id)
    REFERENCES public.model_profile_revisions (revision_id),
  CONSTRAINT execution_plan_model_pins_schema_version
    CHECK (schema_version = 'workbench-internal-v1'),
  CONSTRAINT execution_plan_model_pins_role CHECK (
    (pin_role = 'primary' AND ordinal = 0)
    OR (pin_role = 'fallback' AND ordinal BETWEEN 1 AND 8)
  )
);

CREATE UNIQUE INDEX execution_plan_model_pins_primary_uq
  ON public.execution_plan_model_pins (workspace_id, plan_id, node_id)
  WHERE pin_role = 'primary';
CREATE UNIQUE INDEX execution_plan_model_pins_profile_uq
  ON public.execution_plan_model_pins (
    workspace_id, plan_id, node_id, model_profile_revision_id
  );

CREATE CONSTRAINT TRIGGER execution_plan_model_pins_model_revision_guard
  AFTER INSERT OR UPDATE ON public.execution_plan_model_pins
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.validate_model_revision_consumer();

CREATE FUNCTION public.assert_execution_plan_model_pins_consumable(
  consumer_workspace_id public.product_identifier,
  selected_plan_id public.product_identifier,
  require_finalized boolean DEFAULT true
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  plan_routing_state text;
  consumer_scope_id public.product_identifier;
  pin record;
  pin_count integer := 0;
BEGIN
  SELECT plan.model_routing_state, workflow.scope_id
  INTO plan_routing_state, consumer_scope_id
  FROM public.execution_plans plan
  JOIN public.workflows workflow
    ON workflow.workspace_id = plan.workspace_id
   AND workflow.workflow_id = plan.workflow_id
  WHERE plan.workspace_id = consumer_workspace_id
    AND plan.plan_id = selected_plan_id
    AND (plan.pins_finalized = true OR require_finalized = false);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution_plan_model_authority_missing: %', selected_plan_id
      USING ERRCODE = '23514';
  END IF;

  FOR pin IN
    SELECT
      model_pin.model_profile_revision_id,
      step.value ->> 'modelCapability' AS required_capability
    FROM public.execution_plan_model_pins model_pin
    JOIN public.execution_plans plan
      ON plan.workspace_id = model_pin.workspace_id
     AND plan.plan_id = model_pin.plan_id
    LEFT JOIN LATERAL jsonb_array_elements(plan.plan_document -> 'steps') AS step(value)
      ON step.value ->> 'nodeId' = model_pin.node_id
    WHERE model_pin.workspace_id = consumer_workspace_id
      AND model_pin.plan_id = selected_plan_id
    ORDER BY model_pin.model_profile_revision_id,
      model_pin.node_id, model_pin.pin_role, model_pin.ordinal
  LOOP
    pin_count := pin_count + 1;
    IF pin.required_capability IS NULL OR pin.required_capability NOT IN (
      'chat', 'tool_calling', 'structured_output', 'image_input',
      'image_generation', 'realtime_audio_input', 'realtime_audio_output',
      'realtime_turn_detection', 'realtime_barge_in'
    ) THEN
      RAISE EXCEPTION 'execution_plan_model_capability_missing: %', selected_plan_id
        USING ERRCODE = '23514';
    END IF;
    PERFORM public.assert_model_revision_consumable(
      consumer_workspace_id,
      consumer_scope_id,
      pin.model_profile_revision_id,
      pin.required_capability
    );
  END LOOP;

  IF plan_routing_state = 'pinned' AND pin_count = 0 THEN
    RAISE EXCEPTION 'execution_plan_model_pins_missing: %', selected_plan_id
      USING ERRCODE = '23514';
  END IF;
END;
$function$;

CREATE FUNCTION public.validate_ready_compile_result_model_pins()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.status = 'ready' THEN
    PERFORM public.assert_execution_plan_model_pins_consumable(
      NEW.workspace_id, NEW.execution_plan_id
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER compile_results_ready_model_pins_guard
  AFTER INSERT ON public.compile_results
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_ready_compile_result_model_pins();

ALTER TABLE public.workflows
  ADD CONSTRAINT workflows_latest_compile_result_fk
  FOREIGN KEY (
    workspace_id, latest_compile_result_id, workflow_id, current_revision_id
  ) REFERENCES public.compile_results (
    workspace_id, compile_result_id, workflow_id, workflow_revision_id
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.loop_imports (
  workspace_id public.product_identifier NOT NULL,
  import_id public.product_identifier NOT NULL,
  upload_id public.product_identifier NOT NULL,
  imported_by public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  source_object_id public.product_identifier NOT NULL,
  source_object_kind text COLLATE "C" NOT NULL DEFAULT 'loop_package',
  source_content_hash text COLLATE "C" NOT NULL,
  source_package_hash text COLLATE "C" NOT NULL,
  portable_loop jsonb,
  requirement_states jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  committed_workflow_id public.product_identifier,
  committed_revision_id public.product_identifier,
  row_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, import_id),
  CONSTRAINT loop_imports_creator_fk
    FOREIGN KEY (workspace_id, imported_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT loop_imports_upload_fk
    FOREIGN KEY (
      workspace_id, upload_id, source_object_id,
      source_content_hash, source_package_hash
    ) REFERENCES public.upload_sessions (
      workspace_id, upload_id, object_id, object_content_hash, package_hash
    ),
  CONSTRAINT loop_imports_object_fk
    FOREIGN KEY (
      workspace_id, source_object_id, source_object_kind, source_content_hash
    ) REFERENCES public.product_objects (
      workspace_id, object_id, object_kind, content_hash
    ),
  CONSTRAINT loop_imports_committed_revision_fk
    FOREIGN KEY (workspace_id, committed_workflow_id, committed_revision_id)
    REFERENCES public.workflow_revisions (workspace_id, workflow_id, revision_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT loop_imports_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT loop_imports_status CHECK (
    status IN ('parsing', 'needs_mapping', 'ready', 'committed', 'failed')
  ),
  CONSTRAINT loop_imports_object_kind CHECK (source_object_kind = 'loop_package'),
  CONSTRAINT loop_imports_hash_formats CHECK (
    source_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND source_package_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT loop_imports_commit_shape CHECK (
    (status = 'committed'
      AND committed_workflow_id IS NOT NULL
      AND committed_revision_id IS NOT NULL)
    OR (status <> 'committed'
      AND committed_workflow_id IS NULL
      AND committed_revision_id IS NULL)
  ),
  CONSTRAINT loop_imports_documents CHECK (
    (portable_loop IS NULL OR jsonb_typeof(portable_loop) = 'object')
    AND jsonb_typeof(requirement_states) = 'array'
    AND jsonb_typeof(diagnostics) = 'array'
    AND jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT loop_imports_revision_positive CHECK (row_revision >= 1),
  CONSTRAINT loop_imports_time_order CHECK (updated_at >= created_at)
);

CREATE INDEX loop_imports_creator_updated_idx
  ON public.loop_imports (workspace_id, imported_by, updated_at DESC, import_id);
CREATE INDEX loop_imports_status_updated_idx
  ON public.loop_imports (workspace_id, status, updated_at DESC, import_id);

ALTER TABLE public.execution_invocations
  ADD CONSTRAINT execution_invocations_builder_source_authority_uq
  UNIQUE (workspace_id, invocation_id, attempt_id, product_command_id);

CREATE TABLE public.builder_proposals (
  workspace_id public.product_identifier NOT NULL,
  proposal_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  created_by_principal_id public.product_identifier NOT NULL,
  created_by_principal_kind text COLLATE "C" NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  product_command_kind text COLLATE "C"
    GENERATED ALWAYS AS ('builder_proposal') STORED,
  schema_version text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL,
  workflow_id public.product_identifier,
  base_revision_id public.product_identifier,
  planned_invocation_id public.product_identifier,
  planned_attempt_id public.product_identifier,
  source_invocation_id public.product_identifier,
  source_attempt_id public.product_identifier,
  status text COLLATE "C" NOT NULL,
  generation_status text COLLATE "C" NOT NULL,
  summary text NOT NULL,
  prompt text,
  staged_draft jsonb,
  operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
  permission_impact jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, proposal_id),
  CONSTRAINT builder_proposals_creator_fk
    FOREIGN KEY (
      workspace_id, created_by_principal_id, created_by_principal_kind
    ) REFERENCES public.workspace_principals (
      workspace_id, principal_id, principal_kind
    ),
  CONSTRAINT builder_proposals_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT builder_proposals_command_fk
    FOREIGN KEY (
      workspace_id, product_command_id, scope_id,
      created_by_principal_id, created_by_principal_kind, product_command_kind
    ) REFERENCES public.product_commands (
      workspace_id, command_id, scope_id,
      effective_principal_id, effective_principal_kind, kind
    ),
  CONSTRAINT builder_proposals_workflow_scope_fk
    FOREIGN KEY (workspace_id, workflow_id, scope_id)
    REFERENCES public.workflows (workspace_id, workflow_id, scope_id),
  CONSTRAINT builder_proposals_base_revision_fk
    FOREIGN KEY (workspace_id, workflow_id, base_revision_id)
    REFERENCES public.workflow_revisions (workspace_id, workflow_id, revision_id),
  CONSTRAINT builder_proposals_source_invocation_fk
    FOREIGN KEY (
      workspace_id, source_invocation_id, source_attempt_id,
      product_command_id
    ) REFERENCES public.execution_invocations (
      workspace_id, invocation_id, attempt_id, product_command_id
    ),
  CONSTRAINT builder_proposals_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT builder_proposals_kind CHECK (
    kind IN ('workflow_change', 'staged_loop_draft')
  ),
  CONSTRAINT builder_proposals_status CHECK (
    status IN ('generating', 'proposed', 'applied', 'dismissed', 'conflicted', 'invalid')
  ),
  CONSTRAINT builder_proposals_generation_status CHECK (
    generation_status IN ('accepted', 'running', 'completed', 'failed', 'blocked')
  ),
  CONSTRAINT builder_proposals_planned_execution_shape CHECK (
    (planned_invocation_id IS NULL AND planned_attempt_id IS NULL)
    OR (planned_invocation_id IS NOT NULL AND planned_attempt_id IS NOT NULL)
  ),
  CONSTRAINT builder_proposals_source_execution_shape CHECK (
    (source_invocation_id IS NULL AND source_attempt_id IS NULL)
    OR (
      source_invocation_id IS NOT NULL
      AND source_attempt_id IS NOT NULL
      AND planned_invocation_id IS NOT NULL
      AND planned_attempt_id IS NOT NULL
      AND planned_invocation_id IS NOT DISTINCT FROM source_invocation_id
      AND planned_attempt_id IS NOT DISTINCT FROM source_attempt_id
    )
  ),
  CONSTRAINT builder_proposals_kind_shape CHECK (
    (kind = 'workflow_change'
      AND workflow_id IS NOT NULL
      AND base_revision_id IS NOT NULL
      AND staged_draft IS NULL
      AND expires_at IS NULL)
    OR (kind = 'staged_loop_draft'
      AND workflow_id IS NULL
      AND base_revision_id IS NULL
      AND staged_draft IS NOT NULL
      AND expires_at IS NOT NULL)
  ),
  CONSTRAINT builder_proposals_kind_status CHECK (
    kind <> 'staged_loop_draft' OR status <> 'conflicted'
  ),
  CONSTRAINT builder_proposals_decision_shape CHECK (
    (status IN ('applied', 'dismissed', 'conflicted', 'invalid')) = (decided_at IS NOT NULL)
  ),
  CONSTRAINT builder_proposals_documents CHECK (
    (staged_draft IS NULL OR jsonb_typeof(staged_draft) = 'object')
    AND jsonb_typeof(operations) = 'array'
    AND jsonb_typeof(diagnostics) = 'array'
    AND jsonb_typeof(permission_impact) = 'array'
    AND jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT builder_proposals_summary_length CHECK (length(summary) BETWEEN 1 AND 2000),
  CONSTRAINT builder_proposals_prompt_length CHECK (prompt IS NULL OR length(prompt) BETWEEN 1 AND 8000),
  CONSTRAINT builder_proposals_expiry CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX builder_proposals_creator_status_created_idx
  ON public.builder_proposals (
    workspace_id, created_by_principal_id, created_by_principal_kind,
    status, created_at DESC, proposal_id
  );
CREATE INDEX builder_proposals_workflow_created_idx
  ON public.builder_proposals (workspace_id, workflow_id, created_at DESC, proposal_id)
  WHERE workflow_id IS NOT NULL;
CREATE INDEX builder_proposals_command_created_idx
  ON public.builder_proposals (workspace_id, product_command_id, created_at, proposal_id)
  WHERE product_command_id IS NOT NULL;

CREATE TRIGGER builder_proposals_scope_immutable
  BEFORE UPDATE ON public.builder_proposals
  FOR EACH ROW EXECUTE FUNCTION public.enforce_root_scope_immutable();

CREATE TABLE public.loop_versions (
  workspace_id public.product_identifier NOT NULL,
  loop_version_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  workflow_revision_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  version text COLLATE "C" NOT NULL,
  workflow_revision_content_hash text COLLATE "C" NOT NULL,
  compile_result_id public.product_identifier NOT NULL,
  execution_plan_id public.product_identifier NOT NULL,
  compile_status text COLLATE "C" NOT NULL DEFAULT 'ready',
  validation_run_id public.product_identifier,
  definition jsonb NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  pins_finalized boolean NOT NULL DEFAULT false,
  released_by public.product_identifier NOT NULL,
  released_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, loop_version_id),
  CONSTRAINT loop_versions_revision_fk
    FOREIGN KEY (
      workspace_id, workflow_id, workflow_revision_id, workflow_revision_content_hash
    ) REFERENCES public.workflow_revisions (
      workspace_id, workflow_id, revision_id, content_hash
    ),
  CONSTRAINT loop_versions_compile_result_fk
    FOREIGN KEY (
      workspace_id, compile_result_id, execution_plan_id,
      workflow_id, workflow_revision_id, compile_status
    ) REFERENCES public.compile_results (
      workspace_id, compile_result_id, execution_plan_id,
      workflow_id, workflow_revision_id, status
    ),
  CONSTRAINT loop_versions_execution_plan_fk
    FOREIGN KEY (
      workspace_id, execution_plan_id, compile_result_id,
      workflow_id, workflow_revision_id
    ) REFERENCES public.execution_plans (
      workspace_id, plan_id, compile_result_id, workflow_id, workflow_revision_id
    ),
  CONSTRAINT loop_versions_releaser_fk
    FOREIGN KEY (workspace_id, released_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT loop_versions_version_uq UNIQUE (workspace_id, workflow_id, version),
  CONSTRAINT loop_versions_identity_uq
    UNIQUE (workspace_id, workflow_id, loop_version_id),
  CONSTRAINT loop_versions_content_uq
    UNIQUE (workspace_id, workflow_id, loop_version_id, content_hash),
  CONSTRAINT loop_versions_release_authority_uq
    UNIQUE (workspace_id, workflow_id, loop_version_id, version, content_hash),
  CONSTRAINT loop_versions_finalized_release_authority_uq
    UNIQUE (
      workspace_id, workflow_id, loop_version_id, version, content_hash,
      pins_finalized
    ),
  CONSTRAINT loop_versions_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT loop_versions_version_nonempty CHECK (length(version) BETWEEN 1 AND 128),
  CONSTRAINT loop_versions_ready_compile CHECK (compile_status = 'ready'),
  CONSTRAINT loop_versions_hash_formats CHECK (
    workflow_revision_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT loop_versions_definition_object CHECK (jsonb_typeof(definition) = 'object'),
  CONSTRAINT loop_versions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE public.loop_version_skill_pins (
  workspace_id public.product_identifier NOT NULL,
  loop_version_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  skill_id public.product_identifier NOT NULL,
  skill_version_id public.product_identifier NOT NULL,
  version text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  PRIMARY KEY (workspace_id, loop_version_id, skill_id),
  CONSTRAINT loop_version_skill_pins_loop_fk
    FOREIGN KEY (workspace_id, workflow_id, loop_version_id)
    REFERENCES public.loop_versions (workspace_id, workflow_id, loop_version_id),
  CONSTRAINT loop_version_skill_pins_skill_fk
    FOREIGN KEY (workspace_id, skill_id, skill_version_id, version, content_hash)
    REFERENCES public.skill_versions (
      workspace_id, skill_id, skill_version_id, version, content_hash
    ),
  CONSTRAINT loop_version_skill_pins_schema_version
    CHECK (schema_version = 'workbench-internal-v1')
);

CREATE TABLE public.loop_version_resource_pins (
  workspace_id public.product_identifier NOT NULL,
  loop_version_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  resource_id public.product_identifier NOT NULL,
  resource_version text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  PRIMARY KEY (workspace_id, loop_version_id, resource_id),
  CONSTRAINT loop_version_resource_pins_loop_fk
    FOREIGN KEY (workspace_id, workflow_id, loop_version_id)
    REFERENCES public.loop_versions (workspace_id, workflow_id, loop_version_id),
  CONSTRAINT loop_version_resource_pins_resource_fk
    FOREIGN KEY (workspace_id, resource_id, resource_version, content_hash)
    REFERENCES public.workspace_resources (
      workspace_id, resource_id, resource_version, content_hash
    ),
  CONSTRAINT loop_version_resource_pins_schema_version
    CHECK (schema_version = 'workbench-internal-v1')
);

CREATE TABLE public.loop_version_connection_requirements (
  workspace_id public.product_identifier NOT NULL,
  loop_version_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  requirement_id public.product_identifier NOT NULL,
  capability_key text COLLATE "C" NOT NULL,
  description text NOT NULL,
  required_effects jsonb NOT NULL DEFAULT '[]'::jsonb,
  schema_version text COLLATE "C" NOT NULL,
  PRIMARY KEY (workspace_id, loop_version_id, requirement_id),
  CONSTRAINT loop_version_connection_requirements_loop_fk
    FOREIGN KEY (workspace_id, workflow_id, loop_version_id)
    REFERENCES public.loop_versions (workspace_id, workflow_id, loop_version_id),
  CONSTRAINT loop_version_connection_requirements_schema_version
    CHECK (schema_version = 'workbench-internal-v1'),
  CONSTRAINT loop_version_connection_requirements_fields CHECK (
    length(capability_key) BETWEEN 1 AND 128
    AND length(description) BETWEEN 1 AND 1000
    AND jsonb_typeof(required_effects) = 'array'
  )
);

CREATE FUNCTION public.validate_loop_version_connection_requirement_effects()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  canonical_effects jsonb;
  string_effect_count integer;
BEGIN
  IF jsonb_typeof(NEW.required_effects) <> 'array' THEN
    RAISE EXCEPTION 'loop_connection_required_effects_not_canonical'
      USING ERRCODE = '23514';
  END IF;
  SELECT count(*) FILTER (WHERE jsonb_typeof(effect) = 'string'),
    COALESCE(jsonb_agg(to_jsonb(effect_text) ORDER BY effect_text), '[]'::jsonb)
  INTO string_effect_count, canonical_effects
  FROM (
    SELECT DISTINCT effect, effect #>> '{}' AS effect_text
    FROM jsonb_array_elements(NEW.required_effects) AS effect
    WHERE jsonb_typeof(effect) = 'string'
      AND length(effect #>> '{}') BETWEEN 1 AND 128
  ) canonical;
  IF string_effect_count <> jsonb_array_length(NEW.required_effects)
    OR NEW.required_effects IS DISTINCT FROM canonical_effects THEN
    RAISE EXCEPTION 'loop_connection_required_effects_not_canonical'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER loop_version_connection_requirements_effects_guard
  BEFORE INSERT ON public.loop_version_connection_requirements
  FOR EACH ROW EXECUTE FUNCTION public.validate_loop_version_connection_requirement_effects();

CREATE TABLE public.workspace_asset_releases (
  source_workspace_id public.product_identifier NOT NULL,
  release_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  asset_kind text COLLATE "C" NOT NULL,
  skill_id public.product_identifier,
  skill_version_id public.product_identifier,
  loop_workflow_id public.product_identifier,
  loop_version_id public.product_identifier,
  asset_id public.product_identifier GENERATED ALWAYS AS (
    CASE WHEN asset_kind = 'skill' THEN skill_id ELSE loop_workflow_id END
  ) STORED,
  version_id public.product_identifier GENERATED ALWAYS AS (
    CASE WHEN asset_kind = 'skill' THEN skill_version_id ELSE loop_version_id END
  ) STORED,
  loop_pins_finalized boolean GENERATED ALWAYS AS (
    CASE WHEN asset_kind = 'loop' THEN true ELSE NULL END
  ) STORED,
  version text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  visibility text COLLATE "C" NOT NULL,
  domain text COLLATE "C" NOT NULL,
  starting_point boolean NOT NULL DEFAULT false,
  release_notes text NOT NULL DEFAULT '',
  dependencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_by public.product_identifier NOT NULL,
  published_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (source_workspace_id, release_id),
  CONSTRAINT workspace_asset_releases_publisher_fk
    FOREIGN KEY (source_workspace_id, published_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT workspace_asset_releases_skill_fk
    FOREIGN KEY (
      source_workspace_id, skill_id, skill_version_id, version, content_hash
    ) REFERENCES public.skill_versions (
      workspace_id, skill_id, skill_version_id, version, content_hash
    ),
  CONSTRAINT workspace_asset_releases_loop_fk
    FOREIGN KEY (
      source_workspace_id, loop_workflow_id, loop_version_id, version,
      content_hash, loop_pins_finalized
    ) REFERENCES public.loop_versions (
      workspace_id, workflow_id, loop_version_id, version, content_hash,
      pins_finalized
    ),
  CONSTRAINT workspace_asset_releases_skill_identity_uq UNIQUE (
    source_workspace_id, release_id, asset_kind, skill_id, skill_version_id
  ),
  CONSTRAINT workspace_asset_releases_loop_identity_uq UNIQUE (
    source_workspace_id, release_id, asset_kind, loop_workflow_id, loop_version_id
  ),
  CONSTRAINT workspace_asset_releases_loop_version_identity_uq UNIQUE (
    source_workspace_id, release_id, asset_kind, loop_version_id
  ),
  CONSTRAINT workspace_asset_releases_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT workspace_asset_releases_typed_shape CHECK (
    (asset_kind = 'skill'
      AND skill_id IS NOT NULL
      AND skill_version_id IS NOT NULL
      AND loop_workflow_id IS NULL
      AND loop_version_id IS NULL)
    OR (asset_kind = 'loop'
      AND skill_id IS NULL
      AND skill_version_id IS NULL
      AND loop_workflow_id IS NOT NULL
      AND loop_version_id IS NOT NULL)
  ),
  CONSTRAINT workspace_asset_releases_visibility CHECK (
    visibility IN ('private', 'workspace')
  ),
  CONSTRAINT workspace_asset_releases_domain CHECK (
    domain IN ('product', 'research', 'data', 'engineering')
  ),
  CONSTRAINT workspace_asset_releases_hash_format
    CHECK (content_hash ~ '^sha256:[a-f0-9]{16,64}$'),
  CONSTRAINT workspace_asset_releases_notes_length CHECK (length(release_notes) <= 4000),
  CONSTRAINT workspace_asset_releases_documents CHECK (
    jsonb_typeof(dependencies) = 'array' AND jsonb_typeof(payload) = 'object'
  )
);

CREATE UNIQUE INDEX workspace_asset_releases_asset_version_uq
  ON public.workspace_asset_releases (
    source_workspace_id, asset_kind, asset_id, version_id
  );
CREATE INDEX workspace_asset_releases_catalog_idx
  ON public.workspace_asset_releases (
    source_workspace_id, visibility, domain, published_at DESC, release_id
  );

ALTER TABLE public.workflows
  ADD CONSTRAINT workflows_source_release_fk
  FOREIGN KEY (
    source_release_workspace_id, source_release_id,
    source_release_asset_kind, source_release_version_id
  ) REFERENCES public.workspace_asset_releases (
    source_workspace_id, release_id, asset_kind, loop_version_id
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.asset_installations (
  workspace_id public.product_identifier NOT NULL,
  installation_id public.product_identifier NOT NULL,
  source_workspace_id public.product_identifier NOT NULL,
  release_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  asset_kind text COLLATE "C" NOT NULL,
  skill_id public.product_identifier,
  skill_version_id public.product_identifier,
  loop_workflow_id public.product_identifier,
  loop_version_id public.product_identifier,
  upstream_asset_id public.product_identifier GENERATED ALWAYS AS (
    CASE WHEN asset_kind = 'skill' THEN skill_id ELSE loop_workflow_id END
  ) STORED,
  pinned_version_id public.product_identifier GENERATED ALWAYS AS (
    CASE WHEN asset_kind = 'skill' THEN skill_version_id ELSE loop_version_id END
  ) STORED,
  state text COLLATE "C" NOT NULL,
  installed_by public.product_identifier NOT NULL,
  installed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  write_version integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, installation_id),
  CONSTRAINT asset_installations_installer_fk
    FOREIGN KEY (workspace_id, installed_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT asset_installations_skill_release_fk
    FOREIGN KEY (
      source_workspace_id, release_id, asset_kind, skill_id, skill_version_id
    ) REFERENCES public.workspace_asset_releases (
      source_workspace_id, release_id, asset_kind, skill_id, skill_version_id
    ),
  CONSTRAINT asset_installations_loop_release_fk
    FOREIGN KEY (
      source_workspace_id, release_id, asset_kind, loop_workflow_id, loop_version_id
    ) REFERENCES public.workspace_asset_releases (
      source_workspace_id, release_id, asset_kind, loop_workflow_id, loop_version_id
    ),
  CONSTRAINT asset_installations_identity_uq UNIQUE NULLS NOT DISTINCT (
    workspace_id, installation_id, asset_kind, skill_id, skill_version_id,
    loop_workflow_id, loop_version_id
  ),
  CONSTRAINT asset_installations_skill_identity_uq UNIQUE (
    workspace_id, installation_id, asset_kind, skill_id, skill_version_id
  ),
  CONSTRAINT asset_installations_loop_identity_uq UNIQUE (
    workspace_id, installation_id, asset_kind, loop_workflow_id, loop_version_id
  ),
  CONSTRAINT asset_installations_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT asset_installations_v1_same_workspace CHECK (source_workspace_id = workspace_id),
  CONSTRAINT asset_installations_typed_shape CHECK (
    (asset_kind = 'skill'
      AND skill_id IS NOT NULL
      AND skill_version_id IS NOT NULL
      AND loop_workflow_id IS NULL
      AND loop_version_id IS NULL)
    OR (asset_kind = 'loop'
      AND skill_id IS NULL
      AND skill_version_id IS NULL
      AND loop_workflow_id IS NOT NULL
      AND loop_version_id IS NOT NULL)
  ),
  CONSTRAINT asset_installations_state CHECK (
    state IN ('installed', 'update_available', 'update_draft_created', 'removed')
  ),
  CONSTRAINT asset_installations_write_version_positive CHECK (write_version >= 1),
  CONSTRAINT asset_installations_time_order CHECK (updated_at >= installed_at),
  CONSTRAINT asset_installations_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX asset_installations_active_asset_uq
  ON public.asset_installations (
    workspace_id, asset_kind, upstream_asset_id
  ) WHERE state <> 'removed';
CREATE INDEX asset_installations_state_updated_idx
  ON public.asset_installations (workspace_id, state, updated_at DESC, installation_id);

CREATE TABLE public.installation_update_drafts (
  workspace_id public.product_identifier NOT NULL,
  update_draft_id public.product_identifier NOT NULL,
  installation_id public.product_identifier NOT NULL,
  created_by public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  asset_kind text COLLATE "C" NOT NULL,
  skill_id public.product_identifier,
  base_skill_version_id public.product_identifier,
  target_skill_version_id public.product_identifier,
  loop_workflow_id public.product_identifier,
  base_loop_version_id public.product_identifier,
  target_loop_version_id public.product_identifier,
  base_release_id public.product_identifier NOT NULL,
  target_release_id public.product_identifier NOT NULL,
  base_installation_write_version integer NOT NULL,
  base_pinned_version_id public.product_identifier GENERATED ALWAYS AS (
    CASE WHEN asset_kind = 'skill' THEN base_skill_version_id ELSE base_loop_version_id END
  ) STORED,
  target_version_id public.product_identifier GENERATED ALWAYS AS (
    CASE WHEN asset_kind = 'skill' THEN target_skill_version_id ELSE target_loop_version_id END
  ) STORED,
  impact jsonb NOT NULL,
  status text COLLATE "C" NOT NULL,
  conflict_reason text,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  decided_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, update_draft_id),
  CONSTRAINT installation_update_drafts_creator_fk
    FOREIGN KEY (workspace_id, created_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT installation_update_drafts_installation_fk
    FOREIGN KEY (workspace_id, installation_id)
    REFERENCES public.asset_installations (workspace_id, installation_id),
  CONSTRAINT installation_update_drafts_base_skill_release_fk
    FOREIGN KEY (
      workspace_id, base_release_id, asset_kind, skill_id, base_skill_version_id
    ) REFERENCES public.workspace_asset_releases (
      source_workspace_id, release_id, asset_kind, skill_id, skill_version_id
    ),
  CONSTRAINT installation_update_drafts_target_skill_release_fk
    FOREIGN KEY (
      workspace_id, target_release_id, asset_kind, skill_id, target_skill_version_id
    ) REFERENCES public.workspace_asset_releases (
      source_workspace_id, release_id, asset_kind, skill_id, skill_version_id
    ),
  CONSTRAINT installation_update_drafts_base_loop_release_fk
    FOREIGN KEY (
      workspace_id, base_release_id, asset_kind, loop_workflow_id, base_loop_version_id
    ) REFERENCES public.workspace_asset_releases (
      source_workspace_id, release_id, asset_kind, loop_workflow_id, loop_version_id
    ),
  CONSTRAINT installation_update_drafts_target_loop_release_fk
    FOREIGN KEY (
      workspace_id, target_release_id, asset_kind, loop_workflow_id, target_loop_version_id
    ) REFERENCES public.workspace_asset_releases (
      source_workspace_id, release_id, asset_kind, loop_workflow_id, loop_version_id
    ),
  CONSTRAINT installation_update_drafts_schema_version CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT installation_update_drafts_typed_shape CHECK (
    (asset_kind = 'skill'
      AND skill_id IS NOT NULL
      AND base_skill_version_id IS NOT NULL
      AND target_skill_version_id IS NOT NULL
      AND loop_workflow_id IS NULL
      AND base_loop_version_id IS NULL
      AND target_loop_version_id IS NULL)
    OR (asset_kind = 'loop'
      AND skill_id IS NULL
      AND base_skill_version_id IS NULL
      AND target_skill_version_id IS NULL
      AND loop_workflow_id IS NOT NULL
      AND base_loop_version_id IS NOT NULL
      AND target_loop_version_id IS NOT NULL)
  ),
  CONSTRAINT installation_update_drafts_status CHECK (
    status IN ('pending_review', 'ready', 'conflicted', 'applied', 'kept_current')
  ),
  CONSTRAINT installation_update_drafts_terminal_shape CHECK (
    (status IN ('applied', 'kept_current')) = (decided_at IS NOT NULL)
  ),
  CONSTRAINT installation_update_drafts_conflict_shape CHECK (
    (status = 'conflicted') = (conflict_reason IS NOT NULL)
  ),
  CONSTRAINT installation_update_drafts_revision_positive CHECK (revision >= 1),
  CONSTRAINT installation_update_drafts_base_write_version_positive
    CHECK (base_installation_write_version >= 1),
  CONSTRAINT installation_update_drafts_impact_object CHECK (jsonb_typeof(impact) = 'object'),
  CONSTRAINT installation_update_drafts_time_order CHECK (updated_at >= created_at),
  CONSTRAINT installation_update_drafts_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX installation_update_drafts_installation_updated_idx
  ON public.installation_update_drafts (
    workspace_id, installation_id, updated_at DESC, update_draft_id
  );
CREATE INDEX installation_update_drafts_status_updated_idx
  ON public.installation_update_drafts (
    workspace_id, status, updated_at DESC, update_draft_id
  );

CREATE TABLE public.installation_update_draft_connection_bindings (
  workspace_id public.product_identifier NOT NULL,
  update_draft_id public.product_identifier NOT NULL,
  requirement_id public.product_identifier NOT NULL,
  connection_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, update_draft_id, requirement_id),
  CONSTRAINT installation_update_draft_connection_bindings_draft_fk
    FOREIGN KEY (workspace_id, update_draft_id)
    REFERENCES public.installation_update_drafts (workspace_id, update_draft_id),
  CONSTRAINT installation_update_draft_connection_bindings_connection_fk
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES public.workspace_connections (workspace_id, connection_id),
  CONSTRAINT installation_update_draft_connection_bindings_schema_version
    CHECK (schema_version = 'workbench-internal-v1')
);

CREATE TABLE public.workspace_connection_bindings (
  workspace_id public.product_identifier NOT NULL,
  binding_id public.product_identifier NOT NULL,
  connection_id public.product_identifier NOT NULL,
  requirement_id public.product_identifier NOT NULL,
  bound_by public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  workflow_id public.product_identifier,
  workflow_revision_id public.product_identifier,
  installation_id public.product_identifier,
  generation integer NOT NULL DEFAULT 1,
  status text COLLATE "C" NOT NULL DEFAULT 'active',
  superseded_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, binding_id),
  CONSTRAINT workspace_connection_bindings_connection_fk
    FOREIGN KEY (workspace_id, connection_id)
    REFERENCES public.workspace_connections (workspace_id, connection_id),
  CONSTRAINT workspace_connection_bindings_bound_by_fk
    FOREIGN KEY (workspace_id, bound_by)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT workspace_connection_bindings_workflow_revision_fk
    FOREIGN KEY (workspace_id, workflow_id, workflow_revision_id)
    REFERENCES public.workflow_revisions (workspace_id, workflow_id, revision_id),
  CONSTRAINT workspace_connection_bindings_installation_fk
    FOREIGN KEY (workspace_id, installation_id)
    REFERENCES public.asset_installations (workspace_id, installation_id),
  CONSTRAINT workspace_connection_bindings_schema_version
    CHECK (schema_version = 'workbench-v1'),
  CONSTRAINT workspace_connection_bindings_target_shape CHECK (
    (workflow_id IS NOT NULL AND workflow_revision_id IS NOT NULL AND installation_id IS NULL)
    OR (workflow_id IS NULL AND workflow_revision_id IS NULL AND installation_id IS NOT NULL)
  ),
  CONSTRAINT workspace_connection_bindings_generation_positive CHECK (generation >= 1),
  CONSTRAINT workspace_connection_bindings_status CHECK (
    status IN ('active', 'superseded')
  ),
  CONSTRAINT workspace_connection_bindings_status_shape CHECK (
    (status = 'active' AND superseded_at IS NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL)
  ),
  CONSTRAINT workspace_connection_bindings_time_order CHECK (
    updated_at >= created_at
    AND (superseded_at IS NULL OR (
      superseded_at >= created_at AND updated_at >= superseded_at
    ))
  ),
  CONSTRAINT workspace_connection_bindings_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX workspace_connection_bindings_workflow_generation_uq
  ON public.workspace_connection_bindings (
    workspace_id, workflow_id, workflow_revision_id, requirement_id, generation
  ) WHERE workflow_revision_id IS NOT NULL;
CREATE UNIQUE INDEX workspace_connection_bindings_installation_generation_uq
  ON public.workspace_connection_bindings (
    workspace_id, installation_id, requirement_id, generation
  ) WHERE installation_id IS NOT NULL;
CREATE UNIQUE INDEX workspace_connection_bindings_workflow_active_uq
  ON public.workspace_connection_bindings (
    workspace_id, workflow_id, workflow_revision_id, requirement_id
  ) WHERE workflow_revision_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX workspace_connection_bindings_installation_active_uq
  ON public.workspace_connection_bindings (
    workspace_id, installation_id, requirement_id
  ) WHERE installation_id IS NOT NULL AND status = 'active';
CREATE INDEX workspace_connection_bindings_connection_idx
  ON public.workspace_connection_bindings (workspace_id, connection_id, binding_id);

CREATE FUNCTION public.validate_workspace_connection_binding_generation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  previous_status text;
BEGIN
  IF NEW.status <> 'active' OR NEW.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'workspace_connection_binding_must_start_active'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.generation = 1 THEN
    PERFORM 1
    FROM public.workspace_connection_bindings previous
    WHERE previous.workspace_id = NEW.workspace_id
      AND previous.requirement_id = NEW.requirement_id
      AND (
        (NEW.workflow_id IS NOT NULL
          AND previous.workflow_id = NEW.workflow_id
          AND previous.workflow_revision_id = NEW.workflow_revision_id)
        OR (NEW.installation_id IS NOT NULL
          AND previous.installation_id = NEW.installation_id)
      );
    IF FOUND THEN
      RAISE EXCEPTION 'workspace_connection_binding_first_generation_exists'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT previous.status INTO previous_status
  FROM public.workspace_connection_bindings previous
  WHERE previous.workspace_id = NEW.workspace_id
    AND previous.requirement_id = NEW.requirement_id
    AND previous.generation = NEW.generation - 1
    AND (
      (NEW.workflow_id IS NOT NULL
        AND previous.workflow_id = NEW.workflow_id
        AND previous.workflow_revision_id = NEW.workflow_revision_id)
      OR (NEW.installation_id IS NOT NULL
        AND previous.installation_id = NEW.installation_id)
    )
  FOR SHARE OF previous;
  IF previous_status IS NULL THEN
    RAISE EXCEPTION 'workspace_connection_binding_previous_generation_missing'
      USING ERRCODE = '23514';
  END IF;
  IF previous_status <> 'superseded' THEN
    RAISE EXCEPTION 'workspace_connection_binding_previous_generation_active'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_connection_bindings_generation_guard
  BEFORE INSERT ON public.workspace_connection_bindings
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_connection_binding_generation();

CREATE FUNCTION public.validate_workspace_connection_binding_scope()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_scope_id public.product_identifier;
  required_capability_key text;
  required_effects jsonb;
  requirement_signature_count integer;
  locked_source_workspace_id public.product_identifier;
  locked_release_id public.product_identifier;
  locked_asset_kind text;
  locked_loop_workflow_id public.product_identifier;
  locked_loop_version_id public.product_identifier;
  locked_installation_state text;
BEGIN
  IF NEW.workflow_id IS NOT NULL THEN
    SELECT workflow.scope_id,
      min(requirement.capability_key),
      (array_agg(requirement.required_effects ORDER BY requirement.required_effects::text))[1],
      count(DISTINCT ROW(requirement.capability_key, requirement.required_effects))
    INTO target_scope_id, required_capability_key, required_effects,
      requirement_signature_count
    FROM public.workflows workflow
    JOIN public.workflow_revisions revision
      ON revision.workspace_id = workflow.workspace_id
     AND revision.workflow_id = workflow.workflow_id
    JOIN public.loop_versions loop_version
      ON loop_version.workspace_id = revision.workspace_id
     AND loop_version.workflow_id = revision.workflow_id
     AND loop_version.workflow_revision_id = revision.revision_id
     AND loop_version.pins_finalized
    JOIN public.loop_version_connection_requirements requirement
      ON requirement.workspace_id = loop_version.workspace_id
     AND requirement.workflow_id = loop_version.workflow_id
     AND requirement.loop_version_id = loop_version.loop_version_id
     AND requirement.requirement_id = NEW.requirement_id
    WHERE workflow.workspace_id = NEW.workspace_id
      AND workflow.workflow_id = NEW.workflow_id
      AND revision.revision_id = NEW.workflow_revision_id
    GROUP BY workflow.scope_id;
  ELSE
    SELECT installation.source_workspace_id, installation.release_id,
      installation.asset_kind,
      installation.loop_workflow_id, installation.loop_version_id,
      installation.state
    INTO locked_source_workspace_id, locked_release_id, locked_asset_kind,
      locked_loop_workflow_id, locked_loop_version_id,
      locked_installation_state
    FROM public.asset_installations installation
    WHERE installation.workspace_id = NEW.workspace_id
      AND installation.installation_id = NEW.installation_id
    FOR SHARE OF installation;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'workspace_connection_binding_requirement_invalid: %',
        NEW.requirement_id
        USING ERRCODE = '23514';
    END IF;
    SELECT workflow.scope_id,
      min(requirement.capability_key),
      (array_agg(requirement.required_effects ORDER BY requirement.required_effects::text))[1],
      count(DISTINCT ROW(requirement.capability_key, requirement.required_effects))
    INTO target_scope_id, required_capability_key, required_effects,
      requirement_signature_count
    FROM public.workspace_asset_releases release
    JOIN public.loop_versions loop_version
      ON loop_version.workspace_id = release.source_workspace_id
     AND loop_version.workflow_id = release.loop_workflow_id
     AND loop_version.loop_version_id = release.loop_version_id
     AND loop_version.pins_finalized
    JOIN public.loop_version_connection_requirements requirement
      ON requirement.workspace_id = loop_version.workspace_id
     AND requirement.workflow_id = loop_version.workflow_id
     AND requirement.loop_version_id = loop_version.loop_version_id
     AND requirement.requirement_id = NEW.requirement_id
    JOIN public.workflows workflow
      ON workflow.workspace_id = NEW.workspace_id
     AND workflow.workflow_id = locked_loop_workflow_id
    WHERE release.source_workspace_id = locked_source_workspace_id
      AND release.release_id = locked_release_id
     AND release.asset_kind = 'loop'
      AND release.loop_workflow_id = locked_loop_workflow_id
      AND release.loop_version_id = locked_loop_version_id
      AND locked_asset_kind = 'loop'
      AND locked_installation_state <> 'removed'
    GROUP BY workflow.scope_id;
  END IF;
  IF target_scope_id IS NULL OR requirement_signature_count <> 1 THEN
    RAISE EXCEPTION 'workspace_connection_binding_requirement_invalid: %',
      NEW.requirement_id
      USING ERRCODE = '23514';
  END IF;
  PERFORM public.assert_workspace_connection_consumable(
    NEW.workspace_id, target_scope_id, NEW.connection_id,
    required_capability_key, required_effects
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_connection_bindings_scope_guard
  BEFORE INSERT ON public.workspace_connection_bindings
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_connection_binding_scope();

CREATE FUNCTION public.enforce_workspace_connection_binding_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workspace_connection_binding_delete_forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW.workspace_id, NEW.binding_id, NEW.connection_id, NEW.requirement_id,
    NEW.bound_by, NEW.schema_version, NEW.workflow_id,
    NEW.workflow_revision_id, NEW.installation_id, NEW.generation, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id, OLD.binding_id, OLD.connection_id, OLD.requirement_id,
    OLD.bound_by, OLD.schema_version, OLD.workflow_id,
    OLD.workflow_revision_id, OLD.installation_id, OLD.generation, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'workspace_connection_binding_identity_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'superseded'
    AND ROW(NEW.status, NEW.superseded_at)
      IS DISTINCT FROM ROW(OLD.status, OLD.superseded_at) THEN
    RAISE EXCEPTION 'workspace_connection_binding_superseded_terminal'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.status = 'active'
    AND NEW.status = 'superseded'
    AND OLD.superseded_at IS NULL
    AND NEW.superseded_at IS NOT NULL
    AND NEW.superseded_at >= OLD.created_at
    AND NEW.updated_at >= NEW.superseded_at
  ) THEN
    RAISE EXCEPTION 'workspace_connection_binding_transition_forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION 'workspace_connection_binding_superseded_at_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'workspace_connection_binding_time_regression'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workspace_connection_bindings_identity_immutable
  BEFORE UPDATE OR DELETE ON public.workspace_connection_bindings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workspace_connection_binding_identity_immutable();

CREATE FUNCTION public.validate_workspace_connection_binding_active_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  active_count integer;
  active_generation integer;
  latest_generation integer;
BEGIN
  SELECT count(*) FILTER (WHERE binding.status = 'active'),
    max(binding.generation) FILTER (WHERE binding.status = 'active'),
    max(binding.generation)
  INTO active_count, active_generation, latest_generation
  FROM public.workspace_connection_bindings binding
  WHERE binding.workspace_id = NEW.workspace_id
    AND binding.requirement_id = NEW.requirement_id
    AND (
      (NEW.workflow_id IS NOT NULL
        AND binding.workflow_id = NEW.workflow_id
        AND binding.workflow_revision_id = NEW.workflow_revision_id)
      OR (NEW.installation_id IS NOT NULL
        AND binding.installation_id = NEW.installation_id)
    );
  IF active_count <> 1 OR active_generation IS DISTINCT FROM latest_generation THEN
    RAISE EXCEPTION 'workspace_connection_binding_active_generation_invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER workspace_connection_bindings_active_aggregate_guard
  AFTER INSERT OR UPDATE ON public.workspace_connection_bindings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workspace_connection_binding_active_aggregate();

CREATE FUNCTION public.assert_execution_plan_connection_bindings_consumable(
  consumer_workspace_id public.product_identifier,
  selected_plan_id public.product_identifier
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  plan_scope_id public.product_identifier;
  plan_workflow_id public.product_identifier;
  plan_workflow_revision_id public.product_identifier;
  published_requirement record;
  candidate_binding public.workspace_connection_bindings%ROWTYPE;
  valid_candidate_count integer;
  selected_connection_id public.product_identifier;
  locked_source_workspace_id public.product_identifier;
  locked_release_id public.product_identifier;
  locked_asset_kind text;
  locked_loop_workflow_id public.product_identifier;
  locked_loop_version_id public.product_identifier;
  locked_installation_state text;
  installation_lineage_valid boolean;
BEGIN
  SELECT workflow.scope_id, plan.workflow_id, plan.workflow_revision_id
  INTO plan_scope_id, plan_workflow_id, plan_workflow_revision_id
  FROM public.execution_plans plan
  JOIN public.workflows workflow
    ON workflow.workspace_id = plan.workspace_id
   AND workflow.workflow_id = plan.workflow_id
  WHERE plan.workspace_id = consumer_workspace_id
    AND plan.plan_id = selected_plan_id;
  IF plan_scope_id IS NULL THEN
    RAISE EXCEPTION 'execution_plan_connection_scope_missing: %', selected_plan_id
      USING ERRCODE = '23514';
  END IF;

  FOR candidate_binding IN
    SELECT binding.*
    FROM public.workspace_connection_bindings binding
    WHERE binding.workspace_id = consumer_workspace_id
      AND binding.status = 'active'
      AND binding.workflow_id = plan_workflow_id
      AND binding.workflow_revision_id = plan_workflow_revision_id
    ORDER BY binding.binding_id
    FOR SHARE OF binding
  LOOP
    IF NOT EXISTS (
        SELECT 1
        FROM public.loop_versions loop_version
        JOIN public.loop_version_connection_requirements requirement
          ON requirement.workspace_id = loop_version.workspace_id
         AND requirement.workflow_id = loop_version.workflow_id
         AND requirement.loop_version_id = loop_version.loop_version_id
        WHERE loop_version.workspace_id = consumer_workspace_id
          AND loop_version.execution_plan_id = selected_plan_id
          AND loop_version.workflow_id = plan_workflow_id
          AND loop_version.workflow_revision_id = plan_workflow_revision_id
          AND loop_version.pins_finalized
          AND requirement.requirement_id = candidate_binding.requirement_id
      )
    THEN
      RAISE EXCEPTION 'execution_plan_connection_binding_not_in_requirement_set: %',
        selected_plan_id
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR published_requirement IN
    SELECT requirement.requirement_id, requirement.capability_key,
      requirement.required_effects
    FROM public.loop_versions loop_version
    JOIN public.loop_version_connection_requirements requirement
      ON requirement.workspace_id = loop_version.workspace_id
     AND requirement.workflow_id = loop_version.workflow_id
     AND requirement.loop_version_id = loop_version.loop_version_id
    WHERE loop_version.workspace_id = consumer_workspace_id
      AND loop_version.execution_plan_id = selected_plan_id
      AND loop_version.workflow_id = plan_workflow_id
      AND loop_version.workflow_revision_id = plan_workflow_revision_id
      AND loop_version.pins_finalized
    GROUP BY requirement.requirement_id, requirement.capability_key,
      requirement.required_effects
    ORDER BY requirement.requirement_id, requirement.capability_key,
      requirement.required_effects::text
  LOOP
    valid_candidate_count := 0;
    selected_connection_id := NULL;
    FOR candidate_binding IN
      SELECT binding.*
      FROM public.workspace_connection_bindings binding
      WHERE binding.workspace_id = consumer_workspace_id
        AND binding.requirement_id = published_requirement.requirement_id
        AND binding.status = 'active'
        AND (
          (binding.workflow_id = plan_workflow_id
            AND binding.workflow_revision_id = plan_workflow_revision_id)
          OR binding.installation_id IS NOT NULL
        )
      ORDER BY binding.binding_id
      FOR SHARE OF binding
    LOOP
      IF candidate_binding.workflow_id = plan_workflow_id
        AND candidate_binding.workflow_revision_id = plan_workflow_revision_id THEN
        valid_candidate_count := valid_candidate_count + 1;
        selected_connection_id := candidate_binding.connection_id;
      ELSIF candidate_binding.installation_id IS NOT NULL THEN
        locked_source_workspace_id := NULL;
        locked_release_id := NULL;
        locked_asset_kind := NULL;
        locked_loop_workflow_id := NULL;
        locked_loop_version_id := NULL;
        locked_installation_state := NULL;
        SELECT installation.source_workspace_id, installation.release_id,
          installation.asset_kind, installation.loop_workflow_id,
          installation.loop_version_id, installation.state
        INTO locked_source_workspace_id, locked_release_id, locked_asset_kind,
          locked_loop_workflow_id, locked_loop_version_id,
          locked_installation_state
        FROM public.asset_installations installation
        WHERE installation.workspace_id = consumer_workspace_id
          AND installation.installation_id = candidate_binding.installation_id
        FOR SHARE OF installation;
        IF FOUND THEN
          SELECT EXISTS (
            SELECT 1
            FROM public.workspace_asset_releases release
            JOIN public.loop_versions loop_version
              ON loop_version.workspace_id = release.source_workspace_id
             AND loop_version.workflow_id = release.loop_workflow_id
             AND loop_version.loop_version_id = release.loop_version_id
            WHERE release.source_workspace_id = locked_source_workspace_id
              AND release.release_id = locked_release_id
              AND release.asset_kind = 'loop'
              AND release.loop_workflow_id = locked_loop_workflow_id
              AND release.loop_version_id = locked_loop_version_id
              AND locked_source_workspace_id = consumer_workspace_id
              AND locked_asset_kind = 'loop'
              AND locked_installation_state <> 'removed'
              AND loop_version.workflow_id = plan_workflow_id
              AND loop_version.workflow_revision_id = plan_workflow_revision_id
              AND loop_version.execution_plan_id = selected_plan_id
              AND loop_version.pins_finalized
          ) INTO installation_lineage_valid;
          IF installation_lineage_valid THEN
            valid_candidate_count := valid_candidate_count + 1;
            selected_connection_id := candidate_binding.connection_id;
          END IF;
        END IF;
      END IF;
    END LOOP;
    IF valid_candidate_count <> 1 THEN
      RAISE EXCEPTION 'execution_plan_connection_requirement_unbound: %',
        published_requirement.requirement_id
        USING ERRCODE = '23514';
    END IF;
    PERFORM public.assert_workspace_connection_consumable(
      consumer_workspace_id, plan_scope_id, selected_connection_id,
      published_requirement.capability_key,
      published_requirement.required_effects
    );
  END LOOP;
END;
$function$;

CREATE FUNCTION public.enforce_template_version_content_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR ROW(
    OLD.template_id, OLD.template_version, OLD.schema_version, OLD.name,
    OLD.description, OLD.category, OLD.display, OLD.input_form, OLD.graph,
    OLD.included_skills, OLD.expected_outputs, OLD.review_policy, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.template_id, NEW.template_version, NEW.schema_version, NEW.name,
    NEW.description, NEW.category, NEW.display, NEW.input_form, NEW.graph,
    NEW.included_skills, NEW.expected_outputs, NEW.review_policy, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'immutable_template_version_content_mutation_forbidden'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_finalizable_pin_parent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  model_projection_complete boolean;
  skill_projection_complete boolean;
  resource_projection_complete boolean;
  parent_plan jsonb;
  revision_resource_refs jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'immutable_finalized_pin_parent_mutation_forbidden: %', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT'
    AND TG_TABLE_NAME = 'loop_versions'
    AND NEW.pins_finalized IS TRUE THEN
    RAISE EXCEPTION 'loop_version_pin_assembly_must_finalize_after_insert'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD.pins_finalized = false
    AND NEW.pins_finalized = true
    AND (to_jsonb(NEW) - ARRAY[
      'pins_finalized', 'compile_status', 'ordered_steps', 'review_gates'
    ]::text[]) <> (to_jsonb(OLD) - ARRAY[
      'pins_finalized', 'compile_status', 'ordered_steps', 'review_gates'
    ]::text[]) THEN
    RAISE EXCEPTION 'immutable_finalized_pin_parent_mutation_forbidden: %', TG_TABLE_NAME
      USING ERRCODE = '55000';
  ELSIF TG_OP = 'UPDATE'
    AND NOT (OLD.pins_finalized = false AND NEW.pins_finalized = true) THEN
    RAISE EXCEPTION 'immutable_finalized_pin_parent_mutation_forbidden: %', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;

  IF NEW.pins_finalized IS TRUE AND TG_TABLE_NAME = 'execution_plans' THEN
    WITH expected AS (
      SELECT
        step ->> 'nodeId' AS node_id,
        'primary'::text AS pin_role,
        0 AS ordinal,
        step ->> 'modelProfileRevisionId' AS model_profile_revision_id
      FROM jsonb_array_elements(NEW.plan_document -> 'steps') AS step
      WHERE step ? 'modelProfileRevisionId'
      UNION ALL
      SELECT
        step ->> 'nodeId',
        'fallback'::text,
        fallback.ordinality::integer,
        fallback.value
      FROM jsonb_array_elements(NEW.plan_document -> 'steps') AS step
      CROSS JOIN LATERAL jsonb_array_elements_text(
        COALESCE(step -> 'fallbackModelProfileRevisionIds', '[]'::jsonb)
      ) WITH ORDINALITY AS fallback(value, ordinality)
    ), actual AS (
      SELECT node_id, pin_role, ordinal, model_profile_revision_id
      FROM public.execution_plan_model_pins
      WHERE workspace_id = NEW.workspace_id AND plan_id = NEW.plan_id
    )
    SELECT NOT EXISTS (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) INTO model_projection_complete;

    IF model_projection_complete IS NOT TRUE THEN
      RAISE EXCEPTION 'execution_plan_model_pin_projection_incomplete'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.pins_finalized IS TRUE AND TG_TABLE_NAME = 'loop_versions' THEN
    SELECT plan_document INTO parent_plan
    FROM public.execution_plans
    WHERE workspace_id = NEW.workspace_id AND plan_id = NEW.execution_plan_id;

    WITH expected AS (
      SELECT
        skill ->> 'skillId' AS skill_id,
        skill ->> 'version' AS version
      FROM jsonb_array_elements(parent_plan -> 'pinnedSkills') AS skill
    ), actual AS (
      SELECT skill_id, version
      FROM public.loop_version_skill_pins
      WHERE workspace_id = NEW.workspace_id
        AND loop_version_id = NEW.loop_version_id
    )
    SELECT NOT EXISTS (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) INTO skill_projection_complete;

    IF skill_projection_complete IS NOT TRUE THEN
      RAISE EXCEPTION 'loop_version_skill_pin_projection_incomplete'
        USING ERRCODE = '55000';
    END IF;

    SELECT resource_refs INTO revision_resource_refs
    FROM public.workflow_revisions
    WHERE workspace_id = NEW.workspace_id
      AND workflow_id = NEW.workflow_id
      AND revision_id = NEW.workflow_revision_id;

    WITH expected AS (
      SELECT
        resource ->> 'resourceId' AS resource_id,
        resource ->> 'version' AS resource_version,
        resource ->> 'contentHash' AS content_hash
      FROM jsonb_array_elements(revision_resource_refs) AS resource
    ), actual AS (
      SELECT resource_id, resource_version, content_hash
      FROM public.loop_version_resource_pins
      WHERE workspace_id = NEW.workspace_id
        AND loop_version_id = NEW.loop_version_id
    )
    SELECT NOT EXISTS (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual)
      UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) INTO resource_projection_complete;

    IF resource_projection_complete IS NOT TRUE THEN
      RAISE EXCEPTION 'loop_version_resource_pin_projection_incomplete'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_finalized_execution_plan_model_consumption()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.pins_finalized THEN
    PERFORM public.assert_execution_plan_model_pins_consumable(
      NEW.workspace_id, NEW.plan_id
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.reject_finalized_pin_projection_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  parent_finalized boolean;
  parent_plan jsonb;
  model_pin_matches boolean;
BEGIN
  IF TG_TABLE_NAME = 'execution_plan_model_pins' THEN
    SELECT pins_finalized, plan_document
      INTO parent_finalized, parent_plan
    FROM public.execution_plans
    WHERE workspace_id = NEW.workspace_id AND plan_id = NEW.plan_id;

    IF parent_finalized IS TRUE THEN
      RAISE EXCEPTION 'finalized_pin_projection_append_forbidden: %', TG_TABLE_NAME
        USING ERRCODE = '55000';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(parent_plan -> 'steps') AS step
      WHERE step ->> 'nodeId' = NEW.node_id
        AND (
          (NEW.pin_role = 'primary'
            AND step ->> 'modelProfileRevisionId' = NEW.model_profile_revision_id)
          OR (NEW.pin_role = 'fallback'
            AND step -> 'fallbackModelProfileRevisionIds' ->> (NEW.ordinal - 1)
              = NEW.model_profile_revision_id)
        )
    ) INTO model_pin_matches;

    IF model_pin_matches IS NOT TRUE THEN
      RAISE EXCEPTION 'execution_plan_model_pin_projection_mismatch'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT pins_finalized INTO parent_finalized
    FROM public.loop_versions
    WHERE workspace_id = NEW.workspace_id AND loop_version_id = NEW.loop_version_id;
  END IF;

  IF parent_finalized IS TRUE THEN
    RAISE EXCEPTION 'finalized_pin_projection_append_forbidden: %', TG_TABLE_NAME
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_installation_update_draft_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  installation public.asset_installations%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO installation
    FROM public.asset_installations
    WHERE workspace_id = NEW.workspace_id
      AND installation_id = NEW.installation_id
    FOR UPDATE;

    IF NOT FOUND
      OR installation.asset_kind <> NEW.asset_kind
      OR installation.release_id <> NEW.base_release_id
      OR installation.write_version <> NEW.base_installation_write_version
      OR (NEW.asset_kind = 'skill' AND (
        installation.skill_id <> NEW.skill_id
        OR installation.skill_version_id <> NEW.base_skill_version_id
      ))
      OR (NEW.asset_kind = 'loop' AND (
        installation.loop_workflow_id <> NEW.loop_workflow_id
        OR installation.loop_version_id <> NEW.base_loop_version_id
      )) THEN
      RAISE EXCEPTION 'installation_update_draft_base_snapshot_mismatch'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.workspace_id, NEW.update_draft_id, NEW.installation_id, NEW.created_by,
    NEW.schema_version, NEW.asset_kind, NEW.skill_id, NEW.base_skill_version_id,
    NEW.loop_workflow_id, NEW.base_loop_version_id, NEW.base_release_id,
    NEW.base_installation_write_version, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id, OLD.update_draft_id, OLD.installation_id, OLD.created_by,
    OLD.schema_version, OLD.asset_kind, OLD.skill_id, OLD.base_skill_version_id,
    OLD.loop_workflow_id, OLD.base_loop_version_id, OLD.base_release_id,
    OLD.base_installation_write_version, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'installation_update_draft_identity_or_base_mutation_forbidden'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('applied', 'kept_current') THEN
    RAISE EXCEPTION 'terminal_installation_update_draft_mutation_forbidden'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.reject_immutable_loop_library_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'immutable_loop_library_history_mutation_forbidden: %', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER templates_version_content_immutable
  BEFORE UPDATE OR DELETE ON public.templates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_template_version_content_immutability();

CREATE TRIGGER workflow_revisions_immutable
  BEFORE UPDATE OR DELETE ON public.workflow_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_loop_library_history_mutation();

CREATE TRIGGER compile_results_immutable
  BEFORE UPDATE OR DELETE ON public.compile_results
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_loop_library_history_mutation();

CREATE TRIGGER execution_plans_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.execution_plans
  FOR EACH ROW EXECUTE FUNCTION public.enforce_finalizable_pin_parent();

CREATE CONSTRAINT TRIGGER execution_plans_model_consumption_guard
  AFTER INSERT OR UPDATE ON public.execution_plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_finalized_execution_plan_model_consumption();

CREATE TRIGGER execution_plan_model_pins_reject_finalized_append
  BEFORE INSERT ON public.execution_plan_model_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_finalized_pin_projection_append();

CREATE TRIGGER execution_plan_model_pins_immutable
  BEFORE UPDATE OR DELETE ON public.execution_plan_model_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_loop_library_history_mutation();

CREATE TRIGGER loop_versions_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.loop_versions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_finalizable_pin_parent();

CREATE TRIGGER loop_version_skill_pins_reject_finalized_append
  BEFORE INSERT ON public.loop_version_skill_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_finalized_pin_projection_append();

CREATE TRIGGER loop_version_resource_pins_reject_finalized_append
  BEFORE INSERT ON public.loop_version_resource_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_finalized_pin_projection_append();

CREATE TRIGGER loop_version_connection_requirements_reject_finalized_append
  BEFORE INSERT ON public.loop_version_connection_requirements
  FOR EACH ROW EXECUTE FUNCTION public.reject_finalized_pin_projection_append();

CREATE TRIGGER loop_version_skill_pins_immutable
  BEFORE UPDATE OR DELETE ON public.loop_version_skill_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_loop_library_history_mutation();

CREATE TRIGGER loop_version_resource_pins_immutable
  BEFORE UPDATE OR DELETE ON public.loop_version_resource_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_loop_library_history_mutation();

CREATE TRIGGER loop_version_connection_requirements_immutable
  BEFORE UPDATE OR DELETE ON public.loop_version_connection_requirements
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_loop_library_history_mutation();

CREATE TRIGGER workspace_asset_releases_immutable
  BEFORE UPDATE OR DELETE ON public.workspace_asset_releases
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_loop_library_history_mutation();

CREATE TRIGGER installation_update_drafts_enforce_snapshot
  BEFORE INSERT OR UPDATE ON public.installation_update_drafts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_installation_update_draft_snapshot();

-- G2B3: the outer Workflow Run is a Product-owned controller root. The six
-- tables below deliberately do not duplicate the G2A worker fabric, B4A actor
-- authority, or B2 pin projections.

CREATE TABLE public.workflow_runs (
  workspace_id public.product_identifier NOT NULL,
  run_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  command_kind text COLLATE "C" GENERATED ALWAYS AS ('workflow_run') STORED,
  command_target_kind text COLLATE "C" GENERATED ALWAYS AS ('workflow_run') STORED,
  command_target_revision integer GENERATED ALWAYS AS (1) STORED,
  workflow_id public.product_identifier NOT NULL,
  workflow_revision_id public.product_identifier NOT NULL,
  workflow_revision_content_hash text COLLATE "C" NOT NULL,
  compile_result_id public.product_identifier NOT NULL,
  compile_status text COLLATE "C" GENERATED ALWAYS AS ('ready') STORED,
  execution_plan_id public.product_identifier NOT NULL,
  execution_plan_content_hash text COLLATE "C" NOT NULL,
  plan_pins_finalized boolean GENERATED ALWAYS AS (true) STORED,
  retry_of_run_id public.product_identifier,
  schema_version text COLLATE "C" NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  resource_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key public.product_identifier NOT NULL,
  status text COLLATE "C" NOT NULL,
  current_node_id public.product_identifier,
  event_sequence bigint NOT NULL DEFAULT 0,
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, run_id),
  CONSTRAINT workflow_runs_command_uq UNIQUE (workspace_id, product_command_id),
  CONSTRAINT workflow_runs_idempotency_uq UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT workflow_runs_scope_identity_uq UNIQUE (
    workspace_id, run_id, scope_id
  ),
  CONSTRAINT workflow_runs_command_identity_uq UNIQUE (
    workspace_id, run_id, product_command_id
  ),
  CONSTRAINT workflow_runs_authority_uq UNIQUE (
    workspace_id, run_id, scope_id, product_command_id
  ),
  CONSTRAINT workflow_runs_pin_authority_uq UNIQUE (
    workspace_id, run_id, scope_id, product_command_id,
    workflow_id, workflow_revision_id, compile_result_id, execution_plan_id
  ),
  CONSTRAINT workflow_runs_command_fk
    FOREIGN KEY (
      workspace_id, product_command_id, scope_id, command_kind,
      command_target_kind, run_id, command_target_revision
    ) REFERENCES public.product_commands (
      workspace_id, command_id, scope_id, kind,
      target_kind, target_id, target_revision
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT workflow_runs_workflow_scope_fk
    FOREIGN KEY (workspace_id, workflow_id, scope_id)
    REFERENCES public.workflows (workspace_id, workflow_id, scope_id),
  CONSTRAINT workflow_runs_revision_fk
    FOREIGN KEY (
      workspace_id, workflow_id, workflow_revision_id,
      workflow_revision_content_hash
    ) REFERENCES public.workflow_revisions (
      workspace_id, workflow_id, revision_id, content_hash
    ),
  CONSTRAINT workflow_runs_compile_fk
    FOREIGN KEY (
      workspace_id, compile_result_id, execution_plan_id,
      workflow_id, workflow_revision_id, compile_status
    ) REFERENCES public.compile_results (
      workspace_id, compile_result_id, execution_plan_id,
      workflow_id, workflow_revision_id, status
    ),
  CONSTRAINT workflow_runs_plan_fk
    FOREIGN KEY (
      workspace_id, execution_plan_id, compile_result_id,
      workflow_id, workflow_revision_id, plan_pins_finalized
    ) REFERENCES public.execution_plans (
      workspace_id, plan_id, compile_result_id,
      workflow_id, workflow_revision_id, pins_finalized
    ),
  CONSTRAINT workflow_runs_retry_fk
    FOREIGN KEY (workspace_id, retry_of_run_id)
    REFERENCES public.workflow_runs (workspace_id, run_id),
  CONSTRAINT workflow_runs_schema_version
    CHECK (schema_version = 'workbench-run-v1'),
  CONSTRAINT workflow_runs_status CHECK (status IN (
    'queued', 'running', 'waiting_review', 'cancellation_requested',
    'completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
  )),
  CONSTRAINT workflow_runs_initial_projection CHECK (event_sequence >= 0),
  CONSTRAINT workflow_runs_retry_not_self CHECK (
    retry_of_run_id IS NULL OR retry_of_run_id <> run_id
  ),
  CONSTRAINT workflow_runs_hash_formats CHECK (
    workflow_revision_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND execution_plan_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  ),
  CONSTRAINT workflow_runs_documents CHECK (
    jsonb_typeof(inputs) = 'object'
    AND jsonb_typeof(resource_refs) = 'array'
    AND jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT workflow_runs_started_shape CHECK (
    started_at IS NULL OR started_at >= queued_at
  ),
  CONSTRAINT workflow_runs_terminal_shape CHECK (
    (status IN ('completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown'))
      = (finished_at IS NOT NULL)
  ),
  CONSTRAINT workflow_runs_time_order CHECK (
    created_at = queued_at AND updated_at >= created_at
    AND (finished_at IS NULL OR finished_at >= queued_at)
  )
);

CREATE INDEX workflow_runs_workspace_status_queued_idx
  ON public.workflow_runs (workspace_id, status, queued_at, run_id);
CREATE INDEX workflow_runs_workflow_created_idx
  ON public.workflow_runs (
    workspace_id, workflow_id, workflow_revision_id, created_at DESC, run_id
  );

CREATE TABLE public.workflow_run_events (
  workspace_id public.product_identifier NOT NULL,
  event_id public.product_identifier NOT NULL,
  run_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  sequence bigint NOT NULL,
  type text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  node_id public.product_identifier,
  node_attempt_id public.product_identifier,
  review_id public.product_identifier,
  summary text NOT NULL,
  writer_kind text COLLATE "C" NOT NULL,
  product_command_id public.product_identifier,
  run_fence integer NOT NULL,
  lease_owner public.product_identifier,
  lease_token public.product_identifier,
  lease_expires_at timestamptz,
  previous_run_fence integer,
  previous_lease_owner public.product_identifier,
  previous_lease_token public.product_identifier,
  previous_lease_expires_at timestamptz,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, event_id),
  CONSTRAINT workflow_run_events_run_fk
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.workflow_runs (workspace_id, run_id),
  CONSTRAINT workflow_run_events_command_fk
    FOREIGN KEY (workspace_id, product_command_id)
    REFERENCES public.product_commands (workspace_id, command_id),
  CONSTRAINT workflow_run_events_run_sequence_uq
    UNIQUE (workspace_id, run_id, sequence),
  CONSTRAINT workflow_run_events_run_event_uq
    UNIQUE (workspace_id, run_id, event_id),
  CONSTRAINT workflow_run_events_schema_version
    CHECK (schema_version = 'workbench-run-event-v1'),
  CONSTRAINT workflow_run_events_sequence_positive CHECK (sequence >= 1),
  CONSTRAINT workflow_run_events_type CHECK (type IN (
    'run.queued', 'run.started', 'run.worker_recovered', 'run.lease_renewed',
    'node.started', 'node.progress', 'node.completed', 'node.failed',
    'node.effect_recovery_started', 'node.effect_recovery_completed',
    'node.effect_recovery_unknown', 'review.requested', 'review.decided',
    'run.cancellation_requested', 'run.completed', 'run.failed',
    'run.cancelled', 'run.partial', 'run.effect_outcome_unknown'
  )),
  CONSTRAINT workflow_run_events_status CHECK (status IN (
    'queued', 'running', 'waiting_review', 'cancellation_requested',
    'completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown',
    'skipped'
  )),
  CONSTRAINT workflow_run_events_review_shape CHECK (
    (type NOT IN ('review.requested', 'review.decided') OR review_id IS NOT NULL)
    AND (review_id IS NULL OR type IN ('review.requested', 'review.decided', 'run.cancelled'))
    AND (review_id IS NULL OR node_id IS NOT NULL)
  ),
  CONSTRAINT workflow_run_events_node_attempt_shape CHECK (
    CASE
      WHEN type LIKE 'node.%'
        OR type = 'review.requested'
        OR (writer_kind = 'worker' AND type IN (
          'run.completed', 'run.failed', 'run.cancelled',
          'run.partial', 'run.effect_outcome_unknown'
        ))
      THEN node_id IS NOT NULL AND node_attempt_id IS NOT NULL
      ELSE node_attempt_id IS NULL
    END
  ),
  CONSTRAINT workflow_run_events_writer CHECK (
    (writer_kind = 'controller'
      AND product_command_id IS NOT NULL
      AND lease_owner IS NULL AND lease_token IS NULL)
    OR (writer_kind = 'worker'
      AND product_command_id IS NULL
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL)
  ),
  CONSTRAINT workflow_run_events_fence_nonnegative CHECK (run_fence >= 0),
  CONSTRAINT workflow_run_events_lease_shape CHECK (
    (type IN ('run.started', 'run.worker_recovered', 'run.lease_renewed'))
      = (lease_expires_at IS NOT NULL AND previous_run_fence IS NOT NULL)
    AND (
      type IN ('run.started', 'run.worker_recovered', 'run.lease_renewed')
      OR (lease_expires_at IS NULL AND previous_run_fence IS NULL
        AND previous_lease_owner IS NULL AND previous_lease_token IS NULL
        AND previous_lease_expires_at IS NULL)
    )
    AND (
      type <> 'run.lease_renewed'
      OR (previous_run_fence = run_fence
        AND previous_lease_owner = lease_owner
        AND previous_lease_token = lease_token
        AND previous_lease_expires_at IS NOT NULL)
    )
    AND ((previous_lease_owner IS NULL) = (previous_lease_token IS NULL))
    AND ((previous_lease_owner IS NULL) = (previous_lease_expires_at IS NULL))
  ),
  CONSTRAINT workflow_run_events_summary_length
    CHECK (length(summary) BETWEEN 1 AND 2000),
  CONSTRAINT workflow_run_events_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX workflow_run_events_one_terminal_uq
  ON public.workflow_run_events (workspace_id, run_id)
  WHERE status IN ('completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown');
CREATE INDEX workflow_run_events_cursor_idx
  ON public.workflow_run_events (workspace_id, run_id, sequence, event_id);
CREATE UNIQUE INDEX workflow_run_events_node_started_uq
  ON public.workflow_run_events (workspace_id, run_id, node_attempt_id)
  WHERE type = 'node.started';
CREATE UNIQUE INDEX workflow_run_events_node_outcome_uq
  ON public.workflow_run_events (workspace_id, run_id, node_attempt_id)
  WHERE type IN ('node.completed', 'node.failed');
CREATE UNIQUE INDEX workflow_run_events_effect_recovery_started_uq
  ON public.workflow_run_events (workspace_id, run_id, node_attempt_id)
  WHERE type = 'node.effect_recovery_started';
CREATE UNIQUE INDEX workflow_run_events_effect_recovery_outcome_uq
  ON public.workflow_run_events (workspace_id, run_id, node_attempt_id)
  WHERE type IN ('node.effect_recovery_completed', 'node.effect_recovery_unknown');

CREATE TABLE public.workflow_run_jobs (
  workspace_id public.product_identifier NOT NULL,
  run_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  state text COLLATE "C" NOT NULL,
  available_at timestamptz NOT NULL,
  queued_at timestamptz NOT NULL,
  lease_owner public.product_identifier,
  lease_token public.product_identifier,
  lease_expires_at timestamptz,
  lease_event_id public.product_identifier,
  fence integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, run_id),
  CONSTRAINT workflow_run_jobs_run_fk
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.workflow_runs (workspace_id, run_id),
  CONSTRAINT workflow_run_jobs_lease_event_fk
    FOREIGN KEY (workspace_id, lease_event_id)
    REFERENCES public.workflow_run_events (workspace_id, event_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT workflow_run_jobs_schema_version
    CHECK (schema_version = 'workbench-run-job-v1'),
  CONSTRAINT workflow_run_jobs_state
    CHECK (state IN ('queued', 'leased', 'waiting_review', 'terminal')),
  CONSTRAINT workflow_run_jobs_lease_shape CHECK (
    (state IN ('queued', 'waiting_review')
      AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (state = 'leased'
      AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_event_id IS NOT NULL)
    OR (state = 'terminal' AND (
      (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL)
    ))
  ),
  CONSTRAINT workflow_run_jobs_fence_nonnegative CHECK (fence >= 0),
  CONSTRAINT workflow_run_jobs_time_order CHECK (
    available_at >= queued_at AND created_at = queued_at
    AND updated_at >= created_at
    AND (lease_expires_at IS NULL OR lease_expires_at > updated_at)
  ),
  CONSTRAINT workflow_run_jobs_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX workflow_run_jobs_fifo_idx
  ON public.workflow_run_jobs (available_at, queued_at, run_id)
  WHERE state = 'queued';
CREATE INDEX workflow_run_jobs_lease_expiry_idx
  ON public.workflow_run_jobs (lease_expires_at, run_id)
  WHERE state = 'leased';

CREATE TABLE public.workflow_run_node_attempts (
  workspace_id public.product_identifier NOT NULL,
  node_attempt_id public.product_identifier NOT NULL,
  run_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  node_id public.product_identifier NOT NULL,
  attempt_number integer NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  invocation_id public.product_identifier NOT NULL,
  execution_attempt_id public.product_identifier NOT NULL,
  checkpoint_id public.product_identifier,
  run_fence integer NOT NULL,
  lease_owner public.product_identifier NOT NULL,
  lease_token public.product_identifier NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  invocation_session_key text COLLATE "C" GENERATED ALWAYS AS ('@none') STORED,
  invocation_turn_key text COLLATE "C" GENERATED ALWAYS AS ('@none') STORED,
  invocation_controller_kind text COLLATE "C"
    GENERATED ALWAYS AS ('workflow_run') STORED,
  PRIMARY KEY (workspace_id, node_attempt_id),
  CONSTRAINT workflow_run_node_attempts_run_node_attempt_uq UNIQUE (
    workspace_id, run_id, node_id, node_attempt_id
  ),
  CONSTRAINT workflow_run_node_attempts_worker_lineage_uq UNIQUE (
    workspace_id, run_id, node_id, node_attempt_id,
    run_fence, lease_owner, lease_token
  ),
  CONSTRAINT workflow_run_node_attempts_run_number_uq UNIQUE (
    workspace_id, run_id, node_id, attempt_number
  ),
  CONSTRAINT workflow_run_node_attempts_run_fk
    FOREIGN KEY (workspace_id, run_id, scope_id, product_command_id)
    REFERENCES public.workflow_runs (
      workspace_id, run_id, scope_id, product_command_id
    ),
  CONSTRAINT workflow_run_node_attempts_invocation_fk
    FOREIGN KEY (
      workspace_id, invocation_id, product_command_id,
      invocation_session_key, invocation_turn_key,
      invocation_controller_kind, run_id, run_fence
    ) REFERENCES public.execution_invocations (
      workspace_id, invocation_id, product_command_id,
      lineage_session_key, lineage_turn_key,
      controller_kind, controller_id, controller_fence
    ),
  CONSTRAINT workflow_run_node_attempts_execution_attempt_fk
    FOREIGN KEY (invocation_id, execution_attempt_id)
    REFERENCES public.execution_attempts (invocation_id, attempt_id),
  CONSTRAINT workflow_run_node_attempts_checkpoint_fk
    FOREIGN KEY (checkpoint_id)
    REFERENCES public.execution_checkpoints (checkpoint_id),
  CONSTRAINT workflow_run_node_attempts_schema_version
    CHECK (schema_version = 'workbench-run-node-attempt-v1'),
  CONSTRAINT workflow_run_node_attempts_number_positive CHECK (attempt_number >= 1),
  CONSTRAINT workflow_run_node_attempts_status CHECK (status IN (
    'queued', 'running', 'waiting_review', 'completed', 'failed', 'skipped',
    'cancelled', 'partial', 'effect_outcome_unknown'
  )),
  CONSTRAINT workflow_run_node_attempts_fence_positive CHECK (run_fence >= 1),
  CONSTRAINT workflow_run_node_attempts_started_shape CHECK (
    started_at IS NULL OR started_at >= created_at
  ),
  CONSTRAINT workflow_run_node_attempts_terminal_shape CHECK (
    (status IN (
      'completed', 'failed', 'skipped', 'cancelled', 'partial',
      'effect_outcome_unknown'
    )) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT workflow_run_node_attempts_time_order CHECK (
    updated_at >= created_at AND (finished_at IS NULL OR finished_at >= created_at)
  ),
  CONSTRAINT workflow_run_node_attempts_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX workflow_run_node_attempts_run_status_idx
  ON public.workflow_run_node_attempts (
    workspace_id, run_id, status, node_id, attempt_number
  );

ALTER TABLE public.workflow_run_events
  ADD CONSTRAINT workflow_run_events_node_attempt_fk
  FOREIGN KEY (
    workspace_id, run_id, node_id, node_attempt_id,
    run_fence, lease_owner, lease_token
  ) REFERENCES public.workflow_run_node_attempts (
    workspace_id, run_id, node_id, node_attempt_id,
    run_fence, lease_owner, lease_token
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.workflow_run_reviews (
  workspace_id public.product_identifier NOT NULL,
  review_id public.product_identifier NOT NULL,
  run_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  node_id public.product_identifier NOT NULL,
  node_attempt_id public.product_identifier NOT NULL,
  revision integer NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL,
  decision text COLLATE "C",
  decision_command_id public.product_identifier,
  decision_command_kind text COLLATE "C"
    GENERATED ALWAYS AS ('workflow_run_review') STORED,
  decision_target_kind text COLLATE "C"
    GENERATED ALWAYS AS ('workflow_run_review') STORED,
  cancellation_command_id public.product_identifier,
  cancellation_command_kind text COLLATE "C"
    GENERATED ALWAYS AS ('workflow_run_cancel') STORED,
  cancellation_target_kind text COLLATE "C"
    GENERATED ALWAYS AS ('workflow_run_cancellation') STORED,
  cancellation_target_revision integer GENERATED ALWAYS AS (1) STORED,
  requested_at timestamptz NOT NULL,
  decided_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, review_id),
  CONSTRAINT workflow_run_reviews_target_uq UNIQUE (
    workspace_id, review_id, run_id, scope_id, revision
  ),
  CONSTRAINT workflow_run_reviews_event_identity_uq UNIQUE (
    workspace_id, review_id, run_id, node_id
  ),
  CONSTRAINT workflow_run_reviews_node_attempt_fk
    FOREIGN KEY (workspace_id, run_id, node_id, node_attempt_id)
    REFERENCES public.workflow_run_node_attempts (
      workspace_id, run_id, node_id, node_attempt_id
    ),
  CONSTRAINT workflow_run_reviews_run_scope_fk
    FOREIGN KEY (workspace_id, run_id, scope_id)
    REFERENCES public.workflow_runs (workspace_id, run_id, scope_id),
  CONSTRAINT workflow_run_reviews_decision_command_fk
    FOREIGN KEY (
      workspace_id, decision_command_id, scope_id, decision_command_kind,
      decision_target_kind, review_id, revision
    ) REFERENCES public.product_commands (
      workspace_id, command_id, scope_id, kind,
      target_kind, target_id, target_revision
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT workflow_run_reviews_cancellation_command_fk
    FOREIGN KEY (
      workspace_id, cancellation_command_id, scope_id,
      cancellation_command_kind, cancellation_target_kind,
      run_id, cancellation_target_revision
    ) REFERENCES public.product_commands (
      workspace_id, command_id, scope_id, kind,
      target_kind, target_id, target_revision
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT workflow_run_reviews_schema_version
    CHECK (schema_version = 'workbench-run-review-v1'),
  CONSTRAINT workflow_run_reviews_revision_positive CHECK (revision >= 1),
  CONSTRAINT workflow_run_reviews_status CHECK (
    status IN ('pending', 'decided', 'cancelled')
  ),
  CONSTRAINT workflow_run_reviews_decision CHECK (
    decision IS NULL OR decision IN ('approve', 'reject', 'revise')
  ),
  CONSTRAINT workflow_run_reviews_decision_shape CHECK (
    (status = 'pending' AND decision IS NULL
      AND decision_command_id IS NULL AND cancellation_command_id IS NULL
      AND decided_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'decided' AND decision IS NOT NULL
      AND decision_command_id IS NOT NULL AND cancellation_command_id IS NULL
      AND decided_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND decision IS NULL
      AND decision_command_id IS NULL AND cancellation_command_id IS NOT NULL
      AND decided_at IS NULL AND cancelled_at IS NOT NULL)
  ),
  CONSTRAINT workflow_run_reviews_time_order CHECK (
    updated_at >= requested_at
    AND (decided_at IS NULL OR decided_at >= requested_at)
    AND (cancelled_at IS NULL OR cancelled_at >= requested_at)
  ),
  CONSTRAINT workflow_run_reviews_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX workflow_run_reviews_one_pending_node_uq
  ON public.workflow_run_reviews (workspace_id, run_id, node_id)
  WHERE status = 'pending';

ALTER TABLE public.workflow_run_events
  ADD CONSTRAINT workflow_run_events_review_fk
  FOREIGN KEY (workspace_id, review_id, run_id, node_id)
  REFERENCES public.workflow_run_reviews (
    workspace_id, review_id, run_id, node_id
  ) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.workflow_run_final_outputs (
  workspace_id public.product_identifier NOT NULL,
  run_id public.product_identifier NOT NULL,
  node_id public.product_identifier NOT NULL,
  node_attempt_id public.product_identifier NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  outcome text COLLATE "C" NOT NULL,
  run_fence integer NOT NULL,
  lease_owner public.product_identifier NOT NULL,
  lease_token public.product_identifier NOT NULL,
  final_answer jsonb NOT NULL,
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, run_id),
  CONSTRAINT workflow_run_final_outputs_run_fk
    FOREIGN KEY (workspace_id, run_id)
    REFERENCES public.workflow_runs (workspace_id, run_id),
  CONSTRAINT workflow_run_final_outputs_node_attempt_fk
    FOREIGN KEY (
      workspace_id, run_id, node_id, node_attempt_id,
      run_fence, lease_owner, lease_token
    ) REFERENCES public.workflow_run_node_attempts (
      workspace_id, run_id, node_id, node_attempt_id,
      run_fence, lease_owner, lease_token
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT workflow_run_final_outputs_schema_version
    CHECK (schema_version = 'workbench-run-final-output-v1'),
  CONSTRAINT workflow_run_final_outputs_outcome CHECK (
    outcome IN ('completed', 'partial')
  ),
  CONSTRAINT workflow_run_final_outputs_fence_positive CHECK (run_fence >= 1),
  CONSTRAINT workflow_run_final_outputs_documents CHECK (
    jsonb_typeof(final_answer) = 'object'
    AND jsonb_typeof(artifact_refs) = 'array'
    AND jsonb_typeof(evidence_refs) = 'array'
    AND jsonb_typeof(payload) = 'object'
  )
);

CREATE FUNCTION public.enforce_workflow_run_root()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_status text;
  actual_plan_hash text;
  retry_source public.workflow_runs%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_run_root_delete_forbidden' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT c.status INTO command_status
    FROM public.product_commands c
    WHERE c.workspace_id = NEW.workspace_id
      AND c.command_id = NEW.product_command_id
      AND c.scope_id = NEW.scope_id
      AND c.kind = 'workflow_run'
      AND c.target_kind = 'workflow_run'
      AND c.target_id = NEW.run_id
      AND c.target_revision = 1
    FOR SHARE;
    IF command_status IS DISTINCT FROM 'accepted' THEN
      RAISE EXCEPTION 'workflow_run_command_not_accepted' USING ERRCODE = '23514';
    END IF;

    SELECT p.content_hash INTO actual_plan_hash
    FROM public.execution_plans p
    WHERE p.workspace_id = NEW.workspace_id
      AND p.plan_id = NEW.execution_plan_id
      AND p.compile_result_id = NEW.compile_result_id
      AND p.workflow_id = NEW.workflow_id
      AND p.workflow_revision_id = NEW.workflow_revision_id
      AND p.pins_finalized IS TRUE
    FOR SHARE;
    IF actual_plan_hash IS DISTINCT FROM NEW.execution_plan_content_hash THEN
      RAISE EXCEPTION 'workflow_run_plan_hash_mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'queued' OR NEW.event_sequence <> 0
      OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
      OR NEW.current_node_id IS NOT NULL THEN
      RAISE EXCEPTION 'workflow_run_initial_state_invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.retry_of_run_id IS NOT NULL THEN
      SELECT * INTO retry_source
      FROM public.workflow_runs source
      WHERE source.workspace_id = NEW.workspace_id
        AND source.run_id = NEW.retry_of_run_id
      FOR SHARE;
      IF NOT FOUND
        OR retry_source.status NOT IN ('failed', 'cancelled')
        OR retry_source.scope_id <> NEW.scope_id
        OR retry_source.workflow_id <> NEW.workflow_id
        OR retry_source.workflow_revision_id <> NEW.workflow_revision_id
        OR retry_source.workflow_revision_content_hash
          <> NEW.workflow_revision_content_hash
        OR retry_source.compile_result_id <> NEW.compile_result_id
        OR retry_source.execution_plan_id <> NEW.execution_plan_id
        OR retry_source.execution_plan_content_hash
          <> NEW.execution_plan_content_hash
        OR retry_source.inputs IS DISTINCT FROM NEW.inputs
        OR retry_source.resource_refs IS DISTINCT FROM NEW.resource_refs THEN
        RAISE EXCEPTION 'workflow_run_retry_source_invalid' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.workspace_id, NEW.run_id, NEW.scope_id, NEW.product_command_id,
    NEW.workflow_id, NEW.workflow_revision_id, NEW.workflow_revision_content_hash,
    NEW.compile_result_id, NEW.execution_plan_id, NEW.execution_plan_content_hash,
    NEW.retry_of_run_id, NEW.schema_version, NEW.inputs, NEW.resource_refs,
    NEW.idempotency_key, NEW.queued_at, NEW.created_at, NEW.payload
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id, OLD.run_id, OLD.scope_id, OLD.product_command_id,
    OLD.workflow_id, OLD.workflow_revision_id, OLD.workflow_revision_content_hash,
    OLD.compile_result_id, OLD.execution_plan_id, OLD.execution_plan_content_hash,
    OLD.retry_of_run_id, OLD.schema_version, OLD.inputs, OLD.resource_refs,
    OLD.idempotency_key, OLD.queued_at, OLD.created_at, OLD.payload
  ) THEN
    RAISE EXCEPTION 'workflow_run_root_immutable' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.status, NEW.current_node_id, NEW.event_sequence,
         NEW.started_at, NEW.finished_at)
      IS DISTINCT FROM
     ROW(OLD.status, OLD.current_node_id, OLD.event_sequence,
         OLD.started_at, OLD.finished_at)
    AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'workflow_run_lifecycle_requires_event' USING ERRCODE = '55000';
  END IF;
  IF NEW.event_sequence <> OLD.event_sequence + 1 THEN
    RAISE EXCEPTION 'workflow_run_event_sequence_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'workflow_run_time_regression' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_control_command()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_status text;
  target_valid boolean;
BEGIN
  IF NEW.kind = 'workflow_run_cancel' THEN
    SELECT r.status INTO target_status
    FROM public.workflow_runs r
    WHERE r.workspace_id = NEW.workspace_id
      AND r.run_id = NEW.target_id
      AND r.scope_id = NEW.scope_id
      AND NEW.target_kind = 'workflow_run_cancellation'
      AND NEW.target_revision = 1
    FOR UPDATE;
    IF target_status IS NULL OR target_status IN (
      'completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
    ) THEN
      RAISE EXCEPTION 'workflow_run_cancel_target_invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.kind = 'workflow_run_review' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.workflow_run_reviews review
      WHERE review.workspace_id = NEW.workspace_id
        AND review.review_id = NEW.target_id
        AND review.scope_id = NEW.scope_id
        AND review.revision = NEW.target_revision
        AND review.status = 'pending'
    ) INTO target_valid;
    IF target_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'workflow_run_review_target_invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.apply_workflow_run_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_row public.workflow_runs%ROWTYPE;
  job_row public.workflow_run_jobs%ROWTYPE;
  command_scope public.product_identifier;
  controller_authorized boolean;
  transition_allowed boolean;
  command_status text;
  projected_status text;
  authority_now timestamptz;
BEGIN
  SELECT * INTO run_row FROM public.workflow_runs
  WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id
  FOR UPDATE;
  IF NOT FOUND OR NEW.sequence <> run_row.event_sequence + 1 THEN
    RAISE EXCEPTION 'workflow_run_event_sequence_invalid' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO job_row FROM public.workflow_run_jobs
  WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_run_job_missing' USING ERRCODE = '23503';
  END IF;
  authority_now := clock_timestamp();

  IF NEW.node_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.execution_plans plan
    CROSS JOIN LATERAL jsonb_array_elements(plan.plan_document -> 'steps') step
    WHERE plan.workspace_id = run_row.workspace_id
      AND plan.plan_id = run_row.execution_plan_id
      AND step ->> 'nodeId' = NEW.node_id
  ) THEN
    RAISE EXCEPTION 'workflow_run_event_node_not_in_plan' USING ERRCODE = '23514';
  END IF;

  IF NEW.sequence = 1 THEN
    IF NEW.type <> 'run.queued' OR NEW.status <> 'queued'
      OR NEW.writer_kind <> 'controller'
      OR NEW.product_command_id <> run_row.product_command_id
      OR NEW.run_fence <> 0 OR job_row.state <> 'queued' OR job_row.fence <> 0 THEN
      RAISE EXCEPTION 'workflow_run_initial_event_invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    projected_status := CASE WHEN NEW.status = 'skipped' THEN run_row.status ELSE NEW.status END;
    IF NOT (
      (NEW.type = 'run.started'
        AND NEW.writer_kind = 'worker' AND NEW.status = 'running')
      OR (NEW.type = 'run.worker_recovered'
        AND NEW.writer_kind = 'worker'
        AND NEW.status IN ('running', 'cancellation_requested'))
      OR (NEW.type = 'run.lease_renewed'
        AND NEW.writer_kind = 'worker'
        AND NEW.status IN ('running', 'cancellation_requested'))
      OR (NEW.type IN (
          'node.started', 'node.progress', 'node.completed', 'node.failed',
          'node.effect_recovery_started', 'node.effect_recovery_completed',
          'node.effect_recovery_unknown'
        ) AND NEW.writer_kind = 'worker' AND NEW.status IN ('running', 'skipped'))
      OR (NEW.type = 'review.requested'
        AND NEW.writer_kind = 'worker' AND NEW.status = 'waiting_review')
      OR (NEW.type = 'review.decided'
        AND NEW.writer_kind = 'controller' AND NEW.status = 'running')
      OR (NEW.type = 'run.cancellation_requested'
        AND NEW.writer_kind = 'controller'
        AND NEW.status = 'cancellation_requested')
      OR (NEW.type = 'run.completed'
        AND NEW.writer_kind = 'worker' AND NEW.status = 'completed')
      OR (NEW.type = 'run.failed' AND NEW.status = 'failed')
      OR (NEW.type = 'run.cancelled' AND NEW.status = 'cancelled')
      OR (NEW.type = 'run.partial'
        AND NEW.writer_kind = 'worker' AND NEW.status = 'partial')
      OR (NEW.type = 'run.effect_outcome_unknown'
        AND NEW.writer_kind = 'worker' AND NEW.status = 'effect_outcome_unknown')
    ) THEN
      RAISE EXCEPTION 'workflow_run_event_type_status_writer_mismatch'
        USING ERRCODE = '23514';
    END IF;
    transition_allowed := CASE run_row.status
      WHEN 'queued' THEN projected_status IN (
        'queued', 'running', 'cancellation_requested', 'cancelled', 'failed'
      )
      WHEN 'running' THEN projected_status IN (
        'running', 'waiting_review', 'cancellation_requested', 'completed',
        'failed', 'partial', 'effect_outcome_unknown'
      )
      WHEN 'waiting_review' THEN projected_status IN (
        'waiting_review', 'running', 'cancellation_requested', 'cancelled', 'failed'
      )
      WHEN 'cancellation_requested' THEN projected_status IN (
        'cancellation_requested', 'cancelled', 'failed', 'partial',
        'effect_outcome_unknown'
      )
      ELSE false
    END;
    IF transition_allowed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'workflow_run_transition_invalid' USING ERRCODE = '23514';
    END IF;

    IF NEW.writer_kind = 'worker' THEN
      IF NEW.type = 'run.lease_renewed'
        AND NEW.lease_expires_at <= NEW.previous_lease_expires_at THEN
        RAISE EXCEPTION 'workflow_run_lease_expiry_not_extended'
          USING ERRCODE = '23514';
      END IF;
      IF job_row.state <> 'leased'
        OR job_row.fence <> NEW.run_fence
        OR job_row.lease_owner <> NEW.lease_owner
        OR job_row.lease_token <> NEW.lease_token
        OR job_row.lease_expires_at <= authority_now
        OR (NEW.type IN (
          'run.started', 'run.worker_recovered', 'run.lease_renewed'
        ) AND (
          NEW.lease_expires_at IS DISTINCT FROM job_row.lease_expires_at
          OR NEW.lease_expires_at <= authority_now
          OR NEW.lease_expires_at > authority_now + interval '1 hour'
        )) THEN
        RAISE EXCEPTION 'workflow_run_stale_worker_event' USING ERRCODE = '55000';
      END IF;
    ELSE
      SELECT c.scope_id INTO command_scope
      FROM public.product_commands c
      WHERE c.workspace_id = NEW.workspace_id
        AND c.command_id = NEW.product_command_id;
      controller_authorized := CASE
        WHEN NEW.type = 'run.cancellation_requested' THEN EXISTS (
          SELECT 1 FROM public.product_commands c
          WHERE c.workspace_id = run_row.workspace_id
            AND c.command_id = NEW.product_command_id
            AND c.scope_id = run_row.scope_id
            AND c.kind = 'workflow_run_cancel'
            AND c.target_kind = 'workflow_run_cancellation'
            AND c.target_id = run_row.run_id
            AND c.target_revision = 1
            AND c.status = 'completed'
        )
        WHEN NEW.type = 'run.cancelled' AND EXISTS (
          SELECT 1 FROM public.product_commands cancellation
          WHERE cancellation.workspace_id = run_row.workspace_id
            AND cancellation.command_id = NEW.product_command_id
            AND cancellation.kind = 'workflow_run_cancel'
        ) THEN job_row.state IN ('queued', 'waiting_review')
          AND job_row.lease_owner IS NULL
          AND job_row.lease_token IS NULL
          AND job_row.lease_expires_at IS NULL
          AND EXISTS (
            SELECT 1 FROM public.product_commands c
            WHERE c.workspace_id = run_row.workspace_id
              AND c.command_id = NEW.product_command_id
              AND c.scope_id = run_row.scope_id
              AND c.kind = 'workflow_run_cancel'
              AND c.target_kind = 'workflow_run_cancellation'
              AND c.target_id = run_row.run_id
              AND c.target_revision = 1
              AND c.status = 'completed'
          )
          AND (
            job_row.state <> 'waiting_review'
            OR (
              NEW.review_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.workflow_run_reviews review
                WHERE review.workspace_id = run_row.workspace_id
                  AND review.run_id = run_row.run_id
                  AND review.review_id = NEW.review_id
                  AND review.status = 'cancelled'
                  AND review.cancellation_command_id = NEW.product_command_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.workflow_run_reviews pending
                WHERE pending.workspace_id = run_row.workspace_id
                  AND pending.run_id = run_row.run_id
                  AND pending.status = 'pending'
              )
            )
          )
        WHEN NEW.type = 'review.decided'
          OR (NEW.type = 'run.cancelled' AND run_row.status = 'waiting_review') THEN EXISTS (
          SELECT 1 FROM public.workflow_run_reviews review
          JOIN public.product_commands c
            ON c.workspace_id = review.workspace_id
           AND c.command_id = review.decision_command_id
           AND c.scope_id = review.scope_id
           AND c.kind = 'workflow_run_review'
           AND c.target_kind = 'workflow_run_review'
           AND c.target_id = review.review_id
           AND c.target_revision = review.revision
           AND c.status = 'completed'
          WHERE review.workspace_id = run_row.workspace_id
            AND review.run_id = run_row.run_id
            AND review.decision_command_id = NEW.product_command_id
            AND review.status = 'decided'
            AND review.review_id = NEW.review_id
            AND (
              (NEW.type = 'review.decided' AND review.decision IN ('approve', 'revise'))
              OR (NEW.type = 'run.cancelled' AND review.decision = 'reject')
            )
        )
        WHEN NEW.type = 'run.failed'
          AND run_row.status = 'queued' AND job_row.fence = 0 THEN
          NEW.product_command_id = run_row.product_command_id
        ELSE false
      END;
      IF command_scope IS DISTINCT FROM run_row.scope_id
        OR NEW.run_fence <> job_row.fence
        OR controller_authorized IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'workflow_run_controller_event_unauthorized' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF NEW.status IN ('completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown')
    AND NEW.type <> 'run.' || NEW.status THEN
    RAISE EXCEPTION 'workflow_run_terminal_event_type_mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.type = 'review.requested' AND NEW.status <> 'waiting_review' THEN
    RAISE EXCEPTION 'workflow_run_review_event_state_mismatch' USING ERRCODE = '23514';
  END IF;

  UPDATE public.workflow_runs
  SET status = CASE WHEN NEW.status = 'skipped' THEN status ELSE NEW.status END,
      current_node_id = COALESCE(NEW.node_id, current_node_id),
      event_sequence = NEW.sequence,
      started_at = CASE
        WHEN NEW.status = 'running' THEN COALESCE(started_at, NEW.occurred_at)
        ELSE started_at
      END,
      finished_at = CASE
        WHEN NEW.status IN (
          'completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
        ) THEN NEW.occurred_at
        ELSE NULL
      END,
      updated_at = NEW.occurred_at
  WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id;

  IF NEW.status = 'waiting_review' THEN
    UPDATE public.workflow_run_jobs
    SET state = 'waiting_review', lease_owner = NULL, lease_token = NULL,
        lease_expires_at = NULL, lease_event_id = NEW.event_id,
        updated_at = NEW.occurred_at
    WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id;
  ELSIF NEW.status IN (
    'completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
  ) THEN
    UPDATE public.workflow_run_jobs
    SET state = 'terminal',
        lease_owner = CASE WHEN NEW.writer_kind = 'worker' THEN lease_owner ELSE NULL END,
        lease_token = CASE WHEN NEW.writer_kind = 'worker' THEN lease_token ELSE NULL END,
        lease_expires_at = CASE
          WHEN NEW.writer_kind = 'worker' THEN lease_expires_at ELSE NULL END,
        updated_at = NEW.occurred_at
    WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id;
  END IF;

  command_status := CASE NEW.status
    WHEN 'running' THEN 'running'
    WHEN 'cancellation_requested' THEN 'cancellation_requested'
    WHEN 'completed' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    WHEN 'partial' THEN 'blocked'
    WHEN 'effect_outcome_unknown' THEN 'blocked'
    ELSE NULL
  END;
  IF command_status IS NOT NULL THEN
    UPDATE public.product_commands
    SET status = command_status,
        finished_at = CASE
          WHEN command_status IN ('completed', 'failed', 'cancelled', 'blocked')
          THEN NEW.occurred_at ELSE NULL END,
        updated_at = NEW.occurred_at
    WHERE workspace_id = NEW.workspace_id
      AND command_id = run_row.product_command_id
      AND status <> command_status;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_workflow_run_job_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_run_job_delete_forbidden' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' OR NEW.fence <> 0 OR NEW.lease_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'workflow_run_job_initial_state_invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.workspace_id, NEW.run_id, NEW.schema_version, NEW.queued_at,
         NEW.created_at, NEW.payload)
      IS DISTINCT FROM
     ROW(OLD.workspace_id, OLD.run_id, OLD.schema_version, OLD.queued_at,
         OLD.created_at, OLD.payload) THEN
    RAISE EXCEPTION 'workflow_run_job_identity_immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.fence < OLD.fence OR NEW.fence > OLD.fence + 1 THEN
    RAISE EXCEPTION 'workflow_run_job_fence_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'leased' AND NEW.fence <> OLD.fence + 1
    AND ROW(NEW.lease_owner, NEW.lease_token)
      IS DISTINCT FROM ROW(OLD.lease_owner, OLD.lease_token) THEN
    RAISE EXCEPTION 'workflow_run_job_lease_requires_new_fence' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.fence, NEW.lease_owner, NEW.lease_token, NEW.lease_expires_at)
      IS DISTINCT FROM
     ROW(OLD.fence, OLD.lease_owner, OLD.lease_token, OLD.lease_expires_at)
    AND NEW.lease_event_id IS NOT DISTINCT FROM OLD.lease_event_id THEN
    RAISE EXCEPTION 'workflow_run_job_lease_event_id_required'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.claim_workflow_run_job(
  worker_id public.product_identifier,
  worker_lease_token public.product_identifier,
  claim_event_id public.product_identifier,
  lease_duration interval
)
RETURNS SETOF public.workflow_run_jobs
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  candidate public.workflow_run_jobs%ROWTYPE;
  claimed public.workflow_run_jobs%ROWTYPE;
  candidate_workspace_id public.product_identifier;
  candidate_run_id public.product_identifier;
  candidate_plan_id public.product_identifier;
  next_sequence bigint;
  database_now timestamptz;
  candidate_run_status text;
BEGIN
  IF lease_duration <= interval '0 seconds' OR lease_duration > interval '1 hour' THEN
    RAISE EXCEPTION 'workflow_run_lease_duration_invalid' USING ERRCODE = '22023';
  END IF;
  database_now := clock_timestamp();
  SELECT r.workspace_id, r.run_id, r.execution_plan_id, r.status
  INTO candidate_workspace_id, candidate_run_id, candidate_plan_id, candidate_run_status
  FROM public.workflow_runs r
  JOIN public.workflow_run_jobs j
    ON j.workspace_id = r.workspace_id AND j.run_id = r.run_id
  WHERE (
      (j.state = 'queued' AND j.available_at <= database_now
        AND r.status IN ('queued', 'running', 'waiting_review'))
      OR (j.state = 'leased' AND j.lease_expires_at <= database_now
        AND r.status IN ('running', 'cancellation_requested'))
    )
  ORDER BY j.available_at, j.queued_at, j.run_id
  FOR UPDATE OF r SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO candidate
  FROM public.workflow_run_jobs j
  WHERE j.workspace_id = candidate_workspace_id AND j.run_id = candidate_run_id
  FOR UPDATE;
  database_now := clock_timestamp();
  IF NOT (
    (candidate.state = 'queued' AND candidate.available_at <= database_now)
    OR (candidate.state = 'leased' AND candidate.lease_expires_at <= database_now)
  ) THEN RETURN; END IF;

  PERFORM public.assert_execution_plan_model_pins_consumable(
    candidate_workspace_id, candidate_plan_id
  );
  PERFORM public.assert_execution_plan_connection_bindings_consumable(
    candidate_workspace_id, candidate_plan_id
  );

  UPDATE public.workflow_run_jobs
  SET state = 'leased', lease_owner = worker_id,
      lease_token = worker_lease_token,
      lease_expires_at = database_now + lease_duration,
      lease_event_id = claim_event_id,
      fence = candidate.fence + 1, updated_at = database_now
  WHERE workspace_id = candidate.workspace_id AND run_id = candidate.run_id
  RETURNING * INTO claimed;

  SELECT event_sequence + 1 INTO next_sequence
  FROM public.workflow_runs
  WHERE workspace_id = claimed.workspace_id AND run_id = claimed.run_id;
  INSERT INTO public.workflow_run_events (
    workspace_id, event_id, run_id, schema_version, sequence, type, status,
    summary, writer_kind, run_fence, lease_owner, lease_token,
    lease_expires_at, previous_run_fence, previous_lease_owner,
    previous_lease_token, previous_lease_expires_at, occurred_at
  ) VALUES (
    claimed.workspace_id, claim_event_id,
    claimed.run_id, 'workbench-run-event-v1', next_sequence,
    CASE WHEN candidate.state = 'leased'
      THEN 'run.worker_recovered' ELSE 'run.started' END,
    CASE WHEN candidate_run_status = 'cancellation_requested'
      THEN 'cancellation_requested' ELSE 'running' END,
    'Run worker claimed.', 'worker', claimed.fence,
    claimed.lease_owner, claimed.lease_token,
    claimed.lease_expires_at, candidate.fence, candidate.lease_owner,
    candidate.lease_token, candidate.lease_expires_at, database_now
  );
  RETURN NEXT claimed;
END;
$function$;

CREATE FUNCTION public.renew_workflow_run_job_lease(
  target_workspace_id public.product_identifier,
  target_run_id public.product_identifier,
  worker_id public.product_identifier,
  worker_lease_token public.product_identifier,
  renewal_event_id public.product_identifier,
  lease_duration interval
)
RETURNS public.workflow_run_jobs
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_row public.workflow_runs%ROWTYPE;
  job_row public.workflow_run_jobs%ROWTYPE;
  renewed public.workflow_run_jobs%ROWTYPE;
  database_now timestamptz;
  next_expiry timestamptz;
BEGIN
  IF lease_duration <= interval '0 seconds'
    OR lease_duration > interval '1 hour' THEN
    RAISE EXCEPTION 'workflow_run_lease_duration_invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO run_row
  FROM public.workflow_runs run
  WHERE run.workspace_id = target_workspace_id AND run.run_id = target_run_id
  FOR UPDATE;
  IF NOT FOUND OR run_row.status NOT IN ('running', 'cancellation_requested') THEN
    RAISE EXCEPTION 'workflow_run_lease_renewal_target_invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO job_row
  FROM public.workflow_run_jobs job
  WHERE job.workspace_id = target_workspace_id AND job.run_id = target_run_id
  FOR UPDATE;
  database_now := clock_timestamp();
  IF NOT FOUND OR job_row.state <> 'leased'
    OR job_row.lease_owner <> worker_id
    OR job_row.lease_token <> worker_lease_token
    OR job_row.lease_expires_at <= database_now THEN
    RAISE EXCEPTION 'workflow_run_stale_lease_renewal'
      USING ERRCODE = '55000';
  END IF;

  next_expiry := database_now + lease_duration;
  IF next_expiry <= job_row.lease_expires_at THEN
    RAISE EXCEPTION 'workflow_run_lease_expiry_not_extended'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.workflow_run_jobs
  SET lease_expires_at = next_expiry,
      lease_event_id = renewal_event_id,
      updated_at = database_now
  WHERE workspace_id = target_workspace_id AND run_id = target_run_id
  RETURNING * INTO renewed;

  INSERT INTO public.workflow_run_events (
    workspace_id, event_id, run_id, schema_version, sequence, type, status,
    summary, writer_kind, run_fence, lease_owner, lease_token,
    lease_expires_at, previous_run_fence, previous_lease_owner,
    previous_lease_token, previous_lease_expires_at, occurred_at
  ) VALUES (
    target_workspace_id, renewal_event_id, target_run_id,
    'workbench-run-event-v1', run_row.event_sequence + 1,
    'run.lease_renewed', run_row.status, 'Run worker lease renewed.',
    'worker', job_row.fence, worker_id, worker_lease_token,
    next_expiry, job_row.fence, job_row.lease_owner,
    job_row.lease_token, job_row.lease_expires_at, database_now
  );
  RETURN renewed;
END;
$function$;

CREATE FUNCTION public.close_workflow_run_recovered_execution(
  target_workspace_id public.product_identifier,
  target_run_id public.product_identifier,
  worker_id public.product_identifier,
  worker_lease_token public.product_identifier
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_row public.workflow_runs%ROWTYPE;
  job_row public.workflow_run_jobs%ROWTYPE;
  database_now timestamptz;
  closed_invocation_count integer;
BEGIN
  SELECT * INTO run_row
  FROM public.workflow_runs run
  WHERE run.workspace_id = target_workspace_id AND run.run_id = target_run_id
  FOR UPDATE;
  IF NOT FOUND OR run_row.status NOT IN ('running', 'cancellation_requested') THEN
    RAISE EXCEPTION 'workflow_run_recovery_target_invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO job_row
  FROM public.workflow_run_jobs job
  WHERE job.workspace_id = target_workspace_id AND job.run_id = target_run_id
  FOR UPDATE;
  database_now := clock_timestamp();
  IF NOT FOUND OR job_row.state <> 'leased'
    OR job_row.lease_owner <> worker_id
    OR job_row.lease_token <> worker_lease_token
    OR job_row.lease_expires_at <= database_now
    OR NOT EXISTS (
      SELECT 1 FROM public.workflow_run_events recovery
      WHERE recovery.workspace_id = target_workspace_id
        AND recovery.run_id = target_run_id
        AND recovery.type = 'run.worker_recovered'
        AND recovery.run_fence = job_row.fence
        AND recovery.lease_owner = job_row.lease_owner
        AND recovery.lease_token = job_row.lease_token
    ) THEN
    RAISE EXCEPTION 'workflow_run_recovery_authority_invalid'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.workflow_run_node_attempts node_attempt
  SET status = 'cancelled', finished_at = database_now, updated_at = database_now
  WHERE node_attempt.workspace_id = target_workspace_id
    AND node_attempt.run_id = target_run_id
    AND node_attempt.run_fence < job_row.fence
    AND node_attempt.status IN ('queued', 'running', 'waiting_review');

  UPDATE public.execution_attempts execution_attempt
  SET status = 'cancelled', finished_at = database_now, updated_at = database_now
  FROM public.execution_invocations invocation
  WHERE invocation.invocation_id = execution_attempt.invocation_id
    AND invocation.workspace_id = target_workspace_id
    AND invocation.controller_kind = 'workflow_run'
    AND invocation.controller_id = target_run_id
    AND invocation.controller_fence < job_row.fence
    AND execution_attempt.status IN ('queued', 'running');

  UPDATE public.execution_invocations invocation
  SET status = 'cancelled', finished_at = database_now, updated_at = database_now
  WHERE invocation.workspace_id = target_workspace_id
    AND invocation.controller_kind = 'workflow_run'
    AND invocation.controller_id = target_run_id
    AND invocation.controller_fence < job_row.fence
    AND invocation.status IN ('queued', 'running', 'cancellation_requested');
  GET DIAGNOSTICS closed_invocation_count = ROW_COUNT;

  UPDATE public.capability_leases capability
  SET status = 'revoked', revoked_at = database_now, updated_at = database_now
  FROM public.execution_invocations invocation
  WHERE invocation.invocation_id = capability.invocation_id
    AND invocation.workspace_id = target_workspace_id
    AND invocation.controller_kind = 'workflow_run'
    AND invocation.controller_id = target_run_id
    AND invocation.controller_fence < job_row.fence
    AND capability.status <> 'revoked';

  UPDATE public.capacity_leases capacity
  SET status = 'released', released_at = database_now, updated_at = database_now
  WHERE capacity.capacity_lease_id IN (
      SELECT invocation.capacity_lease_id
      FROM public.execution_invocations invocation
      WHERE invocation.workspace_id = target_workspace_id
        AND invocation.controller_kind = 'workflow_run'
        AND invocation.controller_id = target_run_id
        AND invocation.controller_fence < job_row.fence
    )
    AND capacity.status <> 'released';
  RETURN closed_invocation_count;
END;
$function$;

CREATE FUNCTION public.decide_workflow_run_review(
  target_workspace_id public.product_identifier,
  target_review_id public.product_identifier,
  review_decision_command_id public.product_identifier,
  review_decision text
)
RETURNS public.workflow_run_reviews
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target_run_id public.product_identifier;
  run_row public.workflow_runs%ROWTYPE;
  job_row public.workflow_run_jobs%ROWTYPE;
  review_row public.workflow_run_reviews%ROWTYPE;
  node_attempt_row public.workflow_run_node_attempts%ROWTYPE;
  invocation_row public.execution_invocations%ROWTYPE;
  review_event_id public.product_identifier;
  database_now timestamptz;
  settled_status text;
  changed_count integer;
BEGIN
  IF review_decision NOT IN ('approve', 'revise') THEN
    RAISE EXCEPTION 'workflow_run_review_decision_unsupported'
      USING ERRCODE = '22023';
  END IF;
  SELECT review.run_id INTO target_run_id
  FROM public.workflow_run_reviews review
  WHERE review.workspace_id = target_workspace_id
    AND review.review_id = target_review_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_run_review_not_found' USING ERRCODE = '23503';
  END IF;

  SELECT * INTO run_row
  FROM public.workflow_runs run
  WHERE run.workspace_id = target_workspace_id AND run.run_id = target_run_id
  FOR UPDATE;
  SELECT * INTO job_row
  FROM public.workflow_run_jobs job
  WHERE job.workspace_id = target_workspace_id AND job.run_id = target_run_id
  FOR UPDATE;
  SELECT * INTO review_row
  FROM public.workflow_run_reviews review
  WHERE review.workspace_id = target_workspace_id
    AND review.review_id = target_review_id
  FOR UPDATE;

  review_event_id := md5(
    review_decision_command_id::text || ':review.decided:' || review_decision
  )::public.product_identifier;
  IF review_row.status = 'decided'
    AND review_row.decision_command_id = review_decision_command_id
    AND review_row.decision = review_decision THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.workflow_run_events event
      WHERE event.workspace_id = target_workspace_id
        AND event.run_id = target_run_id
        AND event.event_id = review_event_id
        AND event.type = 'review.decided'
        AND event.review_id = target_review_id
        AND event.product_command_id = review_decision_command_id
    ) OR EXISTS (
      SELECT 1
      FROM public.workflow_run_node_attempts node_attempt
      JOIN public.execution_invocations invocation
        ON invocation.invocation_id = node_attempt.invocation_id
      JOIN public.execution_attempts execution_attempt
        ON execution_attempt.invocation_id = invocation.invocation_id
      LEFT JOIN public.capability_leases capability
        ON capability.invocation_id = invocation.invocation_id
      LEFT JOIN public.capacity_leases capacity
        ON capacity.capacity_lease_id = invocation.capacity_lease_id
      WHERE node_attempt.workspace_id = target_workspace_id
        AND node_attempt.node_attempt_id = review_row.node_attempt_id
        AND (
          node_attempt.status NOT IN ('completed', 'cancelled')
          OR invocation.status NOT IN ('completed', 'cancelled')
          OR execution_attempt.status IN ('queued', 'running')
          OR capability.status IS DISTINCT FROM 'revoked'
          OR capacity.status IS DISTINCT FROM 'released'
        )
    ) THEN
      RAISE EXCEPTION 'workflow_run_review_replay_inconsistent'
        USING ERRCODE = '23514';
    END IF;
    RETURN review_row;
  END IF;
  IF run_row.status <> 'waiting_review'
    OR job_row.state <> 'waiting_review'
    OR review_row.status <> 'pending' THEN
    RAISE EXCEPTION 'workflow_run_review_not_waiting' USING ERRCODE = '23514';
  END IF;
  database_now := clock_timestamp();
  settled_status := CASE review_decision
    WHEN 'approve' THEN 'completed' ELSE 'cancelled' END;

  SELECT * INTO node_attempt_row
  FROM public.workflow_run_node_attempts node_attempt
  WHERE node_attempt.workspace_id = target_workspace_id
    AND node_attempt.node_attempt_id = review_row.node_attempt_id;
  IF NOT FOUND OR node_attempt_row.status <> 'waiting_review' THEN
    RAISE EXCEPTION 'workflow_run_review_attempt_not_waiting'
      USING ERRCODE = '23514';
  END IF;
  PERFORM execution_attempt.attempt_id
  FROM public.execution_attempts execution_attempt
  WHERE execution_attempt.invocation_id = node_attempt_row.invocation_id
  ORDER BY execution_attempt.attempt_id
  FOR UPDATE;
  SELECT * INTO invocation_row
  FROM public.execution_invocations invocation
  WHERE invocation.invocation_id = node_attempt_row.invocation_id
  FOR UPDATE;
  IF NOT FOUND OR invocation_row.status NOT IN (
      'queued', 'running', 'cancellation_requested'
    ) THEN
    RAISE EXCEPTION 'workflow_run_review_invocation_terminal'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO node_attempt_row
  FROM public.workflow_run_node_attempts node_attempt
  WHERE node_attempt.workspace_id = target_workspace_id
    AND node_attempt.node_attempt_id = review_row.node_attempt_id
  FOR UPDATE;
  IF NOT FOUND OR node_attempt_row.status <> 'waiting_review'
    OR node_attempt_row.invocation_id <> invocation_row.invocation_id THEN
    RAISE EXCEPTION 'workflow_run_review_attempt_not_waiting'
      USING ERRCODE = '23514';
  END IF;
  PERFORM execution_attempt.attempt_id
  FROM public.execution_attempts execution_attempt
  WHERE execution_attempt.invocation_id = node_attempt_row.invocation_id
  ORDER BY execution_attempt.attempt_id
  FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.execution_attempts execution_attempt
    WHERE execution_attempt.invocation_id = node_attempt_row.invocation_id
      AND execution_attempt.status = 'effect_outcome_unknown'
  ) THEN
    RAISE EXCEPTION 'workflow_run_review_effect_outcome_unresolved'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.workflow_run_reviews
  SET status = 'decided', decision = review_decision,
      decision_command_id = review_decision_command_id,
      decided_at = database_now, updated_at = database_now
  WHERE workspace_id = target_workspace_id AND review_id = target_review_id
    AND status = 'pending'
  RETURNING * INTO review_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_run_review_already_decided' USING ERRCODE = '55000';
  END IF;

  UPDATE public.workflow_run_node_attempts
  SET status = settled_status, finished_at = database_now, updated_at = database_now
  WHERE workspace_id = target_workspace_id
    AND node_attempt_id = review_row.node_attempt_id
    AND status = 'waiting_review';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_run_review_attempt_not_waiting'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.execution_attempts
  SET status = settled_status, finished_at = database_now, updated_at = database_now
  WHERE invocation_id = node_attempt_row.invocation_id
    AND attempt_id = node_attempt_row.execution_attempt_id
    AND status IN ('queued', 'running');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_run_review_execution_attempt_terminal'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.execution_attempts
  SET status = 'cancelled', finished_at = database_now, updated_at = database_now
  WHERE invocation_id = node_attempt_row.invocation_id
    AND attempt_id <> node_attempt_row.execution_attempt_id
    AND status IN ('queued', 'running');
  UPDATE public.execution_invocations
  SET status = settled_status, finished_at = database_now, updated_at = database_now
  WHERE invocation_id = node_attempt_row.invocation_id
    AND status IN ('queued', 'running', 'cancellation_requested');
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 1 THEN
    RAISE EXCEPTION 'workflow_run_review_invocation_terminal'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.capability_leases capability
  SET status = 'revoked', revoked_at = database_now, updated_at = database_now
  WHERE capability.invocation_id = node_attempt_row.invocation_id
    AND capability.status <> 'revoked';
  UPDATE public.capacity_leases capacity
  SET status = 'released', released_at = database_now, updated_at = database_now
  WHERE capacity.capacity_lease_id = (
    SELECT invocation.capacity_lease_id
    FROM public.execution_invocations invocation
    WHERE invocation.invocation_id = node_attempt_row.invocation_id
  ) AND capacity.status <> 'released';

  INSERT INTO public.workflow_run_events (
    workspace_id, event_id, run_id, schema_version, sequence, type, status,
    node_id, review_id, summary, writer_kind, product_command_id,
    run_fence, occurred_at
  ) VALUES (
    target_workspace_id, review_event_id, target_run_id,
    'workbench-run-event-v1', run_row.event_sequence + 1,
    'review.decided', 'running', review_row.node_id, target_review_id,
    'Workflow Run review decided.', 'controller', review_decision_command_id,
    job_row.fence, database_now
  );
  RETURN review_row;
END;
$function$;

CREATE FUNCTION public.enforce_execution_attempt_parent_serialization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  invocation_row public.execution_invocations%ROWTYPE;
  reconciliation_authorized boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'execution_attempt_delete_forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.attempt_id, NEW.invocation_id, NEW.schema_version,
    NEW.attempt_number, NEW.fence, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.attempt_id, OLD.invocation_id, OLD.schema_version,
    OLD.attempt_number, OLD.fence, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'execution_attempt_identity_immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO invocation_row
  FROM public.execution_invocations invocation
  WHERE invocation.invocation_id = NEW.invocation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'execution_attempt_invocation_not_found'
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'UPDATE'
    AND invocation_row.status = 'effect_outcome_unknown'
    AND OLD.status = 'effect_outcome_unknown'
    AND NEW.status IN ('completed', 'cancelled') THEN
    SELECT count(*) > 0
      AND CASE NEW.status
        WHEN 'completed' THEN bool_and(receipt.status = 'succeeded')
        ELSE bool_and(receipt.status IN ('succeeded', 'cancelled'))
      END
    INTO reconciliation_authorized
    FROM public.external_effect_receipts receipt
    WHERE receipt.invocation_id = NEW.invocation_id
      AND receipt.attempt_id = NEW.attempt_id;
  END IF;

  IF invocation_row.status IN (
      'completed', 'failed', 'cancelled', 'blocked', 'partial',
      'effect_outcome_unknown', 'timeout', 'permission_denied',
      'sandbox_unavailable', 'remote_backend_unavailable'
    ) AND reconciliation_authorized IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'execution_attempt_parent_invocation_terminal'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_external_effect_receipt_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  attempt_row public.execution_attempts%ROWTYPE;
  invocation_row public.execution_invocations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'external_effect_receipt_delete_forbidden'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO attempt_row
  FROM public.execution_attempts execution_attempt
  WHERE execution_attempt.invocation_id = NEW.invocation_id
    AND execution_attempt.attempt_id = NEW.attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'external_effect_receipt_attempt_not_found'
      USING ERRCODE = '23503';
  END IF;
  SELECT * INTO invocation_row
  FROM public.execution_invocations invocation
  WHERE invocation.invocation_id = attempt_row.invocation_id
  FOR UPDATE;
  IF NOT FOUND
    OR invocation_row.workspace_id <> NEW.workspace_id
    OR invocation_row.invocation_id <> NEW.invocation_id
    OR invocation_row.controller_id IS DISTINCT FROM NEW.controller_id THEN
    RAISE EXCEPTION 'external_effect_receipt_lineage_invalid'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'intent_recorded' THEN
      RAISE EXCEPTION 'external_effect_receipt_initial_status_invalid'
        USING ERRCODE = '23514';
    END IF;
    IF invocation_row.status <> 'running'
      OR attempt_row.status <> 'running' THEN
      RAISE EXCEPTION 'external_effect_receipt_lineage_invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.workspace_id, NEW.effect_id, NEW.schema_version,
    NEW.invocation_id, NEW.attempt_id, NEW.controller_id,
    NEW.node_id, NEW.connection_id, NEW.requirement_id,
    NEW.action, NEW.argument_digest, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id, OLD.effect_id, OLD.schema_version,
    OLD.invocation_id, OLD.attempt_id, OLD.controller_id,
    OLD.node_id, OLD.connection_id, OLD.requirement_id,
    OLD.action, OLD.argument_digest, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'external_effect_receipt_identity_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('succeeded', 'cancelled') THEN
    RAISE EXCEPTION 'external_effect_receipt_terminal'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (CASE OLD.status
    WHEN 'pending' THEN NEW.status IN ('pending', 'intent_recorded', 'cancelled')
    WHEN 'intent_recorded' THEN NEW.status IN (
      'intent_recorded', 'dispatching', 'cancelled'
    )
    WHEN 'dispatching' THEN NEW.status IN (
      'dispatching', 'outcome_unknown', 'succeeded', 'cancelled'
    )
    WHEN 'outcome_unknown' THEN NEW.status IN (
      'outcome_unknown', 'succeeded', 'cancelled'
    )
    ELSE false
  END) THEN
    RAISE EXCEPTION 'external_effect_receipt_transition_invalid'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'outcome_unknown' THEN
    IF invocation_row.status <> 'effect_outcome_unknown'
      OR attempt_row.status <> 'effect_outcome_unknown' THEN
      RAISE EXCEPTION 'external_effect_receipt_reconciliation_authority_invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF invocation_row.status NOT IN ('running', 'cancellation_requested')
    OR attempt_row.status <> 'running' THEN
    RAISE EXCEPTION 'external_effect_receipt_parent_terminal'
      USING ERRCODE = '55000';
  ELSIF OLD.status = 'intent_recorded' AND NEW.status = 'dispatching'
    AND invocation_row.status <> 'running' THEN
    RAISE EXCEPTION 'external_effect_receipt_dispatch_after_cancellation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_workflow_run_node_attempt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  job_row public.workflow_run_jobs%ROWTYPE;
  run_status text;
  plan_document jsonb;
  checkpoint_matches boolean;
  authority_now timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_run_node_attempt_delete_forbidden' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.workspace_id, NEW.node_attempt_id, NEW.run_id, NEW.scope_id,
    NEW.product_command_id, NEW.node_id, NEW.attempt_number, NEW.schema_version,
    NEW.invocation_id, NEW.execution_attempt_id, NEW.run_fence,
    NEW.lease_owner, NEW.lease_token, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id, OLD.node_attempt_id, OLD.run_id, OLD.scope_id,
    OLD.product_command_id, OLD.node_id, OLD.attempt_number, OLD.schema_version,
    OLD.invocation_id, OLD.execution_attempt_id, OLD.run_fence,
    OLD.lease_owner, OLD.lease_token, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'workflow_run_node_attempt_identity_immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN (
      'completed', 'failed', 'skipped', 'cancelled', 'partial',
      'effect_outcome_unknown'
    ) THEN
      RAISE EXCEPTION 'workflow_run_node_attempt_terminal' USING ERRCODE = '55000';
    END IF;
    IF NOT (CASE OLD.status
      WHEN 'queued' THEN NEW.status IN (
        'queued', 'running', 'completed', 'failed', 'skipped', 'cancelled'
      )
      WHEN 'running' THEN NEW.status IN (
        'running', 'waiting_review', 'completed', 'failed', 'cancelled',
        'partial', 'effect_outcome_unknown'
      )
      WHEN 'waiting_review' THEN NEW.status IN (
        'waiting_review', 'running', 'completed', 'failed', 'cancelled'
      )
      ELSE false
    END) THEN
      RAISE EXCEPTION 'workflow_run_node_attempt_transition_invalid'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION 'workflow_run_node_attempt_time_regression'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT status INTO run_status FROM public.workflow_runs
  WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id
  FOR UPDATE;
  SELECT * INTO job_row FROM public.workflow_run_jobs
  WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id
  FOR UPDATE;
  authority_now := clock_timestamp();
  IF NOT (
    (job_row.state = 'leased' AND job_row.fence = NEW.run_fence
      AND job_row.lease_owner = NEW.lease_owner
      AND job_row.lease_token = NEW.lease_token
      AND job_row.lease_expires_at > authority_now)
    OR (NEW.status = 'cancelled' AND job_row.state = 'waiting_review'
      AND EXISTS (
        SELECT 1 FROM public.workflow_run_reviews review
        WHERE review.workspace_id = NEW.workspace_id
          AND review.run_id = NEW.run_id
          AND review.node_id = NEW.node_id
          AND review.node_attempt_id = NEW.node_attempt_id
          AND (
            review.status = 'cancelled'
            OR (review.status = 'decided' AND review.decision = 'reject')
          )
      ))
    OR (NEW.status = 'cancelled'
      AND run_status IN ('running', 'cancellation_requested')
      AND job_row.state = 'leased'
      AND job_row.fence > NEW.run_fence
      AND EXISTS (
        SELECT 1 FROM public.workflow_run_events recovery
        WHERE recovery.workspace_id = NEW.workspace_id
          AND recovery.run_id = NEW.run_id
          AND recovery.type = 'run.worker_recovered'
          AND recovery.run_fence = job_row.fence
          AND recovery.lease_owner = job_row.lease_owner
          AND recovery.lease_token = job_row.lease_token
      ))
    OR (run_status = 'waiting_review'
      AND job_row.state = 'queued'
      AND EXISTS (
        SELECT 1 FROM public.workflow_run_reviews review
        WHERE review.workspace_id = NEW.workspace_id
          AND review.run_id = NEW.run_id
          AND review.node_id = NEW.node_id
          AND review.node_attempt_id = NEW.node_attempt_id
          AND review.status = 'decided'
          AND (
            (review.decision = 'approve' AND NEW.status = 'completed')
            OR (review.decision = 'revise' AND NEW.status = 'cancelled')
          )
      ))
  ) THEN
    RAISE EXCEPTION 'workflow_run_stale_node_attempt' USING ERRCODE = '55000';
  END IF;

  SELECT p.plan_document INTO plan_document
  FROM public.workflow_runs r
  JOIN public.execution_plans p
    ON p.workspace_id = r.workspace_id AND p.plan_id = r.execution_plan_id
  WHERE r.workspace_id = NEW.workspace_id AND r.run_id = NEW.run_id;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(plan_document -> 'steps') step
    WHERE step ->> 'nodeId' = NEW.node_id
  ) THEN
    RAISE EXCEPTION 'workflow_run_node_not_in_plan' USING ERRCODE = '23514';
  END IF;

  IF NEW.checkpoint_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.execution_checkpoints c
      WHERE c.checkpoint_id = NEW.checkpoint_id
        AND c.invocation_id = NEW.invocation_id
        AND c.attempt_id = NEW.execution_attempt_id
        AND c.fence = NEW.run_fence
    ) INTO checkpoint_matches;
    IF checkpoint_matches IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'workflow_run_checkpoint_lineage_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1
    FROM public.workflow_run_events recovery
    WHERE recovery.workspace_id = NEW.workspace_id
      AND recovery.run_id = NEW.run_id
      AND recovery.type = 'run.worker_recovered'
      AND recovery.run_fence = job_row.fence
      AND recovery.lease_owner = job_row.lease_owner
      AND recovery.lease_token = job_row.lease_token
  ) AND (
    EXISTS (
      SELECT 1
      FROM public.workflow_run_node_attempts prior
      WHERE prior.workspace_id = NEW.workspace_id
        AND prior.run_id = NEW.run_id
        AND prior.run_fence < NEW.run_fence
        AND prior.status NOT IN (
          'completed', 'failed', 'skipped', 'cancelled', 'partial',
          'effect_outcome_unknown'
        )
    ) OR EXISTS (
      SELECT 1
      FROM public.execution_invocations invocation
      JOIN public.execution_attempts execution_attempt
        ON execution_attempt.invocation_id = invocation.invocation_id
      LEFT JOIN public.capability_leases capability
        ON capability.invocation_id = invocation.invocation_id
       AND capability.attempt_id = execution_attempt.attempt_id
      LEFT JOIN public.capacity_leases capacity
        ON capacity.capacity_lease_id = invocation.capacity_lease_id
      WHERE invocation.workspace_id = NEW.workspace_id
        AND invocation.controller_kind = 'workflow_run'
        AND invocation.controller_id = NEW.run_id
        AND invocation.controller_fence < NEW.run_fence
        AND (
          invocation.status NOT IN (
            'completed', 'failed', 'cancelled', 'blocked', 'partial',
            'effect_outcome_unknown', 'timeout', 'permission_denied',
            'sandbox_unavailable', 'remote_backend_unavailable'
          )
          OR execution_attempt.status NOT IN (
            'completed', 'failed', 'cancelled', 'blocked', 'partial',
            'effect_outcome_unknown', 'timeout', 'permission_denied',
            'sandbox_unavailable', 'remote_backend_unavailable'
          )
          OR capability.status IS DISTINCT FROM 'revoked'
          OR capacity.status IS DISTINCT FROM 'released'
        )
    )
  ) THEN
    RAISE EXCEPTION 'workflow_run_recovery_lineage_not_closed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_workflow_run_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_status text;
  job_state text;
  current_node public.product_identifier;
  attempt_status text;
  command_valid boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workflow_run_review_delete_forbidden' USING ERRCODE = '55000';
  END IF;
  SELECT r.status, r.current_node_id
  INTO run_status, current_node
  FROM public.workflow_runs r
  WHERE r.workspace_id = NEW.workspace_id AND r.run_id = NEW.run_id
  FOR UPDATE;
  SELECT j.state INTO job_state
  FROM public.workflow_run_jobs j
  WHERE j.workspace_id = NEW.workspace_id AND j.run_id = NEW.run_id
  FOR UPDATE;
  SELECT attempt.status INTO attempt_status
  FROM public.workflow_run_node_attempts attempt
  WHERE attempt.workspace_id = NEW.workspace_id
    AND attempt.node_attempt_id = NEW.node_attempt_id
    AND attempt.run_id = NEW.run_id
    AND attempt.node_id = NEW.node_id;

  IF TG_OP = 'INSERT' THEN
    IF run_status <> 'waiting_review' OR job_state <> 'waiting_review'
      OR current_node IS DISTINCT FROM NEW.node_id
      OR attempt_status IS DISTINCT FROM 'waiting_review' THEN
      RAISE EXCEPTION 'workflow_run_review_not_waiting' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(
    NEW.workspace_id, NEW.review_id, NEW.run_id, NEW.scope_id, NEW.node_id,
    NEW.node_attempt_id, NEW.revision, NEW.schema_version, NEW.requested_at
  ) IS DISTINCT FROM ROW(
    OLD.workspace_id, OLD.review_id, OLD.run_id, OLD.scope_id, OLD.node_id,
    OLD.node_attempt_id, OLD.revision, OLD.schema_version, OLD.requested_at
  ) THEN
    RAISE EXCEPTION 'workflow_run_review_identity_immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('decided', 'cancelled') THEN
    RAISE EXCEPTION 'workflow_run_review_already_decided' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'cancelled'
    AND (run_status <> 'waiting_review' OR job_state <> 'waiting_review') THEN
    RAISE EXCEPTION 'workflow_run_review_not_waiting' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'decided' THEN
    SELECT c.status = 'completed'
      AND c.kind = 'workflow_run_review'
      AND c.scope_id = NEW.scope_id
      AND c.target_kind = 'workflow_run_review'
      AND c.target_id = NEW.review_id
      AND c.target_revision = NEW.revision
    INTO command_valid
    FROM public.product_commands c
    WHERE c.workspace_id = NEW.workspace_id
      AND c.command_id = NEW.decision_command_id;
  ELSE
    SELECT c.status = 'completed'
      AND c.kind = 'workflow_run_cancel'
      AND c.scope_id = NEW.scope_id
      AND c.target_kind = 'workflow_run_cancellation'
      AND c.target_id = NEW.run_id
      AND c.target_revision = 1
    INTO command_valid
    FROM public.product_commands c
    WHERE c.workspace_id = NEW.workspace_id
      AND c.command_id = NEW.cancellation_command_id;
  END IF;
  IF command_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'workflow_run_review_command_invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'decided' AND NEW.decision IN ('approve', 'revise') THEN
    UPDATE public.workflow_run_jobs
    SET state = 'queued', available_at = NEW.decided_at,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        updated_at = NEW.decided_at
    WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id
      AND state = 'waiting_review';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'workflow_run_review_requeue_conflict' USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_final_output()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  job_row public.workflow_run_jobs%ROWTYPE;
  authority_now timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'workflow_run_final_output_immutable' USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM public.workflow_runs
  WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id
  FOR UPDATE;
  SELECT * INTO job_row FROM public.workflow_run_jobs
  WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id
  FOR UPDATE;
  authority_now := clock_timestamp();
  IF job_row.state NOT IN ('leased', 'terminal')
    OR job_row.fence <> NEW.run_fence
    OR job_row.lease_owner <> NEW.lease_owner
    OR job_row.lease_token <> NEW.lease_token
    OR (job_row.state = 'leased' AND job_row.lease_expires_at <= authority_now) THEN
    RAISE EXCEPTION 'workflow_run_stale_final_output' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_initial_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  aggregate_run_id public.product_identifier;
  aggregate_workspace_id public.product_identifier;
  aggregate_command_id public.product_identifier;
  aggregate_plan_id public.product_identifier;
  valid boolean;
BEGIN
  IF TG_TABLE_NAME = 'product_commands' THEN
    IF NEW.kind <> 'workflow_run' THEN RETURN NEW; END IF;
    aggregate_run_id := NEW.target_id;
    aggregate_workspace_id := NEW.workspace_id;
    aggregate_command_id := NEW.command_id;
  ELSE
    aggregate_run_id := NEW.run_id;
    aggregate_workspace_id := NEW.workspace_id;
    aggregate_command_id := NEW.product_command_id;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.workflow_runs r
    JOIN public.product_commands c
      ON c.workspace_id = r.workspace_id
     AND c.command_id = r.product_command_id
     AND c.scope_id = r.scope_id
     AND c.kind = 'workflow_run'
     AND c.target_kind = 'workflow_run'
     AND c.target_id = r.run_id
     AND c.target_revision = 1
    JOIN public.workflow_run_jobs j
      ON j.workspace_id = r.workspace_id AND j.run_id = r.run_id
    JOIN public.workflow_run_events e
      ON e.workspace_id = r.workspace_id AND e.run_id = r.run_id
     AND e.sequence = 1 AND e.type = 'run.queued' AND e.status = 'queued'
     AND e.product_command_id = r.product_command_id AND e.run_fence = 0
    WHERE r.workspace_id = aggregate_workspace_id
      AND r.run_id = aggregate_run_id
      AND r.product_command_id = aggregate_command_id
      AND r.event_sequence >= 1
  ) INTO valid;
  IF valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'workflow_run_initial_aggregate_incomplete' USING ERRCODE = '23503';
  END IF;
  SELECT execution_plan_id INTO aggregate_plan_id
  FROM public.workflow_runs
  WHERE workspace_id = aggregate_workspace_id AND run_id = aggregate_run_id;
  PERFORM public.assert_execution_plan_model_pins_consumable(
    aggregate_workspace_id, aggregate_plan_id
  );
  PERFORM public.assert_execution_plan_connection_bindings_consumable(
    aggregate_workspace_id, aggregate_plan_id
  );
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_control_command_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  applied boolean;
BEGIN
  IF NEW.kind = 'workflow_run_cancel' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.workflow_run_events e
      WHERE e.workspace_id = NEW.workspace_id
        AND e.run_id = NEW.target_id
        AND e.type = 'run.cancellation_requested'
        AND e.status = 'cancellation_requested'
        AND e.product_command_id = NEW.command_id
    ) INTO applied;
    IF applied IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'workflow_run_cancel_command_not_applied'
        USING ERRCODE = '23503';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.workflow_run_reviews review
      WHERE review.workspace_id = NEW.workspace_id
        AND review.run_id = NEW.target_id
        AND review.status = 'pending'
    ) THEN
      RAISE EXCEPTION 'workflow_run_cancel_pending_review_not_closed'
        USING ERRCODE = '23503';
    END IF;
  ELSIF NEW.kind = 'workflow_run_review' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.workflow_run_reviews review
      JOIN public.workflow_run_events e
        ON e.workspace_id = review.workspace_id
       AND e.run_id = review.run_id
       AND e.review_id = review.review_id
       AND e.node_id = review.node_id
       AND e.product_command_id = review.decision_command_id
      WHERE review.workspace_id = NEW.workspace_id
        AND review.review_id = NEW.target_id
        AND review.revision = NEW.target_revision
        AND review.decision_command_id = NEW.command_id
        AND review.status = 'decided'
        AND (
          (review.decision IN ('approve', 'revise')
            AND e.type = 'review.decided' AND e.status = 'running')
          OR (review.decision = 'reject'
            AND e.type = 'run.cancelled' AND e.status = 'cancelled')
        )
    ) INTO applied;
    IF applied IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'workflow_run_review_command_not_applied'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_terminal_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  terminal_status text;
  output_count integer;
  output_outcome text;
  output_node_id public.product_identifier;
  output_node_attempt_id public.product_identifier;
  terminal_node_id public.product_identifier;
  terminal_node_attempt_id public.product_identifier;
BEGIN
  IF TG_TABLE_NAME = 'workflow_run_events' THEN
    IF NEW.status NOT IN (
      'completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
    ) THEN RETURN NEW; END IF;
    terminal_status := NEW.status;
  ELSE
    SELECT status INTO terminal_status FROM public.workflow_runs
    WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id;
  END IF;
  SELECT count(*), min(outcome), min(node_id), min(node_attempt_id)
  INTO output_count, output_outcome, output_node_id, output_node_attempt_id
  FROM public.workflow_run_final_outputs
  WHERE workspace_id = NEW.workspace_id AND run_id = NEW.run_id;
  SELECT e.node_id, e.node_attempt_id
  INTO terminal_node_id, terminal_node_attempt_id
  FROM public.workflow_run_events e
  WHERE e.workspace_id = NEW.workspace_id AND e.run_id = NEW.run_id
    AND e.status IN (
      'completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
    );
  IF terminal_status IN ('completed', 'partial') THEN
    IF output_count <> 1 OR output_outcome <> terminal_status
      OR output_node_id IS DISTINCT FROM terminal_node_id
      OR output_node_attempt_id IS DISTINCT FROM terminal_node_attempt_id THEN
      RAISE EXCEPTION 'workflow_run_final_output_missing_or_mismatched'
        USING ERRCODE = '23514';
    END IF;
  ELSIF output_count <> 0 THEN
    RAISE EXCEPTION 'workflow_run_final_output_forbidden_for_terminal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_projection_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  aggregate_workspace_id public.product_identifier;
  aggregate_run_id public.product_identifier;
  run_status text;
  command_status text;
  job_state text;
  consistent boolean;
BEGIN
  IF TG_TABLE_NAME = 'product_commands' THEN
    IF NEW.kind <> 'workflow_run' OR NEW.target_kind <> 'workflow_run' THEN
      RETURN NEW;
    END IF;
    aggregate_workspace_id := NEW.workspace_id;
    aggregate_run_id := NEW.target_id;
  ELSE
    aggregate_workspace_id := NEW.workspace_id;
    aggregate_run_id := NEW.run_id;
  END IF;

  SELECT r.status, c.status, j.state
  INTO run_status, command_status, job_state
  FROM public.workflow_runs r
  JOIN public.product_commands c
    ON c.workspace_id = r.workspace_id
   AND c.command_id = r.product_command_id
   AND c.kind = 'workflow_run'
   AND c.target_kind = 'workflow_run'
   AND c.target_id = r.run_id
   AND c.target_revision = 1
  JOIN public.workflow_run_jobs j
    ON j.workspace_id = r.workspace_id AND j.run_id = r.run_id
  WHERE r.workspace_id = aggregate_workspace_id
    AND r.run_id = aggregate_run_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  consistent := CASE run_status
    WHEN 'queued' THEN command_status = 'accepted' AND job_state = 'queued'
    WHEN 'running' THEN command_status = 'running' AND job_state IN ('queued', 'leased')
    WHEN 'waiting_review' THEN
      command_status = 'running' AND job_state = 'waiting_review'
    WHEN 'cancellation_requested' THEN
      command_status = 'cancellation_requested'
      AND job_state IN ('queued', 'leased', 'waiting_review')
    WHEN 'completed' THEN command_status = 'completed' AND job_state = 'terminal'
    WHEN 'failed' THEN command_status = 'failed' AND job_state = 'terminal'
    WHEN 'cancelled' THEN command_status = 'cancelled' AND job_state = 'terminal'
    WHEN 'partial' THEN command_status = 'blocked' AND job_state = 'terminal'
    WHEN 'effect_outcome_unknown' THEN
      command_status = 'blocked' AND job_state = 'terminal'
    ELSE false
  END;
  IF consistent IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'workflow_run_projection_inconsistent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_job_lease_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  lease_event_exists boolean;
BEGIN
  IF ROW(
       NEW.fence, NEW.lease_owner, NEW.lease_token,
       NEW.lease_expires_at, NEW.lease_event_id
     )
      IS NOT DISTINCT FROM
     ROW(
       OLD.fence, OLD.lease_owner, OLD.lease_token,
       OLD.lease_expires_at, OLD.lease_event_id
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.state = 'leased' AND NEW.fence = OLD.fence + 1 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.workflow_run_events event
      WHERE event.workspace_id = NEW.workspace_id
        AND event.run_id = NEW.run_id
        AND event.event_id = NEW.lease_event_id
        AND (
          (event.type = 'run.started'
            AND OLD.state = 'queued'
            AND event.status = 'running')
          OR (event.type = 'run.worker_recovered'
            AND OLD.state = 'leased'
            AND event.status IN ('running', 'cancellation_requested'))
        )
        AND event.run_fence = NEW.fence
        AND event.lease_owner = NEW.lease_owner
        AND event.lease_token = NEW.lease_token
        AND event.lease_expires_at = NEW.lease_expires_at
        AND event.previous_run_fence = OLD.fence
        AND event.previous_lease_owner IS NOT DISTINCT FROM OLD.lease_owner
        AND event.previous_lease_token IS NOT DISTINCT FROM OLD.lease_token
        AND event.previous_lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at
    ) INTO lease_event_exists;
  ELSIF NEW.state = 'leased' AND NEW.fence = OLD.fence
    AND NEW.lease_owner = OLD.lease_owner
    AND NEW.lease_token = OLD.lease_token
    AND NEW.lease_expires_at > OLD.lease_expires_at
    AND NEW.lease_event_id IS DISTINCT FROM OLD.lease_event_id THEN
    SELECT EXISTS (
      SELECT 1 FROM public.workflow_run_events event
      WHERE event.workspace_id = NEW.workspace_id
        AND event.run_id = NEW.run_id
        AND event.event_id = NEW.lease_event_id
        AND event.type = 'run.lease_renewed'
        AND event.run_fence = NEW.fence
        AND event.lease_owner = NEW.lease_owner
        AND event.lease_token = NEW.lease_token
        AND event.lease_expires_at = NEW.lease_expires_at
        AND event.previous_run_fence = OLD.fence
        AND event.previous_lease_owner = OLD.lease_owner
        AND event.previous_lease_token = OLD.lease_token
        AND event.previous_lease_expires_at = OLD.lease_expires_at
    ) INTO lease_event_exists;
  ELSIF OLD.state = 'leased'
    AND NEW.lease_owner IS NULL
    AND NEW.lease_token IS NULL
    AND NEW.lease_expires_at IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.workflow_run_events event
      WHERE event.workspace_id = NEW.workspace_id
        AND event.run_id = NEW.run_id
        AND event.event_id = NEW.lease_event_id
        AND event.type = 'review.requested'
        AND event.run_fence = OLD.fence
        AND event.lease_owner = OLD.lease_owner
        AND event.lease_token = OLD.lease_token
    ) INTO lease_event_exists;
  ELSE
    lease_event_exists := false;
  END IF;

  IF lease_event_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'workflow_run_job_lease_event_missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_lease_event_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  event_current boolean;
BEGIN
  IF NEW.type NOT IN ('run.started', 'run.worker_recovered', 'run.lease_renewed') THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.workflow_run_jobs job
    JOIN public.workflow_runs run
      ON run.workspace_id = job.workspace_id AND run.run_id = job.run_id
    WHERE job.workspace_id = NEW.workspace_id
      AND job.run_id = NEW.run_id
      AND job.state = 'leased'
      AND job.fence = NEW.run_fence
      AND job.lease_owner = NEW.lease_owner
      AND job.lease_token = NEW.lease_token
      AND job.lease_expires_at = NEW.lease_expires_at
      AND job.lease_event_id = NEW.event_id
      AND run.event_sequence >= NEW.sequence
      AND (
        (NEW.type = 'run.started'
          AND run.status = 'running'
          AND NEW.previous_lease_owner IS NULL
          AND NEW.previous_run_fence = NEW.run_fence - 1)
        OR (NEW.type = 'run.worker_recovered'
          AND NEW.status IN ('running', 'cancellation_requested')
          AND run.status = NEW.status
          AND NEW.previous_lease_owner IS NOT NULL
          AND NEW.previous_run_fence = NEW.run_fence - 1)
        OR (NEW.type = 'run.lease_renewed'
          AND run.status = NEW.status
          AND NEW.previous_run_fence = NEW.run_fence
          AND NEW.previous_lease_owner = NEW.lease_owner
          AND NEW.previous_lease_token = NEW.lease_token
          AND NEW.lease_expires_at > NEW.previous_lease_expires_at)
      )
  ) INTO event_current;
  IF event_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'workflow_run_lease_event_not_current'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_execution_state_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  affected_workspace_id public.product_identifier;
  affected_run_id public.product_identifier;
  affected_invocation_id public.product_identifier;
  affected_capacity_lease_id public.product_identifier;
  inconsistent boolean;
  inconsistent_terminal_type text;
BEGIN
  IF TG_TABLE_NAME IN (
    'workflow_run_events', 'workflow_run_node_attempts',
    'workflow_run_final_outputs'
  ) THEN
    affected_workspace_id := NEW.workspace_id;
    affected_run_id := NEW.run_id;
  ELSIF TG_TABLE_NAME = 'execution_invocations' THEN
    affected_invocation_id := NEW.invocation_id;
  ELSIF TG_TABLE_NAME IN ('execution_attempts', 'capability_leases') THEN
    affected_invocation_id := NEW.invocation_id;
  ELSE
    affected_capacity_lease_id := NEW.capacity_lease_id;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.workflow_run_events event
    JOIN public.workflow_run_node_attempts node_attempt
      ON node_attempt.workspace_id = event.workspace_id
     AND node_attempt.run_id = event.run_id
     AND node_attempt.node_id = event.node_id
     AND node_attempt.node_attempt_id = event.node_attempt_id
    JOIN public.execution_invocations invocation
      ON invocation.invocation_id = node_attempt.invocation_id
    JOIN public.execution_attempts execution_attempt
      ON execution_attempt.invocation_id = node_attempt.invocation_id
     AND execution_attempt.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capability_leases capability
      ON capability.invocation_id = node_attempt.invocation_id
     AND capability.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capacity_leases capacity
      ON capacity.capacity_lease_id = invocation.capacity_lease_id
    WHERE (
      (affected_run_id IS NOT NULL
        AND node_attempt.workspace_id = affected_workspace_id
        AND node_attempt.run_id = affected_run_id)
      OR (affected_invocation_id IS NOT NULL
        AND node_attempt.invocation_id = affected_invocation_id)
      OR (affected_capacity_lease_id IS NOT NULL
        AND invocation.capacity_lease_id = affected_capacity_lease_id)
    )
    AND (
      event.type IN (
        'node.started', 'node.progress', 'node.completed', 'node.failed',
        'node.effect_recovery_started', 'node.effect_recovery_completed',
        'node.effect_recovery_unknown', 'review.requested'
      )
      OR (event.writer_kind = 'worker' AND event.type IN (
        'run.completed', 'run.failed', 'run.cancelled',
        'run.partial', 'run.effect_outcome_unknown'
      ) AND NOT EXISTS (
        SELECT 1
        FROM public.workflow_run_final_outputs output
        WHERE output.workspace_id = event.workspace_id
          AND output.run_id = event.run_id
      ))
    )
    AND NOT CASE event.type
      WHEN 'node.started' THEN
        node_attempt.status = 'running'
        AND execution_attempt.status = 'running'
        AND invocation.status = 'running'
      WHEN 'node.progress' THEN
        node_attempt.status = 'running'
        AND execution_attempt.status = 'running'
        AND invocation.status = 'running'
      WHEN 'node.completed' THEN
        node_attempt.status = 'completed'
        AND execution_attempt.status = 'completed'
        AND invocation.status = 'completed'
      WHEN 'node.failed' THEN
        node_attempt.status = 'failed'
        AND execution_attempt.status = 'failed'
        AND invocation.status = 'failed'
      WHEN 'node.effect_recovery_started' THEN
        node_attempt.status = 'running'
        AND execution_attempt.status = 'running'
        AND invocation.status = 'running'
      WHEN 'node.effect_recovery_completed' THEN
        node_attempt.status = 'running'
        AND execution_attempt.status = 'running'
        AND invocation.status = 'running'
      WHEN 'node.effect_recovery_unknown' THEN
        node_attempt.status = 'effect_outcome_unknown'
        AND execution_attempt.status = 'effect_outcome_unknown'
        AND invocation.status = 'effect_outcome_unknown'
      WHEN 'review.requested' THEN
        node_attempt.status = 'waiting_review'
        AND execution_attempt.status = 'running'
        AND invocation.status = 'running'
      WHEN 'run.completed' THEN
        node_attempt.status = 'completed'
        AND execution_attempt.status = 'completed'
        AND invocation.status = 'completed'
      WHEN 'run.failed' THEN
        node_attempt.status = 'failed'
        AND execution_attempt.status = 'failed'
        AND invocation.status = 'failed'
      WHEN 'run.cancelled' THEN
        node_attempt.status = 'cancelled'
        AND execution_attempt.status = 'cancelled'
        AND invocation.status = 'cancelled'
        AND capability.status = 'revoked'
        AND capacity.status = 'released'
      WHEN 'run.partial' THEN
        node_attempt.status = 'partial'
        AND execution_attempt.status = 'partial'
        AND invocation.status = 'partial'
      WHEN 'run.effect_outcome_unknown' THEN
        node_attempt.status = 'effect_outcome_unknown'
        AND execution_attempt.status = 'effect_outcome_unknown'
        AND invocation.status = 'effect_outcome_unknown'
      ELSE false
    END
    AND NOT EXISTS (
      SELECT 1
      FROM public.workflow_run_events newer_event
      WHERE newer_event.workspace_id = event.workspace_id
        AND newer_event.run_id = event.run_id
        AND newer_event.sequence > event.sequence
        AND (
          newer_event.node_attempt_id = node_attempt.node_attempt_id
          OR (
            newer_event.type IN ('review.decided', 'run.cancelled')
            AND EXISTS (
              SELECT 1
              FROM public.workflow_run_reviews review
              WHERE review.workspace_id = newer_event.workspace_id
                AND review.run_id = newer_event.run_id
                AND review.review_id = newer_event.review_id
                AND review.node_attempt_id = node_attempt.node_attempt_id
            )
          )
        )
        AND (
          newer_event.type IN (
            'node.started', 'node.progress', 'node.completed', 'node.failed',
            'node.effect_recovery_started', 'node.effect_recovery_completed',
            'node.effect_recovery_unknown', 'review.requested', 'review.decided'
          )
          OR (newer_event.writer_kind = 'worker' AND newer_event.type IN (
            'run.completed', 'run.failed', 'run.cancelled',
            'run.partial', 'run.effect_outcome_unknown'
          ))
          OR (newer_event.writer_kind = 'controller'
            AND newer_event.type = 'run.cancelled'
            AND newer_event.review_id IS NOT NULL)
        )
    )
  ) INTO inconsistent;
  IF inconsistent THEN
    RAISE EXCEPTION 'workflow_run_execution_state_inconsistent'
      USING ERRCODE = '23514';
  END IF;

  SELECT terminal_event.type
  INTO inconsistent_terminal_type
  FROM public.workflow_run_events terminal_event
  JOIN public.execution_invocations invocation
    ON invocation.workspace_id = terminal_event.workspace_id
   AND invocation.controller_kind = 'workflow_run'
   AND invocation.controller_id = terminal_event.run_id
  JOIN public.execution_attempts execution_attempt
    ON execution_attempt.invocation_id = invocation.invocation_id
  LEFT JOIN public.capability_leases capability
    ON capability.invocation_id = invocation.invocation_id
   AND capability.attempt_id = execution_attempt.attempt_id
  LEFT JOIN public.capacity_leases capacity
    ON capacity.capacity_lease_id = invocation.capacity_lease_id
  WHERE terminal_event.type IN (
      'run.completed', 'run.failed', 'run.cancelled',
      'run.partial', 'run.effect_outcome_unknown'
    )
    AND (
      (affected_run_id IS NOT NULL
        AND terminal_event.workspace_id = affected_workspace_id
        AND terminal_event.run_id = affected_run_id)
      OR (affected_invocation_id IS NOT NULL
        AND invocation.invocation_id = affected_invocation_id)
      OR (affected_capacity_lease_id IS NOT NULL
        AND invocation.capacity_lease_id = affected_capacity_lease_id)
    )
    AND (
      execution_attempt.status NOT IN (
        'completed', 'failed', 'cancelled', 'blocked', 'partial',
        'effect_outcome_unknown', 'timeout', 'permission_denied',
        'sandbox_unavailable', 'remote_backend_unavailable'
      )
      OR NOT CASE terminal_event.type
        WHEN 'run.completed' THEN
          invocation.status IN ('completed', 'cancelled')
        WHEN 'run.failed' THEN
          invocation.status IN ('completed', 'failed', 'cancelled')
        WHEN 'run.partial' THEN
          invocation.status IN ('completed', 'failed', 'cancelled', 'partial')
        WHEN 'run.effect_outcome_unknown' THEN
          invocation.status IN (
            'completed', 'cancelled', 'effect_outcome_unknown'
          )
        WHEN 'run.cancelled' THEN invocation.status IN (
          'completed', 'failed', 'cancelled', 'blocked', 'partial',
          'effect_outcome_unknown', 'timeout', 'permission_denied',
          'sandbox_unavailable', 'remote_backend_unavailable'
        )
        ELSE false
      END
      OR capability.status IS DISTINCT FROM 'revoked'
      OR capacity.status IS DISTINCT FROM 'released'
    )
  LIMIT 1;
  IF inconsistent_terminal_type IS NOT NULL THEN
    IF inconsistent_terminal_type = 'run.cancelled' THEN
      RAISE EXCEPTION 'workflow_run_cancellation_execution_not_closed'
        USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'workflow_run_terminal_execution_not_closed'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.workflow_run_events terminal_event
    JOIN public.workflow_run_node_attempts node_attempt
      ON node_attempt.workspace_id = terminal_event.workspace_id
     AND node_attempt.run_id = terminal_event.run_id
    JOIN public.execution_invocations invocation
      ON invocation.invocation_id = node_attempt.invocation_id
    JOIN public.execution_attempts execution_attempt
      ON execution_attempt.invocation_id = node_attempt.invocation_id
     AND execution_attempt.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capability_leases capability
      ON capability.invocation_id = node_attempt.invocation_id
     AND capability.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capacity_leases capacity
      ON capacity.capacity_lease_id = invocation.capacity_lease_id
    WHERE terminal_event.type = 'run.cancelled'
      AND (
        (affected_run_id IS NOT NULL
          AND node_attempt.workspace_id = affected_workspace_id
          AND node_attempt.run_id = affected_run_id)
        OR (affected_invocation_id IS NOT NULL
          AND node_attempt.invocation_id = affected_invocation_id)
        OR (affected_capacity_lease_id IS NOT NULL
          AND invocation.capacity_lease_id = affected_capacity_lease_id)
      )
      AND (
        node_attempt.status <> execution_attempt.status
        OR node_attempt.status <> invocation.status
        OR node_attempt.status NOT IN (
          'completed', 'failed', 'skipped', 'cancelled', 'partial',
          'effect_outcome_unknown'
        )
        OR capability.status <> 'revoked'
        OR capacity.status <> 'released'
      )
  ) INTO inconsistent;
  IF inconsistent THEN
    RAISE EXCEPTION 'workflow_run_cancellation_leases_not_released'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.workflow_run_events event
    JOIN public.workflow_run_reviews review
      ON review.workspace_id = event.workspace_id
     AND review.run_id = event.run_id
     AND review.review_id = event.review_id
    JOIN public.workflow_run_node_attempts node_attempt
      ON node_attempt.workspace_id = review.workspace_id
     AND node_attempt.run_id = review.run_id
     AND node_attempt.node_id = review.node_id
     AND node_attempt.node_attempt_id = review.node_attempt_id
    JOIN public.execution_invocations invocation
      ON invocation.invocation_id = node_attempt.invocation_id
    JOIN public.execution_attempts execution_attempt
      ON execution_attempt.invocation_id = node_attempt.invocation_id
     AND execution_attempt.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capability_leases capability
      ON capability.invocation_id = node_attempt.invocation_id
     AND capability.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capacity_leases capacity
      ON capacity.capacity_lease_id = invocation.capacity_lease_id
    WHERE event.writer_kind = 'controller'
      AND event.type = 'run.cancelled'
      AND (
        review.status = 'cancelled'
        OR (review.status = 'decided' AND review.decision = 'reject')
      )
      AND (
        (affected_run_id IS NOT NULL
          AND node_attempt.workspace_id = affected_workspace_id
          AND node_attempt.run_id = affected_run_id)
        OR (affected_invocation_id IS NOT NULL
          AND node_attempt.invocation_id = affected_invocation_id)
        OR (affected_capacity_lease_id IS NOT NULL
          AND invocation.capacity_lease_id = affected_capacity_lease_id)
      )
      AND NOT (
        node_attempt.status = 'cancelled'
        AND execution_attempt.status = 'cancelled'
        AND invocation.status = 'cancelled'
        AND capability.status = 'revoked'
        AND capacity.status = 'released'
      )
  ) INTO inconsistent;
  IF inconsistent THEN
    RAISE EXCEPTION 'workflow_run_execution_state_inconsistent'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.workflow_run_events event
    JOIN public.workflow_run_reviews review
      ON review.workspace_id = event.workspace_id
     AND review.run_id = event.run_id
     AND review.review_id = event.review_id
    JOIN public.workflow_run_node_attempts node_attempt
      ON node_attempt.workspace_id = review.workspace_id
     AND node_attempt.run_id = review.run_id
     AND node_attempt.node_id = review.node_id
     AND node_attempt.node_attempt_id = review.node_attempt_id
    JOIN public.execution_invocations invocation
      ON invocation.invocation_id = node_attempt.invocation_id
    JOIN public.execution_attempts execution_attempt
      ON execution_attempt.invocation_id = node_attempt.invocation_id
     AND execution_attempt.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capability_leases capability
      ON capability.invocation_id = node_attempt.invocation_id
     AND capability.attempt_id = node_attempt.execution_attempt_id
    JOIN public.capacity_leases capacity
      ON capacity.capacity_lease_id = invocation.capacity_lease_id
    WHERE event.type = 'review.decided'
      AND review.status = 'decided'
      AND review.decision IN ('approve', 'revise')
      AND (
        (affected_run_id IS NOT NULL
          AND node_attempt.workspace_id = affected_workspace_id
          AND node_attempt.run_id = affected_run_id)
        OR (affected_invocation_id IS NOT NULL
          AND node_attempt.invocation_id = affected_invocation_id)
        OR (affected_capacity_lease_id IS NOT NULL
          AND invocation.capacity_lease_id = affected_capacity_lease_id)
      )
      AND NOT (
        node_attempt.status = CASE review.decision
          WHEN 'approve' THEN 'completed' ELSE 'cancelled' END
        AND execution_attempt.status = CASE review.decision
          WHEN 'approve' THEN 'completed' ELSE 'cancelled' END
        AND invocation.status = CASE review.decision
          WHEN 'approve' THEN 'completed' ELSE 'cancelled' END
        AND capability.status = 'revoked'
        AND capacity.status = 'released'
      )
  ) INTO inconsistent;
  IF inconsistent THEN
    RAISE EXCEPTION 'workflow_run_review_execution_not_closed'
      USING ERRCODE = '23514';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.workflow_run_final_outputs output
    JOIN public.workflow_run_node_attempts node_attempt
      ON node_attempt.workspace_id = output.workspace_id
     AND node_attempt.run_id = output.run_id
     AND node_attempt.node_id = output.node_id
     AND node_attempt.node_attempt_id = output.node_attempt_id
    JOIN public.execution_invocations invocation
      ON invocation.invocation_id = node_attempt.invocation_id
    JOIN public.execution_attempts execution_attempt
      ON execution_attempt.invocation_id = node_attempt.invocation_id
     AND execution_attempt.attempt_id = node_attempt.execution_attempt_id
    WHERE (
      (affected_run_id IS NOT NULL
        AND node_attempt.workspace_id = affected_workspace_id
        AND node_attempt.run_id = affected_run_id)
      OR (affected_invocation_id IS NOT NULL
        AND node_attempt.invocation_id = affected_invocation_id)
      OR (affected_capacity_lease_id IS NOT NULL
        AND invocation.capacity_lease_id = affected_capacity_lease_id)
    )
    AND (
      node_attempt.status <> output.outcome
      OR execution_attempt.status <> output.outcome
      OR invocation.status <> output.outcome
      OR node_attempt.finished_at IS NULL
      OR execution_attempt.finished_at IS NULL
      OR invocation.finished_at IS NULL
    )
  ) INTO inconsistent;
  IF inconsistent THEN
    RAISE EXCEPTION 'workflow_run_final_output_attempt_not_terminal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_node_event_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.type IN (
      'node.progress', 'node.completed', 'node.failed',
      'node.effect_recovery_started'
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.workflow_run_events started
      WHERE started.workspace_id = NEW.workspace_id
        AND started.run_id = NEW.run_id
        AND started.node_attempt_id = NEW.node_attempt_id
        AND started.type = 'node.started'
        AND started.sequence < NEW.sequence
    ) THEN
    RAISE EXCEPTION 'workflow_run_node_started_predecessor_missing'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.type IN (
      'node.effect_recovery_completed', 'node.effect_recovery_unknown'
    ) AND NOT EXISTS (
      SELECT 1
      FROM public.workflow_run_events started
      WHERE started.workspace_id = NEW.workspace_id
        AND started.run_id = NEW.run_id
        AND started.node_attempt_id = NEW.node_attempt_id
        AND started.type = 'node.effect_recovery_started'
        AND started.sequence < NEW.sequence
    ) THEN
    RAISE EXCEPTION 'workflow_run_effect_recovery_predecessor_missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_workflow_run_review_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  review_row public.workflow_run_reviews%ROWTYPE;
  requested_count integer;
  decided_count integer;
  cancelled_count integer;
BEGIN
  IF TG_TABLE_NAME = 'workflow_run_events' THEN
    IF NEW.review_id IS NULL THEN RETURN NEW; END IF;
    SELECT * INTO review_row FROM public.workflow_run_reviews
    WHERE workspace_id = NEW.workspace_id AND review_id = NEW.review_id;
  ELSE
    review_row := NEW;
  END IF;
  IF review_row.review_id IS NULL THEN
    RAISE EXCEPTION 'workflow_run_review_aggregate_missing'
      USING ERRCODE = '23503';
  END IF;
  SELECT count(*) INTO requested_count
  FROM public.workflow_run_events e
  WHERE e.workspace_id = review_row.workspace_id
    AND e.run_id = review_row.run_id
    AND e.review_id = review_row.review_id
    AND e.node_id = review_row.node_id
    AND e.type = 'review.requested'
    AND e.status = 'waiting_review';
  SELECT count(*) INTO decided_count
  FROM public.workflow_run_events e
  WHERE e.workspace_id = review_row.workspace_id
    AND e.run_id = review_row.run_id
    AND e.review_id = review_row.review_id
    AND e.node_id = review_row.node_id
    AND (
      (e.type = 'review.decided' AND review_row.decision IN ('approve', 'revise')
        AND e.status = 'running')
      OR (e.type = 'run.cancelled' AND review_row.decision = 'reject'
        AND e.status = 'cancelled')
    )
    AND e.product_command_id = review_row.decision_command_id;
  SELECT count(*) INTO cancelled_count
  FROM public.workflow_run_events e
  WHERE e.workspace_id = review_row.workspace_id
    AND e.run_id = review_row.run_id
    AND e.review_id = review_row.review_id
    AND e.node_id = review_row.node_id
    AND e.type = 'run.cancelled'
    AND e.status = 'cancelled'
    AND e.product_command_id = review_row.cancellation_command_id;
  IF requested_count <> 1
    OR (review_row.status = 'pending'
      AND (decided_count <> 0 OR cancelled_count <> 0))
    OR (review_row.status = 'decided'
      AND (decided_count <> 1 OR cancelled_count <> 0))
    OR (review_row.status = 'cancelled'
      AND (decided_count <> 0 OR cancelled_count <> 1)) THEN
    RAISE EXCEPTION 'workflow_run_review_aggregate_incomplete'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER workflow_runs_root_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.workflow_runs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workflow_run_root();

CREATE TRIGGER product_commands_workflow_run_control_guard
  BEFORE INSERT ON public.product_commands
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_control_command();

CREATE TRIGGER workflow_run_events_apply
  BEFORE INSERT ON public.workflow_run_events
  FOR EACH ROW EXECUTE FUNCTION public.apply_workflow_run_event();

CREATE TRIGGER workflow_run_events_immutable
  BEFORE UPDATE OR DELETE ON public.workflow_run_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_loop_library_history_mutation();

CREATE TRIGGER workflow_run_jobs_mutation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.workflow_run_jobs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workflow_run_job_mutation();

CREATE TRIGGER workflow_run_node_attempts_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.workflow_run_node_attempts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workflow_run_node_attempt();

CREATE TRIGGER workflow_run_reviews_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.workflow_run_reviews
  FOR EACH ROW EXECUTE FUNCTION public.enforce_workflow_run_review();

CREATE TRIGGER workflow_run_final_outputs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.workflow_run_final_outputs
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_final_output();

CREATE CONSTRAINT TRIGGER product_commands_workflow_run_aggregate_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_initial_aggregate();

CREATE CONSTRAINT TRIGGER product_commands_workflow_run_control_aggregate_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_control_command_aggregate();

CREATE CONSTRAINT TRIGGER workflow_runs_initial_aggregate_guard
  AFTER INSERT ON public.workflow_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_initial_aggregate();

CREATE CONSTRAINT TRIGGER workflow_run_events_terminal_aggregate_guard
  AFTER INSERT ON public.workflow_run_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_terminal_aggregate();

CREATE CONSTRAINT TRIGGER workflow_run_final_outputs_terminal_aggregate_guard
  AFTER INSERT ON public.workflow_run_final_outputs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_terminal_aggregate();

CREATE CONSTRAINT TRIGGER product_commands_workflow_run_projection_guard
  AFTER INSERT OR UPDATE ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_projection_consistency();

CREATE CONSTRAINT TRIGGER workflow_runs_projection_guard
  AFTER INSERT OR UPDATE ON public.workflow_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_projection_consistency();

CREATE CONSTRAINT TRIGGER workflow_run_jobs_projection_guard
  AFTER INSERT OR UPDATE ON public.workflow_run_jobs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_projection_consistency();

CREATE CONSTRAINT TRIGGER workflow_run_jobs_lease_aggregate_guard
  AFTER UPDATE ON public.workflow_run_jobs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_job_lease_aggregate();

CREATE CONSTRAINT TRIGGER workflow_run_events_review_aggregate_guard
  AFTER INSERT ON public.workflow_run_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_review_aggregate();

CREATE CONSTRAINT TRIGGER workflow_run_reviews_aggregate_guard
  AFTER INSERT OR UPDATE ON public.workflow_run_reviews
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_review_aggregate();

CREATE CONSTRAINT TRIGGER workflow_run_events_execution_state_guard
  AFTER INSERT ON public.workflow_run_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_execution_state_aggregate();

CREATE CONSTRAINT TRIGGER workflow_run_events_node_event_order_guard
  AFTER INSERT ON public.workflow_run_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_node_event_order();

CREATE CONSTRAINT TRIGGER workflow_run_events_lease_event_guard
  AFTER INSERT ON public.workflow_run_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_lease_event_aggregate();

CREATE CONSTRAINT TRIGGER workflow_run_node_attempts_execution_state_guard
  AFTER INSERT OR UPDATE ON public.workflow_run_node_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_execution_state_aggregate();

CREATE CONSTRAINT TRIGGER workflow_run_final_outputs_execution_state_guard
  AFTER INSERT ON public.workflow_run_final_outputs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_execution_state_aggregate();

CREATE CONSTRAINT TRIGGER execution_invocations_workflow_run_state_guard
  AFTER INSERT OR UPDATE ON public.execution_invocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_execution_state_aggregate();

CREATE TRIGGER execution_attempts_parent_serialization_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.execution_attempts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_execution_attempt_parent_serialization();

CREATE TRIGGER external_effect_receipts_authority_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.external_effect_receipts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_external_effect_receipt_authority();

CREATE CONSTRAINT TRIGGER execution_attempts_effect_receipt_parent_guard
  AFTER INSERT OR UPDATE ON public.execution_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_execution_effect_receipt_parent_aggregate();

CREATE CONSTRAINT TRIGGER execution_invocations_effect_receipt_parent_guard
  AFTER INSERT OR UPDATE ON public.execution_invocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_execution_effect_receipt_parent_aggregate();

CREATE CONSTRAINT TRIGGER external_effect_receipts_parent_guard
  AFTER INSERT OR UPDATE ON public.external_effect_receipts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_execution_effect_receipt_parent_aggregate();

CREATE CONSTRAINT TRIGGER execution_attempts_workflow_run_state_guard
  AFTER INSERT OR UPDATE ON public.execution_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_execution_state_aggregate();

CREATE CONSTRAINT TRIGGER capability_leases_workflow_run_state_guard
  AFTER INSERT OR UPDATE ON public.capability_leases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_execution_state_aggregate();

CREATE CONSTRAINT TRIGGER capacity_leases_workflow_run_state_guard
  AFTER INSERT OR UPDATE ON public.capacity_leases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_workflow_run_execution_state_aggregate();

-- G2 B4B Batch B: Automation is a pinned policy-and-input definition that
-- reuses the B4A Decision/ProductCommand authority and the B3 Workflow Run.
-- Inbox is a recipient projection only; source domains retain their authority.

CREATE TABLE public.automations (
  workspace_id public.product_identifier NOT NULL,
  automation_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  owner_user_id public.product_identifier NOT NULL,
  owner_principal_id public.product_identifier NOT NULL,
  owner_principal_kind text COLLATE "C" GENERATED ALWAYS AS ('user') STORED,
  automation_principal_id public.product_identifier NOT NULL,
  automation_principal_kind text COLLATE "C" GENERATED ALWAYS AS ('automation') STORED,
  schema_version text COLLATE "C" NOT NULL,
  display_name text NOT NULL,
  status text COLLATE "C" NOT NULL,
  current_revision_id public.product_identifier NOT NULL,
  current_revision_number integer NOT NULL,
  write_version integer NOT NULL DEFAULT 1,
  next_scheduled_at timestamptz,
  last_occurrence_at timestamptz,
  failure_streak integer NOT NULL DEFAULT 0,
  created_by_principal_id public.product_identifier NOT NULL,
  created_by_principal_kind text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, automation_id),
  CONSTRAINT automations_scope_fk
    FOREIGN KEY (workspace_id, scope_id)
    REFERENCES public.product_scopes (workspace_id, scope_id),
  CONSTRAINT automations_owner_membership_fk
    FOREIGN KEY (workspace_id, owner_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT automations_owner_principal_fk
    FOREIGN KEY (
      workspace_id, owner_principal_id, owner_principal_kind, owner_user_id
    ) REFERENCES public.workspace_principals (
      workspace_id, principal_id, principal_kind, user_id
    ),
  CONSTRAINT automations_automation_principal_fk
    FOREIGN KEY (
      workspace_id, automation_principal_id, automation_principal_kind
    ) REFERENCES public.workspace_principals (
      workspace_id, principal_id, principal_kind
    ),
  CONSTRAINT automations_creator_fk
    FOREIGN KEY (
      workspace_id, created_by_principal_id, created_by_principal_kind
    ) REFERENCES public.workspace_principals (
      workspace_id, principal_id, principal_kind
    ),
  CONSTRAINT automations_revision_parent_uq UNIQUE (
    workspace_id, automation_id, scope_id, automation_principal_id, owner_user_id
  ),
  CONSTRAINT automations_schema_version
    CHECK (schema_version = 'workbench-automation-v1'),
  CONSTRAINT automations_owner_identity
    CHECK (owner_principal_id = owner_user_id),
  CONSTRAINT automations_status CHECK (
    status IN ('draft', 'checking', 'active', 'paused', 'blocked', 'archived')
  ),
  CONSTRAINT automations_revision_positive CHECK (
    current_revision_number >= 1 AND write_version >= 1
  ),
  CONSTRAINT automations_failure_streak_nonnegative CHECK (failure_streak >= 0),
  CONSTRAINT automations_display_name_length
    CHECK (length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT automations_archive_shape
    CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT automations_time_order CHECK (
    updated_at >= created_at
    AND (next_scheduled_at IS NULL OR next_scheduled_at >= created_at)
    AND (last_occurrence_at IS NULL OR last_occurrence_at >= created_at)
    AND (archived_at IS NULL OR archived_at >= created_at)
  ),
  CONSTRAINT automations_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX automations_due_idx
  ON public.automations (workspace_id, status, next_scheduled_at, automation_id)
  WHERE status = 'active';

CREATE TABLE public.automation_revisions (
  workspace_id public.product_identifier NOT NULL,
  automation_revision_id public.product_identifier NOT NULL,
  automation_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  automation_principal_id public.product_identifier NOT NULL,
  automation_principal_kind text COLLATE "C" GENERATED ALWAYS AS ('automation') STORED,
  owner_user_id public.product_identifier NOT NULL,
  owner_scope_grant_id public.product_identifier NOT NULL,
  owner_principal_kind text COLLATE "C" GENERATED ALWAYS AS ('user') STORED,
  owner_access_kind text COLLATE "C" GENERATED ALWAYS AS ('operation') STORED,
  revision_number integer NOT NULL,
  base_revision_id public.product_identifier,
  base_revision_number integer,
  schema_version text COLLATE "C" NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  workflow_revision_id public.product_identifier NOT NULL,
  workflow_revision_content_hash text COLLATE "C" NOT NULL,
  loop_version_id public.product_identifier NOT NULL,
  loop_version_content_hash text COLLATE "C" NOT NULL,
  compile_result_id public.product_identifier NOT NULL,
  execution_plan_id public.product_identifier NOT NULL,
  execution_plan_content_hash text COLLATE "C" NOT NULL,
  scope_policy_revision_id public.product_identifier NOT NULL,
  policy_grant_id public.product_identifier NOT NULL,
  observed_policy_grant_revision integer NOT NULL,
  model_policy_revision_id public.product_identifier NOT NULL,
  model_policy_revision_number integer NOT NULL,
  model_profile_revision_ids public.product_identifier[] NOT NULL,
  trigger_kind text COLLATE "C" NOT NULL,
  cron_expression text COLLATE "C" NOT NULL,
  timezone_name text COLLATE "C" NOT NULL,
  trigger_revision integer NOT NULL,
  trigger_content_key text COLLATE "C" GENERATED ALWAYS AS (
    trigger_kind || chr(31) || cron_expression || chr(31) || timezone_name
  ) STORED,
  execution_location_policy text COLLATE "C" NOT NULL,
  budget_currency text COLLATE "C" NOT NULL,
  max_cost_microunits bigint NOT NULL,
  max_duration_seconds integer NOT NULL,
  approval_policy text COLLATE "C" NOT NULL,
  allowed_effect_classes text[] NOT NULL,
  misfire_policy text COLLATE "C" NOT NULL,
  misfire_max_lateness_seconds integer NOT NULL,
  dedupe_policy text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  pins_finalized boolean NOT NULL DEFAULT false,
  created_by_principal_id public.product_identifier NOT NULL,
  created_by_principal_kind text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, automation_revision_id),
  CONSTRAINT automation_revisions_root_fk
    FOREIGN KEY (
      workspace_id, automation_id, scope_id, automation_principal_id, owner_user_id
    ) REFERENCES public.automations (
      workspace_id, automation_id, scope_id, automation_principal_id, owner_user_id
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT automation_revisions_owner_scope_grant_fk
    FOREIGN KEY (
      workspace_id, scope_id, owner_scope_grant_id,
      owner_user_id, owner_principal_kind, owner_access_kind
    ) REFERENCES public.scope_principal_grants (
      workspace_id, scope_id, grant_id,
      principal_id, principal_kind, access_kind
    ),
  CONSTRAINT automation_revisions_policy_grant_fk
    FOREIGN KEY (
      workspace_id, scope_id, policy_grant_id,
      automation_principal_id, automation_principal_kind,
      scope_policy_revision_id
    ) REFERENCES public.policy_grants (
      workspace_id, scope_id, policy_grant_id,
      subject_principal_id, subject_principal_kind, policy_revision_id
    ),
  CONSTRAINT automation_revisions_workflow_scope_fk
    FOREIGN KEY (workspace_id, workflow_id, scope_id)
    REFERENCES public.workflows (workspace_id, workflow_id, scope_id),
  CONSTRAINT automation_revisions_workflow_revision_fk
    FOREIGN KEY (
      workspace_id, workflow_id, workflow_revision_id,
      workflow_revision_content_hash
    ) REFERENCES public.workflow_revisions (
      workspace_id, workflow_id, revision_id, content_hash
    ),
  CONSTRAINT automation_revisions_loop_version_fk
    FOREIGN KEY (
      workspace_id, workflow_id, loop_version_id, loop_version_content_hash
    ) REFERENCES public.loop_versions (
      workspace_id, workflow_id, loop_version_id, content_hash
    ),
  CONSTRAINT automation_revisions_execution_plan_fk
    FOREIGN KEY (
      workspace_id, execution_plan_id, compile_result_id,
      workflow_id, workflow_revision_id, pins_finalized
    ) REFERENCES public.execution_plans (
      workspace_id, plan_id, compile_result_id,
      workflow_id, workflow_revision_id, pins_finalized
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT automation_revisions_model_policy_fk
    FOREIGN KEY (
      workspace_id, scope_id, model_policy_revision_id,
      model_policy_revision_number
    ) REFERENCES public.workspace_model_policy_revisions (
      workspace_id, scope_id, policy_revision_id, revision
    ),
  CONSTRAINT automation_revisions_number_uq
    UNIQUE (workspace_id, automation_id, revision_number),
  CONSTRAINT automation_revisions_pointer_uq
    UNIQUE (
      workspace_id, automation_id, automation_revision_id, revision_number
    ),
  CONSTRAINT automation_revisions_trigger_generation_uq
    UNIQUE (
      workspace_id, automation_id, automation_revision_id, trigger_revision
    ),
  CONSTRAINT automation_revisions_pin_parent_uq UNIQUE (
    workspace_id, automation_id, automation_revision_id,
    scope_id, workflow_id, loop_version_id
  ),
  CONSTRAINT automation_revisions_base_fk
    FOREIGN KEY (
      workspace_id, automation_id, base_revision_id, base_revision_number
    ) REFERENCES public.automation_revisions (
      workspace_id, automation_id, automation_revision_id, revision_number
    ),
  CONSTRAINT automation_revisions_schema_version
    CHECK (schema_version = 'workbench-automation-revision-v1'),
  CONSTRAINT automation_revisions_number_positive CHECK (
    revision_number >= 1
    AND trigger_revision >= 1
    AND observed_policy_grant_revision >= 1
    AND model_policy_revision_number >= 1
  ),
  CONSTRAINT automation_revisions_base_shape CHECK (
    (revision_number = 1
      AND base_revision_id IS NULL AND base_revision_number IS NULL)
    OR (revision_number > 1
      AND base_revision_id IS NOT NULL
      AND base_revision_number = revision_number - 1)
  ),
  CONSTRAINT automation_revisions_not_self_base
    CHECK (base_revision_id IS NULL OR base_revision_id <> automation_revision_id),
  CONSTRAINT automation_revisions_trigger
    CHECK (trigger_kind = 'daily_cron'),
  CONSTRAINT automation_revisions_daily_cron CHECK (
    cron_expression ~ '^([0-5]?[0-9]) ([01]?[0-9]|2[0-3]) \* \* \*$'
  ),
  CONSTRAINT automation_revisions_cloud_only
    CHECK (execution_location_policy = 'cloud'),
  CONSTRAINT automation_revisions_budget CHECK (
    budget_currency = 'USD'
    AND max_cost_microunits >= 0
    AND max_duration_seconds BETWEEN 1 AND 86400
  ),
  CONSTRAINT automation_revisions_approval_policy CHECK (
    approval_policy IN ('policy_grant_only', 'run_review_required')
  ),
  CONSTRAINT automation_revisions_effects_closed CHECK (
    cardinality(allowed_effect_classes) BETWEEN 1 AND 5
    AND array_position(allowed_effect_classes, NULL) IS NULL
    AND allowed_effect_classes <@ ARRAY[
      'read', 'write_local', 'execute', 'external_write', 'administrative'
    ]::text[]
    AND allowed_effect_classes @> ARRAY['execute']::text[]
  ),
  CONSTRAINT automation_revisions_misfire CHECK (
    (misfire_policy = 'skip' AND misfire_max_lateness_seconds = 0)
    OR (misfire_policy = 'run_once'
      AND misfire_max_lateness_seconds BETWEEN 1 AND 86400)
  ),
  CONSTRAINT automation_revisions_dedupe
    CHECK (dedupe_policy = 'local_schedule_date'),
  CONSTRAINT automation_revisions_hash_formats CHECK (
    workflow_revision_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND loop_version_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND execution_plan_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
    AND content_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT automation_revisions_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

ALTER TABLE public.automations
  ADD CONSTRAINT automations_current_revision_fk
  FOREIGN KEY (
    workspace_id, automation_id, current_revision_id, current_revision_number
  ) REFERENCES public.automation_revisions (
    workspace_id, automation_id, automation_revision_id, revision_number
  ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.loop_version_resource_pins
  ADD CONSTRAINT loop_version_resource_pins_exact_uq UNIQUE (
    workspace_id, loop_version_id, resource_id, resource_version, content_hash
  );

ALTER TABLE public.loop_version_connection_requirements
  ADD CONSTRAINT loop_version_connection_requirements_exact_uq UNIQUE (
    workspace_id, loop_version_id, requirement_id, capability_key, required_effects
  );

CREATE TABLE public.automation_input_pins (
  workspace_id public.product_identifier NOT NULL,
  automation_revision_id public.product_identifier NOT NULL,
  automation_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  loop_version_id public.product_identifier NOT NULL,
  input_pin_id public.product_identifier NOT NULL,
  input_name public.product_identifier NOT NULL,
  input_kind text COLLATE "C" NOT NULL,
  resource_id public.product_identifier NOT NULL,
  resource_version text COLLATE "C" NOT NULL,
  resource_content_hash text COLLATE "C" NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, automation_revision_id, input_pin_id),
  CONSTRAINT automation_input_pins_revision_fk
    FOREIGN KEY (
      workspace_id, automation_id, automation_revision_id,
      scope_id, workflow_id, loop_version_id
    ) REFERENCES public.automation_revisions (
      workspace_id, automation_id, automation_revision_id,
      scope_id, workflow_id, loop_version_id
    ),
  CONSTRAINT automation_input_pins_resource_fk
    FOREIGN KEY (
      workspace_id, loop_version_id, resource_id,
      resource_version, resource_content_hash
    ) REFERENCES public.loop_version_resource_pins (
      workspace_id, loop_version_id, resource_id,
      resource_version, content_hash
    ),
  CONSTRAINT automation_input_pins_name_uq
    UNIQUE (workspace_id, automation_revision_id, input_name),
  CONSTRAINT automation_input_pins_resource_uq
    UNIQUE (
      workspace_id, automation_revision_id,
      resource_id, resource_version, resource_content_hash
    ),
  CONSTRAINT automation_input_pins_schema_version
    CHECK (schema_version = 'workbench-automation-input-pin-v1'),
  CONSTRAINT automation_input_pins_kind
    CHECK (input_kind = 'resource'),
  CONSTRAINT automation_input_pins_hash_formats CHECK (
    resource_content_hash ~ '^sha256:[a-f0-9]{16,64}$'
  )
);

CREATE TABLE public.automation_connection_pins (
  workspace_id public.product_identifier NOT NULL,
  automation_revision_id public.product_identifier NOT NULL,
  automation_id public.product_identifier NOT NULL,
  scope_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  loop_version_id public.product_identifier NOT NULL,
  requirement_id public.product_identifier NOT NULL,
  capability_key text COLLATE "C" NOT NULL,
  required_effects jsonb NOT NULL,
  connection_id public.product_identifier NOT NULL,
  connection_revision_id public.product_identifier NOT NULL,
  connection_revision_number integer NOT NULL,
  secret_binding_id public.product_identifier NOT NULL,
  secret_source text COLLATE "C" NOT NULL,
  store_binding_ref public.product_identifier NOT NULL,
  store_binding_revision integer NOT NULL,
  credential_fingerprint text COLLATE "C" NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, automation_revision_id, requirement_id),
  CONSTRAINT automation_connection_pins_revision_fk
    FOREIGN KEY (
      workspace_id, automation_id, automation_revision_id,
      scope_id, workflow_id, loop_version_id
    ) REFERENCES public.automation_revisions (
      workspace_id, automation_id, automation_revision_id,
      scope_id, workflow_id, loop_version_id
    ),
  CONSTRAINT automation_connection_pins_requirement_fk
    FOREIGN KEY (
      workspace_id, loop_version_id, requirement_id,
      capability_key, required_effects
    ) REFERENCES public.loop_version_connection_requirements (
      workspace_id, loop_version_id, requirement_id,
      capability_key, required_effects
    ),
  CONSTRAINT automation_connection_pins_connection_revision_fk
    FOREIGN KEY (
      workspace_id, connection_id,
      connection_revision_id, connection_revision_number
    ) REFERENCES public.workspace_connection_revisions (
      workspace_id, connection_id,
      connection_revision_id, revision_number
    ),
  CONSTRAINT automation_connection_pins_secret_binding_fk
    FOREIGN KEY (workspace_id, secret_binding_id)
    REFERENCES public.secret_bindings (workspace_id, secret_binding_id),
  CONSTRAINT automation_connection_pins_schema_version
    CHECK (schema_version = 'workbench-automation-connection-pin-v1'),
  CONSTRAINT automation_connection_pins_revision_positive CHECK (
    connection_revision_number >= 1 AND store_binding_revision >= 1
  ),
  CONSTRAINT automation_connection_pins_cloud_secret
    CHECK (secret_source = 'cloud_secret_store'),
  CONSTRAINT automation_connection_pins_hash_format
    CHECK (credential_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT automation_connection_pins_effects_array
    CHECK (jsonb_typeof(required_effects) = 'array')
);

CREATE TABLE public.automation_occurrences (
  workspace_id public.product_identifier NOT NULL,
  occurrence_id public.product_identifier NOT NULL,
  automation_id public.product_identifier NOT NULL,
  automation_revision_id public.product_identifier NOT NULL,
  trigger_revision integer NOT NULL,
  local_schedule_date date NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text COLLATE "C" NOT NULL,
  reason_code text COLLATE "C",
  authorization_decision_id public.product_identifier,
  product_command_id public.product_identifier,
  run_id public.product_identifier,
  observed_policy_grant_revision integer,
  schema_version text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  accepted_at timestamptz,
  terminal_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, occurrence_id),
  CONSTRAINT automation_occurrences_revision_fk
    FOREIGN KEY (
      workspace_id, automation_id,
      automation_revision_id, trigger_revision
    ) REFERENCES public.automation_revisions (
      workspace_id, automation_id,
      automation_revision_id, trigger_revision
    ),
  CONSTRAINT automation_occurrences_decision_fk
    FOREIGN KEY (workspace_id, authorization_decision_id)
    REFERENCES public.authorization_decisions (
      workspace_id, authorization_decision_id
    ),
  CONSTRAINT automation_occurrences_command_fk
    FOREIGN KEY (workspace_id, product_command_id)
    REFERENCES public.product_commands (workspace_id, command_id),
  CONSTRAINT automation_occurrences_run_fk
    FOREIGN KEY (workspace_id, run_id, product_command_id)
    REFERENCES public.workflow_runs (
      workspace_id, run_id, product_command_id
    ) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT automation_occurrences_dedupe_uq UNIQUE (
    workspace_id, automation_id, trigger_revision, local_schedule_date
  ),
  CONSTRAINT automation_occurrences_run_uq UNIQUE (workspace_id, run_id),
  CONSTRAINT automation_occurrences_command_uq
    UNIQUE (workspace_id, product_command_id),
  CONSTRAINT automation_occurrences_schema_version
    CHECK (schema_version = 'workbench-automation-occurrence-v1'),
  CONSTRAINT automation_occurrences_trigger_revision_positive
    CHECK (trigger_revision >= 1),
  CONSTRAINT automation_occurrences_status CHECK (
    status IN ('due', 'accepted', 'misfired', 'skipped', 'blocked')
  ),
  CONSTRAINT automation_occurrences_state_shape CHECK (
    (status = 'due'
      AND reason_code IS NULL
      AND authorization_decision_id IS NULL
      AND product_command_id IS NULL
      AND run_id IS NULL
      AND observed_policy_grant_revision IS NULL
      AND accepted_at IS NULL
      AND terminal_at IS NULL)
    OR (status = 'accepted'
      AND reason_code IS NULL
      AND authorization_decision_id IS NOT NULL
      AND product_command_id IS NOT NULL
      AND run_id IS NOT NULL
      AND observed_policy_grant_revision IS NOT NULL
      AND accepted_at IS NOT NULL
      AND terminal_at = accepted_at)
    OR (status IN ('misfired', 'skipped', 'blocked')
      AND reason_code IS NOT NULL
      AND authorization_decision_id IS NULL
      AND product_command_id IS NULL
      AND run_id IS NULL
      AND observed_policy_grant_revision IS NULL
      AND accepted_at IS NULL
      AND terminal_at IS NOT NULL)
  ),
  CONSTRAINT automation_occurrences_time_order CHECK (
    updated_at >= created_at
    AND (accepted_at IS NULL OR accepted_at >= created_at)
    AND (terminal_at IS NULL OR terminal_at >= created_at)
  ),
  CONSTRAINT automation_occurrences_payload_object
    CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX automation_occurrences_status_schedule_idx
  ON public.automation_occurrences (
    workspace_id, status, scheduled_for, occurrence_id
  );

CREATE TABLE public.inbox_items (
  workspace_id public.product_identifier NOT NULL,
  inbox_item_id public.product_identifier NOT NULL,
  recipient_user_id public.product_identifier NOT NULL,
  source_domain text COLLATE "C" NOT NULL,
  source_id public.product_identifier NOT NULL,
  source_revision integer NOT NULL,
  source_cursor text COLLATE "C" NOT NULL,
  reason_code text COLLATE "C" NOT NULL,
  severity text COLLATE "C" NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  target_kind text COLLATE "C" NOT NULL,
  target_id public.product_identifier NOT NULL,
  action_id public.product_identifier,
  status text COLLATE "C" NOT NULL,
  schema_version text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  read_at timestamptz,
  dismissed_at timestamptz,
  PRIMARY KEY (workspace_id, inbox_item_id),
  CONSTRAINT inbox_items_recipient_fk
    FOREIGN KEY (workspace_id, recipient_user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT inbox_items_identity_uq UNIQUE (
    workspace_id, recipient_user_id,
    source_domain, source_id, source_revision
  ),
  CONSTRAINT inbox_items_schema_version
    CHECK (schema_version = 'workbench-inbox-item-v1'),
  CONSTRAINT inbox_items_source_domain CHECK (
    source_domain IN (
      'authorization_decision', 'workflow_run',
      'automation_occurrence', 'installation_update_draft'
    )
  ),
  CONSTRAINT inbox_items_source_revision_positive CHECK (source_revision >= 1),
  CONSTRAINT inbox_items_source_cursor_length
    CHECK (length(source_cursor) BETWEEN 1 AND 256),
  CONSTRAINT inbox_items_reason_length
    CHECK (length(reason_code) BETWEEN 1 AND 128),
  CONSTRAINT inbox_items_severity
    CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  CONSTRAINT inbox_items_display_lengths CHECK (
    length(title) BETWEEN 1 AND 300
    AND length(summary) BETWEEN 1 AND 2000
  ),
  CONSTRAINT inbox_items_status
    CHECK (status IN ('unread', 'read', 'dismissed')),
  CONSTRAINT inbox_items_status_shape CHECK (
    (status = 'unread' AND read_at IS NULL AND dismissed_at IS NULL)
    OR (status = 'read' AND read_at IS NOT NULL AND dismissed_at IS NULL)
    OR (status = 'dismissed' AND dismissed_at IS NOT NULL)
  ),
  CONSTRAINT inbox_items_time_order CHECK (
    updated_at >= created_at
    AND (read_at IS NULL OR read_at >= created_at)
    AND (dismissed_at IS NULL OR dismissed_at >= created_at)
  )
);

CREATE INDEX inbox_items_recipient_status_created_idx
  ON public.inbox_items (
    workspace_id, recipient_user_id, status, created_at DESC, inbox_item_id
  );

CREATE FUNCTION public.enforce_automation_root_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'archived' THEN
    RAISE EXCEPTION 'automation_root_terminal' USING ERRCODE = '55000';
  END IF;
  IF ROW(
      NEW.workspace_id, NEW.automation_id, NEW.scope_id,
      NEW.owner_user_id, NEW.owner_principal_id,
      NEW.automation_principal_id, NEW.schema_version,
      NEW.created_by_principal_id, NEW.created_by_principal_kind,
      NEW.created_at, NEW.payload
    ) IS DISTINCT FROM ROW(
      OLD.workspace_id, OLD.automation_id, OLD.scope_id,
      OLD.owner_user_id, OLD.owner_principal_id,
      OLD.automation_principal_id, OLD.schema_version,
      OLD.created_by_principal_id, OLD.created_by_principal_kind,
      OLD.created_at, OLD.payload
    ) THEN
    RAISE EXCEPTION 'automation_root_identity_immutable' USING ERRCODE = '55000';
  END IF;
  IF ROW(
      NEW.display_name, NEW.status,
      NEW.current_revision_id, NEW.current_revision_number,
      NEW.next_scheduled_at, NEW.last_occurrence_at,
      NEW.failure_streak, NEW.archived_at
    ) IS DISTINCT FROM ROW(
      OLD.display_name, OLD.status,
      OLD.current_revision_id, OLD.current_revision_number,
      OLD.next_scheduled_at, OLD.last_occurrence_at,
      OLD.failure_streak, OLD.archived_at
    ) AND NEW.write_version <> OLD.write_version + 1 THEN
    RAISE EXCEPTION 'automation_root_write_version_required'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.write_version < OLD.write_version
    OR NEW.current_revision_number < OLD.current_revision_number
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'automation_root_revision_regression'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
    AND NEW.current_revision_number <> OLD.current_revision_number + 1 THEN
    RAISE EXCEPTION 'automation_root_direct_revision_required'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_automation_revision_contract()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  plan_hash text;
  authority_current boolean;
  existing_trigger_revision integer;
  next_trigger_revision integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automation_revision_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NOT (
      OLD.pins_finalized = false AND NEW.pins_finalized = true
      AND (to_jsonb(NEW) - ARRAY[
        'pins_finalized',
        'automation_principal_kind',
        'owner_principal_kind',
        'owner_access_kind',
        'trigger_content_key'
      ]) = (to_jsonb(OLD) - ARRAY[
        'pins_finalized',
        'automation_principal_kind',
        'owner_principal_kind',
        'owner_access_kind',
        'trigger_content_key'
      ])
    ) THEN
      RAISE EXCEPTION 'automation_revision_immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.pins_finalized THEN
    RAISE EXCEPTION 'automation_revision_must_finalize_after_pin_assembly'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM 1
    FROM public.automations root
    WHERE root.workspace_id = NEW.workspace_id
      AND root.automation_id = NEW.automation_id
    FOR UPDATE;
    SELECT revision.trigger_revision INTO existing_trigger_revision
    FROM public.automation_revisions revision
    WHERE revision.workspace_id = NEW.workspace_id
      AND revision.automation_id = NEW.automation_id
      AND revision.trigger_kind = NEW.trigger_kind
      AND revision.cron_expression = NEW.cron_expression
      AND revision.timezone_name = NEW.timezone_name
    ORDER BY revision.revision_number DESC
    LIMIT 1;
    IF FOUND THEN
      IF NEW.trigger_revision <> existing_trigger_revision THEN
        RAISE EXCEPTION 'automation_trigger_generation_content_mismatch'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      SELECT coalesce(max(revision.trigger_revision), 0) + 1
      INTO next_trigger_revision
      FROM public.automation_revisions revision
      WHERE revision.workspace_id = NEW.workspace_id
        AND revision.automation_id = NEW.automation_id;
      IF NEW.trigger_revision <> next_trigger_revision THEN
        RAISE EXCEPTION 'automation_trigger_generation_not_next'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF NEW.model_profile_revision_ids IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value
      FROM unnest(NEW.model_profile_revision_ids) AS value
      ORDER BY value
    ) OR NEW.allowed_effect_classes IS DISTINCT FROM ARRAY(
      SELECT DISTINCT value
      FROM unnest(NEW.allowed_effect_classes) AS value
      ORDER BY value
    ) THEN
    RAISE EXCEPTION 'automation_revision_arrays_not_canonical'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names timezone
    WHERE timezone.name = NEW.timezone_name
  ) THEN
    RAISE EXCEPTION 'automation_timezone_unknown: %', NEW.timezone_name
      USING ERRCODE = '23514';
  END IF;
  SELECT plan.content_hash INTO plan_hash
  FROM public.execution_plans plan
  WHERE plan.workspace_id = NEW.workspace_id
    AND plan.plan_id = NEW.execution_plan_id
    AND plan.compile_result_id = NEW.compile_result_id
    AND plan.workflow_id = NEW.workflow_id
    AND plan.workflow_revision_id = NEW.workflow_revision_id
    AND plan.pins_finalized
  FOR SHARE;
  IF plan_hash IS DISTINCT FROM NEW.execution_plan_content_hash THEN
    RAISE EXCEPTION 'automation_execution_plan_hash_mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT scope.status = 'active'
    AND scope.current_policy_revision_id = NEW.scope_policy_revision_id
    AND owner_membership.status = 'active'
    AND owner_principal.status = 'active'
    AND automation_principal.status = 'active'
    AND owner_grant.status = 'active'
    AND policy_grant.status = 'active'
    AND policy_grant.revision = NEW.observed_policy_grant_revision
    AND policy_grant.expires_at > clock_timestamp()
  INTO authority_current
  FROM public.product_scopes scope
  JOIN public.workspace_memberships owner_membership
    ON owner_membership.workspace_id = NEW.workspace_id
   AND owner_membership.user_id = NEW.owner_user_id
  JOIN public.workspace_principals owner_principal
    ON owner_principal.workspace_id = NEW.workspace_id
   AND owner_principal.principal_id = NEW.owner_user_id
   AND owner_principal.principal_kind = 'user'
  JOIN public.workspace_principals automation_principal
    ON automation_principal.workspace_id = NEW.workspace_id
   AND automation_principal.principal_id = NEW.automation_principal_id
   AND automation_principal.principal_kind = 'automation'
  JOIN public.scope_principal_grants owner_grant
    ON owner_grant.workspace_id = NEW.workspace_id
   AND owner_grant.scope_id = NEW.scope_id
   AND owner_grant.grant_id = NEW.owner_scope_grant_id
   AND owner_grant.principal_id = NEW.owner_user_id
   AND owner_grant.principal_kind = 'user'
  JOIN public.policy_grants policy_grant
    ON policy_grant.workspace_id = NEW.workspace_id
   AND policy_grant.scope_id = NEW.scope_id
   AND policy_grant.policy_grant_id = NEW.policy_grant_id
   AND policy_grant.subject_principal_id = NEW.automation_principal_id
   AND policy_grant.subject_principal_kind = 'automation'
   AND policy_grant.policy_revision_id = NEW.scope_policy_revision_id
  WHERE scope.workspace_id = NEW.workspace_id
    AND scope.scope_id = NEW.scope_id;
  IF authority_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'automation_revision_authority_inactive'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.reject_finalized_automation_pin_append()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.automation_revisions revision
    WHERE revision.workspace_id = NEW.workspace_id
      AND revision.automation_revision_id = NEW.automation_revision_id
      AND revision.pins_finalized
  ) THEN
    RAISE EXCEPTION 'automation_revision_pins_finalized'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.reject_immutable_automation_pin_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'automation_pin_immutable: %', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$function$;

CREATE FUNCTION public.validate_automation_connection_pin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  pin_valid boolean;
  canonical_effects jsonb;
BEGIN
  SELECT COALESCE(
    jsonb_agg(to_jsonb(effect_text) ORDER BY effect_text), '[]'::jsonb
  ) INTO canonical_effects
  FROM (
    SELECT DISTINCT effect #>> '{}' AS effect_text
    FROM jsonb_array_elements(NEW.required_effects) AS effect
    WHERE jsonb_typeof(effect) = 'string'
      AND length(effect #>> '{}') BETWEEN 1 AND 128
  ) canonical;
  IF canonical_effects IS DISTINCT FROM NEW.required_effects THEN
    RAISE EXCEPTION 'automation_connection_effects_not_canonical'
      USING ERRCODE = '23514';
  END IF;

  SELECT connection.enabled
    AND connection.scope_id = NEW.scope_id
    AND revision.scope_id = NEW.scope_id
    AND revision.driver_backend = 'production'
    AND revision.capability_key = NEW.capability_key
    AND revision.validation_effects @> NEW.required_effects
    AND revision.credential_state = 'bound'
    AND revision.readiness_status = 'connected'
    AND revision.validation_status = 'valid'
    AND revision.validation_checked_at IS NOT NULL
    AND revision.validation_checked_at <= clock_timestamp()
    AND (revision.validation_expires_at IS NULL
      OR revision.validation_expires_at > clock_timestamp())
    AND revision.secret_binding_id = NEW.secret_binding_id
    AND revision.credential_binding_fingerprint = NEW.credential_fingerprint
    AND binding.owner_kind = 'connection'
    AND binding.owner_id = NEW.connection_id
    AND binding.scope_id = NEW.scope_id
    AND binding.secret_source = NEW.secret_source
    AND binding.store_binding_ref = NEW.store_binding_ref
    AND binding.store_binding_revision = NEW.store_binding_revision
    AND binding.credential_fingerprint = NEW.credential_fingerprint
    AND binding.status = 'active'
    AND binding.probed_at IS NOT NULL
    AND binding.probed_at <= clock_timestamp()
    AND (binding.expires_at IS NULL OR binding.expires_at > clock_timestamp())
  INTO pin_valid
  FROM public.workspace_connections connection
  JOIN public.workspace_connection_revisions revision
    ON revision.workspace_id = connection.workspace_id
   AND revision.connection_id = connection.connection_id
   AND revision.connection_revision_id = NEW.connection_revision_id
   AND revision.revision_number = NEW.connection_revision_number
  JOIN public.secret_bindings binding
    ON binding.workspace_id = revision.workspace_id
   AND binding.secret_binding_id = revision.secret_binding_id
  WHERE connection.workspace_id = NEW.workspace_id
    AND connection.connection_id = NEW.connection_id
  FOR SHARE OF connection, binding;
  IF pin_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'automation_connection_pin_not_consumable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_automation_revision_pins()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  revision_row public.automation_revisions%ROWTYPE;
  model_projection_valid boolean;
  resource_projection_valid boolean;
  connection_projection_valid boolean;
BEGIN
  IF TG_TABLE_NAME = 'automation_revisions' THEN
    revision_row := NEW;
  ELSE
    SELECT * INTO revision_row
    FROM public.automation_revisions revision
    WHERE revision.workspace_id = NEW.workspace_id
      AND revision.automation_revision_id = NEW.automation_revision_id;
  END IF;
  IF revision_row.automation_revision_id IS NULL OR NOT revision_row.pins_finalized THEN
    RETURN NEW;
  END IF;

  WITH expected AS (
    SELECT DISTINCT pin.model_profile_revision_id
    FROM public.execution_plan_model_pins pin
    WHERE pin.workspace_id = revision_row.workspace_id
      AND pin.plan_id = revision_row.execution_plan_id
  ), actual AS (
    SELECT unnest(revision_row.model_profile_revision_ids)
      AS model_profile_revision_id
  )
  SELECT NOT EXISTS (
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) INTO model_projection_valid;
  IF model_projection_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'automation_model_pin_projection_incomplete'
      USING ERRCODE = '23514';
  END IF;

  SELECT NOT EXISTS (
    (SELECT resource.resource_id, resource.resource_version, resource.content_hash
     FROM public.loop_version_resource_pins resource
     WHERE resource.workspace_id = revision_row.workspace_id
       AND resource.loop_version_id = revision_row.loop_version_id
     EXCEPT
     SELECT pin.resource_id, pin.resource_version, pin.resource_content_hash
     FROM public.automation_input_pins pin
     WHERE pin.workspace_id = revision_row.workspace_id
       AND pin.automation_revision_id = revision_row.automation_revision_id)
    UNION ALL
    (SELECT pin.resource_id, pin.resource_version, pin.resource_content_hash
     FROM public.automation_input_pins pin
     WHERE pin.workspace_id = revision_row.workspace_id
       AND pin.automation_revision_id = revision_row.automation_revision_id
     EXCEPT
     SELECT resource.resource_id, resource.resource_version, resource.content_hash
     FROM public.loop_version_resource_pins resource
     WHERE resource.workspace_id = revision_row.workspace_id
       AND resource.loop_version_id = revision_row.loop_version_id)
  ) INTO resource_projection_valid;
  IF resource_projection_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'automation_resource_pin_projection_incomplete'
      USING ERRCODE = '23514';
  END IF;

  SELECT NOT EXISTS (
    (SELECT requirement.requirement_id
     FROM public.loop_version_connection_requirements requirement
     WHERE requirement.workspace_id = revision_row.workspace_id
       AND requirement.loop_version_id = revision_row.loop_version_id
     EXCEPT
     SELECT pin.requirement_id
     FROM public.automation_connection_pins pin
     WHERE pin.workspace_id = revision_row.workspace_id
       AND pin.automation_revision_id = revision_row.automation_revision_id)
    UNION ALL
    (SELECT pin.requirement_id
     FROM public.automation_connection_pins pin
     WHERE pin.workspace_id = revision_row.workspace_id
       AND pin.automation_revision_id = revision_row.automation_revision_id
     EXCEPT
     SELECT requirement.requirement_id
     FROM public.loop_version_connection_requirements requirement
     WHERE requirement.workspace_id = revision_row.workspace_id
       AND requirement.loop_version_id = revision_row.loop_version_id)
  ) INTO connection_projection_valid;
  IF connection_projection_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'automation_connection_pin_projection_incomplete'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_automation_current_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  root_row public.automations%ROWTYPE;
  current_valid boolean;
BEGIN
  IF TG_TABLE_NAME = 'automations' THEN
    root_row := NEW;
  ELSE
    SELECT * INTO root_row FROM public.automations root
    WHERE root.workspace_id = NEW.workspace_id
      AND root.automation_id = NEW.automation_id;
    IF root_row.current_revision_id IS DISTINCT FROM NEW.automation_revision_id THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT revision.pins_finalized
    AND revision.scope_id = root_row.scope_id
    AND revision.automation_principal_id = root_row.automation_principal_id
    AND revision.owner_user_id = root_row.owner_user_id
  INTO current_valid
  FROM public.automation_revisions revision
  WHERE revision.workspace_id = root_row.workspace_id
    AND revision.automation_id = root_row.automation_id
    AND revision.automation_revision_id = root_row.current_revision_id
    AND revision.revision_number = root_row.current_revision_number;
  IF current_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'automation_current_revision_not_finalized'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.assert_automation_revision_consumable(
  target_workspace_id public.product_identifier,
  target_automation_id public.product_identifier,
  target_automation_revision_id public.product_identifier,
  target_policy_grant_revision integer
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  revision_row public.automation_revisions%ROWTYPE;
  authority_current boolean;
  model_revision_id public.product_identifier;
  connection_pin public.automation_connection_pins%ROWTYPE;
  connection_current boolean;
BEGIN
  SELECT revision.* INTO revision_row
  FROM public.automation_revisions revision
  JOIN public.automations root
    ON root.workspace_id = revision.workspace_id
   AND root.automation_id = revision.automation_id
  WHERE revision.workspace_id = target_workspace_id
    AND revision.automation_id = target_automation_id
    AND revision.automation_revision_id = target_automation_revision_id
    AND root.current_revision_id = revision.automation_revision_id
    AND root.current_revision_number = revision.revision_number
    AND root.status = 'active'
  FOR SHARE OF revision, root;
  IF NOT FOUND OR NOT revision_row.pins_finalized
    OR revision_row.observed_policy_grant_revision
      <> target_policy_grant_revision THEN
    RAISE EXCEPTION 'automation_revision_not_current_or_finalized'
      USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.workspace_principals principal
  WHERE principal.workspace_id = target_workspace_id
    AND principal.principal_id IN (
      revision_row.owner_user_id, revision_row.automation_principal_id
    )
  ORDER BY principal.principal_id, principal.principal_kind
  FOR SHARE;
  PERFORM 1 FROM public.scope_principal_grants scope_grant
  WHERE scope_grant.workspace_id = target_workspace_id
    AND scope_grant.grant_id IN (
      revision_row.owner_scope_grant_id,
      (SELECT policy_grant.subject_scope_grant_id
       FROM public.policy_grants policy_grant
       WHERE policy_grant.workspace_id = target_workspace_id
         AND policy_grant.policy_grant_id = revision_row.policy_grant_id)
    )
  ORDER BY scope_grant.grant_id
  FOR SHARE;
  PERFORM 1 FROM public.workspace_memberships membership
  WHERE membership.workspace_id = target_workspace_id
    AND membership.user_id = revision_row.owner_user_id
  FOR SHARE;
  PERFORM 1 FROM public.product_scopes scope
  WHERE scope.workspace_id = target_workspace_id
    AND scope.scope_id = revision_row.scope_id
  FOR SHARE;
  PERFORM 1 FROM public.policy_grants policy_grant
  WHERE policy_grant.workspace_id = target_workspace_id
    AND policy_grant.policy_grant_id = revision_row.policy_grant_id
  FOR SHARE;

  SELECT root.status = 'active'
    AND scope.status = 'active'
    AND scope.current_policy_revision_id
      = revision_row.scope_policy_revision_id
    AND owner_membership.status = 'active'
    AND owner_principal.status = 'active'
    AND automation_principal.status = 'active'
    AND owner_grant.status = 'active'
    AND automation_grant.status = 'active'
    AND policy_grant.status = 'active'
    AND policy_grant.revision = target_policy_grant_revision
    AND policy_grant.expires_at > clock_timestamp()
  INTO authority_current
  FROM public.automations root
  JOIN public.product_scopes scope
    ON scope.workspace_id = root.workspace_id
   AND scope.scope_id = root.scope_id
  JOIN public.workspace_memberships owner_membership
    ON owner_membership.workspace_id = root.workspace_id
   AND owner_membership.user_id = root.owner_user_id
  JOIN public.workspace_principals owner_principal
    ON owner_principal.workspace_id = root.workspace_id
   AND owner_principal.principal_id = root.owner_user_id
   AND owner_principal.principal_kind = 'user'
  JOIN public.workspace_principals automation_principal
    ON automation_principal.workspace_id = root.workspace_id
   AND automation_principal.principal_id = root.automation_principal_id
   AND automation_principal.principal_kind = 'automation'
  JOIN public.scope_principal_grants owner_grant
    ON owner_grant.workspace_id = root.workspace_id
   AND owner_grant.grant_id = revision_row.owner_scope_grant_id
  JOIN public.policy_grants policy_grant
    ON policy_grant.workspace_id = root.workspace_id
   AND policy_grant.policy_grant_id = revision_row.policy_grant_id
  JOIN public.scope_principal_grants automation_grant
    ON automation_grant.workspace_id = policy_grant.workspace_id
   AND automation_grant.grant_id = policy_grant.subject_scope_grant_id
  WHERE root.workspace_id = target_workspace_id
    AND root.automation_id = target_automation_id;
  IF authority_current IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'automation_authority_inactive'
      USING ERRCODE = '23514';
  END IF;

  FOREACH model_revision_id IN ARRAY revision_row.model_profile_revision_ids LOOP
    PERFORM public.assert_model_revision_consumable(
      target_workspace_id, revision_row.scope_id, model_revision_id, NULL
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.automation_input_pins input_pin
    LEFT JOIN public.workspace_resources resource
      ON resource.workspace_id = input_pin.workspace_id
     AND resource.resource_id = input_pin.resource_id
     AND resource.resource_version = input_pin.resource_version
     AND resource.content_hash = input_pin.resource_content_hash
     AND resource.readiness_status = 'ready'
    WHERE input_pin.workspace_id = target_workspace_id
      AND input_pin.automation_revision_id = target_automation_revision_id
      AND resource.resource_id IS NULL
  ) THEN
    RAISE EXCEPTION 'automation_resource_pin_not_consumable'
      USING ERRCODE = '23514';
  END IF;

  FOR connection_pin IN
    SELECT pin.*
    FROM public.automation_connection_pins pin
    WHERE pin.workspace_id = target_workspace_id
      AND pin.automation_revision_id = target_automation_revision_id
    ORDER BY pin.requirement_id
    FOR SHARE OF pin
  LOOP
    SELECT connection.enabled
      AND connection.scope_id = connection_pin.scope_id
      AND revision.scope_id = connection_pin.scope_id
      AND revision.driver_backend = 'production'
      AND revision.capability_key = connection_pin.capability_key
      AND revision.validation_effects @> connection_pin.required_effects
      AND revision.credential_state = 'bound'
      AND revision.readiness_status = 'connected'
      AND revision.validation_status = 'valid'
      AND revision.validation_checked_at <= clock_timestamp()
      AND (revision.validation_expires_at IS NULL
        OR revision.validation_expires_at > clock_timestamp())
      AND revision.secret_binding_id = connection_pin.secret_binding_id
      AND revision.credential_binding_fingerprint
        = connection_pin.credential_fingerprint
      AND binding.owner_kind = 'connection'
      AND binding.owner_id = connection_pin.connection_id
      AND binding.scope_id = connection_pin.scope_id
      AND binding.secret_source = connection_pin.secret_source
      AND binding.store_binding_ref = connection_pin.store_binding_ref
      AND binding.store_binding_revision
        = connection_pin.store_binding_revision
      AND binding.credential_fingerprint
        = connection_pin.credential_fingerprint
      AND binding.status = 'active'
      AND binding.probed_at <= clock_timestamp()
      AND (binding.expires_at IS NULL
        OR binding.expires_at > clock_timestamp())
    INTO connection_current
    FROM public.workspace_connections connection
    JOIN public.workspace_connection_revisions revision
      ON revision.workspace_id = connection.workspace_id
     AND revision.connection_id = connection.connection_id
     AND revision.connection_revision_id
       = connection_pin.connection_revision_id
     AND revision.revision_number
       = connection_pin.connection_revision_number
    JOIN public.secret_bindings binding
      ON binding.workspace_id = revision.workspace_id
     AND binding.secret_binding_id = revision.secret_binding_id
    WHERE connection.workspace_id = connection_pin.workspace_id
      AND connection.connection_id = connection_pin.connection_id
    FOR SHARE OF connection, binding;
    IF connection_current IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'automation_connection_pin_not_consumable'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$function$;

CREATE FUNCTION public.enforce_automation_occurrence_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  cron_minute integer;
  cron_hour integer;
  timezone_name text;
  misfire_policy text;
  max_lateness_seconds integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'automation_occurrence_terminal'
      USING ERRCODE = '55000';
  END IF;
  SELECT revision.timezone_name,
    split_part(revision.cron_expression, ' ', 1)::integer,
    split_part(revision.cron_expression, ' ', 2)::integer,
    revision.misfire_policy,
    revision.misfire_max_lateness_seconds
  INTO timezone_name, cron_minute, cron_hour, misfire_policy, max_lateness_seconds
  FROM public.automation_revisions revision
  WHERE revision.workspace_id = NEW.workspace_id
    AND revision.automation_revision_id = NEW.automation_revision_id;
  IF timezone_name IS NULL
    OR (NEW.scheduled_for AT TIME ZONE timezone_name)::date
      <> NEW.local_schedule_date
    OR extract(hour FROM NEW.scheduled_for AT TIME ZONE timezone_name)::integer
      <> cron_hour
    OR extract(minute FROM NEW.scheduled_for AT TIME ZONE timezone_name)::integer
      <> cron_minute THEN
    RAISE EXCEPTION 'automation_occurrence_schedule_mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'accepted' AND NEW.accepted_at IS NOT NULL THEN
    -- Cron V1 has minute precision. A slot accepted inside its scheduled
    -- minute is on time; any later acceptance is a catch-up and must obey
    -- the persisted misfire policy instead of an unbounded scheduler choice.
    IF NEW.accepted_at < NEW.scheduled_for THEN
      RAISE EXCEPTION 'automation_occurrence_accepted_before_schedule'
        USING ERRCODE = '23514';
    ELSIF NEW.accepted_at >= NEW.scheduled_for + interval '1 minute' THEN
      IF misfire_policy = 'skip' THEN
        RAISE EXCEPTION 'automation_occurrence_misfire_must_skip'
          USING ERRCODE = '23514';
      ELSIF NEW.accepted_at > NEW.scheduled_for + interval '1 minute'
          + make_interval(secs => max_lateness_seconds) THEN
        RAISE EXCEPTION 'automation_occurrence_misfire_lateness_exceeded'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
  IF OLD.status <> 'due' THEN
    RAISE EXCEPTION 'automation_occurrence_terminal'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
      NEW.workspace_id, NEW.occurrence_id, NEW.automation_id,
      NEW.automation_revision_id, NEW.trigger_revision,
      NEW.local_schedule_date, NEW.scheduled_for,
      NEW.schema_version, NEW.created_at, NEW.payload
    ) IS DISTINCT FROM ROW(
      OLD.workspace_id, OLD.occurrence_id, OLD.automation_id,
      OLD.automation_revision_id, OLD.trigger_revision,
      OLD.local_schedule_date, OLD.scheduled_for,
      OLD.schema_version, OLD.created_at, OLD.payload
    ) THEN
    RAISE EXCEPTION 'automation_occurrence_identity_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'due' OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'automation_occurrence_transition_invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_automation_occurrence_accepted_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  occurrence_row public.automation_occurrences%ROWTYPE;
  revision_row public.automation_revisions%ROWTYPE;
  accepted_valid boolean;
  expected_resources jsonb;
  actual_resources jsonb;
BEGIN
  IF TG_TABLE_NAME = 'automation_occurrences' THEN
    occurrence_row := NEW;
  ELSE
    SELECT occurrence.* INTO occurrence_row
    FROM public.automation_occurrences occurrence
    WHERE occurrence.workspace_id = NEW.workspace_id
      AND (
        (TG_TABLE_NAME = 'product_commands'
          AND occurrence.product_command_id = NEW.command_id)
        OR (TG_TABLE_NAME = 'workflow_runs'
          AND occurrence.run_id = NEW.run_id)
      );
  END IF;
  IF occurrence_row.status IS DISTINCT FROM 'accepted' THEN RETURN NEW; END IF;

  SELECT * INTO revision_row
  FROM public.automation_revisions revision
  WHERE revision.workspace_id = occurrence_row.workspace_id
    AND revision.automation_revision_id
      = occurrence_row.automation_revision_id;
  PERFORM public.assert_automation_revision_consumable(
    occurrence_row.workspace_id, occurrence_row.automation_id,
    occurrence_row.automation_revision_id,
    occurrence_row.observed_policy_grant_revision
  );

  SELECT decision.actor_principal_kind = 'scheduler'
    AND decision.effective_principal_id = revision_row.automation_principal_id
    AND decision.effective_principal_kind = 'automation'
    AND decision.authorization_source = 'policy_grant'
    AND decision.policy_grant_id = revision_row.policy_grant_id
    AND decision.scope_id = revision_row.scope_id
    AND decision.policy_revision_id = revision_row.scope_policy_revision_id
    AND decision.action_id = 'workflow_run'
    AND decision.effect_class = 'execute'
    AND decision.disposition = 'authorized'
    AND decision.decided_at <= occurrence_row.accepted_at
    AND command.authorization_decision_id
      = occurrence_row.authorization_decision_id
    AND command.actor_principal_id = decision.actor_principal_id
    AND command.actor_principal_kind = 'scheduler'
    AND command.effective_principal_id = revision_row.automation_principal_id
    AND command.effective_principal_kind = 'automation'
    AND command.scope_id = revision_row.scope_id
    AND command.policy_revision_id = revision_row.scope_policy_revision_id
    AND command.kind = 'workflow_run'
    AND command.effect_class = 'execute'
    AND command.target_kind = 'workflow_run'
    AND command.target_id = occurrence_row.run_id
    AND command.target_revision = 1
    AND command.quota_user_id = revision_row.owner_user_id
    AND command.status = 'accepted'
    AND run.scope_id = revision_row.scope_id
    AND run.workflow_id = revision_row.workflow_id
    AND run.workflow_revision_id = revision_row.workflow_revision_id
    AND run.workflow_revision_content_hash
      = revision_row.workflow_revision_content_hash
    AND run.compile_result_id = revision_row.compile_result_id
    AND run.execution_plan_id = revision_row.execution_plan_id
    AND run.execution_plan_content_hash
      = revision_row.execution_plan_content_hash
    AND run.idempotency_key = occurrence_row.occurrence_id
    AND run.status = 'queued'
    AND run.event_sequence = 1
    AND run.inputs = '{}'::jsonb
  INTO accepted_valid
  FROM public.authorization_decisions decision
  JOIN public.product_commands command
    ON command.workspace_id = decision.workspace_id
   AND command.command_id = occurrence_row.product_command_id
  JOIN public.workflow_runs run
    ON run.workspace_id = command.workspace_id
   AND run.product_command_id = command.command_id
   AND run.run_id = occurrence_row.run_id
  WHERE decision.workspace_id = occurrence_row.workspace_id
    AND decision.authorization_decision_id
      = occurrence_row.authorization_decision_id;
  IF accepted_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'automation_occurrence_accepted_lineage_mismatch'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'resourceId', input_pin.resource_id,
      'resourceVersion', input_pin.resource_version,
      'contentHash', input_pin.resource_content_hash
    ) ORDER BY input_pin.input_name), '[]'::jsonb)
  INTO expected_resources
  FROM public.automation_input_pins input_pin
  WHERE input_pin.workspace_id = occurrence_row.workspace_id
    AND input_pin.automation_revision_id
      = occurrence_row.automation_revision_id;
  SELECT run.resource_refs INTO actual_resources
  FROM public.workflow_runs run
  WHERE run.workspace_id = occurrence_row.workspace_id
    AND run.run_id = occurrence_row.run_id;
  IF actual_resources IS DISTINCT FROM expected_resources THEN
    RAISE EXCEPTION 'automation_occurrence_resource_pin_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_automation_workflow_run_occurrence_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  command_row public.product_commands%ROWTYPE;
  matching_occurrence_count integer;
BEGIN
  IF TG_TABLE_NAME = 'product_commands' THEN
    command_row := NEW;
  ELSE
    SELECT * INTO command_row FROM public.product_commands command
    WHERE command.workspace_id = NEW.workspace_id
      AND command.command_id = NEW.product_command_id;
  END IF;
  IF command_row.kind <> 'workflow_run'
    OR command_row.actor_principal_kind <> 'scheduler'
    OR command_row.effective_principal_kind <> 'automation' THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO matching_occurrence_count
  FROM public.automation_occurrences occurrence
  WHERE occurrence.workspace_id = command_row.workspace_id
    AND occurrence.product_command_id = command_row.command_id
    AND occurrence.run_id = command_row.target_id
    AND occurrence.status = 'accepted';
  IF matching_occurrence_count <> 1 THEN
    RAISE EXCEPTION 'automation_workflow_run_occurrence_missing'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.validate_inbox_item_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  recipient_active boolean;
  source_valid boolean;
BEGIN
  SELECT membership.status = 'active' AND principal.status = 'active'
  INTO recipient_active
  FROM public.workspace_memberships membership
  JOIN public.workspace_principals principal
    ON principal.workspace_id = membership.workspace_id
   AND principal.user_id = membership.user_id
   AND principal.membership_id = membership.membership_id
   AND principal.principal_id = membership.user_id
   AND principal.principal_kind = 'user'
  WHERE membership.workspace_id = NEW.workspace_id
    AND membership.user_id = NEW.recipient_user_id
  FOR SHARE OF membership, principal;
  IF recipient_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'inbox_recipient_inactive'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_domain = 'authorization_decision' THEN
    SELECT decision.disposition = 'approval_required'
      AND decision.expires_at > clock_timestamp()
      AND NEW.source_revision = 1
      AND NEW.source_cursor = decision.authorization_decision_id
      AND NEW.target_kind = 'authorization_decision'
      AND NEW.target_id = decision.authorization_decision_id
      AND EXISTS (
        SELECT 1
        FROM public.scope_principal_grants recipient_grant
        WHERE recipient_grant.workspace_id = decision.workspace_id
          AND recipient_grant.scope_id = decision.scope_id
          AND recipient_grant.principal_id = NEW.recipient_user_id
          AND recipient_grant.principal_kind = 'user'
          AND recipient_grant.access_kind = 'operation'
          AND recipient_grant.can_approve
          AND recipient_grant.status = 'active'
      )
    INTO source_valid
    FROM public.authorization_decisions decision
    WHERE decision.workspace_id = NEW.workspace_id
      AND decision.authorization_decision_id = NEW.source_id;
  ELSIF NEW.source_domain = 'workflow_run' THEN
    SELECT run.status IN (
        'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
      )
      AND command.quota_user_id = NEW.recipient_user_id
      AND NEW.source_revision = run.event_sequence
      AND NEW.source_cursor = run.run_id || ':' || run.event_sequence::text
      AND NEW.target_kind = 'workflow_run'
      AND NEW.target_id = run.run_id
    INTO source_valid
    FROM public.workflow_runs run
    JOIN public.product_commands command
      ON command.workspace_id = run.workspace_id
     AND command.command_id = run.product_command_id
    WHERE run.workspace_id = NEW.workspace_id
      AND run.run_id = NEW.source_id;
  ELSIF NEW.source_domain = 'automation_occurrence' THEN
    SELECT occurrence.status IN ('misfired', 'skipped', 'blocked')
      AND root.owner_user_id = NEW.recipient_user_id
      AND NEW.source_revision = occurrence.trigger_revision
      AND NEW.source_cursor = occurrence.occurrence_id
      AND NEW.target_kind = 'automation_occurrence'
      AND NEW.target_id = occurrence.occurrence_id
    INTO source_valid
    FROM public.automation_occurrences occurrence
    JOIN public.automations root
      ON root.workspace_id = occurrence.workspace_id
     AND root.automation_id = occurrence.automation_id
    WHERE occurrence.workspace_id = NEW.workspace_id
      AND occurrence.occurrence_id = NEW.source_id;
  ELSIF NEW.source_domain = 'installation_update_draft' THEN
    SELECT draft.created_by = NEW.recipient_user_id
      AND draft.status IN ('pending_review', 'conflicted')
      AND NEW.source_revision = draft.revision
      AND NEW.source_cursor
        = draft.update_draft_id || ':' || draft.revision::text
      AND NEW.target_kind = 'installation_update_draft'
      AND NEW.target_id = draft.update_draft_id
    INTO source_valid
    FROM public.installation_update_drafts draft
    WHERE draft.workspace_id = NEW.workspace_id
      AND draft.update_draft_id = NEW.source_id;
  ELSE
    RAISE EXCEPTION 'inbox_source_authority_unavailable: %', NEW.source_domain
      USING ERRCODE = '0A000';
  END IF;
  IF source_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'inbox_source_or_recipient_mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.enforce_inbox_item_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'dismissed' THEN
    RAISE EXCEPTION 'inbox_item_terminal' USING ERRCODE = '55000';
  END IF;
  IF ROW(
      NEW.workspace_id, NEW.inbox_item_id, NEW.recipient_user_id,
      NEW.source_domain, NEW.source_id, NEW.source_revision, NEW.source_cursor,
      NEW.reason_code, NEW.severity, NEW.title, NEW.summary,
      NEW.target_kind, NEW.target_id, NEW.action_id,
      NEW.schema_version, NEW.created_at
    ) IS DISTINCT FROM ROW(
      OLD.workspace_id, OLD.inbox_item_id, OLD.recipient_user_id,
      OLD.source_domain, OLD.source_id, OLD.source_revision, OLD.source_cursor,
      OLD.reason_code, OLD.severity, OLD.title, OLD.summary,
      OLD.target_kind, OLD.target_id, OLD.action_id,
      OLD.schema_version, OLD.created_at
    ) THEN
    RAISE EXCEPTION 'inbox_item_projection_identity_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.status = 'unread' AND NEW.status IN ('unread', 'read', 'dismissed'))
    OR (OLD.status = 'read' AND NEW.status IN ('read', 'dismissed'))
  ) OR NEW.updated_at < OLD.updated_at
    OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
    RAISE EXCEPTION 'inbox_item_transition_invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_workflow_run_initial_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  aggregate_run_id public.product_identifier;
  aggregate_workspace_id public.product_identifier;
  aggregate_command_id public.product_identifier;
  aggregate_plan_id public.product_identifier;
  automation_occurrence public.automation_occurrences%ROWTYPE;
  valid boolean;
BEGIN
  IF TG_TABLE_NAME = 'product_commands' THEN
    IF NEW.kind <> 'workflow_run' THEN RETURN NEW; END IF;
    aggregate_run_id := NEW.target_id;
    aggregate_workspace_id := NEW.workspace_id;
    aggregate_command_id := NEW.command_id;
  ELSE
    aggregate_run_id := NEW.run_id;
    aggregate_workspace_id := NEW.workspace_id;
    aggregate_command_id := NEW.product_command_id;
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.workflow_runs run
    JOIN public.product_commands command
      ON command.workspace_id = run.workspace_id
     AND command.command_id = run.product_command_id
     AND command.scope_id = run.scope_id
     AND command.kind = 'workflow_run'
     AND command.target_kind = 'workflow_run'
     AND command.target_id = run.run_id
     AND command.target_revision = 1
    JOIN public.workflow_run_jobs job
      ON job.workspace_id = run.workspace_id AND job.run_id = run.run_id
    JOIN public.workflow_run_events event
      ON event.workspace_id = run.workspace_id AND event.run_id = run.run_id
     AND event.sequence = 1
     AND event.type = 'run.queued' AND event.status = 'queued'
     AND event.product_command_id = run.product_command_id
     AND event.run_fence = 0
    WHERE run.workspace_id = aggregate_workspace_id
      AND run.run_id = aggregate_run_id
      AND run.product_command_id = aggregate_command_id
      AND run.event_sequence >= 1
  ) INTO valid;
  IF valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'workflow_run_initial_aggregate_incomplete'
      USING ERRCODE = '23503';
  END IF;
  SELECT execution_plan_id INTO aggregate_plan_id
  FROM public.workflow_runs
  WHERE workspace_id = aggregate_workspace_id AND run_id = aggregate_run_id;
  PERFORM public.assert_execution_plan_model_pins_consumable(
    aggregate_workspace_id, aggregate_plan_id
  );

  SELECT occurrence.* INTO automation_occurrence
  FROM public.automation_occurrences occurrence
  WHERE occurrence.workspace_id = aggregate_workspace_id
    AND occurrence.run_id = aggregate_run_id
    AND occurrence.product_command_id = aggregate_command_id
    AND occurrence.status = 'accepted';
  IF FOUND THEN
    PERFORM public.assert_automation_revision_consumable(
      automation_occurrence.workspace_id,
      automation_occurrence.automation_id,
      automation_occurrence.automation_revision_id,
      automation_occurrence.observed_policy_grant_revision
    );
  ELSE
    PERFORM public.assert_execution_plan_connection_bindings_consumable(
      aggregate_workspace_id, aggregate_plan_id
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER automations_revision_guard
  BEFORE UPDATE OR DELETE ON public.automations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_automation_root_revision();

CREATE TRIGGER automation_revisions_contract_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.automation_revisions
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_revision_contract();

CREATE TRIGGER automation_input_pins_finalized_guard
  BEFORE INSERT ON public.automation_input_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_finalized_automation_pin_append();

CREATE TRIGGER automation_input_pins_immutable
  BEFORE UPDATE OR DELETE ON public.automation_input_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_automation_pin_mutation();

CREATE TRIGGER automation_connection_pins_validate
  BEFORE INSERT ON public.automation_connection_pins
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_connection_pin();

CREATE TRIGGER automation_connection_pins_finalized_guard
  BEFORE INSERT ON public.automation_connection_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_finalized_automation_pin_append();

CREATE TRIGGER automation_connection_pins_immutable
  BEFORE UPDATE OR DELETE ON public.automation_connection_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_automation_pin_mutation();

CREATE TRIGGER automation_occurrences_lifecycle_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.automation_occurrences
  FOR EACH ROW EXECUTE FUNCTION public.enforce_automation_occurrence_lifecycle();

CREATE TRIGGER inbox_items_source_guard
  BEFORE INSERT ON public.inbox_items
  FOR EACH ROW EXECUTE FUNCTION public.validate_inbox_item_source();

CREATE TRIGGER inbox_items_lifecycle_guard
  BEFORE UPDATE OR DELETE ON public.inbox_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_inbox_item_lifecycle();

CREATE CONSTRAINT TRIGGER automations_current_revision_guard
  AFTER INSERT OR UPDATE ON public.automations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_current_revision();

CREATE CONSTRAINT TRIGGER automation_revisions_current_guard
  AFTER INSERT OR UPDATE ON public.automation_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_current_revision();

CREATE CONSTRAINT TRIGGER automation_revisions_pins_guard
  AFTER INSERT OR UPDATE ON public.automation_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_revision_pins();

CREATE CONSTRAINT TRIGGER automation_input_pins_projection_guard
  AFTER INSERT ON public.automation_input_pins
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_revision_pins();

CREATE CONSTRAINT TRIGGER automation_connection_pins_projection_guard
  AFTER INSERT ON public.automation_connection_pins
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_revision_pins();

CREATE CONSTRAINT TRIGGER automation_occurrences_accepted_guard
  AFTER INSERT OR UPDATE ON public.automation_occurrences
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_occurrence_accepted_aggregate();

CREATE CONSTRAINT TRIGGER product_commands_automation_occurrence_guard
  AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_workflow_run_occurrence_aggregate();

CREATE CONSTRAINT TRIGGER workflow_runs_automation_occurrence_guard
  AFTER INSERT ON public.workflow_runs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_automation_workflow_run_occurrence_aggregate();
