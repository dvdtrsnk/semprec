import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTenantZeroId, resetDatabase } from "@semprec/data/testSupport";
import {
  createPool,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  type PasswordResetMailer,
} from "@semprec/data";
import { runInTenant, TenantScopeConflictError } from "@semprec/shared";
import { createDispatcher } from "../app.js";
import { authenticateRequest } from "../authHandler.js";
import { ROUTE_MATRIX } from "../routeMatrix.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const customRouteDefinitions = await moduleRegistry.getCustomRouteDefinitions();

const ADAPTER_PATH_PREFIXES = ["/api/databases", "/api/properties", "/api/views", "/api/items"];

function pathPatternToRegExp(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

function isAdapterServed(method: string, path: string): boolean {
  const pathname = path.split("?")[0]!;
  if (ADAPTER_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return true;
  return customRouteDefinitions.some((d) => d.method === method && pathPatternToRegExp(d.path).test(pathname));
}

async function withScopeMode<T>(mode: "warn" | "strict", fn: () => Promise<T>): Promise<T> {
  const original = process.env.SEMPREC_TENANT_SCOPE;
  process.env.SEMPREC_TENANT_SCOPE = mode;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = original;
  }
}

describe("tenant scope on the real dispatcher", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set");
    pool ??= createPool(url);
    await resetDatabase(pool);

    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "tenant-scope-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await pool.query("UPDATE tenants SET status = 'active'");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function newSession(): Promise<{ token: string; sessionId: string }> {
    const user = await createUser(pool, {
      tenantId: getTenantZeroId(),
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token, session } = await login(pool, {
      email: user.email,
      password: PASSWORD,
      platform: "ios",
      ip: "127.0.0.1",
    });
    return { token, sessionId: session.id };
  }

  async function lastSeenAt(sessionId: string): Promise<string> {
    const { rows } = await pool.query<{ lastSeenAt: Date }>(
      'SELECT last_seen_at AS "lastSeenAt" FROM sessions WHERE id = $1',
      [sessionId],
    );
    return rows[0]!.lastSeenAt.toISOString();
  }

  it.each(["suspended", "provisioning", "deleting"])(
    "answers a session in a %s tenant exactly like a garbage token, without bumping last_seen_at",
    async (status) => {
      const { token, sessionId } = await newSession();
      const before = await lastSeenAt(sessionId);
      await pool.query("UPDATE tenants SET status = $1", [status]);

      for (const path of ["/api/auth/session", "/api/databases"]) {
        const garbage = await fetch(`${baseUrl}${path}`, { headers: { Authorization: "Bearer garbage" } });
        const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status).toBe(401);
        expect(garbage.status).toBe(401);
        expect(await res.text()).toBe(await garbage.text());
      }
      expect(await lastSeenAt(sessionId)).toBe(before);
    },
  );

  it("serves every adapter-mounted ROUTE_MATRIX route with the same status under strict as under warn", async () => {
    const routes = ROUTE_MATRIX.filter((r) => r.surface === "api" && !r.public && isAdapterServed(r.method, r.path));
    expect(routes.length).toBeGreaterThan(0);

    async function statuses(mode: "warn" | "strict"): Promise<Record<string, number>> {
      await resetDatabase(pool);
      const { token } = await newSession();
      return withScopeMode(mode, async () => {
        const result: Record<string, number> = {};
        for (const route of routes) {
          const res = await fetch(`${baseUrl}${route.path}`, {
            method: route.method,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: route.method === "GET" ? undefined : JSON.stringify({}),
          });
          result[`${route.method} ${route.path}`] = res.status;
        }
        return result;
      });
    }

    const warn = await statuses("warn");
    const strict = await statuses("strict");
    expect(strict).toEqual(warn);
    expect(Object.values(strict)).not.toContain(500);
  });

  it("answers every /api/auth route identically under strict and warn", async () => {
    async function responses(mode: "warn" | "strict"): Promise<Array<[number, string]>> {
      await resetDatabase(pool);
      const user = await createUser(pool, {
        tenantId: getTenantZeroId(),
        email: "auth-strict@example.com",
        passwordHash: await hashPassword(PASSWORD),
      });
      const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
      const bearer = { Authorization: `Bearer ${token}` };
      const json = { "Content-Type": "application/json" };
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) => ({
        path,
        init: { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body) },
      });
      const requests = [
        post("/api/auth/login", { email: user.email, password: PASSWORD, platform: "ios" }),
        post("/api/auth/login", { email: user.email, password: "wrong-password", platform: "ios" }),
        post("/api/auth/password-reset/request", { email: user.email }),
        post("/api/auth/password-reset/consume", { token: "unknown-token", newPassword: "another-password" }),
        { path: "/api/auth/session", init: { headers: bearer } },
        post(`/api/auth/sessions/${randomUUID()}/revoke`, {}, bearer),
        post("/api/auth/logout", {}, bearer),
      ];
      return withScopeMode(mode, async () => {
        const out: Array<[number, string]> = [];
        for (const { path, init } of requests) {
          const res = await fetch(`${baseUrl}${path}`, init);
          // Login mints a fresh token each time; compare shape, not the random token value.
          const text = (await res.text()).replace(/"token":"[^"]*"/, '"token":"<token>"');
          out.push([
            res.status,
            text.replace(/"(id|createdAt|updatedAt|lastSeenAt|expiresAt)":"[^"]*"/g, '"$1":"<v>"'),
          ]);
        }
        return out;
      });
    }

    const warn = await responses("warn");
    const strict = await responses("strict");
    expect(strict).toEqual(warn);
    expect(strict.map(([status]) => status)).not.toContain(500);
  });

  it("refuses to authenticate from inside a tenant", async () => {
    const { token } = await newSession();
    const req = { headers: { authorization: `Bearer ${token}` } } as Parameters<typeof authenticateRequest>[1];
    await expect(runInTenant(getTenantZeroId(), () => authenticateRequest(pool, req))).rejects.toBeInstanceOf(
      TenantScopeConflictError,
    );
  });
});
