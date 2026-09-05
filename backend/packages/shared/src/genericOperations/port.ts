import type { GenericOperationName } from "./catalog.js";
import type { AuthenticatedActor } from "./actor.js";
import type {
  Database,
  Item,
  ItemPage,
  Page,
  Property,
  PropertyDeleted,
  RelationDeleted,
  RelationEdge,
  View,
  ViewDeleted,
  ViewItem,
  ViewItemDeleted,
} from "./results.js";
import type {
  DatabaseArchiveInput,
  DatabaseCreateInput,
  DatabaseGetInput,
  DatabaseListInput,
  DatabasePatchInput,
  DatabaseQueryInput,
  DatabaseRestoreInput,
  ItemCreateInput,
  ItemDeleteInput,
  ItemGetInput,
  ItemPatchInput,
  ItemRestoreInput,
  PropertyCreateInput,
  PropertyDeleteInput,
  PropertyGetInput,
  PropertyListInput,
  PropertyPatchInput,
  RelationDeleteInput,
  RelationPutInput,
  ViewCreateInput,
  ViewDeleteInput,
  ViewGetInput,
  ViewItemAddInput,
  ViewItemRemoveInput,
  ViewItemReorderInput,
  ViewListInput,
  ViewPatchInput,
  ViewQueryInput,
} from "./schemas.js";

/** The input each operation's named schema parses to. */
export interface InputByOperation {
  "database.list": DatabaseListInput;
  "database.get": DatabaseGetInput;
  "database.create": DatabaseCreateInput;
  "database.patch": DatabasePatchInput;
  "database.archive": DatabaseArchiveInput;
  "database.restore": DatabaseRestoreInput;
  "database.query": DatabaseQueryInput;
  "property.list": PropertyListInput;
  "property.get": PropertyGetInput;
  "property.create": PropertyCreateInput;
  "property.patch": PropertyPatchInput;
  "property.delete": PropertyDeleteInput;
  "view.list": ViewListInput;
  "view.get": ViewGetInput;
  "view.create": ViewCreateInput;
  "view.patch": ViewPatchInput;
  "view.delete": ViewDeleteInput;
  "view.query": ViewQueryInput;
  "viewItem.add": ViewItemAddInput;
  "viewItem.remove": ViewItemRemoveInput;
  "viewItem.reorder": ViewItemReorderInput;
  "item.get": ItemGetInput;
  "item.create": ItemCreateInput;
  "item.patch": ItemPatchInput;
  "item.delete": ItemDeleteInput;
  "item.restore": ItemRestoreInput;
  "relation.put": RelationPutInput;
  "relation.delete": RelationDeleteInput;
}

/** The authoritative result each operation resolves to. */
export interface OutputByOperation {
  "database.list": Page<Database>;
  "database.get": Database;
  "database.create": Database;
  "database.patch": Database;
  "database.archive": Database;
  "database.restore": Database;
  "database.query": ItemPage;
  "property.list": Property[];
  "property.get": Property;
  "property.create": Property;
  "property.patch": Property;
  "property.delete": PropertyDeleted;
  "view.list": Page<View>;
  "view.get": View;
  "view.create": View;
  "view.patch": View;
  "view.delete": ViewDeleted;
  "view.query": ItemPage;
  "viewItem.add": ViewItem;
  "viewItem.remove": ViewItemDeleted;
  "viewItem.reorder": ViewItem;
  "item.get": Item;
  "item.create": Item;
  "item.patch": Item;
  "item.delete": Item;
  "item.restore": Item;
  "relation.put": RelationEdge;
  "relation.delete": RelationDeleted;
}

/** The port method each operation is bound to. */
export const OPERATION_METHODS = {
  "database.list": "listDatabases",
  "database.get": "getDatabase",
  "database.create": "createDatabase",
  "database.patch": "patchDatabase",
  "database.archive": "archiveDatabase",
  "database.restore": "restoreDatabase",
  "database.query": "queryDatabase",
  "property.list": "listProperties",
  "property.get": "getProperty",
  "property.create": "createProperty",
  "property.patch": "patchProperty",
  "property.delete": "deleteProperty",
  "view.list": "listViews",
  "view.get": "getView",
  "view.create": "createView",
  "view.patch": "patchView",
  "view.delete": "deleteView",
  "view.query": "queryView",
  "viewItem.add": "addViewItem",
  "viewItem.remove": "removeViewItem",
  "viewItem.reorder": "reorderViewItem",
  "item.get": "getItem",
  "item.create": "createItem",
  "item.patch": "patchItem",
  "item.delete": "deleteItem",
  "item.restore": "restoreItem",
  "relation.put": "putRelation",
  "relation.delete": "deleteRelation",
} as const satisfies Record<GenericOperationName, string>;

export type MethodByOperation = typeof OPERATION_METHODS;
export type OperationMethodName = MethodByOperation[GenericOperationName];

/**
 * The transport-independent application port every generic operation runs through. It is
 * derived from the three mappings above, so there is no argument-order freedom: each method
 * takes `(actor, input)` in that order and resolves the operation's declared result. The port
 * imports no service package — #219 supplies the single implementation in
 * `packages/application`, and the API/AgentTool/MCP composition roots inject it.
 */
export type GenericApplicationPort = {
  [K in GenericOperationName as MethodByOperation[K]]: (
    actor: AuthenticatedActor,
    input: InputByOperation[K],
  ) => Promise<OutputByOperation[K]>;
};
