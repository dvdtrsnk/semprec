import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  claimSempMessage,
  createUser,
  finishSempMessageTurn,
  getSempMessageTurn,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  retrySempReply,
  sendSempMessage,
  withTransaction,
  type SempReplyStep,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { createInboxProposalFixture, decideInboxProposal, playItemThreadReply } from "./inboxItemThreadFixtures.js";

/**
 * Retrying a failed or incomplete Semp reply (issue gh-1926) through the real route, the real store and the real
 * queue tables, on the runtime role pool. Replies are played with the production writers: a message is sent, claimed
 * by the turn and finished with `finishSempMessageTurn`.
 */

const PASSWORD = "retry-test-password";

let admin: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;

interface Tenant {
  tenantId: string;
  token: string;
}

async function createTenant(): Promise<Tenant> {
  const tenantId = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  await createUser(admin, { tenantId, email, passwordHash: await hashPassword(PASSWORD) });
  const session = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { tenantId, token: session.token };
}

function step(status: "ok" | "error", errorCode?: string): SempReplyStep {
  return {
    kind: "tool",
    toolName: "mcp_search_aaaaaaaa",
    label: { key: "agentStep.title.namedTool", params: { toolName: "mcp_search_aaaaaaaa" } },
    detail: { key: status === "ok" ? "agentStep.summary.done" : "agentStep.summary.failed", params: {} },
    status,
    startedAt: "2026-11-01T10:00:00.000Z",
    durationMs: 40,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

type Outcome = "error" | "done" | "doneIncomplete" | "doneComplete";

interface PlayedReply {
  threadId: string;
  userMessageId: string;
  assistantMessageId: string;
}

/** Sends a message (into `threadId` when given) and plays its turn to `outcome` (`null` leaves the reply queued). */
async function playReply(tenant: Tenant, outcome: Outcome | null, threadId?: string): Promise<PlayedReply> {
  return runInTenant(tenant.tenantId, () =>
    withTransaction(pool, async (client) => {
      const sent = await sendSempMessage(client, {
        ...(threadId === undefined ? {} : { threadId }),
        text: "Question",
        context: [],
        hasContext: false,
      });
      if (outcome !== null) {
        expect(await claimSempMessage(client, sent.threadId, sent.assistantMessageId)).toBe(true);
        const done = {
          status: "done" as const,
          text: "Answer",
          // The turn's last event id; this reply has no run, so the id only has to be a valid bigint.
          lastEventId: "1",
        };
        const summary = (steps: SempReplyStep[]) => ({
          steps,
          durationMs: 100,
          tokens: { input: 1, output: 1 },
          changes: [],
        });
        const finished =
          outcome === "error"
            ? await finishSempMessageTurn(client, sent.assistantMessageId, {
                status: "error",
                errorCode: "modelError",
              })
            : outcome === "doneIncomplete"
              ? await finishSempMessageTurn(client, sent.assistantMessageId, {
                  ...done,
                  summary: summary([step("error", "timeout")]),
                })
              : await finishSempMessageTurn(client, sent.assistantMessageId, {
                  ...done,
                  summary: summary([step("ok")]),
                });
        expect(finished).toBe(true);
      }
      return {
        threadId: sent.threadId,
        userMessageId: sent.messageId,
        assistantMessageId: sent.assistantMessageId,
      };
    }),
  );
}

interface StoredMessage {
  id: string;
  role: string;
  status: string | null;
  reply_to_message_id: string | null;
  attempt: number;
}

function storedMessages(tenant: Tenant, threadId: string): Promise<StoredMessage[]> {
  return runInTenant(tenant.tenantId, () =>
    withTransaction(pool, async (client) => {
      const { rows } = await client.query<StoredMessage>(
        `SELECT id, role, status, reply_to_message_id, attempt FROM semp_messages
          WHERE thread_id = $1 ORDER BY created_at, id`,
        [threadId],
      );
      return rows;
    }),
  );
}

/** The `sempMessage` jobs of the thread's messages, by key (the view of the queue does not project the payload). */
function queuedJobKeys(tenant: Tenant, threadId: string): Promise<string[]> {
  return runInTenant(tenant.tenantId, () =>
    withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `SELECT j.key FROM graphile_worker.jobs j JOIN semp_messages m ON j.key = 'sempMessage:' || m.id::text
          WHERE m.thread_id = $1 ORDER BY j.key`,
        [threadId],
      );
      return rows.map((row) => row.key);
    }),
  );
}

