import { beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, createItemWithClient, type ChokePoint } from "../chokePoint/chokePoint.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { getMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import {
  createMailLiveSyncRoot,
  type MailAccountLifecycle,
  type MailLiveSyncAccount,
  type MailLiveSyncLifecycleFactory,
} from "../mail/mailLiveSyncRoot.js";

let pool: Pool;
let chokePoint: ChokePoint;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

interface RecordingLifecycle extends MailAccountLifecycle {
  starts: number;
  stops: number;
}

function recordingFactory(
  onCreate?: (account: MailLiveSyncAccount, lifecycle: RecordingLifecycle) => void,
  behavior?: (account: MailLiveSyncAccount) => Partial<MailAccountLifecycle>,
): { factory: MailLiveSyncLifecycleFactory; byAccount: Map<string, RecordingLifecycle> } {
  const byAccount = new Map<string, RecordingLifecycle>();
  const factory: MailLiveSyncLifecycleFactory = (account) => {
    const overrides = behavior?.(account) ?? {};
    const lifecycle: RecordingLifecycle = {
      starts: 0,
      stops: 0,
      async start() {
        lifecycle.starts++;
        await overrides.start?.();
      },
      async stop() {
        lifecycle.stops++;
        await overrides.stop?.();
      },
    };
    byAccount.set(account.mailboxItemId, lifecycle);
    onCreate?.(account, lifecycle);
    return lifecycle;
  };
  return { factory, byAccount };
}

describe("mail live-sync composition root (issue #195)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  it("starts exactly one lifecycle per active account, seeding its sync state", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "gmail" } }));
    const b = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "imap" } }));

    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory);

    await root.reconcileOnce();

    expect(byAccount.get(a.id)?.starts).toBe(1);
    expect(byAccount.get(b.id)?.starts).toBe(1);

    const stateA = await withTransaction(pool, (client) => getMailAccountSyncState(client, a.id));
    expect(stateA?.syncMode).toBe("gmail_api");

    // A second pass with no changes to the active set must not start a second lifecycle for
    // either account — exactly one lifecycle per active account, restart or not.
    await root.reconcileOnce();
    expect(byAccount.get(a.id)?.starts).toBe(1);
    expect(byAccount.get(b.id)?.starts).toBe(1);

    await root.stop();
    expect(byAccount.get(a.id)?.stops).toBe(1);
    expect(byAccount.get(b.id)?.stops).toBe(1);
  });

  it("stops a lifecycle when its account is deactivated (soft-deleted), leaving the others running", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));
    const b = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "generic" } }));

    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory);
    await root.reconcileOnce();
    expect(byAccount.get(a.id)?.starts).toBe(1);
    expect(byAccount.get(b.id)?.starts).toBe(1);

    await chokePoint.softDeleteItem(mailboxesId, a.id);
    await root.reconcileOnce();

    expect(byAccount.get(a.id)?.stops).toBe(1);
    expect(byAccount.get(b.id)?.stops).toBe(0);

    // Reactivation restarts a fresh lifecycle for the account rather than leaving it stopped.
    await chokePoint.restoreItem(mailboxesId, a.id);
    await root.reconcileOnce();
    expect(byAccount.get(a.id)?.starts).toBe(1);
  });

  it("restarting the composition root restores state instead of resetting it and does not duplicate a watcher", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));

    const first = recordingFactory();
    const rootOne = createMailLiveSyncRoot(pool, mailboxesId, first.factory);
    await rootOne.reconcileOnce();
    expect(first.byAccount.get(a.id)?.starts).toBe(1);

    // Persisted sync state survives across "restarts" (a brand-new root instance, simulating a
    // process restart) — it is read back, not reset, and the fresh root does not start a
    // second concurrent lifecycle for the still-active account beyond its own one.
    const stateBeforeRestart = await withTransaction(pool, (client) => getMailAccountSyncState(client, a.id));

    const second = recordingFactory();
    const rootTwo = createMailLiveSyncRoot(pool, mailboxesId, second.factory);
    await rootTwo.reconcileOnce();
    expect(second.byAccount.get(a.id)?.starts).toBe(1);

    const stateAfterRestart = await withTransaction(pool, (client) => getMailAccountSyncState(client, a.id));
    expect(stateAfterRestart?.syncMode).toBe(stateBeforeRestart?.syncMode);
    expect(stateAfterRestart?.nextExpectedActivityAt).toBe(stateBeforeRestart?.nextExpectedActivityAt);
  });

  it("isolates one account's lifecycle failure from the others", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));
    const b = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "B", provider: "generic" } }));

    const errors: Array<{ mailboxItemId: string; phase: string }> = [];
    const { factory, byAccount } = recordingFactory(undefined, (account) =>
      account.mailboxItemId === a.id
        ? {
            start: async () => {
              throw new Error("boom: simulated transport failure for account A");
            },
          }
        : {},
    );
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory, {
      onLifecycleError: (mailboxItemId, phase) => errors.push({ mailboxItemId, phase }),
    });

    await root.reconcileOnce();

    expect(errors).toEqual([{ mailboxItemId: a.id, phase: "start" }]);
    expect(byAccount.get(a.id)?.starts).toBe(1);
    expect(byAccount.get(b.id)?.starts).toBe(1);

    await root.stop();
    // Even though A's lifecycle failed to start, it is still tracked as hosted (its `start`
    // threw, but the composition root already recorded it) and gets a matching stop call.
    expect(byAccount.get(a.id)?.stops).toBe(1);
    expect(byAccount.get(b.id)?.stops).toBe(1);
  });

  it("restarts a lifecycle when the account's sync mode changes instead of hosting two at once", async () => {
    const mailboxesId = await databaseIdFor("mailboxes");
    const a = await withTransaction(pool, (client) => createItemWithClient(client, { databaseId: mailboxesId, properties: { name: "A", provider: "generic" } }));

    const { factory, byAccount } = recordingFactory();
    const root = createMailLiveSyncRoot(pool, mailboxesId, factory);
    await root.reconcileOnce();
    expect(byAccount.get(a.id)?.starts).toBe(1);
    const firstLifecycle = byAccount.get(a.id)!;

    await withTransaction(pool, (client) => client.query("UPDATE mail_account_sync_state SET sync_mode = 'gmail_api' WHERE item_id = $1", [a.id]));
    await root.reconcileOnce();

    expect(firstLifecycle.stops).toBe(1);
    const secondLifecycle = byAccount.get(a.id)!;
    expect(secondLifecycle).not.toBe(firstLifecycle);
    expect(secondLifecycle.starts).toBe(1);
  });
});
