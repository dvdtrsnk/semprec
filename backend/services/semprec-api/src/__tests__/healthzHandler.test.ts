import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { upsertProcessHeartbeat } from "@semprec/data";
import { createHealthzRequestListener } from "../healthzHandler.js";

let pool: Pool;

describe("createHealthzRequestListener (issue #168)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    server = createServer(createHealthzRequestListener(pool));
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

  it("returns 200 {status: ok} when the agents heartbeat is fresh", async () => {
    await upsertProcessHeartbeat(pool, { process: "agents", pid: 1, version: "1.0.0" }, new Date());

    const res = await fetch(`${baseUrl}/healthz`, { method: "GET" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 503 when there is no agents heartbeat row at all", async () => {
    const res = await fetch(`${baseUrl}/healthz`, { method: "GET" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error" });
  });

  it("returns 503 when the agents heartbeat is stale (older than 60 seconds)", async () => {
    const staleStartedAt = new Date(Date.now() - 5 * 60_000);
    await pool.query(
      `INSERT INTO process_heartbeats (process, pid, version, started_at, beat_at)
       VALUES ('agents', 1, '1.0.0', $1, $1)`,
      [staleStartedAt],
    );

    const res = await fetch(`${baseUrl}/healthz`, { method: "GET" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "error" });
  });

  it("leaks no detail when the database check itself fails", async () => {
    const brokenPool = new Pool({ connectionString: "postgres://nobody:nowhere@127.0.0.1:1/does-not-exist" });
    const brokenServer = createServer(createHealthzRequestListener(brokenPool));
    await new Promise<void>((resolve) => brokenServer.listen(0, resolve));
    const address = brokenServer.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/healthz`, { method: "GET" });
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual({ status: "error" });
      expect(body).not.toMatch(/ECONNREFUSED|does-not-exist|nobody/i);
    } finally {
      await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
      await brokenPool.end();
    }
  });

  it("returns 404 for an unknown route", async () => {
    const res = await fetch(`${baseUrl}/healthz/whatever`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-GET method", async () => {
    const res = await fetch(`${baseUrl}/healthz`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
