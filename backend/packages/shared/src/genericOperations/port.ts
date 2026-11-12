import type { AuthenticatedActor } from "./actor.js";
import type { GenericOperationName } from "./operationNames.js";
import type { InputByOperation, ItemPatchOutput } from "./schemas.js";
import type {
  Database,
  Item,
  ItemCountEntry,
  ItemPage,
  ItemLink,
  Page,
  PageRestoreOutput,
  Property,
  RelationEdge,
  RelationListEntry,
  View,
  ViewItem,
} from "./rows.js";

/** Exhaustive mapped type over the 44 literal operation names — see the `_assertOutputByOperationExhaustive` check below. */
export interface OutputByOperation {
  "database.list": Page<Database>;
  "database.get": Database;
  "database.create": Database;
  "database.patch": Database;
  "database.archive": Database;
  "database.restore": Database;
  "property.list": Property[];
  "property.get": Property;
  /**
   * Every property in `databaseId` whose key is `key` (and whose type is `type`, when given) —
   * returned as a list rather than one row so a caller can tell no match, exactly one, and an
   * ambiguous match apart itself.
   */
  "property.getByKey": Property[];
  "property.create": Property;
  "property.patch": Property;
  "property.delete": Property;
  "property.option.add": PropertyOption;
  "property.option.update": PropertyOption;
  "view.list": Page<View>;
  "view.get": View;
  "view.create": View;
  "view.patch": View;
  "view.delete": View;
  "view.query": ItemPage;
  "viewItem.add": ViewItem;
  "viewItem.remove": { deleted: true; viewId: string; itemId: string };
  "viewItem.reorder": ViewItem;
  "item.get": Item;
  "item.create": Item;
  "item.patch": ItemPatchOutput;
  "item.delete": Item;
  "item.restore": Item;
  "database.query": ItemPage;
  "relation.put": RelationEdge;
  "relation.set": RelationEdge | null;
  "relation.delete": RelationEdge;
  "relation.list": RelationListEntry[];
  "page.restoreVersion": PageRestoreOutput;
  "link.unlink": { itemId: string; propertyKey: string } & ItemLink;
  "link.relink": { itemId: string; propertyKey: string } & ItemLink;
  "page.get": PageSummary | PageMarkdown;
  "page.ensure": { docId: string };
  "page.createSubpage": PageCreateSubpageOutput;
  "page.insert": { blockIds: string[] };
  "page.changes": PageChangeEntry[];
  /** One entry per input entry, in input order. */
  "item.count": ItemCountEntry[];
  "page.duplicate": PageDuplicateOutput;
  "page.rename": PageRenameOutput;
}

/**
 * One option of a `select` or `multi_select` property as `property.option.add` and `property.option.update` return
 * it (issue #1699). `label` is the option's stored label, or for an option without one its label in the caller's
 * locale from the owning module's catalog, or the raw key the schema projection falls back to when the option has
 * neither.
 */
export interface PropertyOption {
  key: string;
  label: string;
  color?: string;
}

/** One change a stored update made to the blocks of a page (issue #1680), as `page.changes` lists it. */
export interface PageChangeEntry {
  /** When the update was stored (ISO 8601). */
  at: string;
  /** The blocks the change touched, in document order (a deleted block in the order it had before the update). */
  blockIds: string[];
  kind: "insert" | "update" | "delete";
}

/** The pages one `page.createSubpage` call created; one element per page (issue #2013 returns several). */
export interface PageCreateSubpageOutput {
  pages: Array<{ pageItemId: string; docId: string; blockId: string }>;
}

/** The root of the copy one `page.duplicate` call made: its Pages item, its document and its `page` block in the parent. */
export interface PageDuplicateOutput {
  pageItemId: string;
  docId: string;
  blockId: string;
}

/** The subpage one `page.rename` call named and its title as stored: the requested title after normalization. */
export interface PageRenameOutput {
  pageItemId: string;
  title: string;
}

/** `page.get` with `format: "markdown"` (issue #1678): the page body as canonical Markdown plus its version token. */
export interface PageMarkdown {
  docId: string | null;
  kind: "page";
  markdown: string;
  etag: string;
}

export interface PageSummary {
  docId: string | null;
  kind: "page";
  title: string;
  blocks: Array<{ id: string; type: string; indent: number; done: boolean; text: string; pageId?: string }>;
  blockCount: number;
  subpageCount: number;
  headings: Array<{ id: string; type: string; text: string }>;
  lastEditedAt: string | null;
  lastEditedBy: "user" | "ai_agent" | "system" | null;
  breadcrumbs: Array<{
    itemId: string;
    title: string;
    databaseKey: string | null;
    journal?: { type: string; period: string };
  }> | null;
}

