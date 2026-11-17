// Agent tools of the sleep module. Plans and settings are ordinary items changed with `item.patch`. The run's
// project is taken from the stored run, never from an argument.
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

/** Range form is judged by `loadSleepNights`. */
export const sleepNightsGetArgsSchema = z.strictObject({ from: z.string(), to: z.string() });

/** Values are judged by the same checks as `PUT /api/sleep/nights/:night`; null follows the plan. */
export const sleepNightSetArgsSchema = z.strictObject({
  night: z.string(),
  bedTime: z.string().nullable().optional(),
  wakeTime: z.string().nullable().optional(),
  alarm: z.boolean().nullable().optional(),
});

/** `sensitive` makes the stored tool result redacted. */
export interface SleepAgentToolResult {
  error: boolean;
  result: string;
  sensitive?: true;
}

export type SleepAgentTool = (runId: string, args: unknown) => Promise<SleepAgentToolResult>;

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

function invalidArguments(): SleepAgentToolResult {
  return refusal(new ValidationError("Invalid arguments"));
}

/**
 * `read` on settings and plans is needed because both tools resolve nights from them. The grant rows are locked
 * `FOR SHARE` in `client`'s transaction, so a revoke waits for the transaction that passed.
 */
export async function assertSleepAccess(
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

async function runProject(
  client: PoolClient,
  runId: string,
): Promise<{ agentProjectItemId: string; actorUserId: string }> {
  const run = await getAgentRun(client, runId);
  if (!run) throw new NotFoundError("Run not found");
  if (run.projectItemId === null) throw new ForbiddenError("The run has no project and so no access to sleep data");
  return { agentProjectItemId: run.projectItemId, actorUserId: run.actorUserId };
}

/** Only a `ChokePointError` becomes an error result; anything else propagates and rolls `work` back. */
async function answering(work: () => Promise<SleepAgentToolResult>): Promise<SleepAgentToolResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ChokePointError) return refusal(err);
    throw err;
  }
}

/** Grant check and reads share one REPEATABLE READ transaction, so the answer describes one state. */
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
 * Writes at once with no approval request: it only creates or updates sleep night items, never deletes. The
 * grants are checked up front because the choke point checks the write grant only when it actually writes, and a
 * no-op call must be refused too.
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
