import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgentRun } from "../agentRuns/agentRunsStore.js";
import { resolveModuleAgentToolsForRun } from "../agentTools/moduleAgentTools.js";
import { createUser } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { GmailRestClient } from "../mail/gmailRestClient.js";
import { GraphRestClient } from "../mail/graphRestClient.js";
import { createImapSessionPool, type ImapSessionPool } from "../mail/imapSessionPool.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { MAIL_SEARCH_PROVIDER_SEARCHES_PER_RUN } from "../mail/mailAgentTools.js";
import type { MailContentProviders } from "../mail/mailMessageContent.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import {
  bindMailAgentRemoteSearch,
  createMailSearchRouteHandler,
  type MailRemoteSearchOptions,
  type MailSearchRouteDependencies,
} from "../mail/mailRemoteSearch.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapServer } from "../testSupport/fakeImapServer.js";
import {
  connectLoopbackImapClient,
  createImapMailboxFixture,
  IMAP_FIXTURE_ACCOUNT,
} from "../testSupport/imapMailboxFixture.js";
import { recordingStorage } from "../testSupport/mailAttachmentFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const QRESYNC = ["ENABLE", "IDLE", "CONDSTORE", "QRESYNC", "MOVE", "UIDPLUS", "SPECIAL-USE"];
const FOLDERS = [
  { path: "INBOX", specialUse: "\\Inbox" },
  { path: "Archive", specialUse: "\\Archive" },
  { path: "Sent", specialUse: "\\Sent" },
  { path: "Trash", specialUse: "\\Trash" },
  { path: "Junk", specialUse: "\\Junk" },
] as const;
/** Past the snippet an index message keeps, so only the provider holds what follows. */
const FILLER = "Lorem ipsum dolor sit amet. ".repeat(200);

let admin: Pool;
let runtime: Pool;
let tenant: string;
let other: string;
let userId: string;
const servers: FakeImapServer[] = [];
const sessionPools: ImapSessionPool[] = [];

