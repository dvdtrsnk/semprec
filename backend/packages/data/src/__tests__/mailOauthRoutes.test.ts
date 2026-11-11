import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { inflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import "../domainWriteHooks.js";
import { createUser } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { logger as dbLogger } from "../db/logger.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, ValidationError } from "../errors.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import type { GmailMailClient } from "../mail/gmailReconcile.js";
import { createGmailWatchLifecycleFactory, type GmailWatchTransport } from "../mail/gmailWatchLifecycle.js";
import { logger as mailLogger } from "../mail/logger.js";
import {
  ensureMailAccountSyncState,
  findMailboxByProviderAccountAddress,
  getProviderAccountAddress,
  recordGmailActivity,
  recordGmailWatchEmailAddress,
  recordGraphActivity,
  recordProviderAccountAddress,
} from "../mail/mailAccountSyncStateStore.js";
import { createMailLiveSyncRoot, type MailLiveSyncLifecycleFactory } from "../mail/mailLiveSyncRoot.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import {
  createMailboxReauthorizeRouteHandler,
  createMailOauthCompleteRouteHandler,
  createMailOauthStartRouteHandler,
  type MailOauthRouteDependencies,
} from "../mail/mailOauthRouteHandlers.js";
import { consumeMailOauthState, createMailOauthState } from "../mail/mailOauthStatesStore.js";
import { handleSyncMailAccountTask } from "../mail/mailSyncJob.js";
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL } from "../mail/oauthTokenExchange.js";
import { MailAuthorizationCodeRejectedError } from "../mail/providerTypes.js";
import { seedSystem } from "../seed/seedSystem.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import { handleTenantExportTask } from "../tenancy/tenantExportJob.js";
import { requestTenantExport } from "../tenancy/tenantExportsStore.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,proxyAddresses";
const REDIRECT_URI = "https://app.example.test/api/mail/oauth/callback";

/** Values that must never leave the server: every test that reads a response, a log or an export looks for them. */
const SECRETS = {
  code: "SENTINEL-AUTHORIZATION-CODE",
  accessToken: "SENTINEL-ACCESS-TOKEN",
  refreshToken: "SENTINEL-REFRESH-TOKEN",
  gmailClientSecret: "SENTINEL-GMAIL-CLIENT-SECRET",
  graphClientSecret: "SENTINEL-GRAPH-CLIENT-SECRET",
};

const OAUTH = {
  gmail: { clientId: "gmail-client-id", clientSecret: SECRETS.gmailClientSecret },
  msGraph: { clientId: "graph-client-id", clientSecret: SECRETS.graphClientSecret },
  redirectBaseUrl: "https://app.example.test",
};

interface ProviderCall {
  url: string;
  method: string;
  authorization: string | null;
  /** The form body of a token request; null for the `GET`s. */
  form: URLSearchParams | null;
  signal: AbortSignal | null;
}

type ProviderRoute = (call: ProviderCall) => Response | Promise<Response>;

/** A provider that answers each known URL from `routes` and records every request it received. */
function fakeProvider(routes: Record<string, ProviderRoute>): { fetchImpl: typeof fetch; calls: ProviderCall[] } {
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
    const route = routes[url];
    if (!route) throw new Error(`unexpected provider request to ${url}`);
    return route(call);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const tokens = (): Response =>
  json({
    access_token: SECRETS.accessToken,
    expires_in: 3600,
    refresh_token: SECRETS.refreshToken,
    token_type: "Bearer",
  });

/** Google's three endpoints for one account; `overrides` replaces single answers. */
function googleRoutes(overrides: Record<string, ProviderRoute> = {}): Record<string, ProviderRoute> {
  return {
    [GOOGLE_TOKEN_URL]: tokens,
    [GMAIL_PROFILE_URL]: () =>
      json({ emailAddress: "Connect.User@Gmail.com", messagesTotal: 3, threadsTotal: 2, historyId: "77" }),
    [GMAIL_SEND_AS_URL]: () =>
      json({
        sendAs: [
          { sendAsEmail: "connect.user@gmail.com", isPrimary: true, isDefault: true },
          { sendAsEmail: "Alias@Example.com", verificationStatus: "accepted" },
          { sendAsEmail: "pending@example.com", verificationStatus: "pending" },
          { sendAsEmail: "not an address", verificationStatus: "accepted" },
          "not an entry",
        ],
      }),
    ...overrides,
  };
}

function microsoftRoutes(me: unknown): Record<string, ProviderRoute> {
  return { [MICROSOFT_TOKEN_URL]: tokens, [GRAPH_ME_URL]: () => json(me) };
}

interface Caller {
  tenantId: string;
  userId: string;
}

let admin: Pool;
let runtime: Pool;
let caller: Caller;

/** Runs `fn` in one transaction of `tenantId`, on the runtime role row-level security applies to. */
function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(runtime, fn));
}

async function newUser(tenantId: string): Promise<string> {
  const user = await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
  return user.id;
}

/** A second tenant with its own system databases and user. */
async function otherTenantCaller(): Promise<Caller> {
  const tenantId = await createTestTenant(admin);
  await provisionTenant(runtime, tenantId);
  return { tenantId, userId: await newUser(tenantId) };
}

const startBody = z.object({ authorizeUrl: z.string() }).strict();
const completeBody = z.object({ mailboxId: z.uuid() }).strict();

/** Calls the start route as `who`, the way the adapter does: inside the session's tenant. */
async function start(
  provider: unknown,
  who: Caller = caller,
  dependencies: MailOauthRouteDependencies = { oauth: OAUTH },
): Promise<URL> {
  const handler = createMailOauthStartRouteHandler(runtime, dependencies);
  const result = await runInTenant(who.tenantId, () =>
    handler({ identity: { user: { id: who.userId } }, body: { provider } }),
  );
  expect(result.status).toBe(200);
  return new URL(startBody.parse(result.body).authorizeUrl);
}

function stateOf(authorizeUrl: URL): string {
  const state = authorizeUrl.searchParams.get("state");
  if (state === null) throw new Error("the authorization URL carries no state");
  return state;
}

/** Calls the complete route as `who` against `provider`, with only the members a deployment configures. */
function complete(
  body: unknown,
  provider: { fetchImpl: typeof fetch },
  who: Caller = caller,
  oauth: MailOauthRouteDependencies["oauth"] = OAUTH,
): Promise<{ status: number; body: unknown }> {
  const handler = createMailOauthCompleteRouteHandler(runtime, { oauth, outboundHttp: provider.fetchImpl });
  return runInTenant(who.tenantId, () => handler({ identity: { user: { id: who.userId } }, body }));
}

/** The rejection of `promise`, failing when it resolves or rejects with something that is no `Error`. */
async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error;
  }
  throw new Error("expected a rejection");
}

interface StateRow {
  user_id: string;
  provider: string;
  mailbox_item_id: string | null;
  used_at: Date | null;
}

/** The row of `state`, read as the superuser so a row of any tenant is found. */
async function stateRow(state: string): Promise<StateRow | undefined> {
  const { rows } = await admin.query<StateRow>(
    "SELECT user_id, provider, mailbox_item_id, used_at FROM mail_oauth_states WHERE state_hash = $1",
    [createHash("sha256").update(state, "utf8").digest("hex")],
  );
  return rows[0];
}

async function stateCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM mail_oauth_states");
  return rows[0]?.n ?? -1;
}

interface Connected {
  mailboxes: Array<{ id: string; name: unknown; provider: unknown; addresses: unknown }>;
  credentials: Array<{ item_id: string; credential_type: string }>;
  syncStates: Array<{
    item_id: string;
    sync_mode: string;
    provider_account_address: string | null;
    gmail_watch_email_address: string | null;
  }>;
  jobs: string[];
}

const NOTHING: Connected = { mailboxes: [], credentials: [], syncStates: [], jobs: [] };

/**
 * Everything a connect writes, as `tenantId` sees it. The queue belongs to no tenant, so `jobs` is
 * every queued account sync, read as the superuser through graphile-worker's public `jobs` view.
 */
async function connected(tenantId: string = caller.tenantId): Promise<Connected> {
  const rows = await inTenant(tenantId, async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    const items = await client.query<{ id: string; properties: Record<string, unknown> }>(
      "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
      [mailboxesDatabaseId],
    );
    const credentials = await client.query<{ item_id: string; credential_type: string }>(
      "SELECT item_id, credential_type FROM external_credentials ORDER BY item_id",
    );
    const syncStates = await client.query<Connected["syncStates"][number]>(
      `SELECT item_id, sync_mode, provider_account_address, gmail_watch_email_address
         FROM mail_account_sync_state ORDER BY item_id`,
    );
    return { items: items.rows, credentials: credentials.rows, syncStates: syncStates.rows };
  });
  const jobs = await admin.query<{ key: string }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'mailAccountSync' ORDER BY key",
  );
  return {
    mailboxes: rows.items.map((item) => ({
      id: item.id,
      name: item.properties.name,
      provider: item.properties.provider,
      addresses: item.properties.addresses,
    })),
    credentials: rows.credentials,
    syncStates: rows.syncStates,
    jobs: jobs.rows.map((row) => row.key),
  };
}

function storedRefreshToken(tenantId: string, mailboxId: string): Promise<string | null> {
  return inTenant(tenantId, (client) =>
    getDecryptedCredential(client, { itemId: mailboxId, actorType: "sync_worker", purpose: "test" }),
  );
}

/** Every argument of every log call the data layer's two loggers received, as text. */
function captureLogs(): () => string {
  const spies = [mailLogger, dbLogger].flatMap((target) =>
    (["trace", "debug", "info", "warn", "error", "fatal"] as const).map((level) => vi.spyOn(target, level)),
  );
  return () => spies.map((spy) => inspect(spy.mock.calls, { depth: 8 })).join("\n");
}

function expectNoSecret(text: string, secrets: readonly string[]): void {
  expect(secrets.filter((secret) => text.includes(secret))).toEqual([]);
}

