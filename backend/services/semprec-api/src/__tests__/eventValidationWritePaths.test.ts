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
import { CAPABILITY_IDS, type AuthenticatedActor } from "@semprec/shared";
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

const itemBody = z.object({ id: z.string(), updatedAt: z.string() }).passthrough();
const storedRow = z.object({ properties: z.record(z.string(), z.unknown()), updated_at: z.string() });
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

/** The rejections of issue #1663 on create: a label, the field named, and the Event's properties besides its name. */
const CREATE_REFUSALS: Array<[string, string, Record<string, unknown>]> = [
  ["timeTo not after timeFrom", "timeTo", { date: "2026-10-16", timeFrom: "10:00", timeTo: "09:30" }],
  ["timeFrom and timeTo both 23:55", "timeTo", { date: "2026-10-16", timeFrom: "23:55", timeTo: "23:55" }],
  ["endDate before date", "endDate", { date: "2026-10-16", endDate: "2026-10-15" }],
  ["timeTo without timeFrom", "timeTo", { date: "2026-10-16", timeTo: "11:00" }],
  ["timeTo 24:30", "timeTo", { date: "2026-10-16", timeFrom: "23:00", timeTo: "24:30" }],
  ["timeFrom 24:00", "timeFrom", { date: "2026-10-16", timeFrom: "24:00", timeTo: "24:00" }],
  ["a timeFrom that is no time", "timeFrom", { date: "2026-10-16", timeFrom: "noon" }],
  ["an endDate that is no calendar date", "endDate", { date: "2026-10-16", endDate: "2026-13-01" }],
  [
    "a multi-day timed Event without timeTo",
    "timeTo",
    { date: "2026-10-16", endDate: "2026-10-17", timeFrom: "22:00" },
  ],
  ["no date", "date", {}],
  ["a null date", "date", { date: null }],
  ["an impossible calendar date", "date", { date: "2026-02-30" }],
  ["a date with a time the time transform could not convert", "date", { date: "2026-10-16T25:00" }],
];

/**
 * The rejections of issue #1663 on update: a label, the field named, the Event a write path creates first, the patch,
 * and the legacy values stored into it afterwards (`null` for none).
 */
const PATCH_REFUSALS: Array<[string, string, Record<string, unknown>, Record<string, unknown>, Legacy]> = [
  [
    "only timeFrom 11:45 on an Event from 10:00 to 11:30",
    "timeTo",
    { date: "2026-10-16", timeFrom: "10:00", timeTo: "11:30" },
    { timeFrom: "11:45" },
    null,
  ],
  [
    "only timeFrom 23:55 on an Event from 23:00 to 23:55",
    "timeTo",
    { date: "2026-10-16", timeFrom: "23:00", timeTo: "23:55" },
    { timeFrom: "23:55" },
    null,
  ],
  [
    "only date 2026-10-26 on an Event spanning 24 and 25 October",
    "endDate",
    { date: "2026-10-24", endDate: "2026-10-25" },
    { date: "2026-10-26" },
    null,
  ],
  ["an endDate before the date", "endDate", { date: "2026-10-16" }, { endDate: "2026-10-15" }, null],
  ["an endDate that is no calendar date", "endDate", { date: "2026-10-16" }, { endDate: "2026-13-01" }, null],
  ["a date cleared to null", "date", { date: "2026-10-16" }, { date: null }, null],
  ["an impossible calendar date", "date", { date: "2026-10-16" }, { date: "2026-02-30" }, null],
  [
    "a date with a time the time transform could not convert",
    "date",
    { date: "2026-10-16" },
    { date: "2026-10-16T25:00" },
    null,
  ],
  [
    "a timeFrom that is no time",
    "timeFrom",
    { date: "2026-10-16", timeFrom: "10:00", timeTo: "11:30" },
    { timeFrom: "noon" },
    null,
  ],
  ["timeFrom 24:00", "timeFrom", { date: "2026-10-16" }, { timeFrom: "24:00", timeTo: "24:00" }, null],
  ["timeTo 24:30", "timeTo", { date: "2026-10-16", timeFrom: "10:00", timeTo: "11:00" }, { timeTo: "24:30" }, null],
  ["a timeTo without a timeFrom", "timeTo", { date: "2026-10-16" }, { timeTo: "11:00" }, null],
  [
    "a timeFrom on a two-day Event without a timeTo",
    "timeTo",
    { date: "2026-10-16", endDate: "2026-10-17" },
    { timeFrom: "22:00" },
    null,
  ],
  [
    "times out of order on a legacy date-time",
    "timeTo",
    { date: "2026-10-16" },
    { timeFrom: "10:00", timeTo: "09:00" },
    { date: "2026-10-16T08:00:00Z" },
  ],
];

