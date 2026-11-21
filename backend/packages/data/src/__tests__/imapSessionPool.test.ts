import "../domainWriteHooks.js";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createImapConnectionLimiter, type ImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";
import { createImapSessionPool, type ImapSessionPool } from "../mail/imapSessionPool.js";
import type { MailSyncAdapterFactory } from "../mail/mailSyncJob.js";
import { getMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapServer } from "../testSupport/fakeImapServer.js";
import {
  connectLoopbackImapClient,
  createImapMailboxFixture,
  plainMessage,
  PURELYMAIL_FOLDERS,
  type ImapMailboxFixture,
} from "../testSupport/imapMailboxFixture.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const HOST = "127.0.0.1";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let server: FakeImapServer;
let port: number;
let limiter: ImapConnectionLimiter;
let sessions: ImapSessionPool | undefined;

/** The sync adapter of the composition root over `pool`, connecting to the loopback server. */
function pooledImapClient(pool: ImapSessionPool): NonNullable<MailSyncAdapterFactory["createImapClient"]> {
  return (mailboxItemId, credential, accountLimit) =>
    pool.checkout({
      mailboxItemId,
      accountLimit,
      host: HOST,
      signIn: credential,
      connect: () => connectLoopbackImapClient(port),
    });
}

function sessionPool(idleTimeoutMs?: number): ImapSessionPool {
  sessions = createImapSessionPool(limiter, idleTimeoutMs);
  return sessions;
}

const count = (verb: string) => server.commands.filter((command) => command === verb).length;

async function mailbox(): Promise<ImapMailboxFixture> {
  return createImapMailboxFixture(runtime);
}

async function lastFailureKind(mailboxId: string): Promise<string | null | undefined> {
  return (await withTransaction(runtime, (client) => getMailAccountSyncState(client, mailboxId)))?.lastFailureKind;
}

describe("IMAP sync sessions kept between passes", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    server = new FakeImapServer({ folders: PURELYMAIL_FOLDERS, capabilities: [], latencyMs: 0 });
    server.deliver("INBOX", [], plainMessage("First"));
    port = await server.listen();
    limiter = createImapConnectionLimiter();
  });

  afterEach(async () => {
    await sessions?.close();
    sessions = undefined;
    await server.close();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  const tenantIt = (name: string, fn: () => Promise<void>) => it(name, () => runInTenant(tenant, fn));

  tenantIt("signs in once for two passes of an account and checks the kept connection with a NOOP", async () => {
    const fixture = await mailbox();
    const pool = sessionPool();

    await fixture.sync(pooledImapClient(pool));
    server.deliver("INBOX", [], plainMessage("Second"));
    await fixture.sync(pooledImapClient(pool));

    expect(count("LOGIN")).toBe(1);
    expect(count("NOOP")).toBe(1);
    expect(count("LOGOUT")).toBe(0);
    expect(await lastFailureKind(fixture.mailboxId)).toBeNull();
  });

  tenantIt("discards a session whose provider operation failed, and the next pass signs in again", async () => {
    const fixture = await mailbox();
    const pool = sessionPool();
    await fixture.sync(pooledImapClient(pool));

    server.refusedVerbs.add("LIST");
    await expect(fixture.sync(pooledImapClient(pool))).rejects.toThrow("IMAP provider operation failed unexpectedly");
    await vi.waitFor(() => expect(count("LOGOUT")).toBe(1));
    server.refusedVerbs.delete("LIST");

    await fixture.sync(pooledImapClient(pool));
    expect(count("LOGIN")).toBe(2);
  });

  tenantIt("closes a kept session once it stayed unused for the idle timeout", async () => {
    const fixture = await mailbox();
    const pool = sessionPool(50);
    await fixture.sync(pooledImapClient(pool));

    await vi.waitFor(() => expect(count("LOGOUT")).toBe(1));
    await fixture.sync(pooledImapClient(pool));
    expect(count("LOGIN")).toBe(2);
  });

  tenantIt(
    "closes the account's kept session on closeAccount and every one on close, then refuses checkouts",
    async () => {
      const first = await mailbox();
      const second = await mailbox();
      const pool = sessionPool();
      await first.sync(pooledImapClient(pool));
      await second.sync(pooledImapClient(pool));
      expect(count("LOGIN")).toBe(2);

      await pool.closeAccount(first.mailboxId);
      expect(count("LOGOUT")).toBe(1);
      await first.sync(pooledImapClient(pool));
      expect(count("LOGIN")).toBe(3);

      await pool.close();
      expect(count("LOGOUT")).toBe(3);
      await expect(second.sync(pooledImapClient(pool))).rejects.toThrow("The IMAP session pool is closed");
      expect(count("LOGIN")).toBe(3);
    },
  );

  tenantIt("does not reuse a session opened with another sign-in", async () => {
    const fixture = await mailbox();
    const pool = sessionPool();
    await fixture.sync(pooledImapClient(pool));

    const replaced = await pool.checkout({
      mailboxItemId: fixture.mailboxId,
      accountLimit: 2,
      host: HOST,
      signIn: "a new password",
      connect: () => connectLoopbackImapClient(port),
    });
    await replaced.close();
    expect(count("LOGIN")).toBe(2);
    expect(count("LOGOUT")).toBe(1);
  });

  tenantIt(
    "gives a kept session's account slot up to another connection of the account that waits for it",
    async () => {
      const fixture = await mailbox();
      const pool = sessionPool();
      // A generic account's budget is two: the kept session and one IDLE connection fill it.
      await fixture.sync(pooledImapClient(pool));
      const idle = { accountId: fixture.mailboxId, accountLimit: 2, host: HOST, kind: "idle" as const };
      const first = await limiter.acquire(idle);

      const second = await limiter.acquire(idle);
      expect(count("LOGOUT")).toBe(1);
      first.release();
      second.release();
    },
  );

  tenantIt("lets a checked-out session's caller alone use it, and opens another for a second caller", async () => {
    const fixture = await mailbox();
    const pool = sessionPool();
    const open = pooledImapClient(pool);
    const held = await open(fixture.mailboxId, "app-password", 2);
    const other = await open(fixture.mailboxId, "app-password", 2);
    expect(count("LOGIN")).toBe(2);

    await held.close();
    await expect(held.listFolders()).rejects.toThrow("The IMAP session was handed back");
    // The account keeps one session; the second one handed back is closed.
    await other.close();
    expect(count("LOGOUT")).toBe(1);
  });
});
