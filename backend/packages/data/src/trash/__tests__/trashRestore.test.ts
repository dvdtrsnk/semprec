import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { registerItemRestoreHook } from "../../chokePoint/hooks.js";
import { runAfterCommit, withTransaction } from "../../db/pool.js";
import { ChokePointError, ValidationError } from "../../errors.js";
import { getOrCreateJournalItem } from "../../journal/journalStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createTrashRestoreRouteHandler } from "../trashRouteHandlers.js";

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let tenantId: string;

const USER = { writerKind: "user" } as const;
const ACTING_USER_ID = randomUUID();
const JOURNAL_REFERENCE = new Date("2026-10-16T12:00:00Z");
const ZONE = "Europe/Prague";
const WAIT_MS = 10_000;
/** The task name that makes the hook below fail with an error that is no refusal. */
const DEFECT_NAME = "restore hook defect";
/** The task name that makes the hook below queue an after-commit callback and then refuse with 409. */
const QUEUE_THEN_CONFLICT_NAME = "queues then conflicts";

const resultSchema = z.object({
  id: z.string(),
  kind: z.enum(["item", "database"]),
  status: z.enum(["restored", "not_found", "database_archived", "conflict"]),
});
const bodySchema = z.object({ results: z.array(resultSchema) }).strict();
type RestoreResult = z.infer<typeof resultSchema>;

/** After-commit side effects of the test hook below; a refused id must leave none. */
const hookSideEffects: string[] = [];

// A hook of this file's own, after the production hooks: a defect (an error that is no refusal) for one task name,
// and a callback queued for after the commit followed by a 409 for another.
registerItemRestoreHook(async ({ client, item }) => {
  if (item.properties.name === DEFECT_NAME) throw new Error("restore hook defect");
  if (item.properties.name === QUEUE_THEN_CONFLICT_NAME) {
    runAfterCommit(client, () => hookSideEffects.push(item.id));
    throw new ChokePointError(409, "restore_refused", "refused by the test hook");
  }
});

let events: InvalidationEvent[] = [];

/** Calls the handler as the adapter does: inside the tenant's scope, with the caller's id and the parsed body. */
async function restore(body: unknown, tenant = tenantId): Promise<RestoreResult[]> {
  const answer = await runInTenant(tenant, () =>
    createTrashRestoreRouteHandler(dataPool)({ body, identity: { user: { id: ACTING_USER_ID } } }),
  );
  expect(answer.status).toBe(200);
  // The body as JSON carries it, so a value JSON cannot represent would be noticed.
  return bodySchema.parse(JSON.parse(JSON.stringify(answer.body))).results;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected the handler to reject");
    },
    (error: unknown) => error,
  );
}

async function expectValidationFailure(body: unknown): Promise<void> {
  const error = await rejection(restore(body));
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).toMatchObject({ status: 400, code: "validation_failed" });
}

async function moduleDatabaseId(moduleId: string, tenant = tenantId): Promise<string> {
  const database = await runInTenant(tenant, () =>
    withTransaction(dataPool, (client) => databasesStore.getDatabaseByModuleId(client, moduleId)),
  );
  if (!database) throw new Error(`No ${moduleId} database`);
  return database.id;
}

async function createItem(databaseId: string, properties: Record<string, unknown>, tenant = tenantId): Promise<string> {
  return runInTenant(
    tenant,
    async () => (await chokePoint.createItem({ databaseId, properties }, undefined, undefined, USER)).id,
  );
}

async function createUserDatabase(name: string, tenant = tenantId): Promise<string> {
  return runInTenant(tenant, async () => (await chokePoint.createDatabase({ name })).id);
}

async function trash(databaseId: string, itemId: string, tenant = tenantId): Promise<void> {
  const deleted = await runInTenant(tenant, () => chokePoint.softDeleteItem(databaseId, itemId));
  expect(deleted?.deletedAt).not.toBeNull();
}

async function archive(databaseId: string, tenant = tenantId): Promise<void> {
  await runInTenant(tenant, () => chokePoint.archiveDatabase(databaseId));
}

/** A trashed item of the Tasks database. */
async function trashedTask(name: string, tenant = tenantId): Promise<string> {
  const databaseId = await moduleDatabaseId("tasks", tenant);
  const id = await createItem(databaseId, { name }, tenant);
  await trash(databaseId, id, tenant);
  return id;
}

/** The ids among `ids` that are in the Trash, read as the superuser: a ground truth, not an isolation check. */
async function trashedAmong(ids: readonly string[]): Promise<string[]> {
  const { rows } = await adminPool.query<{ id: string }>(
    "SELECT id FROM items WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL ORDER BY id",
    [ids],
  );
  return rows.map((row) => row.id);
}

