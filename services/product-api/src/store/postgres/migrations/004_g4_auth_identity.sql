-- G4 composition: the public-authentication mutation ledger is deliberately
-- separate from CommandIntake's authenticated-command ledger. Registration
-- happens before a caller has a workspace principal, but still needs exact
-- replay/conflict semantics without persisting a password or bootstrap token.
CREATE TABLE public.auth_idempotency_receipts (
  operation_scope text COLLATE "C" NOT NULL,
  idempotency_key public.product_identifier NOT NULL,
  request_hash text COLLATE "C" NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (operation_scope, idempotency_key),
  CONSTRAINT auth_idempotency_receipts_scope_format
    CHECK (operation_scope ~ '^[a-z][a-z0-9:_-]{0,255}$'),
  CONSTRAINT auth_idempotency_receipts_request_hash
    CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT auth_idempotency_receipts_response_shape
    CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
  CONSTRAINT auth_idempotency_receipts_completion_shape
    CHECK ((response IS NULL) = (completed_at IS NULL))
);
