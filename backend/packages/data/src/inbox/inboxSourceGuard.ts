import type { PoolClient } from "pg";
import { NotFoundError } from "../errors.js";
import { runValueLinkAdmissionLock } from "../chokePoint/valueLinkRelationAdmission.js";

/** Lock the tenant's Inbox source in the caller's transaction, optionally including Trash. */
export async function lockInboxSource(
  client: PoolClient,
  itemId: string,
  allowDeleted = false,
  lockMode?: "nowait",
): Promise<void> {
  if (!(await lockInboxSourceIfPresent(client, itemId, allowDeleted, lockMode)))
    throw new NotFoundError("Inbox source not found", { resource: "item", itemId });
}

/** Purge may call this after it has already deleted the source in the same transaction. */
export async function lockInboxSourceIfPresent(
  client: PoolClient,
  itemId: string,
  allowDeleted = false,
  lockMode?: "nowait",
): Promise<boolean> {
  // The interpolated suffix is either the fixed NOWAIT keyword or an empty string.
  const query = () =>
    client.query<{ id: string }>(
      `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id AND d.tenant_id = i.tenant_id
     WHERE i.id = $1 AND d.owner_module_id = 'inbox' AND ($2::boolean OR i.deleted_at IS NULL) FOR UPDATE OF i${lockMode === "nowait" ? " NOWAIT" : ""}`,
      [itemId, allowDeleted],
    );
  const result = lockMode === "nowait" ? await runValueLinkAdmissionLock(query) : await query();
  return result.rowCount === 1;
}

/** Hold a shared type lock, or report a busy type without aborting the caller's transaction. */
export async function tryLockInboxType(client: PoolClient, databaseId: string, itemId: string): Promise<boolean> {
  await client.query("SAVEPOINT inbox_type_lock");
  try {
    await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR SHARE NOWAIT", [
      databaseId,
      itemId,
    ]);
    await client.query("RELEASE SAVEPOINT inbox_type_lock");
    return true;
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "55P03") throw error;
    await client.query("ROLLBACK TO SAVEPOINT inbox_type_lock");
    await client.query("RELEASE SAVEPOINT inbox_type_lock");
    return false;
  }
}
