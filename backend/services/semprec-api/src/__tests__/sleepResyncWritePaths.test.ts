import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { CollectionMetadataResolver } from "@semprec/data";
import { createTestProjectItem, getTenantZeroId, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createUser,
  createViewTypeRegistry,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  type PasswordResetMailer,
} from "@semprec/data";
import { createGenericOperationGateway } from "@semprec/application";
import { CAPABILITY_IDS, runInTenant, type AuthenticatedActor } from "@semprec/shared";
import { createDispatcher } from "../app.js";

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
const NIGHT = "2026-10-16";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const itemBody = z.object({ id: z.string(), updatedAt: z.string() }).passthrough();

let pool: Pool;

describe("the sleep resync push through REST, the agent gateway and the queue handler (issue gh-1838)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let agentActor: AuthenticatedActor;
  let planId: string;
  let plansDatabaseId: string;
  const gateway = () => createGenericOperationGateway(pool, testMetadataResolver);

  /** The keys of the pending `sleep.resync` jobs, read through the public view of the queue schema. */
  async function resyncKeys(): Promise<string[]> {
    const { rows } = await pool.query<{ key: string }>(
      "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'sleep.resync' ORDER BY key",
    );
    return rows.map((row) => row.key);
  }

  async function clearResyncJobs(): Promise<void> {
    for (const key of await resyncKeys()) await pool.query("SELECT graphile_worker.remove_job($1)", [key]);
  }

  const resyncKey = () => `sleep-resync:${getTenantZeroId()}`;

  async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  /** The `updatedAt` the API reports for the plan, which a patch sends back as `ifVersion`. */
  async function planVersion(): Promise<string> {
    return itemBody.parse((await rest("GET", `/api/items/${planId}`)).body).updatedAt;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM databases WHERE system AND owner_module_id = 'sleepPlans'",
    );
    plansDatabaseId = rows[0]?.id ?? "";
    const plans = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL ORDER BY id",
      [plansDatabaseId],
    );
    planId = plans.rows[0]?.id ?? "";

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const projectItemId = await createTestProjectItem(pool);
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "plan my sleep" });
    agentActor = { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId };
    // The Sleep databases are sensitive, so the data layer closes them to an agent's project until the user grants
    // write access (issue gh-1810). The user-only admin store is not exported from `@semprec/data`, so the fixture
    // stores the decision with the statement of `setAgentDatabaseGrant`.
    const grant = await pool.query(
      `INSERT INTO agent_database_grants (project_item_id, database_id, access)
         SELECT $1, id, 'write' FROM databases WHERE id = $2`,
      [projectItemId, plansDatabaseId],
    );
    expect(grant.rowCount).toBe(1);

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
    await clearResyncJobs();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("enqueues one resync for a REST patch of a plan, and still one for a second patch", async () => {
    expect(await resyncKeys()).toEqual([]);

    const first = await rest("PATCH", `/api/items/${planId}`, {
      properties: { bedTime: "22:30" },
      ifVersion: await planVersion(),
    });
    expect(first.status).toBe(200);
    expect(await resyncKeys()).toEqual([resyncKey()]);

    const second = await rest("PATCH", `/api/items/${planId}`, {
      properties: { bedTime: "22:40" },
      ifVersion: await planVersion(),
    });
    expect(second.status).toBe(200);
    expect(await resyncKeys()).toEqual([resyncKey()]);
  });

  it("enqueues a resync for an agent's item.patch on a sleep item", async () => {
    await gateway().invoke("item.patch", agentActor, new Set(CAPABILITY_IDS), {
      itemId: planId,
      properties: { wakeTime: "06:10" },
      ifVersion: await planVersion(),
    });

    expect(await resyncKeys()).toEqual([resyncKey()]);
  });

  it("enqueues a resync for a PUT that changes a night, and none for a PUT that writes nothing", async () => {
    const noop = await rest("PUT", `/api/sleep/nights/${NIGHT}`, { bedTime: null, wakeTime: null });
    expect(noop.status).toBe(200);
    expect(await resyncKeys()).toEqual([]);

    const changed = await rest("PUT", `/api/sleep/nights/${NIGHT}`, { wakeTime: "07:30" });
    expect(changed.status).toBe(200);
    expect(await resyncKeys()).toEqual([resyncKey()]);
  });

  it("enqueues nothing for a REST patch that the sleep rules refuse", async () => {
    const refused = await rest("PATCH", `/api/items/${planId}`, {
      properties: { bedTime: "25:00" },
      ifVersion: await planVersion(),
    });

    expect(refused.status).toBe(400);
    expect(await resyncKeys()).toEqual([]);
  });

  it("adds no notification and leaves GET /api/notifications/unread as it was when the queue runs the job", async () => {
    const registration = await rest("POST", "/api/push-subscriptions", {
      channel: "apns",
      platform: "ios",
      deviceToken: randomBytes(32).toString("hex"),
      apnsEnvironment: "sandbox",
    });
    expect(registration.status).toBe(200);
    const patched = await rest("PATCH", `/api/items/${planId}`, {
      properties: { bedTime: "22:30" },
      ifVersion: await planVersion(),
    });
    expect(patched.status).toBe(200);
    expect(await resyncKeys()).toEqual([resyncKey()]);
    const unreadBefore = await rest("GET", "/api/notifications/unread");
    const countsBefore = await tableCounts();
    const definition = (await moduleRegistry.getTaskDefinitions()).find((task) => task.name === "sleep.resync");
    if (!definition) throw new Error("The module registry has no sleep.resync task");

    // The handler as the queue runs it: the payload parsed with the module's schema, in the tenant of the job's
    // envelope. APNs is not configured in the test environment, so the push is reported as not sent.
    const payload = definition.payloadSchema.parse({ tenantId: getTenantZeroId() });
    await runInTenant(getTenantZeroId(), () =>
      definition.handler(payload, {
        withPgClient: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
          const client = await pool.connect();
          try {
            return await fn(client);
          } finally {
            client.release();
          }
        },
      }),
    );

    expect(await tableCounts()).toEqual(countsBefore);
    const unreadAfter = await rest("GET", "/api/notifications/unread");
    expect(unreadAfter).toEqual(unreadBefore);
    expect(unreadAfter.status).toBe(200);
  });
});

async function tableCounts(): Promise<{ notifications: number; deliveries: number }> {
  const { rows } = await pool.query<{ notifications: number; deliveries: number }>(
    "SELECT (SELECT count(*) FROM notifications)::int AS notifications, (SELECT count(*) FROM push_deliveries)::int AS deliveries",
  );
  return rows[0] ?? { notifications: -1, deliveries: -1 };
}
