import type { AuthenticatedActor } from "./actor.js";
import type { GenericOperationName } from "./operationNames.js";
import type { InputByOperation } from "./schemas.js";
import type { Database, Item, ItemPage, Page, Property, RelationEdge, View, ViewItem } from "./rows.js";

/** Exhaustive mapped type over the 28 literal operation names — see the `_assertOutputByOperationExhaustive` check below. */
export interface OutputByOperation {
  "database.list": Page<Database>;
  "database.get": Database;
  "database.create": Database;
  "database.patch": Database;
  "database.archive": Database;
  "database.restore": Database;
  "property.list": Property[];
  "property.get": Property;
  "property.create": Property;
  "property.patch": Property;
  "property.delete": Property;
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
  "item.patch": Item;
  "item.delete": Item;
  "item.restore": Item;
  "database.query": ItemPage;
  "relation.put": RelationEdge;
  "relation.delete": RelationEdge;
}

type AssertSameKeys<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const _assertOutputByOperationExhaustive: AssertSameKeys<keyof OutputByOperation, GenericOperationName> = true;
void _assertOutputByOperationExhaustive;

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
  createProperty(
    actor: AuthenticatedActor,
    input: InputByOperation["property.create"],
  ): Promise<OutputByOperation["property.create"]>;
  patchProperty(
    actor: AuthenticatedActor,
    input: InputByOperation["property.patch"],
  ): Promise<OutputByOperation["property.patch"]>;
  deleteProperty(
    actor: AuthenticatedActor,
    input: InputByOperation["property.delete"],
  ): Promise<OutputByOperation["property.delete"]>;
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
  putRelation(
    actor: AuthenticatedActor,
    input: InputByOperation["relation.put"],
  ): Promise<OutputByOperation["relation.put"]>;
  deleteRelation(
    actor: AuthenticatedActor,
    input: InputByOperation["relation.delete"],
  ): Promise<OutputByOperation["relation.delete"]>;
}
