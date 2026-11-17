import type { CollectionMetadataResolver } from "@semprec/data";
import type { ItemReadInclude } from "@semprec/shared";
import type { Pool } from "pg";
import {
  createChokePoint,
  createDocStore,
  ensureJournalPeriodForWriter,
  ForbiddenError,
  listUnreadableDatabaseIds,
  mergeJournalDuplicatesForWriter,
  NotFoundError,
  PAGES_MODULE_ID,
  readerOfWriter,
  searchItemGroups,
  ValidationError,
  withTransaction,
  type Actor,
  type DatabaseReader,
  type InitialItemRelation,
  type WriterIdentity,
} from "@semprec/data";
import type {
  AuthenticatedActor,
  Database,
  GenericApplicationPort,
  Item,
  ItemPatchOutput,
  OutputByOperation,
  Page,
} from "@semprec/shared";

type BreadcrumbEntry = NonNullable<
  Extract<OutputByOperation["page.get"], { kind: "page"; breadcrumbs: unknown }>["breadcrumbs"]
>[number];

/**
 * The only implementation of `GenericApplicationPort`, built solely over `packages/data`'s public
 * entry points (`createChokePoint`, `createDocStore`, `searchItemGroups`), never a store or SQL.
 * It is transport-agnostic; a composition root builds one per `Pool`.
 */

/**
 * Maps the caller identity to the choke point's `Actor`; an agent is identified by carrying
 * `agentProjectItemId`. Exported for the gateway's approval executor and preflight.
 */
export function toActor(actor: AuthenticatedActor): Actor {
  return actor.agentProjectItemId !== undefined
    ? { type: "ai_agent", agentProjectItemId: actor.agentProjectItemId }
    : { type: "user" };
}

/** An empty patch is rejected rather than silently writing nothing. */
function assertNonEmptyPatch(patch: Record<string, unknown>): void {
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("Patch must include at least one field", { reason: "empty_patch" });
  }
}

