import { ModuleRegistry } from "@semprec/module-registry";
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
  type CollectionMetadataResolver,
  type PasswordResetMailer,
} from "@semprec/data";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS } from "@semprec/shared";
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
const MAILBOX_ID = randomUUID();

const createdItem = z.object({ id: z.string() }).passthrough();
/** A JSON-RPC error answer of the MCP endpoint; a `ValidationError` arrives as `-32602` with its details as `data`. */
const mcpError = z.object({ error: z.object({ code: z.number(), data: z.unknown().optional() }) });
const peopleBody = z.object({
  people: z.array(
    z.object({
      personId: z.string(),
      name: z.string().nullable(),
      relationship: z.string().nullable(),
      emails: z.array(z.string()),
      role: z.string(),
      invitation: z.record(z.string(), z.unknown()).nullable(),
    }),
  ),
});

let pool: Pool;

/**
 * The participant edge and its read route through the real dispatcher: the generic edge `PUT` is the public
 * write, and the invitation writes stand in for the calendar module's invitation code, which writes through
 * the choke point with the system writer kind.
 */
describe("Event participants over HTTP (issue #1757)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let userId: string;
  let eventsId: string;
  let peopleId: string;
  let eventsPeopleId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const chokePoint = createChokePoint(pool);
    const databases = await chokePoint.listDatabases();
    const databaseId = (moduleId: string): string => {
      const database = databases.find((candidate) => candidate.ownerModuleId === moduleId);
      if (!database) throw new Error(`Missing ${moduleId}`);
      return database.id;
    };
    eventsId = databaseId("events");
    peopleId = databaseId("people");
    const property = (await chokePoint.listProperties(eventsId)).find((candidate) => candidate.key === "people");
    if (!property) throw new Error("Missing Events.people");
    eventsPeopleId = property.id;

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
      locale: "cs",
    });
    userId = user.id;
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

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
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async function create(databaseId: string, properties: Record<string, unknown>): Promise<string> {
    const created = await call("POST", `/api/databases/${databaseId}/items`, { properties });
    expect(created.status).toBe(201);
    return createdItem.parse(created.body).id;
  }

  /** The generic edge `PUT`, the public write of a participant edge. */
  const put = (eventId: string, personId: string, body?: unknown) =>
    call("PUT", `/api/items/${eventId}/relations/people/${personId}`, body);

  /** Server code writing an invitation: the choke point with the system writer kind. */
  const invite = (eventId: string, personId: string, invitation: Record<string, unknown>) =>
    inTenantZero(() =>
      createChokePoint(pool).createRelation({
        relationPropertyId: eventsPeopleId,
        callerItemId: eventId,
        targetItemId: personId,
        metadata: { invitation },
      }),
    );

  async function participants(eventId: string) {
    const answer = await call("GET", `/api/events/${eventId}/people`);
    expect(answer.status).toBe(200);
    return peopleBody.parse(answer.body).people;
  }

  it("lists the organizer, an accepted, a tentative and a not-invited participant of 'Schuzka s klientem'", async () => {
    const meeting = await create(eventsId, { name: "Schuzka s klientem", date: "2026-11-16" });
    const me = await create(peopleId, { name: "Zdenek" });
    const petr = await create(peopleId, { name: "Petr", relationship: "client", emails: "Petr@Example.com" });
    const jana = await create(peopleId, { name: "Jana" });
    const karel = await create(peopleId, { name: "Karel" });
    expect((await call("PUT", "/api/auth/self-person", { personId: me })).status).toBe(200);
    expect((await put(meeting, me, { metadata: { role: "organizer" } })).status).toBe(200);
    expect((await put(meeting, karel)).status).toBe(200);
    const accepted = { status: "accepted", email: "petr@example.com", mailboxId: MAILBOX_ID };
    const tentative = { status: "tentative", email: "jana@example.com", mailboxId: MAILBOX_ID };
    await invite(meeting, petr, accepted);
    await invite(meeting, jana, tentative);

    expect(await participants(meeting)).toEqual([
      { personId: me, name: "Zdenek", relationship: null, emails: [], role: "organizer", invitation: null },
      { personId: jana, name: "Jana", relationship: null, emails: [], role: "attendee", invitation: tentative },
      { personId: karel, name: "Karel", relationship: null, emails: [], role: "attendee", invitation: null },
      {
        personId: petr,
        name: "Petr",
        relationship: "client",
        emails: ["petr@example.com"],
        role: "attendee",
        invitation: accepted,
      },
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown key", { note: "x" }],
    ["a role outside the two roles", { role: "owner" }],
    [
      "an invitation status outside the four statuses",
      { invitation: { status: "sent", email: "a@b.cz", mailboxId: MAILBOX_ID } },
    ],
  ])("answers a PUT with %s in the metadata with 400 validation_failed on metadata", async (_label, metadata) => {
    const meeting = await create(eventsId, { name: "Planning", date: "2026-11-16" });
    const karel = await create(peopleId, { name: "Karel" });
    const refused = await put(meeting, karel, { metadata });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: { code: "validation_failed", details: { field: "metadata", reason: "invalidParticipantMetadata" } },
    });
    expect(await participants(meeting)).toEqual([]);
  });

  it("answers a PUT that adds, changes or removes an invitation with 400, keeps the stored edge, and accepts a PUT that repeats it", async () => {
    const meeting = await create(eventsId, { name: "Planning", date: "2026-11-16" });
    const petr = await create(peopleId, { name: "Petr" });
    const karel = await create(peopleId, { name: "Karel" });
    const pending = { status: "pending", email: "petr@example.com", mailboxId: MAILBOX_ID };
    await invite(meeting, petr, pending);
    expect((await put(meeting, karel)).status).toBe(200);
    const before = await participants(meeting);
    expect(before.map((entry) => entry.invitation)).toEqual([null, pending]);

    const attempts: Array<[string, unknown]> = [
      [karel, { metadata: { invitation: pending } }],
      [petr, { metadata: { invitation: { ...pending, status: "accepted" } } }],
      [petr, { metadata: {} }],
      [petr, undefined],
    ];
    for (const [personId, body] of attempts) {
      const refused = await put(meeting, personId, body);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        error: { code: "validation_failed", details: { field: "metadata", reason: "invitationReadOnly" } },
      });
    }
    expect(await participants(meeting)).toEqual(before);

    expect((await put(meeting, petr, { metadata: { role: "attendee", invitation: pending } })).status).toBe(200);
    expect(await participants(meeting)).toEqual(before);
  });

  it("refuses an agent's relation.put over MCP that names the person in another text form of its UUID, and keeps the stored invitation", async () => {
    const meeting = await create(eventsId, { name: "Planning", date: "2026-11-16" });
    const petr = await create(peopleId, { name: "Petr" });
    const accepted = { status: "accepted", email: "petr@example.com", mailboxId: MAILBOX_ID };
    await invite(meeting, petr, accepted);
    const before = await participants(meeting);
    expect(before.map((entry) => entry.invitation)).toEqual([accepted]);

    const projectItemId = await createTestProjectItem(pool);
    const { token } = await withTransaction(pool, (client) =>
      mintMcpRunCredential(client, { projectItemId, capabilities: ["core.item.write"], userId }),
    );
    const mcpServer = createServer(
      await createMcpRequestListener(
        pool,
        createGenericOperationGateway(pool, testMetadataResolver),
        new Set(CAPABILITY_IDS),
        new ModuleRegistry(() => new Set()),
      ),
    );
    await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
    try {
      const address = mcpServer.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
      const relationPut = async (args: Record<string, unknown>) => {
        const res = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "semprec.relation.put", arguments: args },
          }),
        });
        expect(res.status).toBe(200);
        return mcpError.parse(await res.json()).error;
      };
      const edge = { relationPropertyId: eventsPeopleId, callerItemId: meeting };

      // Postgres reads both as Petr's id, so the write would meet his stored edge and replace its metadata.
      for (const targetItemId of [`{${petr}}`, petr.replaceAll("-", "")]) {
        expect(await relationPut({ ...edge, targetItemId })).toEqual({
          code: -32602,
          data: { field: "targetItemId", reason: "nonCanonicalItemId" },
        });
      }
      // The same call with the id as stored is judged against the stored invitation.
      expect(await relationPut({ ...edge, targetItemId: petr })).toEqual({
        code: -32602,
        data: { field: "metadata", reason: "invitationReadOnly" },
      });
    } finally {
      await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    }
    expect(await participants(meeting)).toEqual(before);
  });

  it("answers 404 for an unknown Event and 400 for an id that is not a UUID", async () => {
    const unknown = await call("GET", `/api/events/${randomUUID()}/people`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: { code: "not_found" } });
    const malformed = await call("GET", "/api/events/not-a-uuid/people");
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: "validation_failed", details: { field: "id" } } });
  });
});
