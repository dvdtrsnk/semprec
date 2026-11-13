import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { purgeExpiredTrash, RETENTION_DAYS } from "../purgeExpiredTrash.js";
import { createTrashDatabasesRouteHandler, createTrashItemsRouteHandler } from "../trashRouteHandlers.js";

let adminPool: Pool;
let dataPool: Pool;
let chokePoint: ChokePoint;
let tenantId: string;

const USER = { writerKind: "user" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The instant the handler reads as now; only `Date` is faked, so Postgres keeps its own clock. */
const NOW = new Date("2026-06-15T10:00:00.000Z");

const rowSchema = z
  .object({
    item: z
      .object({
        id: z.string(),
        databaseId: z.string(),
        properties: z.record(z.string(), z.unknown()),
        computed: z.record(z.string(), z.unknown()),
        updatedAt: z.string(),
        deletedAt: z.string(),
      })
      .strict(),
    databaseId: z.string(),
    databaseKey: z.string().nullable(),
    ownerModuleId: z.string().nullable(),
    databaseName: z.string(),
    deletedAt: z.string(),
    purgeAt: z.string(),
    daysLeft: z.number(),
  })
  .strict();
const bodySchema = z
  .object({ items: z.array(rowSchema), totalCount: z.number(), nextCursor: z.string().nullable() })
  .strict();
type Body = z.infer<typeof bodySchema>;

/** The days before `NOW` as an ISO instant, the time of day unchanged. */
function daysBeforeNow(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

/** Calls the handler as the adapter does: inside the tenant's scope, with the request URL and the caller's locale. */
async function list(query = "", options: { tenant?: string; locale?: string } = {}): Promise<Body> {
  const result = await runInTenant(options.tenant ?? tenantId, () =>
    createTrashItemsRouteHandler(dataPool)({
      req: { url: `/api/trash/items${query}` },
      identity: { user: { locale: options.locale ?? "en" } },
    }),
  );
  expect(result.status).toBe(200);
  // The body as JSON carries it, so a value JSON cannot represent would be noticed.
  return bodySchema.parse(JSON.parse(JSON.stringify(result.body)));
}

const ids = (body: Body): string[] => body.items.map((row) => row.item.id);

async function moduleDatabaseId(moduleId: string, tenant = tenantId): Promise<string> {
  const database = await runInTenant(tenant, () =>
    withTransaction(dataPool, (client) => databasesStore.getDatabaseByModuleId(client, moduleId)),
  );
  if (!database) throw new Error(`No ${moduleId} database`);
  return database.id;
}

async function createItem(databaseId: string, properties: Record<string, unknown>, tenant = tenantId): Promise<string> {
  return runInTenant(tenant, async () => {
    const item = await chokePoint.createItem({ databaseId, properties }, undefined, undefined, USER);
    return item.id;
  });
}

/**
 * Gives the trash epoch of `rootId` (the `deleted_at` its cascade stamped on `expectedRows` rows) the instant `at`.
 * Raw SQL on the superuser pool because the choke point stamps the transaction's `now()` and cannot trash an item at
 * a chosen instant; the statement keeps the rows of one epoch on one `deleted_at`, as the cascade leaves them.
 */
async function setTrashEpoch(rootId: string, at: string, expectedRows: number): Promise<void> {
  const result = await adminPool.query(
    `UPDATE items SET deleted_at = $2::timestamptz
      WHERE deleted_at = (SELECT deleted_at FROM items WHERE id = $1 AND deleted_at IS NOT NULL)`,
    [rootId, at],
  );
  expect(result.rowCount).toBe(expectedRows);
}

/** Soft-deletes `itemId` through the choke point, then moves its epoch to `at`. */
async function trash(
  databaseId: string,
  itemId: string,
  at: string,
  options: { expectedRows?: number; tenant?: string } = {},
): Promise<void> {
  await runInTenant(options.tenant ?? tenantId, () => chokePoint.softDeleteItem(databaseId, itemId));
  await setTrashEpoch(itemId, at, options.expectedRows ?? 1);
}

async function createUserDatabase(name: string, tenant = tenantId): Promise<string> {
  return runInTenant(tenant, async () => (await chokePoint.createDatabase({ name })).id);
}

async function createInlineDatabase(name: string, parentItemId: string): Promise<string> {
  return runInTenant(tenantId, async () => (await chokePoint.createInlineDatabase({ name, parentItemId })).id);
}

async function setZone(timezone: string): Promise<void> {
  await runInTenant(tenantId, async () => {
    const databaseId = await withTransaction(dataPool, (client) => getSystemSettingsDatabaseId(client));
    const itemId = await withTransaction(dataPool, (client) => getSystemSettingsItemId(client));
    await chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { timezone } });
  });
}

