import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ConflictError, ValidationError } from "../errors.js";
import { loadGuidanceSections, saveGuidanceSections } from "./projectAgentGuidanceSections.js";

interface Context {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}
const requestSchema = z
  .object({
    sections: z
      .object({ purpose: z.string(), allowed: z.string(), notAllowed: z.string(), generalInstructions: z.string() })
      .strict(),
    expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
function projectId(ctx: Context): string {
  const result = z.string().uuid().safeParse(ctx.params.id);
  if (!result.success) throw new ValidationError("Project id must be a UUID", { field: "id" });
  return result.data;
}
export function createProjectAgentGuidanceReadRouteHandler(pool: Pool) {
  return async (ctx: Context) => ({
    status: 200,
    body: await withTransaction(pool, (tx) => loadGuidanceSections(tx, projectId(ctx))),
  });
}
export function createProjectAgentGuidanceSaveRouteHandler(pool: Pool) {
  return async (ctx: Context) => {
    const id = projectId(ctx);
    const parsed = requestSchema.safeParse(ctx.body);
    if (!parsed.success) throw new ValidationError("Invalid guidance request", { field: "sections" });
    try {
      const body = await withTransaction(
        pool,
        (tx) =>
          saveGuidanceSections(tx, {
            projectItemId: id,
            actorUserId: ctx.identity.user.id,
            ...parsed.data,
          }),
        { isolation: "serializable" },
      );
      return { status: 200, body };
    } catch (error) {
      if (error instanceof ConflictError)
        return { status: 409, body: { error: { code: "version_conflict", details: error.details } } };
      if (typeof error === "object" && error !== null && "code" in error && error.code === "40001") {
        const current = await withTransaction(pool, (tx) => loadGuidanceSections(tx, id));
        return { status: 409, body: { error: { code: "version_conflict", details: { current } } } };
      }
      throw error;
    }
  };
}
