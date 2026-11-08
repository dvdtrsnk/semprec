import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES } from "@semprec/queue";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  ensureMailAccountSyncState,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  recordProviderAccountAddress,
  resetDatabase,
  storeCredential,
  stubDnsLookup,
  writeMailboxAddresses,
  type DnsLookupStub,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import {
  createBoundedImapIdleLifecycleFactory,
  createItemWithClient,
  createMailLiveSyncRoot,
  handleGraphChangeNotification,
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
  createGmailPubSubDispatcherFor,
  createImapIdleLifecycleFactory,
  createMailLiveSyncLifecycleFactory,
  decideGraphSubscriptionHosting,
  resolveGmailWatchHosting,
  resolveGraphSubscriptionHosting,
  type MailLiveSyncLifecycleDispatchOptions,
} from "../mailLiveSyncLifecycles.js";
import { loadGmailPubSubConfig } from "../gmailPubSubConfig.js";
import { logger } from "../logger.js";

/**
 * A fault for `node:fs/promises`'s `readFile`, armed by one case and disarmed in `afterEach`: while armed, the
 * key file read rejects with exactly this error; otherwise every call passes through to the real module.
 */
const fsFault = vi.hoisted((): { readFile: Error | undefined } => ({ readFile: undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: unknown[]): Promise<unknown> => {
      if (fsFault.readFile !== undefined) throw fsFault.readFile;
      return Reflect.apply(actual.readFile, actual, args);
    },
  };
});

/**
 * Every error `node:crypto`'s `createPrivateKey` threw, recorded and rethrown unchanged; cleared in `afterEach`.
 * Recording only: every call passes through to the real function, so the owner's decode is the real one.
 */
const decodeFailures = vi.hoisted((): unknown[] => []);

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createPrivateKey: (...args: unknown[]): unknown => {
      try {
        return Reflect.apply(actual.createPrivateKey, actual, args);
      } catch (error) {
        decodeFailures.push(error);
        throw error;
      }
    },
  };
});

/**
 * Runs every cleanup even when one fails. The case's own failure, `primary`, stays first: it is rethrown, or,
 * when a cleanup failed too, rethrown inside an `AggregateError` with the cleanup failures after it. A thrown
 * falsy value counts as a failure because `primary` wraps it.
 */
async function settleAll(primary: { error: unknown } | undefined, cleanups: (() => unknown)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (primary) {
    if (failures.length === 0) throw primary.error;
    throw new AggregateError([primary.error, ...failures], "The case and its cleanup failed", { cause: primary.error });
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Cleanup failed");
}

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

/** How long a case waits for one token-owner outcome it drives, well inside the case timeout. */
const OWNER_MS = 5_000;
/** How long the cleanup waits for every started token-owner outcome once held provider work is released. */
const OWNER_DRAIN_MS = 5_000;

/** Rejects naming `what` when `work` has not settled within `ms`; the timer is cleared either way. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

type OwnerOutcome = { token: string } | { error: unknown };

/** What a bounded wait gave: its value, or the very error it rejected with. */
type Observation<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** The value of `observation`, or its rejection rethrown as the same error object. */
function take<T>(observation: Observation<T>): T {
  if (!observation.ok) throw observation.error;
  return observation.value;
}

/**
 * The held token-provider work of one case, each piece recorded when it is created: every token-owner outcome the
 * case starts, every bounded observation of one, every fake fetch it holds open (with its own release handle and
 * abort listener), every response stream it serves (by its controller) and every stream pull or cancel promise it
 * holds. `release` frees all of it without waiting for any production deadline, then drains every owner outcome and
 * every observation.
 */
function heldProviders() {
  const owners: Promise<OwnerOutcome>[] = [];
  const observations: Promise<unknown>[] = [];
  const fetches: { reject: (error: Error) => void; removeListener: () => void }[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const holds: (() => void)[] = [];
  const releasedError = new Error("Released by the case's cleanup");
  const hold = () => new Promise<void>((resolve) => holds.push(resolve));
  return {
    releasedError,
    /** Starts one token-owner call and records its outcome, which never rejects. */
    owner(start: () => Promise<string>): Promise<OwnerOutcome> {
      const outcome = start().then(
        (token): OwnerOutcome => ({ token }),
        (error: unknown): OwnerOutcome => ({ error }),
      );
      owners.push(outcome);
      return outcome;
    },
    /**
     * Bounds `outcome` within `ms` and observes the bound at once, with both handlers, so a bound that expires while
     * the case still waits for something else rejects into this observation and never goes unhandled. The returned
     * promise never rejects; `take` rethrows the bound's own error.
     */
    bounded<T>(outcome: Promise<T>, ms: number, what: string): Promise<Observation<T>> {
      const observation = within(outcome, ms, what).then(
        (value): Observation<T> => ({ ok: true, value }),
        (error: unknown): Observation<T> => ({ ok: false, error }),
      );
      observations.push(observation);
      return observation;
    },
    /** A fetch answer that settles only when its request is aborted or the cleanup releases it. */
    heldFetch(request: Request, onHeld: () => void): Promise<Response> {
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const reason: unknown = request.signal.reason;
          reject(reason instanceof Error ? reason : new Error("The held fetch was aborted without an Error reason"));
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        fetches.push({ reject, removeListener: () => request.signal.removeEventListener("abort", onAbort) });
        onHeld();
      });
    },
    /** A response whose body stream is recorded; its pull (when `onPull` is given) and its cancel are held. */
    heldStream(options: { onPull?: () => void; onCancel?: () => void; status?: number }): Response {
      const onPull = options.onPull;
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            streams.push(controller);
          },
          ...(onPull
            ? {
                pull: () => {
                  onPull();
                  return hold();
                },
              }
            : {}),
          cancel: () => {
            options.onCancel?.();
            return hold();
          },
        }),
        options.status === undefined ? undefined : { status: options.status },
      );
    },
    /**
     * Rejects every held fetch and removes its abort listener, errors every served stream (a no-op for one already
     * closed, errored or cancelled), resolves every held pull and cancel, and only then waits for every started owner
     * outcome within `drainMs`, and then for every bounded observation within `drainMs`. Each step is attempted
     * whatever an earlier one did; an outcome or observation still pending is a failure, never a settlement.
     */
    async release(drainMs = OWNER_DRAIN_MS): Promise<void> {
      const failures: unknown[] = [];
      const attempt = (step: () => void) => {
        try {
          step();
        } catch (error) {
          failures.push(error);
        }
      };
      for (const held of fetches) {
        attempt(() => held.reject(releasedError));
        attempt(() => held.removeListener());
      }
      for (const controller of streams) attempt(() => controller.error(releasedError));
      for (const resolve of holds) attempt(() => resolve());
      try {
        await within(Promise.all(owners), drainMs, "A token-owner outcome after its provider work was released");
      } catch (error) {
        failures.push(error);
      }
      try {
        await within(
          Promise.all(observations),
          drainMs,
          "A bounded token-owner observation after its provider work was released",
        );
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Releasing held provider work failed");
    },
  };
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

