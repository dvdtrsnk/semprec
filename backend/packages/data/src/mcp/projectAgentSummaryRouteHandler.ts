import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { findLiveProject } from "../scheduler/heartbeatRunScope.js";
import { getProjectAgentSummary } from "./projectAgentSummary.js";
import type { CustomRouteResult, RouteParams } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";

/**
 * Shaped for the project detail's "Semp in this project" row only. A project that is not a live Projects item of
 * the caller's tenant answers 404 with one body; a non-UUID answers 400.
 */
export function createProjectAgentSummaryRouteHandler(pool: Pool) {
  return async (ctx: RouteParams): Promise<CustomRouteResult> => {
    const projectId = requireUuidParam(ctx.params, "id");
    const body = await withTransaction(pool, async (client) => {
      if (!(await findLiveProject(client, projectId))) throw new NotFoundError("Project not found");
      return getProjectAgentSummary(client, projectId);
    });
    return { status: 200, body };
  };
}
