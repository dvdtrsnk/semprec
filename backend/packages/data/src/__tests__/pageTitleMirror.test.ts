import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Pool, PoolClient } from "pg";
import { writeBlock } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { countJobsByIdentifier } from "@semprec/queue/testSupport";
import "../domainWriteHooks.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { mutateDoc } from "../docs/docPersistence.js";
import { getOrCreateDoc } from "../docs/docsStore.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { handlePageTitleMirrorTask } from "../docs/pageTitleMirrorJob.js";
import { PAGE_TITLE_MAX_LENGTH } from "../docs/pageTitle.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { createApiCoreTaskList } from "../worker.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
const taskName = CORE_TASK_NAMES.PAGE_TITLE_MIRROR;
const DEBOUNCE_MS = 10_000;

/*
 * Tenant scope is entered per helper and never around `runOnce`: the queue drain is a system scope, and the
 * production task list enters each job's own tenant from its envelope.
 */
function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenant(tenant, fn);
}
function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTenant(() => withTransaction(pool, fn));
}

async function host(name = "Host"): Promise<string> {
  const databaseId = await inTransaction(async (client) => {
    const database = await getDatabaseByModuleId(client, "tasks");
    if (!database) throw new Error("Missing Tasks database");
    return database.id;
  });
  return (await inTenant(() => cp.createItem({ databaseId, properties: { name } }))).id;
}

interface Subpage {
  pageItemId: string;
  blockId: string;
}

async function subpage(parent: string, title: string): Promise<Subpage> {
  const created = await inTransaction((client) =>
    createSubpageWithClient(client, { parent: { itemId: parent }, title }, "user"),
  );
  const page = created.pages[0];
  if (!page) throw new Error("Missing page");
  return page;
}

/** Types `text` as the title of the page block `blockId`, the way a sync client does: through the block's Y.Text. */
async function typeTitle(parent: string, blockId: string, text: string): Promise<void> {
  await inTenant(async () => {
    const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, parent, "page"));
    await mutateDoc(pool, doc.id, "user", (ydoc) => {
      const block = ydoc.getMap<Y.Map<unknown>>("blocks").get(blockId);
      const title = block?.get("text");
      if (!(title instanceof Y.Text)) throw new Error(`Block ${blockId} has no text`);
      title.delete(0, title.length);
      title.insert(0, text);
    });
  });
}

async function titleOf(itemId: string): Promise<string | undefined> {
  return inTransaction(async (client) => {
    const { rows } = await client.query<{ title: string | null }>(
      `SELECT properties->>'title' AS title FROM items WHERE id = $1`,
      [itemId],
    );
    return rows[0]?.title ?? undefined;
  });
}

async function trash(itemId: string): Promise<void> {
  const databaseId = await inTransaction(async (client) => {
    const { rows } = await client.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [
      itemId,
    ]);
    const row = rows[0];
    if (!row) throw new Error(`Missing item ${itemId}`);
    return row.database_id;
  });
  await inTenant(() => cp.softDeleteItem(databaseId, itemId));
}

async function versionOf(itemId: string): Promise<string | undefined> {
  return inTransaction(async (client) => {
    const { rows } = await client.query<{ updated_at: Date }>(`SELECT updated_at FROM items WHERE id = $1`, [itemId]);
    return rows[0]?.updated_at.toISOString();
  });
}

/** The queued jobs' run times, read from Graphile Worker's public `jobs` view (which has no payload column). */
async function queuedJobs(): Promise<Array<{ key: string | null; run_at: Date }>> {
  const result = await admin.query<{ key: string | null; run_at: Date }>(
    "SELECT key, run_at FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY id",
    [taskName],
  );
  return result.rows;
}

