import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { ModuleRegistry } from "@alldots/module-registry";
import { createGenericOperationGateway } from "@alldots/application";
import { CAPABILITY_IDS, runInTenant } from "@alldots/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@alldots/data/testSupport";
import {
  createCalendarTimelineRouteHandler,
  createChokePoint,
  createUser,
  hashPassword,
  login,
  mintMcpRunCredential,
  seedSystem,
  withTransaction,
} from "@alldots/data";
import { createMcpRequestListener } from "../mcpHandler.js";

/**
 * A run credential naming `calendar.read` in a project that owns the calendar databases, and a
 * human session, list and call it; every other caller gets -32601. The handler itself is tested in
 * `packages/data`.
 */

const calendarManifestHref = new URL(
  "../../../../../packages/data/src/calendar/calendarModuleManifest.js",
  import.meta.url,
).href;
const TOOL = "alldots.calendar.timeline";
const DAY = "2026-10-16";
const PASSWORD = "mcp-test-password";
const metadata = {
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

const rpcBodySchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});
const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean(),
});
const toolListSchema = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.unknown() })) });
const timelineSchema = z.looseObject({
  from: z.string(),
  to: z.string(),
  items: z.array(z.looseObject({ id: z.string(), kind: z.string() })),
});

interface Tenant {
  id: string;
  userId: string;
  email: string;
  eventsId: string;
  /**
   * In the calendar-owning project: one naming `calendar.read`, one naming `calendar.write` only,
   * one naming neither. In another project: one naming `calendar.read`.
   */
  readToken: string;
  writeOnlyToken: string;
  noCalendarCapabilityToken: string;
  otherToken: string;
}

let admin: Pool;
let pool: Pool;
let server: Server;
let url: string;
let registry: ModuleRegistry;
let home: Tenant;
let foreign: Tenant;

async function seededTenant(): Promise<Tenant> {
  const id = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(admin, {
    tenantId: id,
    email,
    passwordHash: await hashPassword(PASSWORD),
    locale: "en",
  });
  return runInTenant(id, async () => {
    await seedSystem(pool);
    const chokePoint = createChokePoint(pool);
    const databases = await chokePoint.listDatabases();
    const database = (key: string) => {
      const found = databases.find((row) => row.ownerModuleId === key);
      if (!found) throw new Error(`Missing ${key}`);
      return found;
    };
    const calendarProjectId = database("calendars").ownerProjectItemId;
    if (!calendarProjectId) throw new Error("The calendars database has no owner project");
    const other = await chokePoint.createItem({ databaseId: database("projects").id, properties: { name: "Other" } });
    const mint = (projectItemId: string, capabilities: string[]) =>
      withTransaction(pool, (client) =>
        mintMcpRunCredential(client, {
          projectItemId,
          capabilities,
          moduleCapabilityIds: ["calendar.read", "calendar.write"],
          userId: user.id,
        }),
      );
    return {
      id,
      userId: user.id,
      email,
      eventsId: database("events").id,
      readToken: (await mint(calendarProjectId, ["core.item.read", "calendar.read"])).token,
      writeOnlyToken: (await mint(calendarProjectId, ["core.item.read", "calendar.write"])).token,
      noCalendarCapabilityToken: (await mint(calendarProjectId, ["core.item.read"])).token,
      otherToken: (await mint(other.id, ["core.item.read", "calendar.read"])).token,
    };
  });
}

async function rpc(token: string, method: string, params?: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return rpcBodySchema.parse(await response.json());
}

async function toolNames(token: string): Promise<string[]> {
  return toolListSchema.parse((await rpc(token, "tools/list")).result).tools.map((tool) => tool.name);
}

const callTool = (token: string, name: string, args: unknown) => rpc(token, "tools/call", { name, arguments: args });

