import { expect, it } from "vitest";
import type { AuthenticatedActor } from "../actor.js";
import type { GenericOperationName } from "../catalog.js";
import { GENERIC_OPERATION_NAMES } from "../catalog.js";
import { GENERIC_OPERATION_BINDINGS } from "../bindings.js";
import type { GenericApplicationPort, InputByOperation, MethodByOperation, OperationMethodName, OutputByOperation } from "../port.js";
import type { DatabaseListInput, ItemPatchInput, PropertyListInput, RelationDeleteInput, RelationPutInput, ViewQueryInput } from "../schemas.js";
import type { Database, Item, ItemPage, Page, Property, PropertyDeleted, RelationDeleted, RelationEdge, View, ViewDeleted, ViewItem, ViewItemDeleted } from "../results.js";

/**
 * Type-level assertions: they hold or `tsc -p packages/shared` fails, which is what proves the
 * port has no argument-order freedom and no operation is missing from any of the mapped types.
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/** Every mapped type covers exactly the 28 literal operation names. */
type _InputsExhaustive = Expect<Equals<keyof InputByOperation, GenericOperationName>>;
type _OutputsExhaustive = Expect<Equals<keyof OutputByOperation, GenericOperationName>>;
type _MethodsExhaustive = Expect<Equals<keyof MethodByOperation, GenericOperationName>>;
type _PortExhaustive = Expect<Equals<keyof GenericApplicationPort, OperationMethodName>>;
type _BindingsExhaustive = Expect<Equals<keyof typeof GENERIC_OPERATION_BINDINGS, GenericOperationName>>;

/** Every port method takes `(actor, input)` in that order and resolves that operation's result. */
type ArgumentOrder = { [K in GenericOperationName]: Equals<Parameters<GenericApplicationPort[MethodByOperation[K]]>, [AuthenticatedActor, InputByOperation[K]]> }[GenericOperationName];
type ResultContract = { [K in GenericOperationName]: Equals<ReturnType<GenericApplicationPort[MethodByOperation[K]]>, Promise<OutputByOperation[K]>> }[GenericOperationName];
type _ArgumentOrder = Expect<Equals<ArgumentOrder, true>>;
type _ResultContract = Expect<Equals<ResultContract, true>>;

/** The result contracts of the table, spelled out per row. */
type _Results = [
  Expect<Equals<OutputByOperation["database.list"], Page<Database>>>,
  Expect<Equals<OutputByOperation["database.get"], Database>>,
  Expect<Equals<OutputByOperation["database.create"], Database>>,
  Expect<Equals<OutputByOperation["database.patch"], Database>>,
  Expect<Equals<OutputByOperation["database.archive"], Database>>,
  Expect<Equals<OutputByOperation["database.restore"], Database>>,
  Expect<Equals<OutputByOperation["database.query"], ItemPage>>,
  Expect<Equals<OutputByOperation["property.list"], Property[]>>,
  Expect<Equals<OutputByOperation["property.get"], Property>>,
  Expect<Equals<OutputByOperation["property.create"], Property>>,
  Expect<Equals<OutputByOperation["property.patch"], Property>>,
  Expect<Equals<OutputByOperation["property.delete"], PropertyDeleted>>,
  Expect<Equals<OutputByOperation["view.list"], Page<View>>>,
  Expect<Equals<OutputByOperation["view.get"], View>>,
  Expect<Equals<OutputByOperation["view.create"], View>>,
  Expect<Equals<OutputByOperation["view.patch"], View>>,
  Expect<Equals<OutputByOperation["view.delete"], ViewDeleted>>,
  Expect<Equals<OutputByOperation["view.query"], ItemPage>>,
  Expect<Equals<OutputByOperation["viewItem.add"], ViewItem>>,
  Expect<Equals<OutputByOperation["viewItem.remove"], ViewItemDeleted>>,
  Expect<Equals<OutputByOperation["viewItem.reorder"], ViewItem>>,
  Expect<Equals<OutputByOperation["item.get"], Item>>,
  Expect<Equals<OutputByOperation["item.create"], Item>>,
  Expect<Equals<OutputByOperation["item.patch"], Item>>,
  Expect<Equals<OutputByOperation["item.delete"], Item>>,
  Expect<Equals<OutputByOperation["item.restore"], Item>>,
  Expect<Equals<OutputByOperation["relation.put"], RelationEdge>>,
  Expect<Equals<OutputByOperation["relation.delete"], RelationDeleted>>,
];

/** `Item` is fixed to the single row envelope; the delete wrappers are exactly the adapter results. */
type _ItemEnvelope = Expect<
  Equals<keyof Item, "id" | "databaseId" | "properties" | "computed" | "updatedAt" | "deletedAt">
>;
type _DeleteWrappers = [
  Expect<Equals<PropertyDeleted, { deleted: true; propertyId: string }>>,
  Expect<Equals<ViewDeleted, { deleted: true; viewId: string }>>,
  Expect<Equals<ViewItemDeleted, { deleted: true; viewId: string; itemId: string }>>,
  Expect<Equals<RelationDeleted, { deleted: true; relationPropertyId: string; callerItemId: string; targetItemId: string }>>,
];

/** Spelled-out signatures, independent of the mapped types the port is derived from. */
type _Signatures = [
  Expect<Equals<GenericApplicationPort["listDatabases"], (actor: AuthenticatedActor, input: DatabaseListInput) => Promise<Page<Database>>>>,
  Expect<Equals<GenericApplicationPort["listProperties"], (actor: AuthenticatedActor, input: PropertyListInput) => Promise<Property[]>>>,
  Expect<Equals<GenericApplicationPort["patchItem"], (actor: AuthenticatedActor, input: ItemPatchInput) => Promise<Item>>>,
  Expect<Equals<GenericApplicationPort["queryView"], (actor: AuthenticatedActor, input: ViewQueryInput) => Promise<ItemPage>>>,
  Expect<Equals<GenericApplicationPort["putRelation"], (actor: AuthenticatedActor, input: RelationPutInput) => Promise<RelationEdge>>>,
  Expect<Equals<GenericApplicationPort["deleteRelation"], (actor: AuthenticatedActor, input: RelationDeleteInput) => Promise<RelationDeleted>>>,
];

/** The actor is the first argument of every method and is never part of an input. */
type _ActorShape = Expect<Equals<AuthenticatedActor, { userId: string; runId?: string; agentProjectItemId?: string }>>;
type _NoActorInInputs = Expect<
  Equals<
    {
      [K in GenericOperationName]: [Extract<keyof InputByOperation[K], "actor" | "userId" | "agentProjectItemId" | "runId">] extends [never] ? true : false;
    }[GenericOperationName],
    true
  >
>;

it("keeps the type-level port assertions above compiled against the catalog", () => {
  expect(GENERIC_OPERATION_NAMES).toHaveLength(Object.keys(GENERIC_OPERATION_BINDINGS).length);
});
