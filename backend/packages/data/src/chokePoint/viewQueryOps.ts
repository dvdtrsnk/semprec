// Owns the choke point's read-through-a-view operations: querying a stored view, and the raw
// request-shaped queries against a database or a view. Nothing that writes state, and no view
// definition management (creating, updating or deleting views and their manual items), belongs here.
// Constrained by: docs/adr/2026-09-17-generic-application-service-port.md
import { withTransaction } from "../db/pool.js";
import * as viewQuery from "../views/viewQuery.js";
import type { ChokePointDeps } from "./chokePointDeps.js";

export function createViewQueryOps(deps: Pick<ChokePointDeps, "pool">) {
  const { pool } = deps;
  return {
    async queryView(viewId: string, options?: viewQuery.QueryViewOptions): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, (client) => viewQuery.queryView(client, viewId, options));
    },

    /** `POST /api/databases/:id/query` (issue #157): raw, request-boundary-validated filter/sort/cursor/limit/inTrash. */
    async queryDatabaseItems(
      databaseId: string,
      input: viewQuery.DatabaseQueryInput,
    ): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, (client) => viewQuery.queryDatabaseItems(client, databaseId, input));
    },

    /** `POST /api/views/:id/query` (issue #157): same raw request shape as `queryDatabaseItems`, resolved against a stored view. */
    async queryViewItems(viewId: string, input: viewQuery.ViewQueryInput): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, (client) => viewQuery.queryViewItems(client, viewId, input));
    },
  };
}
