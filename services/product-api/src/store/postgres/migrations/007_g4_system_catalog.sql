-- M1/G4: the built-in catalog is a single platform-owned source.  Customer
-- workspaces install immutable releases explicitly; they never receive seeds
-- during workspace bootstrap.

ALTER TABLE public.workspace_asset_releases
  ALTER COLUMN published_by DROP NOT NULL;

ALTER TABLE public.workspace_asset_releases
  ADD COLUMN published_by_system_principal_id public.product_identifier;

ALTER TABLE public.workspace_asset_releases
  ADD CONSTRAINT workspace_asset_releases_system_publisher_fk
  FOREIGN KEY (published_by_system_principal_id)
  REFERENCES public.skill_system_catalog_principals (principal_id);

ALTER TABLE public.workspace_asset_releases
  ADD CONSTRAINT workspace_asset_releases_publisher_shape CHECK (
    (published_by IS NOT NULL) <> (published_by_system_principal_id IS NOT NULL)
  );

ALTER TABLE public.workspace_asset_releases
  ADD CONSTRAINT workspace_asset_releases_system_catalog_publisher CHECK (
    source_workspace_id <> 'system-catalog'
    OR published_by_system_principal_id = 'system-catalog'
  );

ALTER TABLE public.asset_installations
  DROP CONSTRAINT asset_installations_v1_same_workspace;

ALTER TABLE public.asset_installations
  ADD CONSTRAINT asset_installations_source_boundary CHECK (
    source_workspace_id = workspace_id
    OR source_workspace_id = 'system-catalog'
  );

ALTER TABLE public.asset_installations
  ADD CONSTRAINT asset_installations_source_identity_uq
  UNIQUE (workspace_id, installation_id, source_workspace_id);

ALTER TABLE public.installation_update_drafts
  ADD COLUMN source_workspace_id public.product_identifier;

UPDATE public.installation_update_drafts
  SET source_workspace_id = workspace_id
  WHERE source_workspace_id IS NULL;

ALTER TABLE public.installation_update_drafts
  ALTER COLUMN source_workspace_id SET NOT NULL;

ALTER TABLE public.installation_update_drafts
  ADD CONSTRAINT installation_update_drafts_source_boundary CHECK (
    source_workspace_id = workspace_id
    OR source_workspace_id = 'system-catalog'
  );

ALTER TABLE public.installation_update_drafts
  ADD CONSTRAINT installation_update_drafts_installation_source_fk
  FOREIGN KEY (workspace_id, installation_id, source_workspace_id)
  REFERENCES public.asset_installations (workspace_id, installation_id, source_workspace_id);

ALTER TABLE public.installation_update_drafts
  DROP CONSTRAINT installation_update_drafts_base_skill_release_fk,
  DROP CONSTRAINT installation_update_drafts_target_skill_release_fk,
  DROP CONSTRAINT installation_update_drafts_base_loop_release_fk,
  DROP CONSTRAINT installation_update_drafts_target_loop_release_fk;

ALTER TABLE public.installation_update_drafts
  ADD CONSTRAINT installation_update_drafts_base_skill_release_fk
  FOREIGN KEY (
    source_workspace_id, base_release_id, asset_kind, skill_id, base_skill_version_id
  ) REFERENCES public.workspace_asset_releases (
    source_workspace_id, release_id, asset_kind, skill_id, skill_version_id
  );

ALTER TABLE public.installation_update_drafts
  ADD CONSTRAINT installation_update_drafts_target_skill_release_fk
  FOREIGN KEY (
    source_workspace_id, target_release_id, asset_kind, skill_id, target_skill_version_id
  ) REFERENCES public.workspace_asset_releases (
    source_workspace_id, release_id, asset_kind, skill_id, skill_version_id
  );

ALTER TABLE public.installation_update_drafts
  ADD CONSTRAINT installation_update_drafts_base_loop_release_fk
  FOREIGN KEY (
    source_workspace_id, base_release_id, asset_kind, loop_workflow_id, base_loop_version_id
  ) REFERENCES public.workspace_asset_releases (
    source_workspace_id, release_id, asset_kind, loop_workflow_id, loop_version_id
  );

ALTER TABLE public.installation_update_drafts
  ADD CONSTRAINT installation_update_drafts_target_loop_release_fk
  FOREIGN KEY (
    source_workspace_id, target_release_id, asset_kind, loop_workflow_id, target_loop_version_id
  ) REFERENCES public.workspace_asset_releases (
    source_workspace_id, release_id, asset_kind, loop_workflow_id, loop_version_id
  );
