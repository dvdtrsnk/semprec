import { ModuleRegistry } from "@semprec/module-registry";
import type { CollectionMetadataResolver } from "@semprec/data";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createTestProjectItem,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createSemprecTickAction,
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

const EVENT = { name: "Client meeting", date: "2026-10-16", timeFrom: "09:00" };

const itemBody = z.object({ id: z.string() }).passthrough();
const mcpEnvelope = z.object({
  result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) }),
});
const relationsBody = z.object({ relations: z.array(z.object({ targetItemId: z.string() }).passthrough()) });
const confirmedProposal = z.object({ properties: z.object({ resultItemId: z.string() }).passthrough() }).passthrough();

let pool: Pool;

describe("every write path gives a new Event the default calendar (issue #1761)", () => {
  let server: Server;
  let mcpServer: Server;
  let baseUrl: string;
  let mcpUrl: string;
  let headers: Record<string, string>;
  let mcpToken: string;
  let agentActor: AuthenticatedActor;
  let eventsId: string;
  let calendarsId: string;
  let personalId: string;
  let ids: { inbox: string; inboxItemTypes: string; processingProposals: string };
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
    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
      locale: "en",
    });
    // Seeded after the English-speaking user exists, so the default calendar is named `Personal`.
    await seedSystem(pool, createViewTypeRegistry());
    const chokePoint = createChokePoint(pool);
    const databases = await chokePoint.listDatabases();
    const databaseId = (moduleId: string): string => {
      const database = databases.find((candidate) => candidate.ownerModuleId === moduleId);
      if (!database) throw new Error(`Missing ${moduleId}`);
      return database.id;
    };
    eventsId = databaseId("events");
    ids = {
      inbox: databaseId("inbox"),
      inboxItemTypes: databaseId("inboxItemTypes"),
      processingProposals: databaseId("processingProposals"),
    };
    calendarsId = databaseId("calendars");
    const calendars = (await chokePoint.listItems(calendarsId, { limit: 50 })).items;
    const personal = calendars.find((calendar) => calendar.properties.name === "Personal");
    if (!personal || personal.properties.isDefault !== true) throw new Error("Missing the default calendar Personal");
    personalId = personal.id;

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

  async function rest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  /** The calendars an Event is linked to, read through the generic relation list. */
  async function calendarsOf(eventId: string): Promise<string[]> {
    const listed = await rest("GET", `/api/items/${eventId}/relations?propertyKey=calendar`);
    expect(listed.status).toBe(200);
    return relationsBody.parse(listed.body).relations.map((relation) => relation.targetItemId);
  }

  /** The Events the default calendar holds, read from the calendar's side. */
  async function eventsInPersonal(): Promise<string[]> {
    const listed = await rest("GET", `/api/items/${personalId}/relations`);
    expect(listed.status).toBe(200);
    return relationsBody.parse(listed.body).relations.map((relation) => relation.targetItemId);
  }

  /** The live Events of the tenant. */
  async function eventIds(): Promise<string[]> {
    return (await createChokePoint(pool).listItems(eventsId, { limit: 50 })).items.map((item) => item.id);
  }

  async function viaRest(): Promise<string> {
    const created = await rest("POST", `/api/databases/${eventsId}/items`, { properties: EVENT });
    expect(created.status).toBe(201);
    return itemBody.parse(created.body).id;
  }

  /** Semp's generic operations: the gateway invoked with an agent actor. */
  async function viaAgentGateway(): Promise<string> {
    const created = await gateway().invoke("item.create", agentActor, new Set(CAPABILITY_IDS), {
      databaseId: eventsId,
      properties: EVENT,
    });
    return itemBody.parse(created).id;
  }

  async function viaMcp(): Promise<string> {
    const res = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mcpToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "semprec.item.create", arguments: { databaseId: eventsId, properties: EVENT } },
      }),
    });
    expect(res.status).toBe(200);
    const text = mcpEnvelope.parse(await res.json()).result.content.find((part) => part.type === "text")?.text;
    if (text === undefined) throw new Error("MCP result has no text content");
    return itemBody.parse(JSON.parse(text)).id;
  }

  /** An Inbox item of a type that targets Events, its proposal from the tick, and the user's confirm over HTTP. */
  async function viaInboxConfirm(): Promise<string> {
    const chokePoint = createChokePoint(pool);
    const proposalId = await inTenantZero(async () => {
      const type = await chokePoint.createItem({
        databaseId: ids.inboxItemTypes,
        properties: { name: "Meeting", emoji: "📅", processingMethod: "database", targetDatabase: "events" },
      });
      const inboxItem = await chokePoint.createItem({
        databaseId: ids.inbox,
        properties: { text: "Meeting with the client", date: "2026-10-16", time: "09:00" },
      });
      const typeProperty = (await chokePoint.listProperties(ids.inbox)).find((property) => property.key === "type");
      if (!typeProperty) throw new Error("Missing Inbox.type");
      await chokePoint.createRelation({
        relationPropertyId: typeProperty.id,
        callerItemId: inboxItem.id,
        targetItemId: type.id,
      });
      const tick = createSemprecTickAction(pool, async () => ({ properties: EVENT }));
      await tick(
        {
          inboxDatabaseId: ids.inbox,
          inboxItemTypesDatabaseId: ids.inboxItemTypes,
          processingProposalsDatabaseId: ids.processingProposals,
        },
        { heartbeatId: "hb", projectItemId: "proj", itemId: inboxItem.id },
      );
      const proposals = await chokePoint.listItems(ids.processingProposals, { limit: 50 });
      const proposal = proposals.items[0];
      if (!proposal || proposals.items.length !== 1) throw new Error("Expected exactly one proposal from the tick");
      return proposal.id;
    });
    const confirmed = await rest("POST", `/api/proposals/${proposalId}/confirm`);
    expect(confirmed.status).toBe(200);
    return confirmedProposal.parse(confirmed.body).properties.resultItemId;
  }

  it.each([
    ["the generic endpoint", () => viaRest()],
    ["Semp's generic operations", () => viaAgentGateway()],
    ["MCP", () => viaMcp()],
    ["the Inbox confirm path", () => viaInboxConfirm()],
  ])("links an Event created through %s to Personal and to no other calendar", async (_path, create) => {
    const eventId = await create();
    expect(await eventIds()).toEqual([eventId]);
    expect(await calendarsOf(eventId)).toEqual([personalId]);
    expect(await eventsInPersonal()).toEqual([eventId]);
  });

  it("adds no second edge when the generic endpoint replays a create with the same Idempotency-Key", async () => {
    const key = { "Idempotency-Key": randomUUID() };
    const first = await rest("POST", `/api/databases/${eventsId}/items`, { properties: EVENT }, key);
    const replayed = await rest("POST", `/api/databases/${eventsId}/items`, { properties: EVENT }, key);
    expect(first.status).toBe(201);
    const eventId = itemBody.parse(first.body).id;
    expect(itemBody.parse(replayed.body).id).toBe(eventId);
    expect(await eventIds()).toEqual([eventId]);
    expect(await calendarsOf(eventId)).toEqual([personalId]);
    expect(await eventsInPersonal()).toEqual([eventId]);
  });

  it("stores no Event and no calendar edge when the generic endpoint refuses the Event", async () => {
    const refused = await rest("POST", `/api/databases/${eventsId}/items`, { properties: { name: "No date" } });
    expect(refused.status).toBe(400);
    expect(await eventIds()).toEqual([]);
    expect(await eventsInPersonal()).toEqual([]);
  });

  it("answers a create with a server error and stores no Event while no live calendar is the default", async () => {
    await inTenantZero(() => createChokePoint(pool).softDeleteItem(calendarsId, personalId));
    const failed = await rest("POST", `/api/databases/${eventsId}/items`, { properties: EVENT });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: { code: "internal_error" } });
    expect(await eventIds()).toEqual([]);
  });
});
