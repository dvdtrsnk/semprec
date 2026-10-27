import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_AFFINITY, CORE_TASK_NAMES, TASK_TENANCY, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import "../domainWriteHooks.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getItemById, softDeleteItem } from "../chokePoint/itemsStore.js";
import { createUser } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { recomputeJournalInboxDay } from "../inbox/journalInboxCompute.js";
import { reindexItemSearch } from "../mail/search.js";
import { indexItem } from "../search/itemSearchIndexer.js";
import {
  enqueueItemSearchBackfill,
  handleItemSearchBackfillTask,
  runItemSearchBackfillCutover,
} from "../search/itemSearchBackfill.js";
import { createApiCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { manifest } from "../seed/systemDatabasesModuleManifest.js";

let admin: Pool;
let pool: Pool;
let cp: ChokePoint;
let tenant: string;
const taskName = CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL;
interface IndexRow {
  item_id: string;
  database_id: string;
  vector: string;
  updated_at: string;
}

async function db(key: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const database = await getDatabaseByModuleId(client, key);
    if (!database) throw new Error(`Missing fixture database: ${key}`);
    return database.id;
  });
}
async function rows(): Promise<IndexRow[]> {
  return withTransaction(
    pool,
    async (client) =>
      (
        await client.query<IndexRow>(
          "SELECT item_id, database_id, search_vector::text AS vector, updated_at::text FROM item_search_index ORDER BY item_id",
        )
      ).rows,
  );
}
async function matches(client: PoolClient, itemId: string, text: string): Promise<boolean> {
  const result = await client.query<{ matches: boolean }>(
    "SELECT search_vector @@ plainto_tsquery('czech', $2) AS matches FROM item_search_index WHERE item_id = $1",
    [itemId, text],
  );
  return result.rows[0]?.matches ?? false;
}
async function has(itemId: string, text: string): Promise<boolean> {
  return withTransaction(pool, (client) => matches(client, itemId, text));
}
async function link(sourceDatabaseId: string, key: string, itemId: string, targetId: string): Promise<void> {
  const property = await withTransaction(pool, (client) => getPropertyByKey(client, sourceDatabaseId, key));
  if (!property) throw new Error(`Missing fixture relation: ${key}`);
  await cp.createRelation({ relationPropertyId: property.id, callerItemId: itemId, targetItemId: targetId });
}
async function task(title = "Invoice"): Promise<{ id: string; databaseId: string }> {
  return cp.createItem({ databaseId: await db("tasks"), properties: { name: title } });
}
async function removeIndex(itemIds: string[]): Promise<void> {
  // Simulates pre-deploy items: the public write path now always creates their index rows.
  await withTransaction(pool, (client) =>
    client.query("DELETE FROM item_search_index WHERE item_id = ANY($1::uuid[])", [itemIds]),
  );
}
async function rejectIndexWrites(onlyMarked = false): Promise<void> {
  // Fault injection is database-only; no production API can make an index upsert fail on demand.
  // The interpolated fragment is one of two closed SQL constants, never fixture content.
  const whenClause = onlyMarked ? "WHEN (NEW.search_vector @@ plainto_tsquery('czech', 'rejectChunk'))" : "";
  await admin.query(`CREATE FUNCTION reject_item_search_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test index failure'; END $$;
    CREATE TRIGGER reject_item_search_test BEFORE INSERT OR UPDATE ON item_search_index
    FOR EACH ROW ${whenClause} EXECUTE FUNCTION reject_item_search_test()`);
}
async function runQueuedBackfill(): Promise<void> {
  const taskList = createApiCoreTaskList(pool, createActionRegistry());
  const handler = taskList[taskName];
  if (!handler) throw new Error("Backfill handler missing from production API task list");
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
  await runInTenant(tenant, () => seedSystem(pool));
});
afterEach(async () => {
  await admin.query(
    "DROP TRIGGER IF EXISTS reject_item_search_test ON item_search_index; DROP FUNCTION IF EXISTS reject_item_search_test()",
  );
});
afterAll(async () => {
  await pool?.end();
  await admin?.end();
});

