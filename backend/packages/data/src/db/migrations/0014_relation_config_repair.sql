-- Issue #82: repair/validate the canonical `{ relationDefinitionId, targetDatabaseId }`
-- config every relation property must carry (loadRelationEdgeContext in chokePoint.ts
-- already refuses to resolve an edge through a property missing either field, but nothing
-- upheld that invariant against rows written before that check existed).
--
-- `relation_definitions`/`properties` are small, bounded, code-managed system tables, not
-- per-item data — the db-migrations skill's structural/data-migration split assumes the
-- latter means "unbounded, needs a resumable cursor", which doesn't apply here. This runs as
-- a DO block inside a structural migration (rather than a queued backfill) specifically so a
-- bad row aborts the deploy outright, per the issue's "abort migration with the offending
-- property id rather than guessing" — a queued backfill can't block startup the way this can.
--
-- Paired definitions: both sides' target is recomputed from the *opposite* side's own
-- database_id (the only value that can't itself be wrong), and any relationDefinitionId
-- already stored on either side must already agree with this definition — a mismatch there
-- means the property was actually miswired to a different relation and repairing it would
-- paper over deeper corruption, so it aborts instead.
--
-- One-way definitions have no opposite side to repair from: the existing targetDatabaseId is
-- preserved as-is, and merely validated as a well-formed UUID naming a real, still-existing
-- database. relationDefinitionId is likewise only checked, never invented.
DO $$
DECLARE
  reldef RECORD;
  prop_a RECORD;
  prop_b RECORD;
  stored_reldef_id text;
  stored_target text;
  target_uuid uuid;
BEGIN
  FOR reldef IN SELECT id, property_id_a, property_id_b FROM relation_definitions LOOP
    SELECT id, database_id, config INTO prop_a FROM properties WHERE id = reldef.property_id_a;
    IF prop_a IS NULL THEN
      RAISE EXCEPTION 'relation_definitions %: property_id_a % does not exist', reldef.id, reldef.property_id_a;
    END IF;

    IF reldef.property_id_b IS NOT NULL THEN
      SELECT id, database_id, config INTO prop_b FROM properties WHERE id = reldef.property_id_b;
      IF prop_b IS NULL THEN
        RAISE EXCEPTION 'relation_definitions %: property_id_b % does not exist', reldef.id, reldef.property_id_b;
      END IF;

      stored_reldef_id := prop_a.config ->> 'relationDefinitionId';
      IF stored_reldef_id IS NOT NULL AND stored_reldef_id <> reldef.id::text THEN
        RAISE EXCEPTION 'relation_definitions %: property % has relationDefinitionId % that does not match its own definition', reldef.id, prop_a.id, stored_reldef_id;
      END IF;
      stored_reldef_id := prop_b.config ->> 'relationDefinitionId';
      IF stored_reldef_id IS NOT NULL AND stored_reldef_id <> reldef.id::text THEN
        RAISE EXCEPTION 'relation_definitions %: property % has relationDefinitionId % that does not match its own definition', reldef.id, prop_b.id, stored_reldef_id;
      END IF;

      UPDATE properties
        SET config = jsonb_build_object('relationDefinitionId', reldef.id::text, 'targetDatabaseId', prop_b.database_id::text)
        WHERE id = prop_a.id;
      UPDATE properties
        SET config = jsonb_build_object('relationDefinitionId', reldef.id::text, 'targetDatabaseId', prop_a.database_id::text)
        WHERE id = prop_b.id;
    ELSE
      stored_reldef_id := prop_a.config ->> 'relationDefinitionId';
      IF stored_reldef_id IS NULL THEN
        RAISE EXCEPTION 'relation_definitions %: one-way property % is missing relationDefinitionId', reldef.id, prop_a.id;
      END IF;
      IF stored_reldef_id <> reldef.id::text THEN
        RAISE EXCEPTION 'relation_definitions %: one-way property % has relationDefinitionId % that does not match its own definition', reldef.id, prop_a.id, stored_reldef_id;
      END IF;

      stored_target := prop_a.config ->> 'targetDatabaseId';
      IF stored_target IS NULL THEN
        RAISE EXCEPTION 'relation_definitions %: one-way property % is missing targetDatabaseId', reldef.id, prop_a.id;
      END IF;

      BEGIN
        target_uuid := stored_target::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'relation_definitions %: one-way property %''s targetDatabaseId % is not a valid uuid', reldef.id, prop_a.id, stored_target;
      END;

      IF NOT EXISTS (SELECT 1 FROM databases WHERE id = target_uuid) THEN
        RAISE EXCEPTION 'relation_definitions %: one-way property %''s targetDatabaseId % does not reference an existing database', reldef.id, prop_a.id, target_uuid;
      END IF;
    END IF;
  END LOOP;
END $$;
