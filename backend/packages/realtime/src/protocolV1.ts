const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * The closed catalog of protocol-v1 inbound (client -> server) text frames (issue #160).
 * Nothing here is acted on yet — subscribing to a doc or an agent run is delivered by later
 * realtime-v1 sibling issues; this module only defines the catalog and validates shape, so
 * every later handler validates against the same one.
 */
export type InboundFrame =
  | { type: "doc:open"; docId: string }
  | { type: "doc:close"; docId: string }
  | { type: "agent:watch"; agentRunId: string }
  | { type: "agent:unwatch"; agentRunId: string };

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
      const { agentRunId } = parsed as { agentRunId?: unknown };
      return isUuid(agentRunId) ? { type, agentRunId } : null;
    }
    default:
      return null;
  }
}

/**
 * The closed catalog of protocol-v1 outbound (server -> client) text frames. Producing any of
 * these is out of this issue's scope (delivered by later realtime-v1 sibling issues) — this type
 * exists so every future producer targets the same catalog from the start.
 */
export type OutboundFrame =
  | { type: "invalidate"; databaseId: string; itemId: string; key: string }
  | { type: "notification"; notification: unknown }
  | { type: "agent:event"; agentRunId: string; kind: string; payload: unknown }
  | { type: "agent:delta"; agentRunId: string; delta: unknown };

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
