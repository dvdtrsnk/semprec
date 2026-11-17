// The approval request of a mail send by an agent or a run-credential MCP client, and the hash that ties it to the
// draft. No permission lets an agent send without approval, so nothing here reads a project, thread or heartbeat.
// Template and params (catalogs `seed/i18n/{cs,en}.json` and `notifications/i18n/{cs,en}.json`):
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
 * SHA-256 of the canonical JSON of what a send would deliver (mailbox, From, To, Cc, Bcc, subject, text body,
 * attachments). Blobs are immutable and content-addressed, so a blob id stands for its bytes; reply headers are
 * excluded. The executor recomputes it at send time and sends nothing on a mismatch.
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

function buildEmailSendApprovalDescription(mailboxName: string, recipientCount: number): ApprovalDescription {
  return { key: "approval.emailSend", params: { mailboxName, recipientCount } };
}

/**
 * Creates the `pending` send request and, in the same transaction, its `approval_pending` notification. Everything it
 * says is read from the stored draft under its writers' locks (`prepareSend`), never from the caller; refusals are
 * those of `prepareSend`. Risk class `outbound`; its source is derived from the run when read.
 *
 * At most one pending request per draft: an existing one is returned without writing. The Emails item lock is held
 * to the commit, so concurrent calls for one draft are ordered. A repeated `(agentRunId, toolCallId)` returns the
 * earlier request.
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
