// Executor of an approved mail send request. The caller took the claim; this sends outside any transaction of its own
// and records the outcome guarded on the request still being `queued`. A claim whose delivery died is settled by the
// stale-claim sweep and never re-sent, so the mail leaves at most once.
import type { Pool, PoolClient } from "pg";
import { describeModuleToolFailure } from "../agentTools/describeModuleToolFailure.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { postApprovalOutcomeMessage } from "../mcp/approvalOutcomeMessage.js";
import { publishApprovalRequestChange } from "../mcp/approvalRequestRealtime.js";
import {
  recordApprovalRequestOutcome,
  type ApprovalRequest,
  type ApprovalRequestOutcome,
  type MailSendApprovalRequestPayload,
} from "../mcp/approvalRequestsStore.js";
import { logger } from "../mcp/logger.js";
import { MailDraftAlreadySentError, MailDraftNotEditableError } from "./draft.js";
import { prepareSend, type PreparedSend } from "./mailDraftSendInput.js";
import { computeMailDraftHash } from "./mailSendApproval.js";
import { MailSendClaimLostError, sendDraftEmail, type MailSendAdapterFactory } from "./send.js";

/** The draft no longer holds what the request was approved for. */
class ApprovedDraftChangedError extends ConflictError {
  constructor() {
    super("The draft was changed after the send was approved; nothing was sent");
    this.name = "ApprovedDraftChangedError";
  }
}

const DRAFT_CHANGED: ApprovalRequestOutcome = {
  error: true,
  outcomeKind: "sourceChanged",
  result: "The draft was changed, sent or removed after the send was approved, so nothing was sent.",
};

/**
 * Maps the "draft gone/sent/unaddressed" refusals to `ApprovedDraftChangedError`, so they are told apart from a
 * `NotFoundError` raised after the provider took the message. Any other failure propagates.
 */
async function readApprovedDraft(client: PoolClient, draftId: string): Promise<PreparedSend> {
  try {
    return await prepareSend(client, draftId);
  } catch (error) {
    if (
      error instanceof NotFoundError ||
      error instanceof ValidationError ||
      error instanceof MailDraftAlreadySentError ||
      error instanceof MailDraftNotEditableError
    ) {
      throw new ApprovedDraftChangedError();
    }
    throw error;
  }
}

/**
 * 1. Without mail send adapters: `toolUnavailable`, nothing sent.
 * 2. A draft that is gone or changed (hash differs from `draftHash`) is `sourceChanged` (status `conflict`).
 * 3. Sent through `sendDraftEmail` as a `user` actor, the owner's approval being the authorization; its claim
 *    transaction re-checks the hash under the writers' locks, so what is delivered is what was approved. A claim held
 *    by another send is `sourceChanged`; any other failure is `callFailed`, logged by class name and code only, and
 *    not retried.
 * 4. Success records the email and thread ids and the send time.
 */
async function mailSendOutcome(
  pool: Pool,
  adapters: MailSendAdapterFactory | undefined,
  request: ApprovalRequest,
  payload: MailSendApprovalRequestPayload,
): Promise<ApprovalRequestOutcome> {
  if (!adapters) {
    return {
      error: true,
      outcomeKind: "toolUnavailable",
      result: "No mail send adapters are configured for this worker, so nothing was sent.",
    };
  }
  try {
    const prepared = await withTransaction(pool, (client) => readApprovedDraft(client, payload.draftId));
    if (computeMailDraftHash(prepared.input) !== payload.draftHash) return DRAFT_CHANGED;
    const sent = await sendDraftEmail(pool, prepared.input, prepared.moduleIds, adapters, {
      beforeClaim: async (client) => {
        const current = await readApprovedDraft(client, payload.draftId);
        if (computeMailDraftHash(current.input) !== payload.draftHash) throw new ApprovedDraftChangedError();
      },
    });
    return {
      error: false,
      result: JSON.stringify({ emailId: sent.itemId, threadId: sent.threadId, sentAt: sent.sentAt.toISOString() }),
    };
  } catch (error) {
    if (error instanceof ApprovedDraftChangedError || error instanceof MailSendClaimLostError) return DRAFT_CHANGED;
    logger.error({ ...describeModuleToolFailure(error), approvalRequestId: request.id }, "Approved mail send failed");
    return {
      error: true,
      outcomeKind: "callFailed",
      result: "The mail send failed and is not retried. The draft shows whether the message was sent.",
    };
  }
}

/**
 * Records the outcome guarded on the request still being `queued`, posts it to the requesting thread and announces
 * the change, in one transaction. An outcome for an already settled request is discarded and logged.
 */
export async function executeClaimedMailSendApproval(
  pool: Pool,
  adapters: MailSendAdapterFactory | undefined,
  claimed: ApprovalRequest,
  payload: MailSendApprovalRequestPayload,
): Promise<void> {
  const outcome = await mailSendOutcome(pool, adapters, claimed, payload);
  const recorded = await withTransaction(pool, async (client) => {
    const changed = await recordApprovalRequestOutcome(client, claimed.id, outcome);
    if (changed) {
      await postApprovalOutcomeMessage(client, claimed, outcome.error ? "conflict" : "executed");
      await publishApprovalRequestChange(client, claimed);
    }
    return changed;
  });
  if (!recorded) {
    logger.warn(
      { approvalRequestId: claimed.id },
      "Mail send approval outcome discarded: the request was already settled by another delivery",
    );
  }
}