// ---------------------------------------------------------------------------------------------
// Gmail watch (issue #1739) and Microsoft Graph subscription (issue #1745) hosting
// ---------------------------------------------------------------------------------------------

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL_WATCH = "https://gmail.googleapis.com/gmail/v1/users/me/watch";
const TOPIC = "projects/semprec-test/topics/gmail";
const SUBSCRIPTION = "projects/semprec-test/subscriptions/gmail-push";
const PUBSUB_PULL = `https://pubsub.googleapis.com/v1/${SUBSCRIPTION}:pull`;
const PUBSUB_ACK = `https://pubsub.googleapis.com/v1/${SUBSCRIPTION}:acknowledge`;
const MICROSOFT_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_SUBSCRIPTIONS = "https://graph.microsoft.com/v1.0/subscriptions";
const SERVICE_ACCOUNT_EMAIL = "semprec-push@semprec-test.iam.gserviceaccount.com";
const REFRESH_TOKEN = "synthetic-refresh-token-that-must-never-be-logged";
const CLIENT_SECRET = "synthetic-client-secret-that-must-never-be-logged";

type FakeRoute = (request: Request) => Promise<Response> | Response;

/**
 * Replaces the global `fetch` with a closed set of synthetic provider endpoints, keyed by method and exact
 * URL (`PATCH` on a Graph subscription by its URL prefix); any other request is refused, so nothing reaches
 * the network. Restored by `vi.unstubAllGlobals()` after every test.
 */
function stubProviders(routes: Record<string, FakeRoute>): Request[] {
  const seen: Request[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request.clone());
    const exact = routes[`${request.method} ${request.url}`];
    const prefixed = Object.entries(routes).find(
      ([key]) => key.endsWith("/*") && `${request.method} ${request.url}`.startsWith(key.slice(0, -1)),
    )?.[1];
    const route = exact ?? prefixed;
    if (!route)
      throw new Error(`Refused an unexpected outbound request: ${request.method} ${new URL(request.url).host}`);
    return route(request);
  });
  return seen;
}

async function formOf(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await request.text());
}

/** Every logger call of this service, captured; the mock keeps them out of the test output. */
function captureServiceLogs(): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  for (const level of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      calls.push([level, ...args]);
    });
  }
  return { calls };
}

/** A synthetic service account key file in a directory this test owns; returns its path and public key. */
async function writeServiceAccountKey(directory: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const path = join(directory, "service-account.json");
  await writeFile(
    path,
    JSON.stringify({ type: "service_account", client_email: SERVICE_ACCOUNT_EMAIL, private_key: pem }),
  );
  return { path, publicKey, pem };
}

/** The claims of a service-account JWT assertion whose RS256 signature `publicKey` verifies; `null` otherwise. */
function verifiedAssertionClaims(assertion: string, publicKey: Parameters<typeof verify>[2]): unknown {
  const [header, claims, signature] = assertion.split(".");
  if (!header || !claims || !signature) return null;
  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${claims}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  if (!valid) return null;
  const parsed: unknown = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  if (JSON.stringify(parsed) !== JSON.stringify({ alg: "RS256", typ: "JWT" })) return null;
  return JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
}

const assertionClaimsSchema = z.object({
  iss: z.literal(SERVICE_ACCOUNT_EMAIL),
  scope: z.literal("https://www.googleapis.com/auth/pubsub"),
  aud: z.literal(GOOGLE_TOKEN),
  iat: z.number(),
  exp: z.number(),
});

/** A Gmail-mode mailbox in `tenantId` with its refresh token, sync state and provider-verified address. */
async function insertGmailMailbox(
  db: Pool,
  tenantId: string,
  verifiedAddress: string,
  claimedAddress?: string,
): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(db, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesDatabaseId,
        properties: { name: `Mailbox ${randomUUID()}`, provider: "gmail" },
      });
      if (claimedAddress !== undefined) {
        await writeMailboxAddresses(client, {
          mailboxesDatabaseId,
          mailboxItemId: mailbox.id,
          address: claimedAddress,
        });
      }
      await storeCredential(client, {
        itemId: mailbox.id,
        credentialType: "oauth2_refresh_token",
        plaintext: REFRESH_TOKEN,
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
      await recordProviderAccountAddress(client, mailbox.id, verifiedAddress);
      return mailbox.id;
    }),
  );
}

async function syncStateOf(mailboxItemId: string) {
  const { rows } = await pool.query<{
    gmail_watch_email_address: string | null;
    graph_subscription_id: string | null;
    graph_client_state: string | null;
    graph_subscription_expires_at: Date | null;
  }>(
    `SELECT gmail_watch_email_address, graph_subscription_id, graph_client_state, graph_subscription_expires_at
     FROM mail_account_sync_state WHERE item_id = $1`,
    [mailboxItemId],
  );
  return rows[0];
}

function pubSubMessage(ackId: string, emailAddress: string) {
  return {
    ackId,
    message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId: "7" })).toString("base64") },
  };
}

