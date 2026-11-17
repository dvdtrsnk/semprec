import { ForbiddenError } from "../errors.js";

/** Names only the property key and database id, never an item or value. */
export function closedDatabaseRefusal(propertyKey: string, databaseId: string): ForbiddenError {
  return new ForbiddenError(
    `Property '${propertyKey}' reaches database ${databaseId}, to which the agent's project has no read access`,
    { resource: "database", databaseId, access: "read", field: propertyKey },
  );
}
