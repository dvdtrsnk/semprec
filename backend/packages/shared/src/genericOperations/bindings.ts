import type { ZodType } from "zod";
import type { AuthenticatedActor } from "./actor.js";
import type { GenericOperationName } from "./catalog.js";
import type { GenericApplicationPort, InputByOperation, OutputByOperation } from "./port.js";
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

/** The eight capability ids the generic catalog is granted through. Pure descriptor data here; #220 registers them in the core ModuleRegistry manifest and filters discovery by grants. */
export const GENERIC_OPERATION_CAPABILITIES = [
  "core.database.read",
  "core.database.write",
  "core.schema.read",
  "core.schema.write",
  "core.view.read",
  "core.view.write",
  "core.item.read",
  "core.item.write",
] as const;

export type CapabilityId = (typeof GENERIC_OPERATION_CAPABILITIES)[number];

export type RiskClass = "destructive";

/** Approval metadata is one pair, not two independent fields: a risk class exists exactly when approval is required. */
export type ApprovalPolicy =
  | { readonly requiresApproval: false; readonly riskClass: null }
  | { readonly requiresApproval: true; readonly riskClass: RiskClass };

export interface OperationBinding<I, O> {
  readonly input: ZodType<I>;
  invoke(service: GenericApplicationPort, actor: AuthenticatedActor, input: I): Promise<O>;
}

export type OperationDescriptor<K extends GenericOperationName> = OperationBinding<InputByOperation[K], OutputByOperation[K]> &
  ApprovalPolicy & {
    readonly requiresCapability: CapabilityId;
  };

export type GenericOperationBindings = { readonly [K in GenericOperationName]: OperationDescriptor<K> };

/**
 * The one binding table over the catalog: schema, required capability, approval metadata and
 * the call into the port. `invoke` always calls `service[method](actor, input)` in that order,
 * and nothing here reaches for a transport, a session or a database — the bindings depend only
 * on the port, and every composition root injects its own implementation of it.
 */
export const GENERIC_OPERATION_BINDINGS: GenericOperationBindings = {
  "database.list": {
    input: DatabaseListInputSchema,
    requiresCapability: "core.database.read",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.listDatabases(actor, input),
  },
  "database.get": {
    input: DatabaseGetInputSchema,
    requiresCapability: "core.database.read",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.getDatabase(actor, input),
  },
  "database.create": {
    input: DatabaseCreateInputSchema,
    requiresCapability: "core.database.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.createDatabase(actor, input),
  },
  "database.patch": {
    input: DatabasePatchInputSchema,
    requiresCapability: "core.database.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.patchDatabase(actor, input),
  },
  "database.archive": {
    input: DatabaseArchiveInputSchema,
    requiresCapability: "core.database.write",
    requiresApproval: true,
    riskClass: "destructive",
    invoke: (service, actor, input) => service.archiveDatabase(actor, input),
  },
  "database.restore": {
    input: DatabaseRestoreInputSchema,
    requiresCapability: "core.database.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.restoreDatabase(actor, input),
  },
  "database.query": {
    input: DatabaseQueryInputSchema,
    requiresCapability: "core.database.read",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.queryDatabase(actor, input),
  },
  "property.list": {
    input: PropertyListInputSchema,
    requiresCapability: "core.schema.read",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.listProperties(actor, input),
  },
  "property.get": {
    input: PropertyGetInputSchema,
    requiresCapability: "core.schema.read",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.getProperty(actor, input),
  },
  "property.create": {
    input: PropertyCreateInputSchema,
    requiresCapability: "core.schema.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.createProperty(actor, input),
  },
  "property.patch": {
    input: PropertyPatchInputSchema,
    requiresCapability: "core.schema.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.patchProperty(actor, input),
  },
  "property.delete": {
    input: PropertyDeleteInputSchema,
    requiresCapability: "core.schema.write",
    requiresApproval: true,
    riskClass: "destructive",
    invoke: (service, actor, input) => service.deleteProperty(actor, input),
  },
  "view.list": {
    input: ViewListInputSchema,
    requiresCapability: "core.view.read",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.listViews(actor, input),
  },
  "view.get": {
    input: ViewGetInputSchema,
    requiresCapability: "core.view.read",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.getView(actor, input),
  },
  "view.create": {
    input: ViewCreateInputSchema,
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.createView(actor, input),
  },
  "view.patch": {
    input: ViewPatchInputSchema,
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.patchView(actor, input),
  },
  "view.delete": {
    input: ViewDeleteInputSchema,
    requiresCapability: "core.view.write",
    requiresApproval: true,
    riskClass: "destructive",
    invoke: (service, actor, input) => service.deleteView(actor, input),
  },
  "view.query": {
    input: ViewQueryInputSchema,
    requiresCapability: "core.view.read",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.queryView(actor, input),
  },
  "viewItem.add": {
    input: ViewItemAddInputSchema,
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.addViewItem(actor, input),
  },
  "viewItem.remove": {
    input: ViewItemRemoveInputSchema,
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.removeViewItem(actor, input),
  },
  "viewItem.reorder": {
    input: ViewItemReorderInputSchema,
    requiresCapability: "core.view.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.reorderViewItem(actor, input),
  },
  "item.get": {
    input: ItemGetInputSchema,
    requiresCapability: "core.item.read",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.getItem(actor, input),
  },
  "item.create": {
    input: ItemCreateInputSchema,
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.createItem(actor, input),
  },
  "item.patch": {
    input: ItemPatchInputSchema,
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.patchItem(actor, input),
  },
  "item.delete": {
    input: ItemDeleteInputSchema,
    requiresCapability: "core.item.write",
    requiresApproval: true,
    riskClass: "destructive",
    invoke: (service, actor, input) => service.deleteItem(actor, input),
  },
  "item.restore": {
    input: ItemRestoreInputSchema,
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.restoreItem(actor, input),
  },
  "relation.put": {
    input: RelationPutInputSchema,
    requiresCapability: "core.item.write",
    requiresApproval: false,
    riskClass: null,
    invoke: (service, actor, input) => service.putRelation(actor, input),
  },
  "relation.delete": {
    input: RelationDeleteInputSchema,
    requiresCapability: "core.item.write",
    requiresApproval: true,
    riskClass: "destructive",
    invoke: (service, actor, input) => service.deleteRelation(actor, input),
  },
};
