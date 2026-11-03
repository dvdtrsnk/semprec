import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Settings } from "luxon";
import { runInTenant } from "@semprec/shared";
import { getTenantZeroId } from "../testSupport/testDb.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { Pool } from "pg";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import "../domainWriteHooks.js";
import { projectItemForRead } from "../chokePoint/hooks.js";
import { readItemPatchChangeMetadata } from "../chokePoint/itemPatchChangeMetadata.js";

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

  it("preserves write classification through a registered item projection without changing JSON", async () => {
    const db = await chokePoint.createDatabase({ name: "Redaction metadata" });
    await chokePoint.createProperty({ databaseId: db.id, key: "body", name: "Body", type: "longText" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { body: "old", title: "before" } });
    const result = await chokePoint.updateItem({
      databaseId: db.id,
      itemId: item.id,
      propertiesPatch: { body: "<p>safe</p><script>remove-me</script>", title: "after" },
    });
    expect(readItemPatchChangeMetadata(result)).toEqual(
      new Map([
        ["body", false],
        ["title", true],
      ]),
    );
    const projected = projectItemForRead(result, "emails");
    expect(readItemPatchChangeMetadata(projected)).toEqual(
      new Map([
        ["body", false],
        ["title", true],
      ]),
    );
    expect(projected.properties.body).toContain("safe");
    expect(projected.properties.body).not.toContain("remove-me");
    expect(JSON.stringify(projected)).not.toContain("itemPatchChangeMetadata");
    expect(JSON.stringify(result)).not.toContain("itemPatchChangeMetadata");
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

  it("returns previous values of exactly two patched keys, preserving unpatched properties", async () => {
    const db = await makeMoviesDb();
    await chokePoint.createProperty({ databaseId: db.id, key: "due", name: "Due", type: "date" });
    await chokePoint.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "text" });
    const item = await chokePoint.createItem({
      databaseId: db.id,
      properties: { title: "Original", due: "2026-10-27", note: "Unchanged" },
    });
    const updated = await chokePoint.updateItem({
      databaseId: db.id,
      itemId: item.id,
      propertiesPatch: { title: "Revised", due: "2026-10-28" },
    });
    expect(updated.previous).toEqual({ title: "Original", due: "2026-10-27" });
    expect(updated.properties).toEqual({ title: "Revised", due: "2026-10-28", note: "Unchanged" });
  });

  it("reports an unset patched key as null, including a key inherited from Object.prototype", async () => {
    const db = await makeMoviesDb();
    await chokePoint.createProperty({ databaseId: db.id, key: "toString", name: "To string", type: "text" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    const updated = await chokePoint.updateItem({
      databaseId: db.id,
      itemId: item.id,
      propertiesPatch: { title: "New", toString: "Own value" },
    });
    expect(updated.previous).toEqual({ title: null, toString: null });
  });

  it("a stale version returns no result, writes nothing and emits no invalidation", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Original" } });
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      const outcome = await Promise.allSettled([
        chokePoint.updateItem({
          databaseId: db.id,
          itemId: item.id,
          propertiesPatch: { title: "Rejected" },
          ifVersion: "2000-01-01T00:00:00.000Z",
        }),
      ]);
      expect(outcome).toEqual([{ status: "rejected", reason: expect.any(ConflictError) }]);
      expect(await chokePoint.getItem(db.id, item.id)).toEqual({ ...item, fromInbox: false });
      expect(events).toEqual([]);
    } finally {
      setInvalidationHook(() => {});
    }
  });

  it("a concurrent patch waits for the first transaction and returns its committed value", async () => {
    const db = await makeMoviesDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Original" } });
    const contenderPool = getTestPool({ max: 1 });
    let releaseFirst = () => {};
    const commitGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirst = () => {};
    const firstWritten = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const first = withTransaction(pool, async (client) => {
      const result = await updateItemWithClient(client, {
        databaseId: db.id,
        itemId: item.id,
        propertiesPatch: { title: "First" },
      });
      signalFirst();
      await commitGate;
      return result;
    });
    // Attach a rejection handler immediately, while the first transaction is held open.
    const firstOutcome = Promise.allSettled([first]);
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([firstWritten, first]);
      const { rows } = await contenderPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = rows[0]?.pid;
      if (pid === undefined) throw new Error("Missing contender backend pid");
      const patch = createChokePoint(contenderPool).updateItem({
        databaseId: db.id,
        itemId: item.id,
        propertiesPatch: { title: "Second" },
      });
      const secondOutcome = Promise.allSettled([patch]);
      second = secondOutcome;
      await expect
        .poll(
          async () => {
            const { rows } = await pool.query<{ blocked: boolean }>(
              "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
              [pid],
            );
            return rows[0]?.blocked;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      releaseFirst();
      const [a, b] = await Promise.all([first, patch]);
      expect(a.previous).toEqual({ title: "Original" });
      expect(b.previous).toEqual({ title: "First" });
      expect((await chokePoint.getItem(db.id, item.id))?.properties.title).toBe("Second");
    } finally {
      releaseFirst();
      await firstOutcome;
      if (second) await second;
      await contenderPool.end();
    }
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

  it("returns only caller-patched keys when Tasks time is derived internally", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      const databaseId = await database("tasks");
      const item = await chokePoint.createItem({
        databaseId,
        properties: { date: "2026-10-27", timeFrom: "14:00", timeTo: "15:00" },
      });
      const updated = await chokePoint.updateItem({
        databaseId,
        itemId: item.id,
        propertiesPatch: { timeFrom: "14:30" },
      });
      expect(updated.previous).toEqual({ timeFrom: "14:00" });
      expect(updated.properties.time).not.toEqual(item.properties.time);
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

  describe("color value validation", () => {
    async function makeProjectsDb() {
      const db = await chokePoint.createDatabase({ name: "Projects" });
      await chokePoint.createProperty({ databaseId: db.id, key: "name", name: "Name", type: "text" });
      await chokePoint.createProperty({ databaseId: db.id, key: "color", name: "Color", type: "color" });
      return db;
    }

    it("accepts upper and lower case #RRGGBB on create and update and stores the value as written", async () => {
      const db = await makeProjectsDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { color: "#FF3B30" } });
      expect(item.properties.color).toBe("#FF3B30");
      const updated = await chokePoint.updateItem({
        databaseId: db.id,
        itemId: item.id,
        propertiesPatch: { color: "#ff3b30" },
      });
      expect(updated.properties.color).toBe("#ff3b30");
    });

    it("rejects non-hex values on create and update with the key as field (HTTP 400 validation_failed)", async () => {
      const db = await makeProjectsDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { color: "#FF3B30" } });
      const expected = { status: 400, code: "validation_failed", details: { field: "color" } };
      for (const bad of ["Červená", "red", "#FFF", "", 7, { hex: "#FF3B30" }, "#FF3B3G", " #FF3B30"]) {
        await expect(chokePoint.createItem({ databaseId: db.id, properties: { color: bad } })).rejects.toMatchObject(
          expected,
        );
        await expect(
          chokePoint.updateItem({ databaseId: db.id, itemId: item.id, propertiesPatch: { color: bad } }),
        ).rejects.toMatchObject(expected);
      }
      const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
        "SELECT properties FROM items WHERE id = $1",
        [item.id],
      );
      expect(rows[0]?.properties.color).toBe("#FF3B30");
    });

    it("null clears the color", async () => {
      const db = await makeProjectsDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { color: "#FF3B30" } });
      const updated = await chokePoint.updateItem({
        databaseId: db.id,
        itemId: item.id,
        propertiesPatch: { color: null },
      });
      expect(updated.properties.color ?? null).toBeNull();
    });

    it("does not inspect keys absent from the write: a stored 'red' survives an update of another key", async () => {
      const db = await makeProjectsDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { name: "Old" } });
      await pool.query(`UPDATE items SET properties = properties || '{"color":"red"}'::jsonb WHERE id = $1`, [item.id]);
      const updated = await chokePoint.updateItem({
        databaseId: db.id,
        itemId: item.id,
        propertiesPatch: { name: "New" },
      });
      expect(updated.properties).toEqual({ name: "New", color: "red" });
    });

    it("also applies to the client-level writers and to calls that pass allowedSystemKeys", async () => {
      const db = await makeProjectsDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { name: "P" } });
      await expect(
        withTransaction(pool, (client) =>
          createItemWithClient(
            client,
            { databaseId: db.id, properties: { color: "red" } },
            { allowedSystemKeys: ["color"] },
          ),
        ),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "color" } });
      await expect(
        withTransaction(pool, (client) =>
          updateItemWithClient(
            client,
            { databaseId: db.id, itemId: item.id, propertiesPatch: { color: "red" } },
            { allowedSystemKeys: ["color"] },
          ),
        ),
      ).rejects.toMatchObject({ code: "validation_failed", details: { field: "color" } });
    });
  });
});

