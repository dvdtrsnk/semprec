import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { enqueueManualHeartbeatFire } from "./heartbeatAgentTools.js";

/** Duck-typed shape of `semprec-api`'s custom-route mount, so this package imports no HTTP types. */
interface CustomRouteRequestContext {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

type CustomRouteResult = { status: number; body: unknown };

/** A malformed id is a 400 here, not a 500 from the `uuid` column. */
const heartbeatIdSchema = z.string().uuid();

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
