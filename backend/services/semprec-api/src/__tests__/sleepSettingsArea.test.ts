import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const NIGHTS_PATH = "/api/sleep/nights?from=2026-10-15&to=2026-10-16";

const createdItem = z.object({ id: z.string() }).passthrough();
const nightsBody = z.object({ areaId: z.string().nullable(), planCount: z.number() }).passthrough();
const restError = z.object({ error: z.object({ code: z.string() }).passthrough() });

let pool: Pool;

describe("sleepSettings.area relation through REST (issue gh-1833)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let settingsItemId: string;
  let areasDatabaseId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ key: string; id: string }>(
      "SELECT owner_module_id AS key, id FROM databases WHERE system AND owner_module_id IN ('sleepSettings', 'areas')",
    );
    const idOf = (key: string): string => {
      const row = rows.find((candidate) => candidate.key === key);
      if (!row) throw new Error(`The seed left no ${key} database`);
      return row.id;
    };
    areasDatabaseId = idOf("areas");
    const item = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [
      idOf("sleepSettings"),
    ]);
    const seededSettingsId = item.rows[0]?.id;
    if (!seededSettingsId) throw new Error("The seed left no sleep settings item");
    settingsItemId = seededSettingsId;

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    server = createServer(
      await createDispatcher(pool, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

  async function createArea(name: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/databases/${areasDatabaseId}/items`, {
      method: "POST",
      headers,
      body: JSON.stringify({ properties: { name } }),
    });
    expect(res.status).toBe(201);
    return createdItem.parse(await res.json()).id;
  }

  function putArea(areaId: string): Promise<Response> {
    return fetch(`${baseUrl}/api/items/${settingsItemId}/relations/area/${areaId}`, { method: "PUT", headers });
  }

  async function nightsAreaId(): Promise<string | null> {
    const res = await fetch(`${baseUrl}${NIGHTS_PATH}`, { headers });
    expect(res.status).toBe(200);
    const body = nightsBody.parse(await res.json());
    expect(body.planCount).toBe(2);
    return body.areaId;
  }

  async function storedEdges(): Promise<string[]> {
    const { rows } = await pool.query<{ item_b: string }>(
      "SELECT item_b FROM item_relations WHERE item_a = $1 ORDER BY item_b",
      [settingsItemId],
    );
    return rows.map((row) => row.item_b);
  }

  it("answers areaId null while no edge is set", async () => {
    expect(await nightsAreaId()).toBeNull();
  });

  it("accepts the first edge and reports it as areaId", async () => {
    const areaId = await createArea("Health");

    const put = await putArea(areaId);

    expect(put.ok).toBe(true);
    expect(await storedEdges()).toEqual([areaId]);
    expect(await nightsAreaId()).toBe(areaId);
  });

  it("answers a second edge to another area with 409 cardinality_violation and keeps the first", async () => {
    const first = await createArea("Health");
    const second = await createArea("Home");
    expect((await putArea(first)).ok).toBe(true);

    const refused = await putArea(second);

    expect(refused.status).toBe(409);
    expect(restError.parse(await refused.json()).error.code).toBe("cardinality_violation");
    expect(await storedEdges()).toEqual([first]);
    expect(await nightsAreaId()).toBe(first);
  });
});
