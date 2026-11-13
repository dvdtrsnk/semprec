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
import { runEventsOccurrenceCutoverMigration } from "../eventsOccurrenceCutoverMigration.js";

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

describe("Events occurrence cutover (issue gh-1843)", () => {
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

  /** The `seriesId` and `occurrenceDate` definitions of a tenant's Events database, in every column that describes them. */
  async function occurrenceProperties(tenantId: string, keys: string[] = ["seriesId", "occurrenceDate"]) {
    const { rows } = await adminPool.query<Record<string, unknown>>(
      `SELECT p.key, p.name, p.type, p.config, p.locked, p.owner, p.owner_process, p.migration_status
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key = ANY($2::text[])
        ORDER BY p.key`,
      [tenantId, keys],
    );
    return propertyShape.parse(rows);
  }

  /** Reproduces a tenant seeded before issue gh-1843: its Events database has no occurrence definitions. */
  async function revertToOldShape(tenantId: string, keys: string[] = ["seriesId", "occurrenceDate"]): Promise<void> {
    await adminPool.query(
      `DELETE FROM properties p USING databases d
        WHERE d.id = p.database_id AND d.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key = ANY($2::text[])`,
      [tenantId, keys],
    );
  }

  async function seed(tenantId: string): Promise<void> {
    await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  }

  it("declares both properties in a fresh seed as system-owned, unlocked properties of the calendar module", async () => {
    await seed(zero);

    expect(await occurrenceProperties(zero)).toEqual([
      {
        key: "occurrenceDate",
        name: null,
        type: "date",
        config: {},
        locked: false,
        owner: "system",
        owner_process: "calendar",
        migration_status: expect.any(String),
      },
      {
        key: "seriesId",
        name: null,
        type: "text",
        config: {},
        locked: false,
        owner: "system",
        owner_process: "calendar",
        migration_status: expect.any(String),
      },
    ]);
  });

  it("adds definitions identical to a fresh seed to an existing tenant, touching no other tenant and no Event", async () => {
    await seed(zero);
    await seed(other);
    const fresh = await occurrenceProperties(zero);
    const untouchedOther = await occurrenceProperties(other);
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
    expect(await occurrenceProperties(zero)).toEqual([]);
    const eventBefore = await adminPool.query("SELECT properties, updated_at FROM items WHERE id = $1", [event.id]);

    await runAsSystem("test Events occurrence cutover", () => runTenantCutoverMigrations(dataPool));

    expect(await occurrenceProperties(zero)).toEqual(fresh);
    expect(await occurrenceProperties(other)).toEqual(untouchedOther);
    expect((await adminPool.query("SELECT properties, updated_at FROM items WHERE id = $1", [event.id])).rows).toEqual(
      eventBefore.rows,
    );
  });

  it("adds only the definition that is missing and leaves the existing one as it is", async () => {
    await seed(zero);
    await revertToOldShape(zero, ["occurrenceDate"]);
    const kept = await adminPool.query<{ id: string }>(
      "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.tenant_id = $1 AND p.key = 'seriesId'",
      [zero],
    );

    await runInTenant(zero, () => runEventsOccurrenceCutoverMigration(dataPool));

    expect((await occurrenceProperties(zero)).map((property) => property.key)).toEqual(["occurrenceDate", "seriesId"]);
    expect(
      (
        await adminPool.query<{ id: string }>(
          "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.tenant_id = $1 AND p.key = 'seriesId'",
          [zero],
        )
      ).rows,
    ).toEqual(kept.rows);
  });

  it("changes nothing when it runs a second time", async () => {
    await seed(zero);
    await revertToOldShape(zero);
    await runInTenant(zero, () => runEventsOccurrenceCutoverMigration(dataPool));
    const afterFirst = await adminPool.query<{ id: string }>(
      "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.tenant_id = $1 AND p.key IN ('seriesId', 'occurrenceDate') ORDER BY p.id",
      [zero],
    );
    const shape = await occurrenceProperties(zero);

    await runInTenant(zero, () => runEventsOccurrenceCutoverMigration(dataPool));

    expect(await occurrenceProperties(zero)).toEqual(shape);
    expect(
      (
        await adminPool.query<{ id: string }>(
          "SELECT p.id FROM properties p JOIN databases d ON d.id = p.database_id WHERE d.tenant_id = $1 AND p.key IN ('seriesId', 'occurrenceDate') ORDER BY p.id",
          [zero],
        )
      ).rows,
    ).toEqual(afterFirst.rows);
  });

  it("is skipped for a tenant without an Events database", async () => {
    await runInTenant(other, () => runEventsOccurrenceCutoverMigration(dataPool));

    expect(await occurrenceProperties(other)).toEqual([]);
    const { rows } = await adminPool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM databases WHERE tenant_id = $1",
      [other],
    );
    expect(rows[0]?.count).toBe(0);
  });
});
