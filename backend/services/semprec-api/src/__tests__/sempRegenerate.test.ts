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
  createUser,
  hashPassword,
  insertAgentRunEvent,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  regenerateSempReply,
  withTransaction,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import {
  createApproval,
  createChatRun,
  playReply,
  type ChatRun,
  type PlayedReply,
  type ReplySetup,
} from "./agentRunReplyFixtures.js";
import { createInboxProposalFixture, decideInboxProposal, playItemThreadReply } from "./inboxItemThreadFixtures.js";

/**
 * Regenerating the latest finished Semp reply (issue gh-1930) through the real route, the real store and the real queue
 * tables, on the runtime role pool. Replies are played with the production writers of the turn
 * (`agentRunReplyFixtures.ts`). The store function itself, with every branch of its checks, is covered by
 * `sempRegenerate.test.ts` of `@semprec/data`.
 */

const PASSWORD = "regenerate-test-password";

let admin: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;

interface Tenant extends ReplySetup {
  token: string;
}

async function createTenant(): Promise<Tenant> {
  const tenant = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword(PASSWORD) });
  const session = await login(admin, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { admin, pool, tenant, userId: user.id, token: session.token };
}

interface Played {
  chat: ChatRun;
  reply: PlayedReply;
}

async function playDone(tenant: Tenant, options: { toolCallId?: string; startMs?: number } = {}): Promise<Played> {
  const chat = await createChatRun(tenant);
  const reply = await playReply(tenant, chat, {
    userText: "Question",
    startMs: options.startMs ?? 0,
    ...(options.toolCallId === undefined ? {} : { toolCalls: [{ toolCallId: options.toolCallId }] }),
  });
  return { chat, reply };
}

interface StoredMessage {
  id: string;
  role: string;
  status: string | null;
  attempt: number;
  reply_to_message_id: string | null;
  replaced_by_message_id: string | null;
}

function storedMessages(tenant: Tenant, threadId: string): Promise<StoredMessage[]> {
  return runInTenant(tenant.tenant, async () => {
    const { rows } = await pool.query<StoredMessage>(
      `SELECT id, role, status, attempt, reply_to_message_id, replaced_by_message_id FROM semp_messages
        WHERE thread_id = $1 ORDER BY created_at, id`,
      [threadId],
    );
    return rows;
  });
}

/** The `sempMessage` jobs of the thread's messages, by key (the view of the queue does not project the payload). */
function queuedJobKeys(tenant: Tenant, threadId: string): Promise<string[]> {
  return runInTenant(tenant.tenant, async () => {
    const { rows } = await pool.query<{ key: string }>(
      `SELECT j.key FROM graphile_worker.jobs j JOIN semp_messages m ON j.key = 'sempMessage:' || m.id::text
        WHERE m.thread_id = $1 ORDER BY j.key`,
      [threadId],
    );
    return rows.map((row) => row.key);
  });
}

