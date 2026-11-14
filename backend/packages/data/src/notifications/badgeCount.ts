import { countPendingInvitations } from "../calendar/pendingInvitationCount.js";
import type { Queryable } from "../db/pool.js";
import { countPendingApprovalRequests } from "../mcp/approvalRequestsStore.js";
import { getNotificationPreferences } from "./notificationPreferencesStore.js";

/** The counts the app icon badge and its preview show: the things that wait for the user's decision. */
export interface BadgeCounts {
  /** The pending approval requests of the user's runs, of every source: the count `GET /api/approval-requests/count` serves. */
  pendingApprovals: number;
  /** The live invitations of the tenant whose `status` is `pending` (issue gh-1954). */
  pendingInvites: number;
  /** `0` until the Inbox count is wired in here. */
  openInboxItems: number;
}

/**
 * The three badge counts of `userId` (issue #1828), read on `client`. `GET /api/badge-counts` answers
 * them and `computeBadgeForUser` sums them, so the preview and the badge on the device are computed from
 * one function. `pendingApprovals` counts every source kind, so it equals the pending count of the approval
 * queue; `pendingInvites` counts the live pending invitations of the tenant in scope; `openInboxItems` is `0` for now.
 */
export async function loadBadgeCounts(client: Queryable, userId: string): Promise<BadgeCounts> {
  const pendingApprovals = await countPendingApprovalRequests(client, { ownerUserId: userId, sourceKinds: null });
  const pendingInvites = await countPendingInvitations(client);
  return { pendingApprovals, pendingInvites, openInboxItems: 0 };
}

/**
 * The number the app icon of `userId` shows (issue #1891): the sum of the counts the user switched on
 * (`badgeApprovals`, `badgeInvites`, `badgeInbox` of their notification preferences, or the defaults
 * without a row). With no switch on, or every enabled count at 0, it is `0`, which clears the badge.
 * Preferences and counts are read on `client` one after the other; the counts are those of `userId`
 * alone, whatever other users of the tenant have pending.
 */
export async function computeBadgeForUser(client: Queryable, userId: string): Promise<number> {
  const preferences = await getNotificationPreferences(client, userId);
  const counts = await loadBadgeCounts(client, userId);
  return (
    (preferences.badgeApprovals ? counts.pendingApprovals : 0) +
    (preferences.badgeInvites ? counts.pendingInvites : 0) +
    (preferences.badgeInbox ? counts.openInboxItems : 0)
  );
}
