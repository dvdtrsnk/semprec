// What becomes of an approved mail send request (issue gh-1913): the executor that `handleApprovalRequestExecuteTask`
// (mcp/approvalRequestExecution.ts) hands a claimed request of the payload kind `MailSendApprovalRequestPayload`. It
// follows the claim, external call, record-outcome protocol of
// docs/adr/2026-09-29-exactly-once-execution-of-deferred-mcp-tool-calls.md: the claim (`claimApprovalRequestExecution`)
// was taken by the caller, this sends outside any transaction of its own, and the outcome is written guarded on the
// request still being `queued`. A claim whose delivery died is settled by the caller's stale-claim sweep, and the mail
// is not sent by a later delivery, so it leaves at most once.
// Constrained by: docs/adr/2026-11-14-an-agents-mail-send-is-an-approval-request-of-its-own-kind-sent-as-the-user.md
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

/** Raised in the claim transaction of the send when the draft no longer holds what the request was approved for. */
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
 * `prepareSend` for an approved draft: the refusals that say the draft is gone or in the trash, has no draft row, was
 * sent or has no recipient become `ApprovedDraftChangedError`, so that a refusal of the read is told apart from a
 * failure after the provider took the message, which can be a `NotFoundError` as well. Any other failure propagates.
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
 * The outcome of one claimed send request. In order:
 * 1. A worker without mail send adapters records `toolUnavailable` and sends nothing.
 * 2. The draft is read as it is now (`readApprovedDraft`, in one transaction) and its hash is computed again. A draft
 *    that is gone, sent, without a recipient or without a draft row, and a hash that differs from the approved
 *    `draftHash`, are a `sourceChanged` outcome (execution status `conflict`) and nothing is sent.
 * 3. The draft is sent through `sendDraftEmail` as a `user` actor, the owner's approval being the authorization. Its
 *    claim transaction reads the draft again under the writers' locks and refuses a hash that differs, so what is
 *    delivered is what was approved. A claim that another send holds is a `sourceChanged` outcome as well. Any other
 *    failure is `callFailed`, logged by class name and code only. A failure before or during delivery leaves the draft
 *    sendable (`sendDraftEmail` undoes its claim) but the request ends and is not retried; after the provider took
 *    the message the claim stays, so the draft cannot go twice.
 * 4. A sent message is a successful outcome that records the ids of the email and its thread and the send time.
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
 * Settles one mail send request that `claimApprovalRequestExecution` just claimed: works out its outcome
 * (`mailSendOutcome`), then, in one transaction, records it guarded on the request still being `queued`, posts the
 * outcome message into the requesting thread and announces the change. An outcome that finds the request already
 * settled by another path is discarded and logged, like the outcome of a module tool request.
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
