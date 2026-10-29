import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { MailServerEndpoint, MailSyncAdapterFactory } from "@semprec/data";
import {
  createTenantZeroUser,
  ensureMailAccountSyncState,
  getTestPool,
  inTenantZero,
  resetDatabase,
  storeCredential,
  stubDnsLookup,
  type DnsLookupStub,
} from "@semprec/data/testSupport";
import { allowLoopbackOutboundForTests } from "@semprec/data/testSupport/mcpContractServers";
import {
  createChokePoint,
  createItemWithClient,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  MailConnectionLimitError,
  MailReauthorizationRequiredError,
  MailServerUnreachableError,
  seedSystem,
  upsertMailServerSettings,
  withTransaction,
} from "@semprec/data";
import { createApiQueueRuntime, type ApiQueueRuntime } from "../queueRuntime.js";
import { createMailSyncAdapters } from "../mailSyncAdapters.js";
import { logger } from "../logger.js";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_API_PREFIX = "https://gmail.googleapis.com/gmail/v1/users/me";
const GOOGLE_HOSTS = ["https://oauth2.googleapis.com/", "https://gmail.googleapis.com/"];
const GMAIL_CLIENT_ID = "test-gmail-client-id.example";
const GMAIL_CLIENT_SECRET = "test-gmail-client-secret-value";
const GMAIL_MISSING_BOTH = ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET"];
const STORED_REFRESH_TOKEN = "1//stored-refresh-token-value";
/** Passed to `createGmailClient` as the job's decrypted credential; it must never be presented to Google. */
const STALE_JOB_CREDENTIAL = "stale-credential-decrypted-by-the-job";
const T0 = new Date("2026-10-29T10:00:00.000Z");
const ONE_HOUR_MS = 3_600_000;

const MICROSOFT_TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_API_PREFIX = "https://graph.microsoft.com/v1.0/me";
const MICROSOFT_HOSTS = ["https://login.microsoftonline.com/", "https://graph.microsoft.com/"];
const GRAPH_CLIENT_ID = "test-graph-client-id.example";
const GRAPH_CLIENT_SECRET = "test-graph-client-secret-value";
const GRAPH_MISSING_BOTH = ["MS_GRAPH_OAUTH_CLIENT_ID", "MS_GRAPH_OAUTH_CLIENT_SECRET"];
const STORED_MICROSOFT_REFRESH_TOKEN = "0.stored-refresh-token-value";
const GRAPH_INBOX_ID = "AAMk-inbox";
/** The delta links the fake Graph API hands out: the first pass ends at DELTA_LINK_1, the next one at DELTA_LINK_2. */
const DELTA_LINK_1 = `${GRAPH_API_PREFIX}/messages/delta?$deltatoken=delta-1`;
const DELTA_LINK_2 = `${GRAPH_API_PREFIX}/messages/delta?$deltatoken=delta-2`;

interface FakeGoogleOptions {
  /** 401 makes the token endpoint reject the stored refresh token, as Google does for a revoked one. */
  tokenStatus?: 200 | 401;
  /** Lifetime of each access token the token endpoint issues, in seconds. */
  expiresIn?: number;
}

interface FakeGoogleCalls {
  /** Refresh tokens presented to the token endpoint, in order. */
  presentedRefreshTokens: string[];
  /** The `Authorization` header of each Gmail API request, in order. */
  authorizations: string[];
  /** The Gmail API route of each request (path and query, without the API prefix), in order. */
  gmailRoutes: string[];
}

interface FakeGoogle {
  fetchImpl: typeof fetch;
  calls: FakeGoogleCalls;
}

const FAKE_MESSAGES = [
  { id: "m-1", subject: "First message" },
  { id: "m-2", subject: "Second message" },
];

function gmailMessage(message: { id: string; subject: string }): unknown {
  return {
    id: message.id,
    threadId: `thread-${message.id}`,
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Message-ID", value: `<${message.id}@gmail.example.test>` },
        { name: "From", value: "Ada <ada@example.test>" },
        { name: "To", value: "owner@example.test" },
        { name: "Subject", value: message.subject },
        { name: "Date", value: "Mon, 05 Oct 2026 10:00:00 +0000" },
      ],
      body: { size: 12, data: Buffer.from(`Body of ${message.id}`).toString("base64url") },
    },
  };
}

/** The absolute URL a `fetch` input names. The code under test only ever passes a string. */
function hrefOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * A fake Google token endpoint and Gmail REST API for one mailbox with two messages and historyId
 * "5000". Any other request to Google fails the test, so an unexpected call cannot pass silently.
 */
function createFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  const calls: FakeGoogleCalls = { presentedRefreshTokens: [], authorizations: [], gmailRoutes: [] };
  let issued = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = hrefOf(input);
    if (href === GOOGLE_TOKEN_ENDPOINT) {
      const body = init?.body;
      calls.presentedRefreshTokens.push(body instanceof URLSearchParams ? (body.get("refresh_token") ?? "") : "");
      if (options.tokenStatus === 401) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
      issued += 1;
      return Response.json({
        access_token: `ya29.access-${issued}`,
        expires_in: options.expiresIn ?? 3600,
        token_type: "Bearer",
      });
    }
    if (href.startsWith(GMAIL_API_PREFIX)) {
      const route = href.slice(GMAIL_API_PREFIX.length);
      calls.gmailRoutes.push(route);
      calls.authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (route === "/profile") return Response.json({ historyId: "5000" });
      if (route === "/labels") return Response.json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }] });
      if (route === "/messages?maxResults=500")
        return Response.json({ messages: FAKE_MESSAGES.map(({ id }) => ({ id })) });
      const fetched = FAKE_MESSAGES.find((message) => route === `/messages/${message.id}?format=full`);
      if (fetched) return Response.json(gmailMessage(fetched));
      return new Response("not found", { status: 404 });
    }
    throw new Error(`fake Google received an unexpected request to ${href}`);
  };
  return { fetchImpl, calls };
}

interface FakeMicrosoftOptions {
  /** Every refresh is rejected with 400 `invalid_grant`, as Microsoft answers a revoked refresh token. */
  revoked?: boolean;
  /** Each refresh rotates the refresh token, as Microsoft does: the presented token is retired and a new one returned. */
  rotates?: boolean;
}

interface FakeMicrosoftCalls {
  /** Refresh tokens presented to the token endpoint, in order. */
  presentedRefreshTokens: string[];
  /** Whether each token request carried a `scope` parameter, in order. */
  scopeParameters: boolean[];
  /** The `Authorization` header of each Graph request, in order. */
  authorizations: string[];
  /** The Graph route of each request (path and query, without the API prefix), in order. */
  graphRoutes: string[];
}

