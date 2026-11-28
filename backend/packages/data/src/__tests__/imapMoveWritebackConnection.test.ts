import "../domainWriteHooks.js";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTransaction } from "../db/pool.js";
import type { ImapMailClient } from "../mail/imapReconcile.js";
import { listMailThreads } from "../mail/mailThreadListQuery.js";
import { createMailThreadArchiveRouteHandler } from "../mail/mailThreadRoutes.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapAccount } from "../testSupport/fakeImapAccount.js";
import {
  createImapMailboxFixture,
  plainMessage,
  PURELYMAIL_FOLDERS,
  type ImapMailboxFixture,
} from "../testSupport/imapMailboxFixture.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

/** A provider client factory that counts the connections it opens and closes. */
function countedConnections(account: FakeImapAccount) {
  const connections = { opened: 0, closed: 0 };
  const createImapClient = async (): Promise<ImapMailClient> => {
    connections.opened++;
    const client = account.client();
    return {
      ...client,
      close: async () => {
        connections.closed++;
        await client.close();
      },
    };
  };
  return { connections, createImapClient };
}

describe("IMAP move write-back connections", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "alldots_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn));

  /** A synced account whose `count` INBOX threads the user archived; their moves wait for the next pass. */
  async function archivedInbox(count: number): Promise<{ account: FakeImapAccount; mailbox: ImapMailboxFixture }> {
    const account = new FakeImapAccount([...PURELYMAIL_FOLDERS], { condstore: true });
    for (let index = 1; index <= count; index++) account.deliver("INBOX", plainMessage(`Message ${index}`));
    const mailbox = await createImapMailboxFixture(runtime);
    await mailbox.sync(async () => account.client());
    const threads = await withTransaction(runtime, (client) =>
      listMailThreads(client, 50, null, { box: "inbox", folderId: null, mailboxId: null, unread: false }),
    );
    expect(threads).toHaveLength(count);
    for (const { threadId } of threads) {
      const archived = await createMailThreadArchiveRouteHandler(runtime)({ params: { threadId } });
      expect(archived).toEqual({ status: 200, body: { threadId, moved: 1 } });
    }
    return { account, mailbox };
  }

  tenantIt("moves every archived message of a pass over one connection and closes it", async () => {
    const { account, mailbox } = await archivedInbox(3);
    const { connections, createImapClient } = countedConnections(account);
    const callsBefore = account.calls.length;

    await mailbox.sync(createImapClient);

    expect([account.countIn("INBOX"), account.countIn("Archive")]).toEqual([0, 3]);
    expect(account.callsSince(callsBefore).filter((call) => call.startsWith("executeMoveStep"))).toHaveLength(3);
    // One connection for the move phase, one for the reconcile that follows it.
    expect(connections).toEqual({ opened: 2, closed: 2 });
  });

  tenantIt("opens a fresh connection for the next move after a move whose outcome is unknown", async () => {
    const { account, mailbox } = await archivedInbox(3);
    const { connections, createImapClient } = countedConnections(account);
    let failedOnce = false;
    account.gate = async (call) => {
      if (call.method !== "executeMoveStep" || failedOnce) return;
      failedOnce = true;
      throw new Error("the connection dropped while the MOVE was in flight");
    };

    await mailbox.sync(createImapClient);

    // The first move stays uncertain and is not repeated; the other two run over a new connection.
    expect([account.countIn("INBOX"), account.countIn("Archive")]).toEqual([1, 2]);
    expect(connections).toEqual({ opened: 3, closed: 3 });
  });
});
