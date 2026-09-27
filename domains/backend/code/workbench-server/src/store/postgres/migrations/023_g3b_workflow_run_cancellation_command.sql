-- G3B: a public Run cancellation is a dedicated Product Command.  It never
-- patches the Run projection directly and never borrows the retired generic
-- Store cancellation path.  Queued Runs have no live execution lineage, so
-- their request and terminal event can be committed atomically.  A running
-- Run only receives the durable cancellation intent here; its fenced Worker
-- owns closing the Invocation, capability lease, capacity lease, node attempt
-- and terminal event.

CREATE OR REPLACE FUNCTION public.request_workflow_run_cancellation(
  target_workspace_id public.product_identifier,
  target_run_id public.product_identifier,
  cancellation_command_id public.product_identifier
)
RETURNS public.workflow_runs
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_row public.workflow_runs%ROWTYPE;
  job_row public.workflow_run_jobs%ROWTYPE;
  cancellation_requested_event_id public.product_identifier;
  cancellation_event_id public.product_identifier;
  database_now timestamptz;
BEGIN
  SELECT * INTO run_row
  FROM public.workflow_runs run
  WHERE run.workspace_id = target_workspace_id
    AND run.run_id = target_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_run_cancellation_not_found' USING ERRCODE = '23503';
  END IF;

  SELECT * INTO job_row
  FROM public.workflow_run_jobs job
  WHERE job.workspace_id = target_workspace_id
    AND job.run_id = target_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_run_cancellation_job_missing' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.product_commands command
    WHERE command.workspace_id = target_workspace_id
      AND command.command_id = cancellation_command_id
      AND command.scope_id = run_row.scope_id
      AND command.kind = 'workflow_run_cancel'
      AND command.target_kind = 'workflow_run_cancellation'
      AND command.target_id = target_run_id
      AND command.target_revision = 1
      AND command.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'workflow_run_cancellation_command_invalid'
      USING ERRCODE = '23514';
  END IF;

  cancellation_requested_event_id := md5(
    cancellation_command_id::text || ':run.cancellation_requested'
  )::public.product_identifier;
  cancellation_event_id := md5(
    cancellation_command_id::text || ':run.cancelled'
  )::public.product_identifier;

  IF run_row.status = 'cancellation_requested' THEN
    IF EXISTS (
      SELECT 1
      FROM public.workflow_run_events event
      WHERE event.workspace_id = target_workspace_id
        AND event.run_id = target_run_id
        AND event.event_id = cancellation_requested_event_id
        AND event.type = 'run.cancellation_requested'
        AND event.status = 'cancellation_requested'
        AND event.product_command_id = cancellation_command_id
    ) THEN
      RETURN run_row;
    END IF;
    RAISE EXCEPTION 'workflow_run_cancellation_in_progress'
      USING ERRCODE = '55000';
  END IF;

  IF run_row.status IN (
    'completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
  ) THEN
    RAISE EXCEPTION 'workflow_run_cancellation_terminal'
      USING ERRCODE = '55000';
  END IF;

  -- A held Review owns its own reject transition.  A generic stop must not
  -- bypass the review aggregate or leave a pending Inbox item behind.
  IF run_row.status = 'waiting_review' OR EXISTS (
    SELECT 1
    FROM public.workflow_run_reviews review
    WHERE review.workspace_id = target_workspace_id
      AND review.run_id = target_run_id
      AND review.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'workflow_run_review_decision_required'
      USING ERRCODE = '23514';
  END IF;

  IF run_row.status NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'workflow_run_cancellation_state_invalid'
      USING ERRCODE = '23514';
  END IF;

  IF run_row.status = 'queued' AND (
    job_row.state <> 'queued'
    OR job_row.lease_owner IS NOT NULL
    OR job_row.lease_token IS NOT NULL
    OR job_row.lease_expires_at IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM public.workflow_run_node_attempts node_attempt
      WHERE node_attempt.workspace_id = target_workspace_id
        AND node_attempt.run_id = target_run_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.execution_invocations invocation
      WHERE invocation.workspace_id = target_workspace_id
        AND invocation.controller_kind = 'workflow_run'
        AND invocation.controller_id = target_run_id
    )
  ) THEN
    RAISE EXCEPTION 'workflow_run_cancellation_queue_state_invalid'
      USING ERRCODE = '55000';
  END IF;

  IF run_row.status = 'running' AND job_row.state <> 'leased' THEN
    RAISE EXCEPTION 'workflow_run_cancellation_lease_state_invalid'
      USING ERRCODE = '55000';
  END IF;

  database_now := clock_timestamp();
  INSERT INTO public.workflow_run_events (
    workspace_id, event_id, run_id, schema_version, sequence, type, status,
    summary, writer_kind, product_command_id, run_fence, occurred_at, payload
  ) VALUES (
    target_workspace_id, cancellation_requested_event_id, target_run_id,
    'workbench-run-event-v1', run_row.event_sequence + 1,
    'run.cancellation_requested', 'cancellation_requested',
    'Workflow Run cancellation requested.', 'controller',
    cancellation_command_id, job_row.fence, database_now,
    jsonb_build_object('source', 'workflow_run_cancellation_command')
  );

  IF run_row.status = 'queued' THEN
    INSERT INTO public.workflow_run_events (
      workspace_id, event_id, run_id, schema_version, sequence, type, status,
      summary, writer_kind, product_command_id, run_fence, occurred_at, payload
    ) VALUES (
      target_workspace_id, cancellation_event_id, target_run_id,
      'workbench-run-event-v1', run_row.event_sequence + 2,
      'run.cancelled', 'cancelled',
      'Workflow Run cancelled before execution started.', 'controller',
      cancellation_command_id, job_row.fence, database_now,
      jsonb_build_object('source', 'workflow_run_cancellation_command')
    );
  END IF;

  SELECT * INTO run_row
  FROM public.workflow_runs run
  WHERE run.workspace_id = target_workspace_id
    AND run.run_id = target_run_id;
  RETURN run_row;
END;
$function$;