interface FakeMicrosoft {
  fetchImpl: typeof fetch;
  calls: FakeMicrosoftCalls;
}

const GRAPH_MESSAGES = [
  { id: "g-1", subject: "First Graph message" },
  { id: "g-2", subject: "Second Graph message" },
];

function graphMessage(message: { id: string; subject: string }): unknown {
  return {
    id: message.id,
    parentFolderId: GRAPH_INBOX_ID,
    internetMessageId: `<${message.id}@graph.example.test>`,
    subject: message.subject,
    from: { emailAddress: { name: "Ada", address: "ada@example.test" } },
    toRecipients: [{ emailAddress: { name: "Owner", address: "owner@example.test" } }],
    receivedDateTime: "2026-10-05T10:00:00Z",
    body: { contentType: "text", content: `Body of ${message.id}` },
    bodyPreview: `Body of ${message.id}`,
    internetMessageHeaders: [],
    hasAttachments: false,
    isRead: false,
    flag: { flagStatus: "notFlagged" },
  };
}

/**
 * A fake Microsoft token endpoint and Graph API for one mailbox: an inbox with two messages and a
 * delta link that moves from DELTA_LINK_1 to DELTA_LINK_2 on the next pass. The token endpoint accepts
 * only the refresh token that is currently valid, so a client that presents a retired one is rejected.
 * Any other request fails the test, so an unexpected call cannot pass silently.
 */
function createFakeMicrosoft(options: FakeMicrosoftOptions = {}): FakeMicrosoft {
  const calls: FakeMicrosoftCalls = {
    presentedRefreshTokens: [],
    scopeParameters: [],
    authorizations: [],
    graphRoutes: [],
  };
  let validRefreshToken = STORED_MICROSOFT_REFRESH_TOKEN;
  let issuedAccessTokens = 0;
  let issuedRefreshTokens = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = hrefOf(input);
    if (href === MICROSOFT_TOKEN_ENDPOINT) {
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
      const presented = body.get("refresh_token") ?? "";
      calls.presentedRefreshTokens.push(presented);
      calls.scopeParameters.push(body.has("scope"));
      if (options.revoked || presented !== validRefreshToken) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      issuedAccessTokens += 1;
      const issued: { access_token: string; expires_in: number; token_type: string; refresh_token?: string } = {
        access_token: `eyJ-access-${issuedAccessTokens}`,
        expires_in: 3600,
        token_type: "Bearer",
      };
      if (options.rotates) {
        issuedRefreshTokens += 1;
        validRefreshToken = `0.ROTATED-${issuedRefreshTokens}`;
        issued.refresh_token = validRefreshToken;
      }
      return Response.json(issued);
    }
    if (href.startsWith(GRAPH_API_PREFIX)) {
      const route = href.slice(GRAPH_API_PREFIX.length);
      calls.graphRoutes.push(route);
      calls.authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
      if (route === "/mailFolders/inbox") return Response.json({ id: GRAPH_INBOX_ID, displayName: "Inbox" });
      if (route === "/mailFolders?$top=999&$select=id,displayName,childFolderCount")
        return Response.json({ value: [{ id: GRAPH_INBOX_ID, displayName: "Inbox", childFolderCount: 0 }] });
      if (route.startsWith("/messages/delta?$select="))
        return Response.json({ value: GRAPH_MESSAGES.map(graphMessage), "@odata.deltaLink": DELTA_LINK_1 });
      if (href === DELTA_LINK_1) return Response.json({ value: [], "@odata.deltaLink": DELTA_LINK_2 });
      // Every well-known folder other than the inbox does not exist in this mailbox.
      if (route.startsWith("/mailFolders/")) return new Response("not found", { status: 404 });
    }
    throw new Error(`fake Microsoft received an unexpected request to ${href}`);
  };
  return { fetchImpl, calls };
}

type GmailClientFactory = NonNullable<MailSyncAdapterFactory["createGmailClient"]>;
type GraphClientFactory = NonNullable<MailSyncAdapterFactory["createGraphClient"]>;

/** The Gmail client factory the wiring returns; a test fails here if the factory has none. */
function gmailClientFactory(adapters: MailSyncAdapterFactory): GmailClientFactory {
  const create = adapters.createGmailClient;
  if (!create) throw new Error("expected createMailSyncAdapters to provide a Gmail client factory");
  return create;
}

/** The Graph client factory the wiring returns; a test fails here if the factory has none. */
function graphClientFactory(adapters: MailSyncAdapterFactory): GraphClientFactory {
  const create = adapters.createGraphClient;
  if (!create) throw new Error("expected createMailSyncAdapters to provide a Graph client factory");
  return create;
}

async function rejectionOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error("expected the promise to reject");
}

/** Polls `check` until it returns `true` or `timeoutMs` elapses, then fails via the final assertion. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  expect(await check()).toBe(true);
}

/** Sets a process environment variable, or removes it when `value` is undefined. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

let pool: Pool;

// File-level: every describe shares this pool, so ending it in one describe's afterAll would break the others.
afterAll(async () => {
  await pool?.end();
});

/** A Mailbox item with its stored refresh token and a sync-state row for `syncMode`, in tenant zero. */
async function createMailbox(input: {
  name: string;
  provider: "gmail" | "outlook";
  syncMode: "gmail_api" | "graph_api";
  refreshToken: string;
}): Promise<string> {
  return inTenantZero(() =>
    withTransaction(pool, async (client) => {
      const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
      if (!mailboxes) throw new Error("fixture: no mailboxes database is seeded");
      const item = await createItemWithClient(client, {
        databaseId: mailboxes.id,
        properties: { name: input.name, provider: input.provider },
      });
      await storeCredential(client, {
        itemId: item.id,
        credentialType: "oauth2_refresh_token",
        plaintext: input.refreshToken,
      });
      await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: input.syncMode });
      return item.id;
    }),
  );
}

function createGmailMailbox(name: string): Promise<string> {
  return createMailbox({ name, provider: "gmail", syncMode: "gmail_api", refreshToken: STORED_REFRESH_TOKEN });
}

function createGraphMailbox(name: string): Promise<string> {
  return createMailbox({
    name,
    provider: "outlook",
    syncMode: "graph_api",
    refreshToken: STORED_MICROSOFT_REFRESH_TOKEN,
  });
}

