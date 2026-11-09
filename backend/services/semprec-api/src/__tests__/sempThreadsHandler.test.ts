import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureMailAccountSyncState,
  getTestPool,
  reconcileGmailAccount,
  resetDatabase,
  type GmailMailClient,
  startTaskSeries,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createDocStore,
  createHeartbeat,
  createItemWithClient,
  createPendingApprovalRequest,
  createRelationWithClient,
  enqueueSempMessage,
  createSempChatThread,
  claimSempMessage,
  createUser,
  finishAgentRun,
  getDatabaseByModuleId,
  handleAgentRunEventsRetentionTask,
  hashPassword,
  insertAgentRunEvent,
  insertSempUserTurn,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  resolveMailModuleIds,
  sendSempMessage,
  seedSystem,
  startSempMessageTurn,
  listSempThreadMessages,
  updateItemWithClient,
  withTransaction,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

let admin: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;
describe("durable Semp thread history", () => {
  const repeatedRunId = randomUUID();
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
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://example.test",
      setupToken: "test",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-thread-test-${randomUUID()}`)),
      maxFileSizeBytes: 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await pool?.end();
    await admin?.end();
  });
  it("projects system message fields and rejects malformed ids", async () => {
    const tenant = await createTestTenant(admin);
    const email = `${randomUUID()}@example.test`;
    const user = await createUser(admin, {
      tenantId: tenant,
      email,
      passwordHash: await hashPassword("thread-test-password"),
    });
    const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
    const fixture = await runInTenant(tenant, async () => {
      const thread = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
      const threadId = thread.rows[0]?.id;
      if (!threadId || thread.rowCount !== 1) throw new Error("Missing thread");
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "history",
        userId: user.id,
        threadId,
      });
      const original = await pool.query<{ id: string }>(
        "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', 'hello') RETURNING id",
        [threadId],
      );
      const replyId = original.rows[0]?.id;
      if (!replyId || original.rowCount !== 1) throw new Error("Missing user message");
      const system = await pool.query<{ id: string }>(
        `INSERT INTO semp_messages (thread_id, role, system_key, system_params, context, reply_to_message_id, agent_run_id, event_from_id, status)
        VALUES ($1, 'system', 'system.test', '{"count":2}'::jsonb, '[{"ref":"x"}]'::jsonb, $2, $3, 123, 'done') RETURNING id`,
        [threadId, replyId, run.id],
      );
      const id = system.rows[0]?.id;
      if (!id || system.rowCount !== 1) throw new Error("Missing system message");
      const failedRun = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "failed",
        userId: user.id,
        threadId,
      });
      expect(await finishAgentRun(pool, failedRun.id, "error", null, "internal")).toBe(true);
      const failed = await pool.query<{ id: string }>(
        "INSERT INTO semp_messages (thread_id, role, agent_run_id, status) VALUES ($1, 'assistant', $2, 'error') RETURNING id",
        [threadId, failedRun.id],
      );
      const failedId = failed.rows[0]?.id;
      if (!failedId || failed.rowCount !== 1) throw new Error("Missing failed message");
      return { threadId, id, replyId, runId: run.id, failedId };
    });
    const headers = { authorization: `Bearer ${session.token}` };
    const response = await fetch(`${baseUrl}/api/semp/threads/${fixture.threadId}/messages`, { headers });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          id: fixture.id,
          role: "system",
          text: null,
          system: { key: "system.test", params: { count: 2 } },
          context: [{ ref: "x" }],
          replyToMessageId: fixture.replyId,
          agentRunId: fixture.runId,
          eventFromId: "123",
          status: "done",
          createdAt: expect.any(String),
          run: { startedAt: expect.any(String), finishedAt: null, status: "running" },
        }),
        expect.objectContaining({ id: fixture.replyId, run: null }),
        expect.objectContaining({
          id: fixture.failedId,
          run: { startedAt: expect.any(String), finishedAt: expect.any(String), status: "error" },
        }),
      ]),
    });
    await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const query = vi.spyOn(client, "query");
        try {
          await listSempThreadMessages(client, fixture.threadId, 1, null);
          expect(query).toHaveBeenCalledTimes(1);
          query.mockClear();
          await listSempThreadMessages(client, fixture.threadId, 50, null);
          expect(query).toHaveBeenCalledTimes(1);
        } finally {
          query.mockRestore();
        }
      }),
    );
    expect(await runInTenant(tenant, () => finishAgentRun(pool, fixture.runId, "done", null))).toBe(true);
    const finished = await fetch(`${baseUrl}/api/semp/threads/${fixture.threadId}/messages`, { headers });
    expect(finished.status).toBe(200);
    const finishedBody: unknown = await finished.json();
    expect(finishedBody).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          id: fixture.id,
          run: { startedAt: expect.any(String), finishedAt: expect.any(String), status: "done" },
        }),
        expect.objectContaining({ id: fixture.replyId, run: null }),
      ]),
    });
    for (const suffix of ["", "/messages"]) {
      expect((await fetch(`${baseUrl}/api/semp/threads/not-a-uuid${suffix}`, { headers })).status).toBe(400);
    }
  });
  it("returns old thread history after the real retention task removes an eligible event", async () => {
    const tenant = await createTestTenant(admin);
    const email = `${randomUUID()}@example.test`;
    const user = await createUser(admin, {
      tenantId: tenant,
      email,
      passwordHash: await hashPassword("thread-test-password"),
    });
    const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
    const fixture = await runInTenant(tenant, async () => {
      const thread = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
      const threadId = thread.rows[0]?.id;
      if (!threadId || thread.rowCount !== 1) throw new Error("Missing thread");
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "history",
        userId: user.id,
        threadId,
      });
      const expired = await insertAgentRunEvent(pool, run.id, "message", { kind: "message" });
      const checkpoint = await insertAgentRunEvent(pool, run.id, "compaction", { kind: "compaction" });
      const retained = await insertAgentRunEvent(pool, run.id, "message", { kind: "message" });
      expect(await finishAgentRun(pool, run.id, "done", null)).toBe(true);
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      const backdated = await pool.query("UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1", [run.id, old]);
      expect(backdated.rowCount).toBe(3);
      const message = await pool.query<{ id: string }>(
        "INSERT INTO semp_messages (thread_id, role, text, agent_run_id, created_at) VALUES ($1, 'assistant', 'old history', $2, $3) RETURNING id",
        [threadId, run.id, old],
      );
      const messageId = message.rows[0]?.id;
      if (!messageId || message.rowCount !== 1) throw new Error("Missing message");
      const before = await pool.query<{ id: string }>(
        "SELECT id FROM agent_run_events WHERE id = ANY($1::bigint[]) ORDER BY id",
        [[expired.id, checkpoint.id, retained.id]],
      );
      expect(before.rows.map((row) => row.id)).toEqual([expired.id, checkpoint.id, retained.id]);
      return { threadId, expired: expired.id, checkpoint: checkpoint.id, retained: retained.id, messageId };
    });
    const result = await runAsSystem("test:retention", () => handleAgentRunEventsRetentionTask(pool));
    expect(result.deleted).toBe(1);
    const remaining = await runInTenant(tenant, () =>
      pool.query<{ id: string }>("SELECT id FROM agent_run_events WHERE id = ANY($1::bigint[]) ORDER BY id", [
        [fixture.expired, fixture.checkpoint, fixture.retained],
      ]),
    );
    expect(remaining.rows.map((row) => row.id)).toEqual([fixture.checkpoint, fixture.retained]);
    const response = await fetch(`${baseUrl}/api/semp/threads/${fixture.threadId}/messages`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ rows: [{ id: fixture.messageId, text: "old history" }], nextCursor: null });
  });

  it("does not expose run data through another tenant's thread id", async () => {
    const ownerTenant = await createTestTenant(admin);
    const foreignTenant = await createTestTenant(admin);
    const ownerEmail = `${randomUUID()}@example.test`;
    const foreignEmail = `${randomUUID()}@example.test`;
    for (const [tenantId, email] of [
      [ownerTenant, ownerEmail],
      [foreignTenant, foreignEmail],
    ] as const) {
      await createUser(admin, { tenantId, email, passwordHash: await hashPassword("thread-test-password") });
    }
    const ownerSession = await login(admin, {
      email: ownerEmail,
      password: "thread-test-password",
      platform: "ios",
      ip: "127.0.0.1",
    });
    const foreignSession = await login(admin, {
      email: foreignEmail,
      password: "thread-test-password",
      platform: "ios",
      ip: "127.0.0.1",
    });
    const threadId = await runInTenant(ownerTenant, () =>
      withTransaction(pool, async (client) => {
        const id = await createSempChatThread(client);
        const turn = await insertSempUserTurn(client, id, "Question", []);
        expect(await claimSempMessage(client, id, turn.assistantMessageId)).toBe(true);
        const run = await createAgentRun(client, {
          triggeredBy: "user",
          unit: "session",
          task: "private",
          threadId: id,
        });
        const event = await insertAgentRunEvent(client, run.id, "message", { kind: "message", text: "private" });
        await startSempMessageTurn(client, turn.assistantMessageId, run.id, event.id);
        return id;
      }),
    );
    const owner = await fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, {
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    expect(owner.status).toBe(200);
    const ownerBody: unknown = await owner.json();
    expect(ownerBody).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ run: expect.objectContaining({ status: "running", finishedAt: null }) }),
      ]),
    });
    const headers = { authorization: `Bearer ${foreignSession.token}` };
    const foreign = await fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, { headers });
    const unknown = await fetch(`${baseUrl}/api/semp/threads/${randomUUID()}/messages`, { headers });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(foreign.status);
    expect(await foreign.text()).toBe(await unknown.text());
    const ownerAfter = await fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, {
      headers: { authorization: `Bearer ${ownerSession.token}` },
    });
    expect(await ownerAfter.json()).toEqual(ownerBody);
  });

  it("rolls back a visible queued job together with the new thread and messages", async () => {
    const tenant = await createTestTenant(admin);
    let threadId = "";
    let messageId = "";
    let assistantId = "";
    await expect(
      runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const turn = await sendSempMessage(client, { text: "Rollback", context: [], hasContext: false });
          ({ threadId, messageId, assistantMessageId: assistantId } = turn);
          const job = await client.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
            `sempMessage:${assistantId}`,
          ]);
          expect(job.rows).toEqual([{ key: `sempMessage:${assistantId}` }]);
          throw new Error("rollback sentinel");
        }),
      ),
    ).rejects.toThrow("rollback sentinel");
    const remaining = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => ({
        threads: await client.query("SELECT id FROM semp_threads WHERE id = $1", [threadId]),
        messages: await client.query("SELECT id FROM semp_messages WHERE id = ANY($1::uuid[])", [
          [messageId, assistantId],
        ]),
        jobs: await client.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [`sempMessage:${assistantId}`]),
      })),
    );
    expect(remaining.threads.rows).toEqual([]);
    expect(remaining.messages.rows).toEqual([]);
    expect(remaining.jobs.rows).toEqual([]);
  });

  it.each([
    {
      context: [{ kind: "item", itemId: randomUUID(), databaseId: randomUUID() }, { kind: "unknown" }],
      field: "context[1]",
    },
    { context: Array.from({ length: 21 }, () => ({ kind: "agentRun", agentRunId: repeatedRunId })), field: "context" },
  ])(
    "rejects malformed or oversized context on both message routes without writes: $field",
    async ({ context, field }) => {
      const tenant = await createTestTenant(admin);
      const email = `${randomUUID()}@example.test`;
      await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword("thread-test-password") });
      const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
      const threadId = await runInTenant(tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
      const snapshot = () =>
        runInTenant(tenant, async () => {
          const threads = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_threads");
          const messages = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages");
          const jobs = await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE queue_name = $1",
            [`semp-chat:${tenant}`],
          );
          return { threads: threads.rows, messages: messages.rows, jobs: jobs.rows };
        });
      const before = await snapshot();
      for (const path of ["/api/semp/threads", `/api/semp/threads/${threadId}/messages`]) {
        const response = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
          body: JSON.stringify({ text: "question", context }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation_failed", details: { field } } });
        expect(await snapshot()).toEqual(before);
      }
    },
  );

  it("accepts owned and trashed item refs and refuses foreign, random and mismatched refs without effects", async () => {
    const tenant = await createTestTenant(admin);
    const foreignTenant = await createTestTenant(admin);
    const email = `${randomUUID()}@example.test`;
    await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword("thread-test-password") });
    const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
    const createFixture = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        await seedSystem(pool);
        const databases = await withTransaction(pool, async (client) => {
          const tasks = await getDatabaseByModuleId(client, "tasks");
          const events = await getDatabaseByModuleId(client, "events");
          if (!tasks || !events) throw new Error("Missing system databases");
          return { tasks: tasks.id, events: events.id };
        });
        const item = await createChokePoint(pool).createItem({
          databaseId: databases.tasks,
          properties: { name: "Task" },
        });
        return { itemId: item.id, databaseId: databases.tasks, otherDatabaseId: databases.events };
      });
    const own = await createFixture(tenant);
    const foreign = await createFixture(foreignTenant);
    const threadId = await runInTenant(tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
    const post = (ref: unknown) =>
      fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "question", context: [ref] }),
      });
    expect((await post({ kind: "item", itemId: own.itemId, databaseId: own.databaseId })).status).toBe(202);
    const snapshot = () =>
      runInTenant(tenant, async () => {
        const messages = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1",
          [threadId],
        );
        const jobs = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE queue_name = $1",
          [`semp-chat:${tenant}`],
        );
        return { messages: messages.rows, jobs: jobs.rows };
      });
    const before = await snapshot();
    let foreignBody: unknown;
    for (const [index, ref] of [
      { kind: "item", itemId: foreign.itemId, databaseId: foreign.databaseId },
      { kind: "item", itemId: randomUUID(), databaseId: randomUUID() },
      { kind: "item", itemId: own.itemId, databaseId: own.otherDatabaseId },
    ].entries()) {
      const response = await post(ref);
      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ error: { code: "validation_failed", details: { field: "context[0]" } } });
      if (index === 0) foreignBody = body;
      if (index === 1) expect(body).toEqual(foreignBody);
      expect(await snapshot()).toEqual(before);
    }
    await runInTenant(tenant, () => createChokePoint(pool).softDeleteItem(own.databaseId, own.itemId));
    expect((await post({ kind: "item", itemId: own.itemId, databaseId: own.databaseId })).status).toBe(202);
  });

  it("accepts and stores task occurrence and trace refs, and refuses foreign, unknown, deleted and non-task ones without effects", async () => {
    const tenant = await createTestTenant(admin);
    const foreignTenant = await createTestTenant(admin);
    const email = `${randomUUID()}@example.test`;
    await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword("thread-test-password") });
    const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
    const createFixture = (tenantId: string) =>
      runInTenant(tenantId, async () => {
        await seedSystem(pool);
        const databases = await withTransaction(pool, async (client) => {
          const tasks = await getDatabaseByModuleId(client, "tasks");
          const projects = await getDatabaseByModuleId(client, "projects");
          if (!tasks || !projects) throw new Error("Missing system databases");
          return { tasks: tasks.id, projects: projects.id };
        });
        const chokePoint = createChokePoint(pool);
        const task = await chokePoint.createItem({
          databaseId: databases.tasks,
          properties: { name: "Weekly review", date: "2026-11-02" },
        });
        const deleted = await chokePoint.createItem({
          databaseId: databases.tasks,
          properties: { name: "Deleted", date: "2026-11-03" },
        });
        const project = await chokePoint.createItem({ databaseId: databases.projects, properties: { name: "Apollo" } });
        const seriesId = await startTaskSeries(pool, {
          databaseId: databases.tasks,
          itemId: task.id,
          mode: "fixed",
          rule: { kind: "weekdays", days: ["mon"] },
        });
        await chokePoint.softDeleteItem(databases.tasks, deleted.id);
        return { ...databases, task, deleted, project, seriesId };
      });
    const own = await createFixture(tenant);
    const foreign = await createFixture(foreignTenant);
    const threadId = await runInTenant(tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
    const post = (ref: unknown) =>
      fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "question", context: [ref] }),
      });
    const occurrence = { kind: "taskOccurrence", seriesId: own.seriesId, occurrenceDate: "2026-11-16" };
    const trace = { kind: "taskTrace", itemId: own.task.id, databaseId: own.tasks, traceDay: "2026-11-02" };

    const accepted = await post(occurrence);
    expect(accepted.status).toBe(202);
    expect((await post(trace)).status).toBe(202);
    const stored = await runInTenant(tenant, () =>
      pool.query<{ context: unknown }>(
        "SELECT context FROM semp_messages WHERE thread_id = $1 AND role = 'user' ORDER BY id",
        [threadId],
      ),
    );
    // Stored exactly as sent: the occurrence carries no item id.
    expect(stored.rows).toEqual([{ context: [occurrence] }, { context: [trace] }]);

    const snapshot = () =>
      runInTenant(tenant, async () => {
        const messages = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1",
          [threadId],
        );
        const jobs = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE queue_name = $1",
          [`semp-chat:${tenant}`],
        );
        return { messages: messages.rows, jobs: jobs.rows };
      });
    const before = await snapshot();
    const refusedBodies: unknown[] = [];
    for (const ref of [
      { kind: "taskOccurrence", seriesId: foreign.seriesId, occurrenceDate: "2026-11-16" },
      { kind: "taskOccurrence", seriesId: randomUUID(), occurrenceDate: "2026-11-16" },
      { kind: "taskOccurrence", seriesId: "not-a-uuid", occurrenceDate: "2026-11-16" },
      { kind: "taskTrace", itemId: own.project.id, databaseId: own.projects, traceDay: "2026-11-02" },
      { kind: "taskTrace", itemId: own.deleted.id, databaseId: own.tasks, traceDay: "2026-11-03" },
      { kind: "taskTrace", itemId: foreign.task.id, databaseId: foreign.tasks, traceDay: "2026-11-02" },
    ]) {
      const response = await post(ref);
      expect(response.status, JSON.stringify(ref)).toBe(400);
      refusedBodies.push(await response.json());
      expect(await snapshot()).toEqual(before);
    }
    // Every refusal is the same body: a foreign series or task answers exactly as an unknown one.
    for (const body of refusedBodies) {
      expect(body).toMatchObject({ error: { code: "validation_failed", details: { field: "context[0]" } } });
      expect(body).toEqual(refusedBodies[0]);
    }
    // An extra key, an unknown kind and a malformed day are refused at the edge.
    for (const bad of [
      { ...occurrence, itemId: own.task.id },
      { ...trace, extra: true },
      { ...occurrence, occurrenceDate: "2026-02-30" },
      { kind: "taskRun", seriesId: own.seriesId },
    ]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("validates block membership and the Transcripts database through the real message route", async () => {
    const tenant = await createTestTenant(admin);
    const email = `${randomUUID()}@example.test`;
    await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword("thread-test-password") });
    const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
    const fixture = await runInTenant(tenant, async () => {
      await seedSystem(pool);
      const items = await withTransaction(pool, async (client) => {
        const tasks = await getDatabaseByModuleId(client, "tasks");
        const transcripts = await getDatabaseByModuleId(client, "transcripts");
        if (!tasks || !transcripts) throw new Error("Missing system databases");
        const item = await createItemWithClient(client, { databaseId: tasks.id, properties: { name: "Page" } });
        const transcript = await createItemWithClient(client, {
          databaseId: transcripts.id,
          properties: { name: "Transcript" },
        });
        return { itemId: item.id, transcriptId: transcript.id };
      });
      const blockId = randomUUID();
      await createDocStore(pool).putBlock(items.itemId, { id: blockId, flavour: "paragraph" }, "user");
      return { ...items, blockId };
    });
    const threadId = await runInTenant(tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
    const post = (ref: unknown) =>
      fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "question", context: [ref] }),
      });
    expect((await post({ kind: "block", itemId: fixture.itemId, blockId: fixture.blockId })).status).toBe(202);
    expect(
      (await post({ kind: "transcriptSegment", itemId: fixture.transcriptId, startsAt: 0, endsAt: 1 })).status,
    ).toBe(202);
    const counts = () =>
      runInTenant(tenant, async () => ({
        messages: (
          await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1", [
            threadId,
          ])
        ).rows,
        jobs: (
          await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE queue_name = $1",
            [`semp-chat:${tenant}`],
          )
        ).rows,
      }));
    const before = await counts();
    for (const ref of [
      { kind: "block", itemId: fixture.itemId, blockId: randomUUID() },
      { kind: "block", itemId: randomUUID(), blockId: fixture.blockId },
      { kind: "transcriptSegment", itemId: fixture.itemId, startsAt: 0, endsAt: 1 },
      { kind: "transcriptSegment", itemId: randomUUID(), startsAt: 0, endsAt: 1 },
    ]) {
      const response = await post(ref);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "context[0]" } },
      });
      expect(await counts()).toEqual(before);
    }
  });

  it("accepts an ingested mail attachment and refuses an unknown attachment without effects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "semprec-ref-mail-"));
    let failure: unknown;
    let failed = false;
    try {
      const tenant = await createTestTenant(admin);
      const email = `${randomUUID()}@example.test`;
      await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword("thread-test-password") });
      const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
      const attachmentId = await runInTenant(tenant, async () => {
        await seedSystem(pool);
        return withTransaction(pool, async (client) => {
          const ids = await resolveMailModuleIds(client);
          const cp = createChokePoint(pool);
          const emailProperties = await cp.listProperties(ids.emailsDatabaseId);
          const folderProperties = await cp.listProperties(ids.foldersDatabaseId);
          const propertyId = (properties: typeof emailProperties, key: string) => {
            const property = properties.find((entry) => entry.key === key);
            if (!property) throw new Error(`Missing ${key} property`);
            return property.id;
          };
          const mailbox = await createItemWithClient(client, {
            databaseId: ids.mailboxesDatabaseId,
            properties: { name: "Mailbox", provider: "gmail" },
          });
          await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
          const gmail: GmailMailClient = {
            getCurrentHistoryId: async () => "1",
            listHistorySince: async () => ({
              invalidated: false,
              newHistoryId: "2",
              changedMessageIds: [],
              removedMessageIds: [],
            }),
            listAllMessageIds: async () => ["message"],
            listLabels: async () => [{ id: "INBOX", name: "Inbox", type: "system" }],
            fetchMessage: async () => ({
              id: "message",
              threadId: "thread",
              labelIds: ["INBOX"],
              message: {
                messageId: `<${tenant}@example.test>`,
                envelope: { from: { address: "sender@example.test" } },
                attachments: [
                  {
                    filename: "note.txt",
                    contentType: "text/plain",
                    contentId: null,
                    disposition: "attachment",
                    openStream: () => Readable.from(["note"]),
                  },
                ],
              },
            }),
            modifyMessageLabels: async () => undefined,
          };
          await reconcileGmailAccount(client, gmail, {
            mailboxItemId: mailbox.id,
            emailsDatabaseId: ids.emailsDatabaseId,
            filesDatabaseId: ids.filesDatabaseId,
            foldersDatabaseId: ids.foldersDatabaseId,
            folderRelationPropertyId: propertyId(emailProperties, "folder"),
            attachmentsRelationPropertyId: propertyId(emailProperties, "attachments"),
            mailboxFolderRelationPropertyId: propertyId(folderProperties, "mailbox"),
            storage: new LocalFsBlobStorageWriter(directory),
            storageKeyPrefix: "ref-test",
          });
          const rows = await client.query<{ id: string }>("SELECT id FROM mail_attachments");
          if (rows.rows.length !== 1 || !rows.rows[0]) throw new Error("Missing ingested attachment");
          return rows.rows[0].id;
        });
      });
      const threadId = await runInTenant(tenant, () => withTransaction(pool, (client) => createSempChatThread(client)));
      const post = (id: string) =>
        fetch(`${baseUrl}/api/semp/threads/${threadId}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
          body: JSON.stringify({ text: "question", context: [{ kind: "mailAttachment", attachmentId: id }] }),
        });
      expect((await post(attachmentId)).status).toBe(202);
      const counts = () =>
        runInTenant(tenant, async () => ({
          messages: (
            await pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1",
              [threadId],
            )
          ).rows,
          jobs: (
            await pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE queue_name = $1",
              [`semp-chat:${tenant}`],
            )
          ).rows,
        }));
      const before = await counts();
      const response = await post(randomUUID());
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "context[0]" } },
      });
      expect(await counts()).toEqual(before);
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      if (failed) {
        // Preserve the original fixture failure as the primary cause; cleanup remains in the aggregate.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([failure, error], "Mail fixture and cleanup failed", { cause: failure });
      }
      throw error;
    }
    if (failed) throw failure instanceof Error ? failure : new Error("Mail fixture failed", { cause: failure });
  });

  it("queues chat messages while leaving an existing approval pending regardless of text", async () => {
    const tenant = await createTestTenant(admin);
    const email = `${randomUUID()}@example.test`;
    await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword("thread-test-password") });
    const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const invalid = await fetch(`${baseUrl}/api/semp/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: " \n " }),
    });
    expect(invalid.status).toBe(400);
    const empty = await runInTenant(tenant, () =>
      pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages"),
    );
    expect(empty.rows).toEqual([{ count: 0 }]);
    const created = await fetch(`${baseUrl}/api/semp/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "first" }),
    });
    expect(created.status).toBe(202);
    const first = z
      .object({ threadId: z.string().uuid(), messageId: z.string().uuid(), assistantMessageId: z.string().uuid() })
      .parse(await created.json());
    const request = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const run = await createAgentRun(client, {
          triggeredBy: "user",
          unit: "session",
          task: "first",
          threadId: first.threadId,
        });
        return createPendingApprovalRequest(client, {
          agentRunId: run.id,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
      }),
    );
    const sent = await fetch(`${baseUrl}/api/semp/threads/${first.threadId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "approve yes" }),
    });
    expect(sent.status).toBe(202);
    const second = z
      .object({ threadId: z.string().uuid(), messageId: z.string().uuid(), assistantMessageId: z.string().uuid() })
      .parse(await sent.json());
    expect(second.threadId).toBe(first.threadId);
    const stored = await runInTenant(tenant, async () => ({
      approval: (
        await pool.query<{ status: string }>("SELECT status FROM approval_requests WHERE id = $1", [request.id])
      ).rows,
      messages: (
        await pool.query<{ role: string; status: string | null; text: string | null }>(
          "SELECT role, status, text FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
          [[second.messageId, second.assistantMessageId]],
        )
      ).rows,
      job: (
        await pool.query<{
          id: string;
          revision: number;
          key: string;
          queue_name: string;
          task_identifier: string;
          max_attempts: number;
          priority: number;
        }>(
          "SELECT id::text, revision, key, queue_name, task_identifier, max_attempts, priority FROM graphile_worker.jobs WHERE key = $1",
          [`sempMessage:${second.assistantMessageId}`],
        )
      ).rows,
    }));
    expect(stored.approval).toEqual([{ status: "pending" }]);
    expect(stored.messages).toEqual([
      { role: "user", status: null, text: "approve yes" },
      { role: "assistant", status: "queued", text: null },
    ]);
    expect(stored.job).toEqual([
      expect.objectContaining({
        key: `sempMessage:${second.assistantMessageId}`,
        queue_name: `semp-chat:${tenant}`,
        task_identifier: "sempMessage",
        max_attempts: 1,
        priority: -1,
      }),
    ]);
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        enqueueSempMessage(client, { threadId: second.threadId, assistantMessageId: second.assistantMessageId }),
      ),
    );
    const duplicate = await runInTenant(tenant, () =>
      pool.query<{ id: string; revision: number }>(
        "SELECT id::text, revision FROM graphile_worker.jobs WHERE key = $1",
        [`sempMessage:${second.assistantMessageId}`],
      ),
    );
    const originalJob = stored.job[0];
    if (!originalJob) throw new Error("Missing queued Semp job");
    expect(duplicate.rows).toEqual([{ id: originalJob.id, revision: originalJob.revision + 1 }]);
    const firstRunRef = { kind: "agentRun", agentRunId: request.agentRunId, messageId: randomUUID() };
    const approvalRef = { kind: "approvalRequest", approvalRequestId: request.id };
    const context = [firstRunRef, approvalRef, { ...firstRunRef, messageId: randomUUID() }];
    const withContext = await fetch(`${baseUrl}/api/semp/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "context question", context }),
    });
    expect(withContext.status).toBe(202);
    const contextMessage = z.object({ messageId: z.string().uuid() }).parse(await withContext.json());
    const contextRows = await runInTenant(tenant, () =>
      pool.query<{ context: unknown }>("SELECT context FROM semp_messages WHERE id = $1", [contextMessage.messageId]),
    );
    expect(contextRows.rows).toEqual([{ context: [firstRunRef, approvalRef] }]);
    const counts = () =>
      runInTenant(tenant, async () => ({
        messages: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages")).rows,
        jobs: (
          await pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE queue_name = $1",
            [`semp-chat:${tenant}`],
          )
        ).rows,
      }));
    const beforeRefusals = await counts();
    for (const ref of [
      { kind: "agentRun", agentRunId: randomUUID() },
      { kind: "approvalRequest", approvalRequestId: randomUUID() },
    ]) {
      const response = await fetch(`${baseUrl}/api/semp/threads/${first.threadId}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "question", context: [ref] }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "validation_failed", details: { field: "context[0]" } },
      });
      expect(await counts()).toEqual(beforeRefusals);
    }
  });

  it("reuses an item thread and refuses a current reserved or decided proposal without effects", async () => {
    const tenant = await createTestTenant(admin);
    const email = `${randomUUID()}@example.test`;
    await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword("thread-test-password") });
    await runInTenant(tenant, () => seedSystem(pool));
    const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
    const fixture = await runInTenant(tenant, async () => {
      const { inbox, proposals } = await withTransaction(pool, async (client) => ({
        inbox: await getDatabaseByModuleId(client, "inbox"),
        proposals: await getDatabaseByModuleId(client, "processingProposals"),
      }));
      if (!inbox || !proposals) throw new Error("Missing seeded Inbox databases");
      const sourceProperty = (await createChokePoint(pool).listProperties(proposals.id)).find(
        (property) => property.key === "sourceInbox",
      );
      if (!sourceProperty) throw new Error("Missing sourceInbox property");
      return withTransaction(pool, async (client) => {
        const source = await createItemWithClient(client, {
          databaseId: inbox.id,
          properties: { date: "2026-01-01", time: "12:00", text: "source" },
        });
        const card = await createItemWithClient(
          client,
          {
            databaseId: proposals.id,
            properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status: "pending" },
          },
          { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
        );
        await createRelationWithClient(
          client,
          { relationPropertyId: sourceProperty.id, callerItemId: card.id, targetItemId: source.id },
          { ownerProcess: "processingProposals" },
        );
        return {
          sourceId: source.id,
          cardId: card.id,
          databaseId: proposals.id,
          inboxId: inbox.id,
          propertyId: sourceProperty.id,
        };
      });
    });
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const post = (body: unknown) =>
      fetch(`${baseUrl}/api/semp/threads`, { method: "POST", headers, body: JSON.stringify(body) });
    const firstResponse = await post({
      text: "first",
      subject: { inboxItemId: fixture.sourceId, proposalId: fixture.cardId },
    });
    expect(firstResponse.status).toBe(202);
    const first = z.object({ threadId: z.string().uuid() }).parse(await firstResponse.json());
    const secondResponse = await post({ text: "second", subject: { inboxItemId: fixture.sourceId } });
    expect(secondResponse.status).toBe(202);
    expect(z.object({ threadId: z.string().uuid() }).parse(await secondResponse.json()).threadId).toBe(first.threadId);
    const invalid = await post({ text: "context", context: [], subject: { inboxItemId: fixture.sourceId } });
    expect(invalid.status).toBe(400);
    expect(
      (await post({ text: "bad hint", subject: { inboxItemId: fixture.sourceId, proposalId: randomUUID() } })).status,
    ).toBe(400);
    const count = async () =>
      (
        await runInTenant(tenant, () =>
          pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1", [
            first.threadId,
          ]),
        )
      ).rows[0]?.count;
    expect(await count()).toBe(4);
    const jobsBefore = (await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs"))
      .rows;
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const writer = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        await updateItemWithClient(
          client,
          { databaseId: fixture.databaseId, itemId: fixture.cardId, propertiesPatch: { status: "confirmed" } },
          { allowedSystemKeys: ["status"] },
        );
        locked();
        await gate;
      }),
    );
    let busyFailure: { error: unknown } | undefined;
    try {
      await Promise.race([
        ready,
        writer.then(() => {
          throw new Error("Proposal writer exited before reservation");
        }),
      ]);
      const busy = await post({ text: "during", subject: { inboxItemId: fixture.sourceId } });
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ error: { code: "version_conflict" } });
      expect(await count()).toBe(4);
      expect(
        (await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs")).rows,
      ).toEqual(jobsBefore);
    } catch (error) {
      busyFailure = { error };
    }
    release();
    try {
      await writer;
    } catch (error) {
      if (busyFailure) {
        throw new AggregateError([busyFailure.error, error], "Proposal overlap cleanup failed", {
          // Keep the assertion failure primary while retaining the writer failure.
          // eslint-disable-next-line preserve-caught-error
          cause: busyFailure.error,
        });
      }
      throw error;
    }
    if (busyFailure) throw busyFailure.error;
    const decided = await post({ text: "after", subject: { inboxItemId: fixture.sourceId } });
    expect(decided.status).toBe(409);
    expect(await decided.json()).toMatchObject({ error: { code: "proposal_locked" } });
    expect(await count()).toBe(4);
    expect(
      (await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs")).rows,
    ).toEqual(jobsBefore);
    const history = await fetch(`${baseUrl}/api/semp/threads/${first.threadId}/messages`, { headers });
    expect(history.status).toBe(200);
    const historyBody = z
      .object({ rows: z.array(z.object({ role: z.string(), text: z.string().nullable() })) })
      .parse(await history.json());
    expect(historyBody.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "first" }),
        expect.objectContaining({ role: "user", text: "second" }),
      ]),
    );
    const laterSource = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        createItemWithClient(client, {
          databaseId: fixture.inboxId,
          properties: { date: "2026-01-01", time: "12:01", text: "later source" },
        }),
      ),
    );
    const beforeCard = await post({ text: "before card", subject: { inboxItemId: laterSource.id } });
    expect(beforeCard.status).toBe(202);
    const nullHintThread = z.object({ threadId: z.string().uuid() }).parse(await beforeCard.json()).threadId;
    const hint = await runInTenant(tenant, () =>
      pool.query<{ subject_proposal_id: string | null }>("SELECT subject_proposal_id FROM semp_threads WHERE id = $1", [
        nullHintThread,
      ]),
    );
    expect(hint.rows).toEqual([{ subject_proposal_id: null }]);
    await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const rejected = await createItemWithClient(
          client,
          {
            databaseId: fixture.databaseId,
            properties: {
              kind: "inbox",
              fingerprint: randomUUID(),
              proposal: {},
              history: [],
              status: "rejected",
            },
          },
          { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
        );
        await createRelationWithClient(
          client,
          { relationPropertyId: fixture.propertyId, callerItemId: rejected.id, targetItemId: laterSource.id },
          { ownerProcess: "processingProposals" },
        );
      }),
    );
    const beforeRejectedJobs = (
      await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs")
    ).rows;
    const rejected = await fetch(`${baseUrl}/api/semp/threads/${nullHintThread}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "after rejection" }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "proposal_locked" } });
    const untouched = await runInTenant(tenant, () =>
      pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1", [
        nullHintThread,
      ]),
    );
    expect(untouched.rows).toEqual([{ count: 2 }]);
    expect(
      (await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs")).rows,
    ).toEqual(beforeRejectedJobs);
  });

  it("accepts text-only tick questions and refuses context and foreign threads", async () => {
    const tenant = await createTestTenant(admin);
    const other = await createTestTenant(admin);
    const makeSession = async (tenantId: string) => {
      const email = `${randomUUID()}@example.test`;
      await createUser(admin, { tenantId, email, passwordHash: await hashPassword("thread-test-password") });
      return login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
    };
    const ownerSession = await makeSession(tenant);
    const otherSession = await makeSession(other);
    await runInTenant(tenant, () => seedSystem(pool));
    const threadId = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
        const heartbeat = await createHeartbeat(client, {
          projectItemId: inbox.ownerProjectItemId,
          name: "Tick question",
          rule: { kind: "interval", minutes: 10 },
          actionId: "core.agentRun",
        });
        // The existing tick writer is private to data; seed its valid FK-constrained row here.
        const thread = await client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind, heartbeat_id) VALUES ('tick', $1) RETURNING id",
          [heartbeat.id],
        );
        if (!thread.rows[0]) throw new Error("Missing tick thread");
        return thread.rows[0].id;
      }),
    );
    const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
    const post = (id: string, token: string, body: unknown) =>
      fetch(`${baseUrl}/api/semp/threads/${id}/messages`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify(body),
      });
    expect((await post(threadId, ownerSession.token, { text: "question", context: [] })).status).toBe(400);
    const accepted = await post(threadId, ownerSession.token, { text: "question" });
    expect(accepted.status).toBe(202);
    const ids = z
      .object({ messageId: z.string().uuid(), assistantMessageId: z.string().uuid() })
      .parse(await accepted.json());
    const before = await runInTenant(tenant, () =>
      pool.query("SELECT id, role, status, text FROM semp_messages WHERE thread_id = $1 ORDER BY created_at, id", [
        threadId,
      ]),
    );
    expect(before.rows).toHaveLength(2);
    const foreign = await post(threadId, otherSession.token, { text: "foreign" });
    const random = await post(randomUUID(), otherSession.token, { text: "foreign" });
    expect(foreign.status).toBe(404);
    expect(random.status).toBe(404);
    expect(await foreign.text()).toBe(await random.text());
    const after = await runInTenant(tenant, () =>
      pool.query("SELECT id, role, status, text FROM semp_messages WHERE thread_id = $1 ORDER BY created_at, id", [
        threadId,
      ]),
    );
    expect(after.rows).toEqual(before.rows);
    const job = await runInTenant(tenant, () =>
      pool.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [`sempMessage:${ids.assistantMessageId}`]),
    );
    expect(job.rows).toEqual([{ key: `sempMessage:${ids.assistantMessageId}` }]);
  });
});
