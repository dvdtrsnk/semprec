-- Issue #207: upgrade the `czech` text search configuration from 0006's unaccent + simple
-- fallback to Hunspell lemmatization, once the Czech dictionary assets exist in PostgreSQL's
-- tsearch_data directory (deploy/provision.sh installs them as cs_cz.dict / cs_cz.affix —
-- PostgreSQL only accepts lowercase dictionary file basenames).
--
-- The assets are an operating-system-level install this migration cannot perform, so the
-- upgrade lives in a function rather than inline DDL: this migration calls it once, and the
-- deploy-time migrations CLI calls it again on every deploy. A database migrated before the
-- assets were installed — which recorded this file as applied while keeping the fallback —
-- is upgraded by the first deploy after provisioning installs them.
--
-- The function is idempotent: once `czech_hunspell` heads every word mapping it returns true
-- without touching the catalogs again. Without the assets, CREATE TEXT SEARCH DICTIONARY
-- raises config_file_error; that one error is caught, logged as a WARNING, and the fallback
-- mapping stays exactly as 0006 left it. Any other error propagates.
--
-- The Hunspell dictionary is tried first; a word it does not recognize falls through to
-- 0006's unaccent + simple chain unchanged. Recognized words are indexed as their lemma with
-- diacritics (ispell output cannot be fed through unaccent), so an unaccented query term only
-- matches through that fallback. Rows indexed before activation keep their fallback lexemes
-- until they are reindexed. websearch_to_tsquery, ranking and the search operators are
-- untouched: they keep reading the same `czech` configuration.
CREATE FUNCTION activate_czech_hunspell_search() RETURNS boolean
LANGUAGE plpgsql
AS $$
BEGIN
  -- Serializes concurrent deploys; the checks below then see each other's committed work.
  PERFORM pg_advisory_xact_lock(hashtext('activate_czech_hunspell_search'));

  IF (
    SELECT count(*)
    FROM pg_ts_config_map m
    JOIN pg_ts_dict d ON d.oid = m.mapdict
    WHERE m.mapcfg = 'czech'::regconfig
      AND m.mapseqno = 1
      AND d.dictname = 'czech_hunspell'
      AND d.dictnamespace = current_schema()::regnamespace
  ) = 6 THEN
    RETURN true;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_dict
    WHERE dictname = 'czech_hunspell' AND dictnamespace = current_schema()::regnamespace
  ) THEN
    BEGIN
      CREATE TEXT SEARCH DICTIONARY czech_hunspell (TEMPLATE = ispell, DictFile = cs_cz, AffFile = cs_cz);
    EXCEPTION WHEN config_file_error THEN
      RAISE WARNING 'Czech Hunspell assets unavailable, keeping unaccent/simple full-text search: %', SQLERRM;
      RETURN false;
    END;
  END IF;

  ALTER TEXT SEARCH CONFIGURATION czech
    ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
    WITH czech_hunspell, unaccent, simple;
  RETURN true;
END;
$$;

-- Only the migrating role activates; the runtime roles never need to call this.
REVOKE EXECUTE ON FUNCTION activate_czech_hunspell_search() FROM PUBLIC;

SELECT activate_czech_hunspell_search();
