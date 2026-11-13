import { ModuleRegistry } from "@semprec/module-registry";
import type { CollectionMetadataResolver } from "@semprec/data";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { createTestProjectItem, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  ValidationError,
  createAgentRun,
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  mintMcpRunCredential,
  seedSystem,
  withTransaction,
  type PasswordResetMailer,
} from "@semprec/data";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, runInTenant, type AuthenticatedActor } from "@semprec/shared";
import { createDispatcher } from "../app.js";
import { createMcpRequestListener } from "../mcp/mcpHandler.js";

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const itemBody = z
  .object({ id: z.string(), updatedAt: z.string(), properties: z.record(z.string(), z.unknown()) })
  .passthrough();
const storedRow = z.object({ properties: z.record(z.string(), z.unknown()) });
const restError = z.object({
  error: z.object({ code: z.string(), details: z.record(z.string(), z.unknown()) }).strict(),
});
const mcpResult = z.object({
  result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) }),
});
const mcpError = z.object({
  error: z.object({ code: z.number(), message: z.string(), data: z.record(z.string(), z.unknown()) }).strict(),
});

/** A refusal as REST exposes it: the HTTP status and the error body's `code` and `details`; the body has no message. */
interface RestRefusal {
  status: number;
  code: string;
  details: Record<string, unknown>;
}

/** A refusal as the agent gateway exposes it: the `ValidationError` it throws. */
interface GatewayRefusal {
  code: string;
  status: number;
  message: string;
  details: Record<string, unknown>;
}

/** A refusal as MCP exposes it: a JSON-RPC error's code, message and `data`. It carries no category string. */
interface McpRefusal {
  rpcCode: number;
  message: string;
  data: Record<string, unknown>;
}

const TRANSPORTS = ["rest", "gateway", "mcp"] as const;
type Transport = (typeof TRANSPORTS)[number];

/** The values issue gh-1802 refuses on Health records: a label, the field named and the values of the write. */
const REFUSALS: Array<[string, string, Record<string, unknown>]> = [
  ["tags neznamy", "tags", { tags: ["neznamy"] }],
  ["tags medication and neznamy", "tags", { tags: ["medication", "neznamy"] }],
  ["status ghost", "status", { status: "ghost" }],
  ["type as a number", "type", { type: 3 }],
];

let pool: Pool;
let healthId: string;

async function storedProperties(itemId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<Record<string, unknown>>(
    "SELECT properties FROM items WHERE database_id = $1 AND id = $2",
    [healthId, itemId],
  );
  return storedRow.parse(rows[0]).properties;
}

async function recordsNamed(name: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM items WHERE database_id = $1 AND properties->>'name' = $2",
    [healthId, name],
  );
  return rows[0]?.count ?? -1;
}

/** A record written by the system writer, the way mail and transcription ingest write their own values. */
async function createAsSystem(properties: Record<string, unknown>) {
  return runInTenant(getTenantZeroId(), () =>
    createChokePoint(pool).createItem({ databaseId: healthId, properties: { name: "Ingested", ...properties } }),
  );
}

