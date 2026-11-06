import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId, getSystemTimezone } from "../systemSettings.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { today } from "../calendarTime.js";

let admin: Pool;
let data: Pool;
let cp: ChokePoint;
let tenant: string;
let databaseId: string;

describe("Projects completion date", () => {
  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("check project completion role", () =>
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
      const db = await withTransaction(data, (client) => getDatabaseByModuleId(client, "projects"));
      if (!db) throw new Error("Projects missing");
      databaseId = db.id;
    });
  });
  afterAll(async () => {
    await data.end();
    await admin.end();
  });

  it("adds the property to a suspended maintained tenant and replay does not rewrite it", async () => {
    const otherTenant = await createTestTenant(admin);
    const otherDatabaseId = await runInTenant(otherTenant, async () => {
      await seedSystem(data);
      const db = await withTransaction(data, (client) => getDatabaseByModuleId(client, "projects"));
      if (!db) throw new Error("Other tenant Projects missing");
      return db.id;
    });
    const removed = await admin.query(
      "DELETE FROM properties WHERE tenant_id = $1 AND database_id = $2 AND key = 'completedAt'",
      [tenant, databaseId],
    );
    expect(removed.rowCount).toBe(1);
    const otherRemoved = await admin.query(
      "DELETE FROM properties WHERE tenant_id = $1 AND database_id = $2 AND key = 'completedAt'",
      [otherTenant, otherDatabaseId],
    );
    expect(otherRemoved.rowCount).toBe(1);
    const suspended = await admin.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenant]);
    expect(suspended.rowCount).toBe(1);
    const run = () => runAsSystem("project completion cutover test", () => runTenantCutoverMigrations(data));
    await run();
    const read = () =>
      runInTenant(tenant, () =>
        data.query<{ id: string; version: string }>(
          "SELECT id, xmin::text AS version FROM properties WHERE database_id = $1 AND key = 'completedAt'",
          [databaseId],
        ),
      );
    const first = await read();
    expect(first.rows).toHaveLength(1);
    const other = await runInTenant(otherTenant, () =>
      data.query<{ id: string; version: string }>(
        "SELECT id, xmin::text AS version FROM properties WHERE database_id = $1 AND key = 'completedAt'",
        [otherDatabaseId],
      ),
    );
    expect(other.rows).toHaveLength(1);
    expect(
      (
        await runInTenant(otherTenant, () =>
          data.query("SELECT id FROM properties WHERE database_id = $1 AND key = 'completedAt'", [databaseId]),
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await runInTenant(otherTenant, () =>
          data.query("SELECT id FROM properties WHERE database_id = $1 AND key = 'completedAt'", [randomUUID()]),
        )
      ).rows,
    ).toEqual([]);
    await run();
    expect((await read()).rows).toEqual(first.rows);
    expect(
      (
        await runInTenant(otherTenant, () =>
          data.query<{ id: string; version: string }>(
            "SELECT id, xmin::text AS version FROM properties WHERE database_id = $1 AND key = 'completedAt'",
            [otherDatabaseId],
          ),
        )
      ).rows,
    ).toEqual(other.rows);
  });

  it("sets the tenant day on entering terminal state, retains it across terminal states and clears it on return", async () => {
    await runInTenant(tenant, async () => {
      const item = await cp.createItem({ databaseId, properties: { name: "Project", status: "inProgress" } });
      const day = today(await withTransaction(data, getSystemTimezone));
      const done = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "done" } });
      expect(done.properties.completedAt).toBe(day);
      const archived = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "archived" } });
      expect(archived.properties.completedAt).toBe(day);
      const active = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "inProgress" } });
      expect(active.properties.completedAt).toBeNull();
      const directArchive = await cp.updateItem({
        databaseId,
        itemId: item.id,
        propertiesPatch: { status: "archived" },
      });
      expect(directArchive.properties.completedAt).toBe(day);
      const longTerm = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "longTerm" } });
      expect(longTerm.properties.completedAt).toBeNull();
      const legacy = await cp.createItem({ databaseId, properties: { name: "Legacy", status: "done" } });
      const stripped = await admin.query(
        "UPDATE items SET properties = properties - 'completedAt' WHERE tenant_id = $1 AND id = $2",
        [tenant, legacy.id],
      );
      expect(stripped.rowCount).toBe(1);
      const legacyArchived = await cp.updateItem({
        databaseId,
        itemId: legacy.id,
        propertiesPatch: { status: "archived" },
      });
      expect(legacyArchived.properties).not.toHaveProperty("completedAt");
      await expect(
        cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { completedAt: day } }),
      ).rejects.toMatchObject({ status: 403 });
      expect((await cp.getItem(databaseId, item.id))?.properties.completedAt).toBeNull();
    });
  });

  it("uses a tenant day that differs from UTC for implicit completion", async () => {
    await runInTenant(tenant, async () => {
      const dateIn = (zone: string) => {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: zone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).formatToParts(new Date());
        return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
      };
      const utcDay = dateIn("UTC");
      const zone = ["Pacific/Kiritimati", "Etc/GMT+12"].find((candidate) => dateIn(candidate) !== utcDay);
      if (!zone) throw new Error("Expected one tenant zone on a different day from UTC");
      const settings = await withTransaction(data, async (client) => ({
        databaseId: await getSystemSettingsDatabaseId(client),
        itemId: await getSystemSettingsItemId(client),
      }));
      await cp.updateItem({ ...settings, propertiesPatch: { timezone: zone } });
      const expected = dateIn(zone);
      const item = await cp.createItem({ databaseId, properties: { name: "Zoned project", status: "inProgress" } });
      const done = await cp.updateItem({ databaseId, itemId: item.id, propertiesPatch: { status: "done" } });
      expect(done.properties.completedAt).toBe(expected);
      expect(done.properties.completedAt).not.toBe(utcDay);
    });
  });
});
