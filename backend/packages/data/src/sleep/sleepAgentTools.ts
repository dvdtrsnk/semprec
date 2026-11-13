// Issue gh-1840: the two agent tools of the sleep module, declared in `sleepModuleManifest.ts`. `sleepNightsGet`
// reads the resolved nights of a range and `sleepNightSet` sets, changes or resets the exception of one night.
// Plans and settings are ordinary items that an agent changes with the generic `item.patch`, so no tool exists
// for them. The handlers take the run's project from the stored run, never from an argument, and answer in the
// shape of the other module tools: a result string that holds JSON, and an `error` flag.
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { assertAgentDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { isCalendarDate } from "../calendar/eventValidationHook.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { loadSleepNights, parseNightPutBody, upsertSleepNight } from "./sleepRouteHandlers.js";

/**
 * The arguments of `sleepNightsGet`: the first and last night of the range. Their form (a calendar date
 * `YYYY-MM-DD`, `from` not after `to`, at most 62 nights) is judged by `loadSleepNights`, which answers a 400 naming
 * the field.
 */
export const sleepNightsGetArgsSchema = z.strictObject({ from: z.string(), to: z.string() });

/**
 * The arguments of `sleepNightSet`: the night and the fields of its exception. A time is judged by
 * `parseNightPutBody` and `night` by `isCalendarDate`, the checks of `PUT /api/sleep/nights/:night`, so a value
 * they refuse is a 400 naming the field. A field that is omitted is left as it is; null follows the plan again.
 */
export const sleepNightSetArgsSchema = z.strictObject({
  night: z.string(),
  bedTime: z.string().nullable().optional(),
  wakeTime: z.string().nullable().optional(),
  alarm: z.boolean().nullable().optional(),
});

/**
 * What a sleep tool answers. `sensitive` marks an answer that carries the content of the sensitive sleep
 * databases, so that the stored tool result is redacted (docs/adr/2026-11-13-sensitive-tool-results-are-marked-by-the-tool-and-stored-redacted.md).
 */
export interface SleepAgentToolResult {
  error: boolean;
  result: string;
  sensitive?: true;
}

export type SleepAgentTool = (runId: string, args: unknown) => Promise<SleepAgentToolResult>;

/** The error result of a refusal: the HTTP status the route would answer, its error code and message. */
function refusal(error: ChokePointError): SleepAgentToolResult {
  const field =
    typeof error.details === "object" && error.details !== null && "field" in error.details
      ? error.details.field
      : undefined;
  return {
    error: true,
    result: JSON.stringify({
      status: error.status,
      error: error.code,
      message: error.message,
      ...(typeof field === "string" ? { field } : {}),
    }),
  };
}

/** The 400 result for an argument object that does not have the shape of the tool's schema. */
function invalidArguments(): SleepAgentToolResult {
  return refusal(new ValidationError("Invalid arguments"));
}

/**
 * Throws a 403 `forbidden` unless the project of the run holds the user's grant on the sleep databases: `nights` on
 * the nights database and `read` on the settings and the plans, which both tools read to resolve a night. A tenant
 * without the sleep module gets a 404. The reads lock the decision rows `FOR SHARE` in the transaction of `client`
 * (`assertAgentDatabaseAccess`), so a revoke waits for the transaction that passed.
 */
async function assertSleepAccess(
  client: PoolClient,
  agentProjectItemId: string,
  nights: "read" | "write",
): Promise<void> {
  for (const [moduleId, access] of [
    [SLEEP_NIGHTS_MODULE_ID, nights],
    [SLEEP_SETTINGS_MODULE_ID, "read"],
    [SLEEP_PLANS_MODULE_ID, "read"],
  ] as const) {
    const database = await getDatabaseByModuleId(client, moduleId);
    if (!database) throw new NotFoundError("The tenant has no sleep module");
    await assertAgentDatabaseAccess(client, { agentProjectItemId, databaseId: database.id, access });
  }
}

/** The run's stored project and user. A run of the tenant that has no project holds no grant, so it is refused. */
async function runProject(
  client: PoolClient,
  runId: string,
): Promise<{ agentProjectItemId: string; actorUserId: string }> {
  const run = await getAgentRun(client, runId);
  if (!run) throw new NotFoundError("Run not found");
  if (run.projectItemId === null) throw new ForbiddenError("The run has no project and so no access to sleep data");
  return { agentProjectItemId: run.projectItemId, actorUserId: run.actorUserId };
}

/**
 * Runs `work`, answering a `ChokePointError` it throws (a 400, 403 or 404 of the checks and of the choke point) as an
 * error result. Whatever else it throws is not an answer of this tool and propagates, so the session reports a failed
 * tool and the transaction of `work` is rolled back.
 */
async function answering(work: () => Promise<SleepAgentToolResult>): Promise<SleepAgentToolResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ChokePointError) return refusal(err);
    throw err;
  }
}

/**
 * `sleepNightsGet { from, to }` (issue gh-1840): what `loadSleepNights` answers for the range, which is the body of
 * `GET /api/sleep/nights`. The project's read grant on the three sleep databases is checked first, in the same
 * REPEATABLE READ transaction as the reads, so the answer describes one state of the data. Without the grant the
 * answer is a 403 `forbidden` and no sleep item is read.
 */
export function createSleepNightsGetTool(pool: Pool): SleepAgentTool {
  return async function sleepNightsGet(runId, rawArgs) {
    const args = sleepNightsGetArgsSchema.safeParse(rawArgs);
    if (!args.success) return invalidArguments();
    return answering(() =>
      withTransaction(
        pool,
        async (client) => {
          const { agentProjectItemId } = await runProject(client, runId);
          await assertSleepAccess(client, agentProjectItemId, "read");
          const nights = await loadSleepNights(client, args.data);
          return { error: false, sensitive: true as const, result: JSON.stringify(nights) };
        },
        { isolation: "repeatable_read" },
      ),
    );
  };
}

/**
 * `sleepNightSet { night, bedTime?, wakeTime?, alarm? }` (issue gh-1840): `upsertSleepNight` as the agent of the run,
 * answering the resolved night as `PUT /api/sleep/nights/:night` does. It never deletes: null follows the plan. The
 * write is made at once, with no approval request: it only creates or updates items of the sleep nights database.
 *
 * The project's write grant on the nights database and its read grant on the settings and the plans are checked
 * first, in the transaction of the write, because the choke point checks the write grant only when it writes and a
 * call that changes nothing must be refused too. A refused call writes nothing and enqueues no resync job. The
 * writer is `agent` with the run and the project of the stored run, acting for the run's user.
 */
export function createSleepNightSetTool(pool: Pool): SleepAgentTool {
  return async function sleepNightSet(runId, rawArgs) {
    const args = sleepNightSetArgsSchema.safeParse(rawArgs);
    if (!args.success) return invalidArguments();
    const { night, ...rest } = args.data;
    return answering(async () => {
      if (!isCalendarDate(night)) {
        throw new ValidationError("'night' must be a calendar date YYYY-MM-DD", { field: "night" });
      }
      const fields = parseNightPutBody(rest);
      return withTransaction(pool, async (client) => {
        const { agentProjectItemId, actorUserId } = await runProject(client, runId);
        await assertSleepAccess(client, agentProjectItemId, "write");
        const writer: WriterIdentity = {
          writerKind: "agent",
          agentRunId: runId,
          agentProjectItemId,
          onBehalfOfUserId: actorUserId,
        };
        const resolved = await upsertSleepNight(client, { night, fields }, { writer, actingUserId: actorUserId });
        return { error: false, sensitive: true as const, result: JSON.stringify(resolved) };
      });
    });
  };
}