/** The decompressed entries of the tenant's export archive, built by the production export job. */
async function exportEntries(who: Caller): Promise<Array<{ name: string; content: Buffer }>> {
  const root = await mkdtemp(join(tmpdir(), "semprec-mail-oauth-export-"));
  try {
    const files = new LocalFsBlobStorageWriter(join(root, "files"));
    const mailAttachments = new LocalFsBlobStorageWriter(join(root, "mail"));
    const exportId = await runInTenant(who.tenantId, async () => {
      const request = await withTransaction(runtime, (client) => requestTenantExport(client, who.userId));
      await handleTenantExportTask(runtime, { files, mailAttachments }, { exportId: request.export.id }, {});
      return request.export.id;
    });
    const archive = await readFile(join(root, "files", who.tenantId, "exports", `${exportId}.zip`));
    const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error("the export archive has no central directory");
    const count = archive.readUInt16LE(eocd + 10);
    let offset = archive.readUInt32LE(eocd + 16);
    const entries: Array<{ name: string; content: Buffer }> = [];
    for (let index = 0; index < count; index += 1) {
      if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("the export archive's directory is malformed");
      const method = archive.readUInt16LE(offset + 10);
      const size = archive.readUInt32LE(offset + 20);
      const nameLength = archive.readUInt16LE(offset + 28);
      const extraLength = archive.readUInt16LE(offset + 30);
      const commentLength = archive.readUInt16LE(offset + 32);
      const localOffset = archive.readUInt32LE(offset + 42);
      const dataStart =
        localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
      const raw = archive.subarray(dataStart, dataStart + size);
      entries.push({
        name: archive.toString("utf8", offset + 46, offset + 46 + nameLength),
        content: method === 8 ? inflateRawSync(raw) : raw,
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});

beforeEach(async () => {
  await resetDatabase(admin);
  await seedSystem(admin);
  caller = { tenantId: getTenantZeroId(), userId: await newUser(getTenantZeroId()) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await runtime?.end();
  await admin?.end();
});

describe("POST /api/mail/mailboxes/oauth/start (issue gh-1686)", () => {
  it("answers Google's authorization URL for a new-account state of the caller", async () => {
    const url = await start("gmail");

    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const state = stateOf(url);
    const challenge = url.searchParams.get("code_challenge");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "gmail-client-id",
      redirect_uri: REDIRECT_URI,
      scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    expect(await stateRow(state)).toEqual({
      user_id: caller.userId,
      provider: "gmail",
      mailbox_item_id: null,
      used_at: null,
    });
    // The challenge in the URL is the S256 of the verifier sealed in that state's row.
    const consumed = await inTenant(caller.tenantId, (client) =>
      consumeMailOauthState(client, { state, userId: caller.userId }),
    );
    if (consumed === null) throw new Error("the started state could not be consumed");
    expect(createHash("sha256").update(consumed.codeVerifier, "utf8").digest("base64url")).toBe(challenge);
    expect(url.toString()).not.toContain(consumed.codeVerifier);
    expect(url.toString()).not.toContain(SECRETS.gmailClientSecret);
  });

  it("answers Microsoft's /common authorization URL with the Graph client and scopes", async () => {
    const url = await start("outlook");

    expect(`${url.origin}${url.pathname}`).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    const state = stateOf(url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "graph-client-id",
      redirect_uri: REDIRECT_URI,
      scope: "Mail.ReadWrite Mail.Send offline_access User.Read",
      state,
      code_challenge: url.searchParams.get("code_challenge"),
      code_challenge_method: "S256",
    });
    expect(await stateRow(state)).toMatchObject({ provider: "outlook", mailbox_item_id: null, used_at: null });
    expect(url.toString()).not.toContain(SECRETS.graphClientSecret);
  });

  it.each([
    ["no provider", {}],
    ["a provider this flow does not connect", { provider: "icloud" }],
    ["an unknown key", { provider: "gmail", mailboxItemId: randomUUID() }],
    ["a body that is no object", null],
  ])("refuses %s with 400 validation_failed and stores no state", async (_name, body) => {
    const handler = createMailOauthStartRouteHandler(runtime, { oauth: OAUTH });

    const error = await caught(
      runInTenant(caller.tenantId, () => handler({ identity: { user: { id: caller.userId } }, body })),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "provider" } });
    expect(await stateCount()).toBe(0);
  });

  it.each<[string, MailOauthRouteDependencies]>([
    ["an empty container", {}],
    ["no client for the provider", { oauth: { msGraph: OAUTH.msGraph, redirectBaseUrl: OAUTH.redirectBaseUrl } }],
    ["no redirect base URL", { oauth: { gmail: OAUTH.gmail } }],
  ])("fails with a plain configuration error, and stores no state, under %s", async (_name, dependencies) => {
    const error = await caught(start("gmail", caller, dependencies));

    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error.message).toBe('Mail OAuth for provider "gmail" is not configured by the composition root');
    expect(await stateCount()).toBe(0);
  });
});

