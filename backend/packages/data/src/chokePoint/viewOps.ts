// Views and curated view membership: view CRUD, `viewDeleteWithClient` for the approved-operation
// executor, `view_items` add/remove/reorder/list, and the one-way user adoption of agent-owned views.
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { ViewItemRow, ViewRow } from "../types.js";
import * as itemsStore from "./itemsStore.js";
import * as viewsStore from "./viewsStore.js";
import * as viewItemsStore from "./viewItemsStore.js";
import type { ViewTypeRegistry } from "./viewTypeRegistry.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { assertReaderDatabaseAccess, type DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
import { assertReaderItemPathAccess, assertReaderViewAccess } from "./readerObjectAccess.js";
import {
  assertAuthenticatedAgentIdentity,
  assertSystemKeyWritable,
  assertViewWritable,
  type Actor,
} from "./authorization.js";

/** `view_items` has no FK to partitioned `items`; this is the existence check `addViewItem` runs instead. */
async function assertItemExists(client: PoolClient, itemId: string): Promise<void> {
  const [item] = await itemsStore.getItemsByIds(client, [itemId]);
  if (!item) throw new NotFoundError(`Item ${itemId} not found`);
}

/**
 * A user's write to an agent-owned view flips it to 'user' and clears the creator identity in the
 * same transaction, before the mutation. A system view never has `createdBy === 'ai_agent'`.
 */
async function adoptIfUserWrite(
  client: PoolClient,
  view: ViewRow,
  actor: Actor,
  viewTypeRegistry: ViewTypeRegistry,
): Promise<void> {
  if (actor.type === "user" && view.createdBy === "ai_agent") {
    await viewsStore.patchView(client, view.id, { createdBy: "user", creatorProjectItemId: null }, viewTypeRegistry);
  }
}

/** Transaction-scoped counterpart to `chokePoint.deleteView`, for the approved-operation executor. */
export async function viewDeleteWithClient(
  client: PoolClient,
  id: string,
  actor: Actor,
  actingUserId?: string,
): Promise<ViewRow> {
  await assertAuthenticatedAgentIdentity(client, actor);
  const view = await viewsStore.getView(client, id);
  if (!view) throw new NotFoundError(`View ${id} not found`);
  assertViewWritable(view, actor);
  await viewsStore.deleteView(client, id);
  if (view.databaseId !== null) {
    const databaseId = view.databaseId;
    runAfterCommit(client, () => notifyInvalidation({ scope: "schema", databaseId, userId: actingUserId }));
  }
  return view;
}

