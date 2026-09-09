-- Issue #145 (system-i18n 02/05): migrates every select/multi_select property's
-- `config.options` from a bare string array to `{ key, label? }[]`, the same override
-- pattern issue #235 applied to `databases.name`/`properties.name` one level up. A shipped
-- catalog option string `s` becomes `{ key: s }` with no label (seed/*.ts's `selectConfig`
-- helper already writes this shape going forward); an option already stored as an object
-- is left untouched, making this idempotent whether or not #146/#147 or a manual edit
-- already ran. Item property values (an item's own select/multi_select selections) are
-- untouched — only the options catalog's shape changes, per the issue's Task.
--
-- Runs as a DO block inside a structural migration, not a queued backfill: `properties` is
-- a small, bounded, code-managed system table (not per-item data), so this fits the
-- db-migrations skill's "small/bounded" exception to the resumable-cursor backfill rule,
-- and a malformed option should abort the deploy with the offending property id rather
-- than silently reshaping bad data — same reasoning as 0014_relation_config_repair.sql.
DO $$
DECLARE
  prop RECORD;
  elem jsonb;
  new_options jsonb;
BEGIN
  FOR prop IN
    SELECT id, config FROM properties
    WHERE type IN ('select', 'multi_select') AND jsonb_typeof(config -> 'options') = 'array'
  LOOP
    new_options := '[]'::jsonb;
    FOR elem IN SELECT * FROM jsonb_array_elements(prop.config -> 'options')
    LOOP
      IF jsonb_typeof(elem) = 'string' THEN
        new_options := new_options || jsonb_build_array(jsonb_build_object('key', elem #>> '{}'));
      ELSIF jsonb_typeof(elem) = 'object' AND jsonb_typeof(elem -> 'key') = 'string' THEN
        -- Already migrated (or a manual { key, label? } override) — preserved verbatim, idempotent.
        new_options := new_options || jsonb_build_array(elem);
      ELSE
        RAISE EXCEPTION 'properties %: malformed select option %, expected a string or a { key, label? } object', prop.id, elem;
      END IF;
    END LOOP;

    UPDATE properties SET config = jsonb_set(config, '{options}', new_options) WHERE id = prop.id;
  END LOOP;
END $$;
