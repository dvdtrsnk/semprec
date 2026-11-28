// Sends one saved Alldots draft for `POST /api/mail/drafts/:id/send` and maps refusals and failures to the codes of the
// REST contract.
import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, ConflictError } from "../errors.js";
import { MailDraftAlreadySentError } from "./draft.js";
import { prepareSend, sentThreadOf } from "./mailDraftSendInput.js";
import {
  MailRecipientRejectedError,
  MailReauthorizationRequiredError,
  MailSendAuthFailedError,
  MailServerUnreachableError,
} from "./providerTypes.js";
import { MailSendClaimLostError, sendDraftEmail, type MailSendAdapterFactory } from "./send.js";

/** The custom-route container members the send route reads; `CustomRouteDependencies` is assignable to it. */
export interface MailDraftSendRouteDependencies {
  mailServerClients?: {
    send?: MailSendAdapterFactory;
  };
}

/**
 * A root without send adapters fails with a plain error, not a `ChokePointError`: the adapter logs it and answers a
 * generic 500, and the draft stays as it was.
 */
export function requireSendAdapters(dependencies: MailDraftSendRouteDependencies): MailSendAdapterFactory {
  const send = dependencies.mailServerClients?.send;
  if (send === undefined) {
    throw new Error('custom route dependency "mailServerClients.send" is not configured by the composition root');
  }
  return send;
}

export interface SentMailDraft {
  emailId: string;
  threadId: string;
  sentAt: string;
  mailbox: { id: string; name: string };
}

/**
 * Maps the four transport error classes (by class, never by message) to REST errors and rethrows anything else. A
 * `MailRecipientRejectedError` is also raised when the server accepted some recipients: those have the message
 * already, and a retry sends it to all of them again.
 */
function rethrowAsRouteError(error: unknown): never {
  if (error instanceof MailReauthorizationRequiredError) {
    throw new ChokePointError(
      409,
      "mail_reauthorization_required",
      "The mailbox must be reauthorized before it can send",
    );
  }
  if (error instanceof MailRecipientRejectedError) {
    throw new ChokePointError(422, "mail_recipient_rejected", error.message);
  }
  if (error instanceof MailSendAuthFailedError) {
    throw new ChokePointError(400, "mail_auth_failed", error.message);
  }
  if (error instanceof MailServerUnreachableError) {
    throw new ChokePointError(400, "mail_server_unreachable", error.message);
  }
  throw error;
}

/**
 * Sends a draft as the user. The draft is read in one transaction and `sendDraftEmail` runs its own, so nothing is
 * held open across the provider call; the send claim arbitrates concurrent calls. The claim transaction re-locks and
 * re-reads the draft (`beforeClaim`), so a draft discarded, sent or changed since the first read is refused (404, 409
 * `mail_draft_already_sent`, 409 `version_conflict`) and what is delivered is what the draft held at the claim. Until
 * finalization the claim makes other draft writers answer 409 `mail_draft_already_sent`.
 *
 * - The loser of the claim answers 409 `mail_draft_already_sent` with `{ emailId, threadId }`, although the winner may
 *   still fail and undo its claim.
 * - A failure before or during delivery leaves the draft sendable: `sendDraftEmail` undoes its claim.
 * - A failure after the provider took the message keeps the claim, so the message is not sent twice.
 */
export async function sendMailDraft(
  pool: Pool,
  draftItemId: string,
  adapters: MailSendAdapterFactory,
): Promise<SentMailDraft> {
  const prepared = await withTransaction(pool, (client) => prepareSend(client, draftItemId));
  try {
    const sent = await sendDraftEmail(pool, prepared.input, prepared.moduleIds, adapters, {
      // Under the claim transaction's locks: a discard or edit that committed since `prepareSend` is seen here.
      beforeClaim: async (client) => {
        const current = await prepareSend(client, draftItemId);
        if (!isDeepStrictEqual(current.input, prepared.input)) {
          throw new ConflictError("The draft was changed while it was being sent; nothing was sent");
        }
      },
    });
    return {
      emailId: sent.itemId,
      threadId: sent.threadId,
      sentAt: sent.sentAt.toISOString(),
      mailbox: prepared.mailbox,
    };
  } catch (error) {
    if (error instanceof MailSendClaimLostError) {
      const threadId = await withTransaction(pool, (client) => sentThreadOf(client, draftItemId, null));
      throw new MailDraftAlreadySentError({ emailId: draftItemId, threadId });
    }
    return rethrowAsRouteError(error);
  }
}
