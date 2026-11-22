import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant, type AiGatewayCompletionInput } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { GmailRestClient } from "../mail/gmailRestClient.js";
import { GraphRestClient } from "../mail/graphRestClient.js";
import { createImapSessionPool, type ImapSessionPool } from "../mail/imapSessionPool.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { createMailThreadGetUserTool } from "../mail/mailAgentTools.js";
import { createMailAttachmentSaveRouteHandler } from "../mail/mailAttachmentSave.js";
import { handleMailContentCacheSweepTask } from "../mail/mailContentCacheSweep.js";
import { writeMailContentCache } from "../mail/mailContentCacheStore.js";
import {
  createMailMessageContentRouteHandler,
  type MailContentProviders,
  type MailContentRouteDependencies,
} from "../mail/mailMessageContent.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { getMailThreadDetail } from "../mail/mailThreadDetail.js";
import { MailReauthorizationRequiredError } from "../mail/providerTypes.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { evaluateAnswerExpectedFilter } from "../scheduler/answerExpectedFilter.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapServer } from "../testSupport/fakeImapServer.js";
import {
  connectLoopbackImapClient,
  createImapMailboxFixture,
  IMAP_FIXTURE_ACCOUNT,
  plainMessage,
} from "../testSupport/imapMailboxFixture.js";
import { recordingStorage } from "../testSupport/mailAttachmentFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const QRESYNC = ["ENABLE", "IDLE", "CONDSTORE", "QRESYNC", "MOVE", "UIDPLUS", "SPECIAL-USE"];
const FOLDERS = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "Archive", specialUse: "\\Archive" },
] as const;
const USER_ID = randomUUID();
const PDF = Buffer.from(`%PDF-1.4 ${"report ".repeat(200)}`);
const HTML = '<p>Dobrý den, <b>old offer</b></p><img src="https://tracker.example.test/pixel.png">';

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;
let storageRoot: string;
const servers: FakeImapServer[] = [];
const sessionPools: ImapSessionPool[] = [];

/**
 * `HTML` as a quoted-printable part and a base64 PDF, dated 200 days ago (so indexed) unless `date` is given.
 */
function oldMessage(messageId: string, subject = "Old offer", date = new Date(Date.now() - 200 * DAY_MS)): Buffer {
  return Buffer.from(
    [
      `Message-ID: ${messageId}`,
      "From: Sender <sender@sender.example.test>",
      `To: ${IMAP_FIXTURE_ACCOUNT}`,
      `Subject: ${subject}`,
      `Date: ${date.toUTCString()}`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="part-boundary"',
      "",
      "--part-boundary",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "<p>Dobr=C3=BD den, <b>old offer</b></p>=",
      '<img src=3D"https://tracker.example.test/pixel.png">',
      "--part-boundary",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      ...(PDF.toString("base64").match(/.{1,76}/g) ?? []),
      "--part-boundary--",
      "",
    ].join("\r\n"),
  );
}

const metaRow = z.object({ item_id: z.uuid(), thread_id: z.uuid(), content_state: z.string() });

async function messageByMessageId(messageId: string) {
  const { rows } = await runtime.query<Record<string, unknown>>(
    "SELECT item_id, thread_id, content_state FROM mail_message_meta WHERE message_id = $1",
    [messageId],
  );
  return metaRow.parse(rows[0]);
}

async function attachmentOf(emailId: string) {
  const { rows } = await runtime.query<{ id: string; blob_id: string | null; byte_size: string }>(
    "SELECT id, blob_id, byte_size::text FROM mail_attachments WHERE message_item_id = $1",
    [emailId],
  );
  const [row] = rows;
  if (!row) throw new Error("No attachment row");
  return row;
}

async function cacheRows(emailId: string) {
  const { rows } = await runtime.query<{ body_html: string | null; expired: boolean }>(
    "SELECT body_html, expires_at <= now() AS expired FROM mail_message_content_cache WHERE item_id = $1",
    [emailId],
  );
  return rows;
}

/** A throttle granting `limit` fetches, then refusing; counts the fetches it was asked for. */
function countingThrottle(limit = Number.MAX_SAFE_INTEGER) {
  const asked: string[] = [];
  return {
    asked,
    throttle: {
      tryAcquire(action: "mailContentFetch", userId: string) {
        asked.push(`${action}:${userId}`);
        return asked.length <= limit ? { granted: true as const } : { granted: false as const, retryAfterSeconds: 42 };
      },
    },
  };
}

interface ImapAccount {
  server: FakeImapServer;
  mailboxId: string;
  /** How many connections the providers opened. */
  connects: { count: number };
  providers: MailContentProviders;
  pass(): Promise<void>;
  /** Body parts the server read from INBOX since `from`, as `<uid>:<section>` (sorted). */
  reads(from?: number): string[];
}