async function sessionToken(tenant: Tenant): Promise<string> {
  return (await login(admin, { email: tenant.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" })).token;
}

async function event(tenant: Tenant, name: string): Promise<string> {
  return (
    await runInTenant(tenant.id, () =>
      createChokePoint(pool).createItem({ databaseId: tenant.eventsId, properties: { name, date: DAY } }),
    )
  ).id;
}

/** Sleep nights included: the route answers the user, who may read them. */
async function routeItems(tenant: Tenant) {
  const { body } = await runInTenant(tenant.id, () =>
    createCalendarTimelineRouteHandler(pool)({ req: { url: `/api/calendar/timeline?from=${DAY}&to=${DAY}` } }),
  );
  return timelineSchema.parse(JSON.parse(JSON.stringify(body))).items;
}

/**
 * Without the sleep nights, which are sensitive. A seeded tenant shows them in its calendar, so the
 * filter leaves something out.
 */
async function routeItemsWithoutSleep(tenant: Tenant) {
  const all = await routeItems(tenant);
  expect(all.some((item) => item.kind === "sleep")).toBe(true);
  return all.filter((item) => item.kind !== "sleep");
}

function timelineOf(answer: z.infer<typeof rpcBodySchema>) {
  expect(answer.error).toBeUndefined();
  const result = toolResultSchema.parse(answer.result);
  expect(result.isError).toBe(false);
  return timelineSchema.parse(JSON.parse(result.content[0]?.text ?? ""));
}

async function requestCount(tenant: Tenant): Promise<number> {
  const { rows } = await admin.query("SELECT count(*)::int AS n FROM approval_requests WHERE tenant_id = $1", [
    tenant.id,
  ]);
  return z.object({ n: z.number() }).parse(rows[0]).n;
}

describe("calendar.timeline over POST /mcp (issue gh-1952)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "alldots_data");
    registry = new ModuleRegistry(() => new Set(["calendar"]));
    await registry.loadModule(calendarManifestHref);
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

  beforeEach(async () => {
    await resetDatabase(admin);
    home = await seededTenant();
    foreign = await seededTenant();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await admin?.end();
  });

  describe("listing", () => {
    it("lists the tool, with its schema, for a run credential of the calendar project that names calendar.read", async () => {
      const list = toolListSchema.parse((await rpc(home.readToken, "tools/list")).result);
      const timeline = list.tools.filter((tool) => tool.name.startsWith("alldots.calendar."));
      expect(timeline.map((tool) => tool.name)).toEqual([TOOL]);
      expect(timeline[0]?.inputSchema).toMatchObject({ type: "object", required: ["from", "to"] });
    });

    it.each([
      ["a credential that names calendar.write but not calendar.read", (tenant: Tenant) => tenant.writeOnlyToken],
      ["a credential that names no calendar capability", (tenant: Tenant) => tenant.noCalendarCapabilityToken],
      [
        "a credential that names calendar.read in a project without the calendar databases",
        (tenant: Tenant) => tenant.otherToken,
      ],
    ])("does not list it for %s", async (_name, tokenOf) => {
      expect(await toolNames(tokenOf(home))).not.toContain(TOOL);
    });

    it("lists it for a human session", async () => {
      expect(await toolNames(await sessionToken(home))).toContain(TOOL);
    });
  });

  describe("calling it", () => {
    it("answers a credential with the items the route returns but its sleep nights, and none of another tenant", async () => {
      const own = await event(home, "Mine");
      const theirs = await event(foreign, "Theirs");

      const timeline = timelineOf(await callTool(home.readToken, TOOL, { from: DAY, to: DAY }));

      expect(timeline).toMatchObject({ from: DAY, to: DAY });
      expect(timeline.items.map((item) => item.id)).toContain(own);
      expect(JSON.stringify(timeline)).not.toContain(theirs);
      expect(timeline.items).toEqual(await routeItemsWithoutSleep(home));
      expect(await requestCount(home)).toBe(0);
    });

    it("answers a human session with the items the route returns but its sleep nights, and none of another tenant", async () => {
      const own = await event(home, "Mine");
      const theirs = await event(foreign, "Theirs");

      const timeline = timelineOf(await callTool(await sessionToken(home), TOOL, { from: DAY, to: DAY }));

      expect(timeline.items.map((item) => item.id)).toContain(own);
      expect(JSON.stringify(timeline)).not.toContain(theirs);
      expect(timeline.items).toEqual(await routeItemsWithoutSleep(home));
      expect(await requestCount(home)).toBe(0);
    });

    it.each([
      ["a range longer than 93 days", { from: "2026-01-01", to: "2026-04-04" }],
      ["a malformed date", { from: "2026-02-30", to: "2026-03-01" }],
    ])("answers -32602 for %s, for a credential and for a session", async (_name, args) => {
      expect((await callTool(home.readToken, TOOL, args)).error?.code).toBe(-32602);
      expect((await callTool(await sessionToken(home), TOOL, args)).error?.code).toBe(-32602);
    });

    it.each([
      ["a credential that names calendar.write but not calendar.read", (tenant: Tenant) => tenant.writeOnlyToken],
      ["a credential that names no calendar capability", (tenant: Tenant) => tenant.noCalendarCapabilityToken],
      [
        "a credential that names calendar.read in a project without the calendar databases",
        (tenant: Tenant) => tenant.otherToken,
      ],
    ])("answers a call from %s exactly as it answers an unknown tool", async (_name, tokenOf) => {
      const token = tokenOf(home);
      const refused = await callTool(token, TOOL, { from: DAY, to: DAY });
      const unknown = await callTool(token, "alldots.calendar.unknownTool", { from: DAY, to: DAY });

      expect(refused.error?.code).toBe(-32601);
      expect(refused.error?.message.replace("timeline", "NAME")).toBe(
        unknown.error?.message.replace("unknownTool", "NAME"),
      );
      expect(refused.result).toBeUndefined();
    });
  });
});
