-- G3B: ProductPostgresStore needs a targeted B3 worker claim. The existing
-- FIFO function intentionally claims any eligible run; WorkflowRunner already
-- owns a concrete runId, so using it would be able to lease an unrelated run.
-- This is the same fenced, event-backed transition restricted to that root.

CREATE FUNCTION public.claim_workflow_run_job_for_run(
  target_workspace_id public.product_identifier,
  target_run_id public.product_identifier,
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
  run_row public.workflow_runs%ROWTYPE;
  next_sequence bigint;
  database_now timestamptz;
BEGIN
  IF lease_duration <= interval '0 seconds' OR lease_duration > interval '1 hour' THEN
    RAISE EXCEPTION 'workflow_run_lease_duration_invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO run_row
  FROM public.workflow_runs run
  WHERE run.workspace_id = target_workspace_id AND run.run_id = target_run_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO candidate
  FROM public.workflow_run_jobs job
  WHERE job.workspace_id = target_workspace_id AND job.run_id = target_run_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  database_now := clock_timestamp();
  IF NOT (
    (candidate.state = 'queued' AND candidate.available_at <= database_now
      AND run_row.status IN ('queued', 'running', 'waiting_review'))
    OR (candidate.state = 'leased' AND candidate.lease_expires_at <= database_now
      AND run_row.status IN ('running', 'cancellation_requested'))
  ) THEN RETURN; END IF;

  PERFORM public.assert_execution_plan_model_pins_consumable(
    target_workspace_id, run_row.execution_plan_id
  );
  PERFORM public.assert_execution_plan_connection_bindings_consumable(
    target_workspace_id, run_row.execution_plan_id
  );

  UPDATE public.workflow_run_jobs
  SET state = 'leased', lease_owner = worker_id,
      lease_token = worker_lease_token,
      lease_expires_at = database_now + lease_duration,
      lease_event_id = claim_event_id,
      fence = candidate.fence + 1, updated_at = database_now
  WHERE workspace_id = target_workspace_id AND run_id = target_run_id
  RETURNING * INTO claimed;

  next_sequence := run_row.event_sequence + 1;
  INSERT INTO public.workflow_run_events (
    workspace_id, event_id, run_id, schema_version, sequence, type, status,
    summary, writer_kind, run_fence, lease_owner, lease_token,
    lease_expires_at, previous_run_fence, previous_lease_owner,
    previous_lease_token, previous_lease_expires_at, occurred_at
  ) VALUES (
    target_workspace_id, claim_event_id, target_run_id,
    'workbench-run-event-v1', next_sequence,
    CASE WHEN candidate.state = 'leased'
      THEN 'run.worker_recovered' ELSE 'run.started' END,
    CASE WHEN run_row.status = 'cancellation_requested'
      THEN 'cancellation_requested' ELSE 'running' END,
    'Run worker claimed.', 'worker', claimed.fence,
    claimed.lease_owner, claimed.lease_token,
    claimed.lease_expires_at, candidate.fence, candidate.lease_owner,
    candidate.lease_token, candidate.lease_expires_at, database_now
  );
  RETURN NEXT claimed;
END;
$function$;
