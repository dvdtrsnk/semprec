// Shared by both `approval_pending` producers so generic and MCP requests link identically.
import type { ApprovalRequestSourceKind } from "../mcp/approvalRequestsStore.js";

/** `chat` sources link to Semp chats, everything else (including unknown) to the Inbox. */
export function approvalNotificationLinkHref(
  source: ApprovalRequestSourceKind | null,
  approvalRequestId: string,
): string {
  const destination = source === "chat" ? "page=semp-chats&tab=semp" : "page=inbox";
  return `?${destination}&approvalRequestId=${approvalRequestId}`;
}
