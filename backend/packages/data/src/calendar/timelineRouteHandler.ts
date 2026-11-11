import { DateTime } from "luxon";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { readCalendarTimeline } from "./timelineRead.js";

/** The longest range one request may ask for, both days included. A month grid needs at most 42 days. */
const MAX_RANGE_DAYS = 93;

/** The request context of `GET /api/calendar/timeline`: its query string is read from the request URL. */
interface CalendarTimelineRouteRequestContext {
  req: { url?: string };
}

function dateParameter(parameters: URLSearchParams, name: "from" | "to"): string {
  const value = parameters.get(name);
  if (!isCalendarDate(value)) {
    throw new ValidationError(`'${name}' must be a calendar date YYYY-MM-DD`, { field: name });
  }
  return value;
}

/**
 * `GET /api/calendar/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD[&shape=compact]` (issue #1717): the body of
 * `readCalendarTimeline` for the caller's tenant. `from` and `to` are calendar dates, `to` is not before
 * `from`, and the range, both days included, is at most 93 days; `shape` is absent or `compact`. Anything
 * else is a 400 `validation_failed` naming the parameter.
 */
export function createCalendarTimelineRouteHandler(pool: Pool) {
  return async (ctx: CalendarTimelineRouteRequestContext): Promise<{ status: number; body: unknown }> => {
    const parameters = new URL(ctx.req.url ?? "/", "http://localhost").searchParams;
    const from = dateParameter(parameters, "from");
    const to = dateParameter(parameters, "to");
    if (to < from) throw new ValidationError("'to' must not be before 'from'", { field: "to" });
    const days = DateTime.fromISO(to, { zone: "utc" }).diff(DateTime.fromISO(from, { zone: "utc" }), "days").days + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new ValidationError(`The range must not be longer than ${MAX_RANGE_DAYS} days`, { field: "to" });
    }
    const shape = parameters.get("shape");
    if (shape !== null && shape !== "compact") {
      throw new ValidationError("'shape' must be 'compact' when it is given", { field: "shape" });
    }
    const body = await withTransaction(pool, (client) =>
      readCalendarTimeline(client, { from, to, shape: shape ?? "full" }),
    );
    return { status: 200, body };
  };
}
