import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  ensureMailAccountSyncState,
  getTestPool,
  ingestEmailMessage,
  reconcileGmailAccount,
  gmailHistory,
  recentGmailListing,
  resetDatabase,
  UNGUARDED_MAIL_SYNC_PASS,
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
  finishSempMessageTurn,
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

const NEW_THREAD = "/api/semp/threads";
const messagesPath = (threadId: string) => `/api/semp/threads/${threadId}/messages`;
const bothRoutes = (threadId: string) => [NEW_THREAD, messagesPath(threadId)];
const rowsSchema = z.object({ rows: z.array(z.object({ id: z.string() }).passthrough()) });
const sentSchema = z.object({
  threadId: z.string().uuid(),
  messageId: z.string().uuid(),
  assistantMessageId: z.string().uuid(),
});

async function signIn(tenantId: string, locale?: string): Promise<{ userId: string; token: string }> {
  const email = `${randomUUID()}@example.test`;
  const passwordHash = await hashPassword("thread-test-password");
  const user = await createUser(admin, { tenantId, email, passwordHash, ...(locale ? { locale } : {}) });
  const session = await login(admin, { email, password: "thread-test-password", platform: "ios", ip: "127.0.0.1" });
  return { userId: user.id, token: session.token };
}

const headersFor = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const getHistory = (token: string, threadId: string) =>
  fetch(`${baseUrl}${messagesPath(threadId)}`, { headers: headersFor(token) });
const send = (token: string, path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, { method: "POST", headers: headersFor(token), body: JSON.stringify(body) });
/** Posts a question with `context` on `path`, by default the thread's message route. */
const ask = (token: string, threadId: string, context: unknown[], path = messagesPath(threadId)) =>
  send(token, path, { text: "question", context });

async function historyRows(token: string, threadId: string) {
  const response = await getHistory(token, threadId);
  expect(response.status).toBe(200);
  return rowsSchema.parse(await response.json()).rows;
}

async function expectRefused(response: Response, field = "context[0]", label?: string): Promise<unknown> {
  expect(response.status, label).toBe(400);
  const body: unknown = await response.json();
  expect(body, label).toMatchObject({ error: { code: "validation_failed", details: { field } } });
  return body;
}

const chatThread = (tenantId: string) =>
  runInTenant(tenantId, () => withTransaction(pool, (client) => createSempChatThread(client)));

async function insertId(db: Pool | PoolClient, sql: string, params: unknown[] = []): Promise<string> {
  const { rows } = await db.query<{ id: string }>(sql, params);
  const id = rows[0]?.id;
  if (!id) throw new Error(`Nothing returned by: ${sql}`);
  return id;
}

const insertThread = () => insertId(pool, "INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(sql, params);
  return rows[0]?.count ?? 0;
}

/** Every thread, message and Semp chat job of the tenant: a refusal leaves all of them unchanged. */
const effects = (tenantId: string) =>
  runInTenant(tenantId, async () => ({
    threads: await count("SELECT count(*)::int AS count FROM semp_threads"),
    messages: await count("SELECT count(*)::int AS count FROM semp_messages"),
    jobs: await count("SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE queue_name = $1", [
      `semp-chat:${tenantId}`,
    ]),
  }));

