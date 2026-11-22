import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../db/pool.js";
import {
  IMAP_FULL_MESSAGES_PER_PASS,
  IMAP_INDEX_MESSAGES_PER_PASS,
  IMAP_MESSAGES_PER_BATCH,
} from "../mail/imapReconcile.js";
import { MAIL_HEADER_VALUE_MAX_BYTES } from "../mail/imapLightFetch.js";
import { getMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { getMailThreadDetail } from "../mail/mailThreadDetail.js";
import { searchItems } from "../mail/search.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapServer } from "../testSupport/fakeImapServer.js";
import {
  connectLoopbackImapClient,
  createImapMailboxFixture,
  IMAP_FIXTURE_ACCOUNT,
  plainMessage,
  type ImapMailboxFixture,
} from "../testSupport/imapMailboxFixture.js";
import { recordingStorage } from "../testSupport/mailAttachmentFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const QRESYNC = ["ENABLE", "IDLE", "CONDSTORE", "QRESYNC", "MOVE", "UIDPLUS", "SPECIAL-USE"];
const CONDSTORE_ONLY = ["ENABLE", "IDLE", "CONDSTORE", "MOVE", "UIDPLUS", "SPECIAL-USE"];
const PLAIN = ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE"];
const FOLDERS = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "Archive", specialUse: "\\Archive" },
] as const;

let admin: Pool;
let runtime: Pool;
let tenant: string;
let server: FakeImapServer | undefined;

/** A message dated `daysAgo` with a quoted-printable text part longer than a snippet and a base64 PDF attachment. */
function messageWithAttachment(subject: string, daysAgo: number, messageId = `<${randomUUID()}@sender.example.test>`) {
  const pdf = Buffer.from(`%PDF-1.4 ${subject} ${"x".repeat(600)}`).toString("base64");
  return Buffer.from(
    [
      `Message-ID: ${messageId}`,
      "From: Sender <sender@sender.example.test>",
      `To: ${IMAP_FIXTURE_ACCOUNT}`,
      `Subject: ${subject}`,
      `Date: ${new Date(Date.now() - daysAgo * DAY_MS).toUTCString()}`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="part-boundary"',
      "",
      "--part-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      `Dobr=C3=BD den, ${subject} snippet. ${"Lorem ipsum dolor sit amet. ".repeat(120)}`,
      "--part-boundary",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      ...(pdf.match(/.{1,76}/g) ?? []),
      "--part-boundary--",
      "",
    ].join("\r\n"),
  );
}

const messageRow = z.object({
  id: z.string(),
  subject: z.string(),
  trashed: z.boolean(),
  body: z.string(),
  content_state: z.enum(["full", "index"]),
  arrival: z.enum(["live", "backfill"]),
  preview_text: z.string().nullable(),
  thread_id: z.string(),
  created_at: z.date(),
  uids: z.array(z.string()),
});

/** Every Emails item with its meta row, by subject; `uids` holds each folder edge's `<folder>:<uid>`. */
async function messages(): Promise<Map<string, z.infer<typeof messageRow>>> {
  const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
  const { rows } = await runtime.query<Record<string, unknown>>(
    `SELECT i.id, i.properties->>'name' AS subject, i.deleted_at IS NOT NULL AS trashed,
       COALESCE(i.properties->>'body', '') AS body, m.content_state, m.arrival, m.preview_text, m.thread_id, i.created_at,
       ARRAY(SELECT (f.properties->>'providerId') || ':' || (r.metadata->>'uid') FROM item_relations r
         JOIN items f ON f.tenant_id = r.tenant_id AND f.database_id = $2
           AND f.id = CASE WHEN r.item_a = i.id THEN r.item_b ELSE r.item_a END
         WHERE r.tenant_id = i.tenant_id AND (r.item_a = i.id OR r.item_b = i.id) ORDER BY 1) AS uids
     FROM items i JOIN mail_message_meta m ON m.tenant_id = i.tenant_id AND m.item_id = i.id
     WHERE i.tenant_id = app_tenant_default() AND i.database_id = $1`,
    [ids.emailsDatabaseId, ids.foldersDatabaseId],
  );
  return new Map(rows.map((row) => messageRow.parse(row)).map((row) => [row.subject, row]));
}

