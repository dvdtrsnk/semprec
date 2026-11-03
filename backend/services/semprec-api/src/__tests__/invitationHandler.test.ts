import { createServer, request as httpRequest, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import {
  acceptInvitation,
  createInvite,
  createUser,
  hashToken,
  revokeInvite,
  withTransaction,
  type CreatedInvite,
} from "@semprec/data";
import { createRuntimeRolePool, getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import { createClientIpThrottle } from "../clientIpThrottle.js";
import { createInvitationRequestListener, type InvitationRequestListenerOptions } from "../invitationHandler.js";
import { logger } from "../logger.js";

const APP_BASE_URL = "https://app.example.test";
const PASSWORD = "correct-horse-battery";
const UNISSUED_TOKEN = "a-token-that-was-never-issued";
const INVITEE = "novak@example.cz";
// Each acceptance that succeeds builds the new tenant's system databases before it answers.
const PROVISIONING_TEST_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The email in a `{ user }` answer, parsed from its body text; any other shape fails the test. */
function userEmailOf(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.user)) throw new Error(`expected a { user } body, got ${text}`);
  return parsed.user.email;
}

function tokenFromUrl(inviteUrl: string): string {
  const token = new URL(inviteUrl).hash.replace("#token=", "");
  if (token.length === 0) throw new Error(`no token in ${inviteUrl}`);
  return token;
}

