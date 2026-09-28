import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES } from "@semprec/queue";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createItemWithClient,
  createMailLiveSyncRoot,
  createNoopMailLiveSyncLifecycleFactory,
  resolveMailModuleIds,
  seedSystem,
  withTransaction,
  type MailLiveSyncRoot,
} from "@semprec/data";

const DISCOVERY_INTERVAL_MS = 200;

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails via the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  expect(await check()).toBe(true);
}

async function syncStateItemIds(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ item_id: string }>(
    "SELECT item_id FROM mail_account_sync_state ORDER BY item_id",
  );
  return rows.map((row) => row.item_id);
}

async function mailAccountSyncPayloads(pool: Pool): Promise<unknown[]> {
  const { rows } = await pool.query<{ payload: unknown }>(
    `SELECT jobs.payload FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1`,
    [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC],
  );
  return rows.map((row) => row.payload);
}

async function insertMailbox(pool: Pool, mailboxesDatabaseId: string, name: string): Promise<string> {
  const item = await withTransaction(pool, (client) =>
    createItemWithClient(client, { databaseId: mailboxesDatabaseId, properties: { name, provider: "generic" } }),
  );
  return item.id;
}

/** Composes the live-sync root exactly as `serve.ts` does, with a shortened discovery interval. */
async function composeLikeServe(pool: Pool): Promise<{ root: MailLiveSyncRoot; mailboxesDatabaseId: string }> {
  const { mailboxesDatabaseId } = await withTransaction(pool, (client) => resolveMailModuleIds(client));
  const root = createMailLiveSyncRoot(pool, mailboxesDatabaseId, createNoopMailLiveSyncLifecycleFactory(pool), {
    discoveryIntervalMs: DISCOVERY_INTERVAL_MS,
  });
  return { root, mailboxesDatabaseId };
}

let pool: Pool;
let root: MailLiveSyncRoot | undefined;

describe("semprec-api mail live-sync composition (issue #650)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    root = undefined;
  });

  afterEach(async () => {
    await root?.stop();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("seeds a sync-state row and enqueues one mailAccountSync for an active mailbox, and stops discovering after stop()", async () => {
    const composed = await composeLikeServe(pool);
    root = composed.root;
    const mailboxId = await insertMailbox(pool, composed.mailboxesDatabaseId, "Primary");

    await root.start();

    expect(await syncStateItemIds(pool)).toEqual([mailboxId]);
    expect(await mailAccountSyncPayloads(pool)).toEqual([
      expect.objectContaining({ payload: { mailboxItemId: mailboxId } }),
    ]);

    await expect(root.stop()).resolves.toBeUndefined();
    await insertMailbox(pool, composed.mailboxesDatabaseId, "Late");
    await sleep(DISCOVERY_INTERVAL_MS * 3);

    expect(await syncStateItemIds(pool)).toEqual([mailboxId]);
  });

  it("gives a soft-deleted mailbox no sync-state row and enqueues nothing for it", async () => {
    const composed = await composeLikeServe(pool);
    root = composed.root;
    const deletedId = await insertMailbox(pool, composed.mailboxesDatabaseId, "Deleted");
    await createChokePoint(pool).softDeleteItem(composed.mailboxesDatabaseId, deletedId);

    await root.start();

    expect(await syncStateItemIds(pool)).toEqual([]);
    expect(await mailAccountSyncPayloads(pool)).toEqual([]);
  });

  it("picks up a mailbox inserted after start() on the next discovery pass", async () => {
    const composed = await composeLikeServe(pool);
    root = composed.root;
    await root.start();

    const mailboxId = await insertMailbox(pool, composed.mailboxesDatabaseId, "Added");

    await waitFor(async () => (await syncStateItemIds(pool)).includes(mailboxId));
    await waitFor(async () => (await mailAccountSyncPayloads(pool)).length === 1);
    expect(await mailAccountSyncPayloads(pool)).toEqual([
      expect.objectContaining({ payload: { mailboxItemId: mailboxId } }),
    ]);
  });
});
