import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import type { MailSyncAdapterFactory } from "@semprec/data";
import {
  createTenantZeroUser,
  ensureMailAccountSyncState,
  getTestPool,
  inTenantZero,
  resetDatabase,
  storeCredential,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createItemWithClient,
  getDatabaseByModuleId,
  loadFullModuleRegistry,
  seedSystem,
  withTransaction,
} from "@semprec/data";
import { createApiQueueRuntime, type ApiQueueRuntime } from "../queueRuntime.js";
import { createMailSyncAdapters } from "../mailSyncAdapters.js";
import { logger } from "../logger.js";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GMAIL_API_PREFIX = "https://gmail.googleapis.com/gmail/v1/users/me";
const CLIENT_ID = "test-gmail-client-id.example";
const CLIENT_SECRET = "test-gmail-client-secret-value";
const STORED_REFRESH_TOKEN = "1//stored-refresh-token-value";
/** Passed to `createGmailClient` as the job's decrypted credential; it must never be presented to Google. */
const STALE_JOB_CREDENTIAL = "stale-credential-decrypted-by-the-job";
const T0 = new Date("2026-10-29T10:00:00.000Z");
const ONE_HOUR_MS = 3_600_000;
const MISSING_BOTH = ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET"];

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

type GmailClientFactory = NonNullable<MailSyncAdapterFactory["createGmailClient"]>;

/** The Gmail client factory the wiring returns; a test fails here if the factory has none. */
function gmailClientFactory(adapters: MailSyncAdapterFactory): GmailClientFactory {
  const create = adapters.createGmailClient;
  if (!create) throw new Error("expected createMailSyncAdapters to provide a Gmail client factory");
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

let pool: Pool;

// File-level: both describes share this pool, so ending it in one describe's afterAll would break the other.
afterAll(async () => {
  await pool?.end();
});

/** A Mailbox item of provider `gmail` with its stored refresh token and a `gmail_api` sync-state row, in tenant zero. */
async function createGmailMailbox(name: string): Promise<string> {
  return inTenantZero(() =>
    withTransaction(pool, async (client) => {
      const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
      if (!mailboxes) throw new Error("fixture: no mailboxes database is seeded");
      const item = await createItemWithClient(client, {
        databaseId: mailboxes.id,
        properties: { name, provider: "gmail" },
      });
      await storeCredential(client, {
        itemId: item.id,
        credentialType: "oauth2_refresh_token",
        plaintext: STORED_REFRESH_TOKEN,
      });
      await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "gmail_api" });
      return item.id;
    }),
  );
}

describe("createMailSyncAdapters (issue #1505)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      case: "the client id is unset",
      env: { GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      missingEnv: ["GMAIL_OAUTH_CLIENT_ID"],
    },
    {
      case: "the client id is empty, as in api.env.example",
      env: { GMAIL_OAUTH_CLIENT_ID: "", GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
      missingEnv: ["GMAIL_OAUTH_CLIENT_ID"],
    },
    {
      case: "the client secret is unset",
      env: { GMAIL_OAUTH_CLIENT_ID: CLIENT_ID },
      missingEnv: ["GMAIL_OAUTH_CLIENT_SECRET"],
    },
    { case: "both are unset", env: {}, missingEnv: MISSING_BOTH },
  ])("has no Gmail client and logs one warning naming the missing keys when $case", ({ env, missingEnv }) => {
    const warn = vi.spyOn(logger, "warn");

    const adapters = createMailSyncAdapters({ pool, env });

    expect(adapters.createGmailClient).toBeUndefined();
    const warnings = warn.mock.calls.filter(([, message]) => String(message).includes("Gmail OAuth client"));
    expect(warnings).toEqual([[{ missingEnv }, expect.any(String)]]);
  });

  it("keeps one access token per client, refreshes it once it nears expiry, and never shares it across clients", async () => {
    const mailboxId = await createGmailMailbox("Caching");
    const google = createFakeGoogle({ expiresIn: 3600 });
    const adapters = createMailSyncAdapters({
      pool,
      env: { GMAIL_OAUTH_CLIENT_ID: CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
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
        env: { GMAIL_OAUTH_CLIENT_ID: CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET },
        fetchImpl: google.fetchImpl,
      }),
    );

    const failure = await rejectionOf(createGmailClient(mailboxId, STALE_JOB_CREDENTIAL).listLabels());

    expect(failure.message).toBe("OAuth token refresh rejected the stored refresh token (status 401)");
    expect(failure.message).not.toContain(CLIENT_SECRET);
    expect(failure.message).not.toContain(STORED_REFRESH_TOKEN);
    expect(google.calls.presentedRefreshTokens).toEqual([STORED_REFRESH_TOKEN]);
    expect(google.calls.gmailRoutes).toEqual([]);
  });
});

