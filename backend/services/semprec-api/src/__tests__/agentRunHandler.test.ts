import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createViewTypeRegistry,
  seedSystem,
  createAgentRun,
  createUser,
  failGatewayCall,
  finishAgentRun,
  hashPassword,
  login,
  getAgentRun,
  recordTokenGatewayCall,
  reserveGatewayCall,
  settleAudioGatewayCall,
  withTransaction,
} from "@semprec/data";
import { createAgentRunRequestListener } from "../agentRunHandler.js";

const PASSWORD = "s3cret-password";

let pool: Pool;

/** Tenant zero's user, which `beforeEach` creates. */
let tenantUser: { id: string; email: string };

/**
 * Signs in tenant zero's user: a minted run's actor is the session user, and a run's actor must be
 * its own tenant's user (`agent_runs_actor_user_id_tenant_fkey`, issue #1066).
 */
async function authHeader(): Promise<{ Authorization: string }> {
  const { token } = await login(pool, {
    email: tenantUser.email,
    password: PASSWORD,
    platform: "ios",
    ip: "127.0.0.1",
  });
  return { Authorization: `Bearer ${token}` };
}

describe("createAgentRunRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    tenantUser = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
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

  it("returns 400 validation_failed naming 'id' for a non-UUID agent run id", async () => {
    const res = await fetch(`${baseUrl}/api/agent-runs/foo`, {
      headers: await authHeader(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details?: unknown };
    expect(body.code).toBe("validation_failed");
    expect(body.details).toEqual({ field: "id" });
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

  describe("usage (issue #1822)", () => {
    it("returns the cost and tokens of the run's settled calls per model", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "search the docs" });
      for (const call of [
        { inputTokens: 4000, outputTokens: 150, costUsd: 0.013 },
        { inputTokens: 2180, outputTokens: 90, costUsd: 0.008 },
      ]) {
        await recordTokenGatewayCall(pool, {
          provider: "anthropic",
          model: "claude-sonnet-5",
          agentRunId: run.id,
          ...call,
        });
      }

      const res = await fetch(`${baseUrl}/api/agent-runs/${run.id}`, { headers: await authHeader() });

      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ id: run.id, task: "search the docs", title: "search the docs" });
      expect(body).toHaveProperty("usage", {
        totalCostUsd: 0.021,
        estimated: false,
        perModel: [
          {
            provider: "anthropic",
            model: "claude-sonnet-5",
            displayName: "Claude Sonnet",
            callCount: 2,
            inputTokens: 6180,
            outputTokens: 240,
            audioSeconds: null,
            costUsd: 0.021,
          },
        ],
      });
    });

    it("returns an empty usage for a run without calls", async () => {
      const run = await createAgentRun(pool, { triggeredBy: "user", task: "no calls" });

      const res = await fetch(`${baseUrl}/api/agent-runs/${run.id}`, { headers: await authHeader() });

      expect(res.status).toBe(200);
      expect(await res.json()).toHaveProperty("usage", { totalCostUsd: 0, estimated: false, perModel: [] });
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
      const projectItemId = await createTestProjectItem(pool);
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

    // Issue #1066: a run's actor must be its own tenant's user, and a tenant has exactly one user, so
    // the session user and the `getTenantUserId` fallback can no longer differ. The test pins that
    // the session's identity is what the run records.
    it("attributes the minted run's actor_user_id to the authenticated session user (issue #220, AC11)", async () => {
      const projectItemId = await createTestProjectItem(pool);

      const res = await fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
        method: "POST",
        headers: { ...(await authHeader()), "Content-Type": "application/json" },
        body: JSON.stringify({ projectItemId, capabilities: ["core.item.read"] }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { runId: string };
      const run = await withTransaction(pool, (client) => getAgentRun(client, body.runId));
      expect(run?.actorUserId).toBe(tenantUser.id);
    });

    describe("project guard", () => {
      async function mint(projectItemId: string): Promise<Response> {
        return fetch(`${baseUrl}/api/agent-runs/mcp-credentials`, {
          method: "POST",
          headers: { ...(await authHeader()), "Content-Type": "application/json" },
          body: JSON.stringify({ projectItemId, capabilities: ["core.item.read"] }),
        });
      }

      async function mintedRowCounts(): Promise<{ runs: number; credentials: number }> {
        const { rows } = await pool.query<{ runs: string; credentials: string }>(
          `SELECT (SELECT count(*) FROM agent_runs)::text AS runs,
                  (SELECT count(*) FROM agent_run_mcp_credentials)::text AS credentials`,
        );
        return { runs: Number(rows[0]!.runs), credentials: Number(rows[0]!.credentials) };
      }

      async function expectNotFound(res: Response): Promise<void> {
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "Project not found", code: "not_found" });
        expect(await mintedRowCounts()).toEqual({ runs: 0, credentials: 0 });
      }

      it("rejects a non-UUID projectItemId as validation_failed", async () => {
        const res = await mint("not-a-uuid");

        expect(res.status).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
        expect(await mintedRowCounts()).toEqual({ runs: 0, credentials: 0 });
      });

      it("answers 404 for a random UUID and creates no run or credential", async () => {
        await expectNotFound(await mint(randomUUID()));
      });

      it("answers 404 for an item of a database other than Projects", async () => {
        const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'tasks'`);
        const item = await createChokePoint(pool).createItem({ databaseId: rows[0]!.id, properties: {} });

        await expectNotFound(await mint(item.id));
      });

      it("answers 404 for a soft-deleted Projects item", async () => {
        const projectItemId = await createTestProjectItem(pool);
        await pool.query(`UPDATE items SET deleted_at = now() WHERE id = $1`, [projectItemId]);

        await expectNotFound(await mint(projectItemId));
      });

      it("answers 201 for a live Projects item", async () => {
        const res = await mint(await createTestProjectItem(pool));

        expect(res.status).toBe(201);
        expect(await mintedRowCounts()).toEqual({ runs: 1, credentials: 1 });
      });
    });
  });
});

describe("GET /api/agent-runs/:id usage under the runtime role (issue #1822)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    await resetDatabase(adminPool);
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      runtimePool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    server = createServer(createAgentRunRequestListener(runtimePool));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await runtimePool?.end();
    await adminPool?.end();
  });

  /** A tenant with a user of the given locale, a run of that user with one settled diarization call, and the user's bearer header. */
  async function tenantWithRun(
    locale: string,
  ): Promise<{ tenant: string; runId: string; headers: { Authorization: string } }> {
    const tenant = await createTestTenant(adminPool);
    const email = `${randomUUID()}@example.test`;
    const user = await createUser(adminPool, {
      tenantId: tenant,
      email,
      locale,
      passwordHash: await hashPassword(PASSWORD),
    });
    const session = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    const runId = await runInTenant(tenant, async () => {
      const run = await createAgentRun(runtimePool, { triggeredBy: "user", task: "usage", userId: user.id });
      const diarization = await reserveGatewayCall(runtimePool, {
        provider: "deepinfra",
        model: "pyannote/speaker-diarization",
        estimatedCostUsd: 1,
        agentRunId: run.id,
      });
      await settleAudioGatewayCall(runtimePool, diarization.id, { audioSeconds: 12.5, costUsd: 0.03 });
      return run.id;
    });
    return { tenant, runId, headers: { Authorization: `Bearer ${session.token}` } };
  }

  async function read(headers: { Authorization: string }, runId: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}/api/agent-runs/${runId}`, { headers });
    return { status: res.status, body: await res.json() };
  }

  it("answers another tenant's run like an unknown id and returns the own run's usage in the session user's locale", async () => {
    const english = await tenantWithRun("en");
    const czech = await tenantWithRun("cs");
    await runInTenant(english.tenant, async () => {
      const failed = await reserveGatewayCall(runtimePool, {
        provider: "anthropic",
        model: "claude-sonnet-5",
        estimatedCostUsd: 5,
        agentRunId: english.runId,
      });
      await failGatewayCall(runtimePool, failed.id);
      await reserveGatewayCall(runtimePool, {
        provider: "anthropic",
        model: "claude-sonnet-5",
        estimatedCostUsd: 0.5,
        agentRunId: english.runId,
      });
    });

    const foreign = await read(czech.headers, english.runId);
    const unknown = await read(czech.headers, randomUUID());
    const ownEnglish = await read(english.headers, english.runId);
    const ownCzech = await read(czech.headers, czech.runId);

    expect(foreign).toEqual({ status: 404, body: { error: "Not found" } });
    expect(unknown).toEqual(foreign);
    const diarization = {
      provider: "deepinfra",
      model: "pyannote/speaker-diarization",
      callCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: 12.5,
      costUsd: 0.03,
    };
    expect(ownEnglish.status).toBe(200);
    expect(ownEnglish.body).toHaveProperty("usage", {
      totalCostUsd: 0.53,
      estimated: true,
      perModel: [
        {
          provider: "anthropic",
          model: "claude-sonnet-5",
          displayName: "Claude Sonnet",
          callCount: 1,
          inputTokens: 0,
          outputTokens: 0,
          audioSeconds: null,
          costUsd: 0.5,
        },
        { ...diarization, displayName: "Diarization" },
      ],
    });
    expect(ownCzech.status).toBe(200);
    expect(ownCzech.body).toHaveProperty("usage", {
      totalCostUsd: 0.03,
      estimated: false,
      perModel: [{ ...diarization, displayName: "Diarizace" }],
    });
  });
});

describe("GET /api/agent-runs/:id errorCode and errorSummary under the runtime role (issue #1824)", () => {
  let adminPool: Pool;
  let runtimePool: Pool;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    adminPool = getTestPool();
    await resetDatabase(adminPool);
    runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      runtimePool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    server = createServer(createAgentRunRequestListener(runtimePool));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await runtimePool?.end();
    await adminPool?.end();
  });

  /** A tenant whose user has the given locale, with the user's bearer header. */
  async function tenantUser(
    locale: string,
  ): Promise<{ tenant: string; userId: string; headers: { Authorization: string } }> {
    const tenant = await createTestTenant(adminPool);
    const email = `${randomUUID()}@example.test`;
    const user = await createUser(adminPool, {
      tenantId: tenant,
      email,
      locale,
      passwordHash: await hashPassword(PASSWORD),
    });
    const session = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { tenant, userId: user.id, headers: { Authorization: `Bearer ${session.token}` } };
  }

  function startRun(user: { tenant: string; userId: string }): Promise<string> {
    return runInTenant(user.tenant, async () => {
      const run = await createAgentRun(runtimePool, { triggeredBy: "user", task: "work", userId: user.userId });
      return run.id;
    });
  }

  async function read(headers: { Authorization: string }, runId: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}/api/agent-runs/${runId}`, { headers });
    return { status: res.status, body: await res.json() };
  }

  it("returns the code and the phrase of the reading user's locale for a failed run, and the code as its result", async () => {
    const czech = await tenantUser("cs");
    const english = await tenantUser("en");
    const czechRun = await startRun(czech);
    const englishRun = await startRun(english);
    await runInTenant(czech.tenant, () => finishAgentRun(runtimePool, czechRun, "error", "modelError"));
    await runInTenant(english.tenant, () => finishAgentRun(runtimePool, englishRun, "error", "budgetExceeded"));

    const czechAnswer = await read(czech.headers, czechRun);
    const englishAnswer = await read(english.headers, englishRun);

    expect(czechAnswer.status).toBe(200);
    expect(czechAnswer.body).toMatchObject({
      status: "error",
      result: "modelError",
      errorCode: "modelError",
      errorSummary: "Chyba AI modelu",
    });
    expect(englishAnswer.status).toBe(200);
    expect(englishAnswer.body).toMatchObject({
      status: "error",
      result: "budgetExceeded",
      errorCode: "budgetExceeded",
      errorSummary: "AI budget used up",
    });
  });

  it("applies a later locale change to a run that failed before it", async () => {
    const user = await tenantUser("cs");
    const runId = await startRun(user);
    await runInTenant(user.tenant, () => finishAgentRun(runtimePool, runId, "error", "interrupted"));

    const before = await read(user.headers, runId);
    await adminPool.query("UPDATE users SET locale = 'en' WHERE id = $1", [user.userId]);
    const after = await read(user.headers, runId);

    expect(before.body).toMatchObject({ errorCode: "interrupted", errorSummary: "Přerušeno restartem" });
    expect(after.body).toMatchObject({ errorCode: "interrupted", errorSummary: "Interrupted by a restart" });
  });

  it("returns null for both fields for a done run and for a running run, and keeps the done result", async () => {
    const user = await tenantUser("cs");
    const doneRun = await startRun(user);
    const runningRun = await startRun(user);
    await runInTenant(user.tenant, () => finishAgentRun(runtimePool, doneRun, "done", "all finished"));

    const done = await read(user.headers, doneRun);
    const running = await read(user.headers, runningRun);

    expect(done.body).toMatchObject({ status: "done", result: "all finished", errorCode: null, errorSummary: null });
    expect(running.body).toMatchObject({ status: "running", errorCode: null, errorSummary: null });
  });

  it("reads a failed row closed before the code existed as internal and still returns its legacy text", async () => {
    const user = await tenantUser("en");
    const runId = await startRun(user);
    // Raw SQL: a close before issue #1446 stored free text and no code, which the close functions no longer write.
    await adminPool.query(
      "UPDATE agent_runs SET status = 'error', result = $2, error_code = NULL, finished_at = now() WHERE id = $1",
      [runId, "legacy provider text"],
    );

    const answer = await read(user.headers, runId);

    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      status: "error",
      result: "legacy provider text",
      errorCode: "internal",
      errorSummary: "Internal error",
    });
  });
});
