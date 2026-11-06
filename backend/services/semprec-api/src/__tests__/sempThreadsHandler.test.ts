import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createSempChatThread,
  claimSempMessage,
  createUser,
  finishAgentRun,
  handleAgentRunEventsRetentionTask,
  hashPassword,
  insertAgentRunEvent,
  insertSempUserTurn,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  sendSempMessage,
  startSempMessageTurn,
  listSempThreadMessages,
  withTransaction,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

let admin: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;
describe("durable Semp thread history", () => {
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
        {
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
        },
        { id: fixture.replyId, run: null },
        {
          id: fixture.failedId,
          run: { startedAt: expect.any(String), finishedAt: expect.any(String), status: "error" },
        },
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
        { id: fixture.id, run: { startedAt: expect.any(String), finishedAt: expect.any(String), status: "done" } },
        { id: fixture.replyId, run: null },
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
      rows: expect.arrayContaining([{ run: { status: "running", finishedAt: null } }]),
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
});
