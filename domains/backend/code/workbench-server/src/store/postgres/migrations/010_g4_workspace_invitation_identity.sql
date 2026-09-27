-- Team entry is a Product-owned aggregate. Invitation secrets are never stored
-- verbatim: the database contains only a SHA-256 token hash, while an injected
-- signing key recreates the one-time URL only when the outbox is delivered.

CREATE TABLE public.workspace_invitations (
  invitation_id public.product_identifier PRIMARY KEY,
  workspace_id public.product_identifier NOT NULL,
  invited_email_normalized text COLLATE "C" NOT NULL,
  membership_role text COLLATE "C" NOT NULL DEFAULT 'member',
  status text COLLATE "C" NOT NULL DEFAULT 'pending',
  token_hash text COLLATE "C" NOT NULL,
  created_by_user_id public.product_identifier NOT NULL,
  authorizer_membership_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_by_user_id public.product_identifier,
  accepted_at timestamptz,
  revoked_by_user_id public.product_identifier,
  revoked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT workspace_invitations_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.product_workspaces (workspace_id),
  CONSTRAINT workspace_invitations_authorizer_fk
    FOREIGN KEY (workspace_id, created_by_user_id, authorizer_membership_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id, membership_id),
  CONSTRAINT workspace_invitations_accepted_user_fk
    FOREIGN KEY (accepted_by_user_id) REFERENCES public.product_users (user_id),
  CONSTRAINT workspace_invitations_revoked_user_fk
    FOREIGN KEY (revoked_by_user_id) REFERENCES public.product_users (user_id),
  CONSTRAINT workspace_invitations_email_normalized CHECK (
    invited_email_normalized = lower(invited_email_normalized)
    AND length(invited_email_normalized) BETWEEN 3 AND 320
  ),
  CONSTRAINT workspace_invitations_role CHECK (membership_role = 'member'),
  CONSTRAINT workspace_invitations_status CHECK (
    status IN ('pending', 'accepted', 'revoked', 'expired')
  ),
  CONSTRAINT workspace_invitations_token_hash CHECK (
    token_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT workspace_invitations_time_order CHECK (
    updated_at >= created_at AND expires_at > created_at
  ),
  CONSTRAINT workspace_invitations_status_shape CHECK (
    (status = 'pending'
      AND accepted_by_user_id IS NULL AND accepted_at IS NULL
      AND revoked_by_user_id IS NULL AND revoked_at IS NULL)
    OR (status = 'accepted'
      AND accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL
      AND revoked_by_user_id IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked'
      AND accepted_by_user_id IS NULL AND accepted_at IS NULL
      AND revoked_by_user_id IS NOT NULL AND revoked_at IS NOT NULL)
    OR (status = 'expired'
      AND accepted_by_user_id IS NULL AND accepted_at IS NULL
      AND revoked_by_user_id IS NULL AND revoked_at IS NULL)
  ),
  CONSTRAINT workspace_invitations_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX workspace_invitations_one_pending_email_uq
  ON public.workspace_invitations (workspace_id, invited_email_normalized)
  WHERE status = 'pending';
CREATE INDEX workspace_invitations_workspace_created_idx
  ON public.workspace_invitations (workspace_id, created_at DESC, invitation_id DESC);

CREATE TABLE public.email_outbox (
  outbox_id public.product_identifier PRIMARY KEY,
  invitation_id public.product_identifier NOT NULL
    REFERENCES public.workspace_invitations (invitation_id),
  recipient_email_normalized text COLLATE "C" NOT NULL,
  delivery_kind text COLLATE "C" NOT NULL DEFAULT 'workspace_invitation',
  status text COLLATE "C" NOT NULL DEFAULT 'queued',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  last_error_code text COLLATE "C",
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT email_outbox_recipient_normalized CHECK (
    recipient_email_normalized = lower(recipient_email_normalized)
    AND length(recipient_email_normalized) BETWEEN 3 AND 320
  ),
  CONSTRAINT email_outbox_kind CHECK (delivery_kind = 'workspace_invitation'),
  CONSTRAINT email_outbox_status CHECK (status IN ('queued', 'leased', 'delivered', 'failed')),
  CONSTRAINT email_outbox_attempt_count CHECK (attempt_count >= 0),
  CONSTRAINT email_outbox_error_code CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT email_outbox_time_order CHECK (
    updated_at >= created_at AND available_at >= created_at
  ),
  CONSTRAINT email_outbox_status_shape CHECK (
    (status = 'queued' AND lease_expires_at IS NULL AND delivered_at IS NULL)
    OR (status = 'leased' AND lease_expires_at IS NOT NULL AND delivered_at IS NULL)
    OR (status = 'delivered' AND lease_expires_at IS NULL AND delivered_at IS NOT NULL)
    OR (status = 'failed' AND lease_expires_at IS NULL AND delivered_at IS NULL)
  ),
  CONSTRAINT email_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX email_outbox_delivery_idx
  ON public.email_outbox (status, available_at, outbox_id);
CREATE INDEX email_outbox_lease_idx
  ON public.email_outbox (lease_expires_at)
  WHERE status = 'leased';

CREATE TABLE public.email_delivery_receipts (
  delivery_receipt_id public.product_identifier PRIMARY KEY,
  outbox_id public.product_identifier NOT NULL REFERENCES public.email_outbox (outbox_id),
  attempt_number integer NOT NULL,
  status text COLLATE "C" NOT NULL,
  provider_receipt_id text COLLATE "C",
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT email_delivery_receipts_attempt_number CHECK (attempt_number >= 1),
  CONSTRAINT email_delivery_receipts_status CHECK (status IN ('delivered', 'failed')),
  CONSTRAINT email_delivery_receipts_provider_receipt_id CHECK (
    provider_receipt_id IS NULL OR (
      length(provider_receipt_id) BETWEEN 1 AND 256
      AND position(E'\\n' IN provider_receipt_id) = 0
      AND position(E'\\r' IN provider_receipt_id) = 0
    )
  ),
  CONSTRAINT email_delivery_receipts_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT email_delivery_receipts_outbox_attempt_uq UNIQUE (outbox_id, attempt_number)
);

CREATE TABLE public.external_identities (
  provider text COLLATE "C" NOT NULL,
  provider_subject text COLLATE "C" NOT NULL,
  user_id public.product_identifier NOT NULL REFERENCES public.product_users (user_id),
  verified_email_normalized text COLLATE "C" NOT NULL,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (provider, provider_subject),
  CONSTRAINT external_identities_provider CHECK (provider IN ('google', 'github')),
  CONSTRAINT external_identities_subject CHECK (length(provider_subject) BETWEEN 1 AND 256),
  CONSTRAINT external_identities_verified_email CHECK (
    verified_email_normalized = lower(verified_email_normalized)
    AND length(verified_email_normalized) BETWEEN 3 AND 320
  ),
  CONSTRAINT external_identities_time_order CHECK (updated_at >= created_at),
  CONSTRAINT external_identities_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT external_identities_one_provider_per_user_uq UNIQUE (user_id, provider)
);

CREATE INDEX external_identities_verified_email_idx
  ON public.external_identities (verified_email_normalized);

CREATE TABLE public.oauth_login_transactions (
  oauth_transaction_id public.product_identifier PRIMARY KEY,
  invitation_id public.product_identifier NOT NULL
    REFERENCES public.workspace_invitations (invitation_id),
  provider text COLLATE "C" NOT NULL,
  state_hash text COLLATE "C" NOT NULL,
  initiated_by_user_id public.product_identifier REFERENCES public.product_users (user_id),
  bind_existing_account boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  completed_user_id public.product_identifier REFERENCES public.product_users (user_id),
  response jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT oauth_login_transactions_provider CHECK (provider IN ('google', 'github')),
  CONSTRAINT oauth_login_transactions_state_hash CHECK (state_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT oauth_login_transactions_time_order CHECK (expires_at > created_at),
  CONSTRAINT oauth_login_transactions_completion_shape CHECK (
    (completed_at IS NULL AND completed_user_id IS NULL AND response IS NULL)
    OR (completed_at IS NOT NULL AND completed_user_id IS NOT NULL AND response IS NOT NULL)
  ),
  CONSTRAINT oauth_login_transactions_response_object CHECK (
    response IS NULL OR jsonb_typeof(response) = 'object'
  ),
  CONSTRAINT oauth_login_transactions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE UNIQUE INDEX oauth_login_transactions_state_hash_uq
  ON public.oauth_login_transactions (state_hash);
CREATE INDEX oauth_login_transactions_invitation_idx
  ON public.oauth_login_transactions (invitation_id, created_at DESC);

-- The initial Scope grant belongs to the same activation aggregate. Baseline
-- validation intentionally admits only one-time workspace/system seeds; add
-- membership activation as the third no-command creation mode, while keeping
-- all existing active-principal and grant-shape checks intact.
CREATE OR REPLACE FUNCTION public.validate_scope_principal_grant_insert()
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
        (s.creation_mode IN (
          'workspace_initial_seed', 'system_initial_seed', 'membership_activation'
        ) AND NEW.issuance_command_id IS NULL)
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

-- Membership activation is deliberately not a generic scope-create path. The
-- Scope, Membership, Principal and accepted Invitation must agree on both the
-- member actor and the Owner authorizer before the deferred aggregate commits.
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
  activation jsonb;
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
    activation := scope_row.payload -> 'membership_activation';
    IF jsonb_typeof(activation) IS DISTINCT FROM 'object'
      OR activation ->> 'invitation_id' IS NULL
      OR activation ->> 'membership_id' IS NULL
      OR activation ->> 'actor_user_id' IS NULL
      OR activation ->> 'authorizer_user_id' IS NULL THEN
      RAISE EXCEPTION 'membership_activation_lineage_required'
        USING ERRCODE = '23514';
    END IF;
    SELECT scope_row.scope_kind = 'personal'
      AND scope_row.owner_user_id = scope_row.created_by_principal_id
      AND scope_row.created_by_principal_kind = 'user'
      AND membership.status = 'active'
      AND membership.membership_id = activation ->> 'membership_id'
      AND membership.payload -> 'membership_activation' = activation
      AND principal.status = 'active'
      AND principal.membership_id = membership.membership_id
      AND principal.payload -> 'membership_activation' = activation
      AND invitation.status = 'accepted'
      AND invitation.accepted_by_user_id = scope_row.owner_user_id
      AND invitation.created_by_user_id = activation ->> 'authorizer_user_id'
      AND activation ->> 'actor_user_id' = scope_row.owner_user_id
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
    JOIN public.workspace_invitations invitation
      ON invitation.workspace_id = membership.workspace_id
     AND invitation.invitation_id = activation ->> 'invitation_id'
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
