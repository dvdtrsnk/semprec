-- Issue #145 (system-i18n 02/05): migrates every select/multi_select property's
-- `config.options` from a bare string array to `{ key, label? }[]`, the same override
-- pattern issue #235 applied to `databases.name`/`properties.name` one level up. A shipped
-- catalog option string `s` becomes `{ key: s }` with no label (seed/*.ts's `selectConfig`
-- helper already writes this shape going forward); an option already stored as an object
-- is left untouched, making this idempotent whether or not #146/#147 or a manual edit
-- already ran. Item property values (an item's own select/multi_select selections) are
-- untouched — only the options catalog's shape changes, per the issue's Task.
--
-- A bare string is only known to be a *shipped* catalog value if it matches the literal
-- option list seed/*.ts's `selectConfig()` calls write for that exact (database
-- owner_module_id, property key) pair (mirrored in the VALUES catalog below) — anything
-- else (a value a user added or renamed before this issue's validators existed, or simply
-- a select/multi_select property this migration doesn't otherwise recognize) is preserved
-- as `{ key, label: <original string> }` so its display text survives as an explicit
-- override, per the issue's Task.
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
  elem_key text;
  new_options jsonb;
  shipped_keys text[];
BEGIN
  FOR prop IN
    SELECT p.id, p.config, d.owner_module_id, p.key AS property_key
    FROM properties p
    JOIN databases d ON d.id = p.database_id
    WHERE p.type IN ('select', 'multi_select') AND jsonb_typeof(p.config -> 'options') = 'array'
  LOOP
    -- Shipped catalog for this exact (database, property) pair, if this migration
    -- recognizes it — kept in sync with the literal arrays seed/*.ts's `selectConfig()`
    -- calls pass today; NULL (no match) means every bare string here gets a label.
    SELECT c.shipped_keys INTO shipped_keys
    FROM (
      VALUES
        ('projects', 'status', ARRAY['inProgress', 'done', 'archived', 'longTerm']),
        ('tasks', 'status', ARRAY['notDone', 'done', 'wontDo']),
        ('people', 'relationship', ARRAY['parent', 'therapist', 'closeFriend', 'girlfriend', 'client', 'neighbor']),
        ('people', 'contact', ARRAY['phone', 'email']),
        ('files', 'type', ARRAY['pdf', 'xlsx', 'docx', 'jpg']),
        ('events', 'type', ARRAY['event', 'standup', 'meeting']),
        ('healthRecords', 'status', ARRAY['resolved', 'monitoring']),
        ('healthRecords', 'type', ARRAY['health', 'condition', 'symptom']),
        ('healthRecords', 'tags', ARRAY['bloodTests', 'medication', 'epilepsy', 'dentalHygiene']),
        ('transcripts', 'status', ARRAY['recording', 'processing', 'done', 'error']),
        ('journal', 'type', ARRAY['year', 'quarter', 'month', 'week', 'day']),
        ('mailboxes', 'provider', ARRAY['gmail', 'outlook', 'icloud', 'generic']),
        ('mailboxes', 'syncStatus', ARRAY['ok', 'error', 'never', 'needsReauthorization']),
        ('folders', 'behavior', ARRAY['folder', 'label']),
        ('folders', 'specialPurpose', ARRAY['inbox', 'sent', 'junk', 'trash', 'drafts', 'archive', 'all', 'none']),
        ('mcpServers', 'syncStatus', ARRAY['ok', 'error', 'never']),
        ('inboxItemTypes', 'status', ARRAY['active', 'archived']),
        ('inboxItemTypes', 'processingMethod', ARRAY['pageContent', 'database']),
        (
          'inboxItemTypes',
          'targetDatabase',
          ARRAY[
            'areas',
            'projects',
            'tasks',
            'people',
            'files',
            'events',
            'healthRecords',
            'companies',
            'transcripts',
            'journal'
          ]
        ),
        ('processingProposals', 'kind', ARRAY['inbox', 'transcript']),
        (
          'processingProposals',
          'status',
          ARRAY['needsClarification', 'proposed', 'confirmed', 'rejected', 'invalid']
        ),
        ('books', 'status', ARRAY['toRead', 'reading', 'read']),
        ('movies', 'type', ARRAY['movie', 'series']),
        ('movies', 'status', ARRAY['planned', 'watching', 'watched'])
    ) AS c(owner_module_id, property_key, shipped_keys)
    WHERE c.owner_module_id = prop.owner_module_id AND c.property_key = prop.property_key;

    new_options := '[]'::jsonb;
    FOR elem IN SELECT * FROM jsonb_array_elements(prop.config -> 'options')
    LOOP
      IF jsonb_typeof(elem) = 'string' THEN
        elem_key := elem #>> '{}';
        IF shipped_keys IS NOT NULL AND elem_key = ANY (shipped_keys) THEN
          new_options := new_options || jsonb_build_array(jsonb_build_object('key', elem_key));
        ELSE
          -- Not a recognized shipped value — preserve its display text as an explicit label override.
          new_options := new_options || jsonb_build_array(jsonb_build_object('key', elem_key, 'label', elem_key));
        END IF;
      ELSIF jsonb_typeof(elem) = 'object' AND jsonb_typeof(elem -> 'key') = 'string' THEN
        -- Already migrated (or a manual { key, label? } override) — preserved verbatim, idempotent.
        new_options := new_options || jsonb_build_array(elem);
      ELSE
        RAISE EXCEPTION 'properties %: malformed select option %, expected a string or a { key, label? } object', prop.id, elem;
      END IF;
    END LOOP;

    -- Skip the write entirely when nothing changed (e.g. already-migrated rows on a rerun).
    IF new_options IS DISTINCT FROM (prop.config -> 'options') THEN
      UPDATE properties SET config = jsonb_set(config, '{options}', new_options) WHERE id = prop.id;
    END IF;
  END LOOP;
END $$;
