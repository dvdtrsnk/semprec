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
  setTenantAiBudget,
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
});
