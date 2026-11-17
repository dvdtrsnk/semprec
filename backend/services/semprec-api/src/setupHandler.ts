import type { IncomingMessage, ServerResponse } from "node:http";
import { ChokePointError, ValidationError, bootstrapFirstAccount, normalizeDisplayName } from "@semprec/data";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { extractBearerToken, PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { logger } from "./logger.js";

export interface SetupHandlerOptions {
  /** Passed in, not read from `process.env`, so `serve.ts` decides where it comes from. */
  setupToken: string;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * The only way to create the first account. Unauthenticated by design; `bootstrapFirstAccount`
 * refuses once any user exists or the bearer token does not match `SETUP_TOKEN`, both answered as a
 * plain 404 so the route never confirms whether setup is still open.
 */
export function createSetupRequestListener(pool: Pool, options: SetupHandlerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "POST" && url.pathname === "/api/setup") {
        const body = (await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })) as {
          email?: unknown;
          password?: unknown;
          displayName?: unknown;
        };
        if (typeof body.email !== "string" || body.email.length === 0) {
          throw new ValidationError("'email' must be a non-empty string");
        }
        if (typeof body.password !== "string" || body.password.length === 0) {
          throw new ValidationError("'password' must be a non-empty string");
        }
        // Validated before any account work, so an invalid name never reaches the bootstrap
        // decision.
        const displayName = normalizeDisplayName(body.displayName);

        const { email, password } = body;
        const user = await runAsSystem("setup", () =>
          bootstrapFirstAccount(pool, options.setupToken, extractBearerToken(req) ?? "", {
            email,
            password,
            displayName,
          }),
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
   * A synchronous boundary confines an escaped rejection to a 500 for this request instead of an
   * unhandled rejection ending the process.
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
