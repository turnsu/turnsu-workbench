-- Project file bytes reuse the governed object store. PostgreSQL owns the heads,
-- immutable revisions and commands; a conflicting commit never advances a head.
DO $migration$
DECLARE constraint_name text; old_expression text; new_expression text;
BEGIN
  FOREACH constraint_name IN ARRAY ARRAY['product_commands_kind', 'product_commands_session_turn_shape', 'product_commands_special_target_shape', 'product_commands_special_completed'] LOOP
    SELECT pg_get_expr(conbin, conrelid) INTO STRICT old_expression FROM pg_constraint
      WHERE conrelid = 'public.product_commands'::regclass AND conname = constraint_name;
    new_expression := CASE constraint_name
      WHEN 'product_commands_kind' THEN 'true'
      WHEN 'product_commands_session_turn_shape' THEN 'session_id IS NULL AND turn_id IS NULL'
      WHEN 'product_commands_special_target_shape' THEN 'effect_class = ''write_local'' AND target_kind = ''project_file_revision'' AND target_id IS NOT NULL AND target_revision = 1'
      ELSE 'status = ''completed''' END;
    EXECUTE format('ALTER TABLE public.product_commands DROP CONSTRAINT %I', constraint_name);
    EXECUTE format('ALTER TABLE public.product_commands ADD CONSTRAINT %I CHECK ((kind = ''project_file_commit'' AND (%s)) OR (kind <> ''project_file_commit'' AND (%s)))', constraint_name, new_expression, old_expression);
  END LOOP;
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT old_expression FROM pg_constraint
    WHERE conrelid = 'public.product_objects'::regclass AND conname = 'product_objects_kind';
  ALTER TABLE public.product_objects DROP CONSTRAINT product_objects_kind;
  EXECUTE format('ALTER TABLE public.product_objects ADD CONSTRAINT product_objects_kind CHECK (object_kind = ''project_file_content'' OR (%s))', old_expression);
END;
$migration$;

DROP TRIGGER product_commands_special_target_guard ON public.product_commands;
CREATE CONSTRAINT TRIGGER product_commands_special_target_guard
  AFTER INSERT ON public.product_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.kind NOT IN ('project_create', 'project_members_revise', 'work_item_create', 'work_item_update',
    'device_register', 'device_revoke', 'agent_tool_approval_decide', 'model_profile_create', 'project_file_commit')
    AND NOT (NEW.kind = 'agent_turn' AND NEW.target_kind IN ('work_item', 'work_item_continuation_turn')))
  EXECUTE FUNCTION public.validate_product_command_special_target();

CREATE TABLE public.project_file_revisions (
  workspace_id public.product_identifier NOT NULL,
  project_id public.product_identifier NOT NULL,
  revision_id public.product_identifier NOT NULL,
  path text COLLATE "C" NOT NULL CHECK (length(path) BETWEEN 1 AND 512),
  path_key text COLLATE "C" NOT NULL,
  base_revision_id public.product_identifier,
  object_id public.product_identifier NOT NULL,
  object_kind text NOT NULL DEFAULT 'project_file_content' CHECK (object_kind = 'project_file_content'),
  content_hash text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 0 AND 8388608),
  media_type text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('synced', 'conflict')),
  created_by_user_id public.product_identifier NOT NULL,
  product_command_id public.product_identifier NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, revision_id),
  UNIQUE (workspace_id, project_id, path_key, revision_id),
  FOREIGN KEY (workspace_id, project_id) REFERENCES public.projects(workspace_id, project_id),
  FOREIGN KEY (workspace_id, project_id, path_key, base_revision_id) REFERENCES public.project_file_revisions(workspace_id, project_id, path_key, revision_id),
  FOREIGN KEY (workspace_id, object_id, object_kind, content_hash) REFERENCES public.product_objects(workspace_id, object_id, object_kind, content_hash),
  FOREIGN KEY (workspace_id, product_command_id) REFERENCES public.product_commands(workspace_id, command_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.project_file_heads (
  workspace_id public.product_identifier NOT NULL,
  project_id public.product_identifier NOT NULL,
  path_key text COLLATE "C" NOT NULL,
  revision_id public.product_identifier NOT NULL,
  PRIMARY KEY (workspace_id, project_id, path_key),
  FOREIGN KEY (workspace_id, project_id, path_key, revision_id) REFERENCES public.project_file_revisions(workspace_id, project_id, path_key, revision_id)
);

CREATE FUNCTION public.guard_project_file_revision() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'project_file_revision_immutable' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.product_commands command
    JOIN public.product_objects object ON object.workspace_id = NEW.workspace_id AND object.object_id = NEW.object_id
    WHERE command.workspace_id = NEW.workspace_id AND command.command_id = NEW.product_command_id
      AND command.kind = 'project_file_commit' AND command.status = 'completed'
      AND command.target_id = NEW.revision_id AND command.target_kind = 'project_file_revision'
      AND command.effective_principal_kind = 'user' AND command.effective_principal_id = NEW.created_by_user_id
      AND object.state = 'promoted' AND object.content_hash = NEW.content_hash AND object.size_bytes = NEW.byte_length)
  THEN RAISE EXCEPTION 'project_file_revision_authority_invalid' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$function$;
