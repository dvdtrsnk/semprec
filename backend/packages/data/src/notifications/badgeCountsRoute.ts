import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { loadBadgeCounts } from "./badgeCount.js";
import type { CustomRouteResult, RouteUser } from "../customRoute.js";

/** `GET /api/badge-counts`: a single-consumer read. Tenant and user come only from the session. */
export function createBadgeCountsRouteHandler(pool: Pool) {
  return async (ctx: RouteUser): Promise<CustomRouteResult> => {
    const body = await withTransaction(pool, (client) => loadBadgeCounts(client, ctx.identity.user.id));
    return { status: 200, body };
  };
}
