import type { IncomingMessage, ServerResponse } from "node:http";
import { ChokePointError, ValidationError, bootstrapFirstAccount } from "@semprec/data";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { extractBearerToken, PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { logger } from "./logger.js";

export interface SetupHandlerOptions {
  /**
   * The deployment's one-time bootstrap secret (#233). Explicit parameter, not read from
   * `process.env` here, so the caller (`serve.ts`) decides where it comes from.
   */
  setupToken: string;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Handles `POST /api/setup` (token via `Authorization: Bearer <token>`) for issue #233 — the
 * only way to create an account in this deployment. Unauthenticated by design (there is no user
 * yet to authenticate as); its safety comes entirely from `bootstrapFirstAccount` refusing to run
 * once any user exists or the bearer token doesn't match `SETUP_TOKEN`, both of which it reports
 * as a plain 404 rather than a 401/403 so the route never confirms or denies "setup is still
 * open" to an unauthenticated caller. #234 builds the web wizard that drives this API; #143 lists
 * it among the documented public route exceptions.
 */
export function createSetupRequestListener(pool: Pool, options: SetupHandlerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "POST" && url.pathname === "/api/setup") {
        const body = (await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })) as { email?: unknown; password?: unknown };
        if (typeof body.email !== "string" || body.email.length === 0) {
          throw new ValidationError("'email' must be a non-empty string");
        }
        if (typeof body.password !== "string" || body.password.length === 0) {
          throw new ValidationError("'password' must be a non-empty string");
        }

        const { email, password } = body;
        const user = await runAsSystem("setup", () =>
          bootstrapFirstAccount(pool, options.setupToken, extractBearerToken(req) ?? "", { email, password }),
        );

        sendJson(res, 200, { user });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, toPublicErrorBody(err));
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * Same rationale as `authHandler.ts`'s `handleRequestSafely`: keeping the boundary synchronous
   * confines a rejection that escapes the try/catch above to a 500 for that one request instead
   * of an unhandled rejection that takes the whole process down.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the setup request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
