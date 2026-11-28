import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@alldots/shared";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../../db/pool.js";
import { createDriftCheckAction } from "../../manifest/driftCheck.js";
import { KNOWN_OWNER_PROCESS_IDS } from "../../manifest/knownActionIds.js";
import { CALENDARS_MODULE_ID } from "../../seed/calendarsKeys.js";
import { INVITATIONS_MODULE_ID } from "../../seed/invitationsKeys.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { CALENDAR_MODULE_ID } from "../calendarModuleId.js";

let adminPool: Pool;
let dataPool: Pool;

const USER = { writerKind: "user" } as const;

const STATUS_OPTIONS = ["pending", "accepted", "tentative", "declined", "acknowledged", "cancelled"];
const KIND_OPTIONS = ["invite", "sharedCalendarNotice"];

/** Every property of the database in key order: `[key, type, config]`; all are system-owned by the calendar module. */
const EXPECTED_PROPERTIES: ReadonlyArray<readonly [string, string, unknown]> = [
  ["allDay", "checkbox", {}],
  ["endsAt", "date", { includeTime: true }],
  ["kind", "select", { options: KIND_OPTIONS.map((key) => ({ key })) }],
  ["organizerEmail", "text", {}],
  ["organizerName", "text", {}],
  ["place", "text", {}],
  ["respondedAt", "date", { includeTime: true }],
  ["sequence", "number", {}],
  ["startsAt", "date", { includeTime: true }],
  ["status", "select", { options: STATUS_OPTIONS.map((key) => ({ key })) }],
  ["timeZone", "text", {}],
  ["title", "title", {}],
  ["uid", "text", {}],
];

const EXPECTED_RELATIONS: ReadonlyArray<readonly [string, string]> = [
  ["event", "events"],
  ["mailbox", "mailboxes"],
  ["sourceEmail", "emails"],
  ["suggestedCalendar", CALENDARS_MODULE_ID],
];

const propertyRows = z.array(
  z.object({
    key: z.string(),
    type: z.string(),
    owner: z.string(),
    owner_process: z.string().nullable(),
    config: z.record(z.string(), z.unknown()),
  }),
);
const relationRows = z.array(
  z.object({
    key: z.string(),
    cardinality: z.string(),
    has_inverse: z.boolean(),
    target: z.string().nullable(),
    owner: z.string(),
    owner_process: z.string().nullable(),
  }),
);
const databaseRows = z.array(
  z.object({
    id: z.string(),
    name: z.string().nullable(),
    key: z.string().nullable(),
    system: z.boolean(),
    schema_locked: z.boolean(),
    owner_module_id: z.string().nullable(),
    owner_project_item_id: z.string().nullable(),
  }),
);
const countRows = z.array(z.object({ count: z.number() }));
const itemRow = z.object({ id: z.string(), properties: z.record(z.string(), z.unknown()) });

async function seedTenant(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
}

/** The tenant's database of a module, read on the admin pool, which bypasses row-level security, so the tenant is named. */
async function databaseOf(tenantId: string, moduleId: string) {
  const { rows } = await adminPool.query(
    `SELECT id, name, key, system, schema_locked, owner_module_id, owner_project_item_id
       FROM databases WHERE tenant_id = $1 AND owner_module_id = $2`,
    [tenantId, moduleId],
  );
  return databaseRows.parse(rows)[0] ?? null;
}

async function requireDatabase(tenantId: string, moduleId: string) {
  const database = await databaseOf(tenantId, moduleId);
  if (!database) throw new Error(`The tenant has no ${moduleId} database`);
  return database;
}

async function propertiesOf(databaseId: string) {
  const { rows } = await adminPool.query(
    `SELECT key, type, owner, owner_process, config FROM properties
      WHERE database_id = $1 AND type <> 'relation' ORDER BY key`,
    [databaseId],
  );
  return propertyRows.parse(rows);
}

