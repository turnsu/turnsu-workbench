-- A governed cancellation is intentionally multi-step: the controller records
-- its command, the Broker stops the invocation, then the leased Run worker
-- closes the aggregate. Allow only that current running node to pass through
-- the intermediate execution states. Terminal Run consistency remains strict.
DO $migration$
DECLARE
  definition text;
  patched text;
  anchor text := '    AND NOT CASE event.type';
  replacement text := $replacement$
    AND NOT (
      event.type IN ('node.started', 'node.progress')
      AND node_attempt.status = 'running'
      AND invocation.status IN ('cancellation_requested', 'cancelled', 'partial', 'effect_outcome_unknown')
      AND execution_attempt.status IN ('running', 'cancelled', 'partial', 'effect_outcome_unknown')
      AND EXISTS (
        SELECT 1 FROM public.workflow_runs cancelling
        JOIN public.workflow_run_events cancellation
          ON cancellation.workspace_id = cancelling.workspace_id
         AND cancellation.run_id = cancelling.run_id
         AND cancellation.type = 'run.cancellation_requested'
        JOIN public.product_commands command
          ON command.workspace_id = cancellation.workspace_id
         AND command.command_id = cancellation.product_command_id
         AND command.kind = 'workflow_run_cancel'
         AND command.target_id = cancelling.run_id
         AND command.scope_id = cancelling.scope_id
        WHERE cancelling.workspace_id = node_attempt.workspace_id
          AND cancelling.run_id = node_attempt.run_id
          AND cancelling.status = 'cancellation_requested'
          AND cancelling.current_node_id = node_attempt.node_id
      )
    )
    AND NOT CASE event.type$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.validate_workflow_run_execution_state_aggregate()'::regprocedure) INTO definition;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'workflow_cancellation_transition_shape_unexpected';
  END IF;
  patched := replace(definition,anchor,replacement);
  EXECUTE patched;
END;
$migration$;
