import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { ensureMailAccountSyncState, getTestPool, resetDatabase, storeCredential } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createItemWithClient,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createApiQueueRuntime, type ApiQueueRuntime } from "../queueRuntime.js";

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails via the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  expect(await check()).toBe(true);
}

interface JobRow {
  payload: unknown;
  attempts: number;
  last_error: string | null;
}

async function jobsFor(pool: Pool, identifier: string): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `SELECT jobs.payload, jobs.attempts, jobs.last_error FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1`,
    [identifier],
  );
  return rows;
}

let pool: Pool;
let runtime: ApiQueueRuntime | undefined;
let previousInternalToken: string | undefined;

describe("createApiQueueRuntime mail module ids (issue #648)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    // The `mail_sync_error` notification the failed sync writes targets the earliest account.
    await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'unused')`, [`${randomUUID()}@example.com`]);
    runtime = undefined;
    // `createApiActionRegistry` composes `core.agentGuidanceDrift` eagerly, which requires it.
    previousInternalToken = process.env.AI_GATEWAY_INTERNAL_TOKEN;
    process.env.AI_GATEWAY_INTERNAL_TOKEN = randomUUID();
  });

  afterEach(async () => {
    await runtime?.stop();
    if (previousInternalToken === undefined) delete process.env.AI_GATEWAY_INTERNAL_TOKEN;
    else process.env.AI_GATEWAY_INTERNAL_TOKEN = previousInternalToken;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects at startup on an unseeded database, naming the missing module ids and the seed CLI", async () => {
    await resetDatabase(pool);

    await expect(createApiQueueRuntime(pool, await loadFullModuleRegistry())).rejects.toThrow(
      "Mail module databases are not seeded (missing: emails, files, folders, mailboxes) — run packages/data/dist/db/runSeedCli.js",
    );
  });

  it("completes mailSearchReindexSweep on its first attempt", async () => {
    runtime = await createApiQueueRuntime(pool, await loadFullModuleRegistry());
    await enqueueJob(pool, CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP, {});

    // Success deletes the row; a failed attempt keeps it with `last_error` set for a backed-off retry.
    await waitFor(async () => {
      const jobs = await jobsFor(pool, CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP);
      return jobs.length === 0 || jobs.some((job) => job.last_error !== null);
    });
    expect(await jobsFor(pool, CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP)).toEqual([]);
  });

  it("sweeps a due account into a mailAccountSync job that fails at the adapter step, not the module-ids guard", async () => {
    const mailbox = await withTransaction(pool, async (client) => {
      const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
      const item = await createItemWithClient(client, {
        databaseId: mailboxes!.id,
        properties: { name: "Composition", provider: "generic" },
      });
      await storeCredential(client, { itemId: item.id, credentialType: "app_password", plaintext: "s3cr3t" });
      await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "imap" });
      return item;
    });

    runtime = await createApiQueueRuntime(pool, await loadFullModuleRegistry());
    await enqueueJob(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC_SWEEP, {});

    await waitFor(async () => (await jobsFor(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC)).length > 0);
    const syncJobs = await jobsFor(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC);
    expect(syncJobs).toHaveLength(1);
    expect(syncJobs[0]!.payload).toMatchObject({ payload: { mailboxItemId: mailbox.id } });

    await waitFor(async () => {
      const { rows } = await pool.query<{ last_error: string | null }>(
        `SELECT last_error FROM mail_account_sync_state WHERE item_id = $1`,
        [mailbox.id],
      );
      return rows[0]?.last_error !== null && rows[0]?.last_error !== undefined;
    });
    const { rows } = await pool.query<{ last_error: string }>(
      `SELECT last_error FROM mail_account_sync_state WHERE item_id = $1`,
      [mailbox.id],
    );
    expect(rows).toEqual([{ last_error: "No IMAP adapter configured for this composition root" }]);
    const synced = await createChokePoint(pool).findItem(mailbox.id);
    expect(synced!.properties.syncStatus).toBe("error");
    // The handler rethrows after recording the failure, so the job row carries the same adapter error.
    await waitFor(async () =>
      (await jobsFor(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC)).some((job) => job.last_error !== null),
    );
    const [failedJob] = await jobsFor(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC);
    expect(failedJob!.last_error).toContain("No IMAP adapter configured for this composition root");
  });
});
