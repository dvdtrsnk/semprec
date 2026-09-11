import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  login,
  type ChokePoint,
  type PasswordResetMailer,
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

interface ItemBody {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
  path?: ItemBody[];
}

interface ErrorBody {
  error: { code: string; details?: unknown };
}

describe("item routes (issue #241)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);

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

  async function makeMoviesDb() {
    const db = await chokePoint.createDatabase({ name: "Movies" });
    await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
    return db;
  }

  describe("create", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/databases/${randomUUID()}/items`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("creates an item and returns 201 with the full row", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json", "Idempotency-Key": randomUUID() };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ItemBody;
      expect(body.databaseId).toBe(db.id);
      expect(body.properties).toEqual({ title: "Arrival" });
    });

    it("rejects a create with no Idempotency-Key header", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("repeating the same Idempotency-Key returns the original row without a second insert", async () => {
      const db = await makeMoviesDb();
      const key = randomUUID();
      const headers = { ...(await authHeader()), "Content-Type": "application/json", "Idempotency-Key": key };

      const first = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Dune" } }),
      });
      const firstBody = (await first.json()) as ItemBody;

      const second = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Dune 2" } }),
      });
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as ItemBody;
      expect(secondBody.id).toBe(firstBody.id);
      expect(secondBody.properties).toEqual({ title: "Dune" });

      const { rows } = await pool.query("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [db.id]);
      expect(rows[0].n).toBe(1);
    });

    it("rejects a create against an archived database with 403 database_archived", async () => {
      const db = await makeMoviesDb();
      await chokePoint.archiveDatabase(db.id);
      const headers = { ...(await authHeader()), "Content-Type": "application/json", "Idempotency-Key": randomUUID() };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers,
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("database_archived");
    });
  });

  describe("detail", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`);
      expect(res.status).toBe(401);
    });

    it("returns 404 for an unknown item", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, { headers });
      expect(res.status).toBe(404);
    });

    it("returns the item without a path by default", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
      expect(body.path).toBeUndefined();
    });

    it("assembles the full ancestor chain for a row nested several inline databases deep", async () => {
      const headers = await authHeader();

      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });

      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      const leafDb = await chokePoint.createInlineDatabase({ name: "Leaf", parentItemId: midItem.id });
      const leafItem = await chokePoint.createItem({ databaseId: leafDb.id, properties: {} });

      const res = await fetch(`${baseUrl}/api/items/${leafItem.id}?include=path`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.path?.map((i) => i.id)).toEqual([rootItem.id, midItem.id, leafItem.id]);
    });

    it("returns a single-entry path for a top-level row, same shape as a nested one", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}?include=path`, { headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.path?.map((i) => i.id)).toEqual([item.id]);
    });
  });

  describe("patch", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, { method: "PATCH" });
      expect(res.status).toBe(401);
    });

    it("merges a properties patch by key and returns 200 with the full row", async () => {
      const db = await chokePoint.createDatabase({ name: "D" });
      await chokePoint.createProperty({ databaseId: db.id, key: "title", name: "Title", type: "text" });
      await chokePoint.createProperty({ databaseId: db.id, key: "year", name: "Year", type: "number" });
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune", year: 2021 } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Dune (2021)" }, ifVersion: item.updatedAt }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.properties).toEqual({ title: "Dune (2021)", year: 2021 });
    });

    it("returns 404 patching an unknown item", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: {} }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 409 version_conflict with details.currentItem on a stale ifVersion", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Dune (2021)" }, ifVersion: item.updatedAt }),
      });

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Dune Part Two" }, ifVersion: item.updatedAt }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as ErrorBody & { error: { details: { currentItem: ItemBody } } };
      expect(body.error.code).toBe("version_conflict");
      expect(body.error.details.currentItem.id).toBe(item.id);
      expect(body.error.details.currentItem.properties).toEqual({ title: "Dune (2021)" });
    });

    it("rejects a write to a rollup-typed property with 403 computed_readonly", async () => {
      const source = await chokePoint.createDatabase({ name: "P" });
      const target = await chokePoint.createDatabase({ name: "T" });
      const { property: relation } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "tasks",
        name: "Tasks",
        targetDatabaseId: target.id,
      });
      const rollup = await chokePoint.createProperty({
        databaseId: source.id,
        key: "count",
        name: "Count",
        type: "rollup",
        config: { relationPropertyKey: relation.key, aggregation: "count" },
      });
      const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { [rollup.key]: 5 } }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("computed_readonly");
    });

    it("rejects a patch against an archived database with 403 database_archived", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      await chokePoint.archiveDatabase(db.id);
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ properties: { title: "Dune (2021)" } }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("database_archived");
    });
  });
});
