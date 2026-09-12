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
      userId?: string;
    }
  | { type: "invalidation"; scope: "schema"; databaseId: string; userId?: string }
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

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * Validates a NOTIFY payload against `RealtimeMessage`'s closed catalog before the listener trusts
 * its shape — this channel only ever carries this process's own `publishRealtimeMessage` writes,
 * but treating a parsed external payload as already-typed (a bare `as RealtimeMessage`) would let a
 * malformed or unexpected payload flow through as if it were valid. Returns `null`, never throws,
 * so the caller can drop an unrecognized message the same way it already drops unparsable JSON.
 */
export function parseRealtimeMessage(raw: unknown): RealtimeMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;

  switch (value.type) {
    case "invalidation": {
      if (value.scope === "item") {
        if (
          typeof value.databaseId === "string" &&
          typeof value.itemId === "string" &&
          (value.op === "create" || value.op === "update" || value.op === "delete") &&
          typeof value.updatedAt === "string" &&
          isOptionalString(value.userId)
        ) {
          return {
            type: "invalidation",
            scope: "item",
            databaseId: value.databaseId,
            itemId: value.itemId,
            op: value.op,
            updatedAt: value.updatedAt,
            userId: value.userId,
          };
        }
        return null;
      }
      if (value.scope === "schema") {
        if (typeof value.databaseId === "string" && isOptionalString(value.userId)) {
          return { type: "invalidation", scope: "schema", databaseId: value.databaseId, userId: value.userId };
        }
        return null;
      }
      return null;
    }
    case "doc_update": {
      if (
        typeof value.docId === "string" &&
        typeof value.updateId === "string" &&
        typeof value.createdBy === "string"
      ) {
        return { type: "doc_update", docId: value.docId, updateId: value.updateId, createdBy: value.createdBy };
      }
      return null;
    }
    case "agent_run_event": {
      if (typeof value.agentRunId === "string" && typeof value.kind === "string") {
        return { type: "agent_run_event", agentRunId: value.agentRunId, kind: value.kind, payload: value.payload };
      }
      return null;
    }
    case "notification_created": {
      if (typeof value.userId === "string" && typeof value.notificationId === "string") {
        return { type: "notification_created", userId: value.userId, notificationId: value.notificationId };
      }
      return null;
    }
    case "notification_read_state": {
      if (
        typeof value.userId === "string" &&
        Array.isArray(value.notificationIds) &&
        value.notificationIds.every((id) => typeof id === "string")
      ) {
        return {
          type: "notification_read_state",
          userId: value.userId,
          notificationIds: value.notificationIds,
        };
      }
      return null;
    }
    case "session_revoked": {
      if (typeof value.sessionId === "string") {
        return { type: "session_revoked", sessionId: value.sessionId };
      }
      return null;
    }
    default:
      return null;
  }
}
