import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { prepareUserItemPatch, updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import {
  clearHooksForTests,
  registerItemCreateHook,
  registerItemPreWriteTransform,
  registerItemUpdateCommand,
  registerItemUpdateHook,
} from "../chokePoint/hooks.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { EVENTS_MODULE_ID, TASKS_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { taskPreWriteTransform } from "../tasks/taskPreWriteTransform.js";
import { getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";
import * as schedulerStore from "../scheduler/schedulerStore.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { runOnce } from "@semprec/queue";
import * as queue from "@semprec/queue";
import { createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { withTransaction } from "../db/pool.js";

// A probe module id that owns the databases these tests create. Its transforms are registered per test.
const PROBE_MODULE = "itemPreWriteProbe";

let pool: Pool;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function countItems(databaseId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM items WHERE database_id = $1",
    [databaseId],
  );
  return Number(rows[0]!.count);
}

/**
 * A database owned by the probe module. `link` is an owner:'system' key whose ownerProcess is another
 * module (a refused add), `stamp` is owner:'system' with the probe module as its ownerProcess (an
 * accepted add), and `derived` is owner:'system' with no ownerProcess (an accepted add).
 */
async function makeProbeDatabase(): Promise<string> {
  const db = await chokePoint.createDatabase({ name: "Probe", ownerModuleId: PROBE_MODULE });
  await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
  await chokePoint.createProperty({
    databaseId: db.id,
    key: "link",
    name: "Link",
    type: "text",
    owner: "system",
    ownerProcess: TRANSCRIPTS_MODULE_ID,
  });
  await chokePoint.createProperty({
    databaseId: db.id,
    key: "stamp",
    name: "Stamp",
    type: "text",
    owner: "system",
    ownerProcess: PROBE_MODULE,
  });
  await chokePoint.createProperty({
    databaseId: db.id,
    key: "derived",
    name: "Derived",
    type: "text",
    owner: "system",
  });
  return db.id;
}

describe("choke-point item pre-write transforms (issue #1422)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
    // Each test registers only what it needs. Restore the production Tasks transform where a test uses it.
    clearHooksForTests();
  });

  afterEach(() => {
    clearHooksForTests();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("refuses a declared command without its own registered transform and preparation", async () => {
    const databaseId = await makeProbeDatabase();
    const item = await chokePoint.createItem({ databaseId, properties: { title: "Before" } });
    const database = await chokePoint.getDatabase(databaseId);
    if (!database) throw new Error("Missing probe database");
    const properties = await chokePoint.listProperties(databaseId);
    const before = await chokePoint.getItem(databaseId, item.id);
    expect(before).not.toBeNull();
    const paired = async ({ patch }: { patch: Record<string, unknown> }) => patch;
    registerItemPreWriteTransform(
      PROBE_MODULE,
      async ({ patch }) => patch,
      async ({ patch }) => ({ patch, deferredKeys: [] }),
    );
    registerItemUpdateCommand(PROBE_MODULE, {
      key: "stamp",
      transform: paired,
      validate: () => {},
      prepare: (value) => ({ intent: value, preconditions: {} }),
      consume: async () => ({}),
    });
    await expect(
      prepareUserItemPatch(properties, { stamp: "raw" }, database, item, "Europe/Prague"),
    ).rejects.toMatchObject({ status: 400, details: { field: "stamp" } });
    await expect(
      chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: { stamp: "raw" } }),
    ).rejects.toMatchObject({ status: 400, details: { field: "stamp" } });
    expect(await chokePoint.getItem(databaseId, item.id)).toEqual(before);
  });

  describe("effective patch validation", () => {
    async function fixture() {
      const database = await chokePoint.createDatabase({ name: "Validation probe", ownerModuleId: PROBE_MODULE });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "title" });
      await chokePoint.createProperty({ databaseId: database.id, key: "color", name: "Color", type: "color" });
      return database;
    }

    function registerOutput(output: Record<string, unknown>) {
      registerItemPreWriteTransform(
        PROBE_MODULE,
        async ({ patch }) => ({ ...patch, ...output }),
        async ({ patch }) => ({ patch: { ...patch, ...output }, deferredKeys: [] }),
      );
    }

    it.each([
      ["color", { color: "not-a-color" }],
      ["title", { title: "  " }],
    ] as const)("rejects invalid transformed %s on create with no write or event", async (field, output) => {
      const database = await fixture();
      registerOutput(output);
      const events: InvalidationEvent[] = [];
      const heartbeat = vi.spyOn(schedulerStore, "triggerOnItemEventHeartbeats");
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(
          chokePoint.createItem(
            { databaseId: database.id, properties: { title: "Valid", color: "#123456" } },
            undefined,
            undefined,
            { writerKind: "user" },
          ),
        ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field } });
        expect(await countItems(database.id)).toBe(0);
        expect(events).toEqual([]);
        expect(heartbeat).not.toHaveBeenCalled();
      } finally {
        heartbeat.mockRestore();
        setInvalidationHook(() => {});
      }
    });

    it.each([
      ["  ", false],
      ["Added title", true],
    ] as const)("validates transform-added create title %j", async (title, allowed) => {
      const database = await fixture();
      const transform = vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => ({ ...patch, title }));
      registerItemPreWriteTransform(PROBE_MODULE, transform);
      const events: InvalidationEvent[] = [];
      const heartbeat = vi.spyOn(schedulerStore, "triggerOnItemEventHeartbeats");
      setInvalidationHook((event) => events.push(event));
      try {
        const create = () =>
          chokePoint.createItem({ databaseId: database.id, properties: {} }, undefined, undefined, {
            writerKind: "user",
          });
        if (allowed) {
          const item = await create();
          expect(item.properties.title).toBe(title);
          expect(await countItems(database.id)).toBe(1);
        } else {
          await expect(create()).rejects.toMatchObject({
            status: 400,
            code: "validation_failed",
            details: { field: "title" },
          });
          expect(await countItems(database.id)).toBe(0);
          expect(events).toEqual([]);
          expect(heartbeat).not.toHaveBeenCalled();
        }
        expect(transform).toHaveBeenCalledOnce();
      } finally {
        heartbeat.mockRestore();
        setInvalidationHook(() => {});
      }
    });

    it("rejects an invalid color added by a transform on create", async () => {
      const database = await fixture();
      registerOutput({ color: "invalid" });
      const events: InvalidationEvent[] = [];
      const heartbeat = vi.spyOn(schedulerStore, "triggerOnItemEventHeartbeats");
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(
          chokePoint.createItem({ databaseId: database.id, properties: { title: "Valid" } }, undefined, undefined, {
            writerKind: "user",
          }),
        ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "color" } });
        expect(await countItems(database.id)).toBe(0);
        expect(events).toEqual([]);
        expect(heartbeat).not.toHaveBeenCalled();
      } finally {
        heartbeat.mockRestore();
        setInvalidationHook(() => {});
      }
    });

    it.each([
      ["color", { color: "not-a-color" }],
      ["title", { title: "  " }],
    ] as const)("rejects invalid transformed %s on update and read-only preparation", async (field, output) => {
      const database = await fixture();
      const item = await chokePoint.createItem({
        databaseId: database.id,
        properties: { title: "Valid", color: "#123456" },
      });
      registerOutput(output);
      const properties = await chokePoint.listProperties(database.id);
      const before = await chokePoint.getItem(database.id, item.id);
      const events: InvalidationEvent[] = [];
      const heartbeat = vi.spyOn(schedulerStore, "triggerOnItemEventHeartbeats");
      setInvalidationHook((event) => events.push(event));
      try {
        const patch = { title: "Updated", color: "#abcdef" };
        await expect(prepareUserItemPatch(properties, patch, database, item, "Europe/Prague")).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field },
        });
        expect(await chokePoint.getItem(database.id, item.id)).toEqual(before);
        expect(events).toEqual([]);
        expect(heartbeat).not.toHaveBeenCalled();
        await expect(
          chokePoint.updateItem(
            { databaseId: database.id, itemId: item.id, propertiesPatch: patch },
            undefined,
            undefined,
            { writerKind: "user" },
          ),
        ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field } });
        expect(await chokePoint.getItem(database.id, item.id)).toEqual(before);
        expect(events).toEqual([]);
        expect(heartbeat).not.toHaveBeenCalled();
      } finally {
        heartbeat.mockRestore();
        setInvalidationHook(() => {});
      }
    });

    it("accepts valid transformed color and title on create, update and read-only preparation", async () => {
      const database = await fixture();
      registerOutput({ title: "Prepared", color: "#abcdef" });
      const created = await chokePoint.createItem(
        { databaseId: database.id, properties: { title: "Valid", color: "#123456" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      const properties = await chokePoint.listProperties(database.id);
      expect(
        (await prepareUserItemPatch(properties, { title: "Updated" }, database, created, "Europe/Prague")).patch,
      ).toMatchObject({
        title: "Prepared",
        color: "#abcdef",
      });
      const updated = await chokePoint.updateItem(
        { databaseId: database.id, itemId: created.id, propertiesPatch: { title: "Updated" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      expect(updated.properties).toMatchObject({ title: "Prepared", color: "#abcdef" });
    });

    it("retains the system-writer title exemption after transformation", async () => {
      const database = await fixture();
      registerOutput({ title: "  ", color: "#abcdef" });
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Valid" } });
      expect(item.properties.title).toBe("  ");
      const updated = await chokePoint.updateItem({
        databaseId: database.id,
        itemId: item.id,
        propertiesPatch: { title: "Valid" },
      });
      expect(updated.properties.title).toBe("  ");
    });

    it.each([
      ["color", { color: "invalid" }, { title: "Updated" }],
      ["title", { title: "  " }, { color: "#123456" }],
    ] as const)("rejects an invalid added %s on update and preparation", async (field, output, patch) => {
      const database = await fixture();
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Valid" } });
      registerOutput(output);
      const properties = await chokePoint.listProperties(database.id);
      const before = await chokePoint.getItem(database.id, item.id);
      const events: InvalidationEvent[] = [];
      const heartbeat = vi.spyOn(schedulerStore, "triggerOnItemEventHeartbeats");
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(prepareUserItemPatch(properties, patch, database, item, "Europe/Prague")).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field },
        });
        expect(await chokePoint.getItem(database.id, item.id)).toEqual(before);
        expect(events).toEqual([]);
        expect(heartbeat).not.toHaveBeenCalled();
        await expect(
          chokePoint.updateItem(
            { databaseId: database.id, itemId: item.id, propertiesPatch: patch },
            undefined,
            undefined,
            { writerKind: "user" },
          ),
        ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field } });
        expect(await chokePoint.getItem(database.id, item.id)).toEqual(before);
        expect(events).toEqual([]);
        expect(heartbeat).not.toHaveBeenCalled();
      } finally {
        heartbeat.mockRestore();
        setInvalidationHook(() => {});
      }
    });

    it("accepts transformed null as a valid color", async () => {
      const database = await fixture();
      registerOutput({ color: null });
      const item = await chokePoint.createItem(
        { databaseId: database.id, properties: { title: "Valid" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      expect(item.properties.color).toBeNull();
      const properties = await chokePoint.listProperties(database.id);
      expect(
        (await prepareUserItemPatch(properties, { title: "Updated" }, database, item, "Europe/Prague")).patch.color,
      ).toBeNull();
      const updated = await chokePoint.updateItem(
        { databaseId: database.id, itemId: item.id, propertiesPatch: { title: "Updated" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      expect(updated.properties.color).toBeNull();
    });

    it("does not reject an unrelated patch solely because the stored title is blank", async () => {
      const database = await fixture();
      const item = await chokePoint.createItem({ databaseId: database.id, properties: { title: "  " } });
      registerOutput({ color: "#abcdef" });
      const updated = await chokePoint.updateItem(
        { databaseId: database.id, itemId: item.id, propertiesPatch: { color: "#123456" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      expect(updated.properties).toMatchObject({ title: "  ", color: "#abcdef" });
    });

    it("retains the Transcripts title exemption for a user after transformation", async () => {
      const databaseId = await databaseIdFor(TRANSCRIPTS_MODULE_ID);
      registerItemPreWriteTransform(TRANSCRIPTS_MODULE_ID, async ({ patch }) => ({ ...patch, name: "  " }));
      const item = await chokePoint.createItem({ databaseId, properties: { name: "Valid" } }, undefined, undefined, {
        writerKind: "user",
      });
      expect(item.properties.name).toBe("  ");
      const updated = await chokePoint.updateItem(
        { databaseId, itemId: item.id, propertiesPatch: { name: "Valid" } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
      expect(updated.properties.name).toBe("  ");
    });
  });

  it("stores the transformed patch once and hands it to the update hooks", async () => {
    const eventsId = await databaseIdFor(EVENTS_MODULE_ID);
    const transformInputs: unknown[] = [];
    registerItemPreWriteTransform(EVENTS_MODULE_ID, async ({ stored, patch }) => {
      transformInputs.push(stored === null ? null : stored.properties.timeFrom);
      const timeFrom = patch.timeFrom;
      return typeof timeFrom === "string" && /^\d:\d\d$/.test(timeFrom)
        ? { ...patch, timeFrom: `0${timeFrom}` }
        : patch;
    });
    const hookPatches: Record<string, unknown>[] = [];
    registerItemUpdateHook(async ({ propertiesPatch }) => {
      hookPatches.push(propertiesPatch);
    });

    const created = await chokePoint.createItem({
      databaseId: eventsId,
      properties: { name: "Standup", timeFrom: "10:00" },
    });
    const deadline = Date.now() + 3000;
    for (;;) {
      const { rows } = await pool.query<{ advanced: boolean }>(
        "SELECT clock_timestamp() >= $1::timestamptz + interval '2 milliseconds' AS advanced",
        [created.updatedAt],
      );
      if (rows[0]?.advanced) break;
      if (Date.now() >= deadline) throw new Error("Database clock did not advance");
    }
    const update = vi.spyOn(itemsStore, "updateItemProperties");
    try {
      const updated = await chokePoint.updateItem({
        databaseId: eventsId,
        itemId: created.id,
        propertiesPatch: { timeFrom: "9:00" },
      });

      expect(updated.properties.timeFrom).toBe("09:00");
      expect((await chokePoint.getItem(eventsId, created.id))!.properties.timeFrom).toBe("09:00");
      expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
      expect(update).toHaveBeenCalledTimes(1);
      expect(hookPatches).toEqual([{ timeFrom: "09:00" }]);
      // A create sees no stored row; the update sees the row it replaces, as committed.
      expect(transformInputs).toEqual([null, "10:00"]);
    } finally {
      update.mockRestore();
    }
  });

  it("enqueues a transformed update heartbeat and rolls it back with the item on later failure", async () => {
    const databaseId = await databaseIdFor(EVENTS_MODULE_ID);
    registerItemPreWriteTransform(EVENTS_MODULE_ID, async ({ patch }) => {
      if (patch.timeFrom === "bad") throw new ValidationError("Invalid time");
      return patch.timeFrom === "9:00" ? { ...patch, timeFrom: "09:00" } : patch;
    });
    const projectDb = await databaseIdFor("projects");
    const project = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [
      projectDb,
    ]);
    if (!project.rows[0]) throw new Error("Missing seeded project");
    const first = await chokePoint.createItem({ databaseId, properties: { name: "Success", timeFrom: "10:00" } });
    const second = await chokePoint.createItem({ databaseId, properties: { name: "Rollback", timeFrom: "10:00" } });
    const heartbeat = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        schedulerStore.createHeartbeat(client, {
          projectItemId: project.rows[0]!.id,
          name: "Update probe",
          rule: { kind: "onItemEvent", databaseId, event: "update" },
          actionId: "noop",
        }),
      ),
    );
    const job = (id: string) => schedulerStore.heartbeatFireJobKey(heartbeat.id, id);
    const readJob = (id: string) =>
      pool.query<{ key: string; locked_at: Date | null; attempts: number; max_attempts: number }>(
        "SELECT key, locked_at, attempts, max_attempts FROM graphile_worker.jobs WHERE key = $1",
        [job(id)],
      );
    const events: InvalidationEvent[] = [];
    const enqueue = vi.spyOn(queue, "enqueueJob");
    const update = vi.spyOn(itemsStore, "updateItemProperties");
    setInvalidationHook((event) => events.push(event));
    try {
      await expect(
        chokePoint.updateItem({ databaseId, itemId: first.id, propertiesPatch: { timeFrom: "bad" } }),
      ).rejects.toMatchObject({ code: "validation_failed" });
      expect((await readJob(first.id)).rows).toEqual([]);
      expect((await chokePoint.getItem(databaseId, first.id))?.properties.timeFrom).toBe("10:00");
      expect(enqueue).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      const updated = await chokePoint.updateItem({
        databaseId,
        itemId: first.id,
        propertiesPatch: { timeFrom: "9:00" },
      });
      expect(updated.properties.timeFrom).toBe("09:00");
      expect(events).toEqual([expect.objectContaining({ scope: "item", op: "update", databaseId, itemId: first.id })]);
      expect((await readJob(first.id)).rows).toEqual([
        { key: job(first.id), locked_at: null, attempts: 0, max_attempts: 3 },
      ]);
      expect(enqueue).toHaveBeenCalledWith(
        update.mock.calls[0]?.[0],
        queue.CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE,
        { heartbeatId: heartbeat.id, itemId: first.id },
        expect.objectContaining({ jobKey: job(first.id) }),
      );
      const before = await chokePoint.getItem(databaseId, second.id);
      const beforeEvents = [...events];
      const failure = new Error("rollback after heartbeat enqueue");
      await expect(
        inTenantZero(() =>
          withTransaction(pool, async (client) => {
            const changed = await updateItemWithClient(client, {
              databaseId,
              itemId: second.id,
              propertiesPatch: { timeFrom: "9:00" },
            });
            expect(changed.properties.timeFrom).toBe("09:00");
            const queued = await client.query<{
              key: string;
              locked_at: Date | null;
              attempts: number;
              max_attempts: number;
            }>("SELECT key, locked_at, attempts, max_attempts FROM graphile_worker.jobs WHERE key = $1", [
              job(second.id),
            ]);
            expect(queued.rows).toEqual([{ key: job(second.id), locked_at: null, attempts: 0, max_attempts: 3 }]);
            expect(enqueue).toHaveBeenCalledWith(
              client,
              queue.CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE,
              { heartbeatId: heartbeat.id, itemId: second.id },
              expect.objectContaining({ jobKey: job(second.id) }),
            );
            throw failure;
          }),
        ),
      ).rejects.toBe(failure);
      expect(await chokePoint.getItem(databaseId, second.id)).toEqual(before);
      expect((await readJob(second.id)).rows).toEqual([]);
      expect(events).toEqual(beforeEvents);
    } finally {
      update.mockRestore();
      enqueue.mockRestore();
      setInvalidationHook(() => {});
    }
  });

  it("replays an idempotent create without running the transform or create side effects again", async () => {
    const databaseId = await makeProbeDatabase();
    let transformCalls = 0;
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => {
      transformCalls += 1;
      return { ...patch, title: `transformed ${transformCalls}` };
    });
    const createHookProperties: Record<string, unknown>[] = [];
    registerItemCreateHook(async ({ properties }) => {
      createHookProperties.push(properties);
    });
    const projectDb = await databaseIdFor("projects");
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [projectDb]);
    const project = rows[0];
    if (!project) throw new Error("Missing seeded project");
    let heartbeatRuns = 0;
    const actions = createActionRegistry();
    actions.set("replayProbe", async () => {
      heartbeatRuns += 1;
    });
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        schedulerStore.createHeartbeat(client, {
          projectItemId: project.id,
          name: "Replay probe",
          rule: { kind: "onItemEvent", databaseId, event: "create" },
          actionId: "replayProbe",
        }),
      ),
    );
    const events: InvalidationEvent[] = [];
    const heartbeat = vi.spyOn(schedulerStore, "triggerOnItemEventHeartbeats");
    setInvalidationHook((event) => events.push(event));
    try {
      const first = await inTenantZero(() =>
        chokePoint.createItem({
          databaseId,
          properties: { title: "original" },
          idempotencyKey: "same-key",
        }),
      );
      const firstEvents = [...events];
      await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, actions) });
      expect(heartbeatRuns).toBe(1);
      expect(createHookProperties).toEqual([{ title: "transformed 1" }]);
      const replay = await inTenantZero(() =>
        chokePoint.createItem({
          databaseId,
          properties: { title: "different" },
          idempotencyKey: "same-key",
        }),
      );
      await runOnce({ pgPool: pool, taskList: createCoreTaskList(pool, actions) });
      expect(heartbeatRuns).toBe(1);

      expect(first.properties.title).toBe("transformed 1");
      expect(replay.id).toBe(first.id);
      expect(replay.properties.title).toBe("transformed 1");
      expect(await countItems(databaseId)).toBe(1);
      expect(createHookProperties).toEqual([{ title: "transformed 1" }]);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(firstEvents).toEqual([expect.objectContaining({ scope: "item", itemId: first.id, op: "create" })]);
      expect(events).toEqual(firstEvents);
      expect(transformCalls).toBe(1);
    } finally {
      heartbeat.mockRestore();
      setInvalidationHook(() => {});
    }
  });

  it("rolls back the idempotency reservation when a fresh create transform fails", async () => {
    const databaseId = await makeProbeDatabase();
    registerItemPreWriteTransform(PROBE_MODULE, async () => {
      throw new ValidationError("fixture failure");
    });
    await expect(
      inTenantZero(() =>
        chokePoint.createItem({ databaseId, properties: { title: "x" }, idempotencyKey: "failed-transform" }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await countItems(databaseId)).toBe(0);
    const result = await inTenantZero(() =>
      pool.query<{ count: string }>("SELECT count(*)::text AS count FROM idempotency_keys WHERE key = $1", [
        "failed-transform",
      ]),
    );
    expect(result.rows).toEqual([{ count: "0" }]);
  });

  it("refuses a create whose transform adds an owner:system key of another process, and stores nothing", async () => {
    const databaseId = await makeProbeDatabase();
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => ({ ...patch, link: "https://example.test" }));

    const write = chokePoint.createItem({ databaseId, properties: { title: "x" } });
    await expect(write).rejects.toBeInstanceOf(ForbiddenError);
    await expect(write).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    expect(await countItems(databaseId)).toBe(0);
  });

  it("refuses an update whose transform adds an owner:system key of another process, and keeps the stored row", async () => {
    const databaseId = await makeProbeDatabase();
    const item = await chokePoint.createItem({ databaseId, properties: { title: "kept" } });
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => ({ ...patch, link: "https://example.test" }));

    const write = chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: { title: "changed" } });
    await expect(write).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    expect((await chokePoint.getItem(databaseId, item.id))!.properties).toEqual({ title: "kept" });
  });

  it("accepts a transform-added system key whose ownerProcess is unset or the transform's own module", async () => {
    const databaseId = await makeProbeDatabase();
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => ({ ...patch, derived: "d", stamp: "s" }));

    const item = await chokePoint.createItem({ databaseId, properties: { title: "x" } });

    expect(item.properties).toMatchObject({ title: "x", derived: "d", stamp: "s" });
  });

  it("refuses a transform-added key that the database does not define", async () => {
    const databaseId = await makeProbeDatabase();
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => ({ ...patch, ghost: "boo" }));

    const write = chokePoint.createItem({ databaseId, properties: { title: "x" } });
    await expect(write).rejects.toBeInstanceOf(ValidationError);
    await expect(write).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    expect(await countItems(databaseId)).toBe(0);
  });

  it("refuses a transform-added relation key with a validation error", async () => {
    const databaseId = await makeProbeDatabase();
    const target = await chokePoint.createDatabase({ name: "Target" });
    await chokePoint.createRelationProperty({
      sourceDatabaseId: databaseId,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
    });
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => ({ ...patch, tasks: [] }));

    const write = chokePoint.createItem({ databaseId, properties: { title: "x" } });
    await expect(write).rejects.toBeInstanceOf(ValidationError);
    expect(await countItems(databaseId)).toBe(0);
  });

  it("refuses a transform-added rollup key as computed_readonly", async () => {
    const databaseId = await makeProbeDatabase();
    const target = await chokePoint.createDatabase({ name: "Target" });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: databaseId,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
    });
    await chokePoint.createProperty({
      databaseId,
      key: "count",
      name: "Count",
      type: "rollup",
      config: { relationPropertyKey: relation.key, aggregation: "count" },
    });
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => ({ ...patch, count: 5 }));

    const write = chokePoint.createItem({ databaseId, properties: { title: "x" } });
    await expect(write).rejects.toMatchObject({ status: 403, code: "computed_readonly" });
    expect(await countItems(databaseId)).toBe(0);
  });

  it.each([
    ["ghost", "boo", 400, "validation_failed"],
    ["tasks", [], 400, "validation_failed"],
    ["count", 5, 403, "computed_readonly"],
    ["link", "https://example.test", 403, "owner_violation"],
  ] as const)("refuses transform-added %s during preparation and update", async (field, value, status, code) => {
    const databaseId = await makeProbeDatabase();
    const target = await chokePoint.createDatabase({ name: "Target" });
    const { property: relation } = await chokePoint.createRelationProperty({
      sourceDatabaseId: databaseId,
      key: "tasks",
      name: "Tasks",
      targetDatabaseId: target.id,
    });
    await chokePoint.createProperty({
      databaseId,
      key: "count",
      name: "Count",
      type: "rollup",
      config: { relationPropertyKey: relation.key, aggregation: "count" },
    });
    const item = await chokePoint.createItem({ databaseId, properties: { title: "Before" } });
    const database = (await chokePoint.listDatabases()).find((entry) => entry.id === databaseId);
    if (!database) throw new Error("Missing probe database");
    const properties = await chokePoint.listProperties(databaseId);
    const transform = vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => ({ ...patch, [field]: value }));
    const prepare = vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => ({
      patch: { ...patch, [field]: value },
      deferredKeys: [],
    }));
    registerItemPreWriteTransform(PROBE_MODULE, transform, prepare);
    const snapshot = () =>
      pool.query<{ properties: string; computed: string; updated_at: string }>(
        "SELECT properties::text, computed::text, updated_at::text FROM items WHERE database_id = $1 AND id = $2",
        [databaseId, item.id],
      );
    const before = (await snapshot()).rows;
    expect(before).toHaveLength(1);
    const events: InvalidationEvent[] = [];
    const heartbeat = vi.spyOn(schedulerStore, "triggerOnItemEventHeartbeats");
    setInvalidationHook((event) => events.push(event));
    try {
      const patch = { title: "Changed" };
      await expect(prepareUserItemPatch(properties, patch, database, item, "Europe/Prague")).rejects.toMatchObject({
        status,
        code,
        details: { field },
      });
      expect(prepare).toHaveBeenCalledOnce();
      expect((await snapshot()).rows).toEqual(before);
      expect(events).toEqual([]);
      expect(heartbeat).not.toHaveBeenCalled();
      await expect(
        chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: patch }),
      ).rejects.toMatchObject({ status, code, details: { field } });
      expect(transform).toHaveBeenCalledOnce();
      expect((await snapshot()).rows).toEqual(before);
      expect(events).toEqual([]);
      expect(heartbeat).not.toHaveBeenCalled();
    } finally {
      heartbeat.mockRestore();
      setInvalidationHook(() => {});
    }
  });

  it.each([
    ["ghost", "boo", 400, "validation_failed"],
    ["tasks", [], 400, "validation_failed"],
    ["count", 5, 403, "computed_readonly"],
    ["link", "https://example.test", 403, "owner_violation"],
  ] as const)(
    "refuses in-place transform-added %s during preparation and update",
    async (field, value, status, code) => {
      const databaseId = await makeProbeDatabase();
      const target = await chokePoint.createDatabase({ name: "Target" });
      const { property: relation } = await chokePoint.createRelationProperty({
        sourceDatabaseId: databaseId,
        key: "tasks",
        name: "Tasks",
        targetDatabaseId: target.id,
      });
      await chokePoint.createProperty({
        databaseId,
        key: "count",
        name: "Count",
        type: "rollup",
        config: { relationPropertyKey: relation.key, aggregation: "count" },
      });
      const item = await chokePoint.createItem({ databaseId, properties: { title: "Before" } });
      const database = (await chokePoint.listDatabases()).find((entry) => entry.id === databaseId);
      if (!database) throw new Error("Missing probe database");
      const properties = await chokePoint.listProperties(databaseId);
      const transform = vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => {
        patch[field] = value;
        return patch;
      });
      const prepare = vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => {
        patch[field] = value;
        return { patch, deferredKeys: [] };
      });
      registerItemPreWriteTransform(PROBE_MODULE, transform, prepare);
      const snapshot = () =>
        pool.query<{ properties: string; computed: string; updated_at: string }>(
          "SELECT properties::text, computed::text, updated_at::text FROM items WHERE database_id = $1 AND id = $2",
          [databaseId, item.id],
        );
      const before = (await snapshot()).rows;
      const linksBefore = await chokePoint.getValueLinksForItems([item.id]);
      const jobsBefore = (
        await pool.query<{ key: string | null }>("SELECT key FROM graphile_worker.jobs ORDER BY key NULLS FIRST")
      ).rows;
      expect(before).toHaveLength(1);
      const events: InvalidationEvent[] = [];
      const heartbeat = vi.spyOn(schedulerStore, "triggerOnItemEventHeartbeats");
      setInvalidationHook((event) => events.push(event));
      try {
        const patch = { title: "Changed" };
        await expect(prepareUserItemPatch(properties, patch, database, item, "Europe/Prague")).rejects.toMatchObject({
          status,
          code,
          details: { field },
        });
        expect(prepare).toHaveBeenCalledOnce();
        expect(patch).toEqual({ title: "Changed" });
        expect(await chokePoint.getValueLinksForItems([item.id])).toEqual(linksBefore);
        expect(
          (await pool.query<{ key: string | null }>("SELECT key FROM graphile_worker.jobs ORDER BY key NULLS FIRST"))
            .rows,
        ).toEqual(jobsBefore);
        expect((await snapshot()).rows).toEqual(before);
        expect(events).toEqual([]);
        expect(heartbeat).not.toHaveBeenCalled();
        await expect(
          chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: patch }),
        ).rejects.toMatchObject({ status, code, details: { field } });
        expect(transform).toHaveBeenCalledOnce();
        expect(patch).toEqual({ title: "Changed" });
        expect(await chokePoint.getValueLinksForItems([item.id])).toEqual(linksBefore);
        expect(
          (await pool.query<{ key: string | null }>("SELECT key FROM graphile_worker.jobs ORDER BY key NULLS FIRST"))
            .rows,
        ).toEqual(jobsBefore);
        expect((await snapshot()).rows).toEqual(before);
        expect(events).toEqual([]);
        expect(heartbeat).not.toHaveBeenCalled();
      } finally {
        heartbeat.mockRestore();
        setInvalidationHook(() => {});
      }
    },
  );

  it("accepts own and unowned system outputs during preparation and update", async () => {
    const databaseId = await makeProbeDatabase();
    const item = await chokePoint.createItem({ databaseId, properties: { title: "Before" } });
    const database = (await chokePoint.listDatabases()).find((entry) => entry.id === databaseId);
    if (!database) throw new Error("Missing probe database");
    registerItemPreWriteTransform(
      PROBE_MODULE,
      async ({ patch }) => ({ ...patch, derived: "d", stamp: "s" }),
      async ({ patch }) => ({ patch: { ...patch, derived: "d", stamp: "s" }, deferredKeys: [] }),
    );
    const patch = { title: "Changed" };
    const before = await chokePoint.getItem(databaseId, item.id);
    expect(
      await prepareUserItemPatch(await chokePoint.listProperties(databaseId), patch, database, item, "Europe/Prague"),
    ).toEqual({
      patch: { title: "Changed", derived: "d", stamp: "s" },
      deferredKeys: [],
    });
    expect(await chokePoint.getItem(databaseId, item.id)).toEqual(before);
    const result = await chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: patch });
    expect(result.properties).toMatchObject({ title: "Changed", derived: "d", stamp: "s" });
    expect((await chokePoint.getItem(databaseId, item.id))?.properties).toEqual(result.properties);
  });

  it("accepts in-place own and unowned outputs without mutating caller input", async () => {
    const databaseId = await makeProbeDatabase();
    const item = await chokePoint.createItem({ databaseId, properties: { title: "Before" } });
    const database = (await chokePoint.listDatabases()).find((entry) => entry.id === databaseId);
    if (!database) throw new Error("Missing probe database");
    registerItemPreWriteTransform(
      PROBE_MODULE,
      async ({ patch }) => {
        patch.derived = "d";
        patch.stamp = "s";
        return patch;
      },
      async ({ patch }) => {
        patch.derived = "d";
        patch.stamp = "s";
        return { patch, deferredKeys: [] };
      },
    );
    const patch = { title: "Changed" };
    const before = await chokePoint.getItem(databaseId, item.id);
    expect(
      await prepareUserItemPatch(await chokePoint.listProperties(databaseId), patch, database, item, "Europe/Prague"),
    ).toEqual({
      patch: { title: "Changed", derived: "d", stamp: "s" },
      deferredKeys: [],
    });
    expect(patch).toEqual({ title: "Changed" });
    expect(await chokePoint.getItem(databaseId, item.id)).toEqual(before);
    const result = await chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: patch });
    expect(patch).toEqual({ title: "Changed" });
    expect(result.properties).toMatchObject({ title: "Changed", derived: "d", stamp: "s" });
    expect((await chokePoint.getItem(databaseId, item.id))?.properties).toEqual(result.properties);
  });

  it("fails a create whose transform throws ValidationError with 400 and stores nothing", async () => {
    const databaseId = await makeProbeDatabase();
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => {
      if (patch.title === "bad") throw new ValidationError("title rejected");
      return patch;
    });

    const write = chokePoint.createItem({ databaseId, properties: { title: "bad" } });
    await expect(write).rejects.toBeInstanceOf(ValidationError);
    await expect(write).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    expect(await countItems(databaseId)).toBe(0);
  });

  it("fails an update whose transform throws ValidationError with 400 and keeps the stored row", async () => {
    const databaseId = await makeProbeDatabase();
    const item = await chokePoint.createItem({ databaseId, properties: { title: "fine" } });
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => {
      if (patch.title === "bad") throw new ValidationError("title rejected");
      return patch;
    });

    const write = chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: { title: "bad" } });
    await expect(write).rejects.toBeInstanceOf(ValidationError);
    await expect(write).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    expect((await chokePoint.getItem(databaseId, item.id))!.properties.title).toBe("fine");
  });

  it("takes the item row lock on update only for a database whose module registered a transform", async () => {
    const eventsId = await databaseIdFor(EVENTS_MODULE_ID);
    const eventsItem = await chokePoint.createItem({ databaseId: eventsId, properties: { name: "Standup" } });
    const databaseId = await makeProbeDatabase();
    const item = await chokePoint.createItem({ databaseId, properties: { title: "before" } });
    const lockSpy = vi.spyOn(itemsStore, "lockItemById");

    try {
      await chokePoint.updateItem({ databaseId: eventsId, itemId: eventsItem.id, propertiesPatch: { name: "Daily" } });
      expect(lockSpy).not.toHaveBeenCalled();

      registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => patch);
      await chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: { title: "after" } });
      expect(lockSpy).toHaveBeenCalledTimes(1);
    } finally {
      lockSpy.mockRestore();
    }
  });

  it("leaves Tasks time untouched on an update that names neither timeFrom nor timeTo", async () => {
    registerItemPreWriteTransform(TASKS_MODULE_ID, taskPreWriteTransform);
    const tasksId = await databaseIdFor(TASKS_MODULE_ID);
    // insertItem bypasses the transform on purpose: it stores a stale derived value, so the update below
    // proves the Tasks transform did not recompute `time` for a patch that names neither source.
    const stale = await itemsStore.insertItem(pool, {
      databaseId: tasksId,
      properties: { name: "Plan", timeFrom: "09:00", timeTo: "10:00", time: "stale" },
    });

    const renamed = await chokePoint.updateItem({
      databaseId: tasksId,
      itemId: stale.id,
      propertiesPatch: { name: "Renamed" },
    });

    expect(renamed.properties).toMatchObject({ name: "Renamed", time: "stale" });
  });
});
