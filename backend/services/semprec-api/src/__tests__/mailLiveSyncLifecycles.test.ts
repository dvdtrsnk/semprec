import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES } from "@semprec/queue";
import {
  createTenantZeroUser,
  getTestPool,
  inTenantZero,
  resetDatabase,
  storeCredential,
  stubDnsLookup,
  type DnsLookupStub,
} from "@semprec/data/testSupport";
import {
  createBoundedImapIdleLifecycleFactory,
  createItemWithClient,
  createMailLiveSyncRoot,
  MailServerUnreachableError,
  resolveMailModuleIds,
  seedSystem,
  upsertMailServerSettings,
  withTransaction,
  type ImapIdleConnection,
  type ImapIdleTransport,
  type MailLiveSyncLifecycleFactory,
  type MailLiveSyncRoot,
  type MailServerEndpoint,
} from "@semprec/data";
import {
  connectionLimitOf,
  createImapIdleLifecycleFactory,
  createMailLiveSyncLifecycleFactory,
  type MailLiveSyncLifecycleDispatchOptions,
} from "../mailLiveSyncLifecycles.js";
import { logger } from "../logger.js";

const DISCOVERY_INTERVAL_MS = 200;
const RECONNECT_BASE_MS = 5;
const RECONNECT_MAX_MS = 10;
const IMAP_HOST = "imap.mail.test";
const IMAP_ENDPOINT: MailServerEndpoint = { host: IMAP_HOST, port: 993, security: "tls" };
const IMAP_USERNAME = "mailbox@mail.test";
const APP_PASSWORD = "app-password-that-must-never-be-logged";

interface LifecycleErrorRecord {
  mailboxItemId: string;
  phase: string;
  err: unknown;
}

interface IdleErrorRecord {
  mailboxItemId: string;
  folderPath: string;
  err: unknown;
}

let pool: Pool;
let root: MailLiveSyncRoot | undefined;
let stub: DnsLookupStub | undefined;
let lifecycleErrors: LifecycleErrorRecord[] = [];
let idleErrors: IdleErrorRecord[] = [];

/**
 * An IDLE connection that stays open until the lifecycle closes it. `onSignal` is the callback the lifecycle
 * handed to the transport, so a test fires the signal the way imapflow would.
 */
class FakeIdleConnection implements ImapIdleConnection {
  closeCalls = 0;
  private endResolve: (value: unknown) => void = () => {};
  private readonly ended = new Promise<unknown>((resolve) => {
    this.endResolve = resolve;
  });

  constructor(
    readonly mailboxItemId: string,
    readonly folderPath: string,
    readonly onSignal: () => void,
  ) {}

  waitForEnd(): Promise<unknown> {
    return this.ended;
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.endResolve(undefined);
  }
}

interface FakeIdleOptions {
  folders?: string[];
  /** Whether connect attempt number `attempt` for `key` (`mailboxItemId/folderPath`) is refused. */
  refuses?: (key: string, attempt: number) => boolean;
}

