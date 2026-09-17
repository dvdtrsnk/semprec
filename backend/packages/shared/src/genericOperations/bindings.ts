import type { z } from "zod";
import type { AuthenticatedActor } from "./actor.js";
import type { GenericApplicationPort, OutputByOperation } from "./port.js";
import type { GenericOperationName } from "./operationNames.js";
import type { InputByOperation } from "./schemas.js";
import {
  DatabaseArchiveInputSchema,
  DatabaseCreateInputSchema,
  DatabaseGetInputSchema,
  DatabaseListInputSchema,
  DatabasePatchInputSchema,
  DatabaseQueryInputSchema,
  DatabaseRestoreInputSchema,
  ItemCreateInputSchema,
  ItemDeleteInputSchema,
  ItemGetInputSchema,
  ItemPatchInputSchema,
  ItemRestoreInputSchema,
  PropertyCreateInputSchema,
  PropertyDeleteInputSchema,
  PropertyGetInputSchema,
  PropertyListInputSchema,
  PropertyPatchInputSchema,
  RelationDeleteInputSchema,
  RelationPutInputSchema,
  ViewCreateInputSchema,
  ViewDeleteInputSchema,
  ViewGetInputSchema,
  ViewItemAddInputSchema,
  ViewItemRemoveInputSchema,
  ViewItemReorderInputSchema,
  ViewListInputSchema,
  ViewPatchInputSchema,
  ViewQueryInputSchema,
} from "./schemas.js";

/**
 * One binding per operation (issue #252): the strict input schema that validates a raw payload
 * into `I`, plus `invoke`, which always calls the injected port's named method as
 * `service[method](actor, input)` — never a different argument order, never a different method.
 * `OperationBinding` itself depends only on `GenericApplicationPort`; the REST composition root
 * injects the REST implementation (#219), the AgentTool/MCP composition roots inject theirs
 * (#220) — this file never imports an implementation.
 */
export interface OperationBinding<I, O> {
  input: z.ZodType<I>;
  invoke(service: GenericApplicationPort, actor: AuthenticatedActor, input: I): Promise<O>;
}

/** Exhaustive over the 28 literal operation names — see the direct-literal-assignment note on `GENERIC_OPERATION_BINDINGS` below. */
export type GenericOperationBindings = {
  [K in GenericOperationName]: OperationBinding<InputByOperation[K], OutputByOperation[K]>;
};

/**
 * The canonical binding table. Assigning this object literal directly to `GenericOperationBindings`
 * (rather than through an intermediate variable) is what makes both a missing operation and an
 * extra/misspelled one a compile error: TypeScript excess-property-checks a fresh object literal
 * against its target type in both directions.
 */
export const GENERIC_OPERATION_BINDINGS: GenericOperationBindings = {
  "database.list": {
    input: DatabaseListInputSchema,
    invoke: (service, actor, input) => service.listDatabases(actor, input),
  },
  "database.get": {
    input: DatabaseGetInputSchema,
    invoke: (service, actor, input) => service.getDatabase(actor, input),
  },
  "database.create": {
    input: DatabaseCreateInputSchema,
    invoke: (service, actor, input) => service.createDatabase(actor, input),
  },
  "database.patch": {
    input: DatabasePatchInputSchema,
    invoke: (service, actor, input) => service.patchDatabase(actor, input),
  },
  "database.archive": {
    input: DatabaseArchiveInputSchema,
    invoke: (service, actor, input) => service.archiveDatabase(actor, input),
  },
  "database.restore": {
    input: DatabaseRestoreInputSchema,
    invoke: (service, actor, input) => service.restoreDatabase(actor, input),
  },
  "property.list": {
    input: PropertyListInputSchema,
    invoke: (service, actor, input) => service.listProperties(actor, input),
  },
  "property.get": {
    input: PropertyGetInputSchema,
    invoke: (service, actor, input) => service.getProperty(actor, input),
  },
  "property.create": {
    input: PropertyCreateInputSchema,
    invoke: (service, actor, input) => service.createProperty(actor, input),
  },
  "property.patch": {
    input: PropertyPatchInputSchema,
    invoke: (service, actor, input) => service.patchProperty(actor, input),
  },
  "property.delete": {
    input: PropertyDeleteInputSchema,
    invoke: (service, actor, input) => service.deleteProperty(actor, input),
  },
  "view.list": {
    input: ViewListInputSchema,
    invoke: (service, actor, input) => service.listViews(actor, input),
  },
  "view.get": {
    input: ViewGetInputSchema,
    invoke: (service, actor, input) => service.getView(actor, input),
  },
  "view.create": {
    input: ViewCreateInputSchema,
    invoke: (service, actor, input) => service.createView(actor, input),
  },
  "view.patch": {
    input: ViewPatchInputSchema,
    invoke: (service, actor, input) => service.patchView(actor, input),
  },
  "view.delete": {
    input: ViewDeleteInputSchema,
    invoke: (service, actor, input) => service.deleteView(actor, input),
  },
  "view.query": {
    input: ViewQueryInputSchema,
    invoke: (service, actor, input) => service.queryView(actor, input),
  },
  "viewItem.add": {
    input: ViewItemAddInputSchema,
    invoke: (service, actor, input) => service.addViewItem(actor, input),
  },
  "viewItem.remove": {
    input: ViewItemRemoveInputSchema,
    invoke: (service, actor, input) => service.removeViewItem(actor, input),
  },
  "viewItem.reorder": {
    input: ViewItemReorderInputSchema,
    invoke: (service, actor, input) => service.reorderViewItem(actor, input),
  },
  "item.get": {
    input: ItemGetInputSchema,
    invoke: (service, actor, input) => service.getItem(actor, input),
  },
  "item.create": {
    input: ItemCreateInputSchema,
    invoke: (service, actor, input) => service.createItem(actor, input),
  },
  "item.patch": {
    input: ItemPatchInputSchema,
    invoke: (service, actor, input) => service.patchItem(actor, input),
  },
  "item.delete": {
    input: ItemDeleteInputSchema,
    invoke: (service, actor, input) => service.deleteItem(actor, input),
  },
  "item.restore": {
    input: ItemRestoreInputSchema,
    invoke: (service, actor, input) => service.restoreItem(actor, input),
  },
  "database.query": {
    input: DatabaseQueryInputSchema,
    invoke: (service, actor, input) => service.queryDatabase(actor, input),
  },
  "relation.put": {
    input: RelationPutInputSchema,
    invoke: (service, actor, input) => service.putRelation(actor, input),
  },
  "relation.delete": {
    input: RelationDeleteInputSchema,
    invoke: (service, actor, input) => service.deleteRelation(actor, input),
  },
};
