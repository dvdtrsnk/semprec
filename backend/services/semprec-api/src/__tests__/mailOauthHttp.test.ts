import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg, { type Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createItemWithClient,
  createMailLiveSyncRoot,
  createUser,
  getDecryptedCredential,
  GOOGLE_TOKEN_URL,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  MICROSOFT_TOKEN_URL,
  provisionTenant,
  resolveMailModuleIds,
  withTransaction,
  type MailLiveSyncLifecycleFactory,
  type MailLiveSyncRoot,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import type { CustomRouteDependencies } from "../adapter/customRouteMount.js";
import { createMailLiveSyncControl } from "../mailLiveSyncControl.js";
import { logger } from "../logger.js";

/**
 * Issue gh-1686 through the production composition path: the real dispatcher, the mail module's
 * manifest routes behind the REST adapter, and the hand-wired public callback. The data package's
 * `mailOauthRoutes.test.ts` covers every branch of the handlers; this file covers what only the
 * HTTP layer decides: the public callback, the status and body of each error, and the adapter's log.
 * For issue gh-1742 it also composes the mail live-sync root the way `serve.ts` does: the dispatcher
 * gets the control first, and the root is created and bound to it afterwards.
 */

const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";

const SECRETS = {
  code: "SENTINEL-AUTHORIZATION-CODE",
  accessToken: "SENTINEL-ACCESS-TOKEN",
  refreshToken: "SENTINEL-REFRESH-TOKEN",
  newRefreshToken: "SENTINEL-NEW-REFRESH-TOKEN",
  clientSecret: "SENTINEL-CLIENT-SECRET",
};

const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const blobStorage = new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-mail-oauth-${randomUUID()}`));
const originalScopeMode = process.env.SEMPREC_TENANT_SCOPE;

type ProviderRoute = (init: RequestInit | undefined) => Response | Promise<Response>;

/** What the provider answers in the running test; reset after each one. */
let providerRoutes: Record<string, ProviderRoute> = {};

/** The composition root's outbound `fetch`: every provider request of the routes under test lands here. */
const outboundHttp: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const route = providerRoutes[url];
  if (!route) throw new Error(`unexpected provider request to ${url}`);
  return route(init);
};

/** The control the dispatcher is mounted with; `beforeAll` binds the live-sync root to it. */
const liveSync = createMailLiveSyncControl();

const dependencies: CustomRouteDependencies = {
  oauth: {
    gmail: { clientId: "gmail-client-id", clientSecret: SECRETS.clientSecret },
    msGraph: { clientId: "graph-client-id", clientSecret: SECRETS.clientSecret },
    redirectBaseUrl: "https://app.example.test",
  },
  outboundHttp,
  mailLiveSync: liveSync.control,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Google answering for the account `address`, issuing `refreshToken`. */
function googleAccount(address: string, refreshToken: string = SECRETS.refreshToken): Record<string, ProviderRoute> {
  return {
    [GOOGLE_TOKEN_URL]: () =>
      json({ access_token: SECRETS.accessToken, expires_in: 3600, refresh_token: refreshToken }),
    [GMAIL_PROFILE_URL]: () => json({ emailAddress: address }),
    [GMAIL_SEND_AS_URL]: () => json({ sendAs: [{ sendAsEmail: address, isPrimary: true }] }),
  };
}

let adminPool: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;
let bearer: Record<string, string>;
let tenantId: string;
let root: MailLiveSyncRoot;

/** What each hosted lifecycle did, in order; a start records the credential it read, as the real lifecycles do. */
const lifecycleEvents: Array<{ mailboxItemId: string; event: "start" | "stop"; credential?: string | null }> = [];

const recordingLifecycles: MailLiveSyncLifecycleFactory = (account) => ({
  async start() {
    const credential = await getDecryptedCredential(pool, {
      itemId: account.mailboxItemId,
      actorType: "sync_worker",
      purpose: "test",
    });
    lifecycleEvents.push({ mailboxItemId: account.mailboxItemId, event: "start", credential });
  },
  async stop() {
    lifecycleEvents.push({ mailboxItemId: account.mailboxItemId, event: "stop" });
  },
});

function eventsOf(mailboxId: string): Array<{ event: "start" | "stop"; credential?: string | null }> {
  return lifecycleEvents
    .filter((entry) => entry.mailboxItemId === mailboxId)
    .map(({ event, credential }) => (event === "start" ? { event, credential } : { event }));
}

/** The mailbox's stored refresh token, read inside its tenant. */
function storedToken(mailboxId: string): Promise<string | null> {
  return runInTenant(tenantId, () =>
    getDecryptedCredential(pool, { itemId: mailboxId, actorType: "sync_worker", purpose: "test" }),
  );
}

async function listen(options: { customRouteDependencies?: CustomRouteDependencies }): Promise<Server> {
  const dispatch = await createDispatcher(pool, {
    passwordResetMailer: noopMailer,
    appBaseUrl: "https://app.example.test",
    setupToken: "mail-oauth-setup-token",
    moduleRegistry,
    blobStorage,
    maxFileSizeBytes: 1024 * 1024,
    ...options,
  });
  const listening = createServer(dispatch);
  await new Promise<void>((resolve) => listening.listen(0, resolve));
  return listening;
}

function urlOf(listening: Server): string {
  const address = listening.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return `http://127.0.0.1:${address.port}`;
}

