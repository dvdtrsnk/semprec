import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import {
  getCredentialType,
  getDecryptedCredential,
  storeCredential,
  type CredentialType,
} from "../credentials/externalCredentialsStore.js";
import { logger as dbLogger } from "../db/logger.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { logger as mailLogger } from "../mail/logger.js";
import {
  ensureMailAccountSyncState,
  getGmailAccountUse,
  recordGmailWatchEmailAddress,
  recordGmailWatchRegistration,
  recordGraphSubscriptionRegistration,
  type SyncMode,
} from "../mail/mailAccountSyncStateStore.js";
import { createMailLiveSyncRoot, type MailLiveSyncRoot } from "../mail/mailLiveSyncRoot.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { createMailboxRemovalRouteHandler, removeMailbox } from "../mail/mailboxRemoval.js";
import {
  cleanUpRemovedMailbox,
  type MailboxRemovalCleanupDependencies,
} from "../mail/mailboxRemovalProviderCleanup.js";
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL } from "../mail/oauthTokenExchange.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

const GMAIL_WATCH_STOP_URL = "https://gmail.googleapis.com/gmail/v1/users/me/stop";
const GOOGLE_TOKEN_REVOCATION_URL = "https://oauth2.googleapis.com/revoke";
const GRAPH_SUBSCRIPTIONS_URL = "https://graph.microsoft.com/v1.0/subscriptions";
/** A subscription id with characters a URL path must escape, and the path segment it becomes. */
const GRAPH_SUBSCRIPTION_ID = "sub/1 #a";
const GRAPH_SUBSCRIPTION_URL = `${GRAPH_SUBSCRIPTIONS_URL}/sub%2F1%20%23a`;

/** Values that must never reach a log, a row or a job payload: the tests that read one look for them. */
const SECRETS = {
  refreshToken: "SENTINEL-REFRESH-TOKEN",
  rotatedRefreshToken: "SENTINEL-ROTATED-REFRESH-TOKEN",
  accessToken: "SENTINEL-ACCESS-TOKEN",
  password: "SENTINEL-APP-PASSWORD",
  gmailClientSecret: "SENTINEL-GMAIL-CLIENT-SECRET",
  graphClientSecret: "SENTINEL-GRAPH-CLIENT-SECRET",
};
/** What a provider says about a failure; a failure log must not repeat it. */
const PROVIDER_ERROR_TEXT = "SENTINEL-PROVIDER-ERROR-TEXT";

const OAUTH = {
  gmail: { clientId: "gmail-client-id", clientSecret: SECRETS.gmailClientSecret },
  msGraph: { clientId: "graph-client-id", clientSecret: SECRETS.graphClientSecret },
};

const CLEANUP_FAILURE_MESSAGE = "Mailbox removal cleanup step failed";
const CLEANUP_SKIP_MESSAGE = "Mailbox removal cleanup step skipped";
const WATCH_EXPIRY = new Date("2030-01-01T00:00:00.000Z");

interface ProviderCall {
  url: string;
  method: string;
  authorization: string | null;
  /** The form body of a token exchange or a revocation; null for every other request. */
  form: URLSearchParams | null;
  signal: AbortSignal | null;
}

type ProviderRoute = (call: ProviderCall) => Response | Promise<Response>;

/**
 * A provider that answers each known URL from `routes` and records every request it received, in
 * `calls` and, as `<METHOD> <url>`, in `events`.
 */
function fakeProvider(
  routes: Record<string, ProviderRoute>,
  events: string[] = [],
): { fetchImpl: typeof fetch; calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: ProviderCall = {
      url,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      form: init?.body instanceof URLSearchParams ? init.body : null,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    events.push(`${call.method} ${url}`);
    const route = routes[url];
    if (!route) throw new Error(`unexpected provider request to ${url}`);
    return route(call);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const done = (): Response => json({});
const googleTokens = (): Response => json({ access_token: SECRETS.accessToken, expires_in: 3600 });
/** Microsoft rotates the refresh token with every exchange. */
const microsoftTokens = (): Response =>
  json({ access_token: SECRETS.accessToken, expires_in: 3600, refresh_token: SECRETS.rotatedRefreshToken });
/** A request that is never answered: it ends only when its signal aborts it. */
const neverAnswers: ProviderRoute = (call) =>
  new Promise<Response>((_resolve, reject) => {
    call.signal?.addEventListener("abort", () => reject(new Error(`aborted ${PROVIDER_ERROR_TEXT}`)));
  });

/** Google answering every call of a Gmail mailbox's cleanup; `overrides` replaces single answers. */
function googleRoutes(overrides: Record<string, ProviderRoute> = {}): Record<string, ProviderRoute> {
  return {
    [GOOGLE_TOKEN_URL]: googleTokens,
    [GMAIL_WATCH_STOP_URL]: done,
    [GOOGLE_TOKEN_REVOCATION_URL]: done,
    ...overrides,
  };
}

/** Microsoft answering every call of an Outlook mailbox's cleanup; `overrides` replaces single answers. */
function microsoftRoutes(overrides: Record<string, ProviderRoute> = {}): Record<string, ProviderRoute> {
  return {
    [MICROSOFT_TOKEN_URL]: microsoftTokens,
    [GRAPH_SUBSCRIPTION_URL]: () => new Response(null, { status: 204 }),
    ...overrides,
  };
}

interface MailboxFixture {
  /** The mailbox's `provider` property, which its user can edit. */
  provider: "gmail" | "outlook" | "generic";
  credential?: { type: CredentialType; plaintext: string };
  /** With a sync mode the mailbox gets its `mail_account_sync_state` row. The cleanup takes the provider from it. */
  syncMode?: SyncMode;
  gmailWatch?: boolean;
  /**
   * The Google account the row of a `gmail_api` mailbox records. Left out, it is an account of the
   * mailbox's own, so two mailboxes share an account only when a test names it. `null` records none,
   * which a mailbox with a recorded watch cannot be: a watch registration records its account.
   */
  gmailAccount?: string | null;
  graphSubscriptionId?: string;
}

const OAUTH_CREDENTIAL = { type: "oauth2_refresh_token", plaintext: SECRETS.refreshToken } as const;
const PASSWORD_CREDENTIAL = { type: "app_password", plaintext: SECRETS.password } as const;
const GMAIL_WITH_WATCH: MailboxFixture = {
  provider: "gmail",
  credential: OAUTH_CREDENTIAL,
  syncMode: "gmail_api",
  gmailWatch: true,
};
const OUTLOOK_WITH_SUBSCRIPTION: MailboxFixture = {
  provider: "outlook",
  credential: OAUTH_CREDENTIAL,
  syncMode: "graph_api",
  graphSubscriptionId: GRAPH_SUBSCRIPTION_ID,
};
const PASSWORD_MAILBOX: MailboxFixture = { provider: "generic", credential: PASSWORD_CREDENTIAL, syncMode: "imap" };

let admin: Pool;
let runtime: Pool;
let tenant: string;
let userId: string;
let roots: MailLiveSyncRoot[];
/** The mail logger's `warn`, spied on before every test so that each failure line of the cleanup is recorded. */
let warnings: { mock: { calls: unknown[][] } };
/** The mail logger's `info`, spied on the same way for the lines of the steps the cleanup skipped. */
let infos: { mock: { calls: unknown[][] } };

/** Runs `fn` in one transaction of `tenantId`, on the runtime role row-level security applies to. */
function inTenant<T>(fn: (client: PoolClient) => Promise<T>, tenantId = tenant): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

/** A mailbox as the connect flows and the lifecycles leave it, written through the stores that own each row. */
function createMailbox(fixture: MailboxFixture, tenantId = tenant): Promise<string> {
  return inTenant(async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    const mailbox = await createItemWithClient(client, {
      databaseId: mailboxesDatabaseId,
      properties: { name: `Mailbox ${randomUUID()}`, provider: fixture.provider },
    });
    if (fixture.credential) {
      await storeCredential(client, {
        itemId: mailbox.id,
        credentialType: fixture.credential.type,
        plaintext: fixture.credential.plaintext,
      });
    }
    if (fixture.syncMode) await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: fixture.syncMode });
    const gmailAccount = fixture.gmailAccount === undefined ? `${randomUUID()}@gmail.com` : fixture.gmailAccount;
    if (fixture.gmailWatch) {
      if (gmailAccount === null) throw new Error("a mailbox with a recorded watch records its Google account");
      await recordGmailWatchRegistration(client, mailbox.id, {
        historyId: "1",
        expiresAt: WATCH_EXPIRY,
        emailAddress: gmailAccount,
      });
    } else if (fixture.syncMode === "gmail_api" && gmailAccount !== null) {
      // What the OAuth connect flow stores with a new Gmail mailbox, before any watch is registered.
      await recordGmailWatchEmailAddress(client, mailbox.id, gmailAccount);
    }
    if (fixture.graphSubscriptionId) {
      await recordGraphSubscriptionRegistration(client, mailbox.id, {
        subscriptionId: fixture.graphSubscriptionId,
        expiresAt: WATCH_EXPIRY,
        clientState: "client-state",
      });
    }
    return mailbox.id;
  }, tenantId);
}

