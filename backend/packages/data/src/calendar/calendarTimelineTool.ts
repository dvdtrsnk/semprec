// `calendar.timeline` answers what `GET /api/calendar/timeline` answers for the same range, through
// `readCalendarTimeline`. The resolver offers it only to a run whose project owns the calendar databases (over
// `/mcp`, only to a credential naming `calendar.read`) and validates the arguments, so a handler gets a valid range.
//
// Sleep nights derive from the sensitive sleep databases: a run gets them only when its project can read all
// three, checked in the read's transaction, and the answer is then marked `sensitive`; a human `/mcp` session is
// an external AI client and never gets them.
import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, ForbiddenError, NotFoundError } from "../errors.js";
import { assertSleepAccess } from "../sleep/sleepAgentTools.js";
import {
  refusal,
  type CalendarAgentTool,
  type CalendarAgentToolResult,
  type CalendarUserTool,
} from "./calendarAgentTools.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { readCalendarTimeline } from "./timelineRead.js";
import { MAX_RANGE_DAYS } from "./timelineRouteHandler.js";

const calendarDate = z.string().refine(isCalendarDate, "Must be a calendar date YYYY-MM-DD");

/** Both days included. */
function rangeDays(from: string, to: string): number {
  return DateTime.fromISO(to, { zone: "utc" }).diff(DateTime.fromISO(from, { zone: "utc" }), "days").days + 1;
}

/** The description is what the model reads of the tool. */
export const calendarTimelineArgsSchema = z
  .strictObject({
    from: calendarDate.describe("The first day of the range, YYYY-MM-DD."),
    to: calendarDate.describe("The last day of the range, YYYY-MM-DD; it is included."),
  })
  .refine(({ from, to }) => !isCalendarDate(from) || !isCalendarDate(to) || to >= from, {
    message: "'to' must not be before 'from'",
    path: ["to"],
  })
  .refine(({ from, to }) => !isCalendarDate(from) || !isCalendarDate(to) || rangeDays(from, to) <= MAX_RANGE_DAYS, {
    message: `The range must not be longer than ${MAX_RANGE_DAYS} days`,
    path: ["to"],
  })
  .describe(
    `Read what is on the user's calendar from one day to another, both included, for at most ${MAX_RANGE_DAYS} days: ` +
      "the Events, Tasks and the other entries of the calendar views, with each item's calendar, project and people, " +
      "also those of hidden calendars, and the user's planned sleep nights only when the project may read the sleep data. " +
      "Use it to answer questions about the user's day or week.",
  );

export type CalendarTimelineArgs = z.infer<typeof calendarTimelineArgsSchema>;

/**
 * Same check as the sleep tools (`assertSleepAccess`). A 403 or 404 means no sleep nights; any other failure
 * propagates.
 */
async function mayReadSleep(client: PoolClient, agentProjectItemId: string): Promise<boolean> {
  try {
    await assertSleepAccess(client, agentProjectItemId, "read");
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError || err instanceof NotFoundError) return false;
    throw err;
  }
}

/** Marked `sensitive` when the answer holds a sleep night. */
async function timelineResult(
  client: PoolClient,
  args: CalendarTimelineArgs,
  includeSleep: boolean,
): Promise<CalendarAgentToolResult> {
  const timeline = await readCalendarTimeline(client, { from: args.from, to: args.to, shape: "full", includeSleep });
  return {
    error: false,
    result: JSON.stringify(timeline),
    ...(timeline.items.some((item) => item.kind === "sleep") ? { sensitive: true as const } : {}),
  };
}

/**
 * Does not leave out hidden calendars: hiding is a display preference. The run's project is read from the stored
 * run, never from an argument.
 */
export function createCalendarTimelineTool(pool: Pool): CalendarAgentTool<CalendarTimelineArgs> {
  return async (runId, args) => {
    try {
      return await withTransaction(pool, async (client) => {
        const run = await getAgentRun(client, runId);
        if (!run) throw new NotFoundError("Run not found");
        if (run.projectItemId === null) {
          throw new ForbiddenError("The run has no project and so no access to the calendar");
        }
        return timelineResult(client, args, await mayReadSleep(client, run.projectItemId));
      });
    } catch (err) {
      if (err instanceof ChokePointError) return refusal(err);
      throw err;
    }
  };
}

/**
 * A session is an external AI client, which no grant opens the sleep databases for, so its answer has no sleep
 * night and is never sensitive.
 */
export function createCalendarTimelineUserTool(pool: Pool): CalendarUserTool<CalendarTimelineArgs> {
  return (_userId, args) => withTransaction(pool, (client) => timelineResult(client, args, false));
}
