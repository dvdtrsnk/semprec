import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { findLiveProject } from "../scheduler/heartbeatRunScope.js";
import { getProjectAgentSummary } from "./projectAgentSummary.js";

/**
 * The custom-route handler shape this file's export is cast to by `semprec-api`'s mount (issue #239), duck-typed
 * as in `projectHeartbeatsRoute.ts`. The adapter authenticates a session before a handler runs and runs the
 * handler inside the session's tenant.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
}

type CustomRouteResult = { status: number; body: unknown };

const projectIdSchema = z.uuid();

/**
 * `GET /api/projects/:id/agent-summary` (issue gh-1935): the counts behind the project detail's "Semp in this
 * project" row and its attention dot (`getProjectAgentSummary`), shaped for that one consumer, so it is the
 * "single-consumer-read" justification. Read-only. A project id that is not a live Projects item of the caller's
 * tenant (another tenant's, trashed or unknown) answers 404 with one body; a value that is no UUID answers 400.
 */
export function createProjectAgentSummaryRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const projectId = projectIdSchema.safeParse(ctx.params.id);
    if (!projectId.success) throw new ValidationError("'id' must be a UUID string", { field: "id" });
    const body = await withTransaction(pool, async (client) => {
      if (!(await findLiveProject(client, projectId.data))) throw new NotFoundError("Project not found");
      return getProjectAgentSummary(client, projectId.data);
    });
    return { status: 200, body };
  };
}
