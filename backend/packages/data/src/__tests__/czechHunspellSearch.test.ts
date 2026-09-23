import { copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "../db/migrate.js";
import { withTransaction } from "../db/pool.js";
import { activateCzechHunspellSearch } from "../mail/czechHunspellSearch.js";
import { reindexItemSearch, searchItems } from "../mail/search.js";
import { seedSystem } from "../seed/seedSystem.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "czech-hunspell");
const ASSET_FILES = ["cs_cz.dict", "cs_cz.affix"];

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set — is vitest.config.ts's globalSetup wired up?");
  return url;
}

/**
 * A database of its own per test: the shared test database was migrated by globalSetup
 * without the Czech assets, and activation rewrites the `czech` configuration every other
 * search test reads. Integration test files run serially (fileParallelism: false), so the
 * assets placed in the instance-wide tsearch_data directory below are visible to this file only.
 */
async function withFreshDatabase(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const name = `czech_fts_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: testDatabaseUrl() });
  // UTF8 like production: the embedded instance's template1 is SQL_ASCII, which the text
  // search parser cannot split Czech words in.
  await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString() });
  try {
    await fn(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

async function tsearchDataDir(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ setting: string }>("SELECT setting FROM pg_config WHERE name = 'SHAREDIR'");
  if (!rows[0]) throw new Error("pg_config reported no SHAREDIR");
  return path.join(rows[0].setting, "tsearch_data");
}

async function installAssets(pool: Pool): Promise<void> {
  const dir = await tsearchDataDir(pool);
  for (const file of ASSET_FILES) {
    await copyFile(path.join(FIXTURE_DIR, file), path.join(dir, file));
  }
}

async function removeAssets(pool: Pool): Promise<void> {
  const dir = await tsearchDataDir(pool);
  for (const file of ASSET_FILES) {
    await rm(path.join(dir, file), { force: true });
  }
}

async function czechVector(pool: Pool, text: string): Promise<string> {
  const { rows } = await pool.query<{ vector: string }>("SELECT to_tsvector('czech', $1)::text AS vector", [text]);
  if (!rows[0]) throw new Error("to_tsvector returned no row");
  return rows[0].vector;
}

async function lexize(pool: Pool, word: string): Promise<string[] | null> {
  const { rows } = await pool.query<{ lexemes: string[] | null }>(
    "SELECT ts_lexize('czech_hunspell', $1) AS lexemes",
    [word],
  );
  if (!rows[0]) throw new Error("ts_lexize returned no row");
  return rows[0].lexemes;
}

async function czechHunspellDictionaryCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM pg_ts_dict WHERE dictname = 'czech_hunspell'",
  );
  return rows[0]?.count ?? 0;
}

/** Seeds the Emails database and indexes one message through the production write path. */
async function indexEmail(pool: Pool, text: string): Promise<{ emailsId: string; itemId: string }> {
  await seedSystem(pool);
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'emails'");
  const emailsId = rows[0]?.id;
  if (!emailsId) throw new Error("Database 'emails' was not seeded");
  const itemId = randomUUID();
  await withTransaction(pool, (client) => reindexItemSearch(client, { itemId, databaseId: emailsId, text }));
  return { emailsId, itemId };
}

async function searchHits(pool: Pool, emailsId: string, query: string): Promise<string[]> {
  const results = await withTransaction(pool, (client) => searchItems(client, { databaseId: emailsId, query }));
  return results.map((r) => r.itemId);
}

describe("Czech Hunspell full-text search (issue #207)", () => {
  it("keeps the unaccent/simple fallback when the migration runs without the assets", async () => {
    await withFreshDatabase(async (pool) => {
      await removeAssets(pool);
      await runMigrations(pool);

      expect(await activateCzechHunspellSearch(pool)).toBe(false);
      expect(await czechHunspellDictionaryCount(pool)).toBe(0);
      expect(await czechVector(pool, "Posílám faktury")).toBe("'faktury':2 'posilam':1");

      const { emailsId, itemId } = await indexEmail(pool, "Posílám faktury");
      expect(await searchHits(pool, emailsId, "posilam faktury")).toEqual([itemId]);
      // No stemming without the dictionary: another inflection of the same word does not match.
      expect(await searchHits(pool, emailsId, "fakturu")).toEqual([]);
    });
  });

  it("lemmatizes inflected Czech terms when the assets exist at migration time", async () => {
    await withFreshDatabase(async (pool) => {
      await installAssets(pool);
      try {
        await runMigrations(pool);

        expect(await lexize(pool, "fakturu")).toEqual(["faktura"]);
        expect(await lexize(pool, "zprávách")).toEqual(["zpráva"]);
        expect(await lexize(pool, "příliš")).toBeNull();
        // Recognized words become their lemma; an unknown one still falls through to unaccent/simple.
        expect(await czechVector(pool, "Příliš faktury")).toBe("'faktura':2 'prilis':1");

        const { emailsId, itemId } = await indexEmail(pool, "Posílám faktury ve zprávách");
        expect(await searchHits(pool, emailsId, "fakturu zpráva")).toEqual([itemId]);
      } finally {
        await removeAssets(pool);
      }
    });
  });

  it("upgrades a database migrated before the assets existed, and repeated activation is a no-op", async () => {
    await withFreshDatabase(async (pool) => {
      await removeAssets(pool);
      await runMigrations(pool);
      const { rows: applied } = await pool.query<{ id: string }>(
        "SELECT id FROM schema_migrations WHERE id = '0046_czech_hunspell_search.sql'",
      );
      expect(applied).toHaveLength(1);
      expect(await czechVector(pool, "faktury")).toBe("'faktury':1");

      await installAssets(pool);
      try {
        expect(await activateCzechHunspellSearch(pool)).toBe(true);
        expect(await lexize(pool, "faktury")).toEqual(["faktura"]);
        expect(await czechVector(pool, "faktury")).toBe("'faktura':1");

        const mappingState = async () =>
          (
            await pool.query<{ state: string }>(
              `SELECT string_agg(m.maptokentype || ':' || m.mapseqno || ':' || m.mapdict || ':' || m.xmin, ','
                 ORDER BY m.maptokentype, m.mapseqno) AS state
               FROM pg_ts_config_map m WHERE m.mapcfg = 'czech'::regconfig`,
            )
          ).rows[0]?.state;
        const before = await mappingState();

        expect(await activateCzechHunspellSearch(pool)).toBe(true);
        expect(await mappingState()).toBe(before);
        expect(await czechHunspellDictionaryCount(pool)).toBe(1);
      } finally {
        await removeAssets(pool);
      }
    });
  });
});
