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
 * Fills every `{ areaValue: true }` slot of a manifest's declared area filter with `areaId` and validates the result
 * as an ordinary filter tree. A malformed area id is a 400 on `areaId`; property keys are resolved later by the
 * compiler.
 */
export function expandAreaFilter(template: AreaFilterTemplate, areaId: string): FilterNode {
  if (!z.uuid().safeParse(areaId).success) {
    throw new ValidationError("'areaId' must be a uuid", { field: "areaId" });
  }
  return parseFilterNode(substitute(template, areaId));
}

/** The compiler binds it as a parameter only. */
const PROBE_AREA_ID = "00000000-0000-4000-8000-000000000000";

/**
 * The declared area filters of the tenant's system databases, by key, each compiled against the tenant's actual
 * schema first, since the manifest loader checks only shape. Databases the tenant lacks are left out. A refused
 * declaration is a configuration error: it throws naming only the database key and field, with `cause`.
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
