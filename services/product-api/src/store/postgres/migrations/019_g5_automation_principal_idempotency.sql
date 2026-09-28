-- Product idempotency is partitioned by the effective Product Principal.
-- The original G3A adapter ledger predated non-user command execution and
-- incorrectly constrained this column to workspace memberships. Automation
-- and future connector commands already have canonical workspace principals,
-- so the ledger must follow that same authority boundary.
ALTER TABLE public.product_idempotency_receipts
  DROP CONSTRAINT product_idempotency_receipts_principal_fk;

ALTER TABLE public.product_idempotency_receipts
  ADD CONSTRAINT product_idempotency_receipts_principal_fk
  FOREIGN KEY (workspace_id, effective_principal_id)
  REFERENCES public.workspace_principals (workspace_id, principal_id);
