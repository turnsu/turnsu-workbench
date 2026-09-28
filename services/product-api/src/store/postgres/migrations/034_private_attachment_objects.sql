-- Personal uploads own their storage objects and expire/delete independently.
-- Equal bytes do not mean equal ownership or lifecycle. Keep content uniqueness
-- for other object kinds and retain every identity/hash foreign-key authority.
ALTER TABLE public.product_objects DROP CONSTRAINT product_objects_content_kind_uq;
CREATE UNIQUE INDEX product_objects_content_kind_uq
  ON public.product_objects (workspace_id, content_hash, object_kind)
  WHERE object_kind NOT IN ('attachment_source', 'attachment_representation');
