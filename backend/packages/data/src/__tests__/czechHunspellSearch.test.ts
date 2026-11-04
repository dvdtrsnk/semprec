import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, ensureQueueSchema, grantQueueSchemaPrivileges, runOnce } from "@semprec/queue";
import { runMigrations } from "../db/migrate.js";
import { createPool, withTransaction } from "../db/pool.js";
import { activateCzechHunspellSearch } from "../mail/czechHunspellSearch.js";
import { reindexItemSearch, searchItems } from "../mail/search.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { buildItemSearchQuery } from "../search/itemSearchQuery.js";
import { indexItem } from "../search/itemSearchIndexer.js";
import { handleItemSearchBackfillTask, runItemSearchBackfillCutover } from "../search/itemSearchBackfill.js";
import { createApiCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import "../domainWriteHooks.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "czech-hunspell");
const ASSET_FILES = ["cs_cz.dict", "cs_cz.affix"];
// Each test creates and fully migrates its own database; late in the integration run that
// competes with the instance's checkpoint I/O and can take well past the default 30 s.
const FRESH_DATABASE_TEST_TIMEOUT_MS = 120_000;

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
  // createPool (not `new Pool`) so a connection this test's own DROP DATABASE ... FORCE
  // races against a client mid-teardown gets pool.ts's 'error' handler, not an unhandled
  // EventEmitter exception that crashes the run.
  const admin = createPool(testDatabaseUrl());
  // UTF8 like production: the embedded instance's template1 is SQL_ASCII, which the text
  // search parser cannot split Czech words in.
  try {
    await admin.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0`);
  } catch (createError) {
    // admin stays open on success for the cleanup's DROP DATABASE; here nothing will use it again.
    try {
      await admin.end();
    } catch {
      // The CREATE DATABASE rejection below is the real failure; a failed pool teardown must not replace it.
    }
    throw createError;
  }
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  let failure: { error: unknown } | undefined;
  try {
    await fn(pool);
  } catch (error) {
    failure = { error };
  }
  // Every step runs even when an earlier one rejects, so the database is dropped and both
  // pools are released; fn's own error wins over cleanup errors, otherwise the first cleanup error.
  const cleanup = [() => pool.end(), () => admin.query(`DROP DATABASE "${name}" WITH (FORCE)`), () => admin.end()];
  for (const step of cleanup) {
    try {
      await step();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
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
  const dictPath = path.join(dir, "cs_cz.dict");
  const affixPath = path.join(dir, "cs_cz.affix");
  const dict = await readFile(dictPath, "utf8");
  const affix = await readFile(affixPath, "utf8");
  await writeFile(dictPath, dict.replace(/^2\n/, "3\n") + "koupelna/Z\n");
  await writeFile(affixPath, affix.replace("SFX Z Y 7", "SFX Z Y 8") + "\nSFX Z   a           ě          na\n");
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
  const { rows } = await pool.query<{ lexemes: string[] | null }>("SELECT ts_lexize('czech_hunspell', $1) AS lexemes", [
    word,
  ]);
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
  // The scratch database's own tenant zero: strict `app_tenant_default()` (#1067) needs a scope.
  const { rows: tenants } = await pool.query<{ id: string }>("SELECT id FROM tenants");
  const tenantId = tenants[0]?.id;
  if (!tenantId) throw new Error("The scratch database has no tenant");
  return runInTenant(tenantId, async () => {
    await seedSystem(pool);
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'emails'");
    const emailsId = rows[0]?.id;
    if (!emailsId) throw new Error("Database 'emails' was not seeded");
    const itemId = (
      await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: emailsId, properties: {} }))
    ).id;
    await withTransaction(pool, (client) => reindexItemSearch(client, { itemId, databaseId: emailsId, text }));
    return { emailsId, itemId };
  });
}

async function searchHits(pool: Pool, emailsId: string, query: string): Promise<string[]> {
  const results = await withTransaction(pool, (client) => searchItems(client, { databaseId: emailsId, query }));
  return results.map((r) => r.itemId);
}

describe("Czech Hunspell full-text search (issue #207)", () => {
  it(
    "rebuilds pre-activation vectors without losing stored page projections",
    async () => {
      await withFreshDatabase(async (pool) => {
        await removeAssets(pool);
        await runMigrations(pool);
        await ensureQueueSchema(pool);
        const tenants = await pool.query<{ id: string }>("SELECT id FROM tenants");
        const tenantId = tenants.rows[0]?.id;
        if (!tenantId) throw new Error("Missing tenant");
        await runInTenant(tenantId, async () => {
          await seedSystem(pool);
          const files = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "files"));
          if (!files) throw new Error("Missing Files database");
          const cp = createChokePoint(pool);
          const invoice = await cp.createItem({ databaseId: files.id, properties: { name: "Faktura_2026-10.pdf" } });
          const bathroom = await cp.createItem({ databaseId: files.id, properties: { name: "Rekonstrukce koupelny" } });
          const both = await cp.createItem({ databaseId: files.id, properties: { name: "Faktura koupelně" } });
          const unrelated = await cp.createItem({ databaseId: files.id, properties: { name: "Smlouva_2026.pdf" } });
          await withTransaction(pool, (client) => indexItem(client, invoice.id, { pageText: "Retained page text" }));
          const search = async (text: string): Promise<string[]> => {
            const query = buildItemSearchQuery(text, 2);
            // The fragment contains only validated parameter positions; input remains bound.
            const { rows } = await withTransaction(pool, (client) =>
              client.query<{ item_id: string }>(
                `SELECT item_id FROM item_search_index WHERE database_id = $1 AND search_vector @@ ${query.sql} ORDER BY item_id`,
                [files.id, ...query.params],
              ),
            );
            return rows.map((row) => row.item_id);
          };
          expect(await search("faktury")).not.toContain(invoice.id);
          const projection = async () =>
            (
              await withTransaction(pool, (client) =>
                client.query<{ body: string; page_text: string }>(
                  "SELECT body, page_text FROM item_search_index WHERE item_id = $1",
                  [invoice.id],
                ),
              )
            ).rows;
          const beforeMigration = await projection();
          // Synthetic pre-0133 catalog state: no prior release binary can create it in this harness.
          await pool.query("DROP TEXT SEARCH CONFIGURATION czech_simple");
          const removed = await pool.query("DELETE FROM schema_migrations WHERE id = $1", [
            "0133_czech_simple_search_config.sql",
          ]);
          expect(removed.rowCount).toBe(1);
          await runMigrations(pool);
          expect(await projection()).toEqual(beforeMigration);
          await installAssets(pool);
          try {
            expect(await activateCzechHunspellSearch(pool)).toBe(true);
            await handleItemSearchBackfillTask(pool, { onlyMissing: false });
            expect(await search("faktury")).toContain(invoice.id);
            expect(await search("fak")).toContain(invoice.id);
            expect(await search("faktury")).not.toContain(unrelated.id);
            expect(await search("koupelně")).toContain(bathroom.id);
            expect(await search("faktury koupelne")).toContain(both.id);
            const result = await withTransaction(pool, (client) =>
              client.query<{ body: string; page_text: string }>(
                "SELECT body, page_text FROM item_search_index WHERE item_id = $1",
                [invoice.id],
              ),
            );
            expect(result.rows[0]).toEqual({ body: "Retained page text", page_text: "Retained page text" });
          } finally {
            await removeAssets(pool);
          }
        });
      });
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );

  it(
    "re-enqueues the full rebuild after a queue-readiness failure",
    async () => {
      await withFreshDatabase(async (pool) => {
        await removeAssets(pool);
        await runMigrations(pool);
        await ensureQueueSchema(pool);
        const { rows: tenants } = await pool.query<{ id: string }>("SELECT id FROM tenants");
        const tenantId = tenants[0]?.id;
        if (!tenantId) throw new Error("Missing tenant");
        await runInTenant(tenantId, () => seedSystem(pool));
        const files = await runInTenant(tenantId, () =>
          withTransaction(pool, (client) => getDatabaseByModuleId(client, "files")),
        );
        if (!files) throw new Error("Missing Files database");
        const item = await runInTenant(tenantId, () =>
          createChokePoint(pool).createItem({ databaseId: files.id, properties: { name: "Faktura" } }),
        );
        const { rows: dbs } = await pool.query<{ name: string }>("SELECT current_database() AS name");
        const databaseName = dbs[0]?.name;
        if (!databaseName) throw new Error("Missing scratch database name");
        const url = new URL(testDatabaseUrl());
        url.pathname = `/${databaseName}`;
        const runtime = createPool(url.toString(), { role: "semprec_data" });
        try {
          await installAssets(pool);
          expect(await activateCzechHunspellSearch(pool)).toBe(true);
          // This disposable database has no production caller capable of removing the queue schema.
          await pool.query("DROP SCHEMA graphile_worker CASCADE");
          await expect(
            runAsSystem("test failed deploy", () => runItemSearchBackfillCutover(runtime, false)),
          ).rejects.toThrow();
          await ensureQueueSchema(pool);
          await grantQueueSchemaPrivileges(pool);
          await runAsSystem("test successful redeploy", () => runItemSearchBackfillCutover(runtime, false));
          const taskName = CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL;
          const handler = createApiCoreTaskList(runtime, createActionRegistry())[taskName];
          if (!handler) throw new Error("Missing item search task");
          await runOnce({ pgPool: pool }, { [taskName]: handler });
          await runInTenant(tenantId, async () => {
            const query = buildItemSearchQuery("faktury", 2);
            // The fragment contains only validated parameter positions; input remains bound.
            const { rows } = await withTransaction(runtime, (client) =>
              client.query<{ matched: boolean }>(
                `SELECT search_vector @@ ${query.sql} AS matched FROM item_search_index WHERE item_id = $1`,
                [item.id, ...query.params],
              ),
            );
            expect(rows[0]?.matched).toBe(true);
          });
        } finally {
          await runtime.end();
          await removeAssets(pool);
        }
      });
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the unaccent/simple fallback when the migration runs without the assets",
    async () => {
      await withFreshDatabase(async (pool) => {
        await removeAssets(pool);
        await runMigrations(pool);
        await ensureQueueSchema(pool);

        expect(await activateCzechHunspellSearch(pool)).toBe(false);
        expect(await czechHunspellDictionaryCount(pool)).toBe(0);
        expect(await czechVector(pool, "Posílám faktury")).toBe("'faktury':2 'posilam':1");

        const { emailsId, itemId } = await indexEmail(pool, "Posílám faktury");
        expect(await searchHits(pool, emailsId, "posilam faktury")).toEqual([itemId]);
        // No stemming without the dictionary: another inflection of the same word does not match.
        expect(await searchHits(pool, emailsId, "fakturu")).toEqual([]);
      });
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );

  it(
    "lemmatizes inflected Czech terms when the assets exist at migration time",
    async () => {
      await withFreshDatabase(async (pool) => {
        await installAssets(pool);
        try {
          await runMigrations(pool);
          await ensureQueueSchema(pool);

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
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );

  it(
    "upgrades a database migrated before the assets existed, and repeated activation is a no-op",
    async () => {
      await withFreshDatabase(async (pool) => {
        await removeAssets(pool);
        await runMigrations(pool);
        await ensureQueueSchema(pool);
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
    },
    FRESH_DATABASE_TEST_TIMEOUT_MS,
  );
});
