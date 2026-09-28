-- Product-owned response ledger used by semantic command adapters.  A response
-- is written in the same transaction as its target mutation; a failed target
-- leaves neither a response nor a consumed idempotency key behind.
CREATE TABLE public.product_idempotency_receipts (
  workspace_id public.product_identifier NOT NULL,
  effective_principal_id public.product_identifier NOT NULL,
  operation_scope text COLLATE "C" NOT NULL,
  idempotency_key public.product_identifier NOT NULL,
  request_hash text COLLATE "C" NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (
    workspace_id, effective_principal_id, operation_scope, idempotency_key
  ),
  CONSTRAINT product_idempotency_receipts_principal_fk
    FOREIGN KEY (workspace_id, effective_principal_id)
    REFERENCES public.workspace_memberships (workspace_id, user_id),
  CONSTRAINT product_idempotency_receipts_request_hash
    CHECK (request_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT product_idempotency_receipts_response_shape
    CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
  CONSTRAINT product_idempotency_receipts_completion_shape
    CHECK ((response IS NULL) = (completed_at IS NULL))
);
