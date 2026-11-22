import type { IncomingMessage, ServerResponse } from "node:http";
import { NO_STORE, sendJson } from "./adapter/http.js";

/** Far above the tokens Graph sends, but bounds what a handshake echoes. */
const MAX_VALIDATION_TOKEN_LENGTH = 1024;
/** Entries of one Graph batch read; anything after them is ignored. */
const MAX_GRAPH_BATCH_ENTRIES = 100;
/**
 * Distinct `(subscriptionId, clientState)` pairs of one batch looked up, after duplicates are dropped. Graph puts
 * about 20 notifications in a batch, and one per subscription is enough to queue its account's pass.
 */
export const MAX_GRAPH_NOTIFICATIONS = 20;
const MAX_GRAPH_ID_LENGTH = 256;
const MAX_CLIENT_STATE_LENGTH = 256;

export interface RawGraphNotification {
  subscriptionId: string;
  clientState: string | null;
}

/** A Graph notification carries other fields the receivers do not act on. */
function parseGraphNotification(value: unknown): RawGraphNotification | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { subscriptionId, clientState } = record;
  if (typeof subscriptionId !== "string" || !subscriptionId || subscriptionId.length > MAX_GRAPH_ID_LENGTH) {
    return undefined;
  }
  return {
    subscriptionId,
    clientState: typeof clientState === "string" && clientState.length <= MAX_CLIENT_STATE_LENGTH ? clientState : null,
  };
}

/**
 * The first `MAX_GRAPH_NOTIFICATIONS` distinct well-formed pairs among the first `MAX_GRAPH_BATCH_ENTRIES` entries of a
 * Graph batch's `value`. An over-long `clientState` reads as none, so it is refused without being compared.
 */
export function distinctGraphNotifications(entries: unknown[]): RawGraphNotification[] {
  const seen = new Map<string, RawGraphNotification>();
  for (const entry of entries.slice(0, MAX_GRAPH_BATCH_ENTRIES)) {
    const notification = parseGraphNotification(entry);
    if (notification === undefined) continue;
    const key = JSON.stringify([notification.subscriptionId, notification.clientState]);
    if (seen.has(key)) continue;
    seen.set(key, notification);
    if (seen.size === MAX_GRAPH_NOTIFICATIONS) break;
  }
  return [...seen.values()];
}

/**
 * Answers a Graph subscription validation handshake (`?validationToken=`): the literal token as `text/plain`, which
 * Graph matches byte for byte, with `nosniff` so a browser never renders the echo as anything else; a token over
 * `MAX_VALIDATION_TOKEN_LENGTH` is 400. `false` when the request is no handshake and nothing was answered; the body of
 * a handshake is never read.
 */
export function answerGraphValidationHandshake(req: IncomingMessage, res: ServerResponse): boolean {
  const validationToken = new URL(req.url ?? "/", "http://localhost").searchParams.get("validationToken");
  if (validationToken === null) return false;
  if (validationToken.length > MAX_VALIDATION_TOKEN_LENGTH) {
    sendJson(res, 400, { error: "validationToken is too long" });
    return true;
  }
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": NO_STORE,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(validationToken);
  return true;
}
