import "../domainWriteHooks.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@alldots/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId, getSystemTimezone } from "../systemSettings.js";
import { ValidationError } from "../errors.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;

const KEYS = ["a", "b", "c", "d", "e"] as const;

/** Runs `fn` in a transaction of the dedicated runtime pool and returns the SQL text of every statement it sent. */
async function statementsOf(fn: (client: PoolClient) => Promise<unknown>): Promise<string[]> {
  return withTransaction(pool, async (client) => {
    const spy = vi.spyOn(client, "query");
    try {
      await fn(client);
      return spy.mock.calls.map(([text]) => (typeof text === "string" ? text : JSON.stringify(text)));
    } finally {
      spy.mockRestore();
    }
  });
}

const count = (statements: string[], pattern: RegExp) => statements.filter((text) => pattern.test(text)).length;
const DATABASE_BY_ID = /FROM databases WHERE id = \$1/;
const ROLLUP_DEPENDENCIES = /FROM rollup_dependencies/;
const SETTINGS_DATABASE = /FROM databases WHERE owner_module_id = \$1 AND system = true/;

describe("round trips of one item write", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "alldots_data");
    cp = createChokePoint(pool);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  async function notesDatabase(): Promise<string> {
    const db = await cp.createDatabase({ name: "Notes" });
    await cp.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    for (const key of KEYS) await cp.createProperty({ databaseId: db.id, key, name: key, type: "text" });
    return db.id;
  }

  it("reads the database row once on create and on update, and looks up rollup dependencies once for all keys", () =>
    runInTenant(tenant, async () => {
      const databaseId = await notesDatabase();
      let itemId = "";
      const create = await statementsOf(async (client) => {
        itemId = (await createItemWithClient(client, { databaseId, properties: { title: "x" } })).id;
      });
      expect(count(create, DATABASE_BY_ID)).toBe(1);

      const update = await statementsOf((client) =>
        updateItemWithClient(client, {
          databaseId,
          itemId,
          propertiesPatch: Object.fromEntries(KEYS.map((key) => [key, "2"])),
        }),
      );
      expect(count(update, DATABASE_BY_ID)).toBe(1);
      expect(count(update, ROLLUP_DEPENDENCIES)).toBe(1);
      expect(count(update, SETTINGS_DATABASE)).toBe(0);
      expect((await cp.getItem(databaseId, itemId))?.properties).toMatchObject({ a: "2", e: "2" });
    }));

  it("resolves the settings item only for a timezone write, and still applies and validates the settings timezone", () =>
    runInTenant(tenant, async () => {
      const { settingsDatabaseId, settingsItemId } = await withTransaction(pool, async (client) => ({
        settingsDatabaseId: await getSystemSettingsDatabaseId(client),
        settingsItemId: await getSystemSettingsItemId(client),
      }));

      const write = await statementsOf((client) =>
        updateItemWithClient(client, {
          databaseId: settingsDatabaseId,
          itemId: settingsItemId,
          propertiesPatch: { timezone: "America/New_York" },
        }),
      );
      expect(count(write, SETTINGS_DATABASE)).toBeGreaterThan(0);
      expect(await withTransaction(pool, (client) => getSystemTimezone(client))).toBe("America/New_York");

      await expect(
        withTransaction(pool, (client) =>
          updateItemWithClient(client, {
            databaseId: settingsDatabaseId,
            itemId: settingsItemId,
            propertiesPatch: { timezone: "Mars/Olympus" },
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await withTransaction(pool, (client) => getSystemTimezone(client))).toBe("America/New_York");
    }));
});
