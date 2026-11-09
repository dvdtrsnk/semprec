import type { CollectionMetadataResolver } from "@semprec/data";
import type { ItemReadInclude } from "@semprec/shared";
import type { Pool } from "pg";
import {
  createChokePoint,
  createDocStore,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type Actor,
  type InitialItemRelation,
  type WriterIdentity,
} from "@semprec/data";
import type {
  AuthenticatedActor,
  Database,
  GenericApplicationPort,
  Item,
  ItemPatchOutput,
  Page,
} from "@semprec/shared";

/**
 * The sole neutral implementation of `GenericApplicationPort` (issue #219): built only over
 * `packages/data`'s public choke-point facade (`createChokePoint`), never a store or SQL
 * directly — `packages/application` is core (see `core-knows-nobody` in
 * `dependency-cruiser.rules.json`) and stays ignorant of which transport (REST today, MCP/AgentTool
 * in #220) is calling it. A composition root (e.g. `semprec-api`'s `app.ts`) constructs one
 * instance per injected `Pool` and threads it through every binding dispatch; there is no other
 * path into the 38-operation catalog's business logic.
 */

/**
 * Every generic-catalog write governs `createdBy`/`creatorProjectItemId` (views) and edge/property
 * ownership (relations) through this — an agent actor is identified by carrying
 * `agentProjectItemId`, matching how #220's AgentTool/MCP composition root will populate
 * `AuthenticatedActor`. Exported so `ApprovedOperationExecutor` and `DestructiveApprovalPreflight`
 * (issue #89, in `genericOperationGateway.ts`) can convert the same actor shape without
 * duplicating this mapping.
 */
