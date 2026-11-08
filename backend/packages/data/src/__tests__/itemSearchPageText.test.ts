import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import "../domainWriteHooks.js";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { writePageTextBlocks } from "../testSupport/pageFixtures.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { mutateDoc, mutateDocWithClient } from "../docs/docPersistence.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { recomputeJournalInboxDay } from "../inbox/journalInboxCompute.js";
import { handleItemSearchPageTextTask } from "../search/pageTextJob.js";
import { createApiCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
const taskName = CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT;
const REINDEX = CORE_TASK_NAMES.ITEM_SEARCH_REINDEX_DEPENDENTS;
const DEBOUNCE_MS = 30_000;

interface IndexRow {
  item_id: string;
  vector: string;
  body: string | null;
  page_text: string | null;
}

/*
 * Tenant scope is entered per helper and never around `runOnce`: the queue drain is a system scope, and the
 * production task list enters each job's own tenant from its envelope.
 */
function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}

async function db(key: string): Promise<string> {
  return inTenant(() =>
    withTransaction(pool, async (client) => {
      const database = await getDatabaseByModuleId(client, key);
      if (!database) throw new Error(`Missing fixture database: ${key}`);
      return database.id;
    }),
  );
}
async function task(title = "Stránka"): Promise<{ id: string; databaseId: string }> {
  const databaseId = await db("tasks");
  return inTenant(() => cp.createItem({ databaseId, properties: { name: title } }));
}
async function writePage(itemId: string, texts: string[]): Promise<void> {
  await inTenant(() => writePageTextBlocks(pool, itemId, texts));
}
async function editCanvas(itemId: string): Promise<void> {
  await inTenant(async () => {
    const canvas = await withTransaction(pool, (client) => getOrCreateDoc(client, itemId, "canvas"));
    await mutateDoc(pool, canvas.id, "user", (ydoc) => {
      ydoc.getMap("elements").set("x", 1);
    });
  });
}
async function indexRow(itemId: string): Promise<IndexRow[]> {
  return inTenant(() =>
    withTransaction(pool, async (client) => {
      const result = await client.query<IndexRow>(
        "SELECT item_id, search_vector::text AS vector, body, page_text FROM item_search_index WHERE item_id = $1",
        [itemId],
      );
      return result.rows;
    }),
  );
}
async function pageText(itemId: string): Promise<string | null> {
  return (await indexRow(itemId))[0]?.page_text ?? null;
}
async function bodyOf(itemId: string): Promise<string | null> {
  return (await indexRow(itemId))[0]?.body ?? null;
}
async function matches(client: PoolClient, itemId: string, text: string): Promise<boolean> {
  const result = await client.query<{ matches: boolean }>(
    "SELECT search_vector @@ plainto_tsquery('czech', $2) AS matches FROM item_search_index WHERE item_id = $1",
    [itemId, text],
  );
  return result.rows[0]?.matches ?? false;
}
async function has(itemId: string, text: string): Promise<boolean> {
  return inTenant(() => withTransaction(pool, (client) => matches(client, itemId, text)));
}
/** The queued job's run time, read from Graphile Worker's public `jobs` view. */
async function queuedRunAt(): Promise<Date[]> {
  const result = await admin.query<{ run_at: Date }>(
    "SELECT run_at FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY id",
    [taskName],
  );
  return result.rows.map((row) => row.run_at);
}
/** Drains the queue once with the production API task list. */
async function runPageTextJobs(): Promise<void> {
  const taskList = createApiCoreTaskList(pool, createActionRegistry());
  const handler = taskList[taskName];
  if (!handler) throw new Error("Page-text handler missing from production API task list");
  await runOnce({ pgPool: admin }, { [taskName]: handler });
}
async function journalDay(): Promise<string> {
  const journalDatabaseId = await db("journal");
  return inTenant(async () => {
    const day = await withTransaction(pool, (client) =>
      getOrCreateJournalItem(client, journalDatabaseId, "day", new Date("2026-10-27T12:00:00Z"), "UTC"),
    );
    return day.id;
  });
}
async function addInboxEntry(text: string): Promise<string> {
  const inboxDatabaseId = await db("inbox");
  return inTenant(async () => {
    const entry = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId,
        date: "2026-10-27",
        time: "12:00",
        text,
      }),
    );
    return entry.id;
  });
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  cp = createChokePoint(pool);
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await inTenant(() => seedSystem(pool));
  // Edits are written 60 seconds in the past, so their 30-second debounce has elapsed when the queue is drained.
  // Only `Date` is faked; the database clock and Graphile Worker's polling are untouched.
  const sixtySecondsAgo = Date.now() - 60_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(sixtySecondsAgo);
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("page text search (issue #1658)", () => {
  it("rolls back the page update and its job together", async () => {
    const item = await task();
    const doc = await inTenant(() => withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page")));
    const aborted = new Error("abort edit");
    await expect(
      inTenant(() =>
        withTransaction(pool, async (client) => {
          await mutateDocWithClient(client, doc.id, "user", (ydoc) => ydoc.getMap("test").set("edit", "value"));
          throw aborted;
        }),
      ),
    ).rejects.toBe(aborted);
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);
    const updates = await inTenant(() =>
      withTransaction(pool, (client) =>
        client.query<{ count: string }>("SELECT count(*)::text AS count FROM doc_updates WHERE doc_id = $1", [doc.id]),
      ),
    );
    expect(updates.rows).toEqual([{ count: "0" }]);
  });

  it("adds a transaction's page and item jobs at its commit, the page's with its first edit's run time (R1 D1)", async () => {
    const item = await task("Titulek");
    const doc = await inTenant(() => withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page")));
    const firstEdit = Date.now();
    let queuedInBody: Array<{ task_identifier: string }> | undefined;
    await inTenant(() =>
      withTransaction(pool, async (client) => {
        await mutateDocWithClient(client, doc.id, "user", (ydoc) => ydoc.getMap("test").set("edit", "first"));
        vi.setSystemTime(firstEdit + 10_000);
        await mutateDocWithClient(client, doc.id, "user", (ydoc) => ydoc.getMap("test").set("edit", "second"));
        await updateItemWithClient(client, {
          databaseId: item.databaseId,
          itemId: item.id,
          propertiesPatch: { name: "Nový titulek" },
        });
        // Registered, not yet added: the same transaction sees no job of its own before the flush.
        queuedInBody = (
          await client.query<{ task_identifier: string }>(
            "SELECT task_identifier FROM graphile_worker.jobs WHERE task_identifier = ANY($1::text[])",
            [[taskName, REINDEX]],
          )
        ).rows;
      }),
    );
    expect(queuedInBody).toEqual([]);
    expect(await queuedRunAt()).toEqual([new Date(firstEdit + DEBOUNCE_MS)]);
    const reindex = await admin.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
      [REINDEX],
    );
    expect(reindex.rows).toEqual([{ key: `item-search-reindex:referrers:${item.id}:start` }]);
  });

  it("makes a page's text searchable once its job has run, and stores the converted text", async () => {
    const item = await task();
    await writePage(item.id, ["Zkontrolovat rozpočet projektu"]);
    expect(await has(item.id, "rozpočet")).toBe(false);
    await runPageTextJobs();
    expect(await has(item.id, "rozpočet")).toBe(true);
    expect(await pageText(item.id)).toBe("Zkontrolovat rozpočet projektu");
  });

  it("queues one job for a burst of edits and keeps the first edit's run time", async () => {
    const item = await task();
    const firstEdit = Date.now();
    await writePage(item.id, ["První verze"]);
    vi.setSystemTime(firstEdit + 10_000);
    await writePage(item.id, ["Druhá verze"]);
    vi.setSystemTime(firstEdit + 20_000);
    await writePage(item.id, ["Třetí verze"]);
    expect(await countJobsByIdentifier(admin, taskName)).toBe(1);
    expect(await queuedRunAt()).toEqual([new Date(firstEdit + DEBOUNCE_MS)]);
    await runPageTextJobs();
    // Each edit appends a block; the one job converts the page as it stands when it runs.
    expect(await pageText(item.id)).toBe("První verze Druhá verze Třetí verze");
  });

  it("queues no job for a canvas doc write", async () => {
    const item = await task();
    await editCanvas(item.id);
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);
  });

  it("completes a canvas item's job without writing page text", async () => {
    const item = await task();
    await editCanvas(item.id);
    await inTenant(() => handleItemSearchPageTextTask(pool, { itemId: item.id }));
    expect(await pageText(item.id)).toBeNull();
  });

  it("completes a soft-deleted item's job without writing", async () => {
    const item = await task();
    await writePage(item.id, ["Text smazané stránky"]);
    const before = await indexRow(item.id);
    await inTenant(() => cp.softDeleteItem(item.databaseId, item.id));
    await runPageTextJobs();
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);
    expect(await indexRow(item.id)).toEqual(before);
    expect(await pageText(item.id)).toBeNull();
  });

  it("completes a missing item's job without writing", async () => {
    const countRows = async (): Promise<string> =>
      (await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM item_search_index")).rows[0]!.count;
    const before = await countRows();
    await inTenant(() => handleItemSearchPageTextTask(pool, { itemId: randomUUID() }));
    expect(await countRows()).toBe(before);
  });

  it("completes an Emails item's job without writing", async () => {
    const emailsDatabaseId = await db("emails");
    const email = await inTenant(() =>
      withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: emailsDatabaseId, properties: { name: "Předmět e-mailu" } },
          { allowedSystemKeys: ["name"] },
        ),
      ),
    );
    await writePage(email.id, ["Text e-mailu"]);
    await runPageTextJobs();
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);
    expect(await indexRow(email.id)).toEqual([]);
  });

  it("stores at most 100000 characters of page text", async () => {
    const item = await task();
    await writePage(item.id, ["a".repeat(100_005)]);
    await runPageTextJobs();
    expect((await pageText(item.id))?.length).toBe(100_000);
  });

  it("keeps the stored page text when an item write rebuilds the index row", async () => {
    const item = await task("Titulek");
    await writePage(item.id, ["Uložený text stránky"]);
    await runPageTextJobs();
    await inTenant(() =>
      cp.updateItem({ databaseId: item.databaseId, itemId: item.id, propertiesPatch: { name: "Nový titulek" } }),
    );
    expect(await pageText(item.id)).toBe("Uložený text stránky");
    expect(await has(item.id, "Uložený")).toBe(true);
    expect(await has(item.id, "Nový")).toBe(true);
  });

  it("makes a Journal day searchable by its page and quotes its Inbox entries and page in body", async () => {
    const day = await journalDay();
    await addInboxEntry("Poznámka z inboxu");
    await inTenant(() => recomputeJournalInboxDay(pool, day));
    await writePage(day, ["Klient schválil nabídku"]);
    await runPageTextJobs();
    expect(await has(day, "klient schválil")).toBe(true);
    expect(await has(day, "inboxu")).toBe(true);
    expect(await bodyOf(day)).toBe("Poznámka z inboxu Klient schválil nabídku");
  });

  it("rewrites a Journal day's body when an Inbox entry changes and leaves its page_text unchanged", async () => {
    const day = await journalDay();
    const entry = await addInboxEntry("Poznámka z inboxu");
    await inTenant(() => recomputeJournalInboxDay(pool, day));
    await writePage(day, ["Klient schválil nabídku"]);
    await runPageTextJobs();
    const pageTextBefore = await pageText(day);
    expect(pageTextBefore).toBe("Klient schválil nabídku");

    const inboxDatabaseId = await db("inbox");
    await inTenant(() =>
      cp.updateItem({ databaseId: inboxDatabaseId, itemId: entry, propertiesPatch: { text: "Zavolat instalatérovi" } }),
    );
    await inTenant(() => recomputeJournalInboxDay(pool, day));

    expect(await bodyOf(day)).toBe("Zavolat instalatérovi Klient schválil nabídku");
    expect(await pageText(day)).toBe(pageTextBefore);
  });
});
