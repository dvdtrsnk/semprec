import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { findLiveProject } from "../scheduler/heartbeatRunScope.js";
import { getProjectAgentSummary } from "./projectAgentSummary.js";

/**
 * Duck-typed custom-route shape the API mount casts this export to. The adapter authenticates the session and runs
 * the handler inside its tenant.
 */
interface CustomRouteRequestContext {
  params: Record<string, string>;
}

type CustomRouteResult = { status: number; body: unknown };

const projectIdSchema = z.uuid();

/**
 * Shaped for the project detail's "Semp in this project" row only. A project that is not a live Projects item of
 * the caller's tenant answers 404 with one body; a non-UUID answers 400.
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
