import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's binding for `POST /api/invitations/accept` (issue #1087's endpoint, driven by the
 * invitation acceptance page per issue #1088). It uses the plain `fetch`, not the session fetch:
 * the visitor has no session yet, and accepting an invitation does not create one.
 */

const acceptResponseSchema = z.object({ user: z.object({ email: z.string() }) });

const errorResponseSchema = z.object({ error: z.string() });

export interface AcceptInvitationInput {
  token: string;
  password: string;
}

export interface InvitationOperations {
  acceptInvitation(input: AcceptInvitationInput): Promise<{ email: string }>;
}

export interface InvitationOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** The endpoint answers an unknown, expired, revoked or used token with one 404; every other failure is retryable. */
const NOT_FOUND_STATUS = 404;

export function createInvitationOperations(options: InvitationOperationsOptions): InvitationOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async acceptInvitation(input) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/invitations/accept`, {
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
          message ?? `Request to /invitations/accept failed with ${response.status}`,
          response.status,
        );
      }

      try {
        const body: unknown = await response.json();
        return { email: acceptResponseSchema.parse(body).user.email };
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Best-effort read of `{ error: string }`, so a validation or throttling failure surfaces its reason instead of a bare status. */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const parsed = errorResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}
