import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { runEventsDateIncludeTimeContractCutoverMigration } from "../calendar/eventsDateIncludeTimeContractCutoverMigration.js";
import { createUser } from "../auth/usersStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let adminPool: Pool;
let dataPool: Pool;

/** The config the previous Events seed gave `date`, with one more key the cutover has to leave alone. */
const PREVIOUS_DATE_CONFIG = { includeTime: true, default: "today" };

const dateConfigRow = z.object({ config: z.record(z.string(), z.unknown()), version: z.string() });

async function tenantWithUser(): Promise<string> {
  const tenantId = await createTestTenant(adminPool);
  await createUser(adminPool, {
    tenantId,
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    locale: "cs",
  });
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  return tenantId;
}

/**
 * The stored config of the Events `date` property of a tenant and the row's `xmin`, which changes whenever the row is
 * written, so a run that rewrote the row with identical content is seen too.
 */
async function eventsDate(tenantId: string): Promise<{ config: Record<string, unknown>; version: string }> {
  const { rows } = await adminPool.query(
    `SELECT p.config, p.xmin::text AS version
       FROM properties p JOIN databases d ON d.id = p.database_id
      WHERE p.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key = 'date'`,
    [tenantId],
  );
  return dateConfigRow.parse(rows[0]);
}

/**
 * Turns a seeded tenant into one that was seeded before this issue: the Events `date` property gets the config the
 * previous seed wrote. The Events schema is locked, so the API cannot produce that state and the cutover is what
 * changes it.
 */
async function restorePreviousEventsDate(tenantId: string): Promise<void> {
  const result = await adminPool.query(
    `UPDATE properties p SET config = $2::jsonb
       FROM databases d
      WHERE d.id = p.database_id AND p.tenant_id = $1 AND d.owner_module_id = 'events' AND p.key = 'date'`,
    [tenantId, JSON.stringify(PREVIOUS_DATE_CONFIG)],
  );
  expect(result.rowCount).toBe(1);
}

const otherDateRow = z.object({ database: z.string(), key: z.string(), config: z.record(z.string(), z.unknown()) });

/** Every date property outside the Events database that declares `includeTime`, in a stable order. */
async function otherDatesWithIncludeTime(tenantId: string) {
  const { rows } = await adminPool.query(
    `SELECT d.owner_module_id AS database, p.key, p.config
       FROM properties p JOIN databases d ON d.id = p.database_id
      WHERE p.tenant_id = $1 AND p.type = 'date' AND p.config ? 'includeTime' AND d.owner_module_id <> 'events'
      ORDER BY d.owner_module_id, p.key`,
    [tenantId],
  );
  return z.array(otherDateRow).parse(rows);
}

describe("Events date includeTime contract cutover (issue gh-1971)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("seeds the Events date property of a new tenant without an includeTime key", async () => {
    const tenantId = await tenantWithUser();
    expect((await eventsDate(tenantId)).config).toEqual({});
  });

  it("keeps includeTime on the date properties of the other databases, in the seed and after the cutover", async () => {
    const tenantId = await tenantWithUser();
    const seeded = await otherDatesWithIncludeTime(tenantId);
    // Other databases (Tasks, Transcripts, Subscribed events, ...) keep declaring it; the Events one must not.
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.map((property) => property.database)).not.toContain("events");

    await restorePreviousEventsDate(tenantId);
    await runInTenant(tenantId, () => runEventsDateIncludeTimeContractCutoverMigration(dataPool));
    expect(await otherDatesWithIncludeTime(tenantId)).toEqual(seeded);
  });

  it("removes includeTime from an existing Events date property, keeps its other keys and changes nothing on a second run", async () => {
    const tenantId = await tenantWithUser();
    await restorePreviousEventsDate(tenantId);
    expect((await eventsDate(tenantId)).config).toEqual(PREVIOUS_DATE_CONFIG);

    await runInTenant(tenantId, () => runEventsDateIncludeTimeContractCutoverMigration(dataPool));
    const contracted = await eventsDate(tenantId);
    expect(contracted.config).toEqual({ default: "today" });

    await runInTenant(tenantId, () => runEventsDateIncludeTimeContractCutoverMigration(dataPool));
    expect(await eventsDate(tenantId)).toEqual(contracted);
  });

  it("does not write a database whose Events date property has no includeTime", async () => {
    const tenantId = await tenantWithUser();
    const seeded = await eventsDate(tenantId);

    await runInTenant(tenantId, () => runEventsDateIncludeTimeContractCutoverMigration(dataPool));
    expect(await eventsDate(tenantId)).toEqual(seeded);
  });

  it("does nothing and does not fail for a tenant without an Events database", async () => {
    const tenantId = await createTestTenant(adminPool);
    await expect(
      runInTenant(tenantId, () => runEventsDateIncludeTimeContractCutoverMigration(dataPool)),
    ).resolves.toBeUndefined();
    const { rows } = await adminPool.query<{ databases: string; properties: string }>(
      `SELECT (SELECT count(*) FROM databases WHERE tenant_id = $1)::text AS databases,
              (SELECT count(*) FROM properties WHERE tenant_id = $1)::text AS properties`,
      [tenantId],
    );
    expect(rows).toEqual([{ databases: "0", properties: "0" }]);
  });

  it("changes only the tenant it runs in", async () => {
    const first = await tenantWithUser();
    const second = await tenantWithUser();
    await restorePreviousEventsDate(first);
    await restorePreviousEventsDate(second);

    await runInTenant(first, () => runEventsDateIncludeTimeContractCutoverMigration(dataPool));
    expect((await eventsDate(first)).config).toEqual({ default: "today" });
    expect((await eventsDate(second)).config).toEqual(PREVIOUS_DATE_CONFIG);
  });

  it("runs through runTenantCutoverMigrations for a suspended tenant", async () => {
    const tenantId = await tenantWithUser();
    await restorePreviousEventsDate(tenantId);
    await adminPool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantId]);

    await runTenantCutoverMigrations(dataPool);
    expect((await eventsDate(tenantId)).config).toEqual({ default: "today" });
  });
});