function retry(tenant: Tenant, threadId: string, messageId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/semp/threads/${threadId}/messages/${messageId}/retry`, {
    method: "POST",
    headers: { authorization: `Bearer ${tenant.token}` },
  });
}

const newMessageSchema = z.object({ messageId: z.uuid() });

describe("retrying a Semp reply", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://example.test",
      setupToken: "test",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-retry-test-${randomUUID()}`)),
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

  it.each<{ outcome: Outcome; label: string }>([
    { outcome: "error", label: "a reply that failed" },
    { outcome: "doneIncomplete", label: "a done reply that left a failed tool call" },
  ])("queues attempt 2 of the same message for $label", async ({ outcome }) => {
    const tenant = await createTenant();
    const played = await playReply(tenant, outcome);

    const response = await retry(tenant, played.threadId, played.assistantMessageId);

    expect(response.status).toBe(202);
    const { messageId } = newMessageSchema.parse(await response.json());
    const messages = await storedMessages(tenant, played.threadId);
    expect(messages.map((message) => [message.id, message.role, message.status, message.attempt])).toEqual([
      [played.userMessageId, "user", null, 1],
      [played.assistantMessageId, "assistant", outcome === "error" ? "error" : "done", 1],
      [messageId, "assistant", "queued", 2],
    ]);
    expect(messages.find((message) => message.id === messageId)?.reply_to_message_id).toBe(played.userMessageId);
    expect(await queuedJobKeys(tenant, played.threadId)).toEqual(
      [`sempMessage:${played.assistantMessageId}`, `sempMessage:${messageId}`].sort(),
    );
  });

  it("numbers the attempt one above the retried reply, so a retry of a retry is attempt 3", async () => {
    const tenant = await createTenant();
    const played = await playReply(tenant, "error");
    const second = newMessageSchema.parse(
      await (await retry(tenant, played.threadId, played.assistantMessageId)).json(),
    );
    await runInTenant(tenant.tenantId, () =>
      withTransaction(pool, async (client) => {
        expect(await claimSempMessage(client, played.threadId, second.messageId)).toBe(true);
        expect(
          await finishSempMessageTurn(client, second.messageId, { status: "error", errorCode: "modelError" }),
        ).toBe(true);
      }),
    );

    const response = await retry(tenant, played.threadId, second.messageId);

    expect(response.status).toBe(202);
    const third = newMessageSchema.parse(await response.json());
    const messages = await storedMessages(tenant, played.threadId);
    expect(messages.filter((message) => message.role === "assistant").map((message) => message.attempt)).toEqual([
      1, 2, 3,
    ]);
    expect(messages.at(-1)).toMatchObject({ id: third.messageId, reply_to_message_id: played.userMessageId });
  });

  it("hands the turn of a retry the text and refs of the user message it answers, not those of the message before it", async () => {
    const tenant = await createTenant();
    const ref = { kind: "agentRun", agentRunId: randomUUID() };
    const played = await runInTenant(tenant.tenantId, () =>
      withTransaction(pool, async (client) => {
        // The refs are stored as the send path stores them after it validated them; the turn only reads them back.
        const sent = await sendSempMessage(client, { text: "Question with a ref", context: [ref], hasContext: true });
        expect(await claimSempMessage(client, sent.threadId, sent.assistantMessageId)).toBe(true);
        expect(
          await finishSempMessageTurn(client, sent.assistantMessageId, { status: "error", errorCode: "modelError" }),
        ).toBe(true);
        return sent;
      }),
    );
    const { messageId } = newMessageSchema.parse(
      await (await retry(tenant, played.threadId, played.assistantMessageId)).json(),
    );

    const turn = await runInTenant(tenant.tenantId, () =>
      withTransaction(pool, (client) => getSempMessageTurn(client, played.threadId, messageId)),
    );

    expect(turn).toMatchObject({
      sourceId: played.messageId,
      role: "user",
      text: "Question with a ref",
      context: [ref],
    });
  });

  it("refuses a reply that is not the latest message of its thread and creates nothing", async () => {
    const tenant = await createTenant();
    const first = await playReply(tenant, "error");
    await playReply(tenant, "doneComplete", first.threadId);
    const before = await storedMessages(tenant, first.threadId);
    const jobsBefore = await queuedJobKeys(tenant, first.threadId);

    const response = await retry(tenant, first.threadId, first.assistantMessageId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "retry_not_latest" } });
    expect(await storedMessages(tenant, first.threadId)).toEqual(before);
    expect(await queuedJobKeys(tenant, first.threadId)).toEqual(jobsBefore);
  });

  it("refuses a successful reply and creates nothing", async () => {
    const tenant = await createTenant();
    const played = await playReply(tenant, "doneComplete");
    const before = await storedMessages(tenant, played.threadId);

    const response = await retry(tenant, played.threadId, played.assistantMessageId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "retry_not_latest" } });
    expect(await storedMessages(tenant, played.threadId)).toEqual(before);
    expect(await queuedJobKeys(tenant, played.threadId)).toEqual([`sempMessage:${played.assistantMessageId}`]);
  });

  it.each<{ outcome: null | "running"; label: string }>([
    { outcome: null, label: "queued" },
    { outcome: "running", label: "running" },
  ])("refuses a reply whose turn is still $label", async ({ outcome }) => {
    const tenant = await createTenant();
    const played = await playReply(tenant, null);
    if (outcome === "running") {
      await runInTenant(tenant.tenantId, () =>
        withTransaction(pool, async (client) => {
          expect(await claimSempMessage(client, played.threadId, played.assistantMessageId)).toBe(true);
        }),
      );
    }

    const response = await retry(tenant, played.threadId, played.assistantMessageId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "retry_not_latest" } });
    expect(await storedMessages(tenant, played.threadId)).toHaveLength(2);
  });

  it("refuses a message that is not an assistant message, the latest message of the thread included", async () => {
    const tenant = await createTenant();
    const threadId = await runInTenant(tenant.tenantId, () =>
      withTransaction(pool, async (client) => {
        const created = await client.query<{ id: string }>(
          "INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id",
        );
        const id = created.rows[0]?.id;
        if (!id) throw new Error("Missing thread");
        return id;
      }),
    );
    // Raw fixture: a thread whose latest message is a user message cannot be produced by the send route, which
    // always queues the assistant reply with it.
    const userMessageId = await runInTenant(tenant.tenantId, async () => {
      const inserted = await pool.query<{ id: string }>(
        "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', 'Unanswered') RETURNING id",
        [threadId],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error("Missing message");
      return id;
    });

    const response = await retry(tenant, threadId, userMessageId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "retry_not_latest" } });
    expect(await storedMessages(tenant, threadId)).toHaveLength(1);
  });

  it("refuses a failed assistant message that answers no message, because there is nothing to send again", async () => {
    const tenant = await createTenant();
    const orphan = await runInTenant(tenant.tenantId, async () => {
      const created = await pool.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
      const threadId = created.rows[0]?.id;
      if (!threadId) throw new Error("Missing thread");
      // Raw fixture: the send path always sets `reply_to_message_id`, so a reply without it cannot be produced by it.
      const inserted = await pool.query<{ id: string }>(
        "INSERT INTO semp_messages (thread_id, role, status) VALUES ($1, 'assistant', 'error') RETURNING id",
        [threadId],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error("Missing message");
      return { threadId, id };
    });

    const response = await retry(tenant, orphan.threadId, orphan.id);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "retry_not_latest" } });
    expect(await storedMessages(tenant, orphan.threadId)).toHaveLength(1);
  });

  it("creates exactly one new message and one job when several retries of the same reply arrive at once", async () => {
    const tenant = await createTenant();
    const played = await playReply(tenant, "error");
    // The thread's row lock is held until every request is waiting for it, so all of them are in flight together
    // and the first statement of each is the one that decides the order.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = runInTenant(tenant.tenantId, () =>
      withTransaction(pool, async (client) => {
        await client.query("SELECT id FROM semp_threads WHERE id = $1 FOR UPDATE", [played.threadId]);
        locked();
        await released;
      }),
    );
    const pending: Promise<Response>[] = [];
    try {
      await lockHeld;
      for (let request = 0; request < 4; request += 1) {
        pending.push(retry(tenant, played.threadId, played.assistantMessageId));
      }
      await vi.waitFor(
        async () => {
          const waiting = await admin.query<{ waiting: number }>(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
              WHERE wait_event_type = 'Lock' AND query LIKE '%semp_threads%FOR UPDATE%'`,
          );
          expect(waiting.rows[0]?.waiting).toBeGreaterThanOrEqual(4);
        },
        { timeout: 10_000 },
      );
    } finally {
      release();
      await holder;
    }
    const responses = await Promise.all(pending);

    expect(responses.map((response) => response.status).sort()).toEqual([202, 409, 409, 409]);
    const winner = responses.find((response) => response.status === 202);
    const { messageId } = newMessageSchema.parse(await winner?.json());
    const messages = await storedMessages(tenant, played.threadId);
    expect(messages.filter((message) => message.role === "assistant" && message.attempt === 2)).toEqual([
      expect.objectContaining({ id: messageId, status: "queued" }),
    ]);
    expect(await queuedJobKeys(tenant, played.threadId)).toEqual(
      [`sempMessage:${played.assistantMessageId}`, `sempMessage:${messageId}`].sort(),
    );
  });

  it("queues a retry on an item thread whose proposal is still open, as a sent message is accepted there", async () => {
    const tenant = await createTenant();
    const fixture = await createInboxProposalFixture(pool, tenant.tenantId);
    const played = await playItemThreadReply(pool, tenant.tenantId, fixture, "error");

    const response = await retry(tenant, played.threadId, played.assistantMessageId);

    expect(response.status).toBe(202);
    const { messageId } = newMessageSchema.parse(await response.json());
    const messages = await storedMessages(tenant, played.threadId);
    expect(messages.map((message) => [message.id, message.role, message.status, message.attempt])).toEqual([
      [played.userMessageId, "user", null, 1],
      [played.assistantMessageId, "assistant", "error", 1],
      [messageId, "assistant", "queued", 2],
    ]);
    expect(await queuedJobKeys(tenant, played.threadId)).toEqual(
      [`sempMessage:${played.assistantMessageId}`, `sempMessage:${messageId}`].sort(),
    );
  });

  it("refuses a retry on an item thread whose proposal was decided with the refusal of the send path and creates nothing", async () => {
    const tenant = await createTenant();
    const fixture = await createInboxProposalFixture(pool, tenant.tenantId);
    const played = await playItemThreadReply(pool, tenant.tenantId, fixture, "error");
    await decideInboxProposal(pool, tenant.tenantId, fixture);
    const before = await storedMessages(tenant, played.threadId);
    const jobsBefore = await queuedJobKeys(tenant, played.threadId);

    const response = await retry(tenant, played.threadId, played.assistantMessageId);
    // The send path answers the same for a new message to the same thread.
    const send = await fetch(`${baseUrl}/api/semp/threads`, {
      method: "POST",
      headers: { authorization: `Bearer ${tenant.token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "after", subject: { inboxItemId: fixture.sourceId } }),
    });

    expect(send.status).toBe(409);
    expect(response.status).toBe(send.status);
    expect(await response.json()).toEqual(await send.json());
    expect(await storedMessages(tenant, played.threadId)).toEqual(before);
    expect(await queuedJobKeys(tenant, played.threadId)).toEqual(jobsBefore);
  });

  it("refuses a second assistant message of the same attempt of one reply at the index", async () => {
    const tenant = await createTenant();
    const played = await playReply(tenant, "error");

    // Raw statement: the retry route never reaches the index because it takes the thread lock first; this inserts
    // what a writer that skipped the lock would, to show that the database refuses it.
    await expect(
      runInTenant(tenant.tenantId, () =>
        pool.query(
          "INSERT INTO semp_messages (thread_id, role, reply_to_message_id, status, attempt) VALUES ($1, 'assistant', $2, 'queued', 1)",
          [played.threadId, played.userMessageId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "semp_messages_reply_attempt_uq" });
    await expect(
      runInTenant(tenant.tenantId, () =>
        pool.query(
          "INSERT INTO semp_messages (thread_id, role, reply_to_message_id, status, attempt) VALUES ($1, 'assistant', $2, 'queued', 2)",
          [played.threadId, played.userMessageId],
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("leaves no message and no job behind when the transaction of an accepted retry rolls back", async () => {
    const tenant = await createTenant();
    const played = await playReply(tenant, "error");

    await expect(
      runInTenant(tenant.tenantId, () =>
        withTransaction(pool, async (client) => {
          await retrySempReply(client, played.threadId, played.assistantMessageId);
          throw new Error("rollback sentinel");
        }),
      ),
    ).rejects.toThrow("rollback sentinel");

    expect(await storedMessages(tenant, played.threadId)).toHaveLength(2);
    expect(await queuedJobKeys(tenant, played.threadId)).toEqual([`sempMessage:${played.assistantMessageId}`]);
  });

  it("answers an unknown message of the caller's own thread and an unknown thread with 404", async () => {
    const tenant = await createTenant();
    const played = await playReply(tenant, "error");

    const unknownMessage = await retry(tenant, played.threadId, randomUUID());
    const unknownThread = await retry(tenant, randomUUID(), played.assistantMessageId);

    expect(unknownMessage.status).toBe(404);
    expect(unknownThread.status).toBe(404);
    expect(await storedMessages(tenant, played.threadId)).toHaveLength(2);
  });

  it("answers another tenant's thread and message exactly as unknown ones, and creates nothing in either", async () => {
    const owner = await createTenant();
    const caller = await createTenant();
    const foreign = await playReply(owner, "error");
    const own = await playReply(caller, "error");

    const foreignAnswer = await retry(caller, foreign.threadId, foreign.assistantMessageId);
    const randomAnswer = await retry(caller, randomUUID(), randomUUID());
    // The foreign message id in a thread of the caller's own is not found there either.
    const mixedAnswer = await retry(caller, own.threadId, foreign.assistantMessageId);
    const randomInOwnThread = await retry(caller, own.threadId, randomUUID());

    expect(foreignAnswer.status).toBe(404);
    expect(foreignAnswer.status).toBe(randomAnswer.status);
    expect(await foreignAnswer.text()).toBe(await randomAnswer.text());
    expect(mixedAnswer.status).toBe(404);
    expect(await mixedAnswer.text()).toBe(await randomInOwnThread.text());
    expect(await storedMessages(owner, foreign.threadId)).toHaveLength(2);
    expect(await queuedJobKeys(owner, foreign.threadId)).toEqual([`sempMessage:${foreign.assistantMessageId}`]);
    expect(await storedMessages(caller, own.threadId)).toHaveLength(2);
    // The owner's own retry works, so the answers above are not a route that refuses everything.
    expect((await retry(owner, foreign.threadId, foreign.assistantMessageId)).status).toBe(202);
  });

  it("rejects a malformed id with 400 before any lookup", async () => {
    const tenant = await createTenant();
    const played = await playReply(tenant, "error");

    expect((await retry(tenant, "not-a-uuid", played.assistantMessageId)).status).toBe(400);
    expect((await retry(tenant, played.threadId, "not-a-uuid")).status).toBe(400);
    expect(await storedMessages(tenant, played.threadId)).toHaveLength(2);
  });

  it("requires a session", async () => {
    const tenant = await createTenant();
    const played = await playReply(tenant, "error");

    const response = await fetch(
      `${baseUrl}/api/semp/threads/${played.threadId}/messages/${played.assistantMessageId}/retry`,
      { method: "POST" },
    );

    expect(response.status).toBe(401);
    expect(await storedMessages(tenant, played.threadId)).toHaveLength(2);
  });

  it("returns the attempt of every assistant message in the history and none for a user message", async () => {
    const tenant = await createTenant();
    const played = await playReply(tenant, "error");
    const retried = newMessageSchema.parse(
      await (await retry(tenant, played.threadId, played.assistantMessageId)).json(),
    );

    const response = await fetch(`${baseUrl}/api/semp/threads/${played.threadId}/messages`, {
      headers: { authorization: `Bearer ${tenant.token}` },
    });

    expect(response.status).toBe(200);
    const body = z
      .object({ rows: z.array(z.object({ id: z.string(), role: z.string() }).passthrough()) })
      .parse(await response.json());
    const row = (id: string) => body.rows.find((candidate) => candidate.id === id);
    expect(row(played.assistantMessageId)).toMatchObject({ attempt: 1, replyToMessageId: played.userMessageId });
    expect(row(retried.messageId)).toMatchObject({ attempt: 2, replyToMessageId: played.userMessageId });
    expect(row(played.userMessageId)).not.toHaveProperty("attempt");
  });
});