export function toActor(actor: AuthenticatedActor): Actor {
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

export function createGenericApplicationService(
  pool: Pool,
  resolver: CollectionMetadataResolver,
): GenericApplicationPort {
  const chokePoint = createChokePoint(pool);
  const docStore = createDocStore(pool);

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

  /** Legacy `include: ["links"]` or `{ links: true }`: attaches each item's links (an empty object when it has none) in one batched read; without it the items come back untouched. */
  async function withLinks<T extends Item>(items: T[], include: ItemReadInclude): Promise<T[]> {
    const links = Array.isArray(include) ? include.includes("links") : include?.links === true;
    const derived = Array.isArray(include) ? include.includes("derived") : include?.derived === true;
    const automation = Array.isArray(include) ? include.includes("automation") : include?.automation === true;
    if (!links && !derived && !automation) return items;
    const ids = items.map((item) => item.id);
    const valuesByItem = derived ? await chokePoint.getDerivedValuesForItems(ids) : undefined;
    const linksByItem = links ? await chokePoint.getValueLinksForItems(ids, derived, valuesByItem) : undefined;
    const automationByItem = automation ? await chokePoint.readAutomationForItems(ids) : undefined;
    return items.map((item) => ({
      ...item,
      ...(linksByItem !== undefined ? { links: linksByItem.get(item.id) ?? {} } : {}),
      ...(valuesByItem !== undefined ? { derived: valuesByItem.get(item.id) ?? {} } : {}),
      ...(automationByItem?.has(item.id) ? { automation: automationByItem.get(item.id) } : {}),
    }));
  }

  function expansion(include: ItemReadInclude) {
    return include && !Array.isArray(include) && include.relations !== undefined
      ? { relations: include.relations, resolver }
      : undefined;
  }
  return {
    // ---- databases ----
    async listDatabases(_actor, input) {
      const databases = await chokePoint.listDatabases();
      return paginate<Database>(databases, input.cursor, input.limit);
    },

    async getDatabase(_actor, input) {
      const database = await chokePoint.getDatabase(input.databaseId);
      if (!database)
        throw new NotFoundError(`Database ${input.databaseId} not found`, {
          resource: "database",
          databaseId: input.databaseId,
        });
      return database;
    },

    async createDatabase(actor, input) {
      const databaseInput = {
        name: input.name,
        parentItemId: input.parentItemId,
        icon: input.icon,
        color: input.color,
      };
      if (input.properties === undefined) return chokePoint.createDatabase(databaseInput, actor.userId);
      // `database.create` holds the database-write capability; property creation needs the separate
      // schema-write capability, so only a human REST session may create properties through it.
      if (actor.restSession !== true) {
        throw new ForbiddenError("Creating a database with properties requires a user session", {
          field: "properties",
        });
      }
      return chokePoint.createDatabaseWithProperties(
        databaseInput,
        input.titlePropertyName ?? "Name",
        input.properties,
        actor.userId,
      );
    },

    async patchDatabase(actor, input) {
      assertNonEmptyPatch(input.patch);
      return chokePoint.patchDatabase(input.databaseId, input.patch, actor.userId);
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

    async getPropertyByKey(_actor, input) {
      return chokePoint.findPropertiesByKey(input.databaseId, input.key, input.type);
    },

    async createProperty(actor, input) {
      if (input.type === "relation") {
        const { property } = await chokePoint.createRelationProperty(
          {
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
          },
          actor.userId,
        );
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
      // Both the existence check and the empty-patch/relation-type guards run inside
      // `chokePoint.updateProperty`'s own transaction, against the row that same transaction
      // fetches — not as a separate read-then-write here, which would leave a window for a
      // concurrent change to slip past them, and would also mean deciding the 404-vs-400 error
      // priority for "unknown id + empty patch" outside the transaction that already knows the
      // answer (issue #219).
      const { property: updated } = await chokePoint.updateProperty(
        input.propertyId,
        { name: input.patch.name, config: input.patch.config, type: input.patch.type },
        actor.userId,
      );
      return updated;
    },

    async patchPropertyWithDatabase(actor, input) {
      // Same transaction-scoped guards as `patchProperty` above (issue #219); the only
      // difference is `chokePoint.updatePropertyWithDatabase` also reads the owning `Database`
      // row inside that same transaction (issue #789).
      const { property, database } = await chokePoint.updatePropertyWithDatabase(
        input.propertyId,
        { name: input.patch.name, config: input.patch.config, type: input.patch.type },
        actor.userId,
      );
      return { property, database };
    },

    async deleteProperty(actor, input) {
      return chokePoint.deleteProperty(input.propertyId, actor.userId);
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
        {
          databaseId: input.databaseId ?? null,
          type: input.type,
          name: input.name,
          config: input.config,
          isDefault: input.isDefault,
        },
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
      return chokePoint.deleteView({ id: input.viewId, actor: toActor(actor), actingUserId: actor.userId });
    },

    async queryView(actor, input) {
      const page = await chokePoint.queryViewItems(
        input.viewId,
        {
          locale: await chokePoint.findUserLocale(actor.userId),
          filter: input.filter,
          sort: input.sort,
          cursor: input.cursor,
          limit: input.limit,
          inTrash: input.inTrash,
          includeCount: input.includeCount,
        },
        expansion(input.include),
      );
      return { ...page, items: await withLinks(page.items, input.include) };
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
      const item = await chokePoint.findItem(input.itemId, expansion(input.include));
      if (!item) throw new NotFoundError(`Item ${input.itemId} not found`, { resource: "item", itemId: input.itemId });
      const [withItemLinks] = await withLinks([item], input.include);
      return withItemLinks ?? item;
    },

    async createItem(actor, input) {
      if (input.relations !== undefined) {
        const properties = await chokePoint.listProperties(input.databaseId);
        const relations = input.relations.map<InitialItemRelation>(({ propertyKey, targetItemIds }) => {
          const property = properties.find((entry) => entry.key === propertyKey && entry.type === "relation");
          if (!property) return { kind: "unresolved" };
          return { kind: "resolved", relationPropertyId: property.id, targetItemIds };
        });
        return chokePoint.createItemWithRelations(
          {
            databaseId: input.databaseId,
            properties: input.properties,
            idempotencyKey: input.idempotencyKey,
            relations,
          },
          actor.userId,
          humanWriterUserIdOf(actor),
          writerIdentityOf(actor),
        );
      }
      return chokePoint.createItem(
        { databaseId: input.databaseId, properties: input.properties, idempotencyKey: input.idempotencyKey },
        actor.userId,
        humanWriterUserIdOf(actor),
        writerIdentityOf(actor),
      );
    },

    async patchItem(actor, input): Promise<ItemPatchOutput> {
      const existing = await requireItem(input.itemId);
      return chokePoint.updateItem(
        {
          databaseId: existing.databaseId,
          itemId: input.itemId,
          propertiesPatch: input.properties,
          ifVersion: input.ifVersion,
        },
        actor.userId,
        humanWriterUserIdOf(actor),
        writerIdentityOf(actor),
      );
    },

    async deleteItem(actor, input) {
      const existing = await requireItemIncludingDeleted(input.itemId);
      const item = await chokePoint.softDeleteItem(
        existing.databaseId,
        input.itemId,
        actor.userId,
        writerIdentityOf(actor),
      );
      if (!item) throw new NotFoundError(`Item ${input.itemId} not found`, { resource: "item", itemId: input.itemId });
      return item;
    },

    async restoreItem(actor, input) {
      const existing = await requireItemIncludingDeleted(input.itemId);
      const item = await chokePoint.restoreItem(
        existing.databaseId,
        input.itemId,
        actor.userId,
        writerIdentityOf(actor),
      );
      if (!item) throw new NotFoundError(`Item ${input.itemId} not found`, { resource: "item", itemId: input.itemId });
      return item;
    },

    async queryDatabase(actor, input) {
      const database = await chokePoint.getDatabase(input.databaseId);
      if (!database)
        throw new NotFoundError(`Database ${input.databaseId} not found`, {
          resource: "database",
          databaseId: input.databaseId,
        });
      const page = await chokePoint.queryDatabaseItems(
        input.databaseId,
        {
          locale: await chokePoint.findUserLocale(actor.userId),
          filter: input.filter,
          sort: input.sort,
          cursor: input.cursor,
          limit: input.limit,
          inTrash: input.inTrash,
          includeCount: input.includeCount,
        },
        expansion(input.include),
      );
      return { ...page, items: await withLinks(page.items, input.include) };
    },

    // ---- relations ----
    async setRelation(actor, input) {
      return chokePoint.setRelation(input, writerIdentityOf(actor), actor.userId);
    },

    async putRelation(actor, input) {
      return chokePoint.createRelation(
        {
          relationPropertyId: input.relationPropertyId,
          callerItemId: input.callerItemId,
          targetItemId: input.targetItemId,
          metadata: input.metadata,
        },
        writerIdentityOf(actor),
        actor.userId,
      );
    },

    async deleteRelation(actor, input) {
      const edge = await chokePoint.deleteRelation(
        {
          relationPropertyId: input.relationPropertyId,
          callerItemId: input.callerItemId,
          targetItemId: input.targetItemId,
        },
        writerIdentityOf(actor),
        actor.userId,
      );
      if (!edge) {
        throw new NotFoundError(`Relation edge not found`, {
          resource: "relationEdge",
          relationPropertyId: input.relationPropertyId,
          callerItemId: input.callerItemId,
          targetItemId: input.targetItemId,
        });
      }
      return edge;
    },

    /** The choke point answers `null` for an unknown, trashed or foreign item; that is the same not-found `requireItem` gives, so no caller can tell the three apart. */
    async listRelations(_actor, input) {
      const relations = await chokePoint.listItemRelations(input.itemId, input.relationPropertyId);
      if (!relations)
        throw new NotFoundError(`Item ${input.itemId} not found`, { resource: "item", itemId: input.itemId });
      return relations;
    },

    async unlinkValue(actor, input) {
      return chokePoint.unlinkValue(
        input,
        writerIdentityOf(actor).writerKind === "user" ? "user" : "agent",
        actor.userId,
      );
    },
    async relinkValue(actor, input) {
      return chokePoint.relinkValue(input, actor.userId);
    },

    async getPage(actor, input) {
      const item = await requireItem(input.itemId);
      if (input.format === "markdown") {
        const { docId, markdown, etag } = await docStore.readPageMarkdown(item.id);
        return { docId, kind: "page", markdown, etag };
      }
      const summary = await docStore.getPageSummary(
        item.id,
        (await chokePoint.findUserLocale(actor.userId)) ?? "en",
        input.limit,
      );
      const path = await chokePoint.getItemPath(item.id);
      const breadcrumbs = await Promise.all(
        path.map(async (entry) => {
          const database = await chokePoint.getDatabase(entry.databaseId);
          const properties = await chokePoint.listProperties(entry.databaseId);
          const titleKey = properties
            .filter((property) => property.type === "title")
            .map((property) => property.key)
            .sort()[0];
          const titleValue = entry.properties[titleKey ?? "name"];
          const title = typeof titleValue === "string" ? titleValue : "";
          const journal =
            database?.ownerModuleId === "journal" &&
            typeof entry.properties.type === "string" &&
            typeof entry.properties.period === "string"
              ? { type: entry.properties.type, period: entry.properties.period }
              : undefined;
          return { itemId: entry.id, title, databaseKey: database?.key ?? null, ...(journal ? { journal } : {}) };
        }),
      );
      return { ...summary, breadcrumbs: breadcrumbs.length > 1 || breadcrumbs[0]?.journal ? breadcrumbs : null };
    },

    async ensurePage(_actor, input) {
      return docStore.ensurePage(input.itemId);
    },

    /** The block is authored by the caller: `ai_agent` for an agent actor, `user` for a person (the same split `toActor` makes). */
    async createSubpage(actor, input) {
      return docStore.createSubpage(input, toActor(actor).type);
    },

    /** Same origin split as `createSubpage`: `ai_agent` for an agent actor (a run credential), `user` for a person. */
    async insertPage(actor, input) {
      const { itemId, placement, markdown, blockIds } = input;
      return docStore.insertPageMarkdown(itemId, { placement, markdown, blockIds, origin: toActor(actor).type });
    },

    // ---- pages ----
    /** The docs module refuses an unknown or non-page item (404), a future `at` (400) and an `at` outside the retained window (410). */
    async restorePageVersion(_actor, input) {
      return docStore.restoreVersion(input.itemId, new Date(input.at));
    },
  } satisfies GenericApplicationPort;
}

/**
 * The one derivation of who wrote, from the caller identity the transport's composition root
 * built (never from a request body): an actor carrying both run ids is an agent run; a REST
 * session is a person; anything else (`/mcp` on a human session, no run credential) is still an
 * agent, an MCP client, without run ids. Every agent value names the user it acts for.
 */
export function writerIdentityOf(actor: AuthenticatedActor): WriterIdentity {
  if (actor.runId !== undefined && actor.agentProjectItemId !== undefined) {
    return {
      writerKind: "agent",
      agentRunId: actor.runId,
      agentProjectItemId: actor.agentProjectItemId,
      onBehalfOfUserId: actor.userId,
    };
  }
  if (actor.restSession === true) return { writerKind: "user" };
  return { writerKind: "agent", onBehalfOfUserId: actor.userId };
}

/** The writer id the choke point's hooks may trust as human: only a REST session actor that is not acting for an agent. */
function humanWriterUserIdOf(actor: AuthenticatedActor): string | undefined {
  return actor.restSession === true && actor.agentProjectItemId === undefined ? actor.userId : undefined;
}
