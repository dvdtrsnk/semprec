-- Issue #1754: what the user did with one action item of a transcript's meeting notes
-- (`computed.meetingNotes.actionItems`). action_item_id is the item's position in that stored array.
-- An open item has no row.
--
-- Additive and rollback-safe: a new table the previous release never reads or writes.
--
-- This release writes `noted` only, through
-- PUT /api/transcripts/:id/action-items/:actionItemId/state. Issue #1767 will write `added` together
-- with task_item_id; `dismissed` is reserved and has no writer.
--
-- transcript_item_id, task_item_id and owner_person_id name items. `items` is partitioned with the
-- composite primary key (database_id, id), so no foreign key to it can be declared. The permanent
-- purge of a transcript deletes its rows (deleteItemDependents); a purge of the task or person a row
-- names leaves that id in place.
--
-- Grants: the API role writes this table, so semprec_data gets DML; semprec_side reads only.
CREATE TABLE transcript_action_item_states (
  tenant_id uuid NOT NULL DEFAULT app_tenant_default() REFERENCES tenants(id),
  transcript_item_id uuid NOT NULL,
  action_item_id integer NOT NULL CHECK (action_item_id >= 0),
  state text NOT NULL CHECK (state IN ('added', 'noted', 'dismissed')),
  task_item_id uuid NULL,
  owner_person_id uuid NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, transcript_item_id, action_item_id)
);
COMMENT ON TABLE transcript_action_item_states IS 'semprec:tenancy=tenant';
ALTER TABLE transcript_action_item_states ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transcript_action_item_states AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app_tenant_default())) WITH CHECK (tenant_id = (SELECT app_tenant_default()));
CREATE POLICY tenant_rows ON transcript_action_item_states AS PERMISSIVE FOR ALL USING (true) WITH CHECK (true);
GRANT SELECT ON transcript_action_item_states TO semprec_side;
GRANT SELECT, INSERT, UPDATE, DELETE ON transcript_action_item_states TO semprec_data;