describe("createMailSyncAdapters (issues #1505, #1508)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    {
      case: "the client id is unset",
      env: { GMAIL_OAUTH_CLIENT_SECRET: GMAIL_CLIENT_SECRET },
      missingEnv: ["GMAIL_OAUTH_CLIENT_ID"],
    },
    {
      case: "the client id is empty, as in api.env.example",
      env: { GMAIL_OAUTH_CLIENT_ID: "", GMAIL_OAUTH_CLIENT_SECRET: GMAIL_CLIENT_SECRET },
      missingEnv: ["GMAIL_OAUTH_CLIENT_ID"],
    },
    {
      case: "the client secret is unset",
      env: { GMAIL_OAUTH_CLIENT_ID: GMAIL_CLIENT_ID },
      missingEnv: ["GMAIL_OAUTH_CLIENT_SECRET"],
    },
    { case: "both are unset", env: {}, missingEnv: GMAIL_MISSING_BOTH },
  ])("has no Gmail client and logs one warning naming the missing keys when $case", ({ env, missingEnv }) => {
    const warn = vi.spyOn(logger, "warn");

    const adapters = createMailSyncAdapters({ pool, env });

    expect(adapters.createGmailClient).toBeUndefined();
    const warnings = warn.mock.calls.filter(([, message]) => String(message).includes("Gmail OAuth client"));
    expect(warnings).toEqual([[{ missingEnv }, expect.any(String)]]);
  });

  it.each([
    {
      case: "the client id is unset",
      env: { MS_GRAPH_OAUTH_CLIENT_SECRET: GRAPH_CLIENT_SECRET },
      missingEnv: ["MS_GRAPH_OAUTH_CLIENT_ID"],
    },
    {
      case: "the client id is empty, as in api.env.example",
      env: { MS_GRAPH_OAUTH_CLIENT_ID: "", MS_GRAPH_OAUTH_CLIENT_SECRET: GRAPH_CLIENT_SECRET },
      missingEnv: ["MS_GRAPH_OAUTH_CLIENT_ID"],
    },
    {
      case: "the client secret is unset",
      env: { MS_GRAPH_OAUTH_CLIENT_ID: GRAPH_CLIENT_ID },
      missingEnv: ["MS_GRAPH_OAUTH_CLIENT_SECRET"],
    },
    { case: "both are unset", env: {}, missingEnv: GRAPH_MISSING_BOTH },
  ])("has no Graph client and logs one warning naming the missing keys when $case", ({ env, missingEnv }) => {
    const warn = vi.spyOn(logger, "warn");

    const adapters = createMailSyncAdapters({ pool, env });

    expect(adapters.createGraphClient).toBeUndefined();
    const warnings = warn.mock.calls.filter(([, message]) => String(message).includes("Graph OAuth client"));
    expect(warnings).toEqual([[{ missingEnv }, expect.any(String)]]);
  });

  it("keeps one access token per client, refreshes it once it nears expiry, and never shares it across clients", async () => {
    const mailboxId = await createGmailMailbox("Caching");
    const google = createFakeGoogle({ expiresIn: 3600 });
    const adapters = createMailSyncAdapters({
      pool,
      env: { GMAIL_OAUTH_CLIENT_ID: GMAIL_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET: GMAIL_CLIENT_SECRET },
      fetchImpl: google.fetchImpl,
    });
    const createGmailClient = gmailClientFactory(adapters);
    // Only `Date` is faked: the database and the request timers keep their real clocks.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);

    const client = createGmailClient(mailboxId, STALE_JOB_CREDENTIAL);
    await client.listLabels();
    await client.listLabels();
    // Two requests on one token: the second one used the kept token, not a new refresh.
    expect(google.calls.presentedRefreshTokens).toEqual([STORED_REFRESH_TOKEN]);
    expect(google.calls.authorizations).toEqual(["Bearer ya29.access-1", "Bearer ya29.access-1"]);

    // Thirty seconds before expiry is inside the margin: the refresh happens before this request.
    vi.setSystemTime(new Date(T0.getTime() + ONE_HOUR_MS - 30_000));
    await client.listLabels();
    expect(google.calls.presentedRefreshTokens).toHaveLength(2);
    expect(google.calls.authorizations.at(-1)).toBe("Bearer ya29.access-2");

    // A second client starts with no token of its own.
    await gmailClientFactory(adapters)(mailboxId, STALE_JOB_CREDENTIAL).listLabels();
    expect(google.calls.presentedRefreshTokens).toHaveLength(3);
    expect(google.calls.authorizations.at(-1)).toBe("Bearer ya29.access-3");
  });

  it("surfaces a rejected refresh token as a failure before any Gmail request, without the secret or a token in the message", async () => {
    const mailboxId = await createGmailMailbox("Revoked");
    const google = createFakeGoogle({ tokenStatus: 401 });
    const createGmailClient = gmailClientFactory(
      createMailSyncAdapters({
        pool,
        env: { GMAIL_OAUTH_CLIENT_ID: GMAIL_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET: GMAIL_CLIENT_SECRET },
        fetchImpl: google.fetchImpl,
      }),
    );

    const failure = await rejectionOf(createGmailClient(mailboxId, STALE_JOB_CREDENTIAL).listLabels());

    expect(failure.message).toBe("OAuth token refresh rejected the stored refresh token (status 401)");
    expect(failure.message).not.toContain(GMAIL_CLIENT_SECRET);
    expect(failure.message).not.toContain(STORED_REFRESH_TOKEN);
    expect(google.calls.presentedRefreshTokens).toEqual([STORED_REFRESH_TOKEN]);
    expect(google.calls.gmailRoutes).toEqual([]);
  });

  it("sends the Graph token request and every Graph request through the injected fetch", async () => {
    const mailboxId = await createGraphMailbox("Injected fetch");
    const microsoft = createFakeMicrosoft();
    // Any request that reaches the global fetch fails the test instead of leaving the fake.
    vi.stubGlobal("fetch", () => {
      throw new Error("the global fetch must not be used when fetchImpl is injected");
    });
    const createGraphClient = graphClientFactory(
      createMailSyncAdapters({
        pool,
        env: { MS_GRAPH_OAUTH_CLIENT_ID: GRAPH_CLIENT_ID, MS_GRAPH_OAUTH_CLIENT_SECRET: GRAPH_CLIENT_SECRET },
        fetchImpl: microsoft.fetchImpl,
      }),
    );

    const folders = await createGraphClient(mailboxId, STALE_JOB_CREDENTIAL).listFolders();

    expect(folders).toEqual([{ id: GRAPH_INBOX_ID, displayName: "Inbox", wellKnownName: "inbox" }]);
    expect(microsoft.calls.presentedRefreshTokens).toEqual([STORED_MICROSOFT_REFRESH_TOKEN]);
    expect(microsoft.calls.graphRoutes).toEqual([
      "/mailFolders/inbox",
      "/mailFolders/sentitems",
      "/mailFolders/drafts",
      "/mailFolders/deleteditems",
      "/mailFolders/junkemail",
      "/mailFolders/archive",
      "/mailFolders?$top=999&$select=id,displayName,childFolderCount",
    ]);
  });
});

