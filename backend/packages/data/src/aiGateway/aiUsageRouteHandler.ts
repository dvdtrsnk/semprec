import type { Pool } from "pg";
import { getAiUsageReport } from "./aiUsageReport.js";
import { ValidationError } from "../errors.js";

/**
 * The custom-route handler shape this file's export is cast to by `semprec-api`'s mount (issue
 * #239) — duck-typed here, same as `inboxRouteHandlers.ts`, so this package has no reason to
 * import that service's HTTP types. `req.url` carries the `from`/`to` query string, the one
 * piece of the request this handler needs beyond what `params`/`body` give the others.
 */
interface CustomRouteRequestContext {
  req: { url?: string };
}

type CustomRouteResult = { status: number; body: unknown };

/**
 * `GET /api/ai-usage` (issue #239's custom-route registration of #121's `getAiUsageReport`) — an
 * aggregate report spanning `ai_gateway_calls`/`agent_runs`/system settings, outside the item
 * model entirely, the "aggregate read outside the item model" justification. Thin mapping only:
 * every aggregation/bounding rule lives in `getAiUsageReport` itself.
 */
export function createAiUsageRouteHandler(pool: Pool) {
  return async (ctx: CustomRouteRequestContext): Promise<CustomRouteResult> => {
    const url = new URL(ctx.req.url ?? "/", "http://localhost");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) {
      throw new ValidationError("'from' and 'to' query parameters are required");
    }
    const report = await getAiUsageReport(pool, { from, to });
    return { status: 200, body: report };
  };
}
