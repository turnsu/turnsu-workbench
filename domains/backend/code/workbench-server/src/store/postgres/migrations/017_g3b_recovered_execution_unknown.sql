-- A worker takeover after an Execution authority was persisted cannot safely
-- infer that the backend side effect did or did not happen. Close the expired
-- authority without dispatching a second Invocation, fence late results, and
-- retain the original node-attempt identity for audit.

CREATE FUNCTION public.seal_workflow_run_recovered_execution_unknown(
  target_workspace_id public.product_identifier,
  target_run_id public.product_identifier,
  worker_id public.product_identifier,
  worker_lease_token public.product_identifier
)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  run_row public.workflow_runs%ROWTYPE;
  job_row public.workflow_run_jobs%ROWTYPE;
  invocation_row record;
  sealed_invocation record;
  database_now timestamptz;
  closed_invocation_count integer := 0;
  settled_execution_status text;
  unknown_result jsonb;
  settled_result jsonb;
BEGIN
  SELECT * INTO run_row
  FROM public.workflow_runs run
  WHERE run.workspace_id = target_workspace_id
    AND run.run_id = target_run_id
  FOR UPDATE;
  IF NOT FOUND OR run_row.status NOT IN ('running', 'cancellation_requested') THEN
    RAISE EXCEPTION 'workflow_run_recovery_target_invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO job_row
  FROM public.workflow_run_jobs job
  WHERE job.workspace_id = target_workspace_id
    AND job.run_id = target_run_id
  FOR UPDATE;
  database_now := clock_timestamp();
  IF NOT FOUND OR job_row.state <> 'leased'
    OR job_row.lease_owner <> worker_id
    OR job_row.lease_token <> worker_lease_token
    OR job_row.lease_expires_at <= database_now
    OR NOT EXISTS (
      SELECT 1 FROM public.workflow_run_events recovery
      WHERE recovery.workspace_id = target_workspace_id
        AND recovery.run_id = target_run_id
        AND recovery.type = 'run.worker_recovered'
        AND recovery.run_fence = job_row.fence
        AND recovery.lease_owner = job_row.lease_owner
        AND recovery.lease_token = job_row.lease_token
    ) THEN
    RAISE EXCEPTION 'workflow_run_recovery_authority_invalid'
      USING ERRCODE = '55000';
  END IF;

  unknown_result := jsonb_build_object(
    'status', 'effect_outcome_unknown',
    'summary', 'Execution ownership expired before a durable result was observed.',
    'failure', jsonb_build_object(
      'code', 'side_effect_outcome_unknown',
      'message', 'The previous Skill invocation may have produced an effect, so it was not repeated.',
      'retryable', false
    ),
    'finishedAt', database_now
  );

  FOR invocation_row IN
    SELECT invocation.invocation_id, invocation.attempt_id,
           invocation.capacity_lease_id, invocation.event_sequence
    FROM public.execution_invocations invocation
    WHERE invocation.workspace_id = target_workspace_id
      AND invocation.controller_kind = 'workflow_run'
      AND invocation.controller_id = target_run_id
      AND invocation.controller_fence < job_row.fence
      AND invocation.status IN ('queued', 'running', 'cancellation_requested')
    ORDER BY invocation.created_at, invocation.invocation_id
    FOR UPDATE
  LOOP
    UPDATE public.external_effect_receipts receipt
    SET status = CASE
          WHEN receipt.status = 'dispatching' THEN 'outcome_unknown'
          ELSE 'cancelled'
        END,
        updated_at = database_now,
        payload = receipt.payload || jsonb_build_object(
          'recoveredByRunFence', job_row.fence
        )
    WHERE receipt.invocation_id = invocation_row.invocation_id
      AND receipt.status IN ('pending', 'intent_recorded', 'dispatching');

    settled_execution_status := CASE WHEN EXISTS (
      SELECT 1 FROM public.external_effect_receipts receipt
      WHERE receipt.invocation_id = invocation_row.invocation_id
        AND receipt.status = 'outcome_unknown'
    ) THEN 'effect_outcome_unknown' ELSE 'failed' END;
    settled_result := unknown_result || jsonb_build_object(
      'status', settled_execution_status
    );

    UPDATE public.execution_attempts execution_attempt
    SET status = settled_execution_status,
        finished_at = database_now,
        updated_at = database_now,
        payload = execution_attempt.payload || jsonb_build_object(
          'result', settled_result,
          'recoveredByRunFence', job_row.fence
        )
    WHERE execution_attempt.invocation_id = invocation_row.invocation_id
      AND execution_attempt.status IN ('queued', 'running');

    UPDATE public.capability_leases capability
    SET status = 'revoked',
        revoked_at = COALESCE(capability.revoked_at, database_now),
        updated_at = database_now,
        payload = capability.payload || jsonb_build_object(
          'recoveredByRunFence', job_row.fence
        )
    WHERE capability.invocation_id = invocation_row.invocation_id
      AND capability.status <> 'revoked';

    UPDATE public.capacity_leases capacity
    SET status = 'released',
        released_at = COALESCE(capacity.released_at, database_now),
        updated_at = database_now,
        payload = capacity.payload || jsonb_build_object(
          'recoveredByRunFence', job_row.fence
        )
    WHERE capacity.capacity_lease_id = invocation_row.capacity_lease_id
      AND capacity.status <> 'released';

    UPDATE public.execution_invocations invocation
    SET status = settled_execution_status,
        event_sequence = invocation.event_sequence + 1,
        execution_fence = invocation.execution_fence + 1,
        finished_at = database_now,
        updated_at = database_now,
        payload = invocation.payload || jsonb_build_object(
          'result', settled_result,
          'recoveredByRunFence', job_row.fence
        )
    WHERE invocation.invocation_id = invocation_row.invocation_id
      AND invocation.status IN ('queued', 'running', 'cancellation_requested')
    RETURNING invocation.attempt_id, invocation.event_sequence
      INTO sealed_invocation;
    IF FOUND THEN
      INSERT INTO public.execution_events (
        event_id, invocation_id, attempt_id, schema_version, sequence,
        type, status, occurred_at, payload
      ) VALUES (
        md5(invocation_row.invocation_id::text || ':run-recovery:' || job_row.fence::text),
        invocation_row.invocation_id, sealed_invocation.attempt_id,
        'workbench-execution-fabric-v1', sealed_invocation.event_sequence,
        'execution.' || settled_execution_status, settled_execution_status,
        database_now,
        jsonb_build_object(
          'reason', 'workflow_run_worker_recovered',
          'recoveredByRunFence', job_row.fence
        )
      );
      closed_invocation_count := closed_invocation_count + 1;
    END IF;
  END LOOP;

  UPDATE public.workflow_run_node_attempts node_attempt
  SET status = 'cancelled',
      finished_at = database_now,
      updated_at = database_now,
      payload = node_attempt.payload || CASE
        WHEN node_attempt.invocation_id IS NULL THEN jsonb_build_object(
          'recoveredByRunFence', job_row.fence
        )
        ELSE jsonb_build_object(
          'invocationStatus', 'outcome_unknown',
          'recoveredExecutionStatus', (
            SELECT invocation.status
            FROM public.execution_invocations invocation
            WHERE invocation.invocation_id = node_attempt.invocation_id
          ),
          'failure', unknown_result -> 'failure',
          'summary', 'The previous Skill result is unknown.',
          'recoveredByRunFence', job_row.fence
        )
      END
  WHERE node_attempt.workspace_id = target_workspace_id
    AND node_attempt.run_id = target_run_id
    AND node_attempt.run_fence < job_row.fence
    AND node_attempt.status IN ('queued', 'running');

  IF EXISTS (
    SELECT 1
    FROM public.execution_invocations invocation
    JOIN public.execution_attempts execution_attempt
      ON execution_attempt.invocation_id = invocation.invocation_id
    JOIN public.capability_leases capability
      ON capability.invocation_id = invocation.invocation_id
     AND capability.attempt_id = execution_attempt.attempt_id
    JOIN public.capacity_leases capacity
      ON capacity.capacity_lease_id = invocation.capacity_lease_id
    JOIN public.workflow_run_node_attempts node_attempt
      ON node_attempt.workspace_id = invocation.workspace_id
     AND node_attempt.invocation_id = invocation.invocation_id
    WHERE invocation.workspace_id = target_workspace_id
      AND invocation.controller_kind = 'workflow_run'
      AND invocation.controller_id = target_run_id
      AND invocation.payload ->> 'recoveredByRunFence' = job_row.fence::text
      AND NOT (
        node_attempt.status = 'cancelled'
        AND node_attempt.payload ->> 'invocationStatus' = 'outcome_unknown'
        AND invocation.status IN ('failed', 'effect_outcome_unknown')
        AND execution_attempt.status = invocation.status
        AND capability.status = 'revoked'
        AND capacity.status = 'released'
      )
  ) THEN
    RAISE EXCEPTION 'workflow_run_recovery_seal_incomplete'
      USING ERRCODE = '23514';
  END IF;

  RETURN closed_invocation_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_workflow_run_job_for_run(
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

  IF candidate.state = 'leased' THEN
    PERFORM public.seal_workflow_run_recovered_execution_unknown(
      target_workspace_id, target_run_id, worker_id, worker_lease_token
    );
  END IF;
  RETURN NEXT claimed;
END;
$function$;

ALTER TABLE public.workflow_run_events
  DROP CONSTRAINT workflow_run_events_node_attempt_shape;
ALTER TABLE public.workflow_run_events
  ADD CONSTRAINT workflow_run_events_node_attempt_shape CHECK (
    CASE
      WHEN type LIKE 'node.%'
        OR type = 'review.requested'
        OR (writer_kind = 'worker' AND type IN (
          'run.completed', 'run.cancelled', 'run.partial'
        ))
      THEN node_id IS NOT NULL AND node_attempt_id IS NOT NULL
      WHEN writer_kind = 'worker'
        AND type IN ('run.failed', 'run.effect_outcome_unknown')
      THEN (node_id IS NULL) = (node_attempt_id IS NULL)
      ELSE node_attempt_id IS NULL
    END
  );

-- Keep every existing execution-state invariant, but make the immutable
-- run.worker_recovered event a superseding boundary for exactly the prior
-- Invocation that this migration sealed. This is a fail-closed surgical
-- replacement because the baseline function is intentionally large and owns
-- several unrelated review/final-output invariants.
DO $migration$
DECLARE
  function_definition text;
  patched_definition text;
  original_fragment text := $original$
          newer_event.node_attempt_id = node_attempt.node_attempt_id
          OR (
$original$;
  replacement_fragment text := $replacement$
          newer_event.node_attempt_id = node_attempt.node_attempt_id
          OR (
            newer_event.type = 'run.worker_recovered'
            AND newer_event.run_fence > node_attempt.run_fence
            AND node_attempt.status = 'cancelled'
            AND invocation.status IN ('failed', 'effect_outcome_unknown')
            AND execution_attempt.status = invocation.status
            AND capability.status = 'revoked'
            AND capacity.status = 'released'
          )
          OR (
$replacement$;
  original_newer_types text := $types_original$
          newer_event.type IN (
            'node.started', 'node.progress', 'node.completed', 'node.failed',
$types_original$;
  replacement_newer_types text := $types_replacement$
          newer_event.type IN (
            'run.worker_recovered',
            'node.started', 'node.progress', 'node.completed', 'node.failed',
$types_replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'public.validate_workflow_run_execution_state_aggregate()'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL
    OR length(function_definition)
       - length(replace(function_definition, original_fragment, ''))
       <> length(original_fragment) THEN
    RAISE EXCEPTION 'workflow_run_execution_state_guard_shape_unexpected'
      USING ERRCODE = '55000';
  END IF;
  patched_definition := replace(
    function_definition, original_fragment, replacement_fragment
  );
  IF length(patched_definition)
       - length(replace(patched_definition, original_newer_types, ''))
       <> length(original_newer_types) THEN
    RAISE EXCEPTION 'workflow_run_execution_state_guard_newer_types_shape_unexpected'
      USING ERRCODE = '55000';
  END IF;
  patched_definition := replace(
    patched_definition, original_newer_types, replacement_newer_types
  );
  EXECUTE patched_definition;
END;
$migration$;