describe("mail sync passes through the api composition root (issues #1505, #1508)", () => {
  const ENV_KEYS = [
    "GMAIL_OAUTH_CLIENT_ID",
    "GMAIL_OAUTH_CLIENT_SECRET",
    "MS_GRAPH_OAUTH_CLIENT_ID",
    "MS_GRAPH_OAUTH_CLIENT_SECRET",
    "AI_GATEWAY_INTERNAL_TOKEN",
  ] as const;
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  let runtime: ApiQueueRuntime | undefined;

  /** Routes the requests to the hosts of one provider to its fake and leaves every other request to the real `fetch`. */
  function stubProviderFetch(provider: typeof fetch, hosts: readonly string[]): void {
    const realFetch = globalThis.fetch;
    const stubbed: typeof fetch = (input, init) => {
      const href = hrefOf(input);
      return hosts.some((host) => href.startsWith(host)) ? provider(input, init) : realFetch(input, init);
    };
    vi.stubGlobal("fetch", stubbed);
  }

  /** Sets the OAuth client keys of the providers named (removes the others) and builds the api runtime from the environment. */
  async function startRuntimeWith(configured: { gmail?: boolean; graph?: boolean }): Promise<void> {
    setEnv("GMAIL_OAUTH_CLIENT_ID", configured.gmail ? GMAIL_CLIENT_ID : undefined);
    setEnv("GMAIL_OAUTH_CLIENT_SECRET", configured.gmail ? GMAIL_CLIENT_SECRET : undefined);
    setEnv("MS_GRAPH_OAUTH_CLIENT_ID", configured.graph ? GRAPH_CLIENT_ID : undefined);
    setEnv("MS_GRAPH_OAUTH_CLIENT_SECRET", configured.graph ? GRAPH_CLIENT_SECRET : undefined);
    runtime = await createApiQueueRuntime(pool, await loadFullModuleRegistry());
  }

  async function enqueueAccountSync(mailboxItemId: string): Promise<void> {
    await inTenantZero(() => enqueueJob(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC, { mailboxItemId }));
  }

  interface SyncStateRow {
    last_error: string | null;
    gmail_history_id: string | null;
  }

  async function syncStateOf(mailboxItemId: string): Promise<SyncStateRow> {
    const { rows } = await pool.query<SyncStateRow>(
      `SELECT last_error, gmail_history_id FROM mail_account_sync_state WHERE item_id = $1`,
      [mailboxItemId],
    );
    const row = rows[0];
    if (!row) throw new Error(`fixture: no mail_account_sync_state row for ${mailboxItemId}`);
    return row;
  }

  async function syncErrorOf(mailboxItemId: string): Promise<string | null> {
    return (await syncStateOf(mailboxItemId)).last_error;
  }

  async function graphDeltaLinkOf(mailboxItemId: string): Promise<string | null> {
    const { rows } = await pool.query<{ graph_delta_link: string | null }>(
      `SELECT graph_delta_link FROM mail_account_sync_state WHERE item_id = $1`,
      [mailboxItemId],
    );
    const row = rows[0];
    if (!row) throw new Error(`fixture: no mail_account_sync_state row for ${mailboxItemId}`);
    return row.graph_delta_link;
  }

  async function syncStatusOf(mailboxItemId: string): Promise<unknown> {
    return (await createChokePoint(pool).findItem(mailboxItemId))?.properties.syncStatus;
  }

  async function jobErrorsFor(identifier: string): Promise<string[]> {
    const { rows } = await pool.query<{ last_error: string | null }>(
      `SELECT jobs.last_error FROM graphile_worker._private_jobs jobs
       JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
       WHERE tasks.identifier = $1`,
      [identifier],
    );
    return rows.flatMap((row) => (row.last_error === null ? [] : [row.last_error]));
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    // The `mail_sync_error` notification the failed sync writes targets the tenant's user, so bind one.
    await createTenantZeroUser(pool);
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    // `createAiGatewayClientForApi` requires this to build the api runtime.
    process.env.AI_GATEWAY_INTERNAL_TOKEN = randomUUID();
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
  });

  describe("Gmail-mode accounts (issue #1505)", () => {
    it("a Gmail-mode account's sync pass downloads its messages with one token for the whole pass", async () => {
      const mailboxId = await createGmailMailbox("Gmail sync");
      const google = createFakeGoogle();
      stubProviderFetch(google.fetchImpl, GOOGLE_HOSTS);
      await startRuntimeWith({ gmail: true });

      await enqueueAccountSync(mailboxId);

      await waitFor(async () => (await syncStateOf(mailboxId)).gmail_history_id === "5000");
      const { rows } = await pool.query<{ provider_message_id: string }>(
        `SELECT provider_message_id FROM mail_message_meta ORDER BY provider_message_id`,
      );
      expect(rows.map((row) => row.provider_message_id)).toEqual(["m-1", "m-2"]);
      expect(await syncStateOf(mailboxId)).toEqual({ last_error: null, gmail_history_id: "5000" });
      expect(await syncStatusOf(mailboxId)).toBe("ok");
      expect(google.calls.presentedRefreshTokens).toEqual([STORED_REFRESH_TOKEN]);
      expect(new Set(google.calls.authorizations)).toEqual(new Set(["Bearer ya29.access-1"]));
    });

    it("marks the account needsReauthorization when the provider rejects the stored refresh token, with no secret in the recorded errors", async () => {
      const mailboxId = await createGmailMailbox("Revoked sync");
      const google = createFakeGoogle({ tokenStatus: 401 });
      stubProviderFetch(google.fetchImpl, GOOGLE_HOSTS);
      await startRuntimeWith({ gmail: true });

      await enqueueAccountSync(mailboxId);

      await waitFor(async () => (await syncErrorOf(mailboxId)) !== null);
      expect(await syncStateOf(mailboxId)).toEqual({
        last_error: "OAuth token refresh rejected the stored refresh token (status 401)",
        gmail_history_id: null,
      });
      expect(await syncStatusOf(mailboxId)).toBe("needsReauthorization");
      expect(google.calls.gmailRoutes).toEqual([]);
      const recorded = [
        ...(await jobErrorsFor(CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC)),
        (await syncErrorOf(mailboxId)) ?? "",
      ];
      for (const text of recorded) {
        expect(text).not.toContain(GMAIL_CLIENT_SECRET);
        expect(text).not.toContain(STORED_REFRESH_TOKEN);
      }
    });

    it("starts without the Gmail OAuth client and fails a Gmail-mode sync with the adapter message", async () => {
      const mailboxId = await createGmailMailbox("Unconfigured sync");
      const warn = vi.spyOn(logger, "warn");

      await startRuntimeWith({});

      const warnings = warn.mock.calls.filter(([, message]) => String(message).includes("Gmail OAuth client"));
      expect(warnings).toEqual([[{ missingEnv: GMAIL_MISSING_BOTH }, expect.any(String)]]);
      await enqueueAccountSync(mailboxId);
      await waitFor(async () => (await syncErrorOf(mailboxId)) !== null);
      expect(await syncStateOf(mailboxId)).toEqual({
        last_error: "No Gmail adapter configured for this composition root",
        gmail_history_id: null,
      });
      expect(await syncStatusOf(mailboxId)).toBe("error");
    });
  });

  describe("Graph-mode accounts (issue #1508)", () => {
    it("a Graph-mode account's sync pass downloads its messages through delta with one token for the whole pass", async () => {
      const mailboxId = await createGraphMailbox("Graph sync");
      const microsoft = createFakeMicrosoft();
      stubProviderFetch(microsoft.fetchImpl, MICROSOFT_HOSTS);
      await startRuntimeWith({ graph: true });

      await enqueueAccountSync(mailboxId);

      await waitFor(async () => (await graphDeltaLinkOf(mailboxId)) === DELTA_LINK_1);
      const { rows } = await pool.query<{ provider_message_id: string }>(
        `SELECT provider_message_id FROM mail_message_meta ORDER BY provider_message_id`,
      );
      expect(rows.map((row) => row.provider_message_id)).toEqual(["g-1", "g-2"]);
      expect(await syncErrorOf(mailboxId)).toBeNull();
      expect(await syncStatusOf(mailboxId)).toBe("ok");
      expect(microsoft.calls.presentedRefreshTokens).toEqual([STORED_MICROSOFT_REFRESH_TOKEN]);
      // The refresh sends no scope, so Microsoft keeps the scopes the account already granted.
      expect(microsoft.calls.scopeParameters).toEqual([false]);
      expect(new Set(microsoft.calls.authorizations)).toEqual(new Set(["Bearer eyJ-access-1"]));
    });

    it("stores a rotated refresh token, and the next pass presents it instead of the retired one", async () => {
      const mailboxId = await createGraphMailbox("Rotating Graph sync");
      const microsoft = createFakeMicrosoft({ rotates: true });
      stubProviderFetch(microsoft.fetchImpl, MICROSOFT_HOSTS);
      await startRuntimeWith({ graph: true });
      await enqueueAccountSync(mailboxId);
      await waitFor(async () => (await graphDeltaLinkOf(mailboxId)) === DELTA_LINK_1);

      await enqueueAccountSync(mailboxId);
      await waitFor(
        async () => (await graphDeltaLinkOf(mailboxId)) === DELTA_LINK_2 || (await syncErrorOf(mailboxId)) !== null,
      );

      expect(microsoft.calls.presentedRefreshTokens).toEqual([STORED_MICROSOFT_REFRESH_TOKEN, "0.ROTATED-1"]);
      expect(microsoft.calls.graphRoutes).toContain("/messages/delta?$deltatoken=delta-1");
      expect(await syncErrorOf(mailboxId)).toBeNull();
      expect(await syncStatusOf(mailboxId)).toBe("ok");
    });

    it("marks the account needsReauthorization when Microsoft rejects the stored refresh token, with no secret in the recorded errors", async () => {
      const mailboxId = await createGraphMailbox("Revoked Graph sync");
      const microsoft = createFakeMicrosoft({ revoked: true });
      stubProviderFetch(microsoft.fetchImpl, MICROSOFT_HOSTS);
      await startRuntimeWith({ graph: true });

      await enqueueAccountSync(mailboxId);

      await waitFor(async () => (await syncErrorOf(mailboxId)) !== null);
      expect(await syncErrorOf(mailboxId)).toBe("OAuth token refresh rejected the stored refresh token (status 400)");
      expect(await syncStatusOf(mailboxId)).toBe("needsReauthorization");
      expect(await graphDeltaLinkOf(mailboxId)).toBeNull();
      expect(microsoft.calls.graphRoutes).toEqual([]);
      const recorded = [
        ...(await jobErrorsFor(CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC)),
        (await syncErrorOf(mailboxId)) ?? "",
      ];
      for (const text of recorded) {
        expect(text).not.toContain(GRAPH_CLIENT_SECRET);
        expect(text).not.toContain(STORED_MICROSOFT_REFRESH_TOKEN);
      }
    });

    it("starts without the Graph OAuth client and fails a Graph-mode sync with the adapter message", async () => {
      const mailboxId = await createGraphMailbox("Unconfigured Graph sync");
      const warn = vi.spyOn(logger, "warn");

      await startRuntimeWith({ gmail: true });

      const warnings = warn.mock.calls.filter(([, message]) => String(message).includes("Graph OAuth client"));
      expect(warnings).toEqual([[{ missingEnv: GRAPH_MISSING_BOTH }, expect.any(String)]]);
      await enqueueAccountSync(mailboxId);
      await waitFor(async () => (await syncErrorOf(mailboxId)) !== null);
      expect(await syncErrorOf(mailboxId)).toBe("No Graph adapter configured for this composition root");
      expect(await syncStatusOf(mailboxId)).toBe("error");
    });
  });
});

