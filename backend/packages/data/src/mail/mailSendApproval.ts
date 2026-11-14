// The approval request of a mail send by an agent or an MCP client with a run credential (issue gh-1913), and the hash
// that ties the request to the draft it was made for. The executor that sends after the approval is
// mail/mailSendApprovalExecution.ts. In v1 no permission lets an agent send without approval, so nothing here reads a
// project, a thread or a heartbeat: the decision does not depend on where the draft or the run is.
// Constrained by: docs/adr/2026-11-14-an-agents-mail-send-is-an-approval-request-of-its-own-kind-sent-as-the-user.md,
// docs/adr/2026-10-28-module-agent-tools-approval-and-grants.md,
// docs/adr/2026-11-12-module-agent-tools-that-require-approval-run-through-a-moduletool-request.md
// Template and params (the catalogs are `seed/i18n/{cs,en}.json` and `notifications/i18n/{cs,en}.json`):
//   approval.emailSend   {mailboxName, recipientCount}   (no recipient, no subject and no body: those are argument values)
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { canonicalizeJson } from "@semprec/shared";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import { createPendingApprovalRequestAndPublish } from "../mcp/approvalRequestRealtime.js";
import { getApprovalRequestSourceKind } from "../mcp/approvalRequestsQueue.js";
import {
  findPendingMailSendApprovalRequest,
  MAIL_DRAFT_SEND_TOOL_NAME,
  type ApprovalDescription,
  type ApprovalRequest,
} from "../mcp/approvalRequestsStore.js";
import { approvalNotificationBody } from "../notifications/approvalNotificationBody.js";
import { approvalNotificationLinkHref } from "../notifications/approvalNotificationLink.js";
import { writeNotification } from "../notifications/notify.js";
import { prepareSend } from "./mailDraftSendInput.js";
import type { MailEnvelopeAddress } from "./mailMessageMetaStore.js";
import type { SendEmailAgentActor, SendEmailInput } from "./send.js";

function recipientsOf(
  addresses: readonly MailEnvelopeAddress[] | undefined,
): Array<{ name: string | null; address: string }> {
  return (addresses ?? []).map((recipient) => ({ name: recipient.name ?? null, address: recipient.address }));
}

/**
 * The hash of what a send would deliver: the mailbox, From, To, Cc, Bcc, subject, text body and attachments, as the
 * SHA-256 hex of their canonical JSON. An attachment is its file name, content type and blob id; a blob is immutable
 * and stored by its content, so its id stands for its bytes. The reply headers are not part of it. The request stores
 * it as `draftHash`, and the executor computes it again from the draft as it is then; a different hash means the
 * draft was changed after it was approved, and nothing is sent.
 */
export function computeMailDraftHash(input: SendEmailInput): string {
  return createHash("sha256")
    .update(
      canonicalizeJson({
        mailboxItemId: input.mailboxItemId,
        from: { name: input.from.name ?? null, address: input.from.address },
        to: recipientsOf(input.to),
        cc: recipientsOf(input.cc),
        bcc: recipientsOf(input.bcc),
        subject: input.subject,
        body: input.bodyText ?? "",
        attachments: (input.attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          blobId: attachment.blobId,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

/** The description of an email send request: the mailbox's name and how many recipients the message has in To, Cc and Bcc. */
function buildEmailSendApprovalDescription(mailboxName: string, recipientCount: number): ApprovalDescription {
  return { key: "approval.emailSend", params: { mailboxName, recipientCount } };
}

/**
 * Creates the `pending` approval request of the agent's send of the draft `draftItemId` (issue gh-1913), and in the
 * same transaction its `approval_pending` notification linked by source, so a rollback drops both. Everything the request
 * says is read from the stored draft under the locks of its writers (`prepareSend`: the Emails item, then its
 * `mail_drafts` row), never from what the caller supplies: the draft hash, the To recipients, the subject and the text
 * body of the payload, and the mailbox's name and the recipient count of the description. The refusals are those of
 * `prepareSend`: 404 for a draft that is gone or a mailbox that is gone, 409 `mail_draft_not_editable` for an item without
 * a draft row, 409 `mail_draft_already_sent` for a sent draft and 400 for a draft without a recipient. The request has risk class
 * `outbound`, and its source (`chat`, `tick` or `mcp`) is derived from the run when it is read.
 *
 * A draft has at most one pending request: when one exists, this returns it and writes nothing. The Emails item lock
 * that `prepareSend` takes is held to the commit, so two concurrent calls for one draft are ordered and the second
 * sees the first's request. A repeated `(agentRunId, toolCallId)` returns the request it created before.
 */
export async function requestMailSendApproval(
  pool: Pool,
  draftItemId: string,
  actor: SendEmailAgentActor,
): Promise<ApprovalRequest> {
  return withTransaction(pool, async (client) => {
    const { input, mailbox } = await prepareSend(client, draftItemId);
    const pending = await findPendingMailSendApprovalRequest(client, draftItemId);
    if (pending !== null) return pending;

    const draftHash = computeMailDraftHash(input);
    const recipientCount = input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0);
    const created = await createPendingApprovalRequestAndPublish(client, {
      agentRunId: actor.agentRunId,
      toolName: MAIL_DRAFT_SEND_TOOL_NAME,
      riskClass: "outbound",
      payload: {
        draftId: draftItemId,
        draftHash,
        mailboxId: mailbox.id,
        to: input.to,
        subject: input.subject,
        body: input.bodyText ?? "",
      },
      resourceSnapshot: { kind: "mail_draft", resourceId: draftItemId, sha256: draftHash },
      toolCallId: actor.toolCallId ?? null,
      description: buildEmailSendApprovalDescription(mailbox.name, recipientCount),
    });
    const { rows } = await client.query<{ actor_user_id: string }>(
      "SELECT actor_user_id FROM agent_runs WHERE id = $1",
      [created.agentRunId],
    );
    await writeNotification(client, {
      userId: requireSingleRow(rows, "agent_runs actor lookup for a mail send approval").actor_user_id,
      kind: "approval_pending",
      ...approvalNotificationBody(created),
      linkHref: approvalNotificationLinkHref(
        await getApprovalRequestSourceKind(client, created.agentRunId),
        created.id,
      ),
      sourceTable: "approval_requests",
      sourceId: created.id,
      transitionInstance: created.id,
    });
    return created;
  });
}
