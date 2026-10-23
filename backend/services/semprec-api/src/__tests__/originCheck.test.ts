import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  type ChokePoint,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { SESSION_COOKIE_NAME } from "../authHandler.js";
import { logger } from "../logger.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
let chokePoint: ChokePoint;
const moduleRegistry = await loadFullModuleRegistry();

interface ErrorBody {
  error: { code: string };
}

describe("same-origin check on unsafe requests (issue #1044)", () => {
  let server: Server;
  let baseUrl: string;
  let cookie: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);

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

    const user = await createUser(pool, {
      tenantId: await tenantForNextTestUser(pool),
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`));
    if (!match) throw new Error(`expected a ${SESSION_COOKIE_NAME} cookie`);
    cookie = `${SESSION_COOKIE_NAME}=${match[1]}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  async function countItems(databaseId: string): Promise<number> {
    // Test-only read through the superuser pool, to prove a refused write left no row behind.
    const res = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
      databaseId,
    ]);
    return res.rows[0]?.n ?? -1;
  }

  const FOREIGN = "https://evil.example";

  describe("refused foreign Origin", () => {
    it("refuses a POST that would create an item, with 403 and no row written", async () => {
      const db = await makeMoviesDb();
      const res = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: FOREIGN },
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()) as ErrorBody).toEqual({ error: { code: "origin_not_allowed" } });
      expect(await countItems(db.id)).toBe(0);
    });

    it("refuses PATCH, DELETE and logout from a foreign Origin, leaving the item and session intact", async () => {
      const db = await makeMoviesDb();
      const created = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(created.status).toBe(201);
      const item = (await created.json()) as { id: string; version: number };

      const patch = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "PATCH",
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: FOREIGN },
        body: JSON.stringify({ ifVersion: item.version, properties: { title: "Hijacked" } }),
      });
      expect(patch.status).toBe(403);

      const del = await fetch(`${baseUrl}/api/items/${item.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: FOREIGN },
      });
      expect(del.status).toBe(403);

      const logout = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: FOREIGN },
      });
      expect(logout.status).toBe(403);

      const stillThere = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie } });
      expect(stillThere.status).toBe(200);
      expect(await countItems(db.id)).toBe(1);
    });

    it("logs exactly one origin_not_allowed warning with method and path, and no origin or header value", async () => {
      const db = await makeMoviesDb();
      const warn = vi.spyOn(logger, "warn");
      await fetch(`${baseUrl}/api/databases/${db.id}/items?secret=abc`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: FOREIGN },
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        { method: "POST", path: `/api/databases/${db.id}/items` },
        "origin_not_allowed",
      );
      const logged = JSON.stringify(warn.mock.calls[0]);
      expect(logged).not.toContain(FOREIGN);
      expect(logged).not.toContain("secret=abc");
      expect(logged).not.toContain(cookie);
    });
  });

  describe("allowed requests", () => {
    it("accepts a POST whose Origin matches Host", async () => {
      const db = await makeMoviesDb();
      const res = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(res.status).toBe(201);
      expect(await countItems(db.id)).toBe(1);
    });

    it("accepts a POST with no Origin header, as a non-browser client sends it", async () => {
      const db = await makeMoviesDb();
      const res = await fetch(`${baseUrl}/api/databases/${db.id}/items`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ properties: { title: "Arrival" } }),
      });
      expect(res.status).toBe(201);
    });

    it("does not refuse a GET carrying a foreign Origin", async () => {
      const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Cookie: cookie, Origin: FOREIGN } });
      expect(res.status).toBe(200);
    });
  });
});
