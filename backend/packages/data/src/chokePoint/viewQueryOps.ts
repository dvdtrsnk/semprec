import { getView } from "./viewsStore.js";
import { expandItemRelations, expansionForReader, type RelationExpansionOptions } from "./relationExpansion.js";
import {
  assertReaderDatabaseAccess,
  listUnreadableDatabaseIds,
  type DatabaseReader,
} from "../agentGrants/agentDatabaseAccess.js";
import { closedSensitiveDatabasesOf, hideClosedRollupValues } from "../agentGrants/closedSensitiveAggregationAccess.js";
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

    /**
     * `POST /api/databases/:id/query` (issue #157): raw, request-boundary-validated filter/sort/cursor/limit/inTrash.
     * An agent (a `reader` that is its project, issue #1810) or an external client (issue #1998) needs `read` access to
     * the database, checked in this transaction before the query, and sees the relation targets of databases it may not
     * read as `{ id, hidden: true }`. For an agent the page and its `totalCount` also leave out the items of a database
     * that inherits sensitivity (Files, Transcripts, Inbox) which are linked to a sensitive record the project may not
     * read, and such a relation target is hidden too (issue #1999). A filter condition on a relation property into a
     * sensitive database the agent's project may not read, or on a rollup that aggregates one, and a sort by such a
     * rollup, is refused with a `ForbiddenError`; the page's rollups of that kind are read as
     * `{ value: null, hidden: true }` (issue #2000).
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
        // The items of a Files, Transcripts or Inbox database that are linked to a sensitive record the agent may not read are left out of the page and its count (issue #1999).
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
     * `POST /api/views/:id/query` (issue #157): same raw request shape as `queryDatabaseItems`, resolved against a stored view.
     * An agent (a `reader` that is its project, issue #1810) or an external client (issue #1998) needs `read` access to
     * the database of a filtered or linked view, checked in this transaction before the query. A curated view has no
     * database: its page, cursor and `totalCount` leave out the items of the databases the reader may not read. For an
     * agent, a filtered or curated view also leaves out the items of a database that inherits sensitivity which are
     * linked to a sensitive record the project may not read (issue #1999). The filter and sort refusals and the hidden
     * rollups of `queryDatabaseItems` apply to an agent here too, the view's stored filter and sort included (issue #2000).
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
        // The unreadable databases are excluded in the query itself, so the page, its cursor and its count cover
        // the readable members only and say nothing about how many members of a closed database the view holds.
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
