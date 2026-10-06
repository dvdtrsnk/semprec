import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import pg, { type Pool } from "pg";
import { getTenantZeroId, resetDatabase } from "@semprec/data/testSupport";
import {
  createPool,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  mintMcpRunCredential,
  seedSystem,
  type PasswordResetMailer,
} from "@semprec/data";
import { currentTenantScope, type TenantScope } from "@semprec/shared";
import { createDispatcher } from "../app.js";
import { ROUTE_MATRIX, type RouteMatrixEntry } from "../routeMatrix.js";

const PASSWORD = "s3cret-password";
const SETUP_TOKEN = "bespoke-scope-setup-token";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

/** The `public: false` matrix entries answered by the eight tenant-scoped bespoke listeners. */
const TENANT_LISTENER_PATH =
  /^\/(?:api\/notifications\/|api\/schema$|api\/approval-requests|mcp$|api\/agent-runs\/|api\/projects\/[^/]+\/mcp-grants|api\/mcp-tool-registrations\/|api\/files$|api\/blobs\/)/;

const tenantRoutes = ROUTE_MATRIX.filter((r) => r.surface === "api" && !r.public && TENANT_LISTENER_PATH.test(r.path));

interface RequestSpec {
  headers: Record<string, string>;
  body?: string;
}

/** A body that gets each route past its own validation and onto the database, fresh per call so no two runs collide on dedup. */
function requestSpecFor(route: RouteMatrixEntry): RequestSpec {
  if (route.path === "/api/files") {
    return { headers: { "Content-Type": "text/plain", "X-Filename": "note.txt" }, body: `content ${randomUUID()}` };
  }
  if (route.method === "GET") return { headers: {} };
  const json = (value: unknown): RequestSpec => ({
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (route.path === "/mcp") {
    return json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "semprec.database.list" } });
  }
  if (route.path.startsWith("/api/approval-requests/")) return json({ decision: "approved" });
  if (route.path === "/api/agent-runs/mcp-credentials") {
    return json({ projectItemId: randomUUID(), capabilities: [] });
  }
  if (route.path.includes("/mcp-grants/")) return json({ granted: true });
  if (route.path.startsWith("/api/mcp-tool-registrations/")) return json({ riskClass: "low" });
  return json({});
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

