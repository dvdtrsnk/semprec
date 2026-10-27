import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Settings } from "luxon";
import { runInTenant } from "@semprec/shared";
import { getTenantZeroId } from "../testSupport/testDb.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import type { Pool } from "pg";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("choke-point itemWrites", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeMoviesDb() {
    const db = await chokePoint.createDatabase({ name: "Movies" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    await chokePoint.createProperty({
      databaseId: db.id,
      key: "rating",
      name: "Rating",
      type: "number",
      owner: "system",
      ownerProcess: "critics.rate",
    });
    return db;
  }

  async function expectDatabaseArchived(promise: Promise<unknown>): Promise<void> {
    try {
      await promise;
      expect.unreachable("expected a database_archived ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe("database_archived");
    }
  }

  it("creates an item and rejects unknown property keys", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
    expect(item.properties).toEqual({ title: "Arrival" });

    await expect(chokePoint.createItem({ databaseId: db.id, properties: { nope: 1 } })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects writing an owner:'system' property from the generic path", async () => {
    const db = await makeMoviesDb();
    await expect(chokePoint.createItem({ databaseId: db.id, properties: { rating: 9 } })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
    await expect(
      chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { rating: 9 } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("honors an Idempotency-Key: a repeat create returns the original row", async () => {
    const db = await makeMoviesDb();
    const first = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Dune" },
      idempotencyKey: "k1",
    });
    const second = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Dune 2" },
      idempotencyKey: "k1",
    });
    expect(second.id).toBe(first.id);
    expect(second.properties).toEqual({ title: "Dune" });

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [db.id]);
    expect(rows[0].n).toBe(1);
  });

  it("two concurrent creates racing on the same Idempotency-Key still produce exactly one item", async () => {
    const db = await makeMoviesDb();
    const [first, second] = await Promise.all([
      chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" }, idempotencyKey: "race" }),
      chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune 2" }, idempotencyKey: "race" }),
    ]);
    expect(second.id).toBe(first.id);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [db.id]);
    expect(rows[0].n).toBe(1);
  });

  it("reusing an Idempotency-Key across a different database is a conflict, not a silent cross-lookup", async () => {
    const dbA = await makeMoviesDb();
    const dbB = await makeMoviesDb();
    await chokePoint.createItem({ databaseId: dbA.id, properties: { title: "Dune" }, idempotencyKey: "shared" });

    await expect(
      chokePoint.createItem({ databaseId: dbB.id, properties: { title: "Other" }, idempotencyKey: "shared" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("a rollup-typed property key is rejected with computed_readonly (403), not a generic validation error", async () => {
    const db = await chokePoint.createDatabase({ name: "P" });
    const target = await chokePoint.createDatabase({ name: "T" });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: db.id,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
    });
    const rollup = await chokePoint.createProperty({
      databaseId: db.id,
      key: "count",
      name: "Count",
      type: "rollup",
      config: { relationPropertyKey: relation.key, aggregation: "count" },
    });

    try {
      await chokePoint.createItem({ databaseId: db.id, properties: { [rollup.key]: 5 } });
      expect.unreachable("expected a ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe("computed_readonly");
    }
  });

  it("updateItem: a matching ifVersion succeeds, a mismatch is a 409 with current state", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });

    const updated = await chokePoint.updateItem({
      databaseId: db.id,
      itemId: item.id,
      propertiesPatch: { title: "Dune (2021)" },
      ifVersion: item.updatedAt,
    });
    expect(updated.properties.title).toBe("Dune (2021)");

    await expect(
      chokePoint.updateItem({
        databaseId: db.id,
        itemId: item.id,
        propertiesPatch: { title: "Dune Part Two" },
        ifVersion: item.updatedAt, // stale now
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("updateItem on a missing item raises NotFoundError", async () => {
    const db = await makeMoviesDb();
    await expect(
      chokePoint.updateItem({ databaseId: db.id, itemId: "00000000-0000-0000-0000-000000000000", propertiesPatch: {} }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("creating and updating an item in an archived database is rejected with database_archived (403), while the same operations succeed before archiving", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
    await chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { title: "Dune Part Two" } });

    await chokePoint.archiveDatabase(db.id);

    await expectDatabaseArchived(chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } }));
    await expectDatabaseArchived(
      chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { title: "Blade Runner" } }),
    );

    await chokePoint.restoreDatabase(db.id);
    const revived = await chokePoint.updateItem({
      databaseId: db.id,
      itemId: item.id,
      propertiesPatch: { title: "Dune (2021)" },
    });
    expect(revived.properties.title).toBe("Dune (2021)");
  });

  it("an idempotent create replays the pre-archive row without writing, but a new key is rejected once archived", async () => {
    const db = await makeMoviesDb();
    const original = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Dune" },
      idempotencyKey: "k1",
    });

    await chokePoint.archiveDatabase(db.id);

    const replay = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Dune 2" },
      idempotencyKey: "k1",
    });
    expect(replay.id).toBe(original.id);
    expect(replay.properties).toEqual({ title: "Dune" });

    await expectDatabaseArchived(
      chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" }, idempotencyKey: "k2" }),
    );
    await expectDatabaseArchived(chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } }));

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [db.id]);
    expect(rows[0].n).toBe(1);
  });

  it("a create replay whose idempotency key points at a soft-deleted item is rejected with database_archived, not the trashed row", async () => {
    const db = await makeMoviesDb();
    const original = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Dune" },
      idempotencyKey: "k1",
    });

    await chokePoint.softDeleteItem(db.id, original.id);
    await chokePoint.archiveDatabase(db.id);

    await expectDatabaseArchived(
      chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune 2" }, idempotencyKey: "k1" }),
    );
  });

  describe("idempotent create replay skips create-only side effects", () => {
    let events: InvalidationEvent[];

    beforeEach(async () => {
      await seedSystem(pool);
      events = [];
      setInvalidationHook((event) => events.push(event));
    });

    afterEach(() => {
      setInvalidationHook(() => {});
    });

    async function countHeartbeatFireJobs(heartbeatId: string): Promise<number> {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
         WHERE t.identifier = $1 AND j.payload -> 'payload' ->> 'heartbeatId' = $2`,
        [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE, heartbeatId],
      );
      return Number(rows[0]!.n);
    }

    it("first create fires the onItemEvent heartbeat and a create invalidation once; a same-key replay fires neither", async () => {
      const db = await makeMoviesDb();
      const { rows: projectRows } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE owner_module_id = 'projects'",
      );
      const { rows: projectItemRows } = await pool.query<{ id: string }>(
        "SELECT id FROM items WHERE database_id = $1 LIMIT 1",
        [projectRows[0]!.id],
      );
      const heartbeat = await withTransaction(pool, (client) =>
        createHeartbeat(client, {
          projectItemId: projectItemRows[0]!.id,
          name: "On create",
          rule: { kind: "onItemEvent", databaseId: db.id, event: "create" },
          actionId: "noop",
        }),
      );

      events = [];
      const first = await chokePoint.createItem({
        databaseId: db.id,
        properties: { title: "Dune" },
        idempotencyKey: "replay-key",
      });
      expect(await countHeartbeatFireJobs(heartbeat.id)).toBe(1);
      expect(events).toEqual([
        { scope: "item", databaseId: db.id, itemId: first.id, op: "create", updatedAt: first.updatedAt },
      ]);

      const replay = await chokePoint.createItem({
        databaseId: db.id,
        properties: { title: "Dune 2" },
        idempotencyKey: "replay-key",
      });
      expect(replay.id).toBe(first.id);
      expect(await countHeartbeatFireJobs(heartbeat.id)).toBe(1);
      expect(events).toHaveLength(1);
    });
  });
});

describe("property defaults on real item writes", () => {
  beforeAll(() => {
    pool = getTestPool();
    chokePoint = createChokePoint(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await runInTenant(getTenantZeroId(), () => seedSystem(pool));
  });

  async function database(moduleId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      moduleId,
    ]);
    if (!rows[0]) throw new Error("Missing seeded database");
    return rows[0].id;
  }

  it.each([undefined, "done", null])("creates Projects with absent or explicit status %j", async (status) => {
    await runInTenant(getTenantZeroId(), async () => {
      const databaseId = await database("projects");
      const properties = status === undefined ? { name: "Project" } : { name: "Project", status };
      const item = await chokePoint.createItem({ databaseId, properties });
      expect(item.properties.status).toBe(status === undefined ? "inProgress" : status);
      const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
        "SELECT properties FROM items WHERE id = $1",
        [item.id],
      );
      expect(rows[0]?.properties.status).toBe(item.properties.status);
    });
  });

  it.each([
    ["books", "status", "toRead"],
    ["movies", "status", "planned"],
    ["areas", "active", true],
  ] as const)("applies the seeded %s default", async (moduleId, key, value) => {
    await runInTenant(getTenantZeroId(), async () => {
      const item = await chokePoint.createItem({ databaseId: await database(moduleId) });
      expect(item.properties).toEqual({ [key]: value });
    });
  });

  it("applies Tasks defaults through the internal transaction creator and preserves explicit status", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      const databaseId = await database("tasks");
      const item = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId }));
      expect(item.properties.status).toBe("notDone");
      const explicit = await withTransaction(pool, (client) =>
        createItemWithClient(client, { databaseId, properties: { status: "done" } }),
      );
      expect(explicit.properties.status).toBe("done");
    });
  });

  it("resolves Files today near midnight in the tenant timezone, preserving an explicit date or null", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      const settingsId = await database("systemSettings");
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [settingsId]);
      if (!rows[0]) throw new Error("Missing settings item");
      await chokePoint.updateItem({
        databaseId: settingsId,
        itemId: rows[0].id,
        propertiesPatch: { timezone: "America/Los_Angeles" },
      });
      const now = Settings.now;
      Settings.now = () => Date.parse("2026-10-27T00:30:00Z");
      try {
        const databaseId = await database("files");
        const item = await chokePoint.createItem({ databaseId });
        expect(item.properties.date).toBe("2026-10-26");
        for (const date of [null, "2026-01-01"]) {
          const explicit = await chokePoint.createItem({ databaseId, properties: { date } });
          expect(explicit.properties.date).toBe(date);
        }
      } finally {
        Settings.now = now;
      }
    });
  });

  it("does not apply defaults on patch or re-evaluate them on replay", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      const databaseId = await database("files");
      const first = await chokePoint.createItem({ databaseId, idempotencyKey: "default-replay" });
      const now = Settings.now;
      // A replay must return before date resolution, even when resolving the date would fail.
      Settings.now = () => {
        throw new Error("Replay evaluated today");
      };
      try {
        const replay = await chokePoint.createItem({ databaseId, idempotencyKey: "default-replay" });
        expect(replay).toEqual(first);
      } finally {
        Settings.now = now;
      }
      const patched = await chokePoint.updateItem({ databaseId, itemId: first.id, propertiesPatch: { date: null } });
      expect(patched.properties.date).toBeNull();
      const again = await chokePoint.updateItem({ databaseId, itemId: first.id, propertiesPatch: { name: "Renamed" } });
      expect(again.properties.date).toBeNull();
    });
  });

  it("does not fill a formerly absent key on patch or replay after a default is added", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      const db = await chokePoint.createDatabase({ name: "Custom" });
      const prop = await chokePoint.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "text" });
      const first = await chokePoint.createItem({ databaseId: db.id, idempotencyKey: "before-default" });
      await chokePoint.updatePropertyConfig(prop.id, { default: "starting" });
      expect((await chokePoint.createItem({ databaseId: db.id, idempotencyKey: "before-default" })).properties).toEqual(
        {},
      );
      expect(
        (await chokePoint.updateItem({ databaseId: db.id, itemId: first.id, propertiesPatch: {} })).properties,
      ).toEqual({});
      expect((await chokePoint.createItem({ databaseId: db.id })).properties).toEqual({ note: "starting" });
    });
  });

  it("resolves multiple date defaults in one create with the same tenant date", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      const db = await chokePoint.createDatabase({ name: "Dates" });
      for (const key of ["start", "end"])
        await chokePoint.createProperty({
          databaseId: db.id,
          key,
          name: key,
          type: "date",
          config: { default: "today" },
        });
      const now = Settings.now;
      Settings.now = () => Date.parse("2026-10-27T12:00:00Z");
      try {
        expect((await chokePoint.createItem({ databaseId: db.id })).properties).toEqual({
          start: "2026-10-27",
          end: "2026-10-27",
        });
      } finally {
        Settings.now = now;
      }
    });
  });

  it("applies false, zero, empty text and a multi_select option without mutating input", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      const db = await chokePoint.createDatabase({ name: "Custom" });
      for (const spec of [
        { key: "active", type: "checkbox", config: { default: false } },
        { key: "count", type: "number", config: { default: 0 } },
        { key: "note", type: "text", config: { default: "" } },
        { key: "tags", type: "multi_select", config: { default: "one", options: [{ key: "one" }] } },
      ] as const)
        await chokePoint.createProperty({ databaseId: db.id, name: spec.key, ...spec });
      const properties = {};
      const item = await chokePoint.createItem({ databaseId: db.id, properties });
      expect(item.properties).toEqual({ active: false, count: 0, note: "", tags: "one" });
      expect(properties).toEqual({});
    });
  });

  it("validates config defaults through both property create and patch without persisting invalid config", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      const db = await chokePoint.createDatabase({ name: "Custom" });
      for (const [type, config] of [
        ["checkbox", { default: "true" }],
        ["select", { options: [{ key: "one" }], default: "missing" }],
        ["date", { default: "today", includeTime: true }],
      ] as const) {
        await expect(
          chokePoint.createProperty({ databaseId: db.id, key: type, name: type, type, config }),
        ).rejects.toMatchObject({ code: "validation_failed", details: { field: "config" } });
        const prop = await chokePoint.createProperty({ databaseId: db.id, key: type, name: type, type });
        await expect(chokePoint.updateProperty(prop.id, { config })).rejects.toMatchObject({
          code: "validation_failed",
          details: { field: "config" },
        });
        const { rows } = await pool.query<{ config: Record<string, unknown> }>(
          "SELECT config FROM properties WHERE id = $1",
          [prop.id],
        );
        expect(rows[0]?.config).toEqual({});
      }
    });
  });
});