/** Whether each Emails item named by its subject is flagged. */
async function flaggedOf(subjects: readonly string[]): Promise<Record<string, boolean>> {
  const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
  const { rows } = await runtime.query<{ subject: string; flagged: boolean }>(
    `SELECT properties->>'name' AS subject, COALESCE((properties->>'flagged')::boolean, false) AS flagged
       FROM items WHERE tenant_id = app_tenant_default() AND database_id = $1 AND properties->>'name' = ANY($2::text[])`,
    [ids.emailsDatabaseId, [...subjects]],
  );
  return Object.fromEntries(rows.map((row) => [row.subject, row.flagged]));
}

const attachmentRow = z.object({
  id: z.string(),
  filename: z.string(),
  blob_id: z.string().nullable(),
  provider_part: z.string().nullable(),
  byte_size: z.string(),
});

async function attachmentsOf(emailItemId: string): Promise<Array<z.infer<typeof attachmentRow>>> {
  const { rows } = await runtime.query<Record<string, unknown>>(
    "SELECT id, filename, blob_id, provider_part, byte_size::text FROM mail_attachments WHERE message_item_id = $1",
    [emailItemId],
  );
  return rows.map((row) => attachmentRow.parse(row));
}

async function filesCount(): Promise<number> {
  const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
  const { rows } = await runtime.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM items WHERE tenant_id = app_tenant_default() AND database_id = $1",
    [ids.filesDatabaseId],
  );
  return rows[0]?.count ?? 0;
}

const folderStateRow = z.object({
  uidvalidity: z.string().nullable(),
  uidnext: z.string().nullable(),
  live_from_uid: z.string().nullable(),
  backfill_below_uid: z.string().nullable(),
});

async function folderState(path: string): Promise<z.infer<typeof folderStateRow>> {
  const { rows } = await runtime.query<Record<string, unknown>>(
    `SELECT s.uidvalidity::text, s.uidnext::text, s.live_from_uid::text, s.backfill_below_uid::text
       FROM mail_folder_sync_state s JOIN items f ON f.tenant_id = s.tenant_id AND f.id = s.item_id
      WHERE s.tenant_id = app_tenant_default() AND f.properties->>'providerId' = $1`,
    [path],
  );
  return folderStateRow.parse(rows[0]);
}

async function initialSyncCompleted(mailboxId: string): Promise<boolean> {
  const state = await withTransaction(runtime, (client) => getMailAccountSyncState(client, mailboxId));
  return state?.initialSyncCompletedAt != null;
}

interface Account {
  server: FakeImapServer;
  mailbox: ImapMailboxFixture;
  pass: () => Promise<void>;
}

async function account(capabilities: readonly string[] = QRESYNC): Promise<Account> {
  const fake = new FakeImapServer({ folders: FOLDERS, capabilities, latencyMs: 0 });
  server = fake;
  const port = await fake.listen();
  const mailbox = await createImapMailboxFixture(runtime);
  const storage = recordingStorage();
  return { server: fake, mailbox, pass: () => mailbox.sync(() => connectLoopbackImapClient(port), storage) };
}

/**
 * The body parts the server read from `path` since `from` (an index into `bodyFetches`), as `<uid>:<section>` and the
 * octet count asked for, sorted. imapflow downloads a part in 64 KiB ranges; a snippet is one range of 2 KiB.
 */
function bodyReads(fake: FakeImapServer, path: string, from = 0): string[] {
  return fake.bodyFetches
    .slice(from)
    .filter((read) => read.path === path)
    .map((read) => `${read.uid}:${read.section}${read.length !== undefined ? `<${read.length}>` : ""}`)
    .sort();
}

/** Expunges `uid` from `path` once, right after the next `UID SEARCH` was answered and before the `UID FETCH` after it. */
function expungeBetweenSearchAndFetch(fake: FakeImapServer, path: string, uid: number): void {
  let searched = false;
  fake.beforeCommand = (verb) => {
    if (verb === "SEARCH") searched = true;
    else if (verb === "FETCH" && searched) {
      fake.beforeCommand = undefined;
      fake.expunge(path, uid);
    }
  };
}