export function createViewOps(deps: Pick<ChokePointDeps, "pool" | "viewTypeRegistry">) {
  const { pool, viewTypeRegistry } = deps;
  return {
    // An agent write here is a direct write, not a proposal through the `confirm` flow.
    /**
     * `actor` (default `{ type: 'user' }`) decides `createdBy`/`creatorProjectItemId`; an `ai_agent`
     * stores `actor.agentProjectItemId`. A `reader` needs `write` on the view's database, checked first;
     * the operations below that take a `reader` check the same way.
     */
    async createView(
      input: Omit<viewsStore.CreateViewInput, "createdBy" | "creatorProjectItemId">,
      actor: Actor = { type: "user" },
      actingUserId?: string,
      reader?: DatabaseReader,
    ): Promise<ViewRow> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined && input.databaseId) {
          await assertReaderDatabaseAccess(client, reader, input.databaseId, "write");
        }
        await assertAuthenticatedAgentIdentity(client, actor);
        assertSystemKeyWritable(input.config, actor);
        const view = await viewsStore.createView(
          client,
          {
            ...input,
            createdBy: actor.type,
            creatorProjectItemId: actor.type === "ai_agent" ? actor.agentProjectItemId! : null,
          },
          viewTypeRegistry,
        );
        // Curated views have no schema whose clients need a "database changed" signal.
        if (view.databaseId !== null) {
          const databaseId = view.databaseId;
          runAfterCommit(client, () => notifyInvalidation({ scope: "schema", databaseId, userId: actingUserId }));
        }
        return view;
      });
    },

    async getView(id: string, reader?: DatabaseReader): Promise<ViewRow | null> {
      return withTransaction(pool, async (client) => {
        if (reader !== undefined) await assertReaderViewAccess(client, reader, id, "read");
        return viewsStore.getView(client, id);
      });
    },

    async listViewsByDatabase(databaseId: string): Promise<ViewRow[]> {
      return withTransaction(pool, (client) => viewsStore.listViewsByDatabase(client, databaseId));
    },

    async listCuratedViews(): Promise<ViewRow[]> {
      return withTransaction(pool, (client) => viewsStore.listCuratedViews(client));
    },

    async patchView(input: {
      id: string;
      actor: Actor;
      name?: string;
      config?: Record<string, unknown>;
      isDefault?: boolean;
      actingUserId?: string;
      reader?: DatabaseReader;
    }): Promise<ViewRow> {
      return withTransaction(pool, async (client) => {
        if (input.reader !== undefined) await assertReaderViewAccess(client, input.reader, input.id, "write");
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.id);
        if (!view) throw new NotFoundError(`View ${input.id} not found`);
        assertViewWritable(view, input.actor);
        assertSystemKeyWritable(input.config, input.actor);
        if (input.actor.type === "ai_agent" && input.isDefault !== undefined) {
          throw new ForbiddenError(
            "is_default cannot be set by an agent, not even on its own view",
            { field: "isDefault" },
            "owner_violation",
          );
        }
        await adoptIfUserWrite(client, view, input.actor, viewTypeRegistry);
        const patched = await viewsStore.patchView(
          client,
          input.id,
          { name: input.name, config: input.config, isDefault: input.isDefault },
          viewTypeRegistry,
        );
        if (patched.databaseId !== null) {
          const databaseId = patched.databaseId;
          runAfterCommit(client, () => notifyInvalidation({ scope: "schema", databaseId, userId: input.actingUserId }));
        }
        return patched;
      });
    },

    /**
     * Returns the row as this transaction read it immediately before deletion, so a concurrent config
     * change cannot make the response describe a state the deleted row never had.
     */
    async deleteView(input: {
      id: string;
      actor: Actor;
      actingUserId?: string;
      reader?: DatabaseReader;
    }): Promise<ViewRow> {
      return withTransaction(pool, async (client) => {
        if (input.reader !== undefined) await assertReaderViewAccess(client, input.reader, input.id, "write");
        return viewDeleteWithClient(client, input.id, input.actor, input.actingUserId);
      });
    },

    // ---- view_items (curated view membership) ----
    // A curated view has no database, so a `reader` is checked against the member item's database (and
    // those above it).
    async addViewItem(input: {
      viewId: string;
      itemId: string;
      position?: number;
      actor: Actor;
      reader?: DatabaseReader;
    }): Promise<ViewItemRow> {
      return withTransaction(pool, async (client) => {
        if (input.reader !== undefined) await assertReaderItemPathAccess(client, input.reader, input.itemId, "write");
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.viewId);
        if (!view) throw new NotFoundError(`View ${input.viewId} not found`);
        if (view.databaseId !== null) {
          throw new ValidationError("Only a curated view (databaseId = null) accepts view_items membership", {
            field: "viewId",
          });
        }
        assertViewWritable(view, input.actor);
        await assertItemExists(client, input.itemId);
        await adoptIfUserWrite(client, view, input.actor, viewTypeRegistry);
        return viewItemsStore.addViewItem(client, input.viewId, input.itemId, input.position);
      });
    },

    async removeViewItem(input: {
      viewId: string;
      itemId: string;
      actor: Actor;
      reader?: DatabaseReader;
    }): Promise<void> {
      return withTransaction(pool, async (client) => {
        if (input.reader !== undefined) await assertReaderItemPathAccess(client, input.reader, input.itemId, "write");
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.viewId);
        if (!view) throw new NotFoundError(`View ${input.viewId} not found`);
        if (view.databaseId !== null) {
          throw new ValidationError("Only a curated view (databaseId = null) accepts view_items membership", {
            field: "viewId",
          });
        }
        assertViewWritable(view, input.actor);
        await adoptIfUserWrite(client, view, input.actor, viewTypeRegistry);
        const removed = await viewItemsStore.removeViewItem(client, input.viewId, input.itemId);
        if (!removed) throw new NotFoundError(`Item ${input.itemId} is not a member of view ${input.viewId}`);
      });
    },

    async reorderViewItem(input: {
      viewId: string;
      itemId: string;
      position: number;
      actor: Actor;
      reader?: DatabaseReader;
    }): Promise<ViewItemRow> {
      return withTransaction(pool, async (client) => {
        if (input.reader !== undefined) await assertReaderItemPathAccess(client, input.reader, input.itemId, "write");
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.viewId);
        if (!view) throw new NotFoundError(`View ${input.viewId} not found`);
        if (view.databaseId !== null) {
          throw new ValidationError("Only a curated view (databaseId = null) accepts view_items membership", {
            field: "viewId",
          });
        }
        assertViewWritable(view, input.actor);
        await adoptIfUserWrite(client, view, input.actor, viewTypeRegistry);
        return viewItemsStore.reorderViewItem(client, input.viewId, input.itemId, input.position);
      });
    },

    async listViewItems(viewId: string): Promise<ViewItemRow[]> {
      return withTransaction(pool, (client) => viewItemsStore.listViewItems(client, viewId));
    },
  };
}
