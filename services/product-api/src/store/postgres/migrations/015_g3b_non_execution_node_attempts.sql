-- B3 Workflow graphs persist pure Input/Output nodes as Run-owned attempts.
-- Those nodes do not cross the Execution Broker, while Skill and ReviewGate
-- attempts retain their mandatory Execution authority lineage.

ALTER TABLE public.workflow_run_node_attempts
  ALTER COLUMN invocation_id DROP NOT NULL,
  ALTER COLUMN execution_attempt_id DROP NOT NULL;

ALTER TABLE public.workflow_run_node_attempts
  ADD CONSTRAINT workflow_run_node_attempts_execution_identity_shape
  CHECK ((invocation_id IS NULL) = (execution_attempt_id IS NULL));
