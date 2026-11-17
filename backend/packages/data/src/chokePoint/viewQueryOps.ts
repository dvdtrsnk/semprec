import { getView } from "./viewsStore.js";
import { expandItemRelations, expansionForReader, type RelationExpansionOptions } from "./relationExpansion.js";
import {
  assertReaderDatabaseAccess,
  listUnreadableDatabaseIds,
  type DatabaseReader,
} from "../agentGrants/agentDatabaseAccess.js";
import { closedSensitiveDatabasesOf, hideClosedRollupValues } from "../agentGrants/closedSensitiveAggregationAccess.js";
import { projectItemsForRead } from "./itemReadProjection.js";
// The choke point's read-through-a-view operations: querying a stored view, and raw request-shaped
// queries against a database or a view. Nothing here writes.
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { withFromInbox } from "./itemOriginReads.js";
import * as viewQuery from "../views/viewQuery.js";
import type { ChokePointDeps } from "./chokePointDeps.js";

async function stampFromInbox(client: PoolClient, page: viewQuery.QueryViewResult): Promise<viewQuery.QueryViewResult> {
  return { ...page, items: await projectItemsForRead(client, await withFromInbox(client, page.items)) };
}

export function createViewQueryOps(deps: Pick<ChokePointDeps, "pool">) {
  const { pool } = deps;
  return {
    /** `undefined` when the user row is not visible; passed as the query `locale` so text sorts follow the user's collation. */
    async findUserLocale(userId: string): Promise<string | undefined> {
      return withTransaction(pool, (client) => viewQuery.findUserLocale(client, userId));
    },

    async queryView(viewId: string, options?: viewQuery.QueryViewOptions): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, async (client) =>
        stampFromInbox(client, await viewQuery.queryView(client, viewId, options)),
      );
    },

    /**
     * `POST /api/databases/:id/query`. A `reader` needs `read` on the database (checked in this
     * transaction) and sees relation targets in databases it may not read as `{ id, hidden: true }`. For
     * an agent, items of a sensitivity-inheriting database (Files, Transcripts, Inbox) linked to a
     * sensitive record it may not read are left out of the page and `totalCount`; filtering on a relation
     * into, or a rollup over, such a database (or sorting by such a rollup) is a `ForbiddenError`, and such
     * rollups read as `{ value: null, hidden: true }`.
     */
    async queryDatabaseItems(
      databaseId: string,
      input: viewQuery.DatabaseQueryInput,
      expansion?: RelationExpansionOptions,
      reader?: DatabaseReader,
    ): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderDatabaseAccess(client, reader, databaseId, "read");
        const closed = await closedSensitiveDatabasesOf(client, reader);
        const queried = await stampFromInbox(
          client,
          await viewQuery.queryDatabaseItems(
            client,
            databaseId,
            input,
            typeof reader === "string" ? reader : undefined,
            closed,
          ),
        );
        const page = { ...queried, items: await hideClosedRollupValues(client, queried.items, closed) };
        const readerExpansion = await expansionForReader(client, expansion, reader);
        return readerExpansion
          ? {
              ...page,
              items: await expandItemRelations(client, page.items, { ...readerExpansion, databaseIds: [databaseId] }),
            }
          : page;
      });
    },

    /**
     * `POST /api/views/:id/query`: the same request shape against a stored view. A filtered or linked
     * view needs `read` on its database; a curated view leaves out the items of databases the reader may
     * not read. The agent-specific exclusions, refusals and hidden rollups of `queryDatabaseItems` apply,
     * including to the view's stored filter and sort.
     */
    async queryViewItems(
      viewId: string,
      input: viewQuery.ViewQueryInput,
      expansion?: RelationExpansionOptions,
      reader?: DatabaseReader,
    ): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, async (client) => {
        const view = reader !== undefined || expansion ? await getView(client, viewId) : null;
        if (reader !== undefined && view?.databaseId) {
          await assertReaderDatabaseAccess(client, reader, view.databaseId, "read");
        }
        // Excluded in the query itself, so the page, cursor and count say nothing about how many members of
        // a closed database the view holds.
        const unreadable =
          reader !== undefined && view?.databaseId === null
            ? await listUnreadableDatabaseIds(client, reader)
            : undefined;
        const closed = await closedSensitiveDatabasesOf(client, reader);
        const queried = await stampFromInbox(
          client,
          await viewQuery.queryViewItems(
            client,
            viewId,
            input,
            unreadable,
            typeof reader === "string" ? reader : undefined,
            closed,
          ),
        );
        const page = { ...queried, items: await hideClosedRollupValues(client, queried.items, closed) };
        const readerExpansion = await expansionForReader(client, expansion, reader);
        if (!readerExpansion) return page;
        return {
          ...page,
          items: await expandItemRelations(client, page.items, {
            ...readerExpansion,
            databaseIds: view?.databaseId ? [view.databaseId] : undefined,
          }),
        };
      });
    },
  };
}