describe("POST /api/mail/mailboxes/oauth/complete (issue gh-1686)", () => {
  it("connects a Google account as one gmail_api mailbox, and answers 409 naming it when the address signs in again", async () => {
    const url = await start("gmail");
    const provider = fakeProvider(googleRoutes());

    const result = await complete({ state: stateOf(url), code: SECRETS.code }, provider);

    expect(result.status).toBe(201);
    const { mailboxId } = completeBody.parse(result.body);
    const expected: Connected = {
      mailboxes: [
        { id: mailboxId, name: "Gmail", provider: "gmail", addresses: "connect.user@gmail.com\nalias@example.com" },
      ],
      credentials: [{ item_id: mailboxId, credential_type: "oauth2_refresh_token" }],
      syncStates: [
        {
          item_id: mailboxId,
          sync_mode: "gmail_api",
          provider_account_address: "connect.user@gmail.com",
          gmail_watch_email_address: "connect.user@gmail.com",
        },
      ],
      jobs: [`mail-account-sync:${mailboxId}`],
    };
    expect(await connected()).toEqual(expected);
    expect(await storedRefreshToken(caller.tenantId, mailboxId)).toBe(SECRETS.refreshToken);

    // The exchange presents the verifier of this state, then both lookups present the access token.
    expect(provider.calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", GOOGLE_TOKEN_URL],
      ["GET", GMAIL_PROFILE_URL],
      ["GET", GMAIL_SEND_AS_URL],
    ]);
    const form = provider.calls[0]?.form;
    if (!form) throw new Error("the token request carried no form body");
    const verifier = form.get("code_verifier") ?? "";
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: SECRETS.code,
      redirect_uri: REDIRECT_URI,
      client_id: "gmail-client-id",
      client_secret: SECRETS.gmailClientSecret,
      code_verifier: verifier,
    });
    expect(createHash("sha256").update(verifier, "utf8").digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(provider.calls.slice(1).map((call) => call.authorization)).toEqual([
      `Bearer ${SECRETS.accessToken}`,
      `Bearer ${SECRETS.accessToken}`,
    ]);

    // The same account, reported in another letter case, through a fresh sign-in.
    const again = fakeProvider(
      googleRoutes({ [GMAIL_PROFILE_URL]: () => json({ emailAddress: "CONNECT.USER@gmail.com" }) }),
    );
    const error = await caught(complete({ state: stateOf(await start("gmail")), code: "second-code" }, again));

    expect(error).toBeInstanceOf(ChokePointError);
    expect(error).toMatchObject({
      status: 409,
      code: "provider_account_already_connected",
      details: { mailboxId },
    });
    expect(again.calls).toHaveLength(3);
    expect(await connected()).toEqual(expected);
  });

  it("stores only the profile address when Gmail lists no send-as entries", async () => {
    const provider = fakeProvider(googleRoutes({ [GMAIL_SEND_AS_URL]: () => json({}) }));

    await complete({ state: stateOf(await start("gmail")), code: SECRETS.code }, provider);

    expect((await connected()).mailboxes.map((mailbox) => mailbox.addresses)).toEqual(["connect.user@gmail.com"]);
  });

  it("keeps at most 100 aliases of one Gmail account", async () => {
    const sendAs = Array.from({ length: 150 }, (_, index) => ({
      sendAsEmail: `alias-${index}@example.com`,
      verificationStatus: "accepted",
    }));
    const provider = fakeProvider(googleRoutes({ [GMAIL_SEND_AS_URL]: () => json({ sendAs }) }));

    await complete({ state: stateOf(await start("gmail")), code: SECRETS.code }, provider);

    const addresses = (await connected()).mailboxes.map((mailbox) => mailbox.addresses);
    expect(addresses).toEqual([
      ["connect.user@gmail.com", ...sendAs.slice(0, 100).map((entry) => entry.sendAsEmail)].join("\n"),
    ]);
  });

  it("connects a Microsoft 365 work account as a graph_api mailbox under its mail address, with its secondary SMTP addresses as aliases", async () => {
    const provider = fakeProvider(
      microsoftRoutes({
        mail: "Work.User@Contoso.com",
        userPrincipalName: "work.user@contoso.onmicrosoft.com",
        proxyAddresses: [
          "SMTP:Work.User@Contoso.com",
          "smtp:Sales@Contoso.com",
          "smtp: spaced@contoso.com",
          "X500:/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=work.user",
          "SIP:sip.user@contoso.com",
          "smtp:not an address",
          "unprefixed@contoso.com",
          42,
        ],
      }),
    );

    const result = await complete({ state: stateOf(await start("outlook")), code: SECRETS.code }, provider);

    const { mailboxId } = completeBody.parse(result.body);
    expect(await connected()).toEqual({
      mailboxes: [
        {
          id: mailboxId,
          name: "Outlook",
          provider: "outlook",
          addresses: "work.user@contoso.com\nsales@contoso.com\nspaced@contoso.com",
        },
      ],
      credentials: [{ item_id: mailboxId, credential_type: "oauth2_refresh_token" }],
      syncStates: [
        {
          item_id: mailboxId,
          sync_mode: "graph_api",
          provider_account_address: "work.user@contoso.com",
          gmail_watch_email_address: null,
        },
      ],
      jobs: [`mail-account-sync:${mailboxId}`],
    });
    expect(await storedRefreshToken(caller.tenantId, mailboxId)).toBe(SECRETS.refreshToken);
    expect(provider.calls.map((call) => [call.method, call.url, call.authorization])).toEqual([
      ["POST", MICROSOFT_TOKEN_URL, null],
      ["GET", GRAPH_ME_URL, `Bearer ${SECRETS.accessToken}`],
    ]);
    expect(provider.calls[0]?.form?.get("client_secret")).toBe(SECRETS.graphClientSecret);
  });

  it.each([
    ["the default property set, without the selected list", { displayName: "Person" }],
    ["an empty proxy address list", { proxyAddresses: [] }],
  ])(
    "connects a personal Outlook.com account, which reports no mail and answers %s, under its user principal name alone",
    async (_name, answer) => {
      const provider = fakeProvider(
        microsoftRoutes({ mail: null, userPrincipalName: "Person@Outlook.com", ...answer }),
      );

      const result = await complete({ state: stateOf(await start("outlook")), code: SECRETS.code }, provider);

      const { mailboxId } = completeBody.parse(result.body);
      const after = await connected();
      expect(after.mailboxes).toEqual([
        { id: mailboxId, name: "Outlook", provider: "outlook", addresses: "person@outlook.com" },
      ]);
      expect(after.syncStates).toEqual([
        {
          item_id: mailboxId,
          sync_mode: "graph_api",
          provider_account_address: "person@outlook.com",
          gmail_watch_email_address: null,
        },
      ]);
      expect(after.jobs).toEqual([`mail-account-sync:${mailboxId}`]);
    },
  );

  it("keeps at most 100 aliases of one Outlook account", async () => {
    const proxyAddresses = Array.from({ length: 150 }, (_, index) => `smtp:alias-${index}@contoso.com`);
    const provider = fakeProvider(microsoftRoutes({ mail: "work.user@contoso.com", proxyAddresses }));

    await complete({ state: stateOf(await start("outlook")), code: SECRETS.code }, provider);

    const addresses = (await connected()).mailboxes.map((mailbox) => mailbox.addresses);
    expect(addresses).toEqual([
      ["work.user@contoso.com", ...proxyAddresses.slice(0, 100).map((entry) => entry.slice("smtp:".length))].join("\n"),
    ]);
  });

  it("lets two tenants connect the same address, each as its own mailbox", async () => {
    const other = await otherTenantCaller();
    const first = completeBody.parse(
      (await complete({ state: stateOf(await start("gmail")), code: SECRETS.code }, fakeProvider(googleRoutes()))).body,
    );

    const second = completeBody.parse(
      (
        await complete(
          { state: stateOf(await start("gmail", other)), code: SECRETS.code },
          fakeProvider(googleRoutes()),
          other,
        )
      ).body,
    );

    expect(second.mailboxId).not.toBe(first.mailboxId);
    expect((await connected()).mailboxes.map((mailbox) => mailbox.id)).toEqual([first.mailboxId]);
    expect((await connected(other.tenantId)).mailboxes.map((mailbox) => mailbox.id)).toEqual([second.mailboxId]);
    expect(await storedRefreshToken(other.tenantId, second.mailboxId)).toBe(SECRETS.refreshToken);
    expect(await storedRefreshToken(other.tenantId, first.mailboxId)).toBeNull();
  });

  it("commits the consumed state before the first provider request, so the same state is refused while that request is still open", async () => {
    const state = stateOf(await start("gmail"));
    const unreached = fakeProvider(googleRoutes());
    let usedAtDuringExchange: Date | null | undefined;
    let secondRequest: Error | undefined;
    const provider = fakeProvider(
      googleRoutes({
        [GOOGLE_TOKEN_URL]: async () => {
          // Read on another connection, which sees the consumption only once it is committed.
          usedAtDuringExchange = (await stateRow(state))?.used_at;
          secondRequest = await caught(complete({ state, code: SECRETS.code }, unreached));
          return tokens();
        },
      }),
    );

    const result = await complete({ state, code: SECRETS.code }, provider);

    expect(usedAtDuringExchange).toBeInstanceOf(Date);
    expect(secondRequest).toBeInstanceOf(ValidationError);
    expect(secondRequest).toMatchObject({ status: 400, code: "validation_failed", details: { field: "state" } });
    expect(unreached.calls).toEqual([]);
    expect(result.status).toBe(201);
    expect((await connected()).mailboxes.map((mailbox) => mailbox.id)).toEqual([
      completeBody.parse(result.body).mailboxId,
    ]);
  });

  it("lets one of two sign-ins that write the same address at once create the mailbox, and answers the other 409 naming it", async () => {
    const states = [stateOf(await start("gmail")), stateOf(await start("gmail"))];
    // Each request holds its last provider answer until both have asked for it, so the two write
    // transactions start together; whichever commits first, the assertions below hold.
    let waiting = 0;
    let releaseBoth: () => void = () => undefined;
    const bothWaiting = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const sendAs = googleRoutes()[GMAIL_SEND_AS_URL];
    if (!sendAs) throw new Error("the Google fixture answers no send-as list");
    const held = (): { fetchImpl: typeof fetch } =>
      fakeProvider(
        googleRoutes({
          [GMAIL_SEND_AS_URL]: async (call) => {
            waiting += 1;
            if (waiting === 2) releaseBoth();
            await bothWaiting;
            return sendAs(call);
          },
        }),
      );

    const outcomes = await Promise.allSettled(states.map((state) => complete({ state, code: SECRETS.code }, held())));

    const created = outcomes.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
    const refused = outcomes.flatMap((outcome): unknown[] => (outcome.status === "rejected" ? [outcome.reason] : []));
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const { mailboxId } = completeBody.parse(created[0]?.body);
    expect(refused[0]).toBeInstanceOf(ChokePointError);
    expect(refused[0]).toMatchObject({
      status: 409,
      code: "provider_account_already_connected",
      details: { mailboxId },
    });
    // Nothing of the refused mailbox remains: its transaction rolled back whole.
    const after = await connected();
    expect(after.mailboxes.map((mailbox) => mailbox.id)).toEqual([mailboxId]);
    expect(after.credentials.map((credential) => credential.item_id)).toEqual([mailboxId]);
    expect(after.syncStates.map((syncState) => syncState.item_id)).toEqual([mailboxId]);
    expect(after.jobs).toEqual([`mail-account-sync:${mailboxId}`]);
  });

  describe("a state the caller may not use", () => {
    async function expectStateRefused(body: unknown, who: Caller = caller): Promise<void> {
      const provider = fakeProvider(googleRoutes());

      const error = await caught(complete(body, provider, who));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "state" } });
      expect(provider.calls).toEqual([]);
      expect(await connected()).toEqual(NOTHING);
      expect(await connected(who.tenantId)).toEqual(NOTHING);
    }

    it("refuses another user's state, which stays unused for its owner", async () => {
      const state = stateOf(await start("gmail"));

      // `users.tenant_id` is unique, so a second user of the same tenant is a caller id no row carries.
      await expectStateRefused({ state, code: SECRETS.code }, { tenantId: caller.tenantId, userId: randomUUID() });

      expect((await stateRow(state))?.used_at).toBeNull();
    });

    it("refuses another tenant's state, which stays unused for its owner", async () => {
      const other = await otherTenantCaller();
      const state = stateOf(await start("gmail"));

      await expectStateRefused({ state, code: SECRETS.code }, other);

      expect((await stateRow(state))?.used_at).toBeNull();
    });

    it("refuses a state that was already used", async () => {
      const state = stateOf(await start("gmail"));
      const refusing = fakeProvider({ [GOOGLE_TOKEN_URL]: () => json({ error: "invalid_grant" }, 400) });
      await caught(complete({ state, code: SECRETS.code }, refusing));
      expect((await stateRow(state))?.used_at).not.toBeNull();

      await expectStateRefused({ state, code: SECRETS.code });
    });

    it("refuses an expired state", async () => {
      const state = stateOf(await start("gmail"));
      // Only the clock expires a state, so the test moves the expiry into the past itself.
      const moved = await admin.query(
        "UPDATE mail_oauth_states SET expires_at = now() - interval '1 second' WHERE state_hash = $1",
        [createHash("sha256").update(state, "utf8").digest("hex")],
      );
      expect(moved.rowCount).toBe(1);

      await expectStateRefused({ state, code: SECRETS.code });

      expect((await stateRow(state))?.used_at).toBeNull();
    });

    it("refuses a state nobody started", async () => {
      await expectStateRefused({ state: "a-state-nobody-started", code: SECRETS.code });
    });
  });

  it.each([
    ["no code", (state: string) => ({ state })],
    ["an empty code", (state: string) => ({ state, code: "" })],
    ["a code above the length cap", (state: string) => ({ state, code: "c".repeat(4097) })],
    ["an unknown key", (state: string) => ({ state, code: SECRETS.code, provider: "gmail" })],
    // What the public callback answers after a cancelled consent: the app has nothing to complete.
    [
      "the callback's provider error in place of a code",
      (state: string) => ({ state, providerError: "access_denied" }),
    ],
    ["no state", () => ({ code: SECRETS.code })],
    ["a state above the length cap", () => ({ state: "s".repeat(513), code: SECRETS.code })],
    ["a body that is no object", () => null],
  ])("refuses a body with %s before the state is consumed", async (_name, build) => {
    const state = stateOf(await start("gmail"));
    const provider = fakeProvider(googleRoutes());

    const error = await caught(complete(build(state), provider));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed" });
    expect((await stateRow(state))?.used_at).toBeNull();
    expect(provider.calls).toEqual([]);
    expect(await connected()).toEqual(NOTHING);
  });

  it("answers 400 validation_failed for a code the provider refuses as invalid_grant, and the state cannot be presented again", async () => {
    const state = stateOf(await start("gmail"));
    const provider = fakeProvider({ [GOOGLE_TOKEN_URL]: () => json({ error: "invalid_grant" }, 400) });

    const error = await caught(complete({ state, code: SECRETS.code }, provider));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "code" } });
    expect(provider.calls).toHaveLength(1);
    expect(await connected()).toEqual(NOTHING);
    expect((await stateRow(state))?.used_at).not.toBeNull();
  });

  it.each<[string, number, unknown, string | null, string]>([
    [
      "refuses the OAuth client (a wrong or expired client secret)",
      401,
      { error: "invalid_client" },
      "invalid_client",
      "status 401, error invalid_client",
    ],
    [
      "calls the request malformed",
      400,
      { error: "invalid_request" },
      "invalid_request",
      "status 400, error invalid_request",
    ],
    ["names no error code this server knows", 400, { error: "redirect_uri_mismatch" }, null, "status 400"],
  ])(
    "propagates a token endpoint that %s as an unexpected error, not as the caller's rejected code, and creates nothing",
    async (_name, status, providerBody, providerError, detail) => {
      const state = stateOf(await start("gmail"));
      const provider = fakeProvider({ [GOOGLE_TOKEN_URL]: () => json(providerBody, status) });

      const error = await caught(complete({ state, code: SECRETS.code }, provider));

      // No `ChokePointError`: the adapter logs the failure and answers a generic 500.
      expect(error).not.toBeInstanceOf(ChokePointError);
      expect(error).toBeInstanceOf(MailAuthorizationCodeRejectedError);
      expect(error).toMatchObject({ providerError });
      expect(error.message).toBe(`OAuth code exchange rejected the authorization code (${detail})`);
      const verifier = provider.calls[0]?.form?.get("code_verifier");
      if (!verifier) throw new Error("the token request carried no verifier");
      expectNoSecret(inspect(error, { depth: 8 }), [...Object.values(SECRETS), verifier]);
      expect(provider.calls).toHaveLength(1);
      expect(await connected()).toEqual(NOTHING);
      expect((await stateRow(state))?.used_at).not.toBeNull();
    },
  );

  it.each([
    ["consent_required", { error: "consent_required" }],
    [
      "invalid_grant naming AADSTS65001",
      { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented." },
    ],
  ])("answers 400 mail_admin_consent_required when Microsoft reports %s", async (_name, providerBody) => {
    const provider = fakeProvider({ [MICROSOFT_TOKEN_URL]: () => json(providerBody, 400) });

    const error = await caught(complete({ state: stateOf(await start("outlook")), code: SECRETS.code }, provider));

    expect(error).toBeInstanceOf(ChokePointError);
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "mail_admin_consent_required" });
    expect(provider.calls).toHaveLength(1);
    expect(await connected()).toEqual(NOTHING);
  });

  it("propagates a provider outage of the token endpoint as an unexpected error and creates nothing", async () => {
    const provider = fakeProvider({ [GOOGLE_TOKEN_URL]: () => json({ error: "server_error" }, 503) });

    const error = await caught(complete({ state: stateOf(await start("gmail")), code: SECRETS.code }, provider));

    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error.message).toBe("OAuth code exchange failed with status 503");
    expect(await connected()).toEqual(NOTHING);
  });

  it.each<[string, ProviderRoute, string]>([
    [
      "is unreachable",
      () => Promise.reject(new Error(`connect failed for Bearer ${SECRETS.accessToken}`)),
      "Gmail profile request failed",
    ],
    [
      "answers 403",
      () => json({ error: { message: "forbidden" } }, 403),
      "Gmail profile request failed with status 403",
    ],
    ["answers without a body", () => new Response(null, { status: 200 }), "Gmail profile response has no body"],
    [
      "answers more than the size cap",
      () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
      "Gmail profile response exceeds the size limit",
    ],
    [
      "answers text that is no JSON",
      () => new Response("<html>", { status: 200 }),
      "Gmail profile response is not valid JSON",
    ],
    [
      "answers JSON that is no object",
      () => json("profile"),
      "Gmail profile response: expected a JSON object in the response, got string",
    ],
    [
      "breaks off while its body streams",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error(`the stream of ${SECRETS.accessToken} broke`));
            },
          }),
          { status: 200 },
        ),
      "Gmail profile response could not be read",
    ],
    ["names no address", () => json({ historyId: "1" }), "Gmail profile response holds no account address"],
    [
      "names something that is no address",
      () => json({ emailAddress: "not an address" }),
      "Gmail profile response holds no account address",
    ],
  ])("creates nothing when the Gmail profile endpoint %s", async (_name, route, message) => {
    const provider = fakeProvider(googleRoutes({ [GMAIL_PROFILE_URL]: route }));

    const error = await caught(complete({ state: stateOf(await start("gmail")), code: SECRETS.code }, provider));

    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error.message).toBe(message);
    expectNoSecret(inspect(error, { depth: 8 }), Object.values(SECRETS));
    expect(provider.calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_URL, GMAIL_PROFILE_URL]);
    // Whatever way the lookup ended, its request was aborted, which releases an unread response.
    expect(provider.calls[1]?.signal?.aborted).toBe(true);
    expect(await connected()).toEqual(NOTHING);
  });

  it("creates nothing when Gmail's send-as answer holds no list", async () => {
    const provider = fakeProvider(googleRoutes({ [GMAIL_SEND_AS_URL]: () => json({ sendAs: "none" }) }));

    const error = await caught(complete({ state: stateOf(await start("gmail")), code: SECRETS.code }, provider));

    expect(error.message).toBe("Gmail send-as list response holds no list");
    expect(await connected()).toEqual(NOTHING);
  });

  it("creates nothing when Microsoft Graph's proxy addresses are no list", async () => {
    const provider = fakeProvider(
      microsoftRoutes({ mail: "work.user@contoso.com", proxyAddresses: "smtp:sales@contoso.com" }),
    );

    const error = await caught(complete({ state: stateOf(await start("outlook")), code: SECRETS.code }, provider));

    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error.message).toBe("Microsoft Graph profile response holds no proxy address list");
    expect(await connected()).toEqual(NOTHING);
  });

  it("creates nothing when Microsoft Graph reports neither a mail address nor a user principal name", async () => {
    const provider = fakeProvider(microsoftRoutes({ displayName: "Nobody", mail: null }));

    const error = await caught(complete({ state: stateOf(await start("outlook")), code: SECRETS.code }, provider));

    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error.message).toBe("Microsoft Graph profile response holds no account address");
    expect(await connected()).toEqual(NOTHING);
  });

  it("gives up on a provider that accepts the lookup and never answers", async () => {
    const state = stateOf(await start("gmail"));
    const timers = vi.spyOn(globalThis, "setTimeout");
    let timersBeforeLookup = 0;
    let reportWaiting: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      reportWaiting = resolve;
    });
    const provider = fakeProvider(
      googleRoutes({
        [GOOGLE_TOKEN_URL]: () => {
          timersBeforeLookup = timers.mock.calls.length;
          return tokens();
        },
        [GMAIL_PROFILE_URL]: (call) =>
          new Promise<Response>((_resolve, reject) => {
            call.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            reportWaiting();
          }),
      }),
    );

    const outcome = caught(complete({ state, code: SECRETS.code }, provider));
    await waiting;
    // The one timer armed between the token answer and the lookup request is the lookup's deadline.
    const armed = timers.mock.calls.slice(timersBeforeLookup);
    expect(armed.map(([, delay]) => delay)).toEqual([15_000]);
    expect(provider.calls[1]?.signal?.aborted).toBe(false);
    const deadline = armed[0]?.[0];
    if (deadline === undefined) throw new Error("the lookup armed no deadline");
    // Runs the deadline now instead of waiting 15 seconds for it.
    deadline();
    const error = await outcome;

    expect(provider.calls[1]?.signal?.aborted).toBe(true);
    expect(error.message).toBe("Gmail profile request failed");
    expect(await connected()).toEqual(NOTHING);
  });

  it("fails with a plain configuration error after consuming the state when the provider's client is gone", async () => {
    const state = stateOf(await start("gmail"));
    const provider = fakeProvider(googleRoutes());

    const error = await caught(
      complete({ state, code: SECRETS.code }, provider, caller, { redirectBaseUrl: OAUTH.redirectBaseUrl }),
    );

    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error.message).toBe('Mail OAuth for provider "gmail" is not configured by the composition root');
    expect(provider.calls).toEqual([]);
    expect((await stateRow(state))?.used_at).not.toBeNull();
    expect(await connected()).toEqual(NOTHING);
  });

  it("uses the global fetch when the composition root injects none", async () => {
    const provider = fakeProvider(googleRoutes());
    const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(provider.fetchImpl);
    const handler = createMailOauthCompleteRouteHandler(runtime, { oauth: OAUTH });
    const state = stateOf(await start("gmail"));

    const result = await runInTenant(caller.tenantId, () =>
      handler({ identity: { user: { id: caller.userId } }, body: { state, code: SECRETS.code } }),
    );

    expect(result.status).toBe(201);
    expect(globalFetch).toHaveBeenCalledTimes(3);
    expect((await connected()).mailboxes).toHaveLength(1);
  });

  it("keeps the code, the verifier and every token out of the response, the logs and the tenant export", async () => {
    const logs = captureLogs();
    const url = await start("gmail");
    const provider = fakeProvider(googleRoutes());

    const result = await complete({ state: stateOf(url), code: SECRETS.code }, provider);

    const verifier = provider.calls[0]?.form?.get("code_verifier");
    if (!verifier) throw new Error("the token request carried no verifier");
    const secrets = [...Object.values(SECRETS), verifier];
    expectNoSecret(JSON.stringify(result), secrets);
    expectNoSecret(url.toString(), [verifier, SECRETS.gmailClientSecret]);

    // A failed sign-in logs through the same loggers: a rejected code and a failed profile lookup.
    const rejected = fakeProvider({ [GOOGLE_TOKEN_URL]: () => json({ error: "invalid_grant" }, 400) });
    await caught(complete({ state: stateOf(await start("gmail")), code: SECRETS.code }, rejected));
    const failing = fakeProvider(
      googleRoutes({ [GMAIL_PROFILE_URL]: () => Promise.reject(new Error(`Bearer ${SECRETS.accessToken}`)) }),
    );
    await caught(complete({ state: stateOf(await start("gmail")), code: SECRETS.code }, failing));
    expectNoSecret(logs(), secrets);

    const entries = await exportEntries(caller);
    const names = entries.map((entry) => entry.name);
    // The mailbox and its sync state are exported; the credential and the state rows are not.
    expect(names).toContain("tables/mail_account_sync_state.jsonl");
    expect(names).not.toContain("tables/external_credentials.jsonl");
    expect(names).not.toContain("tables/mail_oauth_states.jsonl");
    const mailboxId = completeBody.parse(result.body).mailboxId;
    expect(entries.some((entry) => entry.content.includes(Buffer.from(mailboxId)))).toBe(true);
    for (const entry of entries) {
      expect(
        secrets.filter((secret) => entry.content.includes(Buffer.from(secret))),
        `export entry ${entry.name}`,
      ).toEqual([]);
    }
  });
});

