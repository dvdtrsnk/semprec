import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createAgentRun,
  createChokePoint,
  createHeartbeat,
  createItemWithClient,
  createPendingApprovalRequest,
  createRelationWithClient,
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
        await pool.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
          `sempMessage:${second.assistantMessageId}`,
        ])
      ).rows,
    }));
    expect(stored.approval).toEqual([{ status: "pending" }]);
    expect(stored.messages).toEqual([
      { role: "user", status: null, text: "approve yes" },
      { role: "assistant", status: "queued", text: null },
    ]);
    expect(stored.job).toEqual([{ key: `sempMessage:${second.assistantMessageId}` }]);
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