const IMAP_HOST = "imap.mail.test";
/** The settings store accepts only the standard IMAP ports (migration 0101), so the tests store 993. `redirectImapConnections` sends the connection to the fake server's own port. */
const IMAP_STANDARD_PORT = 993;
const IMAP_ENDPOINT: MailServerEndpoint = { host: IMAP_HOST, port: IMAP_STANDARD_PORT, security: "tls" };
const IMAP_USERNAME = "owner@mail.test";
const IMAP_PASSWORD = "app-password-stored-for-issue-1510";
const IMAP_WRONG_PASSWORD = "app-password-revoked-for-issue-1510";

interface FakeImapMessage {
  uid: number;
  messageId: string;
  subject: string;
  body: string;
}

const IMAP_MESSAGES: readonly FakeImapMessage[] = [
  { uid: 1, messageId: "<m-1@mail.test>", subject: "First message", body: "Body of the first message." },
  { uid: 2, messageId: "<m-2@mail.test>", subject: "Second message", body: "Body of the second message." },
];

interface TlsCertificate {
  readonly key: string;
  readonly cert: string;
}

interface FakeImapOptions {
  /** Answers every connection with an untagged BYE in place of the greeting, as a server at its connection limit does. */
  connectionLimit?: boolean;
  /** Answers SELECT with NO, so a pass fails after its login has succeeded. */
  failSelect?: boolean;
}

