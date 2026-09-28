-- A deletion is an immutable revision. Its historical base and bytes remain addressable.
ALTER TABLE public.project_file_revisions ADD COLUMN deleted boolean NOT NULL DEFAULT false;
ALTER TABLE public.project_file_revisions ADD CONSTRAINT project_file_tombstone_shape CHECK (
  NOT deleted OR (base_revision_id IS NOT NULL AND byte_length=0
    AND content_hash='sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
);
