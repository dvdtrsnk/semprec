import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { inspect } from "node:util";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../auth/usersStore.js";
import { verifyCalDavServer } from "../calendar/sync/adapters/caldav/caldavConnectVerification.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError } from "../errors.js";
import { logger as mailLogger } from "../mail/logger.js";
import { verifyMailCredentialsForTests } from "../mail/mailCredentialVerification.js";
import { createMailboxPasswordConnectRouteHandler } from "../mail/mailboxPasswordRouteHandlers.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { allowLoopbackOutboundForTests } from "../net/outboundAddressPolicy.js";
import { seedSystem } from "../seed/seedSystem.js";
import { stubDnsLookup, type DnsLookupStub } from "../testSupport/dnsLookupStub.js";
import { FakeCalDavServer } from "../testSupport/fakeCalDavServer.js";
import { FakeImapServer } from "../testSupport/fakeImapServer.js";
import { PURELYMAIL_FOLDERS } from "../testSupport/imapMailboxFixture.js";
import {
  makeTestCertificate,
  startFakeSmtpServer,
  startTlsFront,
  type ConnectionSpan,
  type FakeSmtpServer,
  type LatentServer,
  type TestCertificate,
} from "../testSupport/latentMailServers.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// Purelymail as measured from the dev VPS: a TLS connect costs about 0.42 s and every command about 0.10 s.
const CONNECT_LATENCY_MS = 420;
const COMMAND_LATENCY_MS = 100;

const ADDRESS = "owner@mail.test";
/** Unique per run, so a hit in a log call can only be this password. */
const PASSWORD = `pw-sentinel-${randomUUID()}`;
const WRONG_PASSWORD = `wrong-${randomUUID()}`;
const CONNECT_BODY = {
  provider: "generic",
  address: ADDRESS,
  password: PASSWORD,
  imapHost: "mail.test",
  smtpHost: "mail.test",
  caldavUrl: "https://dav.mail.test/",
};

let admin: Pool;
let runtime: Pool;
let tenant: string;
let userId: string;
let certificate: TestCertificate;

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "alldots_data");
  certificate = makeTestCertificate("mail.test");
});

let dns: DnsLookupStub | undefined;
let restorePolicy: (() => void) | undefined;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  await resetDatabase(admin);
  tenant = await createTestTenant(admin);
  await runInTenant(tenant, () => seedSystem(runtime));
  userId = (await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "x" })).id;
  restorePolicy = allowLoopbackOutboundForTests();
  dns = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  dns?.restore();
  dns = undefined;
  restorePolicy?.();
  restorePolicy = undefined;
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No loopback port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

interface Passwords {
  imap: string;
  smtp: string;
  caldav: string;
}

interface Account {
  imap: FakeImapServer;
  imapFront: LatentServer;
  smtp: FakeSmtpServer;
  caldav: FakeCalDavServer;
  /** When each CalDAV verification started and settled. */
  caldavSpans: ConnectionSpan[];
  connect(): Promise<{ status: number; item: { id: string } }>;
}

/**
 * The account behind `mail.test`: IMAP on 993 (with 143 refused), SMTP on 465 (with 587 refused) and CalDAV, each
 * accepting its password, all with the latencies above. The connect runs the production handler with the production
 * IMAP/SMTP verification and CalDAV discovery.
 */
async function startAccount(passwords: Passwords = { imap: PASSWORD, smtp: PASSWORD, caldav: PASSWORD }) {
  const imap = new FakeImapServer({
    folders: PURELYMAIL_FOLDERS,
    capabilities: ["SPECIAL-USE", "CONDSTORE", "ENABLE"],
    latencyMs: COMMAND_LATENCY_MS,
    password: passwords.imap,
  });
  const imapPort = await imap.listen();
  cleanups.push(() => imap.close());
  const imapFront = await startTlsFront(imapPort, certificate, CONNECT_LATENCY_MS);
  cleanups.push(() => imapFront.close());
  const smtp = await startFakeSmtpServer({
    certificate,
    username: ADDRESS,
    password: passwords.smtp,
    connectLatencyMs: CONNECT_LATENCY_MS,
    commandLatencyMs: COMMAND_LATENCY_MS,
  });
  cleanups.push(() => smtp.close());
  const caldav = new FakeCalDavServer({ username: ADDRESS, password: passwords.caldav });
  caldav.latencyMs = COMMAND_LATENCY_MS;
  await caldav.start();
  cleanups.push(() => caldav.close());
  const ports = { 993: imapFront.port, 143: await closedPort(), 465: smtp.port, 587: await closedPort() };
  const caldavSpans: ConnectionSpan[] = [];

  const handler = createMailboxPasswordConnectRouteHandler(runtime, {
    mailServerClients: {
      verifyPassword: (input) => verifyMailCredentialsForTests(input, { ca: certificate.cert, ports }),
      // The body's CalDAV address is an https name, as the route requires; the same login goes to the loopback server.
      verifyCalDav: async (input) => {
        const span: ConnectionSpan = { openedAt: performance.now(), closedAt: null };
        caldavSpans.push(span);
        try {
          return await verifyCalDavServer({ ...input, caldavUrl: `${caldav.origin}/` });
        } finally {
          span.closedAt = performance.now();
        }
      },
    },
    throttle: { tryAcquire: () => ({ granted: true }) },
  });
  const account: Account = {
    imap,
    imapFront,
    smtp,
    caldav,
    caldavSpans,
    connect: () => runInTenant(tenant, () => handler({ identity: { user: { id: userId } }, body: CONNECT_BODY })),
  };
  return account;
}

