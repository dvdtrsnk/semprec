import type { Pool, PoolClient } from "pg";

/**
 * One channel for every realtime message kind — structured-data invalidation and
 * binary CRDT update frames are distinguished only by `type` on this shared channel,
 * not by separate mechanisms (issue #23, point 8).
 */
export const REALTIME_CHANNEL = "semprec_events";

/**
 * Every message here stays a thin reference — an identifier plus just enough to let a
 * client skip a stale echo, never a durable row's content (issue #161). The API fetches
 * whatever a client needs from REST after receiving one of these, with one deliberate
 * exception: `notification_created` carries only `notificationId` on this channel, but
 * `@semprec/realtime`'s WS fan-out fetches the full row before broadcasting it, since a
 * notification's `title` is pre-rendered text with no second enforcement layer.
 */
export type RealtimeMessage =
  | {
      type: "invalidation";
      scope: "item";
      databaseId: string;
      itemId: string;
      op: "create" | "update" | "delete";
      updatedAt: string;
    }
  | { type: "invalidation"; scope: "schema"; databaseId: string }
  | { type: "doc_update"; docId: string; updateId: string; createdBy: string }
  | { type: "agent_run_event"; agentRunId: string; kind: string; payload: unknown }
  | { type: "notification_created"; userId: string; notificationId: string }
  | { type: "notification_read_state"; userId: string; notificationIds: string[] }
  | { type: "session_revoked"; sessionId: string };

/**
 * Postgres caps a NOTIFY payload at ~8000 bytes; every message here stays a couple
 * hundred bytes at most, well under that cap, since none of them carry a durable row's
 * content — see `RealtimeMessage`'s doc comment.
 */
export async function publishRealtimeMessage(pool: Pool | PoolClient, message: RealtimeMessage): Promise<void> {
  await pool.query(`SELECT pg_notify($1, $2)`, [REALTIME_CHANNEL, JSON.stringify(message)]);
}
