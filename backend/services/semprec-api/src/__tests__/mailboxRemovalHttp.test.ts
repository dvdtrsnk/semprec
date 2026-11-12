import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createMailLiveSyncRoot,
  createUser,
  GOOGLE_TOKEN_URL,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  provisionTenant,
  type MailLiveSyncRoot,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import type { CustomRouteDependencies } from "../adapter/customRouteMount.js";
import { createMailLiveSyncControl, type MailLiveSyncControlBinding } from "../mailLiveSyncControl.js";

/**
 * Issue gh-2030 through the production composition path: the real dispatcher mounts the mail
 * module's removal route with the composition root's container, and that container's `mailLiveSync`
 * member is the control `serve.ts` creates and binds to the live-sync root. The data package's
 * `mailboxRemovalProviderCleanup.test.ts` covers every branch of the cleanup and
 * `mailLiveSyncControl.unit.test.ts` the control; this file covers the wiring from the HTTP request
 * to the root and to the provider.
 */

const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_SEND_AS_URL = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
const GOOGLE_TOKEN_REVOCATION_URL = "https://oauth2.googleapis.com/revoke";

const SECRETS = {
  code: "SENTINEL-AUTHORIZATION-CODE",
  accessToken: "SENTINEL-ACCESS-TOKEN",
  refreshToken: "SENTINEL-REFRESH-TOKEN",
  clientSecret: "SENTINEL-CLIENT-SECRET",
};

const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const blobStorage = new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-mailbox-removal-${randomUUID()}`));
const originalScopeMode = process.env.SEMPREC_TENANT_SCOPE;

interface ProviderCall {
  url: string;
  form: URLSearchParams | null;
}

/** Every provider request of the routes under test, in order. */
let providerCalls: ProviderCall[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Google answering the sign-in of one account and the cleanup of its mailbox. */
function googleAnswers(address: string): Record<string, () => Response> {
  return {
    [GOOGLE_TOKEN_URL]: () =>
      json({ access_token: SECRETS.accessToken, expires_in: 3600, refresh_token: SECRETS.refreshToken }),
    [GMAIL_PROFILE_URL]: () => json({ emailAddress: address }),
    [GMAIL_SEND_AS_URL]: () => json({ sendAs: [{ sendAsEmail: address, isPrimary: true }] }),
    [GOOGLE_TOKEN_REVOCATION_URL]: () => json({}),
  };
}

let providerAnswers: Record<string, () => Response> = {};

/** The composition root's outbound `fetch`: every provider request of the routes under test lands here. */
const outboundHttp: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  providerCalls.push({ url, form: init?.body instanceof URLSearchParams ? init.body : null });
  const answer = providerAnswers[url];
  if (!answer) throw new Error(`unexpected provider request to ${url}`);
  return answer();
};

/** The container as `serve.ts` builds it: the OAuth clients, the outbound `fetch` and the given live-sync control. */
function dependenciesWith(control: MailLiveSyncControlBinding): CustomRouteDependencies {
  return {
    oauth: {
      gmail: { clientId: "gmail-client-id", clientSecret: SECRETS.clientSecret },
      redirectBaseUrl: "https://app.example.test",
    },
    outboundHttp,
    mailLiveSync: control.control,
  };
}

let adminPool: Pool;
let pool: Pool;
let bearer: Record<string, string>;
const servers: Server[] = [];
let roots: MailLiveSyncRoot[] = [];

/** A listening server over the real dispatcher with `customRouteDependencies`, and its base URL. */
async function listen(customRouteDependencies: CustomRouteDependencies): Promise<string> {
  const dispatch = await createDispatcher(pool, {
    passwordResetMailer: noopMailer,
    appBaseUrl: "https://app.example.test",
    setupToken: "mailbox-removal-setup-token",
    moduleRegistry,
    blobStorage,
    maxFileSizeBytes: 1024 * 1024,
    customRouteDependencies,
  });
  const server = createServer(dispatch);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = bearer,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").startsWith("application/json");
  const parsed: unknown = isJson ? JSON.parse(text) : text;
  return { status: res.status, body: parsed };
}

const startBody = z.object({ authorizeUrl: z.string() }).strict();
const completeBody = z.object({ mailboxId: z.uuid() }).strict();

/** Connects a Gmail mailbox through the real sign-in routes, so that its credential is a stored refresh token. */
async function connectGmailMailbox(baseUrl: string): Promise<string> {
  providerAnswers = googleAnswers(`${randomUUID()}@gmail.com`);
  const started = await request(baseUrl, "POST", "/api/mail/mailboxes/oauth/start", { provider: "gmail" });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const state = new URL(startBody.parse(started.body).authorizeUrl).searchParams.get("state");
  const completed = await request(baseUrl, "POST", "/api/mail/mailboxes/oauth/complete", {
    state,
    code: SECRETS.code,
  });
  expect(completed.status, JSON.stringify(completed.body)).toBe(201);
  providerCalls = [];
  return completeBody.parse(completed.body).mailboxId;
}

/** A live-sync root over the runtime pool whose lifecycles record their starts and stops. */
function recordingRoot(): { root: MailLiveSyncRoot; starts: string[]; stops: string[] } {
  const starts: string[] = [];
  const stops: string[] = [];
  const root = createMailLiveSyncRoot(pool, (account) => ({
    async start() {
      starts.push(account.mailboxItemId);
    },
    async stop() {
      stops.push(account.mailboxItemId);
    },
  }));
  roots.push(root);
  return { root, starts, stops };
}

beforeAll(async () => {
  process.env.SEMPREC_TENANT_SCOPE = "strict";
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  pool = await createRuntimeRolePool(adminPool, "semprec_data");

  const tenantId = await createTestTenant(adminPool);
  await provisionTenant(pool, tenantId);
  const email = `${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const passwordHash = await hashPassword(password);
  // `users` is a global identity table, written outside any tenant as account creation does.
  await runAsSystem("test-fixture-create-user", () => createUser(adminPool, { email, passwordHash, tenantId }));
  const login = await request(await listen({}), "POST", "/api/auth/login", { email, password, platform: "ios" }, {});
  expect(login.status).toBe(200);
  bearer = { Authorization: `Bearer ${z.object({ token: z.string() }).parse(login.body).token}` };
}, 120_000);

