import type { Pool } from "pg";
import { getSempStatusReport } from "./sempStatusReport.js";

export function createSempStatusRouteHandler(pool: Pool) {
  return async () => ({ status: 200, body: await getSempStatusReport(pool) });
}
