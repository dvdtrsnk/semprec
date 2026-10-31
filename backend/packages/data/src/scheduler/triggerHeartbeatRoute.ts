import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { enqueueManualHeartbeatFire } from "./heartbeatAgentTools.js";

/**
 * The custom-route handler shape this file's exports are cast to by `semprec-api`'s mount (issue
 * #239) — duck-typed here, same as `pushRouteHandlers.ts`, so this package has no reason to import
 * that service's HTTP types.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

type CustomRouteResult = { status: number; body: unknown };

/** `project_heartbeats.id` is a `uuid` column: a malformed path id is a 400 here, not a 500 from Postgres. */
const heartbeatIdSchema = z.string().uuid();

/**
 * `POST /api/heartbeats/:id/trigger` (issue #1453) — a person runs an automation now. The caller is
 * the authenticated session user, so the run is attributed to that person with no parent run; the
 * body is not read. The heartbeat is looked up inside the caller's tenant: another tenant's id gets
 * the same `not_found` as an unknown one.
 *
 * The check and the enqueue share one transaction under the heartbeat's row lock (see
 * `enqueueManualHeartbeatFire`), so a second tap that arrives while the first is still waiting or
 * running gets `409 heartbeat_running`, and only one run is made. A tap after that run has finished
 * starts a new one.
 * The answer is `202` with the job key and `activeRun: null`: the run does not exist yet at that
 * point. The worker creates it later, and `coreAgentRunAction` publishes the tick thread's
 * invalidation then, so a client reads the active run from the thread, not from this response.
 */
export function createTriggerHeartbeatRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const parsedId = heartbeatIdSchema.safeParse(ctx.params.id);
    if (!parsedId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const fired = await withTransaction(pool, (client) =>
      enqueueManualHeartbeatFire(client, {
        heartbeatId: parsedId.data,
        projectItemId: null,
        trigger: { triggeredByUserId: ctx.identity.user.id },
        refuseWhileActive: true,
      }),
    );
    return { status: 202, body: { jobKey: fired.jobKey, activeRun: null } };
  };
}
