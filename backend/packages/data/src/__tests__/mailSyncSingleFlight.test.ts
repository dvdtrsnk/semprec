import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, registerTask, runWorker, type Runner } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTransaction } from "../db/pool.js";
import type { ImapMailClient } from "../mail/imapReconcile.js";
import { claimMailSyncPass } from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { enqueueMailAccountSync, handleSyncMailAccountTask, mailAccountSyncJobKey } from "../mail/mailSyncJob.js";
import { IMAP_SEEN_FLAG } from "../mail/messageFlags.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapAccount, type FakeImapCall } from "../testSupport/fakeImapAccount.js";
import {
  createImapMailboxFixture,
  noAttachmentStorage,
  plainMessage,
  PURELYMAIL_FOLDERS,
  type ImapMailboxFixture,
} from "../testSupport/imapMailboxFixture.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let runner: Runner | undefined;
const openHolds: Deferred[] = [];

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const jobRowSchema = z.object({ key: z.string().nullable(), locked: z.boolean() });
const leaseRowSchema = z.object({ rerun: z.boolean(), leased: z.boolean() });

/** One IMAP account whose passes are counted, and whose concurrency is observed, through its client factory. */
function observedAccount(account: FakeImapAccount) {
  const observed = { started: 0, active: 0, maxActive: 0 };
  const createImapClient = async (): Promise<ImapMailClient> => {
    observed.started++;
    observed.active++;
    observed.maxActive = Math.max(observed.maxActive, observed.active);
    const client = account.client();
    return {
      ...client,
      close: async () => {
        observed.active--;
        await client.close();
      },
    };
  };
  return { observed, createImapClient };
}

