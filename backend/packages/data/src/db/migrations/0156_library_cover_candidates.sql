-- Issue #1812: the alternative matches a library metadata run found for a Books or Movies item, kept so the
-- user can pick one of them as the manual cover. The metadata job replaces an item's set at the end of every run
-- that does not fail; nothing reads an external service when the set is listed.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes. A rollback leaves the rows
-- in place and the previous release ignores them.
--
-- item_id names an item of a Books or Movies database. `items` is partitioned with the composite primary key
-- (database_id, id), so no foreign key to it can be declared; the permanent purge of an item deletes its rows
-- through the item purge hook libraryCoverCandidatesPurgeHook, which runs after deleteItemDependents
-- (docs/adr/2026-11-10-item-purge-domain-hooks.md). The primary key (item_id, idx) is scoped by the server-generated id of the parent item
-- of the same tenant, as the key of `item_automation` is, so it is no existence oracle across tenants. idx is the
-- position of the candidate in the stored set, 0 to 2.
--
-- Role grants are those of `tenant_exports`: full DML to `semprec_side`, which `semprec_data` inherits through its
-- membership.
CREATE TABLE library_cover_candidates (
  item_id uuid NOT NULL,
  idx smallint NOT NULL CHECK (idx BETWEEN 0 AND 2),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  source text NOT NULL,
  title text,
  subtitle text,
  image_url text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, idx)
);
COMMENT ON TABLE library_cover_candidates IS 'semprec:tenancy=tenant';
ALTER TABLE library_cover_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON library_cover_candidates AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON library_cover_candidates AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON library_cover_candidates TO semprec_side;
