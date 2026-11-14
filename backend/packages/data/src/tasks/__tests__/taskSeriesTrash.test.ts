// Issue gh-1882: trashing and restoring a whole recurring task series, through the choke point and the runtime role pool.
import "../../domainWriteHooks.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { getTaskRecurrenceBySeriesId } from "../taskRecurrenceStore.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../../chokePoint/relationsStore.js";
import { insertValueLink } from "../../chokePoint/valueLinksStore.js";
import { getValueLinksForItems } from "../../chokePoint/valueLinkReads.js";
import { withTransaction } from "../../db/pool.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createSeriesOccurrence, startTaskSeries } from "../../testSupport/taskSeriesFixtures.js";
import { purgeExpiredTrash } from "../../trash/purgeExpiredTrash.js";
import { projectTaskOccurrences } from "../projectTaskOccurrences.js";
import type { TaskRecurrenceRule } from "../taskRecurrenceRule.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let databases: Record<string, string>;

const TASKS_CONTEXT = { ownerProcess: TASKS_MODULE_ID };
const WEEKLY_MONDAY: TaskRecurrenceRule = { kind: "weekdays", days: ["mon"] };

const itemRow = z.object({ id: z.string(), deleted_at: z.date().nullable(), status: z.string().nullable() });
const seriesRow = z.object({
  item_id: z.string(),
  active: z.boolean(),
  trashed_active_item_id: z.string().nullable(),
});

const create = (databaseKey: string, properties: Record<string, unknown>) =>
  runInTenant(tenant, () => cp.createItem({ databaseId: databases[databaseKey]!, properties }));

async function propertyId(databaseKey: string, key: string): Promise<string> {
  const { rows } = await runInTenant(tenant, () =>
    pool.query<{ id: string }>("SELECT id FROM properties WHERE database_id = $1 AND key = $2", [
      databases[databaseKey],
      key,
    ]),
  );
  if (!rows[0]) throw new Error(`Property ${databaseKey}.${key} missing`);
  return rows[0].id;
}

/** Writes an edge as the Tasks process, the only writer of `hostEvents`. */
async function hostEdge(taskId: string, eventId: string): Promise<void> {
  const relationPropertyId = await propertyId("tasks", "hostEvents");
  await runInTenant(tenant, () =>
    withTransaction(pool, (client) =>
      createRelationWithClient(
        client,
        {
          relationPropertyId,
          callerItemId: taskId,
          targetItemId: eventId,
          metadata: { addedAt: "2026-10-15T10:00:00.000Z" },
        },
        TASKS_CONTEXT,
      ),
    ),
  );
}

async function instancesOf(seriesId: string) {
  const { rows } = await runInTenant(tenant, () =>
    pool.query(
      `SELECT id, deleted_at, properties->>'status' AS status FROM items
       WHERE database_id = $1 AND properties->>'seriesId' = $2 ORDER BY id`,
      [databases.tasks, seriesId],
    ),
  );
  return rows.map((row) => itemRow.parse(row));
}

async function seriesOf(seriesId: string) {
  const { rows } = await runInTenant(tenant, () =>
    pool.query("SELECT item_id, active, trashed_active_item_id FROM task_recurrence WHERE series_id = $1", [seriesId]),
  );
  return rows.map((row) => seriesRow.parse(row));
}

