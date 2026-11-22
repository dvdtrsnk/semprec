import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import "../domainWriteHooks.js";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import {
  ensureMailAccountSyncState,
  getMailAccountSyncState,
  recordGmailSyncCursor,
  recordGmailWatchRegistration,
  recordGraphSyncCursor,
} from "../mail/mailAccountSyncStateStore.js";
import {
  GMAIL_FULL_MESSAGES_PER_PASS,
  reconcileGmailAccount,
  type GmailHistoryResult,
  type GmailMailClient,
  type GmailMessageFormat,
} from "../mail/gmailReconcile.js";
import {
  GRAPH_FULL_MESSAGES_PER_PASS,
  reconcileGraphAccount,
  type GraphChangedMessage,
  type GraphDeltaPage,
  type GraphMailClient,
} from "../mail/graphReconcile.js";
import { MAIL_FULL_CONTENT_WINDOW_DAYS } from "../mail/mailContentState.js";
import type { MailSyncPass } from "../mail/mailSyncPass.js";

let admin: Pool;
let pool: Pool;
let tenantId: string;

/** Inside the full-content window of an account connected during the test, and recent enough to arrive live. */
const RECENT_DATE = new Date(Date.now() - 60 * 60 * 1000);
/** Beyond the full-content window, and older than the live-arrival grace. */
const OLD_DATE = new Date("2001-01-01T00:00:00.000Z");
const PAGE = 50;

const storage: BlobStorageWriter = {
  async writeStream(_key, source) {
    const hash = createHash("sha256");
    let byteSize = 0;
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      byteSize += bytes.length;
      hash.update(bytes);
    }
    return { byteSize, contentHash: hash.digest("hex") };
  },
  async delete() {},
  readStream: () => {
    throw new Error("not used");
  },
};

interface Setup {
  mailboxItemId: string;
  emailsDatabaseId: string;
  filesDatabaseId: string;
  foldersDatabaseId: string;
  folderRelationPropertyId: string;
  mailboxFolderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
}

async function setup(syncMode: "gmail_api" | "graph_api"): Promise<Setup> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const [emails, files, folders, mailboxes] = await Promise.all(
        ["emails", "files", "folders", "mailboxes"].map((m) => getDatabaseByModuleId(client, m)),
      );
      if (!emails || !files || !folders || !mailboxes) throw new Error("mail databases were not seeded");
      const folderProperty = await getPropertyByKey(client, emails.id, "folder");
      const attachmentsProperty = await getPropertyByKey(client, emails.id, "attachments");
      const mailboxProperty = await getPropertyByKey(client, folders.id, "mailbox");
      if (!folderProperty || !attachmentsProperty || !mailboxProperty) throw new Error("schema missing");
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxes.id,
        properties: { name: "M", provider: syncMode === "gmail_api" ? "gmail" : "outlook" },
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode });
      return {
        mailboxItemId: mailbox.id,
        emailsDatabaseId: emails.id,
        filesDatabaseId: files.id,
        foldersDatabaseId: folders.id,
        folderRelationPropertyId: folderProperty.id,
        mailboxFolderRelationPropertyId: mailboxProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        storage,
        storageKeyPrefix: "test",
      };
    }),
  );
}

/** A pass that records how each of its runs finished. */
function recordingPass(): MailSyncPass & { finished: boolean[] } {
  const finished: boolean[] = [];
  return {
    finished,
    enter: async () => true,
    finish: async (_client: PoolClient, { complete }) => {
      finished.push(complete);
    },
  };
}

/** Counts, at each provider call, the transactions the runtime role holds open in this worker's database. */
function transactionProbe(): { check: () => Promise<void>; openAtCalls: number[] } {
  const openAtCalls: number[] = [];
  return {
    openAtCalls,
    async check() {
      const { rows } = await admin.query<{ open: number }>(
        `SELECT count(*)::int AS open FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'semprec_data' AND xact_start IS NOT NULL`,
      );
      openAtCalls.push(rows[0]?.open ?? -1);
    },
  };
}

interface StoredMessage {
  providerMessageId: string;
  arrival: string;
  contentState: string;
  preview: string | null;
  body: string;
  attachments: number;
  storedAttachments: number;
}

