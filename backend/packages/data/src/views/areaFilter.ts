import { z } from "zod";
import type { AreaFilterTemplate } from "@semprec/module-registry";
import { ValidationError } from "../errors.js";
import { parseFilterNode, type FilterNode } from "./filterTree.js";

function substitute(node: AreaFilterTemplate, areaId: string): unknown {
  switch (node.type) {
    case "and":
    case "or":
      return { type: node.type, nodes: node.nodes.map((child) => substitute(child, areaId)) };
    case "relation_is_empty":
      return { type: node.type, property: node.property };
    case "relation_contains":
      return { type: node.type, property: node.property, value: areaId };
    case "relation_path_contains":
      return { type: node.type, path: [node.path[0], node.path[1]], value: areaId };
  }
}

/**
 * Expands a database's declared area filter (a module manifest's `databases[].areaFilter`, issue #1597)
 * for one area: every `{ areaValue: true }` slot becomes `areaId`, and the result is validated with the
 * filter-tree schema (`parseFilterNode`), so it is an ordinary filter tree any query of that database
 * accepts. A malformed area id is a 400 on `areaId`; property keys are resolved later, by the compiler,
 * against the queried database.
 */
export function expandAreaFilter(template: AreaFilterTemplate, areaId: string): FilterNode {
  if (!z.uuid().safeParse(areaId).success) {
    throw new ValidationError("'areaId' must be a uuid", { field: "areaId" });
  }
  return parseFilterNode(substitute(template, areaId));
}
