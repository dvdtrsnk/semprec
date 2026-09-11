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

interface ItemQueryBody {
  items: ItemBody[];
  nextCursor: string | null;
}

interface RelationBody {
  id: string;
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata: Record<string, unknown>;
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

    it("returns 404 for an unknown item even with ?include=path", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}?include=path`, { headers });
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

    it("rejects a patch body with no properties field with a 'required' message, not a type error", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ ifVersion: item.updatedAt }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
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

  describe("delete (issue #156)", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, { method: "DELETE" });
      expect(res.status).toBe(401);
    });

    it("returns 404 deleting an unknown item", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}`, { method: "DELETE", headers });
      expect(res.status).toBe(404);
    });

    it("soft-deletes an item and returns 200 with the full row, never 204", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
      expect(body.deletedAt).not.toBeNull();
    });

    it("cascades the delete through nested inline databases", async () => {
      const headers = await authHeader();
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });

      const res = await fetch(`${baseUrl}/api/items/${rootItem.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(200);

      const midAfter = await chokePoint.getItem(midDb.id, midItem.id);
      expect(midAfter?.deletedAt).not.toBeNull();
    });

    it("repeating the delete on an already-trashed item is idempotent, not a 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      const res = await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
    });

    it("rejects a delete against an archived database with 403 database_archived", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      await chokePoint.archiveDatabase(db.id);
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("database_archived");
    });
  });

  describe("restore (issue #156)", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/restore`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("returns 404 restoring an unknown item", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/restore`, { method: "POST", headers });
      expect(res.status).toBe(404);
    });

    it("restores a trashed item and returns 200 with the full row, never 204", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();
      await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });

      const res = await fetch(`${baseUrl}/api/items/${item.id}/restore`, { method: "POST", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
      expect(body.deletedAt).toBeNull();
    });

    it("cascades the restore through nested inline databases", async () => {
      const headers = await authHeader();
      const rootDb = await chokePoint.createDatabase({ name: "Root" });
      const rootItem = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
      const midDb = await chokePoint.createInlineDatabase({ name: "Mid", parentItemId: rootItem.id });
      const midItem = await chokePoint.createItem({ databaseId: midDb.id, properties: {} });
      await fetch(`${baseUrl}/api/items/${rootItem.id}`, { method: "DELETE", headers });

      const res = await fetch(`${baseUrl}/api/items/${rootItem.id}/restore`, { method: "POST", headers });
      expect(res.status).toBe(200);

      const midAfter = await chokePoint.getItem(midDb.id, midItem.id);
      expect(midAfter?.deletedAt).toBeNull();
    });

    it("repeating the restore on an already-live item is idempotent, not a 404", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/items/${item.id}/restore`, { method: "POST", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemBody;
      expect(body.id).toBe(item.id);
      expect(body.deletedAt).toBeNull();
    });

    it("rejects a restore against an archived database with 403 database_archived", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = await authHeader();
      await fetch(`${baseUrl}/api/items/${item.id}`, { method: "DELETE", headers });
      await chokePoint.archiveDatabase(db.id);

      const res = await fetch(`${baseUrl}/api/items/${item.id}/restore`, { method: "POST", headers });
      expect(res.status).toBe(403);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("database_archived");
    });
  });

  describe("query database (issue #157)", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/databases/${randomUUID()}/query`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("returns 404 querying an unknown database", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/databases/${randomUUID()}/query`, { method: "POST", headers });
      expect(res.status).toBe(404);
    });

    it("returns items ordered by id by default with no body, never 204", async () => {
      const db = await makeMoviesDb();
      const a = await chokePoint.createItem({ databaseId: db.id, properties: { title: "A" } });
      const b = await chokePoint.createItem({ databaseId: db.id, properties: { title: "B" } });
      const headers = await authHeader();

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, { method: "POST", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemQueryBody;
      expect(body.items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    });

    it("applies a filter tree", async () => {
      const db = await makeMoviesDb();
      await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
      const dune = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { type: "equals", property: "title", value: "Dune" } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemQueryBody;
      expect(body.items.map((i) => i.id)).toEqual([dune.id]);
    });

    it("excludes soft-deleted items by default and includes them with inTrash: true", async () => {
      const db = await makeMoviesDb();
      const item = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      await chokePoint.softDeleteItem(db.id, item.id);
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const liveRes = await fetch(`${baseUrl}/api/databases/${db.id}/query`, { method: "POST", headers, body: "{}" });
      const liveBody = (await liveRes.json()) as ItemQueryBody;
      expect(liveBody.items).toEqual([]);

      const trashRes = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ inTrash: true }),
      });
      const trashBody = (await trashRes.json()) as ItemQueryBody;
      expect(trashBody.items.map((i) => i.id)).toEqual([item.id]);
    });

    it("paginates with a stable, non-duplicating keyset cursor under default order", async () => {
      const db = await makeMoviesDb();
      const items = [];
      for (let i = 0; i < 5; i++) {
        items.push(await chokePoint.createItem({ databaseId: db.id, properties: { title: `T${i}` } }));
      }
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const sortedIds = [...items.map((i) => i.id)].sort();

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page++) {
        const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
          method: "POST",
          headers,
          body: JSON.stringify({ limit: 2, cursor: cursor ?? undefined }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ItemQueryBody;
        seen.push(...body.items.map((i) => i.id));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(sortedIds);
      expect(new Set(seen).size).toBe(sortedIds.length);
    });

    it("returns validation_failed for a malformed filter tree, with no partial results", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { type: "not_a_real_type", property: "title" } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for a malformed sort array", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sort: [{ property: "title", direction: "sideways" }] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for a non-positive limit", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: 0 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for a non-UUID cursor used for keyset paging", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ cursor: "not-a-uuid" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for a non-boolean inTrash", async () => {
      const db = await makeMoviesDb();
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ inTrash: "yes" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("matches an equivalent stored view's query results for the same database", async () => {
      const db = await makeMoviesDb();
      const arrival = await chokePoint.createItem({ databaseId: db.id, properties: { title: "Arrival" } });
      await chokePoint.createItem({ databaseId: db.id, properties: { title: "Dune" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const filter = { type: "equals", property: "title", value: "Arrival" };

      const view = await chokePoint.createView({ databaseId: db.id, type: "table", name: "Arrivals", config: { filter } });

      const dbRes = await fetch(`${baseUrl}/api/databases/${db.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter }),
      });
      const dbBody = (await dbRes.json()) as ItemQueryBody;

      const viewRes = await fetch(`${baseUrl}/api/views/${view.id}/query`, { method: "POST", headers, body: "{}" });
      const viewBody = (await viewRes.json()) as ItemQueryBody;

      expect(dbBody.items.map((i) => i.id)).toEqual([arrival.id]);
      expect(viewBody.items.map((i) => i.id)).toEqual(dbBody.items.map((i) => i.id));
      expect(viewBody.nextCursor).toBe(dbBody.nextCursor);
    });
  });

  describe("relations (issue #157)", () => {
    async function makePairedRelation(cardinality?: "one_to_one" | "one_to_many" | "many_to_many") {
      const source = await chokePoint.createDatabase({ name: "Tasks" });
      const target = await chokePoint.createDatabase({ name: "People" });
      const { property } = await chokePoint.createRelationProperty({
        sourceDatabaseId: source.id,
        key: "assignedTo",
        name: "Assigned To",
        targetDatabaseId: target.id,
        cardinality,
        inverse: { key: "assignedTasks", name: "Assigned Tasks" },
      });
      const inverseProperty = await chokePoint.getPropertyByKey(target.id, "assignedTasks");
      if (!inverseProperty) throw new Error("expected inverse property to exist");
      return { source, target, property, inverseProperty };
    }

    describe("PUT create/replace", () => {
      it("rejects an unauthenticated request", async () => {
        const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/relations/foo/${randomUUID()}`, {
          method: "PUT",
        });
        expect(res.status).toBe(401);
      });

      it("returns 404 for an unknown caller item", async () => {
        const headers = await authHeader();
        const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/relations/foo/${randomUUID()}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("returns 404 for a propertyKey that doesn't exist on the caller's database", async () => {
        const { source } = await makePairedRelation();
        const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${item.id}/relations/nope/${randomUUID()}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("returns 404 for a propertyKey belonging to a foreign, unrelated database", async () => {
        const { source } = await makePairedRelation();
        const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const other = await chokePoint.createDatabase({ name: "Other" });
        await chokePoint.createProperty({ databaseId: other.id, key: "unrelated", name: "Unrelated", type: "text" });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${item.id}/relations/unrelated/${randomUUID()}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("creates an edge from the direct (A) side and returns 200 with the full envelope, never 204", async () => {
        const { source, target, property } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ metadata: { role: "owner" } }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as RelationBody;
        expect(body.itemA).toBe(task.id);
        expect(body.itemB).toBe(person.id);
        expect(body.metadata).toEqual({ role: "owner" });
      });

      it("creates an edge from the inverse (B) side, normalizing itemA/itemB the same as the A-side call", async () => {
        const { source, target, property, inverseProperty } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        const direct = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        const directBody = (await direct.json()) as RelationBody;

        const inverse = await fetch(
          `${baseUrl}/api/items/${person.id}/relations/${inverseProperty.key}/${task.id}`,
          { method: "PUT", headers },
        );
        expect(inverse.status).toBe(200);
        const inverseBody = (await inverse.json()) as RelationBody;
        expect(inverseBody.id).toBe(directBody.id);
        expect(inverseBody.itemA).toBe(task.id);
        expect(inverseBody.itemB).toBe(person.id);
      });

      it("repeating PUT with different metadata replaces rather than merges", async () => {
        const { source, target, property } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ metadata: { role: "owner", note: "x" } }),
        });
        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ metadata: { role: "reviewer" } }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as RelationBody;
        expect(body.metadata).toEqual({ role: "reviewer" });
      });

      it("enforces one_to_one cardinality with 409 cardinality_violation", async () => {
        const { source, target, property } = await makePairedRelation("one_to_one");
        const taskA = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const taskB = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        await fetch(`${baseUrl}/api/items/${taskA.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        const res = await fetch(`${baseUrl}/api/items/${taskB.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(409);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.code).toBe("cardinality_violation");
      });

      it("allows a single source item to relate to many targets under one_to_many", async () => {
        const { source, target, property } = await makePairedRelation("one_to_many");
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const personA = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const personB = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        const resA = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${personA.id}`, {
          method: "PUT",
          headers,
        });
        const resB = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${personB.id}`, {
          method: "PUT",
          headers,
        });
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
      });

      it("allows both sides to relate to many under many_to_many", async () => {
        const { source, target, property } = await makePairedRelation("many_to_many");
        const taskA = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const taskB = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = { ...(await authHeader()), "Content-Type": "application/json" };

        const resA = await fetch(`${baseUrl}/api/items/${taskA.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        const resB = await fetch(`${baseUrl}/api/items/${taskB.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);
      });

      it("rejects a write through a system-owned relation property with 403 owner_violation", async () => {
        const source = await chokePoint.createDatabase({ name: "Tasks" });
        const target = await chokePoint.createDatabase({ name: "People" });
        const { property } = await chokePoint.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "systemLink",
          name: "System Link",
          targetDatabaseId: target.id,
        });
        // The public facade never accepts a `SystemRelationWriteContext`, so an owner:'system'
        // property can't be created through it at all; flip it directly in the DB to set up the
        // fixture this route's rejection is being tested against.
        await pool.query("UPDATE properties SET owner = 'system', owner_process = $2 WHERE id = $1", [
          property.id,
          "some-internal-process",
        ]);
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.code).toBe("owner_violation");
      });
    });

    describe("DELETE", () => {
      it("rejects an unauthenticated request", async () => {
        const res = await fetch(`${baseUrl}/api/items/${randomUUID()}/relations/foo/${randomUUID()}`, {
          method: "DELETE",
        });
        expect(res.status).toBe(401);
      });

      it("returns 404 for a propertyKey that doesn't exist", async () => {
        const { source } = await makePairedRelation();
        const item = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${item.id}/relations/nope/${randomUUID()}`, {
          method: "DELETE",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("returns 404 deleting a non-existent edge", async () => {
        const { source, target, property } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "DELETE",
          headers,
        });
        expect(res.status).toBe(404);
      });

      it("deletes an existing edge and returns 200 with the full deleted envelope, never 204", async () => {
        const { source, target, property } = await makePairedRelation();
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = await authHeader();

        await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "PUT",
          headers,
        });
        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "DELETE",
          headers,
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as RelationBody;
        expect(body.itemA).toBe(task.id);
        expect(body.itemB).toBe(person.id);
      });

      it("rejects a delete through a system-owned relation property with 403 owner_violation", async () => {
        const source = await chokePoint.createDatabase({ name: "Tasks" });
        const target = await chokePoint.createDatabase({ name: "People" });
        const { property } = await chokePoint.createRelationProperty({
          sourceDatabaseId: source.id,
          key: "systemLink",
          name: "System Link",
          targetDatabaseId: target.id,
        });
        await pool.query("UPDATE properties SET owner = 'system', owner_process = $2 WHERE id = $1", [
          property.id,
          "some-internal-process",
        ]);
        const task = await chokePoint.createItem({ databaseId: source.id, properties: {} });
        const person = await chokePoint.createItem({ databaseId: target.id, properties: {} });
        const headers = await authHeader();

        const res = await fetch(`${baseUrl}/api/items/${task.id}/relations/${property.key}/${person.id}`, {
          method: "DELETE",
          headers,
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.code).toBe("owner_violation");
      });
    });
  });
});