interface FakeImapServer {
  readonly port: number;
  /** TCP connections accepted. */
  accepted(): number;
  /** Accepted connections whose server side has closed. */
  closed(): number;
  /** The IMAP lines the fake does not implement, in order. A pass must not need any. */
  readonly unsupported: string[];
  close(): Promise<void>;
}

const imapServers: FakeImapServer[] = [];

/** A self-signed certificate for `commonName`, made with the openssl CLI at test time so no key is committed. */
function makeTlsCertificate(commonName: string): TlsCertificate {
  const dir = mkdtempSync(join(tmpdir(), "imap-sync-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        `/CN=${commonName}`,
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Splits IMAP arguments into their values, unquoting quoted strings. */
function tokenize(text: string): string[] {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

/** Whether `uid` is in an IMAP sequence set of one number or a `low:high` range, where `*` is the largest UID. */
function uidInSet(uid: number, set: string): boolean {
  const [lowText = "", highText = lowText] = set.split(":");
  const low = Number(lowText);
  const high = highText === "*" ? Number.MAX_SAFE_INTEGER : Number(highText);
  return uid >= low && uid <= high;
}

function envelopeOf(message: FakeImapMessage): string {
  const from = '(("Ada" NIL "ada" "example.test"))';
  const to = '(("Owner" NIL "owner" "mail.test"))';
  return `("Mon, 05 Oct 2026 10:00:00 +0000" "${message.subject}" ${from} ${from} NIL ${to} NIL NIL NIL "${message.messageId}")`;
}

function bodyStructureOf(message: FakeImapMessage): string {
  return `("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${Buffer.byteLength(message.body)} 1)`;
}

/** One untagged FETCH response carrying the attributes the request named. Body sections are literals; header sections are empty. */
function fetchLine(seq: number, message: FakeImapMessage, items: string): string {
  const attributes: string[] = [];
  if (/\bUID\b/.test(items)) attributes.push(`UID ${message.uid}`);
  if (/\bFLAGS\b/.test(items)) attributes.push("FLAGS (\\Seen)");
  if (/\bENVELOPE\b/.test(items)) attributes.push(`ENVELOPE ${envelopeOf(message)}`);
  if (/\bBODYSTRUCTURE\b/.test(items)) attributes.push(`BODYSTRUCTURE ${bodyStructureOf(message)}`);
  for (const [, section = ""] of items.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\]/gi)) {
    const content = /HEADER/i.test(section) ? "\r\n" : message.body;
    attributes.push(`BODY[${section}] {${Buffer.byteLength(content)}}\r\n${content}`);
  }
  return `* ${seq} FETCH (${attributes.join(" ")})\r\n`;
}

interface ImapReply {
  readonly data: string;
  readonly end: boolean;
}

/** Answers one client line. Implements what one sync pass sends: CAPABILITY, LOGIN, LIST, LSUB, SELECT, UID SEARCH, UID FETCH, NOOP and LOGOUT. */
function imapReply(line: string, options: FakeImapOptions, unsupported: string[]): ImapReply {
  const match = /^(\S+) (\S+)(?: (.*))?$/.exec(line);
  const tag = match?.[1] ?? "*";
  const command = (match?.[2] ?? "").toUpperCase();
  const rest = match?.[3] ?? "";
  const reply = (data: string): ImapReply => ({ data, end: false });
  switch (command) {
    case "CAPABILITY":
      return reply(`* CAPABILITY IMAP4rev1 LOGIN UIDPLUS\r\n${tag} OK CAPABILITY completed\r\n`);
    case "LOGIN": {
      const [user = "", pass = ""] = tokenize(rest);
      return user === IMAP_USERNAME && pass === IMAP_PASSWORD
        ? reply(`${tag} OK [CAPABILITY IMAP4rev1 LOGIN UIDPLUS] LOGIN completed\r\n`)
        : reply(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    }
    case "LIST":
      return reply(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LIST completed\r\n`);
    case "LSUB":
      return reply(`* LSUB (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK LSUB completed\r\n`);
    case "SELECT":
      if (options.failSelect) return reply(`${tag} NO [SERVERBUG] SELECT failed\r\n`);
      return reply(
        `* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n* ${IMAP_MESSAGES.length} EXISTS\r\n* 0 RECENT\r\n` +
          `* OK [UIDVALIDITY 1] UIDs valid\r\n* OK [UIDNEXT ${IMAP_MESSAGES.length + 1}] Predicted next UID\r\n` +
          `${tag} OK [READ-WRITE] SELECT completed\r\n`,
      );
    case "UID": {
      if (/^SEARCH\b/i.test(rest)) {
        return reply(
          `* SEARCH ${IMAP_MESSAGES.map((message) => message.uid).join(" ")}\r\n${tag} OK SEARCH completed\r\n`,
        );
      }
      const fetch = /^FETCH (\S+) \((.*)\)$/i.exec(rest);
      if (!fetch) {
        unsupported.push(line);
        return reply(`${tag} BAD UID command not implemented by the fake\r\n`);
      }
      const [, set = "", items = ""] = fetch;
      const lines = IMAP_MESSAGES.map((message, index) => ({ message, seq: index + 1 }))
        .filter(({ message }) => uidInSet(message.uid, set))
        .map(({ message, seq }) => fetchLine(seq, message, items))
        .join("");
      return reply(`${lines}${tag} OK FETCH completed\r\n`);
    }
    case "NOOP":
      return reply(`${tag} OK NOOP completed\r\n`);
    case "LOGOUT":
      return { data: `* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`, end: true };
    default:
      unsupported.push(line);
      return reply(`${tag} BAD command not implemented by the fake\r\n`);
  }
}

/** Serves one connection: a greeting (or a BYE at the connection limit), then the client's lines until LOGOUT or until it leaves. */
function serveImapConnection(socket: Socket, options: FakeImapOptions, unsupported: string[]): void {
  if (options.connectionLimit) {
    socket.end("* BYE Too many simultaneous connections. (Failure)\r\n");
    return;
  }
  socket.write("* OK [CAPABILITY IMAP4rev1 LOGIN UIDPLUS] fake IMAP server ready\r\n");
  let pending = "";
  socket.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let end = pending.indexOf("\r\n");
    while (end !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      end = pending.indexOf("\r\n");
      const reply = imapReply(line, options, unsupported);
      if (reply.end) socket.end(reply.data);
      else socket.write(reply.data);
    }
  });
}

/** A TLS IMAP server on loopback. Its certificate is only trusted by the test's `tls.connect` wrapper. */
async function startFakeImapServer(
  certificate: TlsCertificate,
  options: FakeImapOptions = {},
): Promise<FakeImapServer> {
  let accepted = 0;
  let closed = 0;
  const unsupported: string[] = [];
  const sockets = new Set<Socket>();
  const server = tls.createServer({ key: certificate.key, cert: certificate.cert }, (socket) => {
    accepted += 1;
    sockets.add(socket);
    // A client that drops its connection after a failing pass is expected, so the fake does not treat it as an error.
    socket.on("error", () => undefined);
    socket.on("close", () => {
      closed += 1;
      sockets.delete(socket);
    });
    serveImapConnection(socket, options, unsupported);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("fake IMAP server is not listening on a TCP port");
  const fake: FakeImapServer = {
    port: address.port,
    accepted: () => accepted,
    closed: () => closed,
    unsupported,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  imapServers.push(fake);
  return fake;
}

describe("IMAP-mode accounts (issue #1510)", () => {
  let imapCertificate: TlsCertificate;
  let runtime: ApiQueueRuntime | undefined;
  let stub: DnsLookupStub | undefined;
  let restorePolicy: (() => void) | undefined;
  let savedGatewayToken: string | undefined;

  beforeAll(() => {
    imapCertificate = makeTlsCertificate(IMAP_HOST);
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    // The `mail_sync_error` notification the failed sync writes targets the tenant's user, so bind one.
    await createTenantZeroUser(pool);
    savedGatewayToken = process.env.AI_GATEWAY_INTERNAL_TOKEN;
    // `createAiGatewayClientForApi` requires this to build the api runtime.
    process.env.AI_GATEWAY_INTERNAL_TOKEN = randomUUID();
    runtime = undefined;
  });

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    stub?.restore();
    stub = undefined;
    restorePolicy?.();
    restorePolicy = undefined;
    vi.restoreAllMocks();
    for (const server of imapServers.splice(0)) await server.close();
    setEnv("AI_GATEWAY_INTERNAL_TOKEN", savedGatewayToken);
  });

  /** Sends IMAP_HOST to `server` on loopback under the test policy, and trusts the test certificate for the connections. */
  function reachFakeImap(server: FakeImapServer): void {
    restorePolicy = allowLoopbackOutboundForTests();
    stub = stubDnsLookup({ [IMAP_HOST]: ["127.0.0.1"] });
    redirectImapConnections(server);
  }

  /** Sends every IMAP connection of this test to `server`'s port, keeping the host name for the lookup and the TLS server name. */
  function redirectImapConnections(server: FakeImapServer): void {
    const connect = tls.connect;
    vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions, listener?: () => void) =>
      connect({ ...options, port: server.port, ca: [imapCertificate.cert] }, listener)) as typeof tls.connect);
  }

  async function startRuntime(): Promise<void> {
    runtime = await createApiQueueRuntime(pool, await loadFullModuleRegistry());
  }

  /** The endpoints of one stored settings row. */
  interface StoredEndpoints {
    imap: MailServerEndpoint | null;
    smtp: MailServerEndpoint | null;
  }

  /**
   * An IMAP Mailbox item with its app password and a sync-state row for `imap`. The server settings hold
   * `endpoints`; `null` stores no settings row at all.
   */
  async function createImapMailbox(
    name: string,
    endpoints: StoredEndpoints | null = { imap: IMAP_ENDPOINT, smtp: null },
    password = IMAP_PASSWORD,
  ): Promise<string> {
    return inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
        if (!mailboxes) throw new Error("fixture: no mailboxes database is seeded");
        const item = await createItemWithClient(client, {
          databaseId: mailboxes.id,
          properties: { name, provider: "imap" },
        });
        await storeCredential(client, { itemId: item.id, credentialType: "app_password", plaintext: password });
        await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "imap" });
        if (endpoints !== null) {
          await upsertMailServerSettings(client, item.id, {
            imap: endpoints.imap,
            smtp: endpoints.smtp,
            username: IMAP_USERNAME,
          });
        }
        return item.id;
      }),
    );
  }

  /** Messages ingested so far, across every mailbox; a refused or failed pass must leave this at zero. */
  async function ingestedMessageCount(): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM mail_message_meta`);
    const row = rows[0];
    if (!row) throw new Error("fixture: the message count query returned no row");
    return row.count;
  }

  async function enqueueAccountSync(mailboxItemId: string): Promise<void> {
    await inTenantZero(() => enqueueJob(pool, CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC, { mailboxItemId }));
  }

  async function syncStatusOf(mailboxItemId: string): Promise<unknown> {
    return (await createChokePoint(pool).findItem(mailboxItemId))?.properties.syncStatus;
  }

  async function syncErrorOf(mailboxItemId: string): Promise<string | null> {
    const { rows } = await pool.query<{ last_error: string | null }>(
      `SELECT last_error FROM mail_account_sync_state WHERE item_id = $1`,
      [mailboxItemId],
    );
    const row = rows[0];
    if (!row) throw new Error(`fixture: no mail_account_sync_state row for ${mailboxItemId}`);
    return row.last_error;
  }

  it("a pass downloads the messages of an IMAP mailbox from its stored settings, then closes the socket", async () => {
    const server = await startFakeImapServer(imapCertificate);
    reachFakeImap(server);
    const mailboxId = await createImapMailbox("IMAP sync");
    await startRuntime();

    await enqueueAccountSync(mailboxId);

    await waitFor(async () => (await syncStatusOf(mailboxId)) === "ok");
    const { rows } = await pool.query<{ message_id: string }>(
      `SELECT message_id FROM mail_message_meta ORDER BY message_id`,
    );
    expect(rows.map((row) => row.message_id)).toEqual(IMAP_MESSAGES.map((message) => message.messageId));
    expect(await syncErrorOf(mailboxId)).toBeNull();
    expect(server.unsupported).toEqual([]);
    // The pass logs out when it ends, so the server sees its connection close.
    await waitFor(async () => server.accepted() > 0 && server.closed() === server.accepted());
  });

  it.each(["127.0.0.1", "10.0.0.1"])(
    "a host that resolves to %s is refused as an unreachable server, and no connection reaches the server",
    async (address) => {
      // The policy stays the default (public only), so the refusal is the policy's own decision.
      const server = await startFakeImapServer(imapCertificate);
      redirectImapConnections(server);
      stub = stubDnsLookup({ [IMAP_HOST]: [address] });
      const mailboxId = await createImapMailbox("Internal host");
      await startRuntime();

      await enqueueAccountSync(mailboxId);

      await waitFor(async () => (await syncStatusOf(mailboxId)) === "error");
      expect(await syncErrorOf(mailboxId)).toBe("The mail server could not be reached");
      expect(server.accepted()).toBe(0);
      expect(await ingestedMessageCount()).toBe(0);
    },
  );

  it("a refused address fails the factory itself with MailServerUnreachableError, before any connection", async () => {
    const server = await startFakeImapServer(imapCertificate);
    redirectImapConnections(server);
    stub = stubDnsLookup({ [IMAP_HOST]: ["127.0.0.1"] });
    const mailboxId = await createImapMailbox("Refused address direct");
    const adapters = createMailSyncAdapters({ pool, env: {} });

    const error = await inTenantZero(() => rejectionOf(adapters.createImapClient!(mailboxId, IMAP_PASSWORD)));

    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(server.accepted()).toBe(0);
  });

  it("the factory maps a rejected login to MailReauthorizationRequiredError, without the password in the message", async () => {
    const server = await startFakeImapServer(imapCertificate);
    reachFakeImap(server);
    const mailboxId = await createImapMailbox("Rejected login direct", undefined, IMAP_WRONG_PASSWORD);
    const adapters = createMailSyncAdapters({ pool, env: {} });

    const error = await inTenantZero(() => rejectionOf(adapters.createImapClient!(mailboxId, IMAP_WRONG_PASSWORD)));

    expect(error).toBeInstanceOf(MailReauthorizationRequiredError);
    expect(error.message).not.toContain(IMAP_WRONG_PASSWORD);
  });

  it("the factory maps the too-many-connections rejection to MailConnectionLimitError", async () => {
    const server = await startFakeImapServer(imapCertificate, { connectionLimit: true });
    reachFakeImap(server);
    const mailboxId = await createImapMailbox("Busy server direct");
    const adapters = createMailSyncAdapters({ pool, env: {} });

    const error = await inTenantZero(() => rejectionOf(adapters.createImapClient!(mailboxId, IMAP_PASSWORD)));

    expect(error).toBeInstanceOf(MailConnectionLimitError);
    expect(error.message).not.toContain(IMAP_PASSWORD);
  });

  it("marks the account needsReauthorization when the server rejects the login, with no password in the recorded error", async () => {
    const server = await startFakeImapServer(imapCertificate);
    reachFakeImap(server);
    const mailboxId = await createImapMailbox("Revoked password", undefined, IMAP_WRONG_PASSWORD);
    await startRuntime();

    await enqueueAccountSync(mailboxId);

    await waitFor(async () => (await syncStatusOf(mailboxId)) === "needsReauthorization");
    const error = await syncErrorOf(mailboxId);
    expect(error).toBe("The IMAP server rejected the stored login; reauthorize the mailbox");
    expect(error).not.toContain(IMAP_WRONG_PASSWORD);
    expect(error).not.toContain(IMAP_PASSWORD);
    expect(await ingestedMessageCount()).toBe(0);
  });

  it("backs off through MailConnectionLimitError when the server reports too many simultaneous connections", async () => {
    const server = await startFakeImapServer(imapCertificate, { connectionLimit: true });
    reachFakeImap(server);
    const mailboxId = await createImapMailbox("Busy server");
    await startRuntime();

    await enqueueAccountSync(mailboxId);

    await waitFor(async () => (await syncStatusOf(mailboxId)) === "error");
    expect(await syncErrorOf(mailboxId)).toBe(
      "The IMAP server reports too many simultaneous connections for this account",
    );
    // The job schedules the retry through the sync state instead of rethrowing into an immediate retry.
    const { rows } = await pool.query<{ backed_off: boolean }>(
      `SELECT next_expected_activity_at > now() AS backed_off FROM mail_account_sync_state WHERE item_id = $1`,
      [mailboxId],
    );
    expect(rows[0]?.backed_off).toBe(true);
    expect(await ingestedMessageCount()).toBe(0);
  });

  it("closes the IMAP socket when the pass throws, and keeps the password out of the recorded error", async () => {
    const server = await startFakeImapServer(imapCertificate, { failSelect: true });
    reachFakeImap(server);
    const mailboxId = await createImapMailbox("Failing pass");
    await startRuntime();

    await enqueueAccountSync(mailboxId);

    await waitFor(async () => (await syncStatusOf(mailboxId)) === "error");
    expect(server.accepted()).toBeGreaterThan(0);
    expect(await syncErrorOf(mailboxId)).not.toContain(IMAP_PASSWORD);
    expect(await ingestedMessageCount()).toBe(0);
    await waitFor(async () => server.closed() === server.accepted());
  });

  it("a mailbox with no IMAP settings fails with a configuration error that names the mailbox and not the password", async () => {
    const mailboxId = await createImapMailbox("No settings", null);
    const adapters = createMailSyncAdapters({ pool, env: {} });

    const error = await inTenantZero(() => rejectionOf(adapters.createImapClient!(mailboxId, IMAP_PASSWORD)));

    expect(error.message).toBe(`Mailbox ${mailboxId} has no IMAP server settings; set the IMAP host before syncing it`);
    expect(error.message).not.toContain(IMAP_PASSWORD);
  });

  it("a mailbox whose stored settings hold only an SMTP endpoint fails with the same configuration error", async () => {
    const mailboxId = await createImapMailbox("SMTP only", {
      imap: null,
      smtp: { host: "smtp.mail.test", port: 465, security: "tls" },
    });
    const adapters = createMailSyncAdapters({ pool, env: {} });

    const error = await inTenantZero(() => rejectionOf(adapters.createImapClient!(mailboxId, IMAP_PASSWORD)));

    expect(error.message).toBe(`Mailbox ${mailboxId} has no IMAP server settings; set the IMAP host before syncing it`);
  });
});
