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
  type MailSentCopyTaskOptions,
} from "../mail/mailSentCopies.js";
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
  send(subject: string): Promise<void>;
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
          accepted.push(message);
          return { needsSentCopy: true };
        },
      }),
    );
    const identity = { user: { id: userId, locale: "en" } };
    const send = async (subject: string) => {
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
      const sent = await createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: adapters } })({
        identity,
        params: { id: created.body.id },
        body: undefined,
      });
      expect(sent.status).toBe(200);
    };
    return { imap, mailbox, accepted, send };
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

  async function openProblems() {
    const { rows } = await runtime.query<{ kind: string; source_id: string; occurrence_count: number }>(
      `SELECT kind, source_id, occurrence_count FROM semp_problems
        WHERE tenant_id = app_tenant_default() AND resolved_at IS NULL ORDER BY kind`,
    );
    return rows;
  }

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

      await expect(runCopy(account, copy!.id, { isFinalAttempt: true })).rejects.toThrow("[NO] Sent is over quota");
      expect(await pendingCopies()).toEqual([expect.objectContaining({ id: copy!.id, failed: true })]);
      expect(await openProblems()).toEqual([
        { kind: "mailSentCopyFailed", source_id: account.mailbox.mailboxId, occurrence_count: 1 },
      ]);
      expect(account.imap.countIn("Sent")).toBe(0);

      // The server takes copies again: the next send's copy goes in and the failed one gets a new job.
      account.imap.gate = undefined;
      await account.send("Hello again");
      const [, next] = await pendingCopies();
      await runCopy(account, next!.id);

      expect(account.imap.countIn("Sent")).toBe(1);
      expect(await pendingCopies()).toEqual([expect.objectContaining({ id: copy!.id, failed: false })]);
      expect(await sentCopyJobs()).toContainEqual(expect.objectContaining({ key: mailSentCopyJobKey(copy!.id) }));
      expect(await openProblems()).toHaveLength(1);

      await runCopy(account, copy!.id);

      expect(account.imap.countIn("Sent")).toBe(2);
      expect(await pendingCopies()).toEqual([]);
      expect(await openProblems()).toEqual([]);
    },
  );

  tenantIt("ends a copy of a mailbox that was put in the trash without an APPEND", async () => {
    const account = await connectAccount();
    await account.send("Hello Bob");
    const [copy] = await pendingCopies();
    const mailboxes = (await createChokePoint(runtime).listDatabases()).find(
      (row) => row.ownerModuleId === "mailboxes",
    );
    await createChokePoint(runtime).softDeleteItem(mailboxes!.id, account.mailbox.mailboxId);

    await runCopy(account, copy!.id);

    expect(account.imap.countIn("Sent")).toBe(0);
    expect(await pendingCopies()).toEqual([]);
  });
});
