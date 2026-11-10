import type { Pool } from "pg";
import { getAiUsageReport } from "./aiUsageReport.js";
import { getAiUsageSummary } from "./aiUsageSummary.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";

/**
 * The custom-route handler shape this file's export is cast to by `semprec-api`'s mount (issue
 * #239) — duck-typed here, same as `inboxRouteHandlers.ts`, so this package has no reason to
 * import that service's HTTP types. `req.url` carries the `from`/`to` query string, the one
 * piece of the request this handler needs beyond what `params`/`body` give the others.
 */
interface CustomRouteRequestContext {
  req: { url?: string };
  identity: { user: { locale: string } };
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
    const granularity = url.searchParams.get("granularity") ?? "day";
    if (granularity !== "day" && granularity !== "month") {
      throw new ValidationError("'granularity' must be 'day' or 'month'", { field: "granularity" });
    }
    const report = await getAiUsageReport(pool, {
      from,
      to,
      granularity,
      locale: toManifestLocale(ctx.identity.user.locale),
    });
    return { status: 200, body: report };
  };
}

/**
 * `GET /api/ai-usage/summary` (issue gh-1456): the caller's tenant's spend against its own caps,
 * from `getAiUsageSummary`, read in one transaction so the spend windows and the reset instant are
 * all computed from the same `now()`. It reads no request input: the tenant is the one the session
 * scope resolves. Thin mapping only.
 */
export function createAiUsageSummaryRouteHandler(pool: Pool) {
  return async (): Promise<CustomRouteResult> => {
    const summary = await withTransaction(pool, (client) => getAiUsageSummary(client));
    return { status: 200, body: summary };
  };
}
