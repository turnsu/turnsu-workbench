-- The public Connection update contract permits a display-label edit.  The
-- baseline revision guard mistakenly treated that mutable presentation field
-- as aggregate identity, making a valid revision write impossible.  Keep the
-- root identity immutable while requiring the same write-version advancement
-- used for enabled/current-revision changes.

CREATE OR REPLACE FUNCTION public.enforce_workspace_connection_root_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'workspace_connection_delete_forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
      NEW.workspace_id, NEW.connection_id, NEW.scope_id, NEW.created_by,
      NEW.schema_version, NEW.created_at, NEW.payload
    ) IS DISTINCT FROM ROW(
      OLD.workspace_id, OLD.connection_id, OLD.scope_id, OLD.created_by,
      OLD.schema_version, OLD.created_at, OLD.payload
    ) THEN
    RAISE EXCEPTION 'workspace_connection_identity_immutable'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.label, NEW.enabled, NEW.current_revision_id, NEW.current_revision_number)
      IS DISTINCT FROM ROW(OLD.label, OLD.enabled, OLD.current_revision_id, OLD.current_revision_number)
    AND NEW.write_version <> OLD.write_version + 1 THEN
    RAISE EXCEPTION 'workspace_connection_write_version_required'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.write_version < OLD.write_version
    OR NEW.current_revision_number < OLD.current_revision_number
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'workspace_connection_revision_regression'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
    AND NEW.current_revision_number <> OLD.current_revision_number + 1 THEN
    RAISE EXCEPTION 'workspace_connection_direct_revision_required'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
