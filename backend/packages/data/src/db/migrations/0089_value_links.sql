-- Issue #1403: value links, the record that a property value on an item was taken over from other
-- items instead of set by the user.
--
-- Additive and rollback-safe: two new tables the previous release never reads or writes. Nothing
-- in production code writes a row yet; rows exist only through test fixtures until the creation
-- and propagation issue (#1593) lands.
--
-- A link covers the whole value of one property on one item, so the unique key is
-- (tenant_id, item_id, property_key). No row means the value is the user's own; state 'on' reads
-- as inherited and state 'broken' as inheritedBroken. There is no foreign key to `items` because
-- it is partitioned with a composite key; cleanup belongs to the purge path (#1656).
CREATE TABLE value_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  item_id uuid NOT NULL,
  property_key text NOT NULL,
  rule_key text NOT NULL,
  state text NOT NULL DEFAULT 'on' CHECK (state IN ('on', 'broken')),
  broken_by text CHECK (broken_by IN ('user', 'agent')),
  broken_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT value_links_tenant_item_property_uq UNIQUE (tenant_id, item_id, property_key),
  CONSTRAINT value_links_tenant_id_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT value_links_state_columns_check CHECK (
    (state = 'on' AND broken_by IS NULL AND broken_at IS NULL)
    OR (state = 'broken' AND broken_by IS NOT NULL AND broken_at IS NOT NULL)
  )
);
COMMENT ON TABLE value_links IS 'semprec:tenancy=tenant';
ALTER TABLE value_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON value_links AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON value_links AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON value_links TO semprec_side;

-- One link may have several sources (a file's company comes from each of its projects). The
-- 'senderDomain' kind is created here so a later issue (#1897) needs no second migration; nothing
-- writes it yet.
CREATE TABLE value_link_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  link_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('item', 'senderDomain')),
  source_item_id uuid,
  source_property_key text NOT NULL,
  domain text,
  CONSTRAINT value_link_sources_link_fkey
    FOREIGN KEY (tenant_id, link_id) REFERENCES value_links (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT value_link_sources_kind_columns_check CHECK (
    (source_kind = 'item' AND source_item_id IS NOT NULL AND domain IS NULL)
    OR (source_kind = 'senderDomain' AND domain IS NOT NULL AND source_item_id IS NULL)
  )
);
CREATE INDEX value_link_sources_source_item_idx ON value_link_sources (tenant_id, source_item_id);
CREATE UNIQUE INDEX value_link_sources_item_uq
  ON value_link_sources (tenant_id, link_id, source_item_id, source_property_key) WHERE source_kind = 'item';
CREATE UNIQUE INDEX value_link_sources_domain_uq
  ON value_link_sources (tenant_id, link_id, domain, source_property_key) WHERE source_kind = 'senderDomain';
COMMENT ON TABLE value_link_sources IS 'semprec:tenancy=tenant';
ALTER TABLE value_link_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON value_link_sources AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON value_link_sources AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON value_link_sources TO semprec_side;