describe("IMAP history as an index, backfilled newest first", () => {
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
    await server?.close();
    server = undefined;
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>, timeoutMs = 60_000) =>
    it(name, () => runInTenant(tenant, fn), timeoutMs);

  tenantIt(
    "stores recent history in full and older history as an index, newest first over passes, then completes",
    async () => {
      const { server: fake, mailbox, pass } = await account();
      fake.deliver("INBOX", [], messageWithAttachment("Old 1", 200));
      for (const index of [2, 3])
        fake.deliver("INBOX", [], plainMessage(`Old ${index}`, { date: new Date(Date.now() - 100 * DAY_MS) }));
      const recent = IMAP_FULL_MESSAGES_PER_PASS + 2;
      for (let uid = 4; uid < 3 + recent; uid++)
        fake.deliver("INBOX", [], plainMessage(`Recent ${uid}`, { date: new Date(Date.now() - DAY_MS) }));
      const lastUid = fake.deliver("INBOX", [], messageWithAttachment(`Recent ${3 + recent}`, 1));

      await pass();
      const afterFirst = await messages();
      // The newest UIDs first, as many full messages as one pass takes.
      expect([...afterFirst.keys()].sort()).toEqual(
        Array.from({ length: IMAP_FULL_MESSAGES_PER_PASS }, (_, index) => `Recent ${lastUid - index}`).sort(),
      );
      const lowestFirst = lastUid - IMAP_FULL_MESSAGES_PER_PASS + 1;
      expect(await folderState("INBOX")).toEqual({
        uidvalidity: "1",
        uidnext: String(lastUid + 1),
        live_from_uid: String(lastUid + 1),
        backfill_below_uid: String(lowestFirst),
      });
      expect(await initialSyncCompleted(mailbox.mailboxId)).toBe(false);

      await pass();
      const all = await messages();
      expect(all.size).toBe(lastUid);
      expect(await folderState("INBOX")).toMatchObject({ backfill_below_uid: null });
      expect(await initialSyncCompleted(mailbox.mailboxId)).toBe(true);
      expect([...all.values()].every((message) => message.arrival === "backfill")).toBe(true);

      const old = all.get("Old 1")!;
      expect(old).toMatchObject({ content_state: "index", body: "", uids: ["INBOX:1"] });
      expect(old.preview_text).toMatch(/^Dobrý den, Old 1 snippet\. Lorem ipsum/);
      expect(all.get("Old 2")).toMatchObject({ content_state: "index", body: "", preview_text: "Old 2 body" });
      const [oldAttachment] = await attachmentsOf(old.id);
      expect(oldAttachment).toMatchObject({ filename: "report.pdf", blob_id: null, provider_part: "2" });
      expect(Number(oldAttachment!.byte_size)).toBeGreaterThan(0);

      const newest = all.get(`Recent ${lastUid}`)!;
      expect(newest).toMatchObject({ content_state: "full" });
      expect(newest.body).toContain(`Dobrý den, Recent ${lastUid} snippet.`);
      const [newestAttachment] = await attachmentsOf(newest.id);
      expect(newestAttachment).toMatchObject({ filename: "report.pdf", provider_part: "2" });
      expect(newestAttachment!.blob_id).not.toBeNull();
      expect(all.get("Recent 4")).toMatchObject({ content_state: "full" });
      expect(all.get("Recent 4")!.body.trim()).toBe("Recent 4 body");
      // Only the full message's attachment became a file.
      expect(await filesCount()).toBe(1);
      // An index message is found by its snippet and its attachment's filename.
      const { emailsDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
      for (const query of ["ipsum", "report.pdf"])
        expect(
          (
            await withTransaction(runtime, (client) => searchItems(client, { databaseId: emailsDatabaseId, query }))
          ).map((hit) => hit.itemId),
        ).toContain(old.id);

      // An index message's text part was read only up to the snippet, and its attachment never.
      expect(bodyReads(fake, "INBOX").filter((read) => /^[123]:/.test(read))).toEqual([
        "1:1<2048>",
        "2:TEXT<2048>",
        "3:TEXT<2048>",
      ]);
      expect(bodyReads(fake, "INBOX")).toEqual(expect.arrayContaining([`${lastUid}:1<65536>`, `${lastUid}:2<65536>`]));

      const detail = await withTransaction(runtime, (client) => getMailThreadDetail(client, old.thread_id, false));
      expect(detail.messages).toEqual([
        expect.objectContaining({
          emailId: old.id,
          contentState: "remote",
          preview: old.preview_text,
          bodyText: "",
          attachments: [
            expect.objectContaining({
              attachmentId: oldAttachment!.id,
              stored: false,
              fileItemId: null,
              blobId: null,
              filename: "report.pdf",
              contentType: "application/pdf",
            }),
          ],
        }),
      ]);
      const fullDetail = await withTransaction(runtime, (client) =>
        getMailThreadDetail(client, newest.thread_id, false),
      );
      expect(fullDetail.messages).toEqual([
        expect.objectContaining({
          contentState: "full",
          preview: newest.preview_text,
          attachments: [
            expect.objectContaining({
              attachmentId: newestAttachment!.id,
              stored: true,
              blobId: newestAttachment!.blob_id,
              fileItemId: expect.any(String),
            }),
          ],
        }),
      ]);
    },
  );

  tenantIt(
    "ingests a delivery made during the backfill as live mail before the older history, from one budget",
    async () => {
      const { server: fake, pass } = await account();
      const history = 2 * IMAP_FULL_MESSAGES_PER_PASS + 10;
      for (let uid = 1; uid <= history; uid++) fake.deliver("INBOX", [], plainMessage(`History ${uid}`));
      await pass();

      fake.deliver("Archive", [], plainMessage("Delivered"));
      await pass();

      const all = await messages();
      const delivered = all.get("Delivered")!;
      expect(delivered).toMatchObject({ arrival: "live", content_state: "full", uids: ["Archive:1"] });
      // The live message took one of the pass's full messages: the backfill took one fewer.
      const inboxUid = (message: { uids: string[] }) => Number(message.uids[0]!.replace("INBOX:", ""));
      const secondPass = [...all.values()].filter(
        (message) => message.subject !== "Delivered" && inboxUid(message) <= history - IMAP_FULL_MESSAGES_PER_PASS,
      );
      expect(secondPass).toHaveLength(IMAP_FULL_MESSAGES_PER_PASS - 1);
      expect(await folderState("INBOX")).toMatchObject({
        backfill_below_uid: String(history - 2 * IMAP_FULL_MESSAGES_PER_PASS + 2),
      });
      expect(secondPass.every((message) => message.created_at.getTime() > delivered.created_at.getTime())).toBe(true);
    },
  );

  tenantIt("downloads no body or attachment of a message the mailbox already holds from another folder", async () => {
    const { server: fake, pass } = await account();
    const messageId = `<${randomUUID()}@sender.example.test>`;
    fake.deliver("INBOX", [], messageWithAttachment("Copied", 1, messageId));
    fake.deliver("Archive", [], messageWithAttachment("Copied", 1, messageId));

    await pass();

    const all = await messages();
    expect(all.size).toBe(1);
    expect(all.get("Copied")).toMatchObject({ content_state: "full", uids: ["Archive:1", "INBOX:1"] });
    expect(bodyReads(fake, "INBOX")).toEqual(["1:1<65536>", "1:2<65536>"]);
    expect(bodyReads(fake, "Archive")).toEqual([]);
    expect(await filesCount()).toBe(1);
  });

  it.each([
    { name: "QRESYNC", capabilities: QRESYNC },
    { name: "CONDSTORE only", capabilities: CONDSTORE_ONLY },
    { name: "neither", capabilities: PLAIN },
  ])(
    "removes a message expunged during a partial backfill on a $name server and backfills the rest",
    ({ capabilities }) =>
      runInTenant(tenant, async () => {
        const { server: fake, mailbox, pass } = await account(capabilities);
        const total = IMAP_FULL_MESSAGES_PER_PASS + 5;
        for (let uid = 1; uid <= total; uid++) fake.deliver("INBOX", [], plainMessage(`History ${uid}`));
        await pass();
        const ingestedId = (await messages()).get("History 20")!.id;

        fake.expunge("INBOX", 20);
        fake.expunge("INBOX", 3);
        await pass();

        const all = await messages();
        expect(all.get("History 20")).toBeUndefined();
        expect(all.has("History 3")).toBe(false);
        const live = [...all.values()].filter((message) => !message.trashed);
        expect(live).toHaveLength(total - 2);
        const { rows } = await runtime.query<{ trashed: boolean }>(
          "SELECT deleted_at IS NOT NULL AS trashed FROM items WHERE id = $1",
          [ingestedId],
        );
        expect(rows).toEqual([{ trashed: true }]);
        expect(await folderState("INBOX")).toMatchObject({ backfill_below_uid: null });
        expect(await initialSyncCompleted(mailbox.mailboxId)).toBe(true);
      }),
    60_000,
  );

  tenantIt(
    "keeps the new UIDs after a batch for the next pass when one of them is expunged between its search and fetch",
    async () => {
      const { server: fake, pass } = await account();
      await pass();
      // Dated beyond the full-content window, so each costs the index budget and only the batch size cuts the step.
      const old = new Date(Date.now() - 200 * DAY_MS);
      const total = IMAP_MESSAGES_PER_BATCH + 10;
      for (let index = 1; index <= total; index++)
        fake.deliver("INBOX", [], plainMessage(`New ${index}`, { date: old }));
      expungeBetweenSearchAndFetch(fake, "INBOX", 10);

      await pass();
      expect((await messages()).size).toBe(IMAP_MESSAGES_PER_BATCH - 1);
      expect(await folderState("INBOX")).toMatchObject({ uidnext: String(IMAP_MESSAGES_PER_BATCH + 1) });

      await pass();
      expect((await messages()).size).toBe(total - 1);
      expect(await folderState("INBOX")).toMatchObject({ uidnext: String(total + 1) });
    },
  );

  tenantIt(
    "keeps the backfill cursor above the UIDs left when one message of a range is expunged between its search and fetch",
    async () => {
      const { server: fake, pass } = await account();
      const limit = IMAP_FULL_MESSAGES_PER_PASS + IMAP_INDEX_MESSAGES_PER_PASS;
      // The newest messages fill the full budget and the older ones the index budget, so the range alone ends the step.
      const total = limit + 2;
      for (let uid = 1; uid <= total; uid++) {
        const daysAgo = uid > total - IMAP_FULL_MESSAGES_PER_PASS ? 1 : 200;
        fake.deliver("INBOX", [], plainMessage(`History ${uid}`, { date: new Date(Date.now() - daysAgo * DAY_MS) }));
      }
      expungeBetweenSearchAndFetch(fake, "INBOX", 300);

      await pass();
      // The search took the `limit` highest UIDs, down to UID 3; UIDs 2 and 1 are left for the next pass.
      expect((await messages()).size).toBe(limit - 1);
      expect(await folderState("INBOX")).toMatchObject({ backfill_below_uid: "3" });

      await pass();
      const all = await messages();
      expect(all.size).toBe(total - 1);
      expect(all.has("History 1")).toBe(true);
      expect(await folderState("INBOX")).toMatchObject({ backfill_below_uid: null });
    },
    120_000,
  );

  tenantIt("fails a pass whose backfill search the server refuses, leaving the backfill where it was", async () => {
    const { server: fake, pass } = await account();
    for (const subject of ["One", "Two", "Three"]) fake.deliver("INBOX", [], plainMessage(subject));
    fake.refusedVerbs.add("SEARCH");

    await expect(pass()).rejects.toThrow();

    expect((await messages()).size).toBe(0);
    expect(await folderState("INBOX")).toMatchObject({ live_from_uid: "4", backfill_below_uid: "4" });
  });

  tenantIt("fails a pass whose UID searches the server refuses, removing no known copy", async () => {
    const { server: fake, pass } = await account(PLAIN);
    for (const subject of ["One", "Two"]) fake.deliver("INBOX", [], plainMessage(subject));
    await pass();
    // The count no longer accounts for the folder, so the pass would list every UID to find the vanished ones.
    fake.expunge("INBOX", 1);
    fake.deliver("INBOX", [], plainMessage("Three"));
    fake.refusedVerbs.add("SEARCH");

    await expect(pass()).rejects.toThrow();

    const after = await messages();
    expect([...after.values()].map(({ subject, trashed, uids }) => ({ subject, trashed, uids }))).toEqual(
      expect.arrayContaining([
        { subject: "One", trashed: false, uids: ["INBOX:1"] },
        { subject: "Two", trashed: false, uids: ["INBOX:2"] },
      ]),
    );
  });

  it.each(["1.5", "-7", "1e20"])(
    "ingests a message whose server gives an attachment size of %s and an overlong Message-ID, the size as unknown",
    (size) =>
      runInTenant(tenant, async () => {
        const { server: fake, pass } = await account();
        const messageId = `<${randomUUID()}@sender.example.test>`;
        fake.deliver("INBOX", [], messageWithAttachment("Broken", 200, messageId));
        const overlong = `<${"x".repeat(3 * MAIL_HEADER_VALUE_MAX_BYTES)}@sender.example.test>`;
        fake.rewriteResponse = (text) =>
          text.replace(/("BASE64" )\d+/, `$1${size}`).replace(`"${messageId}"`, `"${overlong}"`);

        await pass();

        const broken = (await messages()).get("Broken");
        expect(broken).toMatchObject({ content_state: "index", uids: ["INBOX:1"] });
        const [attachment] = await attachmentsOf(broken!.id);
        expect(attachment).toMatchObject({ filename: "report.pdf", byte_size: "0" });
        const { rows } = await runtime.query<{ message_id: string }>(
          "SELECT message_id FROM mail_message_meta WHERE item_id = $1",
          [broken!.id],
        );
        expect(rows).toEqual([{ message_id: "<no-message-id-uid-1@generated>" }]);
      }),
    60_000,
  );

  tenantIt(
    "takes no UID of a replaced UIDVALIDITY for another message's: flags, vanished copies and edges follow the new UIDs",
    async () => {
      const { server: fake, pass } = await account();
      for (const subject of ["Expunged", "Kept", "Flagged"]) fake.deliver("INBOX", [], plainMessage(subject));
      await pass();
      // Renumbered from 1 without the expunged message: "Kept" takes its old UID 1, "Flagged" the old UID 2 of "Kept".
      fake.expunge("INBOX", 1);
      fake.resetUidValidity("INBOX", 1);
      fake.setFlags("INBOX", 2, ["\\Flagged"]);

      await pass();

      const after = await messages();
      expect([...after.keys()].sort()).toEqual(["Flagged", "Kept"]);
      expect(after.get("Kept")?.uids).toEqual(["INBOX:1"]);
      expect(after.get("Flagged")?.uids).toEqual(["INBOX:2"]);
      expect(await flaggedOf(["Kept", "Flagged"])).toEqual({ Kept: false, Flagged: true });
      expect(await folderState("INBOX")).toMatchObject({ uidvalidity: "2", backfill_below_uid: null });
    },
  );

  tenantIt(
    "establishes a folder anew after a UIDVALIDITY reset and backfills it again without downloading known mail",
    async () => {
      const { server: fake, pass } = await account();
      for (const subject of ["First", "Second", "Third"]) fake.deliver("INBOX", [], plainMessage(subject));
      await pass();
      const before = await messages();
      expect(await folderState("INBOX")).toEqual({
        uidvalidity: "1",
        uidnext: "4",
        live_from_uid: "4",
        backfill_below_uid: null,
      });

      fake.resetUidValidity("INBOX", 101);
      const from = fake.bodyFetches.length;
      await pass();

      expect(await folderState("INBOX")).toEqual({
        uidvalidity: "2",
        uidnext: "104",
        live_from_uid: "104",
        backfill_below_uid: null,
      });
      const after = await messages();
      expect([...after.values()].map(({ id, subject, trashed, uids }) => ({ id, subject, trashed, uids }))).toEqual(
        expect.arrayContaining([
          { id: before.get("First")!.id, subject: "First", trashed: false, uids: ["INBOX:101"] },
          { id: before.get("Second")!.id, subject: "Second", trashed: false, uids: ["INBOX:102"] },
          { id: before.get("Third")!.id, subject: "Third", trashed: false, uids: ["INBOX:103"] },
        ]),
      );
      expect(after.size).toBe(3);
      expect(bodyReads(fake, "INBOX", from)).toEqual([]);
    },
  );
});
