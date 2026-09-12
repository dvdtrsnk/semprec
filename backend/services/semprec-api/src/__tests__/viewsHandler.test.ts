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

interface ViewBody {
  id: string;
  databaseId: string | null;
  type: string;
  name: string;
  config: Record<string, unknown>;
  isDefault: boolean;
}

interface ViewItemBody {
  viewId: string;
  itemId: string;
  position: number;
}

describe("view routes (issue #155)", () => {
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

  describe("view CRUD", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/views/${randomUUID()}`, { method: "PATCH" });
      expect(res.status).toBe(401);
    });

    it("creates a linked view against a database (201, not 204)", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const database = await chokePoint.createDatabase({ name: "D" });

      const res = await fetch(`${baseUrl}/api/databases/${database.id}/views`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "table", name: "All rows" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as ViewBody;
      expect(body.databaseId).toBe(database.id);
      expect(body.type).toBe("table");
      expect(body.name).toBe("All rows");
    });

    it("returns 404 creating a view against an unknown database", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const res = await fetch(`${baseUrl}/api/databases/${randomUUID()}/views`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "table", name: "All rows" }),
      });
      expect(res.status).toBe(404);
    });

    it("patches a view (200, not 204)", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const database = await chokePoint.createDatabase({ name: "D" });
      const view = await chokePoint.createView({ databaseId: database.id, type: "table", name: "All rows" });

      const res = await fetch(`${baseUrl}/api/views/${view.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ViewBody;
      expect(body.name).toBe("Renamed");
    });

    it("returns 404 patching an unknown view id", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const res = await fetch(`${baseUrl}/api/views/${randomUUID()}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "x" }),
      });
      expect(res.status).toBe(404);
    });

    it("deletes a view (200 with its prior representation, not 204)", async () => {
      const headers = await authHeader();
      const database = await chokePoint.createDatabase({ name: "D" });
      const view = await chokePoint.createView({ databaseId: database.id, type: "table", name: "All rows" });

      const res = await fetch(`${baseUrl}/api/views/${view.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ViewBody;
      expect(body.id).toBe(view.id);

      expect(await chokePoint.getView(view.id)).toBeNull();
    });

    it("returns 404 deleting an unknown view id", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/views/${randomUUID()}`, { method: "DELETE", headers });
      expect(res.status).toBe(404);
    });
  });

  describe("curated view membership", () => {
    async function makeCuratedView() {
      return chokePoint.createView({ type: "list", name: "Collection", config: { membership: "manual" } });
    }

    async function makeItem() {
      const database = await chokePoint.createDatabase({ name: "D" });
      return chokePoint.createItem({ databaseId: database.id, properties: {} });
    }

    it("adds an item to a curated view (200, not 204)", async () => {
      const headers = await authHeader();
      const view = await makeCuratedView();
      const item = await makeItem();

      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, { method: "PUT", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ViewItemBody;
      expect(body).toEqual({ viewId: view.id, itemId: item.id, position: 0 });

      expect(await chokePoint.listViewItems(view.id)).toEqual([{ viewId: view.id, itemId: item.id, position: 0 }]);
    });

    it("is idempotent: repeating the same PUT leaves membership unchanged", async () => {
      const headers = await authHeader();
      const view = await makeCuratedView();
      const item = await makeItem();

      await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, { method: "PUT", headers });
      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, { method: "PUT", headers });
      expect(res.status).toBe(200);

      expect(await chokePoint.listViewItems(view.id)).toEqual([{ viewId: view.id, itemId: item.id, position: 0 }]);
    });

    it("repositions an existing member via PUT with an explicit position", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const view = await makeCuratedView();
      const itemA = await makeItem();
      const itemB = await makeItem();

      await chokePoint.addViewItem({ viewId: view.id, itemId: itemA.id, actor: { type: "user" } });
      await chokePoint.addViewItem({ viewId: view.id, itemId: itemB.id, actor: { type: "user" } });

      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${itemB.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 0 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ViewItemBody;
      expect(body.position).toBe(0);

      const members = await chokePoint.listViewItems(view.id);
      expect(members.map((m) => m.itemId)).toEqual([itemB.id, itemA.id]);
    });

    it("returns 400 for a non-integer or negative position", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const view = await makeCuratedView();
      const item = await makeItem();

      const floatRes = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 1.5 }),
      });
      expect(floatRes.status).toBe(400);

      const negativeRes = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: -1 }),
      });
      expect(negativeRes.status).toBe(400);

      const outOfRangeRes = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 2147483648 }),
      });
      expect(outOfRangeRes.status).toBe(400);

      // A raw literal, not `JSON.stringify(Infinity)` (which serializes to `null`): a JSON
      // number literal wide enough to overflow float64 parses to `Infinity`, same as any other
      // out-of-domain value a caller might send.
      const infiniteRes = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, {
        method: "PUT",
        headers,
        body: '{"position":1e309}',
      });
      expect(infiniteRes.status).toBe(400);
    });

    it("removes a member from a curated view (200 with its prior representation, not 204)", async () => {
      const headers = await authHeader();
      const view = await makeCuratedView();
      const item = await makeItem();
      await chokePoint.addViewItem({ viewId: view.id, itemId: item.id, actor: { type: "user" } });

      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ViewItemBody;
      expect(body).toEqual({ viewId: view.id, itemId: item.id, position: 0 });

      expect(await chokePoint.listViewItems(view.id)).toEqual([]);
    });

    it("returns 404 adding an item to an unknown view", async () => {
      const headers = await authHeader();
      const item = await makeItem();
      const res = await fetch(`${baseUrl}/api/views/${randomUUID()}/items/${item.id}`, { method: "PUT", headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 adding an unknown item to a curated view", async () => {
      const headers = await authHeader();
      const view = await makeCuratedView();
      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${randomUUID()}`, { method: "PUT", headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 removing an unknown member from a known curated view", async () => {
      const headers = await authHeader();
      const view = await makeCuratedView();
      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${randomUUID()}`, { method: "DELETE", headers });
      expect(res.status).toBe(404);
    });

    it("returns 404 removing a member from an unknown view", async () => {
      const headers = await authHeader();
      const item = await makeItem();
      const res = await fetch(`${baseUrl}/api/views/${randomUUID()}/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(404);
    });

    it("returns 400 adding an item to a non-curated (linked) view", async () => {
      const headers = await authHeader();
      const database = await chokePoint.createDatabase({ name: "D" });
      const view = await chokePoint.createView({ databaseId: database.id, type: "table", name: "All rows" });
      const item = await makeItem();

      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, { method: "PUT", headers });
      expect(res.status).toBe(400);
    });

    it("returns 400 removing an item from a non-curated (linked) view, not a misleading 404", async () => {
      const headers = await authHeader();
      const database = await chokePoint.createDatabase({ name: "D" });
      const view = await chokePoint.createView({ databaseId: database.id, type: "table", name: "All rows" });
      const item = await makeItem();

      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(400);
    });
  });
});
