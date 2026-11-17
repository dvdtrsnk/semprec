import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createPool, withTransaction } from "../db/pool.js";
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
import { createTestTenant, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";

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
