/**
 * The closed generic-operation catalog. Every other file in `genericOperations` is keyed off this list; compile-time
 * exhaustiveness checks in `schemas.ts`, `port.ts`, `capabilities.ts` and `bindings.ts` point at anything missing or
 * extra. The names are used verbatim as AgentTool names and prefixed `semprec.` as MCP names, except
 * `REST_ONLY_OPERATION_NAMES`.
 */
export const GENERIC_OPERATION_NAMES = [
  "database.list",
  "database.get",
  "database.create",
  "database.patch",
  "database.archive",
  "database.restore",
  "property.list",
  "property.get",
  "property.getByKey",
  "property.create",
  "property.patch",
  "property.delete",
  "property.option.add",
  "property.option.update",
  "view.list",
  "view.get",
  "view.create",
  "view.patch",
  "view.delete",
  "view.query",
  "viewItem.add",
  "viewItem.remove",
  "viewItem.reorder",
  "item.get",
  "item.create",
  "item.patch",
  "item.delete",
  "item.restore",
  "database.query",
  "relation.put",
  "relation.set",
  "relation.delete",
  "relation.list",
  "page.restoreVersion",
  "link.unlink",
  "link.relink",
  "page.get",
  "page.ensure",
  "page.createSubpage",
  "page.insert",
  "page.replace",
  "page.changes",
  "item.count",
  "page.duplicate",
  "page.rename",
  "database.facets",
  "page.ensureJournalPeriod",
  "page.mergeJournalDuplicates",
  "search",
  "relation.related",
  "page.convertToBlock",
] as const;

export type GenericOperationName = (typeof GENERIC_OPERATION_NAMES)[number];

/**
 * Operations only REST dispatches; `GenericOperationGateway` (used by AgentTool and MCP) neither lists nor dispatches
 * them.
 * - `property.option.add` / `property.option.update`: an option changes a database's schema, so the assistant gets no
 *   tool for it.
 */
export const REST_ONLY_OPERATION_NAMES = [
  "property.option.add",
  "property.option.update",
] as const satisfies readonly GenericOperationName[];
