import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  login,
  seedSystem,
  type ChokePoint,
  type PasswordResetMailer,
  type PropertyRow,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

/**
 * `graphile_worker.jobs` (000017's view) no longer projects `payload` — this reads the
 * underlying `_private_jobs` table it's built on, joined to `_private_tasks` for the identifier.
 */
async function countPropertyTypeMigrationJobs(propertyId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM graphile_worker._private_jobs jobs
     JOIN graphile_worker._private_tasks tasks ON tasks.id = jobs.task_id
     WHERE tasks.identifier = 'propertyTypeMigration' AND jobs.payload->>'propertyId' = $1`,
    [propertyId],
  );
  return Number(rows[0]!.count);
}

interface PropertyBody {
  id: string;
  key: string;
  name: string;
  type: string;
  locked: boolean;
  migrationStatus: string;
}

describe("property routes (issue #240)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());

    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
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

  it("rejects an unauthenticated request", async () => {
    const res = await fetch(`${baseUrl}/api/properties/${randomUUID()}`, { method: "PATCH" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown property id", async () => {
    const headers = await authHeader();
    const res = await fetch(`${baseUrl}/api/properties/${randomUUID()}`, { method: "PATCH", headers });
    expect(res.status).toBe(404);
  });

  it("renames a property (200, not 204)", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "New Title" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PropertyBody;
    expect(body.name).toBe("New Title");
  });

  it("changing type returns 202 and enqueues exactly one migration_status job", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property: PropertyRow = await chokePoint.createProperty({
      databaseId: database.id,
      key: "score",
      name: "Score",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "number" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as PropertyBody;
    expect(body.type).toBe("number");
    expect(body.migrationStatus).toBe("pending");

    expect(await countPropertyTypeMigrationJobs(property.id)).toBe(1);
  });

  it("returns 200, not 202, when no type change is requested", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "text" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 403 property_locked when changing the type of a locked property", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });
    await pool.query(`UPDATE properties SET locked = true WHERE id = $1`, [property.id]);

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ type: "number" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("property_locked");
  });

  it("returns 403 schema_locked when changing the config of a property in a schema-locked database", async () => {
    const headers = { ...(await authHeader()), "Content-Type": "application/json" };
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });
    await pool.query(`UPDATE databases SET schema_locked = true WHERE id = $1`, [database.id]);

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ config: { note: "x" } }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("schema_locked");
  });

  it("deletes a property (200 with its prior representation, not 204)", async () => {
    const headers = await authHeader();
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PropertyBody;
    expect(body.id).toBe(property.id);

    expect(await chokePoint.getProperty(property.id)).toBeNull();
  });

  it("returns 403 property_locked when deleting a locked property", async () => {
    const headers = await authHeader();
    const database = await chokePoint.createDatabase({ name: "D" });
    const property = await chokePoint.createProperty({
      databaseId: database.id,
      key: "title",
      name: "Title",
      type: "text",
      locked: true,
    });

    const res = await fetch(`${baseUrl}/api/properties/${property.id}`, { method: "DELETE", headers });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("property_locked");
  });
});