describe("Health records select values are judged alike through REST, the agent gateway and MCP (issue gh-1802)", () => {
  let server: Server;
  let mcpServer: Server;
  let baseUrl: string;
  let mcpUrl: string;
  let headers: Record<string, string>;
  let mcpToken: string;
  let agentActor: AuthenticatedActor;
  const gateway = () => createGenericOperationGateway(pool, testMetadataResolver);

  async function listen(s: Server): Promise<string> {
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = 'healthRecords' AND system",
    );
    healthId = rows[0]?.id ?? "";
    if (!healthId) throw new Error("Health records database not seeded");

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const projectItemId = await createTestProjectItem(pool);
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "file a health record" });
    agentActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    mcpToken = (
      await withTransaction(pool, (client) =>
        mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.write"], userId: user.id }),
      )
    ).token;

    server = createServer(
      await createDispatcher(pool, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      }),
    );
    baseUrl = await listen(server);
    mcpServer = createServer(
      await createMcpRequestListener(pool, gateway(), new Set(CAPABILITY_IDS), new ModuleRegistry(() => new Set())),
    );
    mcpUrl = await listen(mcpServer);
  });

  afterEach(async () => {
    await Promise.all([server, mcpServer].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function rest(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }

  async function mcpCall(name: string, args: unknown): Promise<unknown> {
    const res = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcpToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  async function restRefusal(method: string, path: string, body: unknown): Promise<RestRefusal> {
    const response = await rest(method, path, body);
    const parsed = restError.parse(response.body);
    return { status: response.status, code: parsed.error.code, details: parsed.error.details };
  }

  async function gatewayRefusal(operation: "item.create" | "item.patch", input: unknown): Promise<GatewayRefusal> {
    const error: unknown = await gateway()
      .invoke(operation, agentActor, new Set(CAPABILITY_IDS), input)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      details: z.record(z.string(), z.unknown()).parse(error.details),
    };
  }

  /** MCP carries a `ValidationError` as JSON-RPC `-32602` (invalid params): its message, and its details as `data`. */
  async function mcpRefusal(name: string, args: unknown): Promise<McpRefusal> {
    const parsed = mcpError.parse(await mcpCall(name, args));
    return { rpcCode: parsed.error.code, message: parsed.error.message, data: parsed.error.data };
  }

  /**
   * Every exposed part of the three refusals: REST and the gateway carry the same category and status, MCP the
   * gateway's message, and all three the same details naming `field`. MCP's category is not exposed, so it is not
   * compared. The message names the unknown value when `unknownValue` is given.
   */
  function expectSameRefusal(
    refusals: { rest: RestRefusal; gateway: GatewayRefusal; mcp: McpRefusal },
    field: string,
    unknownValue?: string,
  ) {
    expect(refusals.rest).toEqual({ status: 400, code: "validation_failed", details: { field } });
    expect(refusals.gateway).toEqual({
      code: "validation_failed",
      status: 400,
      message: expect.any(String),
      details: { field },
    });
    expect(refusals.mcp).toEqual({ rpcCode: -32602, message: refusals.gateway.message, data: { field } });
    if (unknownValue !== undefined) expect(refusals.gateway.message).toContain(`'${unknownValue}'`);
  }

  function mcpItem(response: unknown) {
    const text = mcpResult.parse(response).result.content.find((part) => part.type === "text")?.text;
    if (text === undefined) throw new Error("MCP result has no text content");
    return itemBody.parse(JSON.parse(text));
  }

  async function createVia(path: Transport, properties: Record<string, unknown>) {
    if (path === "rest") {
      const created = await rest("POST", `/api/databases/${healthId}/items`, { properties });
      expect(created.status).toBe(201);
      return itemBody.parse(created.body);
    }
    const input = { databaseId: healthId, properties };
    if (path === "gateway") {
      return itemBody.parse(await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), input));
    }
    return mcpItem(await mcpCall("semprec.item.create", input));
  }

  /** The item a write path answers a patch with; REST must answer 200. */
  async function patchVia(
    path: Transport,
    item: { id: string; updatedAt: string },
    properties: Record<string, unknown>,
  ) {
    const input = { itemId: item.id, properties, ifVersion: item.updatedAt };
    if (path === "rest") {
      const patched = await rest("PATCH", `/api/items/${item.id}`, { properties, ifVersion: item.updatedAt });
      expect(patched.status).toBe(200);
      return itemBody.parse(patched.body);
    }
    if (path === "gateway") {
      return itemBody.parse(await gateway().invoke("item.patch", agentActor, new Set(CAPABILITY_IDS), input));
    }
    return mcpItem(await mcpCall("semprec.item.patch", input));
  }

  it.each(REFUSALS)(
    "refuses a create with %s alike through REST, the agent gateway and MCP, writing nothing",
    async (label, field, values) => {
      const name = `Refused: ${label}`;
      const properties = { name, ...values };
      const refusals = {
        rest: await restRefusal("POST", `/api/databases/${healthId}/items`, { properties }),
        gateway: await gatewayRefusal("item.create", { databaseId: healthId, properties }),
        mcp: await mcpRefusal("semprec.item.create", { databaseId: healthId, properties }),
      };
      expectSameRefusal(refusals, field);
      expect(await recordsNamed(name)).toBe(0);
    },
  );

  it.each(REFUSALS)(
    "refuses a patch with %s alike through REST, the agent item.patch and MCP, keeping every record",
    async (label, field, values) => {
      const targets = {
        rest: await createVia("rest", { name: `${label} rest`, tags: ["prevention"] }),
        gateway: await createVia("gateway", { name: `${label} gateway`, tags: ["prevention"] }),
        mcp: await createVia("mcp", { name: `${label} mcp`, tags: ["prevention"] }),
      };
      const before = await Promise.all(Object.values(targets).map((target) => storedProperties(target.id)));
      const input = (target: { id: string; updatedAt: string }) => ({
        itemId: target.id,
        properties: values,
        ifVersion: target.updatedAt,
      });

      const refusals = {
        rest: await restRefusal("PATCH", `/api/items/${targets.rest.id}`, {
          properties: values,
          ifVersion: targets.rest.updatedAt,
        }),
        gateway: await gatewayRefusal("item.patch", input(targets.gateway)),
        mcp: await mcpRefusal("semprec.item.patch", input(targets.mcp)),
      };

      expectSameRefusal(refusals, field);
      expect(await Promise.all(Object.values(targets).map((target) => storedProperties(target.id)))).toEqual(before);
    },
  );

  it("names the unknown tag in the message of the gateway and of MCP", async () => {
    const properties = { name: "Named", tags: ["neznamy"] };
    const refusals = {
      rest: await restRefusal("POST", `/api/databases/${healthId}/items`, { properties }),
      gateway: await gatewayRefusal("item.create", { databaseId: healthId, properties }),
      mcp: await mcpRefusal("semprec.item.create", { databaseId: healthId, properties }),
    };

    expectSameRefusal(refusals, "tags", "neznamy");
  });

  it.each(TRANSPORTS)("accepts tags [medication] on a create and on a patch through %s", async (path) => {
    const created = await createVia(path, { name: `Accepted ${path}`, tags: ["prevention"] });

    await patchVia(path, created, { tags: ["medication"] });

    expect((await storedProperties(created.id)).tags).toEqual(["medication"]);
  });

  it.each(TRANSPORTS)("clears tags with null and with an empty array through %s", async (path) => {
    const created = await createVia(path, { name: `Cleared ${path}`, tags: ["medication"], status: "monitoring" });

    const cleared = await patchVia(path, created, { tags: [], status: null });
    expect(await storedProperties(created.id)).toMatchObject({ tags: [], status: null });
    await patchVia(path, cleared, { tags: null });

    expect((await storedProperties(created.id)).tags).toBeNull();
  });

  it.each(TRANSPORTS)(
    "accepts a patch that resends the unchanged unknown values of a record through %s",
    async (path) => {
      const legacy = await createAsSystem({ tags: ["neznamy"], status: "ghost" });
      const item = { id: legacy.id, updatedAt: legacy.updatedAt };

      await patchVia(path, item, { name: `Resent ${path}`, tags: ["neznamy"], status: "ghost" });

      expect(await storedProperties(legacy.id)).toMatchObject({
        name: `Resent ${path}`,
        tags: ["neznamy"],
        status: "ghost",
      });
    },
  );

  it("stores the unknown values of the system writer, which is not checked", async () => {
    const ingested = await createAsSystem({ tags: ["neznamy"], status: "ghost" });

    expect(await storedProperties(ingested.id)).toMatchObject({ tags: ["neznamy"], status: "ghost" });
  });
});
