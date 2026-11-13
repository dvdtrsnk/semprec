import type { Pool } from "pg";
import { z } from "zod";
import { getOverviewSummary, type OverviewSummary } from "./overviewSummary.js";

type CustomRouteResult = { status: number; body: unknown };

/**
 * The body of `GET /api/overview`. Strict, so a field added to the summary without being declared here fails the
 * route instead of reaching a client unreviewed.
 */
export const overviewSummarySchema: z.ZodType<OverviewSummary> = z.strictObject({
  inboxPending: z.number().int().nonnegative(),
  mailUnread: z.number().int().nonnegative(),
  tasksToday: z.number().int().nonnegative(),
  areas: z.array(z.strictObject({ id: z.uuid(), activeProjectCount: z.number().int().nonnegative() })),
  collections: z.array(
    z.strictObject({
      databaseId: z.uuid(),
      ownerModuleId: z.string().min(1),
      itemCount: z.number().int().nonnegative(),
    }),
  ),
  problemCount: z.number().int().nonnegative(),
  journalTodayItemId: z.uuid().nullable(),
});

/** `GET /api/overview`'s request context: the adapter always supplies the caller, whose id scopes the Inbox approvals. */
interface OverviewRouteRequestContext {
  identity: { user: { id: string } };
}

/**
 * `GET /api/overview` (issue gh-1837) — the badges and counts of the Overview screen in one read, shaped for that
 * one consumer: the "single-consumer-read" justification. The summary is the caller's own tenant only: the custom
 * route runs in the caller's tenant scope and `getOverviewSummary` throws without one; the user comes from the
 * session. The route takes no request input. Thin mapping only: every number is computed by the function of its
 * owner, and the assembled body is validated against `overviewSummarySchema` before it is returned.
 */
export function createOverviewRouteHandler(pool: Pool) {
  return async (ctx: OverviewRouteRequestContext): Promise<CustomRouteResult> => {
    const summary = await getOverviewSummary(pool, { ownerUserId: ctx.identity.user.id });
    return { status: 200, body: overviewSummarySchema.parse(summary) };
  };
}
