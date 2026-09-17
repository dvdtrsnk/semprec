import type { Pool } from "pg";
import { createChokePoint, NotFoundError, ValidationError, type Actor } from "@semprec/data";
import type { AuthenticatedActor, Database, GenericApplicationPort, Item, Page } from "@semprec/shared";

/**
 * The sole neutral implementation of `GenericApplicationPort` (issue #219): built only over
 * `packages/data`'s public choke-point facade (`createChokePoint`), never a store or SQL
 * directly — `packages/application` is core (see `core-knows-nobody` in
 * `dependency-cruiser.rules.json`) and stays ignorant of which transport (REST today, MCP/AgentTool
 * in #220) is calling it. A composition root (e.g. `semprec-api`'s `app.ts`) constructs one
 * instance per injected `Pool` and threads it through every binding dispatch; there is no other
 * path into the 28-operation catalog's business logic.
 */

/** Every generic-catalog write governs `createdBy`/`creatorProjectItemId` (views) and edge/property ownership (relations) through this — an agent actor is identified by carrying `agentProjectItemId`, matching how #220's AgentTool/MCP composition root will populate `AuthenticatedActor`. */
function toActor(actor: AuthenticatedActor): Actor {
  return actor.agentProjectItemId !== undefined
    ? { type: "ai_agent", agentProjectItemId: actor.agentProjectItemId }
    : { type: "user" };
}

/** `patch`-shaped inputs (database/property/view) reject an empty object outright, rather than silently no-op'ing a write that changed nothing. */
function assertNonEmptyPatch(patch: Record<string, unknown>): void {
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("Patch must include at least one field", { reason: "empty_patch" });
  }
}

/** In-memory keyset pagination over an already-fetched row set, id-ordered — the choke-point's own list calls (`listDatabases`, `listCuratedViews`) return every row unpaginated. */
function paginate<T extends { id: string }>(rows: readonly T[], cursor: string | undefined, limit: number): Page<T> {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const start = cursor === undefined ? 0 : sorted.findIndex((row) => row.id > cursor);
  const windowRows = start === -1 ? [] : sorted.slice(start, start + limit);
  const nextCursor = start !== -1 && start + limit < sorted.length ? windowRows[windowRows.length - 1]!.id : null;
  return { items: windowRows, nextCursor };
}

