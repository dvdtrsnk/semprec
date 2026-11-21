import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
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

/** Armed by one case and disarmed in `afterEach`; while armed, the key file read rejects with this error. */
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

/** Records every error `createPrivateKey` threw, passing through to the real function; cleared in `afterEach`. */
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
 * Runs every cleanup even when one fails. `primary` stays first: rethrown alone, or inside an `AggregateError`
 * with the cleanup failures after it. A thrown falsy value counts because `primary` wraps it.
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

/** The rejection of `work`, or `null` when it resolved. */
function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => null,
    (error: unknown) => error,
  );
}

const DISCOVERY_INTERVAL_MS = 200;
const IMAP_HOST = "imap.mail.test";
const IMAP_ENDPOINT: MailServerEndpoint = { host: IMAP_HOST, port: 993, security: "tls" };
const IMAP_USERNAME = "mailbox@mail.test";
const APP_PASSWORD = "app-password-that-must-never-be-logged";
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
const GRAPH_ENV = { MS_GRAPH_OAUTH_CLIENT_ID: "synthetic-graph-client", MS_GRAPH_OAUTH_CLIENT_SECRET: CLIENT_SECRET };

let pool: Pool;
let root: MailLiveSyncRoot | undefined;
let stub: DnsLookupStub | undefined;
let lifecycleErrors: { mailboxItemId: string; phase: string; err: unknown }[] = [];
let idleErrors: { mailboxItemId: string; folderPath: string; err: unknown }[] = [];

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
  const [rooted, stubbed] = [root, stub];
  root = undefined;
  stub = undefined;
  await settleAll(undefined, [
    () => rooted?.stop(),
    () => stubbed?.restore(),
    () => vi.unstubAllGlobals(),
    () => vi.restoreAllMocks(),
  ]);
});

/** `onSignal` is the lifecycle's callback, so a test fires the signal the way imapflow would. */
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

/** `refuses` takes the key `mailboxItemId/folderPath`. */
function createFakeIdleTransport(
  options: { folders?: string[]; refuses?: (key: string, attempt: number) => boolean } = {},
) {
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
      // As the address policy refuses: the mapped error, no socket opened.
      if (options.refuses?.(key, attempt)) throw new MailServerUnreachableError();
      const connection = new FakeIdleConnection(mailboxItemId, folderPath, onSignal);
      connections.push(connection);
      return connection;
    },
  };
  return { transport, resolvedMailboxes, connections, attempts };
}

function imapIdleOver(transport: ImapIdleTransport): MailLiveSyncLifecycleFactory {
  return createBoundedImapIdleLifecycleFactory(pool, transport, {
    getCredential: async () => APP_PASSWORD,
    getConnectionLimit: () => 5,
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 10,
    onError: (mailboxItemId, folderPath, err) => {
      idleErrors.push({ mailboxItemId, folderPath, err });
    },
  });
}

/** As serve.ts does, with a shortened discovery interval. */
function composeRoot(hosted: MailLiveSyncLifecycleDispatchOptions["hosted"], db: Pool = pool): MailLiveSyncRoot {
  return createMailLiveSyncRoot(db, createMailLiveSyncLifecycleFactory({ pool: db, hosted }), {
    discoveryIntervalMs: DISCOVERY_INTERVAL_MS,
    onLifecycleError: (mailboxItemId, phase, err) => {
      lifecycleErrors.push({ mailboxItemId, phase, err });
    },
  });
}

async function insertMailbox(
  provider: string,
  options: {
    properties?: Record<string, unknown>;
    db?: Pool;
    tenantId?: string;
    then?: (client: PoolClient, mailboxesDatabaseId: string, id: string) => Promise<unknown>;
  } = {},
): Promise<string> {
  return runInTenant(options.tenantId ?? getTenantZeroId(), () =>
    withTransaction(options.db ?? pool, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      const item = await createItemWithClient(client, {
        databaseId: mailboxesDatabaseId,
        properties: { name: `Mailbox ${randomUUID()}`, provider, ...options.properties },
      });
      await options.then?.(client, mailboxesDatabaseId, item.id);
      return item.id;
    }),
  );
}

const storeAppPassword = (client: PoolClient, itemId: string) =>
  storeCredential(client, { itemId, credentialType: "app_password", plaintext: APP_PASSWORD });

const storeRefreshToken = (client: PoolClient, itemId: string) =>
  storeCredential(client, { itemId, credentialType: "oauth2_refresh_token", plaintext: REFRESH_TOKEN });

function insertGraphMailbox(): Promise<string> {
  return insertMailbox("outlook", {
    then: async (client, _databaseId, id) => {
      await storeRefreshToken(client, id);
      await ensureMailAccountSyncState(client, { itemId: id, syncMode: "graph_api" });
    },
  });
}

