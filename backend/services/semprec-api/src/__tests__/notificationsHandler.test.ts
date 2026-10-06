import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase, getTenantZeroId } from "@semprec/data/testSupport";
import { createViewTypeRegistry, seedSystem, createUser, hashPassword, login } from "@semprec/data";
import { createNotificationsRequestListener } from "../notificationsHandler.js";

const PASSWORD = "s3cret-password";

let pool: Pool;

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    tenantId: getTenantZeroId(),
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

describe("createNotificationsRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());

    server = createServer(createNotificationsRequestListener(pool));
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

  describe("POST /api/notifications/:id/visit", () => {
    it("returns 400 validation_failed naming 'id' for a non-UUID notification id", async () => {
      const res = await fetch(`${baseUrl}/api/notifications/foo/visit`, {
        method: "POST",
        headers: await authHeader(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; details?: unknown };
      expect(body.code).toBe("validation_failed");
      expect(body.details).toEqual({ field: "id" });
    });

    it("returns 404 for a well-formed but unknown notification id", async () => {
      const res = await fetch(`${baseUrl}/api/notifications/${randomUUID()}/visit`, {
        method: "POST",
        headers: await authHeader(),
      });
      expect(res.status).toBe(404);
    });
  });
});
