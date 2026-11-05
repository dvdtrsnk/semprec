import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createUser,
  finishAgentRun,
  handleAgentRunEventsRetentionTask,
  hashPassword,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
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
      return { threadId, id, replyId, runId: run.id };
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
        },
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
});
