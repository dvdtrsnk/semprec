import type { AgentRunEventRow, NotificationRow } from "@semprec/data";
import { isClientUpdateId, type AgentDeltaChunk, type OutboundFrame } from "@semprec/realtime";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check, not a re-validation of every business rule `@semprec/data` enforces server-side — this boundary only needs to know the row is shaped like one before it's handed to caller code. */
function isNotificationRow(value: unknown): value is NotificationRow {
  return (
    isNonNullObject(value) &&
    typeof value.id === "string" &&
    typeof value.userId === "string" &&
    typeof value.kind === "string" &&
    typeof value.title === "string" &&
    (value.body === null || typeof value.body === "string") &&
    (value.linkHref === null || typeof value.linkHref === "string") &&
    typeof value.sourceTable === "string" &&
    typeof value.sourceId === "string" &&
    typeof value.transitionInstance === "string" &&
    isNonNullObject(value.payload) &&
    typeof value.createdAt === "string" &&
    (value.readAt === null || typeof value.readAt === "string")
  );
}

function isAgentRunEventRow(value: unknown): value is AgentRunEventRow {
  return (
    isNonNullObject(value) &&
    typeof value.id === "string" &&
    typeof value.agentRunId === "string" &&
    typeof value.kind === "string" &&
    typeof value.at === "string"
  );
}

function isAgentDeltaChunk(value: unknown): value is AgentDeltaChunk {
  return (
    isNonNullObject(value) &&
    typeof value.id === "string" &&
    typeof value.index === "number" &&
    typeof value.total === "number" &&
    value.encoding === "base64json"
  );
}

/**
 * Validates and parses one text frame received off `WS /api/sync` into protocol-v1's
 * `OutboundFrame` catalog — the client-side mirror of `parseInboundFrame`'s server-side boundary.
 * A frame off a socket is untrusted input crossing a boundary the same way a NOTIFY payload or an
 * API response body is: `JSON.parse` alone, cast with `as`, is never enough. Returns `null` for
 * anything outside the closed catalog so a caller drops it without crashing this connection.
 */
export function parseServerFrame(raw: string): OutboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isNonNullObject(parsed)) return null;

  switch (parsed.type) {
    case "invalidate": {
      if (parsed.scope === "doc") {
        const { docId, itemId, databaseId, lastEditedAt } = parsed;
        if (
          typeof docId !== "string" ||
          !UUID_PATTERN.test(docId) ||
          typeof itemId !== "string" ||
          !UUID_PATTERN.test(itemId) ||
          typeof databaseId !== "string" ||
          !UUID_PATTERN.test(databaseId) ||
          typeof lastEditedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(lastEditedAt) ||
          !Number.isFinite(Date.parse(lastEditedAt)) ||
          new Date(lastEditedAt).toISOString() !== lastEditedAt
        )
          return null;
        return { type: "invalidate", scope: "doc", docId, itemId, databaseId, lastEditedAt };
      }
      if (parsed.scope === "relation") {
        const { databaseId, itemId, propertyKey, op } = parsed;
        if (
          typeof databaseId !== "string" ||
          typeof itemId !== "string" ||
          !(propertyKey === null || typeof propertyKey === "string") ||
          !(op === "put" || op === "delete" || op === "metadata")
        )
          return null;
        return { type: "invalidate", scope: "relation", databaseId, itemId, propertyKey, op };
      }
      if (parsed.scope === "item") {
        const { databaseId, itemId, op, updatedAt } = parsed;
        if (typeof databaseId !== "string" || typeof itemId !== "string" || typeof updatedAt !== "string") return null;
        if (op !== "create" && op !== "update" && op !== "delete") return null;
        return { type: "invalidate", scope: "item", databaseId, itemId, op, updatedAt };
      }
      if (parsed.scope === "schema") {
        const { databaseId } = parsed;
        return typeof databaseId === "string" ? { type: "invalidate", scope: "schema", databaseId } : null;
      }
      if (parsed.scope === "sempThread") {
        const { threadId } = parsed;
        return typeof threadId === "string" ? { type: "invalidate", scope: "sempThread", threadId } : null;
      }
      if (parsed.scope === "approvalRequest") {
        const { approvalRequestId } = parsed;
        return typeof approvalRequestId === "string" && UUID_PATTERN.test(approvalRequestId)
          ? { type: "invalidate", scope: "approvalRequest", approvalRequestId }
          : null;
      }
      if (parsed.scope === "mailThread") {
        const { threadId } = parsed;
        return typeof threadId === "string" ? { type: "invalidate", scope: "mailThread", threadId } : null;
      }
      if (parsed.scope === "inboxCards") {
        const { op, cardId } = parsed;
        if (!(op === "created" || op === "updated" || op === "closed")) return null;
        return typeof cardId === "string" && UUID_PATTERN.test(cardId)
          ? { type: "invalidate", scope: "inboxCards", op, cardId }
          : null;
      }
      return null;
    }
    case "notification": {
      const { notification } = parsed;
      return isNotificationRow(notification) ? { type: "notification", notification } : null;
    }
    case "agent:event": {
      const { agentRunId, event } = parsed;
      if (typeof agentRunId !== "string" || !isAgentRunEventRow(event)) return null;
      return { type: "agent:event", agentRunId, event };
    }
    case "agent:delta": {
      const { agentRunId, delta, chunk } = parsed;
      if (typeof agentRunId !== "string") return null;
      if (chunk === undefined) return { type: "agent:delta", agentRunId, delta };
      return isAgentDeltaChunk(chunk) ? { type: "agent:delta", agentRunId, delta, chunk } : null;
    }
    case "doc:ack": {
      const { docId, clientUpdateId } = parsed;
      return typeof docId === "string" && isClientUpdateId(clientUpdateId)
        ? { type: "doc:ack", docId, clientUpdateId }
        : null;
    }
    default:
      return null;
  }
}
