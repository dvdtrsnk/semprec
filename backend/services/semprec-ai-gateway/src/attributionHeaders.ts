import type { IncomingMessage } from "node:http";
import { ValidationError } from "@semprec/data";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT_RUN_ID_HEADER = "x-semprec-agent-run-id";
const SEMP_MESSAGE_ID_HEADER = "x-semprec-semp-message-id";

/** Reads one optional UUID header: absent is null, present but not a UUID is a 400 `ValidationError` naming the header. */
function readOptionalUuidHeader(req: IncomingMessage, name: string): string | null {
  const header = req.headers[name];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  if (!UUID_PATTERN.test(value)) {
    throw new ValidationError(`'${name}' must be a UUID`, { field: name });
  }
  return value;
}

/** The run the `ai_gateway_calls` row is attributed to; absent means an unattributed call, malformed is a 400. */
export function extractAgentRunId(req: IncomingMessage): string | null {
  return readOptionalUuidHeader(req, AGENT_RUN_ID_HEADER);
}

/** The Semp assistant message the `ai_gateway_calls` row is attributed to; absent is null, malformed is a 400. */
export function extractSempMessageId(req: IncomingMessage): string | null {
  return readOptionalUuidHeader(req, SEMP_MESSAGE_ID_HEADER);
}
