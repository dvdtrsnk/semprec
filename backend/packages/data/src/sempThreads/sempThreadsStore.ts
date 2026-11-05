import type { PoolClient } from "pg";

interface ThreadRow {
  id: string;
  kind: "chat" | "item" | "tick";
  title: string | null;
  subject_inbox_item_id: string | null;
  subject_proposal_id: string | null;
  created_at: Date;
  last_activity_at: Date;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system";
  text: string | null;
  system_key: string | null;
  system_params: unknown;
  context: unknown;
  reply_to_message_id: string | null;
  agent_run_id: string | null;
  event_from_id: string | null;
  status: string | null;
  created_at: string;
}

export async function getSempThread(client: PoolClient, id: string) {
  const { rows } = await client.query<ThreadRow>(
    `SELECT id, kind, title, subject_inbox_item_id, subject_proposal_id, created_at, last_activity_at
       FROM semp_threads WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    subject:
      row.kind === "item" ? { inboxItemId: row.subject_inbox_item_id, proposalId: row.subject_proposal_id } : null,
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
    `SELECT id, role, text, system_key, system_params, context, reply_to_message_id, agent_run_id,
            event_from_id, status, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM semp_messages WHERE thread_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC LIMIT $4`,
    [threadId, before?.createdAt ?? null, before?.id ?? null, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page.map((row) => ({
      id: row.id,
      role: row.role,
      text: row.text,
      system: row.system_key === null ? null : { key: row.system_key, params: row.system_params },
      context: row.context,
      replyToMessageId: row.reply_to_message_id,
      agentRunId: row.agent_run_id,
      eventFromId: row.event_from_id,
      status: row.status,
      createdAt: row.created_at,
    })),
    nextCursor:
      hasMore && last
        ? Buffer.from(JSON.stringify({ createdAt: last.created_at, id: last.id })).toString("base64url")
        : null,
  };
}
