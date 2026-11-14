// Issue gh-1952: the read tool of the calendar module, declared in `calendarModuleManifest.ts`. `calendar.timeline`
// answers what `GET /api/calendar/timeline` answers for the same range, so Semp and an external client over `/mcp` read
// the user's days and weeks from the function the app uses (`readCalendarTimeline`,
// docs/adr/2026-11-10-calendar-timeline-merges-a-list-of-sources.md). It only reads, so the manifest declares it
// without approval (docs/adr/2026-10-28-module-agent-tools-approval-and-grants.md), and with `mcp` like the other
// calendar tools
// (docs/adr/2026-11-14-calendar-tools-over-mcp-are-gated-for-a-run-credential-and-run-as-the-user-for-a-session.md).
//
// Who may call it is decided before a handler runs: the resolver offers the tool only to a run whose project owns the
// calendar databases (and, over `/mcp`, only to a credential whose list names `calendar.read`), and it validates the
// arguments with the schema below, so a handler is called with a valid range. The handler reads in the tenant scope
// the caller established.
//
// The sleep nights of the timeline are derived from the sensitive sleep databases, so the tool does not answer them
// to everyone who may read the calendar (docs/adr/2026-11-14-the-calendar-timeline-tool-leaves-out-sleep-nights-the-caller-may-not-read.md):
// a run gets them only when its project holds read access to the three sleep databases, checked in the transaction of
// the read, and the answer is then marked `sensitive`; a human `/mcp` session is an external AI client and never gets
// them.
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

/** The days of the range `from`..`to`, both included, for two calendar dates. */
function rangeDays(from: string, to: string): number {
  return DateTime.fromISO(to, { zone: "utc" }).diff(DateTime.fromISO(from, { zone: "utc" }), "days").days + 1;
}

/**
 * The arguments of `calendar.timeline`: the range rules of the route (calendar dates, `to` not before `from`, at most
 * `MAX_RANGE_DAYS` days with both days included). The description is what the model reads of the tool.
 */
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
 * Whether the project holds read access to the three sleep databases, the check of the sleep tools
 * (`assertSleepAccess`). A refusal (403) or a tenant without the sleep module (404) means no sleep nights; any other
 * failure is not an answer and propagates.
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

/**
 * The timeline of the range as JSON: the body `GET /api/calendar/timeline` answers in its full shape, with the sleep
 * nights only when `includeSleep` says the caller may read them. The answer is marked `sensitive` when it holds one.
 */
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
 * `calendar.timeline { from, to }`: `GET /api/calendar/timeline?from=&to=` in the full shape for the tenant of the
 * caller, as JSON. It writes nothing and does not leave out the items of hidden calendars: hiding is a display
 * preference. The run's project is read from the stored run, never from an argument; it decides the sleep nights in
 * the transaction of the read. A run that is unknown or has no project gets the refusal of the other calendar tools.
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
 * The human `/mcp` session's `calendar.timeline`: the same read for the session's user, who has no run. A session is
 * an external AI client, which no grant can open the sensitive sleep databases for
 * (docs/adr/2026-11-13-an-external-ai-client-on-mcp-is-refused-sensitive-databases.md), so its answer has no sleep
 * night and is never marked sensitive.
 */
export function createCalendarTimelineUserTool(pool: Pool): CalendarUserTool<CalendarTimelineArgs> {
  return (_userId, args) => withTransaction(pool, (client) => timelineResult(client, args, false));
}
