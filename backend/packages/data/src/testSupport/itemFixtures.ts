import type { PoolClient } from "pg";
import { createDatabase } from "../chokePoint/databasesStore.js";

/**
 * Items with exactly `ids`, in a new database of the client's tenant, for a row a test writes directly that must name
 * an existing item (every item column with a foreign key). Raw rows: the tests choose the ids, which no production
 * write accepts. Returns the database id.
 */
export async function insertItemsWithIds(client: PoolClient, ids: readonly string[]): Promise<string> {
  const database = await createDatabase(client, { name: "Fixture items" });
  await client.query("INSERT INTO items (id, database_id) SELECT id, $2 FROM unnest($1::uuid[]) AS id", [
    ids,
    database.id,
  ]);
  return database.id;
}
