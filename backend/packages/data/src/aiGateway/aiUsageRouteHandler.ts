import type { Pool } from "pg";
import { getAiUsageReport } from "./aiUsageReport.js";
import { getAiUsageSummary } from "./aiUsageSummary.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { CustomRouteResult, RouteLocale, RouteUrl } from "../customRoute.js";
import { requestUrl } from "../customRoute.js";

/** `GET /api/ai-usage`: thin mapping onto `getAiUsageReport`, which owns every aggregation rule. */
export function createAiUsageRouteHandler(pool: Pool) {
  return async (ctx: RouteLocale & RouteUrl): Promise<CustomRouteResult> => {
    const url = requestUrl(ctx.req);
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
 * `GET /api/ai-usage/summary`: one transaction so spend windows and reset instant share one `now()`.
 */
export function createAiUsageSummaryRouteHandler(pool: Pool) {
  return async (): Promise<CustomRouteResult> => {
    const summary = await withTransaction(pool, (client) => getAiUsageSummary(client));
    return { status: 200, body: summary };
  };
}
