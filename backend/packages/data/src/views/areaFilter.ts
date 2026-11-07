import type { PoolClient } from "pg";
import { z } from "zod";
import type { AreaFilterTemplate, ModuleDatabaseProjection } from "@semprec/module-registry";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { ValidationError } from "../errors.js";
import { compileFilterNode } from "./filterCompiler.js";
import { buildFilterProperties } from "./filterProperties.js";
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

/** Stands in for an area id while a declaration is compiled; the compiler binds it as a parameter only. */
const PROBE_AREA_ID = "00000000-0000-4000-8000-000000000000";

/**
 * The declared area filters of the system databases the current tenant has, keyed by database key, each
 * accepted by the existing filter compiler against that tenant's actual schema before it is returned
 * (issue #1597): the manifest loader checks only the template's shape, and a property or relation hop is
 * resolvable only in a tenant's schema. A declaration for a database the tenant does not have is left
 * out. A declaration the compiler refuses is a configuration error: it throws, naming only the database
 * key and the compiler's field, with the compiler's error as `cause`, and nothing is returned. Runs in the
 * caller's transaction.
 */
export async function resolveDatabaseAreaFilters(
  client: PoolClient,
  declarations: readonly Pick<ModuleDatabaseProjection, "key" | "areaFilter">[],
): Promise<Map<string, AreaFilterTemplate>> {
  const resolved = new Map<string, AreaFilterTemplate>();
  for (const { key, areaFilter } of declarations) {
    if (areaFilter === undefined) continue;
    const database = await getDatabaseByModuleId(client, key);
    if (!database) continue;
    const properties = await buildFilterProperties(client, await listPropertiesByDatabase(client, database.id));
    try {
      compileFilterNode(expandAreaFilter(areaFilter, PROBE_AREA_ID), properties, []);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      const details: unknown = error.details;
      const field =
        typeof details === "object" && details !== null && "field" in details && typeof details.field === "string"
          ? details.field
          : "filter";
      throw new Error(`The declared area filter of database '${key}' does not compile (field '${field}')`, {
        cause: error,
      });
    }
    resolved.set(key, areaFilter);
  }
  return resolved;
}
