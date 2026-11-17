import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { readCalendarCancellationImpact, type CalendarCancellationImpact } from "./calendarCancellationImpact.js";

/** Matches `semprec-api`'s `AdapterRequestContext` structurally, without depending on its HTTP types. */
interface CalendarCancellationImpactRouteRequestContext {
  params: Record<string, string>;
}

const calendarIdSchema = z.uuid();

/**
 * `GET /api/calendar/calendars/:id/cancellation-impact`. Only reports; the delete asks for no confirmation flag.
 * Runs in the caller's tenant scope, so an unknown, trashed or other tenant's calendar is the same `not_found`.
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