describe("one mail sync pass per mailbox", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  afterEach(async () => {
    // A failed test may leave a pass held; the worker stops only once its jobs end.
    for (const hold of openHolds.splice(0)) hold.resolve();
    const stopping = runner;
    runner = undefined;
    await stopping?.stop();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>, timeout?: number) =>
    it(name, () => runInTenant(tenant, fn), timeout);
  // The worker runs outside any scope and enters each job's tenant itself; a test using it scopes its own steps.
  const inTenant = <T>(fn: () => Promise<T>) => runInTenant(tenant, fn);

  async function syncJobs(): Promise<Array<z.infer<typeof jobRowSchema>>> {
    const { rows } = await admin.query<Record<string, unknown>>(
      `SELECT key, locked_at IS NOT NULL AS locked FROM graphile_worker.jobs
       WHERE task_identifier = 'mailAccountSync' ORDER BY id`,
    );
    return rows.map((row) => jobRowSchema.parse(row));
  }

  async function leaseOf(mailboxId: string): Promise<z.infer<typeof leaseRowSchema>> {
    const { rows } = await runtime.query<Record<string, unknown>>(
      `SELECT pass_rerun_requested AS rerun, pass_lease_token IS NOT NULL AS leased
       FROM mail_account_sync_state WHERE tenant_id = app_tenant_default() AND item_id = $1`,
      [mailboxId],
    );
    return leaseRowSchema.parse(rows[0]);
  }

  async function emailSubjects(): Promise<string[]> {
    const { emailsDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
    const { rows } = await runtime.query<{ name: string }>(
      `SELECT properties->>'name' AS name FROM items
       WHERE tenant_id = app_tenant_default() AND database_id = $1 AND deleted_at IS NULL ORDER BY 1`,
      [emailsDatabaseId],
    );
    return rows.map((row) => row.name);
  }

  /** A synced account with a few messages, CONDSTORE and `latencyMs` per client call. */
  async function syncedAccount(latencyMs = 0): Promise<{ account: FakeImapAccount; mailbox: ImapMailboxFixture }> {
    const account = new FakeImapAccount([...PURELYMAIL_FOLDERS], { condstore: true, latencyMs });
    account.deliver("INBOX", plainMessage("Inbox 1"));
    account.deliver("Sent", plainMessage("Sent 1"), [IMAP_SEEN_FLAG]);
    account.deliver("Archive", plainMessage("Archive 1"), [IMAP_SEEN_FLAG]);
    const mailbox = await createImapMailboxFixture(runtime);
    await mailbox.sync(async () => account.client());
    return { account, mailbox };
  }

  /** A worker with concurrency 4 that runs `mailAccountSync` through the production handler. */
  async function startWorker(createImapClient: () => Promise<ImapMailClient>): Promise<void> {
    const moduleIds = await inTenant(() => withTransaction(runtime, (client) => resolveMailModuleIds(client)));
    runner = await runWorker({
      pgPool: admin,
      concurrency: 4,
      noHandleSignals: true,
      taskList: {
        [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC]: registerTask(
          CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC,
          async (payload, helpers) => {
            const { mailboxItemId } = z.object({ mailboxItemId: z.string() }).parse(payload);
            await handleSyncMailAccountTask(
              runtime,
              { mailboxItemId },
              { createImapClient },
              moduleIds,
              noAttachmentStorage,
              { job: { id: String(helpers.job.id) } },
            );
          },
        ),
      },
    });
  }

  /** Holds every pass at its folder listing until the test releases it, one hold per pass. */
  function holdListings(account: FakeImapAccount): Deferred[] {
    const holds: Deferred[] = [];
    account.gate = async (call: FakeImapCall) => {
      if (call.method !== "listFolders") return;
      const hold = deferred();
      holds.push(hold);
      openHolds.push(hold);
      await hold.promise;
    };
    return holds;
  }

  async function waitFor(predicate: () => Promise<boolean> | boolean, what: string): Promise<void> {
    await vi.waitFor(
      async () => {
        if (!(await predicate())) throw new Error(`still waiting for ${what}`);
      },
      { timeout: 10_000, interval: 10 },
    );
  }

  /** Every trigger job ran and ended: the running pass's own job is the only `mailAccountSync` job left. */
  const triggersDrained = async () => {
    const jobs = await syncJobs();
    return jobs.length === 1 && jobs[0]!.locked;
  };

  it("runs one pass at a time under a concurrency-4 worker and coalesces every trigger during a pass into one follow-up", async () => {
    const { account, mailbox } = await inTenant(() => syncedAccount());
    const trigger = () => inTenant(() => enqueueMailAccountSync(runtime, mailbox.mailboxId));
    const lease = () => inTenant(() => leaseOf(mailbox.mailboxId));
    const holds = holdListings(account);
    const { observed, createImapClient } = observedAccount(account);
    await startWorker(createImapClient);

    await trigger();
    await waitFor(() => holds.length === 1, "the first pass at its folder listing");

    for (let triggers = 0; triggers < 5; triggers++) {
      await trigger();
      await waitFor(triggersDrained, "the trigger to run");
    }
    expect(observed.started).toBe(1);
    expect(await lease()).toEqual({ rerun: true, leased: true });

    holds[0]!.resolve();
    await waitFor(() => holds.length === 2, "the one follow-up pass");
    expect(observed.started).toBe(2);

    // A trigger after the follow-up started gives exactly one more pass.
    await trigger();
    await waitFor(triggersDrained, "the trigger during the follow-up");
    holds[1]!.resolve();
    await waitFor(() => holds.length === 3, "the pass the last trigger asked for");
    holds[2]!.resolve();
    await waitFor(async () => (await syncJobs()).length === 0 && observed.active === 0, "the passes to end");

    expect(observed).toEqual({ started: 3, active: 0, maxActive: 1 });
    expect(await lease()).toEqual({ rerun: false, leased: false });
  }, 30_000);

  tenantIt(
    "answers a trigger during a pass without a provider call and lets the release enqueue exactly one keyed job",
    async () => {
      const { account, mailbox } = await syncedAccount();
      const holds = holdListings(account);
      const { observed, createImapClient } = observedAccount(account);

      const running = mailbox.sync(createImapClient);
      await waitFor(() => holds.length === 1, "the pass at its folder listing");
      const callsBefore = account.calls.length;

      await mailbox.sync(createImapClient);
      await mailbox.sync(createImapClient);

      expect(observed.started).toBe(1);
      expect(account.calls.length).toBe(callsBefore);
      expect(await leaseOf(mailbox.mailboxId)).toEqual({ rerun: true, leased: true });
      expect(await syncJobs()).toEqual([]);

      holds[0]!.resolve();
      await running;

      expect(await syncJobs()).toEqual([{ key: mailAccountSyncJobKey(mailbox.mailboxId), locked: false }]);
      expect(await leaseOf(mailbox.mailboxId)).toEqual({ rerun: false, leased: false });
    },
  );

  tenantIt("claims the lease of a holder that died once it expired", async () => {
    const { account, mailbox } = await syncedAccount();
    const { observed, createImapClient } = observedAccount(account);
    // A holder that never releases: a lease of 50 ms that nothing renews.
    expect(
      await withTransaction(runtime, (client) => claimMailSyncPass(client, mailbox.mailboxId, randomUUID(), 50)),
    ).toBe("claimed");

    await mailbox.sync(createImapClient);
    expect(observed.started).toBe(0);
    expect(await leaseOf(mailbox.mailboxId)).toEqual({ rerun: true, leased: true });

    await new Promise((resolve) => setTimeout(resolve, 100));
    account.deliver("INBOX", plainMessage("After the holder died"));
    await mailbox.sync(createImapClient);

    expect(observed.started).toBe(1);
    expect(await emailSubjects()).toContain("After the holder died");
    expect(await leaseOf(mailbox.mailboxId)).toEqual({ rerun: false, leased: false });
  });

  tenantIt("ends a pass whose lease another pass took and writes nothing more", async () => {
    const { account, mailbox } = await syncedAccount();
    const holds = holdListings(account);
    const { createImapClient } = observedAccount(account);
    account.deliver("INBOX", plainMessage("Delivered during the pass"));

    const running = mailbox.sync(createImapClient);
    await waitFor(() => holds.length === 1, "the pass at its folder listing");
    // Raw SQL for a state no API produces without waiting five minutes: the running pass's lease expires.
    await runtime.query(
      `UPDATE mail_account_sync_state SET pass_lease_expires_at = now() - interval '1 second'
       WHERE tenant_id = app_tenant_default() AND item_id = $1`,
      [mailbox.mailboxId],
    );
    const other = randomUUID();
    expect(
      await withTransaction(runtime, (client) => claimMailSyncPass(client, mailbox.mailboxId, other, 60_000)),
    ).toBe("claimed");
    holds[0]!.resolve();
    await running;

    expect(await emailSubjects()).not.toContain("Delivered during the pass");
    const { rows } = await runtime.query<{ token: string | null }>(
      `SELECT pass_lease_token AS token FROM mail_account_sync_state
       WHERE tenant_id = app_tenant_default() AND item_id = $1`,
      [mailbox.mailboxId],
    );
    expect(rows).toEqual([{ token: other }]);
  });

  it("imports a message signalled through IDLE while a pass runs right after that pass, selecting only INBOX", async () => {
    const LATENCY_MS = 80;
    const { account, mailbox } = await inTenant(() => syncedAccount(LATENCY_MS));
    const trigger = () => inTenant(() => enqueueMailAccountSync(runtime, mailbox.mailboxId));
    const subjects = () => inTenant(() => emailSubjects());
    // The running pass has work in Archive, where it is held while the delivery is signalled.
    account.deliver("Archive", plainMessage("Archive 2"), [IMAP_SEEN_FLAG]);
    const archiveHeld = deferred();
    openHolds.push(archiveHeld);
    const archiveReached = deferred();
    account.gate = async (call) => {
      if (call.method !== "selectFolder" || call.path !== "Archive") return;
      archiveReached.resolve();
      await archiveHeld.promise;
    };
    const { observed, createImapClient } = observedAccount(account);
    await startWorker(createImapClient);
    await trigger();
    await archiveReached.promise;

    // The server delivers to INBOX; the IDLE signal's only effect is the enqueue of the account's pass.
    account.deliver("INBOX", plainMessage("Signalled"));
    const signalledAt = performance.now();
    await trigger();
    await waitFor(triggersDrained, "the IDLE trigger to run");
    const followUpCalls = account.calls.length;
    archiveHeld.resolve();

    await waitFor(async () => (await subjects()).includes("Signalled"), "the signalled message");
    const visibleAfterMs = performance.now() - signalledAt;
    await waitFor(async () => (await syncJobs()).length === 0 && observed.active === 0, "the passes to end");

    expect(observed).toEqual({ started: 2, active: 0, maxActive: 1 });
    const folderCalls = account
      .callsSince(followUpCalls)
      .filter((call) => call.startsWith("selectFolder") || call.startsWith("fetch"));
    // The rest of the running pass (Archive), then the follow-up, which only looks at INBOX.
    expect(folderCalls.filter((call) => !call.endsWith("Archive"))).toEqual([
      "selectFolder INBOX",
      "fetchMessagesSince INBOX",
      "fetchFlagsChangedSince INBOX",
      "fetchAllUids INBOX",
    ]);
    // Nine client calls of 80 ms (three to finish the running pass, six of the follow-up) plus database work.
    expect(visibleAfterMs).toBeLessThan(2_000);
  }, 30_000);
});
