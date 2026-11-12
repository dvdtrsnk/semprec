import { describe, expect, it } from "vitest";
import type { ApprovalRequestSourceKind } from "../mcp/approvalRequestsStore.js";
import { approvalNotificationLinkHref } from "../notifications/approvalNotificationLink.js";

const REQUEST_ID = "3f2b0c1e-6f0a-4e0e-9a43-0d9b6a7c5e21";
const INBOX_LINK = `?page=inbox&approvalRequestId=${REQUEST_ID}`;

describe("approvalNotificationLinkHref (issue #1787)", () => {
  it("links a request raised in a Semp chat to the Semp chats page, naming the request", () => {
    expect(approvalNotificationLinkHref("chat", REQUEST_ID)).toBe(
      `?page=semp-chats&tab=semp&approvalRequestId=${REQUEST_ID}`,
    );
  });

  it.each<ApprovalRequestSourceKind>(["tick", "mcp"])(
    "links a request of a %s source to the Inbox, naming the request",
    (source) => {
      expect(approvalNotificationLinkHref(source, REQUEST_ID)).toBe(INBOX_LINK);
    },
  );

  it("links a request without a known source to the Inbox", () => {
    expect(approvalNotificationLinkHref(null, REQUEST_ID)).toBe(INBOX_LINK);
  });
});