async function relationsOf(databaseId: string) {
  const { rows } = await adminPool.query(
    `SELECT p.key, r.cardinality, r.property_id_b IS NOT NULL AS has_inverse, target.owner_module_id AS target,
            p.owner, p.owner_process
       FROM properties p
       JOIN relation_definitions r ON r.id = (p.config->>'relationDefinitionId')::uuid
       LEFT JOIN databases target ON target.id = (p.config->>'targetDatabaseId')::uuid
      WHERE p.database_id = $1 AND p.type = 'relation' ORDER BY p.key`,
    [databaseId],
  );
  return relationRows.parse(rows);
}

/** The calendar module's system writer of an invitation row, a row no public path can create. */
async function createInvitation(tenantId: string, properties: Record<string, unknown> = {}) {
  const database = await requireDatabase(tenantId, INVITATIONS_MODULE_ID);
  const row = await runInTenant(tenantId, () =>
    withTransaction(dataPool, (client) =>
      createItemWithClient(
        client,
        {
          databaseId: database.id,
          properties: { title: "Team sync", status: "pending", kind: "invite", sequence: 0, ...properties },
        },
        { allowedSystemKeys: ["title", "status", "kind", "sequence", "uid"], systemOwnerProcess: CALENDAR_MODULE_ID },
      ),
    ),
  );
  return { databaseId: database.id, itemId: row.id };
}

