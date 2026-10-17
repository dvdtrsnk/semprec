import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestModuleItem,
  createTestProjectItem,
  createTestTenant,
  ensureMailAccountSyncState,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  mailSyncProcessName,
  upsertProcessHeartbeat,
  withTransaction,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { mountRoutes } from "../adapter/routeTable.js";
import { ROUTE_MATRIX } from "../routeMatrix.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

interface AccountBody {
  accounts: Record<string, unknown>[];
}

describe("admin routes (issue #1037)", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;

  async function signIn(
    email: string,
    tenantId: string,
    role: "admin" | "member",
  ): Promise<{ id: string; token: string }> {
    const user = await createUser(pool, { email, passwordHash: await hashPassword(PASSWORD), tenantId, role });
    const result = await login(pool, { email, password: PASSWORD, platform: "ios", ip: "1.2.3.4" });
    return { id: user.id, token: result.token };
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "admin-handler-setup-token",
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("answers every admin matrix entry with 403 admin_required for a member", async () => {
    const tenantId = await createTestTenant(pool);
    const member = await signIn(`member-${randomUUID()}@example.test`, tenantId, "member");
    const adminEntries = ROUTE_MATRIX.filter((r) => r.surface === "api" && r.admin === true);
    expect(adminEntries.length).toBeGreaterThan(0);
    for (const route of adminEntries) {
      const res = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: { Authorization: `Bearer ${member.token}`, "Content-Type": "application/json" },
        body: route.method === "GET" ? undefined : JSON.stringify({}),
      });
      expect(res.status, route.name).toBe(403);
      expect(await res.json(), route.name).toEqual({ error: { code: "admin_required" } });
    }
  });

  it("lists every account for an admin with the newest session as lastSeenAt", async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool, { status: "suspended" });
    const tenantC = await createTestTenant(pool);
    const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantA, "admin");
    const secondEmail = `other-${randomUUID()}@example.test`;
    const second = await signIn(secondEmail, tenantB, "member");
    const third = await createUser(pool, {
      email: `nosession-${randomUUID()}@example.test`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: tenantC,
    });
    // The member's second session (the admin's own requests touch its session, so it cannot be asserted exactly); explicit timestamps make "newer" unambiguous.
    await login(pool, { email: secondEmail, password: PASSWORD, platform: "ios", ip: "1.2.3.4" });
    await pool.query("UPDATE sessions SET last_seen_at = '2026-01-01T00:00:00Z' WHERE user_id = $1", [second.id]);
    await pool.query(
      "UPDATE sessions SET last_seen_at = '2026-02-02T00:00:00Z' WHERE id = (SELECT id FROM sessions WHERE user_id = $1 LIMIT 1)",
      [second.id],
    );

    const res = await fetch(`${baseUrl}/api/admin/accounts`, { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccountBody;
    expect(body.accounts).toHaveLength(3);
    for (const entry of body.accounts) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "email", "lastSeenAt", "role", "status", "userId"]);
    }
    const byId = new Map(body.accounts.map((a) => [a.userId, a]));
    expect(byId.get(admin.id)).toMatchObject({ role: "admin", status: "active" });
    expect(byId.get(second.id)).toMatchObject({
      role: "member",
      status: "suspended",
      lastSeenAt: "2026-02-02T00:00:00.000Z",
    });
    expect(byId.get(third.id)).toMatchObject({ lastSeenAt: null });
  });

  it("answers an admin's operations health with counts and no tenant content", async () => {
    const tenantId = await createTestTenant(pool);
    const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantId, "admin");
    // Tenant content through production writers: a live Mailbox with its sync state, and a
    // Projects item, both inside the tenant on a runtime-role pool.
    const dataPool = await createRuntimeRolePool(pool, "semprec_data");
    let mailboxItemId: string;
    let projectItemId: string;
    try {
      ({ mailboxItemId, projectItemId } = await runInTenant(tenantId, async () => {
        const mailbox = await createTestModuleItem(dataPool, "mailboxes");
        await withTransaction(dataPool, (client) =>
          ensureMailAccountSyncState(client, { itemId: mailbox, syncMode: "imap" }),
        );
        return { mailboxItemId: mailbox, projectItemId: await createTestProjectItem(dataPool) };
      }));
    } finally {
      await dataPool.end();
    }
    const { rows: databaseRows } = await pool.query<{ database_id: string }>(
      "SELECT database_id FROM items WHERE id = ANY($1)",
      [[mailboxItemId, projectItemId]],
    );
    const databaseIds = databaseRows.map((row) => row.database_id);
    expect(databaseIds).toHaveLength(2);
    await upsertProcessHeartbeat(
      pool,
      { process: mailSyncProcessName(mailboxItemId), pid: 1, version: "1.0.0" },
      new Date(),
    );
    // Raw SQL on the superuser pool with an explicit tenant id: no production writer records these
    // error states from a fixture, and each carries tenant content the operator report must never echo.
    await pool.query(
      `INSERT INTO tenant_observability_checks (tenant_id, check_key, status, detail) VALUES ($1, $2, 'alerting', $3)`,
      [tenantId, `mail:${mailboxItemId}`, JSON.stringify({ mailboxItemId, lastError: "SECRET-TENANT-TEXT" })],
    );
    await pool.query(
      `INSERT INTO item_automation (tenant_id, item_id, status, error) VALUES ($1, $2, 'error', 'SECRET-TENANT-TEXT')`,
      [tenantId, projectItemId],
    );
    // A legacy global per-mailbox row, as left behind until the check-system tick purges it.
    await pool.query(`INSERT INTO observability_checks (check_key, status, detail) VALUES ($1, 'alerting', $2)`, [
      `mail:${mailboxItemId}`,
      JSON.stringify({ mailboxItemId, lastError: "SECRET-TENANT-TEXT" }),
    ]);

    const res = await fetch(`${baseUrl}/api/admin/health`, { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const secret of ["SECRET-TENANT-TEXT", tenantId, mailboxItemId, projectItemId, ...databaseIds]) {
      expect(text).not.toContain(secret);
    }
    expect(JSON.parse(text)).toMatchObject({
      tenantAggregates: { itemAutomationErrors: 1, alertingTenantChecks: 1 },
    });
  });

  it("refuses an anonymous operations health request with 401", async () => {
    const res = await fetch(`${baseUrl}/api/admin/health`);
    expect(res.status).toBe(401);
  });

  it("refuses to mount a route under /api/admin/ without the admin flag", () => {
    expect(() =>
      mountRoutes(pool, [
        { method: "GET", path: "/api/admin/forgotten", handler: async () => ({ status: 200, body: {} }) },
      ]),
    ).toThrow("/api/admin/forgotten");
  });

  it("mounts a flagged admin route", () => {
    expect(() =>
      mountRoutes(pool, [
        { method: "GET", path: "/api/admin/ok", admin: true, handler: async () => ({ status: 200, body: {} }) },
      ]),
    ).not.toThrow();
  });
});
