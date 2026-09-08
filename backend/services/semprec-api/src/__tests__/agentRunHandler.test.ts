import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createViewTypeRegistry, seedSystem, createAgentRun } from "@semprec/data";
import { createAgentRunRequestListener } from "../agentRunHandler.js";

const AUTH_TOKEN = "test-token";

let pool: Pool;

describe("createAgentRunRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);

    server = createServer(createAgentRunRequestListener(pool, { authToken: AUTH_TOKEN }));
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

  it("rejects a request with no bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/agent-runs/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/agent-runs/${randomUUID()}`, {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/not-a-real-path`, { headers: { Authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown agent run id", async () => {
    const res = await fetch(`${baseUrl}/api/agent-runs/${randomUUID()}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-GET method", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const res = await fetch(`${baseUrl}/api/agent-runs/${run.id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it("returns an agent run's detail", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "search the docs" });

    const res = await fetch(`${baseUrl}/api/agent-runs/${run.id}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: run.id,
      task: "search the docs",
      status: "running",
      triggeredBy: "user",
    });
  });
});