/** The refresh token an existing mailbox holds before it is reauthorized; it must never leave the server either. */
const OLD_REFRESH_TOKEN = "SENTINEL-OLD-REFRESH-TOKEN";
/** The account Google's fixture answers for (`googleRoutes`), as the store records it. */
const GOOGLE_ACCOUNT = "connect.user@gmail.com";

interface ExistingMailbox {
  /** The item's `provider` property; `null` leaves it unset. */
  provider?: string | null;
  /** The recorded provider account address; `null` records none. */
  address?: string | null;
  /** `false` leaves the mailbox without a sync state row, as before its first discovery pass. */
  syncState?: boolean;
  /** `false` leaves the mailbox without a stored credential. */
  credential?: boolean;
}

/**
 * A mailbox as an earlier connect left it, written by the store functions the connect flow uses,
 * holding `OLD_REFRESH_TOKEN`. No sync is queued for it, so a job a test finds was queued by the
 * route under test.
 */
function existingMailbox(tenantId: string, options: ExistingMailbox = {}): Promise<string> {
  const { provider = "gmail", address = GOOGLE_ACCOUNT, syncState = true, credential = true } = options;
  return inTenant(tenantId, async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    const item = await createItemWithClient(client, {
      databaseId: mailboxesDatabaseId,
      properties: { name: "Existing", ...(provider === null ? {} : { provider }) },
    });
    if (syncState) {
      await ensureMailAccountSyncState(client, {
        itemId: item.id,
        syncMode: provider === "outlook" ? "graph_api" : "gmail_api",
      });
      if (address !== null) await recordProviderAccountAddress(client, item.id, address);
    }
    if (credential) {
      await storeCredential(client, {
        itemId: item.id,
        credentialType: "oauth2_refresh_token",
        plaintext: OLD_REFRESH_TOKEN,
      });
    }
    return item.id;
  });
}

/** The password an IMAP mailbox signs in with; a refused reauthorization must leave it in place. */
const IMAP_PASSWORD = "SENTINEL-IMAP-APP-PASSWORD";

/**
 * A mailbox that syncs over IMAP and signs in with a password: sync mode `imap`, as a discovery pass
 * seeds it for the provider `generic`, an `app_password` credential and no provider account address,
 * which only the OAuth flows record.
 */
function passwordMailbox(tenantId: string): Promise<string> {
  return inTenant(tenantId, async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    const item = await createItemWithClient(client, {
      databaseId: mailboxesDatabaseId,
      properties: { name: "IMAP", provider: "generic" },
    });
    await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "imap" });
    await storeCredential(client, { itemId: item.id, credentialType: "app_password", plaintext: IMAP_PASSWORD });
    return item.id;
  });
}

