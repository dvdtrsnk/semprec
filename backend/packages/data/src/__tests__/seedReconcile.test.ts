import "../domainWriteHooks.js";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyCalendarSync } from "../calendar/sync/calendarSyncApply.js";
import { resolveCalendarSyncIds } from "../calendar/sync/calendarSyncStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createPool, withTransaction } from "../db/pool.js";
import { formatSeedLines, runSeed, seedExitCode, type SeedResult } from "../db/runSeed.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import type { SeedAppendedOptions, SeedConflict } from "../seed/seedReconcile.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let adminPool: Pool;
let pool: Pool;

/** What the seed of v0.1.12 lacks against this one, plus a second relation pair. */
const OLDER_SEED_GAP: ReadonlyArray<readonly [string, readonly string[]]> = [
  [MAILBOXES_MODULE_ID, ["mailEnabled", "calendarsEnabled", "calendars"]],
  [CALENDARS_MODULE_ID, ["account", "readOnly", "remoteColor", "remoteName", "subscribedEvents"]],
  [EVENTS_MODULE_ID, ["exceptionDates", "recurrenceId", "recurrenceRule", "timeZone"]],
  [SUBSCRIBED_EVENTS_MODULE_ID, ["calendar"]],
];
const GAP_PROPERTIES = OLDER_SEED_GAP.reduce((sum, [, keys]) => sum + keys.length, 0);
/** `mailboxes.calendars`/`calendars.account` and `calendars.subscribedEvents`/`subscribedEvents.calendar`. */
const GAP_RELATIONS = 2;
/** The `calendars.kind` options of v0.1.12; the current seed appends `account`. */
const OLDER_CALENDAR_KINDS = '{"options":[{"key":"own"},{"key":"system"},{"key":"subscription"}]}';
const CURRENT_CALENDAR_KINDS = '{"options":[{"key":"own"},{"key":"system"},{"key":"subscription"},{"key":"account"}]}';
const APPENDED_ACCOUNT_KIND: SeedAppendedOptions = { database: CALENDARS_MODULE_ID, key: "kind", options: ["account"] };

interface DefinitionRow {
  id: string;
  database_id: string;
  database: string;
  key: string;
  name: string | null;
  type: string;
  config: unknown;
  locked: boolean;
  owner: string;
  owner_process: string | null;
  initial_position: number | null;
}

/**
 * The tenant's system property and relation definitions with every id replaced by what it names, so two tenants
 * compare equal exactly when their definitions do.
 */
async function systemDefinitions(tenantId: string): Promise<{ properties: string[]; relations: string[] }> {
  const databases = await adminPool.query<{ id: string; owner_module_id: string }>(
    "SELECT id, owner_module_id FROM databases WHERE tenant_id = $1 AND system",
    [tenantId],
  );
  const properties = await adminPool.query<DefinitionRow>(
    `SELECT p.id, p.database_id, d.owner_module_id AS database, p.key, p.name, p.type, p.config, p.locked, p.owner,
            p.owner_process, p.initial_position
       FROM properties p JOIN databases d ON d.id = p.database_id
      WHERE p.tenant_id = $1 AND d.system`,
    [tenantId],
  );
  const relations = await adminPool.query<{
    id: string;
    property_id_a: string;
    property_id_b: string | null;
    cardinality: string;
  }>("SELECT id, property_id_a, property_id_b, cardinality FROM relation_definitions WHERE tenant_id = $1", [tenantId]);
  const names = new Map<string, string>();
  for (const row of databases.rows) names.set(row.id, `database:${row.owner_module_id}`);
  for (const row of properties.rows) names.set(row.id, `property:${row.database}.${row.key}`);
  for (const row of relations.rows) names.set(row.id, `relation:${names.get(row.property_id_a) ?? "?"}`);
  const symbolic = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? `unknown:${id}`));
  const rename = (value: unknown): unknown => {
    if (typeof value === "string") return names.get(value) ?? value;
    if (Array.isArray(value)) return value.map(rename);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [names.get(key) ?? key, rename(child)]));
    }
    return value;
  };
  return {
    properties: properties.rows
      .map(({ id: _id, database_id: _databaseId, config, ...row }) =>
        JSON.stringify({ ...row, config: rename(config) }),
      )
      .sort(),
    relations: relations.rows
      .map((row) => JSON.stringify([symbolic(row.property_id_a), symbolic(row.property_id_b), row.cardinality]))
      .sort(),
  };
}

/** Rows with their ids, to show that nothing existing was rewritten. */
async function definitionRows(tenantId: string): Promise<unknown[]> {
  const { rows } = await adminPool.query<{ row: unknown }>(
    `SELECT to_jsonb(p) AS row FROM properties p WHERE tenant_id = $1
     UNION ALL SELECT to_jsonb(r) FROM relation_definitions r WHERE tenant_id = $1
     ORDER BY 1`,
    [tenantId],
  );
  return rows.map((entry) => entry.row);
}

