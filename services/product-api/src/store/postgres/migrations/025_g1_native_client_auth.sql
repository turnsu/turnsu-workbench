-- G1 native Product clients use a browser-confirmed, PKCE-bound authorization
-- exchange.  Only hashes of one-time codes and refresh tokens are durable.
-- Desktop/Mobile access is a client session, not a browser-session fallback.

CREATE TABLE public.native_authorizations (
  authorization_id public.product_identifier PRIMARY KEY,
  client_kind text COLLATE "C" NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text COLLATE "C" NOT NULL,
  device_public_key text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL DEFAULT 'pending',
  user_id public.product_identifier REFERENCES public.product_users (user_id),
  workspace_id public.product_identifier REFERENCES public.product_workspaces (workspace_id),
  authorization_code_hash text COLLATE "C",
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT native_authorizations_client_kind CHECK (client_kind IN ('desktop', 'mobile')),
  CONSTRAINT native_authorizations_status CHECK (status IN ('pending', 'approved', 'consumed', 'expired', 'revoked')),
  CONSTRAINT native_authorizations_redirect_uri CHECK (
    length(redirect_uri) BETWEEN 1 AND 2048
    AND position(E'\n' IN redirect_uri) = 0
    AND position(E'\r' IN redirect_uri) = 0
  ),
  CONSTRAINT native_authorizations_pkce CHECK (
    length(code_challenge) BETWEEN 43 AND 128
    AND code_challenge ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT native_authorizations_device_key CHECK (
    length(device_public_key) BETWEEN 43 AND 256
    AND device_public_key ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT native_authorizations_code_hash CHECK (
    authorization_code_hash IS NULL OR authorization_code_hash ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT native_authorizations_time_order CHECK (expires_at > created_at),
  CONSTRAINT native_authorizations_state_shape CHECK (
    (status = 'pending'
      AND user_id IS NULL AND workspace_id IS NULL AND authorization_code_hash IS NULL
      AND approved_at IS NULL AND consumed_at IS NULL)
    OR (status = 'approved'
      AND user_id IS NOT NULL AND workspace_id IS NOT NULL AND authorization_code_hash IS NOT NULL
      AND approved_at IS NOT NULL AND consumed_at IS NULL)
    OR (status = 'consumed'
      AND user_id IS NOT NULL AND workspace_id IS NOT NULL AND authorization_code_hash IS NOT NULL
      AND approved_at IS NOT NULL AND consumed_at IS NOT NULL)
    OR (status IN ('expired', 'revoked') AND consumed_at IS NULL)
  ),
  CONSTRAINT native_authorizations_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX native_authorizations_pending_expiry_idx
  ON public.native_authorizations (expires_at, authorization_id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX native_authorizations_code_hash_uq
  ON public.native_authorizations (authorization_code_hash)
  WHERE authorization_code_hash IS NOT NULL;

CREATE TABLE public.native_client_sessions (
  client_session_id public.product_identifier PRIMARY KEY,
  user_id public.product_identifier NOT NULL REFERENCES public.product_users (user_id),
  workspace_id public.product_identifier NOT NULL,
  client_kind text COLLATE "C" NOT NULL,
  device_public_key text COLLATE "C" NOT NULL,
  refresh_family_id public.product_identifier NOT NULL,
  status text COLLATE "C" NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_rotated_at timestamptz NOT NULL,
  revoked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT native_client_sessions_membership_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT native_client_sessions_client_kind CHECK (client_kind IN ('desktop', 'mobile')),
  CONSTRAINT native_client_sessions_device_key CHECK (
    length(device_public_key) BETWEEN 43 AND 256
    AND device_public_key ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT native_client_sessions_status CHECK (status IN ('active', 'revoked', 'expired')),
  CONSTRAINT native_client_sessions_time_order CHECK (expires_at > created_at AND last_rotated_at >= created_at),
  CONSTRAINT native_client_sessions_state_shape CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status IN ('revoked', 'expired') AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT native_client_sessions_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX native_client_sessions_user_workspace_idx
  ON public.native_client_sessions (user_id, workspace_id, status, expires_at);

CREATE TABLE public.native_refresh_tokens (
  refresh_token_id public.product_identifier PRIMARY KEY,
  client_session_id public.product_identifier NOT NULL
    REFERENCES public.native_client_sessions (client_session_id),
  token_hash text COLLATE "C" NOT NULL,
  replaced_by_refresh_token_id public.product_identifier,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT native_refresh_tokens_hash_uq UNIQUE (token_hash),
  CONSTRAINT native_refresh_tokens_hash CHECK (token_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT native_refresh_tokens_replacement_fk
    FOREIGN KEY (replaced_by_refresh_token_id)
    REFERENCES public.native_refresh_tokens (refresh_token_id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT native_refresh_tokens_time_order CHECK (expires_at > issued_at),
  CONSTRAINT native_refresh_tokens_consumption_shape CHECK (
    (consumed_at IS NULL AND replaced_by_refresh_token_id IS NULL)
    OR (consumed_at IS NOT NULL AND replaced_by_refresh_token_id IS NOT NULL)
  ),
  CONSTRAINT native_refresh_tokens_revoke_order CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CONSTRAINT native_refresh_tokens_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX native_refresh_tokens_session_idx
  ON public.native_refresh_tokens (client_session_id, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE public.native_access_tokens (
  access_token_id public.product_identifier PRIMARY KEY,
  client_session_id public.product_identifier NOT NULL
    REFERENCES public.native_client_sessions (client_session_id),
  token_hash text COLLATE "C" NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT native_access_tokens_hash_uq UNIQUE (token_hash),
  CONSTRAINT native_access_tokens_hash CHECK (token_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT native_access_tokens_time_order CHECK (expires_at > issued_at),
  CONSTRAINT native_access_tokens_revoke_order CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  CONSTRAINT native_access_tokens_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX native_access_tokens_active_idx
  ON public.native_access_tokens (expires_at, access_token_id)
  WHERE revoked_at IS NULL;