/** A storage double whose only exercised method is `delete`; the purge never reads or writes bytes. */
function fakeStorage(): BlobStorageWriter {
  return {
    writeStream: () => Promise.reject(new Error("not used by the purge")),
    readStream: () => {
      throw new Error("not used by the purge");
    },
    delete: vi.fn(async () => {}),
  };
}

async function itemExists(itemId: string): Promise<boolean> {
  const { rows } = await adminPool.query("SELECT 1 FROM items WHERE id = $1", [itemId]);
  return rows.length === 1;
}

describe("GET /api/trash/items (issue gh-1851)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await runInTenant(tenantId, () => seedSystem(dataPool));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("lists a deleted task and a deleted project with an inline database as two rows, newest first, not the inline database's items", async () => {
    const tasksDatabaseId = await moduleDatabaseId("tasks");
    const projectsDatabaseId = await moduleDatabaseId("projects");
    const taskId = await createItem(tasksDatabaseId, { name: "Pay rent" });
    const projectId = await createItem(projectsDatabaseId, { name: "Renovation" });
    const inlineDatabaseId = await createInlineDatabase("Notes", projectId);
    const inlineItemId = await createItem(inlineDatabaseId, {});
    const liveItemId = await createItem(tasksDatabaseId, { name: "Still live" });
    await trash(projectsDatabaseId, projectId, daysBeforeNow(26), { expectedRows: 2 });
    await trash(tasksDatabaseId, taskId, NOW.toISOString());

    const body = await list();

    expect(ids(body)).toEqual([taskId, projectId]);
    expect(body.items.map((row) => row.daysLeft)).toEqual([30, 4]);
    expect(body.totalCount).toBe(2);
    expect(body.nextCursor).toBeNull();
    expect(ids(body)).not.toContain(inlineItemId);
    expect(ids(body)).not.toContain(liveItemId);
    // A database is never a row of its own: every row is an item, and no row's id is a database's.
    expect(ids(body)).not.toContain(tasksDatabaseId);
    expect(ids(body)).not.toContain(projectsDatabaseId);
    expect(ids(body)).not.toContain(inlineDatabaseId);
    const [task, project] = body.items;
    expect(task).toMatchObject({
      item: { id: taskId, databaseId: tasksDatabaseId, properties: { name: "Pay rent" }, deletedAt: NOW.toISOString() },
      databaseId: tasksDatabaseId,
      databaseKey: "tasks",
      deletedAt: NOW.toISOString(),
    });
    expect(project).toMatchObject({ databaseId: projectsDatabaseId, databaseKey: "projects" });
  });

  it("gives purgeAt as deletedAt plus RETENTION_DAYS and daysLeft by the same constant", async () => {
    const databaseId = await createUserDatabase("Movies");
    const itemId = await createItem(databaseId, {});
    await trash(databaseId, itemId, daysBeforeNow(26));

    const [row] = (await list()).items;

    expect(RETENTION_DAYS).toBe(30);
    expect(row?.deletedAt).toBe(daysBeforeNow(26));
    expect(row?.purgeAt).toBe(daysBeforeNow(26 - RETENTION_DAYS));
    expect(row?.daysLeft).toBe(RETENTION_DAYS - 26);
  });

  it("lists an item trashed alone inside an inline database whose owner is live", async () => {
    const projectsDatabaseId = await moduleDatabaseId("projects");
    const projectId = await createItem(projectsDatabaseId, { name: "Renovation" });
    const inlineDatabaseId = await createInlineDatabase("Notes", projectId);
    const noteId = await createItem(inlineDatabaseId, {});
    await trash(inlineDatabaseId, noteId, NOW.toISOString());

    const body = await list();

    expect(ids(body)).toEqual([noteId]);
    expect(body.items[0]).toMatchObject({ databaseId: inlineDatabaseId, databaseKey: null, databaseName: "Notes" });
  });

  it("lists an item trashed on its own before its owner was deleted next to the owner, and not the item that went with the owner", async () => {
    const projectsDatabaseId = await moduleDatabaseId("projects");
    const projectId = await createItem(projectsDatabaseId, { name: "Renovation" });
    const inlineDatabaseId = await createInlineDatabase("Notes", projectId);
    const earlierNoteId = await createItem(inlineDatabaseId, {});
    const togetherNoteId = await createItem(inlineDatabaseId, {});
    await trash(inlineDatabaseId, earlierNoteId, daysBeforeNow(2));
    // The cascade skips the note that is already in the trash, so only the project and the other note share this epoch.
    await trash(projectsDatabaseId, projectId, daysBeforeNow(1), { expectedRows: 2 });

    const body = await list();

    expect(ids(body)).toEqual([projectId, earlierNoteId]);
    expect(ids(body)).not.toContain(togetherNoteId);
    expect(body.totalCount).toBe(2);
  });

  it("does not list an item deleted before its database was archived, and still lists the items of live databases", async () => {
    const archivedDatabaseId = await createUserDatabase("Old");
    const liveDatabaseId = await createUserDatabase("Current");
    const archivedItemId = await createItem(archivedDatabaseId, {});
    const liveItemId = await createItem(liveDatabaseId, {});
    await trash(archivedDatabaseId, archivedItemId, NOW.toISOString());
    await trash(liveDatabaseId, liveItemId, NOW.toISOString());
    expect(ids(await list())).toHaveLength(2);

    await runInTenant(tenantId, () => chokePoint.archiveDatabase(archivedDatabaseId));
    const body = await list();

    expect(ids(body)).toEqual([liveItemId]);
    expect(body.totalCount).toBe(1);
  });

  it("does not list the items that went with an owner kept in an archived database", async () => {
    const hostDatabaseId = await createUserDatabase("Host");
    const hostId = await createItem(hostDatabaseId, {});
    const inlineDatabaseId = await createInlineDatabase("Notes", hostId);
    const noteId = await createItem(inlineDatabaseId, {});
    await trash(hostDatabaseId, hostId, NOW.toISOString(), { expectedRows: 2 });
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(hostDatabaseId));

    const body = await list();

    expect(ids(body)).not.toContain(noteId);
    expect(body.items).toEqual([]);
    expect(body.totalCount).toBe(0);
  });

  it("gives an item of a user database a null databaseKey, a null ownerModuleId and the stored database name", async () => {
    const databaseId = await createUserDatabase("Movies");
    const itemId = await createItem(databaseId, {});
    await trash(databaseId, itemId, NOW.toISOString());

    const body = await list("", { locale: "cs" });

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      item: { id: itemId },
      databaseId,
      databaseKey: null,
      ownerModuleId: null,
      databaseName: "Movies",
    });
  });

  it("names the database of a system database item from the catalog in the caller's locale, English for any other", async () => {
    const tasksDatabaseId = await moduleDatabaseId("tasks");
    const taskId = await createItem(tasksDatabaseId, { name: "Pay rent" });
    await trash(tasksDatabaseId, taskId, NOW.toISOString());

    expect((await list("", { locale: "en" })).items[0]?.databaseName).toBe("Tasks");
    expect((await list("", { locale: "cs" })).items[0]?.databaseName).toBe("Úkoly");
    expect((await list("", { locale: "de" })).items[0]?.databaseName).toBe("Tasks");
    expect((await list("", { locale: "cs" })).items[0]).toMatchObject({ databaseKey: "tasks", ownerModuleId: "tasks" });
  });

  describe("paging", () => {
    it("returns every row once across the pages, in order, with the same totalCount on each page, even with equal deleted_at", async () => {
      const databaseId = await createUserDatabase("Movies");
      // Three items share one instant to the microsecond; two more differ from it by one microsecond.
      const instants = [
        "2026-06-14T10:00:00.123456Z",
        "2026-06-14T10:00:00.123456Z",
        "2026-06-14T10:00:00.123456Z",
        "2026-06-14T10:00:00.123457Z",
        "2026-06-14T10:00:00.123455Z",
      ];
      const trashed: { id: string; at: string }[] = [];
      for (const at of instants) {
        const itemId = await createItem(databaseId, {});
        await trash(databaseId, itemId, at);
        trashed.push({ id: itemId, at });
      }
      // The list order: newest deletion first, then the id; a uuid's hex text sorts as Postgres sorts its bytes.
      const expected = [...trashed]
        .sort((left, right) => (left.at !== right.at ? (left.at < right.at ? 1 : -1) : left.id < right.id ? -1 : 1))
        .map((entry) => entry.id);
      expect(ids(await list("?limit=200"))).toEqual(expected);

      const seen: string[] = [];
      const totals: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const body: Body = await list(`?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
        seen.push(...ids(body));
        totals.push(body.totalCount);
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(expected);
      expect(totals).toEqual([5, 5, 5]);
    });

    it("answers a last page that is exactly full with a null nextCursor", async () => {
      const databaseId = await createUserDatabase("Movies");
      for (let index = 0; index < 2; index += 1) {
        const itemId = await createItem(databaseId, {});
        await trash(databaseId, itemId, daysBeforeNow(index + 1));
      }

      const body = await list("?limit=2");

      expect(body.items).toHaveLength(2);
      expect(body.nextCursor).toBeNull();
    });

    it("pages 50 rows by default and up to 200 on request", async () => {
      const databaseId = await createUserDatabase("Movies");
      for (let index = 0; index < 51; index += 1) await createItem(databaseId, {});
      // Raw SQL because 51 cascade transactions add nothing here: an item without children is left in exactly this state by a delete.
      const trashed = await adminPool.query(
        `UPDATE items SET deleted_at = $2::timestamptz WHERE database_id = $1 AND deleted_at IS NULL`,
        [databaseId, daysBeforeNow(3)],
      );
      expect(trashed.rowCount).toBe(51);

      const byDefault = await list();
      const maximum = await list("?limit=200");

      expect(byDefault.items).toHaveLength(50);
      expect(byDefault.nextCursor).not.toBeNull();
      expect(byDefault.totalCount).toBe(51);
      expect(maximum.items).toHaveLength(51);
      expect(maximum.nextCursor).toBeNull();
    });

    it.each(["0", "201", "-1", "1.5", "abc", "", "1e2", "0050", "5 "])("refuses limit=%j", async (limit) => {
      await expect(list(`?limit=${encodeURIComponent(limit)}`)).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "limit" },
      });
    });

    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    /**
     * A second base64url spelling of a valid cursor: the JSON is padded to a length that leaves spare bits in the
     * last character, which is then set to a value that decodes to the same bytes.
     */
    const nonCanonicalCursor = (): string => {
      let json = JSON.stringify({ at: "2026-06-14T10:00:00.123456Z", id: "11111111-1111-4111-8111-111111111111" });
      while (json.length % 3 !== 1) json += " ";
      const canonical = Buffer.from(json).toString("base64url");
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const spelled = canonical.slice(0, -1) + alphabet[alphabet.indexOf(canonical.slice(-1)) + 1];
      expect(Buffer.from(spelled, "base64url").toString()).toBe(json);
      return spelled;
    };
    it.each([
      ["characters outside base64url", "a+b/"],
      ["bytes that are not JSON", Buffer.from("not json").toString("base64url")],
      ["a second spelling of a valid value", nonCanonicalCursor()],
      [
        "a padded value",
        `${encode({ at: "2026-06-14T10:00:00.123456Z", id: "11111111-1111-4111-8111-111111111111" })}=`,
      ],
      ["a JSON array", encode([])],
      ["a missing id", encode({ at: "2026-06-14T10:00:00.123456Z" })],
      ["an id that is not a uuid", encode({ at: "2026-06-14T10:00:00.123456Z", id: "nope" })],
      ["a time that is not an instant", encode({ at: "yesterday", id: "11111111-1111-4111-8111-111111111111" })],
      [
        "a time with fewer than six fraction digits",
        encode({ at: "2026-06-14T10:00:00Z", id: "11111111-1111-4111-8111-111111111111" }),
      ],
      [
        "an extra field",
        encode({ at: "2026-06-14T10:00:00.123456Z", id: "11111111-1111-4111-8111-111111111111", x: 1 }),
      ],
      ["a value over 256 characters", "a".repeat(257)],
    ])("refuses a cursor with %s", async (_label, cursor) => {
      await expect(list(`?cursor=${encodeURIComponent(cursor)}`)).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field: "cursor" },
      });
    });
  });

  describe("daysLeft", () => {
    it("counts calendar days in the tenant's zone, not hours", async () => {
      // 29 days and 23 hours have passed, and the clock changed to summer time in between: the purge day is today.
      vi.setSystemTime(new Date("2026-04-09T22:30:00.000Z"));
      const databaseId = await createUserDatabase("Movies");
      const itemId = await createItem(databaseId, {});
      await trash(databaseId, itemId, "2026-03-10T23:30:00.000Z");

      expect((await list()).items[0]?.daysLeft).toBe(0);

      // A day earlier, the day before the purge day still has one day left.
      vi.setSystemTime(new Date("2026-04-08T22:30:00.000Z"));
      expect((await list()).items[0]?.daysLeft).toBe(1);
    });

    it("reads the day in the zone of the System settings", async () => {
      const databaseId = await createUserDatabase("Movies");
      const itemId = await createItem(databaseId, {});
      await trash(databaseId, itemId, "2026-06-15T10:00:00.000Z");
      vi.setSystemTime(new Date("2026-06-15T13:00:00.000Z"));
      expect((await list()).items[0]?.daysLeft).toBe(30);

      // 13:00 UTC is already the next day in Auckland.
      await setZone("Pacific/Auckland");
      expect((await list()).items[0]?.daysLeft).toBe(29);
    });

    it("never goes below 0 for an item the sweep has not purged yet", async () => {
      const databaseId = await createUserDatabase("Movies");
      const itemId = await createItem(databaseId, {});
      await trash(databaseId, itemId, daysBeforeNow(40));

      expect((await list()).items[0]?.daysLeft).toBe(0);
    });
  });

  it("lists, with daysLeft 0, exactly the items the purge sweep removes with its default retention", async () => {
    const databaseId = await createUserDatabase("Movies");
    const dueId = await createItem(databaseId, {});
    const keptId = await createItem(databaseId, {});
    await trash(databaseId, dueId, new Date(NOW.getTime() - RETENTION_DAYS * DAY_MS - 60_000).toISOString());
    await trash(databaseId, keptId, new Date(NOW.getTime() - RETENTION_DAYS * DAY_MS + 60_000).toISOString());
    const before = await list();
    expect(before.items.map((row) => [row.item.id, row.daysLeft])).toEqual([
      [keptId, 0],
      [dueId, 0],
    ]);

    const purged = await runInTenant(tenantId, () => purgeExpiredTrash(dataPool, fakeStorage()));

    expect(purged).toBe(1);
    expect(await itemExists(dueId)).toBe(false);
    expect(await itemExists(keptId)).toBe(true);
    expect(ids(await list())).toEqual([keptId]);
  });

  it("shows a tenant its own trash only, with its own totalCount, through the runtime role pool", async () => {
    const otherTenantId = await createTestTenant(adminPool);
    await runInTenant(otherTenantId, () => seedSystem(dataPool));
    const ownDatabaseId = await createUserDatabase("Movies");
    const otherDatabaseId = await createUserDatabase("Books", otherTenantId);
    const ownItemId = await createItem(ownDatabaseId, {});
    const otherItemId = await createItem(otherDatabaseId, {}, otherTenantId);
    const otherTaskId = await createItem(
      await moduleDatabaseId("tasks", otherTenantId),
      { name: "Foreign" },
      otherTenantId,
    );
    await trash(ownDatabaseId, ownItemId, NOW.toISOString());
    await trash(otherDatabaseId, otherItemId, NOW.toISOString(), { tenant: otherTenantId });
    await trash(await moduleDatabaseId("tasks", otherTenantId), otherTaskId, NOW.toISOString(), {
      tenant: otherTenantId,
    });

    const own = await list();
    const other = await list("", { tenant: otherTenantId });

    expect(ids(own)).toEqual([ownItemId]);
    expect(own.totalCount).toBe(1);
    expect(ids(other).sort()).toEqual([otherItemId, otherTaskId].sort());
    expect(other.totalCount).toBe(2);
  });

  it("answers an empty trash with no rows, a zero total and no cursor", async () => {
    expect(await list()).toEqual({ items: [], totalCount: 0, nextCursor: null });
  });
});

const databaseRowSchema = z
  .object({
    id: z.string(),
    key: z.string().nullable(),
    name: z.string().nullable(),
    liveItemCount: z.number(),
    archivedAt: z.string(),
    purgeAt: z.string().nullable(),
    daysLeft: z.number().nullable(),
  })
  .strict();
const databasesBodySchema = z.object({ databases: z.array(databaseRowSchema), totalCount: z.number() }).strict();
type DatabasesBody = z.infer<typeof databasesBodySchema>;

/** Calls the handler as the adapter does, inside the tenant's scope; the route takes no parameters. */
async function listDatabases(tenant = tenantId): Promise<DatabasesBody> {
  const result = await runInTenant(tenant, () => createTrashDatabasesRouteHandler(dataPool)());
  expect(result.status).toBe(200);
  return databasesBodySchema.parse(JSON.parse(JSON.stringify(result.body)));
}

const databaseIds = (body: DatabasesBody): string[] => body.databases.map((row) => row.id);

describe("GET /api/trash/databases (issue gh-1873)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await runInTenant(tenantId, () => seedSystem(dataPool));
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("lists an archived user database with its stored name, its live item count and its archive time, and no deadline when it has none", async () => {
    const databaseId = await createUserDatabase("Old movies");
    const itemIds: string[] = [];
    for (let count = 0; count < 4; count += 1) itemIds.push(await createItem(databaseId, {}));
    await runInTenant(tenantId, () => chokePoint.softDeleteItem(databaseId, itemIds[0] ?? ""));
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(databaseId));
    // A database archived before deadlines existed has none until the sweep sees it; the archive now stamps one.
    await adminPool.query("UPDATE databases SET purge_at = NULL WHERE id = $1", [databaseId]);
    const { rows } = await adminPool.query<{ archived_at: Date }>("SELECT archived_at FROM databases WHERE id = $1", [
      databaseId,
    ]);

    const body = await listDatabases();

    expect(body.totalCount).toBe(1);
    expect(body.databases).toEqual([
      {
        id: databaseId,
        key: null,
        name: "Old movies",
        liveItemCount: 3,
        archivedAt: rows[0]?.archived_at.toISOString(),
        purgeAt: null,
        daysLeft: null,
      },
    ]);
  });

  it("reports the stored purge deadline and the calendar days left until its day in the tenant's zone", async () => {
    const databaseId = await createUserDatabase("Deadline");
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(databaseId));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const setDeadline = (purgeAt: string) =>
        adminPool.query("UPDATE databases SET purge_at = $2::timestamptz WHERE id = $1", [databaseId, purgeAt]);
      const row = async () => (await listDatabases()).databases[0];

      // 30 days after the fake now, at 20:00 UTC: the deadline's day is 30 days ahead in UTC.
      await setDeadline("2026-07-15T20:00:00.000Z");
      expect(await row()).toMatchObject({ purgeAt: "2026-07-15T20:00:00.000Z", daysLeft: 30 });

      // The same instant is the next calendar day in Auckland (UTC+12), where it is also already evening.
      await setZone("Pacific/Auckland");
      expect((await row())?.daysLeft).toBe(31);
      await setZone("UTC");

      await setDeadline("2026-06-15T23:00:00.000Z");
      expect((await row())?.daysLeft).toBe(0);
      // A deadline that has passed, which the sweep has not carried out yet, never goes below 0.
      await setDeadline("2026-06-10T08:00:00.000Z");
      expect(await row()).toMatchObject({ purgeAt: "2026-06-10T08:00:00.000Z", daysLeft: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stamps a deadline of RETENTION_DAYS days when a database is archived, and drops it from the list again on a restore", async () => {
    const databaseId = await createUserDatabase("Stamped");
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(databaseId));

    const [row] = (await listDatabases()).databases;

    expect(row?.daysLeft).toBe(RETENTION_DAYS);
    expect(new Date(row?.purgeAt ?? "").getTime() - new Date(row?.archivedAt ?? "").getTime()).toBe(
      RETENTION_DAYS * DAY_MS,
    );
    await runInTenant(tenantId, () => chokePoint.restoreDatabase(databaseId));
    expect((await listDatabases()).databases).toEqual([]);
  });

  it("reports zero live items for an archived database that holds none", async () => {
    const databaseId = await createUserDatabase("Empty");
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(databaseId));

    expect((await listDatabases()).databases.map((row) => row.liveItemCount)).toEqual([0]);
  });

  it("does not list a live database", async () => {
    const liveId = await createUserDatabase("Current");
    const archivedId = await createUserDatabase("Old");
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(archivedId));

    const body = await listDatabases();

    expect(databaseIds(body)).toEqual([archivedId]);
    expect(databaseIds(body)).not.toContain(liveId);
  });

  it("never lists a system database, not even one whose archived_at is set", async () => {
    const tasksDatabaseId = await moduleDatabaseId("tasks");
    // The choke point refuses to archive a system database, so the state this test guards against needs raw SQL.
    await adminPool.query("UPDATE databases SET archived_at = now() WHERE id = $1", [tasksDatabaseId]);
    const userId = await createUserDatabase("Old");
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(userId));

    const body = await listDatabases();

    expect(databaseIds(body)).toEqual([userId]);
    expect(body.totalCount).toBe(1);
  });

  it("orders by archive time, newest first, and by id for databases archived at the same instant", async () => {
    const firstId = await createUserDatabase("First");
    const secondId = await createUserDatabase("Second");
    const thirdId = await createUserDatabase("Third");
    const fourthId = await createUserDatabase("Fourth");
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(secondId));
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(firstId));
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(thirdId));
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(fourthId));
    // The choke point stamps the transaction's now(), so two databases can only share an instant by raw SQL.
    await adminPool.query("UPDATE databases SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ANY($1::uuid[])", [
      [thirdId, fourthId],
    ]);

    const body = await listDatabases();

    expect(databaseIds(body)).toEqual([firstId, secondId, ...[thirdId, fourthId].sort()]);
  });

  it("drops a database from the list once it is restored", async () => {
    const keptId = await createUserDatabase("Kept");
    const restoredId = await createUserDatabase("Restored");
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(keptId));
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(restoredId));
    expect(databaseIds(await listDatabases())).toContain(restoredId);

    await runInTenant(tenantId, () => chokePoint.restoreDatabase(restoredId));
    const body = await listDatabases();

    expect(databaseIds(body)).toEqual([keptId]);
    expect(body.totalCount).toBe(1);
  });

  it("answers an empty trash with no rows and a zero total", async () => {
    expect(await listDatabases()).toEqual({ databases: [], totalCount: 0 });
  });

  it("returns at most 500 rows and the real number of archived databases as totalCount", async () => {
    // 501 archived databases without a partition each: a state the API produces one slow create at a time.
    await adminPool.query(
      `INSERT INTO databases (name, tenant_id, archived_at)
       SELECT 'Bulk ' || n, $1::uuid, now() - make_interval(secs => n)
         FROM generate_series(1, 501) AS n`,
      [tenantId],
    );

    const body = await listDatabases();

    expect(body.databases).toHaveLength(500);
    expect(body.totalCount).toBe(501);
    expect(body.databases[0]?.name).toBe("Bulk 1");
    expect(body.databases.at(-1)?.name).toBe("Bulk 500");
  });

  it("shows a tenant its own archived databases only, through the runtime role pool", async () => {
    const otherTenantId = await createTestTenant(adminPool);
    await runInTenant(otherTenantId, () => seedSystem(dataPool));
    const ownId = await createUserDatabase("Own");
    const otherId = await createUserDatabase("Foreign", otherTenantId);
    await createItem(otherId, {}, otherTenantId);
    await runInTenant(tenantId, () => chokePoint.archiveDatabase(ownId));
    await runInTenant(otherTenantId, () => chokePoint.archiveDatabase(otherId));

    const own = await listDatabases();
    const other = await listDatabases(otherTenantId);

    expect(databaseIds(own)).toEqual([ownId]);
    expect(own.totalCount).toBe(1);
    expect(other.databases).toEqual([expect.objectContaining({ id: otherId, name: "Foreign", liveItemCount: 1 })]);
    expect(other.totalCount).toBe(1);
  });
});