async function archivedAmong(ids: readonly string[]): Promise<string[]> {
  const { rows } = await adminPool.query<{ id: string }>(
    "SELECT id FROM databases WHERE id = ANY($1::uuid[]) AND archived_at IS NOT NULL ORDER BY id",
    [ids],
  );
  return rows.map((row) => row.id);
}

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

/** The Journal day entry of 2026-10-16: a second call for the period returns the live one or creates a new entry. */
async function journalDayEntry(): Promise<string> {
  const journalId = await moduleDatabaseId("journal");
  return runInTenant(tenantId, () =>
    withTransaction(
      dataPool,
      async (client) => (await getOrCreateJournalItem(client, journalId, "day", JOURNAL_REFERENCE, ZONE)).id,
    ),
  );
}

/** The thin item and schema announcements the handler caused, as sorted `item:<op>:<id>` and `schema:<id>` strings. */
function announced(): string[] {
  return events
    .flatMap((event) => {
      if (event.scope === "item") return [`item:${event.op}:${event.itemId}`];
      if (event.scope === "schema") return [`schema:${event.databaseId}`];
      return [];
    })
    .sort();
}

describe("POST /api/trash/restore (issue gh-1904)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await runInTenant(tenantId, () => seedSystem(dataPool));
    events = [];
    hookSideEffects.length = 0;
    setInvalidationHook((event) => events.push(event));
  });

  afterEach(() => {
    setInvalidationHook(() => {});
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("restores the two ids that exist and reports the third as not_found", async () => {
    const first = await trashedTask("First");
    const second = await trashedTask("Second");
    const unknown = randomUUID();

    const results = await restore({ itemIds: [first, unknown, second] });

    expect(results).toEqual([
      { id: first, kind: "item", status: "restored" },
      { id: unknown, kind: "item", status: "not_found" },
      { id: second, kind: "item", status: "restored" },
    ]);
    expect(await trashedAmong([first, second])).toEqual([]);
  });

  it("restores a database together with its previously trashed items sent in the same body, databases first", async () => {
    const databaseId = await createUserDatabase("Archive me");
    const trashedItem = await createItem(databaseId, {});
    const liveItem = await createItem(databaseId, {});
    await trash(databaseId, trashedItem);
    await archive(databaseId);
    expect(await archivedAmong([databaseId])).toEqual([databaseId]);

    const results = await restore({ itemIds: [trashedItem], databaseIds: [databaseId] });

    expect(results).toEqual([
      { id: databaseId, kind: "database", status: "restored" },
      { id: trashedItem, kind: "item", status: "restored" },
    ]);
    expect(await archivedAmong([databaseId])).toEqual([]);
    expect(await trashedAmong([trashedItem, liveItem])).toEqual([]);
  });

  it("reports a Journal day whose period has a live entry as conflict, keeps it trashed and restores the tasks around it", async () => {
    const journalId = await moduleDatabaseId("journal");
    const oldEntry = await journalDayEntry();
    await trash(journalId, oldEntry);
    const liveEntry = await journalDayEntry();
    expect(liveEntry).not.toBe(oldEntry);
    const before = await trashedTask("Before the day");
    const after = await trashedTask("After the day");
    events = [];

    const results = await restore({ itemIds: [before, oldEntry, after] });

    expect(results).toEqual([
      { id: before, kind: "item", status: "restored" },
      { id: oldEntry, kind: "item", status: "conflict" },
      { id: after, kind: "item", status: "restored" },
    ]);
    expect(await trashedAmong([before, after, oldEntry, liveEntry])).toEqual([oldEntry]);
  });

  it("leaves no announcement and no after-commit callback behind for a refused id", async () => {
    const journalId = await moduleDatabaseId("journal");
    const oldEntry = await journalDayEntry();
    await trash(journalId, oldEntry);
    await journalDayEntry();
    const tasksDatabaseId = await moduleDatabaseId("tasks");
    const refusedTask = await createItem(tasksDatabaseId, { name: QUEUE_THEN_CONFLICT_NAME });
    await trash(tasksDatabaseId, refusedTask);
    const restoredTask = await trashedTask("Restored");
    const databaseId = await createUserDatabase("Restored database");
    await archive(databaseId);
    events = [];

    const results = await restore({ databaseIds: [databaseId], itemIds: [oldEntry, refusedTask, restoredTask] });

    expect(results.map((result) => result.status)).toEqual(["restored", "conflict", "conflict", "restored"]);
    // The announcements are the single restores': one `update` per restored row, one schema change per database.
    expect(announced()).toEqual(sorted([`item:update:${restoredTask}`, `schema:${databaseId}`]));
    // The hook queued a callback for after the commit before it refused, and the callback was dropped with its id.
    expect(hookSideEffects).toEqual([]);
    expect(await trashedAmong([oldEntry, refusedTask, restoredTask])).toEqual(sorted([oldEntry, refusedTask]));
  });

  it("reports an item of an archived database as database_archived and still restores the other ids", async () => {
    const databaseId = await createUserDatabase("Archived");
    const itemInArchived = await createItem(databaseId, {});
    await trash(databaseId, itemInArchived);
    await archive(databaseId);
    const task = await trashedTask("Restorable");

    const results = await restore({ itemIds: [itemInArchived, task] });

    expect(results).toEqual([
      { id: itemInArchived, kind: "item", status: "database_archived" },
      { id: task, kind: "item", status: "restored" },
    ]);
    expect(await trashedAmong([itemInArchived, task])).toEqual([itemInArchived]);
    expect(await archivedAmong([databaseId])).toEqual([databaseId]);
  });

  it("answers a repeated call with restored for every id and changes nothing", async () => {
    const task = await trashedTask("Repeated");
    const databaseId = await createUserDatabase("Repeated database");
    await archive(databaseId);
    const body = { databaseIds: [databaseId], itemIds: [task] };
    await restore(body);
    const stateOf = async () => {
      const items = await adminPool.query("SELECT id, updated_at, deleted_at FROM items WHERE id = $1", [task]);
      const databases = await adminPool.query("SELECT id, archived_at, purge_at FROM databases WHERE id = $1", [
        databaseId,
      ]);
      return { items: items.rows, databases: databases.rows };
    };
    const afterFirst = await stateOf();
    events = [];

    const results = await restore(body);

    expect(results).toEqual([
      { id: databaseId, kind: "database", status: "restored" },
      { id: task, kind: "item", status: "restored" },
    ]);
    expect(await stateOf()).toEqual(afterFirst);
    // A live item is not announced again.
    expect(announced()).not.toContain(`item:update:${task}`);
  });

  it("reports an item that is not in the Trash as restored and a database that is not archived as restored", async () => {
    const tasksDatabaseId = await moduleDatabaseId("tasks");
    const live = await createItem(tasksDatabaseId, { name: "Live" });
    const databaseId = await createUserDatabase("Live database");

    const results = await restore({ itemIds: [live], databaseIds: [databaseId] });

    expect(results).toEqual([
      { id: databaseId, kind: "database", status: "restored" },
      { id: live, kind: "item", status: "restored" },
    ]);
    expect(await trashedAmong([live])).toEqual([]);
    expect(await archivedAmong([databaseId])).toEqual([]);
  });

  it("reports an unknown database id as not_found and restores the databases around it", async () => {
    const first = await createUserDatabase("First");
    const second = await createUserDatabase("Second");
    await archive(first);
    await archive(second);
    const unknown = randomUUID();

    const results = await restore({ databaseIds: [first, unknown, second] });

    expect(results).toEqual([
      { id: first, kind: "database", status: "restored" },
      { id: unknown, kind: "database", status: "not_found" },
      { id: second, kind: "database", status: "restored" },
    ]);
    expect(await archivedAmong([first, second])).toEqual([]);
  });

  it("merges duplicate ids, also across upper and lower case, and answers each id once in request order", async () => {
    const first = await trashedTask("First");
    const second = await trashedTask("Second");

    const results = await restore({ itemIds: [second, first.toUpperCase(), second, first] });

    expect(results).toEqual([
      { id: second, kind: "item", status: "restored" },
      { id: first, kind: "item", status: "restored" },
    ]);
  });

  it("restores nothing and aborts with the error of a hook defect that is no refusal", async () => {
    const tasksDatabaseId = await moduleDatabaseId("tasks");
    const defect = await createItem(tasksDatabaseId, { name: DEFECT_NAME });
    await trash(tasksDatabaseId, defect);
    const before = await trashedTask("Restored before the defect");
    const databaseId = await createUserDatabase("Restored before the defect");
    await archive(databaseId);
    events = [];

    const error = await rejection(restore({ databaseIds: [databaseId], itemIds: [before, defect] }));

    expect(error).toMatchObject({ message: "restore hook defect" });
    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(await trashedAmong([before, defect])).toEqual(sorted([before, defect]));
    expect(await archivedAmong([databaseId])).toEqual([databaseId]);
    expect(announced()).toEqual([]);
  });

  it("reports an item that was purged between its lookup and its lock as not_found", async () => {
    const tasksDatabaseId = await moduleDatabaseId("tasks");
    const purged = await createItem(tasksDatabaseId, { name: "Purged meanwhile" });
    await trash(tasksDatabaseId, purged);
    const other = await trashedTask("Restored meanwhile");

    const holder = await adminPool.connect();
    let handler: Promise<RestoreResult[]> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("No backend pid");
      await holder.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [purged]);
      handler = restore({ itemIds: [purged, other] });
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const { rows } = await adminPool.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        if ((rows[0]?.waiting ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("The restore never waited for the row lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The purge the sweep would run: the row is gone when the waiting restore gets its lock.
      await holder.query("DELETE FROM items WHERE id = $1", [purged]);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      await handler?.catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }

    expect(await handler).toEqual([
      { id: purged, kind: "item", status: "not_found" },
      { id: other, kind: "item", status: "restored" },
    ]);
  });

  it("reports a database that was purged between its lookup and its restore as not_found", async () => {
    const purged = await createUserDatabase("Purged meanwhile");
    await archive(purged);
    const other = await createUserDatabase("Restored meanwhile");
    await archive(other);
    events = [];

    const holder = await adminPool.connect();
    let handler: Promise<RestoreResult[]> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (pid === undefined) throw new Error("No backend pid");
      await holder.query("SELECT id FROM databases WHERE id = $1 FOR UPDATE", [purged]);
      handler = restore({ databaseIds: [purged, other] });
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const { rows } = await adminPool.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
          [pid],
        );
        if ((rows[0]?.waiting ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("The restore never waited for the row lock");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The purge the sweep would run: the row is gone when the waiting restore gets its lock.
      await holder.query("DELETE FROM databases WHERE id = $1", [purged]);
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK").catch(() => undefined);
      await handler?.catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }

    expect(await handler).toEqual([
      { id: purged, kind: "database", status: "not_found" },
      { id: other, kind: "database", status: "restored" },
    ]);
    expect(await archivedAmong([other])).toEqual([]);
    expect(announced()).toEqual([`schema:${other}`]);
  });

  describe("tenant isolation (runtime role pool)", () => {
    it("answers another tenant's ids exactly like unknown ones and leaves that tenant's rows trashed", async () => {
      const otherTenant = await createTestTenant(adminPool);
      await runInTenant(otherTenant, () => seedSystem(dataPool));
      const foreignTask = await trashedTask("Foreign task", otherTenant);
      const foreignDatabase = await createUserDatabase("Foreign database", otherTenant);
      await archive(foreignDatabase, otherTenant);
      const ownTask = await trashedTask("Own task");

      const foreign = await restore({ databaseIds: [foreignDatabase], itemIds: [foreignTask, ownTask] });
      const random = await restore({ databaseIds: [randomUUID()], itemIds: [randomUUID(), ownTask] });

      expect(foreign.map(({ kind, status }) => ({ kind, status }))).toEqual(
        random.map(({ kind, status }) => ({ kind, status })),
      );
      expect(foreign.map((result) => result.status)).toEqual(["not_found", "not_found", "restored"]);
      expect(await trashedAmong([foreignTask])).toEqual([foreignTask]);
      expect(await archivedAmong([foreignDatabase])).toEqual([foreignDatabase]);
      expect(await trashedAmong([ownTask])).toEqual([]);
    });
  });

  describe("the body", () => {
    it("is 400 validation_failed above 100 ids in total, and the 100th still passes", async () => {
      const ids = (count: number): string[] => Array.from({ length: count }, () => randomUUID());
      const task = await trashedTask("Not restored by a refused body");

      await expectValidationFailure({ itemIds: ids(101) });
      await expectValidationFailure({ itemIds: [task, ...ids(50)], databaseIds: ids(50) });
      expect(await trashedAmong([task])).toEqual([task]);

      const exactly = await restore({ itemIds: ids(50), databaseIds: ids(50) });
      expect(exactly).toHaveLength(100);
      // 101 entries of which one is repeated are 100 ids.
      const repeated = randomUUID();
      expect(await restore({ itemIds: [...ids(99), repeated, repeated] })).toHaveLength(100);
    });

    it.each([
      ["no body", undefined],
      ["a null body", null],
      ["an array", []],
      ["an empty object", {}],
      ["two empty lists", { itemIds: [], databaseIds: [] }],
      ["an unknown key", { itemIds: [randomUUID()], projectIds: [randomUUID()] }],
      ["an id that is not a UUID", { itemIds: ["not-a-uuid"] }],
      ["a database id that is not a UUID", { databaseIds: [randomUUID(), 7] }],
      ["a list that is not a list", { itemIds: randomUUID() }],
    ])("is 400 validation_failed for %s", async (_label, body) => {
      await expectValidationFailure(body);
    });

    it("writes nothing when one id of the body is malformed", async () => {
      const task = await trashedTask("Not restored");

      await expectValidationFailure({ itemIds: [task, "not-a-uuid"] });

      expect(await trashedAmong([task])).toEqual([task]);
    });
  });
});
