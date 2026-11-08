import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  CORE_AGENT_RUN_ACTION_ID,
  createHeartbeat,
  createUser,
  hashPassword,
  login,
  mintMcpRunCredential,
  resolveModuleAgentToolsForRun,
  withTransaction,
} from "@semprec/data";
import { createMcpRequestListener } from "../mcpHandler.js";

let admin: Pool;
let pool: Pool;
let server: Server;
let url: string;
const registry = new ModuleRegistry(() => new Set(["schemaCore", "ownedTools", "mcpFixture"]));
const metadata = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}

describe("restricted MCP module tools", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    await registry.loadModule(
      new URL("../../../../../packages/data/src/chokePoint/schemaCoreModuleManifest.js", import.meta.url).href,
    );
    await registry.loadModule(
      new URL(
        "../../../../../packages/module-registry/src/__tests__/fixtures/ownedAgentToolsModule.js",
        import.meta.url,
      ).href,
    );
    await registry.loadModule(new URL("./moduleToolFixture.js", import.meta.url).href);
    server = createServer(
      await createMcpRequestListener(
        pool,
        createGenericOperationGateway(pool, metadata),
        new Set(CAPABILITY_IDS),
        registry,
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    url = `http://127.0.0.1:${address.port}/mcp`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await admin?.end();
  });
  it("rejects collisions even when the active declaration is gated", async () => {
    const collision = new ModuleRegistry(() => new Set(["collisionFixture"]));
    await collision.loadModule(new URL("./collisionFixture.js", import.meta.url).href);
    await expect(
      createMcpRequestListener(pool, createGenericOperationGateway(pool, metadata), new Set(), collision),
    ).rejects.toThrow(/collides/);
  });
  it("lists and invokes only the real run's admitted tools within its tenant and project", async () => {
    const tenantA = await createTestTenant(admin);
    const tenantB = await createTestTenant(admin);
    async function setup(tenant: string) {
      const user = await createUser(admin, {
        tenantId: tenant,
        email: `${randomUUID()}@example.test`,
        passwordHash: await hashPassword("mcp-test-password"),
      });
      return runInTenant(tenant, async () => {
        const projectId = await createTestProjectItem(pool);
        const heartbeat = await withTransaction(pool, (client) =>
          createHeartbeat(client, {
            projectItemId: projectId,
            name: `Own ${tenant}`,
            rule: { kind: "interval", minutes: 5 },
            actionId: CORE_AGENT_RUN_ACTION_ID,
            actionConfig: { task: "work" },
          }),
        );
        const credential = await withTransaction(pool, (client) =>
          mintMcpRunCredential(client, { projectItemId: projectId, capabilities: ["core.item.read"], userId: user.id }),
        );
        return { projectId, heartbeat, credential, user };
      });
    }
    const a = await setup(tenantA);
    const b = await setup(tenantB);
    const narrowed = await runInTenant(tenantA, () =>
      withTransaction(pool, (client) =>
        mintMcpRunCredential(client, {
          projectItemId: a.projectId,
          capabilities: ["core.item.write"],
          userId: a.user.id,
        }),
      ),
    );
    async function rpc(token: string | null, method: string, params?: unknown, endpoint = url) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return { status: response.status, body: record(await response.json()) };
    }
    expect((await rpc(null, "tools/list")).status).toBe(401);
    const human = await login(admin, {
      email: a.user.email,
      password: "mcp-test-password",
      platform: "ios",
      ip: "127.0.0.1",
    });
    const humanList = record((await rpc(human.token, "tools/list")).body.result);
    if (!Array.isArray(humanList.tools)) throw new Error("Missing human tools");
    expect(humanList.tools.map((entry: unknown) => record(entry).name)).not.toContain("semprec.heartbeat.list");
    expect(
      record((await rpc(human.token, "tools/call", { name: "semprec.heartbeat.list", arguments: {} })).body.error).code,
    ).toBe(-32601);
    const limitedServer = createServer(
      await createMcpRequestListener(pool, createGenericOperationGateway(pool, metadata), new Set(), registry),
    );
    await new Promise<void>((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = limitedServer.address();
      if (!address || typeof address === "string") throw new Error("Missing limited server address");
      const limited = record(
        (await rpc(a.credential.token, "tools/list", undefined, `http://127.0.0.1:${address.port}/mcp`)).body.result,
      );
      if (!Array.isArray(limited.tools)) throw new Error("Missing process-limited tools");
      const limitedNames = limited.tools.map((entry: unknown) => record(entry).name);
      expect(limitedNames).not.toContain("semprec.fixture.core");
      expect(limitedNames).toContain("semprec.heartbeat.list");
    } finally {
      await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
    }
    const list = record((await rpc(a.credential.token, "tools/list")).body.result);
    if (!Array.isArray(list.tools)) throw new Error("Missing tools");
    const names = list.tools.map((tool: unknown) => record(tool).name);
    expect(names).toContain("semprec.heartbeat.list");
    expect(names).not.toContain("semprec.owned.inspect");
    expect(names).not.toContain("semprec.owned.gated");
    expect(names).toContain("semprec.item.get");
    expect(names).toContain("semprec.fixture.core");
    expect(names).not.toContain("semprec.fixture.gated");
    expect(names).not.toContain("semprec.item.create");
    const narrowList = record((await rpc(narrowed.token, "tools/list")).body.result);
    if (!Array.isArray(narrowList.tools)) throw new Error("Missing narrowed tools");
    expect(narrowList.tools.map((entry: unknown) => record(entry).name)).not.toContain("semprec.fixture.core");
    expect(
      record((await rpc(narrowed.token, "tools/call", { name: "semprec.fixture.core", arguments: {} })).body.error)
        .code,
    ).toBe(-32601);
    const call = async (name: string, args: unknown) =>
      (await rpc(a.credential.token, "tools/call", { name, arguments: args })).body;
    const result = record((await call("semprec.heartbeat.list", {})).result);
    expect(result.isError).toBe(false);
    const actual = JSON.stringify(result.content);
    expect(actual).toContain(a.heartbeat.id);
    expect(actual).not.toContain(b.heartbeat.id);
    const session = await runInTenant(tenantA, () =>
      resolveModuleAgentToolsForRun(pool, registry, a.credential.run.id, a.projectId),
    );
    const tool = session.find((entry) => entry.name === "heartbeat.list");
    if (!tool) throw new Error("Missing session tool");
    const expected = await runInTenant(tenantA, () => tool.invoke({}));
    expect(result.content).toEqual([{ type: "text", text: expected.result }]);
    const fixtureSuccess = record((await call("semprec.fixture.core", {})).result);
    expect(fixtureSuccess).toMatchObject({ isError: false, content: [{ type: "text", text: "ok" }] });
    for (const [kind, code] of [
      ["validation", -32602],
      ["approval", -32001],
      ["domain", -32000],
    ] as const) {
      expect(record((await call("semprec.fixture.core", { throw: kind })).error).code).toBe(code);
    }
    const fixtureError = record((await call("semprec.fixture.core", { fail: true })).result);
    expect(fixtureError).toMatchObject({ isError: true, content: [{ type: "text", text: "refused" }] });
    const error = record((await call("semprec.heartbeat.history", { heartbeatId: b.heartbeat.id })).result);
    expect(error.isError).toBe(true);
    expect(record((await call("semprec.owned.inspect", {})).error).code).toBe(-32601);
    expect(record((await call("semprec.unknown", {})).error).code).toBe(-32601);
    expect(record((await call("semprec.heartbeat.list", { unexpected: true })).error).code).toBe(-32602);
    await expect(
      runInTenant(tenantA, () => resolveModuleAgentToolsForRun(pool, registry, b.credential.run.id, b.projectId)),
    ).rejects.toThrow();
    await expect(
      runInTenant(tenantA, () => resolveModuleAgentToolsForRun(pool, registry, a.credential.run.id, b.projectId)),
    ).rejects.toThrow();
  });
});
