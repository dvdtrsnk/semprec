import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { enqueueManualHeartbeatFire } from "./heartbeatAgentTools.js";
import type { CustomRouteResult, RouteParams, RouteBody, RouteUser } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";

/**
 * `POST /api/heartbeats/:id/trigger`: a person runs an automation now, attributed to the session user
 * with no parent run; the body is not read. Another tenant's id gets the same `not_found` as an unknown one.
 *
 * The check and enqueue share one transaction under the heartbeat's row lock, so a second tap while the
 * first is waiting or running gets `409 heartbeat_running`.
 *
 * Answers `202` with the job key and `activeRun: null`: the worker creates the run later and publishes
 * the tick thread's invalidation, so clients read the active run from the thread.
 */
export function createTriggerHeartbeatRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<CustomRouteResult> => {
    const heartbeatId = requireUuidParam(ctx.params, "id");
    const fired = await withTransaction(pool, (client) =>
      enqueueManualHeartbeatFire(client, {
        heartbeatId,
        projectItemId: null,
        trigger: { triggeredByUserId: ctx.identity.user.id },
        refuseWhileActive: true,
      }),
    );
    return { status: 202, body: { jobKey: fired.jobKey, activeRun: null } };
  };
}
