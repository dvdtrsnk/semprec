import type { GenericOperationName } from "./operationNames.js";

/** Pure capability descriptors; grants are enforced elsewhere. */
export const CAPABILITY_IDS = [
  "core.database.read",
  "core.database.write",
  "core.schema.read",
  "core.schema.write",
  "core.view.read",
  "core.view.write",
  "core.item.read",
  "core.item.write",
  "core.page.read",
  "core.page.write",
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
 * Reads and reversible/non-destructive writes never require approval. The destructive operations that do are
 * `database.archive`, `property.delete`, `view.delete`, `item.delete`, `relation.delete`, `page.restoreVersion`,
 * `page.replace`, `page.mergeJournalDuplicates` and `page.convertToBlock`.
 */
export interface OperationMetadata {
  requiresCapability: CapabilityId;
  requiresApproval: boolean;
  riskClass: RiskClass;
  /** Whether a finished call can be undone through another operation (trash restore, `database.restore`). */
  reversible: boolean;
}

const nonDestructive = (requiresCapability: CapabilityId, riskClass: "read" | "write"): OperationMetadata => ({
  requiresCapability,
  requiresApproval: false,
  riskClass,
  reversible: true,
});

const destructive = (requiresCapability: CapabilityId, reversible: boolean): OperationMetadata => ({
  requiresCapability,
  requiresApproval: true,
  riskClass: "destructive",
  reversible,
});

/**
 * Exhaustive over every operation name: the object literal's exact key type turns a missing or misspelled operation
 * into a compile error.
 */
export const OPERATION_METADATA: { [K in GenericOperationName]: OperationMetadata } = {
  "database.list": nonDestructive("core.database.read", "read"),
  "database.get": nonDestructive("core.database.read", "read"),
  "database.query": nonDestructive("core.database.read", "read"),
  // Counts items, so it takes the item-read capability, as `item.count` does.
  "database.facets": nonDestructive("core.item.read", "read"),
  search: nonDestructive("core.item.read", "read"),
  "database.create": nonDestructive("core.database.write", "write"),
  "database.patch": nonDestructive("core.database.write", "write"),
  "database.archive": destructive("core.database.write", true),
  "database.restore": nonDestructive("core.database.write", "write"),
  "property.list": nonDestructive("core.schema.read", "read"),
  "property.get": nonDestructive("core.schema.read", "read"),
  "property.getByKey": nonDestructive("core.schema.read", "read"),
  "property.create": nonDestructive("core.schema.write", "write"),
  "property.patch": nonDestructive("core.schema.write", "write"),
  "property.delete": destructive("core.schema.write", false),
  // Neither removes an option nor changes a key, so every stored value stays valid.
  "property.option.add": nonDestructive("core.schema.write", "write"),
  "property.option.update": nonDestructive("core.schema.write", "write"),
  "view.list": nonDestructive("core.view.read", "read"),
  "view.get": nonDestructive("core.view.read", "read"),
  "view.query": nonDestructive("core.view.read", "read"),
  "view.create": nonDestructive("core.view.write", "write"),
  "view.patch": nonDestructive("core.view.write", "write"),
  "view.delete": destructive("core.view.write", false),
  "viewItem.add": nonDestructive("core.view.write", "write"),
  "viewItem.remove": nonDestructive("core.view.write", "write"),
  "viewItem.reorder": nonDestructive("core.view.write", "write"),
  "item.get": nonDestructive("core.item.read", "read"),
  "item.count": nonDestructive("core.item.read", "read"),
  "item.create": nonDestructive("core.item.write", "write"),
  "item.patch": nonDestructive("core.item.write", "write"),
  "item.delete": destructive("core.item.write", true),
  "item.restore": nonDestructive("core.item.write", "write"),
  "relation.put": nonDestructive("core.item.write", "write"),
  "relation.set": nonDestructive("core.item.write", "write"),
  "relation.delete": destructive("core.item.write", false),
  "relation.list": nonDestructive("core.item.read", "read"),
  "relation.related": nonDestructive("core.item.read", "read"),
  "link.unlink": nonDestructive("core.item.write", "write"),
  "link.relink": nonDestructive("core.item.write", "write"),
  // Page operations take the item capabilities: an agent's access to a page follows its project's grant on the database
  // that owns the page. `core.page.read`/`core.page.write` stay registered, and no operation requires them.
  "page.ensure": nonDestructive("core.item.write", "write"),
  // Creates an empty Journal entry and page the user could create and trash themselves, so no approval.
  "page.ensureJournalPeriod": nonDestructive("core.item.write", "write"),
  // Re-points links and trashes one entry, so an agent's call always needs approval. Not `reversible`: restoring the
  // trashed entry does not move its content and links back.
  "page.mergeJournalDuplicates": destructive("core.item.write", false),
  // Trashes a page subtree and rewrites the parent's block, so it always needs approval. `reversible`: the pages come
  // back with their block through `item.restore` during retention.
  "page.convertToBlock": destructive("core.item.write", true),
  "page.get": nonDestructive("core.item.read", "read"),
  "page.changes": nonDestructive("core.item.read", "read"),
  // Additive and reversible through `item.delete`.
  "page.createSubpage": nonDestructive("core.item.write", "write"),
  // Additive: new Pages items and documents plus one `page` block in the parent.
  "page.duplicate": nonDestructive("core.item.write", "write"),
  // Undone by renaming back.
  "page.rename": nonDestructive("core.item.write", "write"),
  // Additive: destroys no content, and its blocks carry the caller as `created_by`.
  "page.insert": nonDestructive("core.item.write", "write"),
  // Discards the current body and trashes subpages whose links vanished. Trash and version restore make it
  // `reversible`, but it stays destructive, so an agent's call needs approval.
  "page.replace": destructive("core.item.write", true),
  // Undone by restoring an earlier instant.
  "page.restoreVersion": destructive("core.item.write", true),
};

export const APPROVAL_RISK_LEVELS = ["irreversible", "outbound", "breaksLink", "write"] as const;
export type ApprovalRiskLevel = (typeof APPROVAL_RISK_LEVELS)[number];

/**
 * A `destructive` request is `irreversible` unless its generic operation is `reversible`; every other class is a plain
 * `write`.
 */
export function deriveApprovalRiskLevel(input: { riskClass: RiskClass; operationName?: string }): ApprovalRiskLevel {
  switch (input.riskClass) {
    case "breaksLink":
      return "breaksLink";
    case "outbound":
      return "outbound";
    case "destructive": {
      const name = input.operationName;
      const reversible =
        name !== undefined &&
        Object.hasOwn(OPERATION_METADATA, name) &&
        OPERATION_METADATA[name as GenericOperationName].reversible;
      return reversible ? "write" : "irreversible";
    }
    default:
      return "write";
  }
}