type AssertSameKeys<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const _assertOutputByOperationExhaustive: AssertSameKeys<keyof OutputByOperation, GenericOperationName> = true;
void _assertOutputByOperationExhaustive;

/** Batched automation projection used by the application read facade. */
export interface ItemAutomationReadPort {
  readAutomationForItems(itemIds: string[]): Promise<Map<string, NonNullable<Item["automation"]>>>;
}

/**
 * The one transport-independent port every generic-operation binding calls through (issue
 * #252). `packages/application` provides the sole neutral implementation (#219); the REST,
 * AgentTool, and MCP composition roots each inject that same implementation rather than
 * implementing this port themselves (#219/#220). Argument order is fixed: every method takes
 * `(actor, input)`, in that order, matching how `GENERIC_OPERATION_BINDINGS` in `bindings.ts`
 * invokes it — `service[method](actor, input)`, never the reverse.
 */
export interface GenericApplicationPort {
  listDatabases(
    actor: AuthenticatedActor,
    input: InputByOperation["database.list"],
  ): Promise<OutputByOperation["database.list"]>;
  getDatabase(
    actor: AuthenticatedActor,
    input: InputByOperation["database.get"],
  ): Promise<OutputByOperation["database.get"]>;
  createDatabase(
    actor: AuthenticatedActor,
    input: InputByOperation["database.create"],
  ): Promise<OutputByOperation["database.create"]>;
  patchDatabase(
    actor: AuthenticatedActor,
    input: InputByOperation["database.patch"],
  ): Promise<OutputByOperation["database.patch"]>;
  archiveDatabase(
    actor: AuthenticatedActor,
    input: InputByOperation["database.archive"],
  ): Promise<OutputByOperation["database.archive"]>;
  restoreDatabase(
    actor: AuthenticatedActor,
    input: InputByOperation["database.restore"],
  ): Promise<OutputByOperation["database.restore"]>;
  listProperties(
    actor: AuthenticatedActor,
    input: InputByOperation["property.list"],
  ): Promise<OutputByOperation["property.list"]>;
  getProperty(
    actor: AuthenticatedActor,
    input: InputByOperation["property.get"],
  ): Promise<OutputByOperation["property.get"]>;
  getPropertyByKey(
    actor: AuthenticatedActor,
    input: InputByOperation["property.getByKey"],
  ): Promise<OutputByOperation["property.getByKey"]>;
  createProperty(
    actor: AuthenticatedActor,
    input: InputByOperation["property.create"],
  ): Promise<OutputByOperation["property.create"]>;
  patchProperty(
    actor: AuthenticatedActor,
    input: InputByOperation["property.patch"],
  ): Promise<OutputByOperation["property.patch"]>;
  /**
   * REST-only extension of `patchProperty` (issue #789): the property's owning `Database`, read
   * inside the same transaction the patch itself commits in, so `PATCH /api/properties/:id` can
   * resolve catalog/locale without a second, independently-committed `database.get` call after
   * the patch. Not one of the 44 catalog operations — `OutputByOperation["property.patch"]` (the
   * shape every MCP/AgentTool `property.patch` call returns) is untouched by this. Only
   * `services/semprec-api`'s REST handler may call this directly; `mcpHandler.ts` and the
   * AgentTool composition root never call a catalog-external port method. See
   * `docs/adr/2026-10-01-rest-only-port-extension-methods.md` for the full set of constraints
   * this pattern must satisfy.
   */
  patchPropertyWithDatabase(
    actor: AuthenticatedActor,
    input: InputByOperation["property.patch"],
  ): Promise<{ property: Property; database: Database }>;
  deleteProperty(
    actor: AuthenticatedActor,
    input: InputByOperation["property.delete"],
  ): Promise<OutputByOperation["property.delete"]>;
  addPropertyOption(
    actor: AuthenticatedActor,
    input: InputByOperation["property.option.add"],
  ): Promise<OutputByOperation["property.option.add"]>;
  updatePropertyOption(
    actor: AuthenticatedActor,
    input: InputByOperation["property.option.update"],
  ): Promise<OutputByOperation["property.option.update"]>;
  listViews(actor: AuthenticatedActor, input: InputByOperation["view.list"]): Promise<OutputByOperation["view.list"]>;
  getView(actor: AuthenticatedActor, input: InputByOperation["view.get"]): Promise<OutputByOperation["view.get"]>;
  createView(
    actor: AuthenticatedActor,
    input: InputByOperation["view.create"],
  ): Promise<OutputByOperation["view.create"]>;
  patchView(actor: AuthenticatedActor, input: InputByOperation["view.patch"]): Promise<OutputByOperation["view.patch"]>;
  deleteView(
    actor: AuthenticatedActor,
    input: InputByOperation["view.delete"],
  ): Promise<OutputByOperation["view.delete"]>;
  queryView(actor: AuthenticatedActor, input: InputByOperation["view.query"]): Promise<OutputByOperation["view.query"]>;
  addViewItem(
    actor: AuthenticatedActor,
    input: InputByOperation["viewItem.add"],
  ): Promise<OutputByOperation["viewItem.add"]>;
  removeViewItem(
    actor: AuthenticatedActor,
    input: InputByOperation["viewItem.remove"],
  ): Promise<OutputByOperation["viewItem.remove"]>;
  reorderViewItem(
    actor: AuthenticatedActor,
    input: InputByOperation["viewItem.reorder"],
  ): Promise<OutputByOperation["viewItem.reorder"]>;
  getItem(actor: AuthenticatedActor, input: InputByOperation["item.get"]): Promise<OutputByOperation["item.get"]>;
  createItem(
    actor: AuthenticatedActor,
    input: InputByOperation["item.create"],
  ): Promise<OutputByOperation["item.create"]>;
  patchItem(actor: AuthenticatedActor, input: InputByOperation["item.patch"]): Promise<OutputByOperation["item.patch"]>;
  deleteItem(
    actor: AuthenticatedActor,
    input: InputByOperation["item.delete"],
  ): Promise<OutputByOperation["item.delete"]>;
  restoreItem(
    actor: AuthenticatedActor,
    input: InputByOperation["item.restore"],
  ): Promise<OutputByOperation["item.restore"]>;
  queryDatabase(
    actor: AuthenticatedActor,
    input: InputByOperation["database.query"],
  ): Promise<OutputByOperation["database.query"]>;
  setRelation(
    actor: AuthenticatedActor,
    input: InputByOperation["relation.set"],
  ): Promise<OutputByOperation["relation.set"]>;

