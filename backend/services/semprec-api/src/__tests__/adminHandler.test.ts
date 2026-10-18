import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  hashToken,
  listPushSubscriptionsForUser,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  mailSyncProcessName,
  registerPushSubscription,
  setSessionRevokedHook,
  setTenantAiBudget,
  upsertProcessHeartbeat,
  withTransaction,
  type InviteMailer,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { mountRoutes } from "../adapter/routeTable.js";
import { ROUTE_MATRIX } from "../routeMatrix.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks a response body's `field` is an array of objects, so a test can read its entries' fields. */
function readRecordArray(body: unknown, field: string): Record<string, unknown>[] {
  if (!isRecord(body)) throw new Error("expected a JSON object body");
  const value = body[field];
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`expected '${field}' to be an array of objects`);
  return value;
}

/** Checks a response body's `field` is an object, so a test can read its fields. */
function readRecord(body: unknown, field: string): Record<string, unknown> {
  if (!isRecord(body)) throw new Error("expected a JSON object body");
  const value = body[field];
  if (!isRecord(value)) throw new Error(`expected '${field}' to be an object`);
  return value;
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
    const tenantB = await createTestTenant(pool);
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
    // Raw SQL: login refuses a suspended tenant, so the status is set after the sessions exist.
    await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantB]);
    await pool.query("UPDATE sessions SET last_seen_at = '2026-01-01T00:00:00Z' WHERE user_id = $1", [second.id]);
    await pool.query(
      "UPDATE sessions SET last_seen_at = '2026-02-02T00:00:00Z' WHERE id = (SELECT id FROM sessions WHERE user_id = $1 LIMIT 1)",
      [second.id],
    );

    const res = await fetch(`${baseUrl}/api/admin/accounts`, { headers: { Authorization: `Bearer ${admin.token}` } });
    expect(res.status).toBe(200);
    const accounts = readRecordArray(await res.json(), "accounts");
    expect(accounts).toHaveLength(3);
    for (const entry of accounts) {
      expect(Object.keys(entry).sort()).toEqual(["createdAt", "email", "lastSeenAt", "role", "status", "userId"]);
    }
    const byId = new Map(accounts.map((a) => [a.userId, a]));
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
  describe("AI budgets (issue #1039)", () => {
    async function budgetRowCount(tenantId: string): Promise<number> {
      const { rows } = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM tenant_ai_budgets WHERE tenant_id = $1",
        [tenantId],
      );
      return Number(rows[0]?.n);
    }

    async function budgetRow(
      tenantId: string,
    ): Promise<{ daily_cap_usd: string | null; monthly_cap_usd: string | null; updated_at: Date }[]> {
      const { rows } = await pool.query<{
        daily_cap_usd: string | null;
        monthly_cap_usd: string | null;
        updated_at: Date;
      }>("SELECT daily_cap_usd, monthly_cap_usd, updated_at FROM tenant_ai_budgets WHERE tenant_id = $1", [tenantId]);
      return rows;
    }

    /** Raw SQL: a call's `at` and `status` must be controlled to sit on either side of a UTC window boundary. */
    async function insertCall(tenantId: string, costUsd: number, at: Date, status = "settled"): Promise<void> {
      await pool.query(
        `INSERT INTO ai_gateway_calls (tenant_id, provider, model, input_tokens, output_tokens, cost_usd, at, status)
         VALUES ($1, 'anthropic', 'claude-sonnet-5', 1, 1, $2, $3, $4)`,
        [tenantId, costUsd, at, status],
      );
    }

    async function auditRowsFor(
      action: string,
    ): Promise<{ target_tenant_id: string; details: Record<string, unknown> }[]> {
      const { rows } = await pool.query<{ target_tenant_id: string; details: Record<string, unknown> }>(
        "SELECT target_tenant_id, details FROM admin_audit_log WHERE action = $1",
        [action],
      );
      return rows;
    }

    it("sets the caps of the target user's tenant and records one audit row for that tenant only", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantA, "admin");
      const target = await signIn(`target-${randomUUID()}@example.test`, tenantB, "member");
      // Tenant A already has caps of its own; writing B's must leave them untouched.
      await withTransaction(pool, (client) =>
        setTenantAiBudget(client, { tenantId: tenantA, dailyCapUsd: 1, monthlyCapUsd: 10, updatedBy: admin.id }),
      );
      const budgetABefore = await budgetRow(tenantA);

      const res = await fetch(`${baseUrl}/api/admin/accounts/${target.id}/ai-budget`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ dailyCapUsd: 5, monthlyCapUsd: 40 }),
      });
      expect(res.status).toBe(200);
      const budget = readRecord(await res.json(), "budget");
      expect(Object.keys(budget).sort()).toEqual(["dailyCapUsd", "monthlyCapUsd", "updatedAt", "userId"]);
      expect(budget).toMatchObject({ userId: target.id, dailyCapUsd: 5, monthlyCapUsd: 40 });

      const { rows } = await pool.query<{ daily_cap_usd: string; monthly_cap_usd: string; updated_by: string }>(
        "SELECT daily_cap_usd, monthly_cap_usd, updated_by FROM tenant_ai_budgets WHERE tenant_id = $1",
        [tenantB],
      );
      expect(rows).toEqual([{ daily_cap_usd: "5", monthly_cap_usd: "40", updated_by: admin.id }]);
      expect(await budgetRow(tenantA)).toEqual(budgetABefore);
      expect(budgetABefore).toMatchObject([{ daily_cap_usd: "1", monthly_cap_usd: "10" }]);

      const audit = await auditRowsFor("tenantAiBudgetSet");
      expect(audit).toEqual([{ target_tenant_id: tenantB, details: { dailyCapUsd: 5, monthlyCapUsd: 40 } }]);
    });

    it("creates a budget row for a tenant that has none, and reads it back in the overview", async () => {
      const tenantId = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
      const target = await signIn(`target-${randomUUID()}@example.test`, tenantId, "member");
      expect(await budgetRowCount(tenantId)).toBe(0);

      const put = await fetch(`${baseUrl}/api/admin/accounts/${target.id}/ai-budget`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ dailyCapUsd: null, monthlyCapUsd: 0 }),
      });
      expect(put.status).toBe(200);

      const get = await fetch(`${baseUrl}/api/admin/ai-budgets`, {
        headers: { Authorization: `Bearer ${admin.token}` },
      });
      expect(get.status).toBe(200);
      const overview: unknown = await get.json();
      expect(overview).toMatchObject({ spendWindow: "utc" });
      const entry = readRecordArray(overview, "accounts").find((account) => account.userId === target.id);
      expect(entry).toMatchObject({ hasBudget: true, dailyCapUsd: null, monthlyCapUsd: 0 });
    });

    it.each([
      ["negative daily", { dailyCapUsd: -1, monthlyCapUsd: 40 }, "dailyCapUsd"],
      ["string monthly", { dailyCapUsd: 5, monthlyCapUsd: "5" }, "monthlyCapUsd"],
      ["missing monthly", { dailyCapUsd: 5 }, "monthlyCapUsd"],
    ])(
      "refuses a %s cap as validation_failed naming the field, with no row and no audit row",
      async (_label, body, field) => {
        const tenantId = await createTestTenant(pool);
        const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
        const target = await signIn(`target-${randomUUID()}@example.test`, tenantId, "member");

        const res = await fetch(`${baseUrl}/api/admin/accounts/${target.id}/ai-budget`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: { code: "validation_failed", details: { field } } });
        expect(await budgetRowCount(tenantId)).toBe(0);
        expect(await auditRowsFor("tenantAiBudgetSet")).toEqual([]);
      },
    );

    it.each(["dailyCapUsd", "monthlyCapUsd"])(
      "refuses an overflowing JSON number for %s (Infinity once parsed) as validation_failed, with no row and no audit row",
      async (field) => {
        const tenantId = await createTestTenant(pool);
        const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
        const target = await signIn(`target-${randomUUID()}@example.test`, tenantId, "member");
        // Raw JSON text: JSON.stringify(Infinity) yields null, so the literal 1e309 is the only way to send it.
        const rawBody =
          field === "dailyCapUsd"
            ? '{"dailyCapUsd": 1e309, "monthlyCapUsd": 40}'
            : '{"dailyCapUsd": 5, "monthlyCapUsd": 1e309}';

        const res = await fetch(`${baseUrl}/api/admin/accounts/${target.id}/ai-budget`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
          body: rawBody,
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: { code: "validation_failed", details: { field } } });
        expect(await budgetRowCount(tenantId)).toBe(0);
        expect(await auditRowsFor("tenantAiBudgetSet")).toEqual([]);
      },
    );

    it("rolls the budget write back when its audit row cannot be written", async () => {
      const tenantId = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
      const target = await signIn(`target-${randomUUID()}@example.test`, tenantId, "member");
      const put = (caps: { dailyCapUsd: number; monthlyCapUsd: number }) =>
        fetch(`${baseUrl}/api/admin/accounts/${target.id}/ai-budget`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(caps),
        });
      expect((await put({ dailyCapUsd: 5, monthlyCapUsd: 40 })).status).toBe(200);
      const before = await budgetRow(tenantId);

      // The audit insert fails only for the sentinel monthly cap 777, which no other test sends, and
      // only after setTenantAiBudget has already upserted the row in the same transaction.
      await pool.query(
        `CREATE OR REPLACE FUNCTION test_fail_budget_audit() RETURNS trigger AS $$
         BEGIN
           IF NEW.action = 'tenantAiBudgetSet' AND NEW.details->>'monthlyCapUsd' = '777' THEN
             RAISE EXCEPTION 'injected audit failure';
           END IF;
           RETURN NEW;
         END $$ LANGUAGE plpgsql`,
      );
      await pool.query(
        `CREATE TRIGGER test_fail_budget_audit BEFORE INSERT ON admin_audit_log
         FOR EACH ROW EXECUTE FUNCTION test_fail_budget_audit()`,
      );
      try {
        const res = await put({ dailyCapUsd: 9, monthlyCapUsd: 777 });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: { code: "internal_error" } });
      } finally {
        await pool.query("DROP TRIGGER IF EXISTS test_fail_budget_audit ON admin_audit_log");
        await pool.query("DROP FUNCTION IF EXISTS test_fail_budget_audit()");
      }

      expect(await budgetRow(tenantId)).toEqual(before);
      expect(before).toMatchObject([{ daily_cap_usd: "5", monthly_cap_usd: "40" }]);
      expect(await auditRowsFor("tenantAiBudgetSet")).toEqual([
        { target_tenant_id: tenantId, details: { dailyCapUsd: 5, monthlyCapUsd: 40 } },
      ]);
    });

    it("reports each tenant's UTC spend through the overview route, and hasBudget false with null caps without a row", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
      const accountA = await signIn(`a-${randomUUID()}@example.test`, tenantA, "member");
      const accountB = await signIn(`b-${randomUUID()}@example.test`, tenantB, "member");
      await withTransaction(pool, (client) =>
        setTenantAiBudget(client, { tenantId: tenantA, dailyCapUsd: 5, monthlyCapUsd: 40, updatedBy: admin.id }),
      );

      const { rows } = await pool.query<{ now: Date; day_start: Date; month_start: Date }>(
        `SELECT now() AS now,
                date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS day_start,
                date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start`,
      );
      const windows = rows[0];
      if (!windows) throw new Error("expected one row of UTC windows");
      // The 2.00 call sits one second before today's UTC midnight: an earlier day of this month,
      // except on the 1st, when it falls in the previous month and counts toward neither sum.
      const beforeToday = new Date(windows.day_start.getTime() - 1000);
      const beforeTodayIsThisMonth = beforeToday.getTime() >= windows.month_start.getTime();

      await insertCall(tenantA, 1.5, windows.now);
      await insertCall(tenantA, 0.25, windows.now, "reserved");
      await insertCall(tenantA, 0, windows.now, "failed");
      await insertCall(tenantA, 2, beforeToday);
      await insertCall(tenantB, 3, windows.now);

      const res = await fetch(`${baseUrl}/api/admin/ai-budgets`, {
        headers: { Authorization: `Bearer ${admin.token}` },
      });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ spendWindow: "utc" });
      const byId = new Map(readRecordArray(body, "accounts").map((account) => [account.userId, account]));
      expect(byId.get(accountA.id)).toMatchObject({
        hasBudget: true,
        dailyCapUsd: 5,
        monthlyCapUsd: 40,
        spentTodayUsd: 1.75,
        spentMonthUsd: beforeTodayIsThisMonth ? 3.75 : 1.75,
      });
      expect(byId.get(accountB.id)).toMatchObject({
        hasBudget: false,
        dailyCapUsd: null,
        monthlyCapUsd: null,
        spentTodayUsd: 3,
        spentMonthUsd: 3,
      });
    });

    it("answers 400 for a non-uuid user id and 404 not_found for an unknown one, with no audit row", async () => {
      const tenantId = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantId, "admin");
      const put = (userId: string) =>
        fetch(`${baseUrl}/api/admin/accounts/${userId}/ai-budget`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ dailyCapUsd: 5, monthlyCapUsd: 40 }),
        });

      expect((await put("not-a-uuid")).status).toBe(400);
      const unknown = await put(randomUUID());
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });
      expect(await auditRowsFor("tenantAiBudgetSet")).toEqual([]);
      expect(await budgetRowCount(tenantId)).toBe(0);
    });

    it("refuses an account bound to no tenant as validation_failed on userId, writing no budget and no audit row", async () => {
      const tenantId = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantId, "admin");
      const unbound = await createUser(pool, {
        email: `unbound-${randomUUID()}@example.test`,
        passwordHash: await hashPassword(PASSWORD),
        role: "member",
      });

      const res = await fetch(`${baseUrl}/api/admin/accounts/${unbound.id}/ai-budget`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ dailyCapUsd: 5, monthlyCapUsd: 40 }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "validation_failed", details: { field: "userId" } } });
      const { rows } = await pool.query<{ count: string }>("SELECT count(*) AS count FROM tenant_ai_budgets");
      expect(rows).toEqual([{ count: "0" }]);
      expect(await auditRowsFor("tenantAiBudgetSet")).toEqual([]);
    });
  });

  describe("invitations (issue #1040)", () => {
    interface AuditEntry {
      action: string;
      details: Record<string, unknown>;
    }

    async function invitesTable(): Promise<{ id: string; status: string }[]> {
      const { rows } = await pool.query<{ id: string; accepted_at: Date | null; revoked_at: Date | null }>(
        "SELECT id, accepted_at, revoked_at FROM invites",
      );
      return rows.map((row) => ({
        id: row.id,
        status: row.revoked_at ? "revoked" : row.accepted_at ? "accepted" : "pending",
      }));
    }

    async function inviteAuditEntries(): Promise<AuditEntry[]> {
      const { rows } = await pool.query<AuditEntry>(
        "SELECT action, details FROM admin_audit_log WHERE action LIKE 'invite%' ORDER BY id",
      );
      return rows;
    }

    function authed(token: string, method: string, path: string, body?: unknown): Promise<Response> {
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    it("creates a pending invite with a normalized email, a seven-day expiry and one audit row without the email", async () => {
      const tenantId = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantId, "admin");

      const res = await authed(admin.token, "POST", "/api/admin/invites", { email: " New@Example.COM " });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { invite: Record<string, unknown>; inviteUrl: string; emailed: boolean };
      expect(body.invite).toMatchObject({ email: "new@example.com", status: "pending", invitedBy: admin.id });
      expect(Date.parse(String(body.invite.expiresAt)) - Date.parse(String(body.invite.createdAt))).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
      expect(body.inviteUrl).toMatch(/^https:\/\/app\.example\.test\/\?page=invite#token=[A-Za-z0-9_-]+$/);
      expect(body.emailed).toBe(false);
      expect(Object.keys(body.invite).sort()).not.toContain("token_hash");

      const token = new URL(body.inviteUrl).hash.replace("#token=", "");
      const { rows } = await pool.query<{ token_hash: string }>("SELECT token_hash FROM invites");
      expect(rows).toEqual([{ token_hash: hashToken(token) }]);
      expect(await inviteAuditEntries()).toEqual([{ action: "inviteCreated", details: { inviteId: body.invite.id } }]);
    });

    it("answers 400 validation_failed on email for a malformed address or one that already has an account, writing nothing", async () => {
      const tenantId = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantId, "admin");
      const takenEmail = `taken-${randomUUID()}@example.test`;
      await signIn(takenEmail, await createTestTenant(pool), "member");

      for (const email of ["not-an-email", takenEmail]) {
        const res = await authed(admin.token, "POST", "/api/admin/invites", { email });
        expect(res.status, email).toBe(400);
        expect(await res.json(), email).toMatchObject({
          error: { code: "validation_failed", details: { field: "email" } },
        });
      }
      expect(await invitesTable()).toEqual([]);
      expect(await inviteAuditEntries()).toEqual([]);
    });

    it("lists every invite newest first with its status and never a token", async () => {
      const tenantId = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantId, "admin");
      const first = (await (
        await authed(admin.token, "POST", "/api/admin/invites", { email: "one@example.com" })
      ).json()) as { invite: { id: string } };
      const second = (await (
        await authed(admin.token, "POST", "/api/admin/invites", { email: "two@example.com" })
      ).json()) as { invite: { id: string }; inviteUrl: string };
      await pool.query("UPDATE invites SET accepted_at = now() WHERE id = $1", [first.invite.id]);

      const res = await authed(admin.token, "GET", "/api/admin/invites");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("token_hash");
      expect(text).not.toContain(new URL(second.inviteUrl).hash.replace("#token=", ""));
      const invites = (JSON.parse(text) as { invites: { id: string; status: string }[] }).invites;
      expect(invites.map((entry) => [entry.id, entry.status])).toEqual([
        [second.invite.id, "pending"],
        [first.invite.id, "accepted"],
      ]);
    });

    it("revokes a pending invite with an audit row, and answers 409 or 404 without one for a non-pending or unknown id", async () => {
      const tenantId = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantId, "admin");
      const pending = (await (
        await authed(admin.token, "POST", "/api/admin/invites", { email: "p@example.com" })
      ).json()) as { invite: { id: string } };
      const accepted = (await (
        await authed(admin.token, "POST", "/api/admin/invites", { email: "a@example.com" })
      ).json()) as { invite: { id: string } };
      await pool.query("UPDATE invites SET accepted_at = now() WHERE id = $1", [accepted.invite.id]);
      const auditBefore = (await inviteAuditEntries()).length;

      const revoked = await authed(admin.token, "POST", `/api/admin/invites/${pending.invite.id}/revoke`);
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ invite: { id: pending.invite.id, status: "revoked" } });
      expect((await inviteAuditEntries()).at(-1)).toEqual({
        action: "inviteRevoked",
        details: { inviteId: pending.invite.id },
      });

      const auditAfterRevoke = (await inviteAuditEntries()).length;
      const refused = await authed(admin.token, "POST", `/api/admin/invites/${accepted.invite.id}/revoke`);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "invite_not_pending" } });

      const unknown = await authed(admin.token, "POST", `/api/admin/invites/${randomUUID()}/revoke`);
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });

      expect((await inviteAuditEntries()).length).toBe(auditAfterRevoke);
      expect(auditAfterRevoke).toBe(auditBefore + 1);
      expect((await authed(admin.token, "POST", "/api/admin/invites/not-a-uuid/revoke")).status).toBe(400);
    });

    it("reports emailed true and sends the mail after commit when an invite mailer is configured", async () => {
      const sent: { to: string; inviteUrl: string }[] = [];
      const mailer: InviteMailer = {
        async sendInviteEmail(input) {
          sent.push({ to: input.to, inviteUrl: input.inviteUrl });
        },
      };
      const mailedDispatch = await createDispatcher(pool, {
        passwordResetMailer: noopMailer,
        inviteMailer: mailer,
        appBaseUrl: "https://app.example.test",
        setupToken: "admin-handler-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      });
      const mailedServer = createServer(mailedDispatch);
      await new Promise<void>((resolve) => mailedServer.listen(0, resolve));
      const address = mailedServer.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
      try {
        const tenantId = await createTestTenant(pool);
        const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantId, "admin");
        const res = await fetch(`http://127.0.0.1:${address.port}/api/admin/invites`, {
          method: "POST",
          headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email: "Mailed@Example.com" }),
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { inviteUrl: string; emailed: boolean };
        expect(body.emailed).toBe(true);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent).toEqual([{ to: "mailed@example.com", inviteUrl: body.inviteUrl }]);
      } finally {
        await new Promise<void>((resolve) => mailedServer.close(() => resolve()));
      }
    });
  });

  describe("account mutations (issue #1041)", () => {
    function authed(token: string, method: string, path: string, body?: unknown): Promise<Response> {
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    async function auditActions(): Promise<string[]> {
      const { rows } = await pool.query<{ action: string }>("SELECT action FROM admin_audit_log ORDER BY id");
      return rows.map((row) => row.action);
    }

    async function tenantStatus(tenantId: string): Promise<string> {
      const { rows } = await pool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
      return rows[0]!.status;
    }

    async function tenantOf(userId: string): Promise<string> {
      const { rows } = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM users WHERE id = $1", [userId]);
      return rows[0]!.tenant_id;
    }

    afterEach(() => {
      setSessionRevokedHook(() => {});
    });

    beforeEach(async () => {
      await pool.query("DELETE FROM admin_audit_log");
    });

    it("suspends a member: tenant, sessions, push registrations, audit row and 401 for the old token; tenant A untouched", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantA, "admin");
      const member = await signIn(`member-${randomUUID()}@example.test`, tenantB, "member");
      const secondEmail = (await pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [member.id]))
        .rows[0]!.email;
      await login(pool, { email: secondEmail, password: PASSWORD, platform: "web", ip: "1.2.3.4" });
      await registerPushSubscription(pool, {
        userId: member.id,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/member",
        p256dh: "key",
        authSecret: "secret",
      });
      const statusChangedBefore = (
        await pool.query<{ status_changed_at: Date }>("SELECT status_changed_at FROM tenants WHERE id = $1", [tenantB])
      ).rows[0]!.status_changed_at;
      const events: string[] = [];
      setSessionRevokedHook((event) => {
        events.push(event.sessionId);
      });

      const res = await authed(admin.token, "POST", `/api/admin/accounts/${member.id}/suspend`);

      expect(res.status).toBe(200);
      expect(readRecord(await res.json(), "account")).toMatchObject({ userId: member.id, status: "suspended" });
      expect(await tenantStatus(tenantB)).toBe("suspended");
      const statusChangedAfter = (
        await pool.query<{ status_changed_at: Date }>("SELECT status_changed_at FROM tenants WHERE id = $1", [tenantB])
      ).rows[0]!.status_changed_at;
      expect(statusChangedAfter.getTime()).toBeGreaterThan(statusChangedBefore.getTime());
      const sessions = await pool.query<{ id: string; revoked_at: Date | null }>(
        "SELECT id, revoked_at FROM sessions WHERE user_id = $1",
        [member.id],
      );
      expect(sessions.rows).toHaveLength(2);
      expect(sessions.rows.every((row) => row.revoked_at !== null)).toBe(true);
      await vi.waitFor(() => expect([...events].sort()).toEqual(sessions.rows.map((r) => r.id).sort()));
      const push = await listPushSubscriptionsForUser(pool, member.id);
      expect(push.length).toBeGreaterThan(0);
      expect(push.every((row) => row.revokedAt !== null)).toBe(true);
      const audit = await pool.query<{ action: string; target_tenant_id: string }>(
        "SELECT action, target_tenant_id FROM admin_audit_log",
      );
      expect(audit.rows).toEqual([{ action: "accountSuspended", target_tenant_id: tenantB }]);
      expect((await authed(member.token, "GET", "/api/admin/accounts")).status).toBe(401);
      expect(await tenantStatus(tenantA)).toBe("active");
      expect((await authed(admin.token, "GET", "/api/admin/accounts")).status).toBe(200);
    });

    it("reactivates a suspended account so the user can log in again, and refuses repeat transitions with 409", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantA, "admin");
      const email = `member-${randomUUID()}@example.test`;
      const member = await signIn(email, tenantB, "member");

      const activeAgain = await authed(admin.token, "POST", `/api/admin/accounts/${member.id}/reactivate`);
      expect(activeAgain.status).toBe(409);
      expect(await activeAgain.json()).toMatchObject({ error: { code: "invalid_account_status" } });
      expect(await auditActions()).toEqual([]);

      expect((await authed(admin.token, "POST", `/api/admin/accounts/${member.id}/suspend`)).status).toBe(200);
      const twice = await authed(admin.token, "POST", `/api/admin/accounts/${member.id}/suspend`);
      expect(twice.status).toBe(409);
      expect(await twice.json()).toMatchObject({ error: { code: "invalid_account_status" } });
      expect(await auditActions()).toEqual(["accountSuspended"]);

      const res = await authed(admin.token, "POST", `/api/admin/accounts/${member.id}/reactivate`);
      expect(res.status).toBe(200);
      expect(readRecord(await res.json(), "account")).toMatchObject({ userId: member.id, status: "active" });
      expect(await tenantStatus(tenantB)).toBe("active");
      expect(await auditActions()).toEqual(["accountSuspended", "accountReactivated"]);
      const relogin = await login(pool, { email, password: PASSWORD, platform: "web", ip: "1.2.3.4" });
      expect(relogin.user.id).toBe(member.id);
    });

    it("refuses the only active admin demoting or suspending themselves, and allows it with a second admin", async () => {
      const tenantA = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantA, "admin");

      const demote = await authed(admin.token, "PUT", `/api/admin/accounts/${admin.id}/role`, { role: "member" });
      expect(demote.status).toBe(409);
      expect(await demote.json()).toMatchObject({ error: { code: "last_admin" } });
      const suspend = await authed(admin.token, "POST", `/api/admin/accounts/${admin.id}/suspend`);
      expect(suspend.status).toBe(409);
      expect(await suspend.json()).toMatchObject({ error: { code: "last_admin" } });
      expect(await tenantStatus(tenantA)).toBe("active");
      expect(await auditActions()).toEqual([]);

      const second = await signIn(`admin2-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
      const allowedDemote = await authed(admin.token, "PUT", `/api/admin/accounts/${admin.id}/role`, {
        role: "member",
      });
      expect(allowedDemote.status).toBe(200);
      const allowedSuspend = await authed(second.token, "POST", `/api/admin/accounts/${second.id}/suspend`);
      // The second admin is now the only active admin again.
      expect(allowedSuspend.status).toBe(409);
      expect(await auditActions()).toEqual(["accountRoleChanged"]);
    });

    it("suspends oneself when a second active admin exists", async () => {
      const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
      await signIn(`admin2-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");

      const res = await authed(admin.token, "POST", `/api/admin/accounts/${admin.id}/suspend`);

      expect(res.status).toBe(200);
      expect(await auditActions()).toEqual(["accountSuspended"]);
    });

    it("changes a role with { from, to } in the audit row, effective on the target's next request", async () => {
      const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
      const member = await signIn(`member-${randomUUID()}@example.test`, await createTestTenant(pool), "member");
      expect((await authed(member.token, "GET", "/api/admin/accounts")).status).toBe(403);

      const res = await authed(admin.token, "PUT", `/api/admin/accounts/${member.id}/role`, { role: "admin" });

      expect(res.status).toBe(200);
      expect(readRecord(await res.json(), "account")).toMatchObject({ userId: member.id, role: "admin" });
      const audit = await pool.query<{ action: string; target_tenant_id: string; details: unknown }>(
        "SELECT action, target_tenant_id, details FROM admin_audit_log",
      );
      expect(audit.rows).toEqual([
        {
          action: "accountRoleChanged",
          target_tenant_id: await tenantOf(member.id),
          details: { from: "member", to: "admin" },
        },
      ]);
      expect((await authed(member.token, "GET", "/api/admin/accounts")).status).toBe(200);
    });

    it("answers 200 without an audit row when the role is unchanged, and 400 for an unknown role", async () => {
      const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
      const member = await signIn(`member-${randomUUID()}@example.test`, await createTestTenant(pool), "member");

      const same = await authed(admin.token, "PUT", `/api/admin/accounts/${member.id}/role`, { role: "member" });
      expect(same.status).toBe(200);
      expect(readRecord(await same.json(), "account")).toMatchObject({ role: "member" });
      expect(await auditActions()).toEqual([]);

      const invalid = await authed(admin.token, "PUT", `/api/admin/accounts/${member.id}/role`, { role: "owner" });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: "validation_failed", details: { field: "role" } } });
      const missing = await authed(admin.token, "PUT", `/api/admin/accounts/${member.id}/role`, {});
      expect(missing.status).toBe(400);
      expect(await auditActions()).toEqual([]);
    });

    it("answers 404 for an unknown user id, 400 for a malformed one, 403 for a member and 401 anonymously", async () => {
      const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
      const member = await signIn(`member-${randomUUID()}@example.test`, await createTestTenant(pool), "member");
      const unknown = randomUUID();
      const routes: { method: string; suffix: string; body?: unknown }[] = [
        { method: "POST", suffix: "suspend" },
        { method: "POST", suffix: "reactivate" },
        { method: "POST", suffix: "delete" },
        { method: "PUT", suffix: "role", body: { role: "member" } },
      ];
      for (const route of routes) {
        const missing = await authed(
          admin.token,
          route.method,
          `/api/admin/accounts/${unknown}/${route.suffix}`,
          route.body,
        );
        expect(missing.status, route.suffix).toBe(404);
        const malformed = await authed(
          admin.token,
          route.method,
          `/api/admin/accounts/not-a-uuid/${route.suffix}`,
          route.body,
        );
        expect(malformed.status, route.suffix).toBe(400);
        const forbidden = await authed(
          member.token,
          route.method,
          `/api/admin/accounts/${unknown}/${route.suffix}`,
          route.body,
        );
        expect(forbidden.status, route.suffix).toBe(403);
        expect(await forbidden.json()).toEqual({ error: { code: "admin_required" } });
        const anonymous = await fetch(`${baseUrl}/api/admin/accounts/${unknown}/${route.suffix}`, {
          method: route.method,
          headers: { "Content-Type": "application/json" },
          body: route.body === undefined ? undefined : JSON.stringify(route.body),
        });
        expect(anonymous.status, route.suffix).toBe(401);
      }
      expect(await auditActions()).toEqual([]);
    });
  });

  describe("account deletion (issue #1049)", () => {
    function authed(token: string, path: string): Promise<Response> {
      return fetch(`${baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    }

    async function tenantStatus(tenantId: string): Promise<string> {
      const { rows } = await pool.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1", [tenantId]);
      return rows[0]!.status;
    }

    async function auditRows(): Promise<{ action: string; target_tenant_id: string }[]> {
      const { rows } = await pool.query<{ action: string; target_tenant_id: string }>(
        "SELECT action, target_tenant_id FROM admin_audit_log ORDER BY id",
      );
      return rows;
    }

    beforeEach(async () => {
      await pool.query("DELETE FROM admin_audit_log");
    });

    it("deletes B's member: 202 with the summary, tenant deleting, token revoked, one audit row; tenant A untouched", async () => {
      const tenantA = await createTestTenant(pool);
      const tenantB = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantA, "admin");
      const member = await signIn(`member-${randomUUID()}@example.test`, tenantB, "member");

      const res = await authed(admin.token, `/api/admin/accounts/${member.id}/delete`);

      expect(res.status).toBe(202);
      expect(readRecord(await res.json(), "account")).toMatchObject({ userId: member.id, status: "deleting" });
      expect(await tenantStatus(tenantB)).toBe("deleting");
      expect((await authed(member.token, `/api/admin/accounts/${admin.id}/delete`)).status).toBe(401);
      expect(await auditRows()).toEqual([{ action: "accountDeletionRequested", target_tenant_id: tenantB }]);
      expect(await tenantStatus(tenantA)).toBe("active");
      expect(
        (await fetch(`${baseUrl}/api/admin/accounts`, { headers: { Authorization: `Bearer ${admin.token}` } })).status,
      ).toBe(200);
    });

    it("answers 403 self_deletion_requires_reauthentication for the admin's own id and changes nothing", async () => {
      const tenantA = await createTestTenant(pool);
      const admin = await signIn(`admin-${randomUUID()}@example.test`, tenantA, "admin");
      await signIn(`second-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");

      const res = await authed(admin.token, `/api/admin/accounts/${admin.id}/delete`);

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: "self_deletion_requires_reauthentication" } });
      expect(await tenantStatus(tenantA)).toBe("active");
      expect(await auditRows()).toEqual([]);
      expect(
        (await fetch(`${baseUrl}/api/admin/accounts`, { headers: { Authorization: `Bearer ${admin.token}` } })).status,
      ).toBe(200);
    });

    it("answers 409 invalid_account_status when the account is already deleting", async () => {
      const admin = await signIn(`admin-${randomUUID()}@example.test`, await createTestTenant(pool), "admin");
      const member = await signIn(`member-${randomUUID()}@example.test`, await createTestTenant(pool), "member");
      expect((await authed(admin.token, `/api/admin/accounts/${member.id}/delete`)).status).toBe(202);

      const again = await authed(admin.token, `/api/admin/accounts/${member.id}/delete`);

      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: { code: "invalid_account_status" } });
      expect(await auditRows()).toHaveLength(1);
    });
  });
});