interface Answer {
  status: number;
  body: unknown;
  headers: Headers;
}

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").startsWith("application/json");
  const answer: Answer = { status: res.status, body: isJson ? JSON.parse(text) : text, headers: res.headers };
  return answer;
}

const startBody = z.object({ authorizeUrl: z.string() }).strict();
const completeBody = z.object({ mailboxId: z.uuid() }).strict();

/** Starts a sign-in through the real route and returns the provider URL it answered. */
async function start(provider: "gmail" | "outlook"): Promise<URL> {
  const answer = await request("POST", "/api/mail/mailboxes/oauth/start", { provider }, bearer);
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return new URL(startBody.parse(answer.body).authorizeUrl);
}

function stateOf(authorizeUrl: URL): string {
  const state = authorizeUrl.searchParams.get("state");
  if (state === null) throw new Error("the authorization URL carries no state");
  return state;
}

function complete(state: string): Promise<Answer> {
  return request("POST", "/api/mail/mailboxes/oauth/complete", { state, code: SECRETS.code }, bearer);
}

/** `used_at` of the row of `state`, read as the superuser. */
async function usedAt(state: string): Promise<Date | null | undefined> {
  const { rows } = await adminPool.query<{ used_at: Date | null }>(
    "SELECT used_at FROM mail_oauth_states WHERE state_hash = $1",
    [createHash("sha256").update(state, "utf8").digest("hex")],
  );
  return rows[0]?.used_at;
}