/** Drains the queue once with the production API task list, as the worker does. */
async function runMirrorJobs(): Promise<void> {
  const handler = createApiCoreTaskList(pool, createActionRegistry())[taskName];
  if (!handler) throw new Error("The mirror handler is missing from the production API task list");
  await runOnce({ pgPool: admin }, { [taskName]: handler });
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
  // Edits are written 60 seconds in the past, so their 10-second debounce has elapsed when the queue is drained.
  // Only `Date` is faked; the database clock and Graphile Worker's polling are untouched.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - 60_000);
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("subpage title mirror (issue #1715)", () => {
  it("copies a title typed in the parent onto the Pages item once the job has run", async () => {
    const parent = await host();
    const page = await subpage(parent, "Old title");
    await typeTitle(parent, page.blockId, "New title");
    expect(await titleOf(page.pageItemId)).toBe("Old title");

    await runMirrorJobs();

    expect(await titleOf(page.pageItemId)).toBe("New title");
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);
  });

  it("queues one job for a burst of edits and keeps the first edit's run time", async () => {
    const parent = await host();
    const firstEdit = Date.now();
    const page = await subpage(parent, "One");
    vi.setSystemTime(firstEdit + 4_000);
    await typeTitle(parent, page.blockId, "Two");
    vi.setSystemTime(firstEdit + 8_000);
    await typeTitle(parent, page.blockId, "Three");

    expect(await countJobsByIdentifier(admin, taskName)).toBe(1);
    expect(await queuedJobs()).toEqual([
      { key: `page-title-mirror:${parent}`, run_at: new Date(firstEdit + DEBOUNCE_MS) },
    ]);
    await runMirrorJobs();
    expect(await titleOf(page.pageItemId)).toBe("Three");
  });

  it("queues no job for a canvas document write, and none for an edit that rolls back", async () => {
    const item = await host();
    await inTenant(async () => {
      const canvas = await withTransaction(pool, (client) => getOrCreateDoc(client, item, "canvas"));
      await mutateDoc(pool, canvas.id, "user", (ydoc) => ydoc.getMap("elements").set("x", 1));
    });
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);

    const parent = await host("Rolled back");
    const aborted = new Error("abort edit");
    await expect(
      inTransaction(async (client) => {
        await createSubpageWithClient(client, { parent: { itemId: parent }, title: "Never" }, "user");
        throw aborted;
      }),
    ).rejects.toBe(aborted);
    expect(await countJobsByIdentifier(admin, taskName)).toBe(0);
  });

  it("stores a title with a line break with a space, and cuts an over-long title instead of failing", async () => {
    const parent = await host();
    const lineBreak = await subpage(parent, "A");
    const tooLong = await subpage(parent, "B");
    await typeTitle(parent, lineBreak.blockId, "Line one\nline two");
    await typeTitle(parent, tooLong.blockId, "x".repeat(PAGE_TITLE_MAX_LENGTH + 100));

    await runMirrorJobs();

    expect(await titleOf(lineBreak.pageItemId)).toBe("Line one line two");
    expect(await titleOf(tooLong.pageItemId)).toBe("x".repeat(PAGE_TITLE_MAX_LENGTH));
  });

  it("writes nothing for a trashed page, a page of another parent, an unknown id or an item of another database", async () => {
    const parent = await host("Parent");
    const other = await host("Other parent");
    const trashed = await subpage(parent, "Trashed original");
    const foreign = await subpage(other, "Foreign original");
    const unrelated = await host("Unrelated item");
    await trash(trashed.pageItemId);
    const mirrored = await subpage(parent, "Mirrored original");

    // The parent document holds page blocks for each of them, all retitled by hand (a sync client may write any pageId).
    await inTenant(async () => {
      const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, parent, "page"));
      await mutateDoc(pool, doc.id, "user", (ydoc) => {
        for (const [blockId, pageId] of [
          ["to-trashed", trashed.pageItemId],
          ["to-foreign", foreign.pageItemId],
          ["to-unknown", randomUUID()],
          ["to-unrelated", unrelated],
          ["to-malformed", "not-a-uuid"],
        ] as const) {
          writeBlock(ydoc, { id: blockId, type: "page", pageId, text: "Hijacked" });
        }
      });
    });
    await typeTitle(parent, mirrored.blockId, "Mirrored new");
    const versions = await Promise.all([trashed.pageItemId, foreign.pageItemId, unrelated].map(versionOf));

    await runMirrorJobs();

    expect(await titleOf(mirrored.pageItemId)).toBe("Mirrored new");
    expect(await titleOf(trashed.pageItemId)).toBe("Trashed original");
    expect(await titleOf(foreign.pageItemId)).toBe("Foreign original");
    expect(await titleOf(unrelated)).toBeUndefined();
    expect(await Promise.all([trashed.pageItemId, foreign.pageItemId, unrelated].map(versionOf))).toEqual(versions);
  });

  it("leaves an item whose title already equals the block text untouched", async () => {
    const parent = await host();
    const page = await subpage(parent, "Same");
    const before = await versionOf(page.pageItemId);
    await typeTitle(parent, page.blockId, "Same");
    await runMirrorJobs();
    expect(await versionOf(page.pageItemId)).toBe(before);
  });

  it("completes without writing for a missing item, a trashed item, an item without a page and a tenant without Pages", async () => {
    const trashedParent = await host("Trashed parent");
    const page = await subpage(trashedParent, "Kept");
    await typeTitle(trashedParent, page.blockId, "Changed");
    await trash(trashedParent);
    const noPage = await host("No page");
    const before = await versionOf(page.pageItemId);

    for (const itemId of [randomUUID(), trashedParent, noPage]) {
      await inTenant(() => handlePageTitleMirrorTask(pool, { itemId }));
    }
    expect(await titleOf(page.pageItemId)).toBe("Kept");
    expect(await versionOf(page.pageItemId)).toBe(before);

    // A tenant that never created a subpage has no Pages database: its job completes without looking further.
    const otherTenant = await createTestTenant(admin);
    const otherItem = await runInTenant(otherTenant, async () => {
      const chokePoint = createChokePoint(pool);
      const database = await chokePoint.createDatabase({ name: "Other tenant" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      await withTransaction(pool, (client) => getOrCreateDoc(client, item.id, "page"));
      return item.id;
    });
    await runInTenant(otherTenant, () => handlePageTitleMirrorTask(pool, { itemId: otherItem }));
  });

  it("refuses a payload with an extra key or a non-UUID item id", async () => {
    await expect(handlePageTitleMirrorTask(pool, { itemId: "nope" })).rejects.toThrow();
    await expect(handlePageTitleMirrorTask(pool, { itemId: randomUUID(), extra: true })).rejects.toThrow();
  });
});
