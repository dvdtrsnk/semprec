import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createPool, withTransaction } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import {
  ensureMailAccountSyncState,
  getProviderAccountAddress,
  ProviderAccountAlreadyConnectedError,
  recordProviderAccountAddress,
} from "../mail/mailAccountSyncStateStore.js";
import {
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const MIGRATION_0125 = "0125_mail_provider_account_address.sql";

let adminPool: Pool;
/** Runtime role (semprec_data) pool: the only pool isolation and production writes are asserted through. */
let dataPool: Pool;
let chokePoint: ChokePoint;

/** The semprec_data pool every production write in this file goes through; row-level security applies to it. */
function openDataPool(): Pool {
  return createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
}

/** Seeds one tenant's system databases in that tenant's scope, as production does. */
async function seedTenant(tenantId: string): Promise<void> {
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
}

/** Creates a Gmail-backed Mailboxes item in a tenant with its address written by the production system writer. */
async function createMailbox(tenantId: string, address: string): Promise<{ itemId: string; databaseId: string }> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const database = await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID);
      if (!database) throw new Error("Mailboxes was not seeded");
      const item = await createItemWithClient(client, {
        databaseId: database.id,
        properties: { name: "Mailbox", provider: "gmail" },
      });
      await writeMailboxAddresses(client, { mailboxesDatabaseId: database.id, mailboxItemId: item.id, address });
      await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "gmail_api" });
      return { itemId: item.id, databaseId: database.id };
    }),
  );
}

/** Runs the production recorder in a tenant and resolves to its error, or null on success. */
async function recordAddress(tenantId: string, itemId: string, address: string): Promise<unknown> {
  return runInTenant(tenantId, () =>
    withTransaction(dataPool, (client) => recordProviderAccountAddress(client, itemId, address)).then(
      () => null,
      (error: unknown) => error,
    ),
  );
}

async function readStoredAddress(tenantId: string, itemId: string): Promise<string | null> {
  return runInTenant(tenantId, () => withTransaction(dataPool, (client) => getProviderAccountAddress(client, itemId)));
}

async function readAddressProperty(tenantId: string, databaseId: string, itemId: string): Promise<unknown> {
  return runInTenant(tenantId, async () => {
    const { rows } = await dataPool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1 AND id = $2",
      [databaseId, itemId],
    );
    return rows[0]?.properties.addresses;
  });
}

/**
 * Re-applies migration 0125 against a tenant whose column, index and backfill were removed in the same
 * transaction, then rolls everything back. The migration already ran once in globalSetup, so the test
 * recreates its pre-state. Owner DDL, which only a test can produce once the migration ran.
 */
async function withPreMigration0125(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await adminPool.connect();
  let failure: { error: unknown } | undefined;
  try {
    await client.query("BEGIN");
    await client.query("DROP INDEX IF EXISTS mail_account_sync_state_tenant_provider_address_uq");
    await client.query("ALTER TABLE mail_account_sync_state DROP COLUMN IF EXISTS provider_account_address");
    await fn(client);
  } catch (error) {
    failure = { error };
  }
  let rollbackError: Error | undefined;
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    rollbackError = error instanceof Error ? error : new Error(String(error));
  }
  if (rollbackError) {
    client.release(rollbackError);
  } else {
    client.release();
  }
  if (failure) throw failure.error;
  if (rollbackError) throw rollbackError;
}

