-- A new author draft does not alter the released version used by teammates.
CREATE OR REPLACE FUNCTION public.enforce_skill_asset_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.lifecycle = OLD.lifecycle
    OR NEW.lifecycle NOT IN ('draft', 'validating', 'tested', 'published', 'deprecated', 'archived')
  THEN
    RETURN NEW;
  END IF;

  IF (CASE OLD.lifecycle
    WHEN 'draft' THEN NEW.lifecycle = 'validating'
    WHEN 'validating' THEN NEW.lifecycle IN ('draft', 'tested')
    WHEN 'tested' THEN NEW.lifecycle IN ('draft', 'published')
    WHEN 'published' THEN NEW.lifecycle = 'deprecated' OR (
      NEW.lifecycle = 'draft'
      AND NEW.current_draft_id IS DISTINCT FROM OLD.current_draft_id
      AND NEW.latest_published_version_id IS NOT DISTINCT FROM OLD.latest_published_version_id
      AND EXISTS (SELECT 1 FROM public.skill_drafts draft
        WHERE draft.workspace_id = NEW.workspace_id AND draft.skill_id = NEW.skill_id
          AND draft.skill_draft_id = NEW.current_draft_id AND draft.base_version_id IS NOT NULL)
    )
    WHEN 'deprecated' THEN NEW.lifecycle = 'archived'
    ELSE false
  END) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'skill_asset_lifecycle_transition_forbidden: % -> %', OLD.lifecycle, NEW.lifecycle
    USING ERRCODE = '23514', CONSTRAINT = 'skill_assets_lifecycle_transition';
END;
$function$;
