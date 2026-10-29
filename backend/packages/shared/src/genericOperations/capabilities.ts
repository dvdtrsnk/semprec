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

/**
 * The closed set of risk classes shared by generic operations, MCP tool snapshots and approval
 * requests. A module that needs another class extends this list.
 */
export const RISK_CLASSES = ["unclassified", "read", "write", "destructive", "outbound", "breaksLink"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export function isRiskClass(value: string): value is RiskClass {
  return (RISK_CLASSES as readonly string[]).includes(value);
}

/**
 * Reads and reversible/non-destructive writes never require approval. `database.archive`,
 * `property.delete`, `view.delete`, `item.delete`, and `relation.delete` are the five
 * destructive operations that do. No approval enforcement happens in this batch position — the
 * interceptor consuming this metadata is #220.
 */
export interface OperationMetadata {
  requiresCapability: CapabilityId;
  requiresApproval: boolean;
  riskClass: RiskClass;
}

const nonDestructive = (requiresCapability: CapabilityId, riskClass: "read" | "write"): OperationMetadata => ({
  requiresCapability,
  requiresApproval: false,
  riskClass,
});

const destructive = (requiresCapability: CapabilityId): OperationMetadata => ({
  requiresCapability,
  requiresApproval: true,
  riskClass: "destructive",
});

/**
 * Exhaustive over the 29 literal operation names, capability and approval/risk metadata checked
 * together in one object literal per operation: assigning this object literal to a type with
 * exactly these keys is what makes an operation missing (or an extra, misspelled one) a compile
 * error rather than a runtime gap.
 */
export const OPERATION_METADATA: { [K in GenericOperationName]: OperationMetadata } = {
  "database.list": nonDestructive("core.database.read", "read"),
  "database.get": nonDestructive("core.database.read", "read"),
  "database.query": nonDestructive("core.database.read", "read"),
  "database.create": nonDestructive("core.database.write", "write"),
  "database.patch": nonDestructive("core.database.write", "write"),
  "database.archive": destructive("core.database.write"),
  "database.restore": nonDestructive("core.database.write", "write"),
  "property.list": nonDestructive("core.schema.read", "read"),
  "property.get": nonDestructive("core.schema.read", "read"),
  "property.getByKey": nonDestructive("core.schema.read", "read"),
  "property.create": nonDestructive("core.schema.write", "write"),
  "property.patch": nonDestructive("core.schema.write", "write"),
  "property.delete": destructive("core.schema.write"),
  "view.list": nonDestructive("core.view.read", "read"),
  "view.get": nonDestructive("core.view.read", "read"),
  "view.query": nonDestructive("core.view.read", "read"),
  "view.create": nonDestructive("core.view.write", "write"),
  "view.patch": nonDestructive("core.view.write", "write"),
  "view.delete": destructive("core.view.write"),
  "viewItem.add": nonDestructive("core.view.write", "write"),
  "viewItem.remove": nonDestructive("core.view.write", "write"),
  "viewItem.reorder": nonDestructive("core.view.write", "write"),
  "item.get": nonDestructive("core.item.read", "read"),
  "item.create": nonDestructive("core.item.write", "write"),
  "item.patch": nonDestructive("core.item.write", "write"),
  "item.delete": destructive("core.item.write"),
  "item.restore": nonDestructive("core.item.write", "write"),
  "relation.put": nonDestructive("core.item.write", "write"),
  "relation.delete": destructive("core.item.write"),
};
