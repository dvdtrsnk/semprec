import type { PoolClient } from "pg";

/**
 * A dedicated two-key advisory lock class: the key derives from a client-chosen `deviceId`, so it
 * must never collide with another lock (2331 in `seed/seedSystem.ts`, 2332/2333 in `db/pool.ts`).
 */
export const SESSION_DEVICE_LOCK_CLASS = 2334;

/** Transaction-scoped. Ids are cast through `uuid` so two spellings of one `deviceId` share a key. */
export async function lockSessionDevice(client: PoolClient, userId: string, deviceId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock($1::int4, hashtext('alldots_device:' || $2::uuid::text || ':' || $3::uuid::text))",
    [SESSION_DEVICE_LOCK_CLASS, userId, deviceId],
  );
}