describe("title validation on item writes", () => {
  const userWriter = { writerKind: "user" } as const;
  const agentWriter = { writerKind: "agent" } as const;

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
  });

  async function makeDb(withTitle = true) {
    const db = await chokePoint.createDatabase({ name: "Things" });
    if (withTitle) await chokePoint.createProperty({ databaseId: db.id, key: "name", name: "Name", type: "title" });
    await chokePoint.createProperty({ databaseId: db.id, key: "note", name: "Note", type: "text" });
    return db;
  }

  async function countItems(databaseId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM items WHERE database_id = $1", [
      databaseId,
    ]);
    return Number(rows[0]?.count);
  }

  const rejected = { status: 400, code: "validation_failed", details: { field: "name" } };

  it("publishes neither invalidation nor heartbeat jobs for rejected user and agent creates", async () => {
    await seedSystem(pool);
    const db = await makeDb();
    const projects = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'projects'");
    const project = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [
      projects.rows[0]?.id,
    ]);
    const projectId = project.rows[0]?.id;
    if (!projectId) throw new Error("missing seeded project");
    const heartbeat = await withTransaction(pool, (client) =>
      createHeartbeat(client, {
        projectItemId: projectId,
        name: "On create",
        rule: { kind: "onItemEvent", databaseId: db.id, event: "create" },
        actionId: "noop",
      }),
    );
    const countJobs = async () => {
      const result = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM graphile_worker._private_jobs j
         JOIN graphile_worker._private_tasks t ON t.id = j.task_id
         WHERE t.identifier = $1 AND j.payload -> 'payload' ->> 'heartbeatId' = $2`,
        [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE, heartbeat.id],
      );
      return result.rows[0]?.n;
    };
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      expect(await countJobs()).toBe(0);
      for (const writer of [userWriter, agentWriter]) {
        await expect(
          chokePoint.createItem({ databaseId: db.id, properties: { name: "   " } }, undefined, undefined, writer),
        ).rejects.toMatchObject(rejected);
      }
      expect(await countItems(db.id)).toBe(0);
      expect(events).toEqual([]);
      expect(await countJobs()).toBe(0);
      const created = await chokePoint.createItem(
        { databaseId: db.id, properties: { name: "Valid" } },
        undefined,
        undefined,
        userWriter,
      );
      expect(events).toMatchObject([{ scope: "item", itemId: created.id, op: "create" }]);
      expect(await countJobs()).toBe(1);
    } finally {
      setInvalidationHook(() => {});
    }
  });

  it.each([
    ["user", userWriter],
    ["agent", agentWriter],
  ])("rejects a blank or missing title on create for a %s and leaves no row", async (_label, writer) => {
    const db = await makeDb();
    for (const properties of [{ name: "   " }, { name: "" }, { name: null }, { note: "x" }]) {
      await expect(
        chokePoint.createItem({ databaseId: db.id, properties }, undefined, undefined, writer),
      ).rejects.toMatchObject(rejected);
    }
    expect(await countItems(db.id)).toBe(0);
    const item = await chokePoint.createItem(
      { databaseId: db.id, properties: { name: " Padded " } },
      undefined,
      undefined,
      writer,
    );
    expect(item.properties.name).toBe(" Padded ");
  });

  it("rejects patching the title to blank but allows patching another property", async () => {
    const db = await makeDb();
    const item = await chokePoint.createItem(
      { databaseId: db.id, properties: { name: "Keep" } },
      undefined,
      undefined,
      userWriter,
    );
    for (const name of ["", "  ", null]) {
      await expect(
        chokePoint.updateItem(
          { databaseId: db.id, itemId: item.id, propertiesPatch: { name } },
          undefined,
          undefined,
          userWriter,
        ),
      ).rejects.toMatchObject(rejected);
    }
    const userUpdated = await chokePoint.updateItem(
      { databaseId: db.id, itemId: item.id, propertiesPatch: { note: "user note" } },
      undefined,
      undefined,
      userWriter,
    );
    expect(userUpdated.properties).toEqual({ name: "Keep", note: "user note" });
    const updated = await chokePoint.updateItem(
      { databaseId: db.id, itemId: item.id, propertiesPatch: { note: "n" } },
      undefined,
      undefined,
      agentWriter,
    );
    expect(updated.properties).toEqual({ name: "Keep", note: "n" });
  });

  it("does not apply to internal writers", async () => {
    const db = await makeDb();
    const item = await chokePoint.createItem({ databaseId: db.id, properties: { note: "x" } });
    const updated = await chokePoint.updateItem({
      databaseId: db.id,
      itemId: item.id,
      propertiesPatch: { name: "" },
    });
    expect(updated.properties.name).toBe("");
  });

  it("does not apply to a database without a user-owned title property", async () => {
    const db = await makeDb(false);
    const item = await chokePoint.createItem(
      { databaseId: db.id, properties: { note: "x" } },
      undefined,
      undefined,
      userWriter,
    );
    await chokePoint.updateItem(
      { databaseId: db.id, itemId: item.id, propertiesPatch: { note: "y" } },
      undefined,
      undefined,
      agentWriter,
    );
  });

  it("exempts Transcripts for every writer kind", async () => {
    await runInTenant(getTenantZeroId(), async () => {
      await seedSystem(pool);
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
        "transcripts",
      ]);
      const databaseId = rows[0]?.id ?? "";
      for (const writer of [userWriter, agentWriter]) {
        const item = await chokePoint.createItem(
          { databaseId, properties: { name: "" } },
          undefined,
          undefined,
          writer,
        );
        const updated = await chokePoint.updateItem(
          { databaseId, itemId: item.id, propertiesPatch: { name: "  " } },
          undefined,
          undefined,
          writer,
        );
        expect(updated.properties.name).toBe("  ");
      }
    });
  });
});
