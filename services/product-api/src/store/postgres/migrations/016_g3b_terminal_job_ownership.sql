-- A terminal Workflow Run has no active worker owner. The immutable terminal
-- event retains the writer, fence, lease token, and expiry needed for audit;
-- the mutable Job projection must release its active lease tuple.

CREATE OR REPLACE FUNCTION public.validate_workflow_run_job_lease_aggregate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  lease_event_exists boolean;
BEGIN
  IF ROW(
       NEW.fence, NEW.lease_owner, NEW.lease_token,
       NEW.lease_expires_at, NEW.lease_event_id
     )
      IS NOT DISTINCT FROM
     ROW(
       OLD.fence, OLD.lease_owner, OLD.lease_token,
       OLD.lease_expires_at, OLD.lease_event_id
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.state = 'leased' AND NEW.fence = OLD.fence + 1 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.workflow_run_events event
      WHERE event.workspace_id = NEW.workspace_id
        AND event.run_id = NEW.run_id
        AND event.event_id = NEW.lease_event_id
        AND (
          (event.type = 'run.started'
            AND OLD.state = 'queued'
            AND event.status = 'running')
          OR (event.type = 'run.worker_recovered'
            AND OLD.state = 'leased'
            AND event.status IN ('running', 'cancellation_requested'))
        )
        AND event.run_fence = NEW.fence
        AND event.lease_owner = NEW.lease_owner
        AND event.lease_token = NEW.lease_token
        AND event.lease_expires_at = NEW.lease_expires_at
        AND event.previous_run_fence = OLD.fence
        AND event.previous_lease_owner IS NOT DISTINCT FROM OLD.lease_owner
        AND event.previous_lease_token IS NOT DISTINCT FROM OLD.lease_token
        AND event.previous_lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at
    ) INTO lease_event_exists;
  ELSIF NEW.state = 'leased' AND NEW.fence = OLD.fence
    AND NEW.lease_owner = OLD.lease_owner
    AND NEW.lease_token = OLD.lease_token
    AND NEW.lease_expires_at > OLD.lease_expires_at
    AND NEW.lease_event_id IS DISTINCT FROM OLD.lease_event_id THEN
    SELECT EXISTS (
      SELECT 1 FROM public.workflow_run_events event
      WHERE event.workspace_id = NEW.workspace_id
        AND event.run_id = NEW.run_id
        AND event.event_id = NEW.lease_event_id
        AND event.type = 'run.lease_renewed'
        AND event.run_fence = NEW.fence
        AND event.lease_owner = NEW.lease_owner
        AND event.lease_token = NEW.lease_token
        AND event.lease_expires_at = NEW.lease_expires_at
        AND event.previous_run_fence = OLD.fence
        AND event.previous_lease_owner = OLD.lease_owner
        AND event.previous_lease_token = OLD.lease_token
        AND event.previous_lease_expires_at = OLD.lease_expires_at
    ) INTO lease_event_exists;
  ELSIF NEW.lease_owner IS NULL
    AND NEW.lease_token IS NULL
    AND NEW.lease_expires_at IS NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.workflow_run_events event
      WHERE event.workspace_id = NEW.workspace_id
        AND event.run_id = NEW.run_id
        AND event.event_id = NEW.lease_event_id
        AND (
          (OLD.state = 'leased'
            AND NEW.state = 'waiting_review'
            AND event.type = 'review.requested'
            AND event.status = 'waiting_review')
          OR (OLD.state = 'terminal'
            AND NEW.state = 'terminal'
            AND event.status IN (
              'completed', 'failed', 'cancelled', 'partial',
              'effect_outcome_unknown'
            )
            AND event.type = 'run.' || event.status)
        )
        AND event.run_fence = OLD.fence
        AND event.lease_owner = OLD.lease_owner
        AND event.lease_token = OLD.lease_token
    ) INTO lease_event_exists;
  ELSE
    lease_event_exists := false;
  END IF;

  IF lease_event_exists IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'workflow_run_job_lease_event_missing'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.release_terminal_workflow_run_job_ownership()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  UPDATE public.workflow_run_jobs
  SET lease_owner = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      lease_event_id = NEW.event_id,
      updated_at = NEW.occurred_at
  WHERE workspace_id = NEW.workspace_id
    AND run_id = NEW.run_id
    AND state = 'terminal'
    AND (
      lease_owner IS NOT NULL
      OR lease_token IS NOT NULL
      OR lease_expires_at IS NOT NULL
    );
  RETURN NULL;
END;
$function$;

CREATE TRIGGER workflow_run_events_release_terminal_job_ownership
  AFTER INSERT ON public.workflow_run_events
  FOR EACH ROW
  WHEN (NEW.status IN (
    'completed', 'failed', 'cancelled', 'partial', 'effect_outcome_unknown'
  ))
  EXECUTE FUNCTION public.release_terminal_workflow_run_job_ownership();
