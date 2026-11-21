import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../db/pool.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { listMailThreads } from "../mail/mailThreadListQuery.js";
import { createMailThreadReadRouteHandler } from "../mail/mailThreadRoutes.js";
import { IMAP_SEEN_FLAG } from "../mail/messageFlags.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapAccount } from "../testSupport/fakeImapAccount.js";
import { FakeImapServer } from "../testSupport/fakeImapServer.js";
import {
  connectLoopbackImapClient,
  createImapMailboxFixture,
  plainMessage,
  PURELYMAIL_FOLDERS,
} from "../testSupport/imapMailboxFixture.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const LATENCY_MS = 80;

/** About 20 messages over the six folders, as in the production account; INBOX holds unread ones. */
const CONTENT: Record<string, Array<readonly string[]>> = {
  INBOX: [[], [], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG]],
  Sent: [[IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG]],
  Drafts: [[IMAP_SEEN_FLAG]],
  Archive: [[IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG]],
  Trash: [[IMAP_SEEN_FLAG], [IMAP_SEEN_FLAG]],
  Junk: [[]],
};

let admin: Pool;
let runtime: Pool;
let tenant: string;
let server: FakeImapServer | undefined;

const USER_ID = randomUUID();

describe("a quiet IMAP pass against a loopback server with 80 ms per command", () => {
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

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn));

  async function unreadSubjects(): Promise<string[]> {
    const { emailsDatabaseId } = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
    const { rows } = await runtime.query<{ name: string }>(
      `SELECT properties->>'name' AS name FROM items
       WHERE tenant_id = app_tenant_default() AND database_id = $1 AND deleted_at IS NULL
         AND NOT COALESCE(properties->'read' = 'true'::jsonb, false)
       ORDER BY 1`,
      [emailsDatabaseId],
    );
    return rows.map((row) => row.name);
  }

  async function threadIdOf(subject: string): Promise<string> {
    const threads = await withTransaction(runtime, (client) =>
      listMailThreads(client, 50, null, { box: "inbox", folderId: null, mailboxId: null, unread: false }),
    );
    const thread = threads.find((row) => row.subject === subject);
    if (!thread) throw new Error(`No inbox thread ${subject}`);
    return thread.threadId;
  }

  /**
   * The mailbox's messages are ingested through an in-memory account with the same folders, UIDs and flags as the
   * loopback server (which holds no bodies), then one pass over the wire records the server's cursors.
   */
  async function syncedMailbox(capabilities: readonly string[]) {
    const account = new FakeImapAccount([...PURELYMAIL_FOLDERS]);
    server = new FakeImapServer({ folders: PURELYMAIL_FOLDERS, capabilities, latencyMs: LATENCY_MS });
    for (const [path, messages] of Object.entries(CONTENT)) {
      messages.forEach((flags, index) => {
        account.deliver(path, plainMessage(`${path} ${index + 1}`), flags);
        server!.deliver(path, flags);
      });
    }
    const port = await server.listen();
    const mailbox = await createImapMailboxFixture(runtime);
    // A pass ingests at most `IMAP_NEW_MESSAGES_PER_PASS` messages.
    for (let pass = 0; pass < 3; pass++) await mailbox.sync(async () => account.client());
    const overWire = () => connectLoopbackImapClient(port);
    await mailbox.sync(overWire);
    return { mailbox, overWire, server };
  }

  async function measuredPass(sync: () => Promise<void>, wire: FakeImapServer) {
    const from = wire.commands.length;
    const started = performance.now();
    await sync();
    return { counts: wire.countsSince(from), elapsedMs: performance.now() - started };
  }

  const CONDSTORE_LIST_STATUS = ["ENABLE", "CONDSTORE", "LIST-STATUS", "SPECIAL-USE"];
  // The connection's own commands: LOGIN, ENABLE (with CONDSTORE), imapflow's two LISTs and LSUB, LOGOUT.
  it.each([
    {
      name: "CONDSTORE and LIST-STATUS",
      capabilities: CONDSTORE_LIST_STATUS,
      counts: { LOGIN: 1, ENABLE: 1, LIST: 2, LSUB: 1, LOGOUT: 1 },
      maxMs: 900,
    },
    {
      name: "CONDSTORE without LIST-STATUS",
      capabilities: ["ENABLE", "CONDSTORE", "SPECIAL-USE"],
      counts: { LOGIN: 1, ENABLE: 1, LIST: 2, LSUB: 1, STATUS: 6, LOGOUT: 1 },
      maxMs: 1_400,
    },
    {
      name: "no CONDSTORE",
      capabilities: ["SPECIAL-USE"],
      // One SELECT per folder, then the full flag fetch; no UID search.
      counts: { LOGIN: 1, LIST: 2, LSUB: 1, SELECT: 6, FETCH: 6, LOGOUT: 1 },
      maxMs: 2_000,
    },
  ])("sends only the commands a quiet pass needs on a server with $name", ({ capabilities, counts, maxMs }) =>
    runInTenant(tenant, async () => {
      const { mailbox, overWire, server: wire } = await syncedMailbox(capabilities);

      const pass = await measuredPass(() => mailbox.sync(overWire), wire);

      expect(pass.counts).toEqual(counts);
      expect(pass.elapsedMs).toBeLessThan(maxMs);
    }),
  );

  tenantIt("selects only the folder whose flags changed on the server and applies the change", async () => {
    const { mailbox, overWire, server: wire } = await syncedMailbox(CONDSTORE_LIST_STATUS);
    wire.setFlags("Archive", 2, []);

    const pass = await measuredPass(() => mailbox.sync(overWire), wire);

    expect(pass.counts).toEqual({ LOGIN: 1, ENABLE: 1, LIST: 2, LSUB: 1, SELECT: 1, FETCH: 1, LOGOUT: 1 });
    expect(await unreadSubjects()).toEqual(["Archive 2", "INBOX 1", "INBOX 2", "INBOX 6", "Junk 1"]);
  });

  tenantIt("writes a read flag back with one SELECT and STORE and fetches no unchanged folder", async () => {
    const { mailbox, overWire, server: wire } = await syncedMailbox(CONDSTORE_LIST_STATUS);
    const threadId = await threadIdOf("INBOX 1");
    const read = await createMailThreadReadRouteHandler(runtime)({
      params: { threadId },
      body: { read: true },
      identity: { user: { id: USER_ID } },
    });
    expect(read.status).toBe(200);

    const writeBack = await measuredPass(() => mailbox.sync(overWire), wire);

    expect(writeBack.counts).toEqual({ LOGIN: 1, ENABLE: 1, LIST: 2, LSUB: 1, SELECT: 1, STORE: 1, LOGOUT: 1 });
    expect(wire.flagsOf("INBOX", 1)).toEqual([IMAP_SEEN_FLAG]);
    // The STORE raised INBOX's mod-sequence: the next pass looks at INBOX alone and finds the flag it wrote.
    const after = await measuredPass(() => mailbox.sync(overWire), wire);
    expect(after.counts).toEqual({ LOGIN: 1, ENABLE: 1, LIST: 2, LSUB: 1, SELECT: 1, FETCH: 1, LOGOUT: 1 });
    expect(await unreadSubjects()).toEqual(["INBOX 2", "INBOX 6", "Junk 1"]);
  });
});