/** The accepted creates of issue #1663: a label, the Event's properties besides its name, and what is stored. */
const CREATE_PASSES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["timeTo 24:00", { date: "2026-10-16", timeFrom: "23:00", timeTo: "24:00" }, { timeFrom: "23:00", timeTo: "24:00" }],
  ["23:30 with no end, stored with 24:00", { date: "2026-10-16", timeFrom: "23:30" }, { timeTo: "24:00" }],
  [
    "an all-day Event spanning 24 and 25 October",
    { date: "2026-10-24", endDate: "2026-10-25" },
    { date: "2026-10-24", endDate: "2026-10-25" },
  ],
  [
    "an overnight Event from 22:00 on 16 October to 02:00 on 17 October",
    { date: "2026-10-16", endDate: "2026-10-17", timeFrom: "22:00", timeTo: "02:00" },
    { date: "2026-10-16", endDate: "2026-10-17", timeFrom: "22:00", timeTo: "02:00" },
  ],
  [
    "a date with a time the time transform converted",
    { date: "2026-10-16T08:00" },
    { date: "2026-10-16", timeFrom: "08:00", timeTo: "09:00" },
  ],
];

/**
 * The accepted updates of issue #1663 on an Event with legacy values: a label, the legacy values, the patch, and what
 * is stored afterwards.
 */
const PATCH_PASSES: Array<[string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> = [
  [
    "only name on an Event whose stored date is 2026-10-16T08:00:00Z",
    { date: "2026-10-16T08:00:00Z" },
    { name: "Renamed" },
    { name: "Renamed", date: "2026-10-16T08:00:00Z" },
  ],
  [
    "times on an Event whose stored date and endDate are unreadable",
    { date: "2026-10-16T08:00:00Z", endDate: "someday" },
    { timeFrom: "09:00", timeTo: "10:00" },
    { date: "2026-10-16T08:00:00Z", endDate: "someday", timeFrom: "09:00", timeTo: "10:00" },
  ],
];

/** Values stored into an Event with raw SQL after its create, or `null` for none. */
type Legacy = Record<string, unknown> | null;

let pool: Pool;
let eventsId: string;

async function stored(itemId: string) {
  const { rows } = await pool.query<Record<string, unknown>>(
    "SELECT properties, updated_at::text FROM items WHERE database_id = $1 AND id = $2",
    [eventsId, itemId],
  );
  return storedRow.parse(rows[0]);
}

async function eventsNamed(name: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM items WHERE database_id = $1 AND properties->>'name' = $2",
    [eventsId, name],
  );
  return rows[0]?.count ?? -1;
}

/**
 * Synthetic legacy state: the Events time transform converts a date-time on every write, so only a row stored before
 * issue #1598 holds one; no write path can produce it, so it is written with raw SQL.
 */
async function storeLegacy(itemId: string, legacy: Record<string, unknown>): Promise<void> {
  const result = await pool.query(
    "UPDATE items SET properties = properties || $3::jsonb WHERE database_id = $1 AND id = $2",
    [eventsId, itemId, JSON.stringify(legacy)],
  );
  expect(result.rowCount).toBe(1);
}