async function storedMessages(mailboxItemId: string): Promise<StoredMessage[]> {
  const { rows } = await admin.query<StoredMessage>(
    `SELECT m.provider_message_id AS "providerMessageId", m.arrival, m.content_state AS "contentState",
            m.preview_text AS preview, COALESCE(i.properties ->> 'body', '') AS body,
            (SELECT count(*)::int FROM mail_attachments a WHERE a.message_item_id = m.item_id) AS attachments,
            (SELECT count(*)::int FROM mail_attachments a WHERE a.message_item_id = m.item_id AND a.blob_id IS NOT NULL)
              AS "storedAttachments"
       FROM mail_message_meta m JOIN items i ON i.id = m.item_id
      WHERE m.mailbox_item_id = $1
      ORDER BY m.provider_message_id`,
    [mailboxItemId],
  );
  return rows;
}

async function syncState(mailboxItemId: string) {
  const state = await runInTenant(tenantId, () =>
    withTransaction(pool, (client) => getMailAccountSyncState(client, mailboxItemId)),
  );
  if (!state) throw new Error("Missing sync state");
  return state;
}

function inTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(pool, fn));
}

function windowStartSeconds(connectedAt: string | null): number {
  if (connectedAt === null) throw new Error("The account has no connection anchor");
  return Math.floor(new Date(connectedAt).getTime() / 1000) - MAIL_FULL_CONTENT_WINDOW_DAYS * 24 * 60 * 60;
}

beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
});

beforeEach(async () => {
  await resetDatabase(admin);
  tenantId = getTenantZeroId();
  await runInTenant(tenantId, () => seedSystem(pool));
});

afterAll(async () => {
  await pool?.end();
});

interface FakeGmailAccount {
  client: GmailMailClient;
  listings: Array<{ query: string; pageToken: string | null }>;
  fetches: Array<{ id: string; format: GmailMessageFormat }>;
  historyIdCaptures: number;
  historyStarts: string[];
  probe: ReturnType<typeof transactionProbe>;
}

/**
 * A Gmail account holding `recent` messages inside the full-content window and `old` ones beyond it, each phase listed
 * newest first in pages of 50. `history` answers `history.list`; `failFetch` makes a fetch of that id fail once.
 */
function gmailAccount(options: {
  recent: string[];
  old: string[];
  history?: (startHistoryId: string) => GmailHistoryResult;
  failFetch?: string;
}): FakeGmailAccount {
  const probe = transactionProbe();
  let failFetch = options.failFetch;
  const fake: FakeGmailAccount = {
    listings: [],
    fetches: [],
    historyIdCaptures: 0,
    historyStarts: [],
    probe,
    client: {
      getCurrentHistoryId: async () => {
        await probe.check();
        fake.historyIdCaptures++;
        return "1000";
      },
      listHistorySince: async (startHistoryId) => {
        await probe.check();
        fake.historyStarts.push(startHistoryId);
        return (
          options.history?.(startHistoryId) ?? {
            invalidated: false,
            newHistoryId: startHistoryId,
            changedMessageIds: [],
            removedMessageIds: [],
          }
        );
      },
      listMessageIds: async (query, pageToken) => {
        await probe.check();
        fake.listings.push({ query, pageToken });
        const ids = query.startsWith("after:") ? options.recent : options.old;
        const page = pageToken === null ? 0 : Number(pageToken.slice(pageToken.lastIndexOf(":") + 1));
        const next = (page + 1) * PAGE < ids.length ? `${query}:${page + 1}` : null;
        return { ids: ids.slice(page * PAGE, (page + 1) * PAGE), nextPageToken: next };
      },
      fetchMessage: async (id, format) => {
        await probe.check();
        fake.fetches.push({ id, format });
        if (id === failFetch) {
          failFetch = undefined;
          throw new Error("Gmail sync provider request failed unexpectedly");
        }
        const full = format === "full";
        return {
          id,
          threadId: `thread-${id}`,
          labelIds: ["INBOX"],
          snippet: `Snippet of ${id}`,
          message: {
            messageId: `<${id}@gmail.test>`,
            subject: id,
            envelope: { from: { address: "sender@example.test" } },
            date: options.old.includes(id) ? OLD_DATE : RECENT_DATE,
            ...(full ? { bodyText: `Body of ${id}` } : {}),
            attachments: full
              ? [
                  {
                    filename: `${id}.txt`,
                    contentType: "text/plain",
                    contentId: null,
                    disposition: "attachment" as const,
                    openStream: () => Readable.from([`bytes of ${id}`]),
                  },
                ]
              : [],
          },
        };
      },
      listLabels: async () => {
        await probe.check();
        return [{ id: "INBOX", name: "INBOX", type: "system" }];
      },
      modifyMessageLabels: async () => {
        await probe.check();
      },
    },
  };
  return fake;
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);
}

