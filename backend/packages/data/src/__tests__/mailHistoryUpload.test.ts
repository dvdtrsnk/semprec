import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { MAIL_HEADER_VALUE_MAX_BYTES } from "../mail/imapLightFetch.js";
import { getMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import {
  createMailHistoryClaimRouteHandler,
  createMailHistoryReleaseRouteHandler,
  createMailHistoryUploadRouteHandler,
  MAIL_HISTORY_MAX_FETCH_BYTES,
  MAIL_HISTORY_MAX_MESSAGES,
  type MailHistoryClaim,
  type MailHistoryRouteDependencies,
} from "../mail/mailHistoryUpload.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { MailReauthorizationRequiredError } from "../mail/providerTypes.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapServer } from "../testSupport/fakeImapServer.js";
import {
  connectLoopbackImapClient,
  createImapMailboxFixture,
  IMAP_FIXTURE_ACCOUNT,
  type ImapMailboxFixture,
} from "../testSupport/imapMailboxFixture.js";
import { RawImapHistoryClient } from "../testSupport/rawImapHistoryClient.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CONDSTORE = ["ENABLE", "IDLE", "CONDSTORE", "MOVE", "UIDPLUS", "SPECIAL-USE"];
const FOLDERS = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "Archive", specialUse: "\\Archive" },
] as const;
const USER_ID = randomUUID();
const USER_WRITER = { writerKind: "user" } as const;

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;
const servers: FakeImapServer[] = [];

interface HistoryMessage {
  subject: string;
  daysAgo: number;
  kind?: "plain" | "html" | "attachment";
  flags?: readonly string[];
  headers?: readonly string[];
}

function messageIdOf(subject: string): string {
  return `<${subject.toLowerCase().replace(/\s+/g, "-")}@sender.example.test>`;
}

/** One message's bytes, the same for every server it is delivered to. */
function raw(message: HistoryMessage, now: number): Buffer {
  const head = [
    `Message-ID: ${messageIdOf(message.subject)}`,
    "From: Sender <sender@sender.example.test>",
    `To: ${IMAP_FIXTURE_ACCOUNT}`,
    `Subject: ${message.subject}`,
    `Date: ${new Date(now - message.daysAgo * DAY_MS).toUTCString()}`,
    ...(message.headers ?? []),
  ];
  if (message.kind === "html")
    return Buffer.from(
      [...head, "Content-Type: text/html; charset=utf-8", "", `<p>${message.subject} <b>html</b> body</p>`, ""].join(
        "\r\n",
      ),
    );
  if (message.kind === "attachment")
    return Buffer.from(
      [
        ...head,
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="part-boundary"',
        "",
        "--part-boundary",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        `Dobr=C3=BD den, ${message.subject} snippet. ${"Lorem ipsum dolor sit amet. ".repeat(20)}`,
        "--part-boundary",
        'Content-Type: application/pdf; name="report.pdf"',
        'Content-Disposition: attachment; filename="report.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        ...(Buffer.from(`%PDF-1.4 ${"x".repeat(600)}`)
          .toString("base64")
          .match(/.{1,76}/g) ?? []),
        "--part-boundary--",
        "",
      ].join("\r\n"),
    );
  return Buffer.from(
    [...head, "Content-Type: text/plain; charset=utf-8", "", `${message.subject} plain body`, ""].join("\r\n"),
  );
}

const RECENT = Array.from({ length: 25 }, (_, index) => ({ subject: `Recent ${index + 1}`, daysAgo: index + 1 }));

/**
 * Each folder's history newest UID first, as the backfill reads it. A pass ingests 25 messages in full: INBOX's first
 * pass takes the 25 recent ones and "Old 1" (the first message older than the window, which makes the folder
 * index-only) and stops at "Late recent" (in the window, below an old UID), leaving it and the older ones; Archive's
 * recent message then finds the full budget spent, so Archive stays in its in-window backfill.
 */