describe("Gmail watch lifecycles and the Pub/Sub dispatcher (issue #1739)", () => {
  let directory: string | undefined;
  let dispatcher: { stop(): Promise<void> } | undefined;

  // The describe above ends the file's pool in its afterAll; this one opens and ends its own.
  beforeAll(() => {
    pool = getTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    await createTenantZeroUser(pool);
    lifecycleErrors = [];
    root = undefined;
    dispatcher = undefined;
    directory = await mkdtemp(join(tmpdir(), "semprec-gmail-pubsub-"));
  });

  function ownDirectory(): string {
    if (directory === undefined) throw new Error("the test directory was not created");
    return directory;
  }

  afterEach(async () => {
    const [stopping, rooted, owned] = [dispatcher, root, directory];
    dispatcher = undefined;
    root = undefined;
    directory = undefined;
    await settleAll(undefined, [
      () => stopping?.stop(),
      () => rooted?.stop(),
      () => {
        fsFault.readFile = undefined;
        decodeFailures.length = 0;
      },
      () => vi.unstubAllGlobals(),
      () => vi.restoreAllMocks(),
      // This test's own key directory.
      () => (owned === undefined ? undefined : rm(owned, { recursive: true, force: true })),
    ]);
  });

  it("routes a notification for a watched, provider-verified address to one sync per mailbox, never by Mailboxes.addresses", async () => {
    const key = await writeServiceAccountKey(ownDirectory());
    const logs = captureServiceLogs();
    // Two tenants: every production read and write runs on a runtime-role pool, under row-level security.
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let primary: { error: unknown } | undefined;
    try {
      const otherTenant = await createTestTenant(pool);
      await runInTenant(otherTenant, () => seedSystem(runtime));
      const first = await insertGmailMailbox(runtime, getTenantZeroId(), "Verified@Example.com", "claimed@example.com");
      const second = await insertGmailMailbox(runtime, otherTenant, "verified@example.com");
      // Phase one delivers only the claimed address, so no verified notification's sync can mask a wrong route.
      const pending = [pubSubMessage("ack-claimed", "claimed@example.com")];
      const acknowledged: string[][] = [];
      let serviceAccountExchanges = 0;
      const seen = stubProviders({
        [`POST ${GOOGLE_TOKEN}`]: async (request) => {
          const form = await formOf(request);
          if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === REFRESH_TOKEN) {
            return Response.json({ access_token: "gmail-user-access", expires_in: 3600, token_type: "Bearer" });
          }
          const claims = assertionClaimsSchema.safeParse(
            verifiedAssertionClaims(form.get("assertion") ?? "", key.publicKey),
          );
          if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !claims.success) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          serviceAccountExchanges += 1;
          return Response.json({ access_token: "pubsub-service-access", expires_in: 3600, token_type: "Bearer" });
        },
        [`POST ${GMAIL_WATCH}`]: async (request) => {
          expect(request.headers.get("authorization")).toBe("Bearer gmail-user-access");
          expect(z.object({ topicName: z.string() }).parse(await request.json()).topicName).toBe(TOPIC);
          return Response.json({ historyId: "100", expiration: String(Date.now() + 7 * 24 * 3600 * 1000) });
        },
        [`POST ${PUBSUB_PULL}`]: (request) => {
          expect(request.headers.get("authorization")).toBe("Bearer pubsub-service-access");
          return Response.json(pending.length === 0 ? {} : { receivedMessages: pending.splice(0) });
        },
        [`POST ${PUBSUB_ACK}`]: async (request) => {
          expect(request.headers.get("authorization")).toBe("Bearer pubsub-service-access");
          acknowledged.push(z.object({ ackIds: z.array(z.string()) }).parse(await request.json()).ackIds);
          return Response.json({});
        },
      });

      const hosting = await resolveGmailWatchHosting(runtime, {
        GMAIL_PUBSUB_TOPIC: TOPIC,
        GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
        GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: key.path,
        GMAIL_OAUTH_CLIENT_ID: "synthetic-client-id",
        GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      });
      if (!hosting) throw new Error("expected the Gmail watch lifecycle to be hosted");
      root = createMailLiveSyncRoot(
        runtime,
        createMailLiveSyncLifecycleFactory({ pool: runtime, hosted: { gmail_api: hosting.lifecycle } }),
        {
          discoveryIntervalMs: DISCOVERY_INTERVAL_MS,
          onLifecycleError: (mailboxItemId, phase, err) => {
            lifecycleErrors.push({ mailboxItemId, phase, err });
          },
        },
      );
      await root.start();
      await waitFor(async () =>
        (await Promise.all([first, second].map(syncStateOf))).every(
          (state) => state?.gmail_watch_email_address === "verified@example.com",
        ),
      );
      await clearSyncJobsFor(first);
      await clearSyncJobsFor(second);

      const running = createGmailPubSubDispatcherFor(runtime, hosting);
      dispatcher = running;
      await running.start();
      await waitFor(async () => acknowledged.length === 1);
      // Handed off to no mailbox: the claimed address is the first mailbox's Mailboxes.addresses only.
      expect(acknowledged).toEqual([["ack-claimed"]]);
      expect(await syncJobsFor(first)).toBe(0);
      expect(await syncJobsFor(second)).toBe(0);

      // Phase two: the provider-verified address reaches both tenants' watching mailboxes.
      pending.push(pubSubMessage("ack-verified", "verified@example.com"));
      await waitFor(async () => acknowledged.length === 2);
      expect(acknowledged).toEqual([["ack-claimed"], ["ack-verified"]]);
      expect(await syncJobsFor(first)).toBe(1);
      expect(await syncJobsFor(second)).toBe(1);
      // One assertion exchange for the pull and the acknowledge: the service-account token is cached.
      expect(serviceAccountExchanges).toBe(1);
      expect(lifecycleErrors).toEqual([]);
      const recorded = JSON.stringify([logs.calls, seen.map((request) => request.url)]);
      for (const secret of [key.pem, REFRESH_TOKEN, CLIENT_SECRET, "gmail-user-access", "pubsub-service-access"]) {
        expect(JSON.stringify(logs.calls)).not.toContain(secret);
        expect(recorded).not.toContain(secret);
      }
    } catch (error) {
      primary = { error };
    }
    // Both run on `runtime`, so they stop before it ends; each step runs even when an earlier one fails.
    const [stopping, rooted] = [dispatcher, root];
    dispatcher = undefined;
    root = undefined;
    await settleAll(primary, [() => stopping?.stop(), () => rooted?.stop(), () => runtime.end()]);
  });

  it("with the Gmail OAuth client but no Pub/Sub keys logs one lifecycle warning, without the client logs none, and keeps Gmail accounts on the noop lifecycle", async () => {
    stubProviders({});
    const configured = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(
      await resolveGmailWatchHosting(pool, { GMAIL_OAUTH_CLIENT_ID: "id", GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET }),
    ).toBeNull();
    expect(configured.mock.calls).toEqual([
      [
        { reason: "missing GMAIL_PUBSUB_TOPIC, GMAIL_PUBSUB_SUBSCRIPTION, GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH" },
        "Gmail watch lifecycles are not hosted; Gmail accounts are synced by the periodic sweep",
      ],
    ]);
    expect(JSON.stringify(configured.mock.calls)).not.toContain(CLIENT_SECRET);
    configured.mockRestore();
    // Without the OAuth client the mail sync adapters own the provider warning; the lifecycle adds none, also
    // when the Pub/Sub keys are present.
    for (const env of [
      {},
      {
        GMAIL_PUBSUB_TOPIC: TOPIC,
        GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
        GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: "/x",
      },
    ]) {
      const unconfigured = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      expect(await resolveGmailWatchHosting(pool, env)).toBeNull();
      expect(unconfigured).not.toHaveBeenCalled();
      unconfigured.mockRestore();
    }

    root = composeRoot({});
    const gmailId = await insertMailbox("gmail");
    await root.start();
    expect(await syncJobsFor(gmailId)).toBe(1);
    expect(lifecycleErrors).toEqual([]);
  });

  it("reads the configuration's formats and key file, naming the key and a fixed category, never a value", async () => {
    const directory = ownDirectory();
    const key = await writeServiceAccountKey(directory);
    const complete = {
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: key.path,
    };
    const keyFile = async (name: string, privateKey: string) => {
      const path = join(directory, name);
      await writeFile(
        path,
        JSON.stringify({ type: "service_account", client_email: SERVICE_ACCOUNT_EMAIL, private_key: privateKey }),
      );
      return path;
    };
    const garbage = await keyFile("garbage.json", "secret-garbage");
    const publicOnly = await keyFile(
      "public.json",
      generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const ecKey = await keyFile(
      "ec.json",
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const notJson = join(directory, "not-json.json");
    await writeFile(notJson, "secret-garbage");
    const notAKeyReason = "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is not a service account key";
    const withPath = (path: string) => ({ ...complete, GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: path });
    const cases: [Record<string, string>, string][] = [
      [
        { ...complete, GMAIL_PUBSUB_TOPIC: "topics/gmail" },
        "GMAIL_PUBSUB_TOPIC is not projects/<project>/topics/<topic>",
      ],
      [
        { ...complete, GMAIL_PUBSUB_SUBSCRIPTION: TOPIC },
        "GMAIL_PUBSUB_SUBSCRIPTION is not projects/<project>/subscriptions/<subscription>",
      ],
      [withPath(join(directory, "absent.json")), "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH does not exist"],
      [withPath(join(key.path, "beneath-a-file.json")), "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH does not exist"],
      [withPath(directory), "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is a directory"],
      [withPath("key\0.json"), "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is not a valid path"],
      [withPath(notJson), notAKeyReason],
      [withPath(garbage), notAKeyReason],
      [withPath(publicOnly), notAKeyReason],
      [withPath(ecKey), notAKeyReason],
      [{ ...complete, GMAIL_PUBSUB_TOPIC: "" }, "missing GMAIL_PUBSUB_TOPIC"],
    ];
    for (const [env, reason] of cases) {
      expect(await loadGmailPubSubConfig(env)).toEqual({ config: null, reason });
    }
    const loaded = await loadGmailPubSubConfig(complete);
    expect(loaded.config).toMatchObject({ topicName: TOPIC, subscriptionName: SUBSCRIPTION });
  });

  it("propagates an unexpected key file read failure as it is rather than reporting a missing configuration", async () => {
    const directory = ownDirectory();
    // Two symlinks pointing at each other: the read fails with ELOOP, which is not a configuration category.
    await symlink(join(directory, "loop-b"), join(directory, "loop-a"));
    await symlink(join(directory, "loop-a"), join(directory, "loop-b"));
    const failure = await loadGmailPubSubConfig({
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: join(directory, "loop-a"),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: "ELOOP" });
  });

  it("maps a denied, a forbidden and an overlong key path to their fixed reasons, never the path", async () => {
    const directory = ownDirectory();
    const complete = { GMAIL_PUBSUB_TOPIC: TOPIC, GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION };
    // A real ENAMETOOLONG: one path component longer than any supported file system allows.
    expect(
      await loadGmailPubSubConfig({
        ...complete,
        GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: join(directory, "k".repeat(300)),
      }),
    ).toEqual({ config: null, reason: "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is not a valid path" });
    // EACCES and EPERM through the armed read fault: a permission bit does not deny a root user, as CI may run.
    const keyPath = join(directory, "key.json");
    for (const code of ["EACCES", "EPERM"]) {
      fsFault.readFile = Object.assign(new Error(`${code}: synthetic, open '${keyPath}'`), {
        code,
        syscall: "open",
        path: keyPath,
      });
      const result = await loadGmailPubSubConfig({ ...complete, GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: keyPath });
      expect(result).toEqual({ config: null, reason: "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is not readable" });
      expect(JSON.stringify(result)).not.toContain(directory);
    }
    fsFault.readFile = undefined;
  });

  it("propagates a key file read failure without a code, or with a non-string code, as the same error", async () => {
    const env = {
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: join(ownDirectory(), "key.json"),
    };
    for (const fault of [
      new Error("synthetic read failure"),
      Object.assign(new Error("synthetic code"), { code: 13 }),
    ]) {
      fsFault.readFile = fault;
      const failure = await loadGmailPubSubConfig(env).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBe(fault);
    }
    fsFault.readFile = undefined;
  });

  it("propagates an encrypted key's missing-passphrase decode error as it is, not as a configuration reason", async () => {
    const directory = ownDirectory();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "synthetic-passphrase" },
    });
    const path = join(directory, "encrypted.json");
    await writeFile(
      path,
      JSON.stringify({ type: "service_account", client_email: SERVICE_ACCOUNT_EMAIL, private_key: privateKey }),
    );
    decodeFailures.length = 0;
    const failure = await loadGmailPubSubConfig({
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: path,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    // The very error the owner's real decode threw, not a wrapper or a copy of it.
    expect(decodeFailures).toHaveLength(1);
    expect(failure).toBe(decodeFailures[0]);
    // An unrecognized decoder error: an Error whose string code lies outside the one decoder code the owner maps
    // to a configuration reason (`ERR_OSSL_UNSUPPORTED`), whichever code this host's OpenSSL gives it.
    expect(failure).toBeInstanceOf(Error);
    const code: unknown = failure instanceof Error ? Reflect.get(failure, "code") : undefined;
    expect(typeof code).toBe("string");
    expect(code).not.toBe("ERR_OSSL_UNSUPPORTED");
    expect(String(failure)).not.toContain(privateKey.slice(40, 80));
  });

  it("fails a held fetch, a held body read and a held cancellation at the shared deadline, and caches no failure", async () => {
    const key = await writeServiceAccountKey(ownDirectory());
    const loaded = await loadGmailPubSubConfig({
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: key.path,
    });
    if (!loaded.config) throw new Error(loaded.reason);
    const config = loaded.config;
    // Each token request's deadline, controlled by this case instead of 15 real seconds.
    const deadlines: { ms: number; controller: AbortController }[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const controller = new AbortController();
      deadlines.push({ ms, controller });
      return controller.signal;
    });
    const expire = (index: number): unknown => {
      const entry = deadlines[index];
      if (!entry) throw new Error(`no deadline ${index}`);
      entry.controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      const reason: unknown = entry.controller.signal.reason;
      return reason;
    };
    const providers = heldProviders();
    let fetchHeld = false;
    let readHeld = false;
    let cancelHeld = false;
    const good = () => new Response(JSON.stringify({ access_token: "pubsub-token-good", expires_in: 30 }));
    const answers: ((request: Request) => Response | Promise<Response>)[] = [
      (request) =>
        providers.heldFetch(request, () => {
          fetchHeld = true;
        }),
      good,
      () =>
        providers.heldStream({
          onPull: () => {
            readHeld = true;
          },
        }),
      good,
      () =>
        providers.heldStream({
          onCancel: () => {
            cancelHeld = true;
          },
          status: 500,
        }),
      good,
    ];
    let exchanges = 0;
    stubProviders({
      [`POST ${GOOGLE_TOKEN}`]: (request) => {
        const answer = answers[exchanges];
        exchanges += 1;
        if (!answer) throw new Error("no further token answer");
        return answer(request);
      },
    });
    // Every owner outcome is recorded by the harness when it starts, and its bound is observed as it is created.
    const bounded = (what: string) =>
      providers.bounded(
        providers.owner(() => config.getPubSubAccessToken()),
        OWNER_MS,
        what,
      );
    const outcome = async (what: string) => take(await bounded(what));
    let primary: { error: unknown } | undefined;
    try {
      // Observed from here on: a bound expiring during the readiness wait below cannot reject unhandled.
      const fetching = bounded("The owner of the held fetch");
      await waitFor(async () => fetchHeld);
      const fetchReason = expire(0);
      const fetchFailed = take(await fetching);
      expect("error" in fetchFailed && fetchFailed.error).toBe(fetchReason);
      expect(await outcome("A later token request")).toEqual({ token: "pubsub-token-good" });

      const reading = bounded("The owner of the held body read");
      await waitFor(async () => readHeld);
      const readReason = expire(2);
      const readFailed = take(await reading);
      if (!("error" in readFailed) || !(readFailed.error instanceof AggregateError)) {
        throw new Error("expected an AggregateError for the held read");
      }
      expect(readFailed.error.errors[0]).toBe(readReason);
      expect(readFailed.error.errors[1]).toEqual(
        new Error("The Pub/Sub token response was not settled before its deadline"),
      );
      expect(readFailed.error.cause).toBe(readReason);
      expect(await outcome("A later token request")).toEqual({ token: "pubsub-token-good" });

      const cancelling = bounded("The owner of the held cancellation");
      await waitFor(async () => cancelHeld);
      expire(4);
      const cancelFailed = take(await cancelling);
      if (!("error" in cancelFailed) || !(cancelFailed.error instanceof AggregateError)) {
        throw new Error("expected an AggregateError for the held cancellation");
      }
      expect(cancelFailed.error.errors).toEqual([
        new Error("The Pub/Sub token request failed with status 500"),
        new Error("The Pub/Sub token response's cancellation did not settle before its deadline"),
      ]);
      expect(cancelFailed.error.cause).toBe(cancelFailed.error.errors[0]);
      // No failure was cached: every later call exchanged again and succeeded.
      expect(await outcome("A later token request")).toEqual({ token: "pubsub-token-good" });
      expect(exchanges).toBe(answers.length);
      expect(deadlines.map((deadline) => deadline.ms)).toEqual(answers.map(() => 15_000));
    } catch (error) {
      primary = { error };
    }
    // Every held fetch, stream and stream promise is released, then every started owner outcome and every bounded
    // observation drained, before afterEach restores the globals and the spy.
    await settleAll(primary, [() => providers.release()]);
  });

  it("releases a held fetch and drains its real token owner when the case fails before any deadline, keeping that failure", async () => {
    const key = await writeServiceAccountKey(ownDirectory());
    const loaded = await loadGmailPubSubConfig({
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: key.path,
    });
    if (!loaded.config) throw new Error(loaded.reason);
    const config = loaded.config;
    // A deadline that never expires: nothing below relies on the production deadline to free the held fetch.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const providers = heldProviders();
    let fetchHeld = false;
    stubProviders({
      [`POST ${GOOGLE_TOKEN}`]: (request) =>
        providers.heldFetch(request, () => {
          fetchHeld = true;
        }),
    });
    const owner = providers.owner(() => config.getPubSubAccessToken());
    const early = new Error("The case's observation failed while the fetch was held");
    let primary: { error: unknown } | undefined;
    try {
      await waitFor(async () => fetchHeld);
      throw early;
    } catch (error) {
      primary = { error };
    }
    const thrown = await settleAll(primary, [() => providers.release()]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBe(early);
    // The real owner settled with the release, not with a deadline.
    expect(await within(owner, OWNER_MS, "The released owner")).toEqual({ error: providers.releasedError });
  });

  it("reports an owner outcome that never settles as an unsettled failure after the case's own", async () => {
    const providers = heldProviders();
    // A synthetic owner that never settles, standing for a regressed one; it holds no resource. The harness keeps its
    // outcome, which never rejects, and the release below reports it as unsettled; nothing here awaits it.
    void providers.owner(() => new Promise<string>(() => {}));
    const early = new Error("The case's own failure");
    const thrown = await settleAll({ error: early }, [() => providers.release(50)]).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(thrown instanceof AggregateError)) throw new Error("expected an AggregateError");
    expect(thrown.errors).toEqual([
      early,
      new Error("A token-owner outcome after its provider work was released did not settle within 50 ms"),
    ]);
    expect(thrown.errors[0]).toBe(early);
    expect(thrown.cause).toBe(early);
  });

  it.each(["delayed", "failed"] as const)(
    "observes a bounded owner outcome from its creation, so %s readiness past its expired bound leaves no unhandled rejection and keeps the original failure",
    async (readiness) => {
      const key = await writeServiceAccountKey(ownDirectory());
      const loaded = await loadGmailPubSubConfig({
        GMAIL_PUBSUB_TOPIC: TOPIC,
        GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
        GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: key.path,
      });
      if (!loaded.config) throw new Error(loaded.reason);
      const config = loaded.config;
      // A deadline that never expires: only the release below frees the held fetch.
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
      const providers = heldProviders();
      let fetchHeld = false;
      stubProviders({
        [`POST ${GOOGLE_TOKEN}`]: (request) =>
          providers.heldFetch(request, () => {
            fetchHeld = true;
          }),
      });
      const owner = providers.owner(() => config.getPubSubAccessToken());
      // A bound far below the readiness wait. The owner is held until the release, so this bound expires first.
      const fetching = providers.bounded(owner, 20, "The owner of the held fetch");
      // Set once the observation has settled; the readiness wait reads this flag and never awaits the observation.
      let expired = false;
      const expiring = fetching.then(() => {
        expired = true;
      });
      const readinessFailed = new Error("The case's readiness was never signalled");
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      let primary: { error: unknown } | undefined;
      try {
        // Readiness is held until the owner's fetch is held and the bound has expired, then arrives late or fails.
        await waitFor(async () => {
          if (!fetchHeld || !expired) return false;
          if (readiness === "failed") throw readinessFailed;
          return true;
        });
        take(await fetching);
        throw new Error("expected the bound to have expired");
      } catch (error) {
        primary = { error };
      }
      const thrown = await settleAll(primary, [
        () => providers.release(),
        // One more turn of the event loop, after which an unhandled rejection would already have been reported.
        () => new Promise<void>((resolve) => setImmediate(resolve)),
        () => {
          process.off("unhandledRejection", onUnhandled);
        },
      ]).then(
        () => null,
        (error: unknown) => error,
      );
      await expiring;
      const observation = await fetching;
      if (observation.ok) throw new Error("expected the bound to have rejected");
      expect(observation.error).toEqual(new Error("The owner of the held fetch did not settle within 20 ms"));
      // The case's own failure is kept: the readiness failure, or the bound's error rethrown unchanged by `take`.
      expect(thrown).toBe(readiness === "failed" ? readinessFailed : observation.error);
      expect(unhandled).toEqual([]);
      // The real owner settled with the release, not with a deadline.
      expect(await within(owner, OWNER_MS, "The released owner")).toEqual({ error: providers.releasedError });
    },
  );

  it("settles every failed token response, keeps its own failure first, and caches no failure", async () => {
    const key = await writeServiceAccountKey(ownDirectory());
    const loaded = await loadGmailPubSubConfig({
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: key.path,
    });
    if (!loaded.config) throw new Error(loaded.reason);
    const config = loaded.config;
    const cancelled: string[] = [];
    const readFailure = new Error("synthetic socket reset");
    const cancelFailure = new Error("synthetic cancel failure");
    const releaseFailure = new Error("synthetic release failure");

    /** A body stream that yields `chunks`, then ends or fails with `fail`; it records each cancel and can fail it. */
    function body(
      chunks: string[],
      options: { fail?: unknown; cancelFails?: boolean } = {},
    ): ReadableStream<Uint8Array> {
      let index = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[index];
          index += 1;
          if (chunk !== undefined) controller.enqueue(new TextEncoder().encode(chunk));
          else if (options.fail !== undefined) controller.error(options.fail);
          else controller.close();
        },
        cancel() {
          cancelled.push("cancel");
          if (options.cancelFails) throw cancelFailure;
        },
      });
    }
    /** A response whose body hands out a reader that reads normally but fails to release its lock. */
    function unreleasable(text: string): Response {
      const stream = body([text]);
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "body", {
        value: {
          getReader() {
            const reader = stream.getReader();
            return {
              read: () => reader.read(),
              cancel: (reason?: unknown) => reader.cancel(reason),
              releaseLock: () => {
                throw releaseFailure;
              },
            };
          },
        },
      });
      return response;
    }
    const good = () => new Response(JSON.stringify({ access_token: "pubsub-token-good", expires_in: 30 }));
    const oversized = "x".repeat(40 * 1024);
    const answers: (() => Response)[] = [
      () => new Response(body(['{"error":"backend","access_token":"leaked-token"}']), { status: 503 }),
      good,
      () => new Response(body(["{}"], { cancelFails: true }), { status: 500 }),
      good,
      () => new Response(body([oversized, oversized, oversized, oversized])),
      good,
      () => new Response(body([oversized, oversized, oversized, oversized], { cancelFails: true })),
      good,
      () => new Response(body(['{"access_token":'], { fail: readFailure })),
      good,
      () => new Response(body(["not json: leaked-token"])),
      good,
      () => new Response(body([JSON.stringify({ token: "leaked-token" })])),
      good,
      () => unreleasable(JSON.stringify({ access_token: "pubsub-token-unsettled", expires_in: 3600 })),
      good,
    ];
    let exchanges = 0;
    stubProviders({
      [`POST ${GOOGLE_TOKEN}`]: () => {
        const answer = answers[exchanges];
        exchanges += 1;
        if (!answer) throw new Error("no further token answer");
        return answer();
      },
    });
    const outcome = () =>
      config.getPubSubAccessToken().then(
        (token) => ({ token }),
        (error: unknown) => ({ error }),
      );

    const nonOk = await outcome();
    expect(nonOk).toEqual({ error: new Error("The Pub/Sub token request failed with status 503") });
    expect(await outcome()).toEqual({ token: "pubsub-token-good" });

    const nonOkCancelFails = await outcome();
    if (!("error" in nonOkCancelFails) || !(nonOkCancelFails.error instanceof AggregateError)) {
      throw new Error("expected an AggregateError");
    }
    expect(nonOkCancelFails.error.message).toBe("The Pub/Sub token request failed with status 500");
    expect(nonOkCancelFails.error.errors).toEqual([
      new Error("The Pub/Sub token request failed with status 500"),
      cancelFailure,
    ]);
    expect(nonOkCancelFails.error.cause).toBe(nonOkCancelFails.error.errors[0]);
    expect(await outcome()).toEqual({ token: "pubsub-token-good" });

    expect(await outcome()).toEqual({ error: new Error("The Pub/Sub token response exceeded its size cap") });
    expect(await outcome()).toEqual({ token: "pubsub-token-good" });

    const oversizedCancelFails = await outcome();
    if (!("error" in oversizedCancelFails) || !(oversizedCancelFails.error instanceof AggregateError)) {
      throw new Error("expected an AggregateError");
    }
    expect(oversizedCancelFails.error.errors).toEqual([
      new Error("The Pub/Sub token response exceeded its size cap"),
      cancelFailure,
    ]);
    expect(await outcome()).toEqual({ token: "pubsub-token-good" });

    const readFails = await outcome();
    expect("error" in readFails && readFails.error).toBe(readFailure);
    expect(await outcome()).toEqual({ token: "pubsub-token-good" });

    expect(await outcome()).toEqual({ error: new Error("The Pub/Sub token response is not a token") });
    expect(await outcome()).toEqual({ token: "pubsub-token-good" });
    expect(await outcome()).toEqual({ error: new Error("The Pub/Sub token response is not a token") });
    expect(await outcome()).toEqual({ token: "pubsub-token-good" });

    const unsettled = await outcome();
    if (!("error" in unsettled) || !(unsettled.error instanceof AggregateError)) {
      throw new Error("expected an AggregateError");
    }
    expect(unsettled.error.errors).toEqual([
      new Error("The Pub/Sub token response could not be settled"),
      releaseFailure,
    ]);
    // The token of a response that could not be settled is not cached: the next call exchanges again.
    expect(await outcome()).toEqual({ token: "pubsub-token-good" });

    expect(exchanges).toBe(answers.length);
    // The 503 and 500 bodies were never read and were cancelled, as were both oversized bodies.
    expect(cancelled).toEqual(["cancel", "cancel", "cancel", "cancel"]);
    expect(JSON.stringify([nonOk, nonOkCancelFails, readFails, unsettled])).not.toContain("leaked-token");
  });

  it("caches the service-account token until shortly before it expires, retries after a failure, and leaks neither key nor token", async () => {
    const key = await writeServiceAccountKey(ownDirectory());
    const env = {
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: key.path,
    };
    const answers: (() => Response)[] = [
      () => Response.json({ error: "backend_error", access_token: "leaked-in-error-body" }, { status: 500 }),
      () => Response.json({ access_token: "pubsub-token-1", expires_in: 3600 }),
      () => Response.json({ access_token: "pubsub-token-short", expires_in: 30 }),
      () => Response.json({ access_token: "pubsub-token-2", expires_in: 30 }),
    ];
    let exchanges = 0;
    stubProviders({
      [`POST ${GOOGLE_TOKEN}`]: async (request) => {
        const claims = assertionClaimsSchema.safeParse(
          verifiedAssertionClaims((await formOf(request)).get("assertion") ?? "", key.publicKey),
        );
        if (!claims.success) return Response.json({ error: "invalid_grant" }, { status: 400 });
        expect(claims.data.exp - claims.data.iat).toBe(3600);
        const answer = answers[exchanges];
        exchanges += 1;
        if (!answer) throw new Error("no further token answer");
        return answer();
      },
    });
    const first = await loadGmailPubSubConfig(env);
    if (!first.config) throw new Error(first.reason);
    const failure = await first.config.getPubSubAccessToken().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toEqual(new Error("The Pub/Sub token request failed with status 500"));
    expect(await first.config.getPubSubAccessToken()).toBe("pubsub-token-1");
    expect(await first.config.getPubSubAccessToken()).toBe("pubsub-token-1");
    expect(exchanges).toBe(2);

    // A token that lives less than the refresh margin is replaced on the next call.
    const second = await loadGmailPubSubConfig(env);
    if (!second.config) throw new Error(second.reason);
    expect(await second.config.getPubSubAccessToken()).toBe("pubsub-token-short");
    expect(await second.config.getPubSubAccessToken()).toBe("pubsub-token-2");
    expect(exchanges).toBe(4);
    expect(JSON.stringify(failure)).not.toContain("leaked-in-error-body");
    expect(String(failure)).not.toContain(key.pem.slice(40, 80));
  });
});

