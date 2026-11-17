import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { loadBadgeCounts } from "./badgeCount.js";

/** Duck-typed custom-route context so this package need not import `semprec-api`'s HTTP types. */
interface BadgeCountsRouteRequestContext {
  identity: { user: { id: string } };
}

type CustomRouteResult = { status: number; body: unknown };

/** `GET /api/badge-counts`: a single-consumer read. Tenant and user come only from the session. */
export function createBadgeCountsRouteHandler(pool: Pool) {
  return async (ctx: BadgeCountsRouteRequestContext): Promise<CustomRouteResult> => {
    const body = await withTransaction(pool, (client) => loadBadgeCounts(client, ctx.identity.user.id));
    return { status: 200, body };
  };
}
