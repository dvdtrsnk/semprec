/**
 * The closed catalog of generic operations. Extending it is always a code change here — the
 * REST adapter, the AgentTools (same names verbatim) and the MCP tools (prefixed `semprec.`)
 * all project exactly this list, so a name that is not in it exists on no transport.
 * Binary files are deliberately excluded: they are the one non-JSON surface (#37).
 */
export const GENERIC_OPERATION_NAMES = [
  "database.list",
  "database.get",
  "database.create",
  "database.patch",
  "database.archive",
  "database.restore",
  "database.query",
  "property.list",
  "property.get",
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
  "relation.put",
  "relation.delete",
] as const;

export type GenericOperationName = (typeof GENERIC_OPERATION_NAMES)[number];