afterEach(async () => {
  providerAnswers = {};
  providerCalls = [];
  for (const root of roots) await root.stop();
  roots = [];
});

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool?.end();
  await adminPool?.end();
  if (originalScopeMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
  else process.env.SEMPREC_TENANT_SCOPE = originalScopeMode;
});

describe("DELETE /api/mail/mailboxes/:id behind the REST adapter (issue gh-2030)", () => {
  it("stops the mailbox's hosted lifecycle through the bound control and revokes its stored token before it answers", async () => {
    const control = createMailLiveSyncControl();
    const baseUrl = await listen(dependenciesWith(control));
    const mailboxId = await connectGmailMailbox(baseUrl);
    const hosting = recordingRoot();
    control.bind(hosting.root);
    await hosting.root.reconcileOnce();
    expect(hosting.starts).toEqual([mailboxId]);

    const answer = await request(baseUrl, "DELETE", `/api/mail/mailboxes/${mailboxId}`);

    expect(answer).toEqual({ status: 200, body: { id: mailboxId } });
    expect(hosting.stops).toEqual([mailboxId]);
    // The mailbox has no recorded watch, so the one provider call is the revocation of the token the sign-in stored.
    expect(providerCalls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_REVOCATION_URL]);
    expect(Object.fromEntries(providerCalls[0]?.form ?? [])).toEqual({ token: SECRETS.refreshToken });
    expect(JSON.stringify(answer.body)).not.toContain("SENTINEL-");

    await hosting.root.reconcileOnce();
    expect(hosting.starts).toEqual([mailboxId]);
    expect((await request(baseUrl, "DELETE", `/api/mail/mailboxes/${mailboxId}`)).status).toBe(404);
  });

  it("answers 200 and still revokes the token when the control is not bound to a root", async () => {
    const baseUrl = await listen(dependenciesWith(createMailLiveSyncControl()));
    const mailboxId = await connectGmailMailbox(baseUrl);

    const answer = await request(baseUrl, "DELETE", `/api/mail/mailboxes/${mailboxId}`);

    expect(answer).toEqual({ status: 200, body: { id: mailboxId } });
    expect(providerCalls.map((call) => call.url)).toEqual([GOOGLE_TOKEN_REVOCATION_URL]);
    expect((await request(baseUrl, "DELETE", `/api/mail/mailboxes/${mailboxId}`)).status).toBe(404);
  });
});
