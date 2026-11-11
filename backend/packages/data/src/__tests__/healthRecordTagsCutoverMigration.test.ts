import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { z } from "zod";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { runHealthRecordTagsCutoverMigration } from "../seed/healthRecordTagsCutoverMigration.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

const ORIGINAL_KEYS = ["bloodTests", "medication", "epilepsy", "dentalHygiene"];
const ADDED_KEYS = ["bloodPressure", "prevention"];
const ORIGINAL_OPTIONS = ORIGINAL_KEYS.map((key) => ({ key }));
const ALL_OPTIONS = [...ORIGINAL_KEYS, ...ADDED_KEYS].map((key) => ({ key }));
/**
 * The six options with the colors of issue #1705: what a fresh seed stores, and what the whole tenant runner
 * leaves in an older tenant, where the select-option colors cutover runs after the tags cutover.
 */
const COLORED_OPTIONS = [
  { key: "bloodTests", color: "#FF9500" },
  { key: "medication", color: "#AF52DE" },
  { key: "epilepsy" },
  { key: "dentalHygiene" },
  { key: "bloodPressure", color: "#FF2D55" },
  { key: "prevention", color: "#34C759" },
];

let admin: Pool;
let runtime: Pool;
let first: string;
let second: string;

const tagsRow = z.object({
  id: z.string(),
  databaseId: z.string(),
  /** The row version (`xmin`): it changes with every write to the row, including one that stores equal values. */
  version: z.string(),
  config: z.record(z.string(), z.unknown()),
});
type TagsRow = z.infer<typeof tagsRow>;

/** The tenant's Health records `tags` property, read as that tenant on the runtime role; `null` when it has none. */
async function findTags(tenantId: string): Promise<TagsRow | null> {
  return runInTenant(tenantId, async () => {
    const { rows } = await runtime.query<Record<string, unknown>>(
      `SELECT p.id, p.database_id AS "databaseId", p.xmin::text AS version, p.config
         FROM properties p JOIN databases d ON d.id = p.database_id
        WHERE d.owner_module_id = 'healthRecords' AND d.system AND p.key = 'tags'`,
    );
    return rows[0] ? tagsRow.parse(rows[0]) : null;
  });
}

async function readTags(tenantId: string): Promise<TagsRow> {
  const row = await findTags(tenantId);
  if (!row) throw new Error("Health records tags property missing");
  return row;
}

function seed(tenantId: string): Promise<unknown> {
  return runInTenant(tenantId, () => seedSystem(runtime, createViewTypeRegistry()));
}

/** Seeds the tenant, then replaces its stored Health records `tags` config with `config`. */
async function seedWithStoredTags(tenantId: string, config: Record<string, unknown>): Promise<TagsRow> {
  await seed(tenantId);
  const { id } = await readTags(tenantId);
  // Raw SQL as the owner: Health records is schema-locked, so no production write can change this catalog.
  const result = await admin.query("UPDATE properties SET config = $3::jsonb WHERE tenant_id = $1 AND id = $2", [
    tenantId,
    id,
    JSON.stringify(config),
  ]);
  expect(result.rowCount).toBe(1);
  return readTags(tenantId);
}

function runCutovers(): Promise<void> {
  return runAsSystem("health record tags cutover test", () => runTenantCutoverMigrations(runtime));
}

function runCutoverIn(tenantId: string): Promise<void> {
  return runInTenant(tenantId, () => runHealthRecordTagsCutoverMigration(runtime));
}

/** Resolves once a session is queued for an EXCLUSIVE lock on `properties`; throws after about ten seconds without one. */
async function waitForQueuedPropertiesLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await admin.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_locks l
        WHERE l.relation = 'public.properties'::regclass AND l.mode = 'ExclusiveLock' AND NOT l.granted
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await delay(50);
  }
  throw new Error("No session queued for an EXCLUSIVE lock on properties");
}