function history(extraOld = 0): Record<(typeof FOLDERS)[number]["path"], HistoryMessage[]> {
  return {
    INBOX: [
      ...RECENT,
      { subject: "Old 1", daysAgo: 200 },
      { subject: "Late recent", daysAgo: 30 },
      { subject: "Old offer", daysAgo: 210, kind: "attachment" },
      { subject: "Old html", daysAgo: 220, kind: "html" },
      {
        subject: "Re Old offer",
        daysAgo: 230,
        flags: ["\\Seen"],
        headers: [`In-Reply-To: ${messageIdOf("Old offer")}`, `References: ${messageIdOf("Old offer")}`],
      },
      { subject: "Old newsletter", daysAgo: 240, headers: ["List-Id: <news.sender.example.test>"] },
      ...Array.from({ length: extraOld }, (_, index) => ({ subject: `Older ${index + 1}`, daysAgo: 300 + index })),
    ],
    Archive: [
      { subject: "Archived recent", daysAgo: 3 },
      { subject: "Archived old", daysAgo: 300 },
    ],
  };
}

interface Account {
  server: FakeImapServer;
  port: number;
  mailbox: ImapMailboxFixture;
  mailboxId: string;
  pass(): Promise<void>;
}

/** An IMAP account on a loopback server holding `content`, the oldest message of each folder at UID 1. */
async function account(content = history(), now = Date.now()): Promise<Account> {
  const server = new FakeImapServer({ folders: FOLDERS, capabilities: CONDSTORE, latencyMs: 0 });
  servers.push(server);
  for (const [path, messages] of Object.entries(content))
    for (const message of [...messages].reverse()) server.deliver(path, message.flags ?? [], raw(message, now));
  const port = await server.listen();
  const mailbox = await createImapMailboxFixture(runtime);
  return {
    server,
    port,
    mailbox,
    mailboxId: mailbox.mailboxId,
    pass: () => mailbox.sync(() => connectLoopbackImapClient(port)),
  };
}

/** A throttle granting `limit` requests, then refusing; records what it was asked. */
function countingThrottle(limit = Number.MAX_SAFE_INTEGER) {
  const asked: string[] = [];
  return {
    asked,
    throttle: {
      tryAcquire(action: "mailHistoryUpload", userId: string) {
        asked.push(`${action}:${userId}`);
        return asked.length <= limit ? { granted: true as const } : { granted: false as const, retryAfterSeconds: 42 };
      },
    },
  };
}

const unlimited: MailHistoryRouteDependencies = { throttle: countingThrottle().throttle };

function claim(mailboxId: string, body: unknown = {}, dependencies = unlimited) {
  return createMailHistoryClaimRouteHandler(
    runtime,
    dependencies,
  )({
    params: { id: mailboxId },
    body,
    identity: { user: { id: USER_ID } },
  });
}

function release(mailboxId: string, leaseToken: string) {
  return createMailHistoryReleaseRouteHandler(runtime)({ params: { id: mailboxId }, body: { leaseToken } });
}

function upload(mailboxId: string, body: unknown, dependencies = unlimited) {
  return createMailHistoryUploadRouteHandler(
    runtime,
    dependencies,
  )({
    params: { id: mailboxId },
    body,
    identity: { user: { id: USER_ID } },
  });
}

type LeasedFolder = MailHistoryClaim["folders"][number];

/** The slice with its first FETCH response rewritten by `rewrite`, which must change it. */
function withFirstFetch(body: SliceBody, rewrite: (text: string) => string): SliceBody {
  return {
    ...body,
    messages: body.messages.map((message, index) => {
      if (index > 0) return message;
      const text = Buffer.from(message.fetch, "base64").toString("latin1");
      const rewritten = rewrite(text);
      if (rewritten === text) throw new Error("The rewrite matched nothing of the FETCH response");
      return { ...message, fetch: Buffer.from(rewritten, "latin1").toString("base64") };
    }),
  };
}

/** What the client sends for `[rangeLow, folder.backfillBelowUid)`, read from the server as the contract says. */
async function sliceBody(account: Account, leaseToken: string, folder: LeasedFolder, rangeLow = 1) {
  const client = await RawImapHistoryClient.connect(account.port);
  try {
    await client.select(folder.path);
    const uids = await client.searchUids(rangeLow, folder.backfillBelowUid - 1);
    const responses = await client.fetchHistory(uids);
    return {
      leaseToken,
      folderId: folder.folderId,
      uidvalidity: folder.uidvalidity,
      rangeHigh: folder.backfillBelowUid,
      rangeLow,
      uids,
      messages: uids.map((uid) => ({ uid, fetch: responses.get(uid)?.toString("base64") ?? "" })),
    };
  } finally {
    await client.close();
  }
}

