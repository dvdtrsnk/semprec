import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { AgentRunEventRow, NotificationRow } from "@semprec/data";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared validation for UUIDs crossing the WebSocket and NOTIFY boundaries. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isAgentRunEventId(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
  return BigInt(value) <= 9_223_372_036_854_775_807n;
}

/** The closed catalog of inbound (client -> server) text frames; handlers trust this one validation boundary. */
export type InboundFrame =
  | { type: "doc:open"; docId: string }
  | { type: "doc:close"; docId: string }
  | { type: "agent:watch"; runId: string; afterEventId: string }
  | { type: "agent:unwatch"; runId: string };

/** Returns `null` for anything outside the catalog, so the caller can drop it without crashing any connection. */
export function parseInboundFrame(raw: string): InboundFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const { type } = parsed as { type?: unknown };
  switch (type) {
    case "doc:open":
    case "doc:close": {
      const { docId } = parsed as { docId?: unknown };
      return isUuid(docId) ? { type, docId } : null;
    }
    case "agent:watch":
    case "agent:unwatch": {
      const { runId } = parsed as { runId?: unknown };
      if (!isUuid(runId)) return null;
      if (type === "agent:unwatch") return { type, runId };
      const { afterEventId } = parsed as { afterEventId?: unknown };
      return isAgentRunEventId(afterEventId) ? { type, runId, afterEventId } : null;
    }
    default:
      return null;
  }
}

/**
 * The closed catalog of outbound (server -> client) text frames. `invalidate` is always a thin reference that makes the
 * client refetch the durable state over REST:
 * - `item` names one item's identifiers, op and `updatedAt`; `schema` the database whose properties/views changed;
 *   `relation` a link to refetch (a null property key means all incoming and outgoing links of the item).
 * - `sempThread`, `approvalRequest`, `mailThread`, `projectAgent` name only what changed; `agentRuns` names a run and
 *   its project (null when none); `inboxCards` names one card and the op (`created`, `updated`, `closed`).
 * - `sempStatus`, `overview`, `mcpServers`, `notificationPreferences`, `badgeCounts` and `account` carry nothing but
 * the scope. `notification` deliberately carries the complete row: its pre-rendered `title` has no second enforcement
 * layer. `agent:event` carries the durable row; `agent:delta` is an ephemeral typing update (`MailDraftBodyDelta` while
 * a run writes a mail draft). `doc:ack` goes only to the sender of a doc update with a client update id, once durable.
 */
export type OutboundFrame =
  | {
      type: "invalidate";
      scope: "item";
      databaseId: string;
      itemId: string;
      op: "create" | "update" | "delete";
      updatedAt: string;
    }
  | { type: "invalidate"; scope: "schema"; databaseId: string }
  | { type: "invalidate"; scope: "doc"; docId: string; itemId: string; databaseId: string; lastEditedAt: string }
  | {
      type: "invalidate";
      scope: "relation";
      databaseId: string;
      itemId: string;
      propertyKey: string | null;
      op: "put" | "delete" | "metadata";
    }
  | { type: "invalidate"; scope: "sempThread"; threadId: string }
  | { type: "invalidate"; scope: "approvalRequest"; approvalRequestId: string }
  | { type: "invalidate"; scope: "mailThread"; threadId: string }
  | { type: "invalidate"; scope: "agentRuns"; projectItemId: string | null; agentRunId: string }
  | { type: "invalidate"; scope: "projectAgent"; projectItemId: string }
  | { type: "invalidate"; scope: "sempStatus" }
  | { type: "invalidate"; scope: "notificationPreferences" }
  | { type: "invalidate"; scope: "badgeCounts" }
  | { type: "invalidate"; scope: "account" }
  | { type: "invalidate"; scope: "overview" }
  | { type: "invalidate"; scope: "mcpServers" }
  | { type: "invalidate"; scope: "inboxCards"; op: "created" | "updated" | "closed"; cardId: string }
  | { type: "notification"; notification: NotificationRow }
  | { type: "agent:event"; agentRunId: string; event: AgentRunEventRow }
  | { type: "agent:delta"; agentRunId: string; delta: unknown; chunk?: AgentDeltaChunk }
  | { type: "doc:ack"; docId: string; clientUpdateId: string };

/**
 * The `delta` while a run writes a mail draft body with `mail.draft.update`. Ephemeral: the durable change is the draft
 * update and its item invalidation.
 */
export interface MailDraftBodyDelta {
  kind: "mailDraftBody";
  draftId: string;
  body: string;
}

/** A large ephemeral delta is transported as pieces of its base64-encoded JSON value. */
export interface AgentDeltaChunk {
  id: string;
  index: number;
  total: number;
  encoding: "base64json";
}

/** Every binary frame's mandatory prefix: the 16-byte UUID of the document it belongs to. */
export const DOC_FRAME_PREFIX_BYTES = 16;

export interface BinaryFrame {
  docId: Buffer;
  payload: Buffer;
}

/** Returns `null` for a frame shorter than the prefix, which the caller must drop. */
export function parseBinaryFrame(data: Buffer): BinaryFrame | null {
  if (data.length < DOC_FRAME_PREFIX_BYTES) return null;
  return { docId: data.subarray(0, DOC_FRAME_PREFIX_BYTES), payload: data.subarray(DOC_FRAME_PREFIX_BYTES) };
}

/** Decodes the prefix into the hyphenated UUID form; `null` for a malformed prefix, whose frame the caller skips. */
export function decodeDocId(bytes: Buffer): string | null {
  if (bytes.length !== DOC_FRAME_PREFIX_BYTES) return null;
  const hex = bytes.toString("hex");
  const candidate = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isUuid(candidate) ? candidate : null;
}

export function encodeDocId(docId: string): Buffer {
  return Buffer.from(docId.replace(/-/g, ""), "hex");
}

export function buildBinaryFrame(docId: string, payload: Uint8Array): Buffer {
  return Buffer.concat([encodeDocId(docId), payload]);
}

/** A client update id is 1 to 64 characters of `[A-Za-z0-9_-]`. */
export const CLIENT_UPDATE_ID_MAX_LENGTH = 64;
const CLIENT_UPDATE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isClientUpdateId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= CLIENT_UPDATE_ID_MAX_LENGTH && CLIENT_UPDATE_ID_PATTERN.test(value)
  );
}

/**
 * Appends the optional trailing `varString` client update id after a SyncStep2/Update payload; a server that does not
 * know it ignores the extra bytes. Not validated here: the receiver treats an invalid id as none.
 */
export function appendClientUpdateId(payload: Uint8Array, clientUpdateId: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8Array(encoder, payload);
  encoding.writeVarString(encoder, clientUpdateId);
  return encoding.toUint8Array(encoder);
}

/**
 * `decoder` is positioned after the update bytes. `null` when nothing remains or the value is invalid; never throws.
 */
export function readClientUpdateId(decoder: decoding.Decoder): string | null {
  if (!decoding.hasContent(decoder)) return null;
  try {
    // Valid ids are ASCII, so byte length is character length; checking it against the bytes left rejects a truncated
    // value.
    const length = decoding.readVarUint(decoder);
    if (length > CLIENT_UPDATE_ID_MAX_LENGTH || decoder.arr.length - decoder.pos < length) return null;
    const value = String.fromCharCode(...decoding.readUint8Array(decoder, length));
    return isClientUpdateId(value) ? value : null;
  } catch {
    return null;
  }
}