describe("createInvitationRequestListener (issue #1087)", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  let inviterId: string;
  const servers: Server[] = [];

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    const inviter = await createUser(adminPool, {
      email: `admin-${randomUUID()}@example.test`,
      passwordHash: "x",
      tenantId: await tenantForNextTestUser(adminPool),
      role: "admin",
    });
    inviterId = inviter.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  afterAll(async () => {
    await dataPool.end();
  });

  /** Starts the listener on a loopback port and returns its base URL. */
  async function serve(
    options: InvitationRequestListenerOptions = { trustProxy: false },
    pool: Pool = dataPool,
  ): Promise<string> {
    const server = createServer(createInvitationRequestListener(pool, options));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  /** Creates a pending invitation through the production store; returns its id and raw token. */
  async function issue(email: string): Promise<{ id: string; token: string }> {
    const created: CreatedInvite = await runAsSystem("invitationHandlerTest", () =>
      withTransaction(dataPool, (client) =>
        createInvite(client, { email, invitedBy: inviterId, appBaseUrl: APP_BASE_URL, mailer: null }),
      ),
    );
    return { id: created.invite.id, token: tokenFromUrl(created.inviteUrl) };
  }

  function post(baseUrl: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/api/invitations/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
  }

  function accept(
    baseUrl: string,
    token: string,
    password = PASSWORD,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return post(baseUrl, JSON.stringify({ token, password }), headers);
  }

  it(
    "answers 200 with the new account, and the tenant it creates is active",
    async () => {
      const baseUrl = await serve();
      const { token } = await issue(INVITEE);

      const res = await accept(baseUrl, token);
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(userEmailOf(text)).toBe(INVITEE);
      expect(text).not.toContain("passwordHash");
      const { rows } = await adminPool.query<{ status: string }>(
        "SELECT t.status FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.email = $1",
        [INVITEE],
      );
      expect(rows).toEqual([{ status: "active" }]);
    },
    PROVISIONING_TEST_TIMEOUT_MS,
  );

  it("answers every unusable token with the same 404 body: unknown, expired, revoked and used", async () => {
    const baseUrl = await serve();
    const expired = await issue(INVITEE);
    // No production writer ages an invitation, so the expiry is set by raw SQL on the superuser pool.
    await adminPool.query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    const revoked = await issue("revoked@example.cz");
    await runAsSystem("invitationHandlerTest", () =>
      withTransaction(dataPool, (client) => revokeInvite(client, revoked.id)),
    );
    const used = await issue("used@example.cz");
    await acceptInvitation(dataPool, { token: used.token, password: PASSWORD }, async () => undefined);

    const answers: Array<{ status: number; text: string }> = [];
    for (const token of [UNISSUED_TOKEN, expired.token, revoked.token, used.token]) {
      const res = await accept(baseUrl, token);
      answers.push({ status: res.status, text: await res.text() });
    }

    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404, 404]);
    expect(new Set(answers.map((answer) => answer.text)).size).toBe(1);
  });

  it("answers 400 for a missing token", async () => {
    const baseUrl = await serve();

    const res = await post(baseUrl, JSON.stringify({ password: PASSWORD }));

    expect(res.status).toBe(400);
  });

  it("answers 400 for a password that is not a string", async () => {
    const baseUrl = await serve();

    const res = await post(baseUrl, JSON.stringify({ token: UNISSUED_TOKEN, password: 12345 }));

    expect(res.status).toBe(400);
  });

  it("answers 400 for a short password, whichever token it carries", async () => {
    const baseUrl = await serve();
    const { token } = await issue(INVITEE);

    const res = await accept(baseUrl, token, "short");

    expect(res.status).toBe(400);
  });

  it("answers 400 for a body that is a JSON array rather than an object", async () => {
    const baseUrl = await serve();

    const res = await post(baseUrl, "[]");

    expect(res.status).toBe(400);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const baseUrl = await serve();

    const res = await post(baseUrl, "{not json");

    expect(res.status).toBe(400);
  });

  it("answers 413 for a body over the 64 KiB cap", async () => {
    const throttle = createClientIpThrottle({ limits: { invitationAccept: { maxEvents: 1, windowSeconds: 3600 } } });
    const baseUrl = await serve({ trustProxy: true, clientIpThrottle: throttle });
    const ip = "203.0.113.8";

    const res = await post(baseUrl, JSON.stringify({ token: "x".repeat(70 * 1024), password: PASSWORD }), {
      "X-Forwarded-For": ip,
    });

    expect(res.status).toBe(413);
    expect(throttle.retryAfterSeconds("invitationAccept", ip)).toBeNull();
  });

  it("answers 404 for a GET on the route and for a POST on another path", async () => {
    const baseUrl = await serve();

    const getRes = await fetch(`${baseUrl}/api/invitations/accept`);
    const otherPathRes = await fetch(`${baseUrl}/api/invitations/accept/extra`, { method: "POST", body: "{}" });

    expect(getRes.status).toBe(404);
    expect(await getRes.json()).toEqual({ error: "Not found" });
    expect(otherPathRes.status).toBe(404);
  });

  it(
    "answers 429 past the per-address limit, counts only unusable tokens, and still serves another address",
    async () => {
      const throttle = createClientIpThrottle({ limits: { invitationAccept: { maxEvents: 2, windowSeconds: 3600 } } });
      const baseUrl = await serve({ trustProxy: true, clientIpThrottle: throttle });
      const first = { "X-Forwarded-For": "203.0.113.7" };
      const second = { "X-Forwarded-For": "198.51.100.9" };

      // A validation failure does not count, so three of them do not exhaust the two-event budget.
      for (let i = 0; i < 3; i += 1) {
        expect((await post(baseUrl, "{}", first)).status).toBe(400);
      }
      // A success does not count either.
      expect((await accept(baseUrl, (await issue(INVITEE)).token, PASSWORD, first)).status).toBe(200);
      // Two unusable tokens count, and the next request from the address is over the limit.
      expect((await accept(baseUrl, UNISSUED_TOKEN, PASSWORD, first)).status).toBe(404);
      expect((await accept(baseUrl, UNISSUED_TOKEN, PASSWORD, first)).status).toBe(404);
      const refused = await accept(baseUrl, UNISSUED_TOKEN, PASSWORD, first);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(await refused.json()).toEqual({ error: "Too many attempts; try again later", code: "rate_limited" });

      // Another address is not affected by the first one's budget.
      expect((await accept(baseUrl, (await issue("other@example.cz")).token, PASSWORD, second)).status).toBe(200);
    },
    PROVISIONING_TEST_TIMEOUT_MS,
  );

  it(
    "reserves concurrent slow requests before reading bodies and releases validation failures",
    async () => {
      const throttle = createClientIpThrottle({ limits: { invitationAccept: { maxEvents: 2, windowSeconds: 3600 } } });
      const listener = createInvitationRequestListener(dataPool, { trustProxy: true, clientIpThrottle: throttle });
      let arrivals = 0;
      let notifyArrived: () => void = () => {};
      const allArrived = new Promise<void>((resolve) => {
        notifyArrived = resolve;
      });
      const server = createServer((req, res) => {
        if (++arrivals === 3) notifyArrived();
        listener(req, res);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const ip = "203.0.113.7";
      const otherIp = "198.51.100.9";
      const otherInvite = await issue("concurrent-other@example.test");
      const payload = "{}";
      const requests = Array.from({ length: 3 }, () => {
        const req = httpRequest(`${baseUrl}/api/invitations/accept`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(payload)),
            "X-Forwarded-For": ip,
          },
        });
        const status = new Promise<number>((resolve, reject) => {
          req.on("response", (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
            res.on("error", reject);
          });
          req.on("error", reject);
          req.setTimeout(30000, () => req.destroy(new Error("request timed out")));
        });
        return { req, status };
      });
      const settled = Promise.all(requests.map(({ status }) => status));
      const timeout = setTimeout(() => {
        for (const { req } of requests) req.destroy(new Error("arrival timeout"));
      }, 30000);
      let primary: { error: unknown } | undefined;
      try {
        for (const { req } of requests) req.flushHeaders();
        await Promise.race([allArrived, settled]);
        const first = await Promise.race(requests.map(({ status }, index) => status.then((code) => ({ code, index }))));
        expect(first.code).toBe(429);
        const other = await fetch(`${baseUrl}/api/invitations/accept`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": otherIp },
          body: JSON.stringify({ token: otherInvite.token, password: PASSWORD }),
          signal: AbortSignal.timeout(20000),
        });
        await other.arrayBuffer();
        expect(other.status).toBe(200);
        for (const [index, { req }] of requests.entries()) if (index !== first.index) req.end(payload);
        const statuses = await settled;
        expect(statuses.filter((status) => status === 400)).toHaveLength(2);
        expect(statuses.filter((status) => status === 429)).toHaveLength(1);
        expect(throttle.retryAfterSeconds("invitationAccept", ip)).toBeNull();
        expect((await accept(baseUrl, UNISSUED_TOKEN, PASSWORD, { "X-Forwarded-For": ip })).status).toBe(404);
        expect((await accept(baseUrl, UNISSUED_TOKEN, PASSWORD, { "X-Forwarded-For": ip })).status).toBe(404);
        expect((await accept(baseUrl, UNISSUED_TOKEN, PASSWORD, { "X-Forwarded-For": ip })).status).toBe(429);
      } catch (error) {
        primary = { error };
      }
      clearTimeout(timeout);
      const cleanupError = new Error("owned request cleanup");
      const cleanupFailures: unknown[] = [];
      for (const { req } of requests) {
        try {
          req.destroy(cleanupError);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
      for (const result of await Promise.allSettled(requests.map(({ status }) => status))) {
        if (
          result.status === "rejected" &&
          result.reason !== cleanupError &&
          (!primary || result.reason !== primary.error)
        )
          cleanupFailures.push(result.reason);
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => reject(new Error("server cleanup timed out")), 5000);
          server.close((error) => {
            clearTimeout(deadline);
            if (error) reject(error);
            else resolve();
          });
          server.closeAllConnections();
        });
        servers.splice(servers.indexOf(server), 1);
      } catch (error) {
        cleanupFailures.push(error);
      }
      if (cleanupFailures.length)
        throw new AggregateError(
          primary ? [primary.error, ...cleanupFailures] : cleanupFailures,
          "Request cleanup failed",
          { cause: primary?.error },
        );
      if (primary?.error instanceof Error) throw primary.error;
      if (primary) throw new Error("Held request test failed", { cause: primary.error });
    },
    PROVISIONING_TEST_TIMEOUT_MS,
  );

  it("answers 500 without the token, the email or the password when a step after the commit fails", async () => {
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    // The superuser pool makes provisionTenant refuse the connection's role after the invitation is consumed.
    const throttle = createClientIpThrottle({ limits: { invitationAccept: { maxEvents: 1, windowSeconds: 3600 } } });
    const baseUrl = await serve({ trustProxy: true, clientIpThrottle: throttle }, adminPool);
    const { token } = await issue(INVITEE);
    const ip = "203.0.113.9";

    const res = await accept(baseUrl, token, PASSWORD, { "X-Forwarded-For": ip });

    expect(res.status).toBe(500);
    expect(throttle.retryAfterSeconds("invitationAccept", ip)).toBeNull();
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(errorLog).toHaveBeenCalledWith(
      { errorName: "Error", method: "POST", path: "/api/invitations/accept" },
      "Unexpected error handling request",
    );
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(hashToken(token));
    expect(logged).not.toContain(INVITEE);
    expect(logged).not.toContain(PASSWORD);
  });

  describe("displayName (issue #1513)", () => {
    async function storedDisplayName(email: string): Promise<string | null | undefined> {
      const { rows } = await adminPool.query<{ display_name: string | null }>(
        "SELECT display_name FROM users WHERE email = $1",
        [email],
      );
      return rows[0]?.display_name;
    }

    it(
      "stores the trimmed displayName on the accepted account and returns it",
      async () => {
        const baseUrl = await serve();
        const { token } = await issue(INVITEE);

        const res = await post(baseUrl, JSON.stringify({ token, password: PASSWORD, displayName: "  Novak  " }));

        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        expect(body).toMatchObject({ user: { displayName: "Novak" } });
        expect(await storedDisplayName(INVITEE)).toBe("Novak");
      },
      PROVISIONING_TEST_TIMEOUT_MS,
    );

    it(
      "stores NULL when displayName is omitted",
      async () => {
        const baseUrl = await serve();
        const { token } = await issue(INVITEE);

        const res = await accept(baseUrl, token);

        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        expect(body).toMatchObject({ user: { displayName: null } });
        expect(await storedDisplayName(INVITEE)).toBeNull();
      },
      PROVISIONING_TEST_TIMEOUT_MS,
    );

    it(
      "refuses an invalid displayName with 400 naming the field, and the invitation is still accepted afterwards",
      async () => {
        const baseUrl = await serve();
        const { token } = await issue(INVITEE);

        for (const displayName of ["a".repeat(81), "   ", 42]) {
          const res = await post(baseUrl, JSON.stringify({ token, password: PASSWORD, displayName }));
          expect(res.status).toBe(400);
          expect(await res.json()).toMatchObject({ code: "validation_failed", details: { field: "displayName" } });
        }
        expect(await storedDisplayName(INVITEE)).toBeUndefined();

        const accepted = await accept(baseUrl, token);
        expect(accepted.status).toBe(200);
      },
      PROVISIONING_TEST_TIMEOUT_MS,
    );
  });
});
