import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createViewTypeRegistry,
  seedSystem,
  withTransaction,
  createItemWithClient,
  upsertMcpToolRegistration,
  createUser,
  hashPassword,
  login,
} from "@semprec/data";
import { createMcpAgentPageRequestListener } from "../mcpAgentPageHandler.js";

const PASSWORD = "s3cret-password";

let pool: Pool;
let mcpServersId: string;

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

async function createMcpServerItem(name: string, active: boolean) {
  return withTransaction(pool, (client) =>
    createItemWithClient(client, { databaseId: mcpServersId, properties: { name, active } }),
  );
}

describe("createMcpAgentPageRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    const viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM databases WHERE owner_module_id = 'mcpServers'`);
    if (!rows[0]) throw new Error("mcpServers database was not seeded");
    mcpServersId = rows[0].id;

    server = createServer(createMcpAgentPageRequestListener(pool));
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
    const res = await fetch(`${baseUrl}/api/projects/${randomUUID()}/mcp-grants`);
    expect(res.status).toBe(401);
  });

  it("rejects a request with a garbage bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${randomUUID()}/mcp-grants`, {
      headers: { Authorization: "Bearer garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/not-a-real-path`, { headers: await authHeader() });
    expect(res.status).toBe(404);
  });

  it("lists an active registration, unchecked by default, for a project", async () => {
    const server1 = await createMcpServerItem("Server", true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server1.id,
      toolName: "tool",
      toolSchema: {},
    });
    const projectItemId = randomUUID();

    const res = await fetch(`${baseUrl}/api/projects/${projectItemId}/mcp-grants`, {
      headers: await authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([expect.objectContaining({ mcpToolRegistrationId: registration.id, granted: false })]);
  });

  it("round-trips a grant toggle through PATCH", async () => {
    const server1 = await createMcpServerItem("Server", true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server1.id,
      toolName: "tool",
      toolSchema: {},
    });
    const projectItemId = randomUUID();

    const patchRes = await fetch(`${baseUrl}/api/projects/${projectItemId}/mcp-grants/${registration.id}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ granted: true }),
    });
    expect(patchRes.status).toBe(200);
    const grant = (await patchRes.json()) as { granted: boolean };
    expect(grant.granted).toBe(true);

    const getRes = await fetch(`${baseUrl}/api/projects/${projectItemId}/mcp-grants`, {
      headers: await authHeader(),
    });
    const body = (await getRes.json()) as { rows: Array<{ granted: boolean }> };
    expect(body.rows[0]!.granted).toBe(true);
  });

  it("rejects a grant PATCH with a non-boolean 'granted'", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${randomUUID()}/mcp-grants/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ granted: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("maps a grant PATCH for an unknown mcpToolRegistrationId to a 404 response", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${randomUUID()}/mcp-grants/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ granted: true }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a PATCH with a malformed JSON body", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${randomUUID()}/mcp-grants/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a PATCH whose body exceeds the maximum allowed size", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${randomUUID()}/mcp-grants/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ granted: true, padding: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it("reclassifies a registration's riskClass and requiresApproval through PATCH", async () => {
    const server1 = await createMcpServerItem("Server", true);
    const registration = await upsertMcpToolRegistration(pool, {
      mcpServerItemId: server1.id,
      toolName: "tool",
      toolSchema: {},
    });

    const res = await fetch(`${baseUrl}/api/mcp-tool-registrations/${registration.id}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ riskClass: "destructive", requiresApproval: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { riskClass: string; requiresApproval: boolean };
    expect(body.riskClass).toBe("destructive");
    expect(body.requiresApproval).toBe(true);
  });

  it("maps a validation error (neither field set) to a 400 response", async () => {
    const res = await fetch(`${baseUrl}/api/mcp-tool-registrations/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("maps an unknown registration id to a 404 response", async () => {
    const res = await fetch(`${baseUrl}/api/mcp-tool-registrations/${randomUUID()}`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ riskClass: "high" }),
    });
    expect(res.status).toBe(404);
  });
});