describe("Gmail sync stores recent mail in full and older history as an index", () => {
  const reconcile = (params: Setup, gmail: GmailMailClient, pass = recordingPass()) =>
    runInTenant(tenantId, () => reconcileGmailAccount(pool, gmail, { ...params, pass }));

  it("lists the full-content window in full and older mail as metadata with its snippet, never inside a transaction", async () => {
    const params = await setup("gmail_api");
    const account = gmailAccount({ recent: ["recent"], old: ["old"] });
    const pass = recordingPass();

    await expect(reconcile(params, account.client, pass)).resolves.toEqual({ ran: true, complete: true });

    const state = await syncState(params.mailboxItemId);
    const windowStart = windowStartSeconds(state.connectedAt);
    expect(account.listings).toEqual([
      { query: `after:${windowStart}`, pageToken: null },
      { query: `before:${windowStart + 1}`, pageToken: null },
    ]);
    expect(account.fetches).toEqual([
      { id: "recent", format: "full" },
      { id: "old", format: "metadata" },
    ]);
    expect(await storedMessages(params.mailboxItemId)).toEqual([
      {
        providerMessageId: "old",
        arrival: "backfill",
        contentState: "index",
        preview: "Snippet of old",
        body: "",
        attachments: 0,
        storedAttachments: 0,
      },
      {
        providerMessageId: "recent",
        arrival: "backfill",
        contentState: "full",
        preview: "Body of recent",
        body: "Body of recent",
        attachments: 1,
        storedAttachments: 1,
      },
    ]);
    expect(state).toMatchObject({ gmailHistoryId: "1000", gmailListingPhase: null, gmailListingPageToken: null });
    expect(state.initialSyncCompletedAt).not.toBeNull();
    expect(pass.finished).toEqual([true]);
    expect(account.probe.openAtCalls.length).toBeGreaterThan(0);
    expect(account.probe.openAtCalls.every((open) => open === 0)).toBe(true);
  });

  it.each(["before the first pass", "while the first pass captures its history id"] as const)(
    "lists the mailbox on its first pass when the Gmail watch is registered %s",
    async (when) => {
      const params = await setup("gmail_api");
      const register = () =>
        inTenant((client) =>
          recordGmailWatchRegistration(client, params.mailboxItemId, {
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            emailAddress: "user@gmail.test",
          }),
        );
      if (when === "before the first pass") await register();
      const account = gmailAccount({ recent: ["recent"], old: ["old"] });
      const client: GmailMailClient = {
        ...account.client,
        getCurrentHistoryId: async () => {
          if (when !== "before the first pass") await register();
          return account.client.getCurrentHistoryId();
        },
      };

      await expect(reconcile(params, client)).resolves.toEqual({ ran: true, complete: true });

      expect(account.historyStarts).toEqual([]);
      expect(account.listings).toHaveLength(2);
      expect((await storedMessages(params.mailboxItemId)).map((m) => m.providerMessageId)).toEqual(["old", "recent"]);
      expect(await syncState(params.mailboxItemId)).toMatchObject({ gmailHistoryId: "1000", gmailListingPhase: null });
    },
  );

  it("ingests a message reached through history.list as live and in full, from the history id captured before the listing", async () => {
    const params = await setup("gmail_api");
    await reconcile(params, gmailAccount({ recent: [], old: [] }).client);
    const account = gmailAccount({
      recent: [],
      old: [],
      history: () => ({
        invalidated: false,
        newHistoryId: "1001",
        changedMessageIds: ["delivered"],
        removedMessageIds: [],
      }),
    });

    await expect(reconcile(params, account.client)).resolves.toEqual({ ran: true, complete: true });

    expect(account.historyStarts).toEqual(["1000"]);
    expect(account.listings).toEqual([]);
    expect(account.fetches).toEqual([{ id: "delivered", format: "full" }]);
    expect(await storedMessages(params.mailboxItemId)).toEqual([
      expect.objectContaining({
        providerMessageId: "delivered",
        arrival: "live",
        contentState: "full",
        body: "Body of delivered",
        storedAttachments: 1,
      }),
    ]);
    expect((await syncState(params.mailboxItemId)).gmailHistoryId).toBe("1001");
  });

  it("resumes an interrupted listing at its stored page instead of listing again, without duplicates", async () => {
    const params = await setup("gmail_api");
    // Index pages: the pass budget reaches past the first page, so the failure hits the second one.
    const old = ids("old", PAGE + 10);
    const failing = gmailAccount({ recent: [], old, failFetch: old[PAGE + 3] });

    await expect(reconcile(params, failing.client)).rejects.toThrow("Gmail sync provider request failed unexpectedly");
    // The first page committed with the listing cursor after it; nothing of the failed second page did.
    const interrupted = await syncState(params.mailboxItemId);
    const windowStart = windowStartSeconds(interrupted.connectedAt);
    expect(interrupted).toMatchObject({
      gmailHistoryId: "1000",
      gmailListingPhase: "index",
      gmailListingPageToken: `before:${windowStart + 1}:1`,
      initialSyncCompletedAt: null,
    });
    expect((await storedMessages(params.mailboxItemId)).map((m) => m.providerMessageId)).toEqual(old.slice(0, PAGE));

    const resumed = gmailAccount({ recent: [], old });
    await expect(reconcile(params, resumed.client)).resolves.toEqual({ ran: true, complete: true });

    // The history id captured before the listing is kept and its history applied; the listing goes on at page 2.
    expect(resumed.historyIdCaptures).toBe(0);
    expect(resumed.historyStarts).toEqual(["1000"]);
    expect(resumed.listings).toEqual([
      { query: `before:${windowStart + 1}`, pageToken: `before:${windowStart + 1}:1` },
    ]);
    expect(resumed.fetches.map((fetch) => fetch.id)).toEqual(old.slice(PAGE));
    const stored = await storedMessages(params.mailboxItemId);
    expect(stored.map((m) => m.providerMessageId)).toEqual(old);
    expect(stored.every((m) => m.contentState === "index" && m.arrival === "backfill")).toBe(true);
    expect((await syncState(params.mailboxItemId)).initialSyncCompletedAt).not.toBeNull();
  });

  it("ends a pass at its full-message budget, asks for a rerun and leaves the initial sync open until the listing ends", async () => {
    const params = await setup("gmail_api");
    const recent = ids("recent", GMAIL_FULL_MESSAGES_PER_PASS + 20);
    const account = gmailAccount({ recent, old: ["old"] });

    const first = recordingPass();
    await expect(reconcile(params, account.client, first)).resolves.toEqual({ ran: true, complete: false });
    expect(first.finished).toEqual([false]);
    expect((await storedMessages(params.mailboxItemId)).length).toBe(GMAIL_FULL_MESSAGES_PER_PASS);
    const partial = await syncState(params.mailboxItemId);
    expect(partial.gmailListingPhase).toBe("full");
    expect(partial.initialSyncCompletedAt).toBeNull();
    // Due at once, so the sweep resumes the listing even when the follow-up job is lost.
    expect(new Date(partial.nextExpectedActivityAt ?? 0).getTime()).toBeLessThanOrEqual(Date.now());

    const second = recordingPass();
    await expect(reconcile(params, account.client, second)).resolves.toEqual({ ran: true, complete: true });
    expect(second.finished).toEqual([true]);
    expect((await storedMessages(params.mailboxItemId)).length).toBe(recent.length + 1);
    expect((await syncState(params.mailboxItemId)).initialSyncCompletedAt).not.toBeNull();
  });

  it("restarts the listing as backfill from a newly captured history id when history.list answers 404", async () => {
    const params = await setup("gmail_api");
    await reconcile(params, gmailAccount({ recent: ["before"], old: [] }).client);
    const account = gmailAccount({
      recent: ["before", "resynced"],
      old: ["old-resynced"],
      history: (startHistoryId) => ({
        invalidated: true,
        newHistoryId: startHistoryId,
        changedMessageIds: [],
        removedMessageIds: [],
      }),
    });

    await expect(reconcile(params, account.client)).resolves.toEqual({ ran: true, complete: true });

    expect(account.historyIdCaptures).toBe(1);
    // The known message is refreshed from its metadata, the new ones are fetched by their phase.
    expect(account.fetches).toEqual([
      { id: "before", format: "metadata" },
      { id: "resynced", format: "full" },
      { id: "old-resynced", format: "metadata" },
    ]);
    expect(
      (await storedMessages(params.mailboxItemId)).map((m) => [m.providerMessageId, m.arrival, m.contentState]),
    ).toEqual([
      ["before", "backfill", "full"],
      ["old-resynced", "backfill", "index"],
      ["resynced", "backfill", "full"],
    ]);
    expect(await syncState(params.mailboxItemId)).toMatchObject({
      gmailHistoryId: "1000",
      gmailListingPhase: null,
      lastError: null,
    });
  });

  it("leaves the cursor of a pass that another pass overtook as that pass wrote it", async () => {
    const params = await setup("gmail_api");
    await reconcile(params, gmailAccount({ recent: [], old: [] }).client);
    const account = gmailAccount({
      recent: [],
      old: [],
      history: () => ({ invalidated: false, newHistoryId: "1001", changedMessageIds: ["late"], removedMessageIds: [] }),
    });
    const moved = { ...account.client };
    // Another pass stores a newer history id while this one fetches.
    moved.fetchMessage = async (id, format) => {
      await inTenant((client) =>
        recordGmailSyncCursor(client, params.mailboxItemId, {
          historyId: "2000",
          listingPhase: null,
          listingPageToken: null,
        }),
      );
      return account.client.fetchMessage(id, format);
    };

    await expect(reconcile(params, moved)).resolves.toEqual({ ran: true, complete: false });
    expect(await storedMessages(params.mailboxItemId)).toEqual([]);
    expect((await syncState(params.mailboxItemId)).gmailHistoryId).toBe("2000");
  });
});

