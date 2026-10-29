import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const moduleRegistry = await loadFullModuleRegistry();

let adminPool: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;

async function headersIn(tenantId: string): Promise<Record<string, string>> {
  const email = `${randomUUID()}@example.com`;
  await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
  const { token } = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("creating a database with properties across two tenants (issue #1592)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    await seedSystem(adminPool, createViewTypeRegistry());
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-${randomUUID()}`)),
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

  const post = async (headers: Record<string, string>, body: unknown) => {
    const res = await fetch(`${baseUrl}/api/databases`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  };
  const customDatabaseCount = async (): Promise<number> =>
    Number(
      (await adminPool.query<{ n: string }>("SELECT count(*) AS n FROM databases WHERE system = false")).rows[0]?.n,
    );

  it("fails a relation to another tenant's database exactly like an unknown id and leaves nothing", async () => {
    const aHeaders = await headersIn(getTenantZeroId());
    const bHeaders = await headersIn(await createTestTenant(adminPool));
    const foreign = JSON.parse((await post(aHeaders, { name: "Tenant A" })).text) as { id: string };
    const before = await customDatabaseCount();
    const relation = (targetDatabaseId: string) => ({
      name: "Mine",
      properties: [{ key: "link", name: "Link", type: "relation", targetDatabaseId, cardinality: "one_to_many" }],
    });

    const crossTenant = await post(bHeaders, relation(foreign.id));
    const unknownId = randomUUID();
    const unknown = await post(bHeaders, relation(unknownId));

    expect(crossTenant.status).toBe(400);
    expect(crossTenant.status).toBe(unknown.status);
    expect(crossTenant.text.replace(foreign.id, "<id>")).toBe(unknown.text.replace(unknownId, "<id>"));
    expect(await customDatabaseCount()).toBe(before);
  });
});
