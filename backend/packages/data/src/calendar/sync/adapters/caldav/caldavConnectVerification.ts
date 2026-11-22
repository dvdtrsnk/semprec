import type { OutboundAddressPolicy } from "../../../../net/outboundAddressPolicy.js";
import { CalendarSyncProviderError, CalendarSyncReauthorizationRequiredError } from "../../adapter.js";
import { discoverCalendarHome } from "./caldavClient.js";
import { CalDavAuthFailedError, CalDavServerInvalidError, CalDavServerUnreachableError } from "./caldavErrors.js";
import { withCalDavSession } from "./caldavHttp.js";

/** Where an iCloud account's calendar discovery starts. */
export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com/";

/** Discovery may take three requests and up to three redirects each. */
const VERIFICATION_TIMEOUT_MS = 45_000;

export interface VerifyCalDavServerInput {
  caldavUrl: string;
  username: string;
  password: string;
  /**
   * Whether a well-known `caldavUrl` may delegate the account to another server (`withCalDavSession`'s
   * `resolveServer`): at connect, where the address is the person's, not once a server is stored.
   */
  resolveServer: boolean;
}

export interface CalDavVerification {
  /** The server a well-known `caldavUrl` delegated the account to, its CalDAV address from then on; else `null`. */
  delegatedServerUrl: string | null;
}

type CalDavVerificationRefusal = CalDavAuthFailedError | CalDavServerUnreachableError | CalDavServerInvalidError;

export function isCalDavVerificationRefusal(error: unknown): error is CalDavVerificationRefusal {
  return (
    error instanceof CalDavAuthFailedError ||
    error instanceof CalDavServerUnreachableError ||
    error instanceof CalDavServerInvalidError
  );
}

/**
 * Resolves when the login finds a calendar home from `caldavUrl`, the discovery the calendar sync runs; rejects with a
 * `CalDavVerificationRefusal`, or with an unexpected error as it is.
 */
export async function verifyCalDavServer(
  input: VerifyCalDavServerInput,
  options: { policy?: OutboundAddressPolicy } = {},
): Promise<CalDavVerification> {
  const signal = AbortSignal.timeout(VERIFICATION_TIMEOUT_MS);
  const start = new URL(input.caldavUrl);
  try {
    return await withCalDavSession(
      { username: input.username, password: input.password },
      { signal, start, resolveServer: input.resolveServer, ...(options.policy ? { policy: options.policy } : {}) },
      async (session) => {
        await discoverCalendarHome(session, start);
        return { delegatedServerUrl: session.delegatedServer()?.href ?? null };
      },
    );
  } catch (error) {
    if (error instanceof CalendarSyncReauthorizationRequiredError) throw new CalDavAuthFailedError();
    if (error instanceof CalendarSyncProviderError) {
      throw error.code === "invalidResponse" ? new CalDavServerInvalidError() : new CalDavServerUnreachableError();
    }
    if (signal.aborted) throw new CalDavServerUnreachableError();
    throw error;
  }
}
