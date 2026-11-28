import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { z } from "zod";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { seedSystem } from "../seed/seedSystem.js";
import { HEALTH_RECORDS_MODULE_ID, JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import type { PropertyRow } from "../types.js";

const USER = { writerKind: "user" } as const;

let admin: Pool;
let runtime: Pool;
let chokePoint: ChokePoint;
let first: string;
const invalidation = vi.fn<(event: InvalidationEvent) => void>();

const inFirst = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(first, fn);

function seed(tenantId: string): Promise<unknown> {
  return runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
}

async function moduleProperty(tenantId: string, moduleId: string, key: string): Promise<PropertyRow> {
  return runInTenant(tenantId, async () => {
    const database = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, moduleId));
    if (!database) throw new Error(`${moduleId} database missing`);
    const property = await chokePoint.getPropertyByKey(database.id, key);
    if (!property) throw new Error(`${moduleId} '${key}' property missing`);
    return property;
  });
}

const healthProperty = (tenantId: string, key: "tags" | "status" | "subject") =>
  moduleProperty(tenantId, HEALTH_RECORDS_MODULE_ID, key);

/** A Health records item written like an ingest writer, so a retired key can be stored too. */
async function healthItem(tenantId: string, databaseId: string, properties: Record<string, unknown>): Promise<string> {
  const item = await runInTenant(tenantId, () =>
    chokePoint.createItem({ databaseId, properties: { name: `Record ${randomUUID()}`, ...properties } }),
  );
  return item.id;
}

const storedItemRow = z.object({
  properties: z.record(z.string(), z.unknown()),
  version: z.string(),
  deleted: z.boolean(),
});

async function storedItem(tenantId: string, itemId: string): Promise<z.infer<typeof storedItemRow>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await runtime.query<Record<string, unknown>>(
      "SELECT properties, version::text AS version, deleted_at IS NOT NULL AS deleted FROM items WHERE id = $1",
      [itemId],
    );
    return storedItemRow.parse(rows[0]);
  });
}

const storedPropertyRow = z.object({ version: z.string(), config: z.record(z.string(), z.unknown()) });

/** `version` is `xmin`: it changes with every write. */
async function storedProperty(tenantId: string, propertyId: string): Promise<z.infer<typeof storedPropertyRow>> {
  return runInTenant(tenantId, async () => {
    const { rows } = await runtime.query<Record<string, unknown>>(
      "SELECT xmin::text AS version, config FROM properties WHERE id = $1",
      [propertyId],
    );
    return storedPropertyRow.parse(rows[0]);
  });
}

const storedOptionKeys = async (tenantId: string, propertyId: string): Promise<string[]> =>
  z
    .array(z.looseObject({ key: z.string() }))
    .parse((await storedProperty(tenantId, propertyId)).config.options)
    .map((option) => option.key);

async function allJobKeys(): Promise<(string | null)[]> {
  const { rows } = await admin.query<{ key: string | null }>("SELECT key FROM graphile_worker.jobs ORDER BY id");
  return rows.map((job) => job.key);
}

async function backfillJobs(databaseId: string): Promise<string[]> {
  const { rows } = await admin.query<{ key: string | null; task_identifier: string }>(
    "SELECT key, task_identifier FROM graphile_worker.jobs ORDER BY id",
  );
  return rows.flatMap((job) =>
    job.task_identifier === "itemSearchBackfill" && job.key?.includes(`:${databaseId}:`) === true ? [job.key] : [],
  );
}

/** `refused` must reject, leaving the property and `itemIds` unwritten, no job queued and no invalidation sent. */
async function expectNoEffect(
  tenantId: string,
  propertyId: string,
  itemIds: readonly string[],
  refused: () => Promise<unknown>,
  error: Record<string, unknown>,
): Promise<void> {
  const before = await storedProperty(tenantId, propertyId);
  const itemsBefore = await Promise.all(itemIds.map((id) => storedItem(tenantId, id)));
  const jobsBefore = await allJobKeys();
  invalidation.mockClear();
  await expect(runInTenant(tenantId, refused)).rejects.toMatchObject(error);
  expect(await storedProperty(tenantId, propertyId)).toEqual(before);
  expect(await Promise.all(itemIds.map((id) => storedItem(tenantId, id)))).toEqual(itemsBefore);
  expect(await allJobKeys()).toEqual(jobsBefore);
  expect(invalidation).not.toHaveBeenCalled();
}

