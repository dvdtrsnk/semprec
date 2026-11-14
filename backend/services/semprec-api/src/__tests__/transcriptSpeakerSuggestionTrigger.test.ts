import { ModuleRegistry } from "@semprec/module-registry";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { createTestProjectItem, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
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
const createdItem = z.object({ id: z.string() }).passthrough();

let pool: Pool;

/**
 * The trigger of the speaker suggestion (issue gh-1942) fires for an edge written by `semprec-api`: the generic edge
 * `PUT` of the route matrix, and the generic operation gateway that Semp's tools and every MCP client write through.
 */
describe("the speaker suggestion trigger over the generic edge writes (issue gh-1942)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let userId: string;
  let transcriptsId: string;
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
    transcriptsId = databaseId("transcripts");
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

  async function speakerJobKeys(): Promise<string[]> {
    const { rows } = await pool.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'transcriptSpeakerSuggestion' ORDER BY key",
    );
    return rows.map((row) => row.key);
  }

  async function clearJobs(): Promise<void> {
    await pool.query("TRUNCATE graphile_worker._private_jobs RESTART IDENTITY CASCADE");
  }

  it("enqueues the job of a transcript for the edge the generic PUT writes to its Event, and for a participant PUT", async () => {
    const transcriptId = await create(transcriptsId, { name: "Weekly sync" });
    const eventId = await create(eventsId, { name: "Weekly sync", date: "2026-11-16" });
    const personId = await create(peopleId, { name: "Alice" });
    await clearJobs();

    expect((await call("PUT", `/api/items/${transcriptId}/relations/event/${eventId}`)).status).toBe(200);
    expect(await speakerJobKeys()).toEqual([`transcript-speaker-suggestion:${transcriptId}`]);
    await clearJobs();

    expect((await call("PUT", `/api/items/${eventId}/relations/people/${personId}`)).status).toBe(200);
    expect(await speakerJobKeys()).toEqual([`transcript-speaker-suggestion:${transcriptId}`]);
  });

  it("enqueues it for a participant that a Semp or MCP relation.put adds to the Event of a transcript", async () => {
    const transcriptId = await create(transcriptsId, { name: "Weekly sync" });
    const eventId = await create(eventsId, { name: "Weekly sync", date: "2026-11-16" });
    const personId = await create(peopleId, { name: "Alice" });
    expect((await call("PUT", `/api/items/${transcriptId}/relations/event/${eventId}`)).status).toBe(200);
    await clearJobs();
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
      const res = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "semprec.relation.put",
            arguments: { relationPropertyId: eventsPeopleId, callerItemId: eventId, targetItemId: personId },
          },
        }),
      });
      expect(res.status).toBe(200);
      expect(z.object({ result: z.unknown() }).safeParse(await res.json()).success).toBe(true);
    } finally {
      await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    }

    expect(await speakerJobKeys()).toEqual([`transcript-speaker-suggestion:${transcriptId}`]);
  });
});
