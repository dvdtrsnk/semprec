import type { Pool } from "pg";
import { getSystemHealthReport } from "./systemHealthReport.js";
import type { CustomRouteResult } from "../customRoute.js";

/**
 * `GET /api/system-health`: a single-consumer read of the caller's own tenant only (operator
 * health is `GET /api/admin/health`). Thin mapping onto `getSystemHealthReport`.
 */
export function createSystemHealthRouteHandler(pool: Pool) {
  return async (): Promise<CustomRouteResult> => {
    const report = await getSystemHealthReport(pool);
    return { status: 200, body: report };
  };
}