describe("Events validation errors are the same through REST, the agent gateway and MCP (issue #1663)", () => {
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
      "SELECT id FROM databases WHERE owner_module_id = 'events' AND system",
    );
    eventsId = rows[0]!.id;

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const projectItemId = await createTestProjectItem(pool);
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "plan a meeting" });
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
   * compared.
   */
  function expectSameRefusal(refusals: { rest: RestRefusal; gateway: GatewayRefusal; mcp: McpRefusal }, field: string) {
    expect(refusals.rest).toEqual({ status: 400, code: "validation_failed", details: { field } });
    expect(refusals.gateway).toEqual({
      code: "validation_failed",
      status: 400,
      message: expect.any(String),
      details: { field },
    });
    expect(refusals.mcp).toEqual({ rpcCode: -32602, message: refusals.gateway.message, data: { field } });
  }

  async function createVia(path: Transport, properties: Record<string, unknown>) {
    if (path === "rest") {
      const created = await rest("POST", `/api/databases/${eventsId}/items`, { properties });
      expect(created.status).toBe(201);
      return itemBody.parse(created.body);
    }
    if (path === "gateway") {
      return itemBody.parse(
        await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), {
          databaseId: eventsId,
          properties,
        }),
      );
    }
    const text = mcpResult
      .parse(await mcpCall("semprec.item.create", { databaseId: eventsId, properties }))
      .result.content.find((part) => part.type === "text")?.text;
    if (text === undefined) throw new Error("MCP result has no text content");
    return itemBody.parse(JSON.parse(text));
  }

  async function patchVia(
    path: Transport,
    item: { id: string; updatedAt: string },
    properties: Record<string, unknown>,
  ) {
    const input = { itemId: item.id, properties, ifVersion: item.updatedAt };
    if (path === "rest") {
      const patched = await rest("PATCH", `/api/items/${item.id}`, { properties, ifVersion: item.updatedAt });
      expect(patched.status).toBe(200);
      return;
    }
    if (path === "gateway") {
      itemBody.parse(await gateway().invoke("item.patch", agentActor, new Set(CAPABILITY_IDS), input));
      return;
    }
    mcpResult.parse(await mcpCall("semprec.item.patch", input));
  }

  /** An Event a write path created, with any legacy values stored into it, and its stored row before the patch. */
  async function patchTarget(path: Transport, name: string, base: Record<string, unknown>, legacy: Legacy) {
    const item = await createVia(path, { name: `${name} ${path}`, ...base });
    if (legacy !== null) await storeLegacy(item.id, legacy);
    return { item, before: await stored(item.id) };
  }

  it.each(CREATE_REFUSALS)(
    "refuses a create with %s on %s alike through REST, the agent gateway and MCP, writing nothing",
    async (label, field, values) => {
      const name = `Refused: ${label}`;
      const properties = { name, ...values };
      const refusals = {
        rest: await restRefusal("POST", `/api/databases/${eventsId}/items`, { properties }),
        gateway: await gatewayRefusal("item.create", { databaseId: eventsId, properties }),
        mcp: await mcpRefusal("semprec.item.create", { databaseId: eventsId, properties }),
      };
      expectSameRefusal(refusals, field);
      expect(await eventsNamed(name)).toBe(0);
    },
  );

  it.each(PATCH_REFUSALS)(
    "refuses a patch with %s on %s alike through REST, the agent item.patch and MCP, keeping every row",
    async (label, field, base, patch, legacy) => {
      const targets = {
        rest: await patchTarget("rest", label, base, legacy),
        gateway: await patchTarget("gateway", label, base, legacy),
        mcp: await patchTarget("mcp", label, base, legacy),
      };
      const refusals = {
        rest: await restRefusal("PATCH", `/api/items/${targets.rest.item.id}`, {
          properties: patch,
          ifVersion: targets.rest.item.updatedAt,
        }),
        gateway: await gatewayRefusal("item.patch", {
          itemId: targets.gateway.item.id,
          properties: patch,
          ifVersion: targets.gateway.item.updatedAt,
        }),
        mcp: await mcpRefusal("semprec.item.patch", {
          itemId: targets.mcp.item.id,
          properties: patch,
          ifVersion: targets.mcp.item.updatedAt,
        }),
      };
      expectSameRefusal(refusals, field);
      for (const path of TRANSPORTS) {
        expect(await stored(targets[path].item.id)).toEqual(targets[path].before);
      }
    },
  );

  it.each(CREATE_PASSES)(
    "accepts a create with %s through REST, the agent gateway and MCP",
    async (label, values, expected) => {
      for (const path of TRANSPORTS) {
        const item = await createVia(path, { name: `${label} ${path}`, ...values });
        expect((await stored(item.id)).properties).toMatchObject(expected);
      }
    },
  );

  it.each(PATCH_PASSES)(
    "accepts a patch of %s through REST, the agent item.patch and MCP",
    async (label, legacy, patch, expected) => {
      for (const path of TRANSPORTS) {
        const { item } = await patchTarget(path, label, { date: "2026-10-16" }, legacy);
        await patchVia(path, item, patch);
        expect((await stored(item.id)).properties).toMatchObject(expected);
      }
    },
  );
});
