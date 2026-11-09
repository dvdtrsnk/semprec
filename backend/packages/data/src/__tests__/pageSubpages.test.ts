import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { readPageBlocks, type PageBlock } from "@semprec/block-model";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { insertItem, softDeleteItem } from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient } from "../docs/docPersistence.js";
import { createDocStore } from "../docs/docStore.js";
import { createSubpageWithClient } from "../docs/pageOperations.js";
import { ensurePagesDatabase, PAGES_MODULE_ID } from "../docs/pagesDatabase.js";
import { PAGE_TITLE_MAX_LENGTH } from "../docs/pageTitle.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  writePageTextBlocks,
} from "../testSupport/testDb.js";
import type { CreatedBy } from "../types.js";
import type { PageCreateSubpageInput, PageCreateSubpageOutput } from "@semprec/shared";

let admin: Pool;
let runtime: Pool;
let tenant: string;

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await runInTenant(tenant, () => seedSystem(runtime));
});
afterAll(async () => {
  const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
});

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

function createSubpage(input: PageCreateSubpageInput, origin: CreatedBy = "user"): Promise<PageCreateSubpageOutput> {
  return inTenant((client) => createSubpageWithClient(client, input, origin));
}

async function readBlocks(itemId: string): Promise<PageBlock[]> {
  return inTenant(async (client) => {
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM docs WHERE item_id = $1`, [itemId]);
    const docRow = rows[0];
    if (!docRow) throw new Error(`Item ${itemId} has no document`);
    const doc = await loadDocWithClient(client, docRow.id);
    try {
      return readPageBlocks(doc).filter((block) => !block.synthetic);
    } finally {
      doc.destroy();
    }
  });
}

interface WriteCounts {
  pagesDatabases: number;
  pagesItems: number;
  docs: number;
  docUpdates: number;
  journalItems: number;
}

/** What a refused call must leave exactly as it found it, read inside the tenant. */
async function writeCounts(tenantId = tenant): Promise<WriteCounts> {
  return inTenant(async (client) => {
    const { rows } = await client.query<WriteCounts>(
      `SELECT (SELECT count(*)::int FROM databases WHERE owner_module_id = $1) AS "pagesDatabases",
              (SELECT count(*)::int FROM items i JOIN databases d ON d.id = i.database_id WHERE d.owner_module_id = $1) AS "pagesItems",
              (SELECT count(*)::int FROM docs) AS docs,
              (SELECT count(*)::int FROM doc_updates) AS "docUpdates",
              (SELECT count(*)::int FROM items i JOIN databases d ON d.id = i.database_id WHERE d.owner_module_id = 'journal') AS "journalItems"`,
      [PAGES_MODULE_ID],
    );
    const row = rows[0];
    if (!row) throw new Error("Missing counts");
    return row;
  }, tenantId);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to be rejected");
}

/** The `resource` field of a not-found error's details, read without assuming the details' shape. */
function detailsResource(details: unknown): unknown {
  return typeof details === "object" && details !== null && "resource" in details ? details.resource : undefined;
}

describe("page.createSubpage (issue #1676)", () => {
  it("creates the Pages item, its document and a page block after the requested block, authored by the caller", async () => {
    const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
    await runInTenant(tenant, () => writePageTextBlocks(runtime, project, ["first", "second", "third"]));
    const before = await readBlocks(project);
    const [first, second] = before;
    if (!first?.id || !second?.id) throw new Error("Missing seed blocks");

    const created = await createSubpage({
      parent: { itemId: project },
      afterBlockId: first.id,
      title: "  Notes\r\nfor 0.4 ",
    });

    expect(created.pages).toHaveLength(1);
    const [page] = created.pages;
    if (!page) throw new Error("Missing page");
    const blocks = await readBlocks(project);
    expect(blocks.map((block) => block.id)).toEqual([first.id, page.blockId, second.id, before[2]?.id]);
    expect(blocks[1]).toMatchObject({
      type: "page",
      pageId: page.pageItemId,
      text: [{ insert: "Notes for 0.4" }],
    });

    const stored = await inTenant(async (client) => {
      const item = await client.query<{ properties: Record<string, unknown>; database_id: string }>(
        `SELECT properties, database_id FROM items WHERE id = $1`,
        [page.pageItemId],
      );
      const doc = await client.query<{ id: string; kind: string }>(`SELECT id, kind FROM docs WHERE item_id = $1`, [
        page.pageItemId,
      ]);
      const parentUpdates = await client.query<{ created_by: string }>(
        `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id`,
        [project],
      );
      const pageUpdates = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM doc_updates u WHERE u.doc_id = $1`,
        [page.docId],
      );
      return { item: item.rows[0], doc: doc.rows, parentUpdates: parentUpdates.rows, pageUpdates: pageUpdates.rows[0] };
    });
    expect(stored.item?.properties).toEqual({ title: "Notes for 0.4", parentItemId: project });
    expect(stored.doc).toEqual([{ id: page.docId, kind: "page" }]);
    expect(stored.pageUpdates?.n).toBe(0);
    expect(stored.parentUpdates.at(-1)?.created_by).toBe("user");

    // Without afterBlockId the block goes to the end, and an agent caller's origin is stored on the update.
    const appended = await createSubpage({ parent: { itemId: project }, title: "Appended" }, "ai_agent");
    const appendedBlockId = appended.pages[0]?.blockId;
    expect((await readBlocks(project)).at(-1)?.id).toBe(appendedBlockId);
    const lastUpdate = await inTenant(async (client) => {
      const { rows } = await client.query<{ created_by: string }>(
        `SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1 ORDER BY u.id DESC LIMIT 1`,
        [project],
      );
      return rows[0]?.created_by;
    });
    expect(lastUpdate).toBe("ai_agent");
  });

  it("creates a subpage under a host with no document yet, and an empty title is valid", async () => {
    const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
    const created = await createSubpage({ parent: { itemId: project } });
    const [page] = created.pages;
    if (!page) throw new Error("Missing page");
    const blocks = await readBlocks(project);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: page.blockId, type: "page", pageId: page.pageItemId, text: [] });
  });

  it("creates the hidden Pages database on first use with its two system-owned properties, locked", async () => {
    const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
    expect((await writeCounts()).pagesDatabases).toBe(0);
    await createSubpage({ parent: { itemId: project }, title: "One" });
    const database = await inTenant(async (client) => {
      const db = await client.query<{
        id: string;
        name: string | null;
        key: string | null;
        system: boolean;
        schema_locked: boolean;
        owner_module_id: string | null;
      }>(`SELECT id, name, key, system, schema_locked, owner_module_id FROM databases WHERE key = 'pages'`);
      const properties = await client.query<{ key: string; type: string; owner: string; owner_process: string | null }>(
        `SELECT key, type, owner, owner_process FROM properties WHERE database_id = $1 ORDER BY key`,
        [db.rows[0]?.id],
      );
      return { db: db.rows, properties: properties.rows };
    });
    expect(database.db).toEqual([
      expect.objectContaining({
        name: null,
        key: "pages",
        system: true,
        schema_locked: true,
        owner_module_id: PAGES_MODULE_ID,
      }),
    ]);
    expect(database.properties).toEqual([
      { key: "parentItemId", type: "text", owner: "system", owner_process: PAGES_MODULE_ID },
      { key: "title", type: "title", owner: "system", owner_process: PAGES_MODULE_ID },
    ]);

    // A second call finds the database instead of creating another one.
    await createSubpage({ parent: { itemId: project }, title: "Two" });
    expect((await writeCounts()).pagesDatabases).toBe(1);
    const again = await inTenant((client) => ensurePagesDatabase(client));
    expect(again.id).toBe(database.db[0]?.id ?? "");
  });

  it("creates the Journal day, its page and the subpage in one transaction, and a failure leaves none of them", async () => {
    const before = await writeCounts();
    const created = await createSubpage({
      parent: { journal: { type: "day", period: "2026-10-16" } },
      title: "Plan of the day",
    });
    const [page] = created.pages;
    if (!page) throw new Error("Missing page");
    const day = await inTenant(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id
         WHERE d.owner_module_id = 'journal' AND i.properties->>'period' = '2026-10-16' AND i.deleted_at IS NULL`,
      );
      return rows;
    });
    expect(day).toHaveLength(1);
    const dayBlocks = await readBlocks(day[0]!.id);
    expect(dayBlocks).toMatchObject([{ id: page.blockId, type: "page", pageId: page.pageItemId }]);
    const after = await writeCounts();
    expect(after.journalItems).toBe(before.journalItems + 1);
    expect(after.pagesItems).toBe(before.pagesItems + 1);

    // The block cannot be placed, so the day created for it, the Pages database and the Pages item roll back.
    const failedBefore = await writeCounts();
    const error = await rejection(
      createSubpage({
        parent: { journal: { type: "day", period: "2026-10-17" } },
        afterBlockId: "no-such-block",
      }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { field: "afterBlockId" } });
    expect(await writeCounts()).toEqual(failedBefore);
    const failedDay = await inTenant((client) =>
      client.query(`SELECT 1 FROM items WHERE properties->>'period' = '2026-10-17'`),
    );
    expect(failedDay.rows).toHaveLength(0);
  });

  it("refuses an invalid Journal period key with nothing written", async () => {
    const before = await writeCounts();
    const error = await rejection(createSubpage({ parent: { journal: { type: "day", period: "2026-13-45" } } }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(await writeCounts()).toEqual(before);
  });

  describe("rejections write nothing", () => {
    async function expectRejectedUnchanged(
      input: PageCreateSubpageInput,
      expected: { type: typeof ValidationError | typeof NotFoundError; details?: Record<string, unknown> },
    ): Promise<unknown> {
      const before = await writeCounts();
      const error = await rejection(createSubpage(input));
      expect(error).toBeInstanceOf(expected.type);
      if (expected.details) expect(error).toMatchObject({ details: expected.details });
      expect(await writeCounts()).toEqual(before);
      return error;
    }

    it("an unknown afterBlockId", async () => {
      const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
      await runInTenant(tenant, () => writePageTextBlocks(runtime, project, ["only"]));
      const before = await readBlocks(project);
      await expectRejectedUnchanged(
        { parent: { itemId: project }, afterBlockId: randomUUID() },
        { type: ValidationError, details: { field: "afterBlockId" } },
      );
      expect(await readBlocks(project)).toEqual(before);
    });

    it("a title over the limit, while a title of exactly the limit is accepted", async () => {
      const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
      await expectRejectedUnchanged(
        { parent: { itemId: project }, title: "x".repeat(PAGE_TITLE_MAX_LENGTH + 1) },
        { type: ValidationError, details: { field: "title" } },
      );
      const accepted = await createSubpage({ parent: { itemId: project }, title: "x".repeat(PAGE_TITLE_MAX_LENGTH) });
      expect(accepted.pages).toHaveLength(1);
    });

    it("a trashed parent", async () => {
      const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
      await inTenant(async (client) => {
        const { rows } = await client.query<{ database_id: string }>(`SELECT database_id FROM items WHERE id = $1`, [
          project,
        ]);
        await softDeleteItem(client, rows[0]!.database_id, project);
      });
      await expectRejectedUnchanged({ parent: { itemId: project } }, { type: NotFoundError });
    });

    it("a foreign parent, answered exactly like an unknown one", async () => {
      const otherTenant = await createTestTenant(admin);
      const foreign = await inTenant(async (client) => {
        const database = await createDatabase(client, { name: "Foreign" });
        return (await insertItem(client, { databaseId: database.id, properties: {} })).id;
      }, otherTenant);
      const foreignError = await expectRejectedUnchanged({ parent: { itemId: foreign } }, { type: NotFoundError });
      const unknownError = await expectRejectedUnchanged({ parent: { itemId: randomUUID() } }, { type: NotFoundError });
      const shape = (error: unknown): unknown =>
        error instanceof NotFoundError
          ? {
              status: error.status,
              code: error.code,
              message: error.message,
              resource: detailsResource(error.details),
            }
          : error;
      expect(shape(foreignError)).toEqual(shape(unknownError));
      // The foreign tenant's own item is unharmed and still has no page.
      expect((await writeCounts(otherTenant)).docs).toBe(0);
    });

    it("a stored parent cycle", async () => {
      const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
      const first = (await createSubpage({ parent: { itemId: project }, title: "First" })).pages[0];
      const second = first && (await createSubpage({ parent: { itemId: first.pageItemId }, title: "Second" })).pages[0];
      if (!first || !second) throw new Error("Missing pages");
      // The API never reparents a page, so a cycle cannot be built through it; this superuser write stands in for
      // corrupted or hand-edited data, which is the case the walk must survive.
      await admin.query(
        `UPDATE items SET properties = jsonb_set(properties, '{parentItemId}', to_jsonb($2::text)) WHERE id = $1`,
        [first.pageItemId, second.pageItemId],
      );
      await expectRejectedUnchanged(
        { parent: { itemId: second.pageItemId } },
        { type: ValidationError, details: { field: "parent" } },
      );
    });

    it("a parent chain longer than 1000, while a chain of exactly 1000 is accepted", async () => {
      const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
      const first = (await createSubpage({ parent: { itemId: project }, title: "Chain head" })).pages[0];
      if (!first) throw new Error("Missing page");
      const pagesDatabase = await inTenant((client) => ensurePagesDatabase(client));
      // A 1001-deep chain would take 1001 API calls; this superuser insert builds it with one statement. Page 1's
      // parent is the head created above, so the head is page 0 and page n has chain length n + 1.
      const { rows } = await admin.query<{ id: string; label: string }>(
        `WITH chain AS (
           SELECT n, gen_random_uuid() AS id FROM generate_series(1, 1000) AS n
         ), linked AS (
           SELECT c.n, c.id, COALESCE(p.id::text, $2::text) AS parent FROM chain c LEFT JOIN chain p ON p.n = c.n - 1
         )
         INSERT INTO items (id, database_id, properties)
         SELECT id, $1, jsonb_build_object('title', 'p' || n, 'parentItemId', parent) FROM linked
         RETURNING id, properties->>'title' AS label`,
        [pagesDatabase.id, first.pageItemId],
      );
      expect(rows).toHaveLength(1000);
      const byLabel = new Map(rows.map((row) => [row.label, row.id]));
      const tail = byLabel.get("p1000");
      const next = byLabel.get("p999");
      if (!tail || !next) throw new Error("Missing chain ends");
      // The tail is the 1001st page of the chain (head plus 1000), the page below it the 1000th.
      await expectRejectedUnchanged(
        { parent: { itemId: tail } },
        { type: ValidationError, details: { field: "parent" } },
      );
      const accepted = await createSubpage({ parent: { itemId: next }, title: "Deep but allowed" });
      expect(accepted.pages).toHaveLength(1);
    });
  });

  it("creates exactly one Pages database when the first two calls of a tenant run concurrently", async () => {
    const [projectA, projectB] = await runInTenant(tenant, async () => [
      await createTestProjectItem(runtime),
      await createTestProjectItem(runtime),
    ]);
    if (!projectA || !projectB) throw new Error("Missing projects");
    // One open transaction holds the creation lock after creating the database, uncommitted. The two calls queue
    // on the lock, see no database before it, and must find the committed one after it instead of creating another.
    const holder = await runtime.connect();
    let held = false;
    try {
      await holder.query("BEGIN");
      held = true;
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      await ensurePagesDatabase(holder);
      const calls = [
        createSubpage({ parent: { itemId: projectA }, title: "A" }),
        createSubpage({ parent: { itemId: projectB }, title: "B" }),
      ];
      const settled = Promise.allSettled(calls);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await admin.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        if ((rows[0]?.waiting ?? 0) >= 2) break;
        if (Date.now() > deadline) throw new Error("The two calls never queued on the creation lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await holder.query("COMMIT");
      held = false;
      const outcomes = await settled;
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      try {
        if (held) await holder.query("ROLLBACK");
      } finally {
        holder.release();
      }
    }
    const counts = await writeCounts();
    expect(counts.pagesDatabases).toBe(1);
    expect(counts.pagesItems).toBe(2);
  });

  it("reports subpageCount 2 for a project whose root holds two page blocks", async () => {
    const project = await runInTenant(tenant, () => createTestProjectItem(runtime));
    await createSubpage({ parent: { itemId: project }, title: "One" });
    await createSubpage({ parent: { itemId: project }, title: "Two" });
    const summary = await runInTenant(tenant, () => createDocStore(runtime).getPageSummary(project, "en"));
    expect(summary.subpageCount).toBe(2);
    expect(summary.blocks.map((block) => block.type)).toEqual(["page", "page"]);
  });
});