/** In-memory id-ordered keyset pagination over rows the choke point returns unpaginated. */
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

  /**
   * `include: ["links"]` or `{ links: true }` attaches each item's links (empty object when none) in one batched read.
   * For an agent or an external client, a link source item in a database the reader may not read is left out.
   */
  async function withLinks<T extends Item>(
    items: T[],
    include: ItemReadInclude,
    reader: DatabaseReader | undefined,
  ): Promise<T[]> {
    const links = Array.isArray(include) ? include.includes("links") : include?.links === true;
    const derived = Array.isArray(include) ? include.includes("derived") : include?.derived === true;
    const automation = Array.isArray(include) ? include.includes("automation") : include?.automation === true;
    if (!links && !derived && !automation) return items;
    const ids = items.map((item) => item.id);
    const valuesByItem = derived ? await chokePoint.getDerivedValuesForItems(ids) : undefined;
    const linksByItem = links ? await chokePoint.getValueLinksForItems(ids, derived, valuesByItem, reader) : undefined;
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
    async listDatabases(actor, input) {
      const databases = await chokePoint.listDatabases(readerOf(actor));
      return paginate<Database>(databases, input.cursor, input.limit);
    },

    async getDatabase(actor, input) {
      const database = await chokePoint.getDatabase(input.databaseId, readerOf(actor));
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
      if (input.properties === undefined) {
        return chokePoint.createDatabase(databaseInput, actor.userId, externalClientReaderOf(actor));
      }
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
      return chokePoint.patchDatabase(
        input.databaseId,
        input.patch,
        actor.userId,
        resolver,
        externalClientReaderOf(actor),
      );
    },

    async archiveDatabase(actor, input) {
      return chokePoint.archiveDatabase(input.databaseId, actor.userId, externalClientReaderOf(actor));
    },

    async restoreDatabase(actor, input) {
      return chokePoint.restoreDatabase(input.databaseId, actor.userId, externalClientReaderOf(actor));
    },

    // The property, view and page operations below pass only the external-client reader, decided in the data layer
    // inside the operation's transaction; an agent's project is not passed on these paths.
    async listProperties(actor, input) {
      return chokePoint.listProperties(input.databaseId, externalClientReaderOf(actor));
    },

    async getProperty(actor, input) {
      const property = await chokePoint.getProperty(input.propertyId, externalClientReaderOf(actor));
      if (!property) {
        throw new NotFoundError(`Property ${input.propertyId} not found`, {
          resource: "property",
          propertyId: input.propertyId,
        });
      }
      return property;
    },

    async getPropertyByKey(actor, input) {
      return chokePoint.findPropertiesByKey(input.databaseId, input.key, input.type, externalClientReaderOf(actor));
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
          externalClientReaderOf(actor),
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
        externalClientReaderOf(actor),
      );
    },

    async patchProperty(actor, input) {
      // The existence and empty-patch/relation-type guards run inside `chokePoint.updateProperty`'s transaction against
      // the row it fetches, so no concurrent change slips between check and write.
      const { property: updated } = await chokePoint.updateProperty(
        input.propertyId,
        { name: input.patch.name, config: input.patch.config, type: input.patch.type },
        actor.userId,
        externalClientReaderOf(actor),
      );
      return updated;
    },

    async patchPropertyWithDatabase(actor, input) {
      // Same transaction-scoped guards as `patchProperty`; this variant also returns the owning `Database`.
      const { property, database } = await chokePoint.updatePropertyWithDatabase(
        input.propertyId,
        { name: input.patch.name, config: input.patch.config, type: input.patch.type },
        actor.userId,
      );
      return { property, database };
    },

    async deleteProperty(actor, input) {
      return chokePoint.deleteProperty(input.propertyId, actor.userId, externalClientReaderOf(actor));
    },

    async addPropertyOption(actor, input) {
      return chokePoint.addPropertyOption(input.propertyId, { label: input.label, color: input.color }, actor.userId);
    },

    /**
     * An option that stores no label returns its catalog label in the caller's locale (English when the user row is not
     * visible). Empty-patch and unknown-option refusals are raised inside the choke point's transaction.
     */
    async updatePropertyOption(actor, input) {
      return chokePoint.updatePropertyOption(
        input.propertyId,
        input.key,
        { label: input.label, color: input.color },
        (await chokePoint.findUserLocale(actor.userId)) ?? "en",
        actor.userId,
      );
    },

    async listViews(_actor, input) {
      const views = await chokePoint.listCuratedViews();
      return paginate(views, input.cursor, input.limit);
    },

    async getView(actor, input) {
      const view = await chokePoint.getView(input.viewId, externalClientReaderOf(actor));
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
        externalClientReaderOf(actor),
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
        reader: externalClientReaderOf(actor),
      });
    },

    async deleteView(actor, input) {
      return chokePoint.deleteView({
        id: input.viewId,
        actor: toActor(actor),
        actingUserId: actor.userId,
        reader: externalClientReaderOf(actor),
      });
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
          q: input.q,
        },
        expansion(input.include),
        readerOf(actor),
      );
      return { ...page, items: await withLinks(page.items, input.include, readerOf(actor)) };
    },

    async addViewItem(actor, input) {
      return chokePoint.addViewItem({
        viewId: input.viewId,
        itemId: input.itemId,
        position: input.position,
        actor: toActor(actor),
        reader: externalClientReaderOf(actor),
      });
    },

    async removeViewItem(actor, input) {
      await chokePoint.removeViewItem({
        viewId: input.viewId,
        itemId: input.itemId,
        actor: toActor(actor),
        reader: externalClientReaderOf(actor),
      });
      return { deleted: true, viewId: input.viewId, itemId: input.itemId };
    },

    async reorderViewItem(actor, input) {
      return chokePoint.reorderViewItem({
        viewId: input.viewId,
        itemId: input.itemId,
        position: input.position,
        actor: toActor(actor),
        reader: externalClientReaderOf(actor),
      });
    },

    async getItem(actor, input) {
      const writer = writerIdentityOf(actor);
      const reader = readerOfWriter(writer);
      const item = await chokePoint.findItem(input.itemId, expansion(input.include), reader, writer.agentRunId);
      if (!item) throw new NotFoundError(`Item ${input.itemId} not found`, { resource: "item", itemId: input.itemId });
      const [withItemLinks] = await withLinks([item], input.include, reader);
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
          q: input.q,
        },
        expansion(input.include),
        readerOf(actor),
      );
      return { ...page, items: await withLinks(page.items, input.include, readerOf(actor)) };
    },

    /**
     * The choke point resolves each entry's database in the caller's tenant and applies its collection filter. An
     * external client is refused the whole call when an entry names a sensitive database; an agent run is refused an
     * entry whose filter reaches a sensitive database its project may not read (the counted database itself is not
     * checked for an agent).
     */
    async countItems(actor, input) {
      const reader = readerOf(actor);
      return chokePoint.countItemsBatch(
        input.items,
        { resolver, ...(typeof reader === "string" ? { agentProjectItemId: reader } : {}) },
        externalClientReaderOf(actor),
      );
    },

    /**
     * Unstored labels follow the locale of the user the actor is or acts for. An external client is refused a sensitive
     * database; an agent run is refused a filter or facet reaching a sensitive database its project may not read (the
     * faceted database itself is not checked for an agent).
     */
    async getDatabaseFacets(actor, input) {
      const reader = readerOf(actor);
      return chokePoint.getDatabaseFacets(
        input,
        {
          locale: await chokePoint.findUserLocale(actor.userId),
          ...(typeof reader === "string" ? { agentProjectItemId: reader } : {}),
        },
        externalClientReaderOf(actor),
      );
    },

    /**
     * Runs in the caller's tenant; an agent's project limits it to the databases it may read. Only a person (a REST
     * session not acting for an agent) gets the `chat` group of Semp threads.
     */
    async searchItems(actor, input) {
      return searchItemGroups(pool, {
        q: input.q,
        scope: input.scope,
        perGroupLimit: input.perGroupLimit,
        cursor: input.cursor,
        agentProjectItemId: writerIdentityOf(actor).agentProjectItemId,
        humanActor: humanWriterUserIdOf(actor) !== undefined,
      });
    },

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

    /** `null` for an unknown, trashed or foreign item gives the same not-found as `requireItem`, so the three are indistinguishable. */
    async listRelations(actor, input) {
      const relations = await chokePoint.listItemRelations(input.itemId, input.relationPropertyId, readerOf(actor));
      if (!relations)
        throw new NotFoundError(`Item ${input.itemId} not found`, { resource: "item", itemId: input.itemId });
      return relations;
    },

    /** Same not-found for unknown, trashed or foreign items as `listRelations`. */
    async listRelatedCollections(actor, input) {
      const related = await chokePoint.listRelatedCollections(input.itemId, resolver, readerOf(actor));
      if (!related)
        throw new NotFoundError(`Item ${input.itemId} not found`, { resource: "item", itemId: input.itemId });
      return related;
    },

    async unlinkValue(actor, input) {
      // The full identity, so an agent under a run is told from one without.
      const writer = writerIdentityOf(actor);
      if (writer.writerKind === "system") throw new Error("An actor never writes as the system");
      return chokePoint.unlinkValue(input, { ...writer, writerKind: writer.writerKind }, actor.userId);
    },
    async relinkValue(actor, input) {
      // The full identity, so an agent under a run is held to its project's grant on the item's database.
      const writer = writerIdentityOf(actor);
      if (writer.writerKind === "system") throw new Error("An actor never writes as the system");
      return chokePoint.relinkValue(input, actor.userId, { ...writer, writerKind: writer.writerKind });
    },

    // Page access (`assertAgentPageAccess`, one resolver for both readers): an agent run is held to its project's grant
    // on the page's owner database (`resolvePageOwner`), plus the grant on a sensitive record's database when the host
    // item is a file, transcript or Inbox entry linked to one; an external client on `/mcp` is refused a sensitive owner
    // database. Each method passes `readerOf(actor)` to the document store, checked in the operation's transaction;
    // `replacePage` passes it in its writer. `restorePageVersion` passes only an external client's reader, since an
    // agent's call is held for approval and checked by its approval projection. A person and the system carry no reader.
    async getPage(actor, input) {
      const item = await requireItem(input.itemId);
      const reader = readerOf(actor);
      if (input.format === "markdown") {
        const { docId, markdown, etag } = await docStore.readPageMarkdown(item.id, reader);
        return { docId, kind: "page", markdown, etag };
      }
      const summary = await docStore.getPageSummary(
        item.id,
        (await chokePoint.findUserLocale(actor.userId)) ?? "en",
        input.limit,
        reader,
      );
      const path = await chokePoint.getItemPath(item.id);
      // An ancestor can live in a database this reader may not read, so for an agent's project or an external client
      // its trail entry names the item and nothing else, like a hidden relation target.
      const unreadableDatabaseIds =
        reader === undefined
          ? new Set<string>()
          : await withTransaction(pool, (client) => listUnreadableDatabaseIds(client, reader));
      let hostedByPagesDatabase = false;
      const breadcrumbs = await Promise.all(
        path.map(async (entry): Promise<BreadcrumbEntry> => {
          if (unreadableDatabaseIds.has(entry.databaseId)) {
            return { itemId: entry.id, title: "", databaseKey: null, hidden: true };
          }
          const database = await chokePoint.getDatabase(entry.databaseId);
          const properties = await chokePoint.listProperties(entry.databaseId);
          const titleKey = properties
            .filter((property) => property.type === "title")
            .map((property) => property.key)
            .sort()[0];
          const titleValue = entry.properties[titleKey ?? "name"];
          const title = typeof titleValue === "string" ? titleValue : "";
          if (entry.id === item.id) hostedByPagesDatabase = database?.ownerModuleId === PAGES_MODULE_ID;
          const journal =
            database?.ownerModuleId === "journal" &&
            typeof entry.properties.type === "string" &&
            typeof entry.properties.period === "string"
              ? { type: entry.properties.type, period: entry.properties.period }
              : undefined;
          return { itemId: entry.id, title, databaseKey: database?.key ?? null, ...(journal ? { journal } : {}) };
        }),
      );
      // A Pages item always has breadcrumbs, even the one-element trail of a page whose parent is missing or trashed.
      const hasTrail = breadcrumbs.length > 1 || breadcrumbs[0]?.journal || hostedByPagesDatabase;
      return { ...summary, breadcrumbs: hasTrail ? breadcrumbs : null };
    },

    /** The docs module resolves the item in the caller's tenant and bounds the replay. */
    async listPageChanges(actor, input) {
      return docStore.listPageChanges(
        input.itemId,
        { since: new Date(input.since), by: input.by, limit: input.limit },
        readerOf(actor),
      );
    },

    /** The Journal entry of a period and its page, created when missing; an agent needs write access to the Journal database. */
    async ensureJournalPeriod(actor, input) {
      return withTransaction(pool, (client) =>
        ensureJournalPeriodForWriter(
          client,
          input.type,
          { date: input.date, period: input.period },
          writerIdentityOf(actor),
        ),
      );
    },

    /**
     * Merges the first two live entries of a Journal period, or answers `{ merged: false }`. No approval here: an agent's
     * call is held for approval by the gateway before it reaches this method.
     */
    async mergeJournalDuplicates(actor, input) {
      return withTransaction(pool, (client) => mergeJournalDuplicatesForWriter(client, input, writerIdentityOf(actor)));
    },

    async ensurePage(actor, input) {
      return docStore.ensurePage(input.itemId, readerOf(actor));
    },

    /** The block is authored as `ai_agent` for an agent actor, `user` for a person. */
    async createSubpage(actor, input) {
      return docStore.createSubpage(input, toActor(actor).type, readerOf(actor));
    },

    /** Authored like `createSubpage`; the copy's title suffix follows the locale of the user the actor is or acts for (English when not found). */
    async duplicatePage(actor, input) {
      return docStore.duplicatePage(
        input.pageItemId,
        {
          origin: toActor(actor).type,
          locale: (await chokePoint.findUserLocale(actor.userId)) ?? "en",
        },
        readerOf(actor),
      );
    },

    /** The parent's block is rewritten as the caller, authored like `createSubpage`. */
    async renamePage(actor, input) {
      return docStore.renamePage(input, toActor(actor).type, readerOf(actor));
    },

    /**
     * Authored like `createSubpage`; the page tree is trashed with the caller's writer identity and user so trash hooks
     * see who asked. An agent run's call is held for approval by the gateway first.
     */
    async convertPageToBlock(actor, input) {
      return docStore.convertPageToBlock(input, {
        origin: toActor(actor).type,
        writer: writerIdentityOf(actor),
        actingUserId: actor.userId,
      });
    },

    /** Authored like `createSubpage`. */
    async insertPage(actor, input) {
      const { itemId, placement, markdown, blockIds } = input;
      return docStore.insertPageMarkdown(
        itemId,
        { placement, markdown, blockIds, origin: toActor(actor).type },
        readerOf(actor),
      );
    },

    /** Authored like `insertPage`; subpages it trashes are trashed with the caller's writer identity and user. */
    async replacePage(actor, input) {
      return docStore.replacePageMarkdown(input.itemId, {
        markdown: input.markdown,
        expectedEtag: input.expectedEtag,
        origin: toActor(actor).type,
        writer: writerIdentityOf(actor),
        actingUserId: actor.userId,
      });
    },

    /** The docs module refuses an unknown or non-page item (404), a future `at` (400) and an `at` outside the retained window (410). */
    async restorePageVersion(actor, input) {
      return docStore.restoreVersion(input.itemId, new Date(input.at), externalClientReaderOf(actor));
    },
  } satisfies GenericApplicationPort;
}