/** Changes the mailbox's `provider` the way its user can: through the generic item write, as owner `user`. */
function relabel(tenantId: string, mailboxId: string, provider: string): Promise<void> {
  return inTenant(tenantId, async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    await updateItemWithClient(client, {
      databaseId: mailboxesDatabaseId,
      itemId: mailboxId,
      propertiesPatch: { provider },
    });
  });
}

/** The type of the one credential `mailboxId` holds, or `null` when it holds none. */
async function storedCredentialType(tenantId: string, mailboxId: string): Promise<string | null> {
  const { credentials } = await connected(tenantId);
  return credentials.find((credential) => credential.item_id === mailboxId)?.credential_type ?? null;
}

interface StoredMailbox {
  refreshToken: string | null;
  syncState: {
    sync_mode: string;
    provider_account_address: string | null;
    gmail_watch_email_address: string | null;
    gmail_history_id: string | null;
    graph_delta_link: string | null;
  } | null;
  syncStatus: unknown;
  /** Every queued account sync, as `connected` reads them. */
  jobs: string[];
}

/** What a reauthorization may change about `mailboxId`, as committed: read on other connections. */
async function storedMailbox(tenantId: string, mailboxId: string): Promise<StoredMailbox> {
  const rows = await inTenant(tenantId, async (client) => {
    const syncState = await client.query<NonNullable<StoredMailbox["syncState"]>>(
      `SELECT sync_mode, provider_account_address, gmail_watch_email_address, gmail_history_id, graph_delta_link
         FROM mail_account_sync_state WHERE item_id = $1`,
      [mailboxId],
    );
    const item = await client.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE id = $1",
      [mailboxId],
    );
    return { syncState: syncState.rows[0] ?? null, syncStatus: item.rows[0]?.properties.syncStatus };
  });
  return {
    refreshToken: await storedRefreshToken(tenantId, mailboxId),
    ...rows,
    jobs: (await connected(tenantId)).jobs,
  };
}

/** Calls the reauthorize route as `who`, the way the adapter does: inside the session's tenant. */
function reauthorizeResult(
  mailboxId: string,
  who: Caller = caller,
  dependencies: MailOauthRouteDependencies = { oauth: OAUTH },
): Promise<{ status: number; body: unknown }> {
  const handler = createMailboxReauthorizeRouteHandler(runtime, dependencies);
  return runInTenant(who.tenantId, () =>
    handler({ identity: { user: { id: who.userId } }, params: { id: mailboxId } }),
  );
}

/** Starts a reauthorization of `mailboxId` as `who` and returns the provider URL the route answered. */
async function reauthorize(mailboxId: string, who: Caller = caller): Promise<URL> {
  const result = await reauthorizeResult(mailboxId, who);
  expect(result.status).toBe(200);
  return new URL(startBody.parse(result.body).authorizeUrl);
}

/** A live-sync control that records each restart it is asked for and then runs `onRestart`. */
function liveSyncSpy(onRestart?: () => Promise<void>): {
  control: NonNullable<MailOauthRouteDependencies["mailLiveSync"]>;
  restarted: string[];
} {
  const restarted: string[] = [];
  return {
    restarted,
    control: {
      async restartAccount(mailboxItemId) {
        restarted.push(mailboxItemId);
        await onRestart?.();
      },
    },
  };
}

/** Calls the complete route as `who` with the live-sync control a reauthorization needs. */
function completeReauthorization(
  state: string,
  provider: { fetchImpl: typeof fetch },
  liveSync: NonNullable<MailOauthRouteDependencies["mailLiveSync"]>,
  who: Caller = caller,
  pool: Pool = runtime,
): Promise<{ status: number; body: unknown }> {
  const handler = createMailOauthCompleteRouteHandler(pool, {
    oauth: OAUTH,
    outboundHttp: provider.fetchImpl,
    mailLiveSync: liveSync,
  });
  return runInTenant(who.tenantId, () =>
    handler({ identity: { user: { id: who.userId } }, body: { state, code: SECRETS.code } }),
  );
}

/** Google answering for the account `address` with the refresh token `refreshToken`. */
function googleAccount(address: string, refreshToken: string = SECRETS.refreshToken): Record<string, ProviderRoute> {
  return googleRoutes({
    [GOOGLE_TOKEN_URL]: () =>
      json({ access_token: SECRETS.accessToken, expires_in: 3600, refresh_token: refreshToken, token_type: "Bearer" }),
    [GMAIL_PROFILE_URL]: () => json({ emailAddress: address }),
    [GMAIL_SEND_AS_URL]: () => json({ sendAs: [] }),
  });
}

function expectWrongAccount(error: Error): void {
  expect(error).toBeInstanceOf(ChokePointError);
  expect(error).not.toBeInstanceOf(ValidationError);
  expect(error).toMatchObject({ status: 400, code: "mail_reauth_wrong_account", details: undefined });
}

describe("POST /api/mail/mailboxes/:id/reauthorize (issue gh-1742)", () => {
  it("answers Google's authorization URL, as the start route builds it, for a state that carries the mailbox", async () => {
    const mailboxId = await existingMailbox(caller.tenantId);

    const result = await reauthorizeResult(mailboxId);

    expect(result.status).toBe(200);
    const url = new URL(startBody.parse(result.body).authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const state = stateOf(url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "gmail-client-id",
      redirect_uri: REDIRECT_URI,
      scope: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
      state,
      code_challenge: url.searchParams.get("code_challenge"),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    expect(await stateRow(state)).toEqual({
      user_id: caller.userId,
      provider: "gmail",
      mailbox_item_id: mailboxId,
      used_at: null,
    });
    expectNoSecret(JSON.stringify(result), [OLD_REFRESH_TOKEN, SECRETS.gmailClientSecret]);
  });

  it("answers Microsoft's authorization URL with the Graph client for an Outlook mailbox", async () => {
    const mailboxId = await existingMailbox(caller.tenantId, {
      provider: "outlook",
      address: "work.user@contoso.com",
    });

    const url = await reauthorize(mailboxId);

    expect(`${url.origin}${url.pathname}`).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe("graph-client-id");
    expect(url.searchParams.get("scope")).toBe("Mail.ReadWrite Mail.Send offline_access User.Read");
    expect(await stateRow(stateOf(url))).toMatchObject({ provider: "outlook", mailbox_item_id: mailboxId });
  });

  it("answers the same 404 not_found for an unknown, a malformed and a trashed mailbox, and stores no state", async () => {
    const trashed = await existingMailbox(caller.tenantId);
    await runInTenant(caller.tenantId, async () => {
      const { mailboxesDatabaseId } = await withTransaction(runtime, resolveMailModuleIds);
      await createChokePoint(runtime).softDeleteItem(mailboxesDatabaseId, trashed);
    });

    const answers: string[] = [];
    for (const id of [randomUUID(), "not-a-uuid", trashed]) {
      const error = await caught(reauthorizeResult(id));
      expect(error).toMatchObject({ status: 404, code: "not_found", details: undefined });
      answers.push(error.message);
    }

    expect(new Set(answers).size).toBe(1);
    expect(await stateCount()).toBe(0);
  });

  it("answers 404 not_found in a tenant that has no Mailboxes database", async () => {
    // A tenant row without its system databases: nothing was provisioned for it.
    const tenantId = await createTestTenant(admin);
    const unprovisioned: Caller = { tenantId, userId: await newUser(tenantId) };

    const error = await caught(reauthorizeResult(randomUUID(), unprovisioned));

    expect(error).toMatchObject({ status: 404, code: "not_found", details: undefined });
    expect(await stateCount()).toBe(0);
  });

  it("answers another tenant's mailbox exactly like an unknown one, while its owner can reauthorize it", async () => {
    const other = await otherTenantCaller();
    const foreign = await existingMailbox(other.tenantId);

    const refused = await caught(reauthorizeResult(foreign));
    const unknown = await caught(reauthorizeResult(randomUUID()));

    expect(refused).toMatchObject({ status: 404, code: "not_found", details: undefined });
    expect({ name: refused.name, message: refused.message }).toEqual({ name: unknown.name, message: unknown.message });
    expect(await stateCount()).toBe(0);

    const url = await reauthorize(foreign, other);
    expect(await stateRow(stateOf(url))).toMatchObject({ user_id: other.userId, mailbox_item_id: foreign });
  });

  it.each<[string, string | null]>([
    ["an iCloud mailbox", "icloud"],
    ["a generic IMAP mailbox", "generic"],
    ["a mailbox without a provider", null],
  ])(
    "refuses %s, which signs in with a password, with 400 validation_failed and stores no state",
    async (_name, provider) => {
      const mailboxId = await existingMailbox(caller.tenantId, { provider, syncState: false });

      const error = await caught(reauthorizeResult(mailboxId));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "provider" } });
      expect(await stateCount()).toBe(0);
    },
  );

  it.each(["gmail", "outlook"])(
    "refuses an IMAP mailbox relabelled %s, which still signs in with its password, with 400 validation_failed and stores no state",
    async (label) => {
      const mailboxId = await passwordMailbox(caller.tenantId);
      await relabel(caller.tenantId, mailboxId, label);
      const before = await storedMailbox(caller.tenantId, mailboxId);

      const error = await caught(reauthorizeResult(mailboxId));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "provider" } });
      expect(await stateCount()).toBe(0);
      expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
      expect(before).toMatchObject({ refreshToken: IMAP_PASSWORD, syncState: { sync_mode: "imap" } });
      expect(await storedCredentialType(caller.tenantId, mailboxId)).toBe("app_password");
    },
  );

  it.each<[string, ExistingMailbox, string]>([
    ["a Gmail mailbox relabelled outlook", { provider: "gmail" }, "outlook"],
    ["an Outlook mailbox relabelled gmail", { provider: "outlook", address: "work.user@contoso.com" }, "gmail"],
  ])(
    "refuses %s, which still syncs through its own provider's API, with 400 validation_failed and stores no state",
    async (_name, mailbox, label) => {
      const mailboxId = await existingMailbox(caller.tenantId, mailbox);
      await relabel(caller.tenantId, mailboxId, label);
      const before = await storedMailbox(caller.tenantId, mailboxId);

      const error = await caught(reauthorizeResult(mailboxId));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "provider" } });
      expect(await stateCount()).toBe(0);
      expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
      expect(before.refreshToken).toBe(OLD_REFRESH_TOKEN);
    },
  );

  it("fails with a plain configuration error, and stores no state, without the provider's OAuth client", async () => {
    const mailboxId = await existingMailbox(caller.tenantId);

    const error = await caught(
      reauthorizeResult(mailboxId, caller, {
        oauth: { msGraph: OAUTH.msGraph, redirectBaseUrl: OAUTH.redirectBaseUrl },
      }),
    );

    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error.message).toBe('Mail OAuth for provider "gmail" is not configured by the composition root');
    expect(await stateCount()).toBe(0);
  });
});