describe("mailbox addresses are server-owned (issue #1454)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = openDataPool();
    chokePoint = createChokePoint(dataPool);
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    await seedTenant(getTenantZeroId());
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("seeds Mailboxes.addresses as owner 'system' in a fresh tenant", async () => {
    const { rows } = await adminPool.query<{ owner: string }>(
      `SELECT owner FROM properties WHERE key = 'addresses' AND database_id IN (
         SELECT id FROM databases WHERE owner_module_id = $1)`,
      [MAILBOXES_MODULE_ID],
    );
    expect(rows).toEqual([{ owner: "system" }]);
  });

  it("refuses a generic item patch of addresses with owner_violation, leaving the value unchanged", async () => {
    const tenantId = getTenantZeroId();
    const { itemId, databaseId } = await createMailbox(tenantId, "me@example.com");
    const before = await readAddressProperty(tenantId, databaseId, itemId);

    await expect(
      runInTenant(tenantId, () =>
        chokePoint.updateItem({ databaseId, itemId, propertiesPatch: { addresses: "attacker@example.com" } }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "owner_violation" });

    expect(await readAddressProperty(tenantId, databaseId, itemId)).toBe(before);
  });

  it("refuses addresses in a generic item create with owner_violation, writing no row", async () => {
    const tenantId = getTenantZeroId();
    const databaseId = await runInTenant(tenantId, () =>
      withTransaction(dataPool, async (client) => (await getDatabaseByModuleId(client, MAILBOXES_MODULE_ID))!.id),
    );
    const countItems = async () =>
      (
        await adminPool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
          databaseId,
        ])
      ).rows[0]!.n;
    const before = await countItems();

    await expect(
      runInTenant(tenantId, () =>
        chokePoint.createItem({
          databaseId,
          properties: { name: "Forged", provider: "gmail", addresses: "attacker@example.com" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "owner_violation" });

    expect(await countItems()).toBe(before);
  });

  it("the system writer stores the address normalized, with aliases appended and duplicates dropped", async () => {
    const tenantId = getTenantZeroId();
    const { itemId, databaseId } = await createMailbox(tenantId, "me@example.com");

    await runInTenant(tenantId, () =>
      withTransaction(dataPool, (client) =>
        writeMailboxAddresses(client, {
          mailboxesDatabaseId: databaseId,
          mailboxItemId: itemId,
          address: "  Me@Example.COM ",
          aliases: ["alias@example.com", "ME@example.com", ""],
        }),
      ),
    );

    expect(await readAddressProperty(tenantId, databaseId, itemId)).toBe("me@example.com\nalias@example.com");
  });

  it("the system writer rejects an empty address with validation_failed and leaves the value unchanged", async () => {
    const tenantId = getTenantZeroId();
    const { itemId, databaseId } = await createMailbox(tenantId, "me@example.com");
    const before = await readAddressProperty(tenantId, databaseId, itemId);

    await expect(
      runInTenant(tenantId, () =>
        withTransaction(dataPool, (client) =>
          writeMailboxAddresses(client, { mailboxesDatabaseId: databaseId, mailboxItemId: itemId, address: "   " }),
        ),
      ),
    ).rejects.toMatchObject({ status: 400, code: "validation_failed" });

    expect(await readAddressProperty(tenantId, databaseId, itemId)).toBe(before);
  });

  it("the same provider address on two mailboxes of one tenant conflicts, in any letter case", async () => {
    const tenantId = getTenantZeroId();
    const first = await createMailbox(tenantId, "first@example.com");
    const second = await createMailbox(tenantId, "second@example.com");

    expect(await recordAddress(tenantId, first.itemId, "Shared@Example.com")).toBeNull();
    const error = await recordAddress(tenantId, second.itemId, "  shared@example.COM ");

    expect(error).toBeInstanceOf(ProviderAccountAlreadyConnectedError);
    expect(error).toMatchObject({ status: 409, code: "provider_account_already_connected" });
    // The refused write leaves the second mailbox's stored address exactly as it was.
    expect(await readStoredAddress(tenantId, second.itemId)).toBeNull();
    expect(await readStoredAddress(tenantId, first.itemId)).toBe("shared@example.com");
  });

  it("preserves nonmatching database and unknown thrown errors from the recorder", async () => {
    const tenantId = getTenantZeroId();
    const { itemId } = await createMailbox(tenantId, "owner@example.com");
    const errors: unknown[] = [
      new Error("database connection failed"),
      { code: "23505", constraint: "other_index" },
      "opaque failure",
      null,
    ];
    await runInTenant(tenantId, () =>
      withTransaction(dataPool, async (client) => {
        for (const error of errors) {
          const query = vi.spyOn(client, "query").mockRejectedValueOnce(error);
          try {
            await expect(recordProviderAccountAddress(client, itemId, "owner@example.com")).rejects.toBe(error);
          } finally {
            query.mockRestore();
          }
        }
      }),
    );
    expect(await readStoredAddress(tenantId, itemId)).toBeNull();
  });

  it("the same provider address in two tenants is allowed", async () => {
    const tenantA = getTenantZeroId();
    const tenantB = await createTestTenant(adminPool);
    await seedTenant(tenantB);
    const a = await createMailbox(tenantA, "a@example.com");
    const b = await createMailbox(tenantB, "b@example.com");

    expect(await recordAddress(tenantA, a.itemId, "shared@example.com")).toBeNull();
    expect(await recordAddress(tenantB, b.itemId, "shared@example.com")).toBeNull();
  });

  it("a mailbox with no recorded address blocks nothing, and re-recording its own address is accepted", async () => {
    const tenantId = getTenantZeroId();
    const first = await createMailbox(tenantId, "first@example.com");
    const second = await createMailbox(tenantId, "second@example.com");

    expect(await readStoredAddress(tenantId, second.itemId)).toBeNull();
    expect(await recordAddress(tenantId, first.itemId, "shared@example.com")).toBeNull();
    expect(await recordAddress(tenantId, first.itemId, "shared@example.com")).toBeNull();
    expect(await recordAddress(tenantId, second.itemId, "other@example.com")).toBeNull();
  });

  it("the store rejects an empty provider address with validation_failed and writes nothing", async () => {
    const tenantId = getTenantZeroId();
    const { itemId } = await createMailbox(tenantId, "me@example.com");

    const error = await recordAddress(tenantId, itemId, "   ");

    expect(error).toMatchObject({ status: 400, code: "validation_failed" });
    expect(await readStoredAddress(tenantId, itemId)).toBeNull();
  });
});

describe("mailbox provider address migration 0125 (issue #1454)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = openDataPool();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  it("backfills gmail_api rows from the watch address, normalized, and leaves other rows null", async () => {
    const tenantId = getTenantZeroId();
    const gmailItem = randomUUID();
    const imapItem = randomUUID();
    const gmailNoWatch = randomUUID();
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      await ensureMailAccountSyncState(client, { itemId: gmailItem, syncMode: "gmail_api" });
      await client.query("UPDATE mail_account_sync_state SET gmail_watch_email_address = $2 WHERE item_id = $1", [
        gmailItem,
        "  Watched@Example.com ",
      ]);
      await ensureMailAccountSyncState(client, { itemId: imapItem, syncMode: "imap" });
      await client.query("UPDATE mail_account_sync_state SET gmail_watch_email_address = $2 WHERE item_id = $1", [
        imapItem,
        "imap@example.com",
      ]);
      await ensureMailAccountSyncState(client, { itemId: gmailNoWatch, syncMode: "gmail_api" });
    });

    const migration = await readFile(path.join(MIGRATIONS_DIR, MIGRATION_0125), "utf8");
    await withPreMigration0125(async (client) => {
      await client.query(migration);
      const { rows } = await client.query<{ item_id: string; provider_account_address: string | null }>(
        "SELECT item_id, provider_account_address FROM mail_account_sync_state WHERE item_id = ANY($1::uuid[])",
        [[gmailItem, imapItem, gmailNoWatch]],
      );
      const byItem = new Map(rows.map((row) => [row.item_id, row.provider_account_address]));
      expect(byItem.get(gmailItem)).toBe("watched@example.com");
      expect(byItem.get(imapItem)).toBeNull();
      expect(byItem.get(gmailNoWatch)).toBeNull();
    });
  });

  it("backfills two watch addresses that normalize to one value without failing, keeping the lowest item id", async () => {
    const tenantId = getTenantZeroId();
    const lower = "00000000-0000-4000-8000-000000000001";
    const higher = "00000000-0000-4000-8000-000000000002";
    await withTenantTransaction(adminPool, tenantId, async (client) => {
      for (const itemId of [higher, lower]) {
        await ensureMailAccountSyncState(client, { itemId, syncMode: "gmail_api" });
        await client.query("UPDATE mail_account_sync_state SET gmail_watch_email_address = $2 WHERE item_id = $1", [
          itemId,
          "Dup@Example.com",
        ]);
      }
    });

    const migration = await readFile(path.join(MIGRATIONS_DIR, MIGRATION_0125), "utf8");
    await withPreMigration0125(async (client) => {
      await client.query(migration);
      const { rows } = await client.query<{ item_id: string; provider_account_address: string | null }>(
        "SELECT item_id, provider_account_address FROM mail_account_sync_state WHERE item_id = ANY($1::uuid[])",
        [[lower, higher]],
      );
      const byItem = new Map(rows.map((row) => [row.item_id, row.provider_account_address]));
      expect(byItem.get(lower)).toBe("dup@example.com");
      expect(byItem.get(higher)).toBeNull();
    });
  });
});