function regenerate(tenant: Tenant, threadId: string, messageId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/semp/threads/${threadId}/messages/${messageId}/regenerate`, {
    method: "POST",
    headers: { authorization: `Bearer ${tenant.token}` },
  });
}

const newMessageSchema = z.object({ messageId: z.uuid() });

/** Expects a 409 with `code` and nothing created, queued or marked in the thread. */
async function expectRefused(tenant: Tenant, played: Played, code: string): Promise<void> {
  const threadId = played.chat.threadId;
  const before = await storedMessages(tenant, threadId);
  const jobsBefore = await queuedJobKeys(tenant, threadId);

  const response = await regenerate(tenant, threadId, played.reply.assistantMessageId);

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { code } });
  expect(await storedMessages(tenant, threadId)).toEqual(before);
  expect(await queuedJobKeys(tenant, threadId)).toEqual(jobsBefore);
}

describe("regenerating a Semp reply", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://example.test",
      setupToken: "test",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-regenerate-test-${randomUUID()}`)),
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

  it("queues the next attempt of the latest done reply, answers 202 and marks the old reply as replaced", async () => {
    const tenant = await createTenant();
    const played = await playDone(tenant);

    const response = await regenerate(tenant, played.chat.threadId, played.reply.assistantMessageId);

    expect(response.status).toBe(202);
    const { messageId } = newMessageSchema.parse(await response.json());
    const messages = await storedMessages(tenant, played.chat.threadId);
    expect(messages.map((message) => [message.id, message.role, message.status, message.attempt])).toEqual([
      [played.reply.userMessageId, "user", null, 1],
      [played.reply.assistantMessageId, "assistant", "done", 1],
      [messageId, "assistant", "queued", 2],
    ]);
    expect(messages[1]?.replaced_by_message_id).toBe(messageId);
    expect(messages[2]).toMatchObject({
      reply_to_message_id: played.reply.userMessageId,
      replaced_by_message_id: null,
    });
    expect(await queuedJobKeys(tenant, played.chat.threadId)).toEqual(
      [`sempMessage:${played.reply.assistantMessageId}`, `sempMessage:${messageId}`].sort(),
    );
  });

  it("returns replaced on every assistant message of the history, with its steps, and none on a user message", async () => {
    const tenant = await createTenant();
    const played = await playDone(tenant, { toolCallId: "call-1" });
    const { messageId } = newMessageSchema.parse(
      await (await regenerate(tenant, played.chat.threadId, played.reply.assistantMessageId)).json(),
    );

    const response = await fetch(`${baseUrl}/api/semp/threads/${played.chat.threadId}/messages`, {
      headers: { authorization: `Bearer ${tenant.token}` },
    });

    expect(response.status).toBe(200);
    const body = z
      .object({ rows: z.array(z.object({ id: z.string(), role: z.string() }).passthrough()) })
      .parse(await response.json());
    const row = (id: string) => body.rows.find((candidate) => candidate.id === id);
    // The replaced answer stays readable with its steps; the client hides it.
    expect(row(played.reply.assistantMessageId)).toMatchObject({ replaced: true, attempt: 1, status: "done" });
    expect(row(played.reply.assistantMessageId)).toHaveProperty("steps");
    expect(row(messageId)).toMatchObject({ replaced: false, attempt: 2, status: "queued" });
    expect(row(played.reply.userMessageId ?? "")).not.toHaveProperty("replaced");
  });

  it("refuses a reply that is not the latest message of its thread with 409 regenerate_not_latest", async () => {
    const tenant = await createTenant();
    const first = await playDone(tenant);
    await playReply(tenant, first.chat, { userText: "Next question", startMs: 10_000 });

    await expectRefused(tenant, first, "regenerate_not_latest");
  });

  it("refuses a reply that is no longer done, the latest one failed, with 409 regenerate_not_latest", async () => {
    const tenant = await createTenant();
    const chat = await createChatRun(tenant);
    const failed = await playReply(tenant, chat, { userText: "Question", startMs: 0, end: "error" });

    await expectRefused(tenant, { chat, reply: failed }, "regenerate_not_latest");
  });

  it("refuses a reply whose turn requested an approval with 409 regenerate_after_writes and queues nothing", async () => {
    const tenant = await createTenant();
    const played = await playDone(tenant, { toolCallId: "call-1" });
    await createApproval(tenant, played.reply.runId, "call-1");

    await expectRefused(tenant, played, "regenerate_after_writes");
  });

  it("refuses a reply followed by a compaction checkpoint of its conversation with 409 regenerate_after_compaction", async () => {
    const tenant = await createTenant();
    const played = await playDone(tenant);
    await runInTenant(tenant.tenant, () =>
      insertAgentRunEvent(pool, played.reply.runId, "compaction", [
        { id: "c", parentId: null, seq: 0, timestamp: 1, message: { kind: "message", text: "summary" } },
      ]),
    );

    await expectRefused(tenant, played, "regenerate_after_compaction");
  });

  it("refuses a regeneration on an item thread whose proposal was decided with proposal_locked and creates nothing", async () => {
    const tenant = await createTenant();
    const fixture = await createInboxProposalFixture(pool, tenant.tenant);
    const played = await playItemThreadReply(pool, tenant.tenant, fixture, "done");
    await decideInboxProposal(pool, tenant.tenant, fixture);
    const before = await storedMessages(tenant, played.threadId);
    const jobsBefore = await queuedJobKeys(tenant, played.threadId);

    const response = await regenerate(tenant, played.threadId, played.assistantMessageId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "proposal_locked" } });
    expect(await storedMessages(tenant, played.threadId)).toEqual(before);
    expect(await queuedJobKeys(tenant, played.threadId)).toEqual(jobsBefore);
  });

  it("does not let the guard of an item thread with an open proposal change the refusal of the reply itself", async () => {
    const tenant = await createTenant();
    const fixture = await createInboxProposalFixture(pool, tenant.tenant);
    // The played reply has no run range to hide, so the regeneration is refused by its own check, not by the guard.
    const played = await playItemThreadReply(pool, tenant.tenant, fixture, "done");

    const response = await regenerate(tenant, played.threadId, played.assistantMessageId);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "regenerate_not_latest" } });
  });

  it("creates exactly one new message and one job when several regenerations of the same reply arrive at once", async () => {
    const tenant = await createTenant();
    const played = await playDone(tenant);
    // The thread's row lock is held until every request is waiting for it, so all of them are in flight together and
    // the first statement of each is the one that decides the order.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = runInTenant(tenant.tenant, () =>
      withTransaction(pool, async (client) => {
        await client.query("SELECT id FROM semp_threads WHERE id = $1 FOR UPDATE", [played.chat.threadId]);
        locked();
        await released;
      }),
    );
    const pending: Promise<Response>[] = [];
    try {
      await lockHeld;
      for (let request = 0; request < 4; request += 1) {
        pending.push(regenerate(tenant, played.chat.threadId, played.reply.assistantMessageId));
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
    for (const response of responses.filter((candidate) => candidate.status === 409)) {
      expect(await response.json()).toEqual({ error: { code: "regenerate_not_latest" } });
    }
    const messages = await storedMessages(tenant, played.chat.threadId);
    expect(messages.filter((message) => message.role === "assistant" && message.attempt === 2)).toEqual([
      expect.objectContaining({ id: messageId, status: "queued" }),
    ]);
    expect(await queuedJobKeys(tenant, played.chat.threadId)).toEqual(
      [`sempMessage:${played.reply.assistantMessageId}`, `sempMessage:${messageId}`].sort(),
    );
  });

  it("leaves no message, no mark and no job behind when the transaction of an accepted regeneration rolls back", async () => {
    const tenant = await createTenant();
    const played = await playDone(tenant);

    await expect(
      runInTenant(tenant.tenant, () =>
        withTransaction(pool, async (client) => {
          await regenerateSempReply(client, played.chat.threadId, played.reply.assistantMessageId);
          throw new Error("rollback sentinel");
        }),
      ),
    ).rejects.toThrow("rollback sentinel");

    const messages = await storedMessages(tenant, played.chat.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.replaced_by_message_id).toBeNull();
    expect(await queuedJobKeys(tenant, played.chat.threadId)).toEqual([
      `sempMessage:${played.reply.assistantMessageId}`,
    ]);
  });

  it("answers an unknown message of the caller's own thread and an unknown thread with 404", async () => {
    const tenant = await createTenant();
    const played = await playDone(tenant);

    expect((await regenerate(tenant, played.chat.threadId, randomUUID())).status).toBe(404);
    expect((await regenerate(tenant, randomUUID(), played.reply.assistantMessageId)).status).toBe(404);
    expect(await storedMessages(tenant, played.chat.threadId)).toHaveLength(2);
  });

  it("answers another tenant's thread and message exactly as unknown ones, and changes nothing in either", async () => {
    const owner = await createTenant();
    const caller = await createTenant();
    const foreign = await playDone(owner);
    const own = await playDone(caller);

    const foreignAnswer = await regenerate(caller, foreign.chat.threadId, foreign.reply.assistantMessageId);
    const randomAnswer = await regenerate(caller, randomUUID(), randomUUID());
    // The foreign message id in a thread of the caller's own is not found there either.
    const mixedAnswer = await regenerate(caller, own.chat.threadId, foreign.reply.assistantMessageId);
    const randomInOwnThread = await regenerate(caller, own.chat.threadId, randomUUID());

    expect(foreignAnswer.status).toBe(404);
    expect(foreignAnswer.status).toBe(randomAnswer.status);
    expect(await foreignAnswer.text()).toBe(await randomAnswer.text());
    expect(mixedAnswer.status).toBe(404);
    expect(await mixedAnswer.text()).toBe(await randomInOwnThread.text());
    expect(await storedMessages(owner, foreign.chat.threadId)).toHaveLength(2);
    expect((await storedMessages(owner, foreign.chat.threadId))[1]?.replaced_by_message_id).toBeNull();
    expect(await queuedJobKeys(owner, foreign.chat.threadId)).toEqual([
      `sempMessage:${foreign.reply.assistantMessageId}`,
    ]);
    expect(await storedMessages(caller, own.chat.threadId)).toHaveLength(2);
    // The owner's own regeneration works, so the answers above are not a route that refuses everything.
    expect((await regenerate(owner, foreign.chat.threadId, foreign.reply.assistantMessageId)).status).toBe(202);
  });

  it("rejects a malformed id with 400 and requires a session", async () => {
    const tenant = await createTenant();
    const played = await playDone(tenant);

    expect((await regenerate(tenant, "not-a-uuid", played.reply.assistantMessageId)).status).toBe(400);
    expect((await regenerate(tenant, played.chat.threadId, "not-a-uuid")).status).toBe(400);
    const anonymous = await fetch(
      `${baseUrl}/api/semp/threads/${played.chat.threadId}/messages/${played.reply.assistantMessageId}/regenerate`,
      { method: "POST" },
    );
    expect(anonymous.status).toBe(401);
    expect(await storedMessages(tenant, played.chat.threadId)).toHaveLength(2);
  });
});