describe("item search create/update hooks", () => {
  it("indexes a Task inside its own transaction and discards item and index on rollback", async () => {
    await runInTenant(tenant, async () => {
      const databaseId = await db("tasks");
      let id: string | undefined;
      await expect(
        withTransaction(pool, async (client) => {
          const item = await createItemWithClient(client, { databaseId, properties: { name: "Odeslat fakturu" } });
          id = item.id;
          expect(await matches(client, item.id, "Odeslat fakturu")).toBe(true);
          expect((await rows()).some((row) => row.item_id === item.id)).toBe(false);
          throw new Error("rollback probe");
        }),
      ).rejects.toThrow("rollback probe");
      expect(id).toBeDefined();
      expect((await rows()).some((row) => row.item_id === id)).toBe(false);
      const stored = await withTransaction(pool, (client) => getItemById(client, databaseId, id ?? randomUUID()));
      expect(stored).toBeNull();
    });
  });

  it("creates and refreshes a committed Task index through the public choke point", async () => {
    await runInTenant(tenant, async () => {
      const item = await task("Old title");
      expect(await has(item.id, "Old title")).toBe(true);
      await cp.updateItem({ databaseId: item.databaseId, itemId: item.id, propertiesPatch: { name: "Replacement" } });
      expect(await has(item.id, "Replacement")).toBe(true);
      expect(await has(item.id, "Old")).toBe(false);
    });
  });

  it("rolls back a create when the index hook fails", async () => {
    await runInTenant(tenant, async () => {
      const before = await rows();
      await rejectIndexWrites();
      await expect(task("Rejected creation")).rejects.toThrow("test index failure");
      expect(await rows()).toEqual(before);
      const result = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM items WHERE database_id = $1",
        [await db("tasks")],
      );
      expect(result.rows).toEqual([{ count: "0" }]);
    });
  });

  it("rolls back an update when the index hook fails", async () => {
    await runInTenant(tenant, async () => {
      const item = await task("Original");
      const before = await rows();
      await rejectIndexWrites();
      await expect(
        cp.updateItem({ databaseId: item.databaseId, itemId: item.id, propertiesPatch: { name: "Rejected" } }),
      ).rejects.toThrow("test index failure");
      expect(await rows()).toEqual(before);
      expect(
        (await withTransaction(pool, (client) => getItemById(client, item.databaseId, item.id)))?.properties.name,
      ).toBe("Original");
    });
  });

  it("includes a Task's project and the project's area from real inverse edges", async () => {
    await runInTenant(tenant, async () => {
      const area = await cp.createItem({ databaseId: await db("areas"), properties: { name: "Finance" } });
      const project = await cp.createItem({ databaseId: await db("projects"), properties: { name: "Billing" } });
      await link(project.databaseId, "area", project.id, area.id);
      const item = await task();
      await link(item.databaseId, "project", item.id, project.id);
      expect(await has(item.id, "Billing")).toBe(false);
      // Edge fan-out is deferred to #1652; the next item update runs the indexing hook.
      await cp.updateItem({ databaseId: item.databaseId, itemId: item.id, propertiesPatch: { name: "Invoice" } });
      expect(await has(item.id, "Invoice Billing Finance")).toBe(true);
    });
  });

  it("always includes live project, area, people and company titles in custom collections, excluding deleted titles", async () => {
    await runInTenant(tenant, async () => {
      const collection = await cp.createDatabase({ name: "Custom collection" });
      const item = await cp.createItem({ databaseId: collection.id, properties: {} });
      for (const key of ["projects", "areas", "people", "companies"] as const) {
        const target = await cp.createItem({ databaseId: await db(key), properties: { name: `${key}Visible` } });
        const property = await cp.createRelationProperty({
          sourceDatabaseId: collection.id,
          targetDatabaseId: target.databaseId,
          key,
          name: key,
        });
        await cp.createRelation({
          relationPropertyId: property.property.id,
          callerItemId: item.id,
          targetItemId: target.id,
        });
      }
      const deleted = await cp.createItem({ databaseId: await db("people"), properties: { name: "DeletedPerson" } });
      await link(collection.id, "people", item.id, deleted.id);
      // Retains the historical edge so this tests the indexer's deleted-target guard itself.
      await withTransaction(pool, (client) => softDeleteItem(client, deleted.databaseId, deleted.id));
      await withTransaction(pool, (client) => indexItem(client, item.id));
      expect(await has(item.id, "projectsVisible areasVisible peopleVisible companiesVisible")).toBe(true);
      expect(await has(item.id, "DeletedPerson")).toBe(false);
    });
  });

  it("indexes a declared relation to a database outside the always-included set", async () => {
    await runInTenant(tenant, async () => {
      const health = await cp.createItem({ databaseId: await db("healthRecords"), properties: { name: "Dentistry" } });
      const file = await cp.createItem({ databaseId: await db("files"), properties: { name: "Receipt" } });
      await link(file.databaseId, "healthRecords", file.id, health.id);
      await withTransaction(pool, (client) => indexItem(client, file.id));
      expect(await has(file.id, "Dentistry Receipt")).toBe(true);
    });
  });

  it("never creates or rewrites an Emails index when read is toggled", async () => {
    await runInTenant(tenant, async () => {
      const email = await cp.createItem({ databaseId: await db("emails"), properties: { read: false } });
      expect((await rows()).some((row) => row.item_id === email.id)).toBe(false);
      await withTransaction(pool, (client) =>
        reindexItemSearch(client, {
          itemId: email.id,
          databaseId: email.databaseId,
          text: "Rich mail body attachment",
        }),
      );
      const before = await rows();
      await cp.updateItem({ databaseId: email.databaseId, itemId: email.id, propertiesPatch: { read: true } });
      expect(await rows()).toEqual(before);
    });
  });

  it.each(["cs", "en", "fr"])(
    "indexes custom text, longText, URL, select and multi-select labels in locale %s",
    async (locale) => {
      await createUser(admin, {
        tenantId: tenant,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        locale,
      });
      await runInTenant(tenant, async () => {
        const database = await cp.createDatabase({ name: "Notes" });
        for (const [key, type] of [
          ["title", "title"],
          ["text", "text"],
          ["long", "longText"],
          ["url", "url"],
        ] as const) {
          await cp.createProperty({ databaseId: database.id, key, name: key, type });
        }
        await cp.createProperty({
          databaseId: database.id,
          key: "status",
          name: "Status",
          type: "select",
          config: { options: [{ key: "custom", label: "User label" }] },
        });
        await cp.createProperty({
          databaseId: database.id,
          key: "tags",
          name: "Tags",
          type: "multi_select",
          config: { options: [{ key: "first", label: "First tag" }] },
        });
        const item = await cp.createItem({
          databaseId: database.id,
          properties: {
            title: "Title",
            text: "Short",
            long: "Longer prose",
            url: "https://example.test/link",
            status: "custom",
            tags: ["first"],
          },
        });
        expect(await has(item.id, "Title Short Longer prose User label First tag")).toBe(true);
        expect(await has(item.id, "example.test")).toBe(true);
        // A shipped select has no override and must use this tenant's users.locale.
        const selected = await cp.createItem({
          databaseId: await db("tasks"),
          properties: { name: "Selected", status: "notDone" },
        });
        const registry = await import("../manifest/fullModuleRegistry.js").then((module) =>
          module.loadFullModuleRegistry(),
        );
        const catalogs = await registry.getCatalogs("systemDatabases");
        const label = catalogs?.[locale === "cs" ? "cs" : "en"]?.["property.tasks.status.option.notDone"];
        expect(label).toBeTypeOf("string");
        expect(await has(selected.id, typeof label === "string" ? label : "missing label")).toBe(true);
      });
    },
  );

  it("includes the cached Inbox text of a Journal day without adding page/body indexing", async () => {
    await runInTenant(tenant, async () => {
      const databaseId = await db("journal");
      const day = await withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, databaseId, "day", new Date("2026-10-27T12:00:00Z"), "UTC"),
      );
      const inboxDatabaseId = await db("inbox");
      await withTransaction(pool, async (client) => {
        await createInboxItemWithClient(client, {
          inboxDatabaseId,
          journalDatabaseId: databaseId,
          date: "2026-10-27",
          time: "12:00",
          timezone: "UTC",
          text: "Journal Inbox observation",
        });
      });
      await recomputeJournalInboxDay(pool, day.id);
      await withTransaction(pool, (client) => indexItem(client, day.id));
      expect(await has(day.id, "Journal Inbox observation")).toBe(true);
    });
  });

  it("skips missing and soft-deleted items without changing existing index rows", async () => {
    await runInTenant(tenant, async () => {
      const item = await task();
      await cp.softDeleteItem(item.databaseId, item.id);
      await removeIndex([item.id]);
      const before = await rows();
      await withTransaction(pool, async (client) => {
        await indexItem(client, randomUUID());
        await indexItem(client, item.id);
      });
      expect(await rows()).toEqual(before);
    });
  });

  it("declares seeded title/text/select fields and the requested relation fields for all ten databases", async () => {
    await runInTenant(tenant, async () => {
      expect(manifest.databases).toHaveLength(10);
      for (const descriptor of manifest.databases) {
        const props = await pool.query<{ key: string }>(
          "SELECT key FROM properties WHERE database_id = $1 AND type = ANY($2::text[])",
          [await db(descriptor.key), ["title", "text", "longText", "url", "select", "multi_select"]],
        );
        for (const property of props.rows) expect(descriptor.searchFields).toContain(property.key);
      }
      expect(manifest.databases.find((d) => d.key === "events")?.searchFields).not.toContain("place");
      expect(manifest.databases.find((d) => d.key === "people")?.searchFields).toContain("emails");
      expect(manifest.databases.find((d) => d.key === "people")?.searchFields).not.toContain("phones");
      for (const [key, fields] of Object.entries({
        tasks: ["project"],
        events: ["project", "people"],
        projects: ["area", "company"],
        people: ["companies"],
        files: ["projects", "healthRecords", "companies"],
        healthRecords: ["projects"],
      })) {
        expect(manifest.databases.find((d) => d.key === key)?.searchFields).toEqual(expect.arrayContaining(fields));
      }
    });
  });
});