interface Hosting {
  root: MailLiveSyncRoot;
  /** The custom routes' `mailLiveSync` member, bound to `root` as the composition root binds it. */
  control: NonNullable<MailboxRemovalCleanupDependencies["mailLiveSync"]>;
  /** The mailbox ids whose lifecycle started and stopped, in order. */
  starts: string[];
  stops: string[];
}

/**
 * Hosts every live mailbox in a real live-sync root, after one discovery pass. A lifecycle's stop is
 * recorded in `stops` and, as `stop:<id>`, in `events`; it then waits for `stopGate` when there is one.
 */
async function hostLifecycles(events: string[] = [], stopGate?: Promise<void>): Promise<Hosting> {
  const starts: string[] = [];
  const stops: string[] = [];
  const root = createMailLiveSyncRoot(runtime, (account) => ({
    async start() {
      starts.push(account.mailboxItemId);
    },
    async stop() {
      stops.push(account.mailboxItemId);
      events.push(`stop:${account.mailboxItemId}`);
      await stopGate;
    },
  }));
  roots.push(root);
  await root.reconcileOnce();
  return {
    root,
    control: { stopMailbox: (tenantId, mailboxItemId) => root.stopMailbox(tenantId, mailboxItemId) },
    starts,
    stops,
  };
}