interface FakeGraphAccount {
  client: GraphMailClient;
  deltaUrls: Array<string | null>;
  contentFetches: string[];
  probe: ReturnType<typeof transactionProbe>;
}

const graphChange = (id: string, date: Date): GraphChangedMessage => ({
  id,
  parentFolderId: "inbox-id",
  removed: false,
  message: { messageId: `<${id}@graph.test>`, subject: id, envelope: { from: { address: "a@x.test" } }, date },
  preview: `Preview of ${id}`,
});

/**
 * A Graph account whose delta answers from `pages`: `null` for a round from scratch, otherwise by the link asked
 * for; an unknown link answers 410. `failContent` makes the body fetch of that id fail once.
 */
function graphAccount(pages: Map<string | null, GraphDeltaPage>, options: { failContent?: string } = {}) {
  const probe = transactionProbe();
  let failContent = options.failContent;
  const fake: FakeGraphAccount = {
    deltaUrls: [],
    contentFetches: [],
    probe,
    client: {
      listFolders: async () => {
        await probe.check();
        return [{ id: "inbox-id", displayName: "Inbox", wellKnownName: "inbox" }];
      },
      fetchDeltaPage: async (url) => {
        await probe.check();
        fake.deltaUrls.push(url);
        return pages.get(url) ?? null;
      },
      fetchMessageContent: async (id) => {
        await probe.check();
        fake.contentFetches.push(id);
        if (id === failContent) {
          failContent = undefined;
          throw new Error("Graph sync provider request failed unexpectedly");
        }
        return {
          bodyText: `Body of ${id}`,
          attachments: [
            {
              filename: `${id}.txt`,
              contentType: "text/plain",
              contentId: null,
              disposition: "attachment",
              providerPart: `attachment-of-${id}`,
              openStream: () => Readable.from([`bytes of ${id}`]),
            },
          ],
        };
      },
      patchMessage: async () => {
        await probe.check();
      },
    },
  };
  return fake;
}

