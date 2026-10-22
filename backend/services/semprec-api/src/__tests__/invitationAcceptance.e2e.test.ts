import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  provisionTenant,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

/**
 * Issue #1087 end to end through the production dispatcher on a runtime-role pool: an admin of
 * tenant zero invites an address, the invitee accepts, logs in, and sees only its own tenant.
 */

const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const ADMIN_PASSWORD = `pw-${randomUUID()}`;
const INVITEE_PASSWORD = `pw-${randomUUID()}`;

let adminPool: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;
const originalScopeMode = process.env.SEMPREC_TENANT_SCOPE;

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? (JSON.parse(text) as unknown) : null };
}

async function login(email: string, password: string): Promise<string> {
  const res = await call("POST", "/api/auth/login", { body: { email, password, platform: "ios" } });
  expect(res.status).toBe(200);
  const { token } = res.body as { token: string };
  return token;
}

describe("accepting an invitation creates an isolated account (issue #1087)", () => {
  beforeAll(async () => {
    process.env.SEMPREC_TENANT_SCOPE = "strict";
    adminPool = getTestPool();
    await resetDatabase(adminPool);
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "invitation-e2e-setup-token",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-invite-${randomUUID()}`)),
      maxFileSizeBytes: 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await adminPool?.end();
    if (originalScopeMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
    else process.env.SEMPREC_TENANT_SCOPE = originalScopeMode;
  });

  it("invites, accepts, logs in, lists only the new tenant's system databases and cannot read the admin's item", async () => {
    const zero = getTenantZeroId();
    await provisionTenant(pool, zero);
    const adminItemId = await runInTenant(zero, () => createTestProjectItem(pool));
    const adminEmail = `${randomUUID()}@example.test`;
    // `users` is a global identity table; the first account is created outside any tenant, as /setup does.
    await runAsSystem("test-fixture-create-user", async () =>
      createUser(adminPool, {
        email: adminEmail,
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        tenantId: zero,
        role: "admin",
      }),
    );
    const adminToken = await login(adminEmail, ADMIN_PASSWORD);

    const inviteeEmail = `${randomUUID()}@example.test`;
    const created = await call("POST", "/api/admin/invites", { token: adminToken, body: { email: inviteeEmail } });
    expect(created.status).toBe(201);
    const { inviteUrl } = created.body as { inviteUrl: string };
    const token = new URL(inviteUrl).hash.replace("#token=", "");
    expect(token.length).toBeGreaterThan(0);

    const accepted = await call("POST", "/api/invitations/accept", { body: { token, password: INVITEE_PASSWORD } });
    expect(accepted.status).toBe(200);
    const { user } = accepted.body as { user: { id: string; email: string } };
    expect(user.email).toBe(inviteeEmail);

    const inviteeToken = await login(inviteeEmail, INVITEE_PASSWORD);

    const { rows: binding } = await adminPool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM users WHERE id = $1",
      [user.id],
    );
    const inviteeTenantId = binding[0]?.tenant_id;
    if (!inviteeTenantId) throw new Error("the invitee has no tenant");
    expect(inviteeTenantId).not.toBe(zero);
    const { rows: own } = await adminPool.query<{ id: string; system: boolean }>(
      "SELECT id, system FROM databases WHERE tenant_id = $1 AND archived_at IS NULL",
      [inviteeTenantId],
    );
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((row) => row.system)).toBe(true);

    const listed = await call("GET", "/api/databases?limit=200", { token: inviteeToken });
    expect(listed.status).toBe(200);
    const listedIds = (listed.body as { databases: { id: string }[] }).databases.map((db) => db.id).sort();
    expect(listedIds).toEqual(own.map((row) => row.id).sort());

    const foreign = await call("GET", `/api/items/${adminItemId}`, { token: inviteeToken });
    expect(foreign.status).toBe(404);
    // The admin still reads the item, so the 404 is the tenant boundary and not a missing row.
    expect((await call("GET", `/api/items/${adminItemId}`, { token: adminToken })).status).toBe(200);
  });
});
