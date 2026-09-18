import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createViewTypeRegistry,
  seedSystem,
  createAgentRun,
  createUser,
  hashPassword,
  login,
  getAgentRun,
  withTransaction,
} from "@semprec/data";
import { createAgentRunRequestListener } from "../agentRunHandler.js";

const PASSWORD = "s3cret-password";

let pool: Pool;

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

describe("createAgentRunRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await createUser(pool, { email: `${randomUUID()}@example.com`, passwordHash: await hashPassword(PASSWORD) });
    await seedSystem(pool, viewTypeRegistry);

    server = createServer(createAgentRunRequestListener(pool));
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

  it("rejects a request with no credentials", async () => {
    const res = await fetch(`${baseUrl}/api/agent-runs/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("rejects a request with a garbage bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/agent-runs/${randomUUID()}`, {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/not-a-real-path`, { headers: await authHeader() });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown agent run id", async () => {
    const res = await fetch(`${baseUrl}/api/agent-runs/${randomUUID()}`, {
      headers: await authHeader(),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-GET method", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "test" });
    const res = await fetch(`${baseUrl}/api/agent-runs/${run.id}`, {
      method: "POST",
      headers: await authHeader(),
    });
    expect(res.status).toBe(404);
  });

  it("returns an agent run's detail", async () => {
    const run = await createAgentRun(pool, { triggeredBy: "user", task: "search the docs" });

    const res = await fetch(`${baseUrl}/api/agent-runs/${run.id}`, {
      headers: await authHeader(),
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

  describe("POST /api/agent-runs/mcp-credentials (issue #220, AC34/44/47)", () => {
    it("rejects an unauthenticated mint request", async () => {
      const res = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectItemId: randomUUID(), capabilities: ["core.item.write"] }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects a non-POST method", async () => {
      const res = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
        headers: await authHeader(),
      });
      expect(res.status).toBe(404);
    });

    it("rejects a JSON body that is not an object", async () => {
      const res = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify(null),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a missing projectItemId", async () => {
      const res = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ capabilities: ["core.item.write"] }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects an empty capabilities array", async () => {
      const res = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ projectItemId: randomUUID(), capabilities: [] }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects an unknown capability id", async () => {
      const res = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ projectItemId: randomUUID(), capabilities: ["not.a.real.capability"] }),
      });
      expect(res.status).toBe(400);
    });

    it("mints a restricted run credential for the given project item and capabilities", async () => {
      const projectItemId = randomUUID();
      const res = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ projectItemId, capabilities: ["core.item.read", "core.item.write"], task: "test task" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        runId: string;
        agentProjectItemId: string;
        token: string;
        capabilities: string[];
        expiresAt: string;
      };
      expect(body.agentProjectItemId).toBe(projectItemId);
      expect(body.capabilities.sort()).toEqual(["core.item.read", "core.item.write"]);
      expect(typeof body.token).toBe("string");
      expect(body.token.length).toBeGreaterThan(0);

      const run = await withTransaction(pool, (client) => getAgentRun(client, body.runId));
      expect(run).toMatchObject({ id: body.runId, projectItemId, triggeredBy: "mcp", status: "running" });
    });

    it("attributes the minted run's actor_user_id to the authenticated session user, not the earliest-created account (issue #220, AC11)", async () => {
      // `beforeEach` already created an earlier, unrelated account — `getEarliestUserId`'s
      // fallback would resolve to that one, not to the session below, if the session's own
      // identity weren't threaded into `mintMcpRunCredential`.
      const sessionUser = await createUser(pool, {
        email: `${randomUUID()}@example.com`,
        passwordHash: await hashPassword(PASSWORD),
      });
      const { token } = await login(pool, {
        email: sessionUser.email,
        password: PASSWORD,
        platform: "ios",
        ip: "127.0.0.1",
      });
      const projectItemId = randomUUID();

      const res = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ projectItemId, capabilities: ["core.item.read"] }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { runId: string };
      const run = await withTransaction(pool, (client) => getAgentRun(client, body.runId));
      expect(run?.actorUserId).toBe(sessionUser.id);
    });
  });
});