CREATE CONSTRAINT TRIGGER project_file_revision_guard AFTER INSERT OR UPDATE OR DELETE ON public.project_file_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_project_file_revision();

CREATE FUNCTION public.guard_project_file_command() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  IF NEW.kind = 'project_file_commit' AND NOT EXISTS (SELECT 1 FROM public.project_file_revisions revision
    WHERE revision.workspace_id = NEW.workspace_id AND revision.revision_id = NEW.target_id
      AND revision.product_command_id = NEW.command_id AND revision.created_by_user_id = NEW.effective_principal_id)
  THEN RAISE EXCEPTION 'project_file_command_target_invalid' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$function$;
CREATE CONSTRAINT TRIGGER project_file_command_guard AFTER INSERT ON public.product_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_project_file_command();

CREATE FUNCTION public.guard_project_file_head() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
DECLARE prior_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'project_file_head_delete_forbidden' USING ERRCODE='23514'; END IF;
  prior_id := CASE WHEN TG_OP='UPDATE' THEN OLD.revision_id ELSE NULL END;
  IF NOT EXISTS (SELECT 1 FROM public.project_file_revisions revision
    WHERE revision.workspace_id=NEW.workspace_id AND revision.project_id=NEW.project_id AND revision.path_key=NEW.path_key
      AND revision.revision_id=NEW.revision_id AND revision.outcome='synced' AND revision.base_revision_id IS NOT DISTINCT FROM prior_id)
  THEN RAISE EXCEPTION 'project_file_head_base_conflict' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER project_file_head_guard BEFORE INSERT OR UPDATE OR DELETE ON public.project_file_heads
  FOR EACH ROW EXECUTE FUNCTION public.guard_project_file_head();

CREATE TABLE public.project_file_conflict_resolutions (
  workspace_id public.product_identifier NOT NULL,
  project_id public.product_identifier NOT NULL,
  path_key text COLLATE "C" NOT NULL,
  conflict_revision_id public.product_identifier NOT NULL,
  resolution_revision_id public.product_identifier NOT NULL,
  PRIMARY KEY(workspace_id, conflict_revision_id),
  FOREIGN KEY(workspace_id,project_id,path_key,conflict_revision_id) REFERENCES public.project_file_revisions(workspace_id,project_id,path_key,revision_id),
  FOREIGN KEY(workspace_id,project_id,path_key,resolution_revision_id) REFERENCES public.project_file_revisions(workspace_id,project_id,path_key,revision_id)
);
CREATE FUNCTION public.guard_project_file_resolution() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'project_file_resolution_immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.project_file_revisions conflict JOIN public.project_file_revisions resolution
    ON resolution.workspace_id=conflict.workspace_id AND resolution.project_id=conflict.project_id AND resolution.path_key=conflict.path_key
    WHERE conflict.workspace_id=NEW.workspace_id AND conflict.revision_id=NEW.conflict_revision_id AND conflict.outcome='conflict'
      AND resolution.revision_id=NEW.resolution_revision_id AND resolution.outcome='synced' AND resolution.created_at>=conflict.created_at)
  THEN RAISE EXCEPTION 'project_file_resolution_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER project_file_resolution_guard BEFORE INSERT OR UPDATE OR DELETE ON public.project_file_conflict_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.guard_project_file_resolution();
