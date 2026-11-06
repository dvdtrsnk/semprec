import type { PoolClient } from "pg";
import { requireAffectedRows, requireManagedTransaction, requireSingleRow } from "../db/pool.js";
import { enqueueSempMessage } from "../semp/sempMessageQueue.js";
import { allocateSempMessageTimestamp } from "../semp/sempMessageOrder.js";
import { assertKnownValue } from "../dbRowValidation.js";
import type { SempThreadMessage } from "@semprec/shared";
import { NotFoundError, ValidationError } from "../errors.js";
import { guardInboxThreadSend } from "../inbox/inboxThreadSendGuard.js";
import { resolveSempHistoryContexts } from "../semp/sempRefHistory.js";

interface ThreadRow {
  id: string;
  kind: string;
  title: string | null;
  subject_inbox_item_id: string | null;
  subject_proposal_id: string | null;
  created_at: Date;
  last_activity_at: Date;
}

interface MessageRow {
  id: string;
  role: string;
  text: string | null;
  system_key: string | null;
  system_params: unknown;
  context: unknown;
  reply_to_message_id: string | null;
  agent_run_id: string | null;
  event_from_id: string | null;
  status: string | null;
  created_at: string;
  run_started_at: Date | null;
  run_finished_at: Date | null;
  run_status: string | null;
}

export async function createSempChatThread(client: PoolClient): Promise<string> {
  requireManagedTransaction(client);
  const result = await client.query<{ id: string }>("INSERT INTO semp_threads (kind) VALUES ('chat') RETURNING id");
  return requireSingleRow(result.rows, "creating Semp chat thread").id;
}