/** Resolves once a statement whose text contains `fragment` waits for a lock held by another transaction. */
async function waitUntilBlocked(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1",
      [`%${fragment}%`],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No statement containing '${fragment}' ever waited for a lock`);
}

/** Holds the locks `acquire` takes in an open transaction until `release` is called; resolves `locked` once they are held. */
function holdLocks(acquire: (client: PoolClient) => Promise<void>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const done = runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      await acquire(client);
      markLocked();
      await released;
    }),
  );
  return { locked, release, done };
}

function trash(itemId: string) {
  return runInTenant(tenant, () => cp.softDeleteItem(databases.tasks!, itemId));
}

function restore(itemId: string) {
  return runInTenant(tenant, () => cp.restoreItem(databases.tasks!, itemId));
}

/**
 * A series with three stored instances, built with the module's own writes: the first two were completed and the third
 * is the open one that the series row points at. Returns the instances oldest first.
 */
async function seriesOfThree(): Promise<{ seriesId: string; done: [string, string]; open: string }> {
  const first = await create("tasks", { name: "Weekly review", date: "2026-10-12" });
  const seriesId = await runInTenant(tenant, () =>
    startTaskSeries(pool, { databaseId: databases.tasks!, itemId: first.id, mode: "fixed", rule: WEEKLY_MONDAY }),
  );
  const complete = (itemId: string) =>
    runInTenant(tenant, () =>
      cp.updateItem({ databaseId: databases.tasks!, itemId, propertiesPatch: { status: "done" } }),
    );
  await complete(first.id);
  const second = (await instancesOf(seriesId)).find((row) => row.status === "notDone");
  if (!second) throw new Error("The first completion created no instance");
  await complete(second.id);
  const third = (await instancesOf(seriesId)).find((row) => row.status === "notDone");
  if (!third) throw new Error("The second completion created no instance");
  expect(await instancesOf(seriesId)).toHaveLength(3);
  return { seriesId, done: [first.id, second.id], open: third.id };
}

describe("trashing and restoring a recurring task series (issue gh-1882)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    cp = createChokePoint(pool);
    const { rows } = await runInTenant(tenant, () =>
      pool.query<{ id: string; owner_module_id: string }>("SELECT id, owner_module_id FROM databases"),
    );
    databases = Object.fromEntries(rows.map((row) => [row.owner_module_id, row.id]));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  describe("trash", () => {
    it("puts every instance of the series in the Trash under one deletedAt when one instance is deleted", async () => {
      const { seriesId, done } = await seriesOfThree();

      await trash(done[0]);

      const rows = await instancesOf(seriesId);
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.deleted_at !== null)).toBe(true);
      expect(new Set(rows.map((row) => row.deleted_at?.getTime())).size).toBe(1);
      // One epoch at the column's full precision, not only to the millisecond.
      const { rows: epochs } = await runInTenant(tenant, () =>
        pool.query("SELECT count(DISTINCT deleted_at)::int AS n FROM items WHERE properties->>'seriesId' = $1", [
          seriesId,
        ]),
      );
      expect(epochs).toEqual([{ n: 1 }]);
    });

    it("trashes the series when the open instance is the one deleted", async () => {
      const { seriesId, open } = await seriesOfThree();

      await trash(open);

      expect((await instancesOf(seriesId)).every((row) => row.deleted_at !== null)).toBe(true);
    });

    it("turns the repeat rule off and records the instance that held it, so the trashed series projects no occurrence", async () => {
      const { seriesId, open } = await seriesOfThree();
      const project = () =>
        runInTenant(tenant, () =>
          withTransaction(pool, (client) =>
            projectTaskOccurrences(client, { from: "2026-11-01", to: "2026-11-30", today: "2026-10-16" }),
          ),
        );
      expect((await project()).length).toBeGreaterThan(0);

      await trash(open);

      expect(await seriesOf(seriesId)).toEqual([{ item_id: open, active: false, trashed_active_item_id: open }]);
      expect(await project()).toEqual([]);
    });

    it("does not touch a task without a series, nor another series", async () => {
      const { seriesId, done } = await seriesOfThree();
      const other = await create("tasks", { name: "Other", date: "2026-10-13" });
      const otherSeriesId = await runInTenant(tenant, () =>
        startTaskSeries(pool, { databaseId: databases.tasks!, itemId: other.id, mode: "fixed", rule: WEEKLY_MONDAY }),
      );
      const plain = await create("tasks", { name: "Plain", date: "2026-10-14" });

      await trash(done[1]);

      expect((await instancesOf(seriesId)).every((row) => row.deleted_at !== null)).toBe(true);
      expect((await instancesOf(otherSeriesId)).map((row) => row.deleted_at)).toEqual([null]);
      expect(await seriesOf(otherSeriesId)).toMatchObject([{ active: true, trashed_active_item_id: null }]);
      expect((await runInTenant(tenant, () => cp.getItem(databases.tasks!, plain.id)))?.deletedAt).toBeNull();
    });

    it("deletes only the task and its normal cascade when the task has no series", async () => {
      const plain = await create("tasks", { name: "Plain", date: "2026-10-14" });
      const sibling = await create("tasks", { name: "Sibling", date: "2026-10-14" });

      await trash(plain.id);

      const { rows } = await runInTenant(tenant, () =>
        pool.query("SELECT id, deleted_at FROM items WHERE database_id = $1 AND deleted_at IS NOT NULL", [
          databases.tasks,
        ]),
      );
      expect(rows.map((row) => z.object({ id: z.string() }).parse(row).id)).toEqual([plain.id]);
      expect((await runInTenant(tenant, () => cp.getItem(databases.tasks!, sibling.id)))?.deletedAt).toBeNull();
    });

    it("leaves an instance that another tenant's task shares the seriesId with alone", async () => {
      const { seriesId, done } = await seriesOfThree();
      const foreignTenant = await createTestTenant(admin);
      await runInTenant(foreignTenant, () => seedSystem(pool));
      const foreignTasks = await runInTenant(foreignTenant, async () => {
        const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'tasks'");
        return rows[0]!.id;
      });
      const foreign = await runInTenant(foreignTenant, () =>
        createChokePoint(pool).createItem({
          databaseId: foreignTasks,
          properties: { name: "Foreign", date: "2026-10-12" },
        }),
      );
      // Fixture SQL: the Tasks module writes `seriesId` only for its own series, and this forges a collision.
      await admin.query(
        "UPDATE items SET properties = jsonb_set(properties, '{seriesId}', to_jsonb($2::text)) WHERE id = $1",
        [foreign.id, seriesId],
      );

      await trash(done[0]);

      const foreignRow = await runInTenant(foreignTenant, () =>
        createChokePoint(pool).getItem(foreignTasks, foreign.id),
      );
      expect(foreignRow?.deletedAt).toBeNull();
      expect((await instancesOf(seriesId)).every((row) => row.deleted_at !== null)).toBe(true);
    });

    it("leaves a rule the user had turned off off, with no record, and trashes the instances that still carry the series", async () => {
      const { seriesId, done, open } = await seriesOfThree();
      // Turning the repeat off takes the series off the open instance; the completed ones keep it as history.
      await runInTenant(tenant, () =>
        cp.updateItem({ databaseId: databases.tasks!, itemId: open, propertiesPatch: { recurrence: null } }),
      );
      expect(await seriesOf(seriesId)).toMatchObject([{ active: false, trashed_active_item_id: null }]);

      await trash(done[0]);

      expect(await seriesOf(seriesId)).toEqual([{ item_id: open, active: false, trashed_active_item_id: null }]);
      expect((await instancesOf(seriesId)).map((row) => [row.id, row.deleted_at === null] as const).sort()).toEqual(
        [
          [done[0], false],
          [done[1], false],
        ].sort(),
      );
      expect((await runInTenant(tenant, () => cp.getItem(databases.tasks!, open)))?.deletedAt).toBeNull();
    });

    describe("an item of a user-created database that names a series", () => {
      /** An item whose text property `seriesId` holds the id of a live series: nothing but the Tasks module may act on it. */
      async function itemNamingSeries(seriesId: string): Promise<{ databaseId: string; itemId: string }> {
        const notes = await runInTenant(tenant, () => cp.createDatabase({ name: "Notes" }));
        await runInTenant(tenant, () =>
          cp.createProperty({ databaseId: notes.id, key: "seriesId", name: "Series", type: "text" }),
        );
        const note = await runInTenant(tenant, () => cp.createItem({ databaseId: notes.id, properties: { seriesId } }));
        return { databaseId: notes.id, itemId: note.id };
      }

      it("leaves the repeat rule of that series on when the item is trashed, and trashes nothing of the series", async () => {
        const { seriesId } = await seriesOfThree();
        const { databaseId, itemId } = await itemNamingSeries(seriesId);

        await runInTenant(tenant, () => cp.softDeleteItem(databaseId, itemId));

        expect((await runInTenant(tenant, () => cp.getItem(databaseId, itemId)))?.deletedAt).not.toBeNull();
        expect(await seriesOf(seriesId)).toMatchObject([{ active: true, trashed_active_item_id: null }]);
        expect((await instancesOf(seriesId)).every((row) => row.deleted_at === null)).toBe(true);
      });

      it("leaves the repeat rule of that series as it is when the item is restored, even one the trash had turned off", async () => {
        const { seriesId, done, open } = await seriesOfThree();
        const { databaseId, itemId } = await itemNamingSeries(seriesId);
        await runInTenant(tenant, () => cp.softDeleteItem(databaseId, itemId));
        // Fixture SQL: a series that is off with the item as the instance it was on for, a state only a Tasks trash writes.
        await admin.query(
          "UPDATE task_recurrence SET active = false, trashed_active_item_id = $2 WHERE series_id = $1",
          [seriesId, itemId],
        );

        await runInTenant(tenant, () => cp.restoreItem(databaseId, itemId));

        expect((await runInTenant(tenant, () => cp.getItem(databaseId, itemId)))?.deletedAt).toBeNull();
        expect(await seriesOf(seriesId)).toEqual([{ item_id: open, active: false, trashed_active_item_id: itemId }]);
        expect(done).toHaveLength(2);
      });
    });

    it("rolls the whole series back to live when a hook refuses a row of the cascade", async () => {
      const { seriesId, done } = await seriesOfThree();
      // Fixture SQL: a trigger that refuses the soft delete of the open instance, the last row the cascade writes.
      const { open } = { open: (await instancesOf(seriesId)).find((row) => row.status === "notDone")!.id };
      await admin.query(
        `CREATE FUNCTION refuse_series_trash_test() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'series trash refused'; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER refuse_series_trash_test BEFORE UPDATE OF deleted_at ON items FOR EACH ROW
         WHEN (NEW.deleted_at IS NOT NULL AND NEW.id = '${open}'::uuid) EXECUTE FUNCTION refuse_series_trash_test()`,
      );
      try {
        await expect(trash(done[0])).rejects.toThrow("series trash refused");
      } finally {
        await admin.query("DROP TRIGGER refuse_series_trash_test ON items");
        await admin.query("DROP FUNCTION refuse_series_trash_test()");
      }

      expect((await instancesOf(seriesId)).map((row) => row.deleted_at)).toEqual([null, null, null]);
      expect(await seriesOf(seriesId)).toMatchObject([{ active: true, trashed_active_item_id: null }]);
    });
  });

  describe("restore", () => {
    it("brings every instance back when any one is restored, with exactly one active repeat rule", async () => {
      const { seriesId, done, open } = await seriesOfThree();
      await trash(done[0]);

      await restore(done[1]);

      expect((await instancesOf(seriesId)).map((row) => row.deleted_at)).toEqual([null, null, null]);
      const rows = await seriesOf(seriesId);
      expect(rows).toEqual([{ item_id: open, active: true, trashed_active_item_id: null }]);
      // A restore creates no instance.
      expect(await instancesOf(seriesId)).toHaveLength(3);
    });

    it("turns the rule on again when the instance that held it is the one restored", async () => {
      const { seriesId, open } = await seriesOfThree();
      await trash(open);

      await restore(open);

      expect(await seriesOf(seriesId)).toEqual([{ item_id: open, active: true, trashed_active_item_id: null }]);
    });

    it("keeps a rule the user had turned off off after the restore", async () => {
      const { seriesId, open, done } = await seriesOfThree();
      await runInTenant(tenant, () =>
        cp.updateItem({ databaseId: databases.tasks!, itemId: open, propertiesPatch: { recurrence: null } }),
      );
      await trash(done[0]);

      await restore(done[1]);

      expect(await seriesOf(seriesId)).toEqual([{ item_id: open, active: false, trashed_active_item_id: null }]);
      expect((await instancesOf(seriesId)).every((row) => row.deleted_at === null)).toBe(true);
    });

    it("restores only the instances of its epoch and leaves one trashed earlier in the Trash", async () => {
      const { seriesId, done, open } = await seriesOfThree();
      // Fixture SQL: an instance trashed on its own, which the choke point no longer allows for a series instance.
      await admin.query("UPDATE items SET deleted_at = now() - interval '1 day' WHERE id = $1", [done[0]]);
      await trash(open);

      await restore(open);

      const rows = await instancesOf(seriesId);
      expect(rows.find((row) => row.id === done[0])?.deleted_at).not.toBeNull();
      expect(rows.filter((row) => row.id !== done[0]).map((row) => row.deleted_at)).toEqual([null, null]);
      expect(await seriesOf(seriesId)).toMatchObject([{ active: true, trashed_active_item_id: null }]);
    });

    it("leaves the rule off while the instance that held it stays in the Trash", async () => {
      const { seriesId, done, open } = await seriesOfThree();
      await trash(done[0]);
      // Fixture SQL: the held instance leaves the epoch, as a purge of it or an older trash would.
      await admin.query("UPDATE items SET deleted_at = now() - interval '1 day' WHERE id = $1", [open]);

      await restore(done[0]);

      expect(await seriesOf(seriesId)).toEqual([{ item_id: open, active: false, trashed_active_item_id: open }]);
    });

    it("restores a task without a series as before", async () => {
      const plain = await create("tasks", { name: "Plain", date: "2026-10-14" });
      await trash(plain.id);

      await restore(plain.id);

      expect((await runInTenant(tenant, () => cp.getItem(databases.tasks!, plain.id)))?.deletedAt).toBeNull();
    });
  });
  describe("links, edges and the Trash around the series", () => {
    async function inheritedProjectsOf(fileId: string) {
      return runInTenant(tenant, () => withTransaction(pool, (client) => getValueLinksForItems(client, [fileId])));
    }

    async function projectEdgeTargets(fileId: string): Promise<string[]> {
      return runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const property = await getPropertyByKey(client, databases.files!, "projects");
          const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
          if (!definition) throw new Error("Missing Files.projects");
          return (await listRelationsForItem(client, definition.id, fileId)).map((edge) => otherSide(edge, fileId));
        }),
      );
    }

    async function edgeTargets(databaseKey: string, key: string, itemId: string): Promise<string[]> {
      return runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const property = await getPropertyByKey(client, databases[databaseKey]!, key);
          const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
          if (!definition) throw new Error(`Missing ${databaseKey}.${key}`);
          return (await listRelationsForItem(client, definition.id, itemId)).map((edge) => otherSide(edge, itemId));
        }),
      );
    }

    it("makes the attachments' projects their own on delete and does not re-inherit them on restore", async () => {
      const { done, open } = await seriesOfThree();
      const project = await create("projects", { name: "Household" });
      const file = await create("files", { name: "checklist.pdf" });
      await runInTenant(tenant, async () => {
        await cp.createRelation({
          relationPropertyId: await propertyId("tasks", "files"),
          callerItemId: open,
          targetItemId: file.id,
        });
        // The value the file inherited from the task, and the link that records it: no shipped link rule writes a
        // `projects` link, so the links store's own insert stands in for such a rule's producer.
        await cp.createRelation({
          relationPropertyId: await propertyId("files", "projects"),
          callerItemId: file.id,
          targetItemId: project.id,
        });
        await withTransaction(pool, (client) =>
          insertValueLink(client, {
            itemId: file.id,
            propertyKey: "projects",
            ruleKey: "test.inheritProjects",
            sources: [{ kind: "item", sourceItemId: open, sourcePropertyKey: "project" }],
          }),
        );
      });
      expect((await inheritedProjectsOf(file.id)).get(file.id)?.projects).toBeDefined();

      await trash(done[0]);

      expect((await inheritedProjectsOf(file.id)).get(file.id)?.projects).toBeUndefined();
      expect(await projectEdgeTargets(file.id)).toEqual([project.id]);
      expect((await runInTenant(tenant, () => cp.getItem(databases.files!, file.id)))?.deletedAt).toBeNull();

      await restore(done[1]);

      expect((await inheritedProjectsOf(file.id)).get(file.id)?.projects).toBeUndefined();
      expect(await projectEdgeTargets(file.id)).toEqual([project.id]);
      expect(await edgeTargets("tasks", "files", open)).toEqual([file.id]);
    });

    it("keeps the series' edges to an Event while it is in the Trash and shows the task in the Event again after the restore", async () => {
      const { done, open } = await seriesOfThree();
      const event = await create("events", { name: "Workshop", date: "2026-10-16" });
      await hostEdge(open, event.id);

      await trash(done[0]);

      expect(await edgeTargets("tasks", "hostEvents", open)).toEqual([event.id]);
      expect((await runInTenant(tenant, () => cp.getItem(databases.events!, event.id)))?.deletedAt).toBeNull();

      await restore(done[0]);

      expect(await edgeTargets("tasks", "hostEvents", open)).toEqual([event.id]);
      expect((await runInTenant(tenant, () => cp.getItem(databases.tasks!, open)))?.deletedAt).toBeNull();
    });
  });

  describe("purge", () => {
    const storage: BlobStorageWriter = {
      writeStream: () => Promise.reject(new Error("not used by the purge")),
      readStream: () => {
        throw new Error("not used by the purge");
      },
      delete: async () => {},
    };

    it("removes the whole series with its recurrence row after the retention, and nothing of another series", async () => {
      const { seriesId, done } = await seriesOfThree();
      const other = await create("tasks", { name: "Other", date: "2026-10-13" });
      const otherSeriesId = await runInTenant(tenant, () =>
        startTaskSeries(pool, { databaseId: databases.tasks!, itemId: other.id, mode: "fixed", rule: WEEKLY_MONDAY }),
      );
      await trash(done[0]);
      // The purge reads the clock for its cutoff and ages are written by the database's: the series was built on a fake day.
      vi.useRealTimers();
      // Fixture SQL: the only way to age a trashed row past the 30 days retention; it moves every row of the epoch alike.
      await admin.query(
        "UPDATE items SET deleted_at = deleted_at - interval '31 days' WHERE properties->>'seriesId' = $1",
        [seriesId],
      );

      expect(await runInTenant(tenant, () => purgeExpiredTrash(pool, storage))).toBe(3);

      expect(await instancesOf(seriesId)).toEqual([]);
      expect(await seriesOf(seriesId)).toEqual([]);
      expect(await instancesOf(otherSeriesId)).toHaveLength(1);
      expect(await seriesOf(otherSeriesId)).toHaveLength(1);
    });

    it("keeps an instance of the series that is not in the Trash", async () => {
      const { seriesId, done, open } = await seriesOfThree();
      await trash(done[0]);
      vi.useRealTimers();
      await admin.query(
        "UPDATE items SET deleted_at = deleted_at - interval '31 days' WHERE properties->>'seriesId' = $1",
        [seriesId],
      );
      // Fixture SQL: an instance that is live while the rest of the series is expired in the Trash.
      await admin.query("UPDATE items SET deleted_at = NULL WHERE id = $1", [open]);

      expect(await runInTenant(tenant, () => purgeExpiredTrash(pool, storage))).toBe(2);

      expect((await instancesOf(seriesId)).map((row) => row.id)).toEqual([open]);
    });
  });

  describe("lock order", () => {
    it.each(["delete", "restore"] as const)(
      "a %s of one instance waits for the lowest instance of the series before it locks its own row",
      async (operation) => {
        const { seriesId } = await seriesOfThree();
        const ids = (await instancesOf(seriesId)).map((row) => row.id);
        const lowest = ids[0]!;
        const highest = ids.at(-1)!;
        if (operation === "restore") await trash(highest);
        const holder = holdLocks(async (client) => {
          await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [
            databases.tasks,
            lowest,
          ]);
        });
        await holder.locked;
        try {
          const running = operation === "delete" ? trash(highest) : restore(highest);
          await waitUntilBlocked("properties->>$2");

          // The named instance is free while the call waits: the series is locked in id order, and the lowest comes first.
          const probe = await runInTenant(tenant, () =>
            withTransaction(pool, (client) =>
              client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE NOWAIT", [
                databases.tasks,
                highest,
              ]),
            ),
          );
          expect(probe.rowCount).toBe(1);

          holder.release();
          await holder.done;
          await running;
        } finally {
          holder.release();
          await holder.done;
        }

        const rows = await instancesOf(seriesId);
        expect(rows.every((row) => (row.deleted_at === null) === (operation === "restore"))).toBe(true);
      },
    );

    it("a purge of a later instance waits for the lowest instance and the series row before it locks its own row", async () => {
      const { seriesId } = await seriesOfThree();
      const ids = (await instancesOf(seriesId)).map((row) => row.id);
      const lowest = ids[0]!;
      const highest = ids.at(-1)!;
      await trash(highest);
      const holder = holdLocks(async (client) => {
        await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [
          databases.tasks,
          lowest,
        ]);
      });
      await holder.locked;
      let purged: string[];
      try {
        // Every row of the epoch is past this cutoff, so the root named is eligible whichever instance it is.
        const running = runInTenant(tenant, () =>
          cp.purgeExpiredTrashSubtree(highest, new Date("2100-01-01T00:00:00Z")),
        );
        await waitUntilBlocked("properties->>$2");

        // The root is free while the purge waits: it takes the series in id order, so the lowest instance comes first,
        // and a restore of the series, which takes it in that order too, cannot wait for a row this purge holds.
        const probe = await runInTenant(tenant, () =>
          withTransaction(pool, (client) =>
            client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE NOWAIT", [
              databases.tasks,
              highest,
            ]),
          ),
        );
        expect(probe.rowCount).toBe(1);

        holder.release();
        await holder.done;
        purged = (await running).purgedItemIds;
      } finally {
        holder.release();
        await holder.done;
      }

      expect(purged.sort()).toEqual([...ids].sort());
      expect(await instancesOf(seriesId)).toEqual([]);
      expect(await seriesOf(seriesId)).toEqual([]);
    });

    it("trashes an instance that was stored while the delete waited for the series row", async () => {
      const { seriesId, open } = await seriesOfThree();
      const holder = holdLocks(async (client) => {
        await getTaskRecurrenceBySeriesId(client, seriesId, true);
      });
      await holder.locked;
      let stored = "";
      try {
        const running = trash(open);
        await waitUntilBlocked("FROM task_recurrence");
        // What the advance, the nightly close or the materializing of an occurrence does while it holds the series row.
        stored = await runInTenant(tenant, () =>
          createSeriesOccurrence(pool, {
            databaseId: databases.tasks!,
            seriesId,
            occurrenceDate: "2026-11-02",
            status: "notDone",
          }),
        );
        holder.release();
        await holder.done;
        await running;
      } finally {
        holder.release();
        await holder.done;
      }

      const rows = await instancesOf(seriesId);
      expect(rows).toHaveLength(4);
      expect(rows.find((row) => row.id === stored)?.deleted_at).not.toBeNull();
      expect(new Set(rows.map((row) => row.deleted_at?.getTime())).size).toBe(1);
      expect(await seriesOf(seriesId)).toMatchObject([{ active: false, trashed_active_item_id: open }]);
    });
  });
});
