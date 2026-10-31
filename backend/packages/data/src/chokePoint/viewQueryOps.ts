import { getView } from "./viewsStore.js";
import { expandItemRelations, type RelationExpansionOptions } from "./relationExpansion.js";
import { projectItemsForRead } from "./itemReadProjection.js";
// Owns the choke point's read-through-a-view operations: querying a stored view, and the raw
// request-shaped queries against a database or a view. Nothing that writes state, and no view
// definition management (creating, updating or deleting views and their manual items), belongs here.
// Constrained by: docs/adr/2026-09-17-generic-application-service-port.md
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { withFromInbox } from "./itemOriginReads.js";
import * as viewQuery from "../views/viewQuery.js";
import type { ChokePointDeps } from "./chokePointDeps.js";

/** Stamps `fromInbox` on a result page's items with one origin lookup. */
async function stampFromInbox(client: PoolClient, page: viewQuery.QueryViewResult): Promise<viewQuery.QueryViewResult> {
  return { ...page, items: await projectItemsForRead(client, await withFromInbox(client, page.items)) };
}

export function createViewQueryOps(deps: Pick<ChokePointDeps, "pool">) {
  const { pool } = deps;
  return {
    /** The `users.locale` of a user, or `undefined` when the user row is not visible; callers pass it as the query `locale` so text sorts follow the user's collation. */
    async findUserLocale(userId: string): Promise<string | undefined> {
      return withTransaction(pool, (client) => viewQuery.findUserLocale(client, userId));
    },

    async queryView(viewId: string, options?: viewQuery.QueryViewOptions): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, async (client) =>
        stampFromInbox(client, await viewQuery.queryView(client, viewId, options)),
      );
    },

    /** `POST /api/databases/:id/query` (issue #157): raw, request-boundary-validated filter/sort/cursor/limit/inTrash. */
    async queryDatabaseItems(
      databaseId: string,
      input: viewQuery.DatabaseQueryInput,
      expansion?: RelationExpansionOptions,
    ): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, async (client) => {
        const page = await stampFromInbox(client, await viewQuery.queryDatabaseItems(client, databaseId, input));
        return expansion
          ? {
              ...page,
              items: await expandItemRelations(client, page.items, { ...expansion, databaseIds: [databaseId] }),
            }
          : page;
      });
    },

    /** `POST /api/views/:id/query` (issue #157): same raw request shape as `queryDatabaseItems`, resolved against a stored view. */
    async queryViewItems(
      viewId: string,
      input: viewQuery.ViewQueryInput,
      expansion?: RelationExpansionOptions,
    ): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, async (client) => {
        const page = await stampFromInbox(client, await viewQuery.queryViewItems(client, viewId, input));
        if (!expansion) return page;
        const view = await getView(client, viewId);
        return {
          ...page,
          items: await expandItemRelations(client, page.items, {
            ...expansion,
            databaseIds: view?.databaseId ? [view.databaseId] : undefined,
          }),
        };
      });
    },
  };
}
