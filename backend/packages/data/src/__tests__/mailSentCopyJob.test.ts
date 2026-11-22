import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, registerTask, runOnce } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";
import { createMailDraftCreateRouteHandler, createMailDraftSendRouteHandler } from "../mail/mailDraftRouteHandlers.js";
import {
  handleMailSentCopyTask,
  MAIL_SENT_COPY_MAX_ATTEMPTS,
  mailSentCopyJobKey,
  recordPendingSentCopyAfterSend,
  type MailSentCopyTaskOptions,
} from "../mail/mailSentCopies.js";
import { mailPostSendSyncJobKey } from "../mail/mailSyncEnqueue.js";
import { upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import type { MailTransportMessage } from "../mail/mailTransport.js";
import { IMAP_SEEN_FLAG } from "../mail/messageFlags.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapAccount } from "../testSupport/fakeImapAccount.js";
import {
  createImapMailboxFixture,
  IMAP_FIXTURE_ACCOUNT,
  PURELYMAIL_FOLDERS,
  type ImapMailboxFixture,
} from "../testSupport/imapMailboxFixture.js";
import { sendAdapters, transportFor } from "../testSupport/mailSendFakes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// An SMTP account's Sent copy: the send records it with the send, a queue job appends it to the IMAP Sent folder.

let admin: Pool;
let runtime: Pool;
let tenant: string;
let userId: string;

const copyRowSchema = z.object({
  id: z.uuid(),
  message_id: z.string(),
  raw: z.instanceof(Buffer),
  failed: z.boolean(),
});
const jobRowSchema = z.object({ key: z.string().nullable(), max_attempts: z.number(), payload: z.unknown() });

interface Account {
  imap: FakeImapAccount;
  mailbox: ImapMailboxFixture;
  /** Every message the SMTP server accepted. */
  accepted: MailTransportMessage[];
  /** Runs right after the SMTP server accepted a message, before the send's finalization. */
  afterAccept: (() => Promise<void>) | undefined;
  /** The SMTP server refuses the next messages instead of accepting them. */
  refuse: boolean;
  /** The provider files the Sent copy itself, as Gmail and Graph do. */
  filesOwnSentCopy: boolean;
  send(subject: string): Promise<void>;
  /** The draft send route's answer, or its rejection, for one new draft. */
  postSend(subject: string): Promise<{ status: number }>;
}

describe("the Sent copy of an SMTP send", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    userId = (await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "x" }))
      .id;
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn));

  /** A synced password account whose SMTP server accepts everything and files no Sent copy. */
  async function connectAccount(): Promise<Account> {
    const imap = new FakeImapAccount([...PURELYMAIL_FOLDERS], { condstore: true });
    const mailbox = await createImapMailboxFixture(runtime);
    await upsertMailServerSettings(runtime, mailbox.mailboxId, {
      imap: { host: "imap.example.test", port: 993, security: "tls" },
      smtp: { host: "smtp.example.test", port: 465, security: "tls" },
      username: IMAP_FIXTURE_ACCOUNT,
    });
    await mailbox.sync(async () => imap.client());
    const accepted: MailTransportMessage[] = [];
    const adapters = sendAdapters(
      transportFor({
        async send(message) {
          if (account.refuse) throw new Error("550 recipient refused");
          accepted.push(message);
          await account.afterAccept?.();
          return account.filesOwnSentCopy ? {} : { needsSentCopy: true };
        },
      }),
    );
    const identity = { user: { id: userId, locale: "en" } };
    const postSend = async (subject: string) => {
      const created = await createMailDraftCreateRouteHandler(runtime, { maxFileSizeBytes: 1024 * 1024 })({
        identity,
        params: {},
        body: {
          mailboxId: mailbox.mailboxId,
          from: IMAP_FIXTURE_ACCOUNT,
          to: [{ name: "", address: "bob@example.test" }],
          cc: [],
          bcc: [],
          subject,
          body: "Hello",
        },
      });
      expect(created.status).toBe(201);
      return createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: adapters } })({
        identity,
        params: { id: created.body.id },
        body: undefined,
      });
    };
    const account: Account = {
      imap,
      mailbox,
      accepted,
      afterAccept: undefined,
      refuse: false,
      filesOwnSentCopy: false,
      postSend,
      send: async (subject) => {
        expect((await postSend(subject)).status).toBe(200);
      },
    };
    return account;
  }

  async function pendingCopies() {
    const { rows } = await runtime.query<Record<string, unknown>>(
      `SELECT id, message_id, raw, failed_at IS NOT NULL AS failed FROM mail_sent_copies
        WHERE tenant_id = app_tenant_default() ORDER BY created_at`,
    );
    return rows.map((row) => copyRowSchema.parse(row));
  }

  async function sentCopyJobs() {
    const { rows } = await admin.query<Record<string, unknown>>(
      `SELECT j.key, j.max_attempts, p.payload FROM graphile_worker.jobs j
         JOIN graphile_worker._private_jobs p ON p.id = j.id
        WHERE j.task_identifier = 'mailSentCopy' ORDER BY j.id`,
    );
    return rows.map((row) => jobRowSchema.parse(row));
  }

  /**
   * The mailbox's follow-up `mailAccountSync` jobs after a send, by slot, with their due time and enqueue count. Each is
   * a normal pass with its single attempt, so a failing server is not logged in to again by a retry.
   */
  async function postSendSyncJobs(mailboxId: string) {
    const { rows } = await admin.query<{
      key: string;
      run_at: Date;
      revision: number;
      max_attempts: number;
      payload: unknown;
    }>(
      `SELECT j.key, j.run_at, p.revision, j.max_attempts, p.payload FROM graphile_worker.jobs j
         JOIN graphile_worker._private_jobs p ON p.id = j.id
        WHERE j.task_identifier = 'mailAccountSync' AND j.key LIKE 'mail-account-sync-after-send:%' ORDER BY j.run_at`,
    );
    for (const row of rows) {
      expect(row.payload).toEqual(expect.objectContaining({ tenantId: tenant, payload: { mailboxItemId: mailboxId } }));
      expect(row.max_attempts).toBe(1);
    }
    return rows.map(({ key, run_at, revision }) => ({ key, runAt: run_at, revision }));
  }

  function expectDueAbout(runAt: Date, from: number, to: number, delayMs: number) {
    expect(runAt.getTime()).toBeGreaterThanOrEqual(from + delayMs - 1_000);
    expect(runAt.getTime()).toBeLessThanOrEqual(to + delayMs + 1_000);
  }

  async function openProblems() {
    const { rows } = await runtime.query<{
      kind: string;
      source_table: string;
      source_id: string;
      occurrence_count: number;
    }>(
      `SELECT kind, source_table, source_id, occurrence_count FROM semp_problems
        WHERE tenant_id = app_tenant_default() AND resolved_at IS NULL ORDER BY kind`,
    );
    return rows;
  }

  /** The copy's keyed job: `attempts` 0 is runnable again; equal to `max_attempts` it failed for good. */
  async function jobOf(copyId: string) {
    const { rows } = await admin.query<{ attempts: number; max_attempts: number }>(
      "SELECT attempts, max_attempts FROM graphile_worker.jobs WHERE key = $1",
      [mailSentCopyJobKey(copyId)],
    );
    return rows;
  }

  /**
   * The copy's final attempt fails as a refused APPEND would, and its job ends as graphile-worker leaves a job that
   * used up its attempts. The eight backed-off attempts are not waited for; the job row is set to their outcome.
   */
  async function failForGood(account: Account, copyId: string) {
    account.imap.gate = async (call) => {
      if (call.method === "appendMessage") throw new Error("[NO] Sent is over quota");
    };
    await expect(runCopy(account, copyId, { isFinalAttempt: true })).rejects.toThrow("[NO] Sent is over quota");
    account.imap.gate = undefined;
    const exhausted = await admin.query(
      "UPDATE graphile_worker._private_jobs SET attempts = max_attempts, last_error = 'refused' WHERE key = $1",
      [mailSentCopyJobKey(copyId)],
    );
    expect(exhausted.rowCount).toBe(1);
    expect(await jobOf(copyId)).toEqual([
      { attempts: MAIL_SENT_COPY_MAX_ATTEMPTS, max_attempts: MAIL_SENT_COPY_MAX_ATTEMPTS },
    ]);
  }

  const switchMail = async (mailboxId: string, mailEnabled: boolean) => {
    const mailboxes = (await createChokePoint(runtime).listDatabases()).find(
      (row) => row.ownerModuleId === "mailboxes",
    );
    await createChokePoint(runtime).updateItem(
      { databaseId: mailboxes!.id, itemId: mailboxId, propertiesPatch: { mailEnabled } },
      userId,
      userId,
      { writerKind: "user" },
    );
  };

  function runCopy(account: Account, copyId: string, options: Partial<MailSentCopyTaskOptions> = {}) {
    return handleMailSentCopyTask(
      runtime,
      { copyId },
      {
        jobId: randomUUID(),
        isFinalAttempt: false,
        openImap: async () => account.imap.client(),
        limiter: createImapConnectionLimiter(),
        ...options,
      },
    );
  }

  tenantIt("records the copy and its keyed job with the send, and the send opens no IMAP connection", async () => {
    const account = await connectAccount();
    const callsBefore = account.imap.calls.length;

    await account.send("Hello Bob");

    const [copy, ...others] = await pendingCopies();
    expect(others).toEqual([]);
    expect(copy?.raw).toEqual(account.accepted[0]?.raw);
    expect(copy?.failed).toBe(false);
    expect(await sentCopyJobs()).toEqual([
      {
        key: mailSentCopyJobKey(copy!.id),
        max_attempts: MAIL_SENT_COPY_MAX_ATTEMPTS,
        payload: expect.objectContaining({ tenantId: tenant, payload: { copyId: copy!.id } }),
      },
    ]);
    expect(account.imap.calls.length).toBe(callsBefore);
    expect(account.imap.countIn("Sent")).toBe(0);
  });

  it("appends the copy once from the queued job after the process died between the accept and the APPEND", async () => {
    const account = await runInTenant(tenant, () => connectAccount());
    await runInTenant(tenant, () => account.send("Hello Bob"));
    // Nothing of the sending process survives: only the committed row and the queued job.
    await runOnce(
      { pgPool: admin, noHandleSignals: true },
      {
        [CORE_TASK_NAMES.MAIL_SENT_COPY]: registerTask(CORE_TASK_NAMES.MAIL_SENT_COPY, async (payload, helpers) => {
          const { copyId } = z.object({ copyId: z.uuid() }).parse(payload);
          await runCopy(account, copyId, { jobId: String(helpers.job.id) });
        }),
      },
    );

    expect(account.imap.countIn("Sent")).toBe(1);
    expect([...account.imap.flagsIn("Sent").values()]).toEqual([[IMAP_SEEN_FLAG]]);
    expect(await runInTenant(tenant, () => pendingCopies())).toEqual([]);
    expect(await sentCopyJobs()).toEqual([]);
  });

  tenantIt("appends nothing twice when a run repeats after an APPEND whose deletion did not commit", async () => {
    const account = await connectAccount();
    await account.send("Hello Bob");
    const [copy] = await pendingCopies();
    // The earlier run's APPEND reached the server; its process died before the row was deleted.
    account.imap.deliver("Sent", account.accepted[0]!.raw, [IMAP_SEEN_FLAG]);
    const callsBefore = account.imap.calls.length;

    await runCopy(account, copy!.id);
    await runCopy(account, copy!.id);

    expect(account.imap.countIn("Sent")).toBe(1);
    expect(account.imap.callsSince(callsBefore)).toEqual(["hasMessageWithId Sent"]);
    expect(await pendingCopies()).toEqual([]);
  });

  tenantIt(
    "keeps a copy whose APPEND is refused for the retry, raises the mailbox's problem on the final attempt, and resolves it once a copy is appended",
    async () => {
      const account = await connectAccount();
      await account.send("Hello Bob");
      const [copy] = await pendingCopies();
      account.imap.gate = async (call) => {
        if (call.method === "appendMessage") throw new Error("[NO] Sent is over quota");
      };

      await expect(runCopy(account, copy!.id)).rejects.toThrow("[NO] Sent is over quota");
      expect(await pendingCopies()).toEqual([expect.objectContaining({ id: copy!.id, failed: false })]);
      expect(await openProblems()).toEqual([]);

      await failForGood(account, copy!.id);
      expect(await pendingCopies()).toEqual([expect.objectContaining({ id: copy!.id, failed: true })]);
      // The mailbox's sync state row, keyed by the mailbox id, is the source the problem names.
      expect(await openProblems()).toEqual([
        {
          kind: "mailSentCopyFailed",
          source_table: "mail_account_sync_state",
          source_id: account.mailbox.mailboxId,
          occurrence_count: 1,
        },
      ]);
      expect(account.imap.countIn("Sent")).toBe(0);

      // The server takes copies again: the next send's copy goes in and the failed one gets a runnable job again.
      await account.send("Hello again");
      const [, next] = await pendingCopies();
      await runCopy(account, next!.id);

      expect(account.imap.countIn("Sent")).toBe(1);
      expect(await pendingCopies()).toEqual([expect.objectContaining({ id: copy!.id, failed: false })]);
      expect(await jobOf(copy!.id)).toEqual([{ attempts: 0, max_attempts: MAIL_SENT_COPY_MAX_ATTEMPTS }]);
      expect(await openProblems()).toHaveLength(1);

      await runCopy(account, copy!.id);

      expect(account.imap.countIn("Sent")).toBe(2);
      expect(await pendingCopies()).toEqual([]);
      expect(await openProblems()).toEqual([]);
    },
  );

  tenantIt(
    "gives the copies that gave up a runnable job again after a completed sync pass of the mailbox",
    async () => {
      const account = await connectAccount();
      await account.send("Hello Bob");
      const [copy] = await pendingCopies();
      await failForGood(account, copy!.id);

      await account.mailbox.sync(async () => account.imap.client());

      expect(await pendingCopies()).toEqual([expect.objectContaining({ id: copy!.id, failed: false })]);
      expect(await jobOf(copy!.id)).toEqual([{ attempts: 0, max_attempts: MAIL_SENT_COPY_MAX_ATTEMPTS }]);
      await runCopy(account, copy!.id);
      expect(account.imap.countIn("Sent")).toBe(1);
      expect(await openProblems()).toEqual([]);
    },
  );

  tenantIt(
    "drops every copy of a mailbox that was put in the trash without an APPEND and resolves its problem",
    async () => {
      const account = await connectAccount();
      await account.send("Hello Bob");
      await account.send("Hello again");
      const [failed, pending] = await pendingCopies();
      await failForGood(account, failed!.id);
      const mailboxes = (await createChokePoint(runtime).listDatabases()).find(
        (row) => row.ownerModuleId === "mailboxes",
      );
      await createChokePoint(runtime).softDeleteItem(mailboxes!.id, account.mailbox.mailboxId);

      await runCopy(account, pending!.id);

      expect(account.imap.countIn("Sent")).toBe(0);
      expect(await pendingCopies()).toEqual([]);
      expect(await openProblems()).toEqual([]);
    },
  );

  tenantIt("drops every copy of a mailbox whose Mail is switched off and resolves its problem", async () => {
    const account = await connectAccount();
    await account.send("Hello Bob");
    await account.send("Hello again");
    const [failed] = await pendingCopies();
    await failForGood(account, failed!.id);
    expect(await openProblems()).toHaveLength(1);

    await switchMail(account.mailbox.mailboxId, false);

    expect(await pendingCopies()).toEqual([]);
    expect(await openProblems()).toEqual([]);
  });

  tenantIt(
    "records the copy on its own when the send's finalization fails after the server accepted the message",
    async () => {
      const account = await connectAccount();
      // The draft disappears between the acceptance and the finalization, which then cannot move it to Sent.
      account.afterAccept = async () => {
        await admin.query("UPDATE items SET deleted_at = now() WHERE tenant_id = $1 AND properties->>'name' = $2", [
          tenant,
          "Lost on the way",
        ]);
      };

      await expect(account.postSend("Lost on the way")).rejects.toThrow();

      const [copy, ...others] = await pendingCopies();
      expect(others).toEqual([]);
      expect(copy?.raw).toEqual(account.accepted[0]?.raw);
      expect(await jobOf(copy!.id)).toEqual([{ attempts: 0, max_attempts: MAIL_SENT_COPY_MAX_ATTEMPTS }]);
    },
  );

  tenantIt("schedules exactly the two follow-up syncs about 15 s and 60 s after an accepted send", async () => {
    const account = await connectAccount();
    const before = Date.now();
    await account.send("Hello Bob");
    const after = Date.now();

    const jobs = await postSendSyncJobs(account.mailbox.mailboxId);
    expect(jobs.map(({ key, revision }) => ({ key, revision }))).toEqual([
      { key: mailPostSendSyncJobKey(account.mailbox.mailboxId, 15_000), revision: 0 },
      { key: mailPostSendSyncJobKey(account.mailbox.mailboxId, 60_000), revision: 0 },
    ]);
    expectDueAbout(jobs[0]!.runAt, before, after, 15_000);
    expectDueAbout(jobs[1]!.runAt, before, after, 60_000);
  });

  tenantIt("keeps one follow-up per slot, at its first due time, for sends while the slots are pending", async () => {
    const account = await connectAccount();
    await account.send("First");
    const first = await postSendSyncJobs(account.mailbox.mailboxId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await account.send("Second");
    await account.send("Third");

    expect(account.accepted).toHaveLength(3);
    const jobs = await postSendSyncJobs(account.mailbox.mailboxId);
    expect(jobs.map(({ key, runAt }) => ({ key, runAt }))).toEqual(first.map(({ key, runAt }) => ({ key, runAt })));
    expect(jobs.map(({ revision }) => revision)).toEqual([2, 2]);
  });

  tenantIt("schedules no follow-up for a send the server refuses", async () => {
    const account = await connectAccount();
    account.refuse = true;
    await expect(account.postSend("Refused")).rejects.toThrow("550 recipient refused");
    expect(account.accepted).toEqual([]);
    expect(await postSendSyncJobs(account.mailbox.mailboxId)).toEqual([]);
  });

  tenantIt("schedules no follow-up for a send whose provider files its own Sent copy", async () => {
    const account = await connectAccount();
    account.filesOwnSentCopy = true;
    await account.send("Filed by the provider");
    expect(account.accepted).toHaveLength(1);
    expect(await postSendSyncJobs(account.mailbox.mailboxId)).toEqual([]);
  });

  tenantIt(
    "schedules the follow-ups with a copy recorded after the send, as an invitation job records it",
    async () => {
      const account = await connectAccount();
      const recorded = await recordPendingSentCopyAfterSend(runtime, {
        mailboxItemId: account.mailbox.mailboxId,
        messageId: `<${randomUUID()}@example.test>`,
        raw: Buffer.from("Subject: Invitation\r\n\r\nbody\r\n"),
      });
      expect(recorded).toBe(true);
      expect((await postSendSyncJobs(account.mailbox.mailboxId)).map(({ key }) => key)).toEqual([
        mailPostSendSyncJobKey(account.mailbox.mailboxId, 15_000),
        mailPostSendSyncJobKey(account.mailbox.mailboxId, 60_000),
      ]);
    },
  );
});
