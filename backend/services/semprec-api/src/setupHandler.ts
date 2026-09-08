import type { IncomingMessage, ServerResponse } from "node:http";
import { ChokePointError, ValidationError, bootstrapFirstAccount } from "@semprec/data";
import type { Pool } from "pg";

/** Same `Authorization: Bearer <token>` extraction as `approvalRequestsHandler.ts`'s `isAuthorized`. */
function extractBearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length);
}

export interface SetupHandlerOptions {
  /**
   * The deployment's one-time bootstrap secret (#233). Explicit parameter, not read from
   * `process.env` here, so the caller (`serve.ts`) decides where it comes from — same
   * convention as `aiUsageHandler.ts`'s `authToken`.
   */
  setupToken: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const MAX_BODY_BYTES = 64 * 1024;

class PayloadTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError("Request body exceeds the maximum allowed size");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

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
        const body = (await readJsonBody(req)) as { email?: unknown; password?: unknown };
        if (typeof body.email !== "string" || body.email.length === 0) {
          throw new ValidationError("'email' must be a non-empty string");
        }
        if (typeof body.password !== "string" || body.password.length === 0) {
          throw new ValidationError("'password' must be a non-empty string");
        }

        const user = await bootstrapFirstAccount(pool, options.setupToken, extractBearerToken(req), {
          email: body.email,
          password: body.password,
        });

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
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      console.error(`Unexpected error in ${req.method} ${url.pathname}:`, err);
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
      console.error("Unhandled error in the setup request listener:", err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