/** A generic IMAP account whose sync and on-demand reads both go to one loopback server. */
async function imapAccount(): Promise<ImapAccount> {
  const server = new FakeImapServer({ folders: FOLDERS, capabilities: QRESYNC, latencyMs: 0 });
  servers.push(server);
  const port = await server.listen();
  const mailbox = await createImapMailboxFixture(runtime);
  const sessions = createImapSessionPool();
  sessionPools.push(sessions);
  const connects = { count: 0 };
  const syncStorage = recordingStorage();
  return {
    server,
    mailboxId: mailbox.mailboxId,
    connects,
    providers: {
      // As the composition root's: the account's kept session, or a new connection under the connection limiter.
      createImapClient: (mailboxItemId, credential, accountLimit) =>
        sessions.checkout({
          mailboxItemId,
          accountLimit,
          host: "127.0.0.1",
          signIn: credential,
          connect: async () => {
            connects.count++;
            return connectLoopbackImapClient(port);
          },
        }),
      attachmentStorage: new LocalFsBlobStorageWriter(storageRoot),
    },
    pass: () => mailbox.sync(() => connectLoopbackImapClient(port), syncStorage),
    reads: (from = 0) =>
      server.bodyFetches
        .slice(from)
        .filter((read) => read.path === "INBOX")
        .map((read) => `${read.uid}:${read.section}`)
        .sort(),
  };
}

function readContent(dependencies: MailContentRouteDependencies, emailId: string, query = "") {
  return createMailMessageContentRouteHandler(
    runtime,
    dependencies,
  )({
    params: { emailId },
    req: { url: `/api/mail/messages/${emailId}/content${query}` },
    identity: { user: { id: USER_ID } },
  });
}

function saveAttachment(dependencies: MailContentRouteDependencies, emailId: string, attachmentId: string) {
  return createMailAttachmentSaveRouteHandler(
    runtime,
    dependencies,
  )({
    params: { emailId, attachmentId },
    identity: { user: { id: USER_ID } },
  });
}

/** A `format=full` Gmail message with a text body and one attachment at `partId`, named by `attachmentId`. */
function gmailMessageWithAttachment(id: string, partId: string, filename: string, attachmentId: string) {
  return {
    id,
    threadId: `${id}-thread`,
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      headers: [{ name: "Message-ID", value: `<${id}@gmail.example.test>` }],
      parts: [
        { partId: "0", mimeType: "text/plain", body: { size: 4, data: Buffer.from("Body").toString("base64url") } },
        {
          partId,
          mimeType: "text/plain",
          filename,
          headers: [{ name: "Content-Disposition", value: `attachment; filename="${filename}"` }],
          body: { size: 5, attachmentId },
        },
      ],
    },
  };
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** What a refused call answers: its status, code, message and details. */
async function refusal(call: Promise<unknown>) {
  const error: unknown = await call.then(
    () => null,
    (value: unknown) => value,
  );
  if (!(error instanceof Error)) throw new Error("Expected a refusal");
  return z
    .object({ status: z.number(), code: z.string(), message: z.string(), details: z.unknown().optional() })
    .parse(error);
}

