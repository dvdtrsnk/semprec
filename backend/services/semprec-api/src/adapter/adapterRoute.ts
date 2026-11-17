import type { CaptureAttachmentResponse, ConfirmationResult, KeptItem, ProposalWarning } from "@semprec/data";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  ChokePointError,
  ForbiddenError,
  RateLimitedError,
  type AuthenticatedIdentity,
  type ItemRow,
} from "@semprec/data";
import { authenticateRequest } from "../authHandler.js";
import { toErrorResponseBody, statusForError } from "./errorContract.js";
import { toItemEnvelopeWithBlobs } from "./itemEnvelope.js";
import { logger } from "../logger.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./http.js";

export { PayloadTooLargeError };

/**
 * The one place a mounted route's request is authenticated, its JSON body parsed, and its result or
 * error turned into a response, with no per-route opt-out.
 *
 * No URL versioning: contract changes are additive only
 * (docs/architecture/edges-io-and-errors.md#rest-contract).
 *
 * `requireAuthenticatedIdentity` and `sendErrorResponse` stay module-private so no handler can
 * bypass the auth gate or error mapping.
 */

const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** Session cookie or `Authorization: Bearer`, before the handler runs. */
async function requireAuthenticatedIdentity(pool: Pool, req: IncomingMessage): Promise<AuthenticatedIdentity> {
  return authenticateRequest(pool, req);
}

/**
 * A `RateLimitedError` also gets a `Retry-After` header in whole seconds, as the bespoke auth
 * listeners answer their own 429.
 */
function sendErrorResponse(res: ServerResponse, err: ChokePointError): void {
  const headers = err instanceof RateLimitedError ? { "Retry-After": String(err.retryAfterSeconds) } : undefined;
  sendJson(res, statusForError(err), toErrorResponseBody(err), headers);
}

export interface AdapterRequestContext {
  req: IncomingMessage;
  identity: AuthenticatedIdentity;
  /** `{}` for a route with none. */
  params: Record<string, string>;
  body: unknown;
}

/**
 * Either an item to serialize into the item envelope, or a raw JSON `body` sent as-is. An item
 * result may carry `results`, `warnings`, `keptItems` and `attachments`, each added to the envelope
 * as a top-level field when present.
 */
export type AdapterHandlerResult =
  | {
      status: number;
      item: ItemRow;
      results?: ConfirmationResult[];
      warnings?: ProposalWarning[];
      keptItems?: KeptItem[];
      attachments?: CaptureAttachmentResponse[];
    }
  | { status: number; body: unknown };

export type AdapterHandler = (ctx: AdapterRequestContext) => Promise<AdapterHandlerResult>;

export interface AdapterRequestListenerOptions {
  extractParams?: (req: IncomingMessage) => Record<string, string>;
  /**
   * A caller whose role is not `admin` is refused with 403 `admin_required` before the body is
   * read, and the handler runs in system scope instead of the caller's tenant.
   */
  admin?: boolean;
}

/**
 * Anything thrown other than a `ChokePointError`/`PayloadTooLargeError` is logged and answered with
 * a generic 500, never leaking details.
 */
export function createAdapterRequestListener(
  pool: Pool,
  handler: AdapterHandler,
  options: AdapterRequestListenerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const identity = await requireAuthenticatedIdentity(pool, req);
      if (options.admin && identity.role !== "admin") {
        throw new ForbiddenError("Admin role required", undefined, "admin_required");
      }
      const run = async (): Promise<{ status: number; body: unknown }> => {
        const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
        const params = options.extractParams?.(req) ?? {};
        const handled = await handler({ req, identity, params, body });
        // The full item envelope, never an empty 204; built here because the blob lookup needs the
        // tenant scope.
        return "item" in handled
          ? {
              status: handled.status,
              body: {
                ...(await toItemEnvelopeWithBlobs(pool, handled.item)),
                ...(handled.results === undefined ? {} : { results: handled.results }),
                ...(handled.warnings === undefined ? {} : { warnings: handled.warnings }),
                ...(handled.keptItems === undefined ? {} : { keptItems: handled.keptItems }),
                ...(handled.attachments === undefined ? {} : { attachments: handled.attachments }),
              },
            }
          : handled;
      };
      // The tenant comes from the authenticated session only. An admin route runs in system scope
      // and never enters a tenant.
      const result = options.admin ? await runAsSystem("adminRoute", run) : await runInTenant(identity.tenantId, run);
      sendJson(res, result.status, result.body);
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

  // The fallback itself can reject, and HTTP listeners may ignore the returned promise.
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } });
    });
  };
}
