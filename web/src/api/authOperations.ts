import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's binding for the session lifecycle `semprec-api` serves under `/api/auth/*`:
 * log in, read the current session, log out, and the password-reset request and consume calls.
 * The session token is never read or stored here —
 * for `platform: "web"` the server sets it as an `HttpOnly` cookie and never puts it in the body,
 * so every call just issues a same-origin fetch and lets the browser carry the cookie.
 */

export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  locale: z.string(),
  createdAt: z.string(),
  role: z.enum(["admin", "member"]),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;

const userResponseSchema = z.object({ user: sessionUserSchema });

const errorResponseSchema = z.object({ error: z.string() });

const passwordResetErrorSchema = z.object({ error: z.string(), code: z.string() });

/** The codes `POST /api/auth/password-reset/consume` answers a rejected token with, all as a 400. */
const PASSWORD_RESET_TOKEN_CODES = new Set([
  "password_reset_token_invalid",
  "password_reset_token_expired",
  "password_reset_token_consumed",
]);

const BAD_REQUEST_STATUS = 400;

export interface LoginInput {
  email: string;
  password: string;
}

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

export interface AuthOperations {
  login(input: LoginInput): Promise<SessionUser>;
  /** Resolves `null` for an anonymous visitor (401) — that is an ordinary outcome, not an error. */
  getSession(): Promise<SessionUser | null>;
  /** Resolves on 200 and on 401: a session that is already gone is logged out. */
  logout(): Promise<void>;
  /** Resolves on any 2xx, for a known and an unknown address alike. */
  requestPasswordReset(email: string): Promise<void>;
  /**
   * Resolves on any 2xx. A rejected token rejects as `unavailable` (status 400); any other failure
   * rejects as `retryable`, so the same token can be submitted again.
   */
  resetPassword(input: ResetPasswordInput): Promise<void>;
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

  async function readSession(): Promise<SessionUser | null> {
    const path = "/auth/session";
    const response = await send(path, { method: "GET" });
    if (response.status === UNAUTHORIZED_STATUS) return null;
    if (!response.ok) throw await failure(path, response);
    return parseUser(response);
  }

  /**
   * The credentials were accepted and the session cookie is already set, so a failed read is retried
   * once. When it still fails, the error says sign-in succeeded, so the user does not resubmit credentials.
   */
  async function readSessionAfterLogin(): Promise<SessionUser> {
    let outcome: SessionUser | null;
    try {
      outcome = await readSession();
    } catch {
      outcome = await readSession().catch((error: unknown) => {
        const reason = error instanceof OperationError ? error.message : String(error);
        throw new OperationError("retryable", `Signed in, but the session could not be read: ${reason}`);
      });
    }
    if (outcome === null) {
      throw new OperationError("retryable", "Signed in, but the session could not be read: no session");
    }
    return outcome;
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
      // The login body carries no role, so the user comes from the session that the login just set up.
      return readSessionAfterLogin();
    },

    getSession: readSession,

    async logout() {
      const path = "/auth/logout";
      const response = await send(path, { method: "POST" });
      if (response.ok || response.status === UNAUTHORIZED_STATUS) return;
      throw await failure(path, response);
    },

    async requestPasswordReset(email) {
      const path = "/auth/password-reset/request";
      const response = await send(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) throw await failure(path, response);
    },

    async resetPassword(input) {
      const path = "/auth/password-reset/consume";
      const response = await send(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: input.token, newPassword: input.newPassword }),
      });
      if (response.ok) return;
      // The body is read once here; a second read would fail, so the rejection is classified from this parse.
      const body = await readJsonBody(response);
      const parsed = passwordResetErrorSchema.safeParse(body);
      if (
        response.status === BAD_REQUEST_STATUS &&
        parsed.success &&
        PASSWORD_RESET_TOKEN_CODES.has(parsed.data.code)
      ) {
        throw new OperationError("unavailable", parsed.data.error, BAD_REQUEST_STATUS);
      }
      const errorMessage = errorResponseSchema.safeParse(body);
      throw new OperationError(
        "retryable",
        errorMessage.success ? errorMessage.data.error : `Request to ${path} failed with ${response.status}`,
        response.status,
      );
    },
  };
}

/** Best-effort read of `{ error: string }` (the handler's shape for 400/401/etc) so a failure surfaces its actual reason instead of a bare status code. */
async function readErrorMessage(response: Response): Promise<string | null> {
  const parsed = errorResponseSchema.safeParse(await readJsonBody(response));
  return parsed.success ? parsed.data.error : null;
}

/** Reads a response body as JSON, resolving `null` when it is not JSON. Consumes the body, so call it once per response. */
async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
