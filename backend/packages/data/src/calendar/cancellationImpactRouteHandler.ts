import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { readCalendarCancellationImpact, type CalendarCancellationImpact } from "./calendarCancellationImpact.js";

/**
 * Duck-typed the same way `eventParticipantsRouteHandlers.ts` is: matches `semprec-api`'s `AdapterRequestContext`
 * structurally, with no dependency on that service's HTTP types.
 */
interface CalendarCancellationImpactRouteRequestContext {
  params: Record<string, string>;
}

const calendarIdSchema = z.uuid();

/**
 * `GET /api/calendar/calendars/:id/cancellation-impact` (issue gh-2003): `{ eventCount, recipientCount,
 * cancellationCount }` for deleting the calendar, as `readCalendarCancellationImpact` describes them. The route
 * only reports: it changes nothing, and the delete asks for no confirmation flag. The read runs in the caller's
 * tenant scope, so a calendar that is unknown, in the Trash or another tenant's answers with the same `not_found`
 * body. An `id` that is not a UUID is `validation_failed` on `id`.
 */
export function createCalendarCancellationImpactRouteHandler(pool: Pool) {
  return async (
    ctx: CalendarCancellationImpactRouteRequestContext,
  ): Promise<{ status: number; body: CalendarCancellationImpact }> => {
    const id = calendarIdSchema.safeParse(ctx.params.id);
    if (!id.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const impact = await withTransaction(pool, (client) => readCalendarCancellationImpact(client, id.data), {
      isolation: "repeatable_read",
    });
    if (impact === null) throw new NotFoundError("Calendar not found");
    return { status: 200, body: impact };
  };
}
