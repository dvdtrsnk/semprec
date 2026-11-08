-- Issue #1564: the attachments an Inbox item carries, as counted references to `blobs` rows. Moving them
-- into Files on confirm is issue #1703. `deleteBlobIfUnreferenced` counts these rows, so a blob one of
-- them names is kept by a Files item's purge and by the unreferenced-blob sweep (issue #1401).
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- `inbox_item_id` names a partitioned `items` row, which has no (tenant_id, id) key to reference, so
-- there is no foreign key to items: `deleteItemDependents` removes the rows together with the item,
-- the way `item_origins` is removed (migration 0114). A trashed item keeps its rows. The unique index
-- refuses two attachments of one item at the same position. The reference to `blobs` is paired with a
-- composite key that refuses a blob of another tenant, as migration 0083 does for every other reference
-- between tenant rows.
CREATE TABLE inbox_attachments (
  attachment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  inbox_item_id uuid NOT NULL,
  blob_id uuid NOT NULL REFERENCES blobs(id),
  position integer NOT NULL,
  source text NOT NULL CHECK (source IN ('camera', 'scan', 'photoLibrary', 'files', 'share')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_attachments_blob_id_tenant_fkey FOREIGN KEY (tenant_id, blob_id) REFERENCES blobs (tenant_id, id)
);
CREATE UNIQUE INDEX inbox_attachments_item_position_uq ON inbox_attachments (tenant_id, inbox_item_id, position);
CREATE INDEX inbox_attachments_tenant_blob_idx ON inbox_attachments (tenant_id, blob_id);
COMMENT ON TABLE inbox_attachments IS 'semprec:tenancy=tenant';
ALTER TABLE inbox_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON inbox_attachments AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON inbox_attachments AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON inbox_attachments TO semprec_side;
