import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createUser, hashPassword, login, type UserRow } from "@semprec/data";
import { createPushSubscriptionsRequestListener } from "../pushSubscriptionsHandler.js";

let pool: Pool;

const PASSWORD = "s3cret-password";

async function makeUser(email = "person@example.com"): Promise<UserRow> {
  return createUser(pool, { email, passwordHash: await hashPassword(PASSWORD) });
}

async function tokenFor(email: string, platform: "web" | "ios" | "macos" = "ios") {
  const result = await login(pool, { email, password: PASSWORD, platform, ip: "1.2.3.4" });
  return result.token;
}

describe("createPushSubscriptionsRequestListener (issue #150)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    server = createServer(createPushSubscriptionsRequestListener(pool));
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

  it("rejects an unauthenticated registration", async () => {
    const res = await fetch(`${baseUrl}/api/push-subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "web_push", platform: "web" }),
    });
    expect(res.status).toBe(401);
  });

  it("registers an apns subscription for an authenticated session", async () => {
    const user = await makeUser();
    const token = await tokenFor(user.email, "ios");

    const res = await fetch(`${baseUrl}/api/push-subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: "apns", platform: "ios", deviceToken: "device-1", apnsEnvironment: "sandbox" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscription: { id: string; channel: string; revokedAt: string | null } };
    expect(body.subscription.channel).toBe("apns");
    expect(body.subscription.revokedAt).toBeNull();
  });

  it("rejects an invalid channel/platform combination with a 400", async () => {
    const user = await makeUser();
    const token = await tokenFor(user.email, "ios");

    const res = await fetch(`${baseUrl}/api/push-subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: "apns", platform: "web", deviceToken: "device-1", apnsEnvironment: "sandbox" }),
    });

    expect(res.status).toBe(400);
  });

  it("revokes an owned subscription via POST /:id/revoke", async () => {
    const user = await makeUser();
    const token = await tokenFor(user.email, "ios");

    const registerRes = await fetch(`${baseUrl}/api/push-subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: "apns", platform: "ios", deviceToken: "device-1", apnsEnvironment: "sandbox" }),
    });
    const { subscription } = (await registerRes.json()) as { subscription: { id: string } };

    const revokeRes = await fetch(`${baseUrl}/api/push-subscriptions/${subscription.id}/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(revokeRes.status).toBe(200);
    expect(await revokeRes.json()).toEqual({ revoked: true });
  });

  it("rejects a JSON null body with a 400 rather than a 500", async () => {
    const user = await makeUser();
    const token = await tokenFor(user.email, "ios");

    const res = await fetch(`${baseUrl}/api/push-subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "null",
    });

    expect(res.status).toBe(400);
  });

  it("rejects an unauthenticated revocation", async () => {
    const res = await fetch(`${baseUrl}/api/push-subscriptions/00000000-0000-0000-0000-000000000000/revoke`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
