import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's binding for `POST /api/invitations/accept` (issue #1087): the public call that
 * turns an invitation token into a new account. The visitor has no session yet, so this uses the
 * plain `fetch` and sends no bearer header; the single-use token in the body is the credential.
 */

const acceptResponseSchema = z.object({ user: z.object({ email: z.string() }) });

const errorResponseSchema = z.object({ error: z.string() });

export interface AcceptInvitationInput {
  token: string;
  password: string;
}

export interface InvitationOperations {
  /** Resolves the email of the account that the invitation created. The session is not started; the visitor signs in next. */
  acceptInvitation(input: AcceptInvitationInput): Promise<{ email: string }>;
}

export interface InvitationOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** The handler answers every unusable token (unknown, expired, revoked or used) with this one 404, so a retry only repeats the answer. */
const NOT_FOUND_STATUS = 404;

const ACCEPT_PATH = "/invitations/accept";

export function createInvitationOperations(options: InvitationOperationsOptions): InvitationOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async acceptInvitation(input) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${ACCEPT_PATH}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: input.token, password: input.password }),
        });
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }

      if (!response.ok) {
        const message = await readErrorMessage(response);
        throw new OperationError(
          response.status === NOT_FOUND_STATUS ? "unavailable" : "retryable",
          message ?? `Request to ${ACCEPT_PATH} failed with ${response.status}`,
          response.status,
        );
      }

      try {
        const body: unknown = await response.json();
        return acceptResponseSchema.parse(body).user;
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/**
 * Best-effort read of the handler's `{ error: string }` envelope (400, 413, 429 and the rest), so a
 * refusal surfaces its reason. An unreadable error body only loses that reason: the status-based
 * message stands in for it.
 */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const parsed = errorResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}
