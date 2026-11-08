import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import { createUser, hashPassword } from "@semprec/data";
import { createSetupRequestListener } from "../setupHandler.js";

let pool: Pool;

const SETUP_TOKEN = "correct-setup-token";

describe("createSetupRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    server = createServer(createSetupRequestListener(pool, { setupToken: SETUP_TOKEN }));
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

  describe("POST /api/setup", () => {
    it("creates the account with the correct token against an empty users table", async () => {
      const res = await fetch(`${baseUrl}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SETUP_TOKEN}` },
        body: JSON.stringify({ email: "owner@example.com", password: "s3cret-password" }),
      });

      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ user: { email: "owner@example.com" } });
    });

    it("returns 404 for a wrong token", async () => {
      const res = await fetch(`${baseUrl}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
        body: JSON.stringify({ email: "owner@example.com", password: "s3cret-password" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 for a missing token", async () => {
      const res = await fetch(`${baseUrl}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password: "s3cret-password" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 once a user already exists, even with the correct token", async () => {
      await createUser(pool, {
        tenantId: await tenantForNextTestUser(pool),
        email: "existing@example.com",
        passwordHash: await hashPassword("whatever-password"),
      });

      const res = await fetch(`${baseUrl}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SETUP_TOKEN}` },
        body: JSON.stringify({ email: "owner@example.com", password: "s3cret-password" }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects a malformed email with 400", async () => {
      const res = await fetch(`${baseUrl}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SETUP_TOKEN}` },
        body: JSON.stringify({ email: "not-an-email", password: "s3cret-password" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a missing password with 400", async () => {
      const res = await fetch(`${baseUrl}/api/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SETUP_TOKEN}` },
        body: JSON.stringify({ email: "owner@example.com" }),
      });
      expect(res.status).toBe(400);
    });

    describe("displayName (issue #1513)", () => {
      function postSetup(extra: Record<string, unknown>): Promise<Response> {
        return fetch(`${baseUrl}/api/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SETUP_TOKEN}` },
          body: JSON.stringify({ email: "owner@example.com", password: "s3cret-password", ...extra }),
        });
      }

      async function accountCount(): Promise<number> {
        const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
        return rows[0]?.n ?? -1;
      }

      it("stores the trimmed displayName and returns it on the created user", async () => {
        const res = await postSetup({ displayName: "  David  " });

        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        expect(body).toMatchObject({ user: { displayName: "David" } });
        const { rows } = await pool.query<{ display_name: string | null }>("SELECT display_name FROM users");
        expect(rows).toEqual([{ display_name: "David" }]);
      });

      it("stores NULL when displayName is omitted", async () => {
        const res = await postSetup({});

        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        expect(body).toMatchObject({ user: { displayName: null } });
        const { rows } = await pool.query<{ display_name: string | null }>("SELECT display_name FROM users");
        expect(rows).toEqual([{ display_name: null }]);
      });

      it("refuses an 81-character displayName with 400 naming the field, and creates no account", async () => {
        const res = await postSetup({ displayName: "a".repeat(81) });

        expect(res.status).toBe(400);
        const body: unknown = await res.json();
        expect(body).toMatchObject({ code: "validation_failed", details: { field: "displayName" } });
        expect(await accountCount()).toBe(0);
      });

      it("refuses a blank displayName with 400 and creates no account", async () => {
        const res = await postSetup({ displayName: "   " });

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: "validation_failed", details: { field: "displayName" } });
        expect(await accountCount()).toBe(0);
      });

      it("refuses a non-string displayName with 400 and creates no account", async () => {
        const res = await postSetup({ displayName: 42 });

        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ code: "validation_failed", details: { field: "displayName" } });
        expect(await accountCount()).toBe(0);
      });

      it("still creates the account after a refused displayName, since the refusal wrote nothing", async () => {
        expect((await postSetup({ displayName: 42 })).status).toBe(400);

        expect((await postSetup({ displayName: "David" })).status).toBe(200);
        expect(await accountCount()).toBe(1);
      });
    });
  });

  it("returns 404 for an unknown route", async () => {
    const res = await fetch(`${baseUrl}/api/setup/whatever`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
