-- Native recipes remain a distinct execution provenance. Existing managed
-- loop_versions and their compile/Run/Automation foreign keys are unchanged.
ALTER TABLE public.local_loop_trial_receipts ADD CONSTRAINT local_loop_trial_target_uq
  UNIQUE (workspace_id, trial_id, workflow_id, workflow_revision_id, revision_content_hash, reviewed_by);

CREATE TABLE public.native_loop_versions (
  workspace_id public.product_identifier NOT NULL,
  version_id public.product_identifier NOT NULL,
  workflow_id public.product_identifier NOT NULL,
  workflow_revision_id public.product_identifier NOT NULL,
  revision_content_hash text COLLATE "C" NOT NULL,
  trial_id public.product_identifier NOT NULL,
  version text COLLATE "C" NOT NULL,
  recipe jsonb NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  released_by public.product_identifier NOT NULL,
  released_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, version_id),
  UNIQUE (workspace_id, workflow_id, version),
  UNIQUE (workspace_id, workflow_id, version_id, version, content_hash),
  FOREIGN KEY (workspace_id, trial_id, workflow_id, workflow_revision_id, revision_content_hash, released_by)
    REFERENCES public.local_loop_trial_receipts (workspace_id, trial_id, workflow_id, workflow_revision_id, revision_content_hash, reviewed_by),
  CHECK (length(version) BETWEEN 1 AND 64),
  CHECK (jsonb_typeof(recipe) = 'object'),
  CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$')
);
CREATE TRIGGER native_loop_versions_immutable BEFORE UPDATE OR DELETE ON public.native_loop_versions
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

ALTER TABLE public.workspace_asset_releases ADD COLUMN native_loop_version_id public.product_identifier;
ALTER TABLE public.workspace_asset_releases DROP CONSTRAINT workspace_asset_releases_typed_shape;
ALTER TABLE public.workspace_asset_releases ADD CONSTRAINT workspace_asset_releases_typed_shape CHECK (
  (asset_kind = 'skill' AND skill_id IS NOT NULL AND skill_version_id IS NOT NULL
    AND loop_workflow_id IS NULL AND loop_version_id IS NULL AND native_loop_version_id IS NULL)
  OR (asset_kind = 'loop' AND skill_id IS NULL AND skill_version_id IS NULL AND loop_workflow_id IS NOT NULL
    AND ((loop_version_id IS NOT NULL AND native_loop_version_id IS NULL)
      OR (loop_version_id IS NULL AND native_loop_version_id IS NOT NULL)))
);
ALTER TABLE public.workspace_asset_releases ADD CONSTRAINT workspace_asset_releases_native_loop_fk
  FOREIGN KEY (source_workspace_id, loop_workflow_id, native_loop_version_id, version, content_hash)
  REFERENCES public.native_loop_versions (workspace_id, workflow_id, version_id, version, content_hash);
-- Only the catalog's generated projection/index depends on this column;
-- managed consumers retain their existing loop_version_id foreign keys.
ALTER TABLE public.workspace_asset_releases DROP COLUMN version_id;
ALTER TABLE public.workspace_asset_releases ADD COLUMN version_id public.product_identifier GENERATED ALWAYS AS (
  CASE WHEN asset_kind = 'skill' THEN skill_version_id ELSE COALESCE(loop_version_id, native_loop_version_id) END
) STORED;
CREATE UNIQUE INDEX workspace_asset_releases_asset_version_uq ON public.workspace_asset_releases
  (source_workspace_id, asset_kind, asset_id, version_id);

CREATE TABLE public.native_loop_version_skill_pins (
  workspace_id public.product_identifier NOT NULL,
  native_loop_version_id public.product_identifier NOT NULL,
  source_workspace_id public.product_identifier NOT NULL,
  release_id public.product_identifier NOT NULL,
  asset_kind text COLLATE "C" NOT NULL DEFAULT 'skill' CHECK (asset_kind = 'skill'),
  skill_id public.product_identifier NOT NULL,
  skill_version_id public.product_identifier NOT NULL,
  version text COLLATE "C" NOT NULL,
  content_hash text COLLATE "C" NOT NULL,
  package_hash text COLLATE "C" NOT NULL,
  package_object_hash text COLLATE "C" NOT NULL,
  PRIMARY KEY (workspace_id, native_loop_version_id, skill_id),
  FOREIGN KEY (workspace_id, native_loop_version_id) REFERENCES public.native_loop_versions (workspace_id, version_id),
  FOREIGN KEY (source_workspace_id, release_id, asset_kind, skill_id, skill_version_id)
    REFERENCES public.workspace_asset_releases (source_workspace_id, release_id, asset_kind, skill_id, skill_version_id),
  FOREIGN KEY (source_workspace_id, skill_id, skill_version_id, version, content_hash)
    REFERENCES public.skill_versions (workspace_id, skill_id, skill_version_id, version, content_hash),
  CHECK (workspace_id = source_workspace_id),
  CHECK (package_hash ~ '^sha256:[a-f0-9]{16,64}$' AND package_object_hash ~ '^sha256:[a-f0-9]{16,64}$')
);
CREATE TRIGGER native_loop_version_skill_pins_immutable BEFORE UPDATE OR DELETE ON public.native_loop_version_skill_pins
  FOR EACH ROW EXECUTE FUNCTION public.reject_immutable_authority_history_mutation();

CREATE FUNCTION public.guard_native_loop_publication() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE recipe_document jsonb; complete boolean;
BEGIN
  IF TG_TABLE_NAME = 'native_loop_version_skill_pins' THEN
    PERFORM 1 FROM public.native_loop_versions WHERE workspace_id=NEW.workspace_id AND version_id=NEW.native_loop_version_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.workspace_asset_releases WHERE source_workspace_id=NEW.workspace_id AND native_loop_version_id=NEW.native_loop_version_id) THEN
      RAISE EXCEPTION 'native_loop_published_pins_immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.native_loop_version_id IS NOT NULL THEN
    SELECT recipe INTO recipe_document FROM public.native_loop_versions
      WHERE workspace_id=NEW.source_workspace_id AND version_id=NEW.native_loop_version_id FOR UPDATE;
    WITH expected AS (
      SELECT DISTINCT node->'skillRef'->>'skillId' AS skill_id, node->'skillRef'->>'version' AS version
      FROM jsonb_array_elements(recipe_document->'graph'->'nodes') node WHERE node->>'kind'='Skill'
    ), actual AS (
      SELECT skill_id::text, version FROM public.native_loop_version_skill_pins
      WHERE workspace_id=NEW.source_workspace_id AND native_loop_version_id=NEW.native_loop_version_id
    ) SELECT EXISTS (SELECT 1 FROM expected) AND NOT EXISTS (
      (SELECT * FROM expected EXCEPT SELECT * FROM actual) UNION ALL
      (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    ) INTO complete;
    IF complete IS NOT TRUE THEN RAISE EXCEPTION 'native_loop_skill_pins_incomplete' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER native_loop_skill_pin_append_guard BEFORE INSERT ON public.native_loop_version_skill_pins
  FOR EACH ROW EXECUTE FUNCTION public.guard_native_loop_publication();
CREATE TRIGGER native_loop_release_guard BEFORE INSERT ON public.workspace_asset_releases
  FOR EACH ROW EXECUTE FUNCTION public.guard_native_loop_publication();