export function createGenericApplicationService(pool: Pool): GenericApplicationPort {
  const chokePoint = createChokePoint(pool);

  async function requireItem(itemId: string): Promise<Item> {
    const item = await chokePoint.findItem(itemId);
    if (!item) throw new NotFoundError(`Item ${itemId} not found`, { resource: "item", itemId });
    return item;
  }

  async function requireItemIncludingDeleted(itemId: string): Promise<Item> {
    const item = await chokePoint.findItemIncludingDeleted(itemId);
    if (!item) throw new NotFoundError(`Item ${itemId} not found`, { resource: "item", itemId });
    return item;
  }

  return {
    // ---- databases ----
    async listDatabases(_actor, input) {
      const databases = await chokePoint.listDatabases();
      return paginate<Database>(databases, input.cursor, input.limit);
    },

    async getDatabase(_actor, input) {
      const database = await chokePoint.getDatabase(input.databaseId);
      if (!database) throw new NotFoundError(`Database ${input.databaseId} not found`, { resource: "database", databaseId: input.databaseId });
      return database;
    },

    async createDatabase(actor, input) {
      return chokePoint.createDatabase({ name: input.name, parentItemId: input.parentItemId }, actor.userId);
    },

    async patchDatabase(actor, input) {
      assertNonEmptyPatch(input.patch);
      return chokePoint.renameDatabase(input.databaseId, input.patch.name!, actor.userId);
    },

    async archiveDatabase(actor, input) {
      return chokePoint.archiveDatabase(input.databaseId, actor.userId);
    },

    async restoreDatabase(actor, input) {
      return chokePoint.restoreDatabase(input.databaseId, actor.userId);
    },

    // ---- properties ----
    async listProperties(_actor, input) {
      return chokePoint.listProperties(input.databaseId);
    },

    async getProperty(_actor, input) {
      const property = await chokePoint.getProperty(input.propertyId);
      if (!property) {
        throw new NotFoundError(`Property ${input.propertyId} not found`, {
          resource: "property",
          propertyId: input.propertyId,
        });
      }
      return property;
    },

    async createProperty(actor, input) {
      if (input.type === "relation") {
        const { property } = await chokePoint.createRelationProperty({
          sourceDatabaseId: input.databaseId,
          key: input.key,
          name: input.name,
          targetDatabaseId: input.targetDatabaseId,
          cardinality: input.cardinality,
          owner: "user",
          locked: input.locked,
          inverse: input.inverse
            ? { key: input.inverse.key, name: input.inverse.name, owner: "user", locked: input.inverse.locked }
            : undefined,
        });
        return property;
      }
      return chokePoint.createProperty(
        {
          databaseId: input.databaseId,
          key: input.key,
          name: input.name,
          type: input.type,
          config: input.config,
          locked: false,
          owner: "user",
        },
        actor.userId,
      );
    },

    async patchProperty(actor, input) {
      assertNonEmptyPatch(input.patch);
      const property = await chokePoint.getProperty(input.propertyId);
      if (!property) {
        throw new NotFoundError(`Property ${input.propertyId} not found`, {
          resource: "property",
          propertyId: input.propertyId,
        });
      }
      if (property.type === "relation" && (input.patch.type !== undefined || input.patch.config !== undefined)) {
        const field = input.patch.type !== undefined ? "type" : "config";
        throw new ValidationError(`Property ${input.propertyId} is a relation; ${field} is changed only via its relation definition`, {
          field,
          reason: "relation_definition_required",
        });
      }
      const { property: updated } = await chokePoint.updateProperty(
        input.propertyId,
        { name: input.patch.name, config: input.patch.config, type: input.patch.type },
        actor.userId,
      );
      return updated;
    },

    async deleteProperty(actor, input) {
      await chokePoint.deleteProperty(input.propertyId, actor.userId);
      return { deleted: true, propertyId: input.propertyId };
    },

    // ---- views ----
    async listViews(_actor, input) {
      const views = await chokePoint.listCuratedViews();
      return paginate(views, input.cursor, input.limit);
    },

    async getView(_actor, input) {
      const view = await chokePoint.getView(input.viewId);
      if (!view) throw new NotFoundError(`View ${input.viewId} not found`, { resource: "view", viewId: input.viewId });
      return view;
    },

    async createView(actor, input) {
      return chokePoint.createView(
        { databaseId: input.databaseId ?? null, type: input.type, name: input.name, config: input.config, isDefault: input.isDefault },
        toActor(actor),
        actor.userId,
      );
    },

    async patchView(actor, input) {
      assertNonEmptyPatch(input.patch);
      return chokePoint.patchView({
        id: input.viewId,
        actor: toActor(actor),
        name: input.patch.name,
        config: input.patch.config,
        isDefault: input.patch.isDefault,
        actingUserId: actor.userId,
      });
    },

    async deleteView(actor, input) {
      await chokePoint.deleteView({ id: input.viewId, actor: toActor(actor), actingUserId: actor.userId });
      return { deleted: true, viewId: input.viewId };
    },

    async queryView(_actor, input) {
      return chokePoint.queryViewItems(input.viewId, {
        filter: input.filter,
        sort: input.sort,
        cursor: input.cursor,
        limit: input.limit,
        inTrash: input.inTrash,
      });
    },

    async addViewItem(actor, input) {
      return chokePoint.addViewItem({
        viewId: input.viewId,
        itemId: input.itemId,
        position: input.position,
        actor: toActor(actor),
      });
    },

    async removeViewItem(actor, input) {
      await chokePoint.removeViewItem({ viewId: input.viewId, itemId: input.itemId, actor: toActor(actor) });
      return { deleted: true, viewId: input.viewId, itemId: input.itemId };
    },

    async reorderViewItem(actor, input) {
      return chokePoint.reorderViewItem({
        viewId: input.viewId,
        itemId: input.itemId,
        position: input.position,
        actor: toActor(actor),
      });
    },

    // ---- items ----
    async getItem(_actor, input) {
      return requireItem(input.itemId);
    },

    async createItem(actor, input) {
      return chokePoint.createItem(
        { databaseId: input.databaseId, properties: input.properties, idempotencyKey: input.idempotencyKey },
        actor.userId,
      );
    },

    async patchItem(actor, input) {
      const existing = await requireItem(input.itemId);
      return chokePoint.updateItem(
        { databaseId: existing.databaseId, itemId: input.itemId, propertiesPatch: input.properties, ifVersion: input.ifVersion },
        actor.userId,
      );
    },

    async deleteItem(actor, input) {
      const existing = await requireItemIncludingDeleted(input.itemId);
      const item = await chokePoint.softDeleteItem(existing.databaseId, input.itemId, actor.userId);
      if (!item) throw new NotFoundError(`Item ${input.itemId} not found`, { resource: "item", itemId: input.itemId });
      return item;
    },

    async restoreItem(actor, input) {
      const existing = await requireItemIncludingDeleted(input.itemId);
      const item = await chokePoint.restoreItem(existing.databaseId, input.itemId, actor.userId);
      if (!item) throw new NotFoundError(`Item ${input.itemId} not found`, { resource: "item", itemId: input.itemId });
      return item;
    },

    async queryDatabase(_actor, input) {
      const database = await chokePoint.getDatabase(input.databaseId);
      if (!database) throw new NotFoundError(`Database ${input.databaseId} not found`, { resource: "database", databaseId: input.databaseId });
      return chokePoint.queryDatabaseItems(input.databaseId, {
        filter: input.filter,
        sort: input.sort,
        cursor: input.cursor,
        limit: input.limit,
        inTrash: input.inTrash,
      });
    },

    // ---- relations ----
    async putRelation(_actor, input) {
      return chokePoint.createRelation({
        relationPropertyId: input.relationPropertyId,
        callerItemId: input.callerItemId,
        targetItemId: input.targetItemId,
        metadata: input.metadata,
      });
    },

    async deleteRelation(_actor, input) {
      const edge = await chokePoint.deleteRelation({
        relationPropertyId: input.relationPropertyId,
        callerItemId: input.callerItemId,
        targetItemId: input.targetItemId,
      });
      if (!edge) {
        throw new NotFoundError(`Relation edge not found`, {
          resource: "relationEdge",
          relationPropertyId: input.relationPropertyId,
          callerItemId: input.callerItemId,
          targetItemId: input.targetItemId,
        });
      }
      return {
        deleted: true,
        relationPropertyId: input.relationPropertyId,
        callerItemId: input.callerItemId,
        targetItemId: input.targetItemId,
      };
    },
  } satisfies GenericApplicationPort;
}
