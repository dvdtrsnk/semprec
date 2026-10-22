import { createServer, request as httpRequest, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import { createInvite, createUser, revokeInvite, withTransaction } from "@semprec/data";
import { createClientIpThrottle, type ClientIpThrottle } from "../clientIpThrottle.js";
import { createInvitationRequestListener } from "../invitationHandler.js";
import { logger } from "../logger.js";

const PASSWORD = "invitee-password";
const PATH = "/api/invitations/accept";
/** The per-address limit the throttle tests run against, small enough to reach in a few requests. */
const LIMIT = 3;

let adminPool: Pool;
let dataPool: Pool;
let inviterId: string;

interface Answer {
  status: number;
  text: string;
  headers: Headers;
}

function tokenFromUrl(inviteUrl: string): string {
  const token = new URL(inviteUrl).hash.replace("#token=", "");
  if (token.length === 0) throw new Error(`no token in ${inviteUrl}`);
  return token;
}

/** Issues an invitation through the production writer and returns its id and raw token. */
async function invite(email = `${randomUUID()}@example.test`): Promise<{ id: string; token: string }> {
  const created = await runAsSystem("test", () =>
    withTransaction(dataPool, (client) =>
      createInvite(client, { email, invitedBy: inviterId, appBaseUrl: "https://app.example.test", mailer: null }),
    ),
  );
  return { id: created.invite.id, token: tokenFromUrl(created.inviteUrl) };
}

async function startServer(pool: Pool, clientIpThrottle?: ClientIpThrottle): Promise<{ server: Server; url: string }> {
  const server = createServer(createInvitationRequestListener(pool, { trustProxy: true, clientIpThrottle }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("createInvitationRequestListener (issue #1087)", () => {
  let server: Server;
  let baseUrl: string;
  let throttle: ClientIpThrottle;

  async function post(body: unknown, options: { ip?: string; method?: string; path?: string } = {}): Promise<Answer> {
    const res = await fetch(`${baseUrl}${options.path ?? PATH}`, {
      method: options.method ?? "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": options.ip ?? "203.0.113.1" },
      body: options.method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text(), headers: res.headers };
  }

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    inviterId = (
      await createUser(adminPool, {
        email: "admin@example.test",
        passwordHash: "x",
        tenantId: getTenantZeroId(),
        role: "admin",
      })
    ).id;
    throttle = createClientIpThrottle({ limits: { invitationAccept: { maxEvents: LIMIT, windowSeconds: 3600 } } });
    ({ server, url: baseUrl } = await startServer(dataPool, throttle));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stopServer(server);
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it("accepts a pending invitation with 200 { user }", async () => {
    const pending = await invite("invitee@example.test");

    const answer = await post({ token: pending.token, password: PASSWORD });

    expect(answer.status).toBe(200);
    const body = JSON.parse(answer.text) as { user: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(["user"]);
    expect(body.user.email).toBe("invitee@example.test");
    expect(body.user).not.toHaveProperty("passwordHash");
    const { rows } = await adminPool.query<{ status: string; role: string }>(
      "SELECT t.status, u.role FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1",
      [body.user.id],
    );
    expect(rows).toEqual([{ status: "active", role: "member" }]);
  });

  it("answers every unusable token with a byte-identical 404", async () => {
    const expired = await invite();
    // No production path backdates an invitation; expiry otherwise takes seven days.
    await adminPool.query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    const revoked = await invite();
    await runAsSystem("test", () => withTransaction(dataPool, (client) => revokeInvite(client, revoked.id)));
    const used = await invite();
    expect((await post({ token: used.token, password: PASSWORD }, { ip: "198.51.100.9" })).status).toBe(200);
    const taken = await invite("taken@example.test");
    await createUser(adminPool, {
      email: "taken@example.test",
      passwordHash: "x",
      tenantId: await createTestTenant(adminPool),
    });

    const tokens = [randomUUID(), expired.token, revoked.token, used.token, taken.token];
    // A fresh address per request keeps this test clear of the throttle.
    const answers = [];
    for (const [i, token] of tokens.entries()) {
      answers.push(await post({ token, password: PASSWORD }, { ip: `192.0.2.${i + 1}` }));
    }

    for (const answer of answers) expect(answer.status).toBe(404);
    expect(new Set(answers.map((answer) => answer.text)).size).toBe(1);
  });

  it.each([
    ["a missing token", { password: PASSWORD }],
    ["an empty token", { token: "", password: PASSWORD }],
    ["a missing password", { token: "some-token" }],
    ["a non-string password", { token: "some-token", password: 12345678 }],
    ["a short password", { token: "some-token", password: "short" }],
    ["a JSON null body", null],
    ["a JSON array body", []],
  ])("answers 400 for %s", async (_label, body) => {
    const answer = await post(body);
    expect(answer.status).toBe(400);
  });

  it("answers 400 for a short password even when the token is valid, and leaves the invitation pending", async () => {
    const pending = await invite();
    const answer = await post({ token: pending.token, password: "short" });
    expect(answer.status).toBe(400);
    const { rows } = await adminPool.query<{ accepted_at: Date | null }>(
      "SELECT accepted_at FROM invites WHERE id = $1",
      [pending.id],
    );
    expect(rows).toEqual([{ accepted_at: null }]);
  });

  it("answers 413 for a body over 64 KiB", async () => {
    const answer = await post({ token: "x".repeat(65 * 1024), password: PASSWORD });
    expect(answer.status).toBe(413);
  });

  it("answers 429 past the per-address limit, counting only unusable-token 404s, while another address is served", async () => {
    const ip = "203.0.113.50";
    // Neither 400s, 413s nor a successful acceptance count toward the limit.
    for (let i = 0; i < LIMIT + 1; i++) expect((await post({ token: "t" }, { ip })).status).toBe(400);
    for (let i = 0; i < LIMIT + 1; i++) {
      expect((await post({ token: "x".repeat(65 * 1024), password: PASSWORD }, { ip })).status).toBe(413);
    }
    const pending = await invite();
    expect((await post({ token: pending.token, password: PASSWORD }, { ip })).status).toBe(200);
    for (let i = 0; i < LIMIT; i++) {
      expect((await post({ token: randomUUID(), password: PASSWORD }, { ip })).status).toBe(404);
    }

    // Refused before the body is read: even a valid invitation is not accepted.
    const another = await invite();
    const refused = await post({ token: another.token, password: PASSWORD }, { ip });
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.text)).toEqual({ error: "Too many attempts; try again later", code: "rate_limited" });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await post({}, { ip })).status).toBe(429);

    const other = await post({ token: another.token, password: PASSWORD }, { ip: "203.0.113.51" });
    expect(other.status).toBe(200);
  });

  it("lets at most the limit of a concurrent burst of unusable tokens from one address reach acceptance", async () => {
    let arrived = 0;
    let allArrived!: () => void;
    const allArrivedPromise = new Promise<void>((resolve) => (allArrived = resolve));
    const burstSize = LIMIT * 2;
    const listener = createInvitationRequestListener(dataPool, {
      trustProxy: true,
      clientIpThrottle: createClientIpThrottle({
        limits: { invitationAccept: { maxEvents: LIMIT, windowSeconds: 3600 } },
      }),
    });
    const burstServer = createServer((req, res) => {
      if (++arrived === burstSize) allArrived();
      listener(req, res);
    });
    await new Promise<void>((resolve) => burstServer.listen(0, resolve));
    const address = burstServer.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");

    const requests = Array.from({ length: burstSize }, () => {
      const payload = JSON.stringify({ token: randomUUID(), password: PASSWORD });
      const req = httpRequest(`http://127.0.0.1:${address.port}${PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
          "X-Forwarded-For": "203.0.113.77",
        },
      });
      const status = new Promise<number>((resolve, reject) => {
        req.on("response", (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("burst request timed out")));
      });
      return { req, payload, status };
    });
    const statuses = Promise.all(requests.map(({ status }) => status));
    try {
      for (const { req } of requests) req.flushHeaders();
      // Every request passes the throttle check before any body is sent, so a check that counts only
      // after the token lookup would let the whole burst through.
      await Promise.race([allArrivedPromise, statuses]);
      for (const { req, payload } of requests) req.end(payload);
      const answered = await statuses;
      expect(answered.filter((status) => status === 404)).toHaveLength(LIMIT);
      expect(answered.filter((status) => status === 429)).toHaveLength(burstSize - LIMIT);
    } finally {
      for (const { req } of requests) req.destroy();
      await Promise.allSettled(requests.map(({ status }) => status));
      await stopServer(burstServer);
    }
  });

  it.each([
    ["GET", PATH],
    ["PUT", PATH],
    ["POST", "/api/invitations/other"],
  ])("answers %s %s with 404", async (method, path) => {
    const answer = await post({}, { method, path });
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.text)).toEqual({ error: "Not found" });
  });

  it("answers an infrastructure failure with a 500 whose log line names neither token nor password", async () => {
    const pending = await invite("broken@example.test");
    const closedPool = await createRuntimeRolePool(adminPool, "semprec_data");
    await closedPool.end();
    const broken = await startServer(closedPool);
    const logged = vi.spyOn(logger, "error");
    try {
      const res = await fetch(`${broken.url}${PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pending.token, password: PASSWORD }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal server error" });
    } finally {
      await stopServer(broken.server);
    }
    expect(logged).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(logged.mock.calls[0]);
    expect(line).not.toContain(pending.token);
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain("broken@example.test");
  });
});