describe("Gmail sync pass through the api composition root (issue #1505)", () => {
  const ENV_KEYS = ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "AI_GATEWAY_INTERNAL_TOKEN"] as const;
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
  let runtime: ApiQueueRuntime | undefined;

  /** Routes Google's two hosts to `google` and leaves every other request to the real `fetch`. */
  function stubGoogleFetch(google: FakeGoogle): void {
    const realFetch = globalThis.fetch;
    const stubbed: typeof fetch = (input, init) => {
      const href = hrefOf(input);
      const isGoogle =
        href.startsWith("https://oauth2.googleapis.com/") || href.startsWith("https://gmail.googleapis.com/");
      return isGoogle ? google.fetchImpl(input, init) : realFetch(input, init);
    };
    vi.stubGlobal("fetch", stubbed);
  }

  async function startRuntimeWithGmailEnv(configured: boolean): Promise<void> {
    if (configured) {
      process.env.GMAIL_OAUTH_CLIENT_ID = CLIENT_ID;
      process.env.GMAIL_OAUTH_CLIENT_SECRET = CLIENT_SECRET;
    } else {
      delete process.env.GMAIL_OAUTH_CLIENT_ID;
      delete process.env.GMAIL_OAUTH_CLIENT_SECRET;
    }
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
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("a Gmail-mode account's sync pass downloads its messages with one token for the whole pass", async () => {
    const mailboxId = await createGmailMailbox("Gmail sync");
    const google = createFakeGoogle();
    stubGoogleFetch(google);
    await startRuntimeWithGmailEnv(true);

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
    stubGoogleFetch(google);
    await startRuntimeWithGmailEnv(true);

    await enqueueAccountSync(mailboxId);

    await waitFor(async () => (await syncStateOf(mailboxId)).last_error !== null);
    expect(await syncStateOf(mailboxId)).toEqual({
      last_error: "OAuth token refresh rejected the stored refresh token (status 401)",
      gmail_history_id: null,
    });
    expect(await syncStatusOf(mailboxId)).toBe("needsReauthorization");
    expect(google.calls.gmailRoutes).toEqual([]);
    const recorded = [
      ...(await jobErrorsFor(CORE_TASK_NAMES.MAIL_ACCOUNT_SYNC)),
      (await syncStateOf(mailboxId)).last_error ?? "",
    ];
    for (const text of recorded) {
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(STORED_REFRESH_TOKEN);
    }
  });

  it("starts without the Gmail OAuth client and fails a Gmail-mode sync with the adapter message", async () => {
    const mailboxId = await createGmailMailbox("Unconfigured sync");
    const warn = vi.spyOn(logger, "warn");

    await startRuntimeWithGmailEnv(false);

    const warnings = warn.mock.calls.filter(([, message]) => String(message).includes("Gmail OAuth client"));
    expect(warnings).toEqual([[{ missingEnv: MISSING_BOTH }, expect.any(String)]]);
    await enqueueAccountSync(mailboxId);
    await waitFor(async () => (await syncStateOf(mailboxId)).last_error !== null);
    expect(await syncStateOf(mailboxId)).toEqual({
      last_error: "No Gmail adapter configured for this composition root",
      gmail_history_id: null,
    });
    expect(await syncStatusOf(mailboxId)).toBe("error");
  });
});
