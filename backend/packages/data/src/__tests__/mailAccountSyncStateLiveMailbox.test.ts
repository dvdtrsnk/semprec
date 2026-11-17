import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { withTransaction } from "../db/pool.js";
import {
  ensureMailAccountSyncState,
  ensureMailAccountSyncStateOfLiveMailbox,
  getMailAccountSyncState,
  type SyncMode,
} from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { seedSystem } from "../seed/seedSystem.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

async function createMailbox(tenantId = tenant): Promise<{ id: string; mailboxesDatabaseId: string }> {
  return inTenant(async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    const item = await createItemWithClient(client, {
      databaseId: mailboxesDatabaseId,
      properties: { name: "Mailbox", provider: "generic" },
    });
    return { id: item.id, mailboxesDatabaseId };
  }, tenantId);
}

function syncStateOf(itemId: string, tenantId = tenant): ReturnType<typeof getMailAccountSyncState> {
  return inTenant((client) => getMailAccountSyncState(client, itemId), tenantId);
}

function tryLockItemForUpdate(itemId: string): Promise<unknown> {
  return inTenant((client) => client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE NOWAIT", [itemId]));
}

/** 55P03 is `lock_not_available`, raised for a `NOWAIT` statement that would have to wait. */
const LOCK_NOT_AVAILABLE = { code: "55P03" };

describe("ensureMailAccountSyncStateOfLiveMailbox (sp-1272c2b9)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await seedSystem(admin);
    tenant = getTenantZeroId();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  it("returns the row of an account that has one as it is, takes no lock on the item and writes nothing", async () => {
    const mailbox = await createMailbox();
    await inTenant((client) => ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" }));

    const seeded = await inTenant(async (client) => {
      // The given mode differs from the stored one: an existing row is returned as it is.
      const row = await ensureMailAccountSyncStateOfLiveMailbox(client, { ...input(mailbox), syncMode: "gmail_api" });
      // The item is not share-locked by this transaction: another connection row-locks it at once.
      await tryLockItemForUpdate(mailbox.id);
      return row;
    });

    expect(seeded?.syncMode).toBe("imap");
    expect((await syncStateOf(mailbox.id))?.syncMode).toBe("imap");
  });

  it("gives a live account without a row the row with the given syncMode and keeps the item share-locked until the transaction ends", async () => {
    const mailbox = await createMailbox();

    const seeded = await inTenant(async (client) => {
      const row = await ensureMailAccountSyncStateOfLiveMailbox(client, { ...input(mailbox), syncMode: "graph_api" });
      // Another connection cannot take the item's row lock while this transaction is open.
      await expect(tryLockItemForUpdate(mailbox.id)).rejects.toMatchObject(LOCK_NOT_AVAILABLE);
      return row;
    });

    expect(seeded?.itemId).toBe(mailbox.id);
    expect(seeded?.syncMode).toBe("graph_api");
    expect((await syncStateOf(mailbox.id))?.syncMode).toBe("graph_api");
    await tryLockItemForUpdate(mailbox.id);
  });

  it("returns null for an item in the trash and inserts nothing", async () => {
    const mailbox = await createMailbox();
    await inTenant((client) =>
      itemDeleteWithClient(client, mailbox.mailboxesDatabaseId, mailbox.id, {
        queueAffinity: createActionQueueAffinity(),
      }),
    );

    const seeded = await inTenant((client) => ensureMailAccountSyncStateOfLiveMailbox(client, input(mailbox)));

    expect(seeded).toBeNull();
    expect(await syncStateOf(mailbox.id)).toBeNull();
  });

  it("returns null at once for an item that another transaction holds FOR UPDATE, and inserts nothing", async () => {
    const mailbox = await createMailbox();
    const holderHasLock = signal();
    const holderMayEnd = signal();
    const holder = inTenant(async (client) => {
      await client.query("SELECT id FROM items WHERE id = $1 FOR UPDATE", [mailbox.id]);
      holderHasLock.resolve();
      await holderMayEnd.promise;
    });
    try {
      await Promise.race([holderHasLock.promise, holder]);
      // This call ends while the holder's transaction is still open; a wait would never end here.
      const seeded = await inTenant((client) => ensureMailAccountSyncStateOfLiveMailbox(client, input(mailbox)));
      expect(seeded).toBeNull();
    } finally {
      holderMayEnd.resolve();
      await holder;
    }

    expect(await syncStateOf(mailbox.id)).toBeNull();
  });

  it("returns null for an item that is not in the given Mailboxes database", async () => {
    const mailbox = await createMailbox();
    const { rows } = await admin.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      EMAILS_MODULE_ID,
    ]);
    const emailsDatabaseId = rows[0]?.id;
    if (!emailsDatabaseId) throw new Error("The Emails database is not seeded");

    const seeded = await inTenant((client) =>
      ensureMailAccountSyncStateOfLiveMailbox(client, { ...input(mailbox), mailboxesDatabaseId: emailsDatabaseId }),
    );

    expect(seeded).toBeNull();
    expect(await syncStateOf(mailbox.id)).toBeNull();
  });

  it("returns null for another tenant's item under row-level security, and inserts nothing for it", async () => {
    const mailbox = await createMailbox();
    const other = await createTestTenant(admin);
    await provisionTenant(runtime, other);
    // The caller of the other tenant knows the id and the Mailboxes database id of this tenant.
    const seeded = await inTenant((client) => ensureMailAccountSyncStateOfLiveMailbox(client, input(mailbox)), other);

    expect(seeded).toBeNull();
    expect(await syncStateOf(mailbox.id)).toBeNull();
    expect(await syncStateOf(mailbox.id, other)).toBeNull();
    // The same call in the item's own tenant seeds it, so the null above came from the isolation.
    const own = await inTenant((client) => ensureMailAccountSyncStateOfLiveMailbox(client, input(mailbox)));
    expect(own?.itemId).toBe(mailbox.id);
  });
});

function input(mailbox: { id: string; mailboxesDatabaseId: string }): {
  itemId: string;
  mailboxesDatabaseId: string;
  syncMode: SyncMode;
} {
  return { itemId: mailbox.id, mailboxesDatabaseId: mailbox.mailboxesDatabaseId, syncMode: "imap" };
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
