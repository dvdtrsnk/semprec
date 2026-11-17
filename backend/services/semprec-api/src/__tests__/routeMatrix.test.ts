import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { loadFullModuleRegistry, LocalFsBlobStorageWriter, type PasswordResetMailer } from "@semprec/data";
import { createDispatcher } from "../app.js";
import { ROUTE_MATRIX } from "../routeMatrix.js";

let pool: Pool;

const SETUP_TOKEN = "route-matrix-setup-token";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

const moduleRegistry = await loadFullModuleRegistry();

/**
 * Every route this service answers is listed in `routeMatrix.ts`. Each `surface: "api"` entry is driven against the
 * real dispatcher with no credentials, so a protected route that skips `authenticateRequest` fails with a non-401.
 * A `public` route needs a `publicReason`; `surface: "view"` entries are client-only and skip the fetch.
 */
describe("route matrix (issue #143)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: SETUP_TOKEN,
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

  it("documents a reason for every route marked public", () => {
    for (const route of ROUTE_MATRIX) {
      if (route.public) expect(route.publicReason, `${route.name} is public but has no publicReason`).toBeTruthy();
    }
  });

  for (const route of ROUTE_MATRIX.filter((r) => r.surface === "api")) {
    it(`${route.public ? "leaves public" : "rejects unauthenticated access to"} ${route.name} (${route.method} ${route.path})`, async () => {
      const res = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: route.method === "GET" ? undefined : { "Content-Type": "application/json" },
        body: route.method === "GET" ? undefined : JSON.stringify({}),
      });

      if (route.public) {
        expect(res.status, `expected ${route.name} to stay reachable without a session`).not.toBe(401);
      } else {
        expect(res.status, `expected ${route.name} to reject an unauthenticated request`).toBe(401);
      }
    });
  }

  it("still rejects an unauthenticated request bearing a garbage session token", async () => {
    for (const route of ROUTE_MATRIX.filter((r) => r.surface === "api" && !r.public)) {
      const res = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer not-a-real-session-token",
        },
        body: route.method === "GET" ? undefined : JSON.stringify({}),
      });
      expect(res.status, `expected ${route.name} to reject a garbage bearer token`).toBe(401);
    }
  });
});