/**
 * Who wrote, derived from the caller identity the composition root built (never a request body):
 * both run ids make an agent run; a REST session is a person; anything else is an MCP client agent
 * without run ids, carrying `externalClient` when the actor does. Every agent value names the user
 * it acts for.
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
  return {
    writerKind: "agent",
    onBehalfOfUserId: actor.userId,
    ...(actor.externalClient === true ? { externalClient: true as const } : {}),
  };
}

/** Whom a read is checked for: an agent run's project or an external AI client on `/mcp`; `undefined` for a person. */
function readerOf(actor: AuthenticatedActor): DatabaseReader | undefined {
  return readerOfWriter(writerIdentityOf(actor));
}

/**
 * The reader for paths only an external client is checked on: counts, facets, property/view/page
 * operations and database schema writes. A run credential's project is deliberately not a reader
 * there. `undefined` for an agent and for a person.
 */
function externalClientReaderOf(actor: AuthenticatedActor): DatabaseReader | undefined {
  const reader = readerOf(actor);
  return typeof reader === "object" ? reader : undefined;
}

/** The writer id the choke point's hooks may trust as human: only a REST session actor that is not acting for an agent. */
function humanWriterUserIdOf(actor: AuthenticatedActor): string | undefined {
  return actor.restSession === true && actor.agentProjectItemId === undefined ? actor.userId : undefined;
}
