import type { AuthenticatedActor } from "./actor.js";
import type { GenericOperationName } from "./operationNames.js";
import type { InputByOperation, ItemPatchOutput, SearchOutput } from "./schemas.js";
import type {
  Database,
  DatabaseFacet,
  Item,
  ItemCountEntry,
  ItemPage,
  ItemLink,
  Page,
  PageRestoreOutput,
  Property,
  RelationEdge,
  RelatedCollection,
  RelationListEntry,
  View,
  ViewItem,
} from "./rows.js";

/** Mapped type over every operation name; exhaustiveness is checked by `_assertOutputByOperationExhaustive` below. */
export interface OutputByOperation {
  "database.list": Page<Database>;
  "database.get": Database;
  "database.create": Database;
  "database.patch": Database;
  "database.archive": Database;
  "database.restore": Database;
  "property.list": Property[];
  "property.get": Property;
  /** A list, so the caller can tell no match, one match and an ambiguous match apart. */
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
  "relation.related": RelatedCollection[];
  "page.restoreVersion": PageRestoreOutput;
  "link.unlink": { itemId: string; propertyKey: string } & ItemLink;
  "link.relink": { itemId: string; propertyKey: string } & ItemLink;
  "page.get": PageSummary | PageMarkdown;
  "page.ensure": { docId: string };
  "page.ensureJournalPeriod": PageEnsureJournalPeriodOutput;
  "page.mergeJournalDuplicates": PageMergeJournalDuplicatesOutput;
  "page.createSubpage": PageCreateSubpageOutput;
  "page.insert": { blockIds: string[] };
  "page.replace": PageReplaceOutput;
  "page.changes": PageChangeEntry[];
  /** One entry per input entry, in input order. */
  "item.count": ItemCountEntry[];
  "page.duplicate": PageDuplicateOutput;
  "page.rename": PageRenameOutput;
  "page.convertToBlock": PageConvertToBlockOutput;
  /** One entry per requested facet, in request order. */
  "database.facets": DatabaseFacet[];
  /** Grouped by type in the fixed order of `SEARCH_GROUP_TYPES`. */
  search: SearchOutput;
}

/** `label` is the stored label, else the owning module's catalog label in the caller's locale, else the raw key. */
export interface PropertyOption {
  key: string;
  label: string;
  color?: string;
}

/** One change a stored update made to a page's blocks, as `page.changes` lists it. */
export interface PageChangeEntry {
  at: string;
  /** In document order; a deleted block in the order it had before the update. */
  blockIds: string[];
  kind: "insert" | "update" | "delete";
}

/** The canonical period key and its first and last day (`YYYY-MM-DD`, inclusive). */
export interface PageEnsureJournalPeriodOutput {
  itemId: string;
  docId: string;
  period: string;
  range: { from: string; to: string };
}

/**
 * The surviving entry and the one merged into it and trashed, or `{ merged: false }` when there were not two live
 * entries.
 */
export type PageMergeJournalDuplicatesOutput = { survivorId: string; mergedItemId: string } | { merged: false };

/** One element per created page. */
export interface PageCreateSubpageOutput {
  pages: Array<{ pageItemId: string; docId: string; blockId: string }>;
}

/** The root of the copy one `page.duplicate` call made: its Pages item, its document and its `page` block in the parent. */
export interface PageDuplicateOutput {
  pageItemId: string;
  docId: string;
  blockId: string;
}

/** The stored title is the requested one after normalization. */
export interface PageRenameOutput {
  pageItemId: string;
  title: string;
}

/** The new block standing where the `page` block stood, and how many pages (itself included) went to the Trash. */
export interface PageConvertToBlockOutput {
  blockId: string;
  trashedPageCount: number;
}

/**
 * The new version token and the subpages trashed because the Markdown no longer links them, each with its link's title,
 * so a client can offer to restore them.
 */
export interface PageReplaceOutput {
  etag: string;
  trashedPages: Array<{ pageItemId: string; title: string }>;
}

/** `page.get` with `format: "markdown"`: canonical Markdown plus the version token. */
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
  blocks: Array<{
    id: string;
    type: string;
    indent: number;
    done: boolean;
    /** A toggle heading; false on every type but `h1`-`h3`. */
    toggle: boolean;
    text: string;
    pageId?: string;
  }>;
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
    /** An ancestor in a database the agent's project may not read: only its id, no title and no database key. */
    hidden?: true;
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
 * The one transport-independent port every generic-operation binding calls through. `packages/application` provides the
 * sole implementation, injected by the REST, AgentTool and MCP composition roots. Every method takes `(actor, input)`
 * in that order, as `GENERIC_OPERATION_BINDINGS` invokes it.
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
   * REST-only extension of `patchProperty`: also returns the owning `Database`, read in the patch's transaction, so
   * `PATCH /api/properties/:id` needs no second, separately committed read. Not a catalog operation; MCP and AgentTool
   * never call it (docs/architecture/edges-io-and-errors.md#application-port).
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
  listRelatedCollections(
    actor: AuthenticatedActor,
    input: InputByOperation["relation.related"],
  ): Promise<OutputByOperation["relation.related"]>;
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
  ensureJournalPeriod(
    actor: AuthenticatedActor,
    input: InputByOperation["page.ensureJournalPeriod"],
  ): Promise<OutputByOperation["page.ensureJournalPeriod"]>;
  mergeJournalDuplicates(
    actor: AuthenticatedActor,
    input: InputByOperation["page.mergeJournalDuplicates"],
  ): Promise<OutputByOperation["page.mergeJournalDuplicates"]>;
  getPage(actor: AuthenticatedActor, input: InputByOperation["page.get"]): Promise<OutputByOperation["page.get"]>;
  createSubpage(
    actor: AuthenticatedActor,
    input: InputByOperation["page.createSubpage"],
  ): Promise<OutputByOperation["page.createSubpage"]>;
  insertPage(
    actor: AuthenticatedActor,
    input: InputByOperation["page.insert"],
  ): Promise<OutputByOperation["page.insert"]>;
  replacePage(
    actor: AuthenticatedActor,
    input: InputByOperation["page.replace"],
  ): Promise<OutputByOperation["page.replace"]>;
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
  convertPageToBlock(
    actor: AuthenticatedActor,
    input: InputByOperation["page.convertToBlock"],
  ): Promise<OutputByOperation["page.convertToBlock"]>;
  restorePageVersion(
    actor: AuthenticatedActor,
    input: InputByOperation["page.restoreVersion"],
  ): Promise<OutputByOperation["page.restoreVersion"]>;
  countItems(
    actor: AuthenticatedActor,
    input: InputByOperation["item.count"],
  ): Promise<OutputByOperation["item.count"]>;
  getDatabaseFacets(
    actor: AuthenticatedActor,
    input: InputByOperation["database.facets"],
  ): Promise<OutputByOperation["database.facets"]>;
  searchItems(actor: AuthenticatedActor, input: InputByOperation["search"]): Promise<OutputByOperation["search"]>;
}
