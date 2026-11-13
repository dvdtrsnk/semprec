import { ForbiddenError } from "../errors.js";

/**
 * The refusal of a filter or a sort that reaches a sensitive database the agent's project may not read (issue #2000):
 * a relation property into it, or a rollup that aggregates it. The message and the details name the property key
 * and the database id, never any item or any value.
 */
export function closedDatabaseRefusal(propertyKey: string, databaseId: string): ForbiddenError {
  return new ForbiddenError(
    `Property '${propertyKey}' reaches database ${databaseId}, to which the agent's project has no read access`,
    { resource: "database", databaseId, access: "read", field: propertyKey },
  );
}
