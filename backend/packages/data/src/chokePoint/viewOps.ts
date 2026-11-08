// Owns views and curated view membership: view create/read/patch/delete, the transaction-scoped
// `viewDeleteWithClient` the approved-operation executor runs, `view_items` add/remove/reorder/list,
// and the one-way user adoption of agent-owned views those writes share. It does not own stored-view
// queries (viewQueryOps.ts), the actor/ownership guards themselves (authorization.ts), or item writes
// (itemWrites.ts).
// Constrained by:
// - docs/adr/2026-09-10-views-are-excluded-from-the-agent-proposal-flow.md
// - docs/adr/2026-09-10-agent-identity-verified-against-projects-items.md
// - docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md
// - docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
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
import { assertAuthenticatedAgentIdentity, assertViewWritable, type Actor } from "./authorization.js";

/** `view_items` carries no FK to `items` (partitioned, no single partition key) — this is the live existence check `addViewItem` runs in its place. */
async function assertItemExists(client: PoolClient, itemId: string): Promise<void> {
  const [item] = await itemsStore.getItemsByIds(client, [itemId]);
  if (!item) throw new NotFoundError(`Item ${itemId} not found`);
}

/**
 * One-way adoption (issue #87): a user's write — patch or curated-membership mutation — to an
 * agent-owned view flips it to 'user' and clears the creator identity, in the same transaction
 * as (and before) the mutation itself. A system view is never adopted: it never has
 * `createdBy === 'ai_agent'`, so the condition below is false for it by construction.
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

/**
 * Transaction-scoped counterpart to `chokePoint.deleteView` (issue #89), factored out for the
 * same reason as `propertyDeleteWithClient` above.
 */
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
    // An agent write here is a direct write, not a proposal through the `confirm` flow — see
    // [[2026-09-10-views-are-excluded-from-the-agent-proposal-flow]]. Issue #87 only tightens
    // *which* agent may write to *which* view, it does not introduce agent direct-writes.
    /**
     * `actor` (default `{ type: 'user' }`) governs `createdBy`/`creatorProjectItemId` — a
     * caller never sets either directly. Creating as `type: 'ai_agent'` requires and stores
     * `actor.agentProjectItemId` (issue #87); a 'user'/'system' actor stores no creator.
     */
    async createView(
      input: Omit<viewsStore.CreateViewInput, "createdBy" | "creatorProjectItemId">,
      actor: Actor = { type: "user" },
      actingUserId?: string,
    ): Promise<ViewRow> {
      return withTransaction(pool, async (client) => {
        await assertAuthenticatedAgentIdentity(client, actor);
        const view = await viewsStore.createView(
          client,
          {
            ...input,
            createdBy: actor.type,
            creatorProjectItemId: actor.type === "ai_agent" ? actor.agentProjectItemId! : null,
          },
          viewTypeRegistry,
        );
        // Curated views (databaseId === null) have no schema to invalidate — nothing else's REST
        // fetch is keyed by one, so there is no client-visible "database changed" to signal here.
        if (view.databaseId !== null) {
          const databaseId = view.databaseId;
          runAfterCommit(client, () => notifyInvalidation({ scope: "schema", databaseId, userId: actingUserId }));
        }
        return view;
      });
    },

    async getView(id: string): Promise<ViewRow | null> {
      return withTransaction(pool, (client) => viewsStore.getView(client, id));
    },

    async listViewsByDatabase(databaseId: string): Promise<ViewRow[]> {
      return withTransaction(pool, (client) => viewsStore.listViewsByDatabase(client, databaseId));
    },

    /** Curated views have no `databaseId` of their own, so they're listed separately rather than scoped to one database. */
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
    }): Promise<ViewRow> {
      return withTransaction(pool, async (client) => {
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.id);
        if (!view) throw new NotFoundError(`View ${input.id} not found`);
        assertViewWritable(view, input.actor);
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
     * Returns the row as it stood immediately before deletion (issue #219): fetched by this same
     * transaction, not a caller-supplied snapshot from a separate `getView` call — a config change
     * landing between a pre-check and this call could otherwise make a REST response describe a
     * state the deleted row never actually had at the moment it was deleted.
     */
    async deleteView(input: { id: string; actor: Actor; actingUserId?: string }): Promise<ViewRow> {
      return withTransaction(pool, (client) => viewDeleteWithClient(client, input.id, input.actor, input.actingUserId));
    },

    // ---- view_items (curated view membership) ----
    async addViewItem(input: {
      viewId: string;
      itemId: string;
      position?: number;
      actor: Actor;
    }): Promise<ViewItemRow> {
      return withTransaction(pool, async (client) => {
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

    async removeViewItem(input: { viewId: string; itemId: string; actor: Actor }): Promise<void> {
      return withTransaction(pool, async (client) => {
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
    }): Promise<ViewItemRow> {
      return withTransaction(pool, async (client) => {
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