describe("Mailboxes.addresses owner cutover (issue #1454)", () => {
  beforeAll(() => {
    adminPool = getTestPool();
    dataPool = openDataPool();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
  });

  afterAll(async () => {
    await dataPool.end();
    await adminPool.end();
  });

  /** Seeds a tenant, then reverts its Mailboxes.addresses to the pre-#1454 owner, as a populated install still has it. */
  async function seedOldOwner(tenantId: string): Promise<void> {
    await seedTenant(tenantId);
    // Owner DDL-free state change that the public writer cannot produce: a populated catalog seeded before #1454.
    await adminPool.query(
      `UPDATE properties SET owner = 'user' WHERE key = 'addresses' AND database_id IN (
         SELECT id FROM databases WHERE owner_module_id = $1 AND tenant_id = $2)`,
      [MAILBOXES_MODULE_ID, tenantId],
    );
  }

  async function readOwner(tenantId: string): Promise<string> {
    const { rows } = await adminPool.query<{ owner: string }>(
      `SELECT owner FROM properties WHERE key = 'addresses' AND database_id IN (
         SELECT id FROM databases WHERE owner_module_id = $1 AND tenant_id = $2)`,
      [MAILBOXES_MODULE_ID, tenantId],
    );
    return rows[0]!.owner;
  }

  async function snapshotProperties(): Promise<unknown[]> {
    const { rows } = await adminPool.query("SELECT to_jsonb(t) AS row FROM properties t ORDER BY id");
    return rows;
  }

  it("flips an existing user-owned addresses property in every tenant, and a second run changes nothing", async () => {
    const zero = getTenantZeroId();
    const other = await createTestTenant(adminPool);
    await seedOldOwner(zero);
    await seedOldOwner(other);
    expect(await readOwner(zero)).toBe("user");
    expect(await readOwner(other)).toBe("user");

    await runAsSystem("test cutover", () => runTenantCutoverMigrations(dataPool));
    expect(await readOwner(zero)).toBe("system");
    expect(await readOwner(other)).toBe("system");

    const before = await snapshotProperties();
    await runAsSystem("test cutover", () => runTenantCutoverMigrations(dataPool));
    expect(await snapshotProperties()).toEqual(before);
  });

  it("skips a tenant without a Mailboxes database, leaving it without one", async () => {
    const zero = getTenantZeroId();
    await seedOldOwner(zero);
    const bare = await createTestTenant(adminPool);

    await runAsSystem("test cutover", () => runTenantCutoverMigrations(dataPool));

    expect(await readOwner(zero)).toBe("system");
    const { rows } = await adminPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM databases WHERE owner_module_id = $1 AND tenant_id = $2",
      [MAILBOXES_MODULE_ID, bare],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
