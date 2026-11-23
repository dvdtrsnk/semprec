import type { Pool } from "pg";
import { z } from "zod";
import { getOverviewSummary, type OverviewSummary } from "./overviewSummary.js";
import type { CustomRouteResult, RouteUser } from "../customRoute.js";

/** Strict, so an undeclared summary field fails the route instead of reaching a client unreviewed. */
export const overviewSummarySchema: z.ZodType<OverviewSummary> = z.strictObject({
  inboxPending: z.number().int().nonnegative(),
  mailUnread: z.number().int().nonnegative(),
  collections: z.array(z.strictObject({ databaseId: z.uuid(), ownerModuleId: z.string().min(1) })),
  problemCount: z.number().int().nonnegative(),
});

/** `GET /api/overview`: a single-consumer read for the Overview screen. Takes no request input. */
export function createOverviewRouteHandler(pool: Pool) {
  return async (ctx: RouteUser): Promise<CustomRouteResult> => {
    const summary = await getOverviewSummary(pool, { ownerUserId: ctx.identity.user.id });
    return { status: 200, body: overviewSummarySchema.parse(summary) };
  };
}
