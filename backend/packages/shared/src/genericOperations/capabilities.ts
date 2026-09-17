import type { GenericOperationName } from "./operationNames.js";

/**
 * Pure descriptor data in `packages/shared` (issue #252). Registering these eight ids in the
 * core ModuleRegistry manifest and filtering discovery by grants is #220; no enforcement happens
 * here or anywhere in this batch.
 */
export const CAPABILITY_IDS = [
  "core.database.read",
  "core.database.write",
  "core.schema.read",
  "core.schema.write",
  "core.view.read",
  "core.view.write",
  "core.item.read",
  "core.item.write",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type RiskClass = "destructive";

/**
 * Reads and reversible/non-destructive writes never require approval. `database.archive`,
 * `property.delete`, `view.delete`, `item.delete`, and `relation.delete` are the five
 * destructive operations that do. No approval enforcement happens in this batch position — the
 * interceptor consuming this metadata is #220.
 */
export interface OperationMetadata {
  requiresCapability: CapabilityId;
  requiresApproval: boolean;
  riskClass: RiskClass | null;
}

const nonDestructive = (requiresCapability: CapabilityId): OperationMetadata => ({
  requiresCapability,
  requiresApproval: false,
  riskClass: null,
});

const destructive = (requiresCapability: CapabilityId): OperationMetadata => ({
  requiresCapability,
  requiresApproval: true,
  riskClass: "destructive",
});

/**
 * Exhaustive over the 28 literal operation names, capability and approval/risk metadata checked
 * together in one object literal per operation: assigning this object literal to a type with
 * exactly these keys is what makes an operation missing (or an extra, misspelled one) a compile
 * error rather than a runtime gap.
 */
export const OPERATION_METADATA: { [K in GenericOperationName]: OperationMetadata } = {
  "database.list": nonDestructive("core.database.read"),
  "database.get": nonDestructive("core.database.read"),
  "database.query": nonDestructive("core.database.read"),
  "database.create": nonDestructive("core.database.write"),
  "database.patch": nonDestructive("core.database.write"),
  "database.archive": destructive("core.database.write"),
  "database.restore": nonDestructive("core.database.write"),
  "property.list": nonDestructive("core.schema.read"),
  "property.get": nonDestructive("core.schema.read"),
  "property.create": nonDestructive("core.schema.write"),
  "property.patch": nonDestructive("core.schema.write"),
  "property.delete": destructive("core.schema.write"),
  "view.list": nonDestructive("core.view.read"),
  "view.get": nonDestructive("core.view.read"),
  "view.query": nonDestructive("core.view.read"),
  "view.create": nonDestructive("core.view.write"),
  "view.patch": nonDestructive("core.view.write"),
  "view.delete": destructive("core.view.write"),
  "viewItem.add": nonDestructive("core.view.write"),
  "viewItem.remove": nonDestructive("core.view.write"),
  "viewItem.reorder": nonDestructive("core.view.write"),
  "item.get": nonDestructive("core.item.read"),
  "item.create": nonDestructive("core.item.write"),
  "item.patch": nonDestructive("core.item.write"),
  "item.delete": destructive("core.item.write"),
  "item.restore": nonDestructive("core.item.write"),
  "relation.put": nonDestructive("core.item.write"),
  "relation.delete": destructive("core.item.write"),
};
