import type { Pool } from "pg";
import { getSystemHealthReport } from "./systemHealthReport.js";

type CustomRouteResult = { status: number; body: unknown };

/**
 * `GET /api/system-health` (issue #170) — a live snapshot outside the item model entirely, the
 * "single-consumer-read" justification (this UI's System status block is its one consumer). The
 * snapshot is the caller's own tenant only (issue #1052): the custom route runs in the caller's
 * tenant scope, and `getSystemHealthReport` throws without one. Operator health is
 * `GET /api/admin/health`. Thin mapping only: every aggregation rule lives in
 * `getSystemHealthReport` itself, which persists no samples and takes no request input.
 */
export function createSystemHealthRouteHandler(pool: Pool) {
  return async (): Promise<CustomRouteResult> => {
    const report = await getSystemHealthReport(pool);
    return { status: 200, body: report };
  };
}
