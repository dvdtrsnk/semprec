import type { Pool } from "pg";
import { getSempStatusReport } from "./sempStatusReport.js";
import { getSempStatusSummary } from "./sempStatusSummary.js";

export function createSempStatusRouteHandler(pool: Pool) {
  return async () => ({ status: 200, body: await getSempStatusReport(pool) });
}

/** `GET /api/semp-status/summary` (issue #1631): the active count and the banner. */
export function createSempStatusSummaryRouteHandler(pool: Pool) {
  return async () => ({ status: 200, body: await getSempStatusSummary(pool) });
}
