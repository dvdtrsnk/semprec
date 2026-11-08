-- Issue #82: enforce `relation_definitions.cardinality` under concurrency. Until now the
-- column was purely descriptive — nothing stopped two concurrent `createRelationWithClient`
-- calls from producing a `one_to_one`/`one_to_many` violation, since under read-committed
-- isolation two overlapping transactions can each run a "does a conflicting edge already
-- exist" check before either one commits and see no conflict.
--
-- A plain partial UNIQUE index can't express this: which columns must be unique depends on
-- `relation_definitions.cardinality`, a different table's row, and a partial index predicate
-- can only reference the indexed table's own columns. Instead, a BEFORE INSERT trigger takes
-- a transaction-scoped advisory lock keyed on `relation_definition_id` before checking for a
-- conflicting edge — this serializes concurrent inserts for the *same* relation definition
-- (unrelated definitions never contend), so the second transaction's check runs only after
-- the first has committed (or rolled back) and therefore sees its effect.
--
-- Per the issue's contract, `property_id_a`/`item_a` is the "one" side of a `one_to_many`
-- definition: one `item_a` may have many `item_b` edges, but a given `item_b` may point to
-- only one `item_a` — the constraint therefore lands on `item_b`, not `item_a`. `one_to_one`
-- applies that same single-edge-per-value rule to both `item_a` and `item_b`. `many_to_many`
-- adds no constraint beyond the existing `(relation_definition_id, item_a, item_b)`
-- uniqueness. The idempotent re-create path (`ON CONFLICT ... DO UPDATE SET metadata`,
-- relationsStore.createItemRelation) re-attempts the exact same tuple — excluded explicitly
-- below so replaying an existing edge is never mistaken for a new conflict.
CREATE OR REPLACE FUNCTION enforce_relation_cardinality() RETURNS trigger AS $$
DECLARE
  v_cardinality text;
  v_conflict boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.relation_definition_id::text, 0));

  SELECT cardinality INTO v_cardinality FROM relation_definitions WHERE id = NEW.relation_definition_id;
  IF v_cardinality IS NULL THEN
    RAISE EXCEPTION 'relation_definitions % not found', NEW.relation_definition_id;
  END IF;

  IF v_cardinality = 'one_to_one' THEN
    SELECT EXISTS (
      SELECT 1 FROM item_relations
      WHERE relation_definition_id = NEW.relation_definition_id
        AND (item_a = NEW.item_a OR item_b = NEW.item_b)
        AND NOT (item_a = NEW.item_a AND item_b = NEW.item_b)
    ) INTO v_conflict;
    IF v_conflict THEN
      RAISE EXCEPTION USING
        ERRCODE = 'SC001',
        MESSAGE = format('cardinality_violation: relation %s is one_to_one and item_a %s or item_b %s already has a different edge', NEW.relation_definition_id, NEW.item_a, NEW.item_b);
    END IF;
  ELSIF v_cardinality = 'one_to_many' THEN
    SELECT EXISTS (
      SELECT 1 FROM item_relations
      WHERE relation_definition_id = NEW.relation_definition_id
        AND item_b = NEW.item_b
        AND NOT (item_a = NEW.item_a AND item_b = NEW.item_b)
    ) INTO v_conflict;
    IF v_conflict THEN
      RAISE EXCEPTION USING
        ERRCODE = 'SC001',
        MESSAGE = format('cardinality_violation: relation %s is one_to_many and item_b %s already has a different item_a', NEW.relation_definition_id, NEW.item_b);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `CREATE TRIGGER` has no `OR REPLACE` in this Postgres version, so a bare `CREATE TRIGGER`
-- would raise "trigger already exists" if this migration file were ever re-executed after a
-- schema_migrations bookkeeping reset without also dropping the schema — unlike the function
-- above, which `CREATE OR REPLACE` already makes safe to redefine. `DROP ... IF EXISTS` first
-- makes the whole file re-runnable the same way.
DROP TRIGGER IF EXISTS item_relations_cardinality_trigger ON item_relations;
CREATE TRIGGER item_relations_cardinality_trigger
  BEFORE INSERT ON item_relations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_relation_cardinality();
