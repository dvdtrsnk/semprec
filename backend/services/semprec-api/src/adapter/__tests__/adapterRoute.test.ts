import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
} from "@semprec/data/testSupport";
import { currentTenantScope, runInTenant, type TenantScope } from "@semprec/shared";
import {
  ConflictError,
  NotFoundError,
  createChokePoint,
  createBlob,
  withTransaction,
  createUser,
  hashPassword,
  login,
  type ItemRow,
} from "@semprec/data";
import { createAdapterRequestListener, type AdapterHandler } from "../adapterRoute.js";
import { requireJsonObjectBody, requireStringField } from "../requestValidation.js";

function asVoid(
  listener: ReturnType<typeof createAdapterRequestListener>,
): (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void {
  return (req, res) => {
    void listener(req, res);
  };
}

let pool: Pool;

const PASSWORD = "s3cret-password";

const SAMPLE_ITEM: ItemRow = {
  id: "11111111-1111-1111-1111-111111111111",
  databaseId: "22222222-2222-2222-2222-222222222222",
  properties: { title: "Hello" },
  computed: {},
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
  deletedAt: null,
};

async function tokenFor(email: string, role?: "admin" | "member", tenantId?: string): Promise<string> {
  await createUser(pool, {
    email,
    passwordHash: await hashPassword(PASSWORD),
    role,
    tenantId: tenantId ?? (await tenantForNextTestUser(pool)),
  });
  const result = await login(pool, { email, password: PASSWORD, platform: "ios", ip: "1.2.3.4" });
  return result.token;
}

/**
 * A fixture handler standing in for a real generic-resource route (#155-158 mount those) —
 * exercises this adapter's shared auth, JSON body validation, and success/error serialization
 * without any business logic of its own. `title: "conflict"`/`"missing"` pick the two error
 * fixtures this test drives through the real HTTP round trip; anything else is a successful
 * "echo" write.
 */
const fixtureHandler: AdapterHandler = async ({ body }) => {
  const parsed = requireJsonObjectBody(body);
  const title = requireStringField(parsed, "title");
  if (title === "conflict") {
    throw new ConflictError("Item was modified since ifVersion was read", { current: SAMPLE_ITEM });
  }
  if (title === "missing") {
    throw new NotFoundError("Item not found");
  }
  return { status: 200, item: { ...SAMPLE_ITEM, properties: { title } } };
};

describe("adapter route (issue #238)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    server = createServer(asVoid(createAdapterRequestListener(pool, fixtureHandler)));
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

  it("returns the actual completion through authentication, body, delayed handler and errors", async () => {
    let entered = () => {};
    let release = () => {};
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completions: Promise<void>[] = [];
    const requests: Promise<Response>[] = [];
    const actual = createAdapterRequestListener(pool, async (ctx) => {
      if (ctx.req.url === "/delayed") {
        entered();
        await gate;
      }
      return fixtureHandler(ctx);
    });
    const observedServer = createServer((req, res) => {
      const completion = actual(req, res);
      completions.push(completion);
      void completion.catch(() => {});
    });
    await new Promise<void>((resolve) => observedServer.listen(0, "127.0.0.1", resolve));
    const address = observedServer.address();
    if (!address || typeof address === "string") throw new Error("Missing observed server address");
    const url = `http://127.0.0.1:${address.port}`;
    const request = (path: string, body: string, token?: string) => {
      const operation = fetch(url + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body,
        signal: AbortSignal.timeout(5000),
      });
      requests.push(operation);
      void operation.catch(() => {});
      return operation;
    };
    let failure: { error: unknown } | undefined;
    try {
      expect((await request("/", "{}", undefined)).status).toBe(401);
      await completions[0];
      const token = await tokenFor("completion@example.com");
      expect((await request("/", "{", token)).status).toBe(400);
      await completions[1];
      expect((await request("/", JSON.stringify({ title: "missing" }), token)).status).toBe(404);
      await completions[2];
      const pending = request("/delayed", JSON.stringify({ title: "ok" }), token);
      const settled = pending.then(
        () => {},
        () => {},
      );
      try {
        await Promise.race([
          admitted,
          pending.then(() => {
            throw new Error("Request finished before admission");
          }),
        ]);
        const completion = completions[3];
        if (!completion) throw new Error("Missing adapter completion");
        let completed = false;
        void completion.then(
          () => {
            completed = true;
          },
          () => {
            completed = true;
          },
        );
        await Promise.resolve();
        expect(completed).toBe(false);
        release();
        expect((await pending).status).toBe(200);
        await completion;
        expect(completed).toBe(true);
      } finally {
        release();
        await settled;
      }
    } catch (error) {
      failure = { error };
    } finally {
      release();
      observedServer.closeAllConnections();
      const results = await Promise.allSettled([...completions, ...requests]);
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      try {
        await new Promise<void>((resolve, reject) =>
          observedServer.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        const all = failure ? [failure.error, ...errors] : errors;
        failure = { error: new AggregateError(all, "Adapter control and cleanup failed", { cause: all[0] }) };
      }
    }
    if (failure) throw failure.error;
  });

  it("retains a delayed real fallback failure after an earlier observation failure", async () => {
    const bodyError = new Error("adapter observation failed");
    const firstWrite = new Error("initial write failed");
    const fallbackError = new Error("fallback write failed");
    let entered = () => {};
    let release = () => {};
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received: Promise<void> | undefined;
    const actual = createAdapterRequestListener(pool, async (ctx) => {
      entered();
      await gate;
      return fixtureHandler(ctx);
    });
    const token = await tokenFor("delayed-fallback@example.com");
    const observedServer = createServer((req, res) => {
      let writes = 0;
      vi.spyOn(res, "writeHead").mockImplementation(() => {
        throw writes++ === 0 ? firstWrite : fallbackError;
      });
      received = actual(req, res);
      void received.catch(() => {
        res.destroy();
      });
    });
    await new Promise<void>((resolve) => observedServer.listen(0, "127.0.0.1", resolve));
    const address = observedServer.address();
    if (!address || typeof address === "string") throw new Error("Missing observed server address");
    const request = fetch(`http://127.0.0.1:${address.port}/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ok" }),
      signal: AbortSignal.timeout(5000),
    });
    const clientResult = request.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let failure: { error: unknown } | undefined;
    let adapterResult: { value: void } | { error: unknown } | undefined;
    try {
      await Promise.race([
        admitted,
        clientResult.then(() => {
          throw new Error("Client settled before handler admission");
        }),
      ]);
      throw bodyError;
    } catch (error) {
      failure = { error };
    } finally {
      release();
      if (received)
        adapterResult = await received.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      observedServer.closeAllConnections();
      const client = await clientResult;
      const errors: unknown[] = [];
      if (adapterResult && "error" in adapterResult) errors.push(adapterResult.error);
      if ("error" in client) errors.push(client.error);
      try {
        await new Promise<void>((resolve, reject) =>
          observedServer.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        const all = failure ? [failure.error, ...errors] : errors;
        failure = { error: new AggregateError(all, "Adapter control and cleanup failed", { cause: all[0] }) };
      }
    }
    const client = await clientResult;
    expect(adapterResult).toHaveProperty("error");
    if (!adapterResult || !("error" in adapterResult)) throw new Error("Expected adapter failure");
    expect(adapterResult.error).toBe(fallbackError);
    expect("error" in client).toBe(true);
    if (!("error" in client)) throw new Error("Expected client failure");
    expect(client.error).toMatchObject({ name: "TypeError", message: "fetch failed" });
    expect(failure?.error).toBeInstanceOf(AggregateError);
    if (!(failure?.error instanceof AggregateError)) throw new Error("Expected combined adapter failure");
    expect(failure.error.cause).toBe(bodyError);
    expect(failure.error.errors).toHaveLength(3);
    expect(failure.error.errors[0]).toBe(bodyError);
    expect(failure.error.errors[1]).toBe(fallbackError);
    expect(failure.error.errors[2]).toBe(client.error);
  });

  it("returns the original rejection if the fallback response itself throws", async () => {
    const fallback = new Error("fallback write failed");
    const first = new Error("initial write failed");
    let resolveCompletion = (_error: unknown) => {};
    const completion = new Promise<unknown>((resolve) => {
      resolveCompletion = resolve;
    });
    const actual = createAdapterRequestListener(pool, fixtureHandler);
    const failingServer = createServer((req, res) => {
      let calls = 0;
      vi.spyOn(res, "writeHead").mockImplementation(() => {
        throw calls++ === 0 ? first : fallback;
      });
      const work = actual(req, res);
      void work.then(
        () => resolveCompletion(new Error("Unexpected success")),
        (error: unknown) => resolveCompletion(error),
      );
    });
    await new Promise<void>((resolve) => failingServer.listen(0, "127.0.0.1", resolve));
    const address = failingServer.address();
    if (!address || typeof address === "string") throw new Error("Missing failing server address");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const request = fetch(`http://127.0.0.1:${address.port}`, { signal: controller.signal });
    const settled = request.then(
      () => {},
      () => {},
    );
    try {
      const error = await Promise.race([
        completion,
        request.then(() => {
          throw new Error("Unexpected HTTP response");
        }),
      ]);
      expect(error).toBe(fallback);
    } finally {
      clearTimeout(timer);
      controller.abort();
      failingServer.closeAllConnections();
      await settled;
      await new Promise<void>((resolve) => failingServer.close(() => resolve()));
      vi.restoreAllMocks();
    }
  });

  it("rejects an unauthenticated request before the handler runs", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "should never run" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("runs the handler inside the caller's tenant scope, and never runs it without credentials", async () => {
    const scopes: Array<TenantScope | undefined> = [];
    const scopedServer = createServer(
      asVoid(
        createAdapterRequestListener(pool, async () => {
          scopes.push(currentTenantScope());
          return { status: 200, body: { ok: true } };
        }),
      ),
    );
    await new Promise<void>((resolve) => scopedServer.listen(0, resolve));
    const address = scopedServer.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const anonymous = await fetch(url, { method: "POST", body: "{}" });
      expect(anonymous.status).toBe(401);
      expect(scopes).toEqual([]);

      const token = await tokenFor("scoped@example.com");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect(scopes).toEqual([{ kind: "tenant", tenantId: getTenantZeroId() }]);
    } finally {
      await new Promise<void>((resolve) => scopedServer.close(() => resolve()));
    }
  });

  it("runs an admin route in system scope that sees no tenant rows, and refuses a member before the handler", async () => {
    const tenantA = await createTestTenant(pool);
    const tenantB = await createTestTenant(pool);
    for (const tenantId of [tenantA, tenantB]) {
      await runInTenant(tenantId, async () => {
        const db = await createChokePoint(pool).createDatabase({ name: `Admin scope ${tenantId}` });
        await createChokePoint(pool).createItem({ databaseId: db.id, properties: {} });
      });
    }
    // The handler's query runs on a runtime-role pool: the superuser pool bypasses row-level security.
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    const scopes: Array<TenantScope | undefined> = [];
    const counts: string[] = [];
    const adminServer = createServer(
      asVoid(
        createAdapterRequestListener(
          pool,
          async () => {
            scopes.push(currentTenantScope());
            const { rows } = await runtimePool.query<{ count: string }>("SELECT count(*)::text AS count FROM items");
            counts.push(rows[0]?.count ?? "missing");
            return { status: 200, body: { ok: true } };
          },
          { admin: true },
        ),
      ),
    );
    await new Promise<void>((resolve) => adminServer.listen(0, resolve));
    const address = adminServer.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    const url = `http://127.0.0.1:${address.port}`;
    const call = (token: string) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
    try {
      const member = await call(await tokenFor("admin-gate-member@example.com", "member", tenantA));
      expect(member.status).toBe(403);
      expect(await member.json()).toEqual({ error: { code: "admin_required" } });
      expect(scopes).toEqual([]);

      const admin = await call(await tokenFor("admin-gate-admin@example.com", "admin", tenantB));
      expect(admin.status).toBe(200);
      expect(scopes).toEqual([{ kind: "system", reason: "adminRoute" }]);
      expect(counts).toEqual(["0"]);
    } finally {
      await new Promise<void>((resolve) => adminServer.close(() => resolve()));
      await runtimePool.end();
    }
  });

  it("answers an unexpected handler error with the generic 500", async () => {
    const failing = createServer(
      asVoid(
        createAdapterRequestListener(pool, async () => {
          throw new Error("boom");
        }),
      ),
    );
    await new Promise<void>((resolve) => failing.listen(0, resolve));
    const address = failing.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    try {
      const token = await tokenFor("failing@example.com");
      const res = await fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "internal_error" } });
    } finally {
      await new Promise<void>((resolve) => failing.close(() => resolve()));
    }
  });

  it("returns the full item envelope on a successful write, never an empty 204", async () => {
    const token = await tokenFor("writer@example.com");
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "Hello" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ItemRow;
    expect(body).toEqual({ ...SAMPLE_ITEM, properties: { title: "Hello" } });
  });

  it("adds typed results alongside the unchanged flat item envelope", async () => {
    const token = await tokenFor("result@example.com");
    const results = [
      {
        ref: "primary",
        itemId: SAMPLE_ITEM.id,
        databaseKey: null,
        label: "Hello",
        role: "primary" as const,
        date: null,
        linkLabels: [],
        followUp: null,
        updatedAt: SAMPLE_ITEM.updatedAt,
        blockIds: [],
      },
    ];
    const resultServer = createServer(
      asVoid(createAdapterRequestListener(pool, async () => ({ status: 200, item: SAMPLE_ITEM, results }))),
    );
    await new Promise<void>((resolve) => resultServer.listen(0, resolve));
    const failures: unknown[] = [];
    try {
      const address = resultServer.address();
      if (!address || typeof address === "string") throw new Error("Expected bound TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toEqual({ ...SAMPLE_ITEM, results });
    } catch (error) {
      failures.push(error);
    }
    try {
      await new Promise<void>((resolve, reject) => resultServer.close((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Adapter test and settlement failed");
  });

  it("keeps blob metadata identical when typed results are added", async () => {
    const token = await tokenFor("result-blob@example.com");
    const item = await runInTenant(getTenantZeroId(), async () => {
      const chokePoint = createChokePoint(pool);
      const database = await chokePoint.createDatabase({ name: "Blob result" });
      await chokePoint.createProperty({ databaseId: database.id, key: "file", name: "File", type: "file" });
      const blob = await withTransaction(pool, (client) =>
        createBlob(client, {
          mimeType: "application/pdf",
          byteSize: 12,
          storageKey: `${getTenantZeroId()}/files/12345678-1234-1234-1234-123456789012-report.pdf`,
        }),
      );
      return chokePoint.createItem({ databaseId: database.id, properties: { file: { blobId: blob.id } } });
    });
    const results = [
      {
        ref: "primary",
        itemId: item.id,
        databaseKey: null,
        label: item.id,
        role: "primary" as const,
        date: null,
        linkLabels: [],
        followUp: null,
        updatedAt: item.updatedAt,
        blockIds: [],
      },
    ];
    const resultServer = createServer(
      asVoid(
        createAdapterRequestListener(pool, async ({ req }) =>
          req.url === "/result" ? { status: 200, item, results } : { status: 200, item },
        ),
      ),
    );
    await new Promise<void>((resolve) => resultServer.listen(0, resolve));
    const failures: unknown[] = [];
    try {
      const address = resultServer.address();
      if (!address || typeof address === "string") throw new Error("Expected bound TCP address");
      const base = `http://127.0.0.1:${address.port}`;
      const headers = { Authorization: `Bearer ${token}` };
      const normal: unknown = await (await fetch(base, { headers })).json();
      const extended: unknown = await (await fetch(`${base}/result`, { headers })).json();
      expect(normal).toMatchObject({
        id: item.id,
        properties: item.properties,
        blobs: { file: { byteSize: 12, mimeType: "application/pdf" } },
      });
      expect(extended).toEqual({ ...(typeof normal === "object" && normal !== null ? normal : {}), results });
    } catch (error) {
      failures.push(error);
    }
    try {
      await new Promise<void>((resolve, reject) => resultServer.close((error) => (error ? reject(error) : resolve())));
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Adapter test and settlement failed");
  });

  it("rejects an invalid body with validation_failed", async () => {
    const token = await tokenFor("validator@example.com");
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: { field?: string } } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details?.field).toBe("title");
  });

  it("maps a version_conflict onto 409 with details.currentItem", async () => {
    const token = await tokenFor("conflicter@example.com");
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "conflict" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: { currentItem: ItemRow } } };
    expect(body.error.code).toBe("version_conflict");
    expect(body.error.details.currentItem).toEqual(SAMPLE_ITEM);
  });

  it("maps not_found onto 404", async () => {
    const token = await tokenFor("finder@example.com");
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: "missing" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("rejects a body over the 1 MiB cap with payload_too_large", async () => {
    const token = await tokenFor("uploader@example.com");
    const oversized = JSON.stringify({ title: "x".repeat(1024 * 1024 + 1) });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: oversized,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });
});