export async function getSempMessageTurn(client: PoolClient, threadId: string, messageId: string) {
  const { rows } = await client.query<{
    kind: string;
    heartbeat_id: string | null;
    project_item_id: string | null;
    role: string;
    source_id: string;
    text: string | null;
    context: unknown;
  }>(
    `SELECT t.kind, t.heartbeat_id, h.project_item_id, source.id AS source_id, source.role, source.text, source.context
       FROM semp_messages reply
       JOIN semp_threads t ON t.tenant_id = reply.tenant_id AND t.id = reply.thread_id
       JOIN semp_messages source ON source.tenant_id = reply.tenant_id AND source.id = reply.reply_to_message_id
         AND source.thread_id = reply.thread_id
       LEFT JOIN project_heartbeats h ON h.tenant_id = t.tenant_id AND h.id = t.heartbeat_id
      WHERE reply.id = $1 AND reply.thread_id = $2 AND reply.role = 'assistant'`,
    [messageId, threadId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    kind: assertKnownValue(["chat", "item", "tick"] as const, row.kind, "thread kind"),
    heartbeatId: row.heartbeat_id,
    projectItemId: row.project_item_id,
    role: assertKnownValue(["user", "system"] as const, row.role, "source message role"),
    sourceId: row.source_id,
    text: row.text,
    context: row.context,
  };
}

export async function insertSempUserTurn(
  client: PoolClient,
  threadId: string,
  text: string,
  context: unknown,
  trusted?: { source: "voice" },
): Promise<{ threadId: string; messageId: string; assistantMessageId: string }> {
  requireManagedTransaction(client);
  const userTimestamp = await allocateSempMessageTimestamp(client, threadId);
  const user = await client.query<{ id: string }>(
    "INSERT INTO semp_messages (thread_id, role, text, context, created_at, source) VALUES ($1, 'user', $2, $3::jsonb, $4::timestamptz, $5) RETURNING id",
    [threadId, text, JSON.stringify(context), userTimestamp, trusted?.source ?? null],
  );
  const messageId = requireSingleRow(user.rows, "inserting Semp user message").id;
  const assistantTimestamp = await allocateSempMessageTimestamp(client, threadId);
  const assistant = await client.query<{ id: string }>(
    "INSERT INTO semp_messages (thread_id, role, reply_to_message_id, status, created_at) VALUES ($1, 'assistant', $2, 'queued', $3::timestamptz) RETURNING id",
    [threadId, messageId, assistantTimestamp],
  );
  const assistantMessageId = requireSingleRow(assistant.rows, "inserting Semp assistant message").id;
  const updated = await client.query(
    "UPDATE semp_threads SET last_activity_at = GREATEST(last_activity_at, now()) WHERE id = $1",
    [threadId],
  );
  requireAffectedRows(updated, "updating Semp thread activity");
  await enqueueSempMessage(client, { threadId, assistantMessageId });
  return { threadId, messageId, assistantMessageId };
}

export async function sendSempMessage(
  client: PoolClient,
  input: {
    threadId?: string;
    subject?: { inboxItemId: string; proposalId?: string };
    text: string;
    context: unknown;
    hasContext: boolean;
  },
  trusted?: { source: "voice" },
) {
  requireManagedTransaction(client);
  let threadId = input.threadId;
  let subject = input.subject;
  let originalKind: "chat" | "item" | "tick" | undefined;
  if (threadId) {
    const existing = await client.query<{ kind: string; subject_inbox_item_id: string | null }>(
      "SELECT kind, subject_inbox_item_id FROM semp_threads WHERE id = $1",
      [threadId],
    );
    const row = existing.rows[0];
    if (!row) throw new NotFoundError("Thread not found");
    const kind = assertKnownValue(["chat", "item", "tick"] as const, row.kind, "thread kind");
    originalKind = kind;
    if (kind === "item") {
      if (!row.subject_inbox_item_id) throw new Error("Item thread has no Inbox subject");
      subject = { inboxItemId: row.subject_inbox_item_id };
    }
  }
  if (subject) {
    if (input.hasContext) throw new ValidationError("Context is only supported for chat threads", { field: "context" });
    await guardInboxThreadSend(client, subject.inboxItemId, subject.proposalId);
    if (!threadId) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO semp_threads (kind, subject_inbox_item_id, subject_proposal_id)
         VALUES ('item', $1, $2) ON CONFLICT (tenant_id, subject_inbox_item_id) WHERE kind = 'item'
         DO NOTHING RETURNING id`,
        [subject.inboxItemId, subject.proposalId ?? null],
      );
      threadId = result.rows[0]?.id;
      if (!threadId) {
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM semp_threads WHERE kind = 'item' AND subject_inbox_item_id = $1",
          [subject.inboxItemId],
        );
        threadId = requireSingleRow(existing.rows, "finding item thread").id;
      }
    }
  } else if (!threadId) {
    threadId = await createSempChatThread(client);
  }
  const locked = await client.query<{ kind: string; subject_inbox_item_id: string | null }>(
    "SELECT kind, subject_inbox_item_id FROM semp_threads WHERE id = $1 FOR UPDATE",
    [threadId],
  );
  const row = locked.rows[0];
  if (!row) throw new NotFoundError("Thread not found");
  const kind = assertKnownValue(["chat", "item", "tick"] as const, row.kind, "thread kind");
  if (originalKind && kind !== originalKind) throw new NotFoundError("Thread not found");
  if (subject && (kind !== "item" || row.subject_inbox_item_id !== subject.inboxItemId)) {
    throw new NotFoundError("Thread not found");
  }
  if (kind !== "chat" && input.hasContext) {
    throw new ValidationError("Context is only supported for chat threads", { field: "context" });
  }
  return insertSempUserTurn(client, threadId, input.text, input.context, trusted);
}

export async function getSempThread(client: PoolClient, id: string) {
  const { rows } = await client.query<ThreadRow>(
    `SELECT id, kind, title, subject_inbox_item_id, subject_proposal_id, created_at, last_activity_at
       FROM semp_threads WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const kind = assertKnownValue(["chat", "item", "tick"] as const, row.kind, "thread kind");
  return {
    id: row.id,
    kind,
    title: row.title,
    subject: kind === "item" ? { inboxItemId: row.subject_inbox_item_id, proposalId: row.subject_proposal_id } : null,
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
  };
}

export async function listSempThreadMessages(
  client: PoolClient,
  threadId: string,
  limit: number,
  before: { createdAt: string; id: string } | null,
) {
  const { rows } = await client.query<MessageRow>(
    `SELECT m.id, m.role, m.text, m.system_key, m.system_params, m.context, m.reply_to_message_id, m.agent_run_id,
            m.event_from_id, m.status, to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            r.started_at AS run_started_at, r.finished_at AS run_finished_at, r.status AS run_status
       FROM semp_messages m LEFT JOIN agent_runs r ON r.tenant_id = m.tenant_id AND r.id = m.agent_run_id
       WHERE m.thread_id = $1
         AND ($2::timestamptz IS NULL OR (m.created_at, m.id) < ($2::timestamptz, $3::uuid))
       ORDER BY m.created_at DESC, m.id DESC LIMIT $4`,
    [threadId, before?.createdAt ?? null, before?.id ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const contexts = await resolveSempHistoryContexts(
    client,
    page.map((row) => row.context),
  );
  const last = page.at(-1);
  return {
    rows: page.map((row, index): SempThreadMessage => ({
      id: row.id,
      role: assertKnownValue(["user", "assistant", "system"] as const, row.role, "message role"),
      text: row.text,
      system: row.system_key === null ? null : { key: row.system_key, params: row.system_params },
      context: contexts[index],
      replyToMessageId: row.reply_to_message_id,
      agentRunId: row.agent_run_id,
      eventFromId: row.event_from_id,
      status: row.status,
      createdAt: row.created_at,
      run:
        row.run_started_at === null
          ? null
          : {
              startedAt: row.run_started_at.toISOString(),
              finishedAt: row.run_finished_at?.toISOString() ?? null,
              status: assertKnownValue(["running", "done", "error"] as const, row.run_status ?? "", "run status"),
            },
    })),
    nextCursor:
      hasMore && last
        ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString("base64url")
        : null,
  };
}
