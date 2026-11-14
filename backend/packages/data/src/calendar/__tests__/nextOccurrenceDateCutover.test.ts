import "../../domainWriteHooks.js";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import { runNextOccurrenceDateCutoverMigration } from "../nextOccurrenceDateCutoverMigration.js";
import { NEXT_OCCURRENCE_REFRESH_ACTION_ID } from "../nextOccurrenceRefreshAction.js";

const USER = { writerKind: "user" } as const;
const WEEKDAYS = { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };
/** Saturday 17 October 2026, noon in Prague. */
const SATURDAY = new Date("2026-10-17T10:00:00Z");

const propertyShape = z.array(
  z.object({
    key: z.string(),
    name: z.string().nullable(),
    type: z.string(),
    config: z.unknown(),
    locked: z.boolean(),
    owner: z.string(),
    owner_process: z.string().nullable(),
  }),
);
const itemShape = z.object({ properties: z.record(z.string(), z.unknown()), updated_at: z.string() });
const idShape = z.object({ id: z.string() });

describe("Events nextOccurrenceDate cutover (issue gh-1905)", () => {
  let admin: Pool;
  let data: Pool;
  let zero: string;
  let other: string;

  beforeAll(async () => {
    admin = getTestPool();
    data = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    zero = getTenantZeroId();
    other = await createTestTenant(admin);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SATURDAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await data?.end();
    await admin?.end();
  });

  const seed = (tenantId: string) => runInTenant(tenantId, () => seedSystem(data, createViewTypeRegistry()));

  /** The tenant's own Events database id; the admin pool bypasses row-level security, so the tenant is filtered by hand. */
  async function eventsDatabaseId(tenantId: string): Promise<string> {
    const { rows } = await admin.query("SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = 'events'", [
      tenantId,
    ]);
    return idShape.parse(rows[0]).id;
  }

  const createEvent = (tenantId: string, databaseId: string, properties: Record<string, unknown>) =>
    runInTenant(tenantId, () =>
      createChokePoint(data).createItem(
        { databaseId, properties: { name: "Event", ...properties } },
        undefined,
        undefined,
        USER,
      ),
    );

  async function propertyDefinition(tenantId: string) {
    const { rows } = await admin.query(
      `SELECT p.key, p.name, p.type, p.config, p.locked, p.owner, p.owner_process
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key = 'nextOccurrenceDate'`,
      [tenantId],
    );
    return propertyShape.parse(rows);
  }

  async function itemRow(tenantId: string, itemId: string) {
    const { rows } = await admin.query(
      "SELECT properties, updated_at::text FROM items WHERE tenant_id = $1 AND id = $2",
      [tenantId, itemId],
    );
    return itemShape.parse(rows[0]);
  }

  async function heartbeatCount(tenantId: string): Promise<number> {
    const { rows } = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM project_heartbeats WHERE tenant_id = $1 AND action_id = $2",
      [tenantId, NEXT_OCCURRENCE_REFRESH_ACTION_ID],
    );
    return rows[0]?.count ?? -1;
  }

  /** Reproduces a tenant seeded before issue gh-1905: no definition, no value on any Event, no heartbeat. */
  async function revertToOldShape(tenantId: string): Promise<void> {
    await admin.query(
      `DELETE FROM properties p USING databases d
        WHERE d.id = p.database_id AND d.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key = 'nextOccurrenceDate'`,
      [tenantId],
    );
    await admin.query(
      `UPDATE items SET properties = properties - 'nextOccurrenceDate'
        WHERE tenant_id = $1 AND database_id = (SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = 'events')`,
      [tenantId],
    );
    await admin.query("DELETE FROM project_heartbeats WHERE tenant_id = $1 AND action_id = $2", [
      tenantId,
      NEXT_OCCURRENCE_REFRESH_ACTION_ID,
    ]);
  }

  it("declares the property in a fresh seed as a locked, system-owned date without a name, config or owner process", async () => {
    await seed(zero);

    expect(await propertyDefinition(zero)).toEqual([
      {
        key: "nextOccurrenceDate",
        name: null,
        type: "date",
        config: {},
        locked: true,
        owner: "system",
        owner_process: null,
      },
    ]);
    expect(await heartbeatCount(zero)).toBe(1);
  });

  it("adds the definition, the values and the heartbeat to an existing tenant, touching no other tenant", async () => {
    await seed(zero);
    await seed(other);
    const fresh = await propertyDefinition(zero);
    const events = await eventsDatabaseId(zero);
    const otherEvents = await eventsDatabaseId(other);
    const standup = await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const dentist = await createEvent(zero, events, { name: "Dentist", date: "2026-10-12" });
    const trashed = await createEvent(zero, events, { name: "Old", date: "2026-10-20", recurrence: WEEKDAYS });
    await runInTenant(zero, () => createChokePoint(data).softDeleteItem(events, trashed.id));
    const foreign = await createEvent(other, otherEvents, {
      name: "Standup",
      date: "2026-10-12",
      recurrence: WEEKDAYS,
    });
    await revertToOldShape(zero);
    expect(await propertyDefinition(zero)).toEqual([]);
    const foreignBefore = await itemRow(other, foreign.id);
    const standupBefore = await itemRow(zero, standup.id);

    await runAsSystem("test Events nextOccurrenceDate cutover", () => runTenantCutoverMigrations(data));

    expect(await propertyDefinition(zero)).toEqual(fresh);
    expect((await itemRow(zero, standup.id)).properties.nextOccurrenceDate).toBe("2026-10-19");
    expect((await itemRow(zero, dentist.id)).properties.nextOccurrenceDate).toBe("2026-10-12");
    expect((await itemRow(zero, trashed.id)).properties.nextOccurrenceDate).toBe("2026-10-20");
    // The value is system-derived: the version of an Event does not move, so a client's next write does not conflict.
    expect((await itemRow(zero, standup.id)).updated_at).toBe(standupBefore.updated_at);
    expect(await heartbeatCount(zero)).toBe(1);
    expect(await itemRow(other, foreign.id)).toEqual(foreignBefore);
    expect(await heartbeatCount(other)).toBe(1);
  });

  it("keeps a value an Event already has", async () => {
    await seed(zero);
    const events = await eventsDatabaseId(zero);
    const standup = await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    const dentist = await createEvent(zero, events, { name: "Dentist", date: "2026-10-12" });
    await revertToOldShape(zero);
    await admin.query(
      `UPDATE items SET properties = properties || '{"nextOccurrenceDate":"2026-12-24"}'::jsonb WHERE id = $1`,
      [standup.id],
    );

    await runInTenant(zero, () => runNextOccurrenceDateCutoverMigration(data));

    expect((await itemRow(zero, standup.id)).properties.nextOccurrenceDate).toBe("2026-12-24");
    expect((await itemRow(zero, dentist.id)).properties.nextOccurrenceDate).toBe("2026-10-12");
  });

  it("backfills more Events than one batch holds, and an Event without a day gets no value and ends no batch early", async () => {
    await seed(zero);
    const events = await eventsDatabaseId(zero);
    await revertToOldShape(zero);
    // Raw SQL, because 1,100 writes through the choke point would only make the test slow: two full batches of 500, a
    // partial third, and 5 Events without a `date` (the API refuses to create one) among them.
    await withTenantTransaction(admin, zero, (client) =>
      client.query(
        `INSERT INTO items (database_id, properties)
         SELECT $1, CASE WHEN n % 220 = 0 THEN jsonb_build_object('name', 'Undated ' || n)
                         ELSE jsonb_build_object('name', 'Event ' || n, 'date', '2026-10-12') END
           FROM generate_series(1, 1100) AS n`,
        [events],
      ),
    );

    await runInTenant(zero, () => runNextOccurrenceDateCutoverMigration(data));

    const { rows } = await admin.query<{ value: string | null; count: number }>(
      `SELECT properties->>'nextOccurrenceDate' AS value, count(*)::int AS count FROM items
        WHERE tenant_id = $1 AND database_id = $2 GROUP BY 1 ORDER BY 1`,
      [zero, events],
    );
    expect(rows).toEqual([
      { value: "2026-10-12", count: 1095 },
      { value: null, count: 5 },
    ]);
  });

  it("changes nothing when it runs a second time and creates one heartbeat only", async () => {
    await seed(zero);
    const events = await eventsDatabaseId(zero);
    const standup = await createEvent(zero, events, { name: "Standup", date: "2026-10-12", recurrence: WEEKDAYS });
    await revertToOldShape(zero);
    await runInTenant(zero, () => runNextOccurrenceDateCutoverMigration(data));
    const shape = await propertyDefinition(zero);
    const afterFirst = await itemRow(zero, standup.id);

    await runInTenant(zero, () => runNextOccurrenceDateCutoverMigration(data));

    expect(await propertyDefinition(zero)).toEqual(shape);
    expect(await itemRow(zero, standup.id)).toEqual(afterFirst);
    expect(await heartbeatCount(zero)).toBe(1);
  });

  it("creates no heartbeat when the tenant's calendar module has no system project", async () => {
    await seed(zero);
    await revertToOldShape(zero);
    // The project link of the Calendars database cannot be broken through the API, so it is cut with raw SQL.
    await admin.query(
      "UPDATE databases SET owner_project_item_id = NULL WHERE tenant_id = $1 AND owner_module_id = 'calendars'",
      [zero],
    );

    await runInTenant(zero, () => runNextOccurrenceDateCutoverMigration(data));

    expect(await heartbeatCount(zero)).toBe(0);
    expect(await propertyDefinition(zero)).toHaveLength(1);
  });

  it("is skipped for a tenant without an Events database", async () => {
    await runInTenant(other, () => runNextOccurrenceDateCutoverMigration(data));

    expect(await propertyDefinition(other)).toEqual([]);
    expect(await heartbeatCount(other)).toBe(0);
    const { rows } = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM databases WHERE tenant_id = $1",
      [other],
    );
    expect(rows[0]?.count).toBe(0);
  });
});
