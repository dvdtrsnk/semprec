import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { clearHooksForTests, registerItemPreWriteTransform } from "../../chokePoint/hooks.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../../systemSettings.js";
import { withTransaction } from "../../db/pool.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { taskPreWriteTransform, prepareTaskProposal } from "../taskPreWriteTransform.js";
import { taskDisplayDay } from "../taskDisplayDay.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let tasks: string;
describe("Tasks completion and first planned day", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    const rows = await runInTenant(tenant, () =>
      pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = 'tasks'"),
    );
    if (!rows.rows[0]) throw new Error("Tasks missing");
    tasks = rows.rows[0].id;
    clearHooksForTests();
    registerItemPreWriteTransform("tasks", taskPreWriteTransform, prepareTaskProposal);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-14T23:30:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    clearHooksForTests();
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("completes in the tenant day, preserves repeated completion, allows correction, and clears on reopening", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const item = await cp.createItem({ databaseId: tasks, properties: { name: "Task", date: "2026-10-22" } });
      vi.setSystemTime(new Date("2026-10-15T23:30:00Z"));
      const done = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: item.updatedAt,
        propertiesPatch: { status: "done" },
      });
      expect(done.properties).toMatchObject({
        status: "done",
        date: "2026-10-22",
        completedOn: "2026-10-16",
        completedAt: "2026-10-15T23:30:00.000Z",
      });
      expect(taskDisplayDay(done)).toBe("2026-10-16");
      vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
      const repeated = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: done.updatedAt,
        propertiesPatch: { status: "done" },
      });
      expect(repeated.properties.completedOn).toBe(done.properties.completedOn);
      expect(repeated.properties.completedAt).toBe(done.properties.completedAt);
      const corrected = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: repeated.updatedAt,
        propertiesPatch: { completedOn: "2026-10-12" },
      });
      expect(corrected.properties).toEqual({ ...repeated.properties, completedOn: "2026-10-12" });
      expect(taskDisplayDay(corrected)).toBe("2026-10-12");
      expect(corrected.properties.completedAt).toBe(done.properties.completedAt);
      const reopened = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: corrected.updatedAt,
        propertiesPatch: { status: "notDone" },
      });
      expect(reopened.properties).toMatchObject({ completedOn: null, completedAt: null, date: "2026-10-22" });
    }));
  it("rejects future and non-done completion days without changing the item", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const item = await cp.createItem({ databaseId: tasks, properties: { name: "Task" } });
      const before = await cp.getItem(tasks, item.id);
      for (const patch of [{ completedOn: "2026-10-14" }, { status: "done", completedOn: "2026-10-16" }]) {
        await expect(
          cp.updateItem({ databaseId: tasks, itemId: item.id, ifVersion: item.updatedAt, propertiesPatch: patch }),
        ).rejects.toMatchObject({ code: "validation_failed", details: { field: "completedOn" } });
        expect(await cp.getItem(tasks, item.id)).toEqual(before);
      }
    }));
  it("preserves the original completion when a create is replayed on a later day", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const first = await cp.createItem({
        databaseId: tasks,
        properties: { name: "Task", status: "done" },
        idempotencyKey: "done-replay",
      });
      vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
      const settings = await withTransaction(pool, async (client) => ({
        databaseId: await getSystemSettingsDatabaseId(client),
        itemId: await getSystemSettingsItemId(client),
      }));
      await cp.updateItem({ ...settings, propertiesPatch: { timezone: "America/Los_Angeles" } });
      const replay = await cp.createItem({
        databaseId: tasks,
        properties: { name: "Task", status: "done" },
        idempotencyKey: "done-replay",
      });
      expect(replay).toEqual(first);
    }));
  it("accepts an explicit earlier completion day and clears both fields on wontDo", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const item = await cp.createItem({ databaseId: tasks, properties: { name: "Task", date: "2026-10-16" } });
      const done = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: item.updatedAt,
        propertiesPatch: { status: "done", completedOn: "2026-10-12" },
      });
      expect(done.properties).toMatchObject({ date: "2026-10-16", completedOn: "2026-10-12" });
      expect(done.properties.completedAt).toBe("2026-10-14T23:30:00.000Z");
      expect(taskDisplayDay(done)).toBe("2026-10-12");
      const stopped = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: done.updatedAt,
        propertiesPatch: { status: "wontDo" },
      });
      expect(stopped.properties).toMatchObject({ completedOn: null, completedAt: null, date: "2026-10-16" });
    }));
  it("displays a moved task on its explicitly supplied first planned day when completed", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const item = await cp.createItem({ databaseId: tasks, properties: { name: "Task", date: "2026-10-14" } });
      const moved = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: item.updatedAt,
        propertiesPatch: { date: "2026-10-16" },
      });
      expect(moved.properties.since).toBe("2026-10-14");
      const done = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: moved.updatedAt,
        propertiesPatch: { status: "done", completedOn: "2026-10-14" },
      });
      expect(done.properties).toMatchObject({ date: "2026-10-16", since: "2026-10-14", completedOn: "2026-10-14" });
      expect(taskDisplayDay(done)).toBe("2026-10-14");
    }));
  it("does not capture a first planned day when the stored day is not overdue or the task is done", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      for (const properties of [
        { name: "Today", date: "2026-10-15" },
        { name: "Future", date: "2026-10-16" },
        { name: "Done", date: "2026-10-13", status: "done" },
      ]) {
        const item = await cp.createItem({ databaseId: tasks, properties });
        const moved = await cp.updateItem({
          databaseId: tasks,
          itemId: item.id,
          ifVersion: item.updatedAt,
          propertiesPatch: { date: "2026-10-20" },
        });
        expect(moved.properties.since ?? null).toBeNull();
        expect(moved.properties.sinceTime ?? null).toBeNull();
      }
    }));
  it("captures the old overdue day and time once", async () =>
    runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
      const item = await cp.createItem({
        databaseId: tasks,
        properties: { name: "Task", date: "2026-10-13", timeFrom: "10:00", timeTo: "11:00" },
      });
      const moved = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: item.updatedAt,
        propertiesPatch: { date: "2026-10-14" },
      });
      expect(moved.properties).toMatchObject({ since: "2026-10-13", sinceTime: { from: "10:00", to: "11:00" } });
      vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
      const movedAgain = await cp.updateItem({
        databaseId: tasks,
        itemId: item.id,
        ifVersion: moved.updatedAt,
        propertiesPatch: { date: "2026-10-20", timeFrom: "09:00" },
      });
      expect(movedAgain.properties).toMatchObject({ since: "2026-10-13", sinceTime: { from: "10:00", to: "11:00" } });
      expect((await cp.getItem(tasks, item.id))?.properties).toMatchObject({
        since: "2026-10-13",
        sinceTime: { from: "10:00", to: "11:00" },
      });
      expect(
        (await cp.queryDatabaseItems(tasks, {})).items.find((row) => row.id === item.id)?.properties,
      ).toMatchObject({ since: "2026-10-13", sinceTime: { from: "10:00", to: "11:00" } });
      for (const propertiesPatch of [
        { since: "2026-10-01" },
        { sinceTime: { from: "08:00", to: null } },
        { completedAt: "2026-10-14T00:00:00.000Z" },
      ]) {
        await expect(
          cp.updateItem({ databaseId: tasks, itemId: item.id, ifVersion: movedAgain.updatedAt, propertiesPatch }),
        ).rejects.toMatchObject({ code: "owner_violation" });
      }
    }));
});