/** `DELETE /api/mail/mailboxes/:id` as a user of `tenantId`, the way the adapter calls it: inside the session's tenant. */
function removeThroughRoute(
  mailboxItemId: string,
  dependencies: MailboxRemovalCleanupDependencies,
  options: { cleanupStepTimeoutMs?: number; tenantId?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const handler = createMailboxRemovalRouteHandler(runtime, dependencies, options);
  return runInTenant(options.tenantId ?? tenant, () =>
    handler({ params: { id: mailboxItemId }, identity: { user: { id: userId } } }),
  );
}

/** Every argument of every log call the data layer's two loggers received, as text. */
function captureLogs(): () => string {
  const spies = [mailLogger, dbLogger].flatMap((target) =>
    (["trace", "debug", "info", "warn", "error", "fatal"] as const).map((level) => vi.spyOn(target, level)),
  );
  return () => spies.map((spy) => inspect(spy.mock.calls, { depth: 8 })).join("\n");
}

/** The first argument of every failure line the cleanup logged, in order. */
function cleanupFailures(): unknown[] {
  return warnings.mock.calls.filter((call) => call[1] === CLEANUP_FAILURE_MESSAGE).map((call) => call[0]);
}

/** The first argument of every line the cleanup logged for a step it skipped, in order. */
function cleanupSkips(): unknown[] {
  return infos.mock.calls.filter((call) => call[1] === CLEANUP_SKIP_MESSAGE).map((call) => call[0]);
}

function expectNoSecret(text: string, secrets: readonly string[] = [...Object.values(SECRETS), PROVIDER_ERROR_TEXT]) {
  expect(secrets.filter((secret) => text.includes(secret))).toEqual([]);
}

interface MailboxRows {
  trashed: boolean | null;
  credentials: number;
  syncStates: number;
}

const LIVE: MailboxRows = { trashed: false, credentials: 1, syncStates: 1 };
const REMOVED: MailboxRows = { trashed: true, credentials: 0, syncStates: 0 };

/** Whether the mailbox is in the trash and how many of its secret-bearing rows exist, read in `tenantId`. */
function mailboxRows(mailboxItemId: string, tenantId = tenant): Promise<MailboxRows[]> {
  return inTenant(async (client) => {
    const { rows } = await client.query<MailboxRows>(
      `SELECT (SELECT deleted_at IS NOT NULL FROM items WHERE id = $1) AS trashed,
              (SELECT count(*)::int FROM external_credentials WHERE item_id = $1) AS credentials,
              (SELECT count(*)::int FROM mail_account_sync_state WHERE item_id = $1) AS "syncStates"`,
      [mailboxItemId],
    );
    return rows;
  }, tenantId);
}

interface AccessLogRow {
  actor_type: string;
  actor_id: string | null;
  purpose: string;
}

/** The decryptions of the mailbox's credential on record, read in `tenantId`. */
function accessLog(mailboxItemId: string, tenantId = tenant): Promise<AccessLogRow[]> {
  return inTenant(async (client) => {
    const { rows } = await client.query<AccessLogRow>(
      "SELECT actor_type, actor_id, purpose FROM credential_access_log WHERE item_id = $1 ORDER BY id",
      [mailboxItemId],
    );
    return rows;
  }, tenantId);
}

/**
 * The tables in which some row holds `needle` in any column, read as the superuser so that every
 * tenant's rows and the queue's own tables, with their job payloads, are searched alike. Postgres
 * builds each statement from its own catalog with `format('%I')`, and `needle` is a bind parameter.
 */
async function tablesHolding(needle: string): Promise<string[]> {
  const statements = await admin.query<{ name: string; sql: string }>(
    `SELECT format('%s.%s', schemaname, tablename) AS name,
            format('SELECT count(*)::int AS hits FROM %I.%I AS t WHERE strpos(t::text, $1) > 0', schemaname, tablename) AS sql
       FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1`,
  );
  const holding: string[] = [];
  for (const statement of statements.rows) {
    const { rows } = await admin.query<{ hits: number }>(statement.sql, [needle]);
    if ((rows[0]?.hits ?? 0) > 0) holding.push(statement.name);
  }
  return holding;
}

/**
 * Makes one statement of the removal fail until the returned function runs: every insert into
 * `credential_access_log`, or every delete from `external_credentials`. A trigger is the only way to
 * fail one statement of the removal's transaction; no production code exposes that seam.
 */
async function failStatement(statement: "accessLogInsert" | "credentialDelete"): Promise<() => Promise<void>> {
  await admin.query(`CREATE FUNCTION test_mailbox_cleanup_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test mailbox cleanup failure'; END $$`);
  // Two fixed statements, chosen by a closed literal: CREATE TRIGGER accepts no bind parameters.
  await admin.query(
    statement === "accessLogInsert"
      ? "CREATE TRIGGER test_mailbox_cleanup_fail BEFORE INSERT ON credential_access_log FOR EACH ROW EXECUTE FUNCTION test_mailbox_cleanup_fail()"
      : "CREATE TRIGGER test_mailbox_cleanup_fail BEFORE DELETE ON external_credentials FOR EACH ROW EXECUTE FUNCTION test_mailbox_cleanup_fail()",
  );
  return async () => {
    await admin.query(
      statement === "accessLogInsert"
        ? "DROP TRIGGER test_mailbox_cleanup_fail ON credential_access_log"
        : "DROP TRIGGER test_mailbox_cleanup_fail ON external_credentials",
    );
    await admin.query("DROP FUNCTION test_mailbox_cleanup_fail()");
  };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("mailbox removal cleanup outside the database (gh-2030)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    await seedSystem(admin);
    tenant = getTenantZeroId();
    userId = randomUUID();
    roots = [];
    warnings = vi.spyOn(mailLogger, "warn");
    infos = vi.spyOn(mailLogger, "info");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const root of roots) await root.stop();
  });

  afterAll(async () => {
    await runtime?.end();
    await admin?.end();
  });

  describe("the hosted live-sync lifecycle", () => {
    it("is stopped before the route answers, without a discovery pass, and no later pass hosts the removed mailbox again", async () => {
      const removed = await createMailbox(PASSWORD_MAILBOX);
      const kept = await createMailbox(PASSWORD_MAILBOX);
      const hosting = await hostLifecycles();
      expect([...hosting.starts].sort()).toEqual([removed, kept].sort());

      const answer = await removeThroughRoute(removed, { mailLiveSync: hosting.control });

      expect(answer).toEqual({ status: 200, body: { id: removed } });
      expect(hosting.stops).toEqual([removed]);
      expect(cleanupFailures()).toEqual([]);

      await hosting.root.reconcileOnce();
      expect(hosting.starts.filter((id) => id === removed)).toHaveLength(1);
      expect(hosting.stops).toEqual([removed]);
    });

    it("of another tenant's mailbox is left running by a request that finds no mailbox, which calls no provider and reads no credential", async () => {
      const other = await createTestTenant(admin);
      await provisionTenant(runtime, other);
      const foreign = await createMailbox(GMAIL_WITH_WATCH);
      const hosting = await hostLifecycles();
      const provider = fakeProvider(googleRoutes());
      const dependencies = { oauth: OAUTH, mailLiveSync: hosting.control, outboundHttp: provider.fetchImpl };

      await expect(removeThroughRoute(foreign, dependencies, { tenantId: other })).rejects.toBeInstanceOf(
        NotFoundError,
      );

      expect(hosting.stops).toEqual([]);
      expect(provider.calls).toEqual([]);
      expect(await accessLog(foreign)).toEqual([]);
      expect(await mailboxRows(foreign)).toEqual([LIVE]);

      // The owning tenant's request is the allowed side: it removes the mailbox and cleans it up.
      expect(await removeThroughRoute(foreign, dependencies)).toEqual({ status: 200, body: { id: foreign } });
      expect(hosting.stops).toEqual([foreign]);
      expect(provider.calls.map((call) => call.url)).toEqual([
        GOOGLE_TOKEN_URL,
        GMAIL_WATCH_STOP_URL,
        GOOGLE_TOKEN_REVOCATION_URL,
      ]);
    });
  });

  describe("a Gmail mailbox", () => {
    it("has its watch stopped and then its token revoked, after its lifecycle stopped", async () => {
      const mailbox = await createMailbox(GMAIL_WITH_WATCH);
      const events: string[] = [];
      const hosting = await hostLifecycles(events);
      const provider = fakeProvider(googleRoutes(), events);

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(events).toEqual([
        `stop:${mailbox}`,
        `POST ${GOOGLE_TOKEN_URL}`,
        `POST ${GMAIL_WATCH_STOP_URL}`,
        `POST ${GOOGLE_TOKEN_REVOCATION_URL}`,
      ]);
      const [exchange, watchStop, revocation] = provider.calls;
      expect(Object.fromEntries(exchange?.form ?? [])).toEqual({
        grant_type: "refresh_token",
        refresh_token: SECRETS.refreshToken,
        client_id: OAUTH.gmail.clientId,
        client_secret: OAUTH.gmail.clientSecret,
      });
      expect(watchStop?.authorization).toBe(`Bearer ${SECRETS.accessToken}`);
      // The token is the body of the revocation, and nothing else of the request carries it.
      expect(Object.fromEntries(revocation?.form ?? [])).toEqual({ token: SECRETS.refreshToken });
      expect(revocation?.authorization).toBeNull();
      // Every request was ended once it was answered.
      expect(provider.calls.map((call) => call.signal?.aborted)).toEqual([true, true, true]);
      expect(cleanupFailures()).toEqual([]);
      expect(cleanupSkips()).toEqual([]);
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
      expect(await accessLog(mailbox)).toEqual([{ actor_type: "user", actor_id: userId, purpose: "mailbox_removal" }]);
    });

    it("without a recorded watch has its token revoked and no watch call made", async () => {
      const mailbox = await createMailbox({ provider: "gmail", credential: OAUTH_CREDENTIAL, syncMode: "gmail_api" });
      const hosting = await hostLifecycles();
      const provider = fakeProvider(googleRoutes());

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_REVOCATION_URL]);
      expect(hosting.stops).toEqual([mailbox]);
      expect(cleanupFailures()).toEqual([]);
      expect(cleanupSkips()).toEqual([]);
    });
  });

  describe("a Gmail mailbox whose Google account is not its own alone", () => {
    it("leaves the account alone while another tenant's mailbox records it: no call at Google, no token read, the same answer, and the last mailbox ends the grant", async () => {
      const other = await createTestTenant(admin);
      await provisionTenant(runtime, other);
      const account = `${randomUUID()}@gmail.com`;
      const removed = await createMailbox({ ...GMAIL_WITH_WATCH, gmailAccount: account });
      const kept = await createMailbox({ ...GMAIL_WITH_WATCH, gmailAccount: account }, other);
      const events: string[] = [];
      const hosting = await hostLifecycles(events);
      const provider = fakeProvider(googleRoutes(), events);
      const dependencies = { oauth: OAUTH, mailLiveSync: hosting.control, outboundHttp: provider.fetchImpl };

      const answer = await removeThroughRoute(removed, dependencies);

      // The answer is the one of every removal, and only the removed mailbox's lifecycle was stopped.
      expect(answer).toEqual({ status: 200, body: { id: removed } });
      expect(events).toEqual([`stop:${removed}`]);
      expect(cleanupFailures()).toEqual([]);
      expect(cleanupSkips()).toEqual([
        { mailboxItemId: removed, step: "gmailWatchStop", classification: "accountShared" },
        { mailboxItemId: removed, step: "tokenRevocation", classification: "accountShared" },
      ]);
      expect(await accessLog(removed)).toEqual([]);
      expect(await mailboxRows(removed)).toEqual([REMOVED]);
      expect(await mailboxRows(kept, other)).toEqual([LIVE]);
      expect(await accessLog(kept, other)).toEqual([]);

      // The other tenant's mailbox is now the only one on the account, so its removal ends the grant.
      const last = await removeThroughRoute(kept, dependencies, { tenantId: other });

      expect(last).toEqual({ status: 200, body: { id: kept } });
      expect(events).toEqual([
        `stop:${removed}`,
        `stop:${kept}`,
        `POST ${GOOGLE_TOKEN_URL}`,
        `POST ${GMAIL_WATCH_STOP_URL}`,
        `POST ${GOOGLE_TOKEN_REVOCATION_URL}`,
      ]);
      expect(cleanupSkips()).toHaveLength(2);
      expect(await mailboxRows(kept, other)).toEqual([REMOVED]);
    });

    it("leaves the account alone while another mailbox of the same tenant records it, and skips only the revocation of a mailbox without a watch", async () => {
      const account = `${randomUUID()}@gmail.com`;
      const withoutWatch: MailboxFixture = {
        provider: "gmail",
        credential: OAUTH_CREDENTIAL,
        syncMode: "gmail_api",
        gmailAccount: account,
      };
      const first = await createMailbox(withoutWatch);
      const second = await createMailbox(withoutWatch);
      const hosting = await hostLifecycles();
      const provider = fakeProvider(googleRoutes());
      const dependencies = { oauth: OAUTH, mailLiveSync: hosting.control, outboundHttp: provider.fetchImpl };

      expect(await removeThroughRoute(first, dependencies)).toEqual({ status: 200, body: { id: first } });

      expect(provider.calls).toEqual([]);
      expect(cleanupSkips()).toEqual([
        { mailboxItemId: first, step: "tokenRevocation", classification: "accountShared" },
      ]);
      expect(await accessLog(first)).toEqual([]);
      expect(await mailboxRows(second)).toEqual([LIVE]);

      expect(await removeThroughRoute(second, dependencies)).toEqual({ status: 200, body: { id: second } });

      expect(provider.calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_REVOCATION_URL]);
      expect(cleanupSkips()).toHaveLength(1);
      expect(cleanupFailures()).toEqual([]);
      expect(hosting.stops).toEqual([first, second]);
    });

    it("leaves the account alone when the mailbox's row records none, because another mailbox may depend on it", async () => {
      const mailbox = await createMailbox({
        provider: "gmail",
        credential: OAUTH_CREDENTIAL,
        syncMode: "gmail_api",
        gmailAccount: null,
      });
      const hosting = await hostLifecycles();
      const provider = fakeProvider(googleRoutes());

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls).toEqual([]);
      expect(cleanupSkips()).toEqual([
        { mailboxItemId: mailbox, step: "tokenRevocation", classification: "accountUnknown" },
      ]);
      expect(cleanupFailures()).toEqual([]);
      expect(await accessLog(mailbox)).toEqual([]);
      expect(hosting.stops).toEqual([mailbox]);
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
    });
  });

  describe("getGmailAccountUse", () => {
    it("answers unknown for a mailbox without a sync state row and for another tenant's mailbox, whose row it cannot read", async () => {
      const other = await createTestTenant(admin);
      await provisionTenant(runtime, other);
      const mailbox = await createMailbox(GMAIL_WITH_WATCH);

      expect(await inTenant((client) => getGmailAccountUse(client, randomUUID()))).toBe("unknown");
      expect(await inTenant((client) => getGmailAccountUse(client, mailbox), other)).toBe("unknown");
      // The owning tenant reads its own row, so the answers above are not the lookup failing.
      expect(await inTenant((client) => getGmailAccountUse(client, mailbox))).toBe("sole");
    });
  });

  describe("an Outlook mailbox", () => {
    it("has its Graph subscription deleted with a token of its grant, and no revocation call made", async () => {
      const mailbox = await createMailbox(OUTLOOK_WITH_SUBSCRIPTION);
      const events: string[] = [];
      const hosting = await hostLifecycles(events);
      const provider = fakeProvider({ ...googleRoutes(), ...microsoftRoutes() }, events);

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(events).toEqual([`stop:${mailbox}`, `POST ${MICROSOFT_TOKEN_URL}`, `DELETE ${GRAPH_SUBSCRIPTION_URL}`]);
      const [exchange, subscriptionDelete] = provider.calls;
      expect(Object.fromEntries(exchange?.form ?? [])).toEqual({
        grant_type: "refresh_token",
        refresh_token: SECRETS.refreshToken,
        client_id: OAUTH.msGraph.clientId,
        client_secret: OAUTH.msGraph.clientSecret,
      });
      expect(subscriptionDelete?.authorization).toBe(`Bearer ${SECRETS.accessToken}`);
      expect(cleanupFailures()).toEqual([]);
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
      // The refresh token Microsoft rotated with the exchange is dropped, not stored.
      expect(await tablesHolding(SECRETS.rotatedRefreshToken)).toEqual([]);
    });

    it("whose subscription Graph no longer has (404) is cleaned up without a failure", async () => {
      const mailbox = await createMailbox(OUTLOOK_WITH_SUBSCRIPTION);
      const provider = fakeProvider(
        microsoftRoutes({ [GRAPH_SUBSCRIPTION_URL]: () => json({ error: { code: "ResourceNotFound" } }, 404) }),
      );
      const hosting = await hostLifecycles();

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls.map((call) => call.url)).toEqual([MICROSOFT_TOKEN_URL, GRAPH_SUBSCRIPTION_URL]);
      expect(cleanupFailures()).toEqual([]);
    });

    it("without a recorded subscription has no provider call made and its credential not read", async () => {
      const mailbox = await createMailbox({ provider: "outlook", credential: OAUTH_CREDENTIAL, syncMode: "graph_api" });
      const hosting = await hostLifecycles();
      const provider = fakeProvider({ ...googleRoutes(), ...microsoftRoutes() });

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls).toEqual([]);
      expect(await accessLog(mailbox)).toEqual([]);
      expect(hosting.stops).toEqual([mailbox]);
      expect(cleanupFailures()).toEqual([]);
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
    });
  });

  describe("the provider is the one the sync mode names, whatever the mailbox's `provider` property says", () => {
    it("an Outlook mailbox relabelled gmail has its subscription deleted at Microsoft, and Google receives nothing", async () => {
      const mailbox = await createMailbox({ ...OUTLOOK_WITH_SUBSCRIPTION, provider: "gmail" });
      const hosting = await hostLifecycles();
      const provider = fakeProvider({ ...googleRoutes(), ...microsoftRoutes() });

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls.map((call) => call.url)).toEqual([MICROSOFT_TOKEN_URL, GRAPH_SUBSCRIPTION_URL]);
      expect(provider.calls[0]?.form?.get("client_id")).toBe(OAUTH.msGraph.clientId);
      expect(cleanupFailures()).toEqual([]);
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
    });

    it("a Gmail mailbox relabelled outlook has its watch stopped and its token revoked at Google, and Microsoft receives nothing", async () => {
      const mailbox = await createMailbox({ ...GMAIL_WITH_WATCH, provider: "outlook" });
      const hosting = await hostLifecycles();
      const provider = fakeProvider({ ...googleRoutes(), ...microsoftRoutes() });

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls.map((call) => call.url)).toEqual([
        GOOGLE_TOKEN_URL,
        GMAIL_WATCH_STOP_URL,
        GOOGLE_TOKEN_REVOCATION_URL,
      ]);
      expect(provider.calls[0]?.form?.get("client_id")).toBe(OAUTH.gmail.clientId);
      expect(cleanupFailures()).toEqual([]);
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
    });
  });

  describe("a mailbox with no work at the provider", () => {
    it.each<[string, MailboxFixture]>([
      ["a password mailbox", PASSWORD_MAILBOX],
      [
        "a mailbox labelled gmail that syncs through IMAP, whatever its credential's type",
        { provider: "gmail", credential: OAUTH_CREDENTIAL, syncMode: "imap" },
      ],
      [
        "a mailbox that syncs through the Gmail API and holds an app password",
        { provider: "gmail", credential: PASSWORD_CREDENTIAL, syncMode: "gmail_api", gmailWatch: true },
      ],
      [
        "a mailbox that syncs through Graph, has a subscription recorded and holds an app password",
        {
          provider: "outlook",
          credential: PASSWORD_CREDENTIAL,
          syncMode: "graph_api",
          graphSubscriptionId: GRAPH_SUBSCRIPTION_ID,
        },
      ],
      [
        "a mailbox that syncs through IMAP and has a Graph subscription id on its sync state row",
        {
          provider: "outlook",
          credential: OAUTH_CREDENTIAL,
          syncMode: "imap",
          graphSubscriptionId: GRAPH_SUBSCRIPTION_ID,
        },
      ],
      ["a mailbox labelled gmail that never connected", { provider: "gmail" }],
    ])("%s has its lifecycle stopped, no provider call made and no credential read", async (_name, fixture) => {
      const mailbox = await createMailbox(fixture);
      const hosting = await hostLifecycles();
      const provider = fakeProvider({ ...googleRoutes(), ...microsoftRoutes() });

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls).toEqual([]);
      expect(await accessLog(mailbox)).toEqual([]);
      expect(hosting.stops).toEqual([mailbox]);
      expect(cleanupFailures()).toEqual([]);
      expect((await mailboxRows(mailbox))[0]).toMatchObject({ trashed: true, credentials: 0 });
    });
  });

  describe("a mailbox without a sync state row", () => {
    it("has no provider call made and its refresh token not read, though it is labelled gmail", async () => {
      // No discovery pass runs here: a pass would seed the row with the sync mode of the label.
      const mailbox = await createMailbox({ provider: "gmail", credential: OAUTH_CREDENTIAL });
      expect((await mailboxRows(mailbox))[0]).toMatchObject({ credentials: 1, syncStates: 0 });
      const stopMailbox = vi.fn(async (_tenantId: string, _mailboxItemId: string) => {});
      const provider = fakeProvider({ ...googleRoutes(), ...microsoftRoutes() });

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: { stopMailbox },
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls).toEqual([]);
      expect(await accessLog(mailbox)).toEqual([]);
      expect(stopMailbox.mock.calls).toEqual([[tenant, mailbox]]);
      expect(cleanupFailures()).toEqual([]);
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
    });
  });

  describe("a failing step", () => {
    interface FailureCase {
      name: string;
      fixture: MailboxFixture;
      routes: Record<string, ProviderRoute>;
      /** The container's OAuth clients; left out when the composition root configured none. */
      oauth?: MailboxRemovalCleanupDependencies["oauth"];
      /** The URLs called, in order: the steps after the failing one are among them. */
      calls: string[];
      failures: Array<{ step: string; classification: string }>;
    }

    const rejects =
      (message: string): ProviderRoute =>
      () =>
        Promise.reject(new Error(message));

    const cases: FailureCase[] = [
      {
        name: "Gmail refuses the watch stop",
        fixture: GMAIL_WITH_WATCH,
        routes: googleRoutes({ [GMAIL_WATCH_STOP_URL]: () => json({ error: PROVIDER_ERROR_TEXT }, 403) }),
        oauth: OAUTH,
        calls: [GOOGLE_TOKEN_URL, GMAIL_WATCH_STOP_URL, GOOGLE_TOKEN_REVOCATION_URL],
        failures: [{ step: "gmailWatchStop", classification: "providerRejected" }],
      },
      {
        name: "Google refuses the refresh token in the exchange and in the revocation",
        fixture: GMAIL_WITH_WATCH,
        routes: googleRoutes({
          [GOOGLE_TOKEN_URL]: () => json({ error: "invalid_grant", error_description: PROVIDER_ERROR_TEXT }, 400),
          [GOOGLE_TOKEN_REVOCATION_URL]: () => json({ error: "invalid_token", detail: PROVIDER_ERROR_TEXT }, 400),
        }),
        oauth: OAUTH,
        calls: [GOOGLE_TOKEN_URL, GOOGLE_TOKEN_REVOCATION_URL],
        failures: [
          { step: "gmailWatchStop", classification: "providerRejected" },
          { step: "tokenRevocation", classification: "providerRejected" },
        ],
      },
      {
        name: "the token exchange fails on the network",
        fixture: GMAIL_WITH_WATCH,
        routes: googleRoutes({
          [GOOGLE_TOKEN_URL]: rejects(
            `connect failed for refresh_token=${SECRETS.refreshToken} ${PROVIDER_ERROR_TEXT}`,
          ),
        }),
        oauth: OAUTH,
        calls: [GOOGLE_TOKEN_URL, GOOGLE_TOKEN_REVOCATION_URL],
        failures: [{ step: "gmailWatchStop", classification: "failed" }],
      },
      {
        name: "Google answers the token exchange with a 503",
        fixture: GMAIL_WITH_WATCH,
        routes: googleRoutes({ [GOOGLE_TOKEN_URL]: () => json({ error: PROVIDER_ERROR_TEXT }, 503) }),
        oauth: OAUTH,
        calls: [GOOGLE_TOKEN_URL, GOOGLE_TOKEN_REVOCATION_URL],
        failures: [{ step: "gmailWatchStop", classification: "providerRejected" }],
      },
      {
        name: "Google answers the token exchange with a 200 that holds no access token",
        fixture: GMAIL_WITH_WATCH,
        routes: googleRoutes({ [GOOGLE_TOKEN_URL]: () => json({ detail: PROVIDER_ERROR_TEXT }) }),
        oauth: OAUTH,
        calls: [GOOGLE_TOKEN_URL, GOOGLE_TOKEN_REVOCATION_URL],
        failures: [{ step: "gmailWatchStop", classification: "failed" }],
      },
      {
        name: "the watch stop and the revocation fail on the network",
        fixture: GMAIL_WITH_WATCH,
        routes: googleRoutes({
          [GMAIL_WATCH_STOP_URL]: rejects(`socket hang up, Bearer ${SECRETS.accessToken} ${PROVIDER_ERROR_TEXT}`),
          [GOOGLE_TOKEN_REVOCATION_URL]: rejects(`reset while sending token=${SECRETS.refreshToken}`),
        }),
        oauth: OAUTH,
        calls: [GOOGLE_TOKEN_URL, GMAIL_WATCH_STOP_URL, GOOGLE_TOKEN_REVOCATION_URL],
        failures: [
          { step: "gmailWatchStop", classification: "failed" },
          { step: "tokenRevocation", classification: "failed" },
        ],
      },
      {
        name: "the composition root configured no Gmail OAuth client",
        fixture: GMAIL_WITH_WATCH,
        routes: googleRoutes(),
        calls: [GOOGLE_TOKEN_REVOCATION_URL],
        failures: [{ step: "gmailWatchStop", classification: "notConfigured" }],
      },
      {
        name: "Graph refuses the subscription delete",
        fixture: OUTLOOK_WITH_SUBSCRIPTION,
        routes: microsoftRoutes({ [GRAPH_SUBSCRIPTION_URL]: () => json({ error: PROVIDER_ERROR_TEXT }, 500) }),
        oauth: OAUTH,
        calls: [MICROSOFT_TOKEN_URL, GRAPH_SUBSCRIPTION_URL],
        failures: [{ step: "graphSubscriptionDelete", classification: "providerRejected" }],
      },
      {
        name: "Microsoft answers the token exchange with a 429",
        fixture: OUTLOOK_WITH_SUBSCRIPTION,
        routes: microsoftRoutes({ [MICROSOFT_TOKEN_URL]: () => json({ error: PROVIDER_ERROR_TEXT }, 429) }),
        oauth: OAUTH,
        calls: [MICROSOFT_TOKEN_URL],
        failures: [{ step: "graphSubscriptionDelete", classification: "providerRejected" }],
      },
      {
        name: "the Microsoft token exchange fails on the network",
        fixture: OUTLOOK_WITH_SUBSCRIPTION,
        routes: microsoftRoutes({ [MICROSOFT_TOKEN_URL]: rejects(`connect failed ${PROVIDER_ERROR_TEXT}`) }),
        oauth: OAUTH,
        calls: [MICROSOFT_TOKEN_URL],
        failures: [{ step: "graphSubscriptionDelete", classification: "failed" }],
      },
      {
        name: "the composition root configured no Graph OAuth client",
        fixture: OUTLOOK_WITH_SUBSCRIPTION,
        routes: microsoftRoutes(),
        oauth: { gmail: OAUTH.gmail },
        calls: [],
        failures: [{ step: "graphSubscriptionDelete", classification: "notConfigured" }],
      },
    ];

    it.each(cases)(
      "leaves the removal a success and logs only the classification when $name",
      async ({ fixture, routes, oauth, calls, failures }) => {
        const logs = captureLogs();
        const mailbox = await createMailbox(fixture);
        const hosting = await hostLifecycles();
        const provider = fakeProvider(routes);

        const answer = await removeThroughRoute(mailbox, {
          ...(oauth ? { oauth } : {}),
          mailLiveSync: hosting.control,
          outboundHttp: provider.fetchImpl,
        });

        expect(answer).toEqual({ status: 200, body: { id: mailbox } });
        expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
        expect(hosting.stops).toEqual([mailbox]);
        expect(provider.calls.map((call) => call.url)).toEqual(calls);
        expect(cleanupFailures()).toEqual(failures.map((failure) => ({ mailboxItemId: mailbox, ...failure })));
        expectNoSecret(logs());
      },
    );

    it("of the live-sync control is reported, and the steps at the provider still run", async () => {
      const logs = captureLogs();
      const mailbox = await createMailbox(GMAIL_WITH_WATCH);
      const provider = fakeProvider(googleRoutes());
      const refusingControl = {
        stopMailbox: () => Promise.reject(new Error(`the control failed: ${PROVIDER_ERROR_TEXT}`)),
      };

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: refusingControl,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls.map((call) => call.url)).toEqual([
        GOOGLE_TOKEN_URL,
        GMAIL_WATCH_STOP_URL,
        GOOGLE_TOKEN_REVOCATION_URL,
      ]);
      expect(cleanupFailures()).toEqual([{ mailboxItemId: mailbox, step: "liveSyncStop", classification: "failed" }]);
      expectNoSecret(logs());
    });

    it("is reported as notConfigured for the live-sync stop when the removal is given no dependencies", async () => {
      const mailbox = await createMailbox(PASSWORD_MAILBOX);

      const removed = await runInTenant(tenant, () =>
        removeMailbox(runtime, mailbox, { queueAffinity: createActionQueueAffinity() }),
      );

      expect(removed).toBe(true);
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
      expect(cleanupFailures()).toEqual([
        { mailboxItemId: mailbox, step: "liveSyncStop", classification: "notConfigured" },
      ]);
    });

    it("is reported as failed for the live-sync stop when the cleanup runs outside a tenant scope, and stops no lifecycle", async () => {
      const stopMailbox = vi.fn(async () => {});
      const mailboxItemId = randomUUID();

      await runAsSystem("test:mailbox-removal-cleanup", () =>
        cleanUpRemovedMailbox({ mailboxItemId, provider: null }, { mailLiveSync: { stopMailbox } }),
      );

      expect(stopMailbox).not.toHaveBeenCalled();
      expect(cleanupFailures()).toEqual([{ mailboxItemId, step: "liveSyncStop", classification: "failed" }]);
    });
  });

  describe("a step that does not finish in time", () => {
    it("at the provider is ended and reported as timeout, and the next step still runs", async () => {
      const logs = captureLogs();
      const mailbox = await createMailbox(GMAIL_WITH_WATCH);
      const hosting = await hostLifecycles();
      const provider = fakeProvider(googleRoutes({ [GMAIL_WATCH_STOP_URL]: neverAnswers }));

      const answer = await removeThroughRoute(
        mailbox,
        { oauth: OAUTH, mailLiveSync: hosting.control, outboundHttp: provider.fetchImpl },
        { cleanupStepTimeoutMs: 50 },
      );

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(provider.calls.map((call) => call.url)).toEqual([
        GOOGLE_TOKEN_URL,
        GMAIL_WATCH_STOP_URL,
        GOOGLE_TOKEN_REVOCATION_URL,
      ]);
      expect(provider.calls[1]?.signal?.aborted).toBe(true);
      expect(cleanupFailures()).toEqual([
        { mailboxItemId: mailbox, step: "gmailWatchStop", classification: "timeout" },
      ]);
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
      expectNoSecret(logs());
    });

    it("in the token exchange, which ends at its own limit of 15 seconds, is reported as timeout, and the next step still runs", async () => {
      const logs = captureLogs();
      const mailboxItemId = randomUUID();
      const provider = fakeProvider(googleRoutes({ [GOOGLE_TOKEN_URL]: neverAnswers }));
      // The exchange's limit is fixed, so the clock is advanced. The cleanup is called with the input
      // the removal hands it, because a removal needs the database and its real timers.
      vi.useFakeTimers();
      try {
        const cleanup = runInTenant(tenant, () =>
          cleanUpRemovedMailbox(
            {
              mailboxItemId,
              provider: { provider: "gmail", refreshToken: SECRETS.refreshToken, watchRegistered: true },
            },
            { oauth: OAUTH, mailLiveSync: { stopMailbox: async () => {} }, outboundHttp: provider.fetchImpl },
          ),
        );
        await vi.advanceTimersByTimeAsync(14_999);
        expect(provider.calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_URL]);
        expect(provider.calls[0]?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await cleanup;
      } finally {
        vi.useRealTimers();
      }

      expect(provider.calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_URL, GOOGLE_TOKEN_REVOCATION_URL]);
      expect(provider.calls[0]?.signal?.aborted).toBe(true);
      expect(cleanupFailures()).toEqual([{ mailboxItemId, step: "gmailWatchStop", classification: "timeout" }]);
      expectNoSecret(logs());
    });

    it("in the live-sync root is reported as timeout while the stop goes on, and the steps at the provider still run", async () => {
      const mailbox = await createMailbox(GMAIL_WITH_WATCH);
      const stopping = gate();
      const hosting = await hostLifecycles([], stopping.promise);
      const provider = fakeProvider(googleRoutes());

      const answer = await removeThroughRoute(
        mailbox,
        { oauth: OAUTH, mailLiveSync: hosting.control, outboundHttp: provider.fetchImpl },
        { cleanupStepTimeoutMs: 50 },
      );

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      // The lifecycle's stop was called and is still running.
      expect(hosting.stops).toEqual([mailbox]);
      expect(provider.calls.map((call) => call.url)).toEqual([
        GOOGLE_TOKEN_URL,
        GMAIL_WATCH_STOP_URL,
        GOOGLE_TOKEN_REVOCATION_URL,
      ]);
      expect(cleanupFailures()).toEqual([{ mailboxItemId: mailbox, step: "liveSyncStop", classification: "timeout" }]);
      stopping.release();
    });
  });

  describe("the mailbox's refresh token", () => {
    it("that cannot be decrypted does not fail the removal: its lifecycle is stopped and the steps that need it are reported", async () => {
      const mailbox = await createMailbox(GMAIL_WITH_WATCH);
      // No production write stores a credential that cannot be opened again: flip one byte of the ciphertext.
      await admin.query(
        "UPDATE external_credentials SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) WHERE item_id = $1",
        [mailbox],
      );
      await expect(
        inTenant((client) =>
          getDecryptedCredential(client, { itemId: mailbox, actorType: "sync_worker", purpose: "test" }),
        ),
      ).rejects.toThrow();
      const hosting = await hostLifecycles();
      const provider = fakeProvider(googleRoutes());

      const answer = await removeThroughRoute(mailbox, {
        oauth: OAUTH,
        mailLiveSync: hosting.control,
        outboundHttp: provider.fetchImpl,
      });

      expect(answer).toEqual({ status: 200, body: { id: mailbox } });
      expect(await mailboxRows(mailbox)).toEqual([REMOVED]);
      expect(hosting.stops).toEqual([mailbox]);
      expect(provider.calls).toEqual([]);
      expect(cleanupFailures()).toEqual([
        { mailboxItemId: mailbox, step: "gmailWatchStop", classification: "credentialUnavailable" },
        { mailboxItemId: mailbox, step: "tokenRevocation", classification: "credentialUnavailable" },
      ]);
    });

    it("whose read fails a statement fails the removal with that error, which rolls back and runs no cleanup", async () => {
      const mailbox = await createMailbox(GMAIL_WITH_WATCH);
      const hosting = await hostLifecycles();
      const provider = fakeProvider(googleRoutes());

      const restore = await failStatement("accessLogInsert");
      try {
        await expect(
          removeThroughRoute(mailbox, {
            oauth: OAUTH,
            mailLiveSync: hosting.control,
            outboundHttp: provider.fetchImpl,
          }),
        ).rejects.toThrow("test mailbox cleanup failure");
      } finally {
        await restore();
      }

      expect(await mailboxRows(mailbox)).toEqual([LIVE]);
      expect(hosting.stops).toEqual([]);
      expect(provider.calls).toEqual([]);
      expect(cleanupFailures()).toEqual([]);
    });

    it("is read in the removal's transaction: a removal that rolls back after the read leaves no access on record and runs no cleanup", async () => {
      const mailbox = await createMailbox(GMAIL_WITH_WATCH);
      const hosting = await hostLifecycles();
      const provider = fakeProvider(googleRoutes());

      const restore = await failStatement("credentialDelete");
      try {
        await expect(
          removeThroughRoute(mailbox, {
            oauth: OAUTH,
            mailLiveSync: hosting.control,
            outboundHttp: provider.fetchImpl,
          }),
        ).rejects.toThrow("test mailbox cleanup failure");
      } finally {
        await restore();
      }

      expect(await mailboxRows(mailbox)).toEqual([LIVE]);
      expect(await accessLog(mailbox)).toEqual([]);
      expect(hosting.stops).toEqual([]);
      expect(provider.calls).toEqual([]);
    });

    it("appears in no log, no row and no job payload, after a cleanup that succeeded and one whose provider echoed it", async () => {
      const logs = captureLogs();
      const cleaned = await createMailbox(GMAIL_WITH_WATCH);
      const failing = await createMailbox(OUTLOOK_WITH_SUBSCRIPTION);
      const hosting = await hostLifecycles();
      const echo = `refresh_token=${SECRETS.refreshToken} Bearer ${SECRETS.accessToken}`;
      const provider = fakeProvider({
        ...googleRoutes(),
        ...microsoftRoutes({ [GRAPH_SUBSCRIPTION_URL]: () => Promise.reject(new Error(echo)) }),
      });
      const dependencies = { oauth: OAUTH, mailLiveSync: hosting.control, outboundHttp: provider.fetchImpl };

      const answers = [
        await removeThroughRoute(cleaned, dependencies),
        await removeThroughRoute(failing, dependencies),
      ];

      expect(answers).toEqual([
        { status: 200, body: { id: cleaned } },
        { status: 200, body: { id: failing } },
      ]);
      expect(cleanupFailures()).toEqual([
        { mailboxItemId: failing, step: "graphSubscriptionDelete", classification: "failed" },
      ]);
      expectNoSecret(logs());
      expectNoSecret(JSON.stringify(answers));
      for (const secret of [SECRETS.refreshToken, SECRETS.accessToken, SECRETS.rotatedRefreshToken]) {
        expect(await tablesHolding(secret)).toEqual([]);
      }
      // The search finds what is stored: the removed mailbox's id is in its item row, in the access
      // log and in the payload of the job the removal queued.
      const holdingTheId = await tablesHolding(cleaned);
      expect(holdingTheId).toContain("public.credential_access_log");
      expect(holdingTheId.some((table) => table.startsWith("graphile_worker."))).toBe(true);
    });
  });

  describe("getCredentialType", () => {
    it("answers the stored credential's type, and null for an item without one, and records no access", async () => {
      const oauth = await createMailbox({ provider: "gmail", credential: OAUTH_CREDENTIAL });
      const password = await createMailbox({ provider: "generic", credential: PASSWORD_CREDENTIAL });
      const bare = await createMailbox({ provider: "generic" });

      const types = await inTenant(async (client) => [
        await getCredentialType(client, oauth),
        await getCredentialType(client, password),
        await getCredentialType(client, bare),
      ]);

      expect(types).toEqual(["oauth2_refresh_token", "app_password", null]);
      expect(await accessLog(oauth)).toEqual([]);
      expect(await accessLog(password)).toEqual([]);
    });
  });
});
