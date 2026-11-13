import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { loadBadgeCounts } from "./badgeCount.js";

/**
 * The custom-route handler shape this file's export is cast to by `semprec-api`'s mount (issue
 * #239) — duck-typed here, same as `notificationPreferencesRoutes.ts`, so this package has no reason
 * to import that service's HTTP types. The adapter always supplies the caller, whose id scopes the
 * approvals.
 */
interface BadgeCountsRouteRequestContext {
  identity: { user: { id: string } };
}

type CustomRouteResult = { status: number; body: unknown };

/**
 * `GET /api/badge-counts` (issue #1828) — the counts the app icon badge and its preview show,
 * `{ pendingApprovals, pendingInvites, openInboxItems }`. Shaped for exactly one consumer, the
 * client's badge, so it is the "single-consumer-read" justification. `pendingApprovals` is
 * `countPendingApprovalRequests` with every source kind, so it equals the pending count of the
 * approval queue; `pendingInvites` and `openInboxItems` are `0` for now. Tenant and user come only
 * from the session. The route takes no query parameters and writes nothing.
 */
export function createBadgeCountsRouteHandler(pool: Pool) {
  return async (ctx: BadgeCountsRouteRequestContext): Promise<CustomRouteResult> => {
    const body = await withTransaction(pool, (client) => loadBadgeCounts(client, ctx.identity.user.id));
    return { status: 200, body };
  };
}
