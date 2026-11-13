import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import * as databasesStore from "../../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { runEventsRecurrenceCutoverMigration } from "../eventsRecurrenceCutoverMigration.js";

const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };

const propertyShape = z.array(
  z.object({
    key: z.string(),
    name: z.string().nullable(),
    type: z.string(),
    config: z.unknown(),
    locked: z.boolean(),
    owner: z.string(),
    owner_process: z.string().nullable(),
    migration_status: z.string(),
  }),
);

describe("Events recurrence cutover (issue gh-1817)", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  let zero: string;
  let other: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    zero = getTenantZeroId();
    other = await createTestTenant(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  /** The `recurrence` definition of a tenant's Events database, in every column that describes it. */
  async function recurrenceProperties(tenantId: string) {
    const { rows } = await adminPool.query<Record<string, unknown>>(
      `SELECT p.key, p.name, p.type, p.config, p.locked, p.owner, p.owner_process, p.migration_status
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key = 'recurrence'`,
      [tenantId],
    );
    return propertyShape.parse(rows);
  }

  /** Reproduces a tenant seeded before issue gh-1817: its Events database has no `recurrence` definition. */
  async function revertToOldShape(tenantId: string): Promise<void> {
    await adminPool.query(
      `DELETE FROM properties p USING databases d
        WHERE d.id = p.database_id AND d.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key = 'recurrence'`,
      [tenantId],
    );
  }

  async function seed(tenantId: string): Promise<void> {
    await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  }

  it("declares the property in a fresh seed as a user-owned json property without a name or config", async () => {
    await seed(zero);

    expect(await recurrenceProperties(zero)).toEqual([
      {
        key: "recurrence",
        name: null,
        type: "json",
        config: {},
        locked: false,
        owner: "user",
        owner_process: null,
        migration_status: expect.any(String),
      },
    ]);
  });

  it("adds a definition identical to a fresh seed to an existing tenant, touching no other tenant and no Event", async () => {
    await seed(zero);
    await seed(other);
    const fresh = await recurrenceProperties(zero);
    const untouchedOther = await recurrenceProperties(other);
    const eventsId = await runInTenant(zero, () =>
      withTransaction(dataPool, async (client) => (await databasesStore.getDatabaseByModuleId(client, "events"))?.id),
    );
    if (!eventsId) throw new Error("Missing the events database");
    const event = await runInTenant(zero, () =>
      createChokePoint(dataPool).createItem({
        databaseId: eventsId,
        properties: { name: "Standup", date: "2026-10-12" },
      }),
    );
    await revertToOldShape(zero);
    expect(await recurrenceProperties(zero)).toEqual([]);
    const eventBefore = await adminPool.query("SELECT properties, updated_at FROM items WHERE id = $1", [event.id]);

    await runAsSystem("test Events recurrence cutover", () => runTenantCutoverMigrations(dataPool));

    expect(await recurrenceProperties(zero)).toEqual(fresh);
    expect(await recurrenceProperties(other)).toEqual(untouchedOther);
    expect((await adminPool.query("SELECT properties, updated_at FROM items WHERE id = $1", [event.id])).rows).toEqual(
      eventBefore.rows,
    );
  });

  it("makes the added property writable with a rule through the choke point", async () => {
    await seed(zero);
    await revertToOldShape(zero);
    await runInTenant(zero, () => runEventsRecurrenceCutoverMigration(dataPool));

    const stored = await runInTenant(zero, async () => {
      const cp = createChokePoint(dataPool);
      const events = (await cp.listDatabases()).find((database) => database.ownerModuleId === "events");
      if (!events) throw new Error("Missing the events database");
      return cp.createItem(
        { databaseId: events.id, properties: { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS } },
        undefined,
        undefined,
        { writerKind: "user" },
      );
    });

    expect(stored.properties.recurrence).toEqual(WEEKDAYS);
  });

  it("changes nothing when it runs a second time", async () => {
    await seed(zero);
    await revertToOldShape(zero);
    await runInTenant(zero, () => runEventsRecurrenceCutoverMigration(dataPool));
    const afterFirst = await adminPool.query<{ id: string }>(
      "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.tenant_id = $1 AND p.key = 'recurrence'",
      [zero],
    );
    const shape = await recurrenceProperties(zero);

    await runInTenant(zero, () => runEventsRecurrenceCutoverMigration(dataPool));

    expect(await recurrenceProperties(zero)).toEqual(shape);
    expect(
      (
        await adminPool.query<{ id: string }>(
          "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.tenant_id = $1 AND p.key = 'recurrence'",
          [zero],
        )
      ).rows,
    ).toEqual(afterFirst.rows);
  });

  it("is skipped for a tenant without an Events database", async () => {
    await runInTenant(other, () => runEventsRecurrenceCutoverMigration(dataPool));

    expect(await recurrenceProperties(other)).toEqual([]);
    const { rows } = await adminPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM databases WHERE tenant_id = $1",
      [other],
    );
    expect(rows[0]?.count).toBe(0);
  });
});