/** Counts every statement any pool of this process sends while `fn` runs. */
async function statementsDuring(fn: () => Promise<void>): Promise<number> {
  const spy = vi.spyOn(pg.Client.prototype, "query");
  try {
    await fn();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  process.env.SEMPREC_TENANT_SCOPE = "strict";
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  pool = await createRuntimeRolePool(adminPool, "semprec_data");
  server = await listen({ customRouteDependencies: dependencies });
  baseUrl = urlOf(server);
  // Created after the dispatcher and bound to the control it already holds, in `serve.ts`'s order.
  root = createMailLiveSyncRoot(pool, recordingLifecycles);
  liveSync.bind(root);

  tenantId = await createTestTenant(adminPool);
  await provisionTenant(pool, tenantId);
  const email = `${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const passwordHash = await hashPassword(password);
  // `users` is a global identity table, written outside any tenant as account creation does.
  await runAsSystem("test-fixture-create-user", () => createUser(adminPool, { email, passwordHash, tenantId }));
  const login = await request("POST", "/api/auth/login", { email, password, platform: "ios" });
  expect(login.status).toBe(200);
  bearer = { Authorization: `Bearer ${z.object({ token: z.string() }).parse(login.body).token}` };
}, 120_000);

afterEach(() => {
  providerRoutes = {};
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await root?.stop();
  await pool?.end();
  await adminPool?.end();
  if (originalScopeMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
  else process.env.SEMPREC_TENANT_SCOPE = originalScopeMode;
});

describe("GET /api/mail/oauth/callback (issue gh-1686)", () => {
  it("is the redirect target the start route names, and hands the code and state on without touching the database", async () => {
    const authorizeUrl = await start("gmail");
    const state = stateOf(authorizeUrl);
    const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
    expect(redirect.origin).toBe("https://app.example.test");
    redirect.search = new URLSearchParams({ state, code: "4/0Ab-code_from.google" }).toString();

    let answer: Answer | undefined;
    const statements = await statementsDuring(async () => {
      answer = await request("GET", `${redirect.pathname}${redirect.search}`);
    });

    expect(answer?.status).toBe(200);
    expect(answer?.body).toEqual({ state, code: "4/0Ab-code_from.google" });
    expect(answer?.headers.get("cache-control")).toBe("no-store");
    expect(answer?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(answer?.headers.get("set-cookie")).toBeNull();
    // No statement at all: neither a session lookup nor a write.
    expect(statements).toBe(0);
    expect(await usedAt(state)).toBeNull();
  });

  it("answers the same with a session presented as without one, and still sends no statement", async () => {
    const path = "/api/mail/oauth/callback?state=some-state&code=some-code";

    const anonymous = await request("GET", path);
    let signedIn: Answer | undefined;
    const statements = await statementsDuring(async () => {
      signedIn = await request("GET", path, undefined, bearer);
    });

    expect(anonymous.status).toBe(200);
    expect(signedIn?.status).toBe(200);
    expect(signedIn?.body).toEqual(anonymous.body);
    expect(statements).toBe(0);
  });

  it("hands on the provider's error, such as a cancelled consent, instead of a code", async () => {
    let answer: Answer | undefined;
    const statements = await statementsDuring(async () => {
      answer = await request("GET", "/api/mail/oauth/callback?error=access_denied&state=some-state&code=ignored");
    });

    expect(answer?.status).toBe(200);
    expect(answer?.body).toEqual({ state: "some-state", providerError: "access_denied" });
    expect(statements).toBe(0);
  });

  it.each([
    ["no state", "code=some-code"],
    ["a state with a character outside base64url", "state=some%20state&code=some-code"],
    ["a state above the length cap", `state=${"s".repeat(513)}&code=some-code`],
    ["an error that is no short token", "state=some-state&error=Access%20denied%3Cscript%3E"],
    ["neither a code nor an error", "state=some-state"],
    ["an empty code", "state=some-state&code="],
    ["a code above the length cap", `state=some-state&code=${"c".repeat(4097)}`],
  ])("refuses a request with %s with 400 validation_failed", async (_name, query) => {
    let answer: Answer | undefined;
    const statements = await statementsDuring(async () => {
      answer = await request("GET", `/api/mail/oauth/callback?${query}`);
    });

    expect(answer?.status).toBe(400);
    expect(answer?.body).toEqual({ error: { code: "validation_failed" } });
    expect(answer?.headers.get("cache-control")).toBe("no-store");
    expect(statements).toBe(0);
  });

  it("accepts a state and a code exactly at their length caps", async () => {
    const state = "s".repeat(512);
    const code = "c".repeat(4096);

    const answer = await request("GET", `/api/mail/oauth/callback?state=${state}&code=${code}`);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ state, code });
  });

  it("is public for GET only: a POST to the path needs a session and then finds no route", async () => {
    const path = "/api/mail/oauth/callback?state=some-state&code=some-code";

    expect((await request("POST", path, {})).status).toBe(401);
    expect((await request("POST", path, {}, bearer)).status).toBe(404);
  });
});

describe("the mailbox sign-in routes behind the REST adapter (issue gh-1686)", () => {
  it("connects a mailbox over HTTP and serves it through the mailbox detail route", async () => {
    const address = `${randomUUID()}@gmail.com`;
    providerRoutes = googleAccount(address);

    const answer = await complete(stateOf(await start("gmail")));

    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    const { mailboxId } = completeBody.parse(answer.body);
    const detail = await request("GET", `/api/mail/mailboxes/${mailboxId}`, undefined, bearer);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: mailboxId,
      name: "Gmail",
      provider: "gmail",
      primaryAddress: address,
      addresses: [address],
      syncMode: "gmail_api",
    });
    expect(JSON.stringify([answer.body, detail.body])).not.toContain("SENTINEL-");
  });

  it("answers 409 with the existing mailbox's id when the address is already connected", async () => {
    providerRoutes = googleAccount(`${randomUUID()}@gmail.com`);
    const first = completeBody.parse((await complete(stateOf(await start("gmail")))).body);

    const second = await complete(stateOf(await start("gmail")));

    expect(second.status).toBe(409);
    expect(second.body).toEqual({
      error: { code: "provider_account_already_connected", details: { mailboxId: first.mailboxId } },
    });
  });

  it("answers 400 mail_admin_consent_required for a Microsoft tenant that needs administrator approval", async () => {
    providerRoutes = { [MICROSOFT_TOKEN_URL]: () => json({ error: "consent_required" }, 400) };

    const answer = await complete(stateOf(await start("outlook")));

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: { code: "mail_admin_consent_required" } });
  });

  it("answers 400 validation_failed naming the code when the provider refuses it as invalid_grant, and logs no error", async () => {
    const logged = vi.spyOn(logger, "error");
    providerRoutes = { [GOOGLE_TOKEN_URL]: () => json({ error: "invalid_grant" }, 400) };

    const answer = await complete(stateOf(await start("gmail")));

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: { code: "validation_failed", details: { field: "code" } } });
    expect(logged).not.toHaveBeenCalled();
  });

  it("answers a token endpoint that refuses the OAuth client with a generic 500, and logs the provider's error code without a secret", async () => {
    const logged = vi.spyOn(logger, "error");
    providerRoutes = { [GOOGLE_TOKEN_URL]: () => json({ error: "invalid_client" }, 401) };

    const answer = await complete(stateOf(await start("gmail")));

    // A wrong or expired client secret is this deployment's fault: the caller learns nothing, the operator does.
    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ error: { code: "internal_error" } });
    expect(logged).toHaveBeenCalledTimes(1);
    const record = inspect(logged.mock.calls, { depth: 8 });
    expect(record).toContain("OAuth code exchange rejected the authorization code (status 401, error invalid_client)");
    expect(Object.values(SECRETS).filter((secret) => record.includes(secret))).toEqual([]);
  });

  it("answers a provider outage with a generic 500, and its log record names no code, token or secret", async () => {
    const logged = vi.spyOn(logger, "error");
    providerRoutes = {
      ...googleAccount(`${randomUUID()}@gmail.com`),
      [GMAIL_PROFILE_URL]: (init) =>
        Promise.reject(new Error(`request with ${String(new Headers(init?.headers).get("authorization"))} failed`)),
    };

    const answer = await complete(stateOf(await start("gmail")));

    expect(answer.status).toBe(500);
    expect(answer.body).toEqual({ error: { code: "internal_error" } });
    expect(logged).toHaveBeenCalledTimes(1);
    const record = inspect(logged.mock.calls, { depth: 8 });
    expect(record).toContain("Gmail profile request failed");
    expect(Object.values(SECRETS).filter((secret) => record.includes(secret))).toEqual([]);
  });

  it("answers a generic 500 from a deployment that configured no OAuth client", async () => {
    const unconfigured = await listen({});
    try {
      const res = await fetch(`${urlOf(unconfigured)}/api/mail/mailboxes/oauth/start`, {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "gmail" }),
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "internal_error" } });
    } finally {
      await new Promise<void>((resolve) => unconfigured.close(() => resolve()));
    }
  });
});

describe("reauthorizing a mailbox behind the REST adapter, with the live-sync root bound to the routes' control (issue gh-1742)", () => {
  /** Connects a mailbox for `address` over HTTP and lets a discovery pass host it. */
  async function hostedMailbox(address: string): Promise<string> {
    providerRoutes = googleAccount(address);
    const answer = await complete(stateOf(await start("gmail")));
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    const { mailboxId } = completeBody.parse(answer.body);
    await root.reconcileOnce();
    expect(eventsOf(mailboxId)).toEqual([{ event: "start", credential: SECRETS.refreshToken }]);
    return mailboxId;
  }

  function reauthorize(mailboxId: string, headers: Record<string, string> = bearer): Promise<Answer> {
    return request("POST", `/api/mail/mailboxes/${mailboxId}/reauthorize`, {}, headers);
  }

  /** Starts a reauthorization through the real route and returns the state the provider would hand back. */
  async function reauthorizationState(mailboxId: string): Promise<string> {
    const answer = await reauthorize(mailboxId);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return stateOf(new URL(startBody.parse(answer.body).authorizeUrl));
  }

  it("replaces the token and restarts the hosted lifecycle, which reads the new token, leaving one lifecycle hosted", async () => {
    const address = `${randomUUID()}@gmail.com`;
    const mailboxId = await hostedMailbox(address);
    const state = await reauthorizationState(mailboxId);
    providerRoutes = googleAccount(address.toUpperCase(), SECRETS.newRefreshToken);

    const answer = await complete(state);

    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(answer.body).toEqual({ mailboxId });
    expect(await storedToken(mailboxId)).toBe(SECRETS.newRefreshToken);
    expect(eventsOf(mailboxId)).toEqual([
      { event: "start", credential: SECRETS.refreshToken },
      { event: "stop" },
      { event: "start", credential: SECRETS.newRefreshToken },
    ]);
    // A discovery pass afterwards finds the replacement hosted and starts nothing more.
    await root.reconcileOnce();
    expect(eventsOf(mailboxId)).toHaveLength(3);
  });

  it("answers 400 mail_reauth_wrong_account when another account signs in, and keeps the token and the lifecycle", async () => {
    const mailboxId = await hostedMailbox(`${randomUUID()}@gmail.com`);
    const state = await reauthorizationState(mailboxId);
    providerRoutes = googleAccount(`${randomUUID()}@gmail.com`, SECRETS.newRefreshToken);

    const answer = await complete(state);

    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: { code: "mail_reauth_wrong_account" } });
    expect(await storedToken(mailboxId)).toBe(SECRETS.refreshToken);
    expect(eventsOf(mailboxId)).toEqual([{ event: "start", credential: SECRETS.refreshToken }]);
  });

  it("answers 404 for an unknown mailbox, 400 for a mailbox that signs in with a password and 401 without a session", async () => {
    const passwordMailbox = await runInTenant(tenantId, () =>
      withTransaction(pool, async (client) => {
        const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
        const item = await createItemWithClient(client, {
          databaseId: mailboxesDatabaseId,
          properties: { name: "iCloud", provider: "icloud" },
        });
        return item.id;
      }),
    );

    const unknown = await reauthorize(randomUUID());
    const password = await reauthorize(passwordMailbox);
    const anonymous = await reauthorize(passwordMailbox, {});

    expect({ status: unknown.status, body: unknown.body }).toEqual({
      status: 404,
      body: { error: { code: "not_found" } },
    });
    expect({ status: password.status, body: password.body }).toEqual({
      status: 400,
      body: { error: { code: "validation_failed", details: { field: "provider" } } },
    });
    expect(anonymous.status).toBe(401);
  });

  it("answers a generic 500 when the restart fails after the commit, and logs it without a secret", async () => {
    const address = `${randomUUID()}@gmail.com`;
    const mailboxId = await hostedMailbox(address);
    // The same composition, except that no root was ever bound to the control.
    const unbound = await listen({
      customRouteDependencies: { ...dependencies, mailLiveSync: createMailLiveSyncControl().control },
    });
    const logged = vi.spyOn(logger, "error");
    try {
      const post = (path: string, body: unknown): Promise<Response> =>
        fetch(`${urlOf(unbound)}${path}`, {
          method: "POST",
          headers: { ...bearer, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      const started = await post(`/api/mail/mailboxes/${mailboxId}/reauthorize`, {});
      const state = stateOf(new URL(startBody.parse(await started.json()).authorizeUrl));
      providerRoutes = googleAccount(address, SECRETS.newRefreshToken);

      const answer = await post("/api/mail/mailboxes/oauth/complete", { state, code: SECRETS.code });

      expect(answer.status).toBe(500);
      expect(await answer.json()).toEqual({ error: { code: "internal_error" } });
    } finally {
      await new Promise<void>((resolve) => unbound.close(() => resolve()));
    }
    // The token was replaced before the restart was tried; the lifecycle of the bound root was not touched.
    expect(await storedToken(mailboxId)).toBe(SECRETS.newRefreshToken);
    expect(eventsOf(mailboxId)).toEqual([{ event: "start", credential: SECRETS.refreshToken }]);
    expect(logged).toHaveBeenCalledTimes(1);
    const record = inspect(logged.mock.calls, { depth: 8 });
    expect(record).toContain('"mailLiveSync.restartAccount" was called before the mail live-sync root exists');
    expect(Object.values(SECRETS).filter((secret) => record.includes(secret))).toEqual([]);
  });
});