describe("tenant item search backfill task", () => {
  it("refuses an enqueue outside a tenant before writing a queue row", async () => {
    await expect(
      withTransaction(admin, (client) => enqueueItemSearchBackfill(client, { onlyMissing: true })),
    ).rejects.toThrow(/tenant scope/);
    await expect(
      runAsSystem("test invalid enqueue", () =>
        withTransaction(pool, (client) => enqueueItemSearchBackfill(client, { onlyMissing: true })),
      ),
    ).rejects.toThrow(/tenant scope/);
    expect(await readJobPayloadsByIdentifier(admin, taskName)).toEqual([]);
  });

  it("deploy fills every live non-Emails item, including legacy seed data, and repeat deploy leaves index rows unchanged", async () => {
    await runInTenant(tenant, async () => {
      const live = await task();
      const trashed = await task("Trashed");
      await cp.softDeleteItem(trashed.databaseId, trashed.id);
      await cp.createItem({ databaseId: await db("emails"), properties: {} });
      await removeIndex([live.id, trashed.id]);
    });
    await runAsSystem("test deploy", () => runItemSearchBackfillCutover(pool));
    await runQueuedBackfill();
    const before = await runInTenant(tenant, async () => {
      const eligible = await pool.query<{ id: string; database_id: string }>(
        `SELECT i.id, i.database_id FROM items i JOIN databases d ON d.id = i.database_id
         WHERE i.deleted_at IS NULL AND d.owner_module_id IS DISTINCT FROM $1 ORDER BY i.id`,
        ["emails"],
      );
      const indexed = await rows();
      expect(indexed.map((row) => ({ id: row.item_id, database_id: row.database_id }))).toEqual(eligible.rows);
      return indexed;
    });
    await runAsSystem("test repeat deploy", () => runItemSearchBackfillCutover(pool));
    await runQueuedBackfill();
    expect(await runInTenant(tenant, rows)).toEqual(before);
  });

  it("registers the task in the API affinity and tenant tenancy catalogs", () => {
    expect(taskName).toBe("itemSearchBackfill");
    expect(CORE_TASK_AFFINITY[taskName]).toBe("api");
    expect(TASK_TENANCY[taskName]).toBe("tenant");
    expect(createApiCoreTaskList(pool, createActionRegistry())[taskName]).toBeTypeOf("function");
  });

  it("backfills legacy items across committed chunks, queues a distinct cursor on the tenant lane, and preserves existing rows on repeat deploy", async () => {
    const items: string[] = [];
    let databaseId = "";
    await runInTenant(tenant, async () => {
      for (let index = 0; index < 101; index++) items.push((await task(`Legacy ${index}`)).id);
      await removeIndex(items);
      const existing = await task("Already indexed");
      databaseId = existing.databaseId;
      const existingRow = (await rows()).find((row) => row.item_id === existing.id);
      await withTransaction(pool, (client) =>
        enqueueItemSearchBackfill(client, { databaseId: existing.databaseId, onlyMissing: true }),
      );
      await handleItemSearchBackfillTask(pool, { databaseId: existing.databaseId, onlyMissing: true });
      expect((await rows()).filter((row) => items.includes(row.item_id))).toHaveLength(100);
      const jobs = await admin.query<{ key: string; queue_name: string; payload: unknown }>(
        `SELECT j.key, q.queue_name, j.payload FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
         JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id WHERE t.identifier = $1 ORDER BY j.key`,
        [taskName],
      );
      // Graphile Worker 0.17.3: queue name is only exposed by its private queue table.
      expect(jobs.rows).toHaveLength(2);
      expect(new Set(jobs.rows.map((row) => row.key)).size).toBe(2);
      expect(jobs.rows.every((row) => row.queue_name === `item-search-index:${tenant}`)).toBe(true);
      expect(jobs.rows.some((row) => row.key.endsWith([...items].sort()[99] ?? "missing"))).toBe(true);
      expect((await rows()).find((row) => row.item_id === existing.id)).toEqual(existingRow);
    });
    await runQueuedBackfill();
    await runInTenant(tenant, async () => {
      const before = await rows();
      expect(before.filter((row) => row.database_id === databaseId)).toHaveLength(102);
      expect(before.filter((row) => items.includes(row.item_id))).toHaveLength(101);
      await handleItemSearchBackfillTask(pool, { databaseId, onlyMissing: true });
      expect(await rows()).toEqual(before);
    });
  });

  it("onlyMissing preserves an existing index row at the upsert guard", async () => {
    await runInTenant(tenant, async () => {
      const item = await task();
      const before = await rows();
      await withTransaction(pool, (client) => indexItem(client, item.id, { onlyMissing: true }));
      expect(await rows()).toEqual(before);
    });
  });

  it("a full rebuild refreshes existing documents and a database/cursor filter bounds selection", async () => {
    await runInTenant(tenant, async () => {
      const first = await task("First");
      const second = await task("Second");
      const ordered = [first, second].sort((a, b) => a.id.localeCompare(b.id));
      const selected = ordered[1];
      if (!selected || !ordered[0]) throw new Error("fixture missing");
      await withTransaction(pool, (client) =>
        reindexItemSearch(client, { itemId: selected.id, databaseId: selected.databaseId, text: "Stale" }),
      );
      await handleItemSearchBackfillTask(pool, {
        databaseId: selected.databaseId,
        afterItemId: ordered[0].id,
        onlyMissing: false,
      });
      expect(await has(selected.id, "Stale")).toBe(false);
      expect(await has(selected.id, selected.id === first.id ? "First" : "Second")).toBe(true);
    });
  });

  it("skips Emails, trashed items and foreign or missing databases; fails closed on foreign item ids", async () => {
    const other = await createTestTenant(admin);
    let foreignId = "";
    let foreignDb = "";
    await runInTenant(other, async () => {
      const database = await cp.createDatabase({ name: "Foreign collection" });
      const property = await cp.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });
      expect(property).toBeDefined();
      const item = await cp.createItem({ databaseId: database.id, properties: { title: "Foreign secret" } });
      foreignId = item.id;
      foreignDb = database.id;
      await removeIndex([item.id]);
    });
    await runInTenant(tenant, async () => {
      const live = await task("Tenant visible");
      const trashed = await task("Trashed");
      await cp.softDeleteItem(trashed.databaseId, trashed.id);
      const email = await cp.createItem({ databaseId: await db("emails"), properties: {} });
      await removeIndex([live.id, trashed.id]);
      const before = await rows();
      await handleItemSearchBackfillTask(pool, { databaseId: foreignDb, onlyMissing: true });
      await handleItemSearchBackfillTask(pool, { databaseId: randomUUID(), onlyMissing: true });
      await withTransaction(pool, async (client) => {
        await indexItem(client, foreignId);
        await indexItem(client, randomUUID());
      });
      expect(await rows()).toEqual(before);
      await withTransaction(pool, (client) => enqueueItemSearchBackfill(client, { onlyMissing: true }));
      expect((await rows()).some((row) => row.item_id === live.id)).toBe(false);
      expect((await rows()).some((row) => row.item_id === email.id)).toBe(false);
    });
    await runQueuedBackfill();
    await runInTenant(tenant, async () => {
      expect((await rows()).some((row) => row.database_id === foreignDb)).toBe(false);
      const tasksId = await db("tasks");
      expect((await rows()).filter((row) => row.database_id === tasksId)).toHaveLength(1);
    });
    await runInTenant(other, async () => {
      expect(await rows()).toEqual([]);
    });
  });

  it.each([
    null,
    {},
    { onlyMissing: "yes" },
    { onlyMissing: true, databaseId: "not-uuid" },
    { onlyMissing: true, afterItemId: "not-uuid" },
    { onlyMissing: true, tenantId: "untrusted" },
  ])("rejects malformed task payload %j without changes or continuation", async (payload) => {
    await runInTenant(tenant, async () => {
      const before = await rows();
      const jobs = await readJobPayloadsByIdentifier(admin, taskName);
      await expect(handleItemSearchBackfillTask(pool, payload)).rejects.toThrow();
      expect(await rows()).toEqual(before);
      expect(await readJobPayloadsByIdentifier(admin, taskName)).toEqual(jobs);
    });
  });

  it("refuses an owner pool for the deploy cutover before enqueuing", async () => {
    await expect(runAsSystem("test cutover", () => runItemSearchBackfillCutover(admin))).rejects.toThrow(
      /row-level security/,
    );
    expect(await readJobPayloadsByIdentifier(admin, taskName)).toEqual([]);
  });

  it("enqueues once per maintained tenant on each deploy and preserves the missing-only contract", async () => {
    const statuses = ["provisioning", "suspended", "deleting"] as const;
    const ids: string[] = [tenant];
    for (const status of statuses) ids.push(await createTestTenant(admin, { status }));
    await runAsSystem("test deploy", () => runItemSearchBackfillCutover(pool));
    await runAsSystem("test repeat deploy", () => runItemSearchBackfillCutover(pool));
    const payloads = await readJobPayloadsByIdentifier(admin, taskName);
    expect(payloads).toHaveLength(3);
    expect(payloads).toEqual(
      expect.arrayContaining(
        ids.slice(0, 3).map((tenantId) => expect.objectContaining({ tenantId, payload: { onlyMissing: true } })),
      ),
    );
  });

  it("rolls back a failing chunk and leaves no continuation or partial index rows", async () => {
    await runInTenant(tenant, async () => {
      const items = [await task("First candidate"), await task("Second candidate")].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      const last = items.at(-1);
      if (!last) throw new Error("fixture missing");
      await cp.updateItem({ databaseId: last.databaseId, itemId: last.id, propertiesPatch: { name: "rejectChunk" } });
      await removeIndex(items.map((item) => item.id));
      const before = await rows();
      await rejectIndexWrites(true);
      await expect(
        handleItemSearchBackfillTask(pool, { databaseId: last.databaseId, onlyMissing: true }),
      ).rejects.toThrow("test index failure");
      expect(await rows()).toEqual(before);
      expect(await readJobPayloadsByIdentifier(admin, taskName)).toEqual([]);
    });
  });
});