/** The one folder a claim leased. */
function leasedFolder(answer: { body: MailHistoryClaim }, path = "INBOX"): LeasedFolder {
  const folder = answer.body.folders.find((candidate) => candidate.path === path);
  if (!folder) throw new Error(`The claim leased no ${path}`);
  return folder;
}

/** What a refused call answers: its status, code and details. */
async function refusal(call: Promise<unknown>) {
  const error: unknown = await call.then(
    () => null,
    (value: unknown) => value,
  );
  if (!(error instanceof Error)) throw new Error("Expected a refusal");
  return z.object({ status: z.number(), code: z.string(), details: z.unknown().optional() }).parse(error);
}

const folderStateRow = z.object({
  backfill_below_uid: z.string().nullable(),
  backfill_index_only: z.boolean(),
  leased: z.boolean(),
});

async function folderState(mailboxId: string, path: string) {
  const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
  const { rows } = await runtime.query<Record<string, unknown>>(
    `SELECT s.backfill_below_uid::text, s.backfill_index_only, COALESCE(s.client_backfill_lease_until > now(), false) AS leased
       FROM mail_folder_sync_state s
       JOIN items f ON f.tenant_id = s.tenant_id AND f.id = s.item_id AND f.database_id = $3
      WHERE s.tenant_id = app_tenant_default() AND f.properties->>'providerId' = $2
        AND EXISTS (SELECT 1 FROM item_relations r WHERE r.tenant_id = f.tenant_id
          AND ((r.item_a = f.id AND r.item_b = $1) OR (r.item_b = f.id AND r.item_a = $1)))`,
    [mailboxId, path, ids.foldersDatabaseId],
  );
  return folderStateRow.parse(rows[0]);
}

async function initialSyncCompleted(mailboxId: string): Promise<boolean> {
  const state = await withTransaction(runtime, (client) => getMailAccountSyncState(client, mailboxId));
  return state?.initialSyncCompletedAt != null;
}

const messageRow = z.object({
  message_id: z.string(),
  subject: z.string(),
  body: z.string(),
  read: z.boolean().nullable(),
  content_state: z.enum(["full", "index"]),
  arrival: z.enum(["live", "backfill"]),
  preview_text: z.string().nullable(),
  thread: z.array(z.string()),
  folders: z.array(z.string()),
  attachments: z.array(z.string()),
  envelope: z.unknown(),
  in_reply_to: z.string().nullable(),
  references: z.array(z.string()).nullable(),
  is_bulk: z.boolean(),
  provider_message_id: z.string().nullable(),
});

/**
 * Every message of the mailbox by Message-ID, without ids: what a reader sees of it, the Message-IDs of its thread,
 * its folder copies as `<folder>:<uid>` and its attachments' stored metadata.
 */
async function messagesOf(mailboxId: string): Promise<Map<string, z.infer<typeof messageRow>>> {
  const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
  const { rows } = await runtime.query<Record<string, unknown>>(
    `SELECT m.message_id, i.properties->>'name' AS subject, COALESCE(i.properties->>'body', '') AS body,
       (i.properties->>'read')::boolean AS read, m.content_state, m.arrival, m.preview_text, m.envelope,
       m.in_reply_to, m."references", m.is_bulk, m.provider_message_id,
       ARRAY(SELECT o.message_id FROM mail_message_meta o
              WHERE o.tenant_id = m.tenant_id AND o.thread_id = m.thread_id ORDER BY 1) AS thread,
       ARRAY(SELECT (f.properties->>'providerId') || ':' || (r.metadata->>'uid') FROM item_relations r
         JOIN items f ON f.tenant_id = r.tenant_id AND f.database_id = $2
           AND f.id = CASE WHEN r.item_a = i.id THEN r.item_b ELSE r.item_a END
         WHERE r.tenant_id = i.tenant_id AND (r.item_a = i.id OR r.item_b = i.id) ORDER BY 1) AS folders,
       ARRAY(SELECT concat_ws('|', a.filename, a.content_type, a.byte_size, a.provider_part, a.blob_id IS NULL)
               FROM mail_attachments a WHERE a.tenant_id = i.tenant_id AND a.message_item_id = i.id ORDER BY 1)
         AS attachments
     FROM items i JOIN mail_message_meta m ON m.tenant_id = i.tenant_id AND m.item_id = i.id
     WHERE i.tenant_id = app_tenant_default() AND m.mailbox_item_id = $1 AND i.deleted_at IS NULL`,
    [mailboxId, ids.foldersDatabaseId],
  );
  return new Map(rows.map((row) => messageRow.parse(row)).map((row) => [row.message_id, row]));
}