const allJobs = async () =>
  (await admin.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs")).rows;

const userContexts = (tenantId: string, threadId: string) =>
  runInTenant(tenantId, async () =>
    (
      await pool.query<{ context: unknown }>(
        "SELECT context FROM semp_messages WHERE thread_id = $1 AND role = 'user' ORDER BY id",
        [threadId],
      )
    ).rows.map((row) => row.context),
  );

const contextOf = (tenantId: string, messageId: string) =>
  runInTenant(tenantId, async () =>
    (await pool.query<{ context: unknown }>("SELECT context FROM semp_messages WHERE id = $1", [messageId])).rows.map(
      (row) => row.context,
    ),
  );

async function databaseIds<K extends string>(tenantId: string, ...moduleIds: K[]): Promise<Record<K, string>> {
  return runInTenant(tenantId, async () => {
    await seedSystem(pool);
    return withTransaction(pool, async (client) => {
      const ids: Partial<Record<K, string>> = {};
      for (const moduleId of moduleIds) {
        const database = await getDatabaseByModuleId(client, moduleId);
        if (!database) throw new Error(`Missing ${moduleId} database`);
        ids[moduleId] = database.id;
      }
      // Every requested module was assigned above.
      return ids as Record<K, string>;
    });
  });
}

/** Runs `fn` with a fresh directory; a cleanup failure never replaces the case's own failure. */
async function withDirectory(prefix: string, fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  let failure: { error: unknown } | undefined;
  try {
    await fn(directory);
  } catch (error) {
    failure = { error };
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    if (!failure) throw error;
    // Preserve the original fixture failure as the primary cause; cleanup remains in the aggregate.
    // eslint-disable-next-line preserve-caught-error
    throw new AggregateError([failure.error, error], "Mail fixture and cleanup failed", { cause: failure.error });
  }
  if (failure) throw failure.error;
}

/** The ids of the Emails and Folders relation properties mail ingestion writes through. */
async function mailFixtureIds(client: PoolClient) {
  const ids = await resolveMailModuleIds(client);
  const cp = createChokePoint(pool);
  const [emailProperties, folderProperties] = [
    await cp.listProperties(ids.emailsDatabaseId),
    await cp.listProperties(ids.foldersDatabaseId),
  ];
  const propertyId = (properties: typeof emailProperties, key: string) => {
    const property = properties.find((entry) => entry.key === key);
    if (!property) throw new Error(`Missing ${key} property`);
    return property.id;
  };
  return {
    ...ids,
    folderRelationPropertyId: propertyId(emailProperties, "folder"),
    attachmentsRelationPropertyId: propertyId(emailProperties, "attachments"),
    mailboxFolderRelationPropertyId: propertyId(folderProperties, "mailbox"),
  };
}

/** A chat thread whose user message the run answered, in `tenantId`. */
const chatWithAnswer = (
  tenantId: string,
  userId?: string,
  summary?: Parameters<typeof finishSempMessageTurn>[2]["summary"],
) =>
  runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const threadId = await createSempChatThread(client);
      const run = await createAgentRun(client, {
        triggeredBy: "user",
        unit: "session",
        task: "answer",
        userId,
        threadId,
      });
      const turn = await sendSempMessage(client, { threadId, text: "Question", context: [], hasContext: false });
      expect(await claimSempMessage(client, threadId, turn.assistantMessageId)).toBe(true);
      const started = await insertAgentRunEvent(client, run.id, "turn_start", { kind: "turn_start" });
      await startSempMessageTurn(client, turn.assistantMessageId, run.id, started.id);
      const ended = await insertAgentRunEvent(client, run.id, "turn_end", { kind: "turn_end" });
      expect(
        await finishSempMessageTurn(client, turn.assistantMessageId, {
          status: "done",
          text: "Answer",
          lastEventId: ended.id,
          ...(summary ? { summary } : {}),
        }),
      ).toBe(true);
      return { threadId, runId: run.id, userMessageId: turn.messageId, answerId: turn.assistantMessageId };
    }),
  );

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
    const { userId, token } = await signIn(tenant);
    const fixture = await runInTenant(tenant, async () => {
      const threadId = await insertThread();
      const startRun = (task: string) =>
        createAgentRun(pool, { triggeredBy: "user", unit: "session", task, userId, threadId });
      const run = await startRun("history");
      const replyId = await insertId(
        pool,
        "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', 'hello') RETURNING id",
        [threadId],
      );
      const id = await insertId(
        pool,
        `INSERT INTO semp_messages (thread_id, role, system_key, system_params, context, reply_to_message_id, agent_run_id, event_from_id, status)
        VALUES ($1, 'system', 'system.test', '{"count":2}'::jsonb, '[{"ref":"x"}]'::jsonb, $2, $3, 123, 'done') RETURNING id`,
        [threadId, replyId, run.id],
      );
      const failedRun = await startRun("failed");
      expect(await finishAgentRun(pool, failedRun.id, "error", "internal")).toBe(true);
      const failedId = await insertId(
        pool,
        "INSERT INTO semp_messages (thread_id, role, agent_run_id, status) VALUES ($1, 'assistant', $2, 'error') RETURNING id",
        [threadId, failedRun.id],
      );
      return { threadId, id, replyId, runId: run.id, failedId };
    });
    const runOf = (status: string, finished: boolean) => ({
      startedAt: expect.any(String),
      finishedAt: finished ? expect.any(String) : null,
      status,
    });
    expect(await historyRows(token, fixture.threadId)).toEqual(
      expect.arrayContaining([
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
          run: runOf("running", false),
        }),
        expect.objectContaining({ id: fixture.replyId, run: null }),
        expect.objectContaining({ id: fixture.failedId, run: runOf("error", true) }),
      ]),
    );
    // A page is one query whatever its size.
    await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const query = vi.spyOn(client, "query");
        try {
          for (const limit of [1, 50]) {
            query.mockClear();
            await listSempThreadMessages(client, fixture.threadId, limit, null);
            expect(query).toHaveBeenCalledTimes(1);
          }
        } finally {
          query.mockRestore();
        }
      }),
    );
    expect(await runInTenant(tenant, () => finishAgentRun(pool, fixture.runId, "done", null))).toBe(true);
    expect(await historyRows(token, fixture.threadId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.id, run: runOf("done", true) })]),
    );
    for (const suffix of ["", "/messages"]) {
      expect(
        (await fetch(`${baseUrl}/api/semp/threads/not-a-uuid${suffix}`, { headers: headersFor(token) })).status,
      ).toBe(400);
    }
  });

  it("serializes whether each reply left a failed tool call, with the reason fields only when it did", async () => {
    const tenant = await createTestTenant(admin);
    const { token } = await signIn(tenant);
    const serverId = randomUUID();
    const step = (status: "ok" | "error", extra: Record<string, unknown> = {}) => ({
      kind: "tool",
      toolName: "mcp_search_aaaaaaaa",
      label: { key: "agentStep.title.namedTool", params: { toolName: "mcp_search_aaaaaaaa" } },
      detail: { key: status === "ok" ? "agentStep.summary.done" : "agentStep.summary.failed", params: {} },
      status,
      startedAt: "2026-11-01T10:00:00.000Z",
      durationMs: 40,
      ...extra,
    });
    const fixture = await runInTenant(tenant, async () => {
      const threadId = await insertThread();
      const insertReply = (steps: unknown) =>
        insertId(
          pool,
          "INSERT INTO semp_messages (thread_id, role, status, steps) VALUES ($1, 'assistant', 'done', $2::jsonb) RETURNING id",
          [threadId, steps === null ? null : JSON.stringify(steps)],
        );
      return {
        threadId,
        timedOut: await insertReply([
          step("error", { errorCode: "timeout", mcpServerItemId: serverId, connectorName: "GitHub", timeoutMs: 60000 }),
        ]),
        complete: await insertReply([step("ok")]),
        withoutSummary: await insertReply(null),
      };
    });

    const rows = await historyRows(token, fixture.threadId);
    const row = (id: string) => rows.find((candidate) => candidate.id === id);
    expect(row(fixture.timedOut)).toMatchObject({
      outcome: "incomplete",
      incompleteReason: "toolTimeout",
      mcpServerItemId: serverId,
      timeoutMs: 60000,
      steps: expect.anything(),
    });
    // The connector's name is derived from the steps, not stored on the message.
    expect(row(fixture.timedOut)).not.toHaveProperty("connectorName");
    for (const id of [fixture.complete, fixture.withoutSummary]) {
      expect(row(id)).toMatchObject({ outcome: "complete" });
      for (const key of ["incompleteReason", "mcpServerItemId", "timeoutMs"]) expect(row(id)).not.toHaveProperty(key);
    }
  });

  it.each([
    { locale: "cs", message: "Odpověď se nepodařila, protože je vyčerpaný limit výdajů na AI." },
    { locale: "en", message: "I could not answer because the AI spending limit is used up." },
  ])(
    "serializes the error of a failed reply with its text in the user's language, $locale",
    async ({ locale, message }) => {
      const tenant = await createTestTenant(admin);
      const { token } = await signIn(tenant, locale);
      const fixture = await runInTenant(tenant, async () => {
        const threadId = await insertThread();
        const insertReply = (status: "error" | "done", code: string | null, params: unknown) =>
          insertId(
            pool,
            `INSERT INTO semp_messages (thread_id, role, status, error_code, error_params)
           VALUES ($1, 'assistant', $2, $3, $4::jsonb) RETURNING id`,
            [threadId, status, code, params === null ? null : JSON.stringify(params)],
          );
        return {
          threadId,
          budget: await insertReply("error", "budgetExceeded", { connectorName: "Calendar", timeoutMs: 15000 }),
          legacy: await insertReply("error", null, null),
          done: await insertReply("done", null, null),
        };
      });

      const rows = await historyRows(token, fixture.threadId);
      const row = (id: string) => rows.find((candidate) => candidate.id === id);
      expect(row(fixture.budget)).toMatchObject({ status: "error", error: { code: "budgetExceeded", message } });
      expect(JSON.stringify(row(fixture.budget))).not.toContain("Calendar");
      expect(row(fixture.legacy)).toMatchObject({ status: "error", error: { code: "internal" } });
      expect(row(fixture.done)).not.toHaveProperty("error");
    },
  );

  it("returns old thread history after the real retention task removes an eligible event", async () => {
    const tenant = await createTestTenant(admin);
    const { userId, token } = await signIn(tenant);
    const eventIds = (ids: string[]) =>
      runInTenant(tenant, async () =>
        (
          await pool.query<{ id: string }>("SELECT id FROM agent_run_events WHERE id = ANY($1::bigint[]) ORDER BY id", [
            ids,
          ])
        ).rows.map((row) => row.id),
      );
    const fixture = await runInTenant(tenant, async () => {
      const threadId = await insertThread();
      const run = await createAgentRun(pool, {
        triggeredBy: "user",
        unit: "session",
        task: "history",
        userId,
        threadId,
      });
      const expired = await insertAgentRunEvent(pool, run.id, "message", { kind: "message" });
      const checkpoint = await insertAgentRunEvent(pool, run.id, "compaction", { kind: "compaction" });
      const retained = await insertAgentRunEvent(pool, run.id, "message", { kind: "message" });
      expect(await finishAgentRun(pool, run.id, "done", null)).toBe(true);
      // Backdated past retention: no production write sets an event's or message's time.
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      const backdated = await pool.query("UPDATE agent_run_events SET at = $2 WHERE agent_run_id = $1", [run.id, old]);
      expect(backdated.rowCount).toBe(3);
      const messageId = await insertId(
        pool,
        "INSERT INTO semp_messages (thread_id, role, text, agent_run_id, created_at) VALUES ($1, 'assistant', 'old history', $2, $3) RETURNING id",
        [threadId, run.id, old],
      );
      return { threadId, messageId, events: [expired.id, checkpoint.id, retained.id] };
    });
    const [, checkpoint, retained] = fixture.events;
    expect(await eventIds(fixture.events)).toEqual(fixture.events);
    const result = await runAsSystem("test:retention", () => handleAgentRunEventsRetentionTask(pool));
    expect(result.deleted).toBe(1);
    expect(await eventIds(fixture.events)).toEqual([checkpoint, retained]);
    const response = await getHistory(token, fixture.threadId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      rows: [{ id: fixture.messageId, text: "old history" }],
      nextCursor: null,
    });
  });

  it("does not expose run data through another tenant's thread id", async () => {
    const ownerTenant = await createTestTenant(admin);
    const owner = await signIn(ownerTenant);
    const foreign = await signIn(await createTestTenant(admin));
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
    const ownerView = await getHistory(owner.token, threadId);
    expect(ownerView.status).toBe(200);
    const ownerBody: unknown = await ownerView.json();
    expect(ownerBody).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ run: expect.objectContaining({ status: "running", finishedAt: null }) }),
      ]),
    });
    const foreignView = await getHistory(foreign.token, threadId);
    const unknown = await getHistory(foreign.token, randomUUID());
    expect(foreignView.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreignView.text()).toBe(await unknown.text());
    expect(await (await getHistory(owner.token, threadId)).json()).toEqual(ownerBody);
  });

  it("rolls back a visible queued job together with the new thread and messages", async () => {
    const tenant = await createTestTenant(admin);
    let turn: { threadId: string; messageId: string; assistantMessageId: string } | undefined;
    const jobKey = () => `sempMessage:${turn?.assistantMessageId}`;
    await expect(
      runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          turn = await sendSempMessage(client, { text: "Rollback", context: [], hasContext: false });
          const job = await client.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [jobKey()]);
          expect(job.rows).toEqual([{ key: jobKey() }]);
          throw new Error("rollback sentinel");
        }),
      ),
    ).rejects.toThrow("rollback sentinel");
    if (!turn) throw new Error("Missing turn");
    const { threadId, messageId, assistantMessageId } = turn;
    expect(
      await runInTenant(tenant, async () => [
        await count("SELECT count(*)::int AS count FROM semp_threads WHERE id = $1", [threadId]),
        await count("SELECT count(*)::int AS count FROM semp_messages WHERE id = ANY($1::uuid[])", [
          [messageId, assistantMessageId],
        ]),
        await count("SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE key = $1", [jobKey()]),
      ]),
    ).toEqual([0, 0, 0]);
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
      const { token } = await signIn(tenant);
      const threadId = await chatThread(tenant);
      const before = await effects(tenant);
      for (const path of bothRoutes(threadId)) {
        await expectRefused(await ask(token, threadId, context, path), field);
        expect(await effects(tenant)).toEqual(before);
      }
    },
  );

  it("accepts owned and trashed item refs and refuses foreign, random and mismatched refs without effects", async () => {
    const tenant = await createTestTenant(admin);
    const { token } = await signIn(tenant);
    const createFixture = async (tenantId: string) => {
      const { tasks, events } = await databaseIds(tenantId, "tasks", "events");
      const item = await runInTenant(tenantId, () =>
        createChokePoint(pool).createItem({ databaseId: tasks, properties: { name: "Task" } }),
      );
      return { itemId: item.id, databaseId: tasks, otherDatabaseId: events };
    };
    const own = await createFixture(tenant);
    const foreign = await createFixture(await createTestTenant(admin));
    const threadId = await chatThread(tenant);
    const post = (ref: unknown) => ask(token, threadId, [ref]);
    const ownRef = { kind: "item", itemId: own.itemId, databaseId: own.databaseId };
    expect((await post(ownRef)).status).toBe(202);
    const before = await effects(tenant);
    const bodies: unknown[] = [];
    for (const ref of [
      { kind: "item", itemId: foreign.itemId, databaseId: foreign.databaseId },
      { kind: "item", itemId: randomUUID(), databaseId: randomUUID() },
      { kind: "item", itemId: own.itemId, databaseId: own.otherDatabaseId },
    ]) {
      bodies.push(await expectRefused(await post(ref)));
      expect(await effects(tenant)).toEqual(before);
    }
    // A foreign item answers exactly as an unknown one.
    expect(bodies[1]).toEqual(bodies[0]);
    await runInTenant(tenant, () => createChokePoint(pool).softDeleteItem(own.databaseId, own.itemId));
    expect((await post(ownRef)).status).toBe(202);
  });

  it("stores a sleep night ref once with no existence check, and refuses an invalid date on both message routes without effects", async () => {
    const tenant = await createTestTenant(admin);
    const { token } = await signIn(tenant);
    const threadId = await chatThread(tenant);
    const night = { kind: "sleepNight", night: "2026-10-16" };
    const nextNight = { kind: "sleepNight", night: "2026-10-17" };

    // Unseeded tenant: no sleep database exists, and the ref is accepted all the same.
    expect((await ask(token, threadId, [night, { ...night }, nextNight])).status).toBe(202);
    expect(await userContexts(tenant, threadId)).toEqual([[night, nextNight]]);

    const before = await effects(tenant);
    for (const path of bothRoutes(threadId)) {
      for (const invalid of ["2026-13-01", "2026-02-30", "tonight"]) {
        await expectRefused(await ask(token, threadId, [{ kind: "sleepNight", night: invalid }], path));
        expect(await effects(tenant)).toEqual(before);
      }
      await expectRefused(
        await ask(token, threadId, [night, { kind: "sleepNight", night: "2026-13-01" }], path),
        "context[1]",
      );
      expect(await effects(tenant)).toEqual(before);
    }
  });

  it("accepts and stores task occurrence and trace refs, and refuses foreign, unknown, deleted and non-task ones without effects", async () => {
    const tenant = await createTestTenant(admin);
    const { token } = await signIn(tenant);
    const createFixture = async (tenantId: string) => {
      const databases = await databaseIds(tenantId, "tasks", "projects");
      return runInTenant(tenantId, async () => {
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
        return { tasks: databases.tasks, projects: databases.projects, task, deleted, project, seriesId };
      });
    };
    const own = await createFixture(tenant);
    const foreign = await createFixture(await createTestTenant(admin));
    const threadId = await chatThread(tenant);
    const post = (ref: unknown) => ask(token, threadId, [ref]);
    const occurrence = { kind: "taskOccurrence", seriesId: own.seriesId, occurrenceDate: "2026-11-16" };
    const trace = { kind: "taskTrace", itemId: own.task.id, databaseId: own.tasks, traceDay: "2026-11-02" };

    expect((await post(occurrence)).status).toBe(202);
    expect((await post(trace)).status).toBe(202);
    const stored = await userContexts(tenant, threadId);
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(expect.arrayContaining([[occurrence], [trace]]));

    const before = await effects(tenant);
    const refusedBodies: unknown[] = [];
    for (const ref of [
      { kind: "taskOccurrence", seriesId: foreign.seriesId, occurrenceDate: "2026-11-16" },
      { kind: "taskOccurrence", seriesId: randomUUID(), occurrenceDate: "2026-11-16" },
      { kind: "taskOccurrence", seriesId: "not-a-uuid", occurrenceDate: "2026-11-16" },
      { kind: "taskTrace", itemId: own.project.id, databaseId: own.projects, traceDay: "2026-11-02" },
      { kind: "taskTrace", itemId: own.deleted.id, databaseId: own.tasks, traceDay: "2026-11-03" },
      { kind: "taskTrace", itemId: foreign.task.id, databaseId: foreign.tasks, traceDay: "2026-11-02" },
    ]) {
      refusedBodies.push(await expectRefused(await post(ref), "context[0]", JSON.stringify(ref)));
      expect(await effects(tenant)).toEqual(before);
    }
    // A foreign series or task answers exactly as an unknown one.
    for (const body of refusedBodies) expect(body).toEqual(refusedBodies[0]);
    for (const bad of [
      { ...occurrence, itemId: own.task.id },
      { ...trace, extra: true },
      { ...occurrence, occurrenceDate: "2026-02-30" },
      { kind: "taskRun", seriesId: own.seriesId },
    ]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await effects(tenant)).toEqual(before);
  });

  it("validates block membership and the Transcripts database through the real message route", async () => {
    const tenant = await createTestTenant(admin);
    const { token } = await signIn(tenant);
    const { tasks, transcripts } = await databaseIds(tenant, "tasks", "transcripts");
    const fixture = await runInTenant(tenant, async () => {
      const items = await withTransaction(pool, async (client) => ({
        itemId: (await createItemWithClient(client, { databaseId: tasks, properties: { name: "Page" } })).id,
        transcriptId: (
          await createItemWithClient(client, { databaseId: transcripts, properties: { name: "Transcript" } })
        ).id,
      }));
      const blockId = randomUUID();
      await createDocStore(pool).putBlock(items.itemId, { id: blockId, flavour: "paragraph" }, "user");
      return { ...items, blockId };
    });
    const threadId = await chatThread(tenant);
    const post = (ref: unknown) => ask(token, threadId, [ref]);
    const segment = (itemId: string) => ({ kind: "transcriptSegment", itemId, startsAt: 0, endsAt: 1 });
    expect((await post({ kind: "block", itemId: fixture.itemId, blockId: fixture.blockId })).status).toBe(202);
    expect((await post(segment(fixture.transcriptId))).status).toBe(202);
    const before = await effects(tenant);
    for (const ref of [
      { kind: "block", itemId: fixture.itemId, blockId: randomUUID() },
      { kind: "block", itemId: randomUUID(), blockId: fixture.blockId },
      segment(fixture.itemId),
      segment(randomUUID()),
    ]) {
      await expectRefused(await post(ref));
      expect(await effects(tenant)).toEqual(before);
    }
  });

  it("validates a transcript segment ref's range, owner and trash state through the real message route", async () => {
    const tenant = await createTestTenant(admin);
    const { token } = await signIn(tenant);
    const createTranscript = async (tenantId: string) => {
      const { transcripts } = await databaseIds(tenantId, "transcripts");
      const item = await runInTenant(tenantId, () =>
        createChokePoint(pool).createItem({ databaseId: transcripts, properties: { name: "Recording" } }),
      );
      return { databaseId: transcripts, itemId: item.id };
    };
    const own = await createTranscript(tenant);
    const foreignTranscript = await createTranscript(await createTestTenant(admin));
    const threadId = await chatThread(tenant);
    const segment = (itemId: string, startsAt: number, endsAt: number) => ({
      kind: "transcriptSegment",
      itemId,
      startsAt,
      endsAt,
    });

    expect((await ask(token, threadId, [segment(own.itemId, 0, 900)])).status).toBe(202);
    await runInTenant(tenant, () => createChokePoint(pool).softDeleteItem(own.databaseId, own.itemId));
    expect((await ask(token, threadId, [segment(own.itemId, 10, 20)])).status).toBe(202);
    await runInTenant(tenant, () => createChokePoint(pool).restoreItem(own.databaseId, own.itemId));

    const before = await effects(tenant);
    for (const bad of [
      segment(foreignTranscript.itemId, 0, 10),
      segment(own.itemId, 0, 901),
      segment(own.itemId, 30, 20),
      segment(own.itemId, 20, 20),
    ]) {
      await expectRefused(
        await ask(token, threadId, [segment(own.itemId, 0, 10), bad]),
        "context[1]",
        JSON.stringify(bad),
      );
      expect(await effects(tenant)).toEqual(before);
    }
  });

  it("accepts an ingested mail attachment and refuses an unknown attachment without effects", async () => {
    await withDirectory("semprec-ref-mail-", async (directory) => {
      const tenant = await createTestTenant(admin);
      const { token } = await signIn(tenant);
      await runInTenant(tenant, () => seedSystem(pool));
      const attachmentId = await runInTenant(tenant, async () => {
        const { ids, mailbox } = await withTransaction(pool, async (client) => {
          const ids = await mailFixtureIds(client);
          const mailbox = await createItemWithClient(client, {
            databaseId: ids.mailboxesDatabaseId,
            properties: { name: "Mailbox", provider: "gmail" },
          });
          await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "gmail_api" });
          return { ids, mailbox };
        });
        const gmail: GmailMailClient = {
          getCurrentHistoryId: async () => "1",
          listHistorySince: async () => gmailHistory("2"),
          listMessageIds: recentGmailListing(["message"]),
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
        await reconcileGmailAccount(pool, gmail, {
          mailboxItemId: mailbox.id,
          emailsDatabaseId: ids.emailsDatabaseId,
          filesDatabaseId: ids.filesDatabaseId,
          foldersDatabaseId: ids.foldersDatabaseId,
          folderRelationPropertyId: ids.folderRelationPropertyId,
          attachmentsRelationPropertyId: ids.attachmentsRelationPropertyId,
          mailboxFolderRelationPropertyId: ids.mailboxFolderRelationPropertyId,
          storage: new LocalFsBlobStorageWriter(directory),
          storageKeyPrefix: "ref-test",
          pass: UNGUARDED_MAIL_SYNC_PASS,
        });
        const rows = await withTransaction(pool, (client) =>
          client.query<{ id: string }>("SELECT id FROM mail_attachments"),
        );
        if (rows.rows.length !== 1 || !rows.rows[0]) throw new Error("Missing ingested attachment");
        return rows.rows[0].id;
      });
      const threadId = await chatThread(tenant);
      const post = (id: string) => ask(token, threadId, [{ kind: "mailAttachment", attachmentId: id }]);
      expect((await post(attachmentId)).status).toBe(202);
      const before = await effects(tenant);
      await expectRefused(await post(randomUUID()));
      expect(await effects(tenant)).toEqual(before);
    });
  });

  it("accepts a thread ref and a merged-away thread ref as given, and refuses an unknown, another tenant's and a Threads item id on both message routes without effects", async () => {
    await withDirectory("semprec-ref-thread-", async (directory) => {
      const tenant = await createTestTenant(admin);
      const foreign = await createTestTenant(admin);
      const { token } = await signIn(tenant);
      const storage = new LocalFsBlobStorageWriter(directory);
      // The reply arrives before the bridge it answers and starts its own thread; the bridge then joins the root,
      // so the root's thread absorbs the reply's.
      const mail = async (tenantId: string) => {
        await runInTenant(tenantId, () => seedSystem(pool));
        return runInTenant(tenantId, () =>
          withTransaction(pool, async (client) => {
            const ids = await mailFixtureIds(client);
            const mailbox = await createItemWithClient(client, {
              databaseId: ids.mailboxesDatabaseId,
              properties: { name: "Mailbox", provider: "generic" },
            });
            const folderItemId = await ensureFolderItem(client, {
              foldersDatabaseId: ids.foldersDatabaseId,
              mailboxItemId: mailbox.id,
              mailboxRelationPropertyId: ids.mailboxFolderRelationPropertyId,
              providerId: "INBOX",
              name: "Inbox",
              behavior: "folder",
              specialPurpose: "inbox",
            });
            const ingest = async (name: string, references: string[]) => {
              const { itemId } = await ingestEmailMessage(client, {
                arrival: "live",
                contentState: "full",
                emailsDatabaseId: ids.emailsDatabaseId,
                filesDatabaseId: ids.filesDatabaseId,
                folderRelationPropertyId: ids.folderRelationPropertyId,
                attachmentsRelationPropertyId: ids.attachmentsRelationPropertyId,
                folderItemId,
                mailboxItemId: mailbox.id,
                messageId: `<${name}-${tenantId}@example.test>`,
                inReplyTo: references.at(-1) ?? null,
                references: references.map((reference) => `<${reference}-${tenantId}@example.test>`),
                subject: name,
                envelope: {},
                attachments: [],
                storage,
                storageKeyPrefix: "ref-thread-test",
              });
              const { rows } = await client.query<{ thread_id: string; item_id: string | null }>(
                `SELECT m.thread_id, t.item_id FROM mail_message_meta m JOIN mail_threads t ON t.id = m.thread_id
                  WHERE m.item_id = $1`,
                [itemId],
              );
              const row = rows[0];
              if (!row?.item_id) throw new Error(`Message ${name} has no thread`);
              return { threadId: row.thread_id, threadItemId: row.item_id };
            };
            const root = await ingest("root", []);
            const merged = await ingest("reply", ["bridge"]);
            const bridge = await ingest("bridge", ["root"]);
            expect(merged.threadId).not.toBe(root.threadId);
            expect(bridge.threadId).toBe(root.threadId);
            return { survivor: root.threadId, merged: merged.threadId, threadItemId: root.threadItemId };
          }),
        );
      };
      const own = await mail(tenant);
      const other = await mail(foreign);
      const threadRef = (id: string) => ({ kind: "mailThread", threadId: id });
      const chatThreadId = await chatThread(tenant);

      expect((await ask(token, chatThreadId, [threadRef(own.survivor), threadRef(own.merged)])).status).toBe(202);
      expect(await userContexts(tenant, chatThreadId)).toEqual([[threadRef(own.survivor), threadRef(own.merged)]]);

      const before = await effects(tenant);
      for (const path of bothRoutes(chatThreadId)) {
        for (const refused of [randomUUID(), other.survivor, other.merged, own.threadItemId]) {
          await expectRefused(
            await ask(token, chatThreadId, [threadRef(own.survivor), threadRef(refused)], path),
            "context[1]",
          );
          expect(await effects(tenant)).toEqual(before);
        }
      }
      expect((await ask(token, chatThreadId, [threadRef(own.merged)], NEW_THREAD)).status).toBe(202);
    });
  });

  it("queues chat messages while leaving an existing approval pending regardless of text", async () => {
    const tenant = await createTestTenant(admin);
    const { token } = await signIn(tenant);
    expect((await send(token, NEW_THREAD, { text: " \n " })).status).toBe(400);
    expect(await effects(tenant)).toEqual({ threads: 0, messages: 0, jobs: 0 });
    const created = await send(token, NEW_THREAD, { text: "first" });
    expect(created.status).toBe(202);
    const first = sentSchema.parse(await created.json());
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
    const sent = await send(token, messagesPath(first.threadId), { text: "approve yes" });
    expect(sent.status).toBe(202);
    const second = sentSchema.parse(await sent.json());
    expect(second.threadId).toBe(first.threadId);
    const jobKey = `sempMessage:${second.assistantMessageId}`;
    const jobs = () =>
      runInTenant(
        tenant,
        async () =>
          (
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
              [jobKey],
            )
          ).rows,
      );
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
    }));
    expect(stored.approval).toEqual([{ status: "pending" }]);
    expect(stored.messages).toEqual([
      { role: "user", status: null, text: "approve yes" },
      { role: "assistant", status: "queued", text: null },
    ]);
    const [job] = await jobs();
    expect(job).toMatchObject({
      key: jobKey,
      queue_name: `semp-chat:${tenant}`,
      task_identifier: "sempMessage",
      max_attempts: 1,
      priority: -1,
    });
    if (!job) throw new Error("Missing queued Semp job");
    // Enqueueing the same message again revises its one job.
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        enqueueSempMessage(client, { threadId: second.threadId, assistantMessageId: second.assistantMessageId }),
      ),
    );
    expect(await jobs()).toEqual([expect.objectContaining({ id: job.id, revision: job.revision + 1 })]);
    // A run answer needs an assistant message the run produced: the first message's queued one.
    await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        expect(await claimSempMessage(client, first.threadId, first.assistantMessageId)).toBe(true);
        const started = await insertAgentRunEvent(client, request.agentRunId, "turn_start", { kind: "turn_start" });
        await startSempMessageTurn(client, first.assistantMessageId, request.agentRunId, started.id);
      }),
    );
    const firstRunRef = { kind: "agentRun", agentRunId: request.agentRunId, messageId: first.assistantMessageId };
    const approvalRef = { kind: "approvalRequest", approvalRequestId: request.id };
    // The same answer posted twice is one ref; a run ref's identity includes `messageId`.
    const withContext = await send(token, NEW_THREAD, {
      text: "context question",
      context: [firstRunRef, approvalRef, { ...firstRunRef }],
    });
    expect(withContext.status).toBe(202);
    const contextMessage = sentSchema.parse(await withContext.json());
    expect(await contextOf(tenant, contextMessage.messageId)).toEqual([[firstRunRef, approvalRef]]);
    const before = await effects(tenant);
    for (const ref of [
      { kind: "agentRun", agentRunId: randomUUID() },
      { kind: "approvalRequest", approvalRequestId: randomUUID() },
    ]) {
      await expectRefused(await ask(token, first.threadId, [ref]));
      expect(await effects(tenant)).toEqual(before);
    }
  });

  it("accepts an agent run ref that names an answer of the run, returns it unchanged in history, and refuses every other message and a messageId on any other kind with the same error", async () => {
    const tenant = await createTestTenant(admin);
    const foreignTenant = await createTestTenant(admin);
    const { token } = await signIn(tenant);
    // A run's actor is a user of its tenant.
    await signIn(foreignTenant);
    const own = await chatWithAnswer(tenant);
    const other = await chatWithAnswer(tenant);
    const foreign = await chatWithAnswer(foreignTenant);
    const post = (context: unknown[], path?: string) => ask(token, own.threadId, context, path);
    const answerRef = { kind: "agentRun", agentRunId: own.runId, messageId: own.answerId };

    const accepted = await post([answerRef]);
    expect(accepted.status).toBe(202);
    const sent = sentSchema.parse(await accepted.json());
    expect(await contextOf(tenant, sent.messageId)).toEqual([[answerRef]]);
    expect(await historyRows(token, own.threadId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sent.messageId, context: [expect.objectContaining(answerRef)] }),
      ]),
    );

    // An answer and its whole run are two refs; neither is a duplicate of the other.
    const wholeRunRef = { kind: "agentRun", agentRunId: own.runId };
    const both = await post([answerRef, wholeRunRef, { ...answerRef }]);
    expect(both.status).toBe(202);
    expect(await contextOf(tenant, sentSchema.parse(await both.json()).messageId)).toEqual([[answerRef, wholeRunRef]]);

    const before = await effects(tenant);
    const ref = (messageId: string) => ({ kind: "agentRun", agentRunId: own.runId, messageId });
    const unknownTargetBody = await expectRefused(await post([{ kind: "agentRun", agentRunId: randomUUID() }]));
    for (const [name, refused] of [
      ["a message of another run", ref(other.answerId)],
      ["a user message", ref(own.userMessageId)],
      ["an unknown message id", ref(randomUUID())],
      ["a message of another tenant", ref(foreign.answerId)],
    ] as const) {
      const response = await post([refused]);
      expect(response.status, name).toBe(400);
      expect(await response.json(), name).toEqual(unknownTargetBody);
      expect(await effects(tenant), name).toEqual(before);
    }
    // A messageId belongs to the agentRun kind alone, on both message routes.
    const stray = randomUUID();
    for (const refused of [
      { kind: "item", itemId: stray, databaseId: stray },
      { kind: "block", itemId: stray, blockId: stray },
      { kind: "transcriptSegment", itemId: stray, startsAt: 0, endsAt: 1 },
      { kind: "mailAttachment", attachmentId: stray },
      { kind: "mailThread", threadId: stray },
      { kind: "approvalRequest", approvalRequestId: stray },
      { kind: "taskOccurrence", seriesId: stray, occurrenceDate: "2026-11-16" },
      { kind: "taskTrace", itemId: stray, databaseId: stray, traceDay: "2026-11-02" },
      { kind: "sleepNight", night: "2026-11-01" },
    ]) {
      for (const path of bothRoutes(own.threadId)) {
        await expectRefused(await post([{ ...refused, messageId: own.answerId }], path), "context[0]", refused.kind);
        expect(await effects(tenant), refused.kind).toEqual(before);
      }
    }
    expect((await post([{ kind: "agentRun", agentRunId: own.runId, messageId: "not-a-uuid" }])).status).toBe(400);
    expect(await effects(tenant)).toEqual(before);
  });

  it("reuses an item thread and refuses a current reserved or decided proposal without effects", async () => {
    const tenant = await createTestTenant(admin);
    const { token } = await signIn(tenant);
    const { inbox, processingProposals: proposals } = await databaseIds(tenant, "inbox", "processingProposals");
    const sourceProperty = await runInTenant(tenant, async () =>
      (await createChokePoint(pool).listProperties(proposals)).find((property) => property.key === "sourceInbox"),
    );
    if (!sourceProperty) throw new Error("Missing sourceInbox property");
    const createSource = (time: string, text: string) =>
      runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          createItemWithClient(client, { databaseId: inbox, properties: { date: "2026-01-01", time, text } }),
        ),
      );
    const createCard = (sourceId: string, status: string) =>
      runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const card = await createItemWithClient(
            client,
            {
              databaseId: proposals,
              properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status },
            },
            { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
          );
          await createRelationWithClient(
            client,
            { relationPropertyId: sourceProperty.id, callerItemId: card.id, targetItemId: sourceId },
            { ownerProcess: "processingProposals" },
          );
          return card.id;
        }),
      );
    const sourceId = (await createSource("12:00", "source")).id;
    const cardId = await createCard(sourceId, "pending");
    const post = (body: unknown) => send(token, NEW_THREAD, body);
    const threadIdOf = async (response: Response) => {
      expect(response.status).toBe(202);
      return z.object({ threadId: z.string().uuid() }).parse(await response.json()).threadId;
    };
    const firstThread = await threadIdOf(
      await post({ text: "first", subject: { inboxItemId: sourceId, proposalId: cardId } }),
    );
    expect(await threadIdOf(await post({ text: "second", subject: { inboxItemId: sourceId } }))).toBe(firstThread);
    expect((await post({ text: "context", context: [], subject: { inboxItemId: sourceId } })).status).toBe(400);
    expect(
      (await post({ text: "bad hint", subject: { inboxItemId: sourceId, proposalId: randomUUID() } })).status,
    ).toBe(400);
    const threadMessages = (threadId: string) =>
      runInTenant(tenant, () =>
        count("SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1", [threadId]),
      );
    expect(await threadMessages(firstThread)).toBe(4);
    const jobsBefore = await allJobs();
    const expectLocked = async (response: Response, code: string) => {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(await threadMessages(firstThread)).toBe(4);
      expect(await allJobs()).toEqual(jobsBefore);
    };

    // A writer holds the card's row while the message arrives.
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
          { databaseId: proposals, itemId: cardId, propertiesPatch: { status: "confirmed" } },
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
      await expectLocked(await post({ text: "during", subject: { inboxItemId: sourceId } }), "version_conflict");
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
    await expectLocked(await post({ text: "after", subject: { inboxItemId: sourceId } }), "proposal_locked");
    const history = z
      .object({ rows: z.array(z.object({ role: z.string(), text: z.string().nullable() })) })
      .parse(await (await getHistory(token, firstThread)).json());
    expect(history.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", text: "first" }),
        expect.objectContaining({ role: "user", text: "second" }),
      ]),
    );

    // A thread started before its source had a card records no proposal, and refuses once a decided card appears.
    const laterSource = await createSource("12:01", "later source");
    const nullHintThread = await threadIdOf(
      await post({ text: "before card", subject: { inboxItemId: laterSource.id } }),
    );
    const hint = await runInTenant(tenant, () =>
      pool.query<{ subject_proposal_id: string | null }>("SELECT subject_proposal_id FROM semp_threads WHERE id = $1", [
        nullHintThread,
      ]),
    );
    expect(hint.rows).toEqual([{ subject_proposal_id: null }]);
    await createCard(laterSource.id, "rejected");
    const beforeRejectedJobs = await allJobs();
    const rejected = await send(token, messagesPath(nullHintThread), { text: "after rejection" });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: "proposal_locked" } });
    expect(await threadMessages(nullHintThread)).toBe(2);
    expect(await allJobs()).toEqual(beforeRejectedJobs);
  });

  it("accepts text-only tick questions and refuses context and foreign threads", async () => {
    const tenant = await createTestTenant(admin);
    const owner = await signIn(tenant);
    const other = await signIn(await createTestTenant(admin));
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
        // The tick writer is private to data; seed its FK-constrained row here.
        return insertId(client, "INSERT INTO semp_threads (kind, heartbeat_id) VALUES ('tick', $1) RETURNING id", [
          heartbeat.id,
        ]);
      }),
    );
    const messages = () =>
      runInTenant(
        tenant,
        async () =>
          (
            await pool.query(
              "SELECT id, role, status, text FROM semp_messages WHERE thread_id = $1 ORDER BY created_at, id",
              [threadId],
            )
          ).rows,
      );
    expect((await ask(owner.token, threadId, [])).status).toBe(400);
    const accepted = await send(owner.token, messagesPath(threadId), { text: "question" });
    expect(accepted.status).toBe(202);
    const ids = sentSchema.omit({ threadId: true }).parse(await accepted.json());
    const before = await messages();
    expect(before).toHaveLength(2);
    const foreign = await send(other.token, messagesPath(threadId), { text: "foreign" });
    const random = await send(other.token, messagesPath(randomUUID()), { text: "foreign" });
    expect([foreign.status, random.status]).toEqual([404, 404]);
    expect(await foreign.text()).toBe(await random.text());
    expect(await messages()).toEqual(before);
    const job = await runInTenant(tenant, () =>
      pool.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [`sempMessage:${ids.assistantMessageId}`]),
    );
    expect(job.rows).toEqual([{ key: `sempMessage:${ids.assistantMessageId}` }]);
  });

  it("serves changed-item cards with the ids of the item, its current state and values, and none for another tenant's thread", async () => {
    const tenant = await createTestTenant(admin);
    const { userId, token } = await signIn(tenant);
    const foreign = await signIn(await createTestTenant(admin));
    const { tasks } = await databaseIds(tenant, "tasks");
    const { moved, deleted } = await runInTenant(tenant, async () => {
      const chokePoint = createChokePoint(pool);
      const movedItem = await chokePoint.createItem({
        databaseId: tasks,
        properties: { name: "Moved task", date: "2026-11-02" },
      });
      const deletedItem = await chokePoint.createItem({ databaseId: tasks, properties: { name: "Deleted task" } });
      await chokePoint.updateItem({ databaseId: tasks, itemId: movedItem.id, propertiesPatch: { date: "2026-11-09" } });
      await chokePoint.softDeleteItem(tasks, deletedItem.id);
      return { moved: movedItem.id, deleted: deletedItem.id };
    });
    const { threadId } = await chatWithAnswer(tenant, userId, {
      steps: [],
      durationMs: null,
      tokens: { input: 0, output: 0 },
      changes: [
        { itemId: moved, databaseId: tasks, change: "updated", changedKeys: ["date"], before: { date: "2026-11-02" } },
        { itemId: deleted, databaseId: tasks, change: "deleted", changedKeys: [] },
      ],
    });

    const rows = await historyRows(token, threadId);
    expect(rows.find((row) => row.role === "assistant")?.changes).toEqual([
      {
        itemId: moved,
        databaseId: tasks,
        change: "updated",
        changedKeys: ["date"],
        before: { date: "2026-11-02" },
        resolved: { label: "Moved task", databaseKey: "tasks", state: "active", values: { date: "2026-11-09" } },
      },
      {
        itemId: deleted,
        databaseId: tasks,
        change: "deleted",
        changedKeys: [],
        resolved: { label: "Deleted task", databaseKey: "tasks", state: "trashed", values: {} },
      },
    ]);
    expect(Object.hasOwn(rows.find((row) => row.role === "user") ?? {}, "changes")).toBe(false);

    const foreignView = await getHistory(foreign.token, threadId);
    expect(foreignView.status).toBe(404);
    expect(await foreignView.text()).not.toContain("Moved task");
  });
});
