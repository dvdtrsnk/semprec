import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { ConflictError, NotFoundError, createUser, hashPassword, login, type ItemRow } from "@semprec/data";
import { createAdapterRequestListener, type AdapterHandler } from "../adapterRoute.js";
import { requireJsonObjectBody, requireStringField } from "../requestValidation.js";

let pool: Pool;

const PASSWORD = "s3cret-password";

const SAMPLE_ITEM: ItemRow = {
  id: "11111111-1111-1111-1111-111111111111",
  databaseId: "22222222-2222-2222-2222-222222222222",
  properties: { title: "Hello" },
  computed: {},
  updatedAt: "2026-09-11T00:00:00.000Z",
  deletedAt: null,
};

async function tokenFor(email: string): Promise<string> {
  await createUser(pool, { email, passwordHash: await hashPassword(PASSWORD) });
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

    server = createServer(createAdapterRequestListener(pool, fixtureHandler));
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
