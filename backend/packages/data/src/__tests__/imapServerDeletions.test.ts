import "../domainWriteHooks.js";
import type { Pool } from "pg";
import { ImapFlow } from "imapflow";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTransaction } from "../db/pool.js";
import { createImapFlowIdleTransport, type CreateIdleTunedImapFlowClient } from "../mail/imapIdleClient.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { listMailThreads } from "../mail/mailThreadListQuery.js";
import { IMAP_SEEN_FLAG } from "../mail/messageFlags.js";
import { seedSystem } from "../seed/seedSystem.js";
import { elapseMailSyncBackoff } from "../testSupport/mailSyncBackoff.js";
import { FakeImapAccount } from "../testSupport/fakeImapAccount.js";
import type { FakeImapServer } from "../testSupport/fakeImapServer.js";
import type { ImapMailClient } from "../mail/imapMailClient.js";
import {
  createImapMailboxFixture,
  createSyncedLoopbackMailbox,
  IMAP_FIXTURE_ACCOUNT,
  plainMessage,
  PURELYMAIL_CONTENT,
  PURELYMAIL_FOLDERS,
  type LoopbackMessage,
  type SyncedLoopbackMailbox,
} from "../testSupport/imapMailboxFixture.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const neverAborted = new AbortController().signal;

const LATENCY_MS = 40;

/** The capabilities of the Purelymail account the production evidence came from (no LIST-STATUS). */
const QRESYNC = ["ENABLE", "IDLE", "CONDSTORE", "QRESYNC", "MOVE", "UIDPLUS", "SPECIAL-USE"];
const CONDSTORE_ONLY = ["ENABLE", "IDLE", "CONDSTORE", "MOVE", "UIDPLUS", "SPECIAL-USE"];
const PLAIN = ["IDLE", "MOVE", "UIDPLUS", "SPECIAL-USE"];

/** The connection's own commands on a server without LIST-STATUS: LOGIN, ENABLE, imapflow's LISTs and LSUB, LOGOUT. */
const CONNECTION = { LOGIN: 1, ENABLE: 1, LIST: 2, LSUB: 1, STATUS: 6, LOGOUT: 1 };

let admin: Pool;
let runtime: Pool;
let tenant: string;
let server: FakeImapServer | undefined;
const cleanups: Array<() => Promise<void>> = [];

interface EmailState {
  id: string;
  trashed: boolean;
  read: boolean;
  folders: string[];
}

