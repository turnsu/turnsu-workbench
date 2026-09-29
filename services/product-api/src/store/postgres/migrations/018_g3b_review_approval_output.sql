-- An approved ReviewGate is a durable data-producing node. Persist its output
-- in the same aggregate transaction that settles the review and Execution
-- authority so a later worker can continue without process-local state.

DO $migration$
DECLARE
  function_definition text;
  patched_definition text;
  declaration_original text := $declaration_original$
  settled_status text;
  changed_count integer;
$declaration_original$;
  declaration_replacement text := $declaration_replacement$
  settled_status text;
  changed_count integer;
  review_execution_output jsonb;
$declaration_replacement$;
  derivation_anchor text := $derivation_anchor$
  UPDATE public.workflow_run_reviews
  SET status = 'decided', decision = review_decision,
$derivation_anchor$;
  derivation_replacement text := $derivation_replacement$
  IF review_decision = 'approve' THEN
    SELECT jsonb_object_agg(
      output_port ->> 'portId',
      node_attempt_row.payload -> 'executionInput'
        -> (node_definition -> 'inputPorts' -> 0 ->> 'portId')
    )
    INTO review_execution_output
    FROM public.workflow_revisions revision
    CROSS JOIN LATERAL jsonb_array_elements(
      revision.graph -> 'nodes'
    ) node_definition
    CROSS JOIN LATERAL jsonb_array_elements(
      node_definition -> 'outputPorts'
    ) output_port
    WHERE revision.workspace_id = target_workspace_id
      AND revision.revision_id = run_row.workflow_revision_id
      AND node_definition ->> 'nodeId' = review_row.node_id;
  END IF;

  UPDATE public.workflow_run_reviews
  SET status = 'decided', decision = review_decision,
$derivation_replacement$;
  attempt_update_original text := $attempt_update_original$
  UPDATE public.workflow_run_node_attempts
  SET status = settled_status, finished_at = database_now, updated_at = database_now
$attempt_update_original$;
  attempt_update_replacement text := $attempt_update_replacement$
  UPDATE public.workflow_run_node_attempts
  SET status = settled_status,
      finished_at = database_now,
      updated_at = database_now,
      payload = payload || CASE review_decision
        WHEN 'approve' THEN jsonb_build_object(
          'summary', 'Review approved.',
          'invocationStatus', 'completed'
        ) || CASE WHEN review_execution_output IS NULL
          THEN '{}'::jsonb
          ELSE jsonb_build_object('executionOutput', review_execution_output)
        END
        ELSE jsonb_build_object(
          'summary', 'Review revision requested.',
          'invocationStatus', 'cancelled'
        )
      END
$attempt_update_replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'public.decide_workflow_run_review(public.product_identifier,public.product_identifier,public.product_identifier,text)'::regprocedure
  ) INTO function_definition;
  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'workflow_run_review_function_missing'
      USING ERRCODE = '55000';
  END IF;

  IF length(function_definition)
       - length(replace(function_definition, declaration_original, ''))
       <> length(declaration_original) THEN
    RAISE EXCEPTION 'workflow_run_review_declaration_shape_unexpected'
      USING ERRCODE = '55000';
  END IF;
  patched_definition := replace(
    function_definition, declaration_original, declaration_replacement
  );

  IF length(patched_definition)
       - length(replace(patched_definition, derivation_anchor, ''))
       <> length(derivation_anchor) THEN
    RAISE EXCEPTION 'workflow_run_review_derivation_shape_unexpected'
      USING ERRCODE = '55000';
  END IF;
  patched_definition := replace(
    patched_definition, derivation_anchor, derivation_replacement
  );

  IF length(patched_definition)
       - length(replace(patched_definition, attempt_update_original, ''))
       <> length(attempt_update_original) THEN
    RAISE EXCEPTION 'workflow_run_review_attempt_update_shape_unexpected'
      USING ERRCODE = '55000';
  END IF;
  patched_definition := replace(
    patched_definition, attempt_update_original, attempt_update_replacement
  );

  EXECUTE patched_definition;
END;
$migration$;