async function mailboxCount(): Promise<number> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE database_id = $1",
        [mailboxesDatabaseId],
      );
      return rows[0]?.n ?? -1;
    }),
  );
}

/** The special purposes of the mailbox's Folder items, sorted. */
async function folderPurposesOf(mailboxId: string): Promise<string[]> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      const { foldersDatabaseId } = await resolveMailModuleIds(client);
      const { rows } = await client.query<{ purpose: string }>(
        `SELECT f.properties ->> 'specialPurpose' AS purpose
           FROM items f JOIN item_relations r ON r.item_a = f.id OR r.item_b = f.id
          WHERE f.database_id = $1 AND f.deleted_at IS NULL AND (r.item_a = $2 OR r.item_b = $2)
          ORDER BY 1`,
        [foldersDatabaseId, mailboxId],
      );
      return rows.map((row) => row.purpose);
    }),
  );
}

function closedSpan(span: ConnectionSpan | undefined): { openedAt: number; closedAt: number } {
  if (span === undefined || span.closedAt === null) throw new Error("The span is missing or still open");
  return { openedAt: span.openedAt, closedAt: span.closedAt };
}

const overlaps = (a: { openedAt: number; closedAt: number }, b: { openedAt: number; closedAt: number }) =>
  a.openedAt < b.closedAt && b.openedAt < a.closedAt;

/** Every connection the account's servers accepted is closed. */
async function expectAllReleased(account: Account): Promise<void> {
  await account.imapFront.allClosed();
  await account.smtp.allClosed();
  await vi.waitFor(async () => expect(await account.caldav.openConnections()).toBe(0), { timeout: 2_000 });
  expect(account.caldavSpans.every((span) => span.closedAt !== null)).toBe(true);
}

describe("POST /api/mail/mailboxes against servers with a provider's latency", () => {
  it("logs in to IMAP once, lists the folders on that connection and verifies IMAP, SMTP and CalDAV concurrently", async () => {
    const account = await startAccount();

    const started = performance.now();
    const created = await account.connect();

    expect(created.status).toBe(201);
    expect(account.imapFront.connections).toHaveLength(1);
    expect(account.imap.commands.filter((verb) => verb === "LOGIN")).toHaveLength(1);
    expect(account.imap.commands).toContain("LIST");
    expect(account.imap.commands).not.toContain("STATUS");
    expect(await folderPurposesOf(created.item.id)).toEqual(["drafts", "sent"]);

    const imap = closedSpan(account.imapFront.connections[0]);
    const smtp = closedSpan(account.smtp.connections[0]);
    const caldav = closedSpan(account.caldavSpans[0]);
    expect(overlaps(imap, smtp)).toBe(true);
    expect(overlaps(imap, caldav)).toBe(true);
    expect(overlaps(smtp, caldav)).toBe(true);
    const durations = [imap, smtp, caldav].map((span) => span.closedAt - span.openedAt);
    const sum = durations.reduce((total, duration) => total + duration, 0);
    // From the request to the last server connection closing: sequential verifications would take at least their sum,
    // concurrent ones take about the longest. The mailbox's write transaction follows and is not network time.
    const verifying = Math.max(imap.closedAt, smtp.closedAt, caldav.closedAt) - started;
    expect(verifying).toBeLessThan(sum * 0.75);
    expect(verifying).toBeLessThan(Math.max(...durations) + 300);
    await expectAllReleased(account);
  });

  it.each([
    {
      refusing: "IMAP",
      passwords: { imap: WRONG_PASSWORD, smtp: PASSWORD, caldav: PASSWORD },
      code: "mail_auth_failed",
    },
    {
      refusing: "SMTP",
      passwords: { imap: PASSWORD, smtp: WRONG_PASSWORD, caldav: PASSWORD },
      code: "mail_auth_failed",
    },
    {
      refusing: "CalDAV",
      passwords: { imap: PASSWORD, smtp: PASSWORD, caldav: WRONG_PASSWORD },
      code: "caldav_auth_failed",
    },
  ])(
    "answers 400 $code when $refusing refuses the login, writes nothing and leaves no connection open",
    async ({ passwords, code }) => {
      const account = await startAccount(passwords);

      const refusal = await account.connect().catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(ChokePointError);
      expect(refusal).toMatchObject({ status: 400, code });
      expect(await mailboxCount()).toBe(0);
      expect(account.imapFront.connections).toHaveLength(1);
      expect(account.smtp.connections).toHaveLength(1);
      expect(account.caldavSpans).toHaveLength(1);
      await expectAllReleased(account);
    },
  );

  it("connects without the compose folders when LIST fails on the verified connection, and logs no user content", async () => {
    const warn = vi.spyOn(mailLogger, "warn");
    const account = await startAccount();
    account.imap.refusedVerbs.add("LIST");

    const created = await account.connect();

    expect(created.status).toBe(201);
    expect(await folderPurposesOf(created.item.id)).toEqual([]);
    expect(account.imap.commands.filter((verb) => verb === "LOGIN")).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      { stage: "listing", errorName: expect.any(String) },
      "The connect could not list the IMAP folders; the first sync pass discovers them",
    );
    const logged = inspect(warn.mock.calls, { depth: 8 });
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(ADDRESS);
    await expectAllReleased(account);
  });
});