function createFakeIdleTransport(options: FakeIdleOptions = {}): {
  transport: ImapIdleTransport;
  resolvedMailboxes: string[];
  connections: FakeIdleConnection[];
  attempts: Map<string, number>;
} {
  const resolvedMailboxes: string[] = [];
  const connections: FakeIdleConnection[] = [];
  const attempts = new Map<string, number>();
  const transport: ImapIdleTransport = {
    async resolveFolders(mailboxItemId) {
      resolvedMailboxes.push(mailboxItemId);
      return (options.folders ?? ["INBOX"]).map((path) => ({ path }));
    },
    async connect(mailboxItemId, _credential, folderPath, onSignal) {
      const key = `${mailboxItemId}/${folderPath}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      // The refusal the address policy gives: the transport rejects with the mapped error, no socket is opened.
      if (options.refuses?.(key, attempt)) throw new MailServerUnreachableError();
      const connection = new FakeIdleConnection(mailboxItemId, folderPath, onSignal);
      connections.push(connection);
      return connection;
    },
  };
  return { transport, resolvedMailboxes, connections, attempts };
}

/** The bounded IDLE lifecycle over `transport`, with the test's credential and a short reconnect backoff. */
function imapIdleOver(transport: ImapIdleTransport): MailLiveSyncLifecycleFactory {
  return createBoundedImapIdleLifecycleFactory(pool, transport, {
    getCredential: async () => APP_PASSWORD,
    getConnectionLimit: () => 5,
    reconnectBaseDelayMs: RECONNECT_BASE_MS,
    reconnectMaxDelayMs: RECONNECT_MAX_MS,
    onError: (mailboxItemId, folderPath, err) => {
      idleErrors.push({ mailboxItemId, folderPath, err });
    },
  });
}

/** Composes the live-sync root the way serve.ts does, with a shortened discovery interval. */
function composeRoot(hosted: MailLiveSyncLifecycleDispatchOptions["hosted"]): MailLiveSyncRoot {
  return createMailLiveSyncRoot(pool, createMailLiveSyncLifecycleFactory({ pool, hosted }), {
    discoveryIntervalMs: DISCOVERY_INTERVAL_MS,
    onLifecycleError: (mailboxItemId, phase, err) => {
      lifecycleErrors.push({ mailboxItemId, phase, err });
    },
  });
}

async function insertMailbox(provider: string, properties: Record<string, unknown> = {}): Promise<string> {
  return inTenantZero(() =>
    withTransaction(pool, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      const item = await createItemWithClient(client, {
        databaseId: mailboxesDatabaseId,
        properties: { name: `Mailbox ${randomUUID()}`, provider, ...properties },
      });
      return item.id;
    }),
  );
}

/** Stores the app password the IDLE lifecycle reads, and the IMAP settings that name `host`. */
async function storeImapSetup(mailboxItemId: string, host: string): Promise<void> {
  await inTenantZero(() =>
    withTransaction(pool, async (client) => {
      await storeCredential(client, { itemId: mailboxItemId, credentialType: "app_password", plaintext: APP_PASSWORD });
      await upsertMailServerSettings(client, mailboxItemId, {
        imap: { ...IMAP_ENDPOINT, host },
        smtp: null,
        username: IMAP_USERNAME,
      });
    }),
  );
}

/**
 * Queued mail-account sync jobs for `mailboxItemId`. Reads graphile-worker's `_private_jobs` and `_private_tasks`
 * tables, as imapIdleLifecycle.test.ts does.
 */
async function syncJobsFor(mailboxItemId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1 AND jobs.key = $2`,
    [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC, `mail-account-sync:${mailboxItemId}`],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Drops the sync the lifecycle enqueued at start, so a test observes only the enqueue its own signal causes. */
async function clearSyncJobsFor(mailboxItemId: string): Promise<void> {
  await pool.query(`DELETE FROM graphile_worker._private_jobs WHERE key = $1`, [`mail-account-sync:${mailboxItemId}`]);
}

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails through the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  expect(await check()).toBe(true);
}

describe("mail live-sync lifecycles by sync mode (issue #1550)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    // Writes below run in tenant zero's scope, as the fixtures of mailSyncAdapters.test.ts do.
    await createTenantZeroUser(pool);
    lifecycleErrors = [];
    idleErrors = [];
    root = undefined;
  });

  afterEach(async () => {
    await root?.stop();
    root = undefined;
    stub?.restore();
    stub = undefined;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("hosts an imap account on the IDLE lifecycle: its connection opens, and a signal from it enqueues a sync", async () => {
    const fake = createFakeIdleTransport();
    root = composeRoot({ imap: imapIdleOver(fake.transport) });
    const mailboxId = await insertMailbox("generic");

    await root.start();
    await waitFor(async () => fake.connections.length === 1);
    const connection = fake.connections[0];
    if (!connection) throw new Error("the IDLE lifecycle opened no connection");
    expect(connection.mailboxItemId).toBe(mailboxId);
    expect(connection.folderPath).toBe("INBOX");

    await clearSyncJobsFor(mailboxId);
    expect(await syncJobsFor(mailboxId)).toBe(0);
    connection.onSignal();
    await waitFor(async () => (await syncJobsFor(mailboxId)) === 1);
    expect(lifecycleErrors).toEqual([]);
  });

  it("keeps an account whose sync mode has no hosted lifecycle on the noop lifecycle, which the IDLE transport never sees", async () => {
    const fake = createFakeIdleTransport();
    root = composeRoot({ imap: imapIdleOver(fake.transport) });
    const gmailId = await insertMailbox("gmail");

    await root.start();

    expect(await syncJobsFor(gmailId)).toBe(1);
    expect(fake.resolvedMailboxes).not.toContain(gmailId);
    expect(fake.connections).toEqual([]);
    expect(idleErrors).toEqual([]);
  });

  it("closes every IDLE connection of every hosted account before stop() resolves", async () => {
    const fake = createFakeIdleTransport({ folders: ["INBOX", "[Gmail]/All Mail"] });
    root = composeRoot({ imap: imapIdleOver(fake.transport) });
    const first = await insertMailbox("generic");
    const second = await insertMailbox("generic");

    await root.start();
    await waitFor(async () => fake.connections.length === 4);
    await root.stop();
    root = undefined;

    expect(new Set(fake.connections.map((connection) => connection.mailboxItemId))).toEqual(new Set([first, second]));
    expect(fake.connections.every((connection) => connection.closeCalls === 1)).toBe(true);
  });

  it("backs off and retries a connect the address policy refuses, without taking the process down", async () => {
    const fake = createFakeIdleTransport({ refuses: (_key, attempt) => attempt <= 2 });
    root = composeRoot({ imap: imapIdleOver(fake.transport) });
    const mailboxId = await insertMailbox("generic");

    await root.start();
    await waitFor(async () => fake.connections.length === 1);

    expect(fake.attempts.get(`${mailboxId}/INBOX`)).toBe(3);
    expect(idleErrors).toHaveLength(2);
    expect(idleErrors.every((record) => record.err instanceof MailServerUnreachableError)).toBe(true);
    expect(lifecycleErrors).toEqual([]);
  });

  it("retries discovery for an imap account that has no stored credential, naming the mailbox", async () => {
    root = composeRoot({ imap: createImapIdleLifecycleFactory(pool) });
    const mailboxId = await insertMailbox("generic");

    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await root.start();
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());

    expect(lifecycleErrors).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(
      { mailboxItemId: mailboxId, stage: "idle", category: "failure" },
      "IMAP IDLE lifecycle failed",
    );
  });

  it("retries discovery for an imap account that has a credential but no IMAP settings, naming the mailbox", async () => {
    root = composeRoot({ imap: createImapIdleLifecycleFactory(pool) });
    const mailboxId = await insertMailbox("generic");
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        storeCredential(client, { itemId: mailboxId, credentialType: "app_password", plaintext: APP_PASSWORD }),
      ),
    );

    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await root.start();
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());

    expect(lifecycleErrors).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(
      { mailboxItemId: mailboxId, stage: "idle", category: "failure" },
      "IMAP IDLE lifecycle failed",
    );
  });

  it("retries discovery for an imap account whose stored settings hold only an SMTP endpoint, with the same configuration error", async () => {
    root = composeRoot({ imap: createImapIdleLifecycleFactory(pool) });
    const mailboxId = await insertMailbox("generic");
    await inTenantZero(() =>
      withTransaction(pool, async (client) => {
        await storeCredential(client, { itemId: mailboxId, credentialType: "app_password", plaintext: APP_PASSWORD });
        await upsertMailServerSettings(client, mailboxId, {
          imap: null,
          smtp: { host: IMAP_HOST, port: 587, security: "starttls" },
          username: IMAP_USERNAME,
        });
      }),
    );

    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await root.start();
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());

    expect(lifecycleErrors).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(
      { mailboxItemId: mailboxId, stage: "idle", category: "failure" },
      "IMAP IDLE lifecycle failed",
    );
  });

  it("opens an imap account's connection through the address-checked step: a host that resolves to a private address is refused, and discovery retries safely", async () => {
    stub = stubDnsLookup({ [IMAP_HOST]: ["10.0.0.1"] });
    root = composeRoot({ imap: createImapIdleLifecycleFactory(pool) });
    const mailboxId = await insertMailbox("generic");
    await storeImapSetup(mailboxId, IMAP_HOST);

    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await root.start();
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());

    expect(lifecycleErrors).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(
      { mailboxItemId: mailboxId, stage: "idle", category: "failure" },
      "IMAP IDLE lifecycle failed",
    );
    expect(stub.calls).toContain(IMAP_HOST);
  });

  it("settles sibling IDLE cleanup before the root sees a safe stop failure", async () => {
    const secret = "private-stop-error-value";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeIdleTransport({ folders: ["INBOX", "Archive"] });
    const connect = fake.transport.connect.bind(fake.transport);
    fake.transport.connect = async (...args) => {
      const connection = await connect(...args);
      const close = connection.close.bind(connection);
      connection.close = async () => {
        if (args[2] === "Archive") await gate;
        await close();
        if (args[2] === "INBOX") throw new Error(secret);
      };
      return connection;
    };
    root = composeRoot({ imap: imapIdleOver(fake.transport) });
    const mailboxId = await insertMailbox("generic");
    await root.start();
    await waitFor(async () => fake.connections.length === 2);
    const stopping = root.stop();
    await waitFor(async () =>
      fake.connections.some((connection) => connection.folderPath === "INBOX" && connection.closeCalls === 1),
    );
    expect(lifecycleErrors).toEqual([]);
    release();
    await stopping;
    root = undefined;
    expect(fake.connections.every((connection) => connection.closeCalls === 1)).toBe(true);
    expect(lifecycleErrors).toHaveLength(1);
    expect(lifecycleErrors[0]).toMatchObject({ mailboxItemId: mailboxId, phase: "stop" });
    const error = lifecycleErrors[0]?.err;
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error).toEqual(new Error("IMAP IDLE lifecycle failed unexpectedly"));
    expect(Object.keys(error as Error)).toEqual([]);
  });

  it("reads the mailbox's configured connection limit, then its provider's, then the default", async () => {
    const configured = await insertMailbox("icloud", { connectionLimit: 4 });
    const icloud = await insertMailbox("icloud");
    const generic = await insertMailbox("generic");

    await inTenantZero(async () => {
      expect(await connectionLimitOf(pool, configured)).toBe(4);
      expect(await connectionLimitOf(pool, icloud)).toBe(3);
      expect(await connectionLimitOf(pool, generic)).toBe(2);
    });
  });

  it("falls back to the default connection limit for a mailbox that does not exist", async () => {
    await inTenantZero(async () => {
      expect(await connectionLimitOf(pool, randomUUID())).toBe(2);
    });
  });

  it("uses fixed diagnostics for a failed credential lookup", async () => {
    const mailboxId = await insertMailbox("generic");
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await inTenantZero(async () => {
        const lifecycle = createImapIdleLifecycleFactory(pool)({ mailboxItemId: mailboxId, syncMode: "imap" });
        await lifecycle.start();
        await vi.waitFor(() => expect(warning).toHaveBeenCalled());
        await lifecycle.stop();
      });
      expect(warning).toHaveBeenCalledWith(
        { mailboxItemId: mailboxId, stage: "idle", category: "failure" },
        "IMAP IDLE lifecycle failed",
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain(APP_PASSWORD);
    } finally {
      warning.mockRestore();
    }
  });
});
