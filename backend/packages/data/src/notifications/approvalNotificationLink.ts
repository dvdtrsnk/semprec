// Where an `approval_pending` notification links (issue #1787). Both producers of that notification,
// `preflightDestructiveApproval` and `createApprovalGatedMcpInvokeTool`, call this function, so a
// generic-operation request and an MCP request of the same source link to the same place.
import type { ApprovalRequestSourceKind } from "../mcp/approvalRequestsStore.js";

/**
 * The `linkHref` of the notification about approval request `approvalRequestId`. `source` is the
 * kind of the request's source (`getApprovalRequestSourceKind`), or `null` when it is not known.
 * A request of a `chat` source links to the Semp chats page. A request of any other source, and a
 * request without a known one, links to the Inbox. Both links carry the request id, and neither
 * names a user.
 */
export function approvalNotificationLinkHref(
  source: ApprovalRequestSourceKind | null,
  approvalRequestId: string,
): string {
  const destination = source === "chat" ? "page=semp-chats&tab=semp" : "page=inbox";
  return `?${destination}&approvalRequestId=${approvalRequestId}`;
}
