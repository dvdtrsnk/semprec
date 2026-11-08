import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES } from "@semprec/queue";
import {
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
  resolveGmailWatchHosting,
  type MailLiveSyncLifecycleDispatchOptions,
} from "../mailLiveSyncLifecycles.js";
import { loadGmailPubSubConfig } from "../gmailPubSubConfig.js";
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

// ---------------------------------------------------------------------------------------------
// Gmail watch (issue #1739) and Microsoft Graph subscription (issue #1745) hosting
// ---------------------------------------------------------------------------------------------

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GMAIL_WATCH = "https://gmail.googleapis.com/gmail/v1/users/me/watch";
const TOPIC = "projects/semprec-test/topics/gmail";
const SUBSCRIPTION = "projects/semprec-test/subscriptions/gmail-push";
const PUBSUB_PULL = `https://pubsub.googleapis.com/v1/${SUBSCRIPTION}:pull`;
const PUBSUB_ACK = `https://pubsub.googleapis.com/v1/${SUBSCRIPTION}:acknowledge`;
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
async function insertGmailMailbox(tenantId: string, verifiedAddress: string, claimedAddress?: string): Promise<string> {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
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
  let directory: string;
  let dispatcher: { stop(): Promise<void> } | undefined;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    await createTenantZeroUser(pool);
    lifecycleErrors = [];
    root = undefined;
    dispatcher = undefined;
    directory = await mkdtemp(join(tmpdir(), "semprec-gmail-pubsub-"));
  });

  afterEach(async () => {
    await dispatcher?.stop();
    await root?.stop();
    root = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // This test's own key directory.
    await rm(directory, { recursive: true, force: true });
  });

  it("routes a notification for a watched, provider-verified address to one sync per mailbox, never by Mailboxes.addresses", async () => {
    const key = await writeServiceAccountKey(directory);
    const logs = captureServiceLogs();
    const otherTenant = await createTestTenant(pool);
    await runInTenant(otherTenant, () => seedSystem(pool));
    const first = await insertGmailMailbox(getTenantZeroId(), "Verified@Example.com", "claimed@example.com");
    const second = await insertGmailMailbox(otherTenant, "verified@example.com");
    const pending = [
      pubSubMessage("ack-verified", "verified@example.com"),
      pubSubMessage("ack-claimed", "claimed@example.com"),
    ];
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

    const hosting = await resolveGmailWatchHosting(pool, {
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: key.path,
      GMAIL_OAUTH_CLIENT_ID: "synthetic-client-id",
      GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    });
    if (!hosting) throw new Error("expected the Gmail watch lifecycle to be hosted");
    root = composeRoot({ gmail_api: hosting.lifecycle });
    await root.start();
    await waitFor(async () =>
      (await Promise.all([first, second].map(syncStateOf))).every(
        (state) => state?.gmail_watch_email_address === "verified@example.com",
      ),
    );
    await clearSyncJobsFor(first);
    await clearSyncJobsFor(second);

    const running = createGmailPubSubDispatcherFor(pool, hosting);
    dispatcher = running;
    await running.start();
    await waitFor(async () => acknowledged.length === 1);

    expect(acknowledged).toEqual([["ack-verified", "ack-claimed"]]);
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
  });

  it("with the Pub/Sub keys or the Gmail OAuth client missing, logs one warning and keeps Gmail accounts on the noop lifecycle", async () => {
    stubProviders({});
    for (const env of [
      { GMAIL_OAUTH_CLIENT_ID: "id", GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      {
        GMAIL_PUBSUB_TOPIC: TOPIC,
        GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
        GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: "/x",
      },
    ]) {
      const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      expect(await resolveGmailWatchHosting(pool, env)).toBeNull();
      expect(warning).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warning.mock.calls)).not.toContain(CLIENT_SECRET);
      warning.mockRestore();
    }
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(await resolveGmailWatchHosting(pool, {})).toBeNull();
    expect(warning.mock.calls).toEqual([
      [
        {
          reasons: [
            "missing GMAIL_PUBSUB_TOPIC, GMAIL_PUBSUB_SUBSCRIPTION, GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH",
            "missing GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET",
          ],
        },
        "Gmail watch lifecycles are not hosted; Gmail accounts are synced by the periodic sweep",
      ],
    ]);

    root = composeRoot({});
    const gmailId = await insertMailbox("gmail");
    await root.start();
    expect(await syncJobsFor(gmailId)).toBe(1);
    expect(lifecycleErrors).toEqual([]);
  });

  it("reads the configuration's formats and key file, naming the key that is wrong and never its value", async () => {
    const key = await writeServiceAccountKey(directory);
    const complete = {
      GMAIL_PUBSUB_TOPIC: TOPIC,
      GMAIL_PUBSUB_SUBSCRIPTION: SUBSCRIPTION,
      GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: key.path,
    };
    const notAKey = join(directory, "not-a-key.json");
    await writeFile(
      notAKey,
      JSON.stringify({ type: "service_account", client_email: SERVICE_ACCOUNT_EMAIL, private_key: "secret-garbage" }),
    );
    const cases: [Record<string, string>, string][] = [
      [
        { ...complete, GMAIL_PUBSUB_TOPIC: "topics/gmail" },
        "GMAIL_PUBSUB_TOPIC is not projects/<project>/topics/<topic>",
      ],
      [
        { ...complete, GMAIL_PUBSUB_SUBSCRIPTION: TOPIC },
        "GMAIL_PUBSUB_SUBSCRIPTION is not projects/<project>/subscriptions/<subscription>",
      ],
      [
        { ...complete, GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: join(directory, "absent.json") },
        "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH cannot be read (ENOENT)",
      ],
      [
        { ...complete, GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH: notAKey },
        "GMAIL_PUBSUB_SERVICE_ACCOUNT_KEY_PATH is not a service account key",
      ],
      [{ ...complete, GMAIL_PUBSUB_TOPIC: "" }, "missing GMAIL_PUBSUB_TOPIC"],
    ];
    for (const [env, reason] of cases) {
      expect(await loadGmailPubSubConfig(env)).toEqual({ config: null, reason });
    }
    const loaded = await loadGmailPubSubConfig(complete);
    expect(loaded.config).toMatchObject({ topicName: TOPIC, subscriptionName: SUBSCRIPTION });
  });

  it("caches the service-account token until shortly before it expires, retries after a failure, and leaks neither key nor token", async () => {
    const key = await writeServiceAccountKey(directory);
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
