import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { loadFullModuleRegistry, LocalFsBlobStorageWriter, type PasswordResetMailer } from "@semprec/data";

const withTraceContextSpy = vi.fn();

vi.mock("@semprec/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/shared")>();
  return {
    ...actual,
    withTraceContext: ((bindings, fn) => {
      withTraceContextSpy(bindings);
      return actual.withTraceContext(bindings, fn);
    }) satisfies typeof actual.withTraceContext,
  };
});

const { createDispatcher } = await import("../app.js");

let pool: Pool;

const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

const moduleRegistry = await loadFullModuleRegistry();

/**
 * Every request `dispatch` handles runs in its own fresh trace context, never inheriting ambient worker state, and
 * concurrent requests never observe each other's trace id.
 */
describe("HTTP entry point trace context (issue #167)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    withTraceContextSpy.mockClear();

    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "dispatch-trace-setup-token",
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

  it("wraps every request in its own fresh (empty-bindings) trace context", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.test", password: "wrong", platform: "web" }),
    });

    expect(res.status).toBe(401);
    expect(withTraceContextSpy).toHaveBeenCalledTimes(1);
    expect(withTraceContextSpy).toHaveBeenCalledWith({});
  });

  it("wraps two concurrent requests in independent trace contexts", async () => {
    const post = () =>
      fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.test", password: "wrong", platform: "web" }),
      });

    const [resA, resB] = await Promise.all([post(), post()]);
    expect(resA.status).toBe(401);
    expect(resB.status).toBe(401);

    // Empty bindings per call mint distinct trace ids (see `traceContext.unit.test.ts`).
    expect(withTraceContextSpy).toHaveBeenCalledTimes(2);
    expect(withTraceContextSpy).toHaveBeenNthCalledWith(1, {});
    expect(withTraceContextSpy).toHaveBeenNthCalledWith(2, {});
  });
});
