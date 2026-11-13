import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { AgentRunEventRow, NotificationRow } from "@semprec/data";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared validation for UUIDs crossing the WebSocket and NOTIFY boundaries. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** A bigint-safe, non-negative `agent_run_events.id` cursor. */
export function isAgentRunEventId(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
  return BigInt(value) <= 9_223_372_036_854_775_807n;
}

/**
 * The closed catalog of protocol-v1 inbound (client -> server) text frames. This module owns
 * validation so document and agent-run handlers can trust one shared protocol boundary.
 */
export type InboundFrame =
  | { type: "doc:open"; docId: string }
  | { type: "doc:close"; docId: string }
  | { type: "agent:watch"; runId: string; afterEventId: string }
  | { type: "agent:unwatch"; runId: string };

/**
 * Parses and validates one inbound protocol-v1 text frame. Returns `null` for anything outside
 * the closed catalog — non-JSON input, a non-object, an unknown `type`, or a known `type` with a
 * malformed field — so a caller can drop it without crashing the connection it arrived on or any
 * other client's.
 */
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
 * The closed catalog of protocol-v1 outbound (server -> client) text frames. `invalidate` stays a
 * thin reference (issue #161) — `scope: "item"` names one item's identifiers/op/`updatedAt`,
 * `scope: "schema"` names only the database whose properties/views changed, and
 * `scope: "relation"` names a link to refetch: a property key identifies the displayed link;
 * a null key means refetch all incoming and outgoing links for that item.
 * `scope: "sempThread"` names only the Semp thread that changed (best effort, no replay),
 * `scope: "approvalRequest"` names only the approval request whose state changed,
 * `scope: "mailThread"` names only the mail thread that changed, and
 * `scope: "inboxCards"` names one card of the Processing proposals stack with the operation
 * (`created`, `updated` or `closed`) — so the client always refetches the durable row, the card list
 * and its count itself over REST rather than trusting a second, parallel copy of it
 * riding the socket. `notification` is the one deliberate exception and carries the complete row:
 * a notification's `title` is pre-rendered text with no second enforcement layer to fall back on.
 * `agent:event` carries the durable row resolved from its thin notification reference, while an
 * `agent:delta` is an intentionally ephemeral typing update. `doc:ack` goes only to the socket that
 * sent a doc update carrying a client update id, after the update is durable.
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
  | { type: "invalidate"; scope: "inboxCards"; op: "created" | "updated" | "closed"; cardId: string }
  | { type: "notification"; notification: NotificationRow }
  | { type: "agent:event"; agentRunId: string; event: AgentRunEventRow }
  | { type: "agent:delta"; agentRunId: string; delta: unknown; chunk?: AgentDeltaChunk }
  | { type: "doc:ack"; docId: string; clientUpdateId: string };

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

/**
 * Splits a binary WS frame into its mandatory 16-byte document UUID prefix and payload. Returns
 * `null` for a frame shorter than the prefix — malformed input a caller must drop, not crash on.
 */
export function parseBinaryFrame(data: Buffer): BinaryFrame | null {
  if (data.length < DOC_FRAME_PREFIX_BYTES) return null;
  return { docId: data.subarray(0, DOC_FRAME_PREFIX_BYTES), payload: data.subarray(DOC_FRAME_PREFIX_BYTES) };
}

/**
 * Decodes a binary frame's 16-byte doc UUID prefix back into the hyphenated string form
 * `docs.id`/every other doc-identifying value in this codebase uses. Returns `null` for a
 * malformed prefix (only reachable via `isUuid`-validated `docId`s once decoded, so a caller
 * skips a frame this fails on rather than trusting a garbled document reference).
 */
export function decodeDocId(bytes: Buffer): string | null {
  if (bytes.length !== DOC_FRAME_PREFIX_BYTES) return null;
  const hex = bytes.toString("hex");
  const candidate = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isUuid(candidate) ? candidate : null;
}

/** Encodes a validated doc UUID string into its 16 raw bytes for the binary frame prefix. */
export function encodeDocId(docId: string): Buffer {
  return Buffer.from(docId.replace(/-/g, ""), "hex");
}

/** Builds one outbound binary WS frame: the 16-byte doc UUID prefix followed by `payload`. */
export function buildBinaryFrame(docId: string, payload: Uint8Array): Buffer {
  return Buffer.concat([encodeDocId(docId), payload]);
}

/** Limits of a client-chosen correlation id on a doc update: 1 to 64 characters of `[A-Za-z0-9_-]`. */
export const CLIENT_UPDATE_ID_MAX_LENGTH = 64;
const CLIENT_UPDATE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** True for a well-formed client update id (see `CLIENT_UPDATE_ID_MAX_LENGTH`). */
export function isClientUpdateId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= CLIENT_UPDATE_ID_MAX_LENGTH && CLIENT_UPDATE_ID_PATTERN.test(value)
  );
}

/**
 * Appends the optional trailing `varString` client update id after the update bytes of a
 * y-protocols SyncStep2/Update `payload`. A server that does not know the id ignores the extra
 * bytes. The id is not validated here; the receiver treats an invalid one as "no id".
 */
export function appendClientUpdateId(payload: Uint8Array, clientUpdateId: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeUint8Array(encoder, payload);
  encoding.writeVarString(encoder, clientUpdateId);
  return encoding.toUint8Array(encoder);
}

/**
 * Reads the optional trailing client update id from `decoder`, positioned just after the update
 * bytes. Returns `null` when nothing remains or the value is malformed or invalid; never throws.
 */
export function readClientUpdateId(decoder: decoding.Decoder): string | null {
  if (!decoding.hasContent(decoder)) return null;
  try {
    // Valid ids are ASCII, so the byte length is the character length. Checking the declared
    // length against the bytes left rejects a truncated value instead of reading a shorter one.
    const length = decoding.readVarUint(decoder);
    if (length > CLIENT_UPDATE_ID_MAX_LENGTH || decoder.arr.length - decoder.pos < length) return null;
    const value = String.fromCharCode(...decoding.readUint8Array(decoder, length));
    return isClientUpdateId(value) ? value : null;
  } catch {
    return null;
  }
}