describe("invitations system database (issue gh-1901)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "alldots_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("seeds a new tenant with the invitations database, its properties, types and owners, and a locked schema", async () => {
    const tenantId = getTenantZeroId();
    await seedTenant(tenantId);

    const database = await requireDatabase(tenantId, INVITATIONS_MODULE_ID);
    const calendars = await requireDatabase(tenantId, CALENDARS_MODULE_ID);
    expect(database).toMatchObject({
      name: null,
      key: INVITATIONS_MODULE_ID,
      system: true,
      schema_locked: true,
      owner_module_id: INVITATIONS_MODULE_ID,
    });
    expect(calendars.owner_project_item_id).not.toBeNull();
    expect(database.owner_project_item_id).toBe(calendars.owner_project_item_id);

    expect(await propertiesOf(database.id)).toEqual(
      EXPECTED_PROPERTIES.map(([key, type, config]) => ({
        key,
        type,
        owner: "system",
        owner_process: CALENDAR_MODULE_ID,
        config,
      })),
    );
    const items = await adminPool.query("SELECT 1 FROM items WHERE database_id = $1", [database.id]);
    expect(items.rowCount).toBe(0);
  });

  it("declares the four relations system-owned, many-to-many and one-directional, each to a locked database", async () => {
    const tenantId = getTenantZeroId();
    await seedTenant(tenantId);
    const database = await requireDatabase(tenantId, INVITATIONS_MODULE_ID);

    expect(await relationsOf(database.id)).toEqual(
      EXPECTED_RELATIONS.map(([key, target]) => ({
        key,
        cardinality: "many_to_many",
        has_inverse: false,
        target,
        owner: "system",
        owner_process: CALENDAR_MODULE_ID,
      })),
    );
    // One-directional: the locked target schemas gained no property.
    const { rows } = await adminPool.query(
      `SELECT count(*)::int AS count FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.tenant_id = $1 AND p.type = 'relation' AND p.config->>'targetDatabaseId' = $2`,
      [tenantId, database.id],
    );
    expect(countRows.parse(rows)).toEqual([{ count: 0 }]);
  });

  it.each(["status", "title", "startsAt"])(
    "answers a generic write of %s with 403 and leaves the invitation unchanged",
    async (key) => {
      const tenantId = getTenantZeroId();
      await seedTenant(tenantId);
      // The calendar module's own writer is the allowed side of the permission: it creates the row.
      const { databaseId, itemId } = await createInvitation(tenantId);
      const chokePoint = createChokePoint(dataPool);
      await runInTenant(tenantId, async () => {
        await expect(
          chokePoint.updateItem(
            { databaseId, itemId, propertiesPatch: { [key]: "accepted" } },
            undefined,
            undefined,
            USER,
          ),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation", details: { field: key } });
        await expect(
          chokePoint.createItem({ databaseId, properties: { [key]: "accepted" } }, undefined, undefined, USER),
        ).rejects.toMatchObject({ status: 403, code: "owner_violation", details: { field: key } });
      });
      const { rows } = await adminPool.query("SELECT id, properties FROM items WHERE database_id = $1", [databaseId]);
      const stored = z.array(itemRow).parse(rows);
      expect(stored.map((row) => row.id)).toEqual([itemId]);
      expect(stored[0]?.properties).toEqual({ title: "Team sync", status: "pending", kind: "invite", sequence: 0 });
    },
  );

  it("shows no invitation of one tenant to a user of another tenant", async () => {
    const owner = getTenantZeroId();
    const other = await createTestTenant(adminPool);
    await seedTenant(owner);
    await seedTenant(other);
    const { databaseId, itemId } = await createInvitation(owner);
    const otherInvitation = await createInvitation(other, { title: "Other sync" });
    expect(otherInvitation.databaseId).not.toBe(databaseId);

    const chokePoint = createChokePoint(dataPool);
    await runInTenant(other, async () => {
      expect((await chokePoint.listItems(databaseId, { limit: 50 })).items).toEqual([]);
      expect(await chokePoint.getItem(databaseId, itemId)).toBeNull();
      expect(
        (await chokePoint.listItems(otherInvitation.databaseId, { limit: 50 })).items.map((row) => row.id),
      ).toEqual([otherInvitation.itemId]);
    });
    await runInTenant(owner, async () => {
      expect((await chokePoint.listItems(databaseId, { limit: 50 })).items.map((row) => row.id)).toEqual([itemId]);
      expect(await chokePoint.getItem(otherInvitation.databaseId, otherInvitation.itemId)).toBeNull();
    });
  });

  describe("core.driftCheck", () => {
    async function driftFindings(tenantId: string, activeProcessIds: ReadonlySet<string>) {
      const calendars = await requireDatabase(tenantId, CALENDARS_MODULE_ID);
      const projectItemId = calendars.owner_project_item_id;
      if (!projectItemId) throw new Error("The calendars database has no project");
      await runInTenant(tenantId, () =>
        createDriftCheckAction(dataPool, { activeProcessIds })({}, { heartbeatId: "test", projectItemId }),
      );
      const { rows } = await adminPool.query("SELECT payload FROM manifest_drift_findings WHERE tenant_id = $1", [
        tenantId,
      ]);
      const payload = z.object({
        orphanedOwnerProcess: z.array(z.object({ databaseId: z.string(), key: z.string() })),
      });
      return rows.flatMap((row) => payload.parse(row.payload).orphanedOwnerProcess);
    }

    it("reports no orphan property of the invitations database when the calendar module is a known owner process", async () => {
      const tenantId = getTenantZeroId();
      await seedTenant(tenantId);
      const database = await requireDatabase(tenantId, INVITATIONS_MODULE_ID);
      const findings = await driftFindings(tenantId, KNOWN_OWNER_PROCESS_IDS);
      expect(findings.filter((row) => row.databaseId === database.id)).toEqual([]);
    });

    it("reports every property of the database as an orphan when the calendar module is not a known owner process", async () => {
      const tenantId = getTenantZeroId();
      await seedTenant(tenantId);
      const database = await requireDatabase(tenantId, INVITATIONS_MODULE_ID);
      const withoutCalendar = new Set([...KNOWN_OWNER_PROCESS_IDS].filter((id) => id !== CALENDAR_MODULE_ID));
      const orphans = (await driftFindings(tenantId, withoutCalendar)).filter((row) => row.databaseId === database.id);
      expect(orphans.map((row) => row.key).sort()).toEqual(
        [...EXPECTED_PROPERTIES.map(([key]) => key), ...EXPECTED_RELATIONS.map(([key]) => key)].sort(),
      );
    });
  });
});
