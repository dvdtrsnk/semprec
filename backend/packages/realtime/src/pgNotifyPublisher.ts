import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { isAgentRunEventId, isUuid, type AgentDeltaChunk } from "./protocolV1.js";

/**
 * One durable channel for every recoverable realtime message kind — structured-data
 * invalidation and binary CRDT update references are distinguished only by `type` on this shared
 * channel. The ephemeral agent typing stream intentionally has its own channel below.
 */
export const REALTIME_CHANNEL = "semprec_events";
/** Ephemeral typing traffic is deliberately isolated from durable realtime references. */
export const AGENT_STREAM_CHANNEL = "semprec_agent_stream";
const MAX_AGENT_STREAM_NOTIFY_BYTES = 7_500;
const AGENT_STREAM_CHUNK_BYTES = 7_000;

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
  | { type: "agent_run_event"; agentRunId: string; eventId: string }
  | { type: "notification_created"; userId: string; notificationId: string }
  | { type: "notification_read_state"; userId: string; notificationIds: string[] }
  | { type: "session_revoked"; sessionId: string };

/**
 * Postgres caps a NOTIFY payload at ~8000 bytes; every message here stays a couple
 * hundred bytes at most, well under that cap, since none of them carry a durable row's
 * content — see `RealtimeMessage`'s doc comment.
 */
export async function publishRealtimeMessage(pool: Pool | PoolClient, message: RealtimeMessage): Promise<void> {
  if (message.type === "session_revoked") {
    // Sessions are global identity rows revoked from scopes that are not the owner's tenant, so the
    // tenant comes from the session's user (the same binding the socket gets), not the publisher's scope.
    await pool.query(
      `SELECT pg_notify($1, json_build_object(
         'tenantId',
         (SELECT u.tenant_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $3::uuid),
         'message', $2::json)::text)`,
      [REALTIME_CHANNEL, JSON.stringify(message), message.sessionId],
    );
    return;
  }
  await publishEnveloped(pool, REALTIME_CHANNEL, JSON.stringify(message));
}

/**
 * Wraps `messageJson` in `{ tenantId, message }` inside Postgres, so the tenant is always computed
 * from the publisher's own scope and can never be supplied by the message body.
 */
async function publishEnveloped(pool: Pool | PoolClient, channel: string, messageJson: string): Promise<void> {
  await pool.query(
    `SELECT pg_notify($1, json_build_object('tenantId', app_tenant_default(), 'message', $2::json)::text)`,
    [channel, messageJson],
  );
}

export type AgentStreamMessage =
  | { type: "agent_run_delta"; agentRunId: string; delta: unknown }
  | { type: "agent_run_delta"; agentRunId: string; delta: string; chunk: AgentDeltaChunk };

function serializedBytes(message: AgentStreamMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

/**
 * Sends an intentionally non-durable typing delta. A single Postgres NOTIFY payload must stay
 * below its ~8 KiB ceiling, so unusually large JSON values are split into independently valid
 * base64 pieces. The receiver forwards the chunk metadata unchanged for the client to reassemble.
 */
export async function publishAgentRunDelta(pool: Pool | PoolClient, agentRunId: string, delta: unknown): Promise<void> {
  // `JSON.stringify` drops an object key whose value is `undefined`, and `parseAgentStreamMessage`
  // requires a `delta` key to be present — normalize so an explicit `undefined` delta still
  // round-trips instead of being silently dropped on the fast (unchunked) path below.
  const single: AgentStreamMessage = { type: "agent_run_delta", agentRunId, delta: delta === undefined ? null : delta };
  if (serializedBytes(single) < MAX_AGENT_STREAM_NOTIFY_BYTES) {
    await publishEnveloped(pool, AGENT_STREAM_CHANNEL, JSON.stringify(single));
    return;
  }

  const serialized = JSON.stringify(delta);
  if (serialized === undefined) throw new Error("Agent run delta is not JSON-serializable");
  const encoded = Buffer.from(serialized, "utf8").toString("base64");
  const total = Math.ceil(encoded.length / AGENT_STREAM_CHUNK_BYTES);
  const id = randomUUID();
  for (let index = 0; index < total; index += 1) {
    const chunk: AgentDeltaChunk = { id, index, total, encoding: "base64json" };
    const message: AgentStreamMessage = {
      type: "agent_run_delta",
      agentRunId,
      delta: encoded.slice(index * AGENT_STREAM_CHUNK_BYTES, (index + 1) * AGENT_STREAM_CHUNK_BYTES),
      chunk,
    };
    if (serializedBytes(message) >= MAX_AGENT_STREAM_NOTIFY_BYTES) {
      throw new Error("Agent run delta chunk exceeds the NOTIFY payload limit");
    }
    await publishEnveloped(pool, AGENT_STREAM_CHANNEL, JSON.stringify(message));
  }
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
      if (isUuid(value.agentRunId) && isAgentRunEventId(value.eventId)) {
        return { type: "agent_run_event", agentRunId: value.agentRunId, eventId: value.eventId };
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

/** Validates a payload from the separate ephemeral agent stream channel before it reaches a socket. */
export function parseAgentStreamMessage(raw: unknown): AgentStreamMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.type !== "agent_run_delta" || !isUuid(value.agentRunId) || !("delta" in value)) return null;
  if (value.chunk === undefined) return { type: "agent_run_delta", agentRunId: value.agentRunId, delta: value.delta };
  if (typeof value.chunk !== "object" || value.chunk === null || Array.isArray(value.chunk)) return null;
  const chunk = value.chunk as Record<string, unknown>;
  if (
    typeof value.delta !== "string" ||
    typeof chunk.id !== "string" ||
    typeof chunk.index !== "number" ||
    typeof chunk.total !== "number" ||
    !Number.isInteger(chunk.index) ||
    !Number.isInteger(chunk.total) ||
    chunk.index < 0 ||
    chunk.total <= 0 ||
    chunk.index >= chunk.total ||
    chunk.encoding !== "base64json"
  ) {
    return null;
  }
  return {
    type: "agent_run_delta",
    agentRunId: value.agentRunId,
    delta: value.delta,
    chunk: { id: chunk.id, index: chunk.index, total: chunk.total, encoding: "base64json" },
  };
}

/** A NOTIFY payload after validation: the publisher's tenant and the message it published. */
export interface RealtimeEnvelope<M> {
  tenantId: string;
  message: M;
}

function parseEnvelope<M>(raw: unknown, parseMessage: (inner: unknown) => M | null): RealtimeEnvelope<M> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!isUuid(value.tenantId)) return null;
  const message = parseMessage(value.message);
  return message ? { tenantId: value.tenantId, message } : null;
}

/** Validates a `semprec_events` payload: a uuid `tenantId` and a valid `RealtimeMessage`, else `null`. */
export function parseRealtimeEnvelope(raw: unknown): RealtimeEnvelope<RealtimeMessage> | null {
  return parseEnvelope(raw, parseRealtimeMessage);
}

/** Validates a `semprec_agent_stream` payload: a uuid `tenantId` and a valid `AgentStreamMessage`, else `null`. */
export function parseAgentStreamEnvelope(raw: unknown): RealtimeEnvelope<AgentStreamMessage> | null {
  return parseEnvelope(raw, parseAgentStreamMessage);
}