/** A Graph-mode mailbox in tenant zero with its refresh token and sync state. */
async function insertGraphMailbox(): Promise<string> {
  return inTenantZero(() =>
    withTransaction(pool, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesDatabaseId,
        properties: { name: `Mailbox ${randomUUID()}`, provider: "outlook" },
      });
      await storeCredential(client, {
        itemId: mailbox.id,
        credentialType: "oauth2_refresh_token",
        plaintext: REFRESH_TOKEN,
      });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "graph_api" });
      return mailbox.id;
    }),
  );
}

const GRAPH_ENV = { MS_GRAPH_OAUTH_CLIENT_ID: "synthetic-graph-client", MS_GRAPH_OAUTH_CLIENT_SECRET: CLIENT_SECRET };

describe("Microsoft Graph subscription lifecycles (issue #1745)", () => {
  beforeAll(() => {
    pool = getTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    await createTenantZeroUser(pool);
    lifecycleErrors = [];
    idleErrors = [];
    root = undefined;
  });

  afterEach(async () => {
    const rooted = root;
    root = undefined;
    await settleAll(undefined, [() => rooted?.stop(), () => vi.unstubAllGlobals(), () => vi.restoreAllMocks()]);
  });

  it.each([
    ["https://semprec.example", "https://semprec.example/api/mail/graph/webhook"],
    ["https://semprec.example/", "https://semprec.example/api/mail/graph/webhook"],
    ["https://semprec.example:8443", "https://semprec.example:8443/api/mail/graph/webhook"],
  ])("hosts Graph for the plain https origin %s", (appBaseUrl, notificationUrl) => {
    const decision = decideGraphSubscriptionHosting(appBaseUrl, { clientId: "id", clientSecret: "secret" });
    expect(decision).toEqual({ hosted: true, notificationUrl, client: { clientId: "id", clientSecret: "secret" } });
  });

  it.each([
    "http://localhost:3000",
    "https://semprec.example/app",
    "https://semprec.example?x=1",
    "https://user@semprec.example",
    "not a url",
    "https://",
    // URL parsing of an https URL turns a backslash into a path separator: each would otherwise lose its path.
    "https://semprec.example\\app",
    "https://semprec.example\\",
    "https://semprec.example\\?x=1",
    "https://semprec.example:8443\\app",
    // Passes the text check but does not parse.
    "https://semprec.example:99999",
  ])("does not host Graph for APP_BASE_URL %s", (appBaseUrl) => {
    expect(decideGraphSubscriptionHosting(appBaseUrl, { clientId: "id", clientSecret: "secret" })).toEqual({
      hosted: false,
      reason: "APP_BASE_URL is not an https:// origin without a path",
    });
  });

  it("does not host Graph without its OAuth client, naming the missing keys", () => {
    expect(
      decideGraphSubscriptionHosting("https://semprec.example", { missingEnv: ["MS_GRAPH_OAUTH_CLIENT_SECRET"] }),
    ).toEqual({
      hosted: false,
      reason: "missing MS_GRAPH_OAUTH_CLIENT_SECRET",
    });
  });

  it("creates a subscription at the deployment's webhook, a notification enqueues a sync, and a restart re-registers after a 404", async () => {
    const logs = captureServiceLogs();
    const created: { notificationUrl: string; clientState: string }[] = [];
    const renewals: string[] = [];
    let renewStatus = 404;
    const seen = stubProviders({
      [`POST ${MICROSOFT_TOKEN}`]: async (request) => {
        const form = await formOf(request);
        expect(form.get("client_secret")).toBe(CLIENT_SECRET);
        return Response.json({ access_token: "graph-user-access", expires_in: 3600, refresh_token: REFRESH_TOKEN });
      },
      [`POST ${GRAPH_SUBSCRIPTIONS}`]: async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer graph-user-access");
        const body = z.object({ notificationUrl: z.string(), clientState: z.string() }).parse(await request.json());
        created.push(body);
        return Response.json({
          id: `sub-${created.length}`,
          expirationDateTime: new Date(Date.now() + 3600_000).toISOString(),
        });
      },
      [`PATCH ${GRAPH_SUBSCRIPTIONS}/*`]: (request) => {
        renewals.push(request.url);
        if (renewStatus === 404) return new Response(null, { status: 404 });
        return Response.json({
          id: request.url.split("/").at(-1),
          expirationDateTime: new Date(Date.now() + 7200_000).toISOString(),
        });
      },
    });
    const graph = resolveGraphSubscriptionHosting(pool, GRAPH_ENV, "https://semprec.example");
    if (!graph) throw new Error("expected the Graph lifecycle to be hosted");
    const mailboxId = await insertGraphMailbox();

    root = composeRoot({ graph_api: graph });
    await root.start();
    await waitFor(async () => (await syncStateOf(mailboxId))?.graph_subscription_id === "sub-1");
    expect(created.map((entry) => entry.notificationUrl)).toEqual(["https://semprec.example/api/mail/graph/webhook"]);

    await clearSyncJobsFor(mailboxId);
    const clientState = created[0]?.clientState ?? "";
    await expect(handleGraphChangeNotification(pool, { subscriptionId: "sub-1", clientState })).resolves.toBe(
      "accepted",
    );
    expect(await syncJobsFor(mailboxId)).toBe(1);

    await root.stop();
    root = undefined;
    const requestsAtStop = seen.length;
    await sleep(50);
    expect(seen.length).toBe(requestsAtStop);

    // A restart renews the persisted subscription; Graph no longer has it, so a new one is registered.
    root = composeRoot({ graph_api: graph });
    await root.start();
    await waitFor(async () => (await syncStateOf(mailboxId))?.graph_subscription_id === "sub-2");
    expect(renewals).toEqual([`${GRAPH_SUBSCRIPTIONS}/sub-1`]);
    await root.stop();

    // A renewal Graph accepts moves only the expiry.
    renewStatus = 200;
    const before = await syncStateOf(mailboxId);
    root = composeRoot({ graph_api: graph });
    await root.start();
    await waitFor(async () => renewals.length === 2);
    await waitFor(
      async () =>
        (await syncStateOf(mailboxId))?.graph_subscription_expires_at?.getTime() !==
        before?.graph_subscription_expires_at?.getTime(),
    );
    expect((await syncStateOf(mailboxId))?.graph_subscription_id).toBe("sub-2");
    expect(created).toHaveLength(2);
    expect(lifecycleErrors).toEqual([]);
    for (const secret of [REFRESH_TOKEN, CLIENT_SECRET, "graph-user-access"]) {
      expect(JSON.stringify(logs.calls)).not.toContain(secret);
    }
  });

  it("logs a failed subscription create by its error name only", async () => {
    const logs = captureServiceLogs();
    stubProviders({
      [`POST ${MICROSOFT_TOKEN}`]: () => Response.json({ access_token: "graph-user-access", expires_in: 3600 }),
      [`POST ${GRAPH_SUBSCRIPTIONS}`]: () =>
        Response.json({ error: { message: "graph-user-access" } }, { status: 500 }),
    });
    const graph = resolveGraphSubscriptionHosting(pool, GRAPH_ENV, "https://semprec.example");
    if (!graph) throw new Error("expected the Graph lifecycle to be hosted");
    const mailboxId = await insertGraphMailbox();
    root = composeRoot({ graph_api: graph });
    await root.start();
    await waitFor(async () => logs.calls.some((call) => call[2] === "Graph subscription lifecycle failed"));
    expect(logs.calls.filter((call) => call[2] === "Graph subscription lifecycle failed")).toEqual([
      [
        "warn",
        { mailboxItemId: mailboxId, phase: "subscription", errorName: "Error" },
        "Graph subscription lifecycle failed",
      ],
    ]);
    for (const secret of [REFRESH_TOKEN, CLIENT_SECRET, "graph-user-access"]) {
      expect(JSON.stringify(logs.calls)).not.toContain(secret);
    }
  });

  it.each([
    ["an http APP_BASE_URL", "http://localhost:3000"],
    ["a path-bearing APP_BASE_URL", "https://semprec.example/app"],
  ])(
    "with the Graph OAuth client and %s, logs one lifecycle warning and keeps Graph accounts on the noop lifecycle",
    async (_name, appBaseUrl) => {
      stubProviders({});
      const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      expect(resolveGraphSubscriptionHosting(pool, GRAPH_ENV, appBaseUrl)).toBeNull();
      expect(warning.mock.calls).toEqual([
        [
          { reason: "APP_BASE_URL is not an https:// origin without a path" },
          "Graph subscription lifecycles are not hosted; Graph accounts are synced by the periodic sweep",
        ],
      ]);
      root = composeRoot({});
      const mailboxId = await insertGraphMailbox();
      await root.start();
      expect(await syncJobsFor(mailboxId)).toBe(1);
    },
  );

  it("without the Graph OAuth client logs no lifecycle warning, hosts nothing and keeps Graph accounts on the noop lifecycle", async () => {
    stubProviders({});
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    // The mail sync adapters own this provider's one startup warning (mailSyncAdapters.test.ts).
    expect(resolveGraphSubscriptionHosting(pool, {}, "https://semprec.example")).toBeNull();
    expect(warning).not.toHaveBeenCalled();
    root = composeRoot({});
    const mailboxId = await insertGraphMailbox();
    await root.start();
    expect(await syncJobsFor(mailboxId)).toBe(1);
  });

  it("leaves the other sync modes as they were when Graph is hosted", async () => {
    stubProviders({
      [`POST ${MICROSOFT_TOKEN}`]: () => Response.json({ access_token: "graph-user-access", expires_in: 3600 }),
      [`POST ${GRAPH_SUBSCRIPTIONS}`]: () =>
        Response.json({ id: "sub-only", expirationDateTime: new Date(Date.now() + 3600_000).toISOString() }),
    });
    const graph = resolveGraphSubscriptionHosting(pool, GRAPH_ENV, "https://semprec.example");
    if (!graph) throw new Error("expected the Graph lifecycle to be hosted");
    const fake = createFakeIdleTransport();
    root = composeRoot({ imap: imapIdleOver(fake.transport), graph_api: graph });
    const imapId = await insertMailbox("generic");
    const gmailId = await insertMailbox("gmail");
    const graphId = await insertGraphMailbox();
    await root.start();
    await waitFor(async () => fake.connections.length === 1);
    await waitFor(async () => (await syncStateOf(graphId))?.graph_subscription_id === "sub-only");
    expect(fake.connections[0]?.mailboxItemId).toBe(imapId);
    expect(fake.resolvedMailboxes).not.toContain(graphId);
    expect(await syncJobsFor(gmailId)).toBe(1);
    expect(lifecycleErrors).toEqual([]);
  });
});