  putRelation(
    actor: AuthenticatedActor,
    input: InputByOperation["relation.put"],
  ): Promise<OutputByOperation["relation.put"]>;
  deleteRelation(
    actor: AuthenticatedActor,
    input: InputByOperation["relation.delete"],
  ): Promise<OutputByOperation["relation.delete"]>;
  listRelations(
    actor: AuthenticatedActor,
    input: InputByOperation["relation.list"],
  ): Promise<OutputByOperation["relation.list"]>;
  unlinkValue(
    actor: AuthenticatedActor,
    input: InputByOperation["link.unlink"],
  ): Promise<OutputByOperation["link.unlink"]>;
  relinkValue(
    actor: AuthenticatedActor,
    input: InputByOperation["link.relink"],
  ): Promise<OutputByOperation["link.relink"]>;
  ensurePage(
    actor: AuthenticatedActor,
    input: InputByOperation["page.ensure"],
  ): Promise<OutputByOperation["page.ensure"]>;
  getPage(actor: AuthenticatedActor, input: InputByOperation["page.get"]): Promise<OutputByOperation["page.get"]>;
  createSubpage(
    actor: AuthenticatedActor,
    input: InputByOperation["page.createSubpage"],
  ): Promise<OutputByOperation["page.createSubpage"]>;
  insertPage(
    actor: AuthenticatedActor,
    input: InputByOperation["page.insert"],
  ): Promise<OutputByOperation["page.insert"]>;
  listPageChanges(
    actor: AuthenticatedActor,
    input: InputByOperation["page.changes"],
  ): Promise<OutputByOperation["page.changes"]>;
  duplicatePage(
    actor: AuthenticatedActor,
    input: InputByOperation["page.duplicate"],
  ): Promise<OutputByOperation["page.duplicate"]>;
  renamePage(
    actor: AuthenticatedActor,
    input: InputByOperation["page.rename"],
  ): Promise<OutputByOperation["page.rename"]>;
  restorePageVersion(
    actor: AuthenticatedActor,
    input: InputByOperation["page.restoreVersion"],
  ): Promise<OutputByOperation["page.restoreVersion"]>;
  countItems(
    actor: AuthenticatedActor,
    input: InputByOperation["item.count"],
  ): Promise<OutputByOperation["item.count"]>;
}