describe("POST /api/mail/mailboxes/oauth/complete: reauthorization (issue gh-1742)", () => {
  it("replaces the refresh token when the same account signs in, queues a sync, and restarts the lifecycle after the commit", async () => {
    const mailboxId = await existingMailbox(caller.tenantId);
    await inTenant(caller.tenantId, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      await recordGmailActivity(client, {
        itemId: mailboxId,
        historyId: "4711",
        nextExpectedActivityAt: new Date("2031-01-01T00:00:00Z"),
      });
      await updateItemWithClient(
        client,
        { databaseId: mailboxesDatabaseId, itemId: mailboxId, propertiesPatch: { syncStatus: "needsReauthorization" } },
        { allowedSystemKeys: ["syncStatus"] },
      );
    });
    const url = await reauthorize(mailboxId);
    // Google reports the account in another letter case than the stored address.
    const provider = fakeProvider(googleRoutes());
    let seenAtRestart: StoredMailbox | undefined;
    const liveSync = liveSyncSpy(async () => {
      seenAtRestart = await storedMailbox(caller.tenantId, mailboxId);
    });

    const result = await completeReauthorization(stateOf(url), provider, liveSync.control);

    expect(result).toEqual({ status: 200, body: { mailboxId } });
    const expected: StoredMailbox = {
      refreshToken: SECRETS.refreshToken,
      syncState: {
        sync_mode: "gmail_api",
        provider_account_address: GOOGLE_ACCOUNT,
        gmail_watch_email_address: null,
        gmail_history_id: "4711",
        graph_delta_link: null,
      },
      syncStatus: "needsReauthorization",
      jobs: [`mail-account-sync:${mailboxId}`],
    };
    expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(expected);
    // The restart ran once, and another connection already saw the new token and the queued sync then.
    expect(liveSync.restarted).toEqual([mailboxId]);
    expect(seenAtRestart).toEqual(expected);
    expect((await connected()).mailboxes.map((mailbox) => mailbox.id)).toEqual([mailboxId]);
    expect((await stateRow(stateOf(url)))?.used_at).not.toBeNull();
    // The exchange presented this state's verifier, as a new sign-in does.
    expect(provider.calls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_URL, GMAIL_PROFILE_URL, GMAIL_SEND_AS_URL]);
    const verifier = provider.calls[0]?.form?.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier, "utf8").digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
  });

  it("replaces the refresh token of an Outlook mailbox and keeps its delta link", async () => {
    const mailboxId = await existingMailbox(caller.tenantId, {
      provider: "outlook",
      address: "work.user@contoso.com",
    });
    await inTenant(caller.tenantId, (client) =>
      recordGraphActivity(client, {
        itemId: mailboxId,
        deltaLink: "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=kept",
        nextExpectedActivityAt: new Date("2031-01-01T00:00:00Z"),
      }),
    );
    const provider = fakeProvider(microsoftRoutes({ mail: "Work.User@Contoso.com" }));
    const liveSync = liveSyncSpy();

    const result = await completeReauthorization(stateOf(await reauthorize(mailboxId)), provider, liveSync.control);

    expect(result).toEqual({ status: 200, body: { mailboxId } });
    expect(await storedMailbox(caller.tenantId, mailboxId)).toMatchObject({
      refreshToken: SECRETS.refreshToken,
      syncState: {
        sync_mode: "graph_api",
        provider_account_address: "work.user@contoso.com",
        graph_delta_link: "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=kept",
      },
      jobs: [`mail-account-sync:${mailboxId}`],
    });
    expect(liveSync.restarted).toEqual([mailboxId]);
  });

  it("answers 400 mail_reauth_wrong_account when another account signs in, and changes nothing", async () => {
    const mailboxId = await existingMailbox(caller.tenantId);
    const before = await storedMailbox(caller.tenantId, mailboxId);
    expect(before).toMatchObject({ refreshToken: OLD_REFRESH_TOKEN, jobs: [] });
    const state = stateOf(await reauthorize(mailboxId));
    const provider = fakeProvider(googleAccount("someone.else@gmail.com"));
    const liveSync = liveSyncSpy();

    const error = await caught(completeReauthorization(state, provider, liveSync.control));

    expectWrongAccount(error);
    expect(provider.calls).toHaveLength(3);
    expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
    expect(liveSync.restarted).toEqual([]);
    expect((await stateRow(state))?.used_at).not.toBeNull();
  });

  it("accepts and records the signing-in address of a mailbox that records none, when no other mailbox holds it", async () => {
    const mailboxId = await existingMailbox(caller.tenantId, { address: null });
    const liveSync = liveSyncSpy();

    const result = await completeReauthorization(
      stateOf(await reauthorize(mailboxId)),
      fakeProvider(googleAccount(" New.Owner@Gmail.com ")),
      liveSync.control,
    );

    expect(result).toEqual({ status: 200, body: { mailboxId } });
    expect(await storedMailbox(caller.tenantId, mailboxId)).toMatchObject({
      refreshToken: SECRETS.refreshToken,
      // The watch lifecycle owns the watch address; the route leaves it alone.
      syncState: { provider_account_address: "new.owner@gmail.com", gmail_watch_email_address: null },
      jobs: [`mail-account-sync:${mailboxId}`],
    });
    expect(liveSync.restarted).toEqual([mailboxId]);
  });

  it("answers 400 mail_reauth_wrong_account for a mailbox that records no address when another mailbox of the tenant holds the signing-in one", async () => {
    const holder = await existingMailbox(caller.tenantId);
    const mailboxId = await existingMailbox(caller.tenantId, { address: null });
    const before = {
      holder: await storedMailbox(caller.tenantId, holder),
      mailbox: await storedMailbox(caller.tenantId, mailboxId),
    };
    const liveSync = liveSyncSpy();

    const error = await caught(
      completeReauthorization(stateOf(await reauthorize(mailboxId)), fakeProvider(googleRoutes()), liveSync.control),
    );

    expectWrongAccount(error);
    expect({
      holder: await storedMailbox(caller.tenantId, holder),
      mailbox: await storedMailbox(caller.tenantId, mailboxId),
    }).toEqual(before);
    expect(before.mailbox).toMatchObject({ refreshToken: OLD_REFRESH_TOKEN, jobs: [] });
    expect(liveSync.restarted).toEqual([]);
  });

  it("accepts an address that only another tenant's mailbox holds, and leaves that mailbox as it was", async () => {
    const other = await otherTenantCaller();
    const foreign = await existingMailbox(other.tenantId);
    const foreignBefore = await storedMailbox(other.tenantId, foreign);
    const mailboxId = await existingMailbox(caller.tenantId, { address: null });
    const liveSync = liveSyncSpy();

    const result = await completeReauthorization(
      stateOf(await reauthorize(mailboxId)),
      fakeProvider(googleRoutes()),
      liveSync.control,
    );

    expect(result).toEqual({ status: 200, body: { mailboxId } });
    expect(await inTenant(caller.tenantId, (client) => getProviderAccountAddress(client, mailboxId))).toBe(
      GOOGLE_ACCOUNT,
    );
    expect(await storedRefreshToken(caller.tenantId, mailboxId)).toBe(SECRETS.refreshToken);
    expect(await storedMailbox(other.tenantId, foreign)).toEqual({
      ...foreignBefore,
      jobs: [`mail-account-sync:${mailboxId}`],
    });
    expect(foreignBefore.refreshToken).toBe(OLD_REFRESH_TOKEN);
  });

  it("refuses another tenant's reauthorization state like an unknown one, and leaves the mailbox to its owner", async () => {
    const other = await otherTenantCaller();
    const mailboxId = await existingMailbox(caller.tenantId);
    const before = await storedMailbox(caller.tenantId, mailboxId);
    const state = stateOf(await reauthorize(mailboxId));
    const provider = fakeProvider(googleRoutes());
    const liveSync = liveSyncSpy();

    const error = await caught(completeReauthorization(state, provider, liveSync.control, other));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "state" } });
    expect(provider.calls).toEqual([]);
    expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
    expect(liveSync.restarted).toEqual([]);
    expect((await stateRow(state))?.used_at).toBeNull();
  });

  it("creates the sync state of a mailbox no discovery pass has seeded yet, with the signing-in address", async () => {
    const mailboxId = await existingMailbox(caller.tenantId, { syncState: false });
    expect((await storedMailbox(caller.tenantId, mailboxId)).syncState).toBeNull();

    await completeReauthorization(
      stateOf(await reauthorize(mailboxId)),
      fakeProvider(googleRoutes()),
      liveSyncSpy().control,
    );

    expect(await storedMailbox(caller.tenantId, mailboxId)).toMatchObject({
      refreshToken: SECRETS.refreshToken,
      syncState: { sync_mode: "gmail_api", provider_account_address: GOOGLE_ACCOUNT },
      jobs: [`mail-account-sync:${mailboxId}`],
    });
  });

  describe("a state whose mailbox cannot be reauthorized any more", () => {
    async function expectStaleState(state: string, mailboxId: string): Promise<void> {
      const before = await storedMailbox(caller.tenantId, mailboxId);
      const provider = fakeProvider(googleRoutes());
      const liveSync = liveSyncSpy();

      const error = await caught(completeReauthorization(state, provider, liveSync.control));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "state" } });
      // The mailbox is checked in the write transaction, after the provider answered.
      expect(provider.calls).toHaveLength(3);
      expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
      expect(liveSync.restarted).toEqual([]);
      expect((await stateRow(state))?.used_at).not.toBeNull();
    }

    it("refuses a mailbox moved to the trash since the sign-in started", async () => {
      const mailboxId = await existingMailbox(caller.tenantId);
      const state = stateOf(await reauthorize(mailboxId));
      await runInTenant(caller.tenantId, async () => {
        const { mailboxesDatabaseId } = await withTransaction(runtime, resolveMailModuleIds);
        await createChokePoint(runtime).softDeleteItem(mailboxesDatabaseId, mailboxId);
      });

      await expectStaleState(state, mailboxId);
    });

    it("refuses a mailbox whose provider changed since the sign-in started", async () => {
      const mailboxId = await existingMailbox(caller.tenantId);
      const state = stateOf(await reauthorize(mailboxId));
      await inTenant(caller.tenantId, async (client) => {
        const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
        await updateItemWithClient(client, {
          databaseId: mailboxesDatabaseId,
          itemId: mailboxId,
          propertiesPatch: { provider: "outlook" },
        });
      });

      await expectStaleState(state, mailboxId);
    });

    it("refuses an IMAP mailbox relabelled gmail, and keeps its password", async () => {
      const mailboxId = await passwordMailbox(caller.tenantId);
      await relabel(caller.tenantId, mailboxId, "gmail");
      // The reauthorize route refuses this mailbox with 400. Its sync state row can still be seeded
      // after the route read none, so the completion has to refuse the state on its own.
      const { state } = await inTenant(caller.tenantId, (client) =>
        createMailOauthState(client, { userId: caller.userId, provider: "gmail", mailboxItemId: mailboxId }),
      );

      // The mailbox records no provider account address, so the signing-in one would be accepted.
      await expectStaleState(state, mailboxId);

      expect(await storedMailbox(caller.tenantId, mailboxId)).toMatchObject({
        refreshToken: IMAP_PASSWORD,
        syncState: { sync_mode: "imap", provider_account_address: null },
        jobs: [],
      });
      expect(await storedCredentialType(caller.tenantId, mailboxId)).toBe("app_password");
    });

    it("refuses a Gmail mailbox relabelled outlook when a Microsoft account of its address signs in, and keeps its Google token", async () => {
      const mailboxId = await existingMailbox(caller.tenantId);
      await relabel(caller.tenantId, mailboxId, "outlook");
      // As above: the reauthorize route refuses this mailbox with 400.
      const { state } = await inTenant(caller.tenantId, (client) =>
        createMailOauthState(client, { userId: caller.userId, provider: "outlook", mailboxItemId: mailboxId }),
      );
      const before = await storedMailbox(caller.tenantId, mailboxId);
      // The address the mailbox records, so the account check alone would let the token through.
      const provider = fakeProvider(microsoftRoutes({ mail: GOOGLE_ACCOUNT }));
      const liveSync = liveSyncSpy();

      const error = await caught(completeReauthorization(state, provider, liveSync.control));

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "state" } });
      expect(provider.calls.map((call) => call.url)).toEqual([MICROSOFT_TOKEN_URL, GRAPH_ME_URL]);
      expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
      expect(before).toMatchObject({
        refreshToken: OLD_REFRESH_TOKEN,
        syncState: { sync_mode: "gmail_api", provider_account_address: GOOGLE_ACCOUNT },
        jobs: [],
      });
      expect(liveSync.restarted).toEqual([]);
    });

    it("refuses a state that names another tenant's mailbox like one that names none, and leaves that mailbox alone", async () => {
      const other = await otherTenantCaller();
      const foreign = await existingMailbox(other.tenantId);
      const foreignBefore = await storedMailbox(other.tenantId, foreign);
      // No route stores such a state: the reauthorize route refuses a foreign mailbox with 404.
      const { state } = await inTenant(caller.tenantId, (client) =>
        createMailOauthState(client, { userId: caller.userId, provider: "gmail", mailboxItemId: foreign }),
      );

      await expectStaleState(state, foreign);

      expect(await storedMailbox(other.tenantId, foreign)).toEqual(foreignBefore);
      expect(foreignBefore.refreshToken).toBe(OLD_REFRESH_TOKEN);
    });

    it("refuses a state that names no mailbox, and creates no sync state for its id", async () => {
      const unknown = randomUUID();
      const { state } = await inTenant(caller.tenantId, (client) =>
        createMailOauthState(client, { userId: caller.userId, provider: "gmail", mailboxItemId: unknown }),
      );

      await expectStaleState(state, unknown);

      expect(await storedMailbox(caller.tenantId, unknown)).toEqual({
        refreshToken: null,
        syncState: null,
        syncStatus: undefined,
        jobs: [],
      });
    });

    it("refuses a mailbox whose provider changes while the reauthorization waits for its sync state row", async () => {
      const mailboxId = await existingMailbox(caller.tenantId);
      const state = stateOf(await reauthorize(mailboxId));
      const before = await storedMailbox(caller.tenantId, mailboxId);
      const liveSync = liveSyncSpy();
      // Another transaction holds the sync state row. The reauthorization has then read the mailbox
      // without a lock and waits for the row, so only its locked second read can see the change.
      const blocker = await admin.connect();
      let error: Error;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT 1 FROM mail_account_sync_state WHERE item_id = $1 FOR UPDATE", [mailboxId]);
        const outcome = caught(completeReauthorization(state, fakeProvider(googleRoutes()), liveSync.control));
        await vi.waitFor(
          async () => {
            const { rows } = await admin.query<{ waiting: number }>(
              `SELECT count(*)::int AS waiting FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            );
            expect(rows[0]?.waiting).toBe(1);
          },
          { timeout: 10_000 },
        );
        await inTenant(caller.tenantId, async (client) => {
          const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
          await updateItemWithClient(client, {
            databaseId: mailboxesDatabaseId,
            itemId: mailboxId,
            propertiesPatch: { provider: "outlook" },
          });
        });
        await blocker.query("COMMIT");
        error = await outcome;
      } finally {
        // A no-op after the commit; it ends the transaction when a step above failed.
        await blocker.query("ROLLBACK");
        blocker.release();
      }

      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "state" } });
      expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
      expect(liveSync.restarted).toEqual([]);
    });
  });

  it("makes a second account wait for the first one's reauthorization of a mailbox without a recorded address, then refuses it", async () => {
    const mailboxId = await existingMailbox(caller.tenantId, { address: null });
    const states = [stateOf(await reauthorize(mailboxId)), stateOf(await reauthorize(mailboxId))];
    const liveSync = liveSyncSpy();
    const lockWaiters = async (): Promise<number> => {
      const { rows } = await admin.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      return rows[0]?.waiting ?? -1;
    };
    // Another transaction holds the Mailboxes item. The first reauthorization then holds the sync
    // state row and waits for the item, before it has read the recorded address, and the second one
    // waits for the sync state row behind it.
    const blocker = await admin.connect();
    let outcomes: Array<PromiseSettledResult<{ status: number; body: unknown }>>;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM items WHERE id = $1 FOR UPDATE", [mailboxId]);
      const first = completeReauthorization(
        states[0] ?? "",
        fakeProvider(googleAccount("first.account@gmail.com", "SENTINEL-REFRESH-TOKEN-FIRST")),
        liveSync.control,
      );
      const settledFirst = Promise.allSettled([first]);
      await vi.waitFor(async () => expect(await lockWaiters()).toBe(1), { timeout: 10_000 });
      const second = completeReauthorization(
        states[1] ?? "",
        fakeProvider(googleAccount("second.account@gmail.com", "SENTINEL-REFRESH-TOKEN-SECOND")),
        liveSync.control,
      );
      const settledSecond = Promise.allSettled([second]);
      await vi.waitFor(async () => expect(await lockWaiters()).toBe(2), { timeout: 10_000 });
      await blocker.query("COMMIT");
      outcomes = [...(await settledFirst), ...(await settledSecond)];
    } finally {
      // A no-op after the commit; it ends the transaction when a step above failed.
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    // The second one read the address only after the first committed it, so it is another account.
    expect(outcomes[0]).toEqual({ status: "fulfilled", value: { status: 200, body: { mailboxId } } });
    expect(outcomes[1]?.status).toBe("rejected");
    expect(outcomes[1]).toMatchObject({ reason: { status: 400, code: "mail_reauth_wrong_account" } });
    expect(await storedMailbox(caller.tenantId, mailboxId)).toMatchObject({
      refreshToken: "SENTINEL-REFRESH-TOKEN-FIRST",
      syncState: { provider_account_address: "first.account@gmail.com" },
      jobs: [`mail-account-sync:${mailboxId}`],
    });
    expect(liveSync.restarted).toEqual([mailboxId]);
  });

  it("stores neither the token nor the address when queueing the sync fails: all three are one transaction", async () => {
    const mailboxId = await existingMailbox(caller.tenantId, { address: null });
    const before = await storedMailbox(caller.tenantId, mailboxId);
    const state = stateOf(await reauthorize(mailboxId));
    const failure = new Error("the queue refused the job");
    // The runtime pool, except that the statement that queues the job fails.
    const failingEnqueuePool = new Proxy(runtime, {
      get(target, property, receiver) {
        if (property !== "connect") return Reflect.get(target, property, receiver) as unknown;
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty, clientReceiver) {
              const value: unknown = Reflect.get(clientTarget, clientProperty, clientReceiver);
              if (clientProperty !== "query" || typeof value !== "function") return value;
              return (...args: unknown[]) =>
                typeof args[0] === "string" && args[0].includes("graphile_worker.add_job")
                  ? Promise.reject(failure)
                  : (Reflect.apply(value, clientTarget, args) as unknown);
            },
          });
        };
      },
    });
    const liveSync = liveSyncSpy();

    const error = await caught(
      completeReauthorization(state, fakeProvider(googleRoutes()), liveSync.control, caller, failingEnqueuePool),
    );

    expect(error).toBe(failure);
    expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
    expect(before).toMatchObject({ refreshToken: OLD_REFRESH_TOKEN, syncState: { provider_account_address: null } });
    expect(liveSync.restarted).toEqual([]);
  });

  it("fails with a plain configuration error before any provider request when the composition root set no live-sync restart", async () => {
    const mailboxId = await existingMailbox(caller.tenantId);
    const before = await storedMailbox(caller.tenantId, mailboxId);
    const state = stateOf(await reauthorize(mailboxId));
    const provider = fakeProvider(googleRoutes());

    // `complete` mounts the route with the OAuth client and the outbound fetch only.
    const error = await caught(complete({ state, code: SECRETS.code }, provider));

    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error.message).toBe("The mail live-sync restart is not configured by the composition root");
    expect(provider.calls).toEqual([]);
    expect((await stateRow(state))?.used_at).not.toBeNull();
    expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
  });

  it("propagates a failed restart as an unexpected error, with the token already replaced and the sync queued", async () => {
    const mailboxId = await existingMailbox(caller.tenantId);
    const failure = new Error("the lifecycle factory failed");
    const liveSync = liveSyncSpy(async () => {
      throw failure;
    });

    const error = await caught(
      completeReauthorization(stateOf(await reauthorize(mailboxId)), fakeProvider(googleRoutes()), liveSync.control),
    );

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(await storedMailbox(caller.tenantId, mailboxId)).toMatchObject({
      refreshToken: SECRETS.refreshToken,
      jobs: [`mail-account-sync:${mailboxId}`],
    });
    expect(liveSync.restarted).toEqual([mailboxId]);
  });

  it("answers 400 validation_failed for a code the provider refuses, and leaves the mailbox as it was", async () => {
    const mailboxId = await existingMailbox(caller.tenantId);
    const before = await storedMailbox(caller.tenantId, mailboxId);
    const provider = fakeProvider({ [GOOGLE_TOKEN_URL]: () => json({ error: "invalid_grant" }, 400) });
    const liveSync = liveSyncSpy();

    const error = await caught(
      completeReauthorization(stateOf(await reauthorize(mailboxId)), provider, liveSync.control),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, code: "validation_failed", details: { field: "code" } });
    expect(await storedMailbox(caller.tenantId, mailboxId)).toEqual(before);
    expect(liveSync.restarted).toEqual([]);
  });

  describe("with the live-sync root hosting Gmail watch lifecycles", () => {
    /** A watch transport that records the credential every `users.watch` registration presented. */
    function recordingTransport(): { transport: GmailWatchTransport; registered: string[] } {
      const registered: string[] = [];
      return {
        registered,
        transport: {
          async registerWatch(_mailboxItemId, credential) {
            registered.push(credential);
            return { historyId: "1", expiresAt: new Date("2031-01-01T00:00:00Z") };
          },
          pull: async () => [],
          acknowledge: async () => undefined,
        },
      };
    }

    /** The root as `semprec-api` composes it for Gmail: the watch lifecycle reads the stored credential in `start()`. */
    function gmailWatchRoot(transport: GmailWatchTransport) {
      const startErrors: string[] = [];
      const watch = createGmailWatchLifecycleFactory(runtime, transport, {
        getCredential: async (mailboxItemId) => {
          const credential = await getDecryptedCredential(runtime, {
            itemId: mailboxItemId,
            actorType: "sync_worker",
            purpose: "gmail_watch",
          });
          if (credential === null) throw new Error(`Mailbox ${mailboxItemId} has no stored credential`);
          return credential;
        },
        getAccountEmailAddress: async (mailboxItemId) => {
          const address = await withTransaction(runtime, (client) => getProviderAccountAddress(client, mailboxItemId));
          if (address === null) throw new Error(`Mailbox ${mailboxItemId} has no provider-verified account address`);
          return address;
        },
      });
      // Counts every lifecycle the root creates, so "exactly one hosted" is what the counters say.
      const lifecycles: Array<{ starts: number; stops: number }> = [];
      const factory: MailLiveSyncLifecycleFactory = (account) => {
        const lifecycle = watch(account);
        const counters = { starts: 0, stops: 0 };
        lifecycles.push(counters);
        return {
          async start() {
            counters.starts += 1;
            await lifecycle.start();
          },
          async stop() {
            counters.stops += 1;
            await lifecycle.stop();
          },
        };
      };
      const root = createMailLiveSyncRoot(runtime, factory, {
        onLifecycleError: (_mailboxItemId, phase) => startErrors.push(phase),
      });
      return { root, lifecycles, startErrors };
    }

    it("leaves exactly one hosted lifecycle, which registers its watch with the new token", async () => {
      const mailboxId = await existingMailbox(caller.tenantId);
      const { transport, registered } = recordingTransport();
      const { root, lifecycles, startErrors } = gmailWatchRoot(transport);
      try {
        await root.reconcileOnce();
        await vi.waitFor(() => expect(registered).toEqual([OLD_REFRESH_TOKEN]));

        const result = await completeReauthorization(
          stateOf(await reauthorize(mailboxId)),
          fakeProvider(googleRoutes()),
          root,
        );

        expect(result).toEqual({ status: 200, body: { mailboxId } });
        await vi.waitFor(() => expect(registered).toEqual([OLD_REFRESH_TOKEN, SECRETS.refreshToken]));
        // The old lifecycle was stopped once and the new one is the only one running.
        expect(lifecycles).toEqual([
          { starts: 1, stops: 1 },
          { starts: 1, stops: 0 },
        ]);
        // A discovery pass afterwards hosts no further lifecycle for the mailbox.
        await root.reconcileOnce();
        expect(lifecycles).toHaveLength(2);
        expect(startErrors).toEqual([]);
      } finally {
        await root.stop();
      }
    });

    it("replaces a lifecycle whose start() had failed for want of a credential, and the new one holds the new token", async () => {
      const mailboxId = await existingMailbox(caller.tenantId, { credential: false });
      const { transport, registered } = recordingTransport();
      const { root, lifecycles, startErrors } = gmailWatchRoot(transport);
      try {
        await root.reconcileOnce();
        // A second pass leaves the failed lifecycle in place: only the restart replaces it.
        await root.reconcileOnce();
        expect(startErrors).toEqual(["start"]);
        expect(lifecycles).toEqual([{ starts: 1, stops: 0 }]);
        expect(registered).toEqual([]);

        await completeReauthorization(stateOf(await reauthorize(mailboxId)), fakeProvider(googleRoutes()), root);

        await vi.waitFor(() => expect(registered).toEqual([SECRETS.refreshToken]));
        expect(lifecycles).toEqual([
          { starts: 1, stops: 1 },
          { starts: 1, stops: 0 },
        ]);
        expect(startErrors).toEqual(["start"]);
      } finally {
        await root.stop();
      }
    });
  });

  it("queues a sync that is due at once and that, run by the sync job, brings new mail in with the new token", async () => {
    const mailboxId = await existingMailbox(caller.tenantId);

    await completeReauthorization(
      stateOf(await reauthorize(mailboxId)),
      fakeProvider(googleRoutes()),
      liveSyncSpy().control,
    );

    const queued = await admin.query<{ due: boolean }>(
      "SELECT run_at <= now() AS due FROM graphile_worker.jobs WHERE key = $1",
      [`mail-account-sync:${mailboxId}`],
    );
    expect(queued.rows).toEqual([{ due: true }]);

    // The job as the worker runs it, with Gmail answering one message that is new to this server.
    const presented: string[] = [];
    const gmail: GmailMailClient = {
      getCurrentHistoryId: async () => "1",
      listHistorySince: async () => ({
        invalidated: false,
        newHistoryId: "2",
        changedMessageIds: [],
        removedMessageIds: [],
      }),
      listAllMessageIds: async () => ["new-message"],
      listLabels: async () => [{ id: "INBOX", name: "Inbox", type: "system" }],
      fetchMessage: async () => ({
        id: "new-message",
        threadId: "new-thread",
        labelIds: ["INBOX"],
        message: {
          messageId: `<${randomUUID()}@example.test>`,
          subject: "Arrived after the reauthorization",
          envelope: { from: { address: "sender@example.test" } },
          attachments: [],
        },
      }),
      modifyMessageLabels: async () => undefined,
    };
    const root = await mkdtemp(join(tmpdir(), "semprec-mail-reauth-sync-"));
    try {
      await runInTenant(caller.tenantId, async () => {
        const moduleIds = await withTransaction(runtime, resolveMailModuleIds);
        await handleSyncMailAccountTask(
          runtime,
          { mailboxItemId: mailboxId },
          {
            createGmailClient: (_mailboxItemId, credential) => {
              presented.push(credential);
              return gmail;
            },
          },
          moduleIds,
          new LocalFsBlobStorageWriter(root),
        );
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(presented).toEqual([SECRETS.refreshToken]);
    const messages = await inTenant(caller.tenantId, (client) =>
      client.query<{ n: number }>("SELECT count(*)::int AS n FROM mail_message_meta WHERE mailbox_item_id = $1", [
        mailboxId,
      ]),
    );
    expect(messages.rows).toEqual([{ n: 1 }]);
    // The successful pass, not the route, is what writes the status.
    expect((await storedMailbox(caller.tenantId, mailboxId)).syncStatus).toBe("ok");
  });

  it("keeps the code, the verifier, the old and the new token out of the response, the logs and the tenant export", async () => {
    const logs = captureLogs();
    const mailboxId = await existingMailbox(caller.tenantId);
    const url = await reauthorize(mailboxId);
    const provider = fakeProvider(googleRoutes());

    const result = await completeReauthorization(stateOf(url), provider, liveSyncSpy().control);

    const verifier = provider.calls[0]?.form?.get("code_verifier");
    if (!verifier) throw new Error("the token request carried no verifier");
    const secrets = [...Object.values(SECRETS), OLD_REFRESH_TOKEN, verifier];
    expectNoSecret(JSON.stringify(result), secrets);
    expectNoSecret(url.toString(), secrets);

    // The refusals log through the same loggers: another account, and a code the provider rejects.
    const wrongAccount = await caught(
      completeReauthorization(
        stateOf(await reauthorize(mailboxId)),
        fakeProvider(googleAccount("someone.else@gmail.com")),
        liveSyncSpy().control,
      ),
    );
    expectWrongAccount(wrongAccount);
    const rejected = await caught(
      completeReauthorization(
        stateOf(await reauthorize(mailboxId)),
        fakeProvider({ [GOOGLE_TOKEN_URL]: () => json({ error: "invalid_grant" }, 400) }),
        liveSyncSpy().control,
      ),
    );
    expectNoSecret(inspect([wrongAccount, rejected], { depth: 8 }), secrets);
    expectNoSecret(logs(), secrets);

    const entries = await exportEntries(caller);
    const names = entries.map((entry) => entry.name);
    expect(names).toContain("tables/mail_account_sync_state.jsonl");
    expect(names).not.toContain("tables/external_credentials.jsonl");
    expect(names).not.toContain("tables/mail_oauth_states.jsonl");
    expect(entries.some((entry) => entry.content.includes(Buffer.from(mailboxId)))).toBe(true);
    for (const entry of entries) {
      expect(
        secrets.filter((secret) => entry.content.includes(Buffer.from(secret))),
        `export entry ${entry.name}`,
      ).toEqual([]);
    }
  });
});

describe("mail account sync state store: connect flow additions (issue gh-1686)", () => {
  async function mailboxWithState(tenantId: string): Promise<string> {
    return inTenant(tenantId, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      const item = await createItemWithClient(client, {
        databaseId: mailboxesDatabaseId,
        properties: { name: "Mailbox", provider: "gmail" },
      });
      await ensureMailAccountSyncState(client, { itemId: item.id, syncMode: "gmail_api" });
      return item.id;
    });
  }

  it("finds the tenant's mailbox by its provider account address in any letter case, and no other tenant's", async () => {
    const other = await otherTenantCaller();
    const mailboxId = await mailboxWithState(caller.tenantId);
    await inTenant(caller.tenantId, (client) => recordProviderAccountAddress(client, mailboxId, "Owner@Example.com"));

    const find = (tenantId: string, address: string) =>
      inTenant(tenantId, (client) => findMailboxByProviderAccountAddress(client, address));
    expect(await find(caller.tenantId, " OWNER@example.com ")).toBe(mailboxId);
    expect(await find(caller.tenantId, "nobody@example.com")).toBeNull();
    expect(await find(other.tenantId, "owner@example.com")).toBeNull();
  });

  it("stores the Gmail watch address normalized, and refuses an empty address and an unknown mailbox", async () => {
    const mailboxId = await mailboxWithState(caller.tenantId);
    const watchAddress = async (): Promise<string | null | undefined> => {
      const { rows } = await inTenant(caller.tenantId, (client) =>
        client.query<{ gmail_watch_email_address: string | null }>(
          "SELECT gmail_watch_email_address FROM mail_account_sync_state WHERE item_id = $1",
          [mailboxId],
        ),
      );
      return rows[0]?.gmail_watch_email_address;
    };

    await inTenant(caller.tenantId, (client) => recordGmailWatchEmailAddress(client, mailboxId, " Watch@Gmail.com "));
    expect(await watchAddress()).toBe("watch@gmail.com");

    const empty = await caught(
      inTenant(caller.tenantId, (client) => recordGmailWatchEmailAddress(client, mailboxId, "  ")),
    );
    expect(empty).toBeInstanceOf(ValidationError);
    expect(empty).toMatchObject({ details: { field: "gmailWatchEmailAddress" } });
    const unknown = await caught(
      inTenant(caller.tenantId, (client) => recordGmailWatchEmailAddress(client, randomUUID(), "x@gmail.com")),
    );
    expect(unknown.message).toContain("to affect at least one row");
    expect(await watchAddress()).toBe("watch@gmail.com");
  });
});
