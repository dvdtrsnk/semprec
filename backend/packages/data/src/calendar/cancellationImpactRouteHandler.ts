import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { readCalendarCancellationImpact, type CalendarCancellationImpact } from "./calendarCancellationImpact.js";
import type { CustomRouteResult, RouteParams } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";

/**
 * `GET /api/calendar/calendars/:id/cancellation-impact`. Only reports; the delete asks for no confirmation flag.
 * Runs in the caller's tenant scope, so an unknown, trashed or other tenant's calendar is the same `not_found`.
 */
export function createCalendarCancellationImpactRouteHandler(pool: Pool) {
  return async (ctx: RouteParams): Promise<CustomRouteResult<CalendarCancellationImpact>> => {
    const id = requireUuidParam(ctx.params, "id");
    const impact = await withTransaction(pool, (client) => readCalendarCancellationImpact(client, id), {
      isolation: "repeatable_read",
    });
    if (impact === null) throw new NotFoundError("Calendar not found");
    return { status: 200, body: impact };
  };
}