/** An 8-bit plain-text message dated 200 days ago (so stored as an index) whose body ends with `bodyTail`. */
function indexMessage(subject: string, bodyTail: string, messageId = `<${randomUUID()}@sender.example.test>`) {
  return Buffer.from(
    [
      `Message-ID: ${messageId}`,
      "From: Sender <sender@sender.example.test>",
      `To: ${IMAP_FIXTURE_ACCOUNT}`,
      `Subject: ${subject}`,
      `Date: ${new Date(Date.now() - 200 * DAY_MS).toUTCString()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      `${FILLER}${bodyTail}`,
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

/** A throttle granting `limit` searches, then refusing; records what it was asked for. */
function countingThrottle(limit = Number.MAX_SAFE_INTEGER) {
  const asked: string[] = [];
  return {
    asked,
    throttle: {
      tryAcquire(action: "mailRemoteSearch", user: string) {
        asked.push(`${action}:${user}`);
        return asked.length <= limit ? { granted: true as const } : { granted: false as const, retryAfterSeconds: 42 };
      },
    },
  };
}

interface ImapAccount {
  server: FakeImapServer;
  mailboxId: string;
  connects: { count: number };
  providers: MailContentProviders;
  pass(): Promise<void>;
  /** Delivers an index message with `bodyTail`, returns its Message-ID. */
  deliver(path: string, subject: string, bodyTail: string): string;
}

/** A generic IMAP account whose sync and provider searches both go to one loopback server. */
async function imapAccount(options: { refuseSearchCharset?: boolean } = {}): Promise<ImapAccount> {
  const server = new FakeImapServer({ folders: FOLDERS, capabilities: QRESYNC, latencyMs: 0, ...options });
  servers.push(server);
  const port = await server.listen();
  const mailbox = await createImapMailboxFixture(runtime);
  const sessions = createImapSessionPool();
  sessionPools.push(sessions);
  const connects = { count: 0 };
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
    },
    pass: () => mailbox.sync(() => connectLoopbackImapClient(port), recordingStorage()),
    deliver(path, subject, bodyTail) {
      const messageId = `<${randomUUID()}@sender.example.test>`;
      server.deliver(path, [], indexMessage(subject, bodyTail, messageId));
      return messageId;
    },
  };
}

/** An indexed Gmail or Graph message of a new account with the provider id `providerMessageId`. */
async function restMessage(syncMode: "gmail_api" | "graph_api", providerMessageId: string, subject = "Old") {
  const ids = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
  return withTransaction(runtime, async (client) => {
    const mailbox = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: syncMode, provider: syncMode === "gmail_api" ? "gmail" : "outlook" },
    });
    await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode });
    const folder = await createItemWithClient(
      client,
      { databaseId: ids.foldersDatabaseId, properties: { name: "Inbox", behavior: "folder", specialPurpose: "inbox" } },
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
      subject,
      date: new Date(Date.now() - 200 * DAY_MS),
      envelope: { from: { address: "sender@example.test" }, to: [] },
      attachments: [],
      storage: recordingStorage(),
      storageKeyPrefix: mailbox.id,
    });
    const meta = await client.query<{ thread_id: string }>(
      "SELECT thread_id FROM mail_message_meta WHERE message_id = $1",
      [messageId],
    );
    const [row] = meta.rows;
    if (!row) throw new Error("No meta row");
    return { mailboxId: mailbox.id, threadId: row.thread_id };
  });
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Gmail and Graph answering `answer(url, signal)`; every request is recorded with its `Prefer` header. */
function restProviders(answer: (url: string, signal: AbortSignal | undefined) => Promise<Response>) {
  const requests: Array<{ url: string; prefer: string | null }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    requests.push({ url, prefer: new Headers(init?.headers).get("Prefer") });
    return answer(url, init?.signal ?? undefined);
  };
  return {
    requests,
    providers: {
      createGmailClient: () => new GmailRestClient(async () => "token", fetchImpl),
      createGraphClient: () => new GraphRestClient(async () => "token", fetchImpl),
    } satisfies MailContentProviders,
  };
}

const searchAnswer = z.object({
  threads: z.array(z.looseObject({ threadId: z.uuid(), subject: z.string(), lastMessageAt: z.string() })),
  localCount: z.number(),
  remote: z.object({
    searched: z.array(z.uuid()),
    failed: z.array(z.object({ mailboxId: z.uuid(), reason: z.string() })),
    unindexed: z.number(),
  }),
});

async function search(dependencies: MailSearchRouteDependencies, query: string, options?: MailRemoteSearchOptions) {
  const answer = await createMailSearchRouteHandler(
    runtime,
    dependencies,
    options,
  )({ req: { url: `/api/mail/search?${query}` }, identity: { user: { id: userId } } });
  expect(answer.status).toBe(200);
  return searchAnswer.parse(answer.body);
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

function routeRefusal(dependencies: MailSearchRouteDependencies, query: string) {
  return refusal(
    createMailSearchRouteHandler(
      runtime,
      dependencies,
    )({ req: { url: `/api/mail/search?${query}` }, identity: { user: { id: userId } } }),
  );
}

describe("two-layer mail search", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    userId = (await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "x" }))
      .id;
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(other, () => seedSystem(runtime));
  });

  afterEach(async () => {
    bindMailAgentRemoteSearch(undefined);
    for (const sessions of sessionPools.splice(0)) await sessions.close();
    for (const server of servers.splice(0)) await server.close();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn), 60_000);

  describe("GET /api/mail/search over IMAP", () => {
    tenantIt("finds a word only an indexed message's body holds at the provider and answers its thread", async () => {
      const account = await imapAccount();
      const messageId = account.deliver("INBOX", "Old offer", "the zanzibar clause");
      await account.pass();
      const message = await messageByMessageId(messageId);
      expect(message.content_state).toBe("index");
      const { asked, throttle } = countingThrottle();
      const dependencies = { mailContent: account.providers, throttle };

      const answer = await search(dependencies, "q=zanzibar");

      expect(answer.threads.map((thread) => [thread.threadId, thread.subject])).toEqual([
        [message.thread_id, "Old offer"],
      ]);
      expect(answer.localCount).toBe(0);
      expect(answer.remote).toEqual({ searched: [account.mailboxId], failed: [], unindexed: 0 });
      expect(asked).toEqual([`mailRemoteSearch:${userId}`]);
      // Inbox, Archive and Sent are searched; Trash and Junk are not.
      expect(account.server.searches.filter((criteria) => criteria.includes("TEXT"))).toHaveLength(3);
    });

    tenantIt("answers a thread both layers find once, counted as a local match", async () => {
      const account = await imapAccount();
      const messageId = account.deliver("INBOX", "Zanzibar terms", "the zanzibar clause");
      await account.pass();
      const message = await messageByMessageId(messageId);

      const answer = await search(
        { mailContent: account.providers, throttle: countingThrottle().throttle },
        "q=zanzibar",
      );

      expect(answer.threads.map((thread) => thread.threadId)).toEqual([message.thread_id]);
      expect(answer.localCount).toBe(1);
      expect(answer.remote.searched).toEqual([account.mailboxId]);
    });

    tenantIt("searches neither Trash nor Junk, and counts a hit not ingested yet as unindexed", async () => {
      const account = await imapAccount();
      const kept = account.deliver("Archive", "Kept", "the zanzibar clause");
      account.deliver("Trash", "Thrown away", "the zanzibar clause");
      account.deliver("Junk", "Spam", "the zanzibar clause");
      await account.pass();
      account.deliver("Sent", "Not synced yet", "the zanzibar clause");

      const answer = await search(
        { mailContent: account.providers, throttle: countingThrottle().throttle },
        "q=zanzibar",
      );

      expect(answer.threads.map((thread) => thread.threadId)).toEqual([(await messageByMessageId(kept)).thread_id]);
      expect(answer.remote).toEqual({ searched: [account.mailboxId], failed: [], unindexed: 1 });
    });

    tenantIt("applies the query's operators to the provider's hits and asks no provider without words", async () => {
      const account = await imapAccount();
      account.deliver("INBOX", "Old offer", "the zanzibar clause");
      await account.pass();
      const { asked, throttle } = countingThrottle();
      const dependencies = { mailContent: account.providers, throttle };

      const unmatched = await search(dependencies, `q=${encodeURIComponent("zanzibar from:nobody@else.test")}`);
      expect(unmatched.threads).toEqual([]);
      expect(unmatched.remote.searched).toEqual([account.mailboxId]);

      const searchesBefore = account.server.searches.length;
      const operatorsOnly = await search(dependencies, `q=${encodeURIComponent("from:sender@sender.example.test")}`);
      expect(operatorsOnly.threads).toHaveLength(1);
      expect(operatorsOnly.localCount).toBe(1);
      expect(operatorsOnly.remote).toEqual({ searched: [], failed: [], unindexed: 0 });
      expect(account.server.searches.length).toBe(searchesBefore);
      expect(asked).toHaveLength(1);
    });

    tenantIt("searches the other folders when the server no longer holds one of them", async () => {
      const account = await imapAccount();
      const messageId = account.deliver("INBOX", "Old offer", "the zanzibar clause");
      account.deliver("Archive", "Archived offer", "the zanzibar clause");
      await account.pass();
      account.server.deleteFolder("Archive");

      const answer = await search(
        { mailContent: account.providers, throttle: countingThrottle().throttle },
        "q=zanzibar",
      );

      expect(answer.threads.map((thread) => thread.threadId)).toEqual([
        (await messageByMessageId(messageId)).thread_id,
      ]);
      expect(answer.remote).toEqual({ searched: [account.mailboxId], failed: [], unindexed: 0 });
    });

    tenantIt(
      "maps no hit over edges a pass renumbered under a new UIDVALIDITY after the provider searched",
      async () => {
        const account = await imapAccount();
        account.deliver("INBOX", "Old offer", "the zanzibar clause");
        const otherId = account.deliver("INBOX", "Other offer", "another clause");
        await account.pass();
        const create = account.providers.createImapClient!;
        let renumbered = false;
        const providers: MailContentProviders = {
          ...account.providers,
          createImapClient: async (...args) => {
            const client = await create(...args);
            const searchText = client.searchText!.bind(client);
            client.searchText = async (path, terms) => {
              const uids = await searchText(path, terms);
              if (path === "INBOX" && !renumbered) {
                renumbered = true;
                // The hit's message leaves and the server renumbers the rest: the other message takes its UID 1.
                account.server.expunge("INBOX", 1);
                account.server.resetUidValidity("INBOX", 1);
                await account.pass();
              }
              return uids;
            };
            return client;
          },
        };

        const answer = await search({ mailContent: providers, throttle: countingThrottle().throttle }, "q=zanzibar");

        expect(renumbered).toBe(true);
        const other = await messageByMessageId(otherId);
        expect(answer.threads.map((thread) => thread.threadId)).not.toContain(other.thread_id);
        expect(answer.remote).toEqual({ searched: [account.mailboxId], failed: [], unindexed: 1 });
      },
    );

    tenantIt(
      "searches a non-ASCII word with CHARSET UTF-8, and again folded to ASCII where the server refuses it",
      async () => {
        const utf8 = await imapAccount();
        const accented = utf8.deliver("INBOX", "Old offer", "the účetní clause");
        await utf8.pass();
        const dependencies = { mailContent: utf8.providers, throttle: countingThrottle().throttle };

        const found = await search(dependencies, `q=${encodeURIComponent("účetní")}`);
        expect(found.threads.map((thread) => thread.threadId)).toEqual([
          (await messageByMessageId(accented)).thread_id,
        ]);
        expect(utf8.server.searches.at(-1)).toEqual(expect.arrayContaining(["CHARSET", "UTF-8", "TEXT"]));

        const ascii = await imapAccount({ refuseSearchCharset: true });
        const folded = ascii.deliver("INBOX", "Older offer", "the ucetni clause");
        await ascii.pass();
        const refused = await search(
          { mailContent: ascii.providers, throttle: countingThrottle().throttle },
          `q=${encodeURIComponent("účetní")}&mailboxId=${ascii.mailboxId}`,
        );
        expect(refused.threads.map((thread) => thread.threadId)).toEqual([
          (await messageByMessageId(folded)).thread_id,
        ]);
        expect(refused.remote).toEqual({ searched: [ascii.mailboxId], failed: [], unindexed: 0 });
        expect(ascii.server.searches.slice(-2).map((criteria) => criteria.includes("CHARSET"))).toEqual([true, false]);
      },
    );
  });

  describe("GET /api/mail/search over Gmail and Graph", () => {
    tenantIt(
      "passes the query to Gmail as it is and the words to Graph, mapping their ids to local threads",
      async () => {
        const gmail = await restMessage("gmail_api", "gm-1", "Gmail old");
        const graph = await restMessage("graph_api", "AAMk-immutable/1", "Graph old");
        const rest = restProviders(async (url) => {
          if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?"))
            return Response.json({ messages: [{ id: "gm-1" }, { id: "gm-not-synced" }] });
          if (url.startsWith("https://graph.microsoft.com/v1.0/me/messages?"))
            return Response.json({ value: [{ id: "AAMk-immutable/1" }] });
          return new Response(null, { status: 404 });
        });
        const answer = await search(
          { mailContent: rest.providers, throttle: countingThrottle().throttle },
          `q=${encodeURIComponent("zanzibar -draft")}`,
        );

        expect(answer.threads.map((thread) => thread.threadId).sort()).toEqual([gmail.threadId, graph.threadId].sort());
        expect(answer.localCount).toBe(0);
        expect(answer.remote.searched.sort()).toEqual([gmail.mailboxId, graph.mailboxId].sort());
        expect(answer.remote.unindexed).toBe(1);
        const gmailRequest = rest.requests.find((request) => request.url.includes("gmail"));
        expect(new URL(gmailRequest?.url ?? "").searchParams.get("q")).toBe("zanzibar -draft");
        expect(new URL(gmailRequest?.url ?? "").searchParams.get("maxResults")).toBe("100");
        const graphRequest = rest.requests.find((request) => request.url.includes("graph"));
        expect(graphRequest?.url).toBe(
          `https://graph.microsoft.com/v1.0/me/messages?$search=${encodeURIComponent('"zanzibar NOT draft"')}&$top=100&$select=id`,
        );
        expect(graphRequest?.prefer).toBe('IdType="ImmutableId"');
      },
    );

    tenantIt("reports a failing provider and still answers the other accounts", async () => {
      const gmail = await restMessage("gmail_api", "gm-1");
      const graph = await restMessage("graph_api", "AAMk-1");
      const rest = restProviders(async (url) =>
        url.includes("gmail") ? new Response("down", { status: 503 }) : Response.json({ value: [{ id: "AAMk-1" }] }),
      );

      const answer = await search({ mailContent: rest.providers, throttle: countingThrottle().throttle }, "q=zanzibar");

      expect(answer.threads.map((thread) => thread.threadId)).toEqual([graph.threadId]);
      expect(answer.remote).toEqual({
        searched: [graph.mailboxId],
        failed: [{ mailboxId: gmail.mailboxId, reason: "providerUnreachable" }],
        unindexed: 0,
      });
    });

    tenantIt(
      "reports an account that has not answered by the deadline as timed out and aborts its request",
      async () => {
        const gmail = await restMessage("gmail_api", "gm-1");
        const graph = await restMessage("graph_api", "AAMk-1");
        const aborted: string[] = [];
        const rest = restProviders((url, signal) => {
          if (!url.includes("gmail")) return Promise.resolve(Response.json({ value: [{ id: "AAMk-1" }] }));
          return new Promise((_, reject) =>
            signal?.addEventListener("abort", () => {
              aborted.push(url);
              reject(new Error("aborted"));
            }),
          );
        });

        const answer = await search(
          { mailContent: rest.providers, throttle: countingThrottle().throttle },
          "q=zanzibar",
          { deadlineMs: 300 },
        );

        expect(answer.threads.map((thread) => thread.threadId)).toEqual([graph.threadId]);
        expect(answer.remote).toEqual({
          searched: [graph.mailboxId],
          failed: [{ mailboxId: gmail.mailboxId, reason: "timeout" }],
          unindexed: 0,
        });
        expect(aborted).toHaveLength(1);
      },
    );
  });

  describe("refusals and skipped accounts", () => {
    tenantIt(
      "skips an account with Mail off or waiting for a sign-in without asking its provider or the throttle",
      async () => {
        const paused = await imapAccount();
        const signIn = await imapAccount();
        for (const account of [paused, signIn]) account.deliver("INBOX", "Old offer", "the zanzibar clause");
        await paused.pass();
        await signIn.pass();
        // A switch to Mail off and a refused login at the last sync record these.
        await runtime.query("UPDATE mail_account_sync_state SET sync_paused_at = now() WHERE item_id = $1", [
          paused.mailboxId,
        ]);
        await runtime.query(
          "UPDATE mail_account_sync_state SET last_failure_kind = 'reauthorization' WHERE item_id = $1",
          [signIn.mailboxId],
        );
        const { asked, throttle } = countingThrottle();
        const connectsBefore = paused.connects.count + signIn.connects.count;

        const answer = await search({ mailContent: paused.providers, throttle }, "q=zanzibar");

        expect(answer.threads).toEqual([]);
        expect(answer.remote.searched).toEqual([]);
        expect(answer.remote.failed.sort((a, b) => a.mailboxId.localeCompare(b.mailboxId))).toEqual(
          [
            { mailboxId: paused.mailboxId, reason: "mailOff" },
            { mailboxId: signIn.mailboxId, reason: "reauthorizationRequired" },
          ].sort((a, b) => a.mailboxId.localeCompare(b.mailboxId)),
        );
        expect(paused.connects.count + signIn.connects.count).toBe(connectsBefore);
        expect(asked).toEqual([]);
      },
    );

    tenantIt("refuses a search over the user's throttle with 429 and asks no provider", async () => {
      const account = await imapAccount();
      account.deliver("INBOX", "Old offer", "the zanzibar clause");
      await account.pass();

      const answer = await routeRefusal(
        { mailContent: account.providers, throttle: countingThrottle(0).throttle },
        "q=zanzibar",
      );

      expect(answer).toMatchObject({ status: 429, code: "rate_limited" });
      expect(account.connects.count).toBe(0);
      expect(account.server.searches.filter((criteria) => criteria.includes("TEXT"))).toEqual([]);
    });

    it.each([
      ["no q", ""],
      ["a blank q", "q=%20%20"],
      ["a q over 1000 characters", `q=${"a".repeat(1001)}`],
      ["a limit of 0", "q=offer&limit=0"],
      ["a limit over 200", "q=offer&limit=201"],
      ["a limit that is no number", "q=offer&limit=ten"],
      ["a mailboxId that is no UUID", "q=offer&mailboxId=x"],
      ["an invalid search date", "q=before%3Ayesterday"],
    ])("answers %s with a 400", async (_name, query) => {
      const answer = await runInTenant(tenant, () => routeRefusal({}, query));
      expect(answer).toMatchObject({ status: 400, code: "validation_failed" });
    });

    it("answers another tenant's mailbox and a random id alike, asking no provider", async () => {
      const account = await runInTenant(tenant, async () => {
        const created = await imapAccount();
        created.deliver("INBOX", "Old offer", "the zanzibar clause");
        await created.pass();
        return created;
      });
      const { asked, throttle } = countingThrottle();
      const dependencies = { mailContent: account.providers, throttle };

      const random = await runInTenant(other, () => routeRefusal(dependencies, `q=zanzibar&mailboxId=${randomUUID()}`));
      expect(random).toMatchObject({ status: 404, code: "not_found" });
      expect(
        await runInTenant(other, () => routeRefusal(dependencies, `q=zanzibar&mailboxId=${account.mailboxId}`)),
      ).toEqual(random);
      expect(account.connects.count).toBe(0);
      expect(asked).toEqual([]);

      // The owner searches it, so the refusals above are not a broken route.
      const owned = await runInTenant(tenant, () => search(dependencies, `q=zanzibar&mailboxId=${account.mailboxId}`));
      expect(owned.threads).toHaveLength(1);
    });
  });

  describe("the mail.search agent tool", () => {
    async function mailRun(projectItemId?: string) {
      const mailboxes = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "mailboxes"));
      const project = projectItemId ?? mailboxes?.ownerProjectItemId;
      if (!project) throw new Error("The mail databases have no owner project");
      const run = await createAgentRun(runtime, { projectItemId: project, userId, triggeredBy: "user", task: "mail" });
      return { runId: run.id, projectItemId: project };
    }

    async function searchTool(runId: string, projectItemId: string, capabilities?: ReadonlySet<string>) {
      const registry = await loadFullModuleRegistry();
      return (await resolveModuleAgentToolsForRun(runtime, registry, runId, projectItemId, capabilities)).find(
        (tool) => tool.name === "mail.search",
      );
    }

    const toolAnswer = z.object({
      threads: z.array(
        z.strictObject({
          threadId: z.uuid(),
          subject: z.string(),
          lastMessageAt: z.string(),
          lastSender: z.strictObject({ name: z.string(), address: z.string() }),
          snippet: z.string().nullable(),
        }),
      ),
      localCount: z.number(),
      remoteSearch: z.string(),
      remote: searchAnswer.shape.remote,
    });

    tenantIt("returns compact thread rows the providers found, up to its provider searches per run", async () => {
      const account = await imapAccount();
      const messageId = account.deliver("INBOX", "Old offer", "the zanzibar clause");
      await account.pass();
      const { thread_id: threadId } = await messageByMessageId(messageId);
      const { asked, throttle } = countingThrottle();
      bindMailAgentRemoteSearch({ mailContent: account.providers, throttle });
      const { runId, projectItemId } = await mailRun();
      const tool = await searchTool(runId, projectItemId);
      if (!tool) throw new Error("The run has no mail.search");

      const answers = [];
      for (let call = 0; call <= MAIL_SEARCH_PROVIDER_SEARCHES_PER_RUN; call++) {
        const result = await tool.invoke({ query: "zanzibar" });
        expect(result.error, result.result).toBe(false);
        answers.push(toolAnswer.parse(JSON.parse(result.result)));
      }

      expect(answers[0]).toEqual({
        threads: [
          {
            threadId,
            subject: "Old offer",
            lastMessageAt: expect.any(String),
            lastSender: { name: "Sender", address: "sender@sender.example.test" },
            snippet: expect.stringContaining("Lorem ipsum"),
          },
        ],
        localCount: 0,
        remoteSearch: "searched",
        remote: { searched: [account.mailboxId], failed: [], unindexed: 0 },
      });
      expect(answers.map((answer) => answer.remoteSearch)).toEqual([
        ...Array<string>(MAIL_SEARCH_PROVIDER_SEARCHES_PER_RUN).fill("searched"),
        "runBudgetSpent",
      ]);
      expect(answers.at(-1)?.threads).toEqual([]);
      // The run's user is counted by the throttle, the stored password is read as the agent of the run.
      expect(asked).toHaveLength(MAIL_SEARCH_PROVIDER_SEARCHES_PER_RUN);
      const { rows } = await runtime.query<{ actor_type: string; actor_id: string; purpose: string }>(
        "SELECT DISTINCT actor_type, actor_id, purpose FROM credential_access_log WHERE purpose = 'imap_search'",
      );
      expect(rows).toEqual([{ actor_type: "ai_agent", actor_id: runId, purpose: "imap_search" }]);
    });

    tenantIt("searches the local index only in a process that binds no provider clients", async () => {
      const subject = await restMessage("gmail_api", "gm-1", "Zanzibar terms");
      const { runId, projectItemId } = await mailRun();
      const tool = await searchTool(runId, projectItemId);
      if (!tool) throw new Error("The run has no mail.search");

      const answer = toolAnswer.parse(JSON.parse((await tool.invoke({ query: "zanzibar" })).result));

      expect(answer.threads.map((thread) => thread.threadId)).toEqual([subject.threadId]);
      expect(answer.remoteSearch).toBe("unavailable");
    });

    tenantIt("is offered to a run whose project holds mail.read and to no other", async () => {
      const { runId, projectItemId } = await mailRun();
      expect(await searchTool(runId, projectItemId)).toBeDefined();
      expect(await searchTool(runId, projectItemId, new Set(["mail.draft"]))).toBeUndefined();

      const inbox = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "inbox"));
      if (!inbox?.ownerProjectItemId) throw new Error("Missing the Semprec project");
      const elsewhere = await mailRun(inbox.ownerProjectItemId);
      expect(await searchTool(elsewhere.runId, elsewhere.projectItemId)).toBeUndefined();
    });
  });
});