async function itemRows(tenantId: string): Promise<unknown[]> {
  const { rows } = await adminPool.query<{ row: unknown }>(
    `SELECT to_jsonb(i) AS row FROM items i WHERE tenant_id = $1
     UNION ALL SELECT to_jsonb(r) FROM item_relations r WHERE tenant_id = $1
     ORDER BY 1`,
    [tenantId],
  );
  return rows.map((entry) => entry.row);
}

/** Raw SQL: no API may change the config of a locked system property; sets the carried `calendars.kind` config. */
async function setCalendarKindConfig(tenantId: string, config: string): Promise<void> {
  const result = await adminPool.query(
    `UPDATE properties p SET config = $3::jsonb FROM databases d
      WHERE d.id = p.database_id AND p.tenant_id = $1 AND d.owner_module_id = $2 AND p.key = 'kind'`,
    [tenantId, CALENDARS_MODULE_ID, config],
  );
  expect(result.rowCount).toBe(1);
}

async function calendarKindOptions(tenantId: string): Promise<unknown> {
  const { rows } = await adminPool.query<{ options: unknown }>(
    `SELECT p.config->'options' AS options FROM properties p JOIN databases d ON d.id = p.database_id
      WHERE p.tenant_id = $1 AND d.owner_module_id = $2 AND p.key = 'kind'`,
    [tenantId, CALENDARS_MODULE_ID],
  );
  return rows[0]?.options;
}

/** Raw SQL: no API removes a property of a locked system database, which is exactly what an older seed looks like. */
async function removeOlderSeedGap(tenantId: string): Promise<void> {
  for (const [moduleId, keys] of OLDER_SEED_GAP) {
    const result = await adminPool.query(
      `DELETE FROM properties p USING databases d
        WHERE d.id = p.database_id AND p.tenant_id = $1 AND d.system AND d.owner_module_id = $2 AND p.key = ANY($3)`,
      [tenantId, moduleId, keys],
    );
    expect(result.rowCount).toBe(keys.length);
  }
  await setCalendarKindConfig(tenantId, OLDER_CALENDAR_KINDS);
}

/** One calendar sync apply of a new account with Calendars on that lists one remote calendar. */
async function syncOneAccountCalendar(tenantId: string): Promise<void> {
  await runInTenant(tenantId, async () => {
    const { ids, account } = await withTransaction(pool, async (client) => {
      const resolved = await resolveCalendarSyncIds(client);
      if (!resolved) throw new Error("No calendar databases");
      const created = await createItemWithClient(client, {
        databaseId: resolved.mailboxesDatabaseId,
        properties: { name: "Work account", provider: "generic", calendarsEnabled: true },
      });
      return { ids: resolved, account: created };
    });
    const result = await applyCalendarSync(pool, {
      accountItemId: account.id,
      ids,
      tracked: [],
      fetched: [
        {
          calendar: { remoteId: "work", url: null, name: "Work", color: null, readOnly: false, ctag: null },
          changes: { full: true, upserts: [], deletions: [], nextSyncState: { syncToken: null, ctag: null } },
        },
      ],
      window: { start: "2026-01-01", end: "2027-12-31" },
      guardWaitMs: 5_000,
    });
    expect(result.kind).toBe("applied");
  });
}