describe("bespoke listeners run in the caller's tenant or an explicit system scope", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;
  let querySpy: MockInstance;
  let recorded: (TenantScope | undefined)[];

  async function startDispatcher(): Promise<void> {
    // Built under `warn` (the default), exercised under whichever mode the test sets.
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: SETUP_TOKEN,
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set");
    pool ??= createPool(url);
    await resetDatabase(pool);
    await seedSystem(pool);
    await startDispatcher();

    recorded = [];
    // Every statement of every pool path ends at `Client.prototype.query`.
    // Called back with the receiving client below, so the unbound reference is safe.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalQuery: (this: pg.Client, ...args: unknown[]) => unknown = pg.Client.prototype.query;
    querySpy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      recorded.push(currentTenantScope());
      return originalQuery.apply(this, args);
    });
  });

  afterEach(async () => {
    querySpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function sessionToken(): Promise<string> {
    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return token;
  }

  async function send(route: RouteMatrixEntry, token?: string): Promise<Response> {
    const spec = requestSpecFor(route);
    return fetch(`${baseUrl}${route.path}`, {
      method: route.method,
      headers: { ...spec.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: spec.body,
    });
  }

  it("covers every tenant-scoped listener route of the matrix", () => {
    expect(tenantRoutes).toHaveLength(14);
  });

  describe.each(tenantRoutes)("$name ($method $path)", (route) => {
    it("answers the same under strict as under warn, with system then only caller-tenant statements", async () => {
      const token = await sessionToken();
      const tenantId = getTenantZeroId();

      const warnRes = await withScopeMode("warn", () => send(route, token));
      await warnRes.arrayBuffer();

      recorded.length = 0;
      const strictRes = await withScopeMode("strict", () => send(route, token));
      const strictBody = await strictRes.text();

      expect(strictRes.status).toBe(warnRes.status);
      expect(strictRes.status, strictBody).not.toBe(500);

      const firstTenant = recorded.findIndex((scope) => scope?.kind !== "system");
      expect(firstTenant, "expected at least one statement after the session lookup").toBeGreaterThan(0);
      expect(recorded.slice(0, firstTenant).every((scope) => scope?.kind === "system")).toBe(true);
      expect(recorded.slice(firstTenant)).toSatisfy((rest: (TenantScope | undefined)[]) =>
        rest.every((scope) => scope?.kind === "tenant" && scope.tenantId === tenantId),
      );
    });

    it("answers an unauthenticated request with 401 and no statement inside a tenant scope", async () => {
      const res = await withScopeMode("strict", () => send(route));
      await res.arrayBuffer();

      expect(res.status).toBe(401);
      expect(recorded.some((scope) => scope?.kind === "tenant")).toBe(false);
    });
  });

  describe("public listeners", () => {
    async function publicRequest(path: string, init: RequestInit): Promise<{ status: number; body: string }> {
      const res = await fetch(`${baseUrl}${path}`, init);
      return { status: res.status, body: await res.text() };
    }

    function expectAllSystem(): void {
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.every((scope) => scope?.kind === "system")).toBe(true);
    }

    it("serves GET /healthz in a system scope", async () => {
      const warn = await withScopeMode("warn", () => publicRequest("/healthz", {}));
      recorded.length = 0;
      const strict = await withScopeMode("strict", () => publicRequest("/healthz", {}));

      expect(strict).toEqual(warn);
      expectAllSystem();
    });

    it("serves POST /api/setup in a system scope, and 404s after the first account", async () => {
      const setup = (): Promise<{ status: number; body: string }> =>
        publicRequest("/api/setup", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SETUP_TOKEN}` },
          body: JSON.stringify({ email: "owner@example.com", password: PASSWORD }),
        });

      const warnFirst = await withScopeMode("warn", setup);
      const warnSecond = await withScopeMode("warn", setup);
      await resetDatabase(pool);
      recorded.length = 0;
      const strictFirst = await withScopeMode("strict", setup);
      expectAllSystem();
      recorded.length = 0;
      const strictSecond = await withScopeMode("strict", setup);

      expect(warnFirst.status).toBe(200);
      expect(strictFirst.status).toBe(warnFirst.status);
      expect(JSON.parse(strictFirst.body)).toMatchObject({ user: { email: "owner@example.com" } });
      expect(strictSecond.status).toBe(404);
      expect(strictSecond.status).toBe(warnSecond.status);
      expect(recorded.every((scope) => scope?.kind === "system")).toBe(true);
    });

    it("serves POST /api/mail/graph/webhook in a system scope and still echoes a validationToken", async () => {
      const notification = {
        value: [
          {
            subscriptionId: randomUUID(),
            clientState: "unknown-client-state",
            changeType: "created",
            resource: "users/x/messages/y",
          },
        ],
      };
      const post = (): Promise<{ status: number; body: string }> =>
        publicRequest("/api/mail/graph/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(notification),
        });

      const warn = await withScopeMode("warn", post);
      recorded.length = 0;
      const strict = await withScopeMode("strict", post);
      expect(strict).toEqual(warn);
      expect(strict.status).toBe(202);
      expectAllSystem();

      recorded.length = 0;
      const echoPath = "/api/mail/graph/webhook?validationToken=abc123";
      const echoWarn = await withScopeMode("warn", () => publicRequest(echoPath, { method: "POST" }));
      const echoStrict = await withScopeMode("strict", () => publicRequest(echoPath, { method: "POST" }));
      expect(echoStrict).toEqual(echoWarn);
      expect(echoStrict).toEqual({ status: 200, body: "abc123" });
      expect(recorded).toEqual([]);
    });
  });

  describe("POST /mcp with a restricted run credential", () => {
    it("answers as before, looking the credential up in a system scope and serving in its owner's tenant", async () => {
      const user = await createUser(pool, {
        email: `${randomUUID()}@example.com`,
        passwordHash: await hashPassword(PASSWORD),
      });
      const minted = await mintMcpRunCredential(pool, {
        projectItemId: randomUUID(),
        capabilities: ["core.item.write"],
        userId: user.id,
      });
      const call = (): Promise<{ status: number; body: unknown }> =>
        fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${minted.token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }).then(async (res) => ({ status: res.status, body: await res.json() }));

      const warn = await withScopeMode("warn", call);
      recorded.length = 0;
      const strict = await withScopeMode("strict", call);

      expect(strict).toEqual(warn);
      expect(strict.status).toBe(200);
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.every((scope) => scope?.kind === "system" || scope?.kind === "tenant")).toBe(true);
      expect(recorded.some((scope) => scope?.kind === "system")).toBe(true);
      // The request body is read and served inside the credential owner's tenant scope.
      expect(recorded.filter((scope) => scope?.kind === "tenant")).toContainEqual({
        kind: "tenant",
        tenantId: getTenantZeroId(),
      });
    });
  });
});
