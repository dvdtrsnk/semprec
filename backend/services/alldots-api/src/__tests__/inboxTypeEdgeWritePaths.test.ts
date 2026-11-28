import { ModuleRegistry } from "@alldots/module-registry";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, runOnce, type TaskList } from "@alldots/queue";
import { readJobPayloadsByIdentifier } from "@alldots/queue/testSupport";
import {
  createInboxItemWithClient,
  createTestProjectItem,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
} from "@alldots/data/testSupport";
import {
  createActionRegistry,
  createAgentRun,
  createApiCoreTaskList,
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
  type ChokePoint,
  type CollectionMetadataResolver,
  type PasswordResetMailer,
} from "@alldots/data";
import { createGenericOperationGateway } from "@alldots/application";
import { CAPABILITY_IDS, type AuthenticatedActor } from "@alldots/shared";
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
const tmpBlobDir = join(tmpdir(), `alldots-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const TICK_TASK = CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE;
const RECOMPUTE_TASK = CORE_TASK_NAMES.JOURNAL_INBOX_RECOMPUTE;
const DAY = "2026-10-16";

const TRANSPORTS = ["rest", "agent", "mcp"] as const;
type Transport = (typeof TRANSPORTS)[number];

const jobEnvelope = z.object({ tenantId: z.string().nullable(), payload: z.record(z.string(), z.unknown()) });
const mcpResult = z.object({
  result: z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) }),
});
const daySummary = z.array(
  z.object({
    id: z.string(),
    type: z.object({ id: z.string(), name: z.string(), emoji: z.string() }).nullable(),
  }),
);

let pool: Pool;
let chokePoint: ChokePoint;

describe("an Inbox type edge re-runs the tick and the day summary for every writer (issue #1718)", () => {
  let server: Server;
  let mcpServer: Server;
  let baseUrl: string;
  let mcpUrl: string;
  let headers: Record<string, string>;
  let mcpToken: string;
  let agentActor: AuthenticatedActor;
  let inboxId: string;
  let typesId: string;
  let journalId: string;
  let typePropertyId: string;
  let updateHeartbeatId: string;
  const gateway = () => createGenericOperationGateway(pool, testMetadataResolver);

  async function listen(s: Server): Promise<string> {
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  async function databaseIdFor(moduleId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE owner_module_id = $1 AND system",
      [moduleId],
    );
    if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
    return rows[0].id;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    journalId = await databaseIdFor("journal");
    const typeProperty = (await chokePoint.listProperties(inboxId)).find((property) => property.key === "type");
    if (!typeProperty) throw new Error("The Inbox 'type' property was not seeded");
    typePropertyId = typeProperty.id;
    const heartbeats = await pool.query<{ id: string }>(
      `SELECT id FROM project_heartbeats
       WHERE rule ->> 'kind' = 'onItemEvent' AND rule ->> 'databaseId' = $1 AND rule ->> 'event' = 'update'`,
      [inboxId],
    );
    if (!heartbeats.rows[0]) throw new Error("The Inbox 'update' heartbeat was not seeded");
    updateHeartbeatId = heartbeats.rows[0].id;

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const projectItemId = await createTestProjectItem(pool);
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "sort the inbox" });
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

  async function createType(name: string, emoji: string): Promise<string> {
    const type = await inTenantZero(() =>
      chokePoint.createItem({ databaseId: typesId, properties: { name, emoji, processingMethod: "pageContent" } }),
    );
    return type.id;
  }

  async function capture(text: string, typeId?: string): Promise<string> {
    const item = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createInboxItemWithClient(client, { inboxDatabaseId: inboxId, date: DAY, time: "09:00", text, type: typeId }),
      ),
    );
    return item.id;
  }

  async function dayOf(inboxItemId: string): Promise<string> {
    const relations = await inTenantZero(() => chokePoint.listItemRelations(inboxItemId));
    const day = relations?.find((relation) => relation.propertyKey === "journalDay");
    if (!day) throw new Error("The Inbox item has no journalDay edge");
    return day.targetItemId;
  }

  async function summaryTypeOf(journalDayItemId: string, inboxItemId: string) {
    const day = await inTenantZero(() => chokePoint.getItem(journalId, journalDayItemId));
    const entry = daySummary.parse(day?.computed.inboxItems).find((candidate) => candidate.id === inboxItemId);
    if (!entry) throw new Error("The day summary does not list the Inbox item");
    return entry.type;
  }

  async function queued(task: string): Promise<Array<z.infer<typeof jobEnvelope>>> {
    return (await readJobPayloadsByIdentifier(pool, task)).map((raw) => {
      const { tenantId, payload } = jobEnvelope.parse(raw);
      return { tenantId, payload };
    });
  }

  async function tickAndRecomputeJobs() {
    return { tick: await queued(TICK_TASK), recompute: await queued(RECOMPUTE_TASK) };
  }

  /** The item's update tick and its day's recompute. */
  function jobsFor(inboxItemId: string, journalDayItemId: string) {
    const tenantId = getTenantZeroId();
    return {
      tick: [{ tenantId, payload: { heartbeatId: updateHeartbeatId, itemId: inboxItemId } }],
      recompute: [{ tenantId, payload: { journalDayItemId } }],
    };
  }

  /**
   * Runs every queued job with a no-op handler, so a later enqueue is a new row instead of a keyed update of the
   * fixture's job. Repeats while it makes progress, since one run may leave a serialized lane's jobs for the next.
   */
  async function discardQueuedJobs(): Promise<void> {
    let remaining = Number.POSITIVE_INFINITY;
    for (;;) {
      const { rows } = await pool.query<{ task_identifier: string }>(
        "SELECT task_identifier FROM graphile_worker.jobs ORDER BY id",
      );
      if (rows.length === 0) return;
      if (rows.length >= remaining) throw new Error(`Queued jobs stopped draining: ${JSON.stringify(rows)}`);
      remaining = rows.length;
      const taskList: TaskList = Object.fromEntries(rows.map((row) => [row.task_identifier, async () => {}]));
      await runOnce({ pgPool: pool }, taskList);
    }
  }

  async function runRecomputeJobs(): Promise<void> {
    const handler = createApiCoreTaskList(pool, createActionRegistry())[RECOMPUTE_TASK];
    if (!handler) throw new Error("The Journal Inbox recompute handler is missing from the API task list");
    await runOnce({ pgPool: pool }, { [RECOMPUTE_TASK]: handler });
    expect(await queued(RECOMPUTE_TASK)).toEqual([]);
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

  async function putTypeVia(transport: Transport, inboxItemId: string, typeId: string): Promise<void> {
    const input = { relationPropertyId: typePropertyId, callerItemId: inboxItemId, targetItemId: typeId };
    if (transport === "rest") {
      const res = await fetch(`${baseUrl}/api/items/${inboxItemId}/relations/type/${typeId}`, {
        method: "PUT",
        headers,
      });
      expect(res.status).toBe(200);
      return;
    }
    if (transport === "agent") {
      // An agent run calls the gateway from its job, inside the run's tenant.
      await inTenantZero(() => gateway().invoke("relation.put", agentActor, new Set(CAPABILITY_IDS), input));
      return;
    }
    mcpResult.parse(await mcpCall("alldots.relation.put", input));
  }

  it("PUT /api/items/:id/relations/type/:typeId enqueues the tick and the day recompute, and the day summary shows the new type", async () => {
    const typeId = await createType("Note", "N");
    const itemId = await capture("Buy milk");
    const dayId = await dayOf(itemId);
    await runRecomputeJobs();
    expect(await summaryTypeOf(dayId, itemId)).toBeNull();
    await discardQueuedJobs();

    await putTypeVia("rest", itemId, typeId);

    expect(await tickAndRecomputeJobs()).toEqual(jobsFor(itemId, dayId));
    await runRecomputeJobs();
    expect(await summaryTypeOf(dayId, itemId)).toEqual({ id: typeId, name: "Note", emoji: "N" });
  });

  it("DELETE of the type edge enqueues the tick and the day recompute, and the day summary drops the type", async () => {
    const typeId = await createType("Note", "N");
    const itemId = await capture("Buy milk", typeId);
    const dayId = await dayOf(itemId);
    await runRecomputeJobs();
    expect(await summaryTypeOf(dayId, itemId)).toEqual({ id: typeId, name: "Note", emoji: "N" });
    await discardQueuedJobs();

    const res = await fetch(`${baseUrl}/api/items/${itemId}/relations/type/${typeId}`, { method: "DELETE", headers });

    expect(res.status).toBe(200);
    expect(await tickAndRecomputeJobs()).toEqual(jobsFor(itemId, dayId));
    await runRecomputeJobs();
    expect(await summaryTypeOf(dayId, itemId)).toBeNull();
  });

  it("an agent run's relation.put and the MCP tool enqueue the same jobs for the type edge as the REST endpoint", async () => {
    const typeId = await createType("Note", "N");
    for (const transport of TRANSPORTS) {
      const itemId = await capture(`Written through ${transport}`);
      const dayId = await dayOf(itemId);
      await discardQueuedJobs();

      await putTypeVia(transport, itemId, typeId);

      expect(await tickAndRecomputeJobs(), transport).toEqual(jobsFor(itemId, dayId));
    }
  });
});