describe("Health records tags tenant cutover (issue #1700)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    first = getTenantZeroId();
    second = await createTestTenant(admin);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("seeds a new tenant with the four existing tags followed by the two new ones", async () => {
    await seed(first);

    expect((await readTags(first)).config).toStrictEqual({ options: COLORED_OPTIONS });
  });

  it("appends exactly the two options to a tenant seeded before them, through the tenant runner", async () => {
    await seed(first);
    const untouched = await readTags(first);
    await seedWithStoredTags(second, { options: ORIGINAL_OPTIONS });

    await runCutovers();

    expect((await readTags(second)).config).toStrictEqual({ options: COLORED_OPTIONS });
    // The tenant whose seed already carried both options is not written.
    expect(await readTags(first)).toEqual(untouched);
  });

  it("writes nothing on a second run", async () => {
    await seedWithStoredTags(second, { options: ORIGINAL_OPTIONS });
    await runCutovers();
    const afterFirstRun = await readTags(second);
    expect(afterFirstRun.config).toStrictEqual({ options: COLORED_OPTIONS });

    await runCutovers();

    expect(await readTags(second)).toEqual(afterFirstRun);
  });

  it("leaves existing items and a saved tags filter unchanged, and the filter still matches the same items", async () => {
    const { databaseId } = await seedWithStoredTags(second, { options: ORIGINAL_OPTIONS });
    const chokePoint = createChokePoint(runtime);
    const { viewId, matchingIds } = await runInTenant(second, async () => {
      const bloodTests = await chokePoint.createItem({
        databaseId,
        properties: { name: "Annual blood panel", tags: ["bloodTests", "medication"] },
      });
      const hygiene = await chokePoint.createItem({
        databaseId,
        properties: { name: "Hygiene visit", tags: ["dentalHygiene"] },
      });
      await chokePoint.createItem({ databaseId, properties: { name: "Seizure diary", tags: ["epilepsy"] } });
      await chokePoint.createItem({ databaseId, properties: { name: "Untagged" } });
      const view = await chokePoint.createView({
        databaseId,
        type: "table",
        name: "Blood tests and hygiene",
        config: { filter: { type: "in", property: "tags", value: ["bloodTests", "dentalHygiene"] } },
      });
      return { viewId: view.id, matchingIds: [bloodTests.id, hygiene.id].sort() };
    });
    const stored = () =>
      runInTenant(second, async () => {
        const items = await runtime.query<{ row: unknown }>(
          "SELECT to_jsonb(t) AS row FROM items t WHERE database_id = $1 ORDER BY id",
          [databaseId],
        );
        const views = await runtime.query<{ row: unknown }>("SELECT to_jsonb(t) AS row FROM views t WHERE id = $1", [
          viewId,
        ]);
        const matched = await chokePoint.queryView(viewId);
        return { items: items.rows, views: views.rows, matched: matched.items };
      });
    const before = await stored();
    expect(before.items).toHaveLength(4);
    expect(before.views).toHaveLength(1);
    expect(before.matched.map((item) => item.id).sort()).toEqual(matchingIds);

    // This cutover alone, so the comparison below does not depend on what the other registered cutovers write.
    await runCutoverIn(second);

    expect((await readTags(second)).config).toEqual({ options: ALL_OPTIONS });
    expect(await stored()).toEqual(before);
  });

  it("keeps every stored option object and its position, and appends only the key that is missing", async () => {
    const options = [
      { key: "prevention", label: "Check-ups", color: "#112233" },
      { key: "dentalHygiene" },
      { key: "custom", marker: "kept" },
      { key: "bloodTests" },
    ];
    await seedWithStoredTags(second, { options, marker: "kept" });

    await runCutoverIn(second);

    expect((await readTags(second)).config).toEqual({
      options: [...options, { key: "bloodPressure" }],
      marker: "kept",
    });
  });

  it("adds both options when the stored config has no options array", async () => {
    await seedWithStoredTags(second, {});

    await runCutoverIn(second);

    expect((await readTags(second)).config).toEqual({ options: ADDED_KEYS.map((key) => ({ key })) });
  });

  it("changes only the tenant it runs in", async () => {
    await seedWithStoredTags(first, { options: ORIGINAL_OPTIONS });
    const other = await seedWithStoredTags(second, { options: ORIGINAL_OPTIONS });

    await runCutoverIn(first);

    expect((await readTags(first)).config).toEqual({ options: ALL_OPTIONS });
    expect(await readTags(second)).toEqual(other);
  });

  it("does nothing in a tenant without a Health records database", async () => {
    await expect(runCutoverIn(second)).resolves.toBeUndefined();

    const { rows } = await runInTenant(second, () =>
      runtime.query<{ properties: number }>("SELECT count(*)::int AS properties FROM properties"),
    );
    expect(rows).toEqual([{ properties: 0 }]);
  });

  it("does nothing when Health records has no tags property", async () => {
    await seed(second);
    const { id, databaseId } = await readTags(second);
    // Raw SQL as the owner: a locked system property has no production removal path.
    const removed = await admin.query("DELETE FROM properties WHERE tenant_id = $1 AND id = $2", [second, id]);
    expect(removed.rowCount).toBe(1);
    const propertyRows = () =>
      runInTenant(second, async () => {
        const { rows } = await runtime.query<{ row: unknown }>(
          "SELECT to_jsonb(t) AS row FROM properties t WHERE database_id = $1 ORDER BY id",
          [databaseId],
        );
        return rows;
      });
    const before = await propertyRows();

    await expect(runCutoverIn(second)).resolves.toBeUndefined();

    expect(await findTags(second)).toBeNull();
    expect(await propertyRows()).toEqual(before);
  });

  it("refuses a malformed stored catalog and leaves the row as it was", async () => {
    const before = await seedWithStoredTags(second, { options: "invalid" });

    await expect(runCutoverIn(second)).rejects.toBeInstanceOf(z.ZodError);

    expect(await readTags(second)).toEqual(before);
  });

  it("waits for an open write to the tags catalog and appends to what that write committed", async () => {
    const { id } = await seedWithStoredTags(second, { options: ORIGINAL_OPTIONS });
    const concurrentOptions = [...ORIGINAL_OPTIONS, { key: "custom" }];
    const writer = await admin.connect();
    let committed = false;
    let cutover: Promise<unknown> | undefined;
    try {
      await writer.query("BEGIN");
      // Another session's uncommitted catalog write. Raw SQL as the owner, because the locked schema has no
      // production writer that could hold this row open.
      const written = await writer.query(
        "UPDATE properties SET config = jsonb_set(config, '{options}', $3::jsonb) WHERE tenant_id = $1 AND id = $2",
        [second, id, JSON.stringify(concurrentOptions)],
      );
      expect(written.rowCount).toBe(1);
      cutover = runCutoverIn(second).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForQueuedPropertiesLock();
      await writer.query("COMMIT");
      committed = true;
    } finally {
      // Destroying the connection aborts a transaction this test left open, which also unblocks the cutover.
      writer.release(!committed);
      await cutover;
    }

    expect(await cutover).toBeNull();
    expect((await readTags(second)).config).toEqual({
      options: [...concurrentOptions, ...ADDED_KEYS.map((key) => ({ key }))],
    });
  });
});
