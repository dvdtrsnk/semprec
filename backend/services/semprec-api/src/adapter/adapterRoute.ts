import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { ChokePointError, type AuthenticatedIdentity, type ItemRow } from "@semprec/data";
import { authenticateRequest } from "../authHandler.js";
import { toErrorResponseBody, statusForError } from "./errorContract.js";
import { toItemEnvelope } from "./itemEnvelope.js";
import { logger } from "../logger.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./http.js";

export { PayloadTooLargeError };

/**
 * The `semprec-api` REST adapter foundation (issue #238): the one place a mounted route's
 * request is authenticated, its JSON body is parsed, its handler's result or thrown error is
 * turned into a response — shared by every route family this adapter carries, with no per-route
 * opt-out. #239 adds the ModuleRegistry manifest that actually mounts route families through
 * this; this issue ships the adapter itself plus fixture-driven contract tests, no concrete
 * generic resource routes yet.
 *
 * Contract evolution rule: there is no URL versioning (no `/api/v1/...`). Contract changes here
 * are additive only — a new envelope field, a new route, a new error code — never a breaking
 * change without a transition period. See
 * `docs/adr/2026-09-11-additive-only-rest-contract-no-url-versioning.md` for why.
 *
 * `requireAuthenticatedIdentity`, `sendErrorResponse`, and `sendItemResponse` are deliberately
 * module-private: `createAdapterRequestListener` is the only supported entry point, so a route
 * handler can never bypass its centralized auth gate or error mapping by calling one of these
 * directly.
 */

const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Every route mounted through this adapter authenticates the same way — session cookie or `Authorization: Bearer` (issue #143) — before its handler ever runs. */
async function requireAuthenticatedIdentity(pool: Pool, req: IncomingMessage): Promise<AuthenticatedIdentity> {
  return authenticateRequest(pool, req);
}

/** Sends a `ChokePointError` as this adapter's `{ error: { code, details } }` body, at the status the shared code→status table assigns it. */
function sendErrorResponse(res: ServerResponse, err: ChokePointError): void {
  sendJson(res, statusForError(err), toErrorResponseBody(err));
}

/** Sends a successful item write/read as the full item envelope — never an empty 204. */
function sendItemResponse(res: ServerResponse, status: number, item: ItemRow): void {
  sendJson(res, status, toItemEnvelope(item));
}

export interface AdapterRequestContext {
  req: IncomingMessage;
  identity: AuthenticatedIdentity;
  /** Path parameters extracted from the mounted route's pattern (e.g. `:id`) — `{}` for a route with none. */
  params: Record<string, string>;
  body: unknown;
}

/**
 * What a handler resolves with: either the item to serialize into the #238 item envelope, or —
 * for a custom route (#239) whose response isn't shaped like an item at all (a list, a report, a
 * plain confirmation) — a raw JSON `body` sent as-is. Either way, status mapping and error
 * serialization stay the adapter's job, never the handler's.
 */
export type AdapterHandlerResult = { status: number; item: ItemRow } | { status: number; body: unknown };

export type AdapterHandler = (ctx: AdapterRequestContext) => Promise<AdapterHandlerResult>;

export interface AdapterRequestListenerOptions {
  /** Resolves the mounted route's path parameters for this request; omitted (or returning `{}`) for a route with none. */
  extractParams?: (req: IncomingMessage) => Record<string, string>;
}

/**
 * Wraps a route handler with this adapter's shared auth, JSON body parsing, and error/serialization
 * mapping — the "no third path, no per-route opt-out" auth guarantee and the "single place" status
 * mapping the issue's Task asks for. A handler either resolves with the item/body to serialize, or
 * throws; anything other than a `ChokePointError`/`PayloadTooLargeError` is an unexpected failure,
 * logged and answered with a generic 500 rather than leaking its details to the client.
 */
export function createAdapterRequestListener(
  pool: Pool,
  handler: AdapterHandler,
  options: AdapterRequestListenerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const identity = await requireAuthenticatedIdentity(pool, req);
      const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
      const params = options.extractParams?.(req) ?? {};
      const result = await handler({ req, identity, params, body });
      if ("item" in result) {
        sendItemResponse(res, result.status, result.item);
      } else {
        sendJson(res, result.status, result.body);
      }
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: { code: "payload_too_large" } });
        return;
      }
      if (err instanceof ChokePointError) {
        sendErrorResponse(res, err);
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      logger.error({ err, method: req.method, path: pathname }, "Unexpected error handling request");
      sendJson(res, 500, { error: { code: "internal_error" } });
    }
  }

  // Same shape as authHandler.ts's own listener wrapper: keeps an unhandled rejection out of
  // `http.createServer`, which discards an async listener's return value and would otherwise
  // crash the process on any rejection escaping the try/catch above.
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}
