import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's binding for the session lifecycle `semprec-api` serves under `/api/auth/*`:
 * log in, read the current session, log out. The session token is never read or stored here —
 * for `platform: "web"` the server sets it as an `HttpOnly` cookie and never puts it in the body,
 * so every call just issues a same-origin fetch and lets the browser carry the cookie.
 */

export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  locale: z.string(),
  createdAt: z.string(),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

const userResponseSchema = z.object({ user: sessionUserSchema });

const errorResponseSchema = z.object({ error: z.string() });

export interface LoginInput {
  email: string;
  password: string;
}

export interface AuthOperations {
  login(input: LoginInput): Promise<SessionUser>;
  /** Resolves `null` for an anonymous visitor (401) — that is an ordinary outcome, not an error. */
  getSession(): Promise<SessionUser | null>;
  /** Resolves on 200 and on 401: a session that is already gone is logged out. */
  logout(): Promise<void>;
}

export interface AuthOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

const UNAUTHORIZED_STATUS = 401;

export function createAuthOperations(options: AuthOperationsOptions): AuthOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${baseUrl}${path}`, { credentials: "same-origin", ...init });
    } catch (error) {
      throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
    }
  }

  async function parseUser(response: Response): Promise<SessionUser> {
    try {
      const body: unknown = await response.json();
      return userResponseSchema.parse(body).user;
    } catch (error) {
      throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
    }
  }

  async function failure(path: string, response: Response): Promise<OperationError> {
    const message = await readErrorMessage(response);
    return new OperationError(
      "retryable",
      message ?? `Request to ${path} failed with ${response.status}`,
      response.status,
    );
  }

  return {
    async login(input) {
      const path = "/auth/login";
      const response = await send(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: input.email, password: input.password, platform: "web" }),
      });
      if (response.status === UNAUTHORIZED_STATUS) {
        const message = await readErrorMessage(response);
        throw new OperationError("unavailable", message ?? "Invalid or missing credentials", UNAUTHORIZED_STATUS);
      }
      if (!response.ok) throw await failure(path, response);
      return parseUser(response);
    },

    async getSession() {
      const path = "/auth/session";
      const response = await send(path, { method: "GET" });
      if (response.status === UNAUTHORIZED_STATUS) return null;
      if (!response.ok) throw await failure(path, response);
      return parseUser(response);
    },

    async logout() {
      const path = "/auth/logout";
      const response = await send(path, { method: "POST" });
      if (response.ok || response.status === UNAUTHORIZED_STATUS) return;
      throw await failure(path, response);
    },
  };
}

/** Best-effort read of `{ error: string }` (the handler's shape for 400/401/etc) so a failure surfaces its actual reason instead of a bare status code. */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const parsed = errorResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}