describe("Graph sync stores recent mail in full and older history as an index", () => {
  const reconcile = (params: Setup, graph: GraphMailClient, pass = recordingPass()) =>
    runInTenant(tenantId, () => reconcileGraphAccount(pool, graph, { ...params, pass }));

  it("fetches the body of a recent message only, keeps the preview of an old one, stores the immutable ids", async () => {
    const params = await setup("graph_api");
    const account = graphAccount(
      new Map([
        [
          null,
          {
            changes: [graphChange("AAMkImmutable-recent", RECENT_DATE), graphChange("AAMkImmutable-old", OLD_DATE)],
            nextLink: null,
            deltaLink: "delta-1",
          },
        ],
      ]),
    );
    const pass = recordingPass();

    await expect(reconcile(params, account.client, pass)).resolves.toEqual({ ran: true, complete: true });

    expect(account.contentFetches).toEqual(["AAMkImmutable-recent"]);
    expect(await storedMessages(params.mailboxItemId)).toEqual([
      {
        providerMessageId: "AAMkImmutable-old",
        arrival: "backfill",
        contentState: "index",
        preview: "Preview of AAMkImmutable-old",
        body: "",
        attachments: 0,
        storedAttachments: 0,
      },
      {
        providerMessageId: "AAMkImmutable-recent",
        arrival: "backfill",
        contentState: "full",
        preview: "Body of AAMkImmutable-recent",
        body: "Body of AAMkImmutable-recent",
        attachments: 1,
        storedAttachments: 1,
      },
    ]);
    const { rows } = await admin.query<{ provider_part: string }>(
      `SELECT a.provider_part FROM mail_attachments a JOIN mail_message_meta m ON m.item_id = a.message_item_id
        WHERE m.mailbox_item_id = $1`,
      [params.mailboxItemId],
    );
    expect(rows).toEqual([{ provider_part: "attachment-of-AAMkImmutable-recent" }]);
    const state = await syncState(params.mailboxItemId);
    expect(state).toMatchObject({ graphDeltaLink: "delta-1", graphDeltaNextLink: null });
    expect(state.initialSyncCompletedAt).not.toBeNull();
    expect(pass.finished).toEqual([true]);
    expect(account.probe.openAtCalls.length).toBeGreaterThan(0);
    expect(account.probe.openAtCalls.every((open) => open === 0)).toBe(true);
  });

  it("ingests the messages of a round from the stored delta link as live and in full", async () => {
    const params = await setup("graph_api");
    await reconcile(
      params,
      graphAccount(new Map([[null, { changes: [], nextLink: null, deltaLink: "delta-1" }]])).client,
    );
    const account = graphAccount(
      new Map([
        ["delta-1", { changes: [graphChange("delivered", RECENT_DATE)], nextLink: null, deltaLink: "delta-2" }],
      ]),
    );

    await expect(reconcile(params, account.client)).resolves.toEqual({ ran: true, complete: true });

    expect(account.deltaUrls).toEqual(["delta-1"]);
    expect(await storedMessages(params.mailboxItemId)).toEqual([
      expect.objectContaining({ providerMessageId: "delivered", arrival: "live", contentState: "full" }),
    ]);
    expect((await syncState(params.mailboxItemId)).graphDeltaLink).toBe("delta-2");
  });

  it("resumes an interrupted round at its stored next link and promotes the delta link only at the round's end", async () => {
    const params = await setup("graph_api");
    const pages = new Map<string | null, GraphDeltaPage>([
      [null, { changes: [graphChange("first", RECENT_DATE)], nextLink: "next-2", deltaLink: null }],
      ["next-2", { changes: [graphChange("second", RECENT_DATE)], nextLink: null, deltaLink: "delta-1" }],
    ]);

    await expect(reconcile(params, graphAccount(pages, { failContent: "second" }).client)).rejects.toThrow(
      "Graph sync provider request failed unexpectedly",
    );
    expect(await syncState(params.mailboxItemId)).toMatchObject({
      graphDeltaLink: null,
      graphDeltaNextLink: "next-2",
      initialSyncCompletedAt: null,
    });
    expect((await storedMessages(params.mailboxItemId)).map((m) => m.providerMessageId)).toEqual(["first"]);

    const resumed = graphAccount(pages);
    await expect(reconcile(params, resumed.client)).resolves.toEqual({ ran: true, complete: true });

    expect(resumed.deltaUrls).toEqual(["next-2"]);
    expect(resumed.contentFetches).toEqual(["second"]);
    const stored = await storedMessages(params.mailboxItemId);
    // Still backfill: the round started from scratch.
    expect(stored.map((m) => [m.providerMessageId, m.arrival])).toEqual([
      ["first", "backfill"],
      ["second", "backfill"],
    ]);
    const state = await syncState(params.mailboxItemId);
    expect(state).toMatchObject({ graphDeltaLink: "delta-1", graphDeltaNextLink: null });
    expect(state.initialSyncCompletedAt).not.toBeNull();
  });

  it("ends a pass at its full-message budget and asks for a rerun", async () => {
    const params = await setup("graph_api");
    const recent = ids("recent", GRAPH_FULL_MESSAGES_PER_PASS + 5);
    const pages = new Map<string | null, GraphDeltaPage>([
      [
        null,
        {
          changes: recent.slice(0, GRAPH_FULL_MESSAGES_PER_PASS).map((id) => graphChange(id, RECENT_DATE)),
          nextLink: "next-2",
          deltaLink: null,
        },
      ],
      [
        "next-2",
        {
          changes: recent.slice(GRAPH_FULL_MESSAGES_PER_PASS).map((id) => graphChange(id, RECENT_DATE)),
          nextLink: null,
          deltaLink: "delta-1",
        },
      ],
    ]);

    const first = recordingPass();
    await expect(reconcile(params, graphAccount(pages).client, first)).resolves.toEqual({ ran: true, complete: false });
    expect(first.finished).toEqual([false]);
    expect((await storedMessages(params.mailboxItemId)).length).toBe(GRAPH_FULL_MESSAGES_PER_PASS);
    expect(await syncState(params.mailboxItemId)).toMatchObject({
      graphDeltaNextLink: "next-2",
      initialSyncCompletedAt: null,
    });

    const second = recordingPass();
    await expect(reconcile(params, graphAccount(pages).client, second)).resolves.toEqual({
      ran: true,
      complete: true,
    });
    expect(second.finished).toEqual([true]);
    expect((await storedMessages(params.mailboxItemId)).length).toBe(recent.length);
  });

  it.each([
    { name: "the stored delta link", cursor: { deltaLink: "delta-old", nextLink: null } },
    { name: "the next link of a round in progress", cursor: { deltaLink: "delta-old", nextLink: "next-old" } },
  ])("restarts from scratch as backfill when $name answers 410", async ({ cursor }) => {
    const params = await setup("graph_api");
    await reconcile(
      params,
      graphAccount(new Map([[null, { changes: [], nextLink: null, deltaLink: "delta-0" }]])).client,
    );
    await inTenant((client) => recordGraphSyncCursor(client, params.mailboxItemId, cursor));
    const account = graphAccount(
      new Map([[null, { changes: [graphChange("resynced", RECENT_DATE)], nextLink: null, deltaLink: "delta-new" }]]),
    );

    await expect(reconcile(params, account.client)).resolves.toEqual({ ran: true, complete: true });

    expect(account.deltaUrls).toEqual([cursor.nextLink ?? cursor.deltaLink, null]);
    expect(await storedMessages(params.mailboxItemId)).toEqual([
      expect.objectContaining({ providerMessageId: "resynced", arrival: "backfill", contentState: "full" }),
    ]);
    expect(await syncState(params.mailboxItemId)).toMatchObject({
      graphDeltaLink: "delta-new",
      graphDeltaNextLink: null,
      lastError: null,
    });
  });
});
