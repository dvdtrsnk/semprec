/**
 * The closed 29-operation catalog (issue #252). Every other file in `genericOperations` is
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
  "relation.delete",
] as const;

export type GenericOperationName = (typeof GENERIC_OPERATION_NAMES)[number];