/** Resolves once a session waits on a lock in a statement containing `fragment`; throws after ~10 s. */
async function waitForLockWaiter(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [`%${fragment}%`],
    );
    if ((rows[0]?.waiting ?? 0) >= 1) return;
    await delay(50);
  }
  throw new Error(`No session waits on a lock in a statement with '${fragment}'`);
}

const REMOVAL_ITEM_LOCK = "properties @> $2::jsonb OR properties @> $3::jsonb";
const ITEM_WRITE_PROPERTY_LOCK = "type IN ('select', 'multi_select')";

describe("property.option.remove", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
    chokePoint = createChokePoint(runtime);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    first = getTenantZeroId();
    await seed(first);
    invalidation.mockClear();
    setInvalidationHook(invalidation);
  });
  afterEach(() => setInvalidationHook(() => {}));
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("removes a tag of the schema-locked Health records and its key from every live and trashed item, keeping the other keys", async () => {
    const tags = await healthProperty(first, "tags");
    const databaseId = tags.databaseId;
    const both = await healthItem(first, databaseId, { tags: ["medication", "epilepsy"] });
    const only = await healthItem(first, databaseId, { tags: ["medication"] });
    const trashed = await healthItem(first, databaseId, { tags: ["prevention", "medication"] });
    const other = await healthItem(first, databaseId, { tags: ["epilepsy"] });
    await inFirst(() => chokePoint.softDeleteItem(databaseId, trashed));
    const otherBefore = await storedItem(first, other);
    invalidation.mockClear();
    const userId = randomUUID();

    await inFirst(() => chokePoint.removePropertyOption(tags.id, "medication", userId));

    expect(await storedOptionKeys(first, tags.id)).toEqual([
      "bloodTests",
      "epilepsy",
      "dentalHygiene",
      "bloodPressure",
      "prevention",
    ]);
    expect((await storedItem(first, both)).properties.tags).toEqual(["epilepsy"]);
    expect((await storedItem(first, only)).properties.tags).toEqual([]);
    const trashedAfter = await storedItem(first, trashed);
    expect(trashedAfter).toMatchObject({ deleted: true, properties: { tags: ["prevention"] } });
    expect(await storedItem(first, other)).toEqual(otherBefore);
    expect((await inFirst(() => chokePoint.getDatabase(databaseId)))?.schemaLocked).toBe(true);
    expect(await backfillJobs(databaseId)).toHaveLength(1);
    // One item invalidation per live item written, and the schema invalidation; nothing for the trashed or untouched.
    expect(invalidation.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining([
        { scope: "schema", databaseId, userId },
        expect.objectContaining({ scope: "item", databaseId, itemId: both, op: "update", userId }),
        expect.objectContaining({ scope: "item", databaseId, itemId: only, op: "update", userId }),
      ]),
    );
    expect(invalidation).toHaveBeenCalledTimes(3);
  });

  it("leaves a select holding the removed key empty and drops a default that names it", async () => {
    const owned = await inFirst(async () => {
      const database = await chokePoint.createDatabase({ name: `Options ${randomUUID()}` });
      return chokePoint.createProperty({
        databaseId: database.id,
        key: "choice",
        name: "Choice",
        type: "select",
        config: { options: [{ key: "one" }, { key: "two" }], default: "one" },
      });
    });
    const holder = await inFirst(() =>
      chokePoint.createItem({ databaseId: owned.databaseId, properties: { choice: "one" } }),
    );
    const keeper = await inFirst(() =>
      chokePoint.createItem({ databaseId: owned.databaseId, properties: { choice: "two" } }),
    );

    await inFirst(() => chokePoint.removePropertyOption(owned.id, "one"));

    expect((await storedProperty(first, owned.id)).config).toEqual({ options: [{ key: "two" }] });
    expect((await storedItem(first, holder.id)).properties.choice).toBeNull();
    expect((await storedItem(first, keeper.id)).properties.choice).toBe("two");
  });

  it("keeps a default that names another option", async () => {
    const status = await healthProperty(first, "status");
    const owned = await inFirst(async () => {
      const database = await chokePoint.createDatabase({ name: `Options ${randomUUID()}` });
      return chokePoint.createProperty({
        databaseId: database.id,
        key: "choice",
        name: "Choice",
        type: "multi_select",
        config: { options: [{ key: "one" }, { key: "two" }], default: "two" },
      });
    });

    await inFirst(() => chokePoint.removePropertyOption(owned.id, "one"));
    await inFirst(() => chokePoint.removePropertyOption(status.id, "monitoring"));

    expect((await storedProperty(first, owned.id)).config).toEqual({ options: [{ key: "two" }], default: "two" });
    expect(await storedOptionKeys(first, status.id)).toEqual(["resolved"]);
  });

  it("lets a user write an item that held the removed key, and refuses the key itself afterwards", async () => {
    const tags = await healthProperty(first, "tags");
    const item = await healthItem(first, tags.databaseId, { tags: ["medication", "epilepsy"] });

    await inFirst(() => chokePoint.removePropertyOption(tags.id, "medication"));

    const written = await inFirst(() =>
      chokePoint.updateItem(
        { databaseId: tags.databaseId, itemId: item, propertiesPatch: { tags: ["epilepsy", "prevention"] } },
        undefined,
        undefined,
        USER,
      ),
    );
    expect(written.properties.tags).toEqual(["epilepsy", "prevention"]);
    await expect(
      inFirst(() =>
        chokePoint.updateItem(
          { databaseId: tags.databaseId, itemId: item, propertiesPatch: { tags: ["medication"] } },
          undefined,
          undefined,
          USER,
        ),
      ),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "tags" } });
  });

  it("clears the key from a value that also holds a retired key no option names", async () => {
    // Only an ingest writer stores a key no option names; a user write may carry it only unchanged.
    const tags = await healthProperty(first, "tags");
    const item = await healthItem(first, tags.databaseId, { tags: ["medication", "retired"] });

    await inFirst(() => chokePoint.removePropertyOption(tags.id, "medication"));

    expect((await storedItem(first, item)).properties.tags).toEqual(["retired"]);
  });

  it("answers an unknown option key and an unknown property with not_found", async () => {
    const tags = await healthProperty(first, "tags");
    const holder = await healthItem(first, tags.databaseId, { tags: ["medication"] });

    await expectNoEffect(first, tags.id, [holder], () => chokePoint.removePropertyOption(tags.id, "missing"), {
      name: "NotFoundError",
      status: 404,
      code: "not_found",
      details: { resource: "propertyOption", propertyId: tags.id, key: "missing" },
    });
    await expect(inFirst(() => chokePoint.removePropertyOption(randomUUID(), "medication"))).rejects.toMatchObject({
      name: "NotFoundError",
      status: 404,
      code: "not_found",
    });
  });

  it.each([
    [
      "a system-owned select",
      () => moduleProperty(first, JOURNAL_MODULE_ID, "type"),
      "week",
      { status: 400, code: "validation_failed", details: { field: "propertyId", reason: "system_owned" } },
    ],
    [
      "a text property",
      () => healthProperty(first, "subject"),
      "one",
      { status: 400, code: "validation_failed", details: { field: "propertyId" } },
    ],
  ])("refuses %s as validation_failed and writes nothing", async (_case, property, key, error) => {
    const target = await property();

    await expectNoEffect(first, target.id, [], () => chokePoint.removePropertyOption(target.id, key), error);
  });

  it("refuses a locked property with property_locked", async () => {
    const locked = await inFirst(async () => {
      const database = await chokePoint.createDatabase({ name: `Options ${randomUUID()}` });
      return chokePoint.createProperty({
        databaseId: database.id,
        key: "choice",
        name: "Choice",
        type: "select",
        config: { options: [{ key: "one" }] },
        locked: true,
      });
    });

    await expectNoEffect(first, locked.id, [], () => chokePoint.removePropertyOption(locked.id, "one"), {
      name: "PropertyLockedError",
      status: 403,
      code: "property_locked",
    });
  });

  describe("a concurrent item write", () => {
    it("that checked the key first commits, and the removal then clears the key it wrote", async () => {
      const tags = await healthProperty(first, "tags");
      const item = await healthItem(first, tags.databaseId, { tags: ["epilepsy"] });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let checked!: () => void;
      const wrote = new Promise<void>((resolve) => {
        checked = resolve;
      });

      const write = inFirst(() =>
        withTransaction(runtime, async (client) => {
          await updateItemWithClient(
            client,
            { databaseId: tags.databaseId, itemId: item, propertiesPatch: { tags: ["epilepsy", "medication"] } },
            { writer: USER },
          );
          checked();
          await released;
        }),
      );
      await wrote;
      const removal = inFirst(() => chokePoint.removePropertyOption(tags.id, "medication"));
      const settled = Promise.allSettled([write, removal]);
      try {
        await waitForLockWaiter("FROM properties WHERE id = $1 FOR UPDATE");
      } finally {
        release();
      }
      const [writeResult, removalResult] = await settled;

      expect([writeResult.status, removalResult.status]).toEqual(["fulfilled", "fulfilled"]);
      expect((await storedItem(first, item)).properties.tags).toEqual(["epilepsy"]);
      expect(await storedOptionKeys(first, tags.id)).not.toContain("medication");
    });

    it("that checks the key after the removal took the property row waits for it and is refused", async () => {
      const tags = await healthProperty(first, "tags");
      const holder = await healthItem(first, tags.databaseId, { tags: ["medication"] });
      const item = await healthItem(first, tags.databaseId, { tags: ["medication", "epilepsy"] });
      // Holding the first holder stops the removal after it wrote the options, still holding the property row.
      const blocker = await admin.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [holder]);
        const removal = inFirst(() => chokePoint.removePropertyOption(tags.id, "medication"));
        const write = inFirst(() =>
          chokePoint.updateItem(
            {
              databaseId: tags.databaseId,
              itemId: item,
              propertiesPatch: { tags: ["medication", "epilepsy", "prevention"] },
            },
            undefined,
            undefined,
            USER,
          ),
        );
        const settled = Promise.allSettled([removal, write]);
        const failures: unknown[] = [];
        try {
          await waitForLockWaiter(REMOVAL_ITEM_LOCK);
          await waitForLockWaiter(ITEM_WRITE_PROPERTY_LOCK);
        } catch (error) {
          failures.push(error);
        }
        try {
          await blocker.query("ROLLBACK");
        } catch (error) {
          failures.push(error);
        }
        const [removalResult, writeResult] = await settled;
        if (failures.length > 0) throw new AggregateError(failures, "The writers were not blocked as planned");

        expect(removalResult.status).toBe("fulfilled");
        expect(writeResult).toMatchObject({
          status: "rejected",
          reason: { status: 400, code: "validation_failed", details: { field: "tags" } },
        });
      } finally {
        blocker.release();
      }
      expect((await storedItem(first, holder)).properties.tags).toEqual([]);
      expect((await storedItem(first, item)).properties.tags).toEqual(["epilepsy"]);
    });
  });

  describe("tenant isolation on the runtime role", () => {
    it("answers another tenant's property like an unknown one and leaves it and its items unwritten, while the owner's removal succeeds", async () => {
      const second = await createTestTenant(admin);
      await seed(second);
      const firstTags = await healthProperty(first, "tags");
      const secondTags = await healthProperty(second, "tags");
      const firstHolder = await healthItem(first, firstTags.databaseId, { tags: ["medication"] });
      const unknownId = randomUUID();
      const inSecond = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(second, fn);
      const refusalOf = async (propertyId: string): Promise<unknown> => {
        const error: unknown = await inSecond(() => chokePoint.removePropertyOption(propertyId, "medication")).then(
          () => new Error("the removal was not refused"),
          (reason: unknown) => reason,
        );
        if (!(error instanceof Error)) throw new Error("expected an Error");
        const { name, message } = error;
        const fields =
          "status" in error && "code" in error && "details" in error ? [error.status, error.code, error.details] : [];
        return { name, message: message.split(propertyId).join("<id>"), fields };
      };
      const propertyBefore = await storedProperty(first, firstTags.id);
      const holderBefore = await storedItem(first, firstHolder);
      const jobsBefore = await allJobKeys();
      invalidation.mockClear();

      const foreign = await refusalOf(firstTags.id);
      expect(foreign).toEqual(await refusalOf(unknownId));
      expect(foreign).toMatchObject({ name: "NotFoundError", fields: [404, "not_found", undefined] });
      expect(await storedProperty(first, firstTags.id)).toEqual(propertyBefore);
      expect(await storedItem(first, firstHolder)).toEqual(holderBefore);
      expect(await allJobKeys()).toEqual(jobsBefore);
      expect(invalidation).not.toHaveBeenCalled();

      const secondHolder = await healthItem(second, secondTags.databaseId, { tags: ["medication", "epilepsy"] });
      await inSecond(() => chokePoint.removePropertyOption(secondTags.id, "medication"));
      expect(await storedOptionKeys(second, secondTags.id)).not.toContain("medication");
      expect((await storedItem(second, secondHolder)).properties.tags).toEqual(["epilepsy"]);
      expect(await storedProperty(first, firstTags.id)).toEqual(propertyBefore);
      expect(await storedItem(first, firstHolder)).toEqual(holderBefore);
    });
  });
});