async function syncJobsFor(mailboxItemId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = $1 AND jobs.key = $2`,
    [CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC, `mail-account-sync:${mailboxItemId}`],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Drops the syncs enqueued at start, so a test observes only the enqueue its own signal causes. */
async function clearSyncJobsFor(...mailboxItemIds: string[]): Promise<void> {
  for (const id of mailboxItemIds) {
    await pool.query(`DELETE FROM graphile_worker._private_jobs WHERE key = $1`, [`mail-account-sync:${id}`]);
  }
}

async function syncStateOf(mailboxItemId: string) {
  const { rows } = await pool.query<{
    gmail_watch_email_address: string | null;
    graph_subscription_id: string | null;
    graph_subscription_expires_at: Date | null;
  }>(
    `SELECT gmail_watch_email_address, graph_subscription_id, graph_subscription_expires_at
     FROM mail_account_sync_state WHERE item_id = $1`,
    [mailboxItemId],
  );
  return rows[0];
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  expect(await check()).toBe(true);
}

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

/**
 * A closed set of synthetic provider endpoints keyed by method and exact URL (`PATCH` on a Graph subscription by
 * URL prefix); any other request is refused, so nothing reaches the network.
 */
function stubProviders(routes: Record<string, (request: Request) => Promise<Response> | Response>): Request[] {
  const seen: Request[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request.clone());
    const key = `${request.method} ${request.url}`;
    const route =
      routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith("/*") && key.startsWith(k.slice(0, -1)))?.[1];
    if (!route)
      throw new Error(`Refused an unexpected outbound request: ${request.method} ${new URL(request.url).host}`);
    return route(request);
  });
  return seen;
}

/** Answers the Google token endpoint from `answers` in order, counting the exchanges. */
function stubTokenAnswers(answers: ((request: Request) => Response | Promise<Response>)[]): { exchanges: number } {
  const counter = { exchanges: 0 };
  stubProviders({
    [`POST ${GOOGLE_TOKEN}`]: (request) => {
      const answer = answers[counter.exchanges];
      counter.exchanges += 1;
      if (!answer) throw new Error("no further token answer");
      return answer(request);
    },
  });
  return counter;
}

async function formOf(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await request.text());
}

function captureServiceLogs(): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  for (const level of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      calls.push([level, ...args]);
    });
  }
  return { calls };
}

function expectNoSecrets(recorded: unknown, secrets: string[]): void {
  const text = JSON.stringify(recorded);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe("mail live-sync lifecycles by sync mode", () => {
  it("hosts an imap account on the IDLE lifecycle: its connection opens, and a signal from it enqueues a sync", async () => {
    const fake = createFakeIdleTransport();
    root = composeRoot({ imap: imapIdleOver(fake.transport) });
    const mailboxId = await insertMailbox("generic");

    await root.start();
    await waitFor(async () => fake.connections.length === 1);
    const connection = fake.connections[0];
    if (!connection) throw new Error("the IDLE lifecycle opened no connection");
    expect([connection.mailboxItemId, connection.folderPath]).toEqual([mailboxId, "INBOX"]);

    await clearSyncJobsFor(mailboxId);
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

  it.each<[string, (client: PoolClient, id: string) => Promise<unknown>, boolean]>([
    ["has a credential but no IMAP settings", storeAppPassword, false],
    [
      "stores settings with only an SMTP endpoint",
      async (client, id) => {
        await storeAppPassword(client, id);
        await upsertMailServerSettings(client, id, {
          imap: null,
          smtp: { host: IMAP_HOST, port: 587, security: "starttls" },
          username: IMAP_USERNAME,
        });
      },
      false,
    ],
    [
      // The connection opens through the address-checked step, which refuses the private address.
      "has a host that resolves to a private address",
      async (client, id) => {
        await storeAppPassword(client, id);
        await upsertMailServerSettings(client, id, { imap: IMAP_ENDPOINT, smtp: null, username: IMAP_USERNAME });
      },
      true,
    ],
  ])(
    "retries discovery for an imap account that %s, naming the mailbox with fixed diagnostics",
    async (_case, setup, resolvesHost) => {
      stub = stubDnsLookup({ [IMAP_HOST]: ["10.0.0.1"] });
      root = composeRoot({ imap: createImapIdleLifecycleFactory(pool) });
      const mailboxId = await insertMailbox("generic", { then: (client, _db, id) => setup(client, id) });

      const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      await root.start();
      await vi.waitFor(() => expect(warning).toHaveBeenCalled());

      expect(lifecycleErrors).toHaveLength(0);
      expect(warning).toHaveBeenCalledWith(
        { mailboxItemId: mailboxId, stage: "idle", category: "failure" },
        "IMAP IDLE lifecycle failed",
      );
      expectNoSecrets(warning.mock.calls, [APP_PASSWORD]);
      if (resolvesHost) expect(stub.calls).toContain(IMAP_HOST);
    },
  );

  it("warns once and stops the discovery of an imap account without a stored credential", async () => {
    root = composeRoot({ imap: createImapIdleLifecycleFactory(pool) });
    const mailboxId = await insertMailbox("generic");

    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await root.start();
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());

    expect(lifecycleErrors).toHaveLength(0);
    expect(warning.mock.calls).toEqual([
      [{ mailboxItemId: mailboxId, stage: "idle", category: "failure" }, "IMAP IDLE lifecycle failed"],
    ]);
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
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error).toEqual(new Error("IMAP IDLE lifecycle failed unexpectedly"));
    expect(Object.keys(error as Error)).toEqual([]);
  });

  it("reads the mailbox's configured connection limit, then its provider's, then the default, also for an unknown mailbox", async () => {
    const configured = await insertMailbox("icloud", { properties: { connectionLimit: 4 } });
    const icloud = await insertMailbox("icloud");
    const generic = await insertMailbox("generic");

    await inTenantZero(async () => {
      expect(await connectionLimitOf(pool, configured)).toBe(4);
      expect(await connectionLimitOf(pool, icloud)).toBe(3);
      expect(await connectionLimitOf(pool, generic)).toBe(2);
      expect(await connectionLimitOf(pool, randomUUID())).toBe(2);
    });
  });
});

// Gmail watch and Microsoft Graph subscription hosting

async function writeKeyFile(directory: string, name: string, privateKey: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(
    path,
    JSON.stringify({ type: "service_account", client_email: SERVICE_ACCOUNT_EMAIL, private_key: privateKey }),
  );
  return path;
}

async function writeServiceAccountKey(directory: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { path: await writeKeyFile(directory, "service-account.json", pem), publicKey, pem };
}

const pubSubEnv = (keyPath: string) => ({
  GMAIL_PUBSUB_TOPIC: TOPIC,
  GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
  GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: keyPath,
});

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

function pubSubMessage(ackId: string, emailAddress: string) {
  return {
    ackId,
    message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId: "7" })).toString("base64") },
  };
}

type OwnerOutcome = { token: string } | { error: unknown };

const outcomeOf = (work: Promise<string>): Promise<OwnerOutcome> =>
  work.then(
    (token): OwnerOutcome => ({ token }),
    (error: unknown): OwnerOutcome => ({ error }),
  );

/**
 * Held fetches, streams and pull/cancel promises of a case's token-provider work; `release` frees all of it
 * without waiting for any production deadline, then drains the recorded outcomes.
 */
function heldProviders() {
  const outcomes: Promise<unknown>[] = [];
  const fetches: { reject: (error: Error) => void; removeListener: () => void }[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const holds: (() => void)[] = [];
  const releasedError = new Error("Released by the case's cleanup");
  const hold = () => new Promise<void>((resolve) => holds.push(resolve));
  return {
    /** The outcome never rejects, and a bound that expires first rejects it as a failure of the case. */
    owner(start: () => Promise<string>, what: string): Promise<OwnerOutcome> {
      const outcome = within(outcomeOf(start()), 5_000, what).catch((error: unknown) => ({ bound: error }));
      outcomes.push(outcome);
      return outcome.then((value) => {
        if ("bound" in value) throw value.bound;
        return value;
      });
    },
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
    async release(): Promise<void> {
      await settleAll(undefined, [
        ...fetches.flatMap((held) => [() => held.reject(releasedError), () => held.removeListener()]),
        ...streams.map((controller) => () => controller.error(releasedError)),
        ...holds.map((resolve) => () => resolve()),
        () => within(Promise.all(outcomes), 5_000, "A token-owner outcome after its provider work was released"),
      ]);
    },
  };
}

describe("Gmail watch lifecycles and the Pub/Sub dispatcher", () => {
  let directory: string | undefined;
  let dispatcher: { stop(): Promise<void> } | undefined;

  beforeEach(async () => {
    dispatcher = undefined;
    directory = await mkdtemp(join(tmpdir(), "semprec-gmail-pubsub-"));
  });

  function ownDirectory(): string {
    if (directory === undefined) throw new Error("the test directory was not created");
    return directory;
  }

  async function loadConfig() {
    const key = await writeServiceAccountKey(ownDirectory());
    const loaded = await loadGmailPubSubConfig(pubSubEnv(key.path));
    if (!loaded.config) throw new Error(loaded.reason);
    return { key, config: loaded.config };
  }

  afterEach(async () => {
    const [stopping, owned] = [dispatcher, directory];
    dispatcher = undefined;
    directory = undefined;
    await settleAll(undefined, [
      () => stopping?.stop(),
      () => {
        fsFault.readFile = undefined;
        decodeFailures.length = 0;
      },
      () => (owned === undefined ? undefined : rm(owned, { recursive: true, force: true })),
    ]);
  });

  it("routes a notification for a watched, provider-verified address to one sync per mailbox, never by Mailboxes.addresses", async () => {
    const key = await writeServiceAccountKey(ownDirectory());
    const logs = captureServiceLogs();
    // Every production read and write runs on a runtime-role pool, under row-level security.
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    let primary: { error: unknown } | undefined;
    try {
      const otherTenant = await createTestTenant(pool);
      await runInTenant(otherTenant, () => seedSystem(runtime));
      const gmailMailbox = (tenantId: string, verifiedAddress: string, claimedAddress?: string) =>
        insertMailbox("gmail", {
          db: runtime,
          tenantId,
          then: async (client, mailboxesDatabaseId, id) => {
            if (claimedAddress !== undefined) {
              await writeMailboxAddresses(client, { mailboxesDatabaseId, mailboxItemId: id, address: claimedAddress });
            }
            await storeRefreshToken(client, id);
            await ensureMailAccountSyncState(client, { itemId: id, syncMode: "gmail_api" });
            await recordProviderAccountAddress(client, id, verifiedAddress);
          },
        });
      const first = await gmailMailbox(getTenantZeroId(), "Verified@Example.com", "claimed@example.com");
      const second = await gmailMailbox(otherTenant, "verified@example.com");
      // Only the claimed address first, so no verified notification's sync can mask a wrong route.
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
        ...pubSubEnv(key.path),
        GMAIL_OAUTH_CLIENT_ID: "synthetic-client-id",
        GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      });
      if (!hosting) throw new Error("expected the Gmail watch lifecycle to be hosted");
      root = composeRoot({ gmail_api: hosting.lifecycle }, runtime);
      await root.start();
      await waitFor(async () =>
        (await Promise.all([first, second].map(syncStateOf))).every(
          (state) => state?.gmail_watch_email_address === "verified@example.com",
        ),
      );
      await clearSyncJobsFor(first, second);

      const running = createGmailPubSubDispatcherFor(runtime, hosting);
      dispatcher = running;
      await running.start();
      await waitFor(async () => acknowledged.length === 1);
      // The claimed address is only the first mailbox's Mailboxes.addresses, so nothing receives it.
      expect(acknowledged).toEqual([["ack-claimed"]]);
      expect([await syncJobsFor(first), await syncJobsFor(second)]).toEqual([0, 0]);

      pending.push(pubSubMessage("ack-verified", "verified@example.com"));
      await waitFor(async () => acknowledged.length === 2);
      expect(acknowledged).toEqual([["ack-claimed"], ["ack-verified"]]);
      expect([await syncJobsFor(first), await syncJobsFor(second)]).toEqual([1, 1]);
      // The service-account token is cached across the pull and the acknowledge.
      expect(serviceAccountExchanges).toBe(1);
      expect(lifecycleErrors).toEqual([]);
      expectNoSecrets(
        [logs.calls, seen.map((request) => request.url)],
        [key.pem, REFRESH_TOKEN, CLIENT_SECRET, "gmail-user-access", "pubsub-service-access"],
      );
    } catch (error) {
      primary = { error };
    }
    // Both run on `runtime`, so they stop before it ends.
    const [stopping, rooted] = [dispatcher, root];
    dispatcher = undefined;
    root = undefined;
    await settleAll(primary, [() => stopping?.stop(), () => rooted?.stop(), () => runtime.end()]);
  });

  it("with the Gmail OAuth client but no Pub/Sub keys logs one lifecycle warning, without the client logs none, and keeps Gmail accounts on the noop lifecycle", async () => {
    stubProviders({});
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(
      await resolveGmailWatchHosting(pool, { GMAIL_OAUTH_CLIENT_ID: "id", GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET }),
    ).toBeNull();
    expect(warning.mock.calls).toEqual([
      [
        { reason: "missing GMAIL_PUBSUB_TOPIC, GMAIL_PUBSUB_SUBSCRIPTION, GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH" },
        "Gmail watch lifecycles are not hosted; Gmail accounts are synced by the periodic sweep",
      ],
    ]);
    expectNoSecrets(warning.mock.calls, [CLIENT_SECRET]);
    // Without the OAuth client the mail sync adapters own the provider warning; the lifecycle adds none.
    warning.mockClear();
    for (const env of [{}, pubSubEnv("/x")]) expect(await resolveGmailWatchHosting(pool, env)).toBeNull();
    expect(warning).not.toHaveBeenCalled();

    root = composeRoot({});
    const gmailId = await insertMailbox("gmail");
    await root.start();
    expect(await syncJobsFor(gmailId)).toBe(1);
    expect(lifecycleErrors).toEqual([]);
  });

  it("reads the configuration's formats and key file, naming the key and a fixed category, never a value", async () => {
    const directory = ownDirectory();
    const key = await writeServiceAccountKey(directory);
    const complete = pubSubEnv(key.path);
    const garbage = await writeKeyFile(directory, "garbage.json", "secret-garbage");
    const publicOnly = await writeKeyFile(
      directory,
      "public.json",
      generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
    const ecKey = await writeKeyFile(
      directory,
      "ec.json",
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const notJson = join(directory, "not-json.json");
    await writeFile(notJson, "secret-garbage");
    const notAKey = "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is not a service account key";
    const invalidPath = "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is not a valid path";
    const missing = "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH does not exist";
    const cases: [Record<string, string>, string][] = [
      [
        { ...complete, GMAIL_PUBSUB_TOPIC: "topics/gmail" },
        "GMAIL_PUBSUB_TOPIC is not projects/<project>/topics/<topic>",
      ],
      [
        { ...complete, GMAIL_PUBSUB_SUBSCRIPTION: TOPIC },
        "GMAIL_PUBSUB_SUBSCRIPTION is not projects/<project>/subscriptions/<subscription>",
      ],
      [pubSubEnv(join(directory, "absent.json")), missing],
      [pubSubEnv(join(key.path, "beneath-a-file.json")), missing],
      [pubSubEnv(directory), "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is a directory"],
      [pubSubEnv("key\0.json"), invalidPath],
      [pubSubEnv(join(directory, "k".repeat(300))), invalidPath],
      [pubSubEnv(notJson), notAKey],
      [pubSubEnv(garbage), notAKey],
      [pubSubEnv(publicOnly), notAKey],
      [pubSubEnv(ecKey), notAKey],
      [{ ...complete, GMAIL_PUBSUB_TOPIC: "" }, "missing GMAIL_PUBSUB_TOPIC"],
    ];
    for (const [env, reason] of cases) {
      expect(await loadGmailPubSubConfig(env)).toEqual({ config: null, reason });
    }
    const loaded = await loadGmailPubSubConfig(complete);
    expect(loaded.config).toMatchObject({ topicName: TOPIC, subscriptionName: SUBSCRIPTION });
  });

  it("maps a denied or forbidden key read to a fixed reason without the path, and propagates any other read failure as the same error", async () => {
    // Through the armed read fault: a permission bit does not deny a root user, as CI may run.
    const keyPath = join(ownDirectory(), "key.json");
    for (const code of ["EACCES", "EPERM"]) {
      fsFault.readFile = Object.assign(new Error(`${code}: synthetic, open '${keyPath}'`), {
        code,
        syscall: "open",
        path: keyPath,
      });
      const result = await loadGmailPubSubConfig(pubSubEnv(keyPath));
      expect(result).toEqual({ config: null, reason: "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is not readable" });
      expect(JSON.stringify(result)).not.toContain(keyPath);
    }
    // ELOOP is not a configuration category; neither is a missing or non-string code.
    for (const fault of [
      Object.assign(new Error("ELOOP: synthetic"), { code: "ELOOP" }),
      new Error("synthetic read failure"),
      Object.assign(new Error("synthetic code"), { code: 13 }),
    ]) {
      fsFault.readFile = fault;
      expect(await rejectionOf(loadGmailPubSubConfig(pubSubEnv(keyPath)))).toBe(fault);
    }
  });

  it("propagates an encrypted key's missing-passphrase decode error as it is, not as a configuration reason", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "synthetic-passphrase" },
    });
    const path = await writeKeyFile(ownDirectory(), "encrypted.json", privateKey);
    decodeFailures.length = 0;
    const failure = await rejectionOf(loadGmailPubSubConfig(pubSubEnv(path)));
    // The very error the real decode threw, not a wrapper.
    expect(decodeFailures).toHaveLength(1);
    expect(failure).toBe(decodeFailures[0]);
    // A decoder code outside the one the owner maps (`ERR_OSSL_UNSUPPORTED`), whichever code this host's OpenSSL gives.
    const code: unknown = failure instanceof Error ? Reflect.get(failure, "code") : undefined;
    expect(typeof code).toBe("string");
    expect(code).not.toBe("ERR_OSSL_UNSUPPORTED");
    expect(String(failure)).not.toContain(privateKey.slice(40, 80));
  });

  it("fails a held fetch, a held body read and a held cancellation at the shared deadline, and caches no failure", async () => {
    const { config } = await loadConfig();
    // Controlled here instead of 15 real seconds.
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
    const held = { fetch: false, read: false, cancel: false };
    const good = () => new Response(JSON.stringify({ access_token: "pubsub-token-good", expires_in: 30 }));
    const answers: ((request: Request) => Response | Promise<Response>)[] = [
      (request) => providers.heldFetch(request, () => void (held.fetch = true)),
      good,
      () => providers.heldStream({ onPull: () => void (held.read = true) }),
      good,
      () => providers.heldStream({ onCancel: () => void (held.cancel = true), status: 500 }),
      good,
    ];
    const counter = stubTokenAnswers(answers);
    const owner = (what: string) => providers.owner(() => config.getPubSubAccessToken(), what);
    const goodToken = async () => expect(await owner("A later token request")).toEqual({ token: "pubsub-token-good" });
    const aggregateOf = (outcome: OwnerOutcome): AggregateError => {
      if (!("error" in outcome) || !(outcome.error instanceof AggregateError))
        throw new Error("expected an AggregateError");
      return outcome.error;
    };
    let primary: { error: unknown } | undefined;
    try {
      const fetching = owner("The owner of the held fetch");
      await waitFor(async () => held.fetch);
      const fetchReason = expire(0);
      const fetchFailed = await fetching;
      expect("error" in fetchFailed && fetchFailed.error).toBe(fetchReason);
      await goodToken();

      const reading = owner("The owner of the held body read");
      await waitFor(async () => held.read);
      const readReason = expire(2);
      const readFailed = aggregateOf(await reading);
      expect(readFailed.errors[0]).toBe(readReason);
      expect(readFailed.errors[1]).toEqual(new Error("The Pub/Sub token response was not settled before its deadline"));
      expect(readFailed.cause).toBe(readReason);
      await goodToken();

      const cancelling = owner("The owner of the held cancellation");
      await waitFor(async () => held.cancel);
      expire(4);
      const cancelFailed = aggregateOf(await cancelling);
      expect(cancelFailed.errors).toEqual([
        new Error("The Pub/Sub token request failed with status 500"),
        new Error("The Pub/Sub token response's cancellation did not settle before its deadline"),
      ]);
      expect(cancelFailed.cause).toBe(cancelFailed.errors[0]);
      // No failure was cached.
      await goodToken();
      expect(counter.exchanges).toBe(answers.length);
      expect(deadlines.map((deadline) => deadline.ms)).toEqual(answers.map(() => 15_000));
    } catch (error) {
      primary = { error };
    }
    await settleAll(primary, [() => providers.release()]);
  });

  it("settles every failed token response, keeps its own failure first, and caches no failure", async () => {
    const { config } = await loadConfig();
    const cancelled: string[] = [];
    const readFailure = new Error("synthetic socket reset");
    const cancelFailure = new Error("synthetic cancel failure");
    const releaseFailure = new Error("synthetic release failure");

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
    const oversized = Array.from({ length: 4 }, () => "x".repeat(40 * 1024));
    const status500 = new Error("The Pub/Sub token request failed with status 500");
    const sizeCap = new Error("The Pub/Sub token response exceeded its size cap");
    const notAToken = new Error("The Pub/Sub token response is not a token");
    // Each failing answer, with the errors it rejects with: one error alone, several as an AggregateError.
    const failures: [() => Response, unknown[]][] = [
      [
        () => new Response(body(['{"error":"backend","access_token":"leaked-token"}']), { status: 503 }),
        [new Error("The Pub/Sub token request failed with status 503")],
      ],
      [() => new Response(body(["{}"], { cancelFails: true }), { status: 500 }), [status500, cancelFailure]],
      [() => new Response(body(oversized)), [sizeCap]],
      [() => new Response(body(oversized, { cancelFails: true })), [sizeCap, cancelFailure]],
      [() => new Response(body(['{"access_token":'], { fail: readFailure })), [readFailure]],
      [() => new Response(body(["not json: leaked-token"])), [notAToken]],
      [() => new Response(body([JSON.stringify({ token: "leaked-token" })])), [notAToken]],
      // An unsettled response's token is not cached.
      [
        () => unreleasable(JSON.stringify({ access_token: "pubsub-token-unsettled", expires_in: 3600 })),
        [new Error("The Pub/Sub token response could not be settled"), releaseFailure],
      ],
    ];
    const good = () => new Response(JSON.stringify({ access_token: "pubsub-token-good", expires_in: 30 }));
    const counter = stubTokenAnswers(failures.flatMap(([answer]) => [answer, good]));
    const outcomes: unknown[] = [];
    for (const [, errors] of failures) {
      const outcome = await outcomeOf(config.getPubSubAccessToken());
      if (!("error" in outcome)) throw new Error(`expected a failure, got a token`);
      outcomes.push(outcome.error);
      const [primary] = errors;
      if (errors.length === 1) {
        expect(outcome.error).toEqual(primary);
        if (primary === readFailure) expect(outcome.error).toBe(readFailure);
      } else {
        if (!(outcome.error instanceof AggregateError)) throw new Error("expected an AggregateError");
        expect(outcome.error.errors).toEqual(errors);
        expect(outcome.error.message).toBe((primary as Error).message);
        expect(outcome.error.cause).toBe(outcome.error.errors[0]);
      }
      expect(await config.getPubSubAccessToken()).toBe("pubsub-token-good");
    }
    expect(counter.exchanges).toBe(failures.length * 2);
    expect(cancelled).toEqual(["cancel", "cancel", "cancel", "cancel"]);
    expectNoSecrets(outcomes, ["leaked-token"]);
  });

  it("caches the service-account token until shortly before it expires, retries after a failure, and leaks neither key nor token", async () => {
    const key = await writeServiceAccountKey(ownDirectory());
    const answers: (() => Response)[] = [
      () => Response.json({ error: "backend_error", access_token: "leaked-in-error-body" }, { status: 500 }),
      () => Response.json({ access_token: "pubsub-token-1", expires_in: 3600 }),
      () => Response.json({ access_token: "pubsub-token-short", expires_in: 30 }),
      () => Response.json({ access_token: "pubsub-token-2", expires_in: 30 }),
    ];
    const counter = stubTokenAnswers(
      answers.map((answer) => async (request: Request) => {
        const claims = assertionClaimsSchema.safeParse(
          verifiedAssertionClaims((await formOf(request)).get("assertion") ?? "", key.publicKey),
        );
        if (!claims.success) return Response.json({ error: "invalid_grant" }, { status: 400 });
        expect(claims.data.exp - claims.data.iat).toBe(3600);
        return answer();
      }),
    );
    const first = await loadGmailPubSubConfig(pubSubEnv(key.path));
    if (!first.config) throw new Error(first.reason);
    const failure = await rejectionOf(first.config.getPubSubAccessToken());
    expect(failure).toEqual(new Error("The Pub/Sub token request failed with status 500"));
    expect(await first.config.getPubSubAccessToken()).toBe("pubsub-token-1");
    expect(await first.config.getPubSubAccessToken()).toBe("pubsub-token-1");
    expect(counter.exchanges).toBe(2);

    // A token living less than the refresh margin is replaced on the next call.
    const second = await loadGmailPubSubConfig(pubSubEnv(key.path));
    if (!second.config) throw new Error(second.reason);
    expect(await second.config.getPubSubAccessToken()).toBe("pubsub-token-short");
    expect(await second.config.getPubSubAccessToken()).toBe("pubsub-token-2");
    expect(counter.exchanges).toBe(4);
    expect(JSON.stringify(failure)).not.toContain("leaked-in-error-body");
    expect(String(failure)).not.toContain(key.pem.slice(40, 80));
  });
});

function hostedGraph() {
  const graph = resolveGraphSubscriptionHosting(pool, GRAPH_ENV, "https://semprec.example");
  if (!graph) throw new Error("expected the Graph lifecycle to be hosted");
  return graph;
}

const graphTokenRoute = {
  [`POST ${MICROSOFT_TOKEN}`]: () => Response.json({ access_token: "graph-user-access", expires_in: 3600 }),
};

describe("Microsoft Graph subscription lifecycles", () => {
  const client = { clientId: "id", clientSecret: "secret" };

  it.each([
    ["https://semprec.example", "https://semprec.example/api/mail/graph/webhook"],
    ["https://semprec.example/", "https://semprec.example/api/mail/graph/webhook"],
    ["https://semprec.example:8443", "https://semprec.example:8443/api/mail/graph/webhook"],
  ])("hosts Graph for the plain https origin %s", (appBaseUrl, notificationUrl) => {
    expect(decideGraphSubscriptionHosting(appBaseUrl, client)).toEqual({ hosted: true, notificationUrl, client });
  });

  it.each([
    "http://localhost:3000",
    "https://semprec.example/app",
    "https://semprec.example?x=1",
    "https://user@semprec.example",
    "not a url",
    "https://",
    // URL parsing turns a backslash into a path separator, so each would lose its path.
    "https://semprec.example\\app",
    "https://semprec.example\\",
    "https://semprec.example\\?x=1",
    "https://semprec.example:8443\\app",
    "https://semprec.example:99999",
  ])("does not host Graph for APP_BASE_URL %s", (appBaseUrl) => {
    expect(decideGraphSubscriptionHosting(appBaseUrl, client)).toEqual({
      hosted: false,
      reason: "APP_BASE_URL is not an https:// origin without a path",
    });
  });

  it("does not host Graph without its OAuth client, naming the missing keys", () => {
    expect(
      decideGraphSubscriptionHosting("https://semprec.example", { missingEnv: ["MS_GRAPH_OAUTH_CLIENT_SECRET"] }),
    ).toEqual({ hosted: false, reason: "missing MS_GRAPH_OAUTH_CLIENT_SECRET" });
  });

  it("creates a subscription at the deployment's webhook, a notification enqueues a sync, and a restart re-registers after a 404", async () => {
    const logs = captureServiceLogs();
    const created: { notificationUrl: string; clientState: string }[] = [];
    const renewals: string[] = [];
    let renewStatus = 404;
    const seen = stubProviders({
      [`POST ${MICROSOFT_TOKEN}`]: async (request) => {
        expect((await formOf(request)).get("client_secret")).toBe(CLIENT_SECRET);
        return Response.json({ access_token: "graph-user-access", expires_in: 3600, refresh_token: REFRESH_TOKEN });
      },
      [`POST ${GRAPH_SUBSCRIPTIONS}`]: async (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer graph-user-access");
        created.push(z.object({ notificationUrl: z.string(), clientState: z.string() }).parse(await request.json()));
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
    const graph = hostedGraph();
    const mailboxId = await insertGraphMailbox();
    const subscribed = (id: string) =>
      waitFor(async () => (await syncStateOf(mailboxId))?.graph_subscription_id === id);

    root = composeRoot({ graph_api: graph });
    await root.start();
    await subscribed("sub-1");
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

    // Graph no longer has the persisted subscription, so the restart registers a new one.
    root = composeRoot({ graph_api: graph });
    await root.start();
    await subscribed("sub-2");
    expect(renewals).toEqual([`${GRAPH_SUBSCRIPTIONS}/sub-1`]);
    await root.stop();

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
    expectNoSecrets(logs.calls, [REFRESH_TOKEN, CLIENT_SECRET, "graph-user-access"]);
  });

  it("logs a failed subscription create by its error name only", async () => {
    const logs = captureServiceLogs();
    stubProviders({
      ...graphTokenRoute,
      [`POST ${GRAPH_SUBSCRIPTIONS}`]: () =>
        Response.json({ error: { message: "graph-user-access" } }, { status: 500 }),
    });
    const mailboxId = await insertGraphMailbox();
    root = composeRoot({ graph_api: hostedGraph() });
    await root.start();
    const failed = () => logs.calls.filter((call) => call[2] === "Graph subscription lifecycle failed");
    await waitFor(async () => failed().length > 0);
    expect(failed()).toEqual([
      [
        "warn",
        { mailboxItemId: mailboxId, phase: "subscription", errorName: "Error" },
        "Graph subscription lifecycle failed",
      ],
    ]);
    expectNoSecrets(logs.calls, [REFRESH_TOKEN, CLIENT_SECRET, "graph-user-access"]);
  });

  const notHostedWarning = [
    { reason: "APP_BASE_URL is not an https:// origin without a path" },
    "Graph subscription lifecycles are not hosted; Graph accounts are synced by the periodic sweep",
  ];
  it.each([
    ["the OAuth client and an http APP_BASE_URL", GRAPH_ENV, "http://localhost:3000", [notHostedWarning]],
    ["the OAuth client and a path-bearing APP_BASE_URL", GRAPH_ENV, "https://semprec.example/app", [notHostedWarning]],
    // The mail sync adapters own this provider's startup warning.
    ["no OAuth client", {}, "https://semprec.example", []],
  ])(
    "with %s, hosts nothing, logs only the lifecycle's own warning and keeps Graph accounts on the noop lifecycle",
    async (_name, env, appBaseUrl, warnings) => {
      stubProviders({});
      const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      expect(resolveGraphSubscriptionHosting(pool, env, appBaseUrl)).toBeNull();
      expect(warning.mock.calls).toEqual(warnings);
      root = composeRoot({});
      const mailboxId = await insertGraphMailbox();
      await root.start();
      expect(await syncJobsFor(mailboxId)).toBe(1);
    },
  );

  it("leaves the other sync modes as they were when Graph is hosted", async () => {
    stubProviders({
      ...graphTokenRoute,
      [`POST ${GRAPH_SUBSCRIPTIONS}`]: () =>
        Response.json({ id: "sub-only", expirationDateTime: new Date(Date.now() + 3600_000).toISOString() }),
    });
    const fake = createFakeIdleTransport();
    root = composeRoot({ imap: imapIdleOver(fake.transport), graph_api: hostedGraph() });
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
