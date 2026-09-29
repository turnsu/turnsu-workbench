-- G3B: Review rejection is a canonical Workflow Run cancellation.  It never
-- pretends that a write-local review decision can terminate an executing Run.

CREATE OR REPLACE FUNCTION public.reject_workflow_run_review(
  target_workspace_id public.product_identifier,
  target_review_id public.product_identifier,
  review_cancellation_command_id public.product_identifier
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
  cancellation_requested_event_id public.product_identifier;
  cancellation_event_id public.product_identifier;
  database_now timestamptz;
  changed_count integer;
BEGIN
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

  cancellation_requested_event_id := md5(
    review_cancellation_command_id::text || ':run.cancellation_requested:review-rejected'
  )::public.product_identifier;
  cancellation_event_id := md5(
    review_cancellation_command_id::text || ':run.cancelled:review-rejected'
  )::public.product_identifier;

  IF review_row.status = 'cancelled'
    AND review_row.cancellation_command_id = review_cancellation_command_id THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.workflow_run_events event
      WHERE event.workspace_id = target_workspace_id
        AND event.run_id = target_run_id
        AND event.event_id = cancellation_requested_event_id
        AND event.type = 'run.cancellation_requested'
        AND event.status = 'cancellation_requested'
        AND event.product_command_id = review_cancellation_command_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM public.workflow_run_events event
      WHERE event.workspace_id = target_workspace_id
        AND event.run_id = target_run_id
        AND event.event_id = cancellation_event_id
        AND event.type = 'run.cancelled'
        AND event.status = 'cancelled'
        AND event.review_id = target_review_id
        AND event.product_command_id = review_cancellation_command_id
    ) OR EXISTS (
      SELECT 1
      FROM public.workflow_run_node_attempts node_attempt
      JOIN public.execution_invocations invocation
        ON invocation.invocation_id = node_attempt.invocation_id
      JOIN public.execution_attempts execution_attempt
        ON execution_attempt.invocation_id = invocation.invocation_id
      LEFT JOIN public.capability_leases capability
        ON capability.invocation_id = invocation.invocation_id
       AND capability.attempt_id = execution_attempt.attempt_id
      LEFT JOIN public.capacity_leases capacity
        ON capacity.capacity_lease_id = invocation.capacity_lease_id
      WHERE node_attempt.workspace_id = target_workspace_id
        AND node_attempt.node_attempt_id = review_row.node_attempt_id
        AND (
          node_attempt.status <> 'cancelled'
          OR invocation.status <> 'cancelled'
          OR execution_attempt.status IN ('queued', 'running')
          OR capability.status IS DISTINCT FROM 'revoked'
          OR capacity.status IS DISTINCT FROM 'released'
        )
    ) THEN
      RAISE EXCEPTION 'workflow_run_review_rejection_replay_inconsistent'
        USING ERRCODE = '23514';
    END IF;
    RETURN review_row;
  END IF;

  IF run_row.status <> 'waiting_review'
    OR job_row.state <> 'waiting_review'
    OR review_row.status <> 'pending' THEN
    RAISE EXCEPTION 'workflow_run_review_not_waiting' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO node_attempt_row
  FROM public.workflow_run_node_attempts node_attempt
  WHERE node_attempt.workspace_id = target_workspace_id
    AND node_attempt.node_attempt_id = review_row.node_attempt_id
  FOR UPDATE;
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
  IF EXISTS (
    SELECT 1 FROM public.execution_attempts execution_attempt
    WHERE execution_attempt.invocation_id = node_attempt_row.invocation_id
      AND execution_attempt.status = 'effect_outcome_unknown'
  ) THEN
    RAISE EXCEPTION 'workflow_run_review_effect_outcome_unresolved'
      USING ERRCODE = '23514';
  END IF;

  database_now := clock_timestamp();
  UPDATE public.workflow_run_reviews
  SET status = 'cancelled', cancellation_command_id = review_cancellation_command_id,
      cancelled_at = database_now, updated_at = database_now
  WHERE workspace_id = target_workspace_id
    AND review_id = target_review_id
    AND status = 'pending'
  RETURNING * INTO review_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_run_review_already_decided' USING ERRCODE = '55000';
  END IF;

  UPDATE public.workflow_run_node_attempts
  SET status = 'cancelled', finished_at = database_now, updated_at = database_now,
      payload = payload || jsonb_build_object(
        'summary', 'Review rejected.',
        'invocationStatus', 'cancelled'
      )
  WHERE workspace_id = target_workspace_id
    AND node_attempt_id = review_row.node_attempt_id
    AND status = 'waiting_review';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'workflow_run_review_attempt_not_waiting'
      USING ERRCODE = '23514';
  END IF;
  UPDATE public.execution_attempts
  SET status = 'cancelled', finished_at = database_now, updated_at = database_now
  WHERE invocation_id = node_attempt_row.invocation_id
    AND status IN ('queued', 'running');
  UPDATE public.execution_invocations
  SET status = 'cancelled', finished_at = database_now, updated_at = database_now
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
  WHERE capacity.capacity_lease_id = invocation_row.capacity_lease_id
    AND capacity.status <> 'released';

  INSERT INTO public.workflow_run_events (
    workspace_id, event_id, run_id, schema_version, sequence, type, status,
    node_id, summary, writer_kind, product_command_id, run_fence, occurred_at
  ) VALUES (
    target_workspace_id, cancellation_requested_event_id, target_run_id,
    'workbench-run-event-v1', run_row.event_sequence + 1,
    'run.cancellation_requested', 'cancellation_requested', review_row.node_id,
    'Workflow Run cancellation requested from review rejection.', 'controller',
    review_cancellation_command_id, job_row.fence, database_now
  );
  INSERT INTO public.workflow_run_events (
    workspace_id, event_id, run_id, schema_version, sequence, type, status,
    node_id, review_id, summary, writer_kind, product_command_id,
    run_fence, occurred_at
  ) VALUES (
    target_workspace_id, cancellation_event_id, target_run_id,
    'workbench-run-event-v1', run_row.event_sequence + 2,
    'run.cancelled', 'cancelled', review_row.node_id, target_review_id,
    'Workflow Run cancelled after review rejection.', 'controller',
    review_cancellation_command_id, job_row.fence, database_now
  );
  RETURN review_row;
END;
$function$;
