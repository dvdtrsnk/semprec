/**
 * The closed 48-operation catalog (issues #252, #1404, #1617, #1587, #1615, #1616, #1676, #1679, #1709, #1722, #1725, #1699, #1759, #1765, #1861, #2017). Every other file in `genericOperations` is
 * keyed off this exact list — adding or removing an operation means touching this array and
 * letting the compile-time exhaustiveness checks in `schemas.ts`, `port.ts`, `capabilities.ts`,
 * and `bindings.ts` point at whatever is now missing or extra.
 *
 * #220 uses these names verbatim as AgentTool names, and prefixed `semprec.` as MCP names, except for
 * `REST_ONLY_OPERATION_NAMES` below.
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
] as const;

export type GenericOperationName = (typeof GENERIC_OPERATION_NAMES)[number];

/**
 * The catalog operations that REST alone dispatches: `GenericOperationGateway`, through which the AgentTool and MCP
 * transports list and call operations, neither lists nor dispatches them.
 * - `property.option.add` and `property.option.update` (issue #1699,
 *   docs/adr/2026-11-10-select-options-change-on-a-schema-locked-database.md): an option changes the schema of a
 *   database, so the assistant gets no tool for it; it will propose a new option on an Inbox proposal that a person
 *   confirms (#1994).
 */
export const REST_ONLY_OPERATION_NAMES = [
  "property.option.add",
  "property.option.update",
] as const satisfies readonly GenericOperationName[];
