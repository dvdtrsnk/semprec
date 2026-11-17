import { countPendingInvitations } from "../calendar/pendingInvitationCount.js";
import type { Queryable } from "../db/pool.js";
import { countPendingApprovalRequests } from "../mcp/approvalRequestsStore.js";
import { getNotificationPreferences } from "./notificationPreferencesStore.js";

export interface BadgeCounts {
  /** Every source kind, so it equals the approval queue's pending count. */
  pendingApprovals: number;
  pendingInvites: number;
  /** `0` until the Inbox count is wired in here. */
  openInboxItems: number;
}

/** Shared by `GET /api/badge-counts` and `computeBadgeForUser` so preview and device badge agree. */
export async function loadBadgeCounts(client: Queryable, userId: string): Promise<BadgeCounts> {
  const pendingApprovals = await countPendingApprovalRequests(client, { ownerUserId: userId, sourceKinds: null });
  const pendingInvites = await countPendingInvitations(client);
  return { pendingApprovals, pendingInvites, openInboxItems: 0 };
}

/** Sum of the counts the user's preferences enable; `0` clears the badge. */
export async function computeBadgeForUser(client: Queryable, userId: string): Promise<number> {
  const preferences = await getNotificationPreferences(client, userId);
  const counts = await loadBadgeCounts(client, userId);
  return (
    (preferences.badgeApprovals ? counts.pendingApprovals : 0) +
    (preferences.badgeInvites ? counts.pendingInvites : 0) +
    (preferences.badgeInbox ? counts.openInboxItems : 0)
  );
}
