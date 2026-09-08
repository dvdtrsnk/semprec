import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
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
      const body = (await res.json()) as { user: { email: string } };
      expect(body.user.email).toBe("owner@example.com");
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
      await createUser(pool, { email: "existing@example.com", passwordHash: await hashPassword("whatever-password") });

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
  });

  it("returns 404 for an unknown route", async () => {
    const res = await fetch(`${baseUrl}/api/setup/whatever`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