async function accountCalendarCount(tenantId: string): Promise<number> {
  const { rows } = await adminPool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM items i JOIN databases d ON d.id = i.database_id
      WHERE i.tenant_id = $1 AND d.owner_module_id = $2 AND i.properties->>'kind' = 'account'`,
    [tenantId, CALENDARS_MODULE_ID],
  );
  return rows[0]?.count ?? 0;
}

/** Items with values in the databases the reconcile adds to, written through the choke point. */
async function writeItems(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const database = async (moduleId: string) => {
        const row = await getDatabaseByModuleId(client, moduleId);
        if (!row) throw new Error(`Missing ${moduleId}`);
        return row.id;
      };
      await createItemWithClient(client, {
        databaseId: await database(MAILBOXES_MODULE_ID),
        properties: { name: "Family account", provider: "generic" },
      });
      await createItemWithClient(client, {
        databaseId: await database(EVENTS_MODULE_ID),
        properties: { name: "Dinner", date: "2026-11-20" },
      });
    }),
  );
}

function resultFor(results: readonly SeedResult[], tenantId: string): SeedResult {
  const result = results.find((candidate) => candidate.tenantId === tenantId);
  if (!result) throw new Error(`No seed result for ${tenantId}`);
  return result;
}

/** Tenants seeded by the current seed, then given the shape of the older one, with items written before. */
async function olderSeededTenants(count: number): Promise<string[]> {
  const tenantIds: string[] = [];
  for (let index = 0; index < count; index++) tenantIds.push(await createTestTenant(adminPool));
  await runSeed(pool);
  for (const tenantId of tenantIds) {
    await writeItems(tenantId);
    await removeOlderSeedGap(tenantId);
  }
  return tenantIds;
}

async function olderSeededTenant(): Promise<string> {
  const [tenantId] = await olderSeededTenants(1);
  if (!tenantId) throw new Error("No tenant created");
  return tenantId;
}

describe("seed reconcile of already seeded tenants", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    pool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  it("gives a tenant of an older seed the fresh seed's definitions and leaves its items unchanged", async () => {
    const older = await olderSeededTenant();
    const itemsBefore = await itemRows(older);
    const fresh = await createTestTenant(adminPool);

    const results = await runSeed(pool);

    expect(resultFor(results, fresh)).toEqual({ tenantId: fresh, outcome: "created", reconcile: null });
    expect(resultFor(results, older)).toEqual({
      tenantId: older,
      outcome: "already-provisioned",
      reconcile: {
        createdProperties: GAP_PROPERTIES,
        createdRelationDefinitions: GAP_RELATIONS,
        appendedOptions: [APPENDED_ACCOUNT_KIND],
        conflicts: [],
      },
    });
    expect(resultFor(results, getTenantZeroId()).reconcile).toEqual({
      createdProperties: 0,
      createdRelationDefinitions: 0,
      appendedOptions: [],
      conflicts: [],
    });
    expect(await systemDefinitions(older)).toEqual(await systemDefinitions(fresh));
    expect(await itemRows(older)).toEqual(itemsBefore);
    expect(formatSeedLines(resultFor(results, older))).toEqual([
      `seed: tenant ${older} already seeded`,
      `seed: tenant ${older} reconcile created ${GAP_PROPERTIES} properties, ${GAP_RELATIONS} relation definitions, appended 1 select options`,
      `seed: tenant ${older} appended options ${CALENDARS_MODULE_ID}.kind account`,
    ]);
    expect(seedExitCode(results, true)).toBe(0);
  });

  it("creates nothing when it runs again", async () => {
    const older = await olderSeededTenant();
    await runSeed(pool);
    const before = await definitionRows(older);

    const results = await runSeed(pool);

    expect(resultFor(results, older).reconcile).toEqual({
      createdProperties: 0,
      createdRelationDefinitions: 0,
      appendedOptions: [],
      conflicts: [],
    });
    expect(await definitionRows(older)).toEqual(before);
  });

  it("appends the `account` kind to a carried `calendars.kind`, after which the calendar sync creates an account calendar", async () => {
    const tenantId = await createTestTenant(adminPool);
    await runSeed(pool);
    await setCalendarKindConfig(tenantId, OLDER_CALENDAR_KINDS);

    const results = await runSeed(pool);

    expect(resultFor(results, tenantId).reconcile?.appendedOptions).toEqual([APPENDED_ACCOUNT_KIND]);
    expect(await calendarKindOptions(tenantId)).toEqual([
      { key: "own" },
      { key: "system" },
      { key: "subscription" },
      { key: "account" },
    ]);
    await syncOneAccountCalendar(tenantId);
    expect(await accountCalendarCount(tenantId)).toBe(1);
  });

  it("appends the missing options after the tenant's own, keeps an option the seed lacks and reports it", async () => {
    const older = await olderSeededTenant();
    await setCalendarKindConfig(
      older,
      '{"options":[{"key":"subscription"},{"key":"legacy","label":"Legacy"},{"key":"own"},{"key":"system"}]}',
    );

    const results = await runSeed(pool);

    expect(resultFor(results, older).reconcile).toEqual({
      createdProperties: GAP_PROPERTIES,
      createdRelationDefinitions: GAP_RELATIONS,
      appendedOptions: [APPENDED_ACCOUNT_KIND],
      conflicts: [{ tag: "config", database: CALENDARS_MODULE_ID, key: "kind" }],
    });
    const options = [
      { key: "subscription" },
      { key: "legacy", label: "Legacy" },
      { key: "own" },
      { key: "system" },
      { key: "account" },
    ];
    expect(await calendarKindOptions(older)).toEqual(options);

    const again = await runSeed(pool);

    expect(resultFor(again, older).reconcile?.appendedOptions).toEqual([]);
    expect(await calendarKindOptions(older)).toEqual(options);
  });

  /** Raw SQL: these are carried definitions no API may produce on a locked system database. */
  it.each<{ name: string; sql: string; params: unknown[]; conflict: SeedConflict }>([
    {
      name: "another type",
      sql: `UPDATE properties p SET type = 'text' FROM databases d
             WHERE d.id = p.database_id AND p.tenant_id = $1 AND d.owner_module_id = $2 AND p.key = 'notify'`,
      params: [CALENDARS_MODULE_ID],
      conflict: { tag: "type", database: CALENDARS_MODULE_ID, key: "notify" },
    },
    {
      name: "another owner",
      sql: `UPDATE properties p SET owner = 'user', owner_process = NULL FROM databases d
             WHERE d.id = p.database_id AND p.tenant_id = $1 AND d.owner_module_id = $2 AND p.key = 'systemKey'`,
      params: [CALENDARS_MODULE_ID],
      conflict: { tag: "owner", database: CALENDARS_MODULE_ID, key: "systemKey" },
    },
    {
      name: "another config",
      sql: `UPDATE properties p SET config = config || '{"default":"own"}'::jsonb FROM databases d
             WHERE d.id = p.database_id AND p.tenant_id = $1 AND d.owner_module_id = $2 AND p.key = 'kind'`,
      params: [CALENDARS_MODULE_ID],
      conflict: { tag: "config", database: CALENDARS_MODULE_ID, key: "kind" },
    },
    {
      name: "another label of an existing select option besides a missing one",
      sql: `UPDATE properties p
               SET config = '{"options":[{"key":"own","label":"Mine"},{"key":"system"},{"key":"subscription"}]}'::jsonb
              FROM databases d
             WHERE d.id = p.database_id AND p.tenant_id = $1 AND d.owner_module_id = $2 AND p.key = 'kind'`,
      params: [CALENDARS_MODULE_ID],
      conflict: { tag: "config", database: CALENDARS_MODULE_ID, key: "kind" },
    },
    {
      name: "another relation cardinality",
      sql: `UPDATE relation_definitions r SET cardinality = 'many_to_many' FROM properties p, databases d
             WHERE p.id = r.property_id_a AND d.id = p.database_id AND r.tenant_id = $1 AND d.owner_module_id = $2
               AND p.key = 'events'`,
      params: [CALENDARS_MODULE_ID],
      conflict: { tag: "relation", database: CALENDARS_MODULE_ID, key: "events" },
    },
  ])("reports a carried definition with $name, leaves it unchanged and fails only with --strict", async (row) => {
    const older = await olderSeededTenant();
    await setCalendarKindConfig(older, CURRENT_CALENDAR_KINDS);
    const changed = await adminPool.query(row.sql, [older, ...row.params]);
    expect(changed.rowCount).toBe(1);
    const before = await definitionRows(older);

    const results = await runSeed(pool);

    expect(resultFor(results, older).reconcile).toEqual({
      createdProperties: GAP_PROPERTIES,
      createdRelationDefinitions: GAP_RELATIONS,
      appendedOptions: [],
      conflicts: [row.conflict],
    });
    const after = await definitionRows(older);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after).toHaveLength(before.length + GAP_PROPERTIES + GAP_RELATIONS);
    expect(seedExitCode(results, true)).toBe(1);
    expect(seedExitCode(results, false)).toBe(0);
  });

  it("rolls back only the failing tenant and reports it", async () => {
    const [failing, passing] = await olderSeededTenants(2);
    if (!failing || !passing) throw new Error("No tenants created");
    const failingBefore = await definitionRows(failing);
    // Test-only DDL: a relation definition insert that fails for one tenant, after its properties were inserted.
    await adminPool.query("CREATE TABLE seed_reconcile_failing_tenants (tenant_id uuid PRIMARY KEY)");
    try {
      await adminPool.query(`
        CREATE FUNCTION seed_reconcile_fail_tenant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM seed_reconcile_failing_tenants WHERE tenant_id = NEW.tenant_id) THEN
            RAISE EXCEPTION 'injected reconcile failure';
          END IF;
          RETURN NEW;
        END $$`);
      await adminPool.query(`CREATE TRIGGER seed_reconcile_fail_tenant BEFORE INSERT ON relation_definitions
        FOR EACH ROW EXECUTE FUNCTION seed_reconcile_fail_tenant()`);
      await adminPool.query("INSERT INTO seed_reconcile_failing_tenants (tenant_id) VALUES ($1)", [failing]);

      const failure = await runSeed(pool).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) return;
      expect(failure.message).toContain(failing);
      expect(failure.message).not.toContain(passing);
      expect(failure.errors).toHaveLength(1);
    } finally {
      await adminPool.query("DROP TRIGGER IF EXISTS seed_reconcile_fail_tenant ON relation_definitions");
      await adminPool.query("DROP FUNCTION IF EXISTS seed_reconcile_fail_tenant()");
      await adminPool.query("DROP TABLE seed_reconcile_failing_tenants");
    }
    expect(await definitionRows(failing)).toEqual(failingBefore);
    const results = await runSeed(pool);
    expect(resultFor(results, passing).reconcile?.createdProperties).toBe(0);
    expect(resultFor(results, failing).reconcile?.createdProperties).toBe(GAP_PROPERTIES);
  });
});
