import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { runJournalEventsCutoverMigration } from "../journal/journalEventsCutoverMigration.js";
import { JOURNAL_EVENT_LINKS_OWNER_PROCESS } from "../journal/journalOwnerProcesses.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { KNOWN_OWNER_PROCESS_IDS } from "../manifest/knownActionIds.js";
import { findOrphanedOwnerProcessIds } from "../manifest/moduleRegistryDriftCheck.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let journal: string;
let events: string;

async function eventsProperty(tenantId: string) {
  return runInTenant(tenantId, async () =>
    (await createChokePoint(pool).listProperties(journal)).find((p) => p.key === "events"),
  );
}

async function relationDefinitionOf(propertyId: string) {
  const { rows } = await runInTenant(tenant, () =>
    pool.query<{ cardinality: string; property_id_b: string | null }>(
      "SELECT cardinality, property_id_b FROM relation_definitions WHERE property_id_a = $1",
      [propertyId],
    ),
  );
  return rows;
}

const expectedShape = () => ({
  type: "relation",
  owner: "system",
  ownerProcess: JOURNAL_EVENT_LINKS_OWNER_PROCESS,
  name: null,
  config: { targetDatabaseId: events },
});

describe("Journal events relation (issue #1609)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    const { rows } = await runInTenant(tenant, () =>
      pool.query<{ id: string; owner_module_id: string }>(
        "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
        [["journal", "events"]],
      ),
    );
    journal = rows.find((r) => r.owner_module_id === "journal")!.id;
    events = rows.find((r) => r.owner_module_id === "events")!.id;
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("is seeded on a fresh tenant as a system-owned, one-directional many-to-many relation to Events", async () => {
    const property = await eventsProperty(tenant);
    expect(property).toMatchObject(expectedShape());
    expect(await relationDefinitionOf(property!.id)).toEqual([{ cardinality: "many_to_many", property_id_b: null }]);
  });

  it("is added by the cutover to a populated tenant that lacks it, and a second run changes nothing", async () => {
    const day = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, journal, "day", new Date("2026-10-16T10:00:00Z"), "Europe/Prague"),
      ),
    );
    const seeded = await eventsProperty(tenant);
    // A tenant seeded before issue #1609: a locked Journal schema cannot lose a property through the public writer.
    await runInTenant(tenant, async () => {
      const removed = await pool.query("DELETE FROM properties WHERE id = $1", [seeded!.id]);
      expect(removed.rowCount).toBe(1);
      await pool.query("DELETE FROM relation_definitions WHERE property_id_a = $1", [seeded!.id]);
    });
    expect(await eventsProperty(tenant)).toBeUndefined();
    const dayBefore = await runInTenant(tenant, () => createChokePoint(pool).getItem(journal, day.id));

    await runAsSystem("test:journal-events", () => runTenantCutoverMigrations(pool));
    const migrated = await eventsProperty(tenant);
    expect(migrated).toMatchObject(expectedShape());
    expect(await relationDefinitionOf(migrated!.id)).toEqual([{ cardinality: "many_to_many", property_id_b: null }]);
    expect(await runInTenant(tenant, () => createChokePoint(pool).getItem(journal, day.id))).toEqual(dayBefore);

    const snapshot = async () =>
      (
        await admin.query<{ row: unknown }>(
          "SELECT to_jsonb(p) AS row FROM properties p WHERE database_id = $1 ORDER BY id",
          [journal],
        )
      ).rows;
    const before = await snapshot();
    await runAsSystem("test:journal-events-replay", () => runTenantCutoverMigrations(pool));
    expect(await snapshot()).toEqual(before);
    expect(await eventsProperty(tenant)).toEqual(migrated);
  });

  for (const [present, missing] of [
    ["journal", "Events"],
    ["events", "Journal"],
  ] as const) {
    it(`leaves a tenant without ${missing} unchanged`, async () => {
      const bare = await createTestTenant(admin);
      const database = await runInTenant(bare, () => createChokePoint(pool).createDatabase({ name: present }));
      // A tenant with only one of the two databases: no writer creates a system database on its own.
      await runInTenant(bare, async () => {
        const marked = await pool.query("UPDATE databases SET owner_module_id = $2 WHERE id = $1", [
          database.id,
          present,
        ]);
        expect(marked.rowCount).toBe(1);
      });
      const state = () =>
        runInTenant(bare, async () => ({
          properties: (
            await pool.query<{ id: string; database_id: string; key: string; config: unknown }>(
              "SELECT id, database_id, key, config FROM properties ORDER BY id",
            )
          ).rows,
          definitions: (await pool.query<{ id: string }>("SELECT id FROM relation_definitions ORDER BY id")).rows,
        }));
      const before = await state();
      expect(before.properties.some((property) => property.key === "events")).toBe(false);
      await runInTenant(bare, () => runJournalEventsCutoverMigration(pool));
      expect(await state()).toEqual(before);
    });
  }

  it("refuses the generic relation endpoint with 403 owner_violation and lets the journalEventLinks process link a day", async () => {
    const cp = createChokePoint(pool);
    const property = await eventsProperty(tenant);
    const { day, event } = await runInTenant(tenant, async () => ({
      day: await withTransaction(pool, (client) =>
        getOrCreateJournalItem(client, journal, "day", new Date("2026-10-16T10:00:00Z"), "Europe/Prague"),
      ),
      event: await cp.createItem({ databaseId: events, properties: { name: "Standup", date: "2026-10-16" } }),
    }));
    const input = { relationPropertyId: property!.id, callerItemId: day.id, targetItemId: event.id };

    await expect(runInTenant(tenant, () => cp.createRelation(input))).rejects.toMatchObject({
      status: 403,
      code: "owner_violation",
    });
    await expect(
      runInTenant(tenant, () =>
        withTransaction(pool, (client) => createRelationWithClient(client, input, { ownerProcess: "inbox" })),
      ),
    ).rejects.toMatchObject({ status: 403, code: "owner_violation" });
    expect(await runInTenant(tenant, () => cp.listItemRelations(day.id, property!.id))).toEqual([]);

    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        createRelationWithClient(client, input, { ownerProcess: JOURNAL_EVENT_LINKS_OWNER_PROCESS }),
      ),
    );
    const linked = await runInTenant(tenant, () => cp.listItemRelations(day.id, property!.id));
    expect(linked?.map((edge) => edge.targetItemId)).toEqual([event.id]);

    await expect(runInTenant(tenant, () => cp.deleteRelation(input))).rejects.toMatchObject({
      status: 403,
      code: "owner_violation",
    });
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        deleteRelationWithClient(client, input, { ownerProcess: JOURNAL_EVENT_LINKS_OWNER_PROCESS }),
      ),
    );
    expect(await runInTenant(tenant, () => cp.listItemRelations(day.id, property!.id))).toEqual([]);
  });

  it("is owned by a process the module registry drift check knows", async () => {
    const orphaned = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => ({
        known: await findOrphanedOwnerProcessIds(client, KNOWN_OWNER_PROCESS_IDS),
        withoutIt: await findOrphanedOwnerProcessIds(
          client,
          new Set([...KNOWN_OWNER_PROCESS_IDS].filter((id) => id !== JOURNAL_EVENT_LINKS_OWNER_PROCESS)),
        ),
      })),
    );
    expect(orphaned.known).not.toContain(JOURNAL_EVENT_LINKS_OWNER_PROCESS);
    expect(orphaned.withoutIt).toContain(JOURNAL_EVENT_LINKS_OWNER_PROCESS);
  });

  it("labels the relation 'Události' in Czech and 'Events' in English", async () => {
    const registry = await loadFullModuleRegistry();
    for (const [locale, name] of [
      ["cs", "Události"],
      ["en", "Events"],
    ] as const) {
      const schema = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => generateSchemaProjection(client, registry, { locale })),
      );
      expect(
        schema.databases.find((db) => db.key === "journal")?.properties.find((p) => p.key === "events")?.name,
      ).toBe(name);
    }
  });
});
