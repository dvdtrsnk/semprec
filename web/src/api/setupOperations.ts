import { z } from "zod";
import { OperationError } from "./genericOperations.js";

/**
 * The client's own binding for `POST /api/setup` (issue #233's bootstrap API, driven by this
 * wizard per issue #234). Deliberately not folded into `GenericOperations`: this isn't a
 * database view, it's the one-time account-bootstrap call.
 *
 * Unlike every other operations module here, this one *does* carry a bearer token from the
 * browser: the setup token is not a server-side shared secret like `SEMPREC_API_TOKEN`, it's
 * the operator's one-time bootstrap credential, handed to them out of band and pasted into
 * this page's URL — so attaching it is this call's whole job, not something a proxy does on
 * its behalf.
 */

const publicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  locale: z.string(),
  createdAt: z.string(),
});

export type SetupPublicUser = z.infer<typeof publicUserSchema>;

export interface SetupAccountInput {
  token: string;
  email: string;
  password: string;
}

export interface SetupOperations {
  setupAccount(input: SetupAccountInput): Promise<SetupPublicUser>;
}

export interface SetupOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** 404 means "not open" (already bootstrapped, or a wrong token) per #233's design; everything else is retryable, including 400's validation message. */
const NOT_FOUND_STATUS = 404;

export function createSetupOperations(options: SetupOperationsOptions): SetupOperations {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return {
    async setupAccount(input) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/setup`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${input.token}`,
          },
          body: JSON.stringify({ email: input.email, password: input.password }),
        });
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }

      if (!response.ok) {
        const message = await readErrorMessage(response);
        throw new OperationError(
          response.status === NOT_FOUND_STATUS ? "unavailable" : "retryable",
          message ?? `Request to /setup failed with ${response.status}`,
          response.status,
        );
      }

      try {
        const body = (await response.json()) as { user?: unknown };
        return publicUserSchema.parse(body.user);
      } catch (error) {
        throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** Best-effort read of `{ error: string }` (the handler's shape for 400/413/etc) so a validation failure surfaces its actual reason instead of a bare status code. */
async function readErrorMessage(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}