describe("message content and attachments on demand", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(other, () => seedSystem(runtime));
    storageRoot = await mkdtemp(join(tmpdir(), "semprec-mail-content-"));
  });

  afterEach(async () => {
    for (const sessions of sessionPools.splice(0)) await sessions.close();
    for (const server of servers.splice(0)) await server.close();
    await rm(storageRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn), 60_000);

  /** An IMAP account holding one indexed message, synced once. */
  async function indexedImapMessage() {
    const account = await imapAccount();
    const messageId = `<${randomUUID()}@sender.example.test>`;
    account.server.deliver("INBOX", [], oldMessage(messageId));
    await account.pass();
    const message = await messageByMessageId(messageId);
    expect(message.content_state).toBe("index");
    return { ...account, messageId, emailId: message.item_id, threadId: message.thread_id };
  }

  describe("GET /api/mail/messages/:emailId/content", () => {
    tenantIt("answers a full message's stored body sanitized, with remote images only when asked", async () => {
      const account = await imapAccount();
      const messageId = `<${randomUUID()}@sender.example.test>`;
      account.server.deliver("INBOX", [], plainMessage("Recent", { messageId }));
      await account.pass();
      const { item_id: emailId } = await messageByMessageId(messageId);
      const { asked, throttle } = countingThrottle();

      const answer = await readContent({ throttle }, emailId);

      expect(answer).toEqual({
        status: 200,
        body: {
          emailId,
          contentState: "full",
          bodyHtml: expect.stringContaining("Recent body"),
          bodyText: expect.stringContaining("Recent body"),
          fetchedAt: null,
          expiresAt: null,
          attachments: [],
        },
      });
      // A stored body asks nothing of the provider and counts no fetch.
      expect(account.connects.count).toBe(0);
      expect(asked).toEqual([]);
    });

    tenantIt("lists a full message's attachments with their blob and Files item", async () => {
      const account = await imapAccount();
      const messageId = `<${randomUUID()}@sender.example.test>`;
      account.server.deliver("INBOX", [], oldMessage(messageId, "Recent offer", new Date()));
      await account.pass();
      const { item_id: emailId, thread_id: threadId, content_state } = await messageByMessageId(messageId);
      expect(content_state).toBe("full");
      const stored = await attachmentOf(emailId);

      const answer = await readContent({ throttle: countingThrottle().throttle }, emailId);

      const { email } = await filesLinkedFrom(emailId, threadId);
      expect(answer.body.attachments).toEqual([
        {
          attachmentId: stored.id,
          filename: "report.pdf",
          contentType: "application/pdf",
          byteSize: PDF.length,
          stored: true,
          blobId: stored.blob_id,
          fileItemId: email[0],
        },
      ]);
      expect(stored.blob_id).not.toBeNull();
      expect(email).toHaveLength(1);
    });

    tenantIt(
      "fetches an indexed message from its folder by UID, caches it for seven days and serves the cache next",
      async () => {
        const account = await indexedImapMessage();
        const { asked, throttle } = countingThrottle();
        const dependencies = { mailContent: account.providers, throttle };
        const before = await withTransaction(runtime, (client) => getMailThreadDetail(client, account.threadId, false));
        expect(before.messages).toEqual([
          expect.objectContaining({
            contentState: "remote",
            bodyHtml: "",
            bodyText: "",
            preview: "Dobrý den, old offer",
          }),
        ]);
        const from = account.server.bodyFetches.length;

        const first = await readContent(dependencies, account.emailId);

        const attachment = await attachmentOf(account.emailId);
        expect(first.body).toMatchObject({
          emailId: account.emailId,
          contentState: "cached",
          bodyText: "Dobrý den, old offer",
          // Listed from its metadata; the body fetch reads no attachment bytes.
          attachments: [
            {
              attachmentId: attachment.id,
              filename: "report.pdf",
              contentType: "application/pdf",
              byteSize: Number(attachment.byte_size),
              stored: false,
              blobId: null,
              fileItemId: null,
            },
          ],
        });
        expect(first.body.bodyHtml).toContain("<b>old offer</b>");
        expect(first.body.bodyHtml).not.toContain("tracker.example.test");
        const fetchedAt = Date.parse(first.body.fetchedAt ?? "");
        expect(Date.parse(first.body.expiresAt ?? "") - fetchedAt).toBe(7 * DAY_MS);
        // The HTML part only, never the attachment.
        expect(account.reads(from)).toEqual(["1:1"]);
        expect(await cacheRows(account.emailId)).toEqual([{ body_html: HTML, expired: false }]);
        expect(asked).toEqual([`mailContentFetch:${USER_ID}`]);

        const second = await readContent(dependencies, account.emailId, "?allowRemoteImages=true");
        expect(second.body).toMatchObject({ contentState: "cached", fetchedAt: first.body.fetchedAt });
        expect(second.body.bodyHtml).toContain("tracker.example.test");
        expect(account.reads(from)).toEqual(["1:1"]);
        expect(asked).toHaveLength(1);
        expect(account.connects.count).toBe(1);

        const after = await withTransaction(runtime, (client) => getMailThreadDetail(client, account.threadId, false));
        expect(after.messages).toEqual([
          expect.objectContaining({
            contentState: "cached",
            bodyText: "Dobrý den, old offer",
            preview: "Dobrý den, old offer",
          }),
        ]);
      },
    );

    tenantIt("fetches again once the cached copy expired and replaces the row", async () => {
      const account = await indexedImapMessage();
      const dependencies = { mailContent: account.providers, throttle: countingThrottle().throttle };
      await readContent(dependencies, account.emailId);
      // No production writer lets a row expire early.
      await runtime.query(
        `UPDATE mail_message_content_cache SET fetched_at = now() - interval '8 days', expires_at = now() - interval '1 day'
          WHERE item_id = $1`,
        [account.emailId],
      );
      const detail = await withTransaction(runtime, (client) => getMailThreadDetail(client, account.threadId, false));
      expect(detail.messages).toEqual([expect.objectContaining({ contentState: "remote", bodyText: "" })]);
      const from = account.server.bodyFetches.length;

      const answer = await readContent(dependencies, account.emailId);

      expect(answer.body.contentState).toBe("cached");
      expect(account.reads(from)).toEqual(["1:1"]);
      expect(await cacheRows(account.emailId)).toEqual([{ body_html: HTML, expired: false }]);
    });

    it.each([
      {
        name: "the message got another UID in its folder",
        change: (server: FakeImapServer) => server.move("Archive", server.move("INBOX", 1, "Archive"), "INBOX"),
        uid: "2",
      },
      {
        name: "the folder's UIDVALIDITY changed",
        change: (server: FakeImapServer) => server.resetUidValidity("INBOX", 101),
        uid: "101",
      },
    ])("finds the message by its Message-ID when $name", ({ change, uid }) =>
      runInTenant(tenant, async () => {
        const account = await indexedImapMessage();
        change(account.server);
        const from = account.server.bodyFetches.length;
        const searches = account.server.commands.length;

        const answer = await readContent(
          { mailContent: account.providers, throttle: countingThrottle().throttle },
          account.emailId,
        );

        expect(answer.body).toMatchObject({ contentState: "cached", bodyText: "Dobrý den, old offer" });
        expect(account.reads(from)).toEqual([`${uid}:1`]);
        expect(account.server.commands.slice(searches)).toContain("SEARCH");
      }),
    );

    tenantIt(
      "never reads another message through a UID of a replaced UIDVALIDITY before the backfill finds it again",
      async () => {
        const account = await imapAccount();
        const expungedId = `<${randomUUID()}@sender.example.test>`;
        const keptId = `<${randomUUID()}@sender.example.test>`;
        account.server.deliver("INBOX", [], oldMessage(expungedId, "Expunged offer"));
        account.server.deliver("INBOX", [], oldMessage(keptId, "Kept offer"));
        await account.pass();
        const expunged = await messageByMessageId(expungedId);
        const kept = await messageByMessageId(keptId);
        // Renumbered from 1 without the first message: the kept one now has the expunged one's UID.
        account.server.expunge("INBOX", 1);
        account.server.resetUidValidity("INBOX", 1);
        // The pass establishes the folder anew in its live step (the first SELECT), then fails at the search of its
        // backfill (after the second), before finding any message again.
        let selects = 0;
        account.server.beforeCommand = (verb) => {
          if (verb === "SELECT" && ++selects === 2) account.server.refusedVerbs.add("SEARCH");
        };
        await expect(account.pass()).rejects.toThrow();
        account.server.beforeCommand = undefined;
        account.server.refusedVerbs.delete("SEARCH");
        const dependencies = { mailContent: account.providers, throttle: countingThrottle().throttle };

        const gone = await refusal(readContent(dependencies, expunged.item_id));
        const found = await readContent(dependencies, kept.item_id);

        expect(gone).toMatchObject({ status: 409, details: { reason: "messageNotFound" } });
        expect(await cacheRows(expunged.item_id)).toEqual([]);
        expect(found.body).toMatchObject({ contentState: "cached", bodyText: "Dobrý den, old offer" });
      },
    );

    /** An indexed message filed in both folders, and the folder of the edge the content read tries first. */
    async function messageInBothFolders() {
      const account = await imapAccount();
      const messageId = `<${randomUUID()}@sender.example.test>`;
      for (const path of ["INBOX", "Archive"]) account.server.deliver(path, [], oldMessage(messageId));
      await account.pass();
      const { item_id: emailId } = await messageByMessageId(messageId);
      // Both edges carry a UID, so the read takes them in folder id order.
      const { rows } = await runtime.query<{ path: string }>(
        `SELECT properties->>'providerId' AS path FROM items
          WHERE tenant_id = app_tenant_default() AND properties->>'providerId' IN ('INBOX', 'Archive') ORDER BY id`,
      );
      const [first, second] = rows.map((row) => row.path);
      if (first === undefined || second === undefined) throw new Error("Both folders are synced");
      return { account, emailId, first, second };
    }

    tenantIt("passes over a folder the server no longer holds and reads the message from its next folder", async () => {
      const { account, emailId, first, second } = await messageInBothFolders();
      account.server.deleteFolder(first);
      const before = account.server.bodyFetches.length;

      const answer = await readContent(
        { mailContent: account.providers, throttle: countingThrottle().throttle },
        emailId,
      );

      expect(answer.body).toMatchObject({ contentState: "cached", bodyText: "Dobrý den, old offer" });
      expect(account.server.bodyFetches.slice(before).map((read) => read.path)).toEqual([second]);
    });

    tenantIt("answers providerUnreachable when the connection drops at a folder's selection", async () => {
      const { account, emailId } = await messageInBothFolders();
      account.server.droppedVerbs.add("SELECT");

      const answer = await refusal(
        readContent({ mailContent: account.providers, throttle: countingThrottle().throttle }, emailId),
      );

      expect(answer).toMatchObject({ status: 409, details: { reason: "providerUnreachable" } });
      expect(await cacheRows(emailId)).toEqual([]);
    });

    it.each([
      {
        name: "the server fails the fetch",
        reason: "providerUnreachable",
        arrange: (account: ImapAccount) => account.server.refusedVerbs.add("FETCH"),
      },
      {
        name: "the server refuses the stored sign-in",
        reason: "reauthorizationRequired",
        arrange: (account: ImapAccount) => {
          account.providers.createImapClient = () =>
            Promise.reject(new MailReauthorizationRequiredError("The IMAP server rejected the stored login"));
        },
      },
      {
        name: "the server no longer holds the message",
        reason: "messageNotFound",
        arrange: (account: ImapAccount) => account.server.expunge("INBOX", 1),
      },
    ])("answers 409 mail_content_unavailable and caches nothing when $name", ({ reason, arrange }) =>
      runInTenant(tenant, async () => {
        const account = await indexedImapMessage();
        arrange(account);

        const answer = await refusal(
          readContent({ mailContent: account.providers, throttle: countingThrottle().throttle }, account.emailId),
        );

        expect(answer).toMatchObject({ status: 409, code: "mail_content_unavailable", details: { reason } });
        expect(await cacheRows(account.emailId)).toEqual([]);
      }),
    );

    tenantIt("refuses an account waiting for a new sign-in without contacting the provider", async () => {
      const account = await indexedImapMessage();
      // A sync pass records this when the server refuses the login.
      await runtime.query(
        "UPDATE mail_account_sync_state SET last_failure_kind = 'reauthorization' WHERE item_id = $1",
        [account.mailboxId],
      );
      const { asked, throttle } = countingThrottle();

      const answer = await refusal(readContent({ mailContent: account.providers, throttle }, account.emailId));

      expect(answer).toMatchObject({ status: 409, details: { reason: "reauthorizationRequired" } });
      expect(account.connects.count).toBe(0);
      expect(asked).toEqual([]);
    });

    tenantIt("shares one provider fetch between concurrent reads of the message", async () => {
      const account = await indexedImapMessage();
      const { asked, throttle } = countingThrottle();
      const dependencies = { mailContent: account.providers, throttle };
      const from = account.server.bodyFetches.length;

      const answers = await Promise.all([1, 2, 3].map(() => readContent(dependencies, account.emailId)));

      expect(new Set(answers.map((answer) => answer.body.fetchedAt)).size).toBe(1);
      expect(account.reads(from)).toEqual(["1:1"]);
      expect(account.connects.count).toBe(1);
      expect(asked).toHaveLength(1);
      expect(await cacheRows(account.emailId)).toHaveLength(1);
    });

    tenantIt("refuses a fetch over the user's throttle with 429 and asks the provider nothing", async () => {
      const account = await indexedImapMessage();
      const { throttle } = countingThrottle(0);

      const answer = await refusal(readContent({ mailContent: account.providers, throttle }, account.emailId));

      expect(answer).toMatchObject({ status: 429, code: "rate_limited" });
      expect(account.connects.count).toBe(0);
      expect(await cacheRows(account.emailId)).toEqual([]);
    });

    it("answers another tenant's message, a trashed one and a random id exactly alike", async () => {
      const account = await runInTenant(tenant, indexedImapMessage);
      const { throttle } = countingThrottle();
      const dependencies = { mailContent: account.providers, throttle };
      const random = await runInTenant(other, () => refusal(readContent(dependencies, randomUUID())));
      expect(random).toMatchObject({ status: 404, code: "not_found" });

      expect(await runInTenant(other, () => refusal(readContent(dependencies, account.emailId)))).toEqual(random);
      expect(
        await runInTenant(other, () => refusal(saveAttachment(dependencies, account.emailId, randomUUID()))),
      ).toEqual(random);
      const { id: attachmentId } = await runInTenant(tenant, () => attachmentOf(account.emailId));
      const foreignSave = await runInTenant(other, () =>
        refusal(saveAttachment(dependencies, account.emailId, attachmentId)),
      );
      const randomSave = await runInTenant(other, () =>
        refusal(saveAttachment(dependencies, randomUUID(), randomUUID())),
      );
      expect(foreignSave).toEqual(randomSave);

      expect(account.connects.count).toBe(0);
      // The owner reads it, so the refusals above are not a broken route.
      await runInTenant(tenant, async () => {
        expect((await readContent(dependencies, account.emailId)).body.contentState).toBe("cached");
        await withTransaction(runtime, async (client) => {
          const { emailsDatabaseId } = await resolveMailModuleIds(client);
          await itemDeleteWithClient(client, emailsDatabaseId, account.emailId, {
            queueAffinity: createActionQueueAffinity(),
          });
        });
        expect(await refusal(readContent(dependencies, account.emailId))).toEqual(random);
      });
    });

    tenantIt("fetches a Gmail message by its id and a Graph message by its immutable id", async () => {
      const gmail = await restMessage("gmail_api", "gm-1");
      const graph = await restMessage("graph_api", "AAMk-immutable/1");
      const requests: Array<{ url: string; prefer: string | null }> = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = urlOf(input);
        requests.push({ url, prefer: new Headers(init?.headers).get("Prefer") });
        if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/gm-1?format=full") {
          return Response.json({
            id: "gm-1",
            payload: {
              mimeType: "multipart/alternative",
              parts: [
                { mimeType: "text/plain", body: { data: Buffer.from("Gmail text").toString("base64url") } },
                { mimeType: "text/html", body: { data: Buffer.from("<p>Gmail html</p>").toString("base64url") } },
              ],
            },
          });
        }
        if (
          url ===
          "https://graph.microsoft.com/v1.0/me/messages/AAMk-immutable%2F1?$select=body,bodyPreview,hasAttachments"
        ) {
          return Response.json({ body: { contentType: "text", content: "Graph text" } });
        }
        return new Response(null, { status: 404 });
      };
      const dependencies = {
        mailContent: {
          createGmailClient: () => new GmailRestClient(async () => "token", fetchImpl),
          createGraphClient: () => new GraphRestClient(async () => "token", fetchImpl),
        },
        throttle: countingThrottle().throttle,
      };

      expect((await readContent(dependencies, gmail.emailId)).body).toMatchObject({
        contentState: "cached",
        bodyText: "Gmail html",
      });
      expect((await readContent(dependencies, graph.emailId)).body).toMatchObject({
        contentState: "cached",
        bodyText: "Graph text",
      });
      expect(requests.map((request) => request.prefer)).toEqual([null, 'IdType="ImmutableId"']);
      const missing = await restMessage("gmail_api", "gm-gone");
      expect(await refusal(readContent(dependencies, missing.emailId))).toMatchObject({
        status: 409,
        details: { reason: "messageNotFound" },
      });
    });
  });

  describe("POST /api/mail/messages/:emailId/attachments/:attachmentId/save", () => {
    tenantIt(
      "stores an indexed attachment's bytes as a blob and a Files item with the ingest's edges, once",
      async () => {
        const account = await indexedImapMessage();
        const { asked, throttle } = countingThrottle();
        const dependencies = { mailContent: account.providers, throttle };
        const attachment = await attachmentOf(account.emailId);
        expect(attachment.blob_id).toBeNull();
        const from = account.server.bodyFetches.length;

        const saved = await saveAttachment(dependencies, account.emailId, attachment.id);

        expect(saved).toEqual({ status: 200, body: { fileItemId: expect.any(String) } });
        const { fileItemId } = saved.body;
        expect(account.reads(from)).toEqual(["1:2"]);
        const stored = await attachmentOf(account.emailId);
        expect(stored.blob_id).not.toBeNull();
        expect(Number(stored.byte_size)).toBe(PDF.length);
        const { rows: blobs } = await runtime.query<{ byte_size: string; key: string }>(
          "SELECT byte_size::text, storage_key AS key FROM blobs WHERE id = $1",
          [stored.blob_id],
        );
        expect(blobs).toEqual([{ byte_size: String(PDF.length), key: expect.stringContaining(account.mailboxId) }]);
        expect(await filesLinkedFrom(account.emailId, account.threadId)).toEqual({
          email: [fileItemId],
          thread: [fileItemId],
          names: ["report.pdf"],
        });
        const detail = await withTransaction(runtime, (client) => getMailThreadDetail(client, account.threadId, false));
        expect(detail.messages[0]?.attachments).toEqual([
          expect.objectContaining({ attachmentId: attachment.id, stored: true, fileItemId, blobId: stored.blob_id }),
        ]);

        const again = await saveAttachment(dependencies, account.emailId, attachment.id);
        expect(again.body).toEqual({ fileItemId });
        expect(account.reads(from)).toEqual(["1:2"]);
        expect(asked).toHaveLength(1);
        expect(await storedFiles()).toHaveLength(1);

        // The content route lists it as stored from now on.
        const content = await readContent(dependencies, account.emailId);
        expect(content.body.attachments).toEqual([
          expect.objectContaining({ attachmentId: attachment.id, stored: true, fileItemId, blobId: stored.blob_id }),
        ]);
      },
    );

    tenantIt("converges concurrent saves of one attachment on one blob and one Files item", async () => {
      const account = await indexedImapMessage();
      const dependencies = { mailContent: account.providers, throttle: countingThrottle().throttle };
      const attachment = await attachmentOf(account.emailId);

      const saves = await Promise.all([1, 2].map(() => saveAttachment(dependencies, account.emailId, attachment.id)));

      const [first, second] = saves.map((save) => save.body.fileItemId);
      expect(second).toBe(first);
      expect(await filesLinkedFrom(account.emailId, account.threadId)).toMatchObject({
        email: [first],
        thread: [first],
      });
      // The second save's bytes are removed; only the recorded blob's file is left.
      expect(await storedFiles()).toHaveLength(1);
    });

    tenantIt("answers 409 and stores nothing when the provider no longer holds the message", async () => {
      const account = await indexedImapMessage();
      const attachment = await attachmentOf(account.emailId);
      account.server.expunge("INBOX", 1);

      const answer = await refusal(
        saveAttachment(
          { mailContent: account.providers, throttle: countingThrottle().throttle },
          account.emailId,
          attachment.id,
        ),
      );

      expect(answer).toMatchObject({ status: 409, details: { reason: "messageNotFound" } });
      expect((await attachmentOf(account.emailId)).blob_id).toBeNull();
      expect(await storedFiles()).toEqual([]);
    });

    tenantIt("saves a Gmail attachment by its part id and a Graph attachment by its id", async () => {
      const gmail = await restMessage("gmail_api", "gm-1", "1");
      const graph = await restMessage("graph_api", "gr-1", "gr-attachment");
      const fetchImpl: typeof fetch = async (input) => {
        const url = urlOf(input);
        // Gmail names the attachment by an id valid for this read only; the stored part id and name find it.
        if (url.endsWith("/messages/gm-1?format=full"))
          return Response.json(gmailMessageWithAttachment("gm-1", "1", "note.txt", "attachment-id-of-this-read"));
        if (url.endsWith("/messages/gm-1/attachments/attachment-id-of-this-read"))
          return Response.json({ size: 5, data: Buffer.from("gmail").toString("base64url") });
        if (url.endsWith("/messages/gr-1/attachments/gr-attachment/$value")) return new Response("graph bytes");
        return new Response(null, { status: 404 });
      };
      const dependencies = {
        mailContent: {
          createGmailClient: () => new GmailRestClient(async () => "token", fetchImpl),
          createGraphClient: () => new GraphRestClient(async () => "token", fetchImpl),
          attachmentStorage: new LocalFsBlobStorageWriter(storageRoot),
        },
        throttle: countingThrottle().throttle,
      };

      for (const message of [gmail, graph]) {
        const attachment = await attachmentOf(message.emailId);
        const saved = await saveAttachment(dependencies, message.emailId, attachment.id);
        expect((await filesLinkedFrom(message.emailId, message.threadId)).email).toEqual([saved.body.fileItemId]);
      }
      expect(Number((await attachmentOf(gmail.emailId)).byte_size)).toBe(5);
      expect(Number((await attachmentOf(graph.emailId)).byte_size)).toBe("graph bytes".length);
    });

    tenantIt("answers 409 and stores nothing when the Gmail message no longer has the part by that name", async () => {
      const gmail = await restMessage("gmail_api", "gm-1", "1");
      const requested: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const url = urlOf(input);
        requested.push(url);
        if (url.endsWith("/messages/gm-1?format=full"))
          return Response.json(gmailMessageWithAttachment("gm-1", "1", "other.txt", "attachment-id-of-this-read"));
        return new Response(null, { status: 404 });
      };
      const dependencies = {
        mailContent: {
          createGmailClient: () => new GmailRestClient(async () => "token", fetchImpl),
          attachmentStorage: new LocalFsBlobStorageWriter(storageRoot),
        },
        throttle: countingThrottle().throttle,
      };
      const attachment = await attachmentOf(gmail.emailId);

      const answer = await refusal(saveAttachment(dependencies, gmail.emailId, attachment.id));

      expect(answer).toMatchObject({ status: 409, details: { reason: "messageNotFound" } });
      expect(requested).toEqual([expect.stringMatching(/\/messages\/gm-1\?format=full$/)]);
      expect((await attachmentOf(gmail.emailId)).blob_id).toBeNull();
      expect(await storedFiles()).toEqual([]);
    });
  });

  describe("agent reads", () => {
    tenantIt("show an indexed message's preview and say its content is not downloaded, without a fetch", async () => {
      const account = await imapAccount();
      const messageId = `<${randomUUID()}@sender.example.test>`;
      account.server.deliver("INBOX", [], oldMessage(messageId));
      const replyId = `<${randomUUID()}@sender.example.test>`;
      account.server.deliver(
        "INBOX",
        [],
        plainMessage("Re: Old offer", {
          messageId: replyId,
          headers: [`In-Reply-To: ${messageId}`, `References: ${messageId}`],
          date: new Date(Date.now() - DAY_MS),
        }),
      );
      await account.pass();
      const old = await messageByMessageId(messageId);
      const reply = await messageByMessageId(replyId);
      expect(reply.thread_id).toBe(old.thread_id);

      const result = await createMailThreadGetUserTool(runtime)(USER_ID, { threadId: old.thread_id });
      const thread = z
        .object({ messages: z.array(z.record(z.string(), z.unknown())) })
        .parse(JSON.parse(String(result.result)));
      expect(thread.messages[0]).toMatchObject({
        emailId: old.item_id,
        bodyText: "Dobrý den, old offer",
        contentNote: expect.stringContaining("not downloaded"),
      });
      expect(thread.messages[1]).not.toHaveProperty("contentNote");

      const prompts: AiGatewayCompletionInput[] = [];
      await evaluateAnswerExpectedFilter(
        runtime,
        {
          complete: async (input) => {
            prompts.push(input);
            return { content: { expectsReply: false }, usage: { inputTokens: 1, outputTokens: 1 } };
          },
        },
        reply.item_id,
      );
      expect(JSON.stringify(prompts[0]?.messages)).toContain(
        "[Only a preview; the content of this message is not downloaded] Dobrý den, old offer",
      );
      expect(account.connects.count).toBe(0);

      // A copy fetched on demand is what both read.
      await withTransaction(runtime, (client) =>
        writeMailContentCache(client, { itemId: old.item_id, bodyHtml: "<p>The whole old offer</p>", bodyText: null }),
      );
      const cached = await createMailThreadGetUserTool(runtime)(USER_ID, { threadId: old.thread_id });
      expect(String(cached.result)).toContain("The whole old offer");
      expect(String(cached.result)).not.toContain("not downloaded");
    });
  });

  describe("mailContentCacheSweep", () => {
    it("deletes the expired rows of every tenant and keeps the fresh ones", async () => {
      const seed = (tenantId: string) =>
        runInTenant(tenantId, async () => {
          const { emailsDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
          const item = () =>
            withTransaction(runtime, (client) =>
              createItemWithClient(client, { databaseId: emailsDatabaseId, properties: {} }),
            );
          const fresh = await item();
          const expired = await item();
          await withTransaction(runtime, async (client) => {
            await writeMailContentCache(client, { itemId: fresh.id, bodyHtml: null, bodyText: "fresh" });
            await writeMailContentCache(client, { itemId: expired.id, bodyHtml: null, bodyText: "expired" });
          });
          // No production writer lets a row expire early.
          await runtime.query(
            `UPDATE mail_message_content_cache SET fetched_at = now() - interval '8 days',
               expires_at = now() - interval '1 day' WHERE item_id = $1`,
            [expired.id],
          );
          return { fresh: fresh.id, expired: expired.id };
        });
      const seeded = [await seed(tenant), await seed(other)];

      expect(await runAsSystem("test", () => handleMailContentCacheSweepTask(runtime))).toEqual({ deleted: 2 });

      for (const [index, tenantId] of [tenant, other].entries()) {
        const { rows } = await runInTenant(tenantId, () =>
          runtime.query<{ item_id: string }>("SELECT item_id FROM mail_message_content_cache"),
        );
        expect(rows).toEqual([{ item_id: seeded[index]?.fresh }]);
      }
    });
  });

  /** An indexed Gmail or Graph message, with one attachment the provider holds under `attachmentPart` when given. */
  async function restMessage(syncMode: "gmail_api" | "graph_api", providerMessageId: string, attachmentPart?: string) {
    const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
    return withTransaction(runtime, async (client) => {
      const mailbox = await createItemWithClient(client, {
        databaseId: ids.mailboxesDatabaseId,
        properties: { name: syncMode, provider: syncMode === "gmail_api" ? "gmail" : "outlook" },
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode });
      const folder = await createItemWithClient(
        client,
        {
          databaseId: ids.foldersDatabaseId,
          properties: { name: "Inbox", behavior: "folder", specialPurpose: "inbox" },
        },
        { allowedSystemKeys: ["name", "behavior", "specialPurpose"] },
      );
      const property = async (key: string) => {
        const found = await getPropertyByKey(client, ids.emailsDatabaseId, key);
        if (!found) throw new Error(`No Emails.${key}`);
        return found.id;
      };
      const messageId = `<${randomUUID()}@example.test>`;
      await ingestEmailMessage(client, {
        arrival: "backfill",
        contentState: "index",
        snippet: "Preview",
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: await property("folder"),
        attachmentsRelationPropertyId: await property("attachments"),
        mailboxItemId: mailbox.id,
        folderItemId: folder.id,
        messageId,
        providerMessageId,
        subject: "Old",
        envelope: { from: { address: "sender@example.test" }, to: [] },
        attachments: attachmentPart
          ? [
              {
                filename: "note.txt",
                contentType: "text/plain",
                contentId: null,
                disposition: "attachment",
                providerPart: attachmentPart,
                byteSize: 1,
              },
            ]
          : [],
        storage: recordingStorage(),
        storageKeyPrefix: mailbox.id,
      });
      const meta = await client.query<{ item_id: string; thread_id: string }>(
        "SELECT item_id, thread_id FROM mail_message_meta WHERE message_id = $1",
        [messageId],
      );
      const [row] = meta.rows;
      if (!row) throw new Error("No meta row");
      return { emailId: row.item_id, threadId: row.thread_id };
    });
  }

  /** The live Files items the Email and its Thread link over `attachments`, and their names. */
  async function filesLinkedFrom(emailId: string, threadId: string) {
    const { rows } = await runtime.query<{ side: string; id: string; name: string }>(
      `SELECT DISTINCT CASE WHEN $1 IN (r.item_a, r.item_b) THEN 'email' ELSE 'thread' END AS side, f.id,
         f.properties->>'name' AS name
       FROM item_relations r
       JOIN relation_definitions d ON d.id = r.relation_definition_id
       JOIN properties p ON p.id IN (d.property_id_a, d.property_id_b) AND p.key = 'attachments'
       JOIN mail_threads t ON t.id = $2
       JOIN items f ON f.id IN (r.item_a, r.item_b) AND f.id NOT IN ($1, t.item_id) AND f.deleted_at IS NULL
       WHERE $1 IN (r.item_a, r.item_b) OR t.item_id IN (r.item_a, r.item_b)
       ORDER BY 1, 2`,
      [emailId, threadId],
    );
    return {
      email: rows.filter((row) => row.side === "email").map((row) => row.id),
      thread: rows.filter((row) => row.side === "thread").map((row) => row.id),
      names: [...new Set(rows.map((row) => row.name))],
    };
  }

  /** Every file the attachment storage holds. */
  async function storedFiles(): Promise<string[]> {
    const files = await readdir(storageRoot, { recursive: true, withFileTypes: true });
    return files.filter((entry) => entry.isFile()).map((entry) => entry.name);
  }
});
