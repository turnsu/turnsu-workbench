-- G1 Harness bridge: a Worker may emit model-visible Kernel events only
-- through Execution Broker.  This projection binds each accepted event back
-- to the already-authorized Product Session/Turn/Command and writes the
-- existing Agent Session ledger.  It deliberately creates no Harness store.

CREATE OR REPLACE FUNCTION public.project_execution_kernel_model_visible_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  invocation_row public.execution_invocations%ROWTYPE;
  session_row public.agent_sessions%ROWTYPE;
  turn_row public.agent_turns%ROWTYPE;
  command_row public.product_commands%ROWTYPE;
  existing_row public.agent_session_events%ROWTYPE;
  model_event jsonb;
  session_sequence bigint;
  model_event_id text;
  model_event_type text;
  event_status text;
BEGIN
  IF NEW.type <> 'agent.kernel.model_visible' THEN
    RETURN NEW;
  END IF;

  model_event := NEW.payload -> 'modelVisibleEvent';
  IF jsonb_typeof(model_event) <> 'object'
    OR model_event ->> 'schemaVersion' <> 'agent-kernel-model-visible-event-v1'
    OR model_event ->> 'eventId' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
    OR model_event ->> 'runId' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
    OR model_event ->> 'type' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(model_event -> 'session') <> 'object'
    OR model_event #>> '{session,sessionId}' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
    OR (model_event #>> '{session,branchId}') IS NOT NULL
      AND model_event #>> '{session,branchId}' !~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(model_event -> 'sequence') <> 'number'
    OR model_event ->> 'sequence' !~ '^[1-9][0-9]*$'
    OR model_event ->> 'occurredAt' IS NULL THEN
    RAISE EXCEPTION 'kernel_session_event_invalid' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO invocation_row
    FROM public.execution_invocations
   WHERE invocation_id = NEW.invocation_id
   FOR SHARE;
  IF NOT FOUND
    OR invocation_row.attempt_id <> NEW.attempt_id
    OR invocation_row.controller_kind <> 'agent_turn'
    OR invocation_row.lineage_session_id IS NULL
    OR invocation_row.lineage_turn_id IS NULL THEN
    RAISE EXCEPTION 'kernel_session_event_lineage_invalid' USING ERRCODE = '23503';
  END IF;

  SELECT * INTO command_row
    FROM public.product_commands
   WHERE workspace_id = invocation_row.workspace_id
     AND command_id = invocation_row.product_command_id
   FOR SHARE;
  IF NOT FOUND
    OR command_row.kind <> 'agent_turn'
    OR command_row.session_id <> invocation_row.lineage_session_id
    OR command_row.turn_id <> invocation_row.lineage_turn_id THEN
    RAISE EXCEPTION 'kernel_session_event_command_invalid' USING ERRCODE = '23503';
  END IF;

  SELECT * INTO session_row
    FROM public.agent_sessions
   WHERE session_id = invocation_row.lineage_session_id
     AND workspace_id = invocation_row.workspace_id
   FOR UPDATE;
  SELECT * INTO turn_row
    FROM public.agent_turns
   WHERE turn_id = invocation_row.lineage_turn_id
     AND session_id = invocation_row.lineage_session_id
     AND workspace_id = invocation_row.workspace_id
   FOR SHARE;
  IF session_row.session_id IS NULL
    OR NOT FOUND
    OR turn_row.product_command_id <> invocation_row.product_command_id
    OR model_event #>> '{session,sessionId}' <> invocation_row.lineage_session_id
    OR (model_event #>> '{session,branchId}') IS DISTINCT FROM session_row.branch_id THEN
    RAISE EXCEPTION 'kernel_session_event_scope_invalid' USING ERRCODE = '23503';
  END IF;

  model_event_id := model_event ->> 'eventId';
  model_event_type := model_event ->> 'type';
  SELECT * INTO existing_row
    FROM public.agent_session_events
   WHERE event_id = model_event_id
   FOR SHARE;
  IF FOUND THEN
    IF existing_row.session_id <> invocation_row.lineage_session_id
      OR existing_row.turn_id <> invocation_row.lineage_turn_id
      OR existing_row.payload ->> 'productCommandId' <> invocation_row.product_command_id
      OR existing_row.payload -> 'modelVisibleEvent' IS DISTINCT FROM model_event THEN
      RAISE EXCEPTION 'kernel_session_event_identity_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;

  UPDATE public.agent_sessions
     SET event_sequence = event_sequence + 1
   WHERE session_id = session_row.session_id
   RETURNING event_sequence INTO session_sequence;
  event_status := CASE
    WHEN model_event_type LIKE '%cancel%' THEN 'cancelled'
    WHEN model_event_type LIKE '%failed%' THEN 'failed'
    WHEN model_event_type LIKE '%denied%'
      OR model_event_type LIKE '%pending%'
      OR model_event_type LIKE '%uncertain%' THEN 'blocked'
    ELSE 'completed'
  END;
  INSERT INTO public.agent_session_events (
    event_id, session_id, turn_id, schema_version, sequence,
    type, status, summary, occurred_at, payload
  ) VALUES (
    model_event_id, invocation_row.lineage_session_id, invocation_row.lineage_turn_id,
    'workbench-v1', session_sequence,
    'kernel.' || model_event_type, event_status,
    'Agent Kernel ' || model_event_type,
    (model_event ->> 'occurredAt')::timestamptz,
    jsonb_build_object(
      'schemaVersion', 'workbench-v1',
      'eventId', model_event_id,
      'sessionId', invocation_row.lineage_session_id,
      'turnId', invocation_row.lineage_turn_id,
      'type', 'kernel.' || model_event_type,
      'status', event_status,
      'summary', 'Agent Kernel ' || model_event_type,
      'occurredAt', model_event ->> 'occurredAt',
      'productCommandId', invocation_row.product_command_id,
      'modelVisibleEvent', model_event
    )
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER execution_events_project_kernel_session_event
  AFTER INSERT ON public.execution_events
  FOR EACH ROW EXECUTE FUNCTION public.project_execution_kernel_model_visible_event();