async function expireLease(mailboxId: string, path: string): Promise<void> {
  // Ten minutes cannot pass in a test; an expired lease is the state their passing leaves.
  const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
  await runtime.query(
    `UPDATE mail_folder_sync_state s SET client_backfill_lease_until = now() - interval '1 second'
       FROM items f
      WHERE f.tenant_id = s.tenant_id AND f.id = s.item_id AND f.database_id = $2 AND f.properties->>'providerId' = $3
        AND s.tenant_id = app_tenant_default()
        AND EXISTS (SELECT 1 FROM item_relations r WHERE r.tenant_id = f.tenant_id
          AND ((r.item_a = f.id AND r.item_b = $1) OR (r.item_b = f.id AND r.item_a = $1)))`,
    [mailboxId, ids.foldersDatabaseId, path],
  );
}

describe("IMAP history uploaded by a native client", () => {
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
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn), 120_000);

  tenantIt("leases a folder only once the server's backfill made it index-only", async () => {
    const imap = await account();

    // Before the first pass the server knows no folder: nothing to lease yet, but the client may come back.
    const early = await claim(imap.mailboxId);
    expect(early.body).toMatchObject({ folders: [], leaseExpiresAt: null, pendingFullBackfill: true });

    await imap.pass();
    const answer = await claim(imap.mailboxId);
    const inbox = await folderState(imap.mailboxId, "INBOX");
    // INBOX reached "Old 1" and is index-only from there; Archive is still in its in-window backfill.
    expect(inbox).toMatchObject({ backfill_index_only: true, leased: true });
    expect(await folderState(imap.mailboxId, "Archive")).toMatchObject({ backfill_index_only: false, leased: false });
    expect(answer.body).toEqual({
      leaseToken: expect.any(String),
      leaseExpiresAt: expect.any(String),
      folders: [
        {
          folderId: expect.any(String),
          path: "INBOX",
          uidvalidity: 1,
          backfillBelowUid: Number(inbox.backfill_below_uid),
        },
      ],
      pendingFullBackfill: true,
    });
    const leaseEnd = Date.parse(answer.body.leaseExpiresAt ?? "");
    expect(leaseEnd - Date.now()).toBeGreaterThan(9 * 60 * 1000);

    // Another client gets nothing while the lease runs; the holder renews it with its token.
    expect((await claim(imap.mailboxId)).body.folders).toEqual([]);
    const renewed = await claim(imap.mailboxId, { leaseToken: answer.body.leaseToken });
    expect(renewed.body.folders).toEqual(answer.body.folders);
    expect(renewed.body.leaseToken).toBe(answer.body.leaseToken);
  });

  it.each(["released", "expired"] as const)(
    "has the server's backfill skip a leased folder and resume once the lease is %s",
    (end) =>
      runInTenant(tenant, async () => {
        const imap = await account();
        await imap.pass();
        const answer = await claim(imap.mailboxId);
        const below = (await folderState(imap.mailboxId, "INBOX")).backfill_below_uid;
        const lateRecent = messageIdOf("Late recent");

        await imap.pass();
        // Archive moved on; INBOX was left to the client, and the account is not complete.
        expect(await folderState(imap.mailboxId, "INBOX")).toMatchObject({ backfill_below_uid: below, leased: true });
        expect(await folderState(imap.mailboxId, "Archive")).toMatchObject({ backfill_below_uid: null });
        expect((await messagesOf(imap.mailboxId)).has(lateRecent)).toBe(false);
        expect(await initialSyncCompleted(imap.mailboxId)).toBe(false);

        if (end === "released")
          expect((await release(imap.mailboxId, answer.body.leaseToken)).body).toEqual({ released: 1 });
        else await expireLease(imap.mailboxId, "INBOX");
        await imap.pass();

        expect(await folderState(imap.mailboxId, "INBOX")).toMatchObject({ backfill_below_uid: null, leased: false });
        expect((await messagesOf(imap.mailboxId)).get(lateRecent)).toMatchObject({ content_state: "full" });
        expect(await initialSyncCompleted(imap.mailboxId)).toBe(true);
      }),
    120_000,
  );

  it("stores an uploaded folder's history as the server's own backfill indexes it, and completes the initial sync", async () => {
    const now = Date.now();
    const indexedByServer = await runInTenant(other, async () => {
      const imap = await account(history(), now);
      for (let pass = 0; pass < 3; pass++) await imap.pass();
      expect(await initialSyncCompleted(imap.mailboxId)).toBe(true);
      return messagesOf(imap.mailboxId);
    });

    await runInTenant(tenant, async () => {
      const imap = await account(history(), now);
      await imap.pass();
      const answer = await claim(imap.mailboxId);
      await imap.pass();
      expect(await initialSyncCompleted(imap.mailboxId)).toBe(false);
      // Archive is done now, so nothing but INBOX's index is left.
      expect((await claim(imap.mailboxId, { leaseToken: answer.body.leaseToken })).body.pendingFullBackfill).toBe(
        false,
      );

      const uploaded = await upload(
        imap.mailboxId,
        await sliceBody(imap, answer.body.leaseToken, leasedFolder(answer)),
      );

      expect(uploaded).toEqual({
        status: 200,
        body: { accepted: 5, backfillBelowUid: null, leaseExpiresAt: expect.any(String) },
      });
      expect(await folderState(imap.mailboxId, "INBOX")).toMatchObject({ backfill_below_uid: null });
      expect(await initialSyncCompleted(imap.mailboxId)).toBe(true);
      const messages = await messagesOf(imap.mailboxId);
      expect(messages.size).toBe(indexedByServer.size);
      for (const subject of ["Old offer", "Old html", "Re Old offer", "Old newsletter"]) {
        const messageId = messageIdOf(subject);
        expect(messages.get(messageId), subject).toEqual(indexedByServer.get(messageId));
        expect(messages.get(messageId)).toMatchObject({ content_state: "index", arrival: "backfill", body: "" });
      }
      expect(messages.get(messageIdOf("Old offer"))).toMatchObject({
        preview_text: expect.stringContaining("Dobrý den, Old offer snippet."),
        attachments: [expect.stringMatching(/^report\.pdf\|application\/pdf\|\d+\|2\|t$/)],
      });
      expect(messages.get(messageIdOf("Re Old offer"))).toMatchObject({
        read: true,
        thread: [messageIdOf("Old offer"), messageIdOf("Re Old offer")],
      });
      // Below an old UID, a message inside the window is uploaded as an index too; its body is read on demand.
      expect(messages.get(messageIdOf("Late recent"))).toMatchObject({
        content_state: "index",
        arrival: "backfill",
        preview_text: "Late recent plain body",
      });
      expect(indexedByServer.get(messageIdOf("Late recent"))).toMatchObject({ content_state: "full" });
    });
  }, 180_000);

  tenantIt("takes a folder's history in contiguous slices, newest first, over more than one write batch", async () => {
    const imap = await account(history(60));
    await imap.pass();
    const answer = await claim(imap.mailboxId);
    const folder = leasedFolder(answer);

    const upper = await upload(imap.mailboxId, await sliceBody(imap, answer.body.leaseToken, folder, 20));
    expect(upper.body).toMatchObject({ accepted: folder.backfillBelowUid - 20, backfillBelowUid: 20 });
    expect(await folderState(imap.mailboxId, "INBOX")).toMatchObject({ backfill_below_uid: "20", leased: true });

    const lower = await upload(
      imap.mailboxId,
      await sliceBody(imap, answer.body.leaseToken, { ...folder, backfillBelowUid: 20 }),
    );
    expect(lower.body).toMatchObject({ accepted: 19, backfillBelowUid: null });
    const messages = await messagesOf(imap.mailboxId);
    for (let index = 1; index <= 60; index++)
      expect(messages.get(messageIdOf(`Older ${index}`))).toMatchObject({ content_state: "index" });
  });

  tenantIt(
    "removes, once an upload finishes a renumbered folder, the copy of a message the server expunged",
    async () => {
      const imap = await account();
      const uploadAll = async () => {
        const answer = await claim(imap.mailboxId);
        await upload(imap.mailboxId, await sliceBody(imap, answer.body.leaseToken, leasedFolder(answer)));
      };
      await imap.pass();
      await uploadAll();
      expect(await folderState(imap.mailboxId, "INBOX")).toMatchObject({ backfill_below_uid: null });
      const oldest = messageIdOf("Old newsletter");
      const next = messageIdOf("Re Old offer");
      expect((await messagesOf(imap.mailboxId)).get(oldest)?.folders).toEqual(["INBOX:1"]);
      // New mail the next pass finds only after the renumbering, so its backfill reaches it newest first: an old message,
      // which makes the folder index-only again, then more recent ones than its full budget takes.
      for (let index = 1; index <= 26; index++)
        imap.server.deliver("INBOX", [], raw({ subject: `Renumbered recent ${index}`, daysAgo: 2 }, Date.now()));
      imap.server.deliver("INBOX", [], raw({ subject: "Renumbered old", daysAgo: 400 }, Date.now()));
      // The oldest message leaves and the server renumbers the rest from 1.
      imap.server.expunge("INBOX", 1);
      imap.server.resetUidValidity("INBOX", 1);

      await imap.pass();
      expect(await folderState(imap.mailboxId, "INBOX")).toMatchObject({ backfill_index_only: true });
      await uploadAll();
      await imap.pass();

      const messages = await messagesOf(imap.mailboxId);
      expect(messages.has(oldest)).toBe(false);
      expect(messages.get(next)?.folders).toEqual(["INBOX:1"]);
    },
  );

  describe("refusals, which write nothing", () => {
    async function leased() {
      const imap = await account();
      await imap.pass();
      const answer = await claim(imap.mailboxId);
      const body = await sliceBody(imap, answer.body.leaseToken, leasedFolder(answer));
      const before = await messagesOf(imap.mailboxId);
      const expectNothingWritten = async () => {
        expect(await folderState(imap.mailboxId, "INBOX")).toMatchObject({
          backfill_below_uid: String(body.rangeHigh),
        });
        expect([...(await messagesOf(imap.mailboxId)).keys()].sort()).toEqual([...before.keys()].sort());
      };
      return { imap, answer, body, expectNothingWritten };
    }

    it.each<{ name: string; alter: (body: SliceBody) => SliceBody; status: number; code: string; field?: string }>([
      {
        name: "a slice that does not continue at the cursor",
        alter: (body: SliceBody) => ({ ...body, rangeHigh: body.rangeHigh + 1 }),
        status: 409,
        code: "mail_history_range_stale",
      },
      {
        name: "another UIDVALIDITY",
        alter: (body: SliceBody) => ({ ...body, uidvalidity: body.uidvalidity + 1 }),
        status: 409,
        code: "mail_history_uidvalidity_changed",
      },
      {
        name: "a token holding no lease",
        alter: (body: SliceBody) => ({ ...body, leaseToken: randomUUID() }),
        status: 409,
        code: "mail_history_lease_expired",
      },
      {
        name: "a listed UID without its message",
        alter: (body: SliceBody) => ({ ...body, messages: body.messages.slice(1) }),
        status: 400,
        code: "validation_failed",
        field: "messages",
      },
      {
        name: "a message of a UID not listed",
        alter: (body: SliceBody) => ({ ...body, uids: body.uids.slice(1) }),
        status: 400,
        code: "validation_failed",
        field: "messages",
      },
      {
        name: "a FETCH response of another UID",
        alter: (body: SliceBody) => ({
          ...body,
          messages: body.messages.map((message, index) =>
            index === 0 ? { ...message, fetch: body.messages[1]?.fetch ?? "" } : message,
          ),
        }),
        status: 400,
        code: "validation_failed",
        field: "messages.0.fetch",
      },
      {
        name: "a FETCH response without the TEXT section",
        alter: (body: SliceBody) => ({
          ...body,
          messages: body.messages.map((message, index) =>
            index === 0
              ? { ...message, fetch: Buffer.from(`* 1 FETCH (UID ${message.uid} FLAGS ())\r\n`).toString("base64") }
              : message,
          ),
        }),
        status: 400,
        code: "validation_failed",
        field: "messages.0.fetch",
      },
      {
        name: "bytes that are no FETCH response",
        alter: (body: SliceBody) => ({
          ...body,
          messages: body.messages.map((message, index) =>
            index === 0 ? { ...message, fetch: Buffer.from("* OK hello\r\n").toString("base64") } : message,
          ),
        }),
        status: 400,
        code: "validation_failed",
        field: "messages.0.fetch",
      },
      {
        name: "a FETCH response that is not base64",
        alter: (body: SliceBody) => ({
          ...body,
          messages: body.messages.map((message, index) =>
            index === 0 ? { ...message, fetch: "*not base64*" } : message,
          ),
        }),
        status: 400,
        code: "validation_failed",
        field: "messages.0.fetch",
      },
      ...["1.5", "-7", "1e20"].map((size) => ({
        name: `a body part size of ${size}`,
        alter: (body: SliceBody) =>
          withFirstFetch(body, (text) => text.replace(/(BODYSTRUCTURE \(.*?"7BIT" )\d+/, `$1${size}`)),
        status: 400,
        code: "validation_failed",
        field: "messages.0.fetch",
      })),
      {
        name: "a Message-ID longer than a header line",
        alter: (body: SliceBody) =>
          withFirstFetch(body, (text) =>
            text.replace(messageIdOf("Old newsletter"), `<${"x".repeat(3 * MAIL_HEADER_VALUE_MAX_BYTES)}@long.test>`),
          ),
        status: 400,
        code: "validation_failed",
        field: "messages.0.fetch",
      },
      {
        name: "a FETCH response over 64 KiB",
        alter: (body: SliceBody) => ({
          ...body,
          messages: body.messages.map((message, index) =>
            index === 0
              ? { ...message, fetch: Buffer.alloc(MAIL_HISTORY_MAX_FETCH_BYTES + 3, 0x61).toString("base64") }
              : message,
          ),
        }),
        status: 400,
        code: "validation_failed",
        field: "messages.0.fetch",
      },
      {
        name: "more than 500 UIDs",
        alter: (body: SliceBody) => ({
          ...body,
          uids: Array.from({ length: MAIL_HISTORY_MAX_MESSAGES + 1 }, (_, index) => index + 1),
        }),
        status: 400,
        code: "validation_failed",
        field: "uids",
      },
      {
        name: "a UID outside the range",
        alter: (body: SliceBody) => ({ ...body, uids: [...body.uids.slice(1), body.rangeHigh] }),
        status: 400,
        code: "validation_failed",
        field: "uids",
      },
      {
        name: "a range ending where it starts",
        alter: (body: SliceBody) => ({ ...body, rangeLow: body.rangeHigh }),
        status: 400,
        code: "validation_failed",
        field: "rangeLow",
      },
      {
        name: "a UIDVALIDITY that is no IMAP number",
        alter: (body: SliceBody) => ({ ...body, uidvalidity: 2 ** 32 }),
        status: 400,
        code: "validation_failed",
        field: "uidvalidity",
      },
    ])(
      "refuses $name",
      ({ alter, status, code, field }) =>
        runInTenant(tenant, async () => {
          const { imap, body, expectNothingWritten } = await leased();

          const answer = await refusal(upload(imap.mailboxId, alter(body)));

          expect(answer).toMatchObject({ status, code, ...(field ? { details: { field } } : {}) });
          await expectNothingWritten();
        }),
      120_000,
    );

    tenantIt("answers a stale slice with the cursor the folder holds", async () => {
      const { imap, body } = await leased();
      await upload(imap.mailboxId, body);

      const answer = await refusal(upload(imap.mailboxId, body));

      expect(answer).toMatchObject({
        status: 409,
        code: "mail_history_range_stale",
        details: { backfillBelowUid: null },
      });
    });

    tenantIt("refuses an expired lease", async () => {
      const { imap, body, expectNothingWritten } = await leased();
      await expireLease(imap.mailboxId, "INBOX");

      expect(await refusal(upload(imap.mailboxId, body))).toMatchObject({
        status: 409,
        code: "mail_history_lease_expired",
      });
      await expectNothingWritten();
    });

    tenantIt("refuses a slice read before the server renumbered the folder", async () => {
      const { imap, body } = await leased();
      imap.server.resetUidValidity("INBOX", 100);
      await imap.pass();

      expect(await refusal(upload(imap.mailboxId, body))).toMatchObject({
        status: 409,
        code: "mail_history_uidvalidity_changed",
      });
      // The renumbered folder is established anew, without the client's lease.
      expect(await folderState(imap.mailboxId, "INBOX")).toMatchObject({ leased: false });
    });

    it.each([
      {
        name: "Mail switched off",
        reason: "mailboxUnavailable",
        arrange: async (imap: Account) => {
          const { mailboxesDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
          await createChokePoint(runtime).updateItem(
            { databaseId: mailboxesDatabaseId, itemId: imap.mailboxId, propertiesPatch: { mailEnabled: false } },
            USER_ID,
            USER_ID,
            USER_WRITER,
          );
        },
      },
      {
        name: "a sign-in the server refused",
        reason: "reauthorizationRequired",
        arrange: (imap: Account) =>
          imap.mailbox.sync(() => Promise.reject(new MailReauthorizationRequiredError("refused by the server"))),
      },
    ])(
      "refuses a claim and an upload for $name",
      ({ reason, arrange }) =>
        runInTenant(tenant, async () => {
          const { imap, body } = await leased();
          await arrange(imap);

          for (const call of [() => claim(imap.mailboxId), () => upload(imap.mailboxId, body)])
            expect(await refusal(call())).toMatchObject({
              status: 409,
              code: "mail_history_unavailable",
              details: { reason },
            });
        }),
      120_000,
    );

    tenantIt("counts each claim and upload against the user's throttle, and a refused one leases nothing", async () => {
      const imap = await account();
      await imap.pass();
      const { asked, throttle } = countingThrottle(1);

      const granted = await claim(imap.mailboxId, {}, { throttle });
      expect(granted.body.folders).toHaveLength(1);
      expect(asked).toEqual([`mailHistoryUpload:${USER_ID}`]);
      expect((await release(imap.mailboxId, granted.body.leaseToken)).body).toEqual({ released: 1 });
      const before = await folderState(imap.mailboxId, "INBOX");

      expect(await refusal(claim(imap.mailboxId, {}, { throttle }))).toMatchObject({
        status: 429,
        code: "rate_limited",
      });
      expect(await refusal(upload(imap.mailboxId, {}, { throttle }))).toMatchObject({
        status: 429,
        code: "rate_limited",
      });
      expect(asked).toHaveLength(3);
      expect(await folderState(imap.mailboxId, "INBOX")).toEqual({ ...before, leased: false });
    });
  });

  it("answers another tenant's mailbox exactly as a random id, and leases or writes nothing of it", async () => {
    const owned = await runInTenant(tenant, async () => {
      const imap = await account();
      await imap.pass();
      const answer = await claim(imap.mailboxId);
      return { imap, body: await sliceBody(imap, answer.body.leaseToken, leasedFolder(answer)) };
    });
    const before = await runInTenant(tenant, () => folderState(owned.imap.mailboxId, "INBOX"));

    await runInTenant(other, async () => {
      for (const call of [
        (id: string) => claim(id),
        (id: string) => release(id, owned.body.leaseToken),
        (id: string) => upload(id, owned.body),
      ]) {
        const foreign = await refusal(call(owned.imap.mailboxId));
        expect(foreign).toEqual(await refusal(call(randomUUID())));
        expect(foreign).toMatchObject({ status: 404, code: "not_found" });
      }
    });

    expect(await runInTenant(tenant, () => folderState(owned.imap.mailboxId, "INBOX"))).toEqual(before);
    expect((await runInTenant(tenant, () => messagesOf(owned.imap.mailboxId))).has(messageIdOf("Late recent"))).toBe(
      false,
    );
  }, 120_000);
});

type SliceBody = Awaited<ReturnType<typeof sliceBody>>;
