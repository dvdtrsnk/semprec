import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type ChokePoint,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
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

interface ItemQueryBody {
  items: { id: string }[];
  nextCursor: string | null;
}

interface ErrorBody {
  error: { code: string; details?: unknown };
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

    it("returns 400 naming 'config' creating a gallery view with columns 5", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const database = await chokePoint.createDatabase({ name: "D" });

      const res = await fetch(`${baseUrl}/api/databases/${database.id}/views`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "gallery", name: "G", config: { columns: 5, aspect: "3:4" } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details).toMatchObject({ field: "config" });
    });

    it("rejects an invalid gallery patch over HTTP without changing the view", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const database = await chokePoint.createDatabase({ name: "D" });
      const view = await chokePoint.createView({
        databaseId: database.id,
        type: "gallery",
        name: "G",
        config: { columns: 3, aspect: "3:4" },
      });
      const res = await fetch(`${baseUrl}/api/views/${view.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ config: { columns: 5 } }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "validation_failed", details: { field: "config" } } });
      expect((await chokePoint.getView(view.id))?.config).toEqual(view.config);
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

  describe("the Today system view (issue #1798)", () => {
    /** The seeded Today view of the Tasks database, found by its `systemKey` as a client finds it. */
    async function todayViewId(): Promise<string> {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT v.id FROM views v JOIN databases d ON d.id = v.database_id
         WHERE d.owner_module_id = 'tasks' AND v.config->>'systemKey' = 'today'`,
      );
      if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one Today view, found ${rows.length}`);
      return rows[0].id;
    }

    it("refuses a human PATCH with 403 system_owned and leaves the view as it was", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const id = await todayViewId();
      const before = await chokePoint.getView(id);

      const res = await fetch(`${baseUrl}/api/views/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Renamed", config: { sort: [] } }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "owner_violation", details: { viewId: id, reason: "system_owned" } },
      });
      expect(await chokePoint.getView(id)).toEqual(before);
    });

    it("refuses a human DELETE with 403 system_owned and keeps the view", async () => {
      const headers = await authHeader();
      const id = await todayViewId();

      const res = await fetch(`${baseUrl}/api/views/${id}`, { method: "DELETE", headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "owner_violation", details: { viewId: id, reason: "system_owned" } },
      });
      expect(await chokePoint.getView(id)).not.toBeNull();
    });

    it("refuses a human POST that sets config.systemKey with 403 system_key_reserved and stores no view", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const database = await chokePoint.createDatabase({ name: "D" });

      const res = await fetch(`${baseUrl}/api/databases/${database.id}/views`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "table", name: "Forged", config: { systemKey: "today" } }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "owner_violation", details: { field: "config.systemKey", reason: "system_key_reserved" } },
      });
      expect(await chokePoint.listViewsByDatabase(database.id)).toEqual([]);
    });

    it("refuses a human PATCH that sets config.systemKey on its own view and leaves the view editable", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const database = await chokePoint.createDatabase({ name: "D" });
      const own = await chokePoint.createView({ databaseId: database.id, type: "table", name: "Own" });

      const res = await fetch(`${baseUrl}/api/views/${own.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ config: { systemKey: "x" } }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "owner_violation", details: { field: "config.systemKey", reason: "system_key_reserved" } },
      });
      expect((await chokePoint.getView(own.id))?.config).toEqual(own.config);

      const renamed = await fetch(`${baseUrl}/api/views/${own.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "Renamed" }),
      });
      expect(renamed.status).toBe(200);
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
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const view = await makeCuratedView();
      const item = await makeItem();

      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 0 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ViewItemBody;
      expect(body).toEqual({ viewId: view.id, itemId: item.id, position: 0 });

      expect(await chokePoint.listViewItems(view.id)).toEqual([{ viewId: view.id, itemId: item.id, position: 0 }]);
    });

    it("returns 400 validation_failed naming 'itemId' for a non-UUID item id", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const view = await makeCuratedView();

      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/foo`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 0 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details).toEqual({ field: "itemId" });
      expect(await chokePoint.listViewItems(view.id)).toEqual([]);
    });

    it("adds an item to a curated view with no position, appending to the end (200, not 400)", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const view = await makeCuratedView();
      const itemA = await makeItem();
      const itemB = await makeItem();

      await fetch(`${baseUrl}/api/views/${view.id}/items/${itemA.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 0 }),
      });

      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${itemB.id}`, {
        method: "PUT",
        headers,
        body: "{}",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ViewItemBody;
      expect(body).toEqual({ viewId: view.id, itemId: itemB.id, position: 1 });

      expect(await chokePoint.listViewItems(view.id)).toEqual([
        { viewId: view.id, itemId: itemA.id, position: 0 },
        { viewId: view.id, itemId: itemB.id, position: 1 },
      ]);
    });

    it("is idempotent: repeating the same PUT leaves membership unchanged", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const view = await makeCuratedView();
      const item = await makeItem();

      await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 0 }),
      });
      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 0 }),
      });
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

    it("removes a member from a curated view (200 with a thin deleted confirmation, not 204)", async () => {
      const headers = await authHeader();
      const view = await makeCuratedView();
      const item = await makeItem();
      await chokePoint.addViewItem({ viewId: view.id, itemId: item.id, actor: { type: "user" } });

      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${item.id}`, { method: "DELETE", headers });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { deleted: boolean; viewId: string; itemId: string };
      expect(body).toEqual({ deleted: true, viewId: view.id, itemId: item.id });

      expect(await chokePoint.listViewItems(view.id)).toEqual([]);
    });

    it("returns 404 adding an item to an unknown view", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const item = await makeItem();
      const res = await fetch(`${baseUrl}/api/views/${randomUUID()}/items/${item.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 0 }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 adding an unknown item to a curated view", async () => {
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };
      const view = await makeCuratedView();
      const res = await fetch(`${baseUrl}/api/views/${view.id}/items/${randomUUID()}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ position: 0 }),
      });
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

  describe("query view (issue #157)", () => {
    it("rejects an unauthenticated request", async () => {
      const res = await fetch(`${baseUrl}/api/views/${randomUUID()}/query`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    it("returns 404 querying an unknown view", async () => {
      const headers = await authHeader();
      const res = await fetch(`${baseUrl}/api/views/${randomUUID()}/query`, { method: "POST", headers });
      expect(res.status).toBe(404);
    });

    it("uses the view's own stored filter when the request omits one, never 204", async () => {
      const database = await chokePoint.createDatabase({ name: "Movies" });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });
      const arrival = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Arrival" } });
      await chokePoint.createItem({ databaseId: database.id, properties: { title: "Dune" } });
      const filter = { type: "equals", property: "title", value: "Arrival" };
      const view = await chokePoint.createView({
        databaseId: database.id,
        type: "table",
        name: "Arrivals",
        config: { filter },
      });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/views/${view.id}/query`, { method: "POST", headers, body: "{}" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemQueryBody;
      expect(body.items.map((i) => i.id)).toEqual([arrival.id]);
    });

    it("lets an ad-hoc filter override the view's stored filter", async () => {
      const database = await chokePoint.createDatabase({ name: "Movies" });
      await chokePoint.createProperty({ databaseId: database.id, key: "title", name: "Title", type: "text" });
      const arrival = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Arrival" } });
      const dune = await chokePoint.createItem({ databaseId: database.id, properties: { title: "Dune" } });
      const view = await chokePoint.createView({
        databaseId: database.id,
        type: "table",
        name: "Arrivals",
        config: { filter: { type: "equals", property: "title", value: "Arrival" } },
      });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/views/${view.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { type: "equals", property: "title", value: "Dune" } }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemQueryBody;
      expect(body.items.map((i) => i.id)).toEqual([dune.id]);
      expect(body.items.map((i) => i.id)).not.toContain(arrival.id);
    });

    it("returns validation_failed sending filter/sort against a curated view", async () => {
      const view = await chokePoint.createView({ type: "list", name: "Collection", config: { membership: "manual" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/views/${view.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ filter: { type: "is_empty", property: "title" } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });

    it("paginates a curated view by position without filter/sort", async () => {
      const view = await chokePoint.createView({ type: "list", name: "Collection", config: { membership: "manual" } });
      const database = await chokePoint.createDatabase({ name: "D" });
      const itemA = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      const itemB = await chokePoint.createItem({ databaseId: database.id, properties: {} });
      await chokePoint.addViewItem({ viewId: view.id, itemId: itemA.id, actor: { type: "user" } });
      await chokePoint.addViewItem({ viewId: view.id, itemId: itemB.id, actor: { type: "user" } });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/views/${view.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: 1 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ItemQueryBody;
      expect(body.items.map((i) => i.id)).toEqual([itemA.id]);
      expect(body.nextCursor).not.toBeNull();
    });

    it("returns validation_failed for a non-positive limit", async () => {
      const database = await chokePoint.createDatabase({ name: "D" });
      const view = await chokePoint.createView({ databaseId: database.id, type: "table", name: "All rows" });
      const headers = { ...(await authHeader()), "Content-Type": "application/json" };

      const res = await fetch(`${baseUrl}/api/views/${view.id}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: -1 }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_failed");
    });
  });
});
