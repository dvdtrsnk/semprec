import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createUser, hashPassword, login } from "@semprec/data";
import type { ModuleCustomRouteDefinition } from "@semprec/module-registry";
import { mountCustomRoutes, type CustomRouteHandlerFactory } from "../customRouteMount.js";

let pool: Pool;

const PASSWORD = "s3cret-password";

async function tokenFor(email: string): Promise<string> {
  await createUser(pool, { email, passwordHash: await hashPassword(PASSWORD) });
  const result = await login(pool, { email, password: PASSWORD, platform: "ios", ip: "1.2.3.4" });
  return result.token;
}

/** A fixture handler factory echoing the extracted `:id` path parameter back as the response body. */
const echoIdHandlerFactory: CustomRouteHandlerFactory = () => async (ctx) => ({
  status: 200,
  body: { id: ctx.params.id },
});

const noParamHandlerFactory: CustomRouteHandlerFactory = () => async () => ({
  status: 200,
  body: { ok: true },
});

const DEFINITIONS: ModuleCustomRouteDefinition[] = [
  {
    moduleId: "fixture-module",
    name: "fixtureGetThing",
    method: "GET",
    path: "/api/fixture-things/:id",
    handler: echoIdHandlerFactory,
  },
  {
    moduleId: "fixture-module",
    name: "fixturePostThing",
    method: "POST",
    path: "/api/fixture-things",
    handler: noParamHandlerFactory,
  },
];

describe("custom route mount (issue #239)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    const dispatchCustomRoute = mountCustomRoutes(pool, DEFINITIONS);
    server = createServer((req, res) => {
      if (dispatchCustomRoute(req, res)) return;
      res.writeHead(404).end();
    });
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

  it("extracts a `:id` path parameter and authenticates through the shared adapter", async () => {
    const token = await tokenFor("mount-id@example.com");
    const res = await fetch(`${baseUrl}/api/fixture-things/abc-123`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc-123" });
  });

  it("matches a route with no path parameters", async () => {
    const token = await tokenFor("mount-noparam@example.com");
    const res = await fetch(`${baseUrl}/api/fixture-things`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("requires authentication before a mounted custom route's handler runs", async () => {
    const res = await fetch(`${baseUrl}/api/fixture-things/abc-123`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("falls through to the caller's own dispatch for a path matching no custom route", async () => {
    const res = await fetch(`${baseUrl}/api/not-a-custom-route`);
    expect(res.status).toBe(404);
  });

  it("does not match a route on method alone", async () => {
    const token = await tokenFor("mount-method@example.com");
    const res = await fetch(`${baseUrl}/api/fixture-things`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
