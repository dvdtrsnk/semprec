import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
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
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "correct-horse-battery";
const tmpBlobDir = join(tmpdir(), `semprec-invitation-e2e-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function jsonObject(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await res.json();
  if (!isRecord(parsed)) throw new Error("expected a JSON object body");
  return parsed;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`expected '${key}' to be a string`);
  return value;
}

/**
 * The invitation flow of issue #1087 through the real dispatcher on a runtime-role pool, which
 * `provisionTenant` requires: an admin invites an address, the invitee accepts, signs in, and sees
 * only the new tenant's own system databases, never the admin's data.
 */
describe("invitation acceptance, end to end (issue #1087)", () => {
  let adminPool: Pool;
  let dataPool: Pool;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    const dispatch = await createDispatcher(dataPool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "invitation-e2e-setup-token",
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
    await dataPool.end();
  });

  async function signIn(email: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, platform: "ios" }),
    });
    if (res.status !== 200) throw new Error(`login answered ${res.status}`);
    return stringField(await jsonObject(res), "token");
  }

  it("returns the display name given at setup from GET /api/auth/session", async () => {
    const ownerEmail = `owner-${randomUUID()}@example.test`;

    const setup = await fetch(`${baseUrl}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer invitation-e2e-setup-token" },
      body: JSON.stringify({ email: ownerEmail, password: PASSWORD, displayName: "  Ada  " }),
    });
    expect(setup.status).toBe(200);

    const ownerToken = await signIn(ownerEmail);
    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(session.status).toBe(200);
    const sessionUser = (await jsonObject(session))["user"];
    if (!isRecord(sessionUser)) throw new Error("expected a 'user' object in the session body");
    expect(sessionUser["displayName"]).toBe("Ada");
  });

  it("creates the invitee's own tenant and shows the invitee only that tenant's system databases", async () => {
    const adminEmail = `admin-${randomUUID()}@example.test`;
    const inviteeEmail = `novak-${randomUUID()}@example.cz`;
    await createUser(adminPool, {
      email: adminEmail,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
      role: "admin",
    });
    const adminToken = await signIn(adminEmail);
    // The admin's own data, in tenant zero, which the invitee's tenant must not see.
    const adminItemId = await runInTenant(getTenantZeroId(), () => createTestProjectItem(dataPool));

    const invited = await fetch(`${baseUrl}/api/admin/invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ email: inviteeEmail }),
    });
    expect(invited.status).toBe(201);
    const inviteUrl = stringField(await jsonObject(invited), "inviteUrl");
    const token = new URL(inviteUrl).hash.replace("#token=", "");

    const accepted = await fetch(`${baseUrl}/api/invitations/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: PASSWORD, displayName: "  Novak  " }),
    });
    expect(accepted.status).toBe(200);

    const inviteeToken = await signIn(inviteeEmail);
    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Authorization: `Bearer ${inviteeToken}` },
    });
    expect(session.status).toBe(200);
    const sessionUser = (await jsonObject(session))["user"];
    if (!isRecord(sessionUser)) throw new Error("expected a 'user' object in the session body");
    expect(sessionUser["displayName"]).toBe("Novak");
    const listed = await fetch(`${baseUrl}/api/databases`, {
      headers: { Authorization: `Bearer ${inviteeToken}` },
    });
    expect(listed.status).toBe(200);
    const databases = (await jsonObject(listed))["databases"];
    if (!Array.isArray(databases)) throw new Error("expected 'databases' to be an array");
    const listedIds = databases.map((entry) => {
      if (!isRecord(entry)) throw new Error("expected each database to be an object");
      return stringField(entry, "id");
    });

    const { rows: tenantRows } = await adminPool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM users WHERE email = $1",
      [inviteeEmail],
    );
    const newTenantId = tenantRows[0]?.tenant_id;
    if (!newTenantId || newTenantId === getTenantZeroId())
      throw new Error("the invitee must have a tenant of their own");
    const { rows: ownRows } = await adminPool.query<{ id: string }>(
      "SELECT id FROM databases WHERE tenant_id = $1 AND system ORDER BY id",
      [newTenantId],
    );
    expect(ownRows.length).toBeGreaterThan(0);
    expect([...listedIds].sort()).toEqual(ownRows.map((row) => row.id).sort());

    const { rows: adminDatabaseRows } = await adminPool.query<{ database_id: string }>(
      "SELECT database_id FROM items WHERE id = $1",
      [adminItemId],
    );
    const adminDatabaseId = adminDatabaseRows[0]?.database_id;
    expect(adminDatabaseId).toBeDefined();
    expect(listedIds).not.toContain(adminDatabaseId);

    // The item exists, so this 404 is the tenant boundary, not a missing row.
    const foreignItem = await fetch(`${baseUrl}/api/items/${adminItemId}`, {
      headers: { Authorization: `Bearer ${inviteeToken}` },
    });
    expect(foreignItem.status).toBe(404);
  }, 120_000);
});
