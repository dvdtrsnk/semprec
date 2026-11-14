// Sends one saved Semprec draft for `POST /api/mail/drafts/:id/send` (issue gh-1896): reads the draft in one
// transaction, hands it to `sendDraftEmail` and answers refusals and failures with the codes of the REST contract.
// Constrained by: docs/adr/2026-09-10-choke-point-api-for-state-writes.md,
// docs/adr/2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row.md,
// docs/adr/2026-11-14-a-mail-draft-that-holds-a-send-claim-is-refused-to-its-other-writers.md
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

/** What the send route answers: the sent message's item and thread, when it was sent, and the mailbox it left from. */
export interface SentMailDraft {
  emailId: string;
  threadId: string;
  sentAt: string;
  mailbox: { id: string; name: string };
}

/**
 * Rethrows a failure of the send as the error the REST contract has a code for, and every other failure unchanged.
 * The four classes below are the ones the transports raise, and each is mapped from its class, never from a message. A `MailRecipientRejectedError` is also raised when the server took the message for
 * some recipients and refused others: those recipients have it already and a retry sends it to all of them again.
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
 * Sends the Semprec draft `draftItemId` in the caller's tenant as the user (`sendDraftEmail`, actor `user`) and answers
 * what the route returns. The draft is read in one transaction (`prepareSend`) and `sendDraftEmail` then runs its own,
 * so nothing is held open across the provider call; the claim of `sendDraftEmail` arbitrates two calls for one draft.
 * The claim transaction locks the draft's item and row and reads the draft again (`beforeClaim`): a draft that was
 * discarded, sent or changed since the first read is refused before anything is claimed or sent (404, 409
 * `mail_draft_already_sent`, 409 `version_conflict`), so what is delivered is what the draft held when the claim
 * committed. From then until the finalization the claim makes the draft's other writers answer 409
 * `mail_draft_already_sent` (`lockUnsentDraft`), so an edit or a discard cannot commit in between.
 *
 * - A call that loses the claim answers 409 `mail_draft_already_sent` with `{ emailId, threadId }`, as a call after the
 *   send does. The loser cannot tell whether the winner will deliver or fail and undo its claim, so for the time of the
 *   winner's send the answer is a promise the winner may still break; reading the draft shows its `sentAt`.
 * - A failure before or during delivery leaves the draft unsent and sendable again: `sendDraftEmail` undoes its claim
 *   before the error reaches here, and this function writes nothing else.
 * - A failure after the provider took the message (the finalizing transaction failing) leaves the claim, so a later
 *   call answers 409 `mail_draft_already_sent` and the message is not sent twice.
 */
export async function sendMailDraft(
  pool: Pool,
  draftItemId: string,
  adapters: MailSendAdapterFactory,
): Promise<SentMailDraft> {
  const prepared = await withTransaction(pool, (client) => prepareSend(client, draftItemId));
  try {
    const sent = await sendDraftEmail(pool, prepared.input, prepared.moduleIds, adapters, {
      // Under the claim transaction's locks: a discard or an edit that committed since `prepareSend` is seen here
      // (a discard as a 404 or a 409 from `prepareSend`, an edit as a change of what would be sent).
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
