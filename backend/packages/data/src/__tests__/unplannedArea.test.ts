import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { ensureUnplannedArea } from "../seed/seedUnplannedArea.js";

let admin: Pool;
let data: Pool;
let cp: ChokePoint;
let tenant: string;
let areasId: string;

describe("unplanned system area", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check unplanned area role", () =>
      data.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    cp = createChokePoint(data);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, async () => {
      await seedSystem(data);
      const areas = await withTransaction(data, (client) => getDatabaseByModuleId(client, "areas"));
      if (!areas) throw new Error("Areas missing");
      areasId = areas.id;
    });
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  it("creates exactly one Czech system area", async () => {
    await runInTenant(tenant, async () => {
      const list = await cp.listItems(areasId);
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.properties).toMatchObject({ name: "(neplánováno)", active: true, systemActive: true });
    });
  });

  it("creates one area when two direct owner calls run concurrently", async () => {
    const before = await runInTenant(tenant, () => cp.listItems(areasId));
    const area = before.items[0];
    if (!area) throw new Error("Area missing");
    const deleted = await admin.query("DELETE FROM items WHERE tenant_id = $1 AND id = $2", [tenant, area.id]);
    expect(deleted.rowCount).toBe(1);
    let ready!: (pid: number) => void;
    let release!: () => void;
    const started = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runInTenant(tenant, () =>
      withTransaction(data, async (client) => {
        const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
        if (pid === undefined) throw new Error("Missing owner PID");
        await ensureUnplannedArea(client, areasId);
        ready(pid);
        await gate;
      }),
    );
    const firstSettled = Promise.allSettled([first]);
    let secondSettled: Promise<PromiseSettledResult<void>[]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pid = await Promise.race([
        started,
        first.then(() => {
          throw new Error("First owner finished before barrier");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owner barrier timed out")), 5_000);
        }),
      ]);
      const second = runInTenant(tenant, () => withTransaction(data, (client) => ensureUnplannedArea(client, areasId)));
      secondSettled = Promise.allSettled([second]);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        const waiting = await admin.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock%') AS present",
          [pid],
        );
        blocked = waiting.rows[0]?.present === true;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
      if (timer) clearTimeout(timer);
      await firstSettled;
      if (secondSettled !== undefined) await secondSettled;
    }
    for (const result of [...(await firstSettled), ...(secondSettled !== undefined ? await secondSettled : [])]) {
      if (result.status === "rejected") throw result.reason;
    }
    const after = await runInTenant(tenant, () => cp.listItems(areasId));
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.properties).toMatchObject({ name: "(neplánováno)", active: true, systemActive: true });
  });

  it("keeps other tenants' system areas invisible and unchanged", async () => {
    const other = await createTestTenant(admin);
    const foreign = await runInTenant(other, async () => {
      await seedSystem(data);
      const database = await withTransaction(data, (client) => getDatabaseByModuleId(client, "areas"));
      if (!database) throw new Error("Areas missing");
      const item = (await cp.listItems(database.id)).items[0];
      if (!item) throw new Error("Area missing");
      return { database, item };
    });
    await runInTenant(tenant, async () => {
      const own = (await cp.listItems(areasId)).items[0];
      if (!own) throw new Error("Own area missing");
      expect(await cp.findItem(own.id)).toEqual(own);
      expect(await cp.findItem(foreign.item.id)).toBeNull();
      expect(await cp.findItem(randomUUID())).toBeNull();
      expect(await cp.softDeleteItem(areasId, foreign.item.id)).toBeNull();
      expect(await cp.softDeleteItem(areasId, randomUUID())).toBeNull();
      expect(await cp.getItem(areasId, own.id)).toEqual(own);
    });
    expect(await runInTenant(other, () => cp.getItem(foreign.database.id, foreign.item.id))).toEqual(foreign.item);
  });
});
