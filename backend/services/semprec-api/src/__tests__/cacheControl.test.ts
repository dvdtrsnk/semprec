import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
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
import { ROUTE_MATRIX } from "../routeMatrix.js";

const PASSWORD = "s3cret-password";
const NO_STORE = "no-store";

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

let pool: Pool;
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
 * Issue #1072: every HTTP response this service writes carries `Cache-Control: no-store`, because
 * bodies hold one tenant's content. The unauthenticated sweep covers every `surface: "api"` route in
 * `ROUTE_MATRIX`, so a route added later is checked without a new test; the blob and webhook cases
 * cover the branches that write their own response heads instead of going through `sendJson`.
 */
describe("Cache-Control on every API response (issue #1072)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());

    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "cache-control-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-${randomUUID()}`)),
      maxFileSizeBytes: 1024,
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

  for (const route of ROUTE_MATRIX.filter((r) => r.surface === "api")) {
    it(`answers ${route.name} (${route.method} ${route.path}) without credentials with no-store`, async () => {
      const res = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: route.method === "GET" ? undefined : { "Content-Type": "application/json" },
        body: route.method === "GET" ? undefined : JSON.stringify({}),
      });
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      await res.arrayBuffer();
    });
  }

  describe("GET /api/blobs/:id", () => {
    async function uploadBlob(): Promise<string> {
      const res = await fetch(`${baseUrl}/api/files`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "text/plain", "X-Filename": "hello.txt" },
        body: "hello world",
        duplex: "half",
      });
      expect(res.status).toBe(201);
      const item = (await res.json()) as { properties: { file: { blobId: string } } };
      return item.properties.file.blobId;
    }

    it("answers a full download (200) with no-store", async () => {
      const blobId = await uploadBlob();
      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: await authHeader() });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      await res.arrayBuffer();
    });

    it("answers a range download (206) with no-store", async () => {
      const blobId = await uploadBlob();
      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, {
        headers: { ...(await authHeader()), Range: "bytes=0-0" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      await res.arrayBuffer();
    });

    it("answers a matching If-None-Match (304) with no-store and the ETag", async () => {
      const blobId = await uploadBlob();
      const first = await fetch(`${baseUrl}/api/blobs/${blobId}`, { headers: await authHeader() });
      const etag = first.headers.get("etag");
      await first.arrayBuffer();
      expect(etag).toBeTruthy();

      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, {
        headers: { ...(await authHeader()), "If-None-Match": etag! },
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      expect(res.headers.get("etag")).toBe(etag);
    });

    it("answers an unsatisfiable range (416) with no-store", async () => {
      const blobId = await uploadBlob();
      const res = await fetch(`${baseUrl}/api/blobs/${blobId}`, {
        headers: { ...(await authHeader()), Range: "bytes=999999-" },
      });
      expect(res.status).toBe(416);
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      await res.arrayBuffer();
    });

    it("answers an unknown id (404) with no-store", async () => {
      await uploadBlob();
      const res = await fetch(`${baseUrl}/api/blobs/${randomUUID()}`, { headers: await authHeader() });
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      await res.arrayBuffer();
    });
  });

  describe("POST /api/mail/graph/webhook", () => {
    it("answers a validation token (200) with no-store", async () => {
      const res = await fetch(`${baseUrl}/api/mail/graph/webhook?validationToken=abc`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
      expect(await res.text()).toBe("abc");
    });

    it("answers a notification batch (202) with no-store", async () => {
      const res = await fetch(`${baseUrl}/api/mail/graph/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: [] }),
      });
      expect(res.status).toBe(202);
      expect(res.headers.get("cache-control")).toBe(NO_STORE);
    });
  });
});
