-- A sharing relation to the canonical Run, not a second execution ledger.
CREATE TABLE public.work_item_workflow_runs (
  workspace_id public.product_identifier NOT NULL,
  work_item_id public.product_identifier NOT NULL,
  run_id public.product_identifier NOT NULL,
  requested_by_user_id public.product_identifier NOT NULL,
  access_grant_id public.product_identifier NOT NULL,
  share_final_output boolean NOT NULL CHECK (share_final_output = true),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, run_id),
  FOREIGN KEY (workspace_id, work_item_id) REFERENCES public.work_items(workspace_id, work_item_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES public.workflow_runs(workspace_id, run_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, work_item_id, requested_by_user_id, access_grant_id)
    REFERENCES public.work_item_access_grants(workspace_id, work_item_id, user_id, grant_id)
);
CREATE INDEX work_item_workflow_runs_item_idx ON public.work_item_workflow_runs(workspace_id, work_item_id, created_at DESC);

CREATE FUNCTION public.validate_work_item_workflow_run() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'work_item_run_binding_immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.workflow_runs run
    JOIN public.product_commands command ON command.workspace_id = run.workspace_id AND command.command_id = run.product_command_id
    JOIN public.work_item_access_grants grant_row ON grant_row.workspace_id = NEW.workspace_id AND grant_row.grant_id = NEW.access_grant_id
    WHERE run.workspace_id = NEW.workspace_id AND run.run_id = NEW.run_id
      AND command.effective_principal_id = NEW.requested_by_user_id
      AND command.effective_principal_kind = 'user'
      AND command.kind = 'workflow_run'
      AND run.payload->>'requestedBy' = NEW.requested_by_user_id
      AND grant_row.status = 'active' AND grant_row.access_level IN ('owner', 'contribute')
  ) THEN
    RAISE EXCEPTION 'work_item_run_authority_invalid' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE CONSTRAINT TRIGGER work_item_workflow_run_authority
  AFTER INSERT OR UPDATE OR DELETE ON public.work_item_workflow_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.validate_work_item_workflow_run();
