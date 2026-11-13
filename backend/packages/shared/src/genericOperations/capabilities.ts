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
 * Reads and reversible/non-destructive writes never require approval. `database.archive`,
 * `property.delete`, `view.delete`, `item.delete`, and `relation.delete` are the five
 * destructive operations that do; `page.restoreVersion` (issue #1617), `page.replace` (issue #1765), `page.mergeJournalDuplicates` (issue #2017) and `page.convertToBlock` (issue #1876) are the sixth to ninth. No approval
 * enforcement happens in this batch position — the
 * interceptor consuming this metadata is #220.
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
 * Exhaustive over the 51 literal operation names, capability and approval/risk metadata checked
 * together in one object literal per operation: assigning this object literal to a type with
 * exactly these keys is what makes an operation missing (or an extra, misspelled one) a compile
 * error rather than a runtime gap.
 */
export const OPERATION_METADATA: { [K in GenericOperationName]: OperationMetadata } = {
  "database.list": nonDestructive("core.database.read", "read"),
  "database.get": nonDestructive("core.database.read", "read"),
  "database.query": nonDestructive("core.database.read", "read"),
  // Counts the items of the database, so it takes the item-read capability, as `item.count` does (issue #1759).
  "database.facets": nonDestructive("core.item.read", "read"),
  // Reads the items of the tenant's searchable databases, so it takes the item-read capability (issue #1842).
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
  // Neither removes an option nor changes an option key, so every stored item value stays valid (issue #1699).
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
  // The page operations hold the item capabilities: whether an agent may read or write a page is decided by its
  // project's grant on the database that owns the page, not by a capability of its own
  // (docs/adr/2026-11-13-page-operations-follow-the-owner-database-grant.md; issue #1844). `core.page.read` and
  // `core.page.write` stay registered, and no operation requires them.
  "page.ensure": nonDestructive("core.item.write", "write"),
  // Creates an empty Journal entry and its page when the period has none, an entry the user could create themselves
  // and trash again, so it needs no approval (issue #1861).
  "page.ensureJournalPeriod": nonDestructive("core.item.write", "write"),
  // Re-points links and moves one entry to the Trash, so an agent's call is held for approval every time: the
  // assistant proposes the merge and the user decides (issue #2017). Not `reversible`: restoring the trashed entry does
  // not move its content and links back.
  "page.mergeJournalDuplicates": destructive("core.item.write", false),
  // Trashes a page and the pages below it and rewrites the block in the parent, so an agent's call is held for approval
  // every time (issue #1876). `reversible`: the trashed pages come back with their block through `item.restore` for the
  // retention period, and the converted block stays for the user to remove.
  "page.convertToBlock": destructive("core.item.write", true),
  "page.get": nonDestructive("core.item.read", "read"),
  "page.changes": nonDestructive("core.item.read", "read"),
  // Additive and reversible through `item.delete`.
  "page.createSubpage": nonDestructive("core.item.write", "write"),
  // Additive: it creates new Pages items and documents and adds one `page` block to the parent's document. The
  // item-write capability is the issue's choice (docs/adr/2026-11-10-page-duplication-copies-the-subtree-as-new-pages.md).
  "page.duplicate": nonDestructive("core.item.write", "write"),
  // Undone by renaming back. The item-write capability is the issue's choice
  // (docs/adr/2026-11-10-page-rename-writes-the-item-title-and-the-parent-block-together.md).
  "page.rename": nonDestructive("core.item.write", "write"),
  // Additive: it destroys no content and its blocks carry the caller as `created_by` (docs/adr/2026-10-29-agent-page-write-policy.md).
  "page.insert": nonDestructive("core.item.write", "write"),
  // Discards the current body and trashes the subpages whose links vanished; the trash is restorable and an earlier
  // version can be restored, so `reversible`. docs/adr/2026-10-28-page-operation-family.md and
  // docs/adr/2026-10-29-agent-page-write-policy.md classify it destructive, also after version restore exists: an
  // agent's call is held for approval (issue #1844).
  "page.replace": destructive("core.item.write", true),
  // Restorable by another restore to an earlier instant, so `reversible` (issue #1617).
  "page.restoreVersion": destructive("core.item.write", true),
};

export const APPROVAL_RISK_LEVELS = ["irreversible", "outbound", "breaksLink", "write"] as const;
export type ApprovalRiskLevel = (typeof APPROVAL_RISK_LEVELS)[number];

/**
 * The closed key an approval screen renders as a risk label. A `destructive` request is
 * `irreversible` unless it names a generic operation flagged `reversible`; every other class
 * (`write`, `read`, `unclassified`) is a plain `write`.
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