describe("messages deleted or moved on the IMAP server by another client", () => {
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
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    await server?.close();
    server = undefined;
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn), 30_000);

  async function synced(
    capabilities: readonly string[],
    content: Record<string, readonly LoopbackMessage[]> = PURELYMAIL_CONTENT,
  ): Promise<SyncedLoopbackMailbox> {
    const mailbox = await createSyncedLoopbackMailbox(runtime, { capabilities, latencyMs: LATENCY_MS, content });
    server = mailbox.server;
    return mailbox;
  }

  /** Every Emails item named `subject`, trashed ones included, with the folders it has a copy in. */
  async function emailsNamed(subject: string): Promise<EmailState[]> {
    const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
    const { rows } = await runtime.query<EmailState>(
      `SELECT i.id, i.deleted_at IS NOT NULL AS trashed, COALESCE(i.properties->'read' = 'true'::jsonb, false) AS read,
         ARRAY(SELECT f.properties->>'providerId' FROM item_relations r
           JOIN items f ON f.tenant_id = r.tenant_id AND f.database_id = $2
             AND f.id = CASE WHEN r.item_a = i.id THEN r.item_b ELSE r.item_a END
           WHERE r.tenant_id = i.tenant_id AND (r.item_a = i.id OR r.item_b = i.id) ORDER BY 1) AS folders
       FROM items i
       WHERE i.tenant_id = app_tenant_default() AND i.database_id = $1 AND i.properties->>'name' = $3
       ORDER BY i.created_at`,
      [ids.emailsDatabaseId, ids.foldersDatabaseId, subject],
    );
    return rows;
  }

  async function inboxThreads(): Promise<Array<{ subject: string; messageCount: number }>> {
    const threads = await withTransaction(runtime, (client) =>
      listMailThreads(client, 50, null, { box: "inbox", folderId: null, mailboxId: null, unread: false }),
    );
    return threads.map((thread) => ({ subject: thread.subject, messageCount: thread.messageCount }));
  }

  async function measuredPass(mailbox: SyncedLoopbackMailbox) {
    const from = mailbox.server.commands.length;
    await mailbox.mailbox.sync(mailbox.overWire);
    return mailbox.server.countsSince(from);
  }

  it.each([
    {
      name: "QRESYNC",
      capabilities: QRESYNC,
      // VANISHED (EARLIER) and the changed flags in one FETCH; the message count accounts for the rest.
      counts: { ...CONNECTION, SELECT: 1, FETCH: 1 },
    },
    {
      name: "CONDSTORE only",
      capabilities: CONDSTORE_ONLY,
      // The count dropped with no VANISHED to account for it: one full UID list.
      counts: { ...CONNECTION, SELECT: 1, FETCH: 1, SEARCH: 1 },
    },
    {
      name: "neither",
      capabilities: PLAIN,
      // Every folder is selected for its flags; only the one whose count dropped lists its UIDs.
      counts: { LOGIN: 1, LIST: 2, LSUB: 1, LOGOUT: 1, SELECT: 6, FETCH: 6, SEARCH: 1 },
    },
  ])("removes a message expunged on a $name server at the next pass", ({ capabilities, counts }) =>
    runInTenant(tenant, async () => {
      const mailbox = await synced(capabilities);
      expect(await inboxThreads()).toContainEqual({ subject: "INBOX 2", messageCount: 1 });
      const [before] = await emailsNamed("INBOX 2");

      mailbox.server.expunge("INBOX", mailbox.uidOf("INBOX", "INBOX 2"));
      const pass = await measuredPass(mailbox);

      expect(pass).toEqual(counts);
      expect(await emailsNamed("INBOX 2")).toEqual([{ ...before!, trashed: true, folders: [] }]);
      expect((await inboxThreads()).map((thread) => thread.subject)).not.toContain("INBOX 2");

      // The next pass finds the folder as it recorded it and removes nothing more.
      const again = await measuredPass(mailbox);
      expect(again).toEqual(
        capabilities === PLAIN ? { LOGIN: 1, LIST: 2, LSUB: 1, LOGOUT: 1, SELECT: 6, FETCH: 6 } : CONNECTION,
      );
      expect(await emailsNamed("INBOX 2")).toEqual([{ ...before!, trashed: true, folders: [] }]);
      expect(await inboxThreads()).toHaveLength(7);
    }),
  );

  tenantIt("lists no UIDs after a delivery alone on a CONDSTORE-only server", async () => {
    const mailbox = await synced(CONDSTORE_ONLY);

    mailbox.server.deliver("INBOX");
    const pass = await measuredPass(mailbox);

    // The one SEARCH is the new-UID search (UID n:*); the count grew by exactly the new UID.
    expect(pass.SEARCH).toBe(1);
    expect(await inboxThreads()).toContainEqual({ subject: "INBOX 9", messageCount: 1 });
  });

  tenantIt("keeps a thread with one message left when the other is expunged", async () => {
    const original = "<original@sender.example.test>";
    const mailbox = await synced(QRESYNC, {
      INBOX: [
        { subject: "Offer", messageId: original },
        { subject: "Re: Offer", headers: [`In-Reply-To: ${original}`, `References: ${original}`] },
        { subject: "Other" },
      ],
    });
    // Both messages carry the same date, so either may name the thread.
    const counts = async () => (await inboxThreads()).map((thread) => thread.messageCount).sort();
    expect(await counts()).toEqual([1, 2]);
    const [offer] = await emailsNamed("Offer");

    mailbox.server.expunge("INBOX", mailbox.uidOf("INBOX", "Re: Offer"));
    await mailbox.mailbox.sync(mailbox.overWire);

    expect(await inboxThreads()).toEqual(
      expect.arrayContaining([
        { subject: "Offer", messageCount: 1 },
        { subject: "Other", messageCount: 1 },
      ]),
    );
    expect(await emailsNamed("Offer")).toEqual([offer]);
    expect(await emailsNamed("Re: Offer")).toEqual([expect.objectContaining({ trashed: true, folders: [] })]);
  });

  tenantIt("syncs the other folders when a folder is deleted after the pass listed it", async () => {
    const mailbox = await synced(QRESYNC);
    mailbox.server.deliver("Archive", [], plainMessage("Archived later"));
    mailbox.server.deliver("INBOX", [], plainMessage("New in INBOX"));
    // Another client deletes Archive between this pass's LIST and its SELECT of the folder.
    const deletingAfterList = async (): Promise<ImapMailClient> => {
      const client = await mailbox.overWire();
      return Object.assign(Object.create(client) as ImapMailClient, {
        listFolders: async () => {
          const folders = await client.listFolders();
          mailbox.server.deleteFolder("Archive");
          return folders;
        },
      });
    };

    await mailbox.mailbox.sync(deletingAfterList);

    expect(await emailsNamed("New in INBOX")).toMatchObject([{ trashed: false, folders: ["INBOX"] }]);
    expect(await emailsNamed("Archived later")).toEqual([]);
    const { rows } = await runtime.query<{ last_error: string | null; failing_since: Date | null }>(
      "SELECT last_error, failing_since FROM mail_account_sync_state WHERE item_id = $1",
      [mailbox.mailbox.mailboxId],
    );
    expect(rows).toEqual([{ last_error: null, failing_since: null }]);
  });

  /** Whether the mailbox's Folder of `path` is live, trashed, or gone. */
  async function folderOf(path: string): Promise<"live" | "trashed" | "none"> {
    const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
    const { rows } = await runtime.query<{ trashed: boolean }>(
      `SELECT deleted_at IS NOT NULL AS trashed FROM items
        WHERE tenant_id = app_tenant_default() AND database_id = $1 AND properties->>'providerId' = $2`,
      [ids.foldersDatabaseId, path],
    );
    if (rows.length === 0) return "none";
    return rows.every((row) => row.trashed) ? "trashed" : "live";
  }

  tenantIt("trashes a folder deleted by another client, with the messages it alone held", async () => {
    const mailbox = await synced(QRESYNC);
    const [archived] = await emailsNamed("Archive 1");
    expect(archived).toMatchObject({ trashed: false, folders: ["Archive"] });

    mailbox.server.deleteFolder("Archive");
    await mailbox.mailbox.sync(mailbox.overWire);

    expect(await emailsNamed("Archive 1")).toEqual([{ ...archived!, trashed: true, folders: [] }]);
    expect(await folderOf("Archive")).toBe("trashed");
    expect(await emailsNamed("INBOX 1")).toMatchObject([{ trashed: false, folders: ["INBOX"] }]);
  });

  tenantIt("keeps the item of a message whose folder another client renamed", async () => {
    const mailbox = await synced(QRESYNC);
    const [archived] = await emailsNamed("Archive 1");

    // A rename as the client sees it: the folder's messages under another path, the old path gone.
    mailbox.server.move("Archive", mailbox.uidOf("Archive", "Archive 1"), "Junk");
    mailbox.server.deleteFolder("Archive");
    await mailbox.mailbox.sync(mailbox.overWire);

    expect(await emailsNamed("Archive 1")).toEqual([{ ...archived!, folders: ["Junk"] }]);
    expect(await folderOf("Archive")).toBe("trashed");
  });

  tenantIt("shows a message another client moved from INBOX to Archive as moved, on the same item", async () => {
    const mailbox = await synced(QRESYNC);
    const [before] = await emailsNamed("INBOX 3");
    expect(before).toMatchObject({ trashed: false, read: true, folders: ["INBOX"] });

    const archiveUid = mailbox.server.move("INBOX", mailbox.uidOf("INBOX", "INBOX 3"), "Archive");
    await mailbox.mailbox.sync(mailbox.overWire);

    expect(await emailsNamed("INBOX 3")).toEqual([{ ...before!, folders: ["Archive"] }]);
    expect((await inboxThreads()).map((thread) => thread.subject)).not.toContain("INBOX 3");
    expect(mailbox.server.flagsOf("Archive", archiveUid)).toEqual([IMAP_SEEN_FLAG]);
  });

  it.each([
    {
      change: "expunged",
      apply: (account: FakeImapAccount, uid: number) => account.expunge("INBOX", uid),
      after: { trashed: true, folders: [] },
    },
    {
      change: "moved to Archive",
      apply: (account: FakeImapAccount, uid: number) => account.move("INBOX", uid, "Archive"),
      after: { trashed: false, folders: ["Archive"] },
    },
  ])(
    "decides a message $change by another client at the next pass when the pass that removed its INBOX copy failed after it",
    ({ apply, after }) =>
      runInTenant(tenant, async () => {
        const account = new FakeImapAccount([...PURELYMAIL_FOLDERS]);
        account.deliver("INBOX", plainMessage("Kept"));
        const changedUid = account.deliver("INBOX", plainMessage("Changed"));
        const mailbox = await createImapMailboxFixture(runtime);
        await mailbox.sync(async () => account.client());
        const [before] = await emailsNamed("Changed");
        expect(before).toMatchObject({ trashed: false, folders: ["INBOX"] });

        apply(account, changedUid);
        // The inbox goes first; the connection drops once its batch committed, before any other folder is selected.
        account.gate = async (call) => {
          if (call.method === "selectFolder" && call.path !== "INBOX") throw new Error("connection lost");
        };
        await expect(mailbox.sync(async () => account.client())).rejects.toThrow("connection lost");
        expect(await emailsNamed("Changed")).toEqual([{ ...before!, folders: [] }]);

        account.gate = undefined;
        // The next pass runs once the failure's backoff ran out, as the sweep queues it.
        await withTransaction(runtime, (client) => elapseMailSyncBackoff(client, mailbox.mailboxId));
        await mailbox.sync(async () => account.client());

        expect(await emailsNamed("Changed")).toEqual([{ ...before!, ...after }]);
        expect(await emailsNamed("Kept")).toEqual([expect.objectContaining({ trashed: false, folders: ["INBOX"] })]);
        const { rows } = await runtime.query<{ marked: number }>(
          `SELECT count(*)::int AS marked FROM mail_message_meta
            WHERE tenant_id = app_tenant_default() AND folder_copy_removed_at IS NOT NULL`,
        );
        expect(rows).toEqual([{ marked: 0 }]);
      }),
    30_000,
  );

  tenantIt(
    "signals a delivery that follows an expunge while the IDLE connection idles on a QRESYNC server",
    async () => {
      const mailbox = await synced(QRESYNC);
      const { port } = mailbox;
      // As the composition root builds it: the IDLE options decide QRESYNC.
      const createClient: CreateIdleTunedImapFlowClient = async (_mailboxItemId, credential, idleOptions) => {
        const client = new ImapFlow({
          host: "127.0.0.1",
          port,
          secure: false,
          auth: { user: IMAP_FIXTURE_ACCOUNT, pass: credential },
          logger: false,
          ...idleOptions,
        });
        client.on("error", () => {});
        await client.connect();
        return client;
      };
      let signals = 0;
      const connection = await createImapFlowIdleTransport(createClient).connect(
        mailbox.mailbox.mailboxId,
        "app-password",
        "INBOX",
        () => signals++,
        neverAborted,
      );
      cleanups.push(() => connection.close());
      await vi.waitFor(() => expect(mailbox.server.isIdling("INBOX")).toBe(true), { timeout: 5_000, interval: 10 });

      mailbox.server.expunge("INBOX", mailbox.uidOf("INBOX", "INBOX 1"));
      await vi.waitFor(() => expect(signals).toBe(1), { timeout: 5_000, interval: 10 });
      // The delivery brings INBOX back to the message count it had before the expunge.
      mailbox.server.deliver("INBOX", [], plainMessage("After the expunge"));

      await vi.waitFor(() => expect(signals).toBe(2), { timeout: 5_000, interval: 10 });
    },
  );

  tenantIt("removes a message expunged while the IDLE connection idles on INBOX, about a second later", async () => {
    const mailbox = await synced(QRESYNC);
    const { port } = mailbox;
    const createClient: CreateIdleTunedImapFlowClient = async (_mailboxItemId, credential, idleOptions) => {
      const client = new ImapFlow({
        host: "127.0.0.1",
        port,
        secure: false,
        auth: { user: IMAP_FIXTURE_ACCOUNT, pass: credential },
        logger: false,
        ...idleOptions,
      });
      client.on("error", () => {});
      await client.connect();
      return client;
    };
    const passes: Array<Promise<void>> = [];
    // The signal's production effect is the enqueue of the account's pass; here the pass runs at once.
    const connection = await createImapFlowIdleTransport(createClient).connect(
      mailbox.mailbox.mailboxId,
      "app-password",
      "INBOX",
      () => passes.push(runInTenant(tenant, () => mailbox.mailbox.sync(mailbox.overWire))),
      neverAborted,
    );
    cleanups.push(async () => {
      await Promise.allSettled(passes);
      await connection.close();
    });
    await vi.waitFor(() => expect(mailbox.server.isIdling("INBOX")).toBe(true), { timeout: 5_000, interval: 10 });

    const expungedAt = performance.now();
    mailbox.server.expunge("INBOX", mailbox.uidOf("INBOX", "INBOX 1"));
    await vi.waitFor(
      async () => expect(await emailsNamed("INBOX 1")).toEqual([expect.objectContaining({ trashed: true })]),
      { timeout: 10_000, interval: 10 },
    );
    const removedAfterMs = performance.now() - expungedAt;

    expect(passes).toHaveLength(1);
    // One push and a QRESYNC pass of 15 round trips at 40 ms, plus the database work.
    expect(removedAfterMs).toBeLessThan(1_200);
    expect((await inboxThreads()).map((thread) => thread.subject)).not.toContain("INBOX 1");
  });
});
