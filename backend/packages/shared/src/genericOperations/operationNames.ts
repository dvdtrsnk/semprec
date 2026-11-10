/**
 * The closed 38-operation catalog (issues #252, #1404, #1617, #1587, #1615, #1616, #1676, #1679). Every other file in `genericOperations` is
 * keyed off this exact list — adding or removing an operation means touching this array and
 * letting the compile-time exhaustiveness checks in `schemas.ts`, `port.ts`, `capabilities.ts`,
 * and `bindings.ts` point at whatever is now missing or extra.
 *
 * #220 uses these names verbatim as AgentTool names, and prefixed `semprec.` as MCP names.
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
  "page.changes",
] as const;

export type GenericOperationName = (typeof GENERIC_OPERATION_NAMES)[number];
