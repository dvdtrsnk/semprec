import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { prepareUserItemPatch } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import {
  clearHooksForTests,
  registerItemCreateHook,
  registerItemPreWriteTransform,
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
      } finally {
        setInvalidationHook(() => {});
      }
    });

    it("rejects an invalid color added by a transform on create", async () => {
      const database = await fixture();
      registerOutput({ color: "invalid" });
      await expect(
        chokePoint.createItem({ databaseId: database.id, properties: { title: "Valid" } }, undefined, undefined, {
          writerKind: "user",
        }),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field: "color" } });
      expect(await countItems(database.id)).toBe(0);
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
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        const patch = { title: "Updated", color: "#abcdef" };
        await expect(prepareUserItemPatch(properties, patch, database, item)).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field },
        });
        await expect(
          chokePoint.updateItem(
            { databaseId: database.id, itemId: item.id, propertiesPatch: patch },
            undefined,
            undefined,
            { writerKind: "user" },
          ),
        ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field } });
        expect((await chokePoint.getItem(database.id, item.id))?.properties).toEqual(item.properties);
        expect(events).toEqual([]);
      } finally {
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
      expect((await prepareUserItemPatch(properties, { title: "Updated" }, database, created)).patch).toMatchObject({
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
      await expect(prepareUserItemPatch(properties, patch, database, item)).rejects.toMatchObject({
        status: 400,
        code: "validation_failed",
        details: { field },
      });
      await expect(
        chokePoint.updateItem(
          { databaseId: database.id, itemId: item.id, propertiesPatch: patch },
          undefined,
          undefined,
          { writerKind: "user" },
        ),
      ).rejects.toMatchObject({ status: 400, code: "validation_failed", details: { field } });
      expect((await chokePoint.getItem(database.id, item.id))?.properties).toEqual(item.properties);
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
      expect((await prepareUserItemPatch(properties, { title: "Updated" }, database, item)).patch.color).toBeNull();
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
    const updated = await chokePoint.updateItem({
      databaseId: eventsId,
      itemId: created.id,
      propertiesPatch: { timeFrom: "9:00" },
    });

    expect(updated.properties.timeFrom).toBe("09:00");
    expect((await chokePoint.getItem(eventsId, created.id))!.properties.timeFrom).toBe("09:00");
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect(hookPatches).toEqual([{ timeFrom: "09:00" }]);
    // A create sees no stored row; the update sees the row it replaces, as committed.
    expect(transformInputs).toEqual([null, "10:00"]);
  });

  it("replays an idempotent create without writing, running a create hook, or keeping the second transform result", async () => {
    const databaseId = await makeProbeDatabase();
    let transformCalls = 0;
    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => {
      transformCalls += 1;
      return { ...patch, title: `transformed ${transformCalls}` };
    });
    let createHookCalls = 0;
    registerItemCreateHook(async () => {
      createHookCalls += 1;
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
      expect(createHookCalls).toBe(1);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(firstEvents).toEqual([expect.objectContaining({ scope: "item", itemId: first.id, op: "create" })]);
      expect(events).toEqual(firstEvents);
      // The transforms run before insertItemWithReplay checks the key, so the replay invokes the transform
      // once more and discards that result (see the choke-point ADR, consequences).
      expect(transformCalls).toBe(2);
    } finally {
      heartbeat.mockRestore();
      setInvalidationHook(() => {});
    }
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

    await chokePoint.updateItem({ databaseId: eventsId, itemId: eventsItem.id, propertiesPatch: { name: "Daily" } });
    expect(lockSpy).not.toHaveBeenCalled();

    registerItemPreWriteTransform(PROBE_MODULE, async ({ patch }) => patch);
    await chokePoint.updateItem({ databaseId, itemId: item.id, propertiesPatch: { title: "after" } });
    expect(lockSpy).toHaveBeenCalledTimes(1);
    lockSpy.mockRestore();
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
